/**
 * TideOffsetService — the single number behind the "depth right now"
 * chart mode (design 2026-07-11, Shane: "maybe just a toggle switch??
 * ... but needs a disclaimer of course").
 *
 * When the charted depths and prediction explicitly share LAT,
 * live depth = charted + predicted height. This service reads that
 * height for "now" at the nearest station to a position, plus the
 * badge furniture (station name, trend, approx flag).
 *
 * HONESTY CONTRACT (non-negotiable, from the design session):
 *  - This is a PREDICTION, not a measurement — weather routinely moves
 *    real water ±0.3 m off the tables. The one-time acknowledge sheet
 *    and the permanent badge own that message.
 *  - Fails SAFE: any miss (offline, stale curve, out-of-range time)
 *    returns null and the chart reverts to chart datum. Never guess,
 *    never extrapolate, never freeze a stale offset.
 *  - VISUAL ONLY: routing and tracer verdicts keep their own per-spot
 *    LAT-based tide windows. Nothing here feeds the safety maths.
 */
import { readChartDatumForBounds } from './enc/readChartDatum';
import type { ChartBounds } from './enc/chartDatum';
import { fetchTideCurve } from './TideHeightService';
import { createLogger } from '../utils/createLogger';

const log = createLogger('TideOffset');

export interface TideOffsetRead {
    /** Predicted tide height above LAT right now, metres (1 decimal). */
    offsetM: number;
    trend: 'rising' | 'falling';
    /** Station the curve came from — badge attribution. Null = unnamed. */
    stationName: string | null;
    /** True when the curve was interpolated from extremes (±0.3 m-ish). */
    approx: boolean;
    fetchedAt: number;
}

/** A tide curve spanning now → +24 h — the scrubber's raw material. */
export interface TideCurveWindow {
    datum: 'LAT';
    heightAt(tMs: number): number | null;
    rangeMs: [number, number];
    stationName: string | null;
    approx: boolean;
    fetchedAt: number;
    /** Where this curve was requested for — refresh failures keep a
     *  still-valid curve only while the viewport stays near this fix. */
    fix: { lat: number; lon: number };
}

export async function readTideCurveWindow(
    lat: number,
    lon: number,
    chartBounds?: ChartBounds,
): Promise<TideCurveWindow | null> {
    const now = Date.now();
    try {
        // One paint offset affects every visible chart, so the whole
        // viewport must agree. Never apply a LAT curve to MLLW/LLWLT/MSL.
        if (chartBounds && (await readChartDatumForBounds(chartBounds, true)) !== 'LAT') return null;
        const curve = await fetchTideCurve(lat, lon, now - 3 * 3600_000, now + 27 * 3600_000, { chartBounds });
        if (!curve || curve.datum !== 'LAT') return null;
        return {
            datum: curve.datum,
            heightAt: (t: number) => curve.heightAt(t),
            rangeMs: curve.rangeMs,
            stationName: curve.stationName ?? null,
            approx: curve.provenance === 'EXTREMES_INTERP',
            fetchedAt: now,
            fix: { lat, lon },
        };
    } catch (err) {
        log.warn(`tide curve read failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}

/** Sample the curve at a moment (scrubber position or "now") into the
 *  badge-ready read. Null when the moment is outside the curve — the
 *  caller falls back to chart datum, never extrapolates. */
export function tideReadAt(curve: TideCurveWindow, tMs: number): TideOffsetRead | null {
    const h = curve.heightAt(tMs);
    if (h === null || !Number.isFinite(h)) return null;
    const later = curve.heightAt(tMs + 30 * 60_000);
    return {
        offsetM: Math.round(h * 10) / 10,
        trend: (later ?? h) >= h ? 'rising' : 'falling',
        stationName: curve.stationName,
        approx: curve.approx,
        fetchedAt: curve.fetchedAt,
    };
}

export async function readTideOffsetNow(lat: number, lon: number): Promise<TideOffsetRead | null> {
    const curve = await readTideCurveWindow(lat, lon);
    return curve ? tideReadAt(curve, Date.now()) : null;
}
