import { CapacitorHttp } from '@capacitor/core';
import { getTomorrowIoKey } from '../keys';

// --- Types ---
export interface MinutelyRain {
    time: string;       // ISO timestamp
    intensity: number;  // mm/hr
}

/** Realtime observation from Tomorrow.io v4 */
export interface TomorrowIoObservation {
    temperature: number | null;         // °C
    temperatureApparent: number | null; // Feels-like °C
    humidity: number | null;            // %
    windSpeed: number | null;           // m/s
    windDirection: number | null;       // degrees
    windGust: number | null;            // m/s
    pressure: number | null;            // hPa
    visibility: number | null;          // km
    cloudCover: number | null;          // %
    dewPoint: number | null;            // °C
    uvIndex: number | null;
    precipitationIntensity: number | null; // mm/hr
    weatherCode: number | null;
    condition: string;                  // Human-readable condition string
    observationTime: string;            // ISO timestamp
}

// --- Weather Code → Condition mapping ---
const WEATHER_CODE_MAP: Record<number, string> = {
    0: 'Unknown',
    1000: 'Clear',
    1100: 'Mostly Clear',
    1101: 'Partly Cloudy',
    1102: 'Mostly Cloudy',
    1001: 'Cloudy',
    2000: 'Fog',
    2100: 'Light Fog',
    4000: 'Drizzle',
    4001: 'Rain',
    4200: 'Light Rain',
    4201: 'Heavy Rain',
    5000: 'Snow',
    5001: 'Flurries',
    5100: 'Light Snow',
    5101: 'Heavy Snow',
    6000: 'Freezing Drizzle',
    6001: 'Freezing Rain',
    6200: 'Light Freezing Rain',
    6201: 'Heavy Freezing Rain',
    7000: 'Ice Pellets',
    7101: 'Heavy Ice Pellets',
    7102: 'Light Ice Pellets',
    8000: 'Thunderstorm',
};

// --- Caches ---
let cachedRain: { data: MinutelyRain[], fetchedAt: number, key: string } | null = null;
let cachedRealtime: { data: TomorrowIoObservation, fetchedAt: number, key: string } | null = null;

const RAIN_CACHE_TTL = 10 * 60 * 1000;     // 10 minutes
const REALTIME_CACHE_TTL = 5 * 60 * 1000;  // 5 minutes

// --- HTTP helper (CapacitorHttp → fetch fallback) ---
async function httpGet(url: string): Promise<any> {
    try {
        const res = await CapacitorHttp.get({ url });
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        return res.data;
    } catch {
        // Fallback to fetch API (browser dev)
        const res = await fetch(url);
        if (!res.ok) throw new Error(`Fetch HTTP ${res.status}`);
        return res.json();
    }
}

// ============================================================
// REALTIME OBSERVATIONS (Live temp, wind, humidity, conditions)
// ============================================================

/**
 * Fetch realtime weather observations from Tomorrow.io
 * Station-blended observation data — closest to "actual observed" you can get globally.
 * Used for inland/coastal LIVE data display.
 */
export const fetchTomorrowIoRealtime = async (
    lat: number,
    lon: number
): Promise<TomorrowIoObservation | null> => {
    const apiKey = getTomorrowIoKey();
    if (!apiKey) {
        console.warn('[TomorrowIO] No API key configured — skipping realtime');
        return null;
    }

    // Check cache
    const cacheKey = `${lat.toFixed(3)},${lon.toFixed(3)}`;
    if (cachedRealtime && cachedRealtime.key === cacheKey && (Date.now() - cachedRealtime.fetchedAt) < REALTIME_CACHE_TTL) {
        return cachedRealtime.data;
    }

    const fields = [
        'temperature', 'temperatureApparent', 'humidity',
        'windSpeed', 'windDirection', 'windGust',
        'pressureSurfaceLevel', 'visibility', 'cloudCover',
        'dewPoint', 'uvIndex', 'precipitationIntensity', 'weatherCode'
    ].join(',');

    const url = `https://api.tomorrow.io/v4/weather/realtime?location=${lat},${lon}&fields=${fields}&apikey=${apiKey}`;

    try {
        const json = await httpGet(url);

        const vals = json?.data?.values;
        if (!vals) {
            console.warn('[TomorrowIO] No values in realtime response');
            return null;
        }

        const weatherCode = vals.weatherCode ?? null;
        const condition = weatherCode !== null
            ? (WEATHER_CODE_MAP[weatherCode] || 'Unknown')
            : 'Unknown';

        const obs: TomorrowIoObservation = {
            temperature: vals.temperature ?? null,
            temperatureApparent: vals.temperatureApparent ?? null,
            humidity: vals.humidity ?? null,
            windSpeed: vals.windSpeed ?? null,
            windDirection: vals.windDirection ?? null,
            windGust: vals.windGust ?? null,
            pressure: vals.pressureSurfaceLevel ?? null,
            visibility: vals.visibility ?? null,
            cloudCover: vals.cloudCover ?? null,
            dewPoint: vals.dewPoint ?? null,
            uvIndex: vals.uvIndex ?? null,
            precipitationIntensity: vals.precipitationIntensity ?? null,
            weatherCode,
            condition,
            observationTime: json?.data?.time || new Date().toISOString(),
        };

        // Cache
        cachedRealtime = { data: obs, fetchedAt: Date.now(), key: cacheKey };
        return obs;

    } catch (e) {
        console.warn('[TomorrowIO] Realtime fetch failed', e);
        return null;
    }
};

// ============================================================
// MINUTELY RAIN FORECAST
// ============================================================

/**
 * Fetch minutely precipitation forecast from Tomorrow.io
 * Returns 60 data points (1 per minute) for the next hour.
 */
export const fetchMinutelyRain = async (
    lat: number,
    lon: number
): Promise<MinutelyRain[]> => {
    const apiKey = getTomorrowIoKey();
    if (!apiKey) {
        console.warn('[TomorrowIO] No API key configured');
        return [];
    }

    // Check cache
    const cacheKey = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    if (cachedRain && cachedRain.key === cacheKey && (Date.now() - cachedRain.fetchedAt) < RAIN_CACHE_TTL) {
        return cachedRain.data;
    }

    const url = `https://api.tomorrow.io/v4/weather/forecast?location=${lat},${lon}&timesteps=1m&apikey=${apiKey}`;

    try {
        const json = await httpGet(url);

        const minutely = json?.timelines?.minutely;
        if (!minutely || !Array.isArray(minutely)) {
            console.warn('[TomorrowIO] No minutely data in response');
            return [];
        }

        // Extract rain intensity — take first 60 entries
        const result: MinutelyRain[] = minutely.slice(0, 60).map((entry: any) => ({
            time: entry.time,
            intensity: entry.values?.rainIntensity ?? entry.values?.precipitationIntensity ?? 0
        }));

        // Cache
        cachedRain = { data: result, fetchedAt: Date.now(), key: cacheKey };
        return result;

    } catch (e) {
        console.warn('[TomorrowIO] Minutely rain fetch failed', e);
        return [];
    }
};
