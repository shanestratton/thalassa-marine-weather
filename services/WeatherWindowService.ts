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

import { useSettingsStore } from '../stores/settingsStore';
import type { ComfortParams, PreferredAngle } from '../types';
import { getOpenMeteoKey } from './weather/keys';
import { createLogger } from '../utils/createLogger';

/**
 * Internal scoring shape — what scoreWindow() actually consumes.
 * Replaces the old per-voyage ComfortProfile (now removed). Sourced
 * from settings.comfortParams (canonical) blended with vessel.maxWind*
 * mechanical caps in the analyse() entry point. Defaults applied where
 * fields are undefined so the scorer always has concrete numbers to
 * compare against.
 */
interface ScoringComfort {
    maxWindKts: number;
    maxWaveM: number;
    preferredAngles: PreferredAngle[];
}

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
    comfort: ScoringComfort,
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

    // Wind angle scoring — multi-select bands.
    // Each selected band contributes to the score: if the wind's
    // relative angle is in NONE of the selected bands, penalty applied.
    // If preferredAngles is empty / has all 5 → no filter (every relAngle
    // hits at least one band).
    if (courseBearing !== undefined && comfort.preferredAngles.length > 0 && comfort.preferredAngles.length < 5) {
        const avgWindDir = hourlyWindDir.reduce((a, b) => a + b, 0) / hourlyWindDir.length;
        const relAngle = Math.abs(((avgWindDir - courseBearing + 180) % 360) - 180);
        const inBand =
            (comfort.preferredAngles.includes('beating') && relAngle < 50) ||
            (comfort.preferredAngles.includes('close_reach') && relAngle >= 50 && relAngle < 80) ||
            (comfort.preferredAngles.includes('beam_reach') && relAngle >= 80 && relAngle < 110) ||
            (comfort.preferredAngles.includes('broad_reach') && relAngle >= 110 && relAngle < 150) ||
            (comfort.preferredAngles.includes('running') && relAngle >= 150);
        if (!inBand) score -= 20;
    }

    // Night departure penalty (if comfort says no night sailing)
    // This is handled at the caller level

    const clamped = Math.max(0, Math.min(100, score));
    const rating = clamped >= 70 ? 'go' : clamped >= 40 ? 'marginal' : 'wait';
    return { score: clamped, rating };
}

/**
 * Build the scoring comfort from the canonical sources:
 *   - vessel.maxWindSpeed / maxWaveHeight (mechanical caps)
 *   - settings.comfortParams.{maxWindKts,maxWaveM,preferredAngles} (user prefs)
 * Whichever cap is tighter wins per metric. Defaults applied so the
 * scorer always has concrete numbers (otherwise a missing maxWindKts
 * would make the maxWind > comfort.maxWindKts comparison evaluate to
 * `> undefined` = false, masking real wind penalties).
 */
function loadScoringComfort(): ScoringComfort {
    try {
        const settings = useSettingsStore.getState().settings;
        const v = settings.vessel;
        const c: ComfortParams = settings.comfortParams ?? {};
        const tightWind =
            v?.maxWindSpeed != null && c.maxWindKts != null
                ? Math.min(v.maxWindSpeed, c.maxWindKts)
                : (v?.maxWindSpeed ?? c.maxWindKts ?? 35);
        const tightWave =
            v?.maxWaveHeight != null && c.maxWaveM != null
                ? Math.min(v.maxWaveHeight, c.maxWaveM)
                : (v?.maxWaveHeight ?? c.maxWaveM ?? 4);
        return {
            maxWindKts: tightWind,
            maxWaveM: tightWave,
            preferredAngles: c.preferredAngles ?? [],
        };
    } catch {
        // Settings store unavailable (e.g. SSR) — return permissive defaults
        return { maxWindKts: 35, maxWaveM: 4, preferredAngles: [] };
    }
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
     * @param voyageId — Active voyage ID (kept on the signature for
     *   back-compat with callers; comfort thresholds are now sourced
     *   from the canonical settings.comfortParams + vessel profile,
     *   so the voyageId is no longer used here).
     * @param courseBearing — Bearing to destination (degrees)
     */
    async analyse(lat: number, lon: number, _voyageId?: string, courseBearing?: number): Promise<WeatherWindowResult> {
        const comfort = loadScoringComfort();

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

                // Night-departure penalty removed 2026-05-05 along with
                // the per-voyage ComfortProfile (which carried a
                // nightSailing flag). Users now pick a specific
                // departure date in the form; if they wanted a daylight
                // window they'd pick one. Adding a global "no night"
                // penalty would silently downgrade legitimate overnight
                // passages — most cruisers prefer to depart in the
                // afternoon for an arrival the next morning.
                const adjustedScore = score;
                const adjustedRating = rating;

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
