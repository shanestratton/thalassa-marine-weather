import type { PassageLookAhead } from '../stores/passageHudStore';

/** Departure selection reaches five days beyond the time it is chosen. */
export const PASSAGE_DEPARTURE_MAX_MS = 5 * 24 * 3_600_000;

type PassageClock = Pick<PassageLookAhead, 'departureMs' | 'aheadMs'>;

/** A chosen departure stays fixed; an undated look follows the current time. */
export function passageDepartureTime(look: PassageClock, now: number): number {
    return look.departureMs ?? now;
}

/** Absolute forecast time at the scrubber's elapsed passage time. */
export function passageForecastTime(look: PassageClock, now: number): number {
    return passageDepartureTime(look, now) + look.aheadMs;
}

/** Offset from now for forecast layers whose axes are relative to the clock. */
export function passageForecastOffsetMs(look: PassageClock, now: number): number {
    return passageForecastTime(look, now) - now;
}

/** A preview's suggested departure is at least this far off, so it is still ahead when confirmed. */
const PREVIEW_DEPARTURE_LEAD_MS = 15 * 60_000;

/**
 * The departure a route PREVIEW offers first (build 124): the next whole hour
 * on the device clock, at least a quarter of an hour away. A route pulled up on
 * Obs is not one she is sailing, so "now, from its first point" is rarely the
 * question; the skipper can still choose Leave now. Local, not UTC: in a
 * half-hour zone a whole UTC hour reads 14:30.
 */
export function nextPreviewDeparture(now: number): number {
    const at = new Date(now + PREVIEW_DEPARTURE_LEAD_MS);
    if (at.getMinutes() === 0 && at.getSeconds() === 0 && at.getMilliseconds() === 0) return at.getTime();
    at.setMinutes(60, 0, 0);
    return at.getTime();
}
