/**
 * How a departure window is scored against the skipper's limits: the one
 * scorer services/WeatherWindowService.ts rates its Go / Marginal / Wait
 * windows with, moved here unchanged (129-07) so check-weather-alerts'
 * "Good window opens" alert rates a window exactly as the passage card does.
 * Pure and dependency-free: the app and the edge function both import it.
 */

export type WindowAngleBand = 'beating' | 'close_reach' | 'beam_reach' | 'broad_reach' | 'running';

export interface WindowScoringLimits {
    maxWindKts: number;
    maxWaveM: number;
    preferredAngles: readonly WindowAngleBand[];
}

export type WindowRating = 'go' | 'marginal' | 'wait';

/** At or above this score a window is Go; at or above MARGINAL_SCORE it is Marginal. */
export const GO_SCORE = 70;
export const MARGINAL_SCORE = 40;

/**
 * Score one window: its hourly wind (kts) and waves (m), and, where a course
 * is known and the skipper picked some of the five angle bands, the wind's
 * angle off the course (0-180°).
 */
export function scoreDepartureWindow(
    hourlyWind: number[],
    hourlyWave: number[],
    limits: WindowScoringLimits,
    relAngle?: number,
): { score: number; rating: WindowRating } {
    let score = 100;

    const maxWind = Math.max(...hourlyWind);
    const avgWind = hourlyWind.reduce((a, b) => a + b, 0) / hourlyWind.length;
    const maxWave = Math.max(...hourlyWave);

    // Wind penalty
    if (maxWind > limits.maxWindKts) {
        score -= 50; // Hard fail
    } else if (maxWind > limits.maxWindKts * 0.8) {
        score -= 20; // Marginal
    } else if (avgWind > 5 && avgWind < limits.maxWindKts * 0.6) {
        score += 5; // Bonus for ideal range
    }

    // Light wind penalty (too little wind for sailing)
    if (avgWind < 5) score -= 10;

    // Wave penalty
    if (maxWave > limits.maxWaveM) {
        score -= 40;
    } else if (maxWave > limits.maxWaveM * 0.7) {
        score -= 15;
    }

    // Wind angle scoring — multi-select bands. If the wind's relative angle
    // is in NONE of the selected bands, a penalty applies. No bands, or all
    // five, is no filter.
    const bands = limits.preferredAngles;
    if (relAngle !== undefined && bands.length > 0 && bands.length < 5) {
        const inBand = (bands.includes('beating') && relAngle < 50) ||
            (bands.includes('close_reach') && relAngle >= 50 && relAngle < 80) ||
            (bands.includes('beam_reach') && relAngle >= 80 && relAngle < 110) ||
            (bands.includes('broad_reach') && relAngle >= 110 && relAngle < 150) ||
            (bands.includes('running') && relAngle >= 150);
        if (!inBand) score -= 20;
    }

    const clamped = Math.max(0, Math.min(100, score));
    const rating = clamped >= GO_SCORE ? 'go' : clamped >= MARGINAL_SCORE ? 'marginal' : 'wait';
    return { score: clamped, rating };
}
