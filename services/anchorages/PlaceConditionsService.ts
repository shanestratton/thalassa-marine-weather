import { fetchOpenMeteoPoints } from '../weather/openMeteoProxy';
import {
    assessPlaceConditions,
    distanceNM,
    type ConditionsForecast,
    type ConditionsPlace,
    type PlaceConditions,
    type ReadonlyConditionsForecast,
} from './placeConditions';

const TTL = 5 * 60_000;
const cache = new Map<string, { forecast: ReadonlyConditionsForecast; forecastDays: number }>();
const pending = new Map<string, { task: Promise<void>; forecastDays: number }>();
export interface ConditionsForecastOptions {
    /** Planner requests use 5 NM; existing map callers retain the 20 NM grid tolerance. */
    maxProviderDistanceNM?: number;
}
export interface LoadPlaceConditionsOptions extends ConditionsForecastOptions {
    /** Whole forecast days, bounded to 1–7. Existing map callers default to 3. */
    forecastDays?: number;
}
const providerDistance = (options: ConditionsForecastOptions) =>
    Number.isFinite(options.maxProviderDistanceNM) ? Math.min(20, Math.max(0.1, options.maxProviderDistanceNM!)) : 20;
const cacheKey = (cellKey: string, maximumNM: number) => `${cellKey}|provider-distance:${maximumNM}`;
/** Coarse weather cells, never shared shelter. About 3 NM north/south. */
export function conditionsCell(p: { lat: number; lon: number }) {
    const lat = Math.round(p.lat * 20) / 20;
    const lon = Math.round(p.lon * 20) / 20;
    return { lat, lon, key: `${lat.toFixed(2)},${lon.toFixed(2)}` };
}
interface WeatherResponse {
    latitude?: number;
    longitude?: number;
    hourly?: Record<string, unknown>;
    hourly_units?: Record<string, string>;
}
const numbers = (r: WeatherResponse | undefined, key: string): unknown[] =>
    Array.isArray(r?.hourly?.[key]) ? (r.hourly[key] as unknown[]) : [];
const numeric = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined);

export function parseConditionsForecast(
    wind: WeatherResponse | undefined,
    sea: WeatherResponse | undefined,
    cell: { lat: number; lon: number },
    fetchedAt: number,
    maxProviderDistanceNM = 20,
): ConditionsForecast {
    const aligned = (r?: WeatherResponse) =>
        !!r &&
        typeof r.latitude === 'number' &&
        typeof r.longitude === 'number' &&
        Number.isFinite(distanceNM(cell, { lat: r.latitude, lon: r.longitude })) &&
        distanceNM(cell, { lat: r.latitude, lon: r.longitude }) <= maxProviderDistanceNM;
    // Provider grid coordinates can differ from the request. Reject an unrelated
    // or reordered response rather than assigning another region's weather.
    if (!aligned(wind)) wind = undefined;
    if (!aligned(sea)) sea = undefined;
    const time = numbers(wind, 'time');
    const seaIndex = new Map(numbers(sea, 'time').map((t, i) => [t, i]));
    const field = (r: WeatherResponse | undefined, key: string, index: number, unit: string) =>
        r?.hourly_units?.[key] === unit ? numeric(numbers(r, key)[index]) : undefined;
    return {
        ...cell,
        fetchedAt,
        ...(wind ? { windGrid: { lat: wind.latitude!, lon: wind.longitude! } } : {}),
        ...(sea ? { seaGrid: { lat: sea.latitude!, lon: sea.longitude! } } : {}),
        hours: time.flatMap((t, i) => {
            if (typeof t !== 'number' || !Number.isFinite(t)) return [];
            const si = seaIndex.get(t) ?? -1;
            return [
                {
                    t: t * 1000,
                    wind: field(wind, 'wind_speed_10m', i, 'kn'),
                    gust: field(wind, 'wind_gusts_10m', i, 'kn'),
                    direction: field(wind, 'wind_direction_10m', i, '°'),
                    weatherCode: field(wind, 'weather_code', i, 'wmo code'),
                    waveM: field(sea, 'wave_height', si, 'm'),
                    waveDirection: field(sea, 'wave_direction', si, '°'),
                    wavePeriod: field(sea, 'wave_period', si, 's'),
                },
            ];
        }),
    };
}

/** Read-only cached data; callers must assess freshness and hourly coverage.
 * Offline data is withheld just as it is for the map's current conditions. */
export function cachedConditionsForecast(
    p: { lat: number; lon: number },
    options: ConditionsForecastOptions = {},
): ReadonlyConditionsForecast | undefined {
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return undefined;
    const maximumNM = providerDistance(options);
    const forecast = cache.get(cacheKey(conditionsCell(p).key, maximumNM))?.forecast;
    // Strict callers check the actual requested point too, so weather-cell
    // rounding cannot hide a provider grid beyond their local-data tolerance.
    if (
        maximumNM < 20 &&
        forecast &&
        [forecast.windGrid, forecast.seaGrid].some(
            (grid) => grid && (!Number.isFinite(distanceNM(p, grid)) || distanceNM(p, grid) > maximumNM),
        )
    )
        return undefined;
    return forecast;
}

export function cachedPlaceConditions(p: ConditionsPlace, now = Date.now()): PlaceConditions {
    return assessPlaceConditions(p, cachedConditionsForecast(p), now);
}

/** At most 24 cells per viewport. Two batched weather calls, shared between
 * overlays and popups. Missing cells remain grey; no unbounded global query. */
export async function loadPlaceConditions(
    places: ConditionsPlace[],
    options: LoadPlaceConditionsOptions = {},
): Promise<void> {
    const forecastDays = Number.isFinite(options.forecastDays)
        ? Math.min(7, Math.max(1, Math.ceil(options.forecastDays!)))
        : 3;
    const maximumNM = providerDistance(options);
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const cells = [
        ...new Map(
            places.map((p) => {
                const c = conditionsCell(p);
                const key = cacheKey(c.key, maximumNM);
                return [key, { ...c, key }] as const;
            }),
        ).values(),
    ]
        .filter(
            (c) => Number.isFinite(c.lat) && Number.isFinite(c.lon) && Math.abs(c.lat) <= 85 && Math.abs(c.lon) <= 180,
        )
        .slice(0, 24);
    // A planner arriving during a map's shorter request must wait, then upgrade
    // that cell. A longer in-flight request already satisfies a shorter caller.
    let remaining = cells;
    while (remaining.length) {
        const now = Date.now();
        const fresh = remaining.filter((c) => {
            const entry = cache.get(c.key);
            return (
                !pending.has(c.key) &&
                (!entry || now - entry.forecast.fetchedAt >= TTL || entry.forecastDays < forecastDays)
            );
        });
        if (fresh.length) {
            const task = (async () => {
                const params = { forecast_days: forecastDays, timeformat: 'unixtime' };
                const [wind, sea] = await Promise.allSettled([
                    fetchOpenMeteoPoints<WeatherResponse>(
                        'forecast',
                        fresh,
                        {
                            ...params,
                            wind_speed_unit: 'kn',
                            hourly: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m,weather_code',
                        },
                        1,
                    ),
                    fetchOpenMeteoPoints<WeatherResponse>(
                        'marine',
                        fresh,
                        { ...params, hourly: 'wave_height,wave_direction,wave_period' },
                        1,
                    ),
                ]);
                const fetchedAt = Date.now();
                fresh.forEach((c, i) => {
                    // A failed refresh replaces the old favourable result with unknown.
                    const parsed = parseConditionsForecast(
                        wind.status === 'fulfilled' ? wind.value[i] : undefined,
                        sea.status === 'fulfilled' ? sea.value[i] : undefined,
                        c,
                        fetchedAt,
                        maximumNM,
                    );
                    const forecast = Object.freeze({
                        ...parsed,
                        ...(parsed.windGrid ? { windGrid: Object.freeze(parsed.windGrid) } : {}),
                        ...(parsed.seaGrid ? { seaGrid: Object.freeze(parsed.seaGrid) } : {}),
                        hours: Object.freeze(parsed.hours.map((hour) => Object.freeze(hour))),
                    });
                    cache.delete(c.key);
                    cache.set(c.key, { forecast, forecastDays });
                });
                while (cache.size > 96) cache.delete(cache.keys().next().value!);
            })().finally(() => fresh.forEach((c) => pending.delete(c.key)));
            fresh.forEach((c) => pending.set(c.key, { task, forecastDays }));
        }
        const upgrades = remaining.filter((c) => (pending.get(c.key)?.forecastDays ?? forecastDays) < forecastDays);
        await Promise.all(remaining.map((c) => pending.get(c.key)?.task));
        remaining = upgrades;
    }
}
