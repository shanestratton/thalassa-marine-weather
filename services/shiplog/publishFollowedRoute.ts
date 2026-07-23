/**
 * publishFollowedRoute — link the route the skipper chose to follow to the
 * CURRENTLY-TRACKED voyage, so it becomes the one route drawn on the public
 * page (Shane 2026-07-17: "the route we're following should show up on the
 * public page, not all our saved routes").
 *
 * Publishing is deliberately tied to an ACTIVE voyage (option A): the public
 * `passage.plan_line` resolves from voyage_plan_links(current voyage →
 * plan_voyage_id), so without a voyage there's nothing to link to. Following a
 * route while NOT tracking still works in-app (the chart line); it just doesn't
 * publish until you cast off.
 *
 * Standalone (not a VoyageLogService/ShipLogService method) so neither service
 * has to import the other — no circular dependency.
 */
import { ShipLogService } from '../ShipLogService';
import { VoyageLogService } from '../VoyageLogService';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';

export type PublishFollowResult = 'linked' | 'not-tracking' | 'error';

export async function publishFollowedRoute(planVoyageId: string): Promise<PublishFollowResult> {
    const scope = getAuthIdentityScope();
    const immutablePlanVoyageId = planVoyageId.trim();
    if (!immutablePlanVoyageId || !isAuthIdentityScopeCurrent(scope)) return 'error';
    const status = ShipLogService.getTrackingStatus();
    const currentVoyageId = ShipLogService.getCurrentVoyageId();
    if (!status.isTracking || !currentVoyageId) return 'not-tracking';
    const immutableTrackingVoyageId = currentVoyageId;
    const ok = await VoyageLogService.setVoyagePlanLink(immutableTrackingVoyageId, immutablePlanVoyageId);
    if (!isAuthIdentityScopeCurrent(scope)) return 'error';
    return ok ? 'linked' : 'error';
}

/** Clear the public followed-route link for the current voyage (stop showing
 *  any route). No-op when not tracking. */
export async function clearFollowedRoute(): Promise<boolean> {
    const scope = getAuthIdentityScope();
    if (!isAuthIdentityScopeCurrent(scope)) return false;
    const status = ShipLogService.getTrackingStatus();
    const currentVoyageId = ShipLogService.getCurrentVoyageId();
    if (!status.isTracking || !currentVoyageId) return false;
    const immutableTrackingVoyageId = currentVoyageId;
    const cleared = await VoyageLogService.setVoyagePlanLink(immutableTrackingVoyageId, null);
    return isAuthIdentityScopeCurrent(scope) && cleared;
}
