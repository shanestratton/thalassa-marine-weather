/**
 * Point Weather Service — fetches current weather for a single lat/lon tap on the map.
 *
 * Fires two lightweight parallel API calls:
 *   1. Open-Meteo Forecast — wind, pressure, temp, humidity, cloud cover
 *   2. The sea in parts (services/weather/seaPartitions, build 130): MFWAM's
 *      wind sea, swell and second swell, GFS Wave as a second opinion, behind
 *      a snap guard for THIS point
 *
 * Returns a unified PointWeatherData object for the popup display.
 */

import { fetchOpenMeteoProxy } from './openMeteoProxy';
import { fetchSeaPartitions, seaHourAt, seaModelsDiffer, type SeaPart, type SeaPartitions } from './seaPartitions';

/** The sea at the hour of the tap: MFWAM's numbers only, behind the guard. */
export interface PointSea {
    /** The total sea; its mean period. */
    total: SeaPart;
    windSea: SeaPart | null;
    swell: SeaPart | null;
    swell2: SeaPart | null;
    /** MFWAM and GFS Wave part by ×1.5 and 0.3 m: say so. Null when they agree, or GFS has no say. */
    differ: { mfwamM: number; gfsM: number } | null;
    /** Shown wherever these numbers are (a licence condition). */
    credit: string;
    /** How far MFWAM's answering cell is from the tap. */
    snappedKm: number | null;
}

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
     *
     * 'sheltered' (130-04): the wave model answered, but from a cell too far
     * away to be this water (a berth, a marina, an enclosed bay), or with
     * nulls. It reads SEA_NONE_LONG, never a number and never "over land".
     * 'land' stays for a source that can prove dry land; the wave reply
     * cannot (it answers inland taps from the nearest wet cell), so the sea
     * path never claims it.
     */
    marineStatus: 'available' | 'land' | 'sheltered' | 'unavailable' | 'pending';
    // Atmospheric — null when the model did not supply the field. Never 0:
    // "0 kts" and "0°C" are readings, and the popup shows '--' for null.
    windSpeedKmh: number | null;
    windDirectionDeg: number | null;
    windGustsKmh: number | null;
    pressureMsl: number | null;
    temperatureC: number | null;
    humidity: number | null;
    cloudCover: number | null;
    /** The sea in parts; null unless marineStatus is 'available'. */
    sea: PointSea | null;
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
    const marinePromise = fetchSeaPartitions(lat, lon);
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
    const sea = marine.value ? seaNow(marine.value, Date.now()) : null;

    const data: PointWeatherData = {
        ...shape(lat, lon, wx, sea),
        marineStatus: !marine.ok ? 'unavailable' : sea ? 'available' : 'sheltered',
    };

    pointCache.set(cacheKey(lat, lon), { at: Date.now(), data });
    if (pointCache.size > POINT_CACHE_MAX) {
        // Oldest insertion first — Map preserves insertion order.
        const oldest = pointCache.keys().next().value;
        if (oldest !== undefined) pointCache.delete(oldest);
    }
    return data;
}

/** The hour of the tap, or null where the guard refused the cell or MFWAM has no total for it. */
function seaNow(partitions: SeaPartitions, now: number): PointSea | null {
    const hour = seaHourAt(partitions, now);
    if (!hour?.total) return null;
    return {
        total: hour.total,
        windSea: hour.windSea,
        swell: hour.swell,
        swell2: hour.swell2,
        differ: seaModelsDiffer(hour),
        credit: partitions.credit,
        snappedKm: partitions.snappedKm,
    };
}

function shape(lat: number, lon: number, wx: AtmoData, sea: PointSea | null): PointWeatherData {
    return {
        lat,
        lon,
        fetchedAt: Date.now(),
        marineStatus: sea ? 'available' : 'sheltered',
        windSpeedKmh: wx.windSpeedKmh,
        windDirectionDeg: wx.windDirectionDeg,
        windGustsKmh: wx.windGustsKmh,
        pressureMsl: wx.pressureMsl,
        temperatureC: wx.temperatureC,
        humidity: wx.humidity,
        cloudCover: wx.cloudCover,
        sea,
    };
}

// ── Forecast (atmospheric) ──────────────────────────────────────

interface AtmoData {
    windSpeedKmh: number | null;
    windDirectionDeg: number | null;
    windGustsKmh: number | null;
    pressureMsl: number | null;
    temperatureC: number | null;
    humidity: number | null;
    cloudCover: number | null;
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
        windSpeedKmh: c.wind_speed_10m ?? null,
        windDirectionDeg: c.wind_direction_10m ?? null,
        windGustsKmh: c.wind_gusts_10m ?? null,
        pressureMsl: c.pressure_msl ?? null,
        temperatureC: c.temperature_2m ?? null,
        humidity: c.relative_humidity_2m ?? null,
        cloudCover: c.cloud_cover ?? null,
    };
}
