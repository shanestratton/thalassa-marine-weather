/** Display-only tide geometry. Never use the gauge fraction as depth or clearance. */
export interface TideDisplaySample {
    timeMs: number;
    heightM: number;
}

export type TideDisplayTrend = 'rising' | 'falling' | 'steady' | 'unknown';

export interface TideDisplayCurve {
    points: { x: number; y: number; timeMs: number; heightM: number }[];
    linePath: string;
    areaPath: string;
    minM: number;
    maxM: number;
    startMs: number;
    endMs: number;
}

export interface TideGaugePresentation {
    heightM: number | null;
    trend: TideDisplayTrend;
    /** Relative to this 24-hour prediction range, NOT relative to the seabed. */
    fraction: number | null;
    curve: TideDisplayCurve | null;
}

const HOUR_MS = 3_600_000;
const MAX_SAMPLE_GAP_MS = 2 * HOUR_MS;
export const TIDE_CURVE_WIDTH = 300;
export const TIDE_CURVE_HEIGHT = 116;

function samplesForDisplay(samples: readonly TideDisplaySample[]): TideDisplaySample[] {
    const sorted = samples
        .filter((sample) => Number.isFinite(sample.timeMs) && Number.isFinite(sample.heightM))
        .map((sample) => ({ ...sample }))
        .sort((a, b) => a.timeMs - b.timeMs);
    // Conflicting same-time heights are not a trustworthy current reading.
    if (
        sorted.some(
            (sample, i) => i > 0 && sample.timeMs === sorted[i - 1].timeMs && sample.heightM !== sorted[i - 1].heightM,
        )
    ) {
        return [];
    }
    return sorted.filter((sample, i) => i === 0 || sample.timeMs !== sorted[i - 1].timeMs);
}

function heightAt(samples: readonly TideDisplaySample[], timeMs: number): number | null {
    const next = samples.findIndex((sample) => sample.timeMs >= timeMs);
    if (next < 0) return null;
    if (samples[next].timeMs === timeMs) return samples[next].heightM;
    if (next === 0) return null;
    const a = samples[next - 1];
    const b = samples[next];
    if (b.timeMs - a.timeMs > MAX_SAMPLE_GAP_MS) return null;
    return a.heightM + (b.heightM - a.heightM) * ((timeMs - a.timeMs) / (b.timeMs - a.timeMs));
}

/**
 * Only dense provider samples belong here. Extrema are deliberately not an
 * argument: two HW/LW events must never fabricate a live height or a curve.
 */
export function tideGaugePresentation(samples: readonly TideDisplaySample[], nowMs: number): TideGaugePresentation {
    const empty: TideGaugePresentation = { heightM: null, trend: 'unknown', fraction: null, curve: null };
    if (!Number.isFinite(nowMs)) return empty;
    const sorted = samplesForDisplay(samples);
    const heightM = heightAt(sorted, nowMs);
    if (heightM === null) return empty;

    // Prefer the forward interval at an exact sample; never infer tidal
    // current/slack water from the slope of a water-level prediction.
    const after = sorted.findIndex((sample) => sample.timeMs > nowMs);
    const a = after > 0 ? sorted[after - 1] : after === -1 ? sorted[sorted.length - 2] : undefined;
    const b = after > 0 ? sorted[after] : after === -1 ? sorted[sorted.length - 1] : undefined;
    let trend: TideDisplayTrend = 'unknown';
    if (a && b && b.timeMs - a.timeMs <= MAX_SAMPLE_GAP_MS) {
        const slopeMPerHour = ((b.heightM - a.heightM) / (b.timeMs - a.timeMs)) * HOUR_MS;
        trend = Math.abs(slopeMPerHour) < 0.01 ? 'steady' : slopeMPerHour > 0 ? 'rising' : 'falling';
    }

    const endMs = nowMs + 24 * HOUR_MS;
    const endHeight = heightAt(sorted, endMs);
    if (endHeight === null) return { ...empty, heightM, trend };
    const window = [
        { timeMs: nowMs, heightM },
        ...sorted.filter((sample) => sample.timeMs > nowMs && sample.timeMs < endMs),
        { timeMs: endMs, heightM: endHeight },
    ];
    if (window.some((sample, i) => i > 0 && sample.timeMs - window[i - 1].timeMs > MAX_SAMPLE_GAP_MS)) {
        return { ...empty, heightM, trend };
    }
    const minM = Math.min(...window.map((sample) => sample.heightM));
    const maxM = Math.max(...window.map((sample) => sample.heightM));
    const range = maxM - minM;
    // A flat series is shown at mid-gauge, not as zero depth or an empty tide.
    const fraction = range > 1e-6 ? Math.max(0, Math.min(1, (heightM - minM) / range)) : 0.5;
    const plotRange = Math.max(0.1, range);
    const mid = (minM + maxM) / 2;
    const points = window.map((sample) => ({
        ...sample,
        x: 8 + ((sample.timeMs - nowMs) / (24 * HOUR_MS)) * (TIDE_CURVE_WIDTH - 16),
        y: 14 + ((mid + plotRange / 2 - sample.heightM) / plotRange) * (TIDE_CURVE_HEIGHT - 28),
    }));
    const linePath = points
        .map((point, i) => `${i === 0 ? 'M' : 'L'}${point.x.toFixed(2)},${point.y.toFixed(2)}`)
        .join(' ');
    const areaPath = `${linePath} L${points[points.length - 1].x.toFixed(2)},${TIDE_CURVE_HEIGHT} L8,${TIDE_CURVE_HEIGHT} Z`;
    return { heightM, trend, fraction, curve: { points, linePath, areaPath, minM, maxM, startMs: nowMs, endMs } };
}

export function tideHeightLabel(heightM: number | null): string {
    if (heightM === null || !Number.isFinite(heightM)) return '—';
    // Avoid displaying negative zero after decimal rounding.
    return (Math.abs(heightM) < 0.05 ? 0 : heightM).toFixed(1);
}

/** Meteorological FROM bearing, never vessel-relative/apparent wind. */
export function stationWindDirection(degrees: number | null): string | null {
    if (degrees === null || !Number.isFinite(degrees) || degrees < 0 || degrees > 360) return null;
    const bearings = [
        'N',
        'NNE',
        'NE',
        'ENE',
        'E',
        'ESE',
        'SE',
        'SSE',
        'S',
        'SSW',
        'SW',
        'WSW',
        'W',
        'WNW',
        'NW',
        'NNW',
    ];
    return `${bearings[Math.round((degrees % 360) / 22.5) % 16]} · ${Math.round(degrees % 360)}°`;
}
