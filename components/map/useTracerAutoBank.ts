/**
 * useTracerAutoBank — the tracer banks the check of an unchanged stored line
 * without Save (build 124, B5). The rule itself is traceAutoBankSignature; this
 * hook is MapHub's call site, pulled out so it can be driven in tests beside
 * the real grading hook.
 *
 * THE PAIRING GUARD IS THE POINT. MapHub's release gate is memoised on the pins
 * and the vessel but reads legVerdicts and the tide-window label, and both land
 * one render AFTER the pins or the keel change. So the first render after a
 * route load or a draft edit pairs the NEW line with the OLD verdicts (or the
 * last route's tide window) and the gate can say "allowed". Banking that wrote
 * "checked today" over legs nobody graded at this keel (review, 2026-10-08).
 * So it banks only when:
 *
 *  - Route Tracer is in capture mode — a closed tracer never re-grades, so its
 *    kept-alive verdicts must never meet a new draft;
 *  - the verdicts in hand were graded for exactly these pins at this keel and
 *    mast (tracerGradingMatches);
 *  - a tide-gated line's window label was computed for these verdicts and this
 *    departure;
 *  - a draft locked to a trip's slot (126-16a) is matched to THAT leg only. A
 *    copy of another trip's leg that joins at 0 NM has exactly its source's
 *    pins, and a geometry match alone banked the copy's check (even a leg
 *    acknowledged for the new trip) onto the source before Save, against "the
 *    original is unchanged". An empty slot banks nothing; Save writes it.
 *
 * Every write logs with log.warn and why (log.info is a no-op in production).
 */
import { useEffect, useRef } from 'react';
import {
    bankTraceVerification,
    loadSavedTraces,
    type NextLegSeed,
    type SavedTrace,
    type TraceLegVerdict,
    type TracePoint,
} from '../../services/routeTracer';
import { traceAutoBankSignature, traceGeometryKey, type TraceReleaseGate } from '../../services/traceVerification';
import { legInSlot } from '../../services/tripReverse';
import { vesselDraftIsAssumed, vesselDraftMetres } from '../../services/units';
import { tracerGradingMatches, type TracerGradingDeps } from './useTracerGrading';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('tracerAutoBank');

/** Which verdicts and departure the current tide-window label answers. */
export interface TideLabelFor {
    verdicts: ReadonlyArray<TraceLegVerdict | null>;
    departureMs: number | null;
}

export interface TracerAutoBankDeps {
    coordCaptureMode: boolean;
    capturedCoords: ReadonlyArray<TracePoint>;
    legVerdicts: ReadonlyArray<TraceLegVerdict | null>;
    /** MapHub's memoised release gate for the line on screen. */
    release: TraceReleaseGate;
    ackedLegs: ReadonlySet<number>;
    vessel: TracerGradingDeps['vessel'];
    departureMs: number | null;
    /** Set by MapHub's tide-window effect when its label lands; null while it
     *  is recomputing. */
    tideLabelForRef: { current: TideLabelFor | null };
    savedTraces: readonly SavedTrace[];
    setSavedTraces: (traces: SavedTrace[]) => void;
    /** The trip slot the draft is locked to, if any: only that leg can bank. */
    legAnchor?: Pick<NextLegSeed, 'tripId' | 'ordinal'> | null;
}

export function useTracerAutoBank(deps: TracerAutoBankDeps): void {
    const {
        coordCaptureMode,
        capturedCoords,
        legVerdicts,
        release,
        ackedLegs,
        vessel,
        departureMs,
        tideLabelForRef,
        savedTraces,
        setSavedTraces,
        legAnchor = null,
    } = deps;
    const ackPersistRef = useRef<string | null>(null);
    useEffect(() => {
        if (!coordCaptureMode) return;
        const key = traceGeometryKey(capturedCoords);
        if (!key) return;
        // An edit in progress, or never saved, matches nothing — left alone.
        // A slot-locked draft is that leg or nothing: never a geometry twin
        // in another trip or slot.
        const slotRow = legAnchor ? legInSlot(savedTraces, legAnchor) : null;
        const candidates = legAnchor ? (slotRow ? [slotRow] : []) : savedTraces;
        const stored = candidates.find((t) => traceGeometryKey(t.points) === key);
        if (!stored) return;
        const label = tideLabelForRef.current;
        if (
            legVerdicts.some((v) => v?.needsTide) &&
            (label?.verdicts !== legVerdicts || label.departureMs !== departureMs)
        ) {
            return; // the tide window on hand may be the last line's
        }
        const signature = traceAutoBankSignature(
            stored,
            release,
            { draftM: vesselDraftMetres(vessel), draftAssumed: vesselDraftIsAssumed(vessel), nowMs: Date.now() },
            ackedLegs,
            tracerGradingMatches(legVerdicts, capturedCoords, vessel),
        );
        // One write per (route, geometry, draft, acknowledgements), not per render.
        if (!signature || !release.verification || ackPersistRef.current === signature) return;
        ackPersistRef.current = signature;
        const why = !stored.verification ? 'no stored check' : ackedLegs.size > 0 ? 'legs acknowledged' : 'new draft';
        const banked = bankTraceVerification(stored.id, release.verification);
        log.warn(
            banked.banked
                ? `tracer auto-bank banked ${stored.id} (${why})`
                : `tracer auto-bank skipped ${stored.id} (${banked.reason}; ${why})`,
        );
        setSavedTraces(loadSavedTraces());
    }, [
        coordCaptureMode,
        capturedCoords,
        legVerdicts,
        release,
        ackedLegs,
        vessel,
        departureMs,
        tideLabelForRef,
        savedTraces,
        setSavedTraces,
        legAnchor,
    ]);
}
