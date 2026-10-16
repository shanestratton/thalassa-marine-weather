import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ load: vi.fn(), get: vi.fn(), set: vi.fn(), satellite: false }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => h.satellite }));
vi.mock('@capacitor/preferences', () => ({ Preferences: { get: h.get, set: h.set } }));
vi.mock('../services/marineCatalogue/service', () => ({ loadMarineCells: h.load }));
beforeEach(() => {
    vi.resetModules();
    h.get.mockResolvedValue({ value: null });
    h.set.mockResolvedValue(undefined);
    h.satellite = false;
});
it('an unpublished extract cannot fall through to Overpass over a Satellite link', async () => {
    h.satellite = true;
    h.load.mockResolvedValue({ partial: true, manifests: [], records: [] });
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const { loadReferenceTile } = await import('../services/anchorages/CruisingReferenceService');
    await expect(
        loadReferenceTile(
            { key: '-21:148', south: -21, north: -20, west: 148, east: 149 },
            new AbortController().signal,
        ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
});
it('a published OSM area supplies stable moorings, restrictions and snapshot date without querying Overpass', async () => {
    const date = new Date().toISOString(),
        fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    h.load.mockResolvedValue({
        partial: false,
        manifests: [{ dataset: 'osm', sourceAt: date }],
        records: [
            {
                id: 'osm-node42',
                name: 'Fictional buoy',
                kind: 'mooring',
                lat: -20.1,
                lon: 148.9,
                country: '',
                aliases: [],
                approximate: false,
                access: 'private',
                restrictions: ['Permit required'],
                colours: ['white'],
            },
        ],
    });
    const { loadReferenceTile } = await import('../services/anchorages/CruisingReferenceService');
    const result = await loadReferenceTile(
        { key: '-21:148', south: -21, north: -20, west: 148, east: 149 },
        new AbortController().signal,
        { requireRestrictionMetadata: true },
    );
    expect(result.points).toEqual([
        expect.objectContaining({
            id: 'osm-node42',
            access: 'private',
            restrictionNotes: ['Permit required'],
            sourceUrl: 'https://www.openstreetmap.org/node/42',
            retrievedAt: date,
        }),
    ]);
    expect(fetcher).not.toHaveBeenCalled();
    expect(h.load).toHaveBeenCalledWith(['34_164'], ['osm'], expect.any(AbortSignal));
});
