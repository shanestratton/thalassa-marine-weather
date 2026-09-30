/**
 * Owner decision 1 through the router's own merge (round 2, 2026-09-30):
 * EQUAL-scale bands never beat land paint.
 *
 * Two sibling cells of one usage band overlap at their seam: one paints land,
 * the other charts a never-drying 3 m band over it. The merge used to rank
 * each cell by its bbox area, so the SMALLER sibling ranked "finer" and its
 * band beat the other's land — a same-scale chart turning land into water.
 * The merge now ranks a cell by what it says about its scale (compilation
 * scale, else the usage band in its S-57 name — services/enc/scaleShadow.ts
 * cellFinenessRank): same band, same rank, and the land paint stands.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, FeatureCollection } from 'geojson';

const mocks = vi.hoisted(() => ({ cells: [] as unknown[], blobs: {} as Record<string, unknown> }));
vi.mock('../../services/enc/EncCellMetadata', async (original) => ({
    ...(await original<typeof import('../../services/enc/EncCellMetadata')>()),
    cellsForBBox: () => mocks.cells,
}));
vi.mock('../../services/enc/mergeCap', () => ({ capCellsForMerge: (cells: unknown) => cells }));
vi.mock('../../services/enc/EncCellStore', async (original) => ({
    ...(await original<typeof import('../../services/enc/EncCellStore')>()),
    loadCellGeoJSON: async (id: string) => mocks.blobs[id] ?? null,
}));
vi.mock('../../services/OsmRouteOverlayService', async (original) => ({
    ...(await original<typeof import('../../services/OsmRouteOverlayService')>()),
    getOsmRouteOverlay: async () => {
        throw new Error('offline');
    },
}));
vi.mock('../../services/ntmRouting', () => ({ activeNtmZonesFor: async () => ({ features: [], tracklines: [] }) }));

import { assembleTracerLayers } from '../../services/InshoreRouter';
import { buildNavGrid } from '../../services/engine/navGrid';

const rect = (x0: number, y0: number, x1: number, y1: number, props: Record<string, unknown>): Feature => ({
    type: 'Feature',
    properties: props,
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [x0, y0],
                [x1, y0],
                [x1, y1],
                [x0, y1],
                [x0, y0],
            ],
        ],
    },
});
const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });

const BBOX: [number, number, number, number] = [152.49, -27.92, 152.53, -27.88];
// The land cell is 4× the band cell's area: the old bbox rank called the band
// cell "finer".
const LAND_CELL_BBOX: [number, number, number, number] = [152.45, -27.95, 152.55, -27.85];
const BAND_CELL_BBOX: [number, number, number, number] = [152.475, -27.925, 152.525, -27.875];

function install(landCell: Record<string, unknown>, bandCell: Record<string, unknown>) {
    mocks.cells = [
        { id: 'LANDCELL', bbox: LAND_CELL_BBOX, usage: 'navigation', ...landCell },
        { id: 'BANDCELL', bbox: BAND_CELL_BBOX, usage: 'navigation', ...bandCell },
    ];
    mocks.blobs = {
        LANDCELL: {
            ...landCell,
            layers: { LNDARE: fc(rect(152.5, -27.91, 152.52, -27.89, { acronym: 'LNDARE', rcid: 1 })) },
        },
        BANDCELL: {
            ...bandCell,
            layers: {
                DEPARE: fc(
                    rect(152.498, -27.912, 152.522, -27.888, { acronym: 'DEPARE', DRVAL1: 3, DRVAL2: 5, rcid: 2 }),
                ),
            },
        },
    };
}

async function probe() {
    const bundle = await assembleTracerLayers(BBOX, { chartedDepthOnly: true });
    const g = buildNavGrid(bundle!.merged, BBOX, 50, 2.4, 0.5, 60);
    const x = Math.floor((152.51 - g.minLon) / g.dLon);
    const y = Math.floor((-27.9 - g.minLat) / g.dLat);
    const i = y * g.width + x;
    return { land: g.landBlocked?.[i] === 1, wetConflict: g.wetConflict?.[i] === 1 };
}

describe("owner decision 1 through the router's merge: equal-scale bands never beat land paint", () => {
    beforeEach(() => {
        mocks.cells = [];
        mocks.blobs = {};
    });

    it('two siblings compiled at the same scale: the land paint stands, whatever their extents', async () => {
        install({ nativeScale: 50_000 }, { nativeScale: 50_000 });
        expect(await probe()).toMatchObject({ land: true, wetConflict: false });
    });

    it('two siblings of one usage band, known by their S-57 names: the land paint stands', async () => {
        install({ sourceCellId: 'AU4LAND1' }, { sourceCellId: 'AU4BAND2' });
        expect(await probe()).toMatchObject({ land: true, wetConflict: false });
    });

    it('cells that do not say their scale: the land paint stands (unknown never beats land)', async () => {
        install({}, {});
        expect(await probe()).toMatchObject({ land: true, wetConflict: false });
    });

    it('a band compiled at a finer scale beats the coarser land paint: shallow water, never land', async () => {
        install({ nativeScale: 150_000 }, { nativeScale: 22_000 });
        expect(await probe()).toMatchObject({ land: false, wetConflict: true });
    });
});
