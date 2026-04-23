/**
 * unified — Client-side consumer for the get-weather Supabase Edge Function.
 *
 * Maps the standardized `StandardWeatherResponse` from the unified endpoint
 * into the app's `MarineWeatherReport` type. Used as the primary atmospheric
 * data source, replacing direct WeatherKit + OpenMeteo calls.
 *
 * Marine data (waves, swell, water temp, currents) still comes from StormGlass
 * via the orchestrator — the unified endpoint only covers atmospheric + nowcast.
 *
 * Pi Cache integration: checks Pi first for instant offline loads.
 *
 * Native iOS fast path: on Capacitor iOS, we skip the Supabase hop
 * entirely and call Apple's WeatherKit framework directly via our
 * native plugin (ios/App/App/WeatherKitPlugin.swift). The raw WeatherKit
 * response is shaped by the client-side converter below into the same
 * StandardWeatherResponse the edge function would have returned, so the
 * rest of the pipeline (mapping to MarineWeatherReport) is unchanged.
 * Shaves ~500ms-1s off cold start. Falls through to the Supabase path
 * gracefully if the native call fails.
 */

import { Capacitor } from '@capacitor/core';
import { createLogger } from '../../../utils/createLogger';
import { piCache } from '../../PiCacheService';
import { resolveTimeZone, formatTimeInZone } from '../../../utils/timezone';
import type { MarineWeatherReport, SourcedWeatherMetrics, HourlyForecast, ForecastDay } from '../../../types/weather';

const log = createLogger('UnifiedWeather');

// ── Supabase helpers ─────────────────────────────────────────

function getSupabaseUrl(): string {
    if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) {
        return import.meta.env.VITE_SUPABASE_URL;
    }
    return '';
}

function getSupabaseKey(): string {
    if (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) {
        return import.meta.env.VITE_SUPABASE_KEY;
    }
    return '';
}

// ── Types matching the edge function's StandardWeatherResponse ──

interface StandardCurrent {
    temperature: number | null;
    feelsLike: number | null;
    humidity: number | null;
    pressure: number | null;
    windSpeed: number | null;
    windDirection: number | null;
    windGust: number | null;
    condition: string;
    cloudCover: number | null;
    visibility: number | null;
    uvIndex: number | null;
    precipitation: number | null;
    dewPoint: number | null;
    isDay: boolean | null;
}

interface StandardNowcast {
    minutes: { time: string; intensity: number }[];
    summary: string;
}

interface StandardHourly {
    time: string;
    temperature: number;
    windSpeed: number;
    windDirection: number;
    windGust: number | null;
    precipitation: number;
    precipProbability: number;
    condition: string;
    pressure: number | null;
    cloudCover: number | null;
    humidity: number | null;
}

interface StandardDaily {
    date: string;
    tempMax: number;
    tempMin: number;
    windSpeedMax: number;
    windGustMax: number | null;
    condition: string;
    precipSum: number;
    precipProbability: number | null;
    sunrise: string;
    sunset: string;
    uvIndexMax: number | null;
}

interface StandardWeatherResponse {
    provider: 'rainbow+openmeteo' | 'weatherkit';
    timestamp: string;
    coordinates: { lat: number; lon: number };
    timezone: string;
    isPremium: boolean;
    current: StandardCurrent;
    nowcast?: StandardNowcast;
    hourly: StandardHourly[];
    daily: StandardDaily[];
}

// ── Cache ────────────────────────────────────────────────────

const CACHE_TTL = 5 * 60 * 1000; // 5 min
let cached: { data: StandardWeatherResponse; fetchedAt: number; key: string } | null = null;

// ── Wind direction helpers ───────────────────────────────────

const COMPASS = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];

function degreesToCompass(deg: number | null): string {
    if (deg == null) return 'N/A';
    return COMPASS[Math.round(deg / 22.5) % 16];
}

// ── Day name helper ──────────────────────────────────────────

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function dayName(dateStr: string): string {
    const d = new Date(dateStr + 'T12:00:00');
    return DAYS[d.getDay()] || dateStr;
}

// ── Native WeatherKit → StandardWeatherResponse converter ────
//
// The native plugin returns the RAW Apple WeatherKit REST-shaped JSON
// (currentWeather / forecastHourly.hours[] / forecastDaily.days[] /
// forecastNextHour.minutes[]). We need to reshape it to match what the
// Supabase edge function would return so the rest of the pipeline
// doesn't care which path ran.

interface RawWKCurrent {
    asOf?: string;
    temperature?: number;
    temperatureApparent?: number;
    dewPoint?: number;
    humidity?: number;
    pressure?: number;
    visibility?: number;
    uvIndex?: number;
    cloudCover?: number;
    conditionCode?: string;
    windSpeed?: number;
    windGust?: number | null;
    windDirection?: number;
}

interface RawWKHour {
    forecastStart?: string;
    temperature?: number;
    humidity?: number;
    pressure?: number;
    conditionCode?: string;
    cloudCover?: number;
    precipitationChance?: number;
    precipitationAmount?: number;
    windSpeed?: number;
    windGust?: number | null;
    windDirection?: number;
}

interface RawWKDay {
    forecastStart?: string;
    conditionCode?: string;
    temperatureMax?: number;
    temperatureMin?: number;
    precipitationChance?: number;
    precipitationAmount?: number;
    sunrise?: string | null;
    sunset?: string | null;
    uvIndexMax?: number;
    windSpeedMax?: number;
}

interface RawWKMinute {
    startTime?: string;
    precipitationChance?: number;
    precipitationIntensity?: number;
}

interface RawWKResponse {
    currentWeather?: RawWKCurrent;
    forecastHourly?: { hours?: RawWKHour[] };
    forecastDaily?: { days?: RawWKDay[] };
    forecastNextHour?: { minutes?: RawWKMinute[] };
}

function nativeWeatherKitToStandard(raw: unknown, lat: number, lon: number): StandardWeatherResponse | null {
    const r = raw as RawWKResponse;
    if (!r.currentWeather) return null;

    const c = r.currentWeather;
    const current: StandardCurrent = {
        temperature: c.temperature ?? null,
        feelsLike: c.temperatureApparent ?? null,
        humidity: typeof c.humidity === 'number' ? Math.round(c.humidity * 100) : null,
        pressure: c.pressure ?? null,
        windSpeed: typeof c.windSpeed === 'number' ? c.windSpeed / 1.852 : null, // km/h → kts
        windDirection: c.windDirection ?? null,
        windGust: typeof c.windGust === 'number' ? c.windGust / 1.852 : null,
        condition: c.conditionCode || 'Unknown',
        cloudCover: typeof c.cloudCover === 'number' ? Math.round(c.cloudCover * 100) : null,
        visibility: typeof c.visibility === 'number' ? c.visibility / 1852 : null, // m → nm
        uvIndex: c.uvIndex ?? null,
        precipitation: null, // only surfaced on hourly/daily in native payload
        dewPoint: c.dewPoint ?? null,
        isDay: null, // native doesn't flag this; renderer derives from condition+sunrise
    };

    const hourly: StandardHourly[] = (r.forecastHourly?.hours || []).map((h) => ({
        time: h.forecastStart || '',
        temperature: h.temperature ?? 0,
        windSpeed: typeof h.windSpeed === 'number' ? h.windSpeed / 1.852 : 0,
        windDirection: h.windDirection ?? 0,
        windGust: typeof h.windGust === 'number' ? h.windGust / 1.852 : null,
        precipitation: h.precipitationAmount ?? 0,
        precipProbability: typeof h.precipitationChance === 'number' ? h.precipitationChance * 100 : 0,
        condition: h.conditionCode || 'Unknown',
        pressure: h.pressure ?? null,
        cloudCover: typeof h.cloudCover === 'number' ? h.cloudCover * 100 : null,
        humidity: typeof h.humidity === 'number' ? h.humidity * 100 : null,
    }));

    const daily: StandardDaily[] = (r.forecastDaily?.days || []).map((d) => ({
        date: (d.forecastStart || '').split('T')[0],
        tempMax: d.temperatureMax ?? 0,
        tempMin: d.temperatureMin ?? 0,
        windSpeedMax: typeof d.windSpeedMax === 'number' ? d.windSpeedMax / 1.852 : 0,
        windGustMax: null,
        condition: d.conditionCode || 'Unknown',
        precipSum: d.precipitationAmount ?? 0,
        precipProbability: typeof d.precipitationChance === 'number' ? d.precipitationChance * 100 : null,
        sunrise: d.sunrise || '',
        sunset: d.sunset || '',
        uvIndexMax: d.uvIndexMax ?? null,
    }));

    const minutes = r.forecastNextHour?.minutes || [];
    const nowcast: StandardNowcast | undefined =
        minutes.length > 0
            ? {
                  minutes: minutes.map((m) => ({
                      time: m.startTime || '',
                      intensity: m.precipitationIntensity ?? 0,
                  })),
                  summary: '', // Apple doesn't expose a unified summary string
              }
            : undefined;

    return {
        provider: 'weatherkit',
        timestamp: c.asOf || new Date().toISOString(),
        coordinates: { lat, lon },
        timezone: resolveTimeZone(lat, lon),
        isPremium: true, // WeatherKit native is free-tier-accessible via App Store entitlement
        current,
        nowcast,
        hourly,
        daily,
    };
}

// ── Fetch ────────────────────────────────────────────────────

/**
 * Fetch the unified weather response from the get-weather edge function.
 * Tries Pi Cache first for offline/instant loads, then falls back to direct.
 *
 * @returns The raw StandardWeatherResponse, or null on failure.
 */
export async function fetchUnifiedWeatherRaw(
    lat: number,
    lon: number,
    userId?: string,
): Promise<StandardWeatherResponse | null> {
    const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)},${userId || ''}`;
    if (cached && cached.key === cacheKey && Date.now() - cached.fetchedAt < CACHE_TTL) {
        // Diagnostic trace: in-memory cache hit (won't show for first call after cold boot).
        console.warn('[unified] cache hit', cacheKey);
        return cached.data;
    }

    // DIAGNOSTIC: unconditional entry marker so we can verify this path runs in
    // the Xcode console. console.warn bypasses the createLogger prod filter.
    console.warn('[unified] fetchUnifiedWeatherRaw entered', {
        lat: lat.toFixed(4),
        lon: lon.toFixed(4),
        isNative: Capacitor.isNativePlatform(),
    });

    // ── NATIVE FAST PATH (iOS only) ──
    // Skip Supabase entirely and call Apple's WeatherKit framework
    // directly via our native plugin. Saves the 500ms-1s edge-function
    // cold-start + JWT-signing + network round-trip. Graceful fallback
    // to the Supabase path below if the native call fails (capability
    // not yet granted, network error, etc.).
    if (Capacitor.isNativePlatform()) {
        try {
            console.warn('[unified] trying native WeatherKit');
            const { fetchWeatherKitNative } = await import('../../native/weatherKit');
            const nativeRaw = await fetchWeatherKitNative(lat, lon);
            if (nativeRaw && typeof nativeRaw === 'object') {
                const converted = nativeWeatherKitToStandard(nativeRaw, lat, lon);
                if (converted) {
                    cached = { data: converted, fetchedAt: Date.now(), key: cacheKey };
                    console.warn('[unified] ✅ native WeatherKit WIN — saved Supabase hop');
                    return converted;
                }
                console.warn('[unified] native payload present but converter returned null');
            } else {
                console.warn('[unified] native returned null — falling through to Supabase');
            }
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.warn('[unified] native WeatherKit threw — falling through to Supabase:', msg);
        }
    }
    console.warn('[unified] taking Supabase path');

    const supabaseUrl = getSupabaseUrl();
    if (!supabaseUrl) {
        log.warn('No Supabase URL configured');
        return null;
    }

    const params = new URLSearchParams({
        lat: lat.toFixed(4),
        lon: lon.toFixed(4),
    });
    if (userId) params.set('user_id', userId);

    const directUrl = `${supabaseUrl}/functions/v1/get-weather?${params}`;

    // Try Pi Cache first, via the DEDICATED /api/weather/unified endpoint.
    //
    // The previous code used piCache.passthroughUrl() which goes to the Pi's
    // generic /api/passthrough with cache key `passthrough:${url}`. But the
    // scheduler pre-fetches under key `weather:unified:${lat}:${lon}:${uid}:0`
    // — so those keys NEVER matched. Every client boot missed the Pi's
    // pre-fetched cache and forced a fresh upstream fetch, explaining the
    // "goes off for a while to fetch fresh" experience the user reported.
    //
    // The dedicated endpoint uses the scheduler's exact key and rounds lat/
    // lon to 2 decimals server-side, so the Pi scheduler's pre-fetched data
    // is a HIT on nearly every boot.
    if (piCache.isAvailable()) {
        try {
            const piUrl = piCache.unifiedWeatherUrl(lat, lon, userId, false);
            if (piUrl) {
                const piRes = await fetch(piUrl, { signal: AbortSignal.timeout(5000) });
                if (piRes.ok) {
                    const data = await piRes.json();
                    if (data && !data.error) {
                        const xCache = piRes.headers.get('X-Cache');
                        cached = { data, fetchedAt: Date.now(), key: cacheKey };
                        log.info(`Unified weather served from Pi Cache (${data.provider}, X-Cache: ${xCache})`);
                        return data;
                    }
                }
            }
        } catch {
            // Pi failed — fall through to direct
        }
    }

    // Direct fetch
    try {
        const key = getSupabaseKey();
        const res = await fetch(directUrl, {
            headers: key ? { Authorization: `Bearer ${key}`, apikey: key } : {},
            signal: AbortSignal.timeout(20000),
        });

        if (!res.ok) {
            log.warn(`Unified weather HTTP ${res.status}`);
            return null;
        }

        // Edge function may return an { error: string } envelope instead of
        // the full StandardWeatherResponse on failure — parse defensively.
        const raw = (await res.json()) as StandardWeatherResponse | { error: string };
        if ('error' in raw && typeof raw.error === 'string') {
            log.warn('Unified weather returned error:', raw.error);
            return null;
        }
        const data = raw as StandardWeatherResponse;

        cached = { data, fetchedAt: Date.now(), key: cacheKey };
        log.info(`Unified weather: ${data.provider}, premium=${data.isPremium}`);
        return data;
    } catch (err) {
        log.error('Unified weather fetch failed:', err);
        return null;
    }
}

// ── Map to MarineWeatherReport ───────────────────────────────

/**
 * Fetch unified weather and map to MarineWeatherReport.
 *
 * This provides the atmospheric base report. The orchestrator should still
 * blend in StormGlass (marine) and WorldTides (tides) data on top.
 */
export async function fetchUnifiedWeather(
    lat: number,
    lon: number,
    name: string,
    userId?: string,
): Promise<MarineWeatherReport | null> {
    const raw = await fetchUnifiedWeatherRaw(lat, lon, userId);
    if (!raw) return null;
    return mapToMarineReport(raw, lat, lon, name);
}

/**
 * Map StandardWeatherResponse → MarineWeatherReport.
 * Fills atmospheric fields; marine fields (wave, swell, water temp) are left
 * null for the orchestrator to populate from StormGlass.
 */
function mapToMarineReport(resp: StandardWeatherResponse, lat: number, lon: number, name: string): MarineWeatherReport {
    const c = resp.current;

    // Resolve the target location's IANA timezone. OpenMeteo returns a real tz;
    // WeatherKit returns 'UTC' as a sentinel. Either way, tz-lookup fills the gap
    // so sunrise/sunset render in LOCAL-TO-LOCATION time, not device time.
    const timeZone = resolveTimeZone(lat, lon, resp.timezone);

    // Daily sunrise/sunset arrive as ISO strings from the edge function.
    // Format today's into HH:MM in the target tz for the "current" block.
    const todaySunrise = resp.daily[0]?.sunrise ? formatTimeInZone(resp.daily[0].sunrise, timeZone) : undefined;
    const todaySunset = resp.daily[0]?.sunset ? formatTimeInZone(resp.daily[0].sunset, timeZone) : undefined;

    const current: SourcedWeatherMetrics = {
        windSpeed: c.windSpeed,
        windGust: c.windGust,
        windDirection: degreesToCompass(c.windDirection),
        windDegree: c.windDirection ?? undefined,
        waveHeight: null, // Filled by StormGlass
        swellPeriod: null, // Filled by StormGlass
        airTemperature: c.temperature,
        waterTemperature: undefined, // Filled by StormGlass
        description: c.condition,
        condition: c.condition,
        cloudCover: c.cloudCover,
        precipitation: c.precipitation,
        visibility: c.visibility,
        humidity: c.humidity,
        uvIndex: c.uvIndex ?? 0,
        pressure: c.pressure,
        feelsLike: c.feelsLike,
        isDay: c.isDay ?? undefined,
        dewPoint: c.dewPoint,
        sunrise: todaySunrise,
        sunset: todaySunset,
    };

    // Hourly forecast
    const hourly: HourlyForecast[] = resp.hourly.map((h) => ({
        time: h.time,
        windSpeed: h.windSpeed,
        windGust: h.windGust,
        windDirection: degreesToCompass(h.windDirection),
        windDegree: h.windDirection,
        waveHeight: 0, // Filled by StormGlass
        temperature: h.temperature,
        condition: h.condition,
        precipitation: h.precipitation,
        precipChance: h.precipProbability,
        pressure: h.pressure ?? undefined,
        cloudCover: h.cloudCover,
        humidity: h.humidity,
    }));

    // Daily forecast — format sunrise/sunset as HH:MM in the target tz so the UI
    // doesn't have to re-parse provider-specific ISO string formats.
    const forecast: ForecastDay[] = resp.daily.map((d) => ({
        day: dayName(d.date),
        date: d.date,
        isoDate: d.date,
        highTemp: d.tempMax,
        lowTemp: d.tempMin,
        windSpeed: d.windSpeedMax,
        windGust: d.windGustMax ?? undefined,
        waveHeight: 0, // Filled by StormGlass
        condition: d.condition,
        precipitation: d.precipSum,
        precipChance: d.precipProbability ?? undefined,
        sunrise: d.sunrise ? formatTimeInZone(d.sunrise, timeZone) : d.sunrise,
        sunset: d.sunset ? formatTimeInZone(d.sunset, timeZone) : d.sunset,
        uvIndex: d.uvIndexMax ?? undefined,
    }));

    const modelTag = resp.provider === 'weatherkit' ? 'unified-wk' : 'unified-rb+om';

    return {
        locationName: name,
        coordinates: { lat, lon },
        current,
        forecast,
        hourly,
        tides: [], // Filled by WorldTides in the orchestrator
        boatingAdvice: '', // Generated downstream
        generatedAt: resp.timestamp,
        modelUsed: modelTag,
        timeZone, // Resolved via provider-hint → tz-lookup fallback (never 'UTC' sentinel)
    };
}

/**
 * Extract nowcast data from the unified response (if premium/available).
 * Returns the raw minutes array compatible with RainForecastCard.
 */
export function extractNowcast(
    resp: StandardWeatherResponse | null,
): { minutes: { time: string; intensity: number }[]; summary: string } | null {
    if (!resp?.nowcast?.minutes?.length) return null;
    return resp.nowcast;
}
