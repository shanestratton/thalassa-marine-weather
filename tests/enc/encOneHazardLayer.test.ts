/**
 * ONE hazard symbol layer, so the shallowest danger wins ACROSS classes
 * (build 125, 125-04, chart safety).
 *
 * Shane's 2026-08-07 rule: danger symbols declutter at every zoom and the
 * shallowest survives (symbol-sort-key on VALSOU). A sort key orders ONE
 * layer only, and wrecks, rocks and obstructions used to be three layers that
 * Mapbox placed whole, top-down: every rock before any wreck, every wreck
 * before any obstruction. So a 15 m rock took a 0.5 m dangerous wreck off the
 * chart, and a 9 m wreck took a 2 m obstruction, whatever their depths.
 *
 * Now one layer draws all three, picks each class's own INT1 glyph by _kind,
 * and sorts on ONE key the merge stamps on every mark (_hzSort): the charted
 * depth (VALSOU, read case-defensively) when there is one; without it, a mark
 * that dries sorts below 0, one awash at chart datum and any other danger of
 * unknown depth sort as 0 (fail-safe), and a mark the chart itself calls
 * non-dangerous (foul ground, a non-dangerous wreck) sorts as 20.1 m, behind
 * every sounded danger to 20 m. Equal depths keep the old layer priority:
 * rock, then wreck, then obstruction.
 * The real mount runs on a recording stub map and every spec is read back,
 * and the marks go through the real merge (the source table's points row);
 * browser-tests/enc-hazard-labels.spec.ts proves the placement in the real
 * engines. Nothing here is a real chart.
 */
import { describe, expect, it, vi } from 'vitest';
import type { FeatureCollection } from 'geojson';
import type mapboxgl from 'mapbox-gl';

// Sprite registration loads images; the layer specs are what is under test.
vi.mock('../../components/map/seamarkIcons', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    registerSeamarkIcons: async () => undefined,
}));

import { ENC_SOURCE_TABLE, mountEncVectorLayer, unmountEncVectorLayer } from '../../components/map/EncVectorLayer';
import * as layerIds from '../../components/map/encLayerIds';
import { buildFeaturePopupHtml } from '../../components/map/encPopup';
import { UWTROC_ROCK_GLYPH, UWTROC_ROCK_GLYPH_DEFAULT } from '../../components/map/seamarkIcons';
import type { EncMergedVectorData } from '../../services/enc/EncHazardService';
import { evalExpr } from './exprEval';

const { ALL_LAYER_IDS, CLICKABLE_LAYER_IDS, ENC_VEC_LAYERS, ENC_VEC_SRC, RETIRED_ENC_LAYER_IDS } = layerIds;
/** The one hazard layer's id (undefined before 125-04). */
const HAZARDS = (ENC_VEC_LAYERS as Record<string, string>).HAZARDS;
/** The three per-class layers it replaces, by their old ids. */
const OLD_PER_CLASS_IDS = ['enc-vec-obstrn-circle', 'enc-vec-wrecks-circle', 'enc-vec-uwtroc-circle'];

interface Spec {
    id: string;
    type: string;
    source?: string;
    minzoom?: number;
    filter?: unknown;
    layout?: Record<string, unknown>;
    paint?: Record<string, unknown>;
}

function stubMap(seed: Spec[] = []) {
    const layers: Spec[] = seed.map((s) => ({ ...s }));
    const sources = new Set<string>();
    const target = {
        getStyle: () => ({ layers: layers.map((l) => ({ id: l.id, type: l.type })) }),
        getSource: (id: string) => (sources.has(id) ? { setData: () => undefined } : undefined),
        addSource: (id: string) => void sources.add(id),
        removeSource: (id: string) => void sources.delete(id),
        getLayer: (id: string) => layers.find((l) => l.id === id),
        addLayer: (spec: Spec, beforeId?: string) => {
            const at = beforeId ? layers.findIndex((l) => l.id === beforeId) : -1;
            const copy = { ...spec, layout: { ...spec.layout }, paint: { ...spec.paint } };
            if (at >= 0) layers.splice(at, 0, copy);
            else layers.push(copy);
        },
        removeLayer: (id: string) => {
            const at = layers.findIndex((l) => l.id === id);
            if (at >= 0) layers.splice(at, 1);
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
            if (layer) layer.layout = { ...layer.layout, [prop]: value };
        },
        isMoving: () => false,
        areTilesLoaded: () => true,
        _specs: layers,
    };
    const map = new Proxy(target, {
        get: (t, prop: string) => (prop in t ? (t as Record<string, unknown>)[prop] : () => undefined),
    }) as unknown as mapboxgl.Map;
    return { map, layers };
}

const empty: FeatureCollection = { type: 'FeatureCollection', features: [] };
const noData = new Proxy({ cellCount: 0 } as Record<string, unknown>, {
    get: (t, key: string) => (key in t ? t[key] : empty),
}) as unknown as EncMergedVectorData;

const { map, layers } = stubMap();
mountEncVectorLayer(map, noData, { minZoom: 7 });

/** Every symbol layer that draws a MARK from the hazard points source (names excluded). */
const hazardMarkLayers = (stack: Spec[]): Spec[] =>
    stack.filter((l) => l.type === 'symbol' && l.source === ENC_VEC_SRC.POINTS && l.id !== ENC_VEC_LAYERS.POINTS_LABEL);

const hazardSpec = (): Spec => {
    const found = layers.find((l) => l.id === HAZARDS);
    if (!found) throw new Error(`the one hazard layer (${String(HAZARDS)}) was not mounted`);
    return found;
};

type Mark = { tag: string; _kind: string; VALSOU?: unknown; [k: string]: unknown };

/** The points source exactly as the map is handed it: the source table's row (buildMergedPoints). */
const POINTS_ROW = ENC_SOURCE_TABLE.find((row) => row.id === ENC_VEC_SRC.POINTS);

/** Marks through the REAL merge, in the order the map's source lists them. */
function mergedPoints(marks: Mark[]): Array<Record<string, unknown>> {
    if (!POINTS_ROW) throw new Error('no points row in ENC_SOURCE_TABLE');
    const byClass: Record<string, FeatureCollection> = {};
    for (const cls of layerIds.S57_HAZARD_POINT_CLASSES) {
        byClass[cls] = {
            type: 'FeatureCollection',
            features: marks
                .filter((m) => m._kind === cls)
                .map(({ _kind: _cls, ...props }) => ({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [-5.4, 48.2] },
                    properties: props,
                })),
        };
    }
    const data = new Proxy({ cellCount: 1, ...byClass } as Record<string, unknown>, {
        get: (t, key: string) => (key in t ? t[key] : empty),
    }) as unknown as EncMergedVectorData;
    return POINTS_ROW.build(data).features.map((f) => (f.properties ?? {}) as Record<string, unknown>);
}

/**
 * Which of two touching marks Mapbox keeps, from the mounted stack and the
 * source the map is really handed: it places symbol layers top-down; within a
 * layer, in ascending symbol-sort-key, and equal keys in SOURCE order (a stable
 * sort); the first placed takes the space (icon-allow-overlap false on every
 * hazard).
 */
function survivorOf(a: Mark, b: Mark, zoom = 14): string {
    const stack = hazardMarkLayers(layers);
    const ranked = mergedPoints([a, b]).map((props, sourceIndex) => {
        const at = stack.findIndex((l) => evalExpr(l.filter, { props, zoom }) === true);
        if (at < 0) throw new Error(`${String(props.tag)} is drawn by no hazard layer`);
        const key = Number(evalExpr(stack[at].layout?.['symbol-sort-key'] ?? 0, { props, zoom }));
        return { tag: String(props.tag), at, key, sourceIndex };
    });
    // Higher layer first, then the lower key, then the earlier in the source.
    ranked.sort((x, y) => y.at - x.at || x.key - y.key || x.sourceIndex - y.sourceIndex);
    return ranked[0].tag;
}

/** The winner of a touching pair, asserted in both listing orders. */
function expectSurvivor(a: Mark, b: Mark, winner: string, zoom = 14): void {
    expect(survivorOf(a, b, zoom), `${a.tag} | ${b.tag}`).toBe(winner);
    expect(survivorOf(b, a, zoom), `${b.tag} | ${a.tag}`).toBe(winner);
}

describe('one symbol layer draws every wreck, rock and obstruction', () => {
    it('exactly one mark layer reads the hazard points, and it is the hazard layer', () => {
        expect(HAZARDS, 'ENC_VEC_LAYERS.HAZARDS').toBe('enc-vec-hazards-symbol');
        expect(hazardMarkLayers(layers).map((l) => l.id)).toEqual([HAZARDS]);
        for (const id of OLD_PER_CLASS_IDS) expect(map.getLayer(id), id).toBeUndefined();
    });

    it('its filter takes the three hazard classes and nothing else, with SCAMIN kept', () => {
        const passes = (props: Record<string, unknown>, zoom = 10) =>
            evalExpr(hazardSpec().filter, { props, zoom }) === true;
        for (const kind of ['OBSTRN', 'WRECKS', 'UWTROC']) expect(passes({ _kind: kind }), kind).toBe(true);
        for (const kind of ['LIGHTS', 'BOYLAT', 'BCNISD', 'SOUNDG', ''])
            expect(passes({ _kind: kind }), kind).toBe(false);
        expect(passes({}), 'no _kind').toBe(false);
        // SCAMIN still retires a mark the chart asks to retire, and a hazard with
        // no SCAMIN is never zoom-hidden (it is what the router routes around).
        expect(passes({ _kind: 'UWTROC', _minZoom: 12 }, 11)).toBe(false);
        expect(passes({ _kind: 'UWTROC', _minZoom: 12 }, 12)).toBe(true);
        expect(passes({ _kind: 'UWTROC' }, 7)).toBe(true);
    });

    it('declutters exactly as before: no overlap, no ignore-placement, no padding, same size, minzoom and opacity', () => {
        const s = hazardSpec();
        expect(s.type).toBe('symbol');
        expect(s.source).toBe(ENC_VEC_SRC.POINTS);
        expect(s.minzoom).toBe(7);
        expect(s.layout?.['icon-allow-overlap']).toBe(false);
        expect(s.layout?.['icon-ignore-placement']).not.toBe(true);
        expect(s.layout?.['icon-padding']).toBeUndefined();
        expect(s.layout?.['text-field']).toBeUndefined();
        expect(s.layout?.['icon-size']).toEqual(['interpolate', ['linear'], ['zoom'], 7, 0.3, 11, 0.45, 15, 0.62]);
        expect(s.paint?.['icon-opacity']).toBe(0.85);
    });
});

describe('the shallowest danger wins, whatever its class', () => {
    it('one sort key, the one the merge stamps on every mark (read case-defensively there, via readS57)', () => {
        expect(hazardSpec().layout?.['symbol-sort-key']).toEqual(['to-number', ['get', '_hzSort'], 0]);
        const merged = mergedPoints([
            { tag: 'o', _kind: 'OBSTRN', VALSOU: 2 },
            { tag: 'w', _kind: 'WRECKS', valsou: 9, catwrk: 2 },
            { tag: 'r', _kind: 'UWTROC', VALSOU: '0.5', WATLEV: 3 },
        ]);
        for (const props of merged) expect(typeof props._hzSort, String(props.tag)).toBe('number');
    });

    it('a 0.5 m dangerous wreck beats a 15 m rock', () => {
        const wreck = { tag: 'wreck 0.5 m', _kind: 'WRECKS', VALSOU: 0.5, CATWRK: 2 };
        const rock = { tag: 'rock 15 m', _kind: 'UWTROC', VALSOU: 15, WATLEV: 3 };
        expect(survivorOf(rock, wreck)).toBe('wreck 0.5 m');
        expect(survivorOf(wreck, rock)).toBe('wreck 0.5 m');
    });

    it('a 2 m obstruction beats a 9 m wreck', () => {
        const obstruction = { tag: 'obstruction 2 m', _kind: 'OBSTRN', VALSOU: 2 };
        const wreck = { tag: 'wreck 9 m', _kind: 'WRECKS', VALSOU: 9, CATWRK: 2 };
        expect(survivorOf(wreck, obstruction)).toBe('obstruction 2 m');
        expect(survivorOf(obstruction, wreck)).toBe('obstruction 2 m');
    });

    it('an obstruction of unknown depth beats a 1 m rock (fail-safe: an unknown danger reads as 0)', () => {
        const unknown = { tag: 'obstruction, no depth', _kind: 'OBSTRN' };
        const rock = { tag: 'rock 1 m', _kind: 'UWTROC', VALSOU: 1, WATLEV: 3 };
        expectSurvivor(rock, unknown, 'obstruction, no depth');
        const wreck = { tag: 'dangerous wreck, no depth', _kind: 'WRECKS', CATWRK: 2 };
        expectSurvivor(rock, wreck, 'dangerous wreck, no depth');
        const unsure = { tag: 'wreck, no category, no depth', _kind: 'WRECKS' };
        expectSurvivor(
            unsure,
            { tag: 'obstruction 0.4 m', _kind: 'OBSTRN', VALSOU: 0.4 },
            'wreck, no category, no depth',
        );
    });

    it('a rock that dries beats a 0.5 m wreck, and a depth carried as text still sorts as a number', () => {
        const drying = { tag: 'rock dries 0.4 m', _kind: 'UWTROC', VALSOU: -0.4, WATLEV: 4 };
        const wreck = { tag: 'wreck 0.5 m', _kind: 'WRECKS', VALSOU: '0.5' };
        expectSurvivor(wreck, drying, 'rock dries 0.4 m');
        const textDeep = { tag: 'obstruction "12"', _kind: 'OBSTRN', VALSOU: '12' };
        const rock = { tag: 'rock 3 m', _kind: 'UWTROC', VALSOU: 3 };
        expectSurvivor(textDeep, rock, 'rock 3 m');
    });

    it('within one class it is unchanged: the 2 m rock beats the 9 m rock (Shane 2026-08-07)', () => {
        const deep = { tag: 'rock 9 m', _kind: 'UWTROC', VALSOU: 9 };
        const shallow = { tag: 'rock 2 m', _kind: 'UWTROC', VALSOU: 2 };
        expectSurvivor(deep, shallow, 'rock 2 m');
    });
});

describe('a mark the chart itself calls non-dangerous never takes the space from a danger', () => {
    // Foul ground (CATOBS 7, INT1 K31: not a danger to surface navigation) and
    // a non-dangerous wreck (CATWRK 1) are usually charted with no VALSOU. As
    // three layers, every rock and wreck was placed before any obstruction and
    // every rock before any wreck, so they never hid one. In one layer a flat
    // "no depth = 0" put them ahead of every sounded danger of another class
    // (125-04 review, measured in both engines at z7, z13 and z16).
    const foul = { tag: 'foul ground, no depth', _kind: 'OBSTRN', CATOBS: 7 };
    const safeWreck = { tag: 'non-dangerous wreck, no depth', _kind: 'WRECKS', CATWRK: 1, WATLEV: 3 };

    it('foul ground of unknown depth loses to a 0.5 m dangerous wreck and to a 15 m rock', () => {
        expectSurvivor(foul, { tag: 'wreck 0.5 m', _kind: 'WRECKS', VALSOU: 0.5, CATWRK: 2 }, 'wreck 0.5 m');
        expectSurvivor(foul, { tag: 'rock 15 m', _kind: 'UWTROC', VALSOU: 15, WATLEV: 3 }, 'rock 15 m');
        expectSurvivor(foul, { tag: 'obstruction 20 m', _kind: 'OBSTRN', VALSOU: 20 }, 'obstruction 20 m');
    });

    it('a non-dangerous wreck of unknown depth loses to a 1 m rock and to a 0.5 m rock', () => {
        expectSurvivor(safeWreck, { tag: 'rock 1 m', _kind: 'UWTROC', VALSOU: 1, WATLEV: 3 }, 'rock 1 m');
        expectSurvivor(safeWreck, { tag: 'rock 0.5 m', _kind: 'UWTROC', VALSOU: 0.5, WATLEV: 3 }, 'rock 0.5 m');
        expectSurvivor(safeWreck, { tag: 'obstruction 6 m', _kind: 'OBSTRN', VALSOU: 6 }, 'obstruction 6 m');
    });

    it('foul ground of unknown depth loses to a rock awash at chart datum that carries no depth', () => {
        expectSurvivor(foul, { tag: 'rock awash, no depth', _kind: 'UWTROC', WATLEV: 5 }, 'rock awash, no depth');
    });

    it('still a danger when the chart says so: a sounding, or a mark that dries, counts first', () => {
        // The chart's own sounding outranks the category.
        const shoalFoul = { tag: 'foul ground 0.3 m', _kind: 'OBSTRN', CATOBS: 7, VALSOU: 0.3 };
        expectSurvivor(shoalFoul, { tag: 'rock 1 m', _kind: 'UWTROC', VALSOU: 1, WATLEV: 3 }, 'foul ground 0.3 m');
        // A mark that covers and uncovers is something a keel finds, whatever its category.
        const dryingFoul = { tag: 'foul ground that dries', _kind: 'OBSTRN', CATOBS: 7, WATLEV: 4 };
        expectSurvivor(
            dryingFoul,
            { tag: 'wreck 0.5 m', _kind: 'WRECKS', VALSOU: 0.5, CATWRK: 2 },
            'foul ground that dries',
        );
    });

    it('a blank or missing depth is unknown, not 0 m', () => {
        const wreck = { tag: 'wreck 0.5 m', _kind: 'WRECKS', VALSOU: 0.5, CATWRK: 2 };
        for (const blank of ['', '  ', null, 'n/a']) {
            expectSurvivor(
                { ...foul, tag: `foul ground, VALSOU ${JSON.stringify(blank)}`, VALSOU: blank },
                wreck,
                'wreck 0.5 m',
            );
        }
    });
});

describe('a cell with lower-case attribute names sorts exactly like an upper-case one', () => {
    // ogr2ogr cells can carry lower-case names (encDepthStyle.ts hard rule 2);
    // the glyphs already read both. A key on 'VALSOU' alone tied every mark of
    // such a cell at 0 and left the source order (obstructions first) to pick.
    it('a 0.5 m wreck beats a 20 m and a 9 m obstruction', () => {
        const wreck = { tag: 'wreck 0.5 m (lower-case)', _kind: 'WRECKS', valsou: 0.5, catwrk: 2 };
        expectSurvivor({ tag: 'obstruction 20 m (lower-case)', _kind: 'OBSTRN', valsou: 20 }, wreck, wreck.tag);
        expectSurvivor({ tag: 'obstruction 9 m (lower-case)', _kind: 'OBSTRN', valsou: 9 }, wreck, wreck.tag);
    });

    it('a 0.5 m obstruction beats a 20 m rock, and a 2 m obstruction a 9 m wreck, against the old class order', () => {
        // Rocks and wrecks used to be placed before obstructions, so a depth
        // read as missing here hands the space back to the deeper mark.
        const shoal = { tag: 'obstruction 0.5 m (lower-case)', _kind: 'OBSTRN', valsou: 0.5 };
        expectSurvivor({ tag: 'rock 20 m (lower-case)', _kind: 'UWTROC', valsou: 20, watlev: 3 }, shoal, shoal.tag);
        const two = { tag: 'obstruction 2 m (lower-case)', _kind: 'OBSTRN', valsou: 2 };
        expectSurvivor({ tag: 'wreck 9 m (lower-case)', _kind: 'WRECKS', valsou: 9, catwrk: 2 }, two, two.tag);
    });

    it('lower-case foul ground or non-dangerous wreck, no depth, loses to a sounded danger', () => {
        const rock = { tag: 'rock 0.5 m (lower-case)', _kind: 'UWTROC', valsou: 0.5, watlev: 3 };
        const foul = { tag: 'foul ground (lower-case)', _kind: 'OBSTRN', catobs: 7 };
        expectSurvivor(foul, rock, rock.tag);
        const obstruction = { tag: 'obstruction 3 m (lower-case)', _kind: 'OBSTRN', valsou: 3 };
        expectSurvivor(foul, obstruction, obstruction.tag);
        expectSurvivor(
            { tag: 'non-dangerous wreck (lower-case)', _kind: 'WRECKS', catwrk: 1, watlev: 3 },
            obstruction,
            obstruction.tag,
        );
    });

    it('a lower-case mark that dries, no depth, ranks as drying', () => {
        const drying = { tag: 'rock that dries (lower-case)', _kind: 'UWTROC', watlev: 4 };
        expectSurvivor({ tag: 'obstruction, no depth', _kind: 'OBSTRN' }, drying, drying.tag);
        const dryingObstruction = { tag: 'obstruction that dries (lower-case)', _kind: 'OBSTRN', watlev: 4 };
        expectSurvivor(
            { tag: 'rock awash, VALSOU 0', _kind: 'UWTROC', VALSOU: 0, WATLEV: 5 },
            dryingObstruction,
            dryingObstruction.tag,
        );
    });
});

describe('equal depths keep the old priority: rock, then wreck, then obstruction', () => {
    // Mapbox breaks a sort-key tie by source order, and the merge lists
    // obstructions first. The key carries the class order itself, so a rock
    // the chart says dries or lies awash is never given up to an unknown
    // obstruction.
    const unknownObstruction = { tag: 'obstruction, no depth', _kind: 'OBSTRN' };

    it('a rock that covers and uncovers, with no depth, beats an obstruction of unknown depth', () => {
        for (const watlev of [1, 2, 4]) {
            const rock = { tag: `rock WATLEV ${watlev}, no depth`, _kind: 'UWTROC', WATLEV: watlev };
            expectSurvivor(unknownObstruction, rock, rock.tag);
        }
    });

    it('a mark that dries, height unknown, ranks below chart datum: it beats one awash at 0, whatever the class', () => {
        // S-52 gives a drying mark with no VALSOU -15 m; it stands above the
        // water at low tide, so it is shallower than a rock awash at datum.
        const awash0 = { tag: 'rock awash, VALSOU 0', _kind: 'UWTROC', VALSOU: 0, WATLEV: 5 };
        for (const watlev of [1, 2, 4]) {
            const wreck = { tag: `wreck WATLEV ${watlev}, no depth`, _kind: 'WRECKS', WATLEV: watlev };
            expectSurvivor(awash0, wreck, wreck.tag);
            const obstruction = { tag: `obstruction WATLEV ${watlev}, no depth`, _kind: 'OBSTRN', WATLEV: watlev };
            expectSurvivor(awash0, obstruction, obstruction.tag);
        }
    });

    it('a rock awash at chart datum (VALSOU 0, or no depth) beats an obstruction or wreck of unknown depth', () => {
        const awash0 = { tag: 'rock awash, VALSOU 0', _kind: 'UWTROC', VALSOU: 0, WATLEV: 5 };
        const awash = { tag: 'rock awash, no depth', _kind: 'UWTROC', WATLEV: 5 };
        const wreck = { tag: 'dangerous wreck, no depth', _kind: 'WRECKS', CATWRK: 2 };
        for (const rock of [awash0, awash]) {
            expectSurvivor(unknownObstruction, rock, rock.tag);
            expectSurvivor(wreck, rock, rock.tag);
        }
    });

    it('a wreck of unknown depth beats an obstruction of unknown depth; equal soundings likewise', () => {
        expectSurvivor(unknownObstruction, { tag: 'wreck, no depth', _kind: 'WRECKS' }, 'wreck, no depth');
        expectSurvivor(
            { tag: 'obstruction 3 m', _kind: 'OBSTRN', VALSOU: 3 },
            { tag: 'wreck 3 m', _kind: 'WRECKS', VALSOU: 3, CATWRK: 2 },
            'wreck 3 m',
        );
        expectSurvivor(
            { tag: 'wreck 3 m', _kind: 'WRECKS', VALSOU: 3, CATWRK: 2 },
            { tag: 'rock 3 m', _kind: 'UWTROC', VALSOU: 3 },
            'rock 3 m',
        );
    });
});

describe('every class keeps its own INT1 glyph', () => {
    const glyph = (props: Record<string, unknown>) => evalExpr(hazardSpec().layout?.['icon-image'], { props });

    it('OBSTRN: CATOBS 7 is foul ground, every other category and none is the dangerous obstruction', () => {
        for (const cat of ['1', '2', '3', '4', '5', '6', '8', '9', '10', '']) {
            expect(glyph({ _kind: 'OBSTRN', CATOBS: cat }), `CATOBS ${cat}`).toBe('sm-hazard-obstruction');
        }
        expect(glyph({ _kind: 'OBSTRN', CATOBS: '7' })).toBe('sm-hazard-foul');
        expect(glyph({ _kind: 'OBSTRN', CATOBS: 7 })).toBe('sm-hazard-foul');
        expect(glyph({ _kind: 'OBSTRN', catobs: '7' }), 'lower-case attribute').toBe('sm-hazard-foul');
        expect(glyph({ _kind: 'OBSTRN' })).toBe('sm-hazard-obstruction');
    });

    it('WRECKS: 1 non-dangerous, 4 mast, 5 hull, and 2, 3 or unknown read dangerous', () => {
        const expected: Record<string, string> = {
            '1': 'sm-hazard-wreck',
            '2': 'sm-hazard-wreck-dangerous',
            '3': 'sm-hazard-wreck-dangerous',
            '4': 'sm-hazard-wreck-mast',
            '5': 'sm-hazard-wreck-hull',
            '': 'sm-hazard-wreck-dangerous',
        };
        for (const [cat, id] of Object.entries(expected)) {
            expect(glyph({ _kind: 'WRECKS', CATWRK: cat }), `CATWRK ${cat}`).toBe(id);
        }
        expect(glyph({ _kind: 'WRECKS', catwrk: 4 }), 'lower-case attribute').toBe('sm-hazard-wreck-mast');
        expect(glyph({ _kind: 'WRECKS' })).toBe('sm-hazard-wreck-dangerous');
    });

    it('UWTROC: the tested WATLEV table, and the plain submerged cross for anything else', () => {
        const table = new Map(UWTROC_ROCK_GLYPH.map(([w, id]) => [w, id]));
        for (const w of ['1', '2', '3', '4', '5', '6', '7', '']) {
            expect(glyph({ _kind: 'UWTROC', WATLEV: w }), `WATLEV ${w}`).toBe(
                table.get(w) ?? UWTROC_ROCK_GLYPH_DEFAULT,
            );
        }
        expect(glyph({ _kind: 'UWTROC', WATLEV: '4' })).toBe('sm-hazard-rock-drying');
        expect(glyph({ _kind: 'UWTROC', watlev: 5 }), 'lower-case attribute').toBe('sm-hazard-rock-awash-cd');
        expect(glyph({ _kind: 'UWTROC' })).toBe('sm-hazard-rock');
    });

    it('a class attribute never leaks across classes: a wreck with WATLEV 4 is still a wreck', () => {
        expect(glyph({ _kind: 'WRECKS', WATLEV: '4', CATWRK: '1' })).toBe('sm-hazard-wreck');
        expect(glyph({ _kind: 'UWTROC', CATOBS: '7' })).toBe('sm-hazard-rock');
        expect(glyph({ _kind: 'OBSTRN', CATWRK: '4' })).toBe('sm-hazard-obstruction');
    });
});

describe('every consumer follows the one layer', () => {
    it('the canonical stack holds it once, above the hazard names and below the lights', () => {
        const at = (id: string) => ALL_LAYER_IDS.indexOf(id);
        expect(ALL_LAYER_IDS.filter((id) => id === HAZARDS)).toHaveLength(1);
        for (const id of OLD_PER_CLASS_IDS) expect(ALL_LAYER_IDS, id).not.toContain(id);
        expect(at(ENC_VEC_LAYERS.POINTS_LABEL)).toBeGreaterThan(-1);
        expect(at(ENC_VEC_LAYERS.POINTS_LABEL), 'names below the marks (c9535e92)').toBeLessThan(at(HAZARDS));
        expect(at(HAZARDS)).toBeLessThan(at(ENC_VEC_LAYERS.LIGHTS));
    });

    it('it is tappable, and its popup answers by class', () => {
        expect(CLICKABLE_LAYER_IDS).toContain(HAZARDS);
        const title = (props: Record<string, unknown>) =>
            buildFeaturePopupHtml(HAZARDS, props).match(/enc-popup-title[^>]*>([^<]*)</)?.[1];
        expect(title({ _kind: 'OBSTRN', VALSOU: 2 })).toBe('Obstruction');
        expect(title({ _kind: 'WRECKS', VALSOU: 0.5, CATWRK: 2 })).toBe('Wreck');
        expect(title({ _kind: 'UWTROC', VALSOU: 15 })).toBe('Underwater rock');
        // A hazard whose class went missing still reads as a danger, never as a bare "Feature".
        expect(title({ VALSOU: 3 })).toBe('Charted danger');
        const wreck = buildFeaturePopupHtml(HAZARDS, { _kind: 'WRECKS', VALSOU: 0.5, CATWRK: '2' });
        expect(wreck).toContain('0.5');
        expect(wreck).toMatch(/Category<\/span><b>[^<]*[Dd]angerous/);
    });

    it('the mark-class binding sends every hazard class to the one layer and every navaid to its own', () => {
        const encMarkLayerId = (layerIds as Record<string, unknown>).encMarkLayerId as
            | ((cls: string) => string)
            | undefined;
        expect(typeof encMarkLayerId).toBe('function');
        for (const cls of layerIds.S57_HAZARD_POINT_CLASSES) expect(encMarkLayerId!(cls), cls).toBe(HAZARDS);
        const navaidIds = layerIds.S57_NAVAID_CLASSES.map((cls) => encMarkLayerId!(cls));
        expect(new Set(navaidIds).size).toBe(layerIds.S57_NAVAID_CLASSES.length);
        expect(navaidIds).not.toContain(HAZARDS);
    });

    it('a live map an older bundle built heals: the per-class layers go and the one layer sits above the names', () => {
        const old = OLD_PER_CLASS_IDS.map(
            (id): Spec => ({ id, type: 'symbol', source: ENC_VEC_SRC.POINTS, layout: {}, paint: {} }),
        );
        const live = stubMap(old);
        expect(RETIRED_ENC_LAYER_IDS).toEqual(expect.arrayContaining(OLD_PER_CLASS_IDS));
        mountEncVectorLayer(live.map, noData, { minZoom: 7 });
        const ids = live.layers.map((l) => l.id);
        for (const id of OLD_PER_CLASS_IDS) expect(ids, id).not.toContain(id);
        expect(hazardMarkLayers(live.layers).map((l) => l.id)).toEqual([HAZARDS]);
        expect(ids.indexOf(ENC_VEC_LAYERS.POINTS_LABEL)).toBeLessThan(ids.indexOf(HAZARDS));
        // And the teardown takes everything, old and new.
        live.layers.push(...old.map((s) => ({ ...s })));
        unmountEncVectorLayer(live.map);
        expect(live.layers.map((l) => l.id).filter((id) => id.startsWith('enc-vec-'))).toEqual([]);
    });
});
