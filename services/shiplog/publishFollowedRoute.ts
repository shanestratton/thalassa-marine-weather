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
import { setPlanLinkWithRetry } from './planLinkIntent';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';

/** 'queued' = the write didn't land NOW but the intent is durably recorded and
 *  will retry on reconnect — callers should say "will keep trying", not treat
 *  it as loss. 'error' remains for the cases where nothing was recorded. */
export type PublishFollowResult = 'linked' | 'queued' | 'not-tracking' | 'error';

export async function publishFollowedRoute(planVoyageId: string): Promise<PublishFollowResult> {
    const scope = getAuthIdentityScope();
    const immutablePlanVoyageId = planVoyageId.trim();
    if (!immutablePlanVoyageId || !isAuthIdentityScopeCurrent(scope)) return 'error';
    const status = ShipLogService.getTrackingStatus();
    const currentVoyageId = ShipLogService.getCurrentVoyageId();
    if (!status.isTracking || !currentVoyageId) return 'not-tracking';
    const immutableTrackingVoyageId = currentVoyageId;
    // Durable-intent write: bounded attempt now, automatic retry on the
    // 'online' event / delayed timer if it fails (hardening 2026-08-01 —
    // this used to be a single unbounded call whose failure was forgotten).
    const ok = await setPlanLinkWithRetry(immutableTrackingVoyageId, immutablePlanVoyageId);
    if (!isAuthIdentityScopeCurrent(scope)) return 'error';
    if (!ok) return 'queued';
    if (ok) {
        // Announce the link so every other door on this question stays in
        // step: the Log page's follow sheet records the confirm and closes if
        // it is open on the same voyage (LogPage's link-changed listener).
        try {
            window.dispatchEvent(
                new CustomEvent('thalassa:voyage-plan-link-changed', {
                    detail: { voyageId: immutableTrackingVoyageId },
                }),
            );
        } catch {
            /* non-DOM host — listeners simply miss one optimistic close */
        }
    }
    return 'linked';
}

/** Clear the public followed-route link for the current voyage (stop showing
 *  any route). No-op when not tracking. Durable: a failed clear is queued and
 *  retried, so "Just recording" can't silently leave a declined route public. */
export async function clearFollowedRoute(): Promise<boolean> {
    const scope = getAuthIdentityScope();
    if (!isAuthIdentityScopeCurrent(scope)) return false;
    const status = ShipLogService.getTrackingStatus();
    const currentVoyageId = ShipLogService.getCurrentVoyageId();
    if (!status.isTracking || !currentVoyageId) return false;
    const immutableTrackingVoyageId = currentVoyageId;
    const cleared = await setPlanLinkWithRetry(immutableTrackingVoyageId, null);
    return isAuthIdentityScopeCurrent(scope) && cleared;
}
