/**
 * WeatherWindowService — Departure window scoring for cruisers.
 *
 * Analyses the next 7 days of forecast data for a given route
 * and scores 6-hour departure windows as Go / Marginal / Wait.
 * Uses the comfort profile thresholds to determine scoring.
 *
 * Data source: Open-Meteo Commercial marine forecast API.
 * Falls back to cached data for offline use.
 */

import { ComfortProfileService, type ComfortProfile } from './ComfortProfileService';
import { getOpenMeteoKey } from './weather/keys';
import { createLogger } from '../utils/createLogger';

const log = createLogger('WeatherWindow');

export interface DepartureWindow {
    /** ISO timestamp of departure start */
    time: string;
    /** Human label, e.g. "Thu 06:00" */
    label: string;
    /** Rating: 'go' | 'marginal' | 'wait' */
    rating: 'go' | 'marginal' | 'wait';
    /** 0-100 score (higher = better) */
    score: number;
    /** Forecast summary for the first 24h of this window */
    summary: {
        maxWindKts: number;
        avgWindKts: number;
        maxWaveM: number;
        avgWaveM: number;
        dominantWindDir: string;
        rainProbability: number;
    };
    /** Human-readable description */
    description: string;
}

export interface WeatherWindowResult {
    windows: DepartureWindow[];
    bestWindowIndex: number;
    analysisTime: string;
    source: 'live' | 'cached';
}

const CACHE_KEY = 'thalassa_weather_windows';
const CACHE_TTL = 3 * 60 * 60 * 1000; // 3 hours

/** Wind direction labels */
const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
function degToDir(deg: number): string {
    const idx = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
    return DIRS[idx];
}

/** Score a single 6h window against comfort thresholds */
function scoreWindow(
    hourlyWind: number[],
    hourlyWave: number[],
    hourlyWindDir: number[],
    comfort: ComfortProfile,
    courseBearing?: number,
): { score: number; rating: 'go' | 'marginal' | 'wait' } {
    let score = 100;

    const maxWind = Math.max(...hourlyWind);
    const avgWind = hourlyWind.reduce((a, b) => a + b, 0) / hourlyWind.length;
    const maxWave = Math.max(...hourlyWave);

    // Wind penalty
    if (maxWind > comfort.maxWindKts) {
        score -= 50; // Hard fail
    } else if (maxWind > comfort.maxWindKts * 0.8) {
        score -= 20; // Marginal
    } else if (avgWind > 5 && avgWind < comfort.maxWindKts * 0.6) {
        score += 5; // Bonus for ideal range
    }

    // Light wind penalty (too little wind for sailing)
    if (avgWind < 5) score -= 10;

    // Wave penalty
    if (maxWave > comfort.maxWaveM) {
        score -= 40;
    } else if (maxWave > comfort.maxWaveM * 0.7) {
        score -= 15;
    }

    // Wind angle scoring (if course bearing provided)
    if (courseBearing !== undefined && comfort.preferredAngle !== 'any') {
        const avgWindDir = hourlyWindDir.reduce((a, b) => a + b, 0) / hourlyWindDir.length;
        const relAngle = Math.abs(((avgWindDir - courseBearing + 180) % 360) - 180);

        if (comfort.preferredAngle === 'following' && relAngle > 45) score -= 15;
        if (comfort.preferredAngle === 'quarter' && (relAngle < 45 || relAngle > 90)) score -= 10;
        if (comfort.preferredAngle === 'broad_reach' && (relAngle < 90 || relAngle > 135)) score -= 10;
        if (comfort.preferredAngle === 'no_beating' && relAngle > 135) score -= 25;
    }

    // Night departure penalty (if comfort says no night sailing)
    // This is handled at the caller level

    const clamped = Math.max(0, Math.min(100, score));
    const rating = clamped >= 70 ? 'go' : clamped >= 40 ? 'marginal' : 'wait';
    return { score: clamped, rating };
}

/** Day + time label */
function timeLabel(iso: string): string {
    const d = new Date(iso);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    return `${days[d.getDay()]} ${d.getHours().toString().padStart(2, '0')}:00`;
}

/** Build description string */
function describeWindow(summary: DepartureWindow['summary']): string {
    const parts: string[] = [];
    parts.push(`${summary.dominantWindDir} ${summary.avgWindKts.toFixed(0)}–${summary.maxWindKts.toFixed(0)}kt`);
    parts.push(`${summary.avgWaveM.toFixed(1)}–${summary.maxWaveM.toFixed(1)}m swell`);
    if (summary.rainProbability > 50) parts.push(`${summary.rainProbability}% rain`);
    return parts.join(' · ');
}

export const WeatherWindowService = {
    /**
     * Analyse departure windows for the next 7 days.
     * @param lat — Departure latitude
     * @param lon — Departure longitude
     * @param voyageId — Active voyage ID (for comfort profile lookup)
     * @param courseBearing — Bearing to destination (degrees)
     */
    async analyse(lat: number, lon: number, voyageId?: string, courseBearing?: number): Promise<WeatherWindowResult> {
        const comfort = ComfortProfileService.load(voyageId);

        // Check cache
        try {
            const cached = localStorage.getItem(CACHE_KEY);
            if (cached) {
                const data = JSON.parse(cached);
                if (Date.now() - new Date(data.analysisTime).getTime() < CACHE_TTL) {
                    log.info('Using cached weather windows');
                    return { ...data, source: 'cached' };
                }
            }
        } catch {
            /* ignore */
        }

        // Fetch from Open-Meteo Commercial Marine API
        try {
            const omKey = getOpenMeteoKey();
            const keyParam = omKey ? `&apikey=${omKey}` : '';
            const marineBase = omKey
                ? 'https://customer-marine-api.open-meteo.com/v1/marine'
                : 'https://marine-api.open-meteo.com/v1/marine';
            const forecastBase = omKey
                ? 'https://customer-api.open-meteo.com/v1/forecast'
                : 'https://api.open-meteo.com/v1/forecast';

            const url =
                `${marineBase}?` +
                `latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
                `&hourly=wave_height,wave_direction,wave_period,wind_wave_height` +
                `&forecast_days=7&timezone=auto${keyParam}`;

            const windUrl =
                `${forecastBase}?` +
                `latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
                `&hourly=wind_speed_10m,wind_direction_10m,precipitation_probability` +
                `&forecast_days=7&timezone=auto&wind_speed_unit=kn${keyParam}`;

            const [marineRes, windRes] = await Promise.all([fetch(url), fetch(windUrl)]);

            if (!marineRes.ok || !windRes.ok) throw new Error('API error');

            const marine = await marineRes.json();
            const wind = await windRes.json();

            const times: string[] = wind.hourly.time;
            const windSpeed: number[] = wind.hourly.wind_speed_10m;
            const windDir: number[] = wind.hourly.wind_direction_10m;
            const waveHeight: number[] = marine.hourly.wave_height;
            const precip: number[] = wind.hourly.precipitation_probability;

            // Build 6-hour windows
            const windows: DepartureWindow[] = [];
            const step = 6;

            for (let i = 0; i + step <= times.length && windows.length < 28; i += step) {
                const sliceWind = windSpeed.slice(i, i + step);
                const sliceWave = waveHeight.slice(i, i + step);
                const sliceDir = windDir.slice(i, i + step);
                const slicePrecip = precip.slice(i, i + step);

                // Extend analysis to 24h if enough data
                const extEnd = Math.min(i + 24, times.length);
                const dayWind = windSpeed.slice(i, extEnd);
                const dayWave = waveHeight.slice(i, extEnd);

                const { score, rating } = scoreWindow(dayWind, dayWave, sliceDir, comfort, courseBearing);

                // Night penalty
                const hour = new Date(times[i]).getHours();
                const isNight = hour < 6 || hour >= 20;
                let adjustedScore = score;
                if (isNight && !comfort.nightSailing) adjustedScore -= 15;
                const adjustedRating = adjustedScore >= 70 ? 'go' : adjustedScore >= 40 ? 'marginal' : 'wait';

                const summary: DepartureWindow['summary'] = {
                    maxWindKts: Math.round(Math.max(...dayWind)),
                    avgWindKts: Math.round(dayWind.reduce((a, b) => a + b, 0) / dayWind.length),
                    maxWaveM: Math.round(Math.max(...dayWave) * 10) / 10,
                    avgWaveM: Math.round((dayWave.reduce((a, b) => a + b, 0) / dayWave.length) * 10) / 10,
                    dominantWindDir: degToDir(sliceDir.reduce((a, b) => a + b, 0) / sliceDir.length),
                    rainProbability: Math.round(Math.max(...slicePrecip)),
                };

                windows.push({
                    time: times[i],
                    label: timeLabel(times[i]),
                    rating: adjustedRating,
                    score: Math.max(0, Math.min(100, adjustedScore)),
                    summary,
                    description: describeWindow(summary),
                });
            }

            // Find best window
            const bestIdx = windows.reduce((best, w, i) => (w.score > windows[best].score ? i : best), 0);

            const result: WeatherWindowResult = {
                windows,
                bestWindowIndex: bestIdx,
                analysisTime: new Date().toISOString(),
                source: 'live',
            };

            // Cache
            try {
                localStorage.setItem(CACHE_KEY, JSON.stringify(result));
            } catch {
                /* ignore */
            }

            return result;
        } catch (err) {
            log.error('Weather window analysis failed:', err);

            // Return cached if available
            try {
                const cached = localStorage.getItem(CACHE_KEY);
                if (cached) return { ...JSON.parse(cached), source: 'cached' };
            } catch {
                /* ignore */
            }

            // Return empty
            return {
                windows: [],
                bestWindowIndex: -1,
                analysisTime: new Date().toISOString(),
                source: 'live',
            };
        }
    },

    /** Clear cached analysis */
    clearCache(): void {
        try {
            localStorage.removeItem(CACHE_KEY);
        } catch {
            /* ignore */
        }
    },
};
