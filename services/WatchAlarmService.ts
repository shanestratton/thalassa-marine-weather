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

const log = createLogger('WatchAlarm');

/**
 * Notification ID encoding: voyage hash × 1000 + watch_index.
 * Mapping watchIndex into a stable 32-bit integer the LocalNotifications
 * plugin accepts. Using a simple hash of the voyageId prevents collisions
 * across voyages — the plugin requires globally-unique notification IDs.
 */
function notificationIdFor(voyageId: string, watchIndex: number): number {
    let hash = 0;
    for (let i = 0; i < voyageId.length; i++) {
        hash = ((hash << 5) - hash + voyageId.charCodeAt(i)) | 0;
    }
    // Truncate hash to 22 bits (~4M voyages), shift left, OR with watch_index
    // (up to 1023 watches). Result is a 32-bit positive int.
    return (Math.abs(hash) & 0x3fffff) * 1024 + (watchIndex & 0x3ff);
}

/**
 * Parse a watch's `time` string (e.g. "2000–0000", "1600–1800") and
 * the voyage departure_time into a concrete UTC start timestamp.
 *
 * The watch schedule cycles every 24 hours starting at the voyage's
 * departure date — so the first First Watch is on departure day at
 * 20:00 (or whatever the slot's start time is).
 *
 * Returns null if the time string can't be parsed.
 */
function computeWatchStartUtc(timeRange: string, departureIso: string): Date | null {
    // Match HHMM–HHMM format. The dash can be any of -, –, —.
    const match = timeRange.match(/(\d{4})\s*[-–—]\s*(\d{4})/);
    if (!match) return null;
    const startHHMM = match[1];
    const hour = parseInt(startHHMM.slice(0, 2), 10);
    const minute = parseInt(startHHMM.slice(2, 4), 10);
    if (isNaN(hour) || isNaN(minute)) return null;

    const dep = new Date(departureIso);
    if (isNaN(dep.getTime())) return null;

    // The watch's UTC time-of-day is hour:minute. Place it on the
    // departure date first, then advance by 24h until it's >= dep.
    const watchStart = new Date(dep);
    watchStart.setUTCHours(hour, minute, 0, 0);
    while (watchStart.getTime() < dep.getTime()) {
        watchStart.setUTCDate(watchStart.getUTCDate() + 1);
    }
    return watchStart;
}

export const WatchAlarmService = {
    /**
     * Request iOS notification permissions. Idempotent — iOS only
     * shows the prompt the first time.
     *
     * Returns true when permission is granted.
     */
    async requestPermissions(): Promise<boolean> {
        if (!Capacitor.isNativePlatform()) return false;
        try {
            const result = await LocalNotifications.requestPermissions();
            return result.display === 'granted';
        } catch (e) {
            log.warn('requestPermissions failed:', e);
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
        if (!voyageId || !departureIso) return 0;

        // Identify the current user
        let userEmail: string | undefined;
        if (supabase) {
            try {
                const {
                    data: { user },
                } = await supabase.auth.getUser();
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
        await this.cancelForVoyage(voyageId);

        // Load all assignments for the voyage and filter to current user
        const all = await WatchAssignmentService.list(voyageId);
        const mine = all.filter((a) => a.assigned_crew_email === userEmail);
        if (mine.length === 0) return 0;

        // Build LocalNotifications payload
        const now = Date.now();
        const notifications = mine
            .map((a) => {
                const start = computeWatchStartUtc(a.watch_time_label, departureIso);
                if (!start) return null;
                const fireAt = new Date(start.getTime() - minutesBefore * 60_000);
                // Don't schedule alarms in the past
                if (fireAt.getTime() <= now) return null;
                return {
                    id: notificationIdFor(voyageId, a.watch_index),
                    title: `⏰ Watch starts in ${minutesBefore} min`,
                    body: `${a.watch_label} — bridge in ${minutesBefore} min (${a.watch_time_label} UTC)`,
                    schedule: { at: fireAt },
                    sound: 'beep.aiff',
                    extra: {
                        voyageId,
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
            await LocalNotifications.schedule({ notifications });
            log.info(`scheduled ${notifications.length} pre-watch alarm(s) (${minutesBefore} min before)`);
            return notifications.length;
        } catch (e) {
            log.warn('schedule failed:', e);
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
        if (!Capacitor.isNativePlatform()) return;
        if (!voyageId) return;
        try {
            const pending = await LocalNotifications.getPending();
            // Cancel any pending notification whose extra.voyageId matches
            const ours = pending.notifications.filter((n) => {
                const extra = n.extra as { voyageId?: string } | undefined;
                return extra?.voyageId === voyageId;
            });
            if (ours.length === 0) return;
            await LocalNotifications.cancel({ notifications: ours.map((n) => ({ id: n.id })) });
            log.info(`cancelled ${ours.length} pre-watch alarm(s) for voyage ${voyageId}`);
        } catch (e) {
            log.warn('cancelForVoyage failed:', e);
        }
    },
};
