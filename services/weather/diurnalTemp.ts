/**
 * diurnalTemp — hourly air temperature from a daily max/min, Parton & Logan (1981).
 *
 * WHY THIS EXISTS
 *   Some models publish only 6-hourly (ECMWF AIFS among them). Interpolating
 *   those linearly systematically CLIPS the daily extremes: if the real peak
 *   falls at 14:30 and the steps are 12:00 and 18:00, a straight line between
 *   them never reaches it. You under-report the hot part of the day and
 *   over-report the cool part, and the error is largest exactly when someone
 *   cares.
 *
 *   The diurnal cycle is not linear. It is a sine while the sun is up and an
 *   exponential decay after it sets, and Parton & Logan is the standard
 *   formulation of that — forty years of use in agricultural crop models,
 *   reported absolute mean error ~1.2–2.6 °C.
 *
 * THE MODEL
 *   Daytime, m hours after sunrise, daylength Y:
 *       T = (Tmax − Tmin) · sin( π·m / (Y + 2a) ) + Tmin
 *
 *   Night, n hours after sunset, nightlength Z:
 *       T = Tmin' + (Tsunset − Tmin') · exp( −b·n / Z )
 *
 *   Every parameter is physical, which is the point — none is a fudge factor:
 *     a  lag between solar noon and peak temperature. The ground keeps warming
 *        after peak radiation, so the max arrives ~2 h late.
 *     b  overnight radiational-cooling decay rate.
 *     Tmin' is the NEXT morning's minimum where known, because the night is
 *        decaying toward tomorrow's low, not last night's.
 *
 * WHAT THIS IS NOT
 *   Not a forecast. It redistributes a model's own daily max/min across the
 *   hours more honestly than a straight line. If the model's max is wrong,
 *   this faithfully reproduces a wrong max at the right time of day.
 *
 *   It also assumes a clear-ish diurnal cycle. A day with a front through it,
 *   or a marine layer, will not follow a sine — the curve is a better default
 *   than linear, not a claim about any particular day.
 *
 * Reference: Parton, W.J. & Logan, J.A. (1981), "A model for diurnal variation
 * in soil and air temperature", Agricultural Meteorology 23, 205–216.
 */

import SunCalc from 'suncalc';

/** Default parameters for air temperature at screen height, from the paper. */
export const PARTON_LOGAN_DEFAULTS = {
    /** Hours by which peak temperature lags solar noon. */
    a: 1.86,
    /** Overnight exponential decay coefficient. */
    b: 2.2,
} as const;

export interface DiurnalInput {
    /** Daily maximum, °C. */
    tMax: number;
    /** Daily minimum, °C — the minimum at the START of this day, i.e. around sunrise. */
    tMin: number;
    /** Tomorrow's minimum, if known. The night decays toward this, not tMin. */
    tMinNext?: number;
    sunrise: Date;
    sunset: Date;
    /** Next day's sunrise. Needed to size the night; defaults to sunrise + 24 h. */
    sunriseNext?: Date;
    a?: number;
    b?: number;
}

const HOURS = (ms: number): number => ms / 3_600_000;

/**
 * Temperature at an instant. Pure — takes sun times rather than computing
 * them, so it is testable without a location or a clock.
 */
export function diurnalTemperature(at: Date, input: DiurnalInput): number {
    const { tMax, tMin, sunrise, sunset } = input;
    const a = input.a ?? PARTON_LOGAN_DEFAULTS.a;
    const b = input.b ?? PARTON_LOGAN_DEFAULTS.b;
    const tMinNext = input.tMinNext ?? tMin;
    const sunriseNext = input.sunriseNext ?? new Date(sunrise.getTime() + 86_400_000);

    const Y = HOURS(sunset.getTime() - sunrise.getTime()); // daylength
    const Z = HOURS(sunriseNext.getTime() - sunset.getTime()); // nightlength

    // Degenerate polar cases: no meaningful sunrise/sunset split, so there is
    // no diurnal shape to impose. Return the midpoint rather than dividing by
    // zero or emitting a confident nonsense curve.
    if (!(Y > 0) || !(Z > 0)) return (tMax + tMin) / 2;

    const m = HOURS(at.getTime() - sunrise.getTime());

    if (m >= 0 && m <= Y) {
        // Daytime sine. The (Y + 2a) denominator is what shifts the peak past
        // solar noon — with a = 0 the max would land exactly at midday, which
        // is not what happens.
        return (tMax - tMin) * Math.sin((Math.PI * m) / (Y + 2 * a)) + tMin;
    }

    // Night. Anchor on the temperature the daytime curve reaches at sunset so
    // the two halves join without a step.
    const tSunset = (tMax - tMin) * Math.sin((Math.PI * Y) / (Y + 2 * a)) + tMin;

    // Hours after sunset, wrapping a pre-sunrise time into the previous night.
    const n = m < 0 ? HOURS(at.getTime() - sunset.getTime()) + 24 : m - Y;

    return tMinNext + (tSunset - tMinNext) * Math.exp((-b * n) / Z);
}

/** Hourly series across a span. */
export function diurnalSeries(from: Date, hours: number, input: DiurnalInput): number[] {
    return Array.from({ length: hours }, (_, i) => diurnalTemperature(new Date(from.getTime() + i * 3_600_000), input));
}

/**
 * Convenience wrapper: sun times from a location, curve from a model's daily
 * max/min. This is the shape a caller actually has — a forecast gives daily
 * extremes, and the location is known.
 */
export function diurnalTemperatureAt(
    at: Date,
    lat: number,
    lon: number,
    daily: { tMax: number; tMin: number; tMinNext?: number },
    params?: { a?: number; b?: number },
): number {
    const times = SunCalc.getTimes(at, lat, lon);
    const next = SunCalc.getTimes(new Date(at.getTime() + 86_400_000), lat, lon);
    return diurnalTemperature(at, {
        ...daily,
        sunrise: times.sunrise,
        sunset: times.sunset,
        sunriseNext: next.sunrise,
        ...params,
    });
}

/**
 * When the peak actually lands. Useful for labelling a chart, and a cheap way
 * to sanity-check the curve: it should be roughly `a` hours after solar noon,
 * never at noon itself.
 */
export function timeOfMaximum(input: Pick<DiurnalInput, 'sunrise' | 'sunset' | 'a'>): Date {
    const a = input.a ?? PARTON_LOGAN_DEFAULTS.a;
    const Y = HOURS(input.sunset.getTime() - input.sunrise.getTime());
    // sin peaks where its argument is π/2, i.e. m = (Y + 2a)/2
    const m = (Y + 2 * a) / 2;
    return new Date(input.sunrise.getTime() + m * 3_600_000);
}
