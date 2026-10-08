/** Final gate for using a canonical traced route outside MapHub (for example
 * Log's "Following a route?" flow). Since build 124 it WARNS rather than
 * walls (Shane 2026-10-08): an unchecked line follows with its reason said,
 * and only a real check's unacknowledged finding needs a deliberate second
 * tap. The geometry rule is unchanged — steer exactly what was checked. */

import type { RouteOrTrack } from './shiplog/RoutesAndTracks';
import { buildTripPassageRollups, legBadgeOrdinal, loadSavedTraces, stripLegBadge } from './routeTracer';
import {
    normaliseTraceVerification,
    traceFollowStatus,
    type TraceFollowContext,
    type TraceFollowStatus,
} from './traceVerification';
import { getTraceCheckOutcome } from './traceCheckOutcomes';
import { plannedRouteDryFinding } from './routing/dryRunWords';
import { useSettingsStore } from '../stores/settingsStore';
import { vesselDraftIsAssumed, vesselDraftMetres } from './units';

function followContext(nowMs: number): TraceFollowContext {
    const vessel = useSettingsStore.getState().settings.vessel;
    return { draftM: vesselDraftMetres(vessel), draftAssumed: vesselDraftIsAssumed(vessel), nowMs };
}

export type TraceDirectUseStatus = TraceFollowStatus & {
    /** Only a red finding the skipper has not accepted (the second tap). */
    blocked: boolean;
};

/**
 * The geometry that should actually be STEERED for a route.
 *
 * For a trace-linked voyage this is the saved trace's own waypoints, not the
 * line the Log assembled. Those differ for a mundane reason: a log group is
 * built from ship-log ENTRIES, which include recorder rows the tracer never
 * drew — `Voyage Start`, `Voyage End`, `Latest Position`. Following that line
 * would steer a route with the boat's current position spliced into it.
 *
 * Substituting here rather than at the check is the whole point. The gate
 * verifies the geometry it is handed, so as long as callers steer what they
 * verified, the two can never disagree — which is the bug this replaces, where
 * the check bound to one line and follow steered another. Callers must pass
 * the SAME object to this, to the gate, and to startFollowing.
 *
 * Falls through to the route untouched when there is no trace, or the trace is
 * unusable — the gate then refuses it on its own terms rather than this
 * silently inventing geometry.
 */
export function tracedRouteFollowGeometry<T extends Pick<RouteOrTrack, 'savedRouteId' | 'points'>>(route: T): T {
    const routeId = route.savedRouteId?.trim();
    if (!routeId) return route;
    const saved = loadSavedTraces().find((trace) => trace.id === routeId);
    if (!saved || saved.points.length < 2) return route;
    return { ...route, points: saved.points };
}

/**
 * The follow verdict for a route the Log or Cast Off is about to steer —
 * a warning, not a wall (build 124). Amber never blocks; red blocks until
 * `acceptFinding` (the deliberate second tap, or the act of casting off).
 */
export function tracedRouteDirectUseStatus(
    route: Pick<RouteOrTrack, 'savedRouteId' | 'points' | 'caveats'>,
    opts: { acceptFinding?: boolean; nowMs?: number } = {},
): TraceDirectUseStatus {
    const routeId = route.savedRouteId?.trim();
    // An ordinary planner route: no trace, no check to have — unless the
    // router drew it red where no tide clears it (package 125-05): then that
    // is its finding, and following it takes the second tap.
    if (!routeId) {
        const dry = plannedRouteDryFinding(route.caveats);
        return dry
            ? { ...dry, blocked: opts.acceptFinding !== true }
            : { tone: 'checked', code: 'ok', reason: null, blocked: false };
    }

    const saved = loadSavedTraces().find((trace) => trace.id === routeId);
    if (!saved) {
        return { tone: 'unchecked', code: 'none', reason: 'Not checked on this device yet', blocked: false };
    }
    // Name the RIGHT cause when the trace is checked and the steered geometry
    // is not the checked line: re-checking cannot change a voyage's recorded
    // track (Shane 2026-08-07: "i just checked the route through tracer, and
    // the message is still there ????"). Amber now, like every missing check.
    if (
        !normaliseTraceVerification(saved.verification, route.points) &&
        normaliseTraceVerification(saved.verification, saved.points)
    ) {
        return {
            tone: 'unchecked',
            code: 'none',
            reason: 'This voyage’s recorded track is not the line Route Tracer checked. Keep a good lookout.',
            blocked: false,
        };
    }
    const status = traceFollowStatus(
        saved.verification,
        route.points,
        followContext(opts.nowMs ?? Date.now()),
        getTraceCheckOutcome(routeId),
    );
    return { ...status, blocked: status.tone === 'finding' && opts.acceptFinding !== true };
}

/** Kept for older callers: a reason only when following is refused (red). */
export function tracedRouteDirectUseBlockReason(
    route: Pick<RouteOrTrack, 'savedRouteId' | 'points'>,
    nowMs: number = Date.now(),
): string | null {
    const status = tracedRouteDirectUseStatus(route, { nowMs });
    return status.blocked ? status.reason : null;
}

/**
 * Followability of a SAVED TRACE by id — the sync check behind the Log's
 * "Following a route?" picker filter (Shane 2026-08-10: "just show tracks
 * that are ready to be followed" instead of letting a pick fail with chart-
 * safety prose). Checks the trace's own points, which is exactly the
 * geometry tracedRouteFollowGeometry will steer for a trace-linked voyage.
 */
/**
 * voyageId → savedRouteId for every trace on THIS device, read off the
 * plannedRouteId / passageVoyageId mirrors each saved trace carries.
 *
 * Why this exists: the Log's picker filter used to learn a plan's trace link
 * only from RESIDENT ship-log entries. On a fresh boot the Log holds
 * summaries, not entries — so every trace-linked plan looked "ordinary" (no
 * gate to fail), was offered, and then REFUSED at pick time when the fetch
 * revealed the link (Shane 2026-08-13: refusal card for a route the picker
 * itself had just offered). The trace store already knows the link locally;
 * asking it costs nothing and needs no network.
 *
 * A plan whose trace lives only on ANOTHER device still resolves to nothing
 * here and is offered optimistically — if picked, the Log adopts the trace
 * from the account and follows it amber ("not checked on this device yet").
 */
export function localTraceLinkByVoyageId(): Map<string, string> {
    const links = new Map<string, string>();
    for (const trace of loadSavedTraces()) {
        if (trace.plannedRouteId) links.set(trace.plannedRouteId, trace.id);
        if (trace.passageVoyageId) links.set(trace.passageVoyageId, trace.id);
    }
    return links;
}

/**
 * Trip identity for each saved trace, keyed by trace id.
 *
 * The cast-off "Following a route?" sheet lists VoyageSummary rows, which carry
 * no trip or leg identity of their own — so on their own they can only be shown
 * as a flat list, while the Plan page shows the same routes grouped into
 * passages with their legs beneath (Shane 2026-08-30: give the follow sheet
 * "the gold standard treatment").
 *
 * The link already exists and is an explicit id rather than a name match: a
 * trace carries `plannedRouteId`, and the sheet already resolves each row to a
 * `savedRouteId`. This turns that id into the grouping the Plan page uses,
 * from the same trace store, so the two lists cannot describe the same trip
 * differently.
 *
 * Only trips with two or more legs PRESENT get a passage name — a lone leg
 * under no passage heading is an arrow pointing at nothing.
 */
export interface TraceTripIdentity {
    tripId: string;
    legOrdinal?: number;
    /** "<origin> - <destination> (Passage)", absent for a one-leg trip. */
    tripName?: string;
    /** The trace's own saved display name, badge-stripped — the name the PLAN
     *  library shows. Carried so the cast-off sheet can print the same name
     *  instead of re-deriving one from geocoded endpoints (Shane 2026-09-02:
     *  "the names are incorrect and some are even missing"). */
    legName?: string;
}

export function tripIdentityByTraceId(): Map<string, TraceTripIdentity> {
    const traces = loadSavedTraces();
    const nameByTrip = new Map<string, string>();
    for (const rollup of buildTripPassageRollups(traces)) nameByTrip.set(rollup.tripId, rollup.name);

    const out = new Map<string, TraceTripIdentity>();
    for (const trace of traces) {
        if (!trace.tripId) continue;
        const tripName = nameByTrip.get(trace.tripId);
        // No rollup means fewer than two legs are on this device; treat the
        // trace as standalone rather than orphaning it under a missing heading.
        if (!tripName) continue;
        // Ordinal falls back to the name badge inside a trip — a cloud
        // round-trip can drop the structural field (mirrors CrewManagement).
        const legOrdinal = trace.legOrdinal ?? legBadgeOrdinal(trace.name) ?? undefined;
        const legName = typeof trace.name === 'string' && trace.name.trim() ? stripLegBadge(trace.name) : undefined;
        out.set(trace.id, { tripId: trace.tripId, legOrdinal, tripName, legName });
    }
    return out;
}

/** The row status of a SAVED TRACE by id, on its own pins — the Log sheet's
 *  per-row verdict (build 124: three states, see traceFollowStatus). */
export function savedTraceFollowStatus(savedRouteId: string, nowMs: number = Date.now()): TraceFollowStatus {
    const routeId = savedRouteId.trim();
    const saved = routeId ? loadSavedTraces().find((trace) => trace.id === routeId) : undefined;
    if (!saved) return { tone: 'unchecked', code: 'none', reason: 'Not checked on this device yet' };
    return traceFollowStatus(saved.verification, saved.points, followContext(nowMs), getTraceCheckOutcome(routeId));
}
