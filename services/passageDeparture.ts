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
