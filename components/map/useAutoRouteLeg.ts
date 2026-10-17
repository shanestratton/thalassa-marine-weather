import { useCallback, useEffect, useRef } from 'react';
import { requireConfirmedDraft } from '../../stores/draftConfirmStore';
import { useSettingsStore } from '../../stores/settingsStore';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../../services/authIdentityScope';
import { vesselDraftMetres, vesselAirDraftMetres } from '../../services/units';
import { isDraftConfirmed } from '../../services/draftConfirmation';
import type { TracePoint } from '../../services/routeTracer';
import { triggerHaptic } from '../../utils/system';

export interface AutoRouteLegDeps {
    capturedCoords: TracePoint[];
    setCapturedCoords: (pins: TracePoint[]) => void;
    selectedPin: number | null;
    setSelectedPin: (i: number | null) => void;
    setInsertAfter: (i: number | null) => void;
    insertAfterRef: { current: number | null };
    fixBusyLeg: number | null;
    setFixBusyLeg: (i: number | null) => void;
    setAutoRouteDiag: (msg: string | null) => void;
    flashTraceFeedback: (msg: string) => void;
    departureMs: number | null;
    legEtaOffsetsMs: readonly number[];
    enabled: boolean;
}
const requestKey = (d: AutoRouteLegDeps) =>
    JSON.stringify([d.enabled, d.capturedCoords, d.selectedPin, d.departureMs, d.legEtaOffsetsMs]);

/** One confirmed, current edit, committed only after the actual cold sweep. */
export function useAutoRouteLeg(deps: AutoRouteLegDeps): () => void {
    const current = useRef(deps);
    const active = useRef<AbortController | null>(null);
    if (active.current && requestKey(current.current) !== requestKey(deps)) active.current.abort();
    current.current = deps;
    const mounted = useRef(true);
    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            active.current?.abort();
        };
    }, []);
    return useCallback(() => {
        const start = current.current;
        if (!start.enabled || start.capturedCoords.length < 2 || start.fixBusyLeg !== null || active.current) return;
        const stop = new AbortController();
        active.current = stop; // Same-tick taps cannot start a second run.
        const scope = getAuthIdentityScope();
        const boat = useSettingsStore.getState().activeVesselId;
        const originalKey = requestKey(start);
        const sameRequest = () =>
            mounted.current &&
            !stop.signal.aborted &&
            isAuthIdentityScopeCurrent(scope) &&
            useSettingsStore.getState().activeVesselId === boat &&
            requestKey(current.current) === originalKey;
        const settingsKey = () => {
            const state = useSettingsStore.getState();
            return JSON.stringify([state.settings.vessel, state.settings.satelliteMode]);
        };
        void (async () => {
            let busy = false;
            let committed = false;
            let policyKey: string | null = null;
            let unsubscribe: (() => void) | undefined;
            try {
                unsubscribe = useSettingsStore.subscribe(() => {
                    if (
                        useSettingsStore.getState().activeVesselId !== boat ||
                        (policyKey !== null && settingsKey() !== policyKey)
                    )
                        stop.abort();
                });
                if (
                    (!isDraftConfirmed(useSettingsStore.getState().settings.vessel) &&
                        !(await requireConfirmedDraft('auto-route'))) ||
                    !sameRequest() ||
                    !isDraftConfirmed(useSettingsStore.getState().settings.vessel)
                )
                    return;
                // Confirmation may deliberately update the draft. Bind the new
                // policy only after that accepted edit, still on the same boat.
                policyKey = settingsKey();
                // A → B → A switches still retire the original request, even
                // when they happen between two render/worker checkpoints.
                const live = () => sameRequest() && settingsKey() === policyKey;
                const settings = useSettingsStore.getState().settings;
                const leg =
                    start.selectedPin !== null &&
                    start.selectedPin > 0 &&
                    start.selectedPin < start.capturedCoords.length
                        ? start.selectedPin - 1
                        : start.capturedCoords.length - 2;
                const offset = start.legEtaOffsetsMs[leg];
                if (!Number.isFinite(offset) || offset < 0)
                    throw Error('The selected leg has no valid departure clock.');
                busy = true;
                start.setFixBusyLeg(leg);
                start.setAutoRouteDiag(null);
                triggerHaptic('medium');
                start.flashTraceFeedback('Finding and freshly checking a charted route…');
                const { autoTraceLeg } = await import('../../services/routing/autoTraceLeg');
                if (!live()) return;
                const result = await autoTraceLeg({
                    points: start.capturedCoords,
                    legIndex: leg,
                    draftM: vesselDraftMetres(settings.vessel),
                    airDraftM: vesselAirDraftMetres(settings.vessel),
                    departureMs: (start.departureMs ?? Date.now()) + offset,
                    satelliteMode: !!settings.satelliteMode,
                    signal: stop.signal,
                    shouldContinue: live,
                });
                if (!live()) return;
                committed = true;
                start.setCapturedCoords(result.points);
                start.setSelectedPin(null);
                start.setInsertAfter(null);
                start.insertAfterRef.current = null;
                start.flashTraceFeedback(`Auto checked — ${result.added} curve points added.`);
                start.setAutoRouteDiag(
                    `Auto ${result.distanceNM.toFixed(1)} NM: final line freshly checked against installed charts and land. Review the whole route before following; no tide credit was used.`,
                );
            } catch (error) {
                if (sameRequest()) {
                    start.setAutoRouteDiag(
                        error instanceof Error ? error.message : 'Auto could not check this leg. Nothing changed.',
                    );
                    start.flashTraceFeedback('Auto refused — original pins kept.');
                }
            } finally {
                unsubscribe?.();
                if (active.current === stop) active.current = null;
                // Never write the previous account's feedback/busy state into
                // the next account's draft. The owning view resets on identity.
                if (busy && mounted.current && isAuthIdentityScopeCurrent(scope)) {
                    start.setFixBusyLeg(null);
                    if (!committed && (!sameRequest() || (policyKey !== null && settingsKey() !== policyKey))) {
                        start.setAutoRouteDiag('Auto stopped because the request changed. Nothing changed.');
                        start.flashTraceFeedback('Auto stopped — original pins kept.');
                    }
                }
            }
        })();
    }, []);
}
