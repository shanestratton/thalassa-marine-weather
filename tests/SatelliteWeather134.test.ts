import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMPACT_NOW, compactFixture, compactSource } from './fixtures/compactWeatherFixture';

const m = vi.hoisted(() => ({
    settings: { satelliteMode: true, forecastModel: 'dwd_icon', offshoreModel: 'icon' },
    user: { id: 'skipper' },
    native: true,
    paired: false,
    fetch: vi.fn(),
    nativeWeather: vi.fn(),
    pinned: vi.fn(),
    piUrl: vi.fn(),
    headers: vi.fn(),
    om: vi.fn(),
    sg: vi.fn(),
    wk: vi.fn(),
    marine: vi.fn(),
    tides: vi.fn(),
    geocode: vi.fn(),
    cache: vi.fn(),
    offline: vi.fn(),
    save: vi.fn(),
    shelter: vi.fn(),
    announce: vi.fn(),
    spitfire: vi.fn(),
}));
vi.mock('../stores/settingsStore', () => ({ useSettingsStore: { getState: () => ({ settings: m.settings }) } }));
vi.mock('../stores/authStore', () => ({ useAuthStore: { getState: () => ({ user: m.user }) } }));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => m.native } }));
vi.mock('../services/native/weatherKit', () => ({ fetchWeatherKitNative: m.nativeWeather }));
vi.mock('../services/supabaseAuth', () => ({ getAuthenticatedFunctionHeaders: m.headers }));
vi.mock('../services/PiPairingService', () => ({ pinnedPiRequest: m.pinned }));
vi.mock('../services/PiCacheService', () => ({
    piCache: {
        canReachPinned: () => m.paired,
        unifiedWeatherUrl: m.piUrl,
        awaitReady: vi.fn(),
    },
}));
vi.mock('../services/weather/api/openmeteo', () => ({ fetchOpenMeteo: m.om }));
vi.mock('../services/weather/api/stormglass', () => ({ fetchStormGlassWeather: m.sg }));
vi.mock('../services/weather/api/weatherkit', () => ({
    fetchWeatherKitFull: m.wk,
    buildReportFromWeatherKit: vi.fn(),
    fetchWeatherKitRealtime: vi.fn(),
    fetchMinutelyRain: vi.fn(),
}));
vi.mock('../services/weather/api/marine', () => ({ fetchMarine: m.marine, isLocalReading: () => false }));
vi.mock('../services/weather/api/marineModel', () => ({ fetchMarineModelV2: m.marine }));
vi.mock('../services/weather/api/tides', () => ({ fetchRealTides: m.tides, interpolateTideHourly: vi.fn() }));
vi.mock('../services/weather/api/geocoding', () => ({ parseLocation: m.geocode, reverseGeocode: m.geocode }));
vi.mock('../services/weather/api/buoys', () => ({ fetchActiveBuoys: vi.fn() }));
vi.mock('../services/weather/cache', () => ({
    saveToCache: m.save,
    getFromCache: m.cache,
    getFromCacheOffline: m.offline,
}));
vi.mock('../services/weather/shelter', () => ({ assessShelter: m.shelter, dampReportWaves: vi.fn() }));
vi.mock('../services/weather/wxPublished', () => ({ announceCell: m.announce }));
vi.mock('../services/weather/spitfire', () => ({ fetchSpitfire: m.spitfire, applySpitfireToReport: vi.fn() }));
vi.mock('../services/weather/keys', () => ({
    getApiKeySuffix: vi.fn(),
    isStormglassKeyPresent: vi.fn(),
    debugStormglassConnection: vi.fn(),
    checkStormglassStatus: vi.fn(),
}));
vi.mock('../utils/flightRecorder', () => ({ crumb: vi.fn() }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(COMPACT_NOW);
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'synthetic-public-key');
    m.settings.satelliteMode = true;
    m.native = true;
    m.paired = false;
    m.user = { id: 'skipper' };
    m.headers.mockResolvedValue({ Authorization: 'Bearer synthetic-session', apikey: 'synthetic-public-key' });
    m.fetch.mockImplementation(async (url: string) => {
        const parsed = new URL(url);
        return new Response(
            JSON.stringify(
                compactFixture(Number(parsed.searchParams.get('lat')), Number(parsed.searchParams.get('lon'))),
            ),
            { headers: { 'content-type': 'application/json' } },
        );
    });
    m.piUrl.mockImplementation(
        (lat, lon, userId, compact) =>
            `https://pi.test/api/weather/unified?lat=${lat}&lon=${lon}&user_id=${userId}&minified=${compact ? '1' : '0'}`,
    );
    vi.stubGlobal('fetch', m.fetch);
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

function noFullProviders() {
    for (const fn of [
        m.nativeWeather,
        m.om,
        m.sg,
        m.wk,
        m.marine,
        m.tides,
        m.geocode,
        m.shelter,
        m.announce,
        m.spitfire,
    ])
        expect(fn).not.toHaveBeenCalled();
}

describe('compact Satellite forecast through the real client and orchestrator', () => {
    it('requests v2 compact with authenticated headers and skips full native WeatherKit and enrichment', async () => {
        const { fetchWeatherByStrategy } = await import('../services/weather');
        const report = await fetchWeatherByStrategy(-27.12, 153.12, 'Newport', 'offshore');
        expect(m.fetch).toHaveBeenCalledTimes(1);
        expect(new URL(m.fetch.mock.calls[0][0]).searchParams.get('minified')).toBe('1');
        expect(m.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer synthetic-session');
        expect(report.limitedForecast).toBe('satellite');
        expect(report.locationType).toBe('offshore');
        expect(report.hourly[0].time).toBe('2026-10-16T02:00:00.000Z');
        expect(report.hourly[0].windSpeed).toBeNull();
        expect(report.current.windSpeed).toBe(0);
        expect(report.current.waveHeight).toBeNull();
        expect(report.tides).toEqual([]);
        noFullProviders();
    });
    it('uses the pinned Pi compact URL and never calls WAN on a valid cache hit', async () => {
        m.paired = true;
        m.pinned.mockResolvedValue({
            status: 200,
            headers: { 'X-Cache': 'HIT' },
            data: JSON.stringify(compactFixture()),
        });
        const { fetchUnifiedWeatherRaw } = await import('../services/weather/api/unified');
        expect(await fetchUnifiedWeatherRaw(-27.12, 153.12, 'skipper')).not.toBeNull();
        expect(m.piUrl).toHaveBeenCalledWith(-27.12, 153.12, 'skipper', true);
        expect(m.pinned.mock.calls[0][0].url).toContain('minified=1');
        expect(m.fetch).not.toHaveBeenCalled();
        noFullProviders();
    });
    it('keeps compact/full, account and precise-position caches separate', async () => {
        m.native = false;
        const { fetchUnifiedWeatherRaw } = await import('../services/weather/api/unified');
        await fetchUnifiedWeatherRaw(-27.12, 153.12, 'skipper');
        await fetchUnifiedWeatherRaw(-27.12, 153.12, 'skipper');
        expect(m.fetch).toHaveBeenCalledTimes(1);
        await fetchUnifiedWeatherRaw(-27.12, 153.12, 'crew');
        await fetchUnifiedWeatherRaw(-27.121, 153.121, 'crew');
        expect(m.fetch).toHaveBeenCalledTimes(3);
        m.settings.satelliteMode = false;
        m.fetch.mockResolvedValue(new Response(JSON.stringify(compactSource(-27.121, 153.121))));
        const full = await fetchUnifiedWeatherRaw(-27.121, 153.121, 'crew');
        expect(full?.hourly).toHaveLength(48);
        expect(new URL(m.fetch.mock.calls[3][0]).searchParams.has('minified')).toBe(false);
        m.settings.satelliteMode = true;
        m.fetch.mockResolvedValue(new Response(JSON.stringify(compactFixture(-27.121, 153.121))));
        expect((await fetchUnifiedWeatherRaw(-27.121, 153.121, 'crew'))?.hourly).toHaveLength(24);
        expect(m.fetch).toHaveBeenCalledTimes(5);
    });
    it.each(['strategy', 'fast', 'precision'])(
        '%s refuses legacy compact with a visible error and no full-size fallback',
        async (kind) => {
            m.fetch.mockResolvedValue(new Response(JSON.stringify({ v: 1, c: { w: 0 }, h: [{ t: 0 }] })));
            const weather = await import('../services/weather');
            const promise =
                kind === 'strategy'
                    ? weather.fetchWeatherByStrategy(-27.12, 153.12, 'Newport')
                    : kind === 'fast'
                      ? weather.fetchFastWeather('Newport', { lat: -27.12, lon: 153.12 })
                      : weather.fetchPrecisionWeather('Newport', { lat: -27.12, lon: 153.12 }, true, 'offshore');
            await expect(promise).rejects.toThrow('Compact forecast unavailable');
            expect(m.fetch).toHaveBeenCalledTimes(1);
            noFullProviders();
        },
    );
    it('uses the public auth lane without sending an account entitlement hint', async () => {
        m.headers.mockRejectedValue(new Error('Signed out'));
        const { fetchUnifiedWeatherRaw } = await import('../services/weather/api/unified');
        expect(await fetchUnifiedWeatherRaw(-27.12, 153.12, 'untrusted-id')).not.toBeNull();
        expect(m.fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer synthetic-public-key');
        expect(new URL(m.fetch.mock.calls[0][0]).searchParams.has('user_id')).toBe(false);
    });
    it('rejects oversized streamed WAN JSON without a full retry', async () => {
        const cancel = vi.fn();
        const body = new ReadableStream({
            start(controller) {
                controller.enqueue(new Uint8Array(65_537));
            },
            cancel,
        });
        m.fetch.mockResolvedValue(new Response(body));
        const { fetchUnifiedWeatherRaw } = await import('../services/weather/api/unified');
        expect(await fetchUnifiedWeatherRaw(-27.12, 153.12)).toBeNull();
        expect(cancel).toHaveBeenCalledTimes(1);
        expect(m.fetch).toHaveBeenCalledTimes(1);
        noFullProviders();
    });
    it('rejects an oversized Pi string before JSON parsing, then requests only compact from WAN', async () => {
        m.paired = true;
        m.pinned.mockResolvedValue({ status: 200, headers: {}, data: ' '.repeat(65_537) });
        const { fetchUnifiedWeatherRaw } = await import('../services/weather/api/unified');
        expect(await fetchUnifiedWeatherRaw(-27.12, 153.12)).not.toBeNull();
        expect(new URL(m.fetch.mock.calls[0][0]).searchParams.get('minified')).toBe('1');
        noFullProviders();
    });
    it.each(['fast', 'precision'])('%s requires coordinates before a metered lookup', async (kind) => {
        const weather = await import('../services/weather');
        await expect(
            kind === 'fast' ? weather.fetchFastWeather('Newport') : weather.fetchPrecisionWeather('Newport'),
        ).rejects.toThrow('Choose a saved position');
        expect(m.fetch).not.toHaveBeenCalled();
        noFullProviders();
    });
});
