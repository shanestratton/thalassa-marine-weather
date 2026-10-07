/**
 * ENC lights and navaid symbols are never dropped by label collision (W1-01b,
 * the follow-up from W1-01's S-52 review).
 *
 * The chart mounts its light flares, buoys, beacons and their name labels on
 * ONE source (enc-vec-navaids), and the map runs with crossSourceCollisions
 * off, so they all share one collision graph. Mapbox places symbol layers top
 * down: the name labels sit above the lights and are placed first. With the
 * LIGHTS layer at icon-allow-overlap false, a nearby mark's name could cull a
 * lit beacon's flare, and of two close minor lights one simply vanished. IHO
 * S-52, which every ECDIS draws to worldwide, never collision-culls an aid to
 * navigation: text may give way, the symbol may not.
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

import { mountEncVectorLayer } from '../../components/map/EncVectorLayer';
import { ENC_VEC_LAYERS, ENC_VEC_SRC, S57_BUOY_BEACON_CLASSES } from '../../components/map/encLayerIds';
import { S52_STANDARD_NAVAID_LAYERS } from '../../components/map/encDetailScrubber';
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

function mounted(minZoom?: number): Spec[] {
    const layers: Spec[] = [];
    const sources = new Set<string>();
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
        isMoving: () => false,
        areTilesLoaded: () => true,
    };
    const map = new Proxy(target, {
        get: (t, prop: string) => (prop in t ? (t as Record<string, unknown>)[prop] : () => undefined),
    }) as unknown as mapboxgl.Map;
    const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
    const data = new Proxy({ cellCount: 0 } as Record<string, unknown>, {
        get: (t, key: string) => (key in t ? t[key] : empty),
    }) as unknown as EncMergedVectorData;
    mountEncVectorLayer(map, data, minZoom === undefined ? {} : { minZoom });
    return layers;
}

const stack = mounted();
const spec = (id: string): Spec => {
    const found = stack.find((l) => l.id === id);
    if (!found) throw new Error(`${id} was not mounted`);
    return found;
};
const passes = (id: string, props: Record<string, unknown>, zoom: number) =>
    evalExpr(spec(id).filter, { props: { _kind: 'LIGHTS', ...props }, zoom }) === true;

describe('ENC light flares are never collision-culled (S-52)', () => {
    it('a flare draws whatever label or flare it overlaps', () => {
        expect(spec(ENC_VEC_LAYERS.LIGHTS).layout?.['icon-allow-overlap']).toBe(true);
    });

    it('a flare never takes a neighbouring mark’s name off the chart either', () => {
        // The flare sits offset beside its structure; if the stack order ever
        // put it above the labels, its box would otherwise evict their names.
        expect(spec(ENC_VEC_LAYERS.LIGHTS).layout?.['icon-ignore-placement']).toBe(true);
    });

    it('shares the navaid source with the labels — the case the flags exist for', () => {
        expect(spec(ENC_VEC_LAYERS.LIGHTS).source).toBe(ENC_VEC_SRC.NAVAIDS);
        expect(spec(ENC_VEC_LAYERS.NAVAIDS_LABEL).source).toBe(ENC_VEC_SRC.NAVAIDS);
    });

    it('keeps the minor-light zoom floor and the always-on major lights', () => {
        // Declutter is by zoom and SCAMIN, never by collision.
        expect(spec(ENC_VEC_LAYERS.LIGHTS).minzoom).toBe(7);
        expect(mounted(5).find((l) => l.id === ENC_VEC_LAYERS.LIGHTS)?.minzoom).toBe(5);
        expect(passes(ENC_VEC_LAYERS.LIGHTS, { _lightTier: 'major' }, 7), 'major light at z7').toBe(true);
        expect(passes(ENC_VEC_LAYERS.LIGHTS, { _lightTier: 'minor' }, 9.9), 'minor light below z10').toBe(false);
        expect(passes(ENC_VEC_LAYERS.LIGHTS, { _lightTier: 'minor' }, 10), 'minor light at z10').toBe(true);
        // A cell's SCAMIN still retires a major light below the z10 mark floor.
        expect(passes(ENC_VEC_LAYERS.LIGHTS, { _lightTier: 'major', _minZoom: 9 }, 8), 'SCAMIN still retires').toBe(
            false,
        );
        expect(passes(ENC_VEC_LAYERS.LIGHTS, { _lightTier: 'major', _minZoom: 9 }, 9), 'SCAMIN reached').toBe(true);
    });
});

describe('ENC buoy and beacon symbols are never collision-culled (S-52)', () => {
    it.each(S57_BUOY_BEACON_CLASSES.map((c) => [c, ENC_VEC_LAYERS[c]] as const))(
        '%s draws whatever it overlaps',
        (_cls, id) => {
            expect(spec(id).type).toBe('symbol');
            expect(spec(id).layout?.['icon-allow-overlap']).toBe(true);
        },
    );

    it('every protected S-52 navaid symbol layer is covered, lights included', () => {
        const symbols = S52_STANDARD_NAVAID_LAYERS.filter((id) => spec(id).type === 'symbol');
        expect(symbols).toContain(ENC_VEC_LAYERS.LIGHTS);
        for (const id of symbols) expect(spec(id).layout?.['icon-allow-overlap'], id).toBe(true);
    });
});

describe('ENC labels still give way to each other', () => {
    // Every text layer on the two point sources the marks and their names share.
    const markText = () =>
        stack.filter(
            (l) =>
                l.type === 'symbol' &&
                l.layout?.['text-field'] !== undefined &&
                (l.source === ENC_VEC_SRC.NAVAIDS || l.source === ENC_VEC_SRC.POINTS),
        );

    it('the mark and light names keep colliding among themselves', () => {
        for (const id of [ENC_VEC_LAYERS.NAVAIDS_LABEL, ENC_VEC_LAYERS.POINTS_LABEL]) {
            expect(spec(id).layout?.['text-allow-overlap'], id).toBe(false);
            expect(spec(id).layout?.['text-ignore-placement'], id).not.toBe(true);
        }
    });

    it('no text on the mark sources was switched to always-draw', () => {
        const loose = markText().filter(
            (l) => l.layout?.['text-allow-overlap'] === true || l.layout?.['text-ignore-placement'] === true,
        );
        expect(markText().map((l) => l.id)).toEqual(
            expect.arrayContaining([ENC_VEC_LAYERS.NAVAIDS_LABEL, ENC_VEC_LAYERS.POINTS_LABEL]),
        );
        expect(loose.map((l) => l.id)).toEqual([]);
    });

    it('the names still sit above the lights, so a name is placed before the flare beside it', () => {
        const ids = stack.map((l) => l.id);
        expect(ids.indexOf(ENC_VEC_LAYERS.NAVAIDS_LABEL)).toBeGreaterThan(ids.indexOf(ENC_VEC_LAYERS.LIGHTS));
    });
});
