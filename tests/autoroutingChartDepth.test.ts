import { beforeEach, describe, expect, it, vi } from 'vitest';
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
            DRGARE: polygon({ acronym: 'DRGARE' }),
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
    it('flags missing supplementary marina data instead of a clean pass', async () => {
        mocks.overlay.mockRejectedValue(new Error('offline'));
        const result = await assembleTracerLayers(bbox, { chartedDepthOnly: true });
        expect(result?.supplementalChecksUnavailable).toBe(true);
    });
});
