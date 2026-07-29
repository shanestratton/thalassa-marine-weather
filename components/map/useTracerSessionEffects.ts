/**
 * useTracerSessionEffects — three contiguous tracer effects that write no map
 * source, layer, or DOM marker: the app-chrome broadcast, the PLAN-page
 * departure adoption, and the tracer-open bootstrap.
 *
 * Named for the span rather than a theme, deliberately. The departure listener
 * is genuinely unrelated to the other two, and pretending otherwise invites a
 * later "tidy" that harmonises their guards — which would be a behaviour
 * change, because:
 *
 * THE GUARD ASYMMETRY IS INTENTIONAL. The chrome broadcast guards
 * `embedded || pickerMode || isPinView` and deliberately OMITS hideTracer. The
 * departure listener has NO guard at all — every MapHub instance adopts a
 * departure. The deep-link handoff back in MapHub guards all four. These three
 * differ on purpose; do not make them agree.
 *
 * The chrome early-return sits ABOVE `return () => say(false)`, so in
 * embedded/picker/pin-view modes no cleanup is registered AT ALL. Do not hoist
 * that guard into say(), and do not move it to the call site while leaving an
 * unconditional cleanup — say(false) would start firing in modes where it has
 * never fired.
 *
 * `getAuthIdentityScope()` stays INSIDE onDep, at fire time. Hoisting it into
 * the effect body — the obvious "cleanup" — stale-locks the identity guard to
 * subscribe time and lets a previous account's departure through after a user
 * switch. Relatedly, `detail.scopeGeneration` is deliberately not
 * optional-chained: it is safe only because `detail?.scopeKey !== scope.key`
 * short-circuits the ||. Reorder or split those clauses and a detail-less
 * event throws.
 *
 * setDepartureMs must arrive as its RAW identity (a useTraceDraft dispatcher
 * keyed to the auth scope). The listener re-registers exactly on identity
 * change today; an inline `(ms) => setDepartureMs(ms)` wrapper would tear it
 * down and re-add it on every render of a 6,500-line component.
 *
 * `coordCaptureRef.current = coordCaptureMode` stays UNCONDITIONAL and outside
 * the `if (coordCaptureMode)` block, and this hook must stay above the
 * map-controller props that read that ref at tap time. Fold the mirror into
 * the true branch and the ref latches true forever, so every later chart tap
 * is swallowed by the tracer branch.
 *
 * Bootstrap deps stay exactly [coordCaptureMode]: setPlotArmed(true)
 * force-rearms the pen on each run, so widening the deps re-arms it while the
 * skipper has deliberately paused it.
 *
 * The bootstrap's saved-routes merge is IDENTITY-GUARDED. It is a network
 * round trip, so a sign-out or account switch while it is in flight would
 * otherwise land the previous account's routes in the picker. The guard is the
 * same expectedScope pattern every other saved-routes path uses; there is
 * still no cancellation, which is fine because the guard makes a late arrival
 * a no-op rather than a leak.
 */

import { useEffect } from 'react';
import type { Dispatch, SetStateAction } from 'react';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../../services/authIdentityScope';
import { loadSavedTraces, type SavedTrace } from '../../services/routeTracer';

export interface TracerSessionEffectDeps {
    coordCaptureMode: boolean;
    embedded: boolean;
    pickerMode: boolean;
    isPinView: boolean;
    /** Raw useTraceDraft dispatcher identity — never an inline wrapper. */
    setDepartureMs: (ms: number | null) => void;
    /** The ref OBJECT: read at tap time by the map controller. */
    coordCaptureRef: { current: boolean };
    setPlotArmed: Dispatch<SetStateAction<boolean>>;
    setSavedTraces: Dispatch<SetStateAction<SavedTrace[]>>;
}

export function useTracerSessionEffects({
    coordCaptureMode,
    embedded,
    pickerMode,
    isPinView,
    setDepartureMs,
    coordCaptureRef,
    setPlotArmed,
    setSavedTraces,
}: TracerSessionEffectDeps): void {
    // Routing-page declutter (Shane 2026-07-17): tell app-level chrome (the
    // Bosun mic orb over the map) when the tracer is active so it steps
    // aside; Done brings it back.
    useEffect(() => {
        if (embedded || pickerMode || isPinView) return;
        const say = (active: boolean) => {
            try {
                window.dispatchEvent(new CustomEvent('thalassa:tracer-active', { detail: { active } }));
            } catch {
                /* chrome just stays visible */
            }
        };
        say(coordCaptureMode);
        // Done no longer exits trace mode (2026-07-17) — the tab bar does,
        // by UNMOUNTING MapHub. Without this cleanup the mic orb would stay
        // hidden on every other page after leaving mid-trace.
        return () => say(false);
    }, [coordCaptureMode, embedded, pickerMode, isPinView]);

    // Departure set on the PLAN page (DepartControl) → adopt it here so the
    // tide windows / weather ETAs re-anchor without a remount.
    useEffect(() => {
        const onDep = (e: Event) => {
            const detail = (e as CustomEvent).detail as
                | { ms?: unknown; scopeKey?: unknown; scopeGeneration?: unknown }
                | undefined;
            const scope = getAuthIdentityScope();
            if (detail?.scopeKey !== scope.key || detail.scopeGeneration !== scope.generation) return;
            const ms = detail.ms;
            setDepartureMs(typeof ms === 'number' && Number.isFinite(ms) ? ms : null);
        };
        window.addEventListener('thalassa:departure-changed', onDep);
        return () => window.removeEventListener('thalassa:departure-changed', onDep);
    }, [setDepartureMs]);
    // (Tap-the-water popup suppression lives below, after mapRef/mapReady
    // are declared — it's per-map now, not module-global.)
    useEffect(() => {
        coordCaptureRef.current = coordCaptureMode;
        if (coordCaptureMode) {
            // Every tracer open starts with the pen ARMED — pausing is a
            // within-session choice, never a haunting state.
            setPlotArmed(true);
            setSavedTraces(loadSavedTraces());
            // Desktop builder (Phase 5): register cloud ENC cells (idempotent,
            // signed-in only — a browser can't reach the Pi) and pull the
            // account's saved routes; refresh the list when the merge lands.
            void import('../../services/enc/cloudCellSync')
                .then(({ registerCloudCells }) => registerCloudCells())
                .catch(() => {});
            // Identity-guarded: the merge is a network round trip, and a
            // sign-out or account switch while it is in flight would otherwise
            // land the PREVIOUS account's routes in the picker. Same
            // expectedScope pattern every other saved-routes path here uses.
            const expectedScope = getAuthIdentityScope();
            void import('../../services/savedRoutesSync')
                .then(({ syncSavedRoutes }) => syncSavedRoutes())
                .then((merged) => {
                    if (!isAuthIdentityScopeCurrent(expectedScope)) return;
                    setSavedTraces(merged);
                })
                .catch(() => {});
        }
        // The three identities below are named only to satisfy
        // exhaustive-deps, which loses sight of their stability once they
        // arrive as parameters rather than as useRef/useState results in the
        // same component. All three are stable for MapHub's lifetime, so this
        // is runtime-inert: the EFFECTIVE dep is still coordCaptureMode alone,
        // which matters because setPlotArmed(true) force-rearms the pen on
        // every run and a genuinely wider dep would re-arm it under a skipper
        // who had deliberately paused.
    }, [coordCaptureMode, coordCaptureRef, setPlotArmed, setSavedTraces]);
}
