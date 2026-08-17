/**
 * traceRecheck — re-run a route's hazard check without the tracer on screen.
 *
 * A traced route's clearance expires: the check is bound to a draft, a chart
 * library and a moment in time, and after thirty days the Log page blocks
 * following it. The only way to clear that was to open Route Tracer and watch
 * it re-grade, which is why a blocked route felt like a dead end.
 *
 * ── The three things that make this safe rather than a rubber stamp ─────────
 *
 * 1. IT NEVER READS THE VERDICT CACHE. hydrateLegVerdicts keys only on draft +
 *    ENC fingerprint — there is no timestamp in the key. So the case a recheck
 *    is FOR (a clean route that merely aged past thirty days, same boat, same
 *    charts) is exactly the case where the cache still holds every verdict. A
 *    recheck that consulted it would re-stamp checkedAt from cached results
 *    and clear the route without looking at anything. That is worse than no
 *    recheck at all: it launders a stale clearance into a fresh one.
 *
 * 2. IT CANNOT CLEAR A DANGER LEG BY ITSELF. evaluateTraceRelease refuses to
 *    mint a verification while any danger leg is unacknowledged, and an
 *    acknowledgement is a human tap in the tracer's report. Passing an empty
 *    ack set makes an automatic clearance structurally impossible — the
 *    guarantee lives in the pure gate, not in this file's good behaviour.
 *
 * 3. IT REFUSES ON DEGRADED DATA. A window whose gate-mark fetch threw grades
 *    weaker than one that succeeded, and the loop reports those legs volatile.
 *    Any volatile leg fails the recheck. Offline, that means it declines
 *    rather than quietly grading against a thinner chart set and calling it
 *    verified.
 *
 * A refusal is not a failure of this service; it is the answer. The route
 * stays blocked and the skipper is sent to the tracer, which is what Shane
 * asked for: "warn — but not let us go."
 */
import {
    evaluateTraceRelease,
    normaliseTraceVerification,
    type TraceReleaseGate,
    type TraceVerification,
} from './traceVerification';
import {
    commonDepartureWindowLabel,
    TRACE_LAND_CROSSING_MESSAGE,
    type TraceLegVerdict,
    type TracePoint,
} from './routeTracer';
import { gradeLegs } from './traceGrading';
import { getVersion as getEncRegistryVersion, getRegistryFingerprint } from './enc/EncCellMetadata';
import { useSettingsStore } from '../stores/settingsStore';
import { vesselDraftMetres, vesselDraftIsAssumed } from './units';
import { createLogger } from '../utils/createLogger';

const log = createLogger('traceRecheck');

/** Matches the interactive tracer's build-cost ceiling per window. */
const RECHECK_CLUSTER_SPAN_M = 20_000;

/**
 * What the report needs to render, handed back on a refusal.
 *
 * The grading pass already computed every one of these and used to throw them
 * away, so a skipper who needed to acknowledge a no-go leg was sent to Route
 * Tracer to have the SAME work done again in front of them. Returning them
 * lets the Log page show the route report in place (Shane, 2026-08-18: "just
 * trying to make it an easier task than it currently is").
 */
export interface RecheckReport {
    verdicts: Array<TraceLegVerdict | null>;
    tideWindowLabel: string | null;
    status: string;
    /** Legs an acknowledgement alone could clear — no waypoint has to move. */
    ackableDangerLegs: number[];
}

export type RecheckOutcome =
    | { ok: true; verification: TraceVerification }
    /**
     * `needsTracer` distinguishes "look at this yourself" from "conditions
     * were wrong". A danger leg needs a human decision; a failed chart load
     * needs a connection. Sending someone to the tracer for the second is how
     * the old dead end felt.
     */
    | { ok: false; reason: string; needsTracer: boolean; report?: RecheckReport };

export interface RecheckOptions {
    /** Carries forward prior danger acknowledgements, under strict conditions. */
    priorVerification?: TraceVerification | null;
    departureMs?: number | null;
    signal?: AbortSignal;
    onProgress?: (gradedLegs: number, totalLegs: number) => void;
}

/**
 * Which danger legs may inherit the skipper's earlier acknowledgement.
 *
 * THREE conditions, and the third was missing on first write — a real
 * false-clearance path, caught in adversarial review:
 *
 *  1. the chart library is byte-for-byte the one they acknowledged against;
 *  2. the keel is the one they acknowledged against;
 *  3. every leg now grading danger was already acknowledged.
 *
 * (1) and (3) are about identity: the envelope stores bare leg INDICES with no
 * issue identity, so after a chart update index 3 may be a different hazard,
 * and a NEW danger leg is one nobody has looked at.
 *
 * (2) is about meaning, and it is the one that bites hardest here, because a
 * CHANGED DRAFT IS ONE OF ONLY TWO THINGS THAT BLOCKS FOLLOW — so it is a
 * primary reason the skipper is on this path at all. traceFollowBlockReason's
 * own note puts it plainly: "a deeper keel voids every depth verdict the
 * acceptance rested on." Accepting a rock at 1.2 m says nothing about the same
 * rock at 2.4 m. Without this check, changing the draft blocked the route, and
 * then the very recheck offered to clear the block re-minted the old
 * acknowledgement against the new keel and unblocked it — a clearance the
 * interactive tracer would have refused, since it drops every ack on each
 * grading pass and wipes its caches the moment the draft moves.
 */
export function inheritableAcks(
    prior: TraceVerification | null | undefined,
    verdicts: ReadonlyArray<TraceLegVerdict | null>,
    encFingerprintNow: string,
    draftMNow: number,
    draftAssumedNow: boolean,
): Set<number> {
    if (!prior || prior.encRegistryFingerprint !== encFingerprintNow) return new Set();
    // Same 0.01 m tolerance the follow and cast-off gates already use.
    if (prior.draftAssumed !== draftAssumedNow || Math.abs(prior.draftM - draftMNow) > 0.01) return new Set();
    const dangerNow = verdicts.reduce<number[]>((acc, v, i) => (v?.grade === 'danger' ? [...acc, i] : acc), []);
    const acked = new Set(prior.acknowledgedDangerLegs ?? []);
    if (!dangerNow.every((i) => acked.has(i))) return new Set();
    return new Set(dangerNow);
}

export async function recheckTrace(
    points: ReadonlyArray<TracePoint>,
    opts: RecheckOptions = {},
): Promise<RecheckOutcome> {
    if (points.length < 2) {
        return { ok: false, reason: 'This route needs at least two waypoints.', needsTracer: true };
    }

    const vessel = useSettingsStore.getState().settings?.vessel;
    const draftM = vesselDraftMetres(vessel);
    const draftAssumed = vesselDraftIsAssumed(vessel);
    if (draftAssumed) {
        // vesselDraftMetres falls back to 2.5 m for an unset profile. Grading
        // a keel nobody entered and stamping the result "checked" is a false
        // clearance aimed squarely at a new user's first passage.
        return {
            ok: false,
            reason: 'Set your vessel draft first — a route cannot be checked against a guessed keel.',
            needsTracer: false,
        };
    }

    const legs = points.slice(1).map((b, i) => ({
        a: points[i],
        b,
        key: i === points.length - 2 ? `${i}|last` : `${i}`,
    }));

    const verdictByKey = new Map<string, TraceLegVerdict>();
    let sawVolatile = false;
    let graded = 0;

    const result = await gradeLegs(legs, {
        draftM,
        draftAssumed,
        clusterSpanM: RECHECK_CLUSTER_SPAN_M,
        // No ctxFromLru and no holdCtx: a recheck is COLD by construction.
        // Reusing the interactive tracer's held windows would reintroduce
        // exactly the staleness the whole exercise exists to remove.
        superseded: () => opts.signal?.aborted === true,
        onLeg: (key, verdict, isVolatile) => {
            verdictByKey.set(key, verdict);
            if (isVolatile) sawVolatile = true;
            graded += 1;
            opts.onProgress?.(graded, legs.length);
        },
    });

    if (result.superseded) return { ok: false, reason: 'Check cancelled.', needsTracer: false };

    if (sawVolatile) {
        // A transient failure is not a clean check. Say which way it failed,
        // because "reconnect" and "look at this leg" are different actions.
        return {
            ok: false,
            reason: 'Part of this route could not be checked against the charts. Reconnect and try again.',
            needsTracer: false,
        };
    }

    const verdicts = legs.map((l) => verdictByKey.get(l.key) ?? null);

    let tideWindowLabel: string | null = null;
    if (verdicts.some((v) => v?.needsTide)) {
        try {
            tideWindowLabel = await commonDepartureWindowLabel(verdicts, draftM, {
                departureMs: opts.departureMs ?? Date.now(),
            });
        } catch (e) {
            log.warn('tide window lookup failed during recheck:', (e as Error)?.message || e);
            // Left null. evaluateTraceRelease refuses on a null label for a
            // tide-gated route, which is the correct outcome: a shallow leg
            // whose tide could not be checked has not been checked.
        }
    }

    const departureMs = opts.departureMs ?? Date.now();
    const gate = evaluateTraceRelease(
        points,
        result.status,
        verdicts,
        inheritableAcks(opts.priorVerification, verdicts, getRegistryFingerprint(), draftM, draftAssumed),
        {
            draftM,
            draftAssumed,
            encRegistryVersion: getEncRegistryVersion(),
            encRegistryFingerprint: getRegistryFingerprint(),
            departureMs,
            tideWindowLabel,
        },
    );

    if (!gate.allowed || !gate.verification) {
        // Never write anything on a refusal — the existing envelope stays
        // exactly as it was, and the route stays blocked.
        //
        // A land crossing has NO acknowledgement path at all (evaluateTraceRelease
        // refuses it before the ack machinery), so those legs are excluded: they
        // need a waypoint moved, which is an edit, which needs the editor.
        // Everything else grading danger can be cleared by a person deciding —
        // and a person can decide anywhere.
        const ackableDangerLegs = verdicts.reduce<number[]>(
            (acc, v, i) =>
                v?.grade === 'danger' && !v.issues?.some((iss) => iss.message === TRACE_LAND_CROSSING_MESSAGE)
                    ? [...acc, i]
                    : acc,
            [],
        );
        return {
            ok: false,
            reason: gate.reason || 'This route could not be cleared.',
            needsTracer: verdicts.some((v) => v?.grade === 'danger') || result.status === 'ready',
            report: { verdicts, tideWindowLabel, status: result.status, ackableDangerLegs },
        };
    }

    const verification = normaliseTraceVerification(gate.verification, points);
    if (!verification) {
        return { ok: false, reason: 'The check did not match this route’s waypoints.', needsTracer: true };
    }
    return { ok: true, verification };
}

/**
 * Re-run the release gate with the acknowledgements a skipper has just made.
 *
 * The gate is pure and cheap, so the caller can call this on every tap to keep
 * the report's own state honest — and the CHECK itself is never re-run, which
 * is the point: the grading already happened, and acknowledging is a decision
 * about that grading rather than a reason to repeat it.
 *
 * The same three refusals still apply, because this is the same gate: a
 * guessed keel is rejected before it is reached, a land crossing has no
 * acknowledgement path inside evaluateTraceRelease, and a tide-gated leg with
 * no window still refuses. Nothing here can widen what the gate allows.
 */
export function releaseWithAcks(
    points: ReadonlyArray<TracePoint>,
    report: RecheckReport,
    ackedLegs: ReadonlySet<number>,
): TraceReleaseGate {
    const vessel = useSettingsStore.getState().settings?.vessel;
    return evaluateTraceRelease(points, report.status as never, report.verdicts, ackedLegs, {
        draftM: vesselDraftMetres(vessel),
        draftAssumed: vesselDraftIsAssumed(vessel),
        encRegistryVersion: getEncRegistryVersion(),
        encRegistryFingerprint: getRegistryFingerprint(),
        departureMs: Date.now(),
        tideWindowLabel: report.tideWindowLabel,
    });
}
