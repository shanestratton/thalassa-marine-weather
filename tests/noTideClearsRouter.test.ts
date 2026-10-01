/**
 * Owner decision 11 (Shane, 2026-10-01: "ok avoid water no tide can clear")
 * through the app's own router, tryInshoreRoute.
 *
 *   • The highest tide per place is loaded BEFORE routing
 *     (services/routing/tideCeilings), the same 14-day curves the tide chips
 *     read, one per 0.25° bucket nearest the route, at most 4, each at its
 *     bucket's centre (fix-up, 2026-10-01).
 *   • With no tide data for a place (offline, no station, a fetch that failed)
 *     nothing is proved there: the route is today's, and where it crosses
 *     water a tide must clear in such a place it carries ONE plain caveat —
 *     "Tide times not loaded — this route may cross water no tide clears.
 *     Check before you go." An all-deep route says nothing.
 *   • With the tide in and no way round, there is no route, and the refusal
 *     names the spot from the chart's own sea-area names.
 *
 * A synthetic chart clear of every regional marker file (no network): two
 * 5–10 m basins joined only by a 300 m "Boat Passage" charted drying
 * −2.2..0. Serene Summer: 2.4 m draft, the router's 0.5 m UKC — 2.9 m.
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

import { tryInshoreRoute } from '../services/InshoreRouter';
import { buildTideCurve } from '../services/TideHeightService';
import { inshoreRouteCaveats, inshoreRouteNotice } from '../components/map/inshoreRouteNotice';
import { routeAreaTideBuckets, routeAreaTideCeilings } from '../services/routing/tideCeilings';
import { tideBucketStep } from '../services/engine/tideCeiling';

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

const WALL_W = 150.4;
const WALL_E = 150.403;
const CELL_BBOX: [number, number, number, number] = [150.2, -30.7, 150.6, -30.3];
const blob = {
    cellId: 'NOTIDE-TEST',
    bbox: CELL_BBOX,
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
        BRIDGE: fc(),
        PONTON: fc(),
        CBLOHD: fc(),
        PIPOHD: fc(),
        CONVYR: fc(),
    },
};
const FROM = { lat: -30.5, lon: 150.35 };
const TO = { lat: -30.5, lon: 150.45 };

/** A 14-day LAT curve topping out at `highestM` (the WorldTides extremes shape),
 *  from an hour ago — the top is read from now on (fix-up, 2026-10-01).
 *  `pastHighM`: yesterday's highs reached that instead. */
function curveTopping(highestM: number, pastHighM?: number) {
    const t0 = Math.floor(Date.now() / 1000) - 3600 - (pastHighM === undefined ? 0 : 24 * 3600);
    const step = (6 * 60 + 12) * 60;
    return buildTideCurve({
        status: 200,
        responseDatum: 'LAT',
        extremes: Array.from({ length: pastHighM === undefined ? 55 : 59 }, (_, k) => ({
            dt: t0 + k * step,
            date: '',
            height: k % 2 === 0 ? 0.2 : pastHighM !== undefined && k < 4 ? pastHighM : highestM,
            type: k % 2 === 0 ? 'Low' : 'High',
        })),
    } as never);
}

beforeEach(() => {
    mocks.cells.length = 0;
    mocks.cells.push({
        id: 'NOTIDE-TEST',
        bbox: CELL_BBOX,
        usage: 'navigation',
        hazardCount: 1_000_000,
        edition: 1,
        issued: '2026-10-01',
    });
    mocks.blob.mockReset();
    mocks.blob.mockResolvedValue(blob);
    mocks.curve.mockReset();
});

describe('decision 11 through tryInshoreRoute', () => {
    it('offline (no tide curve anywhere): today’s route, with one plain caveat', async () => {
        mocks.curve.mockResolvedValue(null);
        const r = await tryInshoreRoute(FROM, TO, 2.4, 18);
        expect(r && 'polyline' in r, r && 'error' in r ? r.error : 'null').toBe(true);
        if (!r || !('polyline' in r)) return;
        expect(r.tideCheck).toBe('not-loaded');
        const caveats = inshoreRouteCaveats({ tideCheck: r.tideCheck });
        expect(caveats).toEqual([
            'Tide times not loaded — this route may cross water no tide clears. Check before you go.',
        ]);
        // It asked for the route's places, before routing.
        expect(mocks.curve).toHaveBeenCalled();
        const notice = inshoreRouteNotice({ stateMaskOk: true, tideCheck: 'not-loaded', ntmLockBanner: null });
        expect(notice?.title).toBe('Tide times not loaded');
    }, 60_000);

    it('no network and no boat Pi: no tide fetch is waited on — today’s route, with the caveat', async () => {
        mocks.curve.mockResolvedValue(curveTopping(2.5));
        // An own property over jsdom's getter; deleted again below.
        Object.defineProperty(navigator, 'onLine', { value: false, configurable: true });
        try {
            const r = await tryInshoreRoute(FROM, TO, 2.4, 18);
            expect(mocks.curve).not.toHaveBeenCalled();
            expect(r && 'polyline' in r, r && 'error' in r ? r.error : 'null').toBe(true);
            if (!r || !('polyline' in r)) return;
            expect(r.tideCheck).toBe('not-loaded');
        } finally {
            delete (navigator as unknown as Record<string, unknown>).onLine;
        }
    }, 60_000);

    it('with the tide in (top 2.5 m) and no way round: no route, and the refusal names the Boat Passage', async () => {
        mocks.curve.mockResolvedValue(curveTopping(2.5));
        const r = await tryInshoreRoute(FROM, TO, 2.4, 18);
        expect(r && 'error' in r, r && 'polyline' in r ? `routed ${r.distanceNM.toFixed(2)} NM` : 'null').toBe(true);
        if (!r || !('error' in r)) return;
        expect(r.code).toBe('no-tide-clears');
        expect(r.error).toBe(
            'No route for 2.4 m draft: the only way through crosses the Boat Passage, charted to dry 2.2 m; ' +
                'the highest tide in the next 14 days is 2.5 m and you need 2.9 m.',
        );
    }, 60_000);

    it('a tide that clears it (top 3.0 m) routes through, with no caveat', async () => {
        mocks.curve.mockResolvedValue(curveTopping(3.0));
        const r = await tryInshoreRoute(FROM, TO, 2.4, 18);
        expect(r && 'polyline' in r, r && 'error' in r ? r.error : 'null').toBe(true);
        if (!r || !('polyline' in r)) return;
        expect(r.tideCheck).toBeUndefined();
    }, 60_000);

    it('a partial load — no tide for the passage’s place — routes through it as before, with the caveat', async () => {
        // Fix-up, 2026-10-01: the caveat went only on a route with no tide
        // loaded anywhere, so a timed-out bucket left D11 off there in silence.
        // The west basin's place (150.25) answers; the passage's (150.5) does not.
        mocks.curve.mockImplementation(async (lat: number, lon: number) =>
            tideBucketStep(lat, lon)[1] === 601 ? curveTopping(2.5) : null,
        );
        const r = await tryInshoreRoute(FROM, TO, 2.4, 18);
        expect(r && 'polyline' in r, r && 'error' in r ? r.error : 'null').toBe(true);
        if (!r || !('polyline' in r)) return;
        expect(r.tideCheck).toBe('not-loaded');
    }, 60_000);

    it('an all-deep route says nothing of tides, loaded or not', async () => {
        // Fix-up, 2026-10-01: "Tide times not loaded — this route may cross
        // water no tide clears" went on every offline route, all-deep or not.
        mocks.curve.mockResolvedValue(null);
        const r = await tryInshoreRoute(FROM, { lat: -30.48, lon: 150.38 }, 2.4, 18);
        expect(r && 'polyline' in r, r && 'error' in r ? r.error : 'null').toBe(true);
        if (!r || !('polyline' in r)) return;
        expect(r.tideCheck).toBeUndefined();
    }, 60_000);

    it('two calls with different tides are never answered by one promise', async () => {
        // Fix-up, 2026-10-01: the in-flight dedupe keyed on the pins alone.
        const [low, high] = await Promise.all([
            tryInshoreRoute(FROM, TO, 2.4, 18, 'safest', {
                tideCeilings: [{ lat: -30.5, lon: 150.5, highestM: 2.5, days: 14 }],
            }),
            tryInshoreRoute(FROM, TO, 2.4, 18, 'safest', {
                tideCeilings: [{ lat: -30.5, lon: 150.5, highestM: 3.0, days: 14 }],
            }),
        ]);
        expect(low && 'error' in low ? low.code : 'routed').toBe('no-tide-clears');
        expect(high && 'polyline' in high, high && 'error' in high ? high.error : 'null').toBe(true);
    }, 60_000);

    it('a caller that hands in the ceilings is not re-fetched', async () => {
        const r = await tryInshoreRoute(FROM, TO, 2.4, 18, 'safest', {
            tideCeilings: [{ lat: -30.5, lon: 150.45, highestM: 2.5, days: 14 }],
        });
        expect(mocks.curve).not.toHaveBeenCalled();
        expect(r && 'error' in r ? r.code : 'routed').toBe('no-tide-clears');
    }, 60_000);
});

describe('decision 11 — which tides are loaded before routing', () => {
    it('the 0.25° buckets nearest the line, at most the chips’ own 4, each fetched at its centre', () => {
        // Fix-up, 2026-10-01: 9 a route, each at a spot that moved with the
        // route — every new route missed the Pi's tide cache (it keys on the
        // exact spot) and spent the public proxy's 12 an hour.
        const spots = routeAreaTideBuckets({ lat: -27.2135, lon: 153.0875 }, { lat: -27.4268, lon: 153.1267 });
        expect(spots.length).toBeGreaterThan(1);
        expect(spots.length).toBeLessThanOrEqual(4);
        const keys = spots.map((s) => tideBucketStep(s.lat, s.lon).join(','));
        expect(new Set(keys).size).toBe(spots.length);
        for (const s of spots) {
            expect(s.lat * 4).toBe(Math.round(s.lat * 4));
            expect(s.lon * 4).toBe(Math.round(s.lon * 4));
        }
        // The three the line itself runs through first: Newport's (-27.25,
        // 153), the river mouth's (-27.5, 153) and (-27.5, 153.25), which it
        // enters at its end.
        expect(keys.slice(0, 3).sort()).toEqual(['-109,612', '-110,612', '-110,613'].sort());
    });

    it('a tide that has already happened is not the highest tide (fix-up, 2026-10-01)', async () => {
        // The curves start at yesterday 00:00 (the proxy's anchor): yesterday's
        // 2.6 m spring high made a 0–0.35 m band read clearable, and the
        // refusal named it as the highest "in the next 14 days".
        const res = await routeAreaTideCeilings(FROM, TO, Date.now(), async () => curveTopping(2.4, 2.6));
        expect(res.ceilings.length).toBeGreaterThan(0);
        for (const c of res.ceilings) expect(c.highestM).toBeCloseTo(2.4, 2);
    });

    it('a failing or empty curve is left out; the rest carry their top and their days', async () => {
        let n = 0;
        const res = await routeAreaTideCeilings(FROM, TO, Date.UTC(2026, 9, 1), async () =>
            n++ === 0 ? null : curveTopping(2.47),
        );
        expect(res.asked).toBeGreaterThan(1);
        expect(res.ceilings.length).toBe(res.asked - 1);
        for (const c of res.ceilings) {
            expect(c.highestM).toBeCloseTo(2.47, 2);
            expect(c.days).toBe(14);
        }
    });
});
