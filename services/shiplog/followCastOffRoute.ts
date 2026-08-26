/**
 * followCastOffRoute — put a just-cast-off passage's own line on the chart
 * and the public page, automatically.
 *
 * Born with the Cast Off convergence (Shane 2026-08-25: Cast Off from
 * passage planning must end where the Log slider ends — "and dont forget to
 * add it to the public page if appropriate"). The Log slider's flow asks
 * "Follow a route?" because it cannot know which; a passage cast off from
 * planning IS its route, so asking would be a question with one answer.
 *
 * Runs the SAME verification sequence the Log page's manual follow runs —
 * fetch the voyage's trace geometry, refuse anything the direct-use gate
 * blocks (an unverified trace must never advertise a line on MapHub or the
 * public page; that gate exists because a legacy trace once bypassed it),
 * then start the local follow and publish. "If appropriate" is enforced by
 * construction: a blocked or missing geometry returns false and the caller
 * lands on the Log page, whose own follow sheet remains the fallback.
 *
 * The Log page then treats this follow as the answered question: its
 * auto-sheet guard sees a follow that STARTED after the voyage began and
 * records it as confirmed rather than re-asking (hardening 2026-08-01).
 */
import { fetchVoyageAsTrack, type RouteOrTrack } from './RoutesAndTracks';
import { buildFollowRoutePlan, buildFollowRoutePlanFromRoute } from './followRoutePlan';
import { displayRouteLabel, loadSavedTraces } from '../routeTracer';
import { markRouteKitAnswered } from '../../utils/passageClass';
import { publishFollowedRoute } from './publishFollowedRoute';
import { useFollowRouteStore } from '../../stores/followRouteStore';
import { tracedRouteDirectUseBlockReason, tracedRouteFollowGeometry } from '../traceDirectUseGate';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('followCastOffRoute');

/**
 * Follow the voyage's planned route locally and publish it to the public
 * page. Returns true when the line is up; false when the geometry is
 * missing or the verification gate refuses it (the caller's fallback is the
 * Log page's own follow sheet — never force an unverified line).
 */
const normaliseRouteName = (value: string): string =>
    value.toLowerCase().replace(/[→⇄]/g, '-').replace(/\s+/g, ' ').trim();

/** null = the line is up; a string names why it is not. */
export async function followCastOffRoute(
    voyageId: string,
    savedRouteId?: string | null,
    publishPublic: boolean = true,
    voyageName?: string | null,
): Promise<string | null> {
    try {
        const logRoute = await fetchVoyageAsTrack(voyageId);
        let steerRoute: Pick<RouteOrTrack, 'savedRouteId' | 'points'>;
        let exactPlan: ReturnType<typeof buildFollowRoutePlanFromRoute>;
        if (logRoute) {
            steerRoute = tracedRouteFollowGeometry(logRoute);
        } else {
            // A JUST-cast-off passage has no ship-log entries yet — GPS is
            // still warming up — so there is no log line to assemble. The
            // passage's route is the saved trace itself, which is local and
            // already checked. This was the silent bail that made the Log
            // page re-ask "which passage?" seconds after casting off from
            // the passage that IS the answer (Shane 2026-08-26).
            const routeId = savedRouteId?.trim();
            const traces = loadSavedTraces();
            let saved = traces.find((trace) => (routeId && trace.id === routeId) || trace.passageVoyageId === voyageId);
            if (!saved && voyageName?.trim()) {
                // Last resort for a voyage row that predates every link
                // column: a UNIQUE name match against the canonical traces.
                // Safe because the direct-use gate below still verifies the
                // matched trace's own checked geometry before anything is
                // followed or published — a wrong-name match cannot draw an
                // unverified line.
                const wanted = normaliseRouteName(voyageName);
                const byName = traces.filter(
                    (trace) =>
                        normaliseRouteName(trace.name) === wanted ||
                        normaliseRouteName(displayRouteLabel(trace)) === wanted,
                );
                if (byName.length === 1) saved = byName[0];
            }
            if (!saved) {
                return routeId
                    ? 'The saved route for this passage is not on this device. Open it in Route Tracer and save it again.'
                    : 'This passage has no linked saved route. Pick it again in Passage Planning, or re-save the route.';
            }
            if (saved.points.length < 2) return 'The saved route has no usable waypoints.';
            steerRoute = { savedRouteId: saved.id, points: saved.points };
        }
        const blockReason = tracedRouteDirectUseBlockReason(steerRoute);
        if (blockReason) {
            log.info(`cast-off route not auto-followed: ${blockReason}`);
            return blockReason;
        }
        if (logRoute) {
            exactPlan = buildFollowRoutePlanFromRoute({ ...logRoute, points: steerRoute.points });
        } else {
            const saved = loadSavedTraces().find((trace) => trace.id === steerRoute.savedRouteId);
            exactPlan = saved
                ? buildFollowRoutePlan({
                      label: displayRouteLabel(saved),
                      points: steerRoute.points,
                      timestamp: Date.parse(saved.createdAt) || undefined,
                  })
                : null;
        }
        if (!exactPlan) return 'Could not build a follow plan from the saved route.';
        // This passage was born in Passage Planning — the kit is answered by
        // construction. Mark BEFORE following so the nudge's route-committed
        // trigger cannot fire first.
        markRouteKitAnswered(steerRoute.points);
        useFollowRouteStore.getState().startFollowing(exactPlan, voyageId, steerRoute.points);
        // Public page (fire-and-forget like the Log page's pick). Usually a
        // no-op 'not-tracking' at this point — GPS is still starting — so
        // the authoritative publish happens in castOffHandoff the moment
        // tracking confirms. This early attempt stays for the resume case
        // where tracking is already live. Opt-out keeps the line private.
        if (publishPublic) {
            // Publish the PLANNED-ROUTE MIRROR id — the voyage whose
            // ship_logs rows are source='planned_route'. The public page
            // draws the plan from those rows; the cast-off voyage's own
            // entries are live fixes and resolve to nothing.
            const mirrorId = loadSavedTraces()
                .find((trace) => trace.id === steerRoute.savedRouteId)
                ?.plannedRouteId?.trim();
            if (mirrorId) {
                void Promise.resolve(publishFollowedRoute(mirrorId)).catch((error) => {
                    log.warn('publish cast-off followed route failed:', error);
                });
            }
        }
        return null;
    } catch (error) {
        log.warn('cast-off route follow failed:', error);
        return error instanceof Error && error.message.trim() ? error.message.trim() : 'Route follow failed.';
    }
}
