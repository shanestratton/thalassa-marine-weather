/**
 * WeatherWindowService — Departure window scoring for cruisers.
 *
 * Analyses the next 16 days of forecast data for a given route
 * and scores 6-hour departure windows as Go / Marginal / Wait.
 * Uses the comfort profile thresholds to determine scoring.
 *
 * Data source: Open-Meteo Commercial marine forecast API.
 * Falls back to cached data for offline use.
 */

import { useSettingsStore } from '../stores/settingsStore';
import type { ComfortParams, PreferredAngle } from '../types';
import { fetchOpenMeteoProxy } from './weather/openMeteoProxy';
import { createLogger } from '../utils/createLogger';
import { vesselMaxWaveHeightMetres } from './units';
import { circularMean } from '../utils/circularStats';
import { passageDataFingerprint } from './passageEnvironmentReadiness';
import {
    canUsePlaintextWeatherCache,
    readPlaintextWeatherCacheItem,
    writePlaintextWeatherCacheItem,
} from './weather/plaintextCachePrivacy';

/**
 * Internal scoring shape — what scoreWindow() actually consumes.
 * Replaces the old per-voyage ComfortProfile (now removed). Sourced
 * from settings.comfortParams (canonical) blended with vessel.maxWind*
 * mechanical caps in the analyse() entry point. Defaults applied where
 * fields are undefined so the scorer always has concrete numbers to
 * compare against.
 */
export interface WeatherWindowScoringComfort {
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

interface WeatherWindowResultBase {
    windows: DepartureWindow[];
    bestWindowIndex: number;
    analysisTime: string;
    provider: typeof WEATHER_WINDOW_PROVIDER;
}

export interface AvailableWeatherWindowResult extends WeatherWindowResultBase {
    availability: 'available';
    source: 'live' | 'cached';
    cacheVersion: 2;
    forecastStart: string | null;
    forecastEnd: string | null;
    dataFingerprint: string;
    analysisContextFingerprint: string;
}

export interface UnavailableWeatherWindowResult extends WeatherWindowResultBase {
    availability: 'unavailable';
    source: 'unavailable';
    forecastStart: null;
    forecastEnd: null;
    dataFingerprint: null;
    analysisContextFingerprint: string;
    failureReason: string;
}

export type WeatherWindowResult = AvailableWeatherWindowResult | UnavailableWeatherWindowResult;

const CACHE_KEY = 'thalassa_weather_windows';
export const WEATHER_WINDOW_PROVIDER = 'Open-Meteo Commercial marine + forecast' as const;
export const WEATHER_WINDOW_CACHE_TTL_MS = 3 * 60 * 60 * 1000;
/** Hard ceiling for fallback/acceptance. Older forecasts are context only, never readiness. */
export const WEATHER_WINDOW_MAX_FALLBACK_AGE_MS = 6 * 60 * 60 * 1000;
const WEATHER_WINDOW_TIMEOUT_MS = 20_000;

function analysisAgeMs(analysisTime: string, nowMs = Date.now()): number {
    const analysedAt = Date.parse(analysisTime);
    return Number.isFinite(analysedAt) ? nowMs - analysedAt : Number.POSITIVE_INFINITY;
}

export function isWeatherWindowResultAcceptable(
    result: WeatherWindowResult | null | undefined,
    nowMs = Date.now(),
): result is AvailableWeatherWindowResult {
    if (result?.availability !== 'available' || result.windows.length === 0) return false;
    const ageMs = analysisAgeMs(result.analysisTime, nowMs);
    return ageMs >= -5 * 60 * 1000 && ageMs <= WEATHER_WINDOW_MAX_FALLBACK_AGE_MS;
}

function unavailableResult(contextFingerprint: string, reason: string): UnavailableWeatherWindowResult {
    return {
        availability: 'unavailable',
        windows: [],
        bestWindowIndex: -1,
        analysisTime: new Date().toISOString(),
        source: 'unavailable',
        provider: WEATHER_WINDOW_PROVIDER,
        forecastStart: null,
        forecastEnd: null,
        dataFingerprint: null,
        analysisContextFingerprint: contextFingerprint,
        failureReason: reason,
    };
}

function parseCachedResult(raw: string | null): AvailableWeatherWindowResult | null {
    if (!raw) return null;
    try {
        const value = JSON.parse(raw) as Partial<AvailableWeatherWindowResult>;
        if (
            value.availability !== 'available' ||
            value.cacheVersion !== 2 ||
            value.provider !== WEATHER_WINDOW_PROVIDER ||
            !Array.isArray(value.windows) ||
            typeof value.analysisTime !== 'string' ||
            typeof value.dataFingerprint !== 'string' ||
            typeof value.analysisContextFingerprint !== 'string'
        ) {
            return null;
        }
        return value as AvailableWeatherWindowResult;
    } catch {
        return null;
    }
}

/** Wind direction labels */
const DIRS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
function degToDir(deg: number): string {
    const idx = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
    return DIRS[idx];
}

/**
 * Average wind bearings safely across the 0°/360° seam. An arithmetic mean
 * would label 350° + 10° as a southerly (180°), which can invert the apparent
 * wind angle and change a departure recommendation. Opposed directions have
 * no mathematical mean, so retain the first usable forecast bearing in that
 * deliberately ambiguous case.
 */
export function meanWindDirection(degrees: number[]): number {
    const mean = circularMean(degrees);
    if (mean !== null) return mean;
    return degrees.find(Number.isFinite) ?? 0;
}

/** Score a single 6h window against comfort thresholds */
function scoreWindow(
    hourlyWind: number[],
    hourlyWave: number[],
    hourlyWindDir: number[],
    comfort: WeatherWindowScoringComfort,
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
        const avgWindDir = meanWindDirection(hourlyWindDir);
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
function loadScoringComfort(): WeatherWindowScoringComfort {
    try {
        const settings = useSettingsStore.getState().settings;
        const v = settings.vessel;
        const c: ComfortParams = settings.comfortParams ?? {};
        const tightWind =
            v?.maxWindSpeed != null && c.maxWindKts != null
                ? Math.min(v.maxWindSpeed, c.maxWindKts)
                : (v?.maxWindSpeed ?? c.maxWindKts ?? 35);
        // Both sides in METRES before Math.min — the profile stores feet.
        const vMaxWaveM = v?.maxWaveHeight != null ? vesselMaxWaveHeightMetres(v) : null;
        const tightWave =
            vMaxWaveM != null && c.maxWaveM != null ? Math.min(vMaxWaveM, c.maxWaveM) : (vMaxWaveM ?? c.maxWaveM ?? 4);
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

/** Day + date + time label.
 *  Example: "Thu, 8 May · 06:00".
 *  Day-of-week alone was ambiguous when the 7-day window straddles a
 *  month boundary or the user had multiple draft voyages on different
 *  Thursdays — the user couldn't tell which Thursday the card meant. */
function timeLabel(iso: string): string {
    const d = new Date(iso);
    const days = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const dow = days[d.getDay()];
    const dayNum = d.getDate();
    const month = months[d.getMonth()];
    const time = `${d.getHours().toString().padStart(2, '0')}:00`;
    return `${dow}, ${dayNum} ${month} · ${time}`;
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
     * Analyse departure windows for the next 16 days.
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
        const analysisContextFingerprint = passageDataFingerprint('weather-window-context', {
            lat,
            lon,
            courseBearing,
            comfort,
        });

        // Coordinates are normally supplied by a selected map point, but this
        // service is also called from forms and restored voyage data. Refuse
        // malformed values before they can create a bogus cache key or request.
        if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
            log.warn('Ignoring weather-window request with invalid coordinates');
            return unavailableResult(analysisContextFingerprint, 'Departure coordinates are invalid.');
        }

        // The scored result is not just location data: course and the effective
        // vessel/comfort thresholds alter every rating. Key the cache by all of
        // those inputs so changing a limit can never revive an old Go result.
        const cacheKey = `${CACHE_KEY}:${analysisContextFingerprint}`;
        let fallbackCache: AvailableWeatherWindowResult | null = null;

        // Check cache
        try {
            const data = parseCachedResult(readPlaintextWeatherCacheItem(cacheKey));
            if (data) {
                const ageMs = analysisAgeMs(data.analysisTime);
                if (ageMs >= 0 && ageMs <= WEATHER_WINDOW_MAX_FALLBACK_AGE_MS) fallbackCache = data;
                if (ageMs >= 0 && ageMs < WEATHER_WINDOW_CACHE_TTL_MS) {
                    log.info('Using cached weather windows');
                    return { ...data, source: 'cached' };
                }
                if (ageMs > WEATHER_WINDOW_MAX_FALLBACK_AGE_MS) localStorage.removeItem(cacheKey);
            }
        } catch {
            /* ignore */
        }

        // Fetch through the server-owned commercial Open-Meteo boundary.
        try {
            // 16 days = Open-Meteo's max forecast horizon. We fetch the
            // whole window so the card can scope/filter to any
            // departure date the user picks (vs the old 7-day fixed
            // window from "now" that ignored the user's choice).
            // A stalled radio/satellite connection must not leave the passage
            // card in a permanent loading state. Both source calls share one
            // deadline because a partial forecast cannot score a safe window.
            const [marine, wind] = await Promise.all([
                fetchOpenMeteoProxy<{
                    hourly: {
                        wave_height: number[];
                        wave_direction: number[];
                        wave_period: number[];
                        wind_wave_height: number[];
                    };
                }>(
                    'marine',
                    {
                        latitude: lat.toFixed(4),
                        longitude: lon.toFixed(4),
                        hourly: 'wave_height,wave_direction,wave_period,wind_wave_height',
                        forecast_days: 16,
                        timezone: 'auto',
                    },
                    WEATHER_WINDOW_TIMEOUT_MS,
                ),
                fetchOpenMeteoProxy<{
                    hourly: {
                        time: string[];
                        wind_speed_10m: number[];
                        wind_direction_10m: number[];
                        precipitation_probability: number[];
                    };
                }>(
                    'forecast',
                    {
                        latitude: lat.toFixed(4),
                        longitude: lon.toFixed(4),
                        hourly: 'wind_speed_10m,wind_direction_10m,precipitation_probability',
                        forecast_days: 16,
                        timezone: 'auto',
                        wind_speed_unit: 'kn',
                    },
                    WEATHER_WINDOW_TIMEOUT_MS,
                ),
            ]);

            const times: string[] = wind.hourly.time;
            const windSpeed: number[] = wind.hourly.wind_speed_10m;
            const windDir: number[] = wind.hourly.wind_direction_10m;
            const waveHeight: number[] = marine.hourly.wave_height;
            const precip: number[] = wind.hourly.precipitation_probability;
            if (![times, windSpeed, windDir, waveHeight, precip].every(Array.isArray)) {
                throw new Error('Forecast response is missing hourly series');
            }
            // Providers should return aligned hourly series, but treat a
            // truncated/mismatched response as only as complete as its shortest
            // required series. This avoids scoring a window with Infinity/NaN.
            const forecastLength = Math.min(
                times.length,
                windSpeed.length,
                windDir.length,
                waveHeight.length,
                precip.length,
            );
            for (let index = 0; index < forecastLength; index += 1) {
                if (
                    typeof times[index] !== 'string' ||
                    !Number.isFinite(Date.parse(times[index])) ||
                    ![windSpeed[index], windDir[index], waveHeight[index], precip[index]].every(
                        (value) => typeof value === 'number' && Number.isFinite(value),
                    )
                ) {
                    throw new Error(`Forecast response has invalid hourly data at index ${index}`);
                }
            }

            // Build 6-hour windows
            const windows: DepartureWindow[] = [];
            const step = 6;

            // 16 days × 4 windows/day = 64 max. Up from 28 (7 × 4) so
            // the card can show windows around any chosen departure
            // date within the forecast horizon.
            for (let i = 0; i + step <= forecastLength && windows.length < 64; i += step) {
                const sliceDir = windDir.slice(i, i + step);
                const slicePrecip = precip.slice(i, i + step);

                // Extend analysis to 24h if enough data
                const extEnd = Math.min(i + 24, forecastLength);
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
                    dominantWindDir: degToDir(meanWindDirection(sliceDir)),
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
            const bestIdx = windows.length
                ? windows.reduce((best, w, i) => (w.score > windows[best].score ? i : best), 0)
                : -1;

            const dataFingerprint = passageDataFingerprint('weather-window-provider-data', {
                times: times.slice(0, forecastLength),
                windSpeed: windSpeed.slice(0, forecastLength),
                windDir: windDir.slice(0, forecastLength),
                waveHeight: waveHeight.slice(0, forecastLength),
                precip: precip.slice(0, forecastLength),
            });
            const result: AvailableWeatherWindowResult = {
                availability: 'available',
                windows,
                bestWindowIndex: bestIdx,
                analysisTime: new Date().toISOString(),
                source: 'live',
                provider: WEATHER_WINDOW_PROVIDER,
                cacheVersion: 2,
                forecastStart: times[0] ?? null,
                forecastEnd: forecastLength > 0 ? (times[forecastLength - 1] ?? null) : null,
                dataFingerprint,
                analysisContextFingerprint,
            };

            // Cache
            writePlaintextWeatherCacheItem(cacheKey, JSON.stringify(result));

            return result;
        } catch (err) {
            log.error('Weather window analysis failed:', err);

            // Only a bounded, structurally verified cache can stand in for a
            // failed live request. Anything older is contextually obsolete and
            // cannot be accepted as departure readiness.
            if (fallbackCache && analysisAgeMs(fallbackCache.analysisTime) <= WEATHER_WINDOW_MAX_FALLBACK_AGE_MS) {
                return { ...fallbackCache, source: 'cached' };
            }

            return unavailableResult(
                analysisContextFingerprint,
                'Live weather-window data is unavailable and no sufficiently fresh cached analysis exists.',
            );
        }
    },

    /** Clear cached analysis */
    clearCache(): void {
        if (!canUsePlaintextWeatherCache() || typeof localStorage === 'undefined') return;
        try {
            // Analyses are keyed by a fingerprint of coordinates, course and
            // effective limits. Remove both current and legacy variants.
            const keys: string[] = [];
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (key === CACHE_KEY || key?.startsWith(`${CACHE_KEY}:`)) keys.push(key);
            }
            for (const key of keys) localStorage.removeItem(key);
        } catch {
            /* ignore */
        }
    },
};
