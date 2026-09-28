import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    assessPlaceConditions,
    assessPlaceConditionsWindow,
    CONDITIONS_MAX_AGE_MS,
    CONDITIONS_MAX_WINDOW_MS,
    type ConditionsForecast,
    type ConditionsPlace,
} from '../services/anchorages/placeConditions';

const api = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../services/weather/openMeteoProxy', () => ({ fetchOpenMeteoPoints: api.fetch }));

const hour = 3_600_000;
const now = Date.UTC(2026, 8, 27, 0, 25);
const firstHour = Math.floor(now / hour) * hour;
const place: ConditionsPlace = {
    id: 'planned-cove',
    lat: -20,
    lon: 149,
    kind: 'anchorage',
    fetchLandNM: Array(36).fill(0.3),
};
// Tomorrow afternoon through the following morning in a UTC+10 location.
const stay = { fromMs: firstHour + 29.5 * hour, toMs: firstHour + 46.25 * hour };
const forecast = (): ConditionsForecast => ({
    lat: place.lat,
    lon: place.lon,
    fetchedAt: now,
    hours: Array.from({ length: 7 * 24 }, (_, i) => ({
        t: firstHour + i * hour,
        wind: 12,
        gust: 17,
        direction: 135,
        weatherCode: 0,
        waveM: 0.3,
        waveDirection: 135,
        wavePeriod: 5,
    })),
});

describe('Future stay conditions', () => {
    it('uses the present freshness clock for the entire future overnight stay', () => {
        const result = assessPlaceConditionsWindow(place, forecast(), stay, now);
        expect(result).toMatchObject({ light: 'green', ...stay, fetchedAt: now });
        expect(result.reasons.join(' ')).toContain('requested period');
        expect(result.reasons.join(' ')).not.toContain('next 12 hours');
    });

    it('ignores weather outside the stay and lets a late overnight hazard dominate', () => {
        const f = forecast();
        f.hours[1].gust = 40;
        f.hours[48].gust = 40;
        expect(assessPlaceConditionsWindow(place, f, stay, now).light).toBe('green');
        f.hours[44].gust = 40;
        expect(assessPlaceConditionsWindow(place, f, stay, now)).toMatchObject({
            light: 'red',
            worstAt: firstHour + 44 * hour,
        });
    });

    it.each([29, 47])('includes the bracketing boundary sample at hour %s', (index) => {
        const f = forecast();
        f.hours[index].weatherCode = 95;
        expect(assessPlaceConditionsWindow(place, f, stay, now)).toMatchObject({
            light: 'red',
            worstAt: f.hours[index].t,
        });
    });

    it('includes the final sample when the departure is exactly on the hour', () => {
        const f = forecast();
        f.hours[46].gust = 40;
        expect(assessPlaceConditionsWindow(place, f, { ...stay, toMs: f.hours[46].t }, now).light).toBe('red');
    });

    it('rejects forecasts stale now or fetched at the planned future arrival', () => {
        for (const fetchedAt of [now - CONDITIONS_MAX_AGE_MS - 1, stay.fromMs])
            expect(assessPlaceConditionsWindow(place, { ...forecast(), fetchedAt }, stay, now).light).toBe('unknown');
    });

    it.each([
        { fromMs: Number.NaN, toMs: stay.toMs },
        { fromMs: stay.fromMs, toMs: Number.POSITIVE_INFINITY },
        { fromMs: stay.fromMs, toMs: stay.fromMs },
        { fromMs: stay.toMs, toMs: stay.fromMs },
        { fromMs: now - 1, toMs: stay.toMs },
        { fromMs: stay.fromMs, toMs: now + CONDITIONS_MAX_WINDOW_MS + 1 },
    ])('returns unknown for malformed or out-of-range interval %j', (window) => {
        expect(assessPlaceConditionsWindow(place, forecast(), window, now).light).toBe('unknown');
    });

    it.each([29, 37, 47])('requires complete hourly coverage including hour %s', (index) => {
        const f = forecast();
        f.hours.splice(index, 1);
        expect(assessPlaceConditionsWindow(place, f, stay, now).light).toBe('unknown');
    });

    it('rejects duplicate hours and missing fields even with a moderate caution', () => {
        const duplicated = forecast();
        duplicated.hours[37] = { ...duplicated.hours[36] };
        expect(assessPlaceConditionsWindow(place, duplicated, stay, now).light).toBe('unknown');
        const partial = forecast();
        partial.hours[34].gust = 27;
        delete partial.hours[40].waveM;
        expect(assessPlaceConditionsWindow(place, partial, stay, now).light).toBe('unknown');
        partial.hours[44].gust = 40;
        expect(assessPlaceConditionsWindow(place, partial, stay, now).light).toBe('red');
    });

    it('preserves the existing next-12-hour labels and caution with incomplete coverage', () => {
        const f = forecast();
        expect(assessPlaceConditions(place, f, now).reasons).toEqual([
            'Wind, gusts and wave exposure look favourable across the next 12 hours.',
        ]);
        f.hours[1].gust = 27;
        delete f.hours[4].waveM;
        expect(assessPlaceConditions(place, f, now)).toMatchObject({
            light: 'amber',
            fromMs: now,
            toMs: now + 12 * hour,
        });
    });
});

function weatherResponse(operation: string, points: { lat: number; lon: number }[], days: number) {
    const count = days * 24;
    return points.map((p) => ({
        latitude: p.lat,
        longitude: p.lon,
        hourly_units:
            operation === 'forecast'
                ? { wind_speed_10m: 'kn', wind_gusts_10m: 'kn', wind_direction_10m: '°', weather_code: 'wmo code' }
                : { wave_height: 'm', wave_direction: '°', wave_period: 's' },
        hourly: {
            time: Array.from({ length: count }, (_, i) => firstHour / 1000 + i * 3600),
            ...(operation === 'forecast'
                ? {
                      wind_speed_10m: Array(count).fill(12),
                      wind_gusts_10m: Array(count).fill(17),
                      wind_direction_10m: Array(count).fill(135),
                      weather_code: Array(count).fill(0),
                  }
                : {
                      wave_height: Array(count).fill(0.2),
                      wave_direction: Array(count).fill(135),
                      wave_period: Array(count).fill(5),
                  }),
        },
    }));
}

describe('Planner forecast horizons', () => {
    beforeEach(() => {
        vi.resetModules();
        vi.useFakeTimers();
        vi.setSystemTime(now);
        api.fetch.mockReset();
        api.fetch.mockImplementation(async (operation, points, params) =>
            weatherResponse(operation, points, params.forecast_days),
        );
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.unstubAllGlobals();
    });

    it('upgrades a fresh three-day cache for a seven-day plan and reuses it for map callers', async () => {
        const svc = await import('../services/anchorages/PlaceConditionsService');
        const laterStay = { fromMs: firstHour + 120 * hour, toMs: firstHour + 144 * hour };
        await svc.loadPlaceConditions([place]);
        expect(api.fetch.mock.calls.map((call) => call[2].forecast_days)).toEqual([3, 3]);
        expect(assessPlaceConditionsWindow(place, svc.cachedConditionsForecast(place), laterStay, now).light).toBe(
            'unknown',
        );
        await svc.loadPlaceConditions([place], { forecastDays: 7 });
        expect(api.fetch.mock.calls.map((call) => call[2].forecast_days)).toEqual([3, 3, 7, 7]);
        expect(assessPlaceConditionsWindow(place, svc.cachedConditionsForecast(place), laterStay, now).light).toBe(
            'green',
        );
        await svc.loadPlaceConditions([place]);
        await svc.loadPlaceConditions([place], { forecastDays: 7 });
        expect(api.fetch).toHaveBeenCalledTimes(4);
    });

    it('waits for an in-flight shorter horizon then upgrades before resolving the planner', async () => {
        const svc = await import('../services/anchorages/PlaceConditionsService');
        let finishShort!: () => void;
        const shortGate = new Promise<void>((resolve) => {
            finishShort = resolve;
        });
        api.fetch.mockImplementation(async (operation, points, params) => {
            if (params.forecast_days === 3) await shortGate;
            return weatherResponse(operation, points, params.forecast_days);
        });
        const mapLoad = svc.loadPlaceConditions([place]);
        const plannerLoad = svc.loadPlaceConditions([place], { forecastDays: 7 });
        expect(api.fetch).toHaveBeenCalledTimes(2);
        finishShort();
        await Promise.all([mapLoad, plannerLoad]);
        expect(api.fetch.mock.calls.map((call) => call[2].forecast_days)).toEqual([3, 3, 7, 7]);
        expect(svc.cachedConditionsForecast(place)?.hours).toHaveLength(168);
    });

    it('shares an in-flight seven-day request with a map caller', async () => {
        const svc = await import('../services/anchorages/PlaceConditionsService');
        await Promise.all([svc.loadPlaceConditions([place], { forecastDays: 7 }), svc.loadPlaceConditions([place])]);
        expect(api.fetch).toHaveBeenCalledTimes(2);
        expect(api.fetch.mock.calls.map((call) => call[2].forecast_days)).toEqual([7, 7]);
    });

    it.each([
        [99, 7],
        [0, 1],
        [4.5, 5],
        [Number.NaN, 3],
    ])('bounds a requested horizon of %s to %s days', async (requested, expected) => {
        const svc = await import('../services/anchorages/PlaceConditionsService');
        await svc.loadPlaceConditions([place], { forecastDays: requested });
        expect(api.fetch.mock.calls.map((call) => call[2].forecast_days)).toEqual([expected, expected]);
    });

    it('returns immutable cached data and withholds it offline', async () => {
        const svc = await import('../services/anchorages/PlaceConditionsService');
        await svc.loadPlaceConditions([place], { forecastDays: 7 });
        const cached = svc.cachedConditionsForecast(place);
        expect(Object.isFrozen(cached)).toBe(true);
        expect(Object.isFrozen(cached?.hours)).toBe(true);
        expect(Object.isFrozen(cached?.hours[0])).toBe(true);
        vi.stubGlobal('navigator', { onLine: false });
        expect(svc.cachedConditionsForecast(place)).toBeUndefined();
        expect(assessPlaceConditionsWindow(place, svc.cachedConditionsForecast(place), stay, now).light).toBe(
            'unknown',
        );
    });

    it('does not turn a failed or truncated seven-day response into favourable future conditions', async () => {
        const svc = await import('../services/anchorages/PlaceConditionsService');
        await svc.loadPlaceConditions([place]);
        api.fetch.mockRejectedValue(new Error('unavailable'));
        await svc.loadPlaceConditions([place], { forecastDays: 7 });
        expect(assessPlaceConditionsWindow(place, svc.cachedConditionsForecast(place), stay, now).light).toBe(
            'unknown',
        );
        vi.setSystemTime(now + 6 * 60_000);
        api.fetch.mockImplementation(async (operation, points) => weatherResponse(operation, points, 3));
        await svc.loadPlaceConditions([place], { forecastDays: 7 });
        expect(
            assessPlaceConditionsWindow(
                place,
                svc.cachedConditionsForecast(place),
                { fromMs: firstHour + 120 * hour, toMs: firstHour + 144 * hour },
                Date.now(),
            ).light,
        ).toBe('unknown');
    });

    it.each([6, 19.9])(
        'rejects a provider grid %s NM away for strict plans while preserving legacy tolerance',
        async (distance) => {
            const svc = await import('../services/anchorages/PlaceConditionsService');
            api.fetch.mockImplementation(async (operation, points, params) =>
                weatherResponse(operation, points, params.forecast_days).map((response) => ({
                    ...response,
                    latitude: response.latitude + distance / 60,
                })),
            );
            await svc.loadPlaceConditions([place]);
            expect(svc.cachedPlaceConditions(place).light).toBe('green');
            expect(svc.cachedConditionsForecast(place, { maxProviderDistanceNM: 5 })).toBeUndefined();
            await svc.loadPlaceConditions([place], { forecastDays: 7, maxProviderDistanceNM: 5 });
            const strict = svc.cachedConditionsForecast(place, { maxProviderDistanceNM: 5 });
            expect(strict?.hours).toHaveLength(0);
            expect(assessPlaceConditionsWindow(place, strict, stay, now).light).toBe('unknown');
            expect(api.fetch).toHaveBeenCalledTimes(4);
            expect(svc.cachedPlaceConditions(place).light).toBe('green');
        },
    );

    it('separates concurrent strict and legacy cache requests', async () => {
        const svc = await import('../services/anchorages/PlaceConditionsService');
        await Promise.all([
            svc.loadPlaceConditions([place], { forecastDays: 7 }),
            svc.loadPlaceConditions([place], { forecastDays: 7, maxProviderDistanceNM: 5 }),
        ]);
        expect(api.fetch).toHaveBeenCalledTimes(4);
        const strict = svc.cachedConditionsForecast(place, { maxProviderDistanceNM: 5 });
        expect(strict?.windGrid).toEqual({ lat: place.lat, lon: place.lon });
        expect(strict?.seaGrid).toEqual({ lat: place.lat, lon: place.lon });
        expect(Object.isFrozen(strict?.windGrid)).toBe(true);
        expect(assessPlaceConditionsWindow(place, strict, stay, now).light).toBe('green');
    });

    it('rejects swapped nearby responses in strict mode', async () => {
        const svc = await import('../services/anchorages/PlaceConditionsService');
        const other = { ...place, id: 'other', lat: place.lat + 0.1 };
        api.fetch.mockImplementation(async (operation, points, params) =>
            weatherResponse(operation, points, params.forecast_days).reverse(),
        );
        await svc.loadPlaceConditions([place, other], { forecastDays: 7, maxProviderDistanceNM: 5 });
        for (const point of [place, other])
            expect(
                assessPlaceConditionsWindow(
                    point,
                    svc.cachedConditionsForecast(point, { maxProviderDistanceNM: 5 }),
                    stay,
                    now,
                ).light,
            ).toBe('unknown');
    });

    it('rejects a grid outside five NM from the actual point despite cell rounding', async () => {
        const svc = await import('../services/anchorages/PlaceConditionsService');
        const roundedPoint = { ...place, lat: place.lat - 0.024 };
        api.fetch.mockImplementation(async (operation, points, params) =>
            weatherResponse(operation, points, params.forecast_days).map((response) => ({
                ...response,
                latitude: response.latitude + 4.5 / 60,
            })),
        );
        await svc.loadPlaceConditions([roundedPoint], { forecastDays: 7, maxProviderDistanceNM: 5 });
        expect(svc.cachedConditionsForecast(place, { maxProviderDistanceNM: 5 })?.hours.length).toBe(168);
        expect(svc.cachedConditionsForecast(roundedPoint, { maxProviderDistanceNM: 5 })).toBeUndefined();
    });
});
