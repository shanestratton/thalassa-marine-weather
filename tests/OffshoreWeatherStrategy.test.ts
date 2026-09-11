import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarineWeatherReport, OffshoreModel, StormGlassHour } from '../types';

const m = vi.hoisted(() => ({
    settings: { forecastModel: 'ecmwf_aifs025_single', offshoreModel: 'ecmwf' },
    user: { id: 'skipper' },
    ready: vi.fn(),
    unified: vi.fn(),
    om: vi.fn(),
    sg: vi.fn(),
    wk: vi.fn(),
    save: vi.fn(),
    cached: vi.fn(),
    offline: vi.fn(),
    spitfire: vi.fn(),
}));
vi.mock('../stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({ settings: m.settings }) } }));
vi.mock('../stores/authStore', () => ({ useAuthStore: { getState: () => ({ user: m.user }) } }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock('../services/PiCacheService', () => ({ piCache: { awaitReady: m.ready } }));
vi.mock('../services/weather/api/stormglass', () => ({ fetchStormGlassWeather: m.sg }));
vi.mock('../services/weather/api/openmeteo', () => ({ fetchOpenMeteo: m.om }));
vi.mock('../services/weather/api/unified', () => ({
    fetchUnifiedWeather: m.unified,
    fetchUnifiedWeatherRaw: vi.fn(),
    extractNowcast: vi.fn(),
}));
vi.mock('../services/weather/api/weatherkit', () => ({
    fetchWeatherKitFull: m.wk,
    buildReportFromWeatherKit: (data: unknown) => data,
    fetchWeatherKitRealtime: vi.fn(),
    fetchMinutelyRain: vi.fn(),
}));
vi.mock('../services/weather/api/tides', () => ({
    fetchRealTides: vi.fn(async () => ({ tides: [] })),
    interpolateTideHourly: () => [],
}));
vi.mock('../services/weather/api/geocoding', () => ({
    parseLocation: vi.fn(),
    reverseGeocode: vi.fn(async () => 'Ocean'),
}));
vi.mock('../services/weather/api/marine', () => ({
    fetchMarine: vi.fn(async () => null),
    isLocalReading: () => false,
}));
vi.mock('../services/weather/api/buoys', () => ({ fetchActiveBuoys: vi.fn() }));
vi.mock('../services/weather/cache', () => ({
    saveToCache: m.save,
    getFromCache: m.cached,
    getFromCacheOffline: m.offline,
}));
vi.mock('../services/weather/shelter', () => ({ assessShelter: vi.fn(async () => null), dampReportWaves: vi.fn() }));
vi.mock('../services/weather/wxPublished', () => ({ announceCell: vi.fn() }));
vi.mock('../services/weather/spitfire', () => ({ fetchSpitfire: m.spitfire, applySpitfireToReport: vi.fn() }));
vi.mock('../services/weather/keys', () => ({
    getApiKeySuffix: vi.fn(),
    isStormglassKeyPresent: vi.fn(),
    debugStormglassConnection: vi.fn(),
    checkStormglassStatus: vi.fn(),
}));
vi.mock('../utils/flightRecorder', () => ({ crumb: vi.fn() }));
import { fetchPrecisionWeather, fetchWeatherByStrategy } from '../services/weather';
import { mapStormGlassToReport } from '../services/weather/transformers';

function sgReport(model: OffshoreModel = 'ecmwf') {
    const rows = Array.from(
        { length: 4 },
        (_, i) =>
            ({
                time: new Date(Date.now() + i * 3_600_000).toISOString(),
                windSpeed: { sg: 4, ecmwf: 2, noaa: 7 },
                gust: { sg: 5, ecmwf: 3, noaa: 9 },
                windDirection: { sg: 90 },
                airTemperature: { sg: 24, ecmwf: 20, noaa: 28 },
                pressure: { sg: 1008, ecmwf: 1012, noaa: 1018 },
                humidity: { sg: 60 },
                cloudCover: { sg: 20 },
                precipitation: { sg: 0 },
                waveHeight: { sg: 1.5 },
                wavePeriod: { sg: 9 },
            }) as StormGlassHour,
    );
    return mapStormGlassToReport(
        rows,
        -24.123456,
        153.123456,
        'Exact ocean point',
        undefined,
        [],
        [],
        model,
        [],
        'offshore',
    );
}
function fallback(): MarineWeatherReport {
    const data = sgReport('sg');
    data.modelUsed = 'weatherkit';
    data.current.windSpeed = 40;
    data.hourly.forEach((h) => {
        h.windSpeed = 40;
    });
    data.forecast.forEach((d) => {
        d.windSpeed = 40;
    });
    return data;
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}
const point = [-24.123456, 153.123456, 'Exact ocean point'] as const;
beforeEach(() => {
    vi.clearAllMocks();
    m.settings.forecastModel = 'ecmwf_aifs025_single';
    m.settings.offshoreModel = 'ecmwf';
    m.user = { id: 'skipper' };
    m.ready.mockReset().mockResolvedValue(undefined);
    m.unified.mockReset().mockImplementation(async () => fallback());
    m.om.mockReset().mockImplementation(async () => {
        const data = fallback();
        data.modelUsed = 'openmeteo';
        return data;
    });
    m.sg.mockReset().mockImplementation(async (_lat, _lon, _name, _mode, model) => sgReport(model));
    m.wk.mockReset().mockResolvedValue(null);
    m.offline.mockReset().mockReturnValue(null);
    m.cached.mockReset().mockReturnValue(null);
    m.spitfire.mockReset().mockResolvedValue(null);
});

describe('authoritative offshore strategy', () => {
    it('corrects a first unknown point classified offshore with one bounded source-only fetch', async () => {
        const result = await fetchWeatherByStrategy(...point);
        expect(m.sg.mock.calls.map((call) => [call[3], call[4]])).toEqual([
            [undefined, 'ecmwf'],
            ['offshore', 'ecmwf'],
        ]);
        expect(m.unified).toHaveBeenCalledTimes(1);
        expect(m.om).toHaveBeenCalledTimes(1);
        expect(m.ready).toHaveBeenCalledTimes(1);
        expect(result.current.windSpeed).toBe(sgReport('ecmwf').current.windSpeed);
        expect(result.modelUsed).toContain('stormglass_ecmwf');
        expect(result.coordinates).toEqual({ lat: point[0], lon: point[1] });
    });
    it('corrects first-visit ICON with only its supported atmosphere and does not refetch marine', async () => {
        m.settings.offshoreModel = 'icon';
        await fetchWeatherByStrategy(...point);
        expect(m.om.mock.calls.map((call) => call[4])).toEqual(['ecmwf_aifs025_single', 'dwd_icon']);
        expect(m.sg).toHaveBeenCalledTimes(1);
        expect(m.unified).toHaveBeenCalledTimes(1);
    });
    it('reuses an already-fetched ICON source when the unknown point becomes offshore', async () => {
        m.settings.forecastModel = 'dwd_icon';
        m.settings.offshoreModel = 'icon';
        const result = await fetchWeatherByStrategy(...point);
        expect(m.om).toHaveBeenCalledTimes(1);
        expect(m.sg).toHaveBeenCalledTimes(1);
        expect(result.modelUsed).toContain('om:dwd_icon');
    });
    it('does not use marine-only zero placeholders when first-visit atmosphere correction fails', async () => {
        m.sg.mockImplementation(async (_lat, _lon, _name, mode) => {
            if (mode === 'offshore') throw new Error('Atmosphere unavailable');
            const marine = sgReport();
            marine.current.windSpeed = 0;
            return marine;
        });
        const result = await fetchWeatherByStrategy(...point);
        expect(result.current.windSpeed).toBe(40);
        expect(result.modelUsed).not.toContain('stormglass_ecmwf');
        expect(result.modelUsed).toContain('wk');
    });
    it('does not launch classification-correction requests after the captured selection is obsolete', async () => {
        const initial = deferred<MarineWeatherReport>();
        m.sg.mockReturnValue(initial.promise);
        const pending = fetchWeatherByStrategy(...point);
        await vi.waitFor(() => expect(m.sg).toHaveBeenCalledTimes(1));
        m.settings.offshoreModel = 'gfs';
        initial.resolve(sgReport('ecmwf'));
        await pending;
        expect(m.sg).toHaveBeenCalledTimes(1);
        expect(m.save).not.toHaveBeenCalled();
    });
    it('does not correct the source when a new point is classified coastal', async () => {
        m.sg.mockImplementation(async () => ({ ...sgReport(), locationType: 'coastal' }));
        const result = await fetchWeatherByStrategy(...point);
        expect(m.sg).toHaveBeenCalledTimes(1);
        expect(result.modelUsed).toContain('om:ecmwf_aifs025_single');
    });
    it('does not let the unrelated inshore AIFS selection override offshore ECMWF at any horizon', async () => {
        const result = await fetchWeatherByStrategy(...point, 'offshore');
        const selected = sgReport('ecmwf');
        expect(m.om).toHaveBeenCalledWith(...point, false, 'best_match');
        expect(m.sg).toHaveBeenCalledWith(...point, 'offshore', 'ecmwf');
        expect(result.current.windSpeed).toBe(selected.current.windSpeed);
        expect(result.hourly.map((h) => h.windSpeed)).toEqual(selected.hourly.map((h) => h.windSpeed));
        expect(result.forecast.map((d) => d.windSpeed)).toEqual(selected.forecast.map((d) => d.windSpeed));
        expect(result.current.waveHeight).toBe(selected.current.waveHeight);
        expect(result.modelUsed).toContain('stormglass_ecmwf');
        expect(result.modelUsed).not.toContain('aifs');
        expect(result.coordinates).toEqual({ lat: point[0], lon: point[1] });
        expect(result.locationName).toBe(point[2]);
    });
    it('uses supported Open-Meteo ICON atmosphere offshore while preserving SG marine data', async () => {
        m.settings.offshoreModel = 'icon';
        const result = await fetchWeatherByStrategy(...point, 'offshore');
        expect(m.om).toHaveBeenCalledWith(...point, false, 'dwd_icon');
        expect(result.current.windSpeed).toBe(40);
        expect(result.hourly.every((h) => h.windSpeed === 40)).toBe(true);
        expect(result.forecast.every((d) => d.windSpeed === 40)).toBe(true);
        expect(result.current.waveHeight).toBe(sgReport().current.waveHeight);
        expect(result.modelUsed).toContain('om:dwd_icon');
        expect(result.modelUsed).toContain('+sg');
    });
    it('keeps inshore atmospheric model selection independent', async () => {
        const result = await fetchWeatherByStrategy(...point, 'inshore');
        expect(m.om).toHaveBeenCalledWith(...point, false, 'ecmwf_aifs025_single');
        expect(result.current.windSpeed).toBe(40);
        expect(result.modelUsed).toContain('om:ecmwf_aifs025_single');
    });
    it('does not claim selected ECMWF succeeded when StormGlass fails', async () => {
        m.sg.mockRejectedValue(new Error('source unavailable'));
        const result = await fetchWeatherByStrategy(...point, 'offshore');
        expect(result.current.windSpeed).toBe(40);
        expect(result.modelUsed).not.toContain('ecmwf');
        expect(result.modelUsed).toContain('wk');
    });
    it('coalesces identical requests but not model switches, taking the snapshot before Pi readiness', async () => {
        const ready = deferred<void>();
        m.ready.mockReturnValue(ready.promise);
        const first = fetchWeatherByStrategy(...point, 'offshore');
        const twin = fetchWeatherByStrategy(...point, 'offshore');
        m.settings.offshoreModel = 'gfs';
        const second = fetchWeatherByStrategy(...point, 'offshore');
        expect(m.ready).toHaveBeenCalledTimes(2);
        ready.resolve();
        const [ecmwf, same, gfs] = await Promise.all([first, twin, second]);
        expect(m.sg).toHaveBeenCalledTimes(2);
        expect(m.sg.mock.calls.map((call) => call[4])).toEqual(['ecmwf', 'gfs']);
        expect(ecmwf.current.windSpeed).toBe(same.current.windSpeed);
        expect(gfs.current.windSpeed).not.toBe(ecmwf.current.windSpeed);
        expect(m.save).toHaveBeenCalledTimes(1);
        expect(m.save.mock.calls[0][1].modelUsed).toContain('stormglass_gfs');
        ecmwf.current.windSpeed = 999;
        expect(same.current.windSpeed).not.toBe(999);
    });
    it('does not merge callers across accounts or write a previous account result into the current cache', async () => {
        const ready = deferred<void>();
        m.ready.mockReturnValue(ready.promise);
        const first = fetchWeatherByStrategy(...point, 'offshore');
        m.user = { id: 'new-skipper' };
        const second = fetchWeatherByStrategy(...point, 'offshore');
        ready.resolve();
        await Promise.all([first, second]);
        expect(m.unified.mock.calls.map((call) => call[3])).toEqual(['skipper', 'new-skipper']);
        expect(m.save).toHaveBeenCalledTimes(1);
    });
    it('refuses a coordinate-only offline cache from a different offshore model', async () => {
        m.unified.mockResolvedValue(null);
        m.om.mockResolvedValue(null);
        m.sg.mockResolvedValue(null);
        m.offline.mockReturnValue({ data: sgReport('gfs'), ageMinutes: 30 });
        await expect(fetchWeatherByStrategy(...point, 'offshore')).rejects.toThrow('All weather APIs failed');
        m.offline.mockReturnValue({ data: sgReport('ecmwf'), ageMinutes: 30 });
        const stale = await fetchWeatherByStrategy(...point, 'offshore');
        expect(stale._stale).toBe(true);
        expect(stale._staleAgeMinutes).toBe(30);
    });
    it('precision fallback does not reuse a different model from the general coordinate cache', async () => {
        const wrong = sgReport('gfs');
        wrong.utcOffset = 10;
        m.cached.mockReturnValue(wrong);
        await fetchPrecisionWeather(point[2], { lat: point[0], lon: point[1] }, false, 'offshore');
        expect(m.sg).toHaveBeenCalledWith(...point, 'offshore', 'ecmwf');
    });
});
