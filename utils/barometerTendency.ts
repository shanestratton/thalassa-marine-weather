/**
 * barometerTendency — the three-hourly pressure tendency, from OBSERVED
 * samples.
 *
 * A single barometer forecasts weather through one number: how much the
 * pressure has changed in the last three hours. That window is the marine
 * convention (it is what a synoptic report's `ppp`/`a` group carries, and
 * what every "1–2 hPa in 3 h is a change, 3+ is a blow" rule of thumb is
 * stated against), and it is long enough to see past the semidiurnal
 * atmospheric tide but short enough to catch a front.
 *
 * This module is deliberately separate from `pressureTendency` in
 * MetricDeepDiveModal, which reads the FORECAST curve forward twelve hours.
 * That one answers "what does the model think is coming"; this one answers
 * "what has the air actually done around this boat". They disagree
 * sometimes, and that disagreement is information — do not merge them.
 *
 * Everything here is pure and unit-tested (tests/barometerTendency.test.ts).
 */

export interface PressureSample {
    /** Epoch milliseconds. */
    t: number;
    /** Pressure in hPa (= mb). Station or sea-level — the maths only sees deltas. */
    hpa: number;
}

/** WMO-style rate bands, named the way a forecast reads them aloud. */
export type TendencyRate = 'steady' | 'slowly' | 'moderate' | 'quickly' | 'very-rapidly';
export type TendencyDirection = 'rising' | 'falling' | 'steady';
/** How much attention the change deserves. Drives colour, nothing else. */
export type TendencySeverity = 'calm' | 'watch' | 'warn';

export interface TendencyReading {
    /** p(now) − p(now − window). Negative = falling. */
    deltaHpa: number;
    /** The delta normalised to exactly 3 h, for banding a short/long span. */
    delta3h: number;
    /** hPa per hour, signed. */
    perHour: number;
    /** Actual span between the two endpoints, milliseconds. */
    spanMs: number;
    direction: TendencyDirection;
    rate: TendencyRate;
    severity: TendencySeverity;
    /** "Falling quickly" — the pill label. */
    label: string;
    /** One plain sentence a skipper can act on. */
    read: string;
    /** Samples that went into the two endpoint medians. */
    samplesUsed: number;
}

/** The canonical window. */
export const TENDENCY_WINDOW_MS = 3 * 3_600_000;
/**
 * How far from an endpoint a sample may sit and still count. Half an hour
 * either side of the 3 h mark is ±17% of the window — enough to survive a
 * backgrounded app or a gap in sampling, tight enough that the delta is
 * still recognisably a three-hour one (and `delta3h` rescales what is left).
 */
export const TENDENCY_ENDPOINT_TOLERANCE_MS = 30 * 60_000;
/** Samples within this of an endpoint are pooled into its median. */
const ENDPOINT_POOL_MS = 10 * 60_000;
/** Below this span the delta is noise amplified by rescaling — refuse it. */
const MIN_USABLE_SPAN_MS = 90 * 60_000;

const median = (xs: number[]): number => {
    const s = [...xs].sort((a, b) => a - b);
    const mid = s.length >> 1;
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
};

/**
 * Robust value at an instant: the median of every sample within
 * ±ENDPOINT_POOL_MS of it. A single reading is a spike waiting to happen —
 * a door slam, a lift, a hatch — and one bad endpoint moves the whole
 * tendency.
 */
function endpointValue(samples: PressureSample[], at: number): { v: number; used: number; t: number } | null {
    const pool = samples.filter((s) => Math.abs(s.t - at) <= ENDPOINT_POOL_MS);
    if (pool.length) {
        return { v: median(pool.map((s) => s.hpa)), used: pool.length, t: median(pool.map((s) => s.t)) };
    }
    // Nothing in the pool: fall back to the single nearest sample, but only
    // if it is inside the tolerance. Caller decides what that span is worth.
    let best: PressureSample | null = null;
    for (const s of samples) {
        if (!best || Math.abs(s.t - at) < Math.abs(best.t - at)) best = s;
    }
    if (!best || Math.abs(best.t - at) > TENDENCY_ENDPOINT_TOLERANCE_MS) return null;
    return { v: best.hpa, used: 1, t: best.t };
}

/**
 * Band a 3-hour delta. Thresholds follow the WMO characteristic-of-tendency
 * wording used in marine bulletins:
 *
 *   < 0.1   steady
 *   0.1–1.5 slowly
 *   1.6–3.5 (rising/falling)
 *   3.6–6.0 quickly
 *   > 6.0   very rapidly
 *
 * The 3 hPa/3 h line is the one that matters at sea: sustained falls at or
 * past it are the classic gale signature.
 */
export function bandTendency(delta3h: number): { direction: TendencyDirection; rate: TendencyRate } {
    // Round before comparing. A delta of exactly 6.0 hPa arrives from the
    // rescaling step as 6.000000000000001 often enough to matter, and that
    // lands a "quickly" in the "very rapidly" band — a visible severity jump
    // from float noise. Nothing below 0.001 hPa is meaningful anyway.
    const mag = Math.round(Math.abs(delta3h) * 1000) / 1000;
    if (mag < 0.1) return { direction: 'steady', rate: 'steady' };
    const direction: TendencyDirection = delta3h > 0 ? 'rising' : 'falling';
    if (mag <= 1.5) return { direction, rate: 'slowly' };
    if (mag <= 3.5) return { direction, rate: 'moderate' };
    if (mag <= 6.0) return { direction, rate: 'quickly' };
    return { direction, rate: 'very-rapidly' };
}

const RATE_WORD: Record<TendencyRate, string> = {
    steady: '',
    slowly: 'slowly',
    moderate: '',
    quickly: 'quickly',
    'very-rapidly': 'very rapidly',
};

function labelFor(direction: TendencyDirection, rate: TendencyRate): string {
    if (direction === 'steady') return 'Steady';
    const head = direction === 'rising' ? 'Rising' : 'Falling';
    const tail = RATE_WORD[rate];
    return tail ? `${head} ${tail}` : head;
}

/**
 * Severity is asymmetric on purpose. A fast FALL is the dangerous one — it
 * is a deepening low or an approaching front, and the wind arrives with it.
 * A fast RISE usually means a cold front has gone through: brisk, squally,
 * clearing, worth noticing but not the same animal.
 */
function severityFor(direction: TendencyDirection, delta3h: number): TendencySeverity {
    const mag = Math.abs(delta3h);
    if (direction === 'falling') {
        if (mag > 3.5) return 'warn';
        if (mag > 1.5) return 'watch';
        return 'calm';
    }
    if (direction === 'rising') {
        if (mag > 6.0) return 'warn';
        if (mag > 3.5) return 'watch';
        return 'calm';
    }
    return 'calm';
}

function readFor(direction: TendencyDirection, rate: TendencyRate, delta3h: number): string {
    const n = Math.abs(delta3h).toFixed(1);
    if (direction === 'steady') return 'Pressure is holding — no change signalled in the next few hours.';
    if (direction === 'falling') {
        if (rate === 'very-rapidly')
            return `Down ${n} hPa in 3 h. A deep low or a front is on top of you — expect a serious blow.`;
        if (rate === 'quickly') return `Down ${n} hPa in 3 h. Gale signature: wind builds as the low closes in.`;
        if (rate === 'moderate') return `Down ${n} hPa in 3 h. A front is on its way — more wind within the day.`;
        return `Down ${n} hPa in 3 h. Easing gently; a change is possible but not imminent.`;
    }
    if (rate === 'very-rapidly') return `Up ${n} hPa in 3 h. A front has cleared through — squally behind it.`;
    if (rate === 'quickly') return `Up ${n} hPa in 3 h. Clearing fast, often brisk cold wind with it.`;
    if (rate === 'moderate') return `Up ${n} hPa in 3 h. Building high — settling down over the next day.`;
    return `Up ${n} hPa in 3 h. Slowly settling.`;
}

/**
 * Compute the observed tendency, or null if the record cannot support one.
 *
 * Returning null is the point. A barometer with forty minutes of history
 * has nothing to say about the next twelve hours, and inventing a number
 * from a short span — then rescaling it to three hours — turns sensor noise
 * into a gale warning. The UI shows "collecting" instead.
 */
export function observedTendency(
    samples: PressureSample[],
    nowMs: number,
    windowMs: number = TENDENCY_WINDOW_MS,
): TendencyReading | null {
    if (!samples || samples.length < 2) return null;
    const sorted = [...samples].filter((s) => Number.isFinite(s.hpa) && Number.isFinite(s.t)).sort((a, b) => a.t - b.t);
    if (sorted.length < 2) return null;

    const late = endpointValue(sorted, nowMs);
    if (!late) return null;

    // Prefer the requested window; if the record is shorter but still long
    // enough to mean something, use the oldest sample instead and rescale.
    let early = endpointValue(sorted, nowMs - windowMs);
    if (!early) {
        const oldest = sorted[0];
        if (late.t - oldest.t < MIN_USABLE_SPAN_MS) return null;
        early = endpointValue(sorted, oldest.t);
        if (!early) return null;
    }

    const spanMs = late.t - early.t;
    if (spanMs < MIN_USABLE_SPAN_MS) return null;

    const deltaHpa = late.v - early.v;
    const delta3h = (deltaHpa / spanMs) * TENDENCY_WINDOW_MS;
    const perHour = (deltaHpa / spanMs) * 3_600_000;
    const { direction, rate } = bandTendency(delta3h);

    return {
        deltaHpa,
        delta3h,
        perHour,
        spanMs,
        direction,
        rate,
        severity: severityFor(direction, delta3h),
        label: labelFor(direction, rate),
        read: readFor(direction, rate, delta3h),
        samplesUsed: early.used + late.used,
    };
}

/**
 * How much longer until a real tendency can be computed, in milliseconds.
 * Null once there is enough record. Feeds the "collecting" countdown so the
 * panel says something honest rather than sitting blank.
 */
export function timeUntilTendency(samples: PressureSample[], nowMs: number): number | null {
    if (!samples || !samples.length) return MIN_USABLE_SPAN_MS;
    const oldest = samples.reduce((a, b) => (b.t < a.t ? b : a));
    const have = nowMs - oldest.t;
    if (have >= MIN_USABLE_SPAN_MS) return null;
    return MIN_USABLE_SPAN_MS - have;
}

/** Standard atmosphere at mean sea level. The barometer's zero reference. */
export const STANDARD_MSLP_HPA = 1013.25;

/**
 * Barometric reduction to mean sea level, for a phone that is not at sea
 * level. Uses the hypsometric form with a fixed 6.5 K/km lapse rate — the
 * same approximation every consumer weather station uses.
 *
 * On a boat this is a no-op (altitude 0) and that is the common case, which
 * is exactly why it must not be *required* to make the panel work. It is
 * here for the phone that is up a hill when the skipper checks the forecast.
 */
export function reduceToSeaLevel(stationHpa: number, altitudeM: number, airTempC = 15): number {
    if (!Number.isFinite(altitudeM) || Math.abs(altitudeM) < 1) return stationHpa;
    const tempK = airTempC + 273.15;
    return stationHpa * Math.pow(1 - (0.0065 * altitudeM) / (tempK + 0.0065 * altitudeM), -5.257);
}

/** hPa → inches of mercury, for the crews who read it that way. */
export const hpaToInHg = (hpa: number): number => hpa * 0.02952998751;
