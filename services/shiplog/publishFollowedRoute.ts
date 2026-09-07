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
 *
 * AUTHORSHIP (2026-09-08). Two devices on one account: before writing, this
 * device reads the row and, if ANOTHER device set a different route, answers
 * 'held-elsewhere' with that device's name instead of overwriting. The caller
 * shows a centred confirm naming it and, on yes, calls again with
 * `replace: true`. Offline and not the author, it queues the intent rather
 * than writing blind; the flush re-checks on reconnect. This device's own
 * links (the written-here ledger) are re-linked without a read, as before.
 */
import { ShipLogService } from '../ShipLogService';
import { VoyageLogService } from '../VoyageLogService';
import {
    clearPlanLinkIfWrittenHere,
    isForeignLink,
    queuePlanLinkIntent,
    setPlanLinkWithRetry,
    wroteLinkHere,
} from './planLinkIntent';
import { withDeadline } from '../../utils/deadline';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent } from '../authIdentityScope';

const READ_DEADLINE_MS = 10_000;

/** 'queued' = the write didn't land NOW but the intent is durably recorded and
 *  will retry on reconnect — callers should say "will keep trying", not treat
 *  it as loss. 'held-elsewhere' = another device's link stands on this voyage
 *  (see PublishFollowOutcome.hold for its name) and nothing was written.
 *  'error' remains for the cases where nothing was recorded. */
export type PublishFollowResult = 'linked' | 'queued' | 'not-tracking' | 'held-elsewhere' | 'error';

export interface PublishFollowHold {
    voyageId: string;
    /** The route the other device is publishing. */
    planVoyageId: string;
    /** That device, as it named itself ("iPhone/iPad · 3f2a"). */
    deviceName: string;
    /** Server-stamped ISO time of its write. */
    updatedAt: string | null;
}

export interface PublishFollowOptions {
    /** Overwrite a link another device set. Only after the skipper confirmed against its name. */
    replace?: boolean;
    /**
     * Link THIS voyage instead of the one this device is tracking — the
     * account's active voyage, recorded on another device. Lets a second
     * device change the published route without recording the passage itself.
     */
    forVoyageId?: string;
}

export interface PublishFollowOutcome {
    result: PublishFollowResult;
    /** Present only with result 'held-elsewhere'. */
    hold?: PublishFollowHold;
}

function announceLinkChanged(voyageId: string): void {
    // Announce the link so every other door on this question stays in step:
    // the Log page's follow sheet records the confirm and closes if it is
    // open on the same voyage (LogPage's link-changed listener).
    try {
        window.dispatchEvent(new CustomEvent('thalassa:voyage-plan-link-changed', { detail: { voyageId } }));
    } catch {
        /* non-DOM host — listeners simply miss one optimistic close */
    }
}

export async function publishFollowedRouteDetailed(
    planVoyageId: string,
    opts: PublishFollowOptions = {},
): Promise<PublishFollowOutcome> {
    const scope = getAuthIdentityScope();
    const immutablePlanVoyageId = planVoyageId.trim();
    if (!immutablePlanVoyageId || !isAuthIdentityScopeCurrent(scope)) return { result: 'error' };
    let voyageId = opts.forVoyageId?.trim() || '';
    if (!voyageId) {
        const status = ShipLogService.getTrackingStatus();
        const currentVoyageId = ShipLogService.getCurrentVoyageId();
        if (!status.isTracking || !currentVoyageId) return { result: 'not-tracking' };
        voyageId = currentVoyageId;
    }
    const immutableTrackingVoyageId = voyageId;

    if (!opts.replace && !wroteLinkHere(immutableTrackingVoyageId)) {
        let read: Awaited<ReturnType<typeof VoyageLogService.getPlanLink>>;
        try {
            read = await withDeadline(
                VoyageLogService.getPlanLink(immutableTrackingVoyageId),
                READ_DEADLINE_MS,
                'plan-link read',
            );
        } catch (err) {
            read = { ok: false, reason: err instanceof Error ? err.message : String(err) };
        }
        if (!isAuthIdentityScopeCurrent(scope)) return { result: 'error' };
        if (!read.ok) {
            // Cannot see who holds the row: never write blind. The flush
            // re-reads on reconnect and drops the intent if another device's
            // link stands.
            queuePlanLinkIntent(immutableTrackingVoyageId, immutablePlanVoyageId);
            return { result: 'queued' };
        }
        if (isForeignLink(read.row)) {
            if (read.row.planVoyageId === immutablePlanVoyageId) {
                // Same route, already published by the other device.
                announceLinkChanged(immutableTrackingVoyageId);
                return { result: 'linked' };
            }
            return {
                result: 'held-elsewhere',
                hold: {
                    voyageId: immutableTrackingVoyageId,
                    planVoyageId: read.row.planVoyageId,
                    deviceName: read.row.deviceName ?? 'another device',
                    updatedAt: read.row.updatedAt,
                },
            };
        }
    }

    // Durable-intent write: bounded attempt now, automatic retry on the
    // 'online' event / delayed timer if it fails (hardening 2026-08-01 —
    // this used to be a single unbounded call whose failure was forgotten).
    const ok = await setPlanLinkWithRetry(immutableTrackingVoyageId, immutablePlanVoyageId);
    if (!isAuthIdentityScopeCurrent(scope)) return { result: 'error' };
    if (!ok) return { result: 'queued' };
    announceLinkChanged(immutableTrackingVoyageId);
    return { result: 'linked' };
}

export async function publishFollowedRoute(
    planVoyageId: string,
    opts: PublishFollowOptions = {},
): Promise<PublishFollowResult> {
    return (await publishFollowedRouteDetailed(planVoyageId, opts)).result;
}

/** Clear the public followed-route link for the current voyage (stop showing
 *  any route). No-op when not tracking. Durable: a failed clear is queued and
 *  retried, so "Just recording" can't silently leave a declined route public.
 *  Leaves a link ANOTHER device set alone — declining to follow on this phone
 *  must not un-publish the route the other phone is following. */
export async function clearFollowedRoute(): Promise<boolean> {
    const scope = getAuthIdentityScope();
    if (!isAuthIdentityScopeCurrent(scope)) return false;
    const status = ShipLogService.getTrackingStatus();
    const currentVoyageId = ShipLogService.getCurrentVoyageId();
    if (!status.isTracking || !currentVoyageId) return false;
    const immutableTrackingVoyageId = currentVoyageId;
    const outcome = await clearPlanLinkIfWrittenHere(immutableTrackingVoyageId);
    return isAuthIdentityScopeCurrent(scope) && outcome === 'cleared';
}
