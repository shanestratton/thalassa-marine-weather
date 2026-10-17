import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarineWeatherReport } from '../types';
import { mapMarineModelV2 } from '../services/weather/marineModelV2';
import { marineEnvelopeV2 } from '../supabase/functions/_shared/marine-v2';
import { marineFixtureSource, MARINE_FIXTURE_POINT as point, MARINE_FIXTURE_AT as at } from './fixtures/marineV2141';
const m = vi.hoisted(() => ({
    settings: { forecastModel: 'ecmwf_aifs025_single', offshoreModel: 'ecmwf', satelliteMode: false },
    user: { id: 'skipper' },
    ready: vi.fn(),
    unified: vi.fn(),
    om: vi.fn(),
    sg: vi.fn(),
    marine: vi.fn(),
    wk: vi.fn(),
    save: vi.fn(),
    cached: vi.fn(),
    offline: vi.fn(),
    spitfire: vi.fn(),
    shelter: vi.fn(),
    tides: vi.fn(),
}));
vi.mock('../stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({ settings: m.settings }) } }));
vi.mock('../stores/authStore', () => ({ useAuthStore: { getState: () => ({ user: m.user }) } }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock('../services/PiCacheService', () => ({ piCache: { awaitReady: m.ready } }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => m.settings.satelliteMode }));
vi.mock('../services/weather/api/stormglass', () => ({ fetchStormGlassWeather: m.sg }));
vi.mock('../services/weather/api/marineModel', () => ({ fetchMarineModelV2: m.marine }));
vi.mock('../services/weather/api/openmeteo', () => ({ fetchOpenMeteo: m.om }));
vi.mock('../services/weather/api/unified', () => ({
    fetchUnifiedWeather: m.unified,
    fetchUnifiedWeatherRaw: vi.fn(),
    extractNowcast: vi.fn(),
}));
vi.mock('../services/weather/api/weatherkit', () => ({
    fetchWeatherKitFull: m.wk,
    buildReportFromWeatherKit: (value: unknown) => value,
    fetchWeatherKitRealtime: vi.fn(),
    fetchMinutelyRain: vi.fn(),
}));
vi.mock('../services/weather/api/tides', () => ({ fetchRealTides: m.tides, interpolateTideHourly: () => [] }));
vi.mock('../services/weather/api/geocoding', () => ({
    parseLocation: vi.fn(),
    reverseGeocode: vi.fn(async () => 'Ocean'),
}));
vi.mock('../services/weather/api/buoys', () => ({ fetchActiveBuoys: vi.fn() }));
vi.mock('../services/weather/cache', () => ({
    saveToCache: m.save,
    getFromCache: m.cached,
    getFromCacheOffline: m.offline,
}));
vi.mock('../services/weather/shelter', () => ({ assessShelter: m.shelter }));
vi.mock('../services/weather/wxPublished', () => ({ announceCell: vi.fn() }));
vi.mock('../services/weather/spitfire', () => ({ fetchSpitfire: m.spitfire, applySpitfireToReport: vi.fn() }));
vi.mock('../services/weather/keys', () => ({
    getApiKeySuffix: vi.fn(),
    isStormglassKeyPresent: vi.fn(),
    debugStormglassConnection: vi.fn(),
    checkStormglassStatus: vi.fn(),
}));
vi.mock('../utils/flightRecorder', () => ({ crumb: vi.fn() }));
import { fetchFastWeather, fetchPrecisionWeather, fetchWeatherByStrategy } from '../services/weather';
const args = [point.latitude, point.longitude, 'Fictional exact ocean point'] as const;
function atmosphere(model = 'weatherkit', wind = 40): MarineWeatherReport {
    return {
        locationName: args[2],
        coordinates: { lat: args[0], lon: args[1] },
        locationType: 'offshore',
        timeZone: 'UTC',
        utcOffset: 0,
        generatedAt: new Date(at).toISOString(),
        modelUsed: model,
        tides: [],
        alerts: ['Obsolete sea alert'],
        boatingAdvice: 'Obsolete advice',
        current: {
            windSpeed: wind,
            windGust: wind,
            windDirection: 'N',
            waveHeight: 20,
            swellPeriod: 20,
            airTemperature: 22,
            description: 'Fictional forecast',
            condition: 'Sunny',
            uvIndex: 0,
            waterTemperature: 99,
            currentSpeed: 99,
        },
        hourly: [at, at + 3600000].map((time) => ({
            time: new Date(time).toISOString(),
            windSpeed: wind,
            waveHeight: 20,
            temperature: 22,
            condition: 'Sunny',
            waterTemperature: 99,
            currentSpeed: 99,
        })),
        forecast: [
            {
                day: 'Fictional day',
                date: '2026-10-17',
                isoDate: '2026-10-17',
                highTemp: 24,
                lowTemp: 18,
                windSpeed: wind,
                waveHeight: 20,
                condition: 'Sunny',
            },
        ],
    };
}
function reading() {
    return mapMarineModelV2(
        marineEnvelopeV2(point, at, marineFixtureSource('waves'), marineFixtureSource('motion')),
        point,
        at,
        'pi',
    )!;
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}
beforeEach(() => {
    vi.useFakeTimers({ now: at, toFake: ['Date'] });
    vi.clearAllMocks();
    m.settings = { forecastModel: 'ecmwf_aifs025_single', offshoreModel: 'ecmwf', satelliteMode: false };
    m.user = { id: 'skipper' };
    m.ready.mockReset().mockResolvedValue(undefined);
    m.unified.mockReset().mockImplementation(async () => atmosphere());
    m.om
        .mockReset()
        .mockImplementation(async (_lat, _lon, _name, _quick, model) =>
            atmosphere(
                `openmeteo_${model}`,
                model === 'ecmwf_ifs025' ? 7 : model === 'gfs_seamless' ? 13 : model === 'dwd_icon' ? 20 : 40,
            ),
        );
    m.marine.mockReset().mockImplementation(async () => reading());
    m.wk.mockReset().mockResolvedValue(null);
    m.offline.mockReset().mockReturnValue(null);
    m.cached.mockReset().mockReturnValue(null);
    m.spitfire.mockReset().mockResolvedValue(null);
    m.shelter.mockReset().mockResolvedValue(null);
    m.tides.mockReset().mockResolvedValue({ tides: [] });
});
afterEach(() => vi.useRealTimers());
describe('offshore atmosphere with independent marine data', () => {
    it('corrects first-visit offshore atmosphere once without refetching the pack', async () => {
        const result = await fetchWeatherByStrategy(...args);
        expect(m.om.mock.calls.map((call) => call[4])).toEqual(['ecmwf_aifs025_single', 'ecmwf_ifs025']);
        for (const source of [m.unified, m.ready, m.marine, m.tides]) expect(source).toHaveBeenCalledTimes(1);
        expect(m.sg).not.toHaveBeenCalled();
        expect(result.current.windSpeed).toBe(7);
        expect(result.modelUsed).toBe('om:ecmwf_ifs025+marine-v2');
        expect(result.coordinates).toEqual({ lat: args[0], lon: args[1] });
    });
    it.each([
        ['auto', 'ecmwf_ifs025', 7],
        ['sg', 'ecmwf_ifs025', 7],
        ['ecmwf', 'ecmwf_ifs025', 7],
        ['gfs', 'gfs_seamless', 13],
        ['icon', 'dwd_icon', 20],
    ])('uses exact offshore %s domain %s independently from inshore AIFS', async (model, domain, wind) => {
        m.settings.offshoreModel = String(model);
        const result = await fetchWeatherByStrategy(...args, 'offshore');
        expect(m.om).toHaveBeenCalledWith(...args, false, domain);
        expect(result.current.windSpeed).toBe(wind);
        expect(result.hourly.every((h) => h.windSpeed === wind)).toBe(true);
        expect(result.forecast.every((d) => d.windSpeed === wind)).toBe(true);
        expect(result.current.waveHeight).toBe(4.92);
        expect(result.current.currentSpeed).toBe(1);
        expect(result.current.marine?.parts.swell?.hM).toBe(1.2);
        expect(result.modelUsed).toBe(`om:${domain}+marine-v2`);
        expect(m.sg).not.toHaveBeenCalled();
    });
    it('reuses an already fetched domain at first offshore classification', async () => {
        m.settings.forecastModel = 'dwd_icon';
        m.settings.offshoreModel = 'icon';
        const result = await fetchWeatherByStrategy(...args);
        expect(m.om).toHaveBeenCalledTimes(1);
        expect(m.marine).toHaveBeenCalledTimes(1);
        expect(result.modelUsed).toBe('om:dwd_icon+marine-v2');
    });
    it('labels fallback honestly when first-visit atmosphere correction fails', async () => {
        m.om.mockImplementation(async (_lat, _lon, _name, _quick, model) =>
            model === 'ecmwf_ifs025' ? null : atmosphere('openmeteo_aifs', 40),
        );
        const result = await fetchWeatherByStrategy(...args);
        expect(result.current.windSpeed).toBe(40);
        expect(result.modelUsed).toBe('wk+marine-v2');
    });
    it('does not correct or cache an obsolete captured selection', async () => {
        const initial = deferred<MarineWeatherReport>();
        m.om.mockReturnValue(initial.promise);
        const pending = fetchWeatherByStrategy(...args);
        await vi.waitFor(() => expect(m.om).toHaveBeenCalledTimes(1));
        m.settings.offshoreModel = 'gfs';
        initial.resolve(atmosphere('openmeteo_aifs'));
        await pending;
        expect(m.om).toHaveBeenCalledTimes(1);
        expect(m.save).not.toHaveBeenCalled();
    });
    it('preserves inshore atmosphere and refuses coarse sea/current but retains local SST', async () => {
        const result = await fetchWeatherByStrategy(...args, 'inshore');
        expect(m.om).toHaveBeenCalledWith(...args, false, 'ecmwf_aifs025_single');
        expect(result.current.windSpeed).toBe(40);
        expect(result.current.waveHeight).toBeNull();
        expect(result.current.currentSpeed).toBeNull();
        expect(result.current.waterTemperature).toBe(21);
        expect(result.current.marine?.status).toBe('enclosed');
    });
    it('does not correct a coastal point or request marine for a known inland point', async () => {
        m.om.mockResolvedValue({ ...atmosphere(), locationType: 'coastal' });
        await fetchWeatherByStrategy(...args);
        expect(m.om).toHaveBeenCalledTimes(1);
        m.marine.mockClear();
        const result = await fetchWeatherByStrategy(...args, 'inland');
        expect(m.marine).not.toHaveBeenCalled();
        expect(result.current.waveHeight).toBeNull();
    });
    it('clears legacy marine placeholders and obsolete alerts when sources fail', async () => {
        m.om.mockResolvedValue(null);
        m.marine.mockResolvedValue(null);
        const result = await fetchWeatherByStrategy(...args, 'offshore');
        expect(result.current.windSpeed).toBe(40);
        expect(result.current.waveHeight).toBeNull();
        expect(result.hourly.every((h) => h.waveHeight === null)).toBe(true);
        expect(result.forecast.every((d) => d.waveHeight === null)).toBe(true);
        expect(result.modelUsed).toBe('wk');
        expect(result.boatingAdvice).toContain('Sea state unavailable');
        expect(result.alerts).not.toContain('Obsolete sea alert');
        expect(m.sg).not.toHaveBeenCalled();
    });
    it('marks enclosed sea unknown instead of fabricating a capped wave', async () => {
        m.shelter.mockResolvedValue({ enclosed: true, maxFetchKm: 1 });
        const result = await fetchWeatherByStrategy(...args, 'coastal');
        expect(result.current.waveHeight).toBeNull();
        expect(result.current.currentSpeed).toBeNull();
        expect(result.current.marine?.reason).toContain('enclosed');
        expect(result.shelterAdjusted).not.toBe(true);
        expect(result.boatingAdvice).toContain('Sea state unavailable');
    });
    it('coalesces exact requests and snapshots model/cache ownership before Pi readiness', async () => {
        const ready = deferred<void>();
        m.ready.mockReturnValue(ready.promise);
        const first = fetchWeatherByStrategy(...args, 'offshore'),
            twin = fetchWeatherByStrategy(...args, 'offshore');
        m.settings.offshoreModel = 'gfs';
        const second = fetchWeatherByStrategy(...args, 'offshore');
        expect(m.ready).toHaveBeenCalledTimes(2);
        ready.resolve();
        const [ecmwf, same, gfs] = await Promise.all([first, twin, second]);
        expect(m.om.mock.calls.map((call) => call[4])).toEqual(['ecmwf_ifs025', 'gfs_seamless']);
        expect(gfs.current.windSpeed).toBe(13);
        expect(ecmwf.current.windSpeed).toBe(7);
        expect(m.save).toHaveBeenCalledTimes(1);
        expect(m.save.mock.calls[0][1].modelUsed).toContain('gfs_seamless');
        ecmwf.current.windSpeed = 999;
        expect(same.current.windSpeed).toBe(7);
    });
    it('separates accounts and never caches a previous-account result', async () => {
        const ready = deferred<void>();
        m.ready.mockReturnValue(ready.promise);
        const first = fetchWeatherByStrategy(...args, 'offshore');
        m.user = { id: 'other-skipper' };
        const second = fetchWeatherByStrategy(...args, 'offshore');
        ready.resolve();
        await Promise.all([first, second]);
        expect(m.unified.mock.calls.map((call) => call[3])).toEqual(['skipper', 'other-skipper']);
        expect(m.save).toHaveBeenCalledTimes(1);
    });
    it('refuses a different-domain offline cache and clears expired marine from matching stale atmosphere', async () => {
        m.unified.mockResolvedValue(null);
        m.om.mockResolvedValue(null);
        m.marine.mockResolvedValue(null);
        m.offline.mockReturnValue({ data: atmosphere('om:gfs_seamless+marine-v2'), ageMinutes: 30 });
        await expect(fetchWeatherByStrategy(...args, 'offshore')).rejects.toThrow('All weather APIs failed');
        m.offline.mockReturnValue({ data: atmosphere('om:ecmwf_ifs025+marine-v2', 7), ageMinutes: 30 });
        const stale = await fetchWeatherByStrategy(...args, 'offshore');
        expect(stale._stale).toBe(true);
        expect(stale._staleAgeMinutes).toBe(30);
        expect(stale.current.waveHeight).toBeNull();
        expect(stale.current.windSpeed).toBe(7);
    });
    it('precision fallback never revives a legacy paid cache', async () => {
        m.cached.mockReturnValue(atmosphere('stormglass_ecmwf'));
        await fetchPrecisionWeather(args[2], { lat: args[0], lon: args[1] }, false, 'offshore');
        expect(m.om).toHaveBeenCalledWith(...args, false, 'ecmwf_ifs025');
        expect(m.sg).not.toHaveBeenCalled();
        expect(m.cached).not.toHaveBeenCalled();
    });
    it('quick point forecasts also clear unknown sea and obsolete alerts', async () => {
        m.marine.mockResolvedValue(null);
        const result = await fetchFastWeather(args[2], { lat: args[0], lon: args[1] });
        expect(m.om).toHaveBeenCalledWith(...args, true, 'best_match');
        expect(result.current.waveHeight).toBeNull();
        expect(result.alerts).not.toContain('Obsolete sea alert');
        expect(m.sg).not.toHaveBeenCalled();
    });
});
