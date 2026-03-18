/**
 * Anchor Watch Utility Functions
 *
 * Extracted from AnchorWatchPage.tsx — pure functions for nav status colors,
 * weather scope recommendations, distance formatting, bearing conversion,
 * and elapsed time display.
 */

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

/** Format meters to human-readable */
export function formatDistance(meters: number): string {
    if (meters < 1000) return `${meters.toFixed(0)}m`;
    return `${(meters / 1852).toFixed(1)} NM`;
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
