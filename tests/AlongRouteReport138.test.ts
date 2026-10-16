import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CatalogueResult } from '../services/marineCatalogue/service';
import type { MarinePlace } from '../services/marineCatalogue/schema';
const h = vi.hoisted(() => ({
    settings: {
        activeVesselId: 'boat-a',
        settings: { vessel: { type: 'sail', draft: 2, airDraft: 18 }, satelliteMode: false },
    },
    listeners: new Set<() => void>(),
    charts: new Set<() => void>(),
    chartVersion: 1,
    cacheEpoch: 0,
    catalogue: vi.fn(),
    bridges: vi.fn(),
    weather: vi.fn(),
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => h.settings,
        subscribe: (fn: () => void) => {
            h.listeners.add(fn);
            return () => h.listeners.delete(fn);
        },
    },
}));
vi.mock('../services/enc/EncCellMetadata', () => ({
    getVersion: () => h.chartVersion,
    subscribe: (fn: () => void) => {
        h.charts.add(fn);
        return () => h.charts.delete(fn);
    },
}));
vi.mock('../services/marineCatalogue/cache', () => ({ catalogueCacheEpoch: () => h.cacheEpoch }));
vi.mock('../services/marineCatalogue/service', () => ({ loadMarineCells: h.catalogue }));
vi.mock('../services/enc/readAlongRouteBridges', () => ({ readAlongRouteBridges: h.bridges }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => h.settings.settings.satelliteMode }));
vi.mock('../services/routeMeteogramWeather', () => ({ loadRouteMeteogram: h.weather }));
import { loadAlongRouteReport } from '../services/routing/loadAlongRouteReport';
import { clearAlongRouteReport, getAlongRouteReport, nextAlongRouteRow } from '../stores/alongRouteReportStore';
import { WindStore } from '../stores/WindStore';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const T = Date.parse('2026-10-17T06:00:00Z');
const input = () => ({
    points: [
        { lat: 0, lon: 0 },
        { lat: 0, lon: 0.02 },
    ],
    identity: 'synthetic-route-a',
    departureMs: T,
    speedKts: 6,
});
const options = () => ({ signal: new AbortController().signal, isCurrent: () => true });
const point = (id = 'osm-node1'): MarinePlace => ({
    id,
    name: 'Fictional marina',
    kind: 'marina',
    facilityKinds: ['marina'],
    lat: 0,
    lon: 0.01,
    country: '',
    aliases: [],
    approximate: false,
});
function result(dataset: string): CatalogueResult {
    return {
        records: dataset === 'facilities' ? [point()] : [],
        manifests: [
            {
                schema: 1,
                dataset: dataset as 'facilities',
                generation: 'synthetic138',
                builtAt: '2026-10-16T00:00:00Z',
                sourceAt: '2026-10-15T00:00:00Z',
                coverage: 'Fictional regional source only',
                count: 1,
                licence: 'https://opendatacommons.org/licenses/odbl/1-0/',
                sourceUrl: 'https://download.geofabrik.de/',
                shards: [],
            },
        ],
        partial: false,
        cachedOnly: true,
    };
}
const changed = () => h.listeners.forEach((fn) => fn());
beforeEach(() => {
    vi.clearAllMocks();
    clearAlongRouteReport();
    h.settings = {
        activeVesselId: 'boat-a',
        settings: { vessel: { type: 'sail', draft: 2, airDraft: 18 }, satelliteMode: false },
    };
    h.chartVersion = 1;
    h.cacheEpoch = 0;
    WindStore.reset();
    setAuthIdentityScope('synthetic-owner');
    h.catalogue.mockImplementation(async (_keys, datasets) => result(datasets[0]));
    h.bridges.mockResolvedValue({
        records: [],
        complete: false,
        chartVersion: 1,
        note: 'No installed chart coverage; bridges unknown.',
    });
    h.weather.mockImplementation(async ({ clock, identity }) => ({
        identity,
        rows: clock.positions.map(() => ({ windKts: null, windDeg: null, gustKts: null, pressureHpa: 1002 })),
        source: 'Fictional local grid',
        sourceRun: null,
        credit: 'Synthetic source',
        note: 'Coverage gaps stay unknown.',
    }));
});
afterEach(() => {
    clearAlongRouteReport();
    setAuthIdentityScope(null);
    vi.useRealTimers();
});
describe('explicit bounded route references', () => {
    it('uses cache-only public cells, complete local bridge reader and exact ETA aboard weather with no downloadModel', async () => {
        const report = await loadAlongRouteReport(input(), options());
        expect(h.catalogue).toHaveBeenCalledTimes(2);
        for (const call of h.catalogue.mock.calls) {
            expect(call[0].length).toBeLessThanOrEqual(16);
            expect(call[3]).toBe(true);
        }
        expect(h.bridges).toHaveBeenCalledOnce();
        expect(h.weather.mock.calls[0][0]).not.toHaveProperty('downloadModel');
        const clock = h.weather.mock.calls[0][0].clock;
        expect(clock.positions[0]).toMatchObject({ lat: 0, lon: 0.01, atMs: report.rows[0].etaMs });
        expect(report.rows[0].weather).toEqual({ windKts: null, windDeg: null, gustKts: null, pressureHpa: 1002 });
        expect(report.sources[2]).toMatchObject({ partial: true, sourceAt: null });
        expect(report.rows[0].etaMs).toBeCloseTo(T + (report.rows[0].alongNm / 6) * 3600000, 0);
        expect(getAlongRouteReport()).toBe(report);
        expect(nextAlongRouteRow(report, 0)?.id).toBe('facilities:osm-node1');
        expect(nextAlongRouteRow(report, null)).toBeNull();
    });
    it('leaves unpublished and incomplete coverage explicitly unknown, never empty-known', async () => {
        h.catalogue.mockResolvedValue({ records: [], manifests: [], partial: true, cachedOnly: true });
        const report = await loadAlongRouteReport(input(), options());
        expect(report.rows).toEqual([]);
        expect(report.sources.every((s) => s.partial)).toBe(true);
        expect(report.sources[0].coverage).toContain('coverage unknown');
        expect(h.weather).not.toHaveBeenCalled();
    });
    it('requires an explicit public download and refuses that before catalogue work in Satellite Mode', async () => {
        await loadAlongRouteReport({ ...input(), downloadPublic: true }, options());
        expect(h.catalogue.mock.calls.every((call) => call[3] === false)).toBe(true);
        h.catalogue.mockClear();
        h.settings.settings.satelliteMode = true;
        changed();
        await expect(loadAlongRouteReport({ ...input(), downloadPublic: true }, options())).rejects.toThrow(
            'Satellite Mode',
        );
        expect(h.catalogue).not.toHaveBeenCalled();
        await loadAlongRouteReport(input(), options());
        expect(h.catalogue.mock.calls.every((call) => call[3] === true)).toBe(true);
    });
    it.each([0, 101, Infinity])('refuses invalid speed %s before reference work', async (speedKts) => {
        await expect(loadAlongRouteReport({ ...input(), speedKts }, options())).rejects.toThrow('planned speed');
        expect(h.catalogue).not.toHaveBeenCalled();
    });
    it('keeps ETA and weather unknown without a stated departure or speed', async () => {
        const report = await loadAlongRouteReport({ ...input(), departureMs: null, speedKts: null }, options());
        expect(report.rows[0].etaMs).toBeNull();
        expect(report.rows[0].weather.windKts).toBeNull();
        expect(h.weather).not.toHaveBeenCalled();
    });
    it('rejects a changed route/departure/speed identity before a late public result can scan charts or publish', async () => {
        let resolve!: (v: CatalogueResult) => void,
            current = true;
        h.catalogue.mockImplementationOnce(
            () =>
                new Promise((done) => {
                    resolve = done;
                }),
        );
        const job = loadAlongRouteReport(input(), { ...options(), isCurrent: () => current });
        current = false;
        resolve(result('osm'));
        await expect(job).rejects.toThrow('stopped');
        expect(h.bridges).not.toHaveBeenCalled();
        expect(getAlongRouteReport()).toBeNull();
    });
    it('enforces one 30-second lifetime even if a dependency ignores its abort signal', async () => {
        vi.useFakeTimers();
        h.catalogue.mockImplementation(() => new Promise(() => {}));
        const job = loadAlongRouteReport(input(), options());
        const assertion = expect(job).rejects.toThrow('30 seconds');
        await vi.advanceTimersByTimeAsync(30001);
        await assertion;
        expect(h.bridges).not.toHaveBeenCalled();
        expect(getAlongRouteReport()).toBeNull();
    });
    it('fences same-tick boat A to B to A rather than reviving a late original result', async () => {
        h.catalogue.mockImplementation(() => new Promise(() => {}));
        const job = loadAlongRouteReport(input(), options());
        h.settings.activeVesselId = 'boat-b';
        changed();
        h.settings.activeVesselId = 'boat-a';
        changed();
        await expect(job).rejects.toThrow('stopped');
        expect(getAlongRouteReport()).toBeNull();
    });
    it('immediately retires RAM chart summaries after chart, account, vessel policy or wind source changes', async () => {
        await loadAlongRouteReport(input(), options());
        h.chartVersion++;
        h.charts.forEach((fn) => fn());
        expect(getAlongRouteReport()).toBeNull();
        await loadAlongRouteReport(input(), options());
        h.settings.settings.vessel.airDraft = 19;
        changed();
        expect(getAlongRouteReport()).toBeNull();
        await loadAlongRouteReport(input(), options());
        WindStore.setState({ field: 'gust' });
        expect(getAlongRouteReport()).toBeNull();
        await loadAlongRouteReport(input(), options());
        setAuthIdentityScope('other-owner');
        expect(getAlongRouteReport()).toBeNull();
    });
    it('refuses an oversized combined inventory before projection instead of presenting a truncated complete scan', async () => {
        h.catalogue.mockResolvedValue({
            ...result('facilities'),
            records: Array.from({ length: 10001 }, (_, i) => point(`osm-node${i + 1}`)),
        });
        await expect(loadAlongRouteReport(input(), options())).rejects.toThrow('10,000');
        expect(h.bridges).not.toHaveBeenCalled();
    });
});
