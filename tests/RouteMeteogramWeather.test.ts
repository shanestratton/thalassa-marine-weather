import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
    satellite: false,
    subscribers: new Set<() => void>(),
    fetch: vi.fn(),
    imported: vi.fn(),
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        subscribe: (cb: () => void) => {
            h.subscribers.add(cb);
            return () => h.subscribers.delete(cb);
        },
    },
}));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => h.satellite }));
vi.mock('../services/weather/openMeteoProxy', () => ({ fetchOpenMeteoPoints: h.fetch }));
vi.mock('../services/weather/localGribImport', () => ({ loadSelectedImportedGrib: h.imported }));
vi.mock('../services/weather/MultiModelWeatherService', () => ({
    AVAILABLE_MODELS: [{ id: 'icon', name: 'ICON', provider: 'DWD' }],
}));
import { buildRouteClock, HOUR } from '../services/routeMeteogram';
import { loadRouteMeteogram, sampleRouteHourly, type RouteHourlyPayload } from '../services/routeMeteogramWeather';
import { WindStore } from '../stores/WindStore';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import type { ImportedGribFile } from '../services/weather/gribImportTypes';
import type { WindGrid } from '../services/weather/windGridEncoding';

const T = Date.UTC(2026, 9, 16),
    clock = buildRouteClock(
        [
            { lat: 0.01, lon: 0.01 },
            { lat: 0.02, lon: 0.02 },
        ],
        T + HOUR / 2,
        6,
    );
function payload(): RouteHourlyPayload {
    return {
        hourly_units: { wind_speed_10m: 'kn', wind_direction_10m: '°', wind_gusts_10m: 'kn', pressure_msl: 'hPa' },
        hourly: {
            time: [T / 1000, T / 1000 + 3600],
            wind_speed_10m: [10, 10],
            wind_direction_10m: [350, 10],
            wind_gusts_10m: [15, 17],
            pressure_msl: [1000, 1002],
        },
    };
}
const input = () => ({ clock, identity: 'synthetic-full-route', performance: null });
const options = () => ({ signal: new AbortController().signal, isCurrent: () => true });
const grid = (): WindGrid => ({
    width: 2,
    height: 2,
    north: 1,
    south: -1,
    west: -1,
    east: 1,
    lats: [-1, 1],
    lons: [-1, 1],
    totalHours: 2,
    refTime: new Date(T).toISOString(),
    stepHours: [0, 1],
    u: [new Float32Array(4).fill(-5), new Float32Array(4).fill(-5)],
    v: [new Float32Array(4), new Float32Array(4)],
    speed: [new Float32Array(4).fill(5), new Float32Array(4).fill(5)],
});

beforeEach(() => {
    vi.clearAllMocks();
    h.satellite = false;
    h.imported.mockResolvedValue(null);
    h.fetch.mockResolvedValue([payload()]);
    WindStore.reset();
    setAuthIdentityScope('route-weather-fixture');
});
afterEach(() => {
    vi.useRealTimers();
    setAuthIdentityScope(null);
});

describe('strict forecast UTC coverage and units', () => {
    it('interpolates vectors across north, not through a southerly, with actual UTC', () => {
        const row = sampleRouteHourly(payload(), T + HOUR / 2);
        expect(row.windDeg === 0 || row.windDeg === 360).toBe(true);
        expect(row.windKts).toBeCloseTo(9.848, 3);
        expect(row.gustKts).toBe(16);
        expect(row.pressureHpa).toBe(1001);
    });
    it('never borrows the first or last hour or interpolates over an absent hourly knot', () => {
        expect(sampleRouteHourly(payload(), T - 1).windKts).toBeNull();
        expect(sampleRouteHourly(payload(), T + HOUR + 1).windKts).toBeNull();
        const data = payload();
        data.hourly!.time = [T / 1000, T / 1000 + 3 * 3600];
        expect(sampleRouteHourly(data, T + HOUR).windKts).toBeNull();
        expect(sampleRouteHourly(data, T).windKts).toBe(10);
    });
    it.each([null, '', false, NaN])('keeps invalid/null numbers %j unknown rather than calm', (bad) => {
        const data = payload();
        data.hourly!.wind_speed_10m = [bad, 10];
        expect(sampleRouteHourly(data, T).windKts).toBeNull();
    });
    it('refuses mismatched or missing units and malformed clocks', () => {
        const data = payload();
        data.hourly_units!.wind_speed_10m = 'km/h';
        expect(sampleRouteHourly(data, T).windKts).toBeNull();
        data.hourly!.time = ['2026-10-16T00:00', '2026-10-16T01:00'];
        expect(sampleRouteHourly(data, T).pressureHpa).toBeNull();
    });
});

describe('local-first explicit route weather', () => {
    it('uses a loaded sustained-wind grid without making a provider call', async () => {
        WindStore.setState({ grid: grid(), model: 'icon', field: 'wind' });
        const report = await loadRouteMeteogram(input(), options());
        expect(report?.rows[0].windKts).toBeCloseTo(9.71922);
        expect(report?.source).toContain('ICON');
        expect(report?.credit).toContain('DWD');
        expect(h.fetch).not.toHaveBeenCalled();
    });
    it('never relabels an imported grid when its active account-owned import was not confirmed', async () => {
        WindStore.setState({ grid: { ...grid(), importedGrib: true }, model: 'icon', field: 'wind' });
        const report = await loadRouteMeteogram(input(), options());
        expect(report?.source).toBe('No covered weather aboard');
        expect(report?.rows.every((row) => row.windKts === null)).toBe(true);
        expect(h.fetch).not.toHaveBeenCalled();
    });
    it('a selected imported pressure-only file never borrows another model’s wind', async () => {
        WindStore.setState({ grid: grid(), model: 'icon' });
        const file: ImportedGribFile = {
            edition: 1,
            refTime: new Date(T).toISOString(),
            source: { centre: 7, subcentre: 0, process: 81, parameterTable: 2 },
            wind: null,
            ignoredMessages: 0,
            pressure: {
                ...grid(),
                frames: [new Float32Array(4).fill(1000), new Float32Array(4).fill(1002)],
                stepHours: [0, 1],
                refTime: new Date(T).toISOString(),
            },
        };
        h.imported.mockResolvedValue({ file, fingerprint: 'synthetic-hash' });
        const report = await loadRouteMeteogram(input(), options());
        expect(report?.source).toBe('Imported GRIB');
        expect(report?.rows[0].windKts).toBeNull();
        expect(report?.rows[0].pressureHpa).toBe(1001);
        expect(report?.credit).toContain('centre 7');
        expect(h.fetch).not.toHaveBeenCalled();
    });
    it('gust fields and missing clocks stay unknown with no automatic WAN fallback', async () => {
        WindStore.setState({ grid: grid(), field: 'gust' });
        expect((await loadRouteMeteogram(input(), options()))?.rows[0].windKts).toBeNull();
        WindStore.setState({ grid: { ...grid(), refTime: undefined }, field: 'wind' });
        const report = await loadRouteMeteogram(input(), options());
        expect(report?.rows[0].windKts).toBeNull();
        expect(report?.sourceRun).toBeNull();
        expect(h.fetch).not.toHaveBeenCalled();
    });
    it('only an explicit named-model request leaves aboard, using deduplicated public buckets', async () => {
        const report = await loadRouteMeteogram({ ...input(), downloadModel: 'dwd_icon' }, options());
        expect(h.fetch).toHaveBeenCalledOnce();
        const [operation, points, params, concurrency, signal] = h.fetch.mock.calls[0];
        expect(operation).toBe('forecast');
        expect(points).toEqual([{ lat: 0, lon: 0 }]);
        expect(JSON.stringify(points)).not.toContain('.01');
        expect(params.models).toBe('dwd_icon');
        expect(params.timeformat).toBe('unixtime');
        expect(params.timezone).toBe('UTC');
        expect(concurrency).toBe(2);
        expect(signal).toBeInstanceOf(AbortSignal);
        expect(report?.rows[0].pressureHpa).toBe(1001);
        expect(report?.sourceRun).toBeNull();
    });
    it('caps request cost before querying an ocean crossing, and never uses Auto as a model', async () => {
        const long = buildRouteClock(
            [
                { lat: 0, lon: 0 },
                { lat: 0, lon: 100 },
            ],
            T,
            12,
        );
        await expect(
            loadRouteMeteogram({ ...input(), clock: long, downloadModel: 'dwd_icon' }, options()),
        ).rejects.toThrow(/48 public/);
        await expect(loadRouteMeteogram({ ...input(), downloadModel: 'best_match' }, options())).rejects.toThrow(
            /named/,
        );
        expect(h.fetch).not.toHaveBeenCalled();
    });
    it('Satellite Mode allows local reuse and blocks the explicit bulk request', async () => {
        h.satellite = true;
        WindStore.setState({ grid: grid(), field: 'wind' });
        expect((await loadRouteMeteogram(input(), options()))?.rows[0].windKts).not.toBeNull();
        expect(await loadRouteMeteogram({ ...input(), downloadModel: 'dwd_icon' }, options())).toBeNull();
        expect(h.fetch).not.toHaveBeenCalled();
    });
    it.each(['cancel', 'account', 'satellite'])('drops a late provider reply after %s', async (change) => {
        let finish!: (value: RouteHourlyPayload[]) => void;
        h.fetch.mockReturnValue(
            new Promise<RouteHourlyPayload[]>((resolve) => {
                finish = resolve;
            }),
        );
        const controller = new AbortController();
        const result = loadRouteMeteogram(
            { ...input(), downloadModel: 'dwd_icon' },
            { signal: controller.signal, isCurrent: () => true },
        );
        if (change === 'cancel') controller.abort();
        if (change === 'account') setAuthIdentityScope('other-synthetic-account');
        if (change === 'satellite') {
            h.satellite = true;
            for (const cb of h.subscribers) cb();
        }
        expect(await result).toBeNull();
        finish([payload()]);
        await Promise.resolve();
        expect(h.fetch.mock.calls[0][4].aborted).toBe(true);
    });
    it('does not attach a previous grid after its actual WindStore source changes', async () => {
        WindStore.setState({ grid: grid(), model: 'icon', field: 'wind' });
        let finish!: (value: null) => void;
        h.imported.mockReturnValue(
            new Promise<null>((resolve) => {
                finish = resolve;
            }),
        );
        const result = loadRouteMeteogram(input(), options());
        WindStore.setState({ grid: grid(), model: 'ecmwf' });
        finish(null);
        expect(await result).toBeNull();
        expect(h.fetch).not.toHaveBeenCalled();
    });
    it('drops a local file result after geometry/source identity changes', async () => {
        let finish!: (value: null) => void,
            live = true;
        h.imported.mockReturnValue(
            new Promise<null>((resolve) => {
                finish = resolve;
            }),
        );
        const result = loadRouteMeteogram(input(), { signal: new AbortController().signal, isCurrent: () => live });
        live = false;
        finish(null);
        expect(await result).toBeNull();
    });
    it('has a real deadline even when a native transport ignores AbortSignal', async () => {
        vi.useFakeTimers();
        h.fetch.mockReturnValue(new Promise(() => undefined));
        const result = loadRouteMeteogram({ ...input(), downloadModel: 'dwd_icon' }, options());
        const assertion = expect(result).rejects.toThrow(/deadline/);
        await vi.advanceTimersByTimeAsync(20_001);
        await assertion;
        expect(h.fetch.mock.calls[0][4].aborted).toBe(true);
    });
});
