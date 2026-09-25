import { fetchOpenMeteoPoints } from '../weather/openMeteoProxy';
import {
    assessPlaceConditions,
    distanceNM,
    type ConditionsForecast,
    type ConditionsPlace,
    type PlaceConditions,
} from './placeConditions';

const TTL = 5 * 60_000;
const cache = new Map<string, ConditionsForecast>();
const pending = new Map<string, Promise<void>>();
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
): ConditionsForecast {
    const aligned = (r?: WeatherResponse) =>
        !!r &&
        typeof r.latitude === 'number' &&
        typeof r.longitude === 'number' &&
        Number.isFinite(distanceNM(cell, { lat: r.latitude, lon: r.longitude })) &&
        distanceNM(cell, { lat: r.latitude, lon: r.longitude }) <= 20;
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

export function cachedPlaceConditions(p: ConditionsPlace, now = Date.now()): PlaceConditions {
    const forecast =
        typeof navigator !== 'undefined' && navigator.onLine === false ? undefined : cache.get(conditionsCell(p).key);
    return assessPlaceConditions(p, forecast, now);
}

/** At most 24 cells per viewport. Two batched weather calls, shared between
 * overlays and popups. Missing cells remain grey; no unbounded global query. */
export async function loadPlaceConditions(places: ConditionsPlace[]): Promise<void> {
    const now = Date.now();
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    const cells = [
        ...new Map(
            places.map((p) => {
                const c = conditionsCell(p);
                return [c.key, c] as const;
            }),
        ).values(),
    ]
        .filter(
            (c) => Number.isFinite(c.lat) && Number.isFinite(c.lon) && Math.abs(c.lat) <= 85 && Math.abs(c.lon) <= 180,
        )
        .slice(0, 24);
    const fresh = cells.filter((c) => !pending.has(c.key) && now - (cache.get(c.key)?.fetchedAt ?? 0) >= TTL);
    if (fresh.length) {
        const task = (async () => {
            const params = { forecast_days: 3, timeformat: 'unixtime' };
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
                cache.delete(c.key);
                cache.set(
                    c.key,
                    parseConditionsForecast(
                        wind.status === 'fulfilled' ? wind.value[i] : undefined,
                        sea.status === 'fulfilled' ? sea.value[i] : undefined,
                        c,
                        fetchedAt,
                    ),
                );
            });
            while (cache.size > 96) cache.delete(cache.keys().next().value!);
        })().finally(() => fresh.forEach((c) => pending.delete(c.key)));
        fresh.forEach((c) => pending.set(c.key, task));
    }
    await Promise.all(cells.map((c) => pending.get(c.key)));
}
