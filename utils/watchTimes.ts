/**
 * When a watch actually falls.
 *
 * A watch schedule is a set of time-of-day slots ("2000–0000") that repeat
 * every 24 hours from the voyage's departure. Turning a slot into a real
 * instant is the only fiddly part, and it was buried privately inside
 * WatchAlarmService — so anything else that wanted to know "when is my next
 * watch" had to reimplement it. Extracted rather than copied: two versions of
 * this drifting apart would mean an alarm and a countdown disagreeing about
 * when a crew member is due on deck.
 *
 * All UTC. The slot labels are UTC by convention throughout the passage
 * planner, and a watch bill that shifts with the phone's timezone as a boat
 * crosses one would be worse than useless.
 */

export interface WatchSlot {
    hour: number;
    minute: number;
}

/** "2000–0000" → 20:00. The dash may be -, – or —. */
export function parseWatchSlot(timeRange: string): WatchSlot | null {
    const match = timeRange.match(/(\d{4})\s*[-–—]\s*(\d{4})/);
    if (!match) return null;
    const hour = parseInt(match[1].slice(0, 2), 10);
    const minute = parseInt(match[1].slice(2, 4), 10);
    if (!Number.isFinite(hour) || !Number.isFinite(minute)) return null;
    if (hour > 23 || minute > 59) return null;
    return { hour, minute };
}

/**
 * The first occurrence of this slot at or after `from`, never before departure.
 *
 * The schedule starts at the voyage's departure and repeats daily, so the
 * answer is "step the slot forward a day at a time until it is not in the
 * past". `from` is what makes this reusable: pass the departure to get the
 * FIRST instance (what the alarm scheduler wants), or pass now to get the NEXT
 * one (what a crew member looking at their phone mid-passage wants).
 */
export function watchStartAfter(timeRange: string, departureIso: string, from: Date = new Date()): Date | null {
    const slot = parseWatchSlot(timeRange);
    if (!slot) return null;
    const departure = new Date(departureIso);
    if (Number.isNaN(departure.getTime())) return null;

    const cursor = new Date(departure);
    cursor.setUTCHours(slot.hour, slot.minute, 0, 0);
    const floor = Math.max(departure.getTime(), from.getTime());
    // At most a day per step, and the loop is bounded by the gap between the
    // departure and `from` — a long-past voyage costs iterations, not forever.
    let guard = 0;
    while (cursor.getTime() < floor && guard < 4000) {
        cursor.setUTCDate(cursor.getUTCDate() + 1);
        guard++;
    }
    return cursor.getTime() < floor ? null : cursor;
}

/**
 * The FIRST instance of a slot on a voyage — the one the alarm scheduler
 * schedules from. Exactly the behaviour WatchAlarmService had inline.
 */
export function firstWatchStart(timeRange: string, departureIso: string): Date | null {
    const departure = new Date(departureIso);
    if (Number.isNaN(departure.getTime())) return null;
    return watchStartAfter(timeRange, departureIso, departure);
}
