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
    it('keeps shallow soundings shallow underneath leads, canals and fairways', () => {
        const line: FeatureCollection = {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    properties: { acronym: 'NAVLNE' },
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
