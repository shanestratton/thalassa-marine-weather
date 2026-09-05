/**
 * Point Weather Service — fetches current weather for a single lat/lon tap on the map.
 *
 * Fires two lightweight parallel API calls:
 *   1. Open-Meteo Forecast — wind, pressure, temp, humidity, cloud cover
 *   2. Open-Meteo Marine — wave height, period, direction, swell
 *
 * Returns a unified PointWeatherData object for the popup display.
 */

import { fetchOpenMeteoProxy } from './openMeteoProxy';

export interface PointWeatherData {
    lat: number;
    lon: number;
    /** Device time when both point requests settled. Used to make age explicit. */
    fetchedAt: number;
    /**
     * Distinguishes dry land from a failed marine source — and now from one
     * that simply has not landed yet. 'pending' exists because the popup
     * paints as soon as the ATMOSPHERIC half arrives; without it the marine
     * block would have to claim 'unavailable' during the second or two before
     * its own request settles, which is a lie the punter can see.
     */
    marineStatus: 'available' | 'land' | 'unavailable' | 'pending';
    // Atmospheric
    windSpeedKmh: number;
    windDirectionDeg: number;
    windGustsKmh: number;
    pressureMsl: number;
    temperatureC: number;
    humidity: number;
    cloudCover: number;
    // Marine (optional — null if on land)
    waveHeightM: number | null;
    wavePeriodS: number | null;
    waveDirectionDeg: number | null;
    swellHeightM: number | null;
    swellPeriodS: number | null;
    swellDirectionDeg: number | null;
}

/**
 * Cache and in-flight map, keyed by a rounded coordinate.
 *
 * TAPPING THE SAME PATCH OF WATER TWICE USED TO COST TWO ROUND TRIPS. There
 * was no cache and no dedupe here at all, so every inspect tap paid full
 * network latency — including a double tap, a tap-close-tap, and comparing two
 * spots by going back and forth between them (Shane 2026-09-05: "i would like
 * it to be quicker").
 *
 * 0.01° is about 1.1 km, which is finer than the model grid the answer comes
 * off — two taps inside one cell are asking the same question. Ten minutes is
 * short enough that "current conditions" stays current and long enough to
 * cover the back-and-forth a punter actually does while reading a chart.
 */
const POINT_CACHE_TTL_MS = 10 * 60 * 1000;
const pointCache = new Map<string, { at: number; data: PointWeatherData }>();
const inflight = new Map<string, Promise<PointWeatherData | null>>();
/** Bounded so a long session panning a coast cannot grow this without limit. */
const POINT_CACHE_MAX = 120;

const cacheKey = (lat: number, lon: number): string => `${lat.toFixed(2)},${lon.toFixed(2)}`;

/** Drop the whole point cache — for tests, and for a hard refresh. */
export function clearPointWeatherCache(): void {
    pointCache.clear();
    inflight.clear();
}

/**
 * Fetch current weather conditions at a single point.
 *
 * @param onPartial — called with the ATMOSPHERIC half the moment it lands,
 *   marineStatus 'pending'. The popup paints from it immediately instead of
 *   holding a complete answer behind the slower of two requests; the marine
 *   block fills in underneath when it arrives. Not called on a cache hit,
 *   where there is nothing to wait for.
 */
export async function fetchPointWeather(
    lat: number,
    lon: number,
    onPartial?: (partial: PointWeatherData) => void,
): Promise<PointWeatherData | null> {
    const key = cacheKey(lat, lon);
    const hit = pointCache.get(key);
    if (hit && Date.now() - hit.at < POINT_CACHE_TTL_MS) return hit.data;

    // A second tap while the first is in the air JOINS it rather than opening
    // another socket. Two taps on one spot is the commonest way to get here.
    const existing = inflight.get(key);
    if (existing) return existing;

    const task = (async (): Promise<PointWeatherData | null> => {
        try {
            return await loadPointWeather(lat, lon, onPartial);
        } finally {
            inflight.delete(key);
        }
    })();
    inflight.set(key, task);
    return task;
}

async function loadPointWeather(
    lat: number,
    lon: number,
    onPartial?: (partial: PointWeatherData) => void,
): Promise<PointWeatherData | null> {
    const latStr = lat.toFixed(4);
    const lonStr = lon.toFixed(4);

    // Both fire together; the atmospheric one is simply allowed to report
    // first rather than being held behind the marine one.
    const forecastPromise = fetchForecastPoint(latStr, lonStr);
    const marinePromise = fetchMarinePoint(latStr, lonStr);
    // Nothing awaits the marine promise until below; without this an early
    // rejection would surface as an unhandled one.
    const marineSettled = marinePromise.then(
        (value) => ({ ok: true as const, value }),
        () => ({ ok: false as const, value: null }),
    );

    let wx: AtmoData | null = null;
    try {
        wx = await forecastPromise;
    } catch {
        wx = null;
    }
    if (!wx) return null; // Must have at least atmospheric data

    if (onPartial) {
        onPartial({
            ...shape(lat, lon, wx, null),
            marineStatus: 'pending',
        });
    }

    const marine = await marineSettled;
    const sea = marine.value;

    const data: PointWeatherData = {
        ...shape(lat, lon, wx, sea),
        marineStatus: !marine.ok ? 'unavailable' : sea ? 'available' : 'land',
    };

    pointCache.set(cacheKey(lat, lon), { at: Date.now(), data });
    if (pointCache.size > POINT_CACHE_MAX) {
        // Oldest insertion first — Map preserves insertion order.
        const oldest = pointCache.keys().next().value;
        if (oldest !== undefined) pointCache.delete(oldest);
    }
    return data;
}

function shape(lat: number, lon: number, wx: AtmoData, sea: MarineData | null): PointWeatherData {
    return {
        lat,
        lon,
        fetchedAt: Date.now(),
        marineStatus: sea ? 'available' : 'land',
        windSpeedKmh: wx.windSpeedKmh,
        windDirectionDeg: wx.windDirectionDeg,
        windGustsKmh: wx.windGustsKmh,
        pressureMsl: wx.pressureMsl,
        temperatureC: wx.temperatureC,
        humidity: wx.humidity,
        cloudCover: wx.cloudCover,
        waveHeightM: sea?.waveHeightM ?? null,
        wavePeriodS: sea?.wavePeriodS ?? null,
        waveDirectionDeg: sea?.waveDirectionDeg ?? null,
        swellHeightM: sea?.swellHeightM ?? null,
        swellPeriodS: sea?.swellPeriodS ?? null,
        swellDirectionDeg: sea?.swellDirectionDeg ?? null,
    };
}

// ── Forecast (atmospheric) ──────────────────────────────────────

interface AtmoData {
    windSpeedKmh: number;
    windDirectionDeg: number;
    windGustsKmh: number;
    pressureMsl: number;
    temperatureC: number;
    humidity: number;
    cloudCover: number;
}

async function fetchForecastPoint(lat: string, lon: string): Promise<AtmoData | null> {
    const data = await fetchOpenMeteoProxy<{
        current?: Record<string, number | null>;
    }>('forecast', {
        latitude: lat,
        longitude: lon,
        current:
            'temperature_2m,relative_humidity_2m,wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl,cloud_cover',
    });
    const c = data?.current;
    if (!c) return null;

    return {
        windSpeedKmh: c.wind_speed_10m ?? 0,
        windDirectionDeg: c.wind_direction_10m ?? 0,
        windGustsKmh: c.wind_gusts_10m ?? 0,
        pressureMsl: c.pressure_msl ?? 1013.25,
        temperatureC: c.temperature_2m ?? 0,
        humidity: c.relative_humidity_2m ?? 0,
        cloudCover: c.cloud_cover ?? 0,
    };
}

// ── Marine (waves/swell) ────────────────────────────────────────

interface MarineData {
    waveHeightM: number;
    wavePeriodS: number;
    waveDirectionDeg: number;
    swellHeightM: number;
    swellPeriodS: number;
    swellDirectionDeg: number;
}

async function fetchMarinePoint(lat: string, lon: string): Promise<MarineData | null> {
    const data = await fetchOpenMeteoProxy<{
        current?: Record<string, number | null>;
    }>('marine', {
        latitude: lat,
        longitude: lon,
        current: 'wave_height,wave_period,wave_direction,swell_wave_height,swell_wave_period,swell_wave_direction',
    });
    const c = data?.current;
    if (!c) return null;

    // Marine API returns null for land locations
    if (c.wave_height == null && c.swell_wave_height == null) return null;

    return {
        waveHeightM: c.wave_height ?? 0,
        wavePeriodS: c.wave_period ?? 0,
        waveDirectionDeg: c.wave_direction ?? 0,
        swellHeightM: c.swell_wave_height ?? 0,
        swellPeriodS: c.swell_wave_period ?? 0,
        swellDirectionDeg: c.swell_wave_direction ?? 0,
    };
}
