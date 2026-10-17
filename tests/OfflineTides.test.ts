import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { setAuthIdentityScope, authScopedStorageKey } from '../services/authIdentityScope';
const storage = vi.hoisted(() => new Map<string, unknown>());
const policy = vi.hoisted(() => ({ satellite: false }));
vi.mock('../services/nativeStorage', () => ({
    loadLargeData: vi.fn(async (k: string) => structuredClone(storage.get(k) ?? null)),
    saveLargeDataImmediate: vi.fn(async (k: string, v: unknown) => {
        storage.set(k, structuredClone(v));
    }),
}));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => policy.satellite }));
vi.mock('../services/supabaseAuth', () => ({
    getAuthenticatedFunctionHeaders: async () => ({
        'Content-Type': 'application/json',
        Authorization: 'Bearer session',
        apikey: 'public',
    }),
}));
vi.mock('../services/weather/openMeteoProxy', () => ({ fetchOpenMeteoProxy: vi.fn() }));
vi.mock('../services/tides/officialTides', () => ({ fetchOfficialTides: vi.fn(async () => null) }));
vi.mock('../services/weather/api/worldtides', () => ({ fetchWorldTides: vi.fn(async () => null) }));
import { loadLargeData, saveLargeDataImmediate } from '../services/nativeStorage';
import {
    OFFLINE_TIDE_KEY,
    listSavedTideTables,
    removeSavedTideTable,
    saveTideTable,
    tableFromStationDetails,
    savedTidesForPoint,
    validSavedTideTable,
} from '../services/tides/offlineTideStore';
import { tideDiscoveryPlan, discoverTideStations, prefetchTideTable } from '../services/tides/tidePrefetch';
import {
    fetchTideStationDetails,
    fetchNearbyTideStations,
    __resetTideStationDetailsForTests,
    type TideStation,
    type TideStationDetails,
} from '../services/tides/stationDetails';
import { fetchRealTides } from '../services/weather/api/tides';
import { fetchOfficialTides } from '../services/tides/officialTides';
import { fetchWorldTides } from '../services/weather/api/worldtides';
const NOW = Date.parse('2026-10-16T12:00:00Z'),
    DAY = 86400000;
const station: TideStation = { id: 'test', name: 'Public test port', lat: 0, lon: 0, distance: 0 };
const extremes = () =>
    Array.from({ length: 127 }, (_, i) => ({
        timeMs: NOW - DAY / 2 + (i * DAY) / 4,
        heightM: i % 2 ? -0.2 : 2.1,
        type: i % 2 ? ('Low' as const) : ('High' as const),
    }));
const detail = (): TideStationDetails => ({
    station,
    predictionLocation: { lat: 0, lon: 0 },
    predictionStationName: 'Actual port',
    datum: 'MSL',
    requestedDatum: 'LAT',
    timezone: 'UTC',
    fetchedAtMs: NOW,
    heights: [],
    extremes: extremes(),
    source: 'WorldTides',
    copyright: 'WorldTides fixture attribution',
    kind: 'prediction',
    wind: null,
});
const raw = () => ({
    status: 200,
    station: 'Actual port',
    responseLat: 0,
    responseLon: 0,
    responseDatum: 'MSL',
    requestDatum: 'LAT',
    copyright: 'WorldTides fixture attribution',
    extremes: extremes().map((e) => ({
        dt: e.timeMs / 1000,
        date: new Date(e.timeMs).toISOString(),
        height: e.heightM,
        type: e.type,
    })),
    thalassaWindow: {
        schema: 1,
        requestedDays: 30,
        start: (NOW - 1.5 * DAY) / 1000,
        end: (NOW + 30.5 * DAY) / 1000,
        fetchedAtMs: NOW,
    },
});
const fetcher = vi.fn();
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setAuthIdentityScope('11111111-1111-4111-8111-111111111111');
    storage.clear();
    policy.satellite = false;
    vi.clearAllMocks();
    fetcher.mockReset();
    vi.stubGlobal('fetch', fetcher);
    vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'public');
    __resetTideStationDetailsForTests();
});
afterEach(() => {
    setAuthIdentityScope(null);
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
});
describe('account-scoped persistent saved tide tables', () => {
    it('keeps an expired official generation as a separately labelled saved table, with no saved live observation', async () => {
        const official = {
            schema: 1 as const,
            provider: 'NOAA' as const,
            stationId: '9414290',
            stationName: 'Public reference fixture',
            lat: 0,
            lon: 0,
            datumId: 'noaa:9414290:MLLW',
            datumLabel: 'MLLW',
            rawDatum: 'MLLW',
            attribution: 'NOAA public fixture',
            sourceUrl: 'https://tidesandcurrents.noaa.gov/noaatidepredictions.html?id=9414290',
            licenceUrl: 'https://tidesandcurrents.noaa.gov/disclaimers.html',
            maxDistanceKm: 15,
            generatedAt: new Date(NOW).toISOString(),
            expiresAt: new Date(NOW + DAY).toISOString(),
            coverageStart: new Date(NOW - DAY / 2).toISOString(),
            coverageEnd: new Date(NOW + 15 * DAY).toISOString(),
            events: extremes()
                .slice(0, 63)
                .map((e) => ({ time: new Date(e.timeMs).toISOString(), type: e.type, heightM: e.heightM })),
        };
        vi.mocked(fetchOfficialTides).mockResolvedValueOnce(official);
        const live = await fetchRealTides(0, 0);
        expect(live.guiDetails?.source).toBe('official');
        const saved = (await listSavedTideTables())[0];
        expect(saved.official).toBe(true);
        expect(saved.sourceUrl).toContain('?id=9414290');
        expect('observation' in saved).toBe(false);
        vi.setSystemTime(NOW + 2 * DAY);
        policy.satellite = true;
        const offline = await fetchRealTides(0, 0);
        expect(offline.guiDetails?.source).toBe('saved-official');
        expect(offline.guiDetails?.expiresAt).toBeUndefined();
        expect(offline.guiDetails?.observation).toBeUndefined();
        expect(offline.guiDetails?.generatedAt).toBe(new Date(NOW).toISOString());
        expect(fetchWorldTides).not.toHaveBeenCalled();
    });
    it('persists a complete table, survives a cold memory read and never guesses LAT from the request', async () => {
        const table = tableFromStationDetails(detail())!;
        expect(table.datum).toBe('MSL');
        expect(await saveTideTable(table)).toBe(true);
        expect((await listSavedTideTables())[0]).toEqual(table);
        expect(storage.has(authScopedStorageKey(OFFLINE_TIDE_KEY))).toBe(true);
        expect((await savedTidesForPoint({ lat: 0, lon: 0 }))?.predictionLocation).toEqual({ lat: 0, lon: 0 });
        expect(await savedTidesForPoint({ lat: 0, lon: 0.1 })).toBeNull();
    });
    it('isolates identities, fences stale reads and verifies writes before success', async () => {
        await saveTideTable(tableFromStationDetails(detail())!);
        setAuthIdentityScope('22222222-2222-4222-8222-222222222222');
        expect(await listSavedTideTables()).toEqual([]);
        vi.mocked(loadLargeData).mockImplementationOnce(async () => {
            setAuthIdentityScope(null);
            return [...storage.values()][0];
        });
        expect(await listSavedTideTables()).toEqual([]);
        vi.mocked(saveLargeDataImmediate).mockResolvedValueOnce();
        expect(await saveTideTable(tableFromStationDetails(detail())!)).toBe(false);
    });
    it('bounds storage to 24 tables, rejects malformed/duplicate/outdated data and removes selected entries', async () => {
        for (let i = 0; i < 26; i++) {
            const d = detail();
            d.station = { ...station, id: String(i) };
            await saveTideTable(tableFromStationDetails(d)!);
        }
        expect(await listSavedTideTables()).toHaveLength(24);
        const t = (await listSavedTideTables())[0];
        expect(validSavedTideTable({ ...t, extremes: [t.extremes[0], t.extremes[0]] })).toBe(false);
        expect(validSavedTideTable({ ...t, savedAtMs: NOW - 32 * DAY, fetchedAtMs: NOW - 32 * DAY })).toBe(false);
        expect(validSavedTideTable({ ...t, datum: undefined })).toBe(false);
        await removeSavedTideTable(t.id);
        expect(await listSavedTideTables()).toHaveLength(23);
    });
    it('serves saved extrema to map and Glass in Satellite Mode with zero WAN or fresh-publisher calls', async () => {
        await saveTideTable(tableFromStationDetails(detail())!);
        policy.satellite = true;
        expect(await fetchNearbyTideStations(0, 0)).toEqual([station]);
        const d = await fetchTideStationDetails(station, { includeWind: true });
        expect(d?.savedAtMs).toBe(NOW);
        expect(d?.heights).toEqual([]);
        const glass = await fetchRealTides(0, 0);
        expect(glass.guiDetails?.source).toBe('saved-worldtides');
        expect(glass.guiDetails?.datumLabel).toBe('MSL');
        expect(glass.guiDetails?.savedAt).toBe(new Date(NOW).toISOString());
        expect(fetcher).not.toHaveBeenCalled();
        expect(fetchOfficialTides).not.toHaveBeenCalled();
        expect(fetchWorldTides).not.toHaveBeenCalled();
    });
    it('hides tampered owner envelopes even under a matching storage key', async () => {
        storage.set(authScopedStorageKey(OFFLINE_TIDE_KEY), {
            schema: 1,
            ownerKey: 'user:other',
            tables: [tableFromStationDetails(detail())],
        });
        expect(await listSavedTideTables()).toEqual([]);
    });
});
describe('explicit bounded route discovery and prefetch', () => {
    it('searches along a long route across the antimeridian and marks over-budget routes partial', () => {
        const p = tideDiscoveryPlan([
            { lat: 0, lon: 179 },
            { lat: 0, lon: -178 },
        ]);
        expect(p.partial).toBe(false);
        expect(p.points.length).toBeGreaterThan(2);
        expect(p.points.every((x) => Math.abs(x.lon) > 175)).toBe(true);
        expect(
            tideDiscoveryPlan([
                { lat: 0, lon: 0 },
                { lat: 0, lon: 70 },
            ]).partial,
        ).toBe(true);
        expect(tideDiscoveryPlan([{ lat: NaN, lon: 0 }]).points).toEqual([]);
    });
    it('does not discover or prefetch in Satellite Mode', async () => {
        policy.satellite = true;
        expect((await discoverTideStations([{ lat: 0, lon: 0 }])).searched).toBe(0);
        expect('error' in (await prefetchTideTable(station, 30))).toBe(true);
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('checks free capability without coordinates before any paid download and refuses legacy', async () => {
        fetcher.mockResolvedValue(new Response('{}', { status: 400 }));
        expect(await prefetchTideTable(station, 30)).toEqual(
            expect.objectContaining({ error: expect.stringContaining('not enabled') }),
        );
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({ capabilities: true });
        expect(await listSavedTideTables()).toEqual([]);
    });
    it('stores actual complete 30-day events and original response identity/datum with no dense-height request', async () => {
        fetcher
            .mockResolvedValueOnce(
                new Response(JSON.stringify({ status: 200, offlineTides: { schema: 1, minDays: 14, maxDays: 30 } })),
            )
            .mockResolvedValueOnce(new Response(JSON.stringify(raw())));
        const result = await prefetchTideTable(station, 30);
        expect('table' in result).toBe(true);
        expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({
            lat: 0,
            lon: 0,
            offlineDays: 30,
            stationDistance: 1,
        });
        expect((await listSavedTideTables())[0].extremes).toHaveLength(127);
    });
    it('refuses a short/legacy period and fences an account change during download', async () => {
        const capability = () =>
            new Response(JSON.stringify({ status: 200, offlineTides: { schema: 1, minDays: 14, maxDays: 30 } }));
        fetcher
            .mockResolvedValueOnce(capability())
            .mockResolvedValueOnce(new Response(JSON.stringify({ ...raw(), extremes: raw().extremes.slice(0, 30) })));
        expect('error' in (await prefetchTideTable(station, 30))).toBe(true);
        fetcher.mockResolvedValueOnce(capability()).mockImplementationOnce(async () => {
            setAuthIdentityScope(null);
            return new Response(JSON.stringify(raw()));
        });
        expect('error' in (await prefetchTideTable(station, 30))).toBe(true);
        expect(await listSavedTideTables()).toEqual([]);
    });
});
