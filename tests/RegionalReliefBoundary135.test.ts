import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import type { ReliefDisplayRegion } from '../services/reliefDisplayRegions';

vi.mock('../services/supabaseAuth', () => ({ getAuthenticatedFunctionHeaders: async () => ({}) }));
beforeEach(() => vi.resetModules());
afterEach(() => {
    vi.doUnmock('../services/reliefDisplayRegions');
    vi.unstubAllGlobals();
});

describe('regional terrain publication and navigation boundary', () => {
    it('keeps every unapproved provider proof inactive and preserves the current published layers', async () => {
        const { RELIEF_DISPLAY_REGIONS, ownedReliefFile } = await import('../services/reliefDisplayRegions');
        const { reliefTile, planReliefArea } = await import('../services/offlineReliefPlan');
        const { RELIEF_LAYER_IDS } = await import('../components/map/reliefBase');
        expect(RELIEF_DISPLAY_REGIONS.map((region) => region.id)).toEqual(['global', 'au']);
        expect(RELIEF_LAYER_IDS).toEqual([
            'relief-global-tint',
            'relief-global-shade',
            'relief-au-tint',
            'relief-au-shade',
        ]);
        for (const id of ['eu', 'us', 'pr', 'nz', 'au250']) {
            expect(reliefTile(`https://tiles.thalassatiles.com/v2/relief-${id}/idx/8/80/120.png`)).toBeNull();
            expect(ownedReliefFile(`v2_${id}_idx_8_80_120.png`)).toBe(false);
        }
        const plan = planReliefArea({ north: -31.9, south: -32.1, west: 115.5, east: 115.7 }, 13);
        expect(plan.tiles.every((tile) => tile.url.includes('/relief-global/'))).toBe(true);
        expect(ownedReliefFile('unrelated-user-chart.mbtiles')).toBe(false);
        expect(ownedReliefFile('../v1_global_idx_1_0_0.png')).toBe(false);
    });
    it('uses a reviewed provider row consistently in map bounds, credits, versions, reload and bounded offline plans', async () => {
        // Synthetic publication receipt: no v2 terrain is published by this test or the app.
        const region: ReliefDisplayRegion = {
            id: 'pr',
            version: 'v2',
            minzoom: 8,
            maxzoom: 13,
            bounds: [-66, 17.75, -65.75, 18],
            tintFade: [13.5, 14.5],
            shadeFade: [13.5, 14.5],
            datum: 'PRVD02',
            attribution: 'Derived from CIRES / NOAA CUDEM; PRVD02; not for navigation.',
        };
        vi.doMock('../services/reliefDisplayRegions', async (importOriginal) => {
            const actual = await importOriginal<typeof import('../services/reliefDisplayRegions')>();
            return { ...actual, RELIEF_DISPLAY_REGIONS: [...actual.RELIEF_DISPLAY_REGIONS, region] };
        });
        const { addReliefBase, reloadReliefSources, RELIEF_ATTRIBUTION } = await import('../components/map/reliefBase');
        const { reliefTile, planReliefArea } = await import('../services/offlineReliefPlan');
        const sources = new Map<string, Record<string, unknown>>();
        const layers = new Map<string, mapboxgl.AnyLayer>();
        const map = {
            getStyle: () => ({ layers: [] }),
            getSource: (id: string) => sources.get(id),
            getLayer: (id: string) => layers.get(id),
            addSource: (id: string, value: Record<string, unknown>) => sources.set(id, value),
            addLayer: (value: mapboxgl.AnyLayer) => layers.set(value.id, value),
        } as unknown as mapboxgl.Map;
        addReliefBase(map);
        expect(sources.get('relief-pr-idx')).toMatchObject({
            bounds: region.bounds,
            attribution: region.attribution,
            tiles: ['https://tiles.thalassatiles.com/v2/relief-pr/idx/{z}/{x}/{y}.png'],
        });
        expect(sources.get('relief-global-idx')?.tiles).toEqual([
            'https://tiles.thalassatiles.com/v1/relief-global/idx/{z}/{x}/{y}.png',
        ]);
        for (const id of ['global', 'au'])
            for (const kind of ['idx', 'dem'])
                expect(sources.get(`relief-${id}-${kind}`)?.attribution).toBe(RELIEF_ATTRIBUTION);
        const setTiles = vi.fn();
        sources.set('relief-pr-idx', { setTiles });
        reloadReliefSources(map);
        expect(setTiles).toHaveBeenCalledWith(['https://tiles.thalassatiles.com/v2/relief-pr/idx/{z}/{x}/{y}.png']);
        const plan = planReliefArea({ north: 17.91, south: 17.9, west: -65.96, east: -65.95 }, 13);
        const regional = plan.tiles.filter((tile) => tile.url.includes('/relief-pr/'));
        expect(regional.length).toBeGreaterThan(0);
        expect(regional.every((tile) => tile.url.includes('/v2/') && reliefTile(tile.url)?.key === tile.key)).toBe(
            true,
        );
        expect(reliefTile(regional[0].url.replace('/v2/', '/v1/'))).toBeNull();
        expect(reliefTile('https://tiles.thalassatiles.com/v2/relief-pr/idx/13/0/0.png')).toBeNull();
        expect(
            planReliefArea({ north: 20, south: 19, west: -66, east: -65.9 }, 13).tiles.some((tile) =>
                tile.url.includes('/relief-pr/'),
            ),
        ).toBe(false);
    });
    it('keeps bathymetry acquisition on its existing depth provider, independent of display terrain', async () => {
        const fetcher = vi.fn(
            async (_url: string) =>
                new Response(JSON.stringify({ grid: { table: { rows: [] } } }), {
                    headers: { 'content-type': 'application/json' },
                }),
        );
        vi.stubGlobal('fetch', fetcher);
        const { preloadBathymetry } = await import('../services/BathymetryCache');
        await preloadBathymetry({ lat: 17.9, lon: -65.95 }, { lat: 17.95, lon: -65.9 });
        expect(fetcher).toHaveBeenCalledOnce();
        expect(fetcher.mock.calls[0][0]).toMatch(/\/functions\/v1\/gebco-depth$/);
        expect(JSON.stringify(fetcher.mock.calls)).not.toContain('tiles.thalassatiles.com');
    });
});
