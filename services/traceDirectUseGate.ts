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
    const vessel = useSettingsStore.getState().settings.vessel;
    return traceCastOffBlockReason(verification, route.points, {
        draftM: vesselDraftMetres(vessel),
        draftAssumed: vesselDraftIsAssumed(vessel),
        encRegistryFingerprint: getRegistryFingerprint(),
        voyageDepartureMs: verification?.departureMs ?? null,
        nowMs,
    });
}
