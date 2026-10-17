import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import { RELIEF_DISPLAY_REGIONS, ownedReliefFile } from '../services/reliefDisplayRegions';
import { reliefViewportCovered } from '../services/reliefViewport';
import {
    reliefTile,
    planReliefArea,
    RELIEF_OFFLINE_LIMIT_BYTES,
    RELIEF_OFFLINE_LIMIT_TILES,
    RELIEF_TILE_MAX_BYTES,
} from '../services/offlineReliefPlan';
import { addReliefBase, seaBaseLayers, setReliefPalette, reloadReliefSources } from '../components/map/reliefBase';
import { ownsSparseRelief } from '../components/map/sparseReliefOwner';

const region = (id: string) => RELIEF_DISPLAY_REGIONS.find((r) => r.id === id)!;
const tileBounds = (z: number, x: number, y: number): [number, number, number, number] => {
    const lon = (v: number) => (v / 2 ** z) * 360 - 180;
    const lat = (v: number) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * v) / 2 ** z))) * 180) / Math.PI;
    // Keep the viewport wholly inside this tile, away from boundary rounding.
    return [lon(x + 0.25), lat(y + 0.75), lon(x + 0.75), lat(y + 0.25)];
};
interface FixtureLayer {
    id: string;
    type: string;
    source?: string;
    metadata?: Record<string, unknown>;
    layout?: Record<string, unknown>;
    paint?: Record<string, unknown>;
    minzoom?: number;
    maxzoom?: number;
}
function mapFixture() {
    let view: readonly [number, number, number, number] = [0, -1, 1, 0],
        zoom = 8;
    const sources = new Map<string, object>(),
        layers = new Map<string, FixtureLayer>();
    const listeners = new Map<string, Set<() => void>>();
    const map = {
        getStyle: () => ({ layers: [...layers.values()] }),
        getSource: (id: string) => sources.get(id),
        getLayer: (id: string) => layers.get(id),
        addSource: (id: string, spec: object) => {
            if (sources.has(id)) throw Error('collision');
            sources.set(id, { ...spec, setTiles: vi.fn() });
        },
        addLayer: (layer: FixtureLayer, before?: string) => {
            if (layers.has(layer.id)) throw Error('collision');
            const rows = [...layers.entries()],
                at = rows.findIndex(([id]) => id === before);
            rows.splice(at < 0 ? rows.length : at, 0, [layer.id, layer]);
            layers.clear();
            for (const [id, l] of rows) layers.set(id, l);
        },
        removeLayer: (id: string) => layers.delete(id),
        removeSource: (id: string) => sources.delete(id),
        getLayoutProperty: (id: string, prop: string) =>
            (layers.get(id)?.layout as Record<string, unknown> | undefined)?.[prop],
        setLayoutProperty: (id: string, prop: string, value: unknown) => {
            const l = layers.get(id);
            if (l) l.layout = { ...l.layout, [prop]: value };
        },
        setPaintProperty: (id: string, prop: string, value: unknown) => {
            const l = layers.get(id);
            if (l) Object.assign(l, { paint: { ...l.paint, [prop]: value } });
        },
        setLayerZoomRange: (id: string, minzoom: number, maxzoom: number) => {
            const l = layers.get(id);
            if (l) Object.assign(l, { minzoom, maxzoom });
        },
        getBounds: () => ({
            getWest: () => view[0],
            getSouth: () => view[1],
            getEast: () => view[2],
            getNorth: () => view[3],
        }),
        getZoom: () => zoom,
        on: (event: string, fn: () => void) => {
            if (!listeners.has(event)) listeners.set(event, new Set());
            listeners.get(event)!.add(fn);
        },
        off: (event: string, fn: () => void) => listeners.get(event)?.delete(fn),
    };
    return {
        map: map as unknown as mapboxgl.Map,
        raw: map,
        sources,
        layers,
        listeners,
        move: (bounds: readonly [number, number, number, number], z: number) => {
            view = bounds;
            zoom = z;
            for (const fn of listeners.get('moveend') ?? []) fn();
        },
        remove: () => {
            for (const fn of listeners.get('remove') ?? []) fn();
        },
    };
}
describe('published AU/NZ illustrative relief', () => {
    it('independently qualifies fixed Log/Sightings scenes, including explicit regional absence', () => {
        const solent: [number, number, number, number] = [-1.6, 50.65, -1.2, 50.85];
        const fiji: [number, number, number, number] = [179.7, -17.3, 180.4, -17];
        const whitsundays: [number, number, number, number] = [148.7, -20.26, 149, -20.2];
        for (let z = 0; z <= 16; z++) {
            for (const scene of [solent, fiji]) {
                expect(reliefViewportCovered(region('au250'), scene, z)).toBe(false);
                expect(reliefViewportCovered(region('nz'), scene, z)).toBe(false);
            }
            expect(reliefViewportCovered(region('nz'), whitsundays, z)).toBe(false);
        }
        for (const z of [8, 9, 10]) expect(reliefViewportCovered(region('au250'), whitsundays, z)).toBe(true);
    });
    it('omits corrupt bundled sparse metadata rather than accidentally admitting a dense region', async () => {
        vi.resetModules();
        vi.doMock('../data/relief/au250-v2.json', () => ({
            default: { schema: 1, region: 'au250', version: 'v2', minzoom: 8, maxzoom: 10, tilePairs: 50308, rows: [] },
        }));
        try {
            const actual = await import('../services/reliefDisplayRegions');
            expect(actual.RELIEF_DISPLAY_REGIONS.map((r) => r.id)).toEqual(['global', 'au', 'nz']);
        } finally {
            vi.doUnmock('../data/relief/au250-v2.json');
            vi.resetModules();
        }
    });
    it.each([
        ['au250', 50308, 626, 'dd66f32ef5981ac8297a3a90627820c3f2ddb1cd5394a8f9afab28309e903727'],
        ['nz', 2197, 724, 'edf5227268b360cf5f195d4b477e0779faf42da9001ce9bd7fd254effdb2f08b'],
    ] as const)('pins exact completely published sparse bytes for %s', (id, pairs, rows, hash) => {
        expect(
            createHash('sha256')
                .update(readFileSync(`data/relief/${id}-v2.json`))
                .digest('hex'),
        ).toBe(hash);
        expect(region(id).availability?.tilePairs).toBe(pairs);
        expect(region(id).availability?.rows).toHaveLength(rows);
        expect(region(id).version).toBe('v2');
    });
    it.each([
        ['au250', 8, 193, 133],
        ['au250', 9, 386, 267],
        ['au250', 10, 1000, 534],
        ['nz', 8, 247, 162],
        ['nz', 11, 1978, 1322],
        ['nz', 14, 15825, 10578],
    ] as const)('admits the exact read-back %s/%i/%i/%i pair only in v2', (id, z, x, y) => {
        for (const [kind, ext] of [
            ['idx', 'png'],
            ['dem', 'webp'],
        ]) {
            const url = `https://tiles.thalassatiles.com/v2/relief-${id}/${kind}/${z}/${x}/${y}.${ext}`;
            expect(reliefTile(url)?.key).toBe(`v2_${id}_${kind}_${z}_${x}_${y}.${ext}`);
            expect(ownedReliefFile(`v2_${id}_${kind}_${z}_${x}_${y}.${ext}`)).toBe(true);
            expect(reliefTile(url.replace('/v2/', '/v1/'))).toBeNull();
            expect(ownedReliefFile(`v1_${id}_${kind}_${z}_${x}_${y}.${ext}`)).toBe(false);
            expect(reliefTile(url + '?generation=v2')).toBeNull();
        }
    });
    it('preserves native datums and inactive NOAA/EMODnet rather than granting depth authority', () => {
        expect(region('nz').datum).toContain('NZVD2016');
        expect(region('nz').datum).toContain('not MSL');
        expect(region('nz').datum).toContain('No vertical conversion');
        expect(region('au250').datum).toContain('Approximately MSL');
        expect(RELIEF_DISPLAY_REGIONS.map((r) => r.id)).toEqual(['global', 'au250', 'au', 'nz']);
        expect(region('nz').coverage).toContain('not whole-country');
    });
    it('keeps phone byte/file caps and rejects country-sized saved areas before allocation', () => {
        expect([RELIEF_OFFLINE_LIMIT_BYTES, RELIEF_OFFLINE_LIMIT_TILES, RELIEF_TILE_MAX_BYTES]).toEqual([
            134217728, 4096, 262144,
        ]);
        for (const bounds of [
            { west: 92, east: 172, south: -60, north: -8 },
            { west: 166, east: 179, south: -48, north: -33 },
        ]) {
            const plan = planReliefArea(bounds, 14);
            expect(plan.tooLarge).toBe(true);
            expect(plan.tiles).toEqual([]);
        }
        const [west, south, east, north] = tileBounds(14, 15825, 10578),
            plan = planReliefArea({ west, south, east, north }, 14);
        expect(plan.tooLarge).toBe(false);
        expect(plan.tiles.some((t) => t.key === 'v2_nz_idx_14_15825_10578.png')).toBe(true);
        expect(plan.tiles.every((t) => reliefTile(t.url)?.key === t.key)).toBe(true);
    });
    it('rejects actual sparse gaps, invalid coordinates and source lookalikes', () => {
        expect(reliefTile('https://tiles.thalassatiles.com/v2/relief-nz/idx/14/15826/10578.png')).toBeNull();
        expect(
            reliefTile('https://tiles.thalassatiles.com.evil.example/v2/relief-nz/idx/14/15825/10578.png'),
        ).toBeNull();
        expect(reliefTile('https://tiles.thalassatiles.com/v2/relief-nz/idx/15/15825/10578.png')).toBeNull();
    });
});
describe('current sparse viewport owner', () => {
    it('refuses a foreign custom layer even when it copied the old metadata marker', () => {
        const f = mapFixture();
        f.move(tileBounds(8, 247, 162), 8);
        addReliefBase(f.map);
        const old = f.layers.get('relief-nz-tint');
        expect(ownsSparseRelief(f.map, 'nz')).toBe(true);
        const custom = { id: 'relief-nz-tint', type: 'custom', metadata: old?.metadata };
        f.layers.set(custom.id, custom);
        expect(ownsSparseRelief(f.map, 'nz')).toBe(false);
        f.move([0, -1, 1, 0], 8);
        expect(f.layers.get(custom.id)).toBe(custom);
        expect(f.sources.has('relief-nz-idx')).toBe(true);
    });
    it('mounts no new sources in a gap, then adds/retires only the current actual cohort', () => {
        const f = mapFixture();
        addReliefBase(f.map);
        expect(f.sources.has('relief-au250-idx')).toBe(false);
        expect(f.sources.has('relief-nz-idx')).toBe(false);
        for (const [id, on] of seaBaseLayers('relief'))
            if (f.layers.has(id)) f.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
        setReliefPalette(f.map, 'night');
        f.move(tileBounds(8, 247, 162), 8);
        expect(ownsSparseRelief(f.map, 'nz')).toBe(true);
        expect(f.layers.get('relief-nz-tint')?.layout?.visibility).toBe('visible');
        expect((f.layers.get('relief-nz-shade')?.paint as Record<string, unknown>)['hillshade-shadow-color']).toBe(
            '#020406',
        );
        f.move(tileBounds(8, 193, 133), 8);
        expect(f.sources.has('relief-nz-idx')).toBe(false);
        expect(f.sources.has('relief-nz-dem')).toBe(false);
        expect(ownsSparseRelief(f.map, 'au250')).toBe(true);
        expect([...f.layers.keys()].indexOf('relief-au250-shade')).toBeLessThan(
            [...f.layers.keys()].indexOf('relief-au-tint'),
        );
        f.move([0, -1, 1, 0], 8);
        expect(f.sources.has('relief-au250-idx')).toBe(false);
        expect(f.sources.has('relief-global-idx')).toBe(true);
    });
    it('retires above the source fade and avoids duplicate owners across style installation', () => {
        const f = mapFixture();
        f.move(tileBounds(8, 247, 162), 8);
        addReliefBase(f.map);
        addReliefBase(f.map);
        expect(f.listeners.get('moveend')?.size).toBe(1);
        expect(ownsSparseRelief(f.map, 'nz')).toBe(true);
        f.move(tileBounds(8, 247, 162), 15.5);
        expect(f.sources.has('relief-nz-idx')).toBe(false);
        f.remove();
        expect(f.listeners.get('moveend')?.size).toBe(0);
    });
    it('replaces a destroyed style without retaining its old cohort or duplicate handlers', () => {
        const f = mapFixture();
        f.move(tileBounds(8, 247, 162), 8);
        addReliefBase(f.map);
        const old = f.sources.get('relief-nz-idx');
        f.sources.clear();
        f.layers.clear();
        addReliefBase(f.map);
        expect(f.sources.get('relief-nz-idx')).not.toBe(old);
        expect(ownsSparseRelief(f.map, 'nz')).toBe(true);
        expect(f.listeners.get('moveend')?.size).toBe(1);
        f.move([0, -1, 1, 0], 8);
        expect(f.sources.has('relief-nz-idx')).toBe(false);
    });
    it('tracks and retires a partially created cohort after an actual add failure', () => {
        const f = mapFixture();
        f.move(tileBounds(8, 247, 162), 8);
        const original = f.raw.addSource;
        f.raw.addSource = (id, spec) => {
            if (id === 'relief-nz-dem') throw Error('native allocation refused');
            original(id, spec);
        };
        expect(() => addReliefBase(f.map)).toThrow('native allocation refused');
        expect(f.sources.has('relief-nz-idx')).toBe(true);
        expect(ownsSparseRelief(f.map, 'nz')).toBe(false);
        f.move([0, -1, 1, 0], 8);
        expect(f.sources.has('relief-nz-idx')).toBe(false);
    });
    it('will not adopt, refresh or remove a replacement source or a foreign layer', () => {
        const f = mapFixture();
        f.move(tileBounds(8, 247, 162), 8);
        addReliefBase(f.map);
        const foreign = { setTiles: vi.fn() };
        f.sources.set('relief-nz-idx', foreign);
        expect(ownsSparseRelief(f.map, 'nz')).toBe(false);
        reloadReliefSources(f.map);
        expect(foreign.setTiles).not.toHaveBeenCalled();
        f.move([0, -1, 1, 0], 8);
        expect(f.sources.get('relief-nz-idx')).toBe(foreign);
        const g = mapFixture();
        g.move(tileBounds(8, 247, 162), 8);
        addReliefBase(g.map);
        const foreignLayer: FixtureLayer = { id: 'relief-nz-tint', type: 'background' };
        g.layers.set(foreignLayer.id, foreignLayer);
        g.move([0, -1, 1, 0], 8);
        expect(g.layers.get(foreignLayer.id)).toBe(foreignLayer);
    });
    it('handles longitude world copies while refusing invalid/polar viewport clocks and coordinates', () => {
        const b = tileBounds(8, 247, 162);
        expect(reliefViewportCovered(region('nz'), [b[0] + 360, b[1], b[2] + 360, b[3]], 8)).toBe(true);
        for (const v of [
            [NaN, -40, 175, -39],
            [170, -91, 175, -39],
            [170, 86, 175, 90],
            [-180, -80, 181, 80],
        ] as const)
            expect(reliefViewportCovered(region('nz'), v, 8)).toBe(false);
        expect(reliefViewportCovered(region('nz'), b, NaN)).toBe(false);
    });
});
