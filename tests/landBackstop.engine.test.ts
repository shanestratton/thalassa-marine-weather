/**
 * The satellite land check on Auto's REAL path (2026-10-02): calculateThalassaProposal
 * → tryInshoreRoute → routeInshore → inshoreRouteCrossesLand with the route's own
 * chart evidence, NOAA ETOPO answered by a coarse synthetic relief.
 *
 * Shane's phone, Coral Sea Marina → Daydream Island: ETOPO's ~1.8 km pixels
 * read the water beside a headland as land, and Auto refused a route the
 * detailed charts cover. Here a 1.6 × 1.2 km island in a 10 m sea, and an
 * ETOPO that reads land up to 700 m off its shore — as its coarse pixels do:
 *   • charted by a harbour-scale cell (1:12,000): the route round the island
 *     is shown, and the check says it ignored the ETOPO land;
 *   • charted only by a general cell (1:1,500,000): no chart finer than ETOPO
 *     vouches for that water, so the same route is refused, and the words say
 *     none of the charts used for the route is detailed enough there.
 * Synthetic geometry only (the repo is public): invented water near 161 E, 31 S.
 *
 * Run: NODE_OPTIONS=--max-old-space-size=4096 npx vitest run --maxWorkers=1
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, FeatureCollection, Polygon } from 'geojson';

const h = vi.hoisted(() => ({
    cells: [] as { id: string; bbox: [number, number, number, number] }[],
    blobs: new Map<string, unknown>(),
    etopoLand: (_lon: number, _lat: number): boolean => false,
}));

vi.mock('../services/enc/EncCellMetadata', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    cellsForBBox: (b: [number, number, number, number]) =>
        h.cells.filter((c) => !(c.bbox[2] < b[0] || c.bbox[0] > b[2] || c.bbox[3] < b[1] || c.bbox[1] > b[3])),
    listCells: () => h.cells,
}));
vi.mock('../services/enc/EncCellStore', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    loadCellGeoJSON: async (id: string) => h.blobs.get(id) ?? null,
}));
vi.mock('../services/OsmRouteOverlayService', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    getOsmRouteOverlay: async () => null,
}));
vi.mock('../services/ntmRouting', () => ({
    activeNtmZonesFor: async () => ({ features: [], tracklines: [] }),
    packsForCorridor: async () => [],
}));
vi.mock('../services/localNotices', () => ({
    loadLocalNotices: async () => [],
    localNoticesNearPolyline: () => [],
}));
vi.mock('../services/mapboxWater', () => ({
    fetchMapboxWater: async () => ({ type: 'FeatureCollection', features: [] }),
}));
vi.mock('../services/satelliteWater', () => ({
    fetchSatelliteWater: async () => ({ type: 'FeatureCollection', features: [] }),
}));
vi.mock('../services/lowBridges', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    loadLowBridges: async () => [],
}));
vi.mock('../services/TideHeightService', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    fetchTideCurve: async () => null,
}));
vi.mock('../services/routing/tideCeilings', async (original) => ({
    ...(await original<Record<string, unknown>>()),
    routeAreaTideCeilings: async () => ({ ceilings: [] }),
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: { autorouteTrialEnabled: true } }) },
}));

import { calculateThalassaProposal } from '../services/autoroutingThalassa';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { GebcoDepthService } from '../services/GebcoDepthService';

const LON0 = 161.0;
const LAT0 = -31.0;
const M_PER_DEG_LAT = 111_320;
const M_PER_DEG_LON = M_PER_DEG_LAT * Math.cos((LAT0 * Math.PI) / 180);
const ll = (x: number, y: number): [number, number] => [LON0 + x / M_PER_DEG_LON, LAT0 + y / M_PER_DEG_LAT];
const xy = ([lon, lat]: [number, number]): [number, number] => [
    (lon - LON0) * M_PER_DEG_LON,
    (lat - LAT0) * M_PER_DEG_LAT,
];

function rect(x0: number, y0: number, x1: number, y1: number): Polygon {
    const ring: [number, number][] = [];
    const edge = (ax: number, ay: number, bx: number, by: number): void => {
        const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / 25));
        for (let i = 0; i < n; i++) ring.push(ll(ax + ((bx - ax) * i) / n, ay + ((by - ay) * i) / n));
    };
    edge(x0, y0, x1, y0);
    edge(x1, y0, x1, y1);
    edge(x1, y1, x0, y1);
    edge(x0, y1, x0, y0);
    ring.push(ring[0]);
    return { type: 'Polygon', coordinates: [ring] };
}
const area = (acronym: string, g: Polygon, props: Record<string, unknown> = {}): Feature => ({
    type: 'Feature',
    properties: { acronym, ...props },
    geometry: g,
});
const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const sea = (x0: number, y0: number, x1: number, y1: number) =>
    area('DEPARE', rect(x0, y0, x1, y1), { DRVAL1: 10, DRVAL2: 20 });

const ISLAND = { x0: -800, y0: -600, x1: 800, y1: 600 };
const E = 15_000;
/** How far off the shore the coarse relief still reads land. */
const ETOPO_BLEED_M = 700;

/** The island scene, in one cell compiled at `nativeScale`. */
function installIsland(nativeScale: number): void {
    const { x0, y0, x1, y1 } = ISLAND;
    const blob = {
        cellId: 'OC-99-SYN162',
        sourceHO: 'AU',
        edition: 1,
        issued: '2026-10-02',
        nativeScale,
        bbox: [...ll(-E, -E), ...ll(E, E)] as [number, number, number, number],
        layers: {
            LNDARE: fc([area('LNDARE', rect(x0, y0, x1, y1))]),
            DEPARE: fc([sea(-E, -E, x0, E), sea(x1, -E, E, E), sea(x0, -E, x1, y0), sea(x0, y1, x1, E)]),
        },
    };
    h.cells = [
        {
            id: blob.cellId,
            sourceHO: blob.sourceHO,
            edition: blob.edition,
            issued: blob.issued,
            importedAt: '2026-10-02T00:00:00.000Z',
            bbox: blob.bbox,
            geojsonPath: `enc/${blob.cellId}.json`,
            hazardCount: 5_000,
            usage: 'navigation',
        } as never,
    ];
    h.blobs.clear();
    h.blobs.set(blob.cellId, blob);
}

/** Metres from the island's rectangle (0 inside it). */
function offIslandM(lon: number, lat: number): number {
    const [x, y] = xy([lon, lat]);
    const dx = Math.max(ISLAND.x0 - x, 0, x - ISLAND.x1);
    const dy = Math.max(ISLAND.y0 - y, 0, y - ISLAND.y1);
    return Math.hypot(dx, dy);
}

const PROFILE = {
    length: { status: 'measured' as const, valueM: 14 },
    beam: { status: 'measured' as const, valueM: 4.9 },
    airDraft: { status: 'measured' as const, valueM: 18.29 },
    draftStatus: 'measured' as const,
};
const auto = () => {
    const [fromLon, fromLat] = ll(-3000, 0);
    const [toLon, toLat] = ll(3000, 0);
    return calculateThalassaProposal({
        departure: { lat: fromLat, lon: fromLon },
        destination: { lat: toLat, lon: toLon },
        draftM: 2.4,
        speedKts: 6,
        vesselProfile: structuredClone(PROFILE),
    });
};

beforeEach(() => {
    setAuthIdentityScope('backstop-engine-user');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'));
    h.etopoLand = (lon, lat) => offIslandM(lon, lat) <= ETOPO_BLEED_M;
    vi.spyOn(GebcoDepthService, 'queryRouteDepths').mockImplementation(async (points) =>
        points.map(({ lat, lon }) => ({ lat, lon, depth_m: h.etopoLand(lon, lat) ? 3 : -12 })),
    );
});
afterEach(() => {
    vi.restoreAllMocks();
    setAuthIdentityScope(null);
});

describe('the satellite land check on Auto’s real path, synthetic cells', { timeout: 180_000 }, () => {
    it('a harbour-scale chart vouches for the water ETOPO calls land: the route is shown', async () => {
        installIsland(12_000);
        const warn = vi.spyOn(console, 'warn');
        const route = await auto();
        // The coarse relief really did read land along this route, in at
        // least one whole run the check would once have refused…
        const said = warn.mock.calls
            .flat()
            .map((a) =>
                typeof a === 'string' ? /ignored (\d+) ETOPO land sample\(s\) \((\d+) whole run/.exec(a) : null,
            )
            .find(Boolean);
        expect(said, 'the check says it ignored ETOPO land the charts vouch for').toBeTruthy();
        expect(Number(said![2])).toBeGreaterThanOrEqual(1);
        // …and the route is shown, checked, never across the island.
        expect(route.engine?.backstop).toBe('verified');
        expect(route.coordinates.every(([lon, lat]) => offIslandM(lon, lat) > 0)).toBe(true);
    });

    it('a general-scale chart (1:1,500,000) never vouches: the same route is refused, saying why and where', async () => {
        installIsland(1_500_000);
        await expect(auto()).rejects.toThrow(
            /^Satellite relief shows land near 3[01]\.\d{3}° S, 161\.0\d\d° E, where none of the charts used for this route is detailed enough to say whether it is water\. The route is not shown\. Check that stretch on a detailed chart, or plot this passage in Manual\. Nothing changed\.$/,
        );
    });
});
