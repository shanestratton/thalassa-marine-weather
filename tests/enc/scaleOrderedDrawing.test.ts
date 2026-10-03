/**
 * SCALE-ORDERED CHART DRAWING (item f, Shane 2026-10-02: "we should overlay
 * the charts the other way so the water is drawn over the land").
 *
 * Cid Harbour, 2026-10-02: the 1:3,500,000 overview cell's coarse land blob
 * was drawn over the harbour the 1:90,000 cell charts 10–15 m deep, because
 * the chart layer drew EVERY cell's land above EVERY cell's water. Chart
 * plotters draw the best scale on top: each cell's area fills (water, land,
 * coastline) go down coarsest first, finest last. The overview's land then
 * sits UNDER the detailed chart's water, and the detailed chart's small
 * islands sit OVER the overview's water — not "all water over all land",
 * which would paint the overview's water over islands only the detailed
 * chart has.
 *
 * The fineness is the router's own (cellFinenessRank: compilation scale, else
 * the S-57 name's usage band), so the map and the route agree on which chart
 * is finer. Synthetic cells only (the repo is public): the real merge fold
 * runs over them, the real mount builds the layers on a recording stub map,
 * and each feature's paint position is read off the final layer stack.
 */
import { describe, it, expect, vi, beforeAll } from 'vitest';
import type { Feature, FeatureCollection, Geometry } from 'geojson';

import type { EncCell, EncConversionResult } from '../../services/enc/types';
import { paintedAt, recordingMap, type StubLayer } from '../helpers/encLayerStack';

// ── Fixtures (synthetic, nowhere real) ──────────────────────────────

const square = (minLon: number, minLat: number, maxLon: number, maxLat: number): Geometry => ({
    type: 'Polygon',
    coordinates: [
        [
            [minLon, minLat],
            [maxLon, minLat],
            [maxLon, maxLat],
            [minLon, maxLat],
            [minLon, minLat],
        ],
    ],
});
const line = (coords: [number, number][]): Geometry => ({ type: 'LineString', coordinates: coords });
const feat = (geometry: Geometry, properties: Record<string, unknown>): Feature => ({
    type: 'Feature',
    geometry,
    properties,
});
const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });

const cell = (id: string, bbox: [number, number, number, number], usage?: EncCell['usage']): EncCell =>
    ({
        id,
        sourceHO: 'AU',
        edition: 1,
        issued: '2026-01-01',
        importedAt: '2026-10-03T00:00:00Z',
        bbox,
        geojsonPath: `enc/${id}.json`,
        ...(usage ? { usage } : {}),
    }) as EncCell;

// OVERVIEW: an overview chart (1:3,500,000 — usage band 1). DETAILED: a
// 1:90,000 chart (band 4) inside it. The bbox ratio is 16 — the display's
// whole-feature scale-shadow drop is in play, so the overview's land blob is
// drawn to poke OUTSIDE the detailed chart, as the real one does (a blob the
// drop cannot remove: only drawing order can put it under the harbour).
const OVERVIEW = cell('OVERVIEW', [10, 10, 14, 14]);
const DETAILED = cell('DETAILED', [10.8, 10.8, 11.8, 11.8]);
// HARBOUR: a 1:45,000 chart — the SAME usage band (4) as DETAILED, a finer
// scale — that charts a basin where DETAILED draws its island (the within-band
// case per-band grouping would have left under the coarser chart's land).
const HARBOUR = cell('HARBOUR', [11.6, 11.1, 11.79, 11.4]);
// A cell that does not say its scale (no compilation scale, no S-57 band in
// its name), far away from both.
const UNSCALED = cell('OC-00-UNSCALED', [20, 20, 20.5, 20.5]);

const overviewBlob: EncConversionResult = {
    cellId: 'OVERVIEW',
    sourceHO: 'AU',
    nativeScale: 3_500_000,
    edition: 1,
    issued: '2026-01-01',
    bbox: OVERVIEW.bbox,
    layers: {
        // The coarse land blob over the "harbour" — and beyond the detailed chart.
        LNDARE: fc([feat(square(10.5, 11.0, 11.6, 11.6), { tag: 'overview-land' })]),
        // The overview's coarse water — over the island only the detailed chart has.
        DEPARE: fc([feat(square(11.65, 10, 14, 14), { DRVAL1: 0, DRVAL2: 30, tag: 'overview-water' })]),
        // The overview's coastline, straight across the harbour.
        COALNE: fc([
            feat(
                line([
                    [10.5, 11.3],
                    [11.6, 11.3],
                ]),
                { tag: 'overview-coast' },
            ),
        ]),
    },
};

const detailedBlob: EncConversionResult = {
    cellId: 'DETAILED',
    sourceHO: 'AU',
    nativeScale: 90_000,
    edition: 1,
    issued: '2026-01-01',
    bbox: DETAILED.bbox,
    layers: {
        DEPARE: fc([
            // The harbour, charted 10–15 m, under the overview's land blob.
            feat(square(11.1, 11.1, 11.5, 11.5), { DRVAL1: 10, DRVAL2: 15, tag: 'detailed-harbour' }),
            // The water round the island, under the overview's water.
            feat(square(11.66, 10.9, 11.8, 11.5), { DRVAL1: 5, DRVAL2: 10, tag: 'detailed-sea' }),
        ]),
        // A small island the overview leaves out, in the overview's water.
        LNDARE: fc([feat(square(11.7, 11.2, 11.75, 11.25), { tag: 'detailed-island' })]),
        COALNE: fc([
            feat(
                line([
                    [11.7, 11.2],
                    [11.75, 11.2],
                    [11.75, 11.25],
                    [11.7, 11.25],
                    [11.7, 11.2],
                ]),
                { tag: 'detailed-coast' },
            ),
        ]),
    },
};

const harbourBlob: EncConversionResult = {
    cellId: 'HARBOUR',
    sourceHO: 'AU',
    nativeScale: 45_000,
    edition: 1,
    issued: '2026-01-01',
    bbox: HARBOUR.bbox,
    layers: {
        DEPARE: fc([feat(square(11.71, 11.21, 11.74, 11.24), { DRVAL1: 2, DRVAL2: 5, tag: 'harbour-basin' })]),
    },
};

const unscaledBlob: EncConversionResult = {
    cellId: 'OC-00-UNSCALED',
    sourceHO: 'AU',
    edition: 1,
    issued: '2026-01-01',
    bbox: UNSCALED.bbox,
    layers: {
        DEPARE: fc([feat(square(20, 20, 20.5, 20.25), { DRVAL1: 5, DRVAL2: 10, tag: 'unscaled-water' })]),
        LNDARE: fc([feat(square(20, 20.25, 20.5, 20.5), { tag: 'unscaled-land' })]),
    },
};

// UNSIGNED REFERENCE PACKS (localEncPackImport: every chart a Pi-less user
// has, and any pack a Pi user imports) — two more sets, far from the first,
// merged the way the chart layer merges them (includeReferences).
//
// MIXED: a navigation 1:1,500,000 chart whose coarse water runs over an island
// only a reference 1:12,000 plan charts, and whose land blob lies over the
// plan's water.
const NAV_GENERAL = cell('NAV_GENERAL', [30, 30, 34, 34]);
const REF_PLAN = cell('REF_PLAN', [31.2, 31.2, 31.6, 31.6], 'reference');
// REFERENCE-ONLY: a reference 1:3,500,000 overview whose land blob covers a
// harbour a reference 1:12,000 plan charts as water (Cid Harbour, for a
// public-beta user whose charts are all imported).
const REF_OVERVIEW = cell('REF_OVERVIEW', [40, 40, 44, 44], 'reference');
const REF_HARBOUR = cell('REF_HARBOUR', [41, 41, 41.5, 41.5], 'reference');

const scaled = (id: string, bbox: EncCell['bbox'], nativeScale: number, layers: EncConversionResult['layers']) =>
    ({
        cellId: id,
        sourceHO: 'AU',
        nativeScale,
        edition: 1,
        issued: '2026-01-01',
        bbox,
        layers,
    }) as EncConversionResult;

const navGeneralBlob = scaled('NAV_GENERAL', NAV_GENERAL.bbox, 1_500_000, {
    DEPARE: fc([feat(square(31.25, 31.4, 34, 34), { DRVAL1: 20, DRVAL2: 50, tag: 'nav-water' })]),
    LNDARE: fc([feat(square(31.25, 31.25, 31.3, 31.3), { tag: 'nav-land' })]),
});
const refPlanBlob = scaled('REF_PLAN', REF_PLAN.bbox, 12_000, {
    DEPARE: fc([feat(square(31.2, 31.2, 31.6, 31.4), { DRVAL1: 5, DRVAL2: 10, tag: 'ref-plan-water' })]),
    LNDARE: fc([feat(square(31.3, 31.45, 31.35, 31.5), { tag: 'ref-plan-island' })]),
});
const refOverviewBlob = scaled('REF_OVERVIEW', REF_OVERVIEW.bbox, 3_500_000, {
    // Pokes outside the plan, so the whole-feature shadow drop cannot take it.
    LNDARE: fc([feat(square(40.5, 40.5, 41.6, 41.6), { tag: 'ref-overview-land' })]),
});
const refHarbourBlob = scaled('REF_HARBOUR', REF_HARBOUR.bbox, 12_000, {
    DEPARE: fc([feat(square(41.1, 41.1, 41.4, 41.4), { DRVAL1: 10, DRVAL2: 15, tag: 'ref-harbour-water' })]),
});

const blobs: Record<string, EncConversionResult> = {
    OVERVIEW: overviewBlob,
    DETAILED: detailedBlob,
    HARBOUR: harbourBlob,
    'OC-00-UNSCALED': unscaledBlob,
    NAV_GENERAL: navGeneralBlob,
    REF_PLAN: refPlanBlob,
    REF_OVERVIEW: refOverviewBlob,
    REF_HARBOUR: refHarbourBlob,
};
const CELLS = [OVERVIEW, DETAILED, HARBOUR, UNSCALED];
/** What the chart layer's merge (includeReferences) lists — set per scenario. */
let displayCells: EncCell[] = CELLS;
const ALL_CELLS = [...CELLS, NAV_GENERAL, REF_PLAN, REF_OVERVIEW, REF_HARBOUR];

vi.mock('../../services/enc/EncCellMetadata', () => ({
    listCells: () => CELLS,
    listDisplayCells: () => displayCells,
    listPendingCells: () => [],
    getCell: (id: string) => ALL_CELLS.find((c) => c.id === id),
    cellsForBBox: () => CELLS,
    getVersion: () => 1,
    putCell: () => undefined,
    removeCell: () => undefined,
    subscribe: () => () => undefined,
}));
vi.mock('../../services/enc/EncCellStore', () => ({
    loadCellGeoJSON: async (id: string) => blobs[id] ?? null,
    readCellRaw: async (id: string) =>
        blobs[id] ? { kind: 'cached' as const, blob: blobs[id] } : { kind: 'missing' as const },
    parseAndCacheCellText: (_id: string, text: string) => JSON.parse(text),
    saveCellGeoJSON: async () => undefined,
    deleteCellGeoJSON: async () => undefined,
    blobCacheStats: () => ({ entries: 0, textMB: 0 }),
}));
// Sprite registration loads images; the layer stack is what is under test.
vi.mock('../../components/map/seamarkIcons', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    registerSeamarkIcons: async () => undefined,
}));

import { getMergedVectorData, type EncMergedVectorData } from '../../services/enc/EncHazardService';
import { mountEncVectorLayer } from '../../components/map/EncVectorLayer';
import { ENC_VEC_LAYERS, ENC_VEC_SRC } from '../../components/map/encLayerIds';
import { setEncMapBase, syncDepareBaseTreatment } from '../../components/map/encDepthStyleState';
import {
    ENC_DRAW_TIER_COUNT,
    cellFinenessRank,
    encDrawTier,
    overviewLandYields,
    referenceWaterYields,
} from '../../services/enc/scaleShadow';

let merged: EncMergedVectorData;
let stack: StubLayer[];
const byTag = (fcol: FeatureCollection, tag: string): Feature => {
    const f = fcol.features.find((x) => x.properties?.tag === tag);
    if (!f) throw new Error(`no merged feature tagged ${tag}`);
    return f;
};
/** The ONE stack position a feature paints at (fails on none or several). */
function at(source: string, fcol: FeatureCollection, tag: string): number {
    const hits = paintedAt(stack, source, byTag(fcol, tag));
    expect(hits, `${tag} must paint in exactly one layer`).toHaveLength(1);
    return hits[0];
}

describe('scale-ordered chart drawing (item f)', () => {
    beforeAll(async () => {
        merged = (await getMergedVectorData())!;
        expect(merged).not.toBeNull();
        const { map, layers } = recordingMap();
        mountEncVectorLayer(map, merged, {});
        stack = layers;
    });

    it('the detailed chart’s water covers the overview’s coarse land (Cid Harbour)', () => {
        const overviewLand = at(ENC_VEC_SRC.LNDARE, merged.LNDARE, 'overview-land');
        const harbour = at(ENC_VEC_SRC.DEPARE, merged.DEPARE, 'detailed-harbour');
        expect(harbour).toBeGreaterThan(overviewLand);
        // …and the overview's coastline across the harbour goes under it too.
        expect(harbour).toBeGreaterThan(at(ENC_VEC_SRC.COALNE, merged.COALNE, 'overview-coast'));
    });

    it('the detailed chart’s island covers the overview’s coarse water (not all water over all land)', () => {
        const overviewWater = at(ENC_VEC_SRC.DEPARE, merged.DEPARE, 'overview-water');
        const island = at(ENC_VEC_SRC.LNDARE, merged.LNDARE, 'detailed-island');
        expect(island).toBeGreaterThan(overviewWater);
        // The island's coastline draws over its own water and the overview's.
        const coast = at(ENC_VEC_SRC.COALNE, merged.COALNE, 'detailed-coast');
        expect(coast).toBeGreaterThan(at(ENC_VEC_SRC.DEPARE, merged.DEPARE, 'detailed-sea'));
        expect(coast).toBeGreaterThan(island);
    });

    it('within one usage band, the finer scale’s water covers the coarser scale’s land (1:45,000 over 1:90,000)', () => {
        const basin = at(ENC_VEC_SRC.DEPARE, merged.DEPARE, 'harbour-basin');
        expect(basin).toBeGreaterThan(at(ENC_VEC_SRC.LNDARE, merged.LNDARE, 'detailed-island'));
        expect(basin).toBeGreaterThan(at(ENC_VEC_SRC.COALNE, merged.COALNE, 'detailed-coast'));
    });

    it('each chart draws its own land over its own water, coarsest chart first', () => {
        const overviewWater = at(ENC_VEC_SRC.DEPARE, merged.DEPARE, 'overview-water');
        const overviewLand = at(ENC_VEC_SRC.LNDARE, merged.LNDARE, 'overview-land');
        const detailedSea = at(ENC_VEC_SRC.DEPARE, merged.DEPARE, 'detailed-sea');
        const island = at(ENC_VEC_SRC.LNDARE, merged.LNDARE, 'detailed-island');
        expect(overviewLand).toBeGreaterThan(overviewWater);
        expect(island).toBeGreaterThan(detailedSea);
        expect(detailedSea).toBeGreaterThan(overviewLand);
    });

    it('a chart that does not say its scale: its land stands on top, its water beats nothing (the router’s rule)', () => {
        const water = at(ENC_VEC_SRC.DEPARE, merged.DEPARE, 'unscaled-water');
        const land = at(ENC_VEC_SRC.LNDARE, merged.LNDARE, 'unscaled-land');
        expect(water).toBeLessThanOrEqual(at(ENC_VEC_SRC.DEPARE, merged.DEPARE, 'overview-water'));
        expect(land).toBeGreaterThan(at(ENC_VEC_SRC.DEPARE, merged.DEPARE, 'detailed-harbour'));
        expect(land).toBeGreaterThanOrEqual(at(ENC_VEC_SRC.LNDARE, merged.LNDARE, 'detailed-island'));
    });

    it('every area fill and coastline paints exactly once — nothing double-painted, nothing dropped', () => {
        for (const f of merged.DEPARE.features) expect(paintedAt(stack, ENC_VEC_SRC.DEPARE, f)).toHaveLength(1);
        for (const f of merged.LNDARE.features) expect(paintedAt(stack, ENC_VEC_SRC.LNDARE, f)).toHaveLength(1);
        for (const f of merged.COALNE.features) expect(paintedAt(stack, ENC_VEC_SRC.COALNE, f)).toHaveLength(1);
    });

    it('a merge from before the stamp (no draw tier on a feature) still paints it: water lowest, land on top', () => {
        const strip = (f: Feature): Feature => {
            const { _drawTier: _ignored, ...rest } = (f.properties ?? {}) as Record<string, unknown>;
            return { ...f, properties: rest };
        };
        const water = paintedAt(stack, ENC_VEC_SRC.DEPARE, strip(byTag(merged.DEPARE, 'detailed-harbour')));
        const land = paintedAt(stack, ENC_VEC_SRC.LNDARE, strip(byTag(merged.LNDARE, 'overview-land')));
        expect(water).toHaveLength(1);
        expect(land).toHaveLength(1);
        expect(land[0]).toBeGreaterThan(water[0]);
    });

    it('a map an older bundle drew on heals: the retired fine repaint goes, an unfiltered land layer is re-split', () => {
        const { map, layers } = recordingMap();
        // The pre-2026-10-03 stack: unfiltered LNDARE over all water, and the
        // bbox-ranked fine-water repaint.
        map.addLayer({ id: ENC_VEC_LAYERS.DEPARE, type: 'fill', source: ENC_VEC_SRC.DEPARE } as never);
        map.addLayer({ id: ENC_VEC_LAYERS.LNDARE, type: 'fill', source: ENC_VEC_SRC.LNDARE } as never);
        map.addLayer({ id: 'enc-vec-depare-fine-fill', type: 'fill', source: ENC_VEC_SRC.DEPARE } as never);
        mountEncVectorLayer(map, merged, {});
        mountEncVectorLayer(map, merged, {}); // and again: a cell load re-mounts
        expect(layers.some((l) => l.id === 'enc-vec-depare-fine-fill')).toBe(false);
        const harbour = paintedAt(layers, ENC_VEC_SRC.DEPARE, byTag(merged.DEPARE, 'detailed-harbour'));
        const overviewLand = paintedAt(layers, ENC_VEC_SRC.LNDARE, byTag(merged.LNDARE, 'overview-land'));
        expect(harbour).toHaveLength(1);
        expect(overviewLand).toHaveLength(1);
        expect(harbour[0]).toBeGreaterThan(overviewLand[0]);
        for (const f of merged.LNDARE.features) expect(paintedAt(layers, ENC_VEC_SRC.LNDARE, f)).toHaveLength(1);
    });

    it('the satellite base keeps the tier split and adds the competence ladder to every water layer', () => {
        const { map, layers } = recordingMap();
        mountEncVectorLayer(map, merged, {});
        setEncMapBase(map, true);
        syncDepareBaseTreatment(map);
        const waterLayers = layers.filter((l) => l.source === ENC_VEC_SRC.DEPARE && l.type === 'fill');
        expect(waterLayers.length).toBeGreaterThan(1);
        for (const l of waterLayers) {
            expect(l.paint['fill-opacity']).toBe(0);
            expect(JSON.stringify(l.filter)).toContain('_drawTier');
            expect(JSON.stringify(l.filter)).toContain('zoom');
        }
        setEncMapBase(map, false);
        syncDepareBaseTreatment(map);
        for (const l of waterLayers) {
            expect(l.paint['fill-opacity']).toBeGreaterThan(0.9);
            expect(JSON.stringify(l.filter)).toContain('_drawTier');
            expect(JSON.stringify(l.filter)).not.toContain('zoom');
        }
    });
});

// Review fix-up (2026-10-03): the first build pinned every reference pack to
// tier 1, water AND land. A reference plan's island then sat under a coarse
// navigation chart's water (it showed before item f, which drew all land over
// all water), and for a user whose charts are all imported, the plan's harbour
// sat under the reference overview's land again — Cid Harbour unfixed for
// them. Land and coast now draw at their own scale; only the water of a
// reference cell a navigation chart overlaps drops to tier 1.
describe('unsigned reference packs keep the scale order (review fix-up)', () => {
    async function mergeAndMount(cells: EncCell[]) {
        displayCells = cells;
        const data = (await getMergedVectorData(undefined, undefined, { includeReferences: true }))!;
        expect(data).not.toBeNull();
        const { map, layers } = recordingMap();
        mountEncVectorLayer(map, data, {});
        const one = (source: string, fcol: FeatureCollection, tag: string): number => {
            const hits = paintedAt(layers, source, byTag(fcol, tag));
            expect(hits, `${tag} must paint in exactly one layer`).toHaveLength(1);
            return hits[0];
        };
        return { data, one };
    }

    it('mixed: an imported plan’s island draws over a navigation chart’s coarse water', async () => {
        const { data, one } = await mergeAndMount([NAV_GENERAL, REF_PLAN]);
        const island = one(ENC_VEC_SRC.LNDARE, data.LNDARE, 'ref-plan-island');
        expect(island).toBeGreaterThan(one(ENC_VEC_SRC.DEPARE, data.DEPARE, 'nav-water'));
    });

    it('mixed: a navigation chart’s water and land still draw over the imported plan’s water', async () => {
        const { data, one } = await mergeAndMount([NAV_GENERAL, REF_PLAN]);
        const planWater = one(ENC_VEC_SRC.DEPARE, data.DEPARE, 'ref-plan-water');
        expect(one(ENC_VEC_SRC.LNDARE, data.LNDARE, 'nav-land')).toBeGreaterThan(planWater);
        expect(one(ENC_VEC_SRC.DEPARE, data.DEPARE, 'nav-water')).toBeGreaterThan(planWater);
    });

    it('reference only: the imported plan’s harbour water draws over the imported overview’s land', async () => {
        const { data, one } = await mergeAndMount([REF_OVERVIEW, REF_HARBOUR]);
        const harbour = one(ENC_VEC_SRC.DEPARE, data.DEPARE, 'ref-harbour-water');
        expect(harbour).toBeGreaterThan(one(ENC_VEC_SRC.LNDARE, data.LNDARE, 'ref-overview-land'));
    });
});

describe('encDrawTier — the router’s fineness, as a drawing order', () => {
    const tierOf = (nativeScale: number, kind: 'water' | 'land' = 'water') => encDrawTier({ nativeScale }, kind);

    it('one tier per standard compilation scale, nested in the usage bands', () => {
        // The scales the Pi's AU cells use (2026-10-03), coarse → fine.
        expect(
            [3_500_000, 1_500_000, 350_000, 180_000, 90_000, 45_000, 22_000, 18_000, 12_000, 8_000, 4_000, 3_000].map(
                (s) => tierOf(s),
            ),
        ).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
        expect(ENC_DRAW_TIER_COUNT).toBe(12);
        // Water and land of one cell share its tier.
        expect(tierOf(90_000, 'land')).toBe(tierOf(90_000, 'water'));
    });

    it('a finer chart always draws in a tier at least as high — never lower (monotone in scale)', () => {
        for (let a = 1; a < 1e7; a *= 1.13) {
            for (const b of [a / 1.5, a / 2, a / 4]) {
                if (b >= 1) expect(tierOf(b)).toBeGreaterThanOrEqual(tierOf(a));
            }
        }
    });

    it('within one usage band the real scale pairs are split: the finer water draws over the coarser land', () => {
        // band 3: 1:180,000 water over 1:350,000 land; band 4: 1:45,000 over
        // 1:90,000; band 5: 1:18,000, 1:12,000 and 1:8,000 over 1:22,000,
        // 1:8,000 over 1:12,000; band 6: 1:3,000 over 1:4,000. (1:18,000 over
        // 1:22,000 is the review fix-up's 1:20,000 bound: the Cocos pairs.)
        for (const [fine, coarse] of [
            [180_000, 350_000],
            [45_000, 90_000],
            [18_000, 22_000],
            [12_000, 18_000],
            [12_000, 22_000],
            [8_000, 22_000],
            [8_000, 12_000],
            [3_000, 4_000],
        ])
            expect(tierOf(fine, 'water'), `1:${fine} over 1:${coarse}`).toBeGreaterThan(tierOf(coarse, 'land'));
    });

    it('a cell known by its usage band alone: water at the band’s coarsest tier, land at its finest', () => {
        // AU421148 named band 4 (1:22,000 … 1:90,000): tiers 5–6.
        expect(encDrawTier({ cellId: 'AU421148' }, 'water')).toBe(tierOf(90_000));
        expect(encDrawTier({ cellId: 'AU421148' }, 'land')).toBe(tierOf(22_001));
        for (const s of [90_000, 45_000, 22_001]) {
            expect(encDrawTier({ cellId: 'AU421148' }, 'water')).toBeLessThanOrEqual(tierOf(s, 'land'));
            expect(encDrawTier({ cellId: 'AU421148' }, 'land')).toBeGreaterThanOrEqual(tierOf(s, 'water'));
        }
        // The compilation scale wins over the name, as cellFinenessRank's does.
        expect(encDrawTier({ nativeScale: 180_000, cellId: 'AU421148' }, 'water')).toBe(tierOf(180_000));
    });

    it('unknown fineness fails safe like the router: land on top, water at the bottom', () => {
        expect(encDrawTier(null, 'land')).toBe(ENC_DRAW_TIER_COUNT);
        expect(encDrawTier({ cellId: 'OC-61-841124' }, 'land')).toBe(ENC_DRAW_TIER_COUNT);
        expect(encDrawTier(null, 'water')).toBe(1);
    });

    it('an unsigned reference pack’s water never paints over a navigation chart; its land keeps its scale', () => {
        // Water a navigation chart overlaps drops to the bottom tier…
        expect(encDrawTier({ nativeScale: 3_000 }, 'water', true)).toBe(1);
        // …its land and coastline never do (a coarser chart's water must not
        // bury an island only the imported plan charts)…
        expect(encDrawTier({ nativeScale: 3_000 }, 'land', true)).toBe(tierOf(3_000, 'land'));
        // …and with no navigation chart over it, the water keeps its scale.
        expect(encDrawTier({ nativeScale: 3_000 }, 'water', false)).toBe(tierOf(3_000));
    });

    it('a reference cell’s water yields only to a navigation chart that overlaps it', () => {
        const ref = {
            id: 'R',
            bbox: [1, 1, 2, 2] as [number, number, number, number],
            authority: 'reference' as const,
        };
        const nav = (bbox: [number, number, number, number]) => ({ id: 'N', bbox, authority: 'navigation' as const });
        expect(referenceWaterYields(ref, [ref, nav([0, 0, 10, 10])])).toBe(true);
        expect(referenceWaterYields(ref, [ref, nav([1.5, 1.5, 3, 3])])).toBe(true);
        // Touching counts (conservative: the water drops).
        expect(referenceWaterYields(ref, [ref, nav([2, 2, 3, 3])])).toBe(true);
        expect(referenceWaterYields(ref, [ref, nav([5, 5, 6, 6])])).toBe(false);
        // Another reference pack never makes it yield; a cell with no
        // authority is a navigation cell (the CellExtent default).
        expect(referenceWaterYields(ref, [ref, { ...ref, id: 'R2', bbox: [0, 0, 10, 10] }])).toBe(false);
        expect(referenceWaterYields(ref, [ref, { id: 'N2', bbox: [0, 0, 10, 10] }])).toBe(true);
        // A navigation cell's own water never yields.
        expect(referenceWaterYields(nav([1, 1, 2, 2]), [nav([0, 0, 10, 10])])).toBe(false);
    });

    it('wherever decision 12 ignores overview land, the map draws the detailed chart’s water over it', () => {
        // Every compilation scale the bands span, both sides, and the name-only forms.
        const scales = [
            8e6, 3.5e6, 1.5e6, 1e6, 350_001, 350_000, 180_000, 90_000, 45_000, 22_000, 12_000, 4_000, 1_500,
        ];
        const facts = [
            ...scales.map((nativeScale) => ({ nativeScale })),
            ...['AU130120', 'AU230140', 'AU330140', 'AU421148', 'AU530150', 'AU630150'].map((cellId) => ({ cellId })),
        ];
        let pairs = 0;
        for (const water of facts) {
            for (const land of facts) {
                if (!overviewLandYields(cellFinenessRank(water), true, cellFinenessRank(land))) continue;
                pairs++;
                expect(encDrawTier(water, 'water'), JSON.stringify({ water, land })).toBeGreaterThan(
                    encDrawTier(land, 'land'),
                );
            }
        }
        expect(pairs).toBeGreaterThan(40);
    });
});
