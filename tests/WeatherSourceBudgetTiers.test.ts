/** Exercise the actual orchestrator; no independent mirror of its tiering. */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MarineWeatherReport } from '../types';
const m = vi.hoisted(() => ({
    delays: { unified: 570, tides: 2318, openmeteo: 2477, marine: 6509, weatherkit: 569 },
    native: false,
    marine: vi.fn(),
    unified: vi.fn(),
    om: vi.fn(),
    tides: vi.fn(),
    wk: vi.fn(),
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: { forecastModel: 'dwd_icon', offshoreModel: 'auto' } }) },
}));
vi.mock('../stores/authStore', () => ({ useAuthStore: { getState: () => ({ user: { id: 'budget-fixture' } }) } }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => m.native } }));
vi.mock('../services/PiCacheService', () => ({ piCache: { awaitReady: async () => {} } }));
vi.mock('../services/weather/api/unified', () => ({ fetchUnifiedWeather: m.unified }));
vi.mock('../services/weather/api/openmeteo', () => ({ fetchOpenMeteo: m.om }));
vi.mock('../services/weather/api/tides', () => ({ fetchRealTides: m.tides, interpolateTideHourly: () => [] }));
vi.mock('../services/weather/api/weatherkit', () => ({
    fetchWeatherKitFull: m.wk,
    buildReportFromWeatherKit: (data: unknown) => data,
}));
vi.mock('../services/weather/api/marineModel', () => ({ fetchMarineModelV2: m.marine }));
vi.mock('../services/weather/shelter', () => ({ assessShelter: async () => null }));
vi.mock('../services/weather/wxPublished', () => ({ announceCell: () => {} }));
vi.mock('../services/weather/spitfire', () => ({ fetchSpitfire: async () => null, applySpitfireToReport: () => {} }));
vi.mock('../services/weather/cache', () => ({ saveToCache: () => {}, getFromCacheOffline: () => null }));
vi.mock('../services/weather/keys', () => ({
    getApiKeySuffix: () => '',
    isStormglassKeyPresent: () => false,
    debugStormglassConnection: () => {},
    checkStormglassStatus: () => {},
}));
vi.mock('../utils/flightRecorder', () => ({ crumb: () => {} }));
import { fetchWeatherByStrategy } from '../services/weather';
const report = () =>
    ({
        locationName: 'Fictional source-budget point',
        locationType: 'coastal',
        coordinates: { lat: -27, lon: 153 },
        current: { windSpeed: 12, windDirection: 'N', waveHeight: 20, condition: 'Sunny' },
        hourly: [],
        forecast: [],
        tides: [],
        timeZone: 'UTC',
        utcOffset: 0,
        generatedAt: new Date().toISOString(),
        modelUsed: 'openmeteo_dwd_icon',
        boatingAdvice: '',
        alerts: [],
    }) as unknown as MarineWeatherReport;
function source<T>(delay: number, value: T) {
    return new Promise<T>((resolve) => setTimeout(() => resolve(value), delay));
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
    m.native = false;
    m.delays = { unified: 570, tides: 2318, openmeteo: 2477, marine: 6509, weatherkit: 569 };
    m.unified.mockImplementation(() => source(m.delays.unified, report()));
    m.om.mockImplementation(() => source(m.delays.openmeteo, report()));
    m.marine.mockImplementation(() => source(m.delays.marine, null));
    m.tides.mockImplementation(() => source(m.delays.tides, { tides: [] }));
    m.wk.mockImplementation(() => source(m.delays.weatherkit, null));
});
afterEach(() => vi.useRealTimers());
async function elapsed(location: 'coastal' | 'offshore' = 'coastal') {
    const started = Date.now();
    const pending = fetchWeatherByStrategy(-27, 153, 'Fictional source-budget point', location).then((data) => ({
        elapsed: Date.now() - started,
        data,
    }));
    await vi.runAllTimersAsync();
    return pending;
}
describe('actual weather source budget tiers', () => {
    it('cuts slow marine1.5s after the actual essential tier, retaining the original caps', async () => {
        const result = await elapsed();
        expect(result.elapsed).toBe(2477 + 1500);
        expect(result.data.current.waveHeight).toBeNull();
        expect(m.marine).toHaveBeenCalledTimes(1);
    });
    it('keeps an independently slow marine response within the same grace offshore', async () => {
        m.delays = { unified: 500, tides: 600, openmeteo: 700, marine: 6509, weatherkit: 500 };
        expect((await elapsed('offshore')).elapsed).toBe(700 + 1500);
        expect(m.om).toHaveBeenCalledWith(-27, 153, 'Fictional source-budget point', false, 'ecmwf_ifs025');
    });
    it('does not cut marine on a uniformly slow network before the essential-relative grace', async () => {
        m.delays = { unified: 4300, tides: 4500, openmeteo: 4600, marine: 4900, weatherkit: 4200 };
        expect((await elapsed()).elapsed).toBe(4900);
    });
    it('never cuts an essential atmosphere at the supplementary grace', async () => {
        m.delays = { unified: 100, tides: 100, openmeteo: 5000, marine: 100, weatherkit: 100 };
        expect((await elapsed()).elapsed).toBe(5000);
    });
    it('retains the8s outer budget for a stalled essential source', async () => {
        m.delays = { unified: 500, tides: 600, openmeteo: 60000, marine: 100, weatherkit: 100 };
        const result = await elapsed();
        expect(result.elapsed).toBe(8000);
        expect(result.data.modelUsed).toBe('wk');
    });
    it('does not wait on an unused native fallback once the actual report sources answer', async () => {
        m.native = true;
        m.delays = { unified: 500, tides: 600, openmeteo: 700, marine: 100, weatherkit: 60000 };
        expect((await elapsed()).elapsed).toBe(700);
        expect(m.wk).toHaveBeenCalledTimes(1);
    });
    it('bounds a needed parallel native fallback at8s without a second serial retry', async () => {
        m.native = true;
        m.delays = { unified: 500, tides: 600, openmeteo: 700, marine: 100, weatherkit: 60000 };
        m.unified.mockImplementation(() => source(m.delays.unified, null));
        expect((await elapsed()).elapsed).toBe(8000);
        expect(m.wk).toHaveBeenCalledTimes(1);
    });
});
