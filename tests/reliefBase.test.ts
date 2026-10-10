import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type mapboxgl from 'mapbox-gl';
import { DEPARE_BAND_COLORS } from '../components/map/encDepthStyle';
import { contrast, deltaE, VISIONS } from './helpers/colourScience';
import {
    addReliefBase,
    BASE_LABEL,
    BASE_LAND_FILL,
    BASE_WATER_FILL,
    depthIndex,
    GBR30_TITLE,
    HIDDEN_BASE_GEOMETRY,
    LIGHT_PALETTE,
    LAND_IMAGERY_LAYER,
    LAND_STRUCTURE,
    RELIEF_ATTRIBUTION,
    RELIEF_AU_BOUNDS,
    RELIEF_LAYER_IDS,
    SEA_BASE_BANDS,
    SEA_BASE_COAST,
    SEA_BASE_LAND_SHADE,
    seaBaseLayers,
    setReliefPalette,
} from '../components/map/reliefBase';

/**
 * A style-sized stand-in for mapbox-gl: an ordered layer list, a source map
 * and a log of paint writes. Enough to prove ORDER, VISIBILITY AT BIRTH and
 * the palette guard without WebGL.
 */
type FakeLayer = {
    id: string;
    type: string;
    source?: string;
    'source-layer'?: string;
    minzoom?: number;
    maxzoom?: number;
    layout?: Record<string, unknown>;
    paint?: Record<string, unknown>;
};

function fakeMap(
    ids = [
        'land',
        'national-park',
        'landuse',
        'waterway',
        'water',
        'land-structure-polygon',
        'road-simple',
        'settlement-major-label',
    ],
) {
    const layers: FakeLayer[] = ids.map((id) => ({
        id,
        type:
            id === 'land'
                ? 'background'
                : id.endsWith('label')
                  ? 'symbol'
                  : /^(road|bridge)-|-line$/.test(id)
                    ? 'line'
                    : 'fill',
    }));
    const sources = new Map<string, Record<string, unknown>>([
        ['composite', { type: 'vector' }],
        ['satellite-base', { type: 'raster' }],
    ]);
    const writes: Array<[string, string, unknown]> = [];
    const map = {
        layers,
        sources,
        writes,
        getStyle: () => ({ layers: layers.map((l) => ({ ...l })) }),
        getLayer: (id: string) => layers.find((l) => l.id === id),
        getSource: (id: string) => sources.get(id),
        addSource: (id: string, spec: Record<string, unknown>) => {
            if (sources.has(id)) throw new Error(`source ${id} exists`);
            sources.set(id, spec);
        },
        addLayer: (layer: FakeLayer, before?: string) => {
            if (layers.some((l) => l.id === layer.id)) throw new Error(`layer ${layer.id} exists`);
            const at = before ? layers.findIndex((l) => l.id === before) : -1;
            if (at < 0) layers.push(layer);
            else layers.splice(at, 0, layer);
        },
        setPaintProperty: (id: string, prop: string, value: unknown) => {
            writes.push([id, prop, value]);
            const layer = layers.find((l) => l.id === id);
            if (layer) layer.paint = { ...layer.paint, [prop]: value };
        },
        setLayerZoomRange: (id: string, minzoom: number, maxzoom: number) => {
            writes.push([id, 'zoom-range', [minzoom, maxzoom]]);
            const layer = layers.find((l) => l.id === id);
            if (layer) Object.assign(layer, { minzoom, maxzoom });
        },
    };
    return map;
}
const asMap = (map: ReturnType<typeof fakeMap>) => map as unknown as mapboxgl.Map;
const BASE = 'https://relief.example.r2.dev/v1';
const order = (map: ReturnType<typeof fakeMap>) => map.layers.map((l) => l.id);

describe('relief base: layers, order and birth state', () => {
    it('puts land imagery and land shade UNDER the water fill, and the sea stack right above it', () => {
        const map = fakeMap();
        addReliefBase(asMap(map), BASE);
        expect(order(map)).toEqual([
            'land',
            'national-park',
            'landuse',
            'waterway',
            LAND_IMAGERY_LAYER,
            SEA_BASE_LAND_SHADE,
            'water',
            SEA_BASE_BANDS,
            ...RELIEF_LAYER_IDS,
            SEA_BASE_COAST,
            'land-structure-polygon',
            'road-simple',
            'settlement-major-label',
        ]);
    });

    it('creates every layer hidden: MapHub’s base pass is the one visibility owner', () => {
        const map = fakeMap();
        addReliefBase(asMap(map), BASE);
        const added = map.layers.filter((l) => !fakeMap().layers.some((orig) => orig.id === l.id));
        expect(added.length).toBe(4 + RELIEF_LAYER_IDS.length);
        for (const layer of added) expect(layer.layout?.visibility).toBe('none');
    });

    it('draws land imagery from the existing satellite source, not a second imagery download', () => {
        const map = fakeMap();
        addReliefBase(asMap(map), BASE);
        expect(map.layers.find((l) => l.id === LAND_IMAGERY_LAYER)?.source).toBe('satellite-base');
        expect([...map.sources.keys()].filter((id) => /sat/i.test(id))).toEqual(['satellite-base']);
    });

    it('is idempotent across a second load pass', () => {
        const map = fakeMap();
        addReliefBase(asMap(map), BASE);
        const once = order(map);
        expect(() => addReliefBase(asMap(map), BASE)).not.toThrow();
        expect(order(map)).toEqual(once);
    });

    it('builds the vector sea from the style’s own composite source: bathymetry fades out by z9', () => {
        const map = fakeMap();
        addReliefBase(asMap(map), BASE);
        const bands = map.layers.find((l) => l.id === SEA_BASE_BANDS)!;
        expect(bands.source).toBe('composite');
        expect(bands['source-layer']).toBe('depth');
        const opacity = bands.paint?.['fill-opacity'] as unknown[];
        expect(opacity.slice(0, 3)).toEqual(['interpolate', ['linear'], ['zoom']]);
        expect(opacity[opacity.length - 2]).toBeLessThanOrEqual(9);
        expect(opacity[opacity.length - 1]).toBe(0);
        const shade = map.layers.find((l) => l.id === SEA_BASE_LAND_SHADE)!;
        expect(shade['source-layer']).toBe('hillshade');
        expect(map.layers.find((l) => l.id === SEA_BASE_COAST)?.['source-layer']).toBe('water');
    });
});

describe('relief tiles', () => {
    it('reads world GEBCO to z9 and the Australian 30 m grid z8-13 inside its box', () => {
        const map = fakeMap();
        addReliefBase(asMap(map), BASE);
        const src = (id: string) => map.sources.get(id) as Record<string, unknown>;
        expect(src('relief-global-idx')).toMatchObject({ type: 'raster', tileSize: 256, maxzoom: 9 });
        expect(src('relief-global-dem')).toMatchObject({ type: 'raster-dem', encoding: 'terrarium', maxzoom: 9 });
        expect(src('relief-au-idx')).toMatchObject({ minzoom: 8, maxzoom: 13, bounds: RELIEF_AU_BOUNDS });
        expect(src('relief-au-dem')).toMatchObject({ encoding: 'terrarium', minzoom: 8, maxzoom: 13 });
        for (const id of ['relief-global-idx', 'relief-global-dem', 'relief-au-idx', 'relief-au-dem']) {
            const tiles = src(id).tiles as string[];
            expect(tiles).toHaveLength(1);
            expect(tiles[0].startsWith(`${BASE}/`)).toBe(true);
            expect(tiles[0]).toMatch(/\/\{z\}\/\{x\}\/\{y\}\.(png|webp)$/);
            // tools/relief/README.md's layout: <base>/relief-{global,au}/{dem,idx}/{z}/{x}/{y}
            const [, set, kind] = id.split('-');
            expect(tiles[0]).toBe(`${BASE}/relief-${set}/${kind}/{z}/{x}/{y}.${kind === 'dem' ? 'webp' : 'png'}`);
            expect(src(id).attribution).toBe(RELIEF_ATTRIBUTION);
        }
    });

    it('credits GEBCO and Geoscience Australia and says it is not for navigation', () => {
        // CC BY 4.0 §3(a)(1)(B): say the material was modified (exaggerated,
        // smoothed, merged, land-masked), not just whose it is.
        expect(RELIEF_ATTRIBUTION).toMatch(/^Seafloor relief derived from /);
        expect(readFileSync('public/terms.html', 'utf8')).toMatch(/seafloor relief[^<]*derived from/i);
        expect(RELIEF_ATTRIBUTION).toContain('GEBCO');
        expect(RELIEF_ATTRIBUTION).toContain('Geoscience Australia');
        expect(RELIEF_ATTRIBUTION).toContain('CC BY 4.0');
        // The land mask is OSM's: the ODbL Produced Work notice rides with the relief.
        expect(RELIEF_ATTRIBUTION).toContain('coastline &copy; OpenStreetMap contributors');
        expect(RELIEF_ATTRIBUTION).toContain('Not for navigation');
        // Geoscience Australia's wording for derivative material (Copyright@ga.gov.au,
        // 2026-10-07): based on the titled, linked material, by GA, © Commonwealth
        // of Australia, the licence named and linked, and its section 5 disclaimer.
        // The grid's catalogue title (eCat 115066, checked 2026-10-10; the
        // record was renamed from "Great Barrier Reef Bathymetry 2020 30 m"),
        // with the version of grids A-D the tiles are built from (127-DESKMAP A5).
        expect(RELIEF_ATTRIBUTION).toContain(
            'based on <a href="https://pid.geoscience.gov.au/dataset/ga/115066" target="_blank" rel="noopener noreferrer">AusBathyTopo (Great Barrier Reef) 30m 2017 - A regional-scale depth model (20170025C)</a>, version 10 Nov 2020, by Geoscience Australia',
        );
        expect(RELIEF_ATTRIBUTION).not.toContain('Great Barrier Reef Bathymetry 2020');
        expect(RELIEF_ATTRIBUTION).toContain('&copy; Commonwealth of Australia');
        expect(RELIEF_ATTRIBUTION).toMatch(
            /<a href="https:\/\/creativecommons\.org\/licenses\/by\/4\.0\/"[^>]*>CC BY 4\.0<\/a>/,
        );
        expect(RELIEF_ATTRIBUTION).toContain('section 5 disclaimer of warranties');
    });

    // Review 2026-10-05: with the world colour gone at z11, the 30 m grid's
    // overzoomed edge drew a straight line at z10.5+ (156.09°E navy against
    // flat mid-blue on a Brisbane–Noumea passage; 9.80°S, 140.625°E, 29.54°S).
    // Rendered on wx: the world colour running to the grid's own fade closes
    // all four, with no tint over land outside Queensland at z12 (Sydney,
    // Noumea) and none over the reefs inside it. The world hillshade still
    // goes at z10-11: overzoomed 32x it would be blur, not shape.
    it('runs world colour to the 30 m grid’s fade, so the grid’s edge never shows; world shade goes at z10-11', () => {
        const map = fakeMap();
        addReliefBase(asMap(map), BASE);
        const paint = (id: string, prop: string) => map.layers.find((l) => l.id === id)?.paint?.[prop] as unknown[];
        expect(paint('relief-global-tint', 'raster-opacity').slice(3)).toEqual([13.5, 1, 14.5, 0]);
        expect(paint('relief-au-tint', 'raster-opacity').slice(3)).toEqual([13.5, 1, 14.5, 0]);
        expect(paint('relief-global-shade', 'hillshade-exaggeration').slice(-4)).toEqual([10, 0.7, 11, 0]);
        expect(paint('relief-au-shade', 'hillshade-exaggeration').slice(-4)).toEqual([13.5, 0.7, 14.5, 0]);
    });

    it('stops each layer at the zoom its fade reaches nothing, so a faded layer fetches no tiles', () => {
        // mapbox-gl 3.19 keeps a source loading for every layer that is not
        // isHidden(zoom), which reads min/maxzoom and visibility, never opacity.
        const map = fakeMap();
        addReliefBase(asMap(map), BASE);
        const fadeOf = (layer: FakeLayer) =>
            (layer.paint?.['raster-opacity'] ??
                layer.paint?.['hillshade-exaggeration'] ??
                layer.paint?.['fill-opacity']) as unknown[];
        for (const id of [...RELIEF_LAYER_IDS, SEA_BASE_BANDS]) {
            const layer = map.layers.find((l) => l.id === id)!;
            const fade = fadeOf(layer);
            expect(fade.slice(0, 3), id).toEqual(['interpolate', ['linear'], ['zoom']]);
            expect(fade[fade.length - 1], id).toBe(0);
            expect(layer.maxzoom, id).toBe(fade[fade.length - 2]);
        }
    });

    it('colours from an 8-bit depth index: channels arrive 0..1, land is transparent, stops climb', () => {
        const map = fakeMap();
        addReliefBase(asMap(map), BASE);
        const tint = map.layers.find((l) => l.id === 'relief-au-tint')!.paint!;
        // Measured in GL JS 3.19: [1,0,0,0] drew nothing, [255,0,0,0] was right.
        expect(tint['raster-color-mix']).toEqual([255, 0, 0, 0]);
        expect(tint['raster-color-range']).toEqual([0, 255]);
        const ramp = tint['raster-color'] as unknown[];
        expect(ramp.slice(0, 3)).toEqual(['interpolate', ['linear'], ['raster-value']]);
        const stops = ramp.slice(3).filter((_, i) => i % 2 === 0) as number[];
        expect(stops[0]).toBe(0);
        expect(stops[stops.length - 1]).toBe(255);
        for (let i = 1; i < stops.length; i++) expect(stops[i]).toBeGreaterThan(stops[i - 1]);
        expect(ramp[4]).toMatch(/rgba\([^)]*,\s*0\)$/);
    });

    it('matches the tile encoder: 0 is land or under 0.3 m, water is 1..254 on a log scale', () => {
        expect(depthIndex(0)).toBe(0);
        expect(depthIndex(0.3)).toBe(0);
        expect(depthIndex(0.31)).toBeGreaterThanOrEqual(1);
        expect(depthIndex(6000)).toBeCloseTo(254, 5);
        expect(depthIndex(11000)).toBeCloseTo(254, 5);
        for (const [shallow, deep] of [
            [1, 2],
            [5, 10],
            [50, 200],
            [1000, 4000],
        ])
            expect(depthIndex(deep)).toBeGreaterThan(depthIndex(shallow));
    });
});

describe('the quiet fallback', () => {
    it('with no tile base configured adds no relief source, and Relief still draws the vector sea', () => {
        const map = fakeMap();
        addReliefBase(asMap(map), '');
        expect([...map.sources.keys()].some((id) => id.startsWith('relief'))).toBe(false);
        for (const id of RELIEF_LAYER_IDS) expect(map.layers.some((l) => l.id === id)).toBe(false);
        const on = new Map(seaBaseLayers('relief'));
        expect(on.get(SEA_BASE_BANDS)).toBe(true);
        expect(on.get(SEA_BASE_COAST)).toBe(true);
    });

    it('keeps the vector sea UNDER the relief, so a missing or failed tile shows sea, never a hole', () => {
        const map = fakeMap();
        addReliefBase(asMap(map), BASE);
        const at = (id: string) => order(map).indexOf(id);
        for (const id of RELIEF_LAYER_IDS) expect(at(id)).toBeGreaterThan(at(SEA_BASE_BANDS));
        expect(at(SEA_BASE_BANDS)).toBeGreaterThan(at('water'));
    });

    it('builds nothing on a style without the composite sea', () => {
        const map = fakeMap();
        map.sources.delete('composite');
        addReliefBase(asMap(map), BASE);
        expect(order(map)).toEqual(order(fakeMap()));
    });
});

describe('which layers each base shows', () => {
    const shown = (kind: Parameters<typeof seaBaseLayers>[0]) =>
        seaBaseLayers(kind)
            .filter(([, on]) => on)
            .map(([id]) => id);

    it('Relief: relief over the vector sea, coastline, plain land', () => {
        expect(shown('relief')).toEqual([...RELIEF_LAYER_IDS, SEA_BASE_BANDS, SEA_BASE_COAST]);
    });
    it('Relief + Sat: the same sea with imagery on land only', () => {
        expect(shown('reliefSat')).toEqual([...RELIEF_LAYER_IDS, SEA_BASE_BANDS, SEA_BASE_COAST, LAND_IMAGERY_LAYER]);
    });
    it('Ocean: the vector sea and land hillshade, no relief tiles', () => {
        expect(shown('ocean')).toEqual([SEA_BASE_BANDS, SEA_BASE_LAND_SHADE, SEA_BASE_COAST]);
    });
    it.each(['satellite', 'hybrid'] as const)('%s: none of them', (kind) => {
        expect(shown(kind)).toEqual([]);
    });
});

describe('plain land keeps its structures (review 2026-10-05)', () => {
    // dark-v11's non-symbol geometry above the water fill (style fetched 2026-10-04).
    const DARK_V11 = [
        'land-structure-polygon',
        'land-structure-line',
        'aeroway-polygon',
        'aeroway-line',
        'building',
        'tunnel-path-trail',
        'tunnel-simple',
        'road-path',
        'road-simple',
        'road-rail',
        'bridge-path-trail',
        'bridge-path-cycleway-piste',
        'bridge-path',
        'bridge-steps',
        'bridge-pedestrian',
        'bridge-case-simple',
        'bridge-simple',
        'bridge-rail',
    ];
    const KEPT = DARK_V11.filter((id) => /^(land-structure|bridge)-/.test(id));

    it('hides roads, tunnels, aeroways and buildings, but never piers, breakwaters, groynes or bridges', () => {
        // With ENC off, Relief and Ocean have no imagery: the structure layers
        // are a marina's only jetties and breakwaters, and a bridge over a
        // channel is an air-draft hazard (Serene Summer: 18 m).
        expect(DARK_V11.filter((id) => HIDDEN_BASE_GEOMETRY.test(id))).toEqual([
            'aeroway-polygon',
            'aeroway-line',
            'building',
            'tunnel-path-trail',
            'tunnel-simple',
            'road-path',
            'road-simple',
            'road-rail',
        ]);
        expect(KEPT).toHaveLength(10);
        for (const id of KEPT) {
            expect(HIDDEN_BASE_GEOMETRY.test(id), id).toBe(false);
            expect(LAND_STRUCTURE.test(id), id).toBe(true);
        }
        for (const id of DARK_V11.filter((id) => !KEPT.includes(id))) expect(LAND_STRUCTURE.test(id), id).toBe(false);
    });

    it('paints the kept structures land, day and night: solid over water, gone into plain land', () => {
        const map = fakeMap(['land', 'landuse', 'water', ...KEPT, 'settlement-major-label']);
        addReliefBase(asMap(map), BASE);
        const paint = (id: string) => {
            const layer = map.layers.find((l) => l.id === id)!;
            return layer.paint?.[layer.type === 'line' ? 'line-color' : 'fill-color'];
        };
        setReliefPalette(asMap(map), 'night');
        for (const id of KEPT) expect(paint(id), id).toBe('#141518');
        setReliefPalette(asMap(map), 'day');
        for (const id of KEPT) expect(paint(id), id).toBe('#333b45');
    });

    it('useMapInit hides by HIDDEN_BASE_GEOMETRY and paints LAND_STRUCTURE the land slate at load', () => {
        const init = readFileSync('components/map/useMapInit.ts', 'utf8');
        expect(init).toMatch(/HIDDEN_BASE_GEOMETRY\.test\(layer\.id\)/);
        expect(init).toMatch(/LAND_STRUCTURE\.test\(layer\.id\)[\s\S]{0,240}'#333b45'/);
        expect(init).not.toMatch(/land-structure\)\//);
    });
});

describe('palettes', () => {
    it('writes only when the palette changes (the styledata-loop rule)', () => {
        const map = fakeMap();
        addReliefBase(asMap(map), BASE);
        expect(setReliefPalette(asMap(map), 'day')).toBe(true);
        const settled = map.writes.length;
        expect(setReliefPalette(asMap(map), 'day')).toBe(false);
        expect(map.writes.length).toBe(settled);
        expect(setReliefPalette(asMap(map), 'night')).toBe(true);
        expect(map.writes.length).toBeGreaterThan(settled);
    });

    it('re-arms after the layers are rebuilt by a style reload', () => {
        const map = fakeMap();
        addReliefBase(asMap(map), BASE);
        setReliefPalette(asMap(map), 'night');
        const fresh = fakeMap();
        addReliefBase(asMap(fresh), BASE);
        expect(setReliefPalette(asMap(fresh), 'night')).toBe(true);
    });

    it('dims the whole sea and land at night', () => {
        const map = fakeMap();
        addReliefBase(asMap(map), BASE);
        setReliefPalette(asMap(map), 'night');
        const paint = (id: string, prop: string) => map.layers.find((l) => l.id === id)?.paint?.[prop];
        expect(paint('land', 'background-color')).toBe('#141518');
        expect(paint('water', 'fill-color')).toBe('#0c1822');
        expect(String(paint(SEA_BASE_COAST, 'line-color'))).toMatch(/^rgba\(150/);
    });

    it('damps the relief tint under the ENC glaze, and leaves the hillshade', () => {
        const map = fakeMap();
        addReliefBase(asMap(map), BASE);
        setReliefPalette(asMap(map), 'enc');
        const tint = map.layers.find((l) => l.id === 'relief-global-tint')!.paint!;
        expect((tint['raster-opacity'] as unknown[]).slice(3)).toEqual([13.5, 0.7, 14.5, 0]);
        expect(tint['raster-saturation']).toBe(-0.5);
        expect(map.writes.some(([id]) => id === 'relief-global-shade')).toBe(true);
    });

    it('is a no-op before the sea exists', () => {
        const map = fakeMap();
        expect(setReliefPalette(asMap(map), 'night')).toBe(false);
        expect(map.writes).toEqual([]);
    });
});

describe('MapHub wiring', () => {
    const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    const hub = strip(readFileSync('components/map/MapHub.tsx', 'utf8'));
    const init = strip(readFileSync('components/map/useMapInit.ts', 'utf8'));

    it('adds the sea once at style load, after the satellite source it borrows', () => {
        expect(init).toContain('addReliefBase(map)');
        expect(init.indexOf("map.addSource('satellite-base'")).toBeLessThan(init.indexOf('addReliefBase(map)'));
    });

    it('drives every sea layer through the conditional setVis, and the palette through its guard', () => {
        expect(hub).toMatch(
            /for \(const \[id, on\] of seaBaseLayers\(shownBase\)\)[\s\S]{0,80}setVis\(id, on \? 'visible' : 'none'\)/,
        );
        // Light is never damped to 'enc' (127-DESKMAP A1): its chart mode draws
        // the ENC opaque over it, and the dark ramp must never come back.
        expect(hub).toMatch(
            /setReliefPalette\(\s*map,\s*nightMode \? 'night' : shownBase === 'light' \? 'light' : encDrawn \? 'enc' : 'day',?\s*\)/,
        );
        // No unconditional paint write sneaks in beside them.
        expect(hub).not.toMatch(/setPaintProperty\(\s*'relief-/);
    });
});

/**
 * The Light base (127-DESKMAP A1): the relief sea in a paper-chart palette
 * for the desk. Shane 2026-10-10: "the underlying map is dark and very hard to
 * see what is water and what isnt."
 */
describe('the Light base (127-DESKMAP A1)', () => {
    /** A dark-v11-shaped style: the fills and labels the load pass paints, plus
     *  one label layer that is not the base style's (an app-owned source). */
    const STYLE: FakeLayer[] = [
        { id: 'land', type: 'background' },
        { id: 'landcover', type: 'fill', source: 'composite' },
        { id: 'landcover-wood', type: 'fill', source: 'composite' },
        { id: 'sand', type: 'fill', source: 'composite' },
        { id: 'national-park', type: 'fill', source: 'composite' },
        { id: 'landuse', type: 'fill', source: 'composite' },
        { id: 'water-shadow', type: 'fill', source: 'composite' },
        { id: 'waterway', type: 'line', source: 'composite' },
        { id: 'water', type: 'fill', source: 'composite' },
        { id: 'land-structure-polygon', type: 'fill', source: 'composite' },
        { id: 'land-structure-line', type: 'line', source: 'composite' },
        { id: 'water-point-label', type: 'symbol', source: 'composite' },
        { id: 'settlement-major-label', type: 'symbol', source: 'composite' },
        { id: 'country-label', type: 'symbol', source: 'composite' },
        { id: 'enc-vec-lndare-label', type: 'symbol', source: 'enc-vec-source' },
    ];
    function styled() {
        const map = fakeMap([]);
        for (const layer of STYLE) map.layers.push({ ...layer });
        addReliefBase(asMap(map), BASE);
        return map;
    }
    const paint = (map: ReturnType<typeof fakeMap>, id: string, prop: string) =>
        map.layers.find((l) => l.id === id)?.paint?.[prop];
    /** The fills the load pass paints, by the same exported regexes. */
    const loadPassLand = STYLE.filter((l) => l.type === 'fill' && BASE_LAND_FILL.test(l.id)).map((l) => l.id);
    const loadPassWater = STYLE.filter((l) => l.type === 'fill' && BASE_WATER_FILL.test(l.id)).map((l) => l.id);
    const baseLabels = STYLE.filter((l) => l.type === 'symbol' && l.source === 'composite' && BASE_LABEL.test(l.id));
    const L = LIGHT_PALETTE;

    it('lights what Relief lights: relief over the vector sea and coastline; no land imagery, no land shade', () => {
        const on = new Map(seaBaseLayers('light'));
        expect(seaBaseLayers('light')).toEqual(seaBaseLayers('relief'));
        expect(on.get(LAND_IMAGERY_LAYER)).toBe(false);
        expect(on.get(SEA_BASE_LAND_SHADE)).toBe(false);
        for (const id of [...RELIEF_LAYER_IDS, SEA_BASE_BANDS, SEA_BASE_COAST]) expect(on.get(id), id).toBe(true);
    });

    it('paints every load-pass land fill buff and every water fill the flat grey-blue', () => {
        expect(loadPassLand).toEqual([
            'landcover',
            'landcover-wood',
            'sand',
            'national-park',
            'landuse',
            'land-structure-polygon',
        ]);
        expect(loadPassWater).toEqual(['water-shadow', 'water']);
        const map = styled();
        expect(setReliefPalette(asMap(map), 'light')).toBe(true);
        expect(paint(map, 'land', 'background-color')).toBe(L.land);
        for (const id of loadPassLand) expect(paint(map, id, 'fill-color'), id).toBe(L.land);
        for (const id of loadPassWater) expect(paint(map, id, 'fill-color'), id).toBe('#c9d0d6');
        expect(paint(map, 'waterway', 'line-color')).toBe(L.water);
        expect(paint(map, 'land-structure-polygon', 'fill-color')).toBe(L.land);
        expect(paint(map, 'land-structure-line', 'line-color')).toBe(L.land);
        expect(paint(map, SEA_BASE_COAST, 'line-color')).toBe(L.coast);
        // Our own sea layers keep their own paint: the bands are a ramp, never the flat fill.
        expect(paint(map, SEA_BASE_BANDS, 'fill-color')).not.toBe(L.water);
        expect(paint(map, SEA_BASE_LAND_SHADE, 'fill-color')).not.toBe(L.land);
    });

    it('paints the base style’s labels dark on a white halo, and never an app-owned label', () => {
        const map = styled();
        setReliefPalette(asMap(map), 'light');
        expect(baseLabels.map((l) => l.id)).toEqual(['water-point-label', 'settlement-major-label', 'country-label']);
        for (const { id } of baseLabels) {
            expect(paint(map, id, 'text-color'), id).toBe('#1e2b38');
            expect(paint(map, id, 'text-halo-color'), id).toBe('rgba(255,255,255,0.9)');
            expect(paint(map, id, 'text-halo-width'), id).toBe(1.5);
        }
        expect(map.writes.some(([id]) => id === 'enc-vec-lndare-label')).toBe(false);
    });

    it('day after Light restores slate land and white labels; Light after night restores dark labels', () => {
        const map = styled();
        setReliefPalette(asMap(map), 'light');
        setReliefPalette(asMap(map), 'day');
        expect(paint(map, 'land', 'background-color')).toBe('#333b45');
        for (const id of loadPassLand) expect(paint(map, id, 'fill-color'), id).toBe('#333b45');
        for (const id of loadPassWater) expect(paint(map, id, 'fill-color'), id).toBe('#1f5a85');
        for (const { id } of baseLabels) {
            expect(paint(map, id, 'text-color'), id).toBe('#ffffff');
            expect(paint(map, id, 'text-halo-color'), id).toBe('rgba(0, 0, 0, 0.9)');
            expect(paint(map, id, 'text-halo-width'), id).toBe(2);
        }
        setReliefPalette(asMap(map), 'night');
        for (const id of loadPassLand) expect(paint(map, id, 'fill-color'), id).toBe('#141518');
        for (const { id } of baseLabels) expect(paint(map, id, 'text-color'), id).toBe('#ffffff');
        setReliefPalette(asMap(map), 'light');
        for (const { id } of baseLabels) expect(paint(map, id, 'text-color'), id).toBe('#1e2b38');
        for (const id of loadPassLand) expect(paint(map, id, 'fill-color'), id).toBe(L.land);
    });

    it('writes nothing on a repeat Light call (the styledata-loop rule)', () => {
        const map = styled();
        expect(setReliefPalette(asMap(map), 'light')).toBe(true);
        const settled = map.writes.length;
        expect(setReliefPalette(asMap(map), 'light')).toBe(false);
        expect(map.writes.length).toBe(settled);
    });

    // A map that never shows Light (the Log maps, the Ocean page, every phone
    // chart) is painted exactly as before: labels and landcover untouched.
    it('leaves labels and the extra land fills alone on a map that has never been Light', () => {
        const map = styled();
        setReliefPalette(asMap(map), 'day');
        setReliefPalette(asMap(map), 'night');
        setReliefPalette(asMap(map), 'day');
        const touched = new Set(map.writes.map(([id]) => id));
        for (const id of ['landcover', 'landcover-wood', 'sand', 'water-shadow', ...baseLabels.map((l) => l.id)])
            expect(touched.has(id), id).toBe(false);
    });

    it('on Light the world tint ends at z12 (flat water past it); other bases restore it; the GA fade is unchanged', () => {
        const map = styled();
        const layer = (id: string) => map.layers.find((l) => l.id === id)!;
        const fade = (id: string) => (layer(id).paint?.['raster-opacity'] as unknown[]).slice(3);
        setReliefPalette(asMap(map), 'light');
        expect(layer('relief-global-tint').maxzoom).toBe(12);
        expect(fade('relief-global-tint')).toEqual([11, 1, 12, 0]);
        expect(layer('relief-global-shade').maxzoom).toBeLessThanOrEqual(12);
        expect(layer('relief-au-tint').maxzoom).toBe(14.5);
        expect(fade('relief-au-tint')).toEqual([13.5, 1, 14.5, 0]);
        setReliefPalette(asMap(map), 'day');
        expect(layer('relief-global-tint').maxzoom).toBe(14.5);
        expect(fade('relief-global-tint')).toEqual([13.5, 1, 14.5, 0]);
        expect(layer('relief-au-tint').maxzoom).toBe(14.5);
    });

    describe('colour bars', () => {
        const ramp = L.ramp.filter(([d]) => d >= 2).map(([, c]) => c);
        const waters = [...new Set([...ramp, L.water])];

        it('the 2, 5 and 10 m stops are the ENC band colours; land is the ENC land fill', () => {
            const at = (d: number) => L.ramp.find(([depth]) => depth === d)?.[1];
            expect(at(2)).toBe(DEPARE_BAND_COLORS.b0to2);
            expect(at(5)).toBe(DEPARE_BAND_COLORS.b2to5);
            expect(at(10)).toBe(DEPARE_BAND_COLORS.b5to10);
            const enc = readFileSync('components/map/EncVectorLayer.ts', 'utf8');
            expect(enc).toMatch(new RegExp(`LNDARE[\\s\\S]{0,1200}'fill-color': '${L.land}'`));
        });

        it('coastline ≥ 4.5:1 against land and every water; labels ≥ 7:1 on their halo', () => {
            expect(contrast(L.coast, L.land)).toBeGreaterThanOrEqual(4.5);
            for (const w of waters) expect(contrast(L.coast, w), w).toBeGreaterThanOrEqual(4.5);
            expect(contrast(L.label.ink, '#ffffff')).toBeGreaterThanOrEqual(7);
        });

        it('land against every water ΔE2000 ≥ 15, for normal, deutan, protan and tritan vision', () => {
            for (const vision of VISIONS)
                for (const w of waters) expect(deltaE(L.land, w, vision), `${vision} ${w}`).toBeGreaterThanOrEqual(15);
        });

        it('never reaches white: flat water ≥ 10 and the deepest stop ≥ 8 from charted white; flat ≥ 5 from every stop', () => {
            expect(deltaE(L.water, '#ffffff')).toBeGreaterThanOrEqual(10);
            expect(deltaE(ramp[ramp.length - 1], '#ffffff')).toBeGreaterThanOrEqual(8);
            for (const stop of ramp) expect(deltaE(L.water, stop), stop).toBeGreaterThanOrEqual(5);
        });
    });

    it('credits the GA grid by its catalogue title, version and link, beside GEBCO, OSM and Not for navigation', () => {
        expect(GBR30_TITLE).toBe(
            'AusBathyTopo (Great Barrier Reef) 30m 2017 - A regional-scale depth model (20170025C)',
        );
        const credits = readFileSync('src/ocean/Credits.tsx', 'utf8').replace(/\s+/g, ' ');
        const readme = readFileSync('tools/relief/README.md', 'utf8');
        for (const text of [RELIEF_ATTRIBUTION, credits]) {
            expect(text).toContain(GBR30_TITLE);
            expect(text).toContain('10 Nov 2020');
            expect(text).toContain('https://pid.geoscience.gov.au/dataset/ga/115066');
            expect(text).toContain('https://doi.org/10.5285/4f68d5c7-45eb-f999-e063-7086abc036fa');
            expect(text).toContain('https://creativecommons.org/licenses/by/4.0/');
            expect(text).toContain('section 5');
            expect(text).toContain('OpenStreetMap');
            expect(text).toMatch(/Not for navigation/);
            expect(text).not.toContain('Great Barrier Reef Bathymetry 2020');
        }
        expect(readme).toContain(GBR30_TITLE);
        expect(readme).toContain('10 Nov 2020');
        expect(readme).not.toContain('Great Barrier Reef Bathymetry 2020');
    });
});
