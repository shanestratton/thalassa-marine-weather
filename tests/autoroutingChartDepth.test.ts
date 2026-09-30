import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FeatureCollection } from 'geojson';
const mocks = vi.hoisted(() => ({ overlay: vi.fn(), blob: vi.fn() }));
vi.mock('../services/enc/EncCellMetadata', async (original) => ({
    ...(await original<typeof import('../services/enc/EncCellMetadata')>()),
    cellsForBBox: () => [{ id: 'TEST', bbox: [0, 0, 0.01, 0.01], usage: 'navigation' }],
}));
vi.mock('../services/enc/mergeCap', () => ({ capCellsForMerge: (cells: unknown) => cells }));
vi.mock('../services/enc/EncCellStore', async (original) => ({
    ...(await original<typeof import('../services/enc/EncCellStore')>()),
    loadCellGeoJSON: mocks.blob,
}));
vi.mock('../services/OsmRouteOverlayService', async (original) => ({
    ...(await original<typeof import('../services/OsmRouteOverlayService')>()),
    getOsmRouteOverlay: mocks.overlay,
}));
vi.mock('../services/ntmRouting', () => ({ activeNtmZonesFor: async () => ({ features: [], tracklines: [] }) }));
import { assembleTracerLayers } from '../services/InshoreRouter';
import { chartOnlyTracerGridLayers, tracerContextFromLayers, validateTraceLeg } from '../services/routeTracer';
import { buildNavGrid } from '../services/engine/navGrid';
import { cellFinenessRank } from '../services/enc/scaleShadow';
const empty = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] });
const polygon = (props: Record<string, unknown>): FeatureCollection => ({
    type: 'FeatureCollection',
    features: [
        {
            type: 'Feature',
            properties: props,
            geometry: {
                type: 'Polygon',
                coordinates: [
                    [
                        [0, 0],
                        [0.01, 0],
                        [0.01, 0.01],
                        [0, 0.01],
                        [0, 0],
                    ],
                ],
            },
        },
    ],
});
const bbox: [number, number, number, number] = [0, 0, 0.01, 0.01];
beforeEach(() => {
    vi.clearAllMocks();
    mocks.blob.mockResolvedValue({ layers: { DEPARE: polygon({ DRVAL1: 1, DRVAL2: 1 }) } });
    mocks.overlay.mockResolvedValue({
        water: polygon({}),
        marina: polygon({}),
        reef: empty(),
        coastline: empty(),
        breakwater: empty(),
        berths: polygon({}),
        aeroway: empty(),
        canalLines: empty(),
        navLines: empty(),
    });
});
describe('charted-only trial depth policy', () => {
    it('does not inject assumed 5/10 m OSM depths, but retains berth geometry; manual defaults unchanged', async () => {
        const strict = await assembleTracerLayers(bbox, { chartedDepthOnly: true });
        expect(strict?.merged.DEPARE?.features.map((f) => f.properties?.DRVAL1)).toEqual([1]);
        expect(strict?.merged.BERTH?.features).toHaveLength(1);
        const legacy = await assembleTracerLayers(bbox);
        expect(legacy?.merged.DEPARE?.features.map((f) => f.properties?.DRVAL1)).toEqual([1, 10, 5]);
    });
    it('merges only chart leading lines (CATNAV 3) into the lead layer, never clearing or transit lines', async () => {
        const nav = (CATNAV: unknown, rcid: number) => ({
            type: 'Feature' as const,
            properties: { acronym: 'NAVLNE', CATNAV, rcid },
            geometry: {
                type: 'LineString' as const,
                coordinates: [
                    [0.001, 0.005],
                    [0.009, 0.005],
                ],
            },
        });
        mocks.blob.mockResolvedValue({
            layers: {
                DEPARE: polygon({ DRVAL1: 1, DRVAL2: 1 }),
                NAVLNE: {
                    type: 'FeatureCollection',
                    features: [nav(1, 11), nav(2, 12), nav(3, 13), nav(undefined, 14)],
                },
            },
        });
        const bundle = await assembleTracerLayers(bbox, { chartedDepthOnly: true });
        expect(bundle?.merged.NAVLINE?.features.map((f) => f.properties?.rcid)).toEqual([13]);
        expect(bundle?.merged.NAVLINE?.features[0].properties?._cellId).toBe('TEST');
    });
    it('lets the chart decide an OSM line that redraws a chart transit: the twin is dropped, others stay', async () => {
        const line = (props: Record<string, unknown>, lat: number) => ({
            type: 'Feature' as const,
            properties: props,
            geometry: {
                type: 'LineString' as const,
                coordinates: [
                    [0.001, lat],
                    [0.009, lat],
                ],
            },
        });
        mocks.blob.mockResolvedValue({
            layers: {
                DEPARE: polygon({ DRVAL1: 1, DRVAL2: 1 }),
                NAVLNE: {
                    type: 'FeatureCollection',
                    features: [line({ acronym: 'NAVLNE', CATNAV: 2, rcid: 12 }, 0.005)],
                },
            },
        });
        const osm = (id: number, lat: number) =>
            line(
                {
                    'seamark:type': 'navigation_line',
                    'seamark:navigation_line:category': 'transit',
                    _source: 'osm',
                    _osmId: id,
                },
                lat,
            );
        mocks.overlay.mockResolvedValue({
            water: polygon({}),
            marina: polygon({}),
            reef: empty(),
            coastline: empty(),
            breakwater: empty(),
            berths: polygon({}),
            aeroway: empty(),
            canalLines: empty(),
            // 101 lies ~5 m along the chart transit; 102 is ~330 m clear of it.
            navLines: { type: 'FeatureCollection', features: [osm(101, 0.00505), osm(102, 0.008)] },
        });
        const bundle = await assembleTracerLayers(bbox, { chartedDepthOnly: true });
        expect(bundle?.merged.NAVLINE?.features.map((f) => f.properties?._osmId ?? f.properties?.rcid)).toEqual([102]);
    });
    it('keeps shallow soundings shallow underneath leads, canals and fairways', () => {
        const line: FeatureCollection = {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    // A real lead: after Phase 0 only CATNAV 3 leads at all.
                    properties: { acronym: 'NAVLNE', CATNAV: 3 },
                    geometry: {
                        type: 'LineString',
                        coordinates: [
                            [0.001, 0.005],
                            [0.009, 0.005],
                        ],
                    },
                },
            ],
        };
        const layers = {
            DEPARE: polygon({ DRVAL1: 1, DRVAL2: 1 }),
            NAVLINE: line,
            CANAL: line,
            FAIRWY: polygon({ acronym: 'FAIRWY' }),
            // A dredged area is charted depth (its own DRVAL1), not a routing
            // hint: kept in the trial grid since round 2 (2026-09-30).
            DRGARE: polygon({ acronym: 'DRGARE', DRVAL1: 1.3 }),
        };
        const grid = buildNavGrid(chartOnlyTracerGridLayers(layers), bbox, 6, 2.4, 0.5, 60);
        const ctx = tracerContextFromLayers(layers, [], bbox, 2.4, { prebuiltGrid: grid });
        ctx.canalLanes = [];
        expect(ctx.leads.length).toBeGreaterThan(0);
        const result = validateTraceLeg({ lat: 0.005, lon: 0.002 }, { lat: 0.005, lon: 0.008 }, ctx);
        expect(result.grade).toBe('danger');
        expect(result.minDepthM).toBe(1);
        expect(result.needsTide).toBe(true);
        expect(layers.NAVLINE).toBe(line);
    });
    it("keeps a dredged area's own charted depth: DRGARE is a depth band, not a routing hint (round 2, 2026-09-30)", () => {
        // Phase 2a made DRGARE honest charted depth (its DRVAL1, finest survey
        // wins) in the routing grid; the trial grid used to strip it with the
        // routing hints, so a leg through a charted 1.3 m dredged area read
        // "no charted depth" instead of 1.3 m and needs tide.
        const layers = { DRGARE: polygon({ acronym: 'DRGARE', DRVAL1: 1.3 }) };
        const chartOnly = chartOnlyTracerGridLayers(layers);
        expect(chartOnly.DRGARE).toBe(layers.DRGARE);
        const grid = buildNavGrid(chartOnly, bbox, 6, 2.4, 0.5, 60);
        const ctx = tracerContextFromLayers(layers, [], bbox, 2.4, { prebuiltGrid: grid });
        ctx.canalLanes = [];
        const result = validateTraceLeg({ lat: 0.005, lon: 0.002 }, { lat: 0.005, lon: 0.008 }, ctx);
        expect(result.minDepthM).toBeCloseTo(1.3, 5);
        expect(result.needsTide).toBe(true);
    });
    it("keeps shallow soundings shallow under the engine's pre-clip lead copy too (NAVLINE_GRID)", () => {
        // routeInshore's entry clip keeps the leads as they were for the grid's
        // own land verdict (NAVLINE_GRID, services/engine/types.ts). A layer
        // set carrying that copy must not bring the lead's depth rescue back
        // into a chart-only trial grid.
        const lead: FeatureCollection = {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    properties: { acronym: 'NAVLNE', CATNAV: 3 },
                    geometry: {
                        type: 'LineString',
                        coordinates: [
                            [0.001, 0.005],
                            [0.009, 0.005],
                        ],
                    },
                },
            ],
        };
        const underLead = (layers: Parameters<typeof buildNavGrid>[0]) => {
            const grid = buildNavGrid(layers, bbox, 6, 2.4, 0.5, 60);
            const x = Math.floor((0.005 - grid.minLon) / grid.dLon);
            const y = Math.floor((0.005 - grid.minLat) / grid.dLat);
            return { depth: grid.cells[y * grid.width + x], preferred: grid.preferred[y * grid.width + x] === 1 };
        };
        const layers = { DEPARE: polygon({ DRVAL1: 1, DRVAL2: 1 }), NAVLINE_GRID: lead };
        // Control: the routing grid reads the pre-clip copy — it prefers the
        // lead's corridor. Since the Phase 2a review (2026-09-30) it never
        // deepens it: the charted 1 m stays shallow even there.
        expect(underLead(layers)).toEqual({ depth: expect.any(Number), preferred: true });
        expect(underLead(layers).depth).toBeLessThan(0);
        const chartOnly = chartOnlyTracerGridLayers(layers);
        expect(chartOnly.NAVLINE_GRID).toBeUndefined();
        expect(underLead(chartOnly)).toEqual({ depth: expect.any(Number), preferred: false });
        expect(underLead(chartOnly).depth).toBeLessThan(0);
    });
    it('flags missing supplementary marina data instead of a clean pass', async () => {
        mocks.overlay.mockRejectedValue(new Error('offline'));
        const result = await assembleTracerLayers(bbox, { chartedDepthOnly: true });
        expect(result?.supplementalChecksUnavailable).toBe(true);
    });
});
describe('the router merges rank the land paint and the depth bands (owner decision 1, 2026-09-30)', () => {
    // Only a strictly FINER never-drying band beats a coarser chart's land
    // paint, and an unranked LNDARE always stands (navGrid Pass 2,
    // leadLandClip). So both router merges stamp every chart LNDARE, DEPARE
    // and DRGARE with its cell's fineness, or production would keep all of its
    // land paint the way the unranked corridor captures do.
    it("the tracer merge stamps every chart LNDARE, DEPARE and DRGARE with its cell's rank; OSM breakwaters stay unranked", async () => {
        mocks.blob.mockResolvedValue({
            // The cell's compilation scale (the SENC header's native scale):
            // the rank comes from it, never from the bbox (round 2, 2026-09-30).
            nativeScale: 22_000,
            layers: {
                LNDARE: polygon({ acronym: 'LNDARE', rcid: 1 }),
                DEPARE: polygon({ acronym: 'DEPARE', DRVAL1: 1, DRVAL2: 1, rcid: 2 }),
                DRGARE: polygon({ acronym: 'DRGARE', DRVAL1: 3, rcid: 3 }),
            },
        });
        mocks.overlay.mockResolvedValue({
            water: empty(),
            marina: empty(),
            reef: empty(),
            coastline: empty(),
            breakwater: polygon({ man_made: 'breakwater' }),
            berths: empty(),
            aeroway: empty(),
            canalLines: empty(),
            navLines: empty(),
        });
        const bundle = await assembleTracerLayers(bbox, { chartedDepthOnly: true });
        const rank = cellFinenessRank({ nativeScale: 22_000 });
        expect(rank).not.toBeNull();
        const chart = (layer: 'LNDARE' | 'DEPARE' | 'DRGARE') =>
            (bundle?.merged[layer]?.features ?? []).filter((f) => typeof f.properties?.acronym === 'string');
        for (const layer of ['LNDARE', 'DEPARE', 'DRGARE'] as const) {
            expect(chart(layer), layer).toHaveLength(1);
            expect(chart(layer)[0].properties?._scaleRank, layer).toBe(rank);
        }
        // The breakwater is a structure, not a chart: no rank, so it stands.
        const breakwater = (bundle?.merged.LNDARE?.features ?? []).filter((f) => f.properties?.man_made);
        expect(breakwater).toHaveLength(1);
        expect(breakwater[0].properties?._scaleRank).toBeUndefined();
    });

    it('a cell that does not say its scale stays unranked: its land paint stands (round 2, 2026-09-30)', async () => {
        // No compilation scale on the blob and no S-57 name with a usage band
        // (the mocked cell is "TEST"): unknown fineness, never a bbox guess.
        mocks.blob.mockResolvedValue({
            layers: {
                LNDARE: polygon({ acronym: 'LNDARE', rcid: 1 }),
                DEPARE: polygon({ acronym: 'DEPARE', DRVAL1: 1, DRVAL2: 1, rcid: 2 }),
            },
        });
        const bundle = await assembleTracerLayers(bbox, { chartedDepthOnly: true });
        for (const layer of ['LNDARE', 'DEPARE'] as const) {
            const chart = (bundle?.merged[layer]?.features ?? []).filter(
                (f) => typeof f.properties?.acronym === 'string',
            );
            expect(chart, layer).toHaveLength(1);
            expect(chart[0].properties?._scaleRank, layer).toBeUndefined();
        }
    });

    it('the engine merge (tryInshoreRouteInner) stamps the same three layers, like the tracer merge it mirrors', () => {
        const src = readFileSync(join(__dirname, '..', 'services', 'InshoreRouter.ts'), 'utf8');
        expect(src).toMatch(/const SCALE_RANKED_LAYERS[^=]*= new Set\(\['LNDARE', 'DEPARE', 'DRGARE'\]\)/);
        // Two stamp sites per merge (shadow-filtered and whole), two merges.
        expect(src.match(/if \(SCALE_RANKED_LAYERS\.has\(layer\)\) stampScaleRank\(/g)).toHaveLength(4);
        // …and no merge still stamps DEPARE alone.
        expect(src).not.toMatch(/if \(layer === 'DEPARE'\) stampScaleRank\(/);
    });
});
