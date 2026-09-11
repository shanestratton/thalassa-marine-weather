import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarineWeatherReport, OffshoreModel, StormGlassHour } from '../types';

const mocks = vi.hoisted(() => ({
    settings: { offshoreModel: 'sg' as unknown },
    fetchSG: vi.fn(),
    cache: new Map<string, MarineWeatherReport>(),
}));
vi.mock('../stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({ settings: mocks.settings }) } }));
vi.mock('../services/weather/api/base', () => ({ fetchSG: mocks.fetchSG }));
vi.mock('../services/weather/api/tides', () => ({ fetchRealTides: vi.fn(async () => ({ tides: [] })) }));
vi.mock('../services/weather/openMeteoProxy', () => ({ fetchOpenMeteoProxy: vi.fn(async () => ({})) }));
vi.mock('../services/weather/marineProximity', () => ({
    checkMarineProximity: vi.fn(async () => ({ hasMarineData: false })),
}));
vi.mock('../services/weather/api/geocoding', () => ({ reverseGeocodeContext: vi.fn(async () => null) }));
vi.mock('../services/weather/locationType', () => ({ determineLocationType: () => 'offshore' }));
vi.mock('../services/weather/api/beaconService', () => ({ findAndFetchNearestBeacon: vi.fn(async () => null) }));
vi.mock('../services/weather/apiCache', () => ({
    apiCacheGet: (provider: string, lat: number, lon: number, suffix?: string) =>
        mocks.cache.get(`${provider}:${lat}:${lon}:${suffix}`),
    apiCacheSet: (provider: string, lat: number, lon: number, data: MarineWeatherReport, suffix?: string) =>
        mocks.cache.set(`${provider}:${lat}:${lon}:${suffix}`, data),
}));
import { fetchStormGlassWeather } from '../services/weather/api/stormglass';

function payload(): { hours: StormGlassHour[] } {
    return {
        hours: [
            {
                time: new Date().toISOString(),
                windSpeed: { sg: 5, ecmwf: 2, noaa: 9 },
                gust: { sg: 8 },
                windDirection: { sg: 90 },
                airTemperature: { sg: 22 },
                humidity: { sg: 65 },
                pressure: { sg: 1015 },
                precipitation: { sg: 0 },
                cloudCover: { sg: 10 },
                waveHeight: { sg: 1 },
            },
        ],
    };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}
beforeEach(() => {
    mocks.settings.offshoreModel = 'sg';
    mocks.cache.clear();
    mocks.fetchSG.mockReset().mockImplementation(async () => payload());
});

describe('model-scoped StormGlass requests', () => {
    it.each([
        ['ecmwf', 'ecmwf,sg'],
        ['gfs', 'noaa,sg'],
        ['sg', 'sg'],
        ['icon', 'sg'],
    ] as const)('maps %s to documented provider selector %s', async (model, source) => {
        mocks.settings.offshoreModel = model;
        await fetchStormGlassWeather(-24, 153, 'Same ocean point', 'offshore');
        expect(mocks.fetchSG).toHaveBeenCalledWith(
            'weather/point',
            expect.objectContaining({ source, lat: -24, lng: 153 }),
        );
        const params = mocks.fetchSG.mock.calls[0][1].params as string;
        expect(params.includes('windSpeed')).toBe(model !== 'icon');
        expect(params).toContain('waveHeight');
    });
    it('changing model at unchanged coordinates bypasses the previous model cache', async () => {
        const sg = await fetchStormGlassWeather(-24, 153, 'Ocean', 'offshore');
        mocks.settings.offshoreModel = 'ecmwf';
        const ecmwf = await fetchStormGlassWeather(-24, 153, 'Ocean', 'offshore');
        expect(mocks.fetchSG).toHaveBeenCalledTimes(2);
        expect(ecmwf.current.windSpeed).not.toBe(sg.current.windSpeed);
        expect(ecmwf.modelUsed).toContain('stormglass_ecmwf');
        expect(ecmwf.coordinates).toEqual(sg.coordinates);
        await fetchStormGlassWeather(-24, 153, 'Ocean', 'offshore');
        expect(mocks.fetchSG).toHaveBeenCalledTimes(2);
    });
    it('marine-only coastal cache does not satisfy an offshore full-atmosphere request', async () => {
        await fetchStormGlassWeather(-24, 153, 'Ocean', 'coastal');
        await fetchStormGlassWeather(-24, 153, 'Ocean', 'offshore');
        expect(mocks.fetchSG).toHaveBeenCalledTimes(2);
        expect(mocks.fetchSG.mock.calls[0][1].params).not.toContain('windSpeed');
        expect(mocks.fetchSG.mock.calls[1][1].params).toContain('windSpeed');
    });
    it('different models never coalesce in flight, while identical model/point does', async () => {
        const pending = deferred<ReturnType<typeof payload>>();
        mocks.fetchSG.mockReturnValue(pending.promise);
        const first = fetchStormGlassWeather(-24, 153, 'Ocean', 'offshore');
        const same = fetchStormGlassWeather(-24, 153, 'Renamed ocean', 'offshore');
        mocks.settings.offshoreModel = 'ecmwf';
        const second = fetchStormGlassWeather(-24, 153, 'Ocean', 'offshore');
        expect(mocks.fetchSG).toHaveBeenCalledTimes(2);
        pending.resolve(payload());
        const [a, b, c] = await Promise.all([first, same, second]);
        expect(a.current.windSpeed).toBe(b.current.windSpeed);
        expect(c.current.windSpeed).not.toBe(a.current.windSpeed);
        expect(b.locationName).toBe('Renamed ocean');
        a.current.windSpeed = 99;
        expect(b.current.windSpeed).not.toBe(99);
        const cache = await fetchStormGlassWeather(-24, 153, 'Ocean', 'offshore', 'sg');
        expect(cache.current.windSpeed).not.toBe(99);
    });
    it('honours an explicit immutable strategy snapshot and rejects malformed saved selection', async () => {
        mocks.settings.offshoreModel = 'ecmwf';
        await fetchStormGlassWeather(-24, 153, 'Ocean', 'offshore', 'gfs');
        expect(mocks.fetchSG.mock.calls[0][1].source).toBe('noaa,sg');
        mocks.settings.offshoreModel = 'unexpected-provider' as OffshoreModel;
        await fetchStormGlassWeather(-24, 153, 'Ocean', 'offshore');
        expect(mocks.fetchSG.mock.calls[1][1].source).toBe('sg');
    });
});
