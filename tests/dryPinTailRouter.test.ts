/**
 * Package 125-05b through the app's own router, tryInshoreRoute (Shane,
 * 2026-10-08: "tried to do a route from the newport canals to tangalooma, i
 * got some message about it being dry at both ends???? … better we just have
 * red at the "dry" zones, rather than just shit caning the whole route").
 *
 * A pin on drying sand gets the route all the way to it: the tail across the
 * sand drawn red and named in one sentence for that end — its charted depth
 * against draft + UKC, and when the boat floats over it on today's tide,
 * worked from the same curve the router's tide ceilings were read from (or
 * that there is no tide data). A pin in water behind a drying band the route
 * used to stop 1.3 km short of is reached the same way. A saved plan says it
 * again. A global app: a fictional island at 27° S, 40° W and a fictional
 * Wadden harbour at 53.4° N, 5.3° E, clear of every regional marker file.
 *
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

import { inshoreRouteToGeoJSON, tryInshoreRoute, type InshoreRouteResult } from '../services/InshoreRouter';
import { buildTideCurve } from '../services/TideHeightService';
import { inshoreRouteCaveats, savedInshoreRouteCaveats } from '../components/map/inshoreRouteNotice';
import { dryRunCaveat, plannedRouteDryFinding } from '../services/routing/dryRunWords';

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

/** 27° S, 40° W: 10–20 m water, then 500 m of sand drying 0.4 m, then the island. */
const SAND_W = -40.005;
const SAND_E = -40.0;
const M_LON_S = 111_320 * Math.cos((27 * Math.PI) / 180);
const PIN_SAND = { lat: -27.0, lon: SAND_W + 180 / M_LON_S };
const FROM_SEA = { lat: -27.0, lon: -40.08 };
const ISLAND_CELL = {
    cellId: 'DRYPIN-S27',
    bbox: [-40.25, -27.15, -39.85, -26.85] as [number, number, number, number],
    layers: {
        DEPARE: fc(
            band(-40.2, -27.1, SAND_W, -26.9, 10, 20),
            band(SAND_W, -27.1, -39.9, -27.05, 10, 20),
            band(SAND_W, -26.95, -39.9, -26.9, 10, 20),
            band(SAND_W, -27.05, SAND_E, -26.95, -0.4, 0),
        ),
        LNDARE: fc(land(SAND_E, -27.05, -39.9, -26.95)),
        SEAARE: fc(rect(SAND_W, -27.05, SAND_E, -26.95, { OBJNAM: 'Kestrel Sands' })),
        ...noStructures,
    },
};

/** 53.4° N, 5.3° E: a 6–10 m channel, 800 m of flats drying 1.2 m, a 1–2 m harbour basin in the land. */
const M_LON_N = 111_320 * Math.cos((53.4 * Math.PI) / 180);
const FLAT_E = 5.3 + 800 / M_LON_N;
const BASIN_E = FLAT_E + 500 / M_LON_N;
const PIN_BASIN = { lat: 53.4, lon: 5.3 + 850 / M_LON_N };
const WADDEN_CELL = {
    cellId: 'DRYPIN-N53',
    bbox: [5.15, 53.35, 5.4, 53.45] as [number, number, number, number],
    layers: {
        DEPARE: fc(
            band(5.2, 53.38, 5.3, 53.42, 6, 10),
            band(5.3, 53.38, FLAT_E, 53.42, -1.2, 0),
            band(FLAT_E, 53.395, BASIN_E, 53.405, 1, 2),
        ),
        LNDARE: fc(
            land(FLAT_E, 53.38, 5.36, 53.395),
            land(FLAT_E, 53.405, 5.36, 53.42),
            land(BASIN_E, 53.395, 5.36, 53.405),
        ),
        SEAARE: fc(rect(5.3, 53.38, FLAT_E, 53.42, { OBJNAM: 'Hoogsand Flats' })),
        ...noStructures,
    },
};

/** A 14-day LAT curve from an hour ago, lows 0.2 m and highs `highestM`. */
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

function useCell(cell: typeof ISLAND_CELL): void {
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

const hav = (a: { lat: number; lon: number }, p: [number, number]): number => {
    const r = Math.PI / 180;
    const x =
        Math.sin(((p[1] - a.lat) * r) / 2) ** 2 +
        Math.cos(a.lat * r) * Math.cos(p[1] * r) * Math.sin(((p[0] - a.lon) * r) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(x));
};
const hhmm = (ms: number): string => {
    const d = new Date(ms);
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const caveatsOf = (r: InshoreRouteResult) =>
    inshoreRouteCaveats({ pinOffWater: r.pinOffWater, dryRuns: r.dryRuns, tideCheck: r.tideCheck });
const routed = async (from: { lat: number; lon: number }, to: { lat: number; lon: number }) => {
    const r = await tryInshoreRoute(from, to, 2.4, 18);
    expect(r && 'polyline' in r, r && 'error' in r ? `${r.code}: ${r.error}` : 'null').toBe(true);
    return r as InshoreRouteResult;
};

beforeEach(() => {
    mocks.curve.mockReset();
});

describe('125-05b through tryInshoreRoute', () => {
    it('a pin on drying sand, a 4 m top: reached, the sand red and named with when you float over it', async () => {
        useCell(ISLAND_CELL);
        mocks.curve.mockResolvedValue(curveTopping(4.0));
        const r = await routed(FROM_SEA, PIN_SAND);
        // Was: the route stopped ~325 m short and said "the route stops at its edge".
        expect(hav(PIN_SAND, r.polyline[r.polyline.length - 1])).toBeLessThan(1);
        expect(r.pinOffWater).toEqual({ destination: 'drying' });
        const tail = r.dryRuns?.find((d) => d.pin?.end === 'destination');
        expect(tail, JSON.stringify(r.dryRuns)).toBeDefined();
        expect(tail).toMatchObject({ shallowestM: -0.4, draftM: 2.4, pin: { end: 'destination', at: 'on' } });
        expect(tail!.tide?.topM).toBeCloseTo(4.0, 6);
        // The window the curve gives the tail: 3.3 m of rise (2.9 m − −0.4 m)
        // on a 0.2–4.0 m tide, either side of the next high water.
        const floats = tail!.floats;
        expect(floats, 'a window from the loaded curve').toBeTruthy();
        if (!floats) return;
        expect(floats.fromMs).toBeGreaterThan(Date.now());
        expect(floats.toMs - floats.fromMs).toBeGreaterThan(2 * 3600_000);
        expect(floats.toMs - floats.fromMs).toBeLessThan(3 * 3600_000);
        // The day's later windows too, and when they were worked from (review
        // fix-up, 2026-10-09): the boat reaches its destination hours after
        // it leaves, and a reopened plan drops the windows that have closed.
        expect(floats.later?.length ?? 0).toBeGreaterThanOrEqual(1);
        const next = floats.later![0];
        expect(next.fromMs - floats.fromMs).toBeGreaterThan(11 * 3600_000);
        expect(tail!.floatsWorkedMs).toBeLessThanOrEqual(floats.fromMs);
        expect(Date.now() - tail!.floatsWorkedMs!).toBeLessThan(60_000);
        const caveats = caveatsOf(r);
        expect(caveats).toHaveLength(1);
        expect(caveats[0]).toMatch(
            new RegExp(
                '^Red on this route: your destination pin is on a drying bank — the last 1[789]0 m to it dries 0\\.4 m and you need 2\\.9 m ' +
                    `\\(2\\.4 m draft \\+ 0\\.5 m under the keel\\); you float over it from about ${hhmm(floats.fromMs)} to ${hhmm(floats.toMs)} on (today's|tomorrow's) tide, `,
            ),
        );
        expect(caveats[0]).toContain(`again from about ${hhmm(next.fromMs)} to ${hhmm(next.toMs)}`);
        expect(caveats[0]).toMatch(/\. It dries at low water\.$/);
        // A saved plan says it again, the window kept.
        const geo = inshoreRouteToGeoJSON(r, FROM_SEA, PIN_SAND);
        expect((geo.properties as { dryRuns?: unknown }).dryRuns).toEqual(r.dryRuns);
        expect(savedInshoreRouteCaveats({ routeGeoJSON: geo })).toContain(caveats[0]);
        // Nothing else says the route runs "on the edge of" the sand it goes onto.
        expect(savedInshoreRouteCaveats({ routeGeoJSON: geo }).join(' ')).not.toMatch(/edge of water charted to dry/);
        // …and following it is a red finding: two taps.
        expect(plannedRouteDryFinding(caveats)).toMatchObject({ tone: 'finding', code: 'finding' });
    }, 60_000);

    it('the same pin with no tide curve: reached, red, "there is no tide data for it"', async () => {
        useCell(ISLAND_CELL);
        mocks.curve.mockResolvedValue(null);
        const r = await routed(FROM_SEA, PIN_SAND);
        expect(hav(PIN_SAND, r.polyline[r.polyline.length - 1])).toBeLessThan(1);
        const tail = r.dryRuns?.find((d) => d.pin?.end === 'destination');
        expect(tail?.tide).toBeNull();
        expect(tail?.floats).toBeUndefined();
        expect(caveatsOf(r)[0]).toMatch(
            /^Red on this route: your destination pin is on a drying bank — the last 1[789]0 m to it dries 0\.4 m and you need 2\.9 m \(2\.4 m draft \+ 0\.5 m under the keel\); there is no tide data for it\. It dries at low water\.$/,
        );
        // The general line names no pin's tail.
        expect(dryRunCaveat(r.dryRuns)).toBeNull();
    }, 60_000);

    it('a departure from the sand with a 2.5 m top: starts at the pin, "so no tide floats you over it"', async () => {
        useCell(ISLAND_CELL);
        mocks.curve.mockResolvedValue(curveTopping(2.5));
        const r = await routed(PIN_SAND, FROM_SEA);
        expect(hav(PIN_SAND, r.polyline[0])).toBeLessThan(1);
        expect(caveatsOf(r)[0]).toMatch(
            /^Red on this route: your departure pin is on a drying bank — the first 1[789]0 m from it dries 0\.4 m and you need 2\.9 m .*; the highest tide in the next 14 days is 2\.5 m, so no tide floats you over it\. It dries at low water\.$/,
        );
    }, 60_000);

    it('a Wadden harbour pin behind 800 m of flats, no tide curve: reached across them, red and named', async () => {
        useCell(WADDEN_CELL as unknown as typeof ISLAND_CELL);
        mocks.curve.mockResolvedValue(null);
        const r = await routed({ lat: 53.4, lon: 5.22 }, PIN_BASIN);
        // Was: ended ~1.3 km short in the channel, nothing named.
        expect(hav(PIN_BASIN, r.polyline[r.polyline.length - 1])).toBeLessThan(1);
        expect(r.pinOffWater).toBeUndefined();
        expect(caveatsOf(r)).toContainEqual(
            expect.stringMatching(
                /^Red on this route: the way in to your destination pin crosses (7[89]0|8[0-4]0) m of the Hoogsand Flats, which dries 1\.2 m, and you need 2\.9 m \(2\.4 m draft \+ 0\.5 m under the keel\); there is no tide data for it\.$/,
            ),
        );
    }, 60_000);
});
