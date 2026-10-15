import { beforeEach, describe, expect, it, vi } from 'vitest';
const storage = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn() }));
vi.mock('@capacitor/preferences', () => ({ Preferences: storage }));
const tile = { key: '-21:148', south: -21, north: -20, west: 148, east: 149 };
const response = {
    elements: [{ type: 'node', id: 123, lat: -20.07, lon: 148.92, tags: { mooring: 'buoy', colour: 'white' } }],
};
beforeEach(() => {
    vi.resetModules();
    vi.unstubAllGlobals();
    storage.get.mockResolvedValue({ value: null });
    storage.set.mockResolvedValue(undefined);
    storage.set.mockClear();
});
describe('Worldwide reference loading', () => {
    it('refreshes fresh legacy cache metadata for strict planner callers without changing default map reads', async () => {
        const { parseOsmReferences } = await import('../services/anchorages/cruisingReference');
        const at = Date.now() - 1000;
        const legacy = parseOsmReferences(response, new Date(at).toISOString());
        delete legacy[0].restrictionNotes;
        storage.get.mockResolvedValue({ value: JSON.stringify([[tile.key, { at, points: legacy }]]) });
        const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => response });
        vi.stubGlobal('fetch', fetcher);
        const { loadReferenceTile } = await import('../services/anchorages/CruisingReferenceService');
        expect(
            (await loadReferenceTile(tile, new AbortController().signal)).points[0].restrictionNotes,
        ).toBeUndefined();
        expect(fetcher).not.toHaveBeenCalled();
        expect(
            (await loadReferenceTile(tile, new AbortController().signal, { requireRestrictionMetadata: true }))
                .points[0].restrictionNotes,
        ).toEqual([]);
        expect(fetcher).toHaveBeenCalledOnce();
        await loadReferenceTile(tile, new AbortController().signal, { requireRestrictionMetadata: true });
        expect(fetcher).toHaveBeenCalledOnce();
    });
    it('does not label unfiltered legacy cache fresh when the strict refresh fails', async () => {
        const { parseOsmReferences } = await import('../services/anchorages/cruisingReference');
        const at = Date.now() - 1000;
        const legacy = parseOsmReferences(response, new Date(at).toISOString());
        delete legacy[0].restrictionNotes;
        storage.get.mockResolvedValue({ value: JSON.stringify([[tile.key, { at, points: legacy }]]) });
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
        const { loadReferenceTile } = await import('../services/anchorages/CruisingReferenceService');
        expect(
            (await loadReferenceTile(tile, new AbortController().signal, { requireRestrictionMetadata: true })).stale,
        ).toBe(true);
    });
    it('reuses fresh tile data and persists it for offline reads', async () => {
        const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => response });
        vi.stubGlobal('fetch', fetcher);
        const { loadReferenceTile } = await import('../services/anchorages/CruisingReferenceService');
        const a = await loadReferenceTile(tile, new AbortController().signal);
        const b = await loadReferenceTile(tile, new AbortController().signal);
        expect(a).toEqual(b);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(storage.set).toHaveBeenCalledOnce();
        expect(decodeURIComponent(fetcher.mock.calls[0][0])).toContain('(-21,148,-20,149)');
    });
    it('fails over and never treats an HTTP-success timeout payload as an empty success', async () => {
        const fetcher = vi
            .fn()
            .mockResolvedValueOnce({ ok: true, json: async () => ({ elements: [], remark: 'runtime timeout' }) })
            .mockResolvedValueOnce({ ok: true, json: async () => response });
        vi.stubGlobal('fetch', fetcher);
        const { loadReferenceTile } = await import('../services/anchorages/CruisingReferenceService');
        expect((await loadReferenceTile(tile, new AbortController().signal)).points).toHaveLength(1);
        expect(fetcher.mock.calls[1][0]).toContain('overpass.kumi.systems');
    });
    it('reports no data on provider failures instead of persisting an empty tile', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
        const { loadReferenceTile } = await import('../services/anchorages/CruisingReferenceService');
        await expect(loadReferenceTile(tile, new AbortController().signal)).rejects.toThrow('unavailable');
        expect(storage.set).not.toHaveBeenCalled();
    });
    it('returns old stored data with an explicit stale flag after a refresh failure', async () => {
        const { parseOsmReferences } = await import('../services/anchorages/cruisingReference');
        const at = Date.now() - 2 * 86400_000;
        storage.get.mockResolvedValue({
            value: JSON.stringify([
                [tile.key, { at, points: parseOsmReferences(response, new Date(at).toISOString()) }],
            ]),
        });
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
        const { loadReferenceTile } = await import('../services/anchorages/CruisingReferenceService');
        const data = await loadReferenceTile(tile, new AbortController().signal);
        expect(data.stale).toBe(true);
        expect(data.points).toHaveLength(1);
    });
    it('loads a cell once for both planner strictness levels and the map', async () => {
        const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => response });
        vi.stubGlobal('fetch', fetcher);
        const { loadReferenceTile } = await import('../services/anchorages/CruisingReferenceService');
        await loadReferenceTile(tile, new AbortController().signal, { requireRestrictionMetadata: true });
        await loadReferenceTile(tile, new AbortController().signal);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(storage.set.mock.calls[0][0].key).toBe('thalassa_cruising_reference_v1');
    });
    it('discards malformed cache contents and respects cancellation', async () => {
        storage.get.mockResolvedValue({
            value: JSON.stringify([[tile.key, { at: Date.now(), points: [{ colours: 'blue' }] }]]),
        });
        const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => response });
        vi.stubGlobal('fetch', fetcher);
        const { loadReferenceTile } = await import('../services/anchorages/CruisingReferenceService');
        const controller = new AbortController();
        controller.abort();
        await expect(loadReferenceTile(tile, controller.signal)).rejects.toThrow();
        expect(fetcher).not.toHaveBeenCalled();
        expect((await loadReferenceTile(tile, new AbortController().signal)).points).toHaveLength(1);
    });
});

// 131-PYD-10: Plan Your Day's extra public-Overpass ask, cached per cell and capped per phone until our own
// OSM extract on the weather server replaces public Overpass (142-07).
describe('Named places for Plan Your Day', () => {
    const names = {
        elements: [{ type: 'node', id: 456, lat: 69.7, lon: 18.9, tags: { natural: 'bay', name: 'Fixture Vika' } }],
    };
    const cell = (n: number) => ({ key: `69:${n}`, south: 69, north: 70, west: n, east: n + 1 });
    const NAMES_KEY = 'thalassa_named_places_v1';
    const ASKS_KEY = 'thalassa_named_places_asks_v1';

    it('asks Overpass once per cell, keeps it a month, and keeps a copy on the phone', async () => {
        const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => names });
        vi.stubGlobal('fetch', fetcher);
        const { loadNamedPlaces } = await import('../services/anchorages/CruisingReferenceService');
        const a = await loadNamedPlaces(cell(18), new AbortController().signal);
        const b = await loadNamedPlaces(cell(18), new AbortController().signal);
        expect(a).toEqual({ points: [expect.objectContaining({ kind: 'bay', name: 'Fixture Vika' })], stale: false });
        expect(b).toEqual(a);
        expect(fetcher).toHaveBeenCalledOnce();
        expect(decodeURIComponent(fetcher.mock.calls[0][0])).toContain('nw["natural"="bay"]["name"](69,18,70,19)');
        expect(storage.set.mock.calls.map(([arg]) => arg.key)).toEqual([ASKS_KEY, NAMES_KEY]);
    });

    it('a cached cell under a month old is read from the phone, with no ask spent', async () => {
        const at = Date.now() - 20 * 86_400_000;
        const { parseNamedPlaces } = await import('../services/anchorages/cruisingReference');
        storage.get.mockImplementation(async ({ key }: { key: string }) => ({
            value: key === NAMES_KEY ? JSON.stringify([[cell(18).key, { at, points: parseNamedPlaces(names) }]]) : null,
        }));
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        const { loadNamedPlaces } = await import('../services/anchorages/CruisingReferenceService');
        expect((await loadNamedPlaces(cell(18), new AbortController().signal)).points).toHaveLength(1);
        expect(fetcher).not.toHaveBeenCalled();
        expect(storage.set).not.toHaveBeenCalled();
    });

    it('asks for at most twelve cells a day from this phone, then serves an old copy or nothing', async () => {
        const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => names });
        vi.stubGlobal('fetch', fetcher);
        const { loadNamedPlaces, NAMED_PLACES_ASKS_PER_DAY } =
            await import('../services/anchorages/CruisingReferenceService');
        expect(NAMED_PLACES_ASKS_PER_DAY).toBe(12);
        for (let n = 0; n < NAMED_PLACES_ASKS_PER_DAY; n++)
            await loadNamedPlaces(cell(n), new AbortController().signal);
        expect(fetcher).toHaveBeenCalledTimes(12);
        await expect(loadNamedPlaces(cell(50), new AbortController().signal)).rejects.toThrow(/allowance/);
        expect(fetcher).toHaveBeenCalledTimes(12);
        // A cell already on the phone is still read, with no ask.
        expect((await loadNamedPlaces(cell(3), new AbortController().signal)).stale).toBe(false);
    });

    it('the allowance holds across a restart, and an old copy is served stale when it is spent', async () => {
        const now = Date.now();
        const { parseNamedPlaces } = await import('../services/anchorages/cruisingReference');
        const old = now - 40 * 86_400_000;
        storage.get.mockImplementation(async ({ key }: { key: string }) => ({
            value:
                key === ASKS_KEY
                    ? JSON.stringify(Array.from({ length: 12 }, (_, i) => now - i * 3_600_000))
                    : key === NAMES_KEY
                      ? JSON.stringify([[cell(18).key, { at: old, points: parseNamedPlaces(names) }]])
                      : null,
        }));
        const fetcher = vi.fn();
        vi.stubGlobal('fetch', fetcher);
        const { loadNamedPlaces } = await import('../services/anchorages/CruisingReferenceService');
        const stale = await loadNamedPlaces(cell(18), new AbortController().signal);
        expect(stale.stale).toBe(true);
        expect(stale.points).toHaveLength(1);
        await expect(loadNamedPlaces(cell(19), new AbortController().signal)).rejects.toThrow(/allowance/);
        expect(fetcher).not.toHaveBeenCalled();
    });

    it('four cells asked at once: the phone is read once, and every ask counts', async () => {
        const now = Date.now();
        const { parseNamedPlaces } = await import('../services/anchorages/cruisingReference');
        storage.get.mockImplementation(async ({ key }: { key: string }) => ({
            value:
                key === ASKS_KEY
                    ? JSON.stringify(Array.from({ length: 10 }, () => now - 3_600_000))
                    : key === NAMES_KEY
                      ? JSON.stringify([[cell(0).key, { at: now - 1000, points: parseNamedPlaces(names) }]])
                      : null,
        }));
        storage.get.mockClear();
        const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => names });
        vi.stubGlobal('fetch', fetcher);
        const { loadNamedPlaces } = await import('../services/anchorages/CruisingReferenceService');
        const results = await Promise.allSettled(
            [0, 1, 2, 3].map((n) => loadNamedPlaces(cell(n), new AbortController().signal)),
        );
        // Cell 0 from the phone; two of the other three fit in what is left of the day's twelve.
        expect(results.map((r) => r.status)).toEqual(['fulfilled', 'fulfilled', 'fulfilled', 'rejected']);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(storage.get.mock.calls.filter(([arg]) => arg.key === NAMES_KEY)).toHaveLength(1);
    });

    it('asks spent a day ago are given back', async () => {
        const now = Date.now();
        storage.get.mockImplementation(async ({ key }: { key: string }) => ({
            value: key === ASKS_KEY ? JSON.stringify(Array.from({ length: 12 }, () => now - 25 * 3_600_000)) : null,
        }));
        const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => names });
        vi.stubGlobal('fetch', fetcher);
        const { loadNamedPlaces } = await import('../services/anchorages/CruisingReferenceService');
        expect((await loadNamedPlaces(cell(18), new AbortController().signal)).points).toHaveLength(1);
        expect(fetcher).toHaveBeenCalledOnce();
    });

    it('a cut-short answer fails over and is never cached as the whole cell', async () => {
        const fetcher = vi
            .fn()
            .mockResolvedValue({ ok: true, json: async () => ({ elements: [], remark: 'timeout' }) });
        vi.stubGlobal('fetch', fetcher);
        const { loadNamedPlaces } = await import('../services/anchorages/CruisingReferenceService');
        await expect(loadNamedPlaces(cell(18), new AbortController().signal)).rejects.toThrow('unavailable');
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(fetcher.mock.calls[1][0]).toContain('overpass.kumi.systems');
        expect(storage.set.mock.calls.map(([arg]) => arg.key)).toEqual([ASKS_KEY]);
    });
});
