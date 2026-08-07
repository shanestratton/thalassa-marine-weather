/** Final gate for using a canonical traced route outside MapHub (for example
 * Log's "Following a route?" flow). Legacy/unverified mirrors must not gain a
 * second route into follow/publication after MapHub itself was hardened. */

import type { RouteOrTrack } from './shiplog/RoutesAndTracks';
import { loadSavedTraces } from './routeTracer';
import { normaliseTraceVerification, traceCastOffBlockReason } from './traceVerification';
import { useSettingsStore } from '../stores/settingsStore';
import { vesselDraftIsAssumed, vesselDraftMetres } from './units';
import { getRegistryFingerprint } from './enc/EncCellMetadata';

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
        return 'This voyage’s recorded track is not the line Route Tracer checked. Open the route in Route Tracer to follow the checked version.';
    }

    const vessel = useSettingsStore.getState().settings.vessel;
    return traceCastOffBlockReason(verification, route.points, {
        draftM: vesselDraftMetres(vessel),
        draftAssumed: vesselDraftIsAssumed(vessel),
        encRegistryFingerprint: getRegistryFingerprint(),
        voyageDepartureMs: verification?.departureMs ?? null,
        nowMs,
    });
}
