import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { marineFixture, wxFixture } from './fixtures/wxPublishedFixture';
const mocks = vi.hoisted(() => ({
    single: null as unknown,
    filters: [] as [string, string][],
    proxy: vi.fn(),
    marine: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({ CapacitorHttp: {}, Capacitor: { isNativePlatform: () => false } }));
vi.mock('../services/supabase', () => ({
    supabase: {
        from: () => ({
            select: () => ({
                eq: (key: string, value: string) => {
                    mocks.filters.push([key, value]);
                    return {
                        eq: (key: string, value: string) => {
                            mocks.filters.push([key, value]);
                            return { maybeSingle: () => Promise.resolve({ data: mocks.single, error: null }) };
                        },
                    };
                },
            }),
        }),
    },
}));
vi.mock('../services/weather/openMeteoProxy', () => ({ fetchOpenMeteoProxy: mocks.proxy }));
vi.mock('../services/weather/marineProximity', () => ({ checkMarineProximity: mocks.marine }));
vi.mock('../services/weather/api/tides', () => ({ fetchRealTides: vi.fn(async () => null) }));
vi.mock('../services/weather/api/geocoding', () => ({ reverseGeocodeContext: vi.fn(async () => null) }));

beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ now: new Date('2026-10-17T00:30:00Z'), toFake: ['Date'] });
    const fixture = wxFixture();
    mocks.single = { payload: fixture.payload, run_at: fixture.runAt.replace('Z', '+00:00') };
    mocks.filters = [];
    mocks.proxy.mockReset();
    mocks.proxy.mockResolvedValue(fixture.payload);
    mocks.marine.mockReset();
    mocks.marine.mockResolvedValue({ hasMarineData: true, nearestWaterDistanceKm: 0, data: marineFixture() });
});
afterEach(() => vi.useRealTimers());

describe('wx v2 published-first atmospheric path', () => {
    it('uses the retained forecast at midnight without a proxy call and aligns fresh UTC marine hours', async () => {
        const { fetchOpenMeteo } = await import('../services/weather/api/openmeteo');
        const report = await fetchOpenMeteo(-27.2, 153.1, 'Newport', false, 'dwd_icon');
        expect(mocks.proxy).not.toHaveBeenCalled();
        expect(mocks.filters).toContainEqual(['model', 'wx2:dwd_icon']);
        expect(mocks.marine).toHaveBeenCalledWith(-27.2, 153.1, 'UTC');
        expect(report.forecastSampling).toBe('quarter-degree-cell');
        expect(report.forecastRunAt).toBe(wxFixture().runAt.replace('Z', '+00:00'));
        expect(report.modelUsed).toBe('wx_dwd_icon');
        expect(report.current.windSpeed).toBeCloseTo(18.4); // Hour24=34 km/h, not old current200.
        expect(report.current.windGust).toBeNull();
        expect(report.hourly?.[0].time).toBe('2026-10-17T00:00:00.000Z');
        expect(report.hourly?.[0].waveHeight).toBeCloseTo(3.28084); // Fresh marine hour0, not hour24.
        expect(report.forecast[0].isoDate).toBe('2026-10-17');
        expect(report.forecast[0].highTemp).toBe(26);
        expect(report.forecast[0].waveHeight).toBe(4); // Max1.23m; wrong raw daily99m ignored.
    });
    it('keeps missing humidity/feels-like and gusts absent instead of inventing zero', async () => {
        const fixture = wxFixture();
        fixture.payload.hourly.relative_humidity_2m.fill(null);
        mocks.single = { payload: fixture.payload, run_at: fixture.runAt };
        const { fetchOpenMeteo } = await import('../services/weather/api/openmeteo');
        const report = await fetchOpenMeteo(-27.2, 153.1, 'Newport', false, 'dwd_icon');
        expect(report.current.humidity).toBeNull();
        expect(report.current.feelsLike).toBeNull();
        expect(report.hourly?.[0].feelsLike).toBeUndefined();
        expect(report.current.windGust).toBeNull();
    });
    it('withholds marine values when their UTC axis cannot be verified', async () => {
        mocks.marine.mockResolvedValue({
            hasMarineData: true,
            nearestWaterDistanceKm: 0,
            data: { hourly: { wave_height: [9] }, daily: { wave_height_max: [9] } },
        });
        const { fetchOpenMeteo } = await import('../services/weather/api/openmeteo');
        const report = await fetchOpenMeteo(-27.2, 153.1, 'Newport', false, 'dwd_icon');
        expect(report.current.waveHeight).toBeNull();
        expect(report.hourly?.[0].waveHeight).toBeNull();
        expect(report.forecast[0].waveHeight).toBeNull();
    });
    it('falls through to the paid proxy for malformed source evidence', async () => {
        const bad = wxFixture();
        bad.payload.thalassa_provenance.source = 'other';
        mocks.single = { payload: bad.payload, run_at: bad.runAt };
        const { fetchOpenMeteo } = await import('../services/weather/api/openmeteo');
        const report = await fetchOpenMeteo(-27.2, 153.1, 'Newport', false, 'dwd_icon');
        expect(mocks.proxy).toHaveBeenCalledOnce();
        expect(mocks.marine).toHaveBeenCalledWith(-27.2, 153.1, 'auto');
        expect(report.forecastSampling).toBeUndefined();
    });
    it('never accepts coarse evidence for requested IFS9km', async () => {
        const { fetchOpenMeteo } = await import('../services/weather/api/openmeteo');
        const report = await fetchOpenMeteo(-27.2, 153.1, 'Newport', false, 'ecmwf_ifs');
        expect(mocks.filters).toContainEqual(['model', 'ecmwf_ifs']);
        expect(mocks.proxy).toHaveBeenCalledWith('forecast', expect.objectContaining({ models: 'ecmwf_ifs' }));
        expect(report.forecastSampling).toBeUndefined();
    });
    it('makes repaired GFS seamless usable through its real identity', async () => {
        const fixture = wxFixture('gfs_seamless');
        mocks.single = { payload: fixture.payload, run_at: fixture.runAt };
        const { fetchOpenMeteo } = await import('../services/weather/api/openmeteo');
        const report = await fetchOpenMeteo(-27.2, 153.1, 'Newport', false, 'gfs_seamless');
        expect(mocks.proxy).not.toHaveBeenCalled();
        expect(report.modelUsed).toBe('wx_gfs_seamless');
        expect(mocks.filters).toContainEqual(['model', 'wx2:gfs_seamless']);
    });
    it('reprojects across midnight even when the five-minute report memo has not expired', async () => {
        vi.setSystemTime(new Date('2026-10-16T23:59:00Z'));
        mocks.marine.mockResolvedValue({
            hasMarineData: true,
            nearestWaterDistanceKm: 0,
            data: marineFixture('2026-10-16T00:00:00Z'),
        });
        const { fetchOpenMeteo } = await import('../services/weather/api/openmeteo');
        const before = await fetchOpenMeteo(-27.2, 153.1, 'Newport', false, 'dwd_icon');
        expect(before.forecast[0].isoDate).toBe('2026-10-16');
        vi.setSystemTime(new Date('2026-10-17T00:01:00Z'));
        mocks.marine.mockResolvedValue({ hasMarineData: true, nearestWaterDistanceKm: 0, data: marineFixture() });
        const after = await fetchOpenMeteo(-27.2, 153.1, 'Newport', false, 'dwd_icon');
        expect(after.forecast[0].isoDate).toBe('2026-10-17');
        expect(after.current.windSpeed).toBeCloseTo(18.4);
        expect(mocks.filters.filter(([key]) => key === 'model')).toHaveLength(2);
    });
});
