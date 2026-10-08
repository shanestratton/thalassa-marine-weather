/**
 * Package 125-05 through the app's own router, tryInshoreRoute (Shane,
 * 2026-10-08: "better we just have red at the "dry" zones, rather than just
 * shit caning the whole route").
 *
 * Where the only way through crosses water no tide clears, the app gets the
 * route — not 'no-tide-clears' — with each such stretch named
 * (InshoreRouteResult.dryRuns), said in the route notes, kept with a saved
 * plan, and never swapped for a Seaway graph route that would not carry it.
 * No tide data is said, never a refusal. A global app: one chart is a
 * fictional drying harbour on the Wadden coast.
 *
 * Synthetic charts clear of every regional marker file (no network).
 * Serene Summer: 2.4 m draft, the router's 0.5 m UKC — 2.9 m.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, FeatureCollection } from 'geojson';

const mocks = vi.hoisted(() => ({ cells: [] as unknown[], blob: vi.fn(), curve: vi.fn() }));
vi.mock('../services/enc/EncCellMetadata', async (original) => ({
    ...(await original<typeof import('../services/enc/EncCellMetadata')>()),
    cellsForBBox: () => mocks.cells,
    listCells: () => mocks.cells,
}));
vi.mock('../services/enc/mergeCap', () => ({ capCellsForMerge: (cells: unknown) => cells }));
vi.mock('../services/enc/EncCellStore', async (original) => ({
    ...(await original<typeof import('../services/enc/EncCellStore')>()),
    loadCellGeoJSON: mocks.blob,
}));
vi.mock('../services/OsmRouteOverlayService', async (original) => ({
    ...(await original<typeof import('../services/OsmRouteOverlayService')>()),
    getOsmRouteOverlay: async () => {
        const empty = { type: 'FeatureCollection', features: [] };
        return {
            water: empty,
            marina: empty,
            reef: empty,
            coastline: empty,
            breakwater: empty,
            berths: empty,
            aeroway: empty,
            canalLines: empty,
            navLines: empty,
        };
    },
}));
vi.mock('../services/ntmRouting', () => ({ activeNtmZonesFor: async () => ({ features: [], tracklines: [] }) }));
vi.mock('../services/mapboxWater', () => ({
    fetchMapboxWater: async () => ({ type: 'FeatureCollection', features: [] }),
}));
vi.mock('../services/satelliteWater', () => ({
    fetchSatelliteWater: async () => ({ type: 'FeatureCollection', features: [] }),
}));
vi.mock('../services/lowBridges', async (original) => ({
    ...(await original<typeof import('../services/lowBridges')>()),
    loadLowBridges: async () => [],
}));
vi.mock('../services/TideHeightService', async (original) => ({
    ...(await original<typeof import('../services/TideHeightService')>()),
    fetchTideCurve: mocks.curve,
}));

import {
    inshoreRouteToGeoJSON,
    seawayGraphSafetyFault,
    seawayPromotionBlockReason,
    tryInshoreRoute,
} from '../services/InshoreRouter';
import { buildTideCurve } from '../services/TideHeightService';
import { inshoreRouteCaveats, savedInshoreRouteCaveats } from '../components/map/inshoreRouteNotice';
import { dryRunCaveat } from '../services/routing/dryRunWords';

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
const fc = (...f: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features: f });
const band = (x0: number, y0: number, x1: number, y1: number, DRVAL1: number, DRVAL2: number) =>
    rect(x0, y0, x1, y1, { acronym: 'DEPARE', DRVAL1, DRVAL2 });
const land = (x0: number, y0: number, x1: number, y1: number) => rect(x0, y0, x1, y1, { acronym: 'LNDARE' });
const noStructures = { BRIDGE: fc(), PONTON: fc(), CBLOHD: fc(), PIPOHD: fc(), CONVYR: fc() };

/** Two 5–10 m basins joined only by a 300 m "Boat Passage" charted drying −2.2..0. */
const WALL_W = 150.4;
const WALL_E = 150.403;
const PASSAGE_CELL = {
    cellId: 'DRY-TEST',
    bbox: [150.2, -30.7, 150.6, -30.3] as [number, number, number, number],
    layers: {
        DEPARE: fc(
            band(150.3, -30.56, WALL_W, -30.42, 5, 10),
            band(WALL_E, -30.56, 150.5, -30.42, 5, 10),
            band(WALL_W, -30.502, WALL_E, -30.498, -2.2, 0),
        ),
        LNDARE: fc(
            land(150.2, -30.42, 150.6, -30.3),
            land(150.2, -30.7, 150.6, -30.56),
            land(150.2, -30.56, 150.3, -30.42),
            land(150.5, -30.56, 150.6, -30.42),
            land(WALL_W, -30.56, WALL_E, -30.502),
            land(WALL_W, -30.498, WALL_E, -30.42),
        ),
        SEAARE: fc(rect(WALL_W - 0.001, -30.502, WALL_E + 0.001, -30.498, { OBJNAM: 'Boat Passage' })),
        ...noStructures,
    },
};

/** A fictional drying harbour on the Wadden coast: the basin and the channel
 *  outside 4–8 m, joined only by a 400 m gully charted drying 1.2 m. */
const GAT_W = 6.1;
const GAT_E = 6.106;
const WADDEN_CELL = {
    cellId: 'WADDEN-TEST',
    bbox: [5.95, 53.4, 6.25, 53.5] as [number, number, number, number],
    layers: {
        DEPARE: fc(
            band(6.0, 53.44, GAT_W, 53.46, 4, 8),
            band(GAT_E, 53.44, 6.2, 53.46, 4, 8),
            band(GAT_W, 53.448, GAT_E, 53.452, -1.2, 0),
        ),
        LNDARE: fc(
            land(5.95, 53.46, 6.25, 53.5),
            land(5.95, 53.4, 6.25, 53.44),
            land(5.95, 53.44, 6.0, 53.46),
            land(6.2, 53.44, 6.25, 53.46),
            land(GAT_W, 53.44, GAT_E, 53.448),
            land(GAT_W, 53.452, GAT_E, 53.46),
        ),
        SEAARE: fc(rect(GAT_W - 0.0005, 53.448, GAT_E + 0.0005, 53.452, { OBJNAM: 'Meerhaven Gat' })),
        ...noStructures,
    },
};

/** A 14-day LAT curve topping out at `highestM`, from an hour ago. */
function curveTopping(highestM: number) {
    const t0 = Math.floor(Date.now() / 1000) - 3600;
    const step = (6 * 60 + 12) * 60;
    return buildTideCurve({
        status: 200,
        responseDatum: 'LAT',
        extremes: Array.from({ length: 55 }, (_, k) => ({
            dt: t0 + k * step,
            date: '',
            height: k % 2 === 0 ? 0.2 : highestM,
            type: k % 2 === 0 ? 'Low' : 'High',
        })),
    } as never);
}

function useCell(cell: typeof PASSAGE_CELL): void {
    mocks.cells.length = 0;
    mocks.cells.push({
        id: cell.cellId,
        bbox: cell.bbox,
        usage: 'navigation',
        hazardCount: 1_000_000,
        edition: 1,
        issued: '2026-10-01',
    });
    mocks.blob.mockReset();
    mocks.blob.mockResolvedValue(cell);
}

beforeEach(() => {
    mocks.curve.mockReset();
});

describe('125-05 through tryInshoreRoute', () => {
    it('the tide in (top 2.5 m) and no way round: a route, not a refusal — the Boat Passage named', async () => {
        useCell(PASSAGE_CELL);
        mocks.curve.mockResolvedValue(curveTopping(2.5));
        const r = await tryInshoreRoute({ lat: -30.5, lon: 150.35 }, { lat: -30.5, lon: 150.45 }, 2.4, 18);
        // Was: { code: 'no-tide-clears', error: 'No route for 2.4 m draft: the
        // only way through crosses the Boat Passage, charted to dry 2.2 m; …' }.
        expect(r && 'polyline' in r, r && 'error' in r ? `${r.code}: ${r.error}` : 'null').toBe(true);
        if (!r || !('polyline' in r)) return;
        expect(r.dryRuns).toHaveLength(1);
        expect(r.dryRuns![0]).toMatchObject({ place: 'the Boat Passage', shallowestM: -2.2, draftM: 2.4 });
        expect(r.dryRuns![0].tide?.days).toBe(14);
        expect(r.dryRuns![0].tide?.topM).toBeCloseTo(2.5, 6);
        expect(r.dryRuns![0].needM).toBeCloseTo(2.9, 6);
        const caveats = inshoreRouteCaveats({ dryRuns: r.dryRuns, tideCheck: r.tideCheck });
        expect(caveats[0]).toBe(
            'Red on this route: the Boat Passage dries 2.2 m and you need 2.9 m (2.4 m draft + 0.5 m under the keel); ' +
                'the highest tide in the next 14 days is 2.5 m, so no tide clears it. Check it on the chart before you go.',
        );
        // A saved plan says it again.
        const geo = inshoreRouteToGeoJSON(r, { lat: -30.5, lon: 150.35 }, { lat: -30.5, lon: 150.45 });
        expect((geo.properties as { dryRuns?: unknown }).dryRuns).toEqual(r.dryRuns);
        expect(savedInshoreRouteCaveats({ routeGeoJSON: geo })).toContain(dryRunCaveat(r.dryRuns));
    }, 60_000);

    it('a Seaway graph route never replaces one that names a dry stretch', () => {
        expect(
            seawayPromotionBlockReason({
                dryRuns: [
                    {
                        startSeg: 0,
                        startT: 0,
                        endSeg: 0,
                        endT: 1,
                        lengthM: 300,
                        mid: [150.4, -30.5],
                        place: 'the Boat Passage',
                        shallowestM: -2.2,
                        deepestM: 0,
                        draftM: 2.4,
                        needM: 2.9,
                        tide: null,
                    },
                ],
            }),
        ).toMatch(/dry water/);
    });

    it('nor does a graph route across dry water the engine route went round (review fix-up, 2026-10-09)', () => {
        // The Wadden harbour's gully dries 1.2 m: a graph route straight
        // through it, the engine's own (say) round it in deep water.
        const layers = WADDEN_CELL.layers as Parameters<typeof seawayGraphSafetyFault>[1];
        const engine = { polyline: [] as [number, number][], debug: { hardLandTotalM: 0 } };
        const through: [number, number][] = [
            [6.05, 53.45],
            [6.15, 53.45],
        ];
        const inBasin: [number, number][] = [
            [6.02, 53.45],
            [6.08, 53.45],
        ];
        // No tide data: nothing is proved, but the gully dries — declined.
        expect(seawayGraphSafetyFault(through, layers, engine, undefined, { needM: 2.9 })).toMatch(
            /dry water \(Meerhaven Gat\)/,
        );
        expect(seawayGraphSafetyFault(inBasin, layers, engine, undefined, { needM: 2.9 })).toBeNull();
        // A drying band a 2.5 m top lifts at its deep end (−0.5..1 m: 1 + 2.5
        // ≥ 2.9, nothing proved) still dries past the need at its shallow
        // end: declined too.
        const shallowGat = {
            ...layers,
            DEPARE: fc(
                band(6.0, 53.44, GAT_W, 53.46, 4, 8),
                band(GAT_E, 53.44, 6.2, 53.46, 4, 8),
                band(GAT_W, 53.448, GAT_E, 53.452, -0.5, 1),
            ),
        } as typeof layers;
        const top = [{ lat: 53.5, lon: 6.0, highestM: 2.5, days: 14 }];
        expect(
            seawayGraphSafetyFault(through, shallowGat, engine, undefined, { tideCeilings: top, needM: 2.9 }),
        ).toMatch(/dry water/);
    });

    it('a global app: the Wadden harbour with no tide curve is a route, the gully named with no tide data', async () => {
        useCell(WADDEN_CELL);
        mocks.curve.mockResolvedValue(null);
        const r = await tryInshoreRoute({ lat: 53.45, lon: 6.05 }, { lat: 53.45, lon: 6.15 }, 2.4, 18);
        expect(r && 'polyline' in r, r && 'error' in r ? `${r.code}: ${r.error}` : 'null').toBe(true);
        if (!r || !('polyline' in r)) return;
        expect(r.dryRuns).toHaveLength(1);
        expect(r.dryRuns![0]).toMatchObject({ place: 'Meerhaven Gat', shallowestM: -1.2, tide: null });
        expect(r.tideCheck).toBe('not-loaded');
        expect(inshoreRouteCaveats({ dryRuns: r.dryRuns })[0]).toMatch(
            /^Red on this route: Meerhaven Gat dries 1\.2 m and you need 2\.9 m .*there is no tide data for it/,
        );
    }, 60_000);
});
