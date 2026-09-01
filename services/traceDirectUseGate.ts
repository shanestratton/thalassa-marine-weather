/** Final gate for using a canonical traced route outside MapHub (for example
 * Log's "Following a route?" flow). Legacy/unverified mirrors must not gain a
 * second route into follow/publication after MapHub itself was hardened. */

import type { RouteOrTrack } from './shiplog/RoutesAndTracks';
import { buildTripPassageRollups, legBadgeOrdinal, loadSavedTraces, stripLegBadge } from './routeTracer';
import { normaliseTraceVerification, traceFollowBlockReason } from './traceVerification';
import { useSettingsStore } from '../stores/settingsStore';
import { vesselDraftIsAssumed, vesselDraftMetres } from './units';

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

export function tracedRouteDirectUseBlockReason(
    route: Pick<RouteOrTrack, 'savedRouteId' | 'points'>,
    nowMs: number = Date.now(),
): string | null {
    const routeId = route.savedRouteId?.trim();
    if (!routeId) return null; // ordinary planner route

    const saved = loadSavedTraces().find((trace) => trace.id === routeId);
    if (!saved) {
        return 'This traced route is not verified on this device. Open it in Route Tracer, check every leg and save it again.';
    }
    const verification = normaliseTraceVerification(saved.verification, route.points);

    // Name the RIGHT cause when the trace is fine and the geometry is not.
    //
    // Log follow always steers `route.points`, which LogPage builds from the
    // voyage's ship-log ENTRIES (fetchVoyageAsTrack / groupByVoyage) — not
    // from the tracer's waypoints. `savedRouteId` is only a link those entries
    // carry. So for a voyage whose recorded track differs from the checked
    // line, the geometry binding fails and the generic reason told the skipper
    // "no valid check for its current waypoints — open Route Tracer and check
    // it again", which is both wrong and impossible to satisfy: the trace IS
    // checked, and re-checking it cannot change the voyage's logged track.
    // (Shane 2026-08-07: "i just checked the route through tracer, and the
    // message is still there ????")
    //
    // Still blocked — following an unchecked line is the thing the gate exists
    // to prevent — but now with a cause that is true and an action that works.
    if (!verification && normaliseTraceVerification(saved.verification, saved.points)) {
        // Name the CONTROL, not just the screen. "Open Route Tracer" left the
        // skipper hunting; Sail is the button that actually starts following,
        // and it steers capturedCoords — the checked line — through its own
        // release gate, which is why it is the supported path rather than a
        // workaround. (Shane 2026-08-07: "how do i get past that message.")
        return 'This voyage’s recorded track is not the line Route Tracer checked. Open the route in Route Tracer and tap Sail to follow the checked line — or choose “Just recording” to log this passage without a route.';
    }

    // The FOLLOW gate, not the Cast Off gate (Shane 2026-08-10: "once a
    // punter accepts certain issues with routes then they are good to go").
    // Cast Off's tide-window/departure/ENC-drift blocks belong to the
    // publication event; re-sailing an accepted saved line from the Log only
    // needs the acceptance itself to still hold — same waypoints, same keel,
    // checked within a month. See traceFollowBlockReason for the reasoning.
    const vessel = useSettingsStore.getState().settings.vessel;
    return traceFollowBlockReason(verification, route.points, {
        draftM: vesselDraftMetres(vessel),
        draftAssumed: vesselDraftIsAssumed(vessel),
        nowMs,
    });
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
 * here and is offered optimistically — if picked, the gate refuses with the
 * "not verified on this device" reason, which is true and actionable.
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

export function savedTraceFollowBlockReason(savedRouteId: string, nowMs: number = Date.now()): string | null {
    const routeId = savedRouteId.trim();
    if (!routeId) return 'This route has no saved trace on this device.';
    const saved = loadSavedTraces().find((trace) => trace.id === routeId);
    if (!saved) return 'This route has no saved trace on this device.';
    const vessel = useSettingsStore.getState().settings.vessel;
    return traceFollowBlockReason(saved.verification, saved.points, {
        draftM: vesselDraftMetres(vessel),
        draftAssumed: vesselDraftIsAssumed(vessel),
        nowMs,
    });
}
