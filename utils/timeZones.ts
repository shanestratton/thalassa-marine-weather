/**
 * Time zones for the ship's bell clock.
 *
 * A boat crosses zones, and the clock on the bulkhead is whichever one the
 * skipper decided to keep — ship's time, the destination's time, or UTC for
 * the log. So the zone is a CHOICE, and the face says which one it is showing.
 *
 * Everything here goes through Intl rather than arithmetic on offsets: a
 * hand-rolled offset is right until the day daylight saving moves, and a clock
 * that is an hour out on one Sunday a year is worse than no clock.
 */

/** Zones a boat in this part of the world actually keeps, pinned to the top. */
const COMMON: string[] = [
    'UTC',
    'Australia/Brisbane',
    'Australia/Sydney',
    'Australia/Darwin',
    'Australia/Perth',
    'Pacific/Auckland',
    'Pacific/Noumea',
    'Pacific/Port_Moresby',
    'Pacific/Fiji',
    'Pacific/Tongatapu',
    'Asia/Singapore',
    'Asia/Tokyo',
    'Europe/London',
    'America/New_York',
    'America/Los_Angeles',
];

/**
 * Every zone the device knows, with the useful ones first.
 *
 * Intl.supportedValuesOf is not everywhere yet; the curated list alone is a
 * perfectly good clock, so its absence costs nothing.
 */
export function listTimeZones(): string[] {
    const device = deviceTimeZone();
    const head = [device, ...COMMON.filter((z) => z !== device)];
    let all: string[] = [];
    try {
        const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
        if (typeof supported === 'function') all = supported('timeZone');
    } catch {
        all = [];
    }
    const seen = new Set(head);
    return [...head, ...all.filter((z) => !seen.has(z))];
}

export function deviceTimeZone(): string {
    try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    } catch {
        return 'UTC';
    }
}

export interface ZoneClock {
    hour: number;
    minute: number;
    second: number;
    /** What the zone calls itself right now — AEST, AEDT, GMT+11. */
    label: string;
}

/**
 * The wall-clock reading in a zone: what the hands should show.
 *
 * Returns the DEVICE's own reading if the zone is not one Intl recognises,
 * because a clock that throws is worse than a clock that is honest about
 * showing local time.
 */
export function clockInZone(when: Date, timeZone: string): ZoneClock {
    try {
        const parts = new Intl.DateTimeFormat('en-GB', {
            timeZone,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false,
            timeZoneName: 'short',
        }).formatToParts(when);
        const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
        // 24:00 is midnight in en-GB's 2-digit hour; the hands want 0.
        const hour = Number(get('hour')) % 24;
        return {
            hour: Number.isFinite(hour) ? hour : when.getHours(),
            minute: Number(get('minute')) || 0,
            second: Number(get('second')) || 0,
            label: get('timeZoneName') || timeZone,
        };
    } catch {
        return {
            hour: when.getHours(),
            minute: when.getMinutes(),
            second: when.getSeconds(),
            label: deviceTimeZone(),
        };
    }
}

/** "Australia/Brisbane" → "Brisbane", for a dropdown that has to fit a phone. */
export function zoneDisplayName(timeZone: string): string {
    if (timeZone === 'UTC') return 'UTC';
    const tail = timeZone.split('/').slice(-1)[0] ?? timeZone;
    return tail.replace(/_/g, ' ');
}
