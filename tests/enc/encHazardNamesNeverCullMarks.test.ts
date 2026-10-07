/**
 * A hazard's NAME can never take a hazard MARK off the chart (build 123,
 * package HM, the follow-up to W1-FX).
 *
 * Wrecks, rocks and obstructions draw from ONE source (enc-vec-points)
 * together with their name labels, and every chart map (the main chart and the
 * auto-route trial map, tests/enc/encMapsCollideBySource.test.ts) runs with
 * crossSourceCollisions off, so marks and names share one collision graph. Mapbox places symbol
 * layers from the top of the stack down, so whichever sits higher claims the
 * space. The names used to sit topmost, and measured in Chromium and WebKit
 * (browser-tests/enc-hazard-labels.spec.ts) every NAMED hazard lost its own
 * symbol to its own name, and an unnamed rock beside a named wreck vanished
 * under the wreck's name: the skipper saw a name and no rock.
 *
 * The names now sit BELOW the three hazard layers, so every mark is placed
 * first and a name prints only where it has room; and they sit 2 em under
 * their point, clear of the mark's own collision box, so a lone mark keeps its
 * name. Unchanged (Shane 2026-08-07): danger symbols declutter among
 * themselves, the shallowest of each class surviving (the sort key orders one
 * layer; across the three classes it is a known gap), and names give way to
 * each other.
 *
 * The real mount runs on a recording stub map and every layer spec is read
 * back. Nothing here is a real chart.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FeatureCollection } from 'geojson';
import type mapboxgl from 'mapbox-gl';

// Sprite registration loads images; the layer specs are what is under test.
vi.mock('../../components/map/seamarkIcons', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    registerSeamarkIcons: async () => undefined,
}));

import { ENC_SOURCE_TABLE, mountEncVectorLayer } from '../../components/map/EncVectorLayer';
import { ALL_LAYER_IDS, ENC_VEC_LAYERS, ENC_VEC_SRC } from '../../components/map/encLayerIds';
import { getSeamarkIconDefs } from '../../components/map/seamarkIcons';
import type { EncMergedVectorData } from '../../services/enc/EncHazardService';
import { evalExpr } from './exprEval';

interface Spec {
    id: string;
    type: string;
    source?: string;
    minzoom?: number;
    filter?: unknown;
    layout?: Record<string, unknown>;
}

type StubMap = mapboxgl.Map & {
    _ids(): string[];
    _raise(id: string): void;
    _offsetWrites: string[];
};

function stubMap(): StubMap {
    const layers: Spec[] = [];
    const sources = new Set<string>();
    const offsetWrites: string[] = [];
    const target = {
        getStyle: () => ({ layers: layers.map((l) => ({ id: l.id, type: l.type })) }),
        getSource: (id: string) => (sources.has(id) ? { setData: () => undefined } : undefined),
        addSource: (id: string) => void sources.add(id),
        getLayer: (id: string) => layers.find((l) => l.id === id),
        addLayer: (spec: Spec, beforeId?: string) => {
            const at = beforeId ? layers.findIndex((l) => l.id === beforeId) : -1;
            const copy = { ...spec, layout: { ...spec.layout } };
            if (at >= 0) layers.splice(at, 0, copy);
            else layers.push(copy);
        },
        moveLayer: (id: string, beforeId?: string) => {
            const from = layers.findIndex((l) => l.id === id);
            if (from < 0) return;
            const [layer] = layers.splice(from, 1);
            const at = beforeId ? layers.findIndex((l) => l.id === beforeId) : -1;
            if (at >= 0) layers.splice(at, 0, layer);
            else layers.push(layer);
        },
        getLayoutProperty: (id: string, prop: string) => layers.find((l) => l.id === id)?.layout?.[prop],
        setLayoutProperty: (id: string, prop: string, value: unknown) => {
            const layer = layers.find((l) => l.id === id);
            if (!layer) return;
            layer.layout = { ...layer.layout, [prop]: value };
            if (prop === 'text-offset') offsetWrites.push(id);
        },
        isMoving: () => false,
        areTilesLoaded: () => true,
        _offsetWrites: offsetWrites,
        _ids: () => layers.map((l) => l.id),
        /** An older bundle's stacking: put a layer back on top. */
        _raise: (id: string) => {
            const from = layers.findIndex((l) => l.id === id);
            layers.push(...layers.splice(from, 1));
        },
        _specs: layers,
    };
    return new Proxy(target, {
        get: (t, prop: string) => (prop in t ? (t as Record<string, unknown>)[prop] : () => undefined),
    }) as unknown as StubMap;
}

const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
const noData = new Proxy({ cellCount: 0 } as Record<string, unknown>, {
    get: (t, key: string) => (key in t ? t[key] : empty),
}) as unknown as EncMergedVectorData;

const map = stubMap();
mountEncVectorLayer(map, noData);
const stack = (map as unknown as { _specs: Spec[] })._specs;
const spec = (id: string): Spec => {
    const found = stack.find((l) => l.id === id);
    if (!found) throw new Error(`${id} was not mounted`);
    return found;
};

const HAZARD_LAYERS = [ENC_VEC_LAYERS.OBSTRN, ENC_VEC_LAYERS.WRECKS, ENC_VEC_LAYERS.UWTROC] as const;
const NAMES = ENC_VEC_LAYERS.POINTS_LABEL;

describe('every hazard mark is placed before any hazard name', () => {
    it('the names share the hazard source: one copy of the points, the case the order is for', () => {
        expect(spec(NAMES).source).toBe(ENC_VEC_SRC.POINTS);
        for (const id of HAZARD_LAYERS) expect(spec(id).source, id).toBe(ENC_VEC_SRC.POINTS);
        // No label-only duplicate of the points GeoJSON in the web view (the
        // 2 GB WebContent ceiling): one source row builds them.
        const pointRows = ENC_SOURCE_TABLE.filter((row) => row.id === ENC_VEC_SRC.POINTS);
        expect(pointRows).toHaveLength(1);
        expect(Object.values(ENC_VEC_SRC).filter((id) => id.includes('points'))).toEqual([ENC_VEC_SRC.POINTS]);
    });

    it('the canonical stack puts the names below all three hazard layers', () => {
        const at = (id: string) => ALL_LAYER_IDS.indexOf(id);
        for (const id of HAZARD_LAYERS) {
            expect(at(NAMES), `${NAMES} must sit below ${id}`).toBeLessThan(at(id));
        }
    });

    it('the mounted map does too, so Mapbox places the marks first', () => {
        const ids = map._ids();
        for (const id of HAZARD_LAYERS) {
            expect(ids.indexOf(NAMES), `${NAMES} must sit below ${id}`).toBeLessThan(ids.indexOf(id));
        }
    });

    it('a live map an older bundle built (names on top, at 1.4 em) heals on the next mount', () => {
        const live = stubMap();
        mountEncVectorLayer(live, noData);
        live._raise(NAMES);
        live.setLayoutProperty(NAMES, 'text-offset', [0, 1.4]);
        live._offsetWrites.length = 0;
        expect(live._ids().at(-1)).toBe(NAMES);
        mountEncVectorLayer(live, noData);
        const ids = live._ids();
        for (const id of HAZARD_LAYERS) expect(ids.indexOf(NAMES), id).toBeLessThan(ids.indexOf(id));
        expect(live.getLayoutProperty(NAMES, 'text-offset')).toEqual([0, 2]);
        expect(live._offsetWrites).toEqual([NAMES]);
        // Read before write: a mount that finds the offsets right writes none.
        mountEncVectorLayer(live, noData);
        expect(live._offsetWrites).toEqual([NAMES]);
    });

    it('the navaid names keep their place above the lights (W1-FX)', () => {
        const ids = map._ids();
        expect(ids.indexOf(ENC_VEC_LAYERS.NAVAIDS_LABEL)).toBeGreaterThan(ids.indexOf(ENC_VEC_LAYERS.LIGHTS));
        expect(spec(ENC_VEC_LAYERS.NAVAIDS_LABEL).layout?.['text-offset']).toEqual([0, 1.4]);
    });
});

describe('a name clears its own mark', () => {
    // Mapbox's collision boxes: an icon's is the image box times icon-size
    // plus icon-padding; a top-anchored label's starts text-offset ems below
    // the point, less text-padding. Both paddings default to 2 px.
    const MAPBOX_DEFAULT_PADDING = 2;
    const hazardImagePx = Math.max(
        ...getSeamarkIconDefs()
            .filter((d) => d.id.startsWith('sm-hazard-'))
            .map((d) => d.size),
    );
    const num = (v: unknown, zoom: number): number => evalExpr(v, { zoom }) as number;
    const offsetEm = (zoom: number): number => {
        const offset = spec(NAMES).layout?.['text-offset'];
        const pair = (Array.isArray(offset) && typeof offset[0] === 'number' ? offset : evalExpr(offset, { zoom })) as [
            number,
            number,
        ];
        return pair[1];
    };
    const padding = (v: unknown): number => (typeof v === 'number' ? v : MAPBOX_DEFAULT_PADDING);
    const labelTopPx = (zoom: number) =>
        offsetEm(zoom) * num(spec(NAMES).layout?.['text-size'], zoom) - padding(spec(NAMES).layout?.['text-padding']);
    const markHalfPx = (id: string, zoom: number) =>
        (hazardImagePx / 2) * num(spec(id).layout?.['icon-size'], zoom) + padding(spec(id).layout?.['icon-padding']);

    it('the names hang below their point', () => {
        expect(spec(NAMES).layout?.['text-anchor']).toBe('top');
        expect(hazardImagePx).toBe(48);
    });

    it('at every zoom the names show, with at least a pixel to spare', () => {
        // Measured (both engines, real fonts): 1.4 em and 1.8 em still touched
        // the mark's box at z13 and z15, so the lone wreck lost its name.
        const from = spec(NAMES).minzoom ?? 0;
        expect(from).toBe(13);
        for (let zoom = from; zoom <= 22; zoom += 0.25) {
            for (const id of HAZARD_LAYERS) {
                const spare = labelTopPx(zoom) - markHalfPx(id, zoom);
                expect(spare, `${id} at z${zoom}: ${spare.toFixed(2)} px`).toBeGreaterThanOrEqual(1);
            }
        }
    });
});

describe('what stays as it was', () => {
    it('danger symbols still declutter among themselves, shallowest first (Shane 2026-08-07)', () => {
        const sortKey = ['to-number', ['get', 'VALSOU'], 0];
        for (const id of HAZARD_LAYERS) {
            expect(spec(id).type).toBe('symbol');
            expect(spec(id).layout?.['icon-allow-overlap'], id).toBe(false);
            expect(spec(id).layout?.['icon-ignore-placement'], id).not.toBe(true);
            expect(spec(id).layout?.['symbol-sort-key'], id).toEqual(sortKey);
            expect(spec(id).layout?.['icon-padding'], id).toBeUndefined();
        }
    });

    it('no mark carries its name: text on the symbol would be placed with it and cull the next mark', () => {
        // Measured: with the name on the rock layer (text-optional), the named
        // rock's name took the obstruction beside it off the chart, because the
        // rock layer is placed before the obstruction layer.
        for (const id of HAZARD_LAYERS) expect(spec(id).layout?.['text-field'], id).toBeUndefined();
    });

    it('the names still give way to each other and to the marks', () => {
        expect(spec(NAMES).layout?.['text-allow-overlap']).toBe(false);
        expect(spec(NAMES).layout?.['text-ignore-placement']).not.toBe(true);
        expect(spec(NAMES).minzoom).toBe(13);
    });

    it('every named wreck, rock and obstruction is still offered a name; unnamed ones are not', () => {
        const passes = (props: Record<string, unknown>) => evalExpr(spec(NAMES).filter, { props, zoom: 14 }) === true;
        for (const kind of ['OBSTRN', 'WRECKS', 'UWTROC']) {
            expect(passes({ _kind: kind, OBJNAM: 'Fictional Mark' }), kind).toBe(true);
            expect(passes({ _kind: kind, VALSOU: 3 }), `${kind} unnamed`).toBe(false);
        }
    });
});
