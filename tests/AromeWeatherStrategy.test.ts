import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarineWeatherReport, OffshoreModel, WeatherModel } from '../types';
import {
    aromePointFixture,
    AROME_TEST_POINT as point,
    AROME_TEST_RUN as run,
    AROME_TEST_MODEL as model,
} from './fixtures/arome142';
import { mapMarineModelV2 } from '../services/weather/marineModelV2';
import { marineEnvelopeV2 } from '../supabase/functions/_shared/marine-v2';
import { marineFixtureSource } from './fixtures/marineV2141';
const now = run + 3600_000;
const m = vi.hoisted(() => ({
    settings: {
        forecastModel: 'best_local' as WeatherModel,
        offshoreModel: 'ecmwf' as OffshoreModel,
        satelliteMode: false,
    },
    user: { id: 'one' },
    om: vi.fn(),
    unified: vi.fn(),
    wk: vi.fn(),
    local: vi.fn(),
    marine: vi.fn(),
    save: vi.fn(),
    ready: vi.fn(),
}));
vi.mock('../stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({ settings: m.settings }) } }));
vi.mock('../stores/authStore', () => ({ useAuthStore: { getState: () => ({ user: m.user }) } }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => false } }));
vi.mock('../services/PiCacheService', () => ({ piCache: { awaitReady: m.ready } }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => m.settings.satelliteMode }));
vi.mock('../services/weather/api/openmeteo', () => ({ fetchOpenMeteo: m.om }));
vi.mock('../services/weather/aromeSource', () => ({ fetchOwnAromePoint: m.local }));
vi.mock('../services/weather/api/marineModel', () => ({ fetchMarineModelV2: m.marine }));
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
    fetchRealTides: async () => ({ tides: [] }),
    interpolateTideHourly: () => [],
}));
vi.mock('../services/weather/api/geocoding', () => ({
    parseLocation: vi.fn(),
    reverseGeocode: async () => 'Fictional point',
}));
vi.mock('../services/weather/api/buoys', () => ({ fetchActiveBuoys: vi.fn() }));
vi.mock('../services/weather/cache', () => ({ saveToCache: m.save, getFromCacheOffline: () => null }));
vi.mock('../services/weather/shelter', () => ({ assessShelter: async () => null }));
vi.mock('../services/weather/wxPublished', () => ({ announceCell: vi.fn() }));
vi.mock('../services/weather/spitfire', () => ({ fetchSpitfire: async () => null, applySpitfireToReport: vi.fn() }));
vi.mock('../services/weather/keys', () => ({
    getApiKeySuffix: vi.fn(),
    isStormglassKeyPresent: vi.fn(),
    debugStormglassConnection: vi.fn(),
    checkStormglassStatus: vi.fn(),
}));
vi.mock('../utils/flightRecorder', () => ({ crumb: vi.fn() }));
import { fetchFastWeather, fetchWeatherByStrategy } from '../services/weather';

function base(tag = 'weatherkit'): MarineWeatherReport {
    return {
        locationName: 'Fictional',
        coordinates: point,
        locationType: 'coastal',
        timeZone: 'Pacific/Noumea',
        generatedAt: new Date(now).toISOString(),
        modelUsed: tag,
        current: {
            windSpeed: 99,
            windGust: 180,
            windDirection: 'W',
            waveHeight: 99,
            swellPeriod: null,
            airTemperature: 30,
            description: 'Fictional',
            condition: 'Rain',
            precipitation: 10,
            uvIndex: 3,
            visibility: 8,
        },
        hourly: [],
        forecast: [],
        tides: [],
        boatingAdvice: '',
        alerts: [],
    };
}
function own() {
    const result = aromePointFixture();
    result.hourly.temperature_2m = Array(49).fill(22);
    return result;
}
function marine() {
    const p = { latitude: point.lat, longitude: point.lon };
    return mapMarineModelV2(
        marineEnvelopeV2(
            p,
            now,
            { ...marineFixtureSource('waves', now), ...p },
            { ...marineFixtureSource('motion', now), ...p },
        ),
        p,
        now,
        'pi',
    );
}
beforeEach(() => {
    vi.useFakeTimers({ now, toFake: ['Date'] });
    vi.clearAllMocks();
    m.settings = { forecastModel: 'best_local', offshoreModel: 'ecmwf', satelliteMode: false };
    m.user = { id: 'one' };
    m.ready.mockReset().mockResolvedValue(undefined);
    m.save.mockReset();
    m.om.mockReset().mockImplementation(async (_lat, _lon, _name, _fast, id) => {
        const result = base(`openmeteo_${id}`);
        result.current.uvIndex = null;
        result.current.visibility = null;
        return result;
    });
    m.unified.mockReset().mockImplementation(async () => base());
    m.wk.mockReset().mockResolvedValue(null);
    m.local.mockReset().mockImplementation(async () => own());
    m.marine.mockReset().mockImplementation(async () => marine());
});
afterEach(() => vi.useRealTimers());
const args = [point.lat, point.lon, 'Fictional'] as const;

describe('14206 explicit Best local orchestration', () => {
    it('uses the current original regional run with independent marine, while no own id/sentinel reaches paid models', async () => {
        const report = await fetchWeatherByStrategy(...args, 'coastal');
        expect(m.om).toHaveBeenCalledExactlyOnceWith(...args, false, 'dwd_icon');
        expect(m.local).toHaveBeenCalledExactlyOnceWith(model, point);
        expect(report.modelUsed).toBe(`arome:${model}+context+marine-v2`);
        expect(report.current.windSpeed).toBe(10);
        expect(report.current.windGust).toBeNull();
        expect(report.current.waveHeight).toBe(4.92);
        expect(report.current.currentSpeed).toBe(1);
        expect(report.hourly).toHaveLength(49);
        expect(report.forecast).toHaveLength(1);
        expect(report.forecastRunAt).toBe('2026-10-17T00:00:00Z');
        expect(m.save).toHaveBeenCalledOnce();
    });

    it.each(['dwd_icon', 'ecmwf_aifs025_single', 'best_match'] as const)(
        'preserves manual/Auto %s without a regional request',
        async (choice) => {
            m.settings.forecastModel = choice;
            const report = await fetchWeatherByStrategy(...args, 'coastal');
            expect(m.local).not.toHaveBeenCalled();
            expect(m.om.mock.calls[0][4]).toBe(choice);
            expect(report.modelUsed).not.toContain('arome:');
            expect(m.settings.forecastModel).toBe(choice);
        },
    );

    it('keeps the offshore preference authoritative and does not apply local data inland/outside its original domain', async () => {
        m.settings.offshoreModel = 'gfs';
        const offshore = await fetchWeatherByStrategy(...args, 'offshore');
        expect(m.om.mock.calls[0][4]).toBe('gfs_seamless');
        expect(offshore.modelUsed).toContain('gfs_seamless');
        await fetchWeatherByStrategy(...args, 'inland');
        await fetchWeatherByStrategy(-27, 153, 'Fictional Queensland', 'coastal');
        expect(m.local).not.toHaveBeenCalled();
    });

    it.each(['unavailable', 'temperature-gap', 'expired'] as const)(
        'labels the real global fallback for %s local data',
        async (reason) => {
            m.local.mockImplementation(async () => {
                if (reason === 'unavailable') return null;
                const result = own();
                if (reason === 'temperature-gap') result.hourly.temperature_2m[5] = null;
                else result.runUtc = '2026-10-16T00:00:00Z';
                return result;
            });
            const report = await fetchWeatherByStrategy(...args, 'coastal');
            expect(report.modelUsed).toBe('om:dwd_icon+wk+marine-v2');
            expect(report.current.windSpeed).toBe(99);
            expect(report.regionalAtmosphere).toBeUndefined();
            expect(m.settings.forecastModel).toBe('best_local');
        },
    );

    it('can use the actual regional run without any global provider when coastal classification is already known', async () => {
        m.om.mockResolvedValue(null);
        m.unified.mockResolvedValue(null);
        const report = await fetchWeatherByStrategy(...args, 'coastal');
        expect(report.current.windSpeed).toBe(10);
        expect(report.current.uvIndex).toBeNull();
        expect(report.modelUsed).toBe(`arome:${model}+marine-v2`);
        expect(report.current.sunrise).toMatch(/^\d\d:\d\d$/);
    });

    it('retires late regional adoption and cache writes across an account or preference change', async () => {
        let resolve!: (value: ReturnType<typeof own>) => void;
        m.local.mockReturnValue(
            new Promise((done) => {
                resolve = done;
            }),
        );
        const pending = fetchWeatherByStrategy(...args, 'coastal');
        await vi.waitFor(() => expect(m.local).toHaveBeenCalledOnce());
        m.user = { id: 'other' };
        m.settings.forecastModel = 'ecmwf_ifs025';
        resolve(own());
        const report = await pending;
        expect(report.modelUsed).not.toContain('arome:');
        expect(m.save).not.toHaveBeenCalled();
    });

    it('routes the legacy quick Best local choice through the qualified reader; Satellite never fans out', async () => {
        const report = await fetchFastWeather('Fictional', point, 'best_local');
        expect(report.modelUsed).toContain(`arome:${model}`);
        m.local.mockClear();
        m.om.mockClear();
        m.settings.satelliteMode = true;
        await fetchWeatherByStrategy(...args, 'coastal');
        expect(m.local).not.toHaveBeenCalled();
        expect(m.om).not.toHaveBeenCalled();
    });
});
