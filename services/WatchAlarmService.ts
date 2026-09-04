/**
 * WatchAlarmService — Local pre-watch alarm scheduler.
 *
 * Schedules iOS local notifications N minutes before each watch the
 * current user is assigned to. Each crew member's device runs this
 * service independently — when they open the app while their voyage
 * is active, the service reads their assignments and schedules the
 * upcoming alarms.
 *
 * Flow:
 *   1. Skipper assigns watches via WatchAssignSheet → upserts into
 *      watch_assignments table.
 *   2. Each crew member's device queries assignments where
 *      assigned_crew_email == their email.
 *   3. WatchAlarmService.scheduleForVoyage(voyageId) computes the
 *      concrete UTC start time for each of THEIR watches (from the
 *      voyage's departure_time + the watch slot's time-of-day) and
 *      calls LocalNotifications.schedule.
 *   4. iOS fires the alarm at watchStart - alarmMinutesBefore with
 *      sound + haptic + banner.
 *
 * Usage:
 *   await WatchAlarmService.scheduleForVoyage(voyage.id, 15);
 *   await WatchAlarmService.cancelForVoyage(voyage.id);
 *
 * Permissions: requestPermissions() must be called before scheduling.
 * iOS shows the standard "Allow Notifications" prompt the first time.
 */

import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { supabase } from './supabase';
import { WatchAssignmentService } from './WatchAssignmentService';
import { createLogger } from '../utils/createLogger';
// Shared with the crew's own watch page — see utils/watchTimes.
import { watchStartAfter } from '../utils/watchTimes';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from './authIdentityScope';

const log = createLogger('WatchAlarm');
const WATCH_ALARM_MARKER = 'thalassa-watch-alarm';
let identityCleanupEpoch = 0;

/**
 * Notification ID encoding: voyage hash × 1000 + watch_index.
 * Mapping watchIndex into a stable 32-bit integer the LocalNotifications
 * plugin accepts. Using a simple hash of the voyageId prevents collisions
 * across voyages — the plugin requires globally-unique notification IDs.
 */
/**
 * A watch repeats every 24 hours, so an id needs three parts, not two.
 *
 * The old scheme packed (voyage, watchIndex) only — one id per watch for the
 * whole passage — which is why a multi-day voyage could only ever have its
 * FIRST night scheduled. Same 32-bit budget, re-divided: 22 bits of voyage
 * hash, 6 bits of watch index (64 watches is far past any real watch bill) and
 * 4 bits of occurrence (16 days ahead, well past the notification budget).
 *
 * Safe to change: cancellation matches on `extra.voyageId`, never on the id.
 */
function notificationIdFor(voyageId: string, watchIndex: number, occurrence: number): number {
    let hash = 0;
    for (let i = 0; i < voyageId.length; i++) {
        hash = ((hash << 5) - hash + voyageId.charCodeAt(i)) | 0;
    }
    return (Math.abs(hash) & 0x3fffff) * 1024 + (watchIndex & 0x3f) * 16 + (occurrence & 0xf);
}

/** Days of watches to schedule ahead. */
const ROLLING_DAYS = 7;
/**
 * iOS holds 64 pending local notifications per app, and this service is not
 * the only scheduler (the ship's bell clock and the anchor watch also queue).
 * Take a third and no more.
 */
const MAX_WATCH_NOTIFICATIONS = 21;
const DAY_MS = 24 * 60 * 60 * 1000;

function belongsToScope(notification: { extra?: unknown; title?: string }, scope: AuthIdentityScope): boolean {
    const extra = notification.extra as
        | {
              watchAlarmService?: string;
              ownerScopeKey?: string;
          }
        | undefined;
    return extra?.watchAlarmService === WATCH_ALARM_MARKER && extra.ownerScopeKey === scope.key;
}

function isLegacyWatchAlarm(notification: { extra?: unknown; title?: string }): boolean {
    const extra = notification.extra as
        | {
              voyageId?: unknown;
              watchIndex?: unknown;
              ownerScopeKey?: unknown;
          }
        | undefined;
    return (
        !extra?.ownerScopeKey &&
        typeof extra?.voyageId === 'string' &&
        typeof extra?.watchIndex === 'number' &&
        notification.title?.includes('Watch starts') === true
    );
}

async function cancelForScope(voyageId: string, scope: AuthIdentityScope): Promise<void> {
    if (!Capacitor.isNativePlatform() || !voyageId || !isAuthIdentityScopeCurrent(scope)) return;
    try {
        const pending = await LocalNotifications.getPending();
        if (!isAuthIdentityScopeCurrent(scope)) return;
        const ours = pending.notifications.filter((notification) => {
            const extra = notification.extra as { voyageId?: string } | undefined;
            return extra?.voyageId === voyageId && belongsToScope(notification, scope);
        });
        if (ours.length === 0) return;
        await LocalNotifications.cancel({ notifications: ours.map((notification) => ({ id: notification.id })) });
        if (isAuthIdentityScopeCurrent(scope)) {
            log.info(`cancelled ${ours.length} pre-watch alarm(s) for voyage ${voyageId}`);
        }
    } catch (error) {
        if (isAuthIdentityScopeCurrent(scope)) log.warn('cancelForVoyage failed:', error);
    }
}

subscribeAuthIdentityScope((nextScope) => {
    const cleanupEpoch = ++identityCleanupEpoch;
    if (!Capacitor.isNativePlatform()) return;
    void LocalNotifications.getPending()
        .then(async ({ notifications }) => {
            if (cleanupEpoch !== identityCleanupEpoch || !isAuthIdentityScopeCurrent(nextScope)) return;
            const stale = notifications.filter(
                (notification) =>
                    isLegacyWatchAlarm(notification) ||
                    ((notification.extra as { watchAlarmService?: string; ownerScopeKey?: string } | undefined)
                        ?.watchAlarmService === WATCH_ALARM_MARKER &&
                        !belongsToScope(notification, nextScope)),
            );
            if (stale.length > 0) {
                await LocalNotifications.cancel({
                    notifications: stale.map((notification) => ({ id: notification.id })),
                });
            }
        })
        .catch(() => {
            /* best-effort identity cleanup */
        });
});

export const WatchAlarmService = {
    /**
     * Request iOS notification permissions. Idempotent — iOS only
     * shows the prompt the first time.
     *
     * Returns true when permission is granted.
     */
    async requestPermissions(): Promise<boolean> {
        if (!Capacitor.isNativePlatform()) return false;
        const scope = getAuthIdentityScope();
        try {
            const result = await LocalNotifications.requestPermissions();
            return isAuthIdentityScopeCurrent(scope) && result.display === 'granted';
        } catch (e) {
            if (isAuthIdentityScopeCurrent(scope)) log.warn('requestPermissions failed:', e);
            return false;
        }
    },

    /**
     * Schedule pre-watch alarms for the current user's assigned
     * watches in this voyage. Each alarm fires `minutesBefore`
     * minutes before the watch start time.
     *
     * Cancels any previously-scheduled alarms for this voyage first
     * so re-running this function (after a schedule edit) doesn't
     * leave stale notifications.
     */
    async scheduleForVoyage(voyageId: string, departureIso: string, minutesBefore: number = 15): Promise<number> {
        if (!Capacitor.isNativePlatform()) return 0;
        const scope = getAuthIdentityScope();
        const voyageIdSnapshot = voyageId.trim();
        const departureSnapshot = departureIso.trim();
        const leadMinutes = Number.isFinite(minutesBefore)
            ? Math.min(24 * 60, Math.max(0, Math.round(minutesBefore)))
            : 15;
        if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return 0;
        if (!voyageIdSnapshot || !departureSnapshot) return 0;

        // Identify the current user
        let userEmail: string | undefined;
        if (supabase) {
            try {
                const {
                    data: { user },
                } = await supabase.auth.getUser();
                if (!isAuthIdentityScopeCurrent(scope) || user?.id !== scope.userId) return 0;
                userEmail = user?.email;
            } catch {
                /* unauthenticated */
            }
        }
        if (!userEmail) {
            log.info('no authenticated user — skipping alarm scheduling');
            return 0;
        }

        // Cancel previously-scheduled alarms for THIS voyage so we
        // don't double-fire after an edit
        await cancelForScope(voyageIdSnapshot, scope);
        if (!isAuthIdentityScopeCurrent(scope)) return 0;

        // Load all assignments for the voyage and filter to current user
        const all = await WatchAssignmentService.list(voyageIdSnapshot);
        if (!isAuthIdentityScopeCurrent(scope)) return 0;
        const normalizedEmail = userEmail.trim().toLowerCase();
        const mine = all.filter(
            (assignment) =>
                typeof assignment.assigned_crew_email === 'string' &&
                assignment.assigned_crew_email.trim().toLowerCase() === normalizedEmail,
        );
        if (mine.length === 0) return 0;

        // Build LocalNotifications payload
        const now = Date.now();
        // ROLLING, not one-shot. This used to schedule each watch's FIRST
        // occurrence after departure and nothing else — so on a multi-day
        // passage the crew were woken for night one and never again, and
        // reopening the screen simply filtered those first watches out as
        // past. A watch bill repeats every 24 hours; the alarms must too.
        const occurrences: Array<{ a: (typeof mine)[number]; at: Date; day: number }> = [];
        for (const a of mine) {
            // From NOW, not from departure — mid-passage the next occurrence
            // is what matters, and watchStartAfter never returns one before
            // the voyage began.
            const first = watchStartAfter(a.watch_time_label, departureSnapshot, new Date(now));
            if (!first) continue;
            for (let day = 0; day < ROLLING_DAYS; day++) {
                occurrences.push({ a, at: new Date(first.getTime() + day * DAY_MS), day });
            }
        }
        occurrences.sort((x, y) => x.at.getTime() - y.at.getTime());

        const notifications = occurrences
            .slice(0, MAX_WATCH_NOTIFICATIONS)
            .map(({ a, at: start, day }) => {
                const fireAt = new Date(start.getTime() - leadMinutes * 60_000);
                // Don't schedule alarms in the past
                if (fireAt.getTime() <= now) return null;
                return {
                    id: notificationIdFor(voyageIdSnapshot, a.watch_index, day),
                    title: `⏰ Watch starts in ${leadMinutes} min`,
                    body: `${a.watch_label} — bridge in ${leadMinutes} min (${a.watch_time_label} UTC)`,
                    schedule: { at: fireAt },
                    sound: 'beep.aiff',
                    extra: {
                        watchAlarmService: WATCH_ALARM_MARKER,
                        ownerScopeKey: scope.key,
                        ownerUserId: scope.userId,
                        voyageId: voyageIdSnapshot,
                        watchIndex: a.watch_index,
                        watchLabel: a.watch_label,
                        watchStart: start.toISOString(),
                    },
                };
            })
            .filter((n): n is NonNullable<typeof n> => n !== null);

        if (notifications.length === 0) {
            log.info('no future watches to alarm for');
            return 0;
        }

        try {
            if (!isAuthIdentityScopeCurrent(scope)) return 0;
            await LocalNotifications.schedule({ notifications });
            if (!isAuthIdentityScopeCurrent(scope)) {
                await LocalNotifications.cancel({
                    notifications: notifications.map((notification) => ({ id: notification.id })),
                }).catch(() => undefined);
                return 0;
            }
            log.info(`scheduled ${notifications.length} pre-watch alarm(s) (${leadMinutes} min before)`);
            return notifications.length;
        } catch (e) {
            if (isAuthIdentityScopeCurrent(scope)) log.warn('schedule failed:', e);
            return 0;
        }
    },

    /**
     * Cancel all pre-watch alarms for this voyage. Used:
     *   - Before re-scheduling (so a schedule edit doesn't leave
     *     orphan alarms from previous slots)
     *   - When the voyage ends / is deleted
     */
    async cancelForVoyage(voyageId: string): Promise<void> {
        const scope = getAuthIdentityScope();
        await cancelForScope(voyageId.trim(), scope);
    },
};
