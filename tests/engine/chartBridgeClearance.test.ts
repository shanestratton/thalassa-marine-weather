/**
 * Part B (inshore router, 2026-09-30): a charted bridge, overhead cable or
 * overhead pipe (S-57 BRIDGE / CBLOHD / PIPOHD) the vessel's mast cannot
 * clear is LAND for that vessel.
 *
 * Owner decisions: clearance below air draft + margin blocks (margin 1 m);
 * an unknown clearance blocks; an unset air draft blocks every one of them;
 * opening bridges block unless their CLOSED clearance clears. Serene Summer's
 * air draft is 18 m.
 *
 * The bars come from services/routing/overheadClearance.ts chartClearanceBars
 * — the same function tryInshoreRouteInner calls on the merged cells — and
 * are checked two ways: through the engine (routeInshore) on a synthetic
 * canal, and end to end through tryInshoreRoute with the BRIDGE carried in an
 * installed cell's blob.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, FeatureCollection } from 'geojson';

const mocks = vi.hoisted(() => ({ blob: vi.fn(), cells: [] as unknown[] }));
vi.mock('../../services/enc/EncCellMetadata', async (original) => ({
    ...(await original<typeof import('../../services/enc/EncCellMetadata')>()),
    cellsForBBox: () => mocks.cells,
    listCells: () => mocks.cells,
}));
vi.mock('../../services/enc/mergeCap', () => ({ capCellsForMerge: (cells: unknown) => cells }));
vi.mock('../../services/enc/EncCellStore', async (original) => ({
    ...(await original<typeof import('../../services/enc/EncCellStore')>()),
    loadCellGeoJSON: mocks.blob,
}));
vi.mock('../../services/OsmRouteOverlayService', async (original) => ({
    ...(await original<typeof import('../../services/OsmRouteOverlayService')>()),
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
vi.mock('../../services/ntmRouting', () => ({ activeNtmZonesFor: async () => ({ features: [], tracklines: [] }) }));
vi.mock('../../services/mapboxWater', () => ({
    fetchMapboxWater: async () => ({ type: 'FeatureCollection', features: [] }),
}));
vi.mock('../../services/satelliteWater', () => ({
    fetchSatelliteWater: async () => ({ type: 'FeatureCollection', features: [] }),
}));
vi.mock('../../services/lowBridges', async (original) => ({
    ...(await original<typeof import('../../services/lowBridges')>()),
    loadLowBridges: async () => [],
}));

import { routeInshore, type RouteRequest } from '../../services/inshoreRouterEngine';
import { tryInshoreRoute } from '../../services/InshoreRouter';
import { chartClearanceBars, polylineCrossesClearanceBar } from '../../services/routing/overheadClearance';

// A synthetic canal clear of every regional marker file (no network), the
// same shape as tests/engine/lowClearance.test.ts: water between two banks,
// the bridge line straight across at BAR_LON.
const W0 = 150.3;
const LAT = -30.495;
function rect(minLon: number, minLat: number, maxLon: number, maxLat: number, props = {}): Feature {
    return {
        type: 'Feature',
        properties: props,
        geometry: {
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
        },
    };
}
const fc = (...f: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features: f });
const WATER = fc(rect(W0, -30.5, W0 + 0.04, -30.49, { DRVAL1: 10, acronym: 'DEPARE' }));
const BANKS = [
    rect(W0 - 0.01, -30.49, W0 + 0.05, -30.483, { acronym: 'LNDARE' }),
    rect(W0 - 0.01, -30.507, W0 + 0.05, -30.5, { acronym: 'LNDARE' }),
];
/** A land cap sealing the canal's west end: the origin pocket's only exit is under the bridge. */
const CAP = rect(W0 - 0.002, -30.5, W0 + 0.002, -30.49, { acronym: 'LNDARE' });
/** …and one sealing the east end: the two basins meet ONLY under the bridge. */
const EAST_CAP = rect(W0 + 0.038, -30.5, W0 + 0.042, -30.49, { acronym: 'LNDARE' });
const BAR_LON = W0 + 0.02;
const bridgeLine = (props: Record<string, unknown>, acronym = 'BRIDGE'): Feature => ({
    type: 'Feature',
    properties: { acronym, rcid: 41, ...props },
    geometry: {
        type: 'LineString',
        coordinates: [
            [BAR_LON, -30.503],
            [BAR_LON, -30.487],
        ],
    },
});

const req: RouteRequest = {
    fromLat: LAT,
    fromLon: W0 + 0.01,
    toLat: LAT,
    toLon: W0 + 0.035,
    draftM: 2.0,
    safetyM: 0.5,
    resolutionM: 50,
    unchartedPolicy: 'strict',
};
const isResult = (r: ReturnType<typeof routeInshore>): r is Extract<typeof r, { polyline: unknown }> => 'polyline' in r;
const spansBoth = (poly: readonly (readonly [number, number])[]): boolean =>
    poly.some(([lon]) => lon < BAR_LON - 0.0006) && poly.some(([lon]) => lon > BAR_LON + 0.0006);

/** Route the canal with the chart structures turned into bars for this air draft. */
function route(
    structures: { BRIDGE?: Feature[]; CBLOHD?: Feature[]; PIPOHD?: Feature[]; CONVYR?: Feature[] },
    airDraftM: number | null,
    caged: boolean,
) {
    const bars = chartClearanceBars(structures, airDraftM);
    return routeInshore(
        {
            DEPARE: WATER,
            LNDARE: fc(...BANKS, ...(caged ? [CAP] : [])),
            OBSTRN: fc(...bars),
        },
        req,
    );
}

describe('charted bridges and overhead lines against the air draft (engine)', () => {
    it('control: with no structure the route crosses the canal', () => {
        const r = route({}, 18, false);
        expect(isResult(r)).toBe(true);
        if (isResult(r)) expect(spansBoth(r.polyline)).toBe(true);
    });

    it('a 16 m bridge BLOCKS an 18 m mast, and the refusal says why', () => {
        const r = route({ BRIDGE: [bridgeLine({ VERCLR: 16, OBJNAM: 'Canal Bridge' })] }, 18, true);
        expect(isResult(r)).toBe(false);
        if (isResult(r)) return;
        expect(r.code, r.error).toBe('air-draft-blocked');
        expect(r.error).toMatch(/the bridge "Canal Bridge" has 16(\.0)? m clearance/);
        expect(r.error).toMatch(/18(\.0)? m air draft plus a 1 m margin/);
    });

    it('a 25 m bridge passes an 18 m mast', () => {
        const r = route({ BRIDGE: [bridgeLine({ VERCLR: 25 })] }, 18, false);
        expect(isResult(r)).toBe(true);
        if (isResult(r)) expect(spansBoth(r.polyline)).toBe(true);
    });

    it('a bridge with no charted clearance BLOCKS', () => {
        const r = route({ BRIDGE: [bridgeLine({})] }, 18, true);
        expect(isResult(r)).toBe(false);
        if (isResult(r)) return;
        expect(r.code, r.error).toBe('air-draft-blocked');
        expect(r.error).toMatch(/gives no clearance/);
    });

    it('with the air draft unset, even a 40 m bridge BLOCKS', () => {
        const r = route({ BRIDGE: [bridgeLine({ VERCLR: 40 })] }, null, true);
        expect(isResult(r)).toBe(false);
        if (isResult(r)) return;
        expect(r.code, r.error).toBe('air-draft-blocked');
        expect(r.error).toMatch(/air draft is not set/);
    });

    it('an opening bridge BLOCKS on its closed clearance; one that clears closed passes', () => {
        const r = route({ BRIDGE: [bridgeLine({ CATBRG: 4, VERCCL: 5, VERCOP: 40 })] }, 18, true);
        expect(isResult(r)).toBe(false);
        if (!isResult(r)) {
            expect(r.code, r.error).toBe('air-draft-blocked');
            expect(r.error).toMatch(/opening bridge/);
        }
        const open = route({ BRIDGE: [bridgeLine({ CATBRG: 4, VERCCL: 22, VERCOP: 40 })] }, 18, false);
        expect(isResult(open) && spansBoth(open.polyline)).toBe(true);
    });

    it('an overhead cable or pipe too low for the mast BLOCKS', () => {
        const cable = route({ CBLOHD: [bridgeLine({ VERCSA: 12 }, 'CBLOHD')] }, 18, true);
        expect(isResult(cable)).toBe(false);
        if (!isResult(cable)) expect(cable.error).toMatch(/overhead cable/);
        const pipe = route({ PIPOHD: [bridgeLine({}, 'PIPOHD')] }, 18, true);
        expect(isResult(pipe)).toBe(false);
    });

    // Round 2 (2026-09-30): an overhead conveyor (S-57 CONVYR) is a span a
    // mast passes under, and blocks like any bridge (owner decision 5).
    it('an overhead conveyor too low for the mast BLOCKS, and the refusal names it; a tall one passes', () => {
        const low = route({ CONVYR: [bridgeLine({ VERCLR: 14, OBJNAM: 'Coal loader' }, 'CONVYR')] }, 18, true);
        expect(isResult(low)).toBe(false);
        if (!isResult(low)) {
            expect(low.code, low.error).toBe('air-draft-blocked');
            expect(low.error).toMatch(/the overhead conveyor "Coal loader" has 14(\.0)? m clearance/);
        }
        const tall = route({ CONVYR: [bridgeLine({ VERCLR: 30 }, 'CONVYR')] }, 18, false);
        expect(isResult(tall) && spansBoth(tall.polyline)).toBe(true);
    });

    it('a charted recommended track under a blocking bridge never carries the route across it', () => {
        // The RECTRC snap and the leading-line snaps ride their lines OFF the
        // grid; a track straight under the bridge must not carry the route
        // across the bar the grid blocks. Both basins are sealed, so the only
        // way east is under the bridge: the verdict must be the bridge.
        const track: Feature = {
            type: 'Feature',
            properties: { acronym: 'RECTRC', rcid: 5, CATTRK: 1, TRAFIC: 4 },
            geometry: {
                type: 'LineString',
                coordinates: [
                    [W0 + 0.004, LAT],
                    [W0 + 0.036, LAT],
                ],
            },
        };
        const bars = chartClearanceBars({ BRIDGE: [bridgeLine({ VERCLR: 16 })] }, 18);
        const r = routeInshore(
            { DEPARE: WATER, LNDARE: fc(...BANKS, CAP, EAST_CAP), OBSTRN: fc(...bars), RECTRC: fc(track) },
            req,
        );
        if (isResult(r)) expect(spansBoth(r.polyline), 'route spans both sides of a blocking bridge').toBe(false);
        else {
            expect(r.code, r.error).toBe('air-draft-blocked');
            expect(r.error).toMatch(/16 m clearance/);
        }
        // Control: the same sealed basins and track under a 25 m bridge route through.
        const ok = routeInshore(
            {
                DEPARE: WATER,
                LNDARE: fc(...BANKS, CAP, EAST_CAP),
                OBSTRN: fc(...chartClearanceBars({ BRIDGE: [bridgeLine({ VERCLR: 25 })] }, 18)),
                RECTRC: fc(track),
            },
            req,
        );
        expect(isResult(ok) && spansBoth(ok.polyline)).toBe(true);
    });
});

describe('off-grid splices never pass under a blocking bridge', () => {
    // Two channels either side of a narrow island; the SOUTH one carries a
    // charted recommended track and a 16 m bridge. The grid route takes the
    // open north channel, but the RECTRC snap rides its track OFF the grid and,
    // before Part B, spliced the route onto it — straight under the bridge
    // (measured at HEAD 1d649e48: 'rectrc×1', crossing the bridge line).
    const LAND = [
        rect(W0 - 0.01, -30.494, W0 + 0.05, -30.487, { acronym: 'LNDARE' }),
        rect(W0 - 0.01, -30.505, W0 + 0.05, -30.4975, { acronym: 'LNDARE' }),
        rect(W0 + 0.012, -30.49595, W0 + 0.028, -30.49545, { acronym: 'LNDARE' }),
    ];
    const NARROWS = fc(rect(W0, -30.4975, W0 + 0.04, -30.494, { DRVAL1: 10, acronym: 'DEPARE' }));
    const southBridge = (VERCLR: number): Feature => ({
        type: 'Feature',
        properties: { acronym: 'BRIDGE', rcid: 42, VERCLR },
        geometry: {
            type: 'LineString',
            coordinates: [
                [BAR_LON, -30.499],
                [BAR_LON, -30.4957],
            ],
        },
    });
    const southTrack: Feature = {
        type: 'Feature',
        properties: { acronym: 'RECTRC', rcid: 5, CATTRK: 1, TRAFIC: 4 },
        geometry: {
            type: 'LineString',
            coordinates: [
                [W0 + 0.004, -30.4967],
                [W0 + 0.036, -30.4967],
            ],
        },
    };
    const narrowsReq: RouteRequest = {
        fromLat: -30.4955,
        fromLon: W0 + 0.005,
        toLat: -30.4955,
        toLon: W0 + 0.035,
        draftM: 2,
        safetyM: 0.5,
        unchartedPolicy: 'strict',
    };

    it('the route keeps to the open channel instead of riding the track under the bridge', () => {
        const bars = chartClearanceBars({ BRIDGE: [southBridge(16)] }, 18);
        const r = routeInshore(
            { DEPARE: NARROWS, LNDARE: fc(...LAND), OBSTRN: fc(...bars), RECTRC: fc(southTrack) },
            narrowsReq,
        );
        expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
        if (!isResult(r)) return;
        expect(polylineCrossesClearanceBar(r.polyline, bars), 'route passes under the 16 m bridge').toBeNull();
        // It really went round: every vertex north of the island's south shore.
        expect(Math.min(...r.polyline.map((p) => p[1]))).toBeGreaterThan(-30.49595);
    });
});

describe('end to end: a BRIDGE in an installed cell blocks tryInshoreRoute', () => {
    const cellBbox: [number, number, number, number] = [W0 - 0.01, -30.51, W0 + 0.05, -30.48];
    beforeEach(() => {
        mocks.cells.length = 0;
        mocks.cells.push({
            id: 'BRIDGE-TEST',
            bbox: cellBbox,
            usage: 'navigation',
            // Routing-grade density for the corridor coverage gate.
            hazardCount: 100_000,
            edition: 1,
            issued: '2026-09-30',
        });
        mocks.blob.mockReset();
    });
    const blob = (bridge: Feature) => ({
        cellId: 'BRIDGE-TEST',
        bbox: cellBbox,
        layers: {
            DEPARE: WATER,
            LNDARE: fc(...BANKS, CAP),
            BRIDGE: fc(bridge),
            PONTON: fc(),
            CBLOHD: fc(),
            PIPOHD: fc(),
            CONVYR: fc(),
        },
    });

    it('refuses with the bridge named and its clearance against the air draft', async () => {
        mocks.blob.mockResolvedValue(blob(bridgeLine({ VERCLR: 16, OBJNAM: 'Canal Bridge' })));
        const r = await tryInshoreRoute({ lat: LAT, lon: W0 + 0.01 }, { lat: LAT, lon: W0 + 0.035 }, 2.0, 18);
        expect(r && 'error' in r ? r.code : 'routed').toBe('air-draft-blocked');
        expect(r && 'error' in r ? r.error : '').toMatch(/"Canal Bridge" has 16(\.0)? m clearance/);
    }, 60_000);

    it('an unset air draft blocks the same bridge even when it is tall', async () => {
        mocks.blob.mockResolvedValue(blob(bridgeLine({ VERCLR: 40 })));
        const r = await tryInshoreRoute({ lat: LAT, lon: W0 + 0.01 }, { lat: LAT, lon: W0 + 0.035 }, 2.0, null);
        expect(r && 'error' in r ? r.code : 'routed').toBe('air-draft-blocked');
        expect(r && 'error' in r ? r.error : '').toMatch(/air draft is not set/);
    }, 60_000);

    it('a low overhead conveyor in the cell blocks too, named (round 2, 2026-09-30)', async () => {
        const conveyor = bridgeLine({ VERCLR: 12, OBJNAM: 'Coal loader' }, 'CONVYR');
        mocks.blob.mockResolvedValue({
            ...blob(bridgeLine({ VERCLR: 40 })),
            layers: { ...blob(bridgeLine({ VERCLR: 40 })).layers, CONVYR: fc(conveyor) },
        });
        const r = await tryInshoreRoute({ lat: LAT, lon: W0 + 0.01 }, { lat: LAT, lon: W0 + 0.035 }, 2.0, 18);
        expect(r && 'error' in r ? r.code : 'routed').toBe('air-draft-blocked');
        expect(r && 'error' in r ? r.error : '').toMatch(/overhead conveyor "Coal loader" has 12(\.0)? m clearance/);
    }, 60_000);

    it('a tall bridge with the air draft set does not block', async () => {
        mocks.blob.mockResolvedValue({
            ...blob(bridgeLine({ VERCLR: 40 })),
            layers: { ...blob(bridgeLine({ VERCLR: 40 })).layers, LNDARE: fc(...BANKS) },
        });
        const r = await tryInshoreRoute({ lat: LAT, lon: W0 + 0.01 }, { lat: LAT, lon: W0 + 0.035 }, 2.0, 18);
        expect(r && 'polyline' in r).toBe(true);
        // Every structure layer was extracted: nothing unchecked to report.
        expect(r && 'polyline' in r ? r.structuresUnknownCells : 'refused').toBeUndefined();
    }, 60_000);

    // Phase 2a review (2026-09-30): a cell converted before schema 2 carries
    // no BRIDGE / CBLOHD / PIPOHD at all — every installed cell today. Only
    // the curated bridge file gated the route there, and it was emitted with
    // no caveat while the lead overlay said "bridges not in chart data".
    it('a cell without the structure layers routes WITH the "not checked" caveat naming it', async () => {
        const {
            BRIDGE: _b,
            PONTON: _p,
            CBLOHD: _c,
            PIPOHD: _pp,
            CONVYR: _cv,
            ...schema1
        } = blob(bridgeLine({})).layers;
        mocks.blob.mockResolvedValue({
            cellId: 'BRIDGE-TEST',
            bbox: cellBbox,
            layers: { ...schema1, LNDARE: fc(...BANKS) },
        });
        const r = await tryInshoreRoute({ lat: LAT, lon: W0 + 0.01 }, { lat: LAT, lon: W0 + 0.035 }, 2.0, 18);
        expect(r && 'polyline' in r, r && 'error' in r ? r.error : 'null').toBe(true);
        if (!r || !('polyline' in r)) return;
        expect(r.structuresUnknownCells).toEqual(['BRIDGE-TEST']);
    }, 60_000);
});
