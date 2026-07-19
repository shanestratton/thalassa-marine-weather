/**
 * windOverTideSeries — build a wind-vs-tide timeline from model series.
 *
 * Composes the pure judgement in `windOverTide.ts` with two hourly series:
 * sea-surface height (for tidal phase) and wind. It answers "when in the next
 * two days does wind oppose the stream hard enough to stack the sea up".
 *
 * WHERE THE TIDE COMES FROM
 *   `sea_level_height_msl` from the `meteofrance_currents` domain, served by
 *   the self-hosted Open-Meteo instance. Verified at Newport to produce a
 *   clean semi-diurnal curve — 1.40 m high, -0.34 m low, ~12.4 h period, with
 *   the diurnal inequality you would expect on this coast.
 *
 *   ⚠ It is an ~8 km global product and does NOT resolve Moreton Bay. Expect
 *   amplitude to be wrong and timing to be off by tens of minutes inside the
 *   bay. That is tolerable here because the warning turns on tidal PHASE
 *   (is the stream running, which way) rather than on absolute height, and
 *   phase is a large-scale signal. It would NOT be tolerable if we were
 *   quoting heights or slack times to a user — don't repurpose it for that.
 *
 * WHY NOT A KNOTS THRESHOLD
 *   No global model resolves tidal streams in a narrow entrance; inside the
 *   bay the best available current product peaks around 0.8 kt against a real
 *   flood of several knots. Maritime Safety Queensland's own bar-crossing
 *   guidance is expressed in tidal phase — "cross on an incoming tide" — never
 *   in knots. So strength is inferred from spring/neap state and wind, and
 *   `windVsTide` reports how it reached that judgement via `confidence`.
 */

import { tidePhase, streamDirection, windVsTide, type TidePhase, type WindTideResult } from './windOverTide';

/** One hour of the timeline. */
export interface WindTideWindow {
    time: string;
    seaLevel: number;
    phase: TidePhase;
    windDeg: number | null;
    windKts: number | null;
    streamDeg: number | null;
    result: WindTideResult;
}

export interface WindTideSeriesInput {
    times: string[];
    /** metres, same length as times */
    seaLevel: (number | null)[];
    /** degrees the wind blows FROM */
    windDirection: (number | null)[];
    /** knots */
    windSpeed: (number | null)[];
    /** User-set direction the stream runs TOWARD on a rising tide. The most
     *  accurate input available and it overrides any modelled current. */
    floodDirection?: number | null;
    /** Modelled current direction (TOWARD), used only when floodDirection is unset. */
    modelledCurrentDir?: (number | null)[];
}

/**
 * Spring/neap state as a dimensionless ratio: this cycle's range divided by
 * the median range across the series.
 *
 * Deliberately NOT an absolute metre threshold — tidal range spans ~0.3 m in
 * the Mediterranean to >12 m in the Bay of Fundy, so any fixed number is
 * meaningless for a global app. A ratio travels.
 *
 * Returns null when the series is too short to contain a full cycle, in which
 * case the caller simply gets no spring/neap contribution rather than a
 * fabricated one.
 */
export function springNeapRatio(seaLevel: (number | null)[], atIndex: number): number | null {
    const vals = seaLevel.filter((v): v is number => v != null);
    if (vals.length < 25) return null; // need at least ~one semi-diurnal cycle

    // Local range: the window either side of `atIndex` covering roughly one
    // semi-diurnal cycle (12.4 h, so +/- 6 hours).
    const lo = Math.max(0, atIndex - 6);
    const hi = Math.min(seaLevel.length - 1, atIndex + 6);
    const local = seaLevel.slice(lo, hi + 1).filter((v): v is number => v != null);
    if (local.length < 6) return null;
    const localRange = Math.max(...local) - Math.min(...local);

    // Typical range: median of every rolling 12-hour window in the series.
    const ranges: number[] = [];
    for (let i = 0; i + 12 < vals.length; i += 6) {
        const w = vals.slice(i, i + 13);
        ranges.push(Math.max(...w) - Math.min(...w));
    }
    if (!ranges.length) return null;
    ranges.sort((a, b) => a - b);
    const median = ranges[Math.floor(ranges.length / 2)];
    if (median <= 0) return null;

    return localRange / median;
}

export function buildWindOverTideSeries(input: WindTideSeriesInput): WindTideWindow[] {
    const { times, seaLevel, windDirection, windSpeed, floodDirection, modelledCurrentDir } = input;
    const out: WindTideWindow[] = [];

    for (let i = 0; i < times.length; i++) {
        const h = seaLevel[i];
        const next = seaLevel[i + 1];
        if (h == null || next == null) continue;

        const phase = tidePhase(h, next);
        const streamDeg = streamDirection(phase, floodDirection, modelledCurrentDir?.[i]);
        const result = windVsTide({
            windDeg: windDirection[i],
            windKts: windSpeed[i],
            streamDeg,
            currentKts: null, // no trustworthy in-bay current exists — see header
            streamFromSetting: floodDirection != null,
            phase,
            springNeapRatio: springNeapRatio(seaLevel, i),
        });

        out.push({
            time: times[i],
            seaLevel: h,
            phase,
            windDeg: windDirection[i] ?? null,
            windKts: windSpeed[i] ?? null,
            streamDeg,
            result,
        });
    }
    return out;
}

/** The contiguous stretches where wind-over-tide is flagged — what a user
 *  actually wants to see, rather than 48 individual hours. */
export interface WindTideAlert {
    from: string;
    to: string;
    hours: number;
    peakWindKts: number;
    confidence: WindTideResult['confidence'];
}

export function summariseAlerts(series: WindTideWindow[]): WindTideAlert[] {
    const alerts: WindTideAlert[] = [];
    let run: WindTideWindow[] = [];

    const flush = () => {
        if (run.length === 0) return;
        alerts.push({
            from: run[0].time,
            to: run[run.length - 1].time,
            hours: run.length,
            peakWindKts: Math.max(...run.map((w) => w.windKts ?? 0)),
            // Report the WEAKEST confidence in the run. A window that is
            // 'measured' for one hour and 'inferred' for five should not be
            // presented as measured.
            confidence: run.some((w) => w.result.confidence === 'inferred') ? 'inferred' : run[0].result.confidence,
        });
        run = [];
    };

    for (const w of series) {
        if (w.result.windOverTide) run.push(w);
        else flush();
    }
    flush();
    return alerts;
}
