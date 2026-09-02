/**
 * ShipsBellAlarmService — the punter's own watch alarm, set from the clock.
 *
 * Shane 2026-09-03: "it can be attached to the phone alarm so the punter can
 * set his watch times on there."
 *
 * DELIBERATELY NOT WatchAlarmService. That one schedules the watches a SKIPPER
 * assigned to a crew, read from the voyage's watch_assignments table — it needs
 * a voyage, an account, and someone to have built a schedule. This is the other
 * thing entirely: one person, one boat, "wake me at four", no account required.
 * Folding them together would make the simple case depend on the complicated
 * one.
 *
 * Its notification ids live in a band of their own so cancelling these can
 * never reach into the crew watch alarms and silence a schedule someone is
 * relying on.
 */
import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';
import { createLogger } from '../utils/createLogger';

const log = createLogger('ShipsBellAlarm');

/**
 * A band no other scheduler in the app uses.
 *
 * WatchAlarmService encodes (voyage hash × 1024 + watch index) and stays below
 * 2^32; these sit far above anything it produces, so "cancel my clock alarms"
 * cannot cancel a crew's assigned watch.
 */
const ID_BASE = 910_000_000;
const MAX_ALARMS = 8;

export interface BellAlarm {
    id: number;
    /** Epoch ms it fires. */
    at: number;
    /** What the punter called it — "Watch change", "0400". */
    label: string;
}

function idFor(slot: number): number {
    return ID_BASE + (slot % MAX_ALARMS);
}

export const ShipsBellAlarmService = {
    /** iOS only shows its prompt once; safe to call before every schedule. */
    async requestPermission(): Promise<boolean> {
        if (!Capacitor.isNativePlatform()) return false;
        try {
            const result = await LocalNotifications.requestPermissions();
            return result.display === 'granted';
        } catch (e) {
            log.warn('permission request failed', e);
            return false;
        }
    },

    /**
     * Set an alarm for a moment.
     *
     * Refuses a time in the past rather than scheduling a notification that
     * will never fire — a silent no-op here reads to the punter as an alarm
     * that is set, which is the worst possible outcome for an alarm.
     */
    async schedule(at: Date, label: string): Promise<BellAlarm | null> {
        if (!Capacitor.isNativePlatform()) return null;
        const when = at.getTime();
        if (!Number.isFinite(when) || when <= Date.now()) {
            log.warn('refusing to schedule an alarm in the past');
            return null;
        }
        const granted = await this.requestPermission();
        if (!granted) return null;

        const existing = await this.list();
        const slot = existing.length % MAX_ALARMS;
        const id = idFor(slot);
        try {
            await LocalNotifications.schedule({
                notifications: [
                    {
                        id,
                        title: label,
                        body: 'Ship’s bell — your watch is up.',
                        schedule: { at, allowWhileIdle: true },
                        sound: undefined,
                        extra: { source: 'ships-bell-clock' },
                    },
                ],
            });
            return { id, at: when, label };
        } catch (e) {
            log.warn('schedule failed', e);
            return null;
        }
    },

    /** Only this service's own alarms, never the crew watch schedule's. */
    async list(): Promise<BellAlarm[]> {
        if (!Capacitor.isNativePlatform()) return [];
        try {
            const pending = await LocalNotifications.getPending();
            return pending.notifications
                .filter((n) => typeof n.id === 'number' && n.id >= ID_BASE && n.id < ID_BASE + MAX_ALARMS)
                .map((n) => ({
                    id: n.id,
                    at: n.schedule?.at ? new Date(n.schedule.at).getTime() : 0,
                    label: n.title ?? 'Watch alarm',
                }))
                .sort((a, b) => a.at - b.at);
        } catch {
            return [];
        }
    },

    async cancel(id: number): Promise<void> {
        if (!Capacitor.isNativePlatform()) return;
        if (id < ID_BASE || id >= ID_BASE + MAX_ALARMS) return; // not ours to cancel
        try {
            await LocalNotifications.cancel({ notifications: [{ id }] });
        } catch (e) {
            log.warn('cancel failed', e);
        }
    },
};
