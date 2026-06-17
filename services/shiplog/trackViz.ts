/**
 * trackViz — pure presentation helpers for the Track Map Viewer.
 *
 * All functions here are side-effect-free and unit-tested so the viewer
 * stays a thin Leaflet shell. Three concerns:
 *
 *   - windBucket / WIND_BUCKETS: colour a track by the wind it sailed
 *     through. IMPORTANT framing — the wind on an entry is the FORECAST
 *     at capture time (from the weather cache keyed to the dashboard
 *     location), NOT a measured in-situ instrument reading, and it's
 *     often absent offshore. So there's an explicit "no data" bucket and
 *     the legend says "forecast wind" — we never imply measured sea state.
 *   - buildSparkline: a speed-over-time profile for the scrubber.
 *   - nearestTrackEntry: project a tapped lat/lon onto the track for the
 *     tap-for-conditions popup.
 */
import type { ShipLogEntry } from '../../types';
import { isTrackworthyEntry } from './helpers';

export interface WindBucket {
    key: string;
    /** Inclusive upper bound in knots; null = the catch-all top band. */
    maxKt: number | null;
    color: string;
    /** Short legend label. */
    label: string;
}

/**
 * Wind colour ramp — intuitive cold→hot, readable on the light Voyager
 * base. Bucketed (not continuous) so the polyline splits into a handful
 * of segments, never hundreds. Bands follow the Beaufort breakpoints
 * sailors already know (calm → gale).
 */
export const WIND_NODATA_COLOR = '#94a3b8';
export const WIND_BUCKETS: WindBucket[] = [
    { key: 'calm', maxKt: 6, color: '#2dd4bf', label: '<6' },
    { key: 'gentle', maxKt: 11, color: '#22c55e', label: '6–11' },
    { key: 'moderate', maxKt: 17, color: '#84cc16', label: '11–17' },
    { key: 'fresh', maxKt: 22, color: '#eab308', label: '17–22' },
    { key: 'strong', maxKt: 28, color: '#f97316', label: '22–28' },
    { key: 'neargale', maxKt: 34, color: '#ef4444', label: '28–34' },
    { key: 'gale', maxKt: null, color: '#a21caf', label: '34+' },
];

const NODATA_BUCKET: WindBucket = { key: 'nodata', maxKt: null, color: WIND_NODATA_COLOR, label: 'No wind data' };

/**
 * Bucket a wind speed (knots) for track colouring. Undefined/null/NaN →
 * the explicit no-data bucket (don't pretend calm). Negative clamps to
 * the lowest band.
 */
export function windBucket(windKt: number | null | undefined): WindBucket {
    if (windKt == null || !Number.isFinite(windKt)) return NODATA_BUCKET;
    for (const b of WIND_BUCKETS) {
        if (b.maxKt === null || windKt < b.maxKt) return b;
    }
    return WIND_BUCKETS[WIND_BUCKETS.length - 1];
}

export interface Sparkline {
    /** SVG path string in the given w×h viewBox (empty string if <2 points). */
    path: string;
    /** x pixel position per entry index — for placing the playback cursor. */
    xs: number[];
    /** Max speed used to scale the y axis (kts; >= 1 so a flat track still draws). */
    maxKts: number;
}

/**
 * Build a speed-over-time sparkline path across a w×h viewBox. x is by
 * INDEX (entries are already timestamp-sorted), y is speed scaled to the
 * voyage max. Missing/zero speeds are treated as 0 (legit gaps — the
 * (0,0) placeholder and spike-drops leave real holes), never NaN.
 */
export function buildSparkline(entries: ShipLogEntry[], w: number, h: number): Sparkline {
    const n = entries.length;
    if (n < 2) return { path: '', xs: n === 1 ? [0] : [], maxKts: 1 };

    const speeds = entries.map((e) => (typeof e.speedKts === 'number' && e.speedKts > 0 ? e.speedKts : 0));
    const maxKts = Math.max(1, ...speeds);
    const xs = entries.map((_, i) => (i / (n - 1)) * w);

    let path = '';
    for (let i = 0; i < n; i++) {
        const y = h - (speeds[i] / maxKts) * h;
        path += `${i === 0 ? 'M' : 'L'}${xs[i].toFixed(1)} ${y.toFixed(1)}`;
    }
    return { path, xs, maxKts };
}

/**
 * Nearest trackworthy entry to a tapped lat/lon (equirectangular
 * approximation — fine at the scale of a tap radius). Ignores manual
 * entries and turn pins so the popup lands on the actual track. Returns
 * null if there are no trackworthy points.
 */
export function nearestTrackEntry(entries: ShipLogEntry[], lat: number, lon: number): ShipLogEntry | null {
    let best: ShipLogEntry | null = null;
    let bestD = Infinity;
    const cosLat = Math.cos((lat * Math.PI) / 180);
    for (const e of entries) {
        if (!isTrackworthyEntry(e)) continue;
        const dLat = (e.latitude as number) - lat;
        const dLon = ((e.longitude as number) - lon) * cosLat;
        const d = dLat * dLat + dLon * dLon;
        if (d < bestD) {
            bestD = d;
            best = e;
        }
    }
    return best;
}
