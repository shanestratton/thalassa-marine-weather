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
import { fetchVoyageAsTrack } from './RoutesAndTracks';
import { buildFollowRoutePlanFromRoute } from './followRoutePlan';
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
export async function followCastOffRoute(voyageId: string): Promise<boolean> {
    try {
        const logRoute = await fetchVoyageAsTrack(voyageId);
        if (!logRoute) return false;
        const steerRoute = tracedRouteFollowGeometry(logRoute);
        const blockReason = tracedRouteDirectUseBlockReason(steerRoute);
        if (blockReason) {
            log.info(`cast-off route not auto-followed: ${blockReason}`);
            return false;
        }
        const exactPlan = buildFollowRoutePlanFromRoute(steerRoute);
        if (!exactPlan) return false;
        useFollowRouteStore.getState().startFollowing(exactPlan, voyageId, steerRoute.points);
        // Public page (fire-and-forget like the Log page's pick): tracking is
        // already live, so this resolves 'linked' — or queues offline.
        void Promise.resolve(publishFollowedRoute(voyageId)).catch((error) => {
            log.warn('publish cast-off followed route failed:', error);
        });
        return true;
    } catch (error) {
        log.warn('cast-off route follow failed:', error);
        return false;
    }
}
