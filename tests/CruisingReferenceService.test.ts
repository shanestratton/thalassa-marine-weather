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
