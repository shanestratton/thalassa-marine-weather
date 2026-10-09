/**
 * Anchor Watch Utility Functions
 *
 * Extracted from AnchorWatchPage.tsx — pure functions for nav status colors,
 * weather scope recommendations, distance formatting, bearing conversion,
 * and elapsed time display.
 */

import type { DistanceUnit, LengthUnit } from '../../types/units';

// Nav status → color (same logic as useAisStreamLayer)
export function navStatusColorSimple(code: number): string {
    switch (code) {
        case 0:
            return '#22c55e';
        case 1:
            return '#f59e0b';
        case 5:
        case 6:
            return '#94a3b8';
        case 7:
            return '#06b6d4';
        case 2:
        case 3:
        case 4:
            return '#f97316';
        case 14:
            return '#ef4444';
        default:
            return '#38bdf8';
    }
}

/** Compute weather-aware scope recommendation */
export function getWeatherRecommendation(windKts: number, gustKts: number, waveM: number) {
    const effectiveWind = Math.max(windKts, gustKts * 0.85);
    if (effectiveWind >= 30 || waveM >= 3) {
        return { scope: 10, label: 'Storm Scope', severity: 'red' as const, icon: '🌊' };
    }
    if (effectiveWind >= 20 || waveM >= 2) {
        return { scope: 8, label: 'Strong Wind', severity: 'amber' as const, icon: '💨' };
    }
    if (effectiveWind >= 10 || waveM >= 1) {
        return { scope: 7, label: 'Moderate', severity: 'sky' as const, icon: '🌬️' };
    }
    return { scope: 5, label: 'Light Air', severity: 'emerald' as const, icon: '☀️' };
}

/** Format meters to human-readable — '35 m', spaced like '1.0 NM' and the
 *  slider ends (UX scorecard run 6 saw '5m' beside '1 m'). */
export function formatDistance(meters: number): string {
    if (meters < 1000) return `${meters.toFixed(0)} m`;
    return `${(meters / 1852).toFixed(1)} NM`;
}

const METRES_PER_FOOT = 0.3048;
const METRES_PER_LONG: Record<DistanceUnit, [number, string]> = {
    nm: [1852, 'NM'],
    km: [1000, 'km'],
    mi: [1609.344, 'mi'],
};

/**
 * A length at anchor in the VIEWER's own unit (Settings → units.length), the
 * number and its unit apart for a big readout: metres or feet, and from
 * 1000 m on their distance unit (NM unless they chose km or miles). Shore
 * Watch (126-03a): a feet skipper watching from ashore reads feet, whatever
 * the boat's phone uses. Not a number reads '--', never NaN.
 */
export function anchorLengthParts(
    metres: number,
    unit: LengthUnit,
    { decimals = 0, long = 'nm' }: { decimals?: number; long?: DistanceUnit } = {},
): { value: string; unit: string } {
    if (!Number.isFinite(metres)) return { value: '--', unit: '' };
    if (Math.abs(metres) >= 1000) {
        const [per, label] = METRES_PER_LONG[long] ?? METRES_PER_LONG.nm;
        return { value: (metres / per).toFixed(1), unit: label };
    }
    return unit === 'ft'
        ? { value: (metres / METRES_PER_FOOT).toFixed(decimals), unit: 'ft' }
        : { value: metres.toFixed(decimals), unit: 'm' };
}

/** '35 m', '115 ft', '1.0 NM': anchorLengthParts as one string. */
export function formatAnchorLength(
    metres: number,
    unit: LengthUnit,
    options?: { decimals?: number; long?: DistanceUnit },
): string {
    const parts = anchorLengthParts(metres, unit, options);
    return parts.unit ? `${parts.value} ${parts.unit}` : parts.value;
}

/** Format bearing to compass cardinal */
export function bearingToCardinal(deg: number): string {
    const dirs = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
    return dirs[Math.round(deg / 45) % 8];
}

/** Format elapsed time since timestamp */
export function formatElapsed(startMs: number): string {
    const elapsed = Date.now() - startMs;
    const hours = Math.floor(elapsed / 3600000);
    const minutes = Math.floor((elapsed % 3600000) / 60000);
    if (hours > 0) return `${hours}h ${minutes}m`;
    return `${minutes}m`;
}
