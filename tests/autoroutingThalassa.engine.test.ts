/**
 * Auto's provider on the REAL engine (2026-10-01): calculateThalassaProposal
 * → tryInshoreRoute → routeInshore, on synthetic cells only (the repo is
 * public). The scenes are invented geometry in the Tasman Sea near 161.0E,
 * 31.0S, apart from the fix-first harness at 160E (tests/engine/
 * soloMarkDiscYieldsToDeepWater.test.ts, whose mocks this file reuses).
 * Serene Summer: 2.4 m draft, 0.5 m under the keel (2.9 m), 18 m air draft.
 *
 * Run: NODE_OPTIONS=--max-old-space-size=4096 npx vitest run --maxWorkers=1
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Feature, FeatureCollection, Polygon } from 'geojson';

const h = vi.hoisted(() => ({
    cells: [] as { id: string; bbox: [number, number, number, number] }[],
    blobs: new Map<string, unknown>(),
    ceilings: [] as { lat: number; lon: number; highestM: number; days: number }[],
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
    routeAreaTideCeilings: async () => ({ ceilings: h.ceilings }),
}));
vi.mock('../services/routing/landBackstop', () => ({
    inshoreRouteCrossesLand: async () => ({ status: 'verified', crossesLand: false, runs: [] }),
}));
// The skipper has switched Settings → Preferences → "Auto route (trial)" on
// (off by default since 2026-10-01; tests/AutorouteTrialSwitch.test.tsx).
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: { getState: () => ({ settings: { autorouteTrialEnabled: true } }) },
}));

import { calculateThalassaProposal, THALASSA_PLANNED_ONLY_WARNING } from '../services/autoroutingThalassa';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { isStandingRouteNote, routeNotesToReview } from '../services/autoroutingReview';

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

function install(layers: Record<string, FeatureCollection>): void {
    const blob = {
        cellId: 'OC-99-SYN161',
        sourceHO: 'AU',
        edition: 1,
        issued: '2026-10-01',
        nativeScale: 12_000,
        bbox: [...ll(-E, -E), ...ll(E, E)] as [number, number, number, number],
        layers,
    };
    h.cells = [
        {
            id: blob.cellId,
            sourceHO: blob.sourceHO,
            edition: blob.edition,
            issued: blob.issued,
            importedAt: '2026-10-01T00:00:00.000Z',
            bbox: blob.bbox,
            geojsonPath: `enc/${blob.cellId}.json`,
            // Routing grade for the corridor gate (features per square degree).
            hazardCount: 5_000,
            usage: 'navigation',
        } as never,
    ];
    h.blobs.clear();
    h.blobs.set(blob.cellId, blob);
}

/** A 10 m sea with a 1.6 × 1.2 km island in the middle. */
function islandScene(): void {
    const { x0, y0, x1, y1 } = ISLAND;
    install({
        LNDARE: fc([area('LNDARE', rect(x0, y0, x1, y1))]),
        DEPARE: fc([sea(-E, -E, x0, E), sea(x1, -E, E, E), sea(x0, -E, x1, y0), sea(x0, y1, x1, E)]),
    });
}

/** A land wall north–south through the middle; its only gap is a bank charted
 *  0–1 m (DRVAL1 0 / DRVAL2 1). */
function bankScene(): void {
    install({
        LNDARE: fc([area('LNDARE', rect(-200, -E, 200, -300)), area('LNDARE', rect(-200, 300, 200, E))]),
        DEPARE: fc([
            sea(-E, -E, -200, E),
            sea(200, -E, E, E),
            area('DEPARE', rect(-200, -300, 200, 300), { DRVAL1: 0, DRVAL2: 1 }),
        ]),
    });
}

/** A solid land wall north–south through the middle, `widthM` wide, from
 *  edge to edge of the chart: no way round it by water at all (2026-10-01
 *  review, the safety lens's scene (a)). */
function wallScene(widthM: number): void {
    const half = widthM / 2;
    install({
        LNDARE: fc([area('LNDARE', rect(-half, -E, half, E))]),
        DEPARE: fc([sea(-E, -E, -half, E), sea(half, -E, E, E)]),
    });
}

/**
 * A lagoon inside a block of land, reached from the sea by a deep channel;
 * a ring of bar charted 0–1 m (thin to north and south) lies all round the
 * lagoon. The integrity lens's scene (2026-10-01 review): a WATER pin behind
 * a bar no tide clears, where the relaxed route's tail runs onto the land
 * beside the bar and is trimmed back.
 */
function lagoonScene(): void {
    const ring = { x0: -2800, x1: -1200, y0: -450, y1: 450 };
    const lagoon = { x0: -2600, x1: -1400, y0: -400, y1: 400 };
    const bar = (x0: number, y0: number, x1: number, y1: number) =>
        area('DEPARE', rect(x0, y0, x1, y1), { DRVAL1: 0, DRVAL2: 1 });
    install({
        LNDARE: fc([
            area('LNDARE', rect(-4000, -2000, ring.x0, 2000)),
            area('LNDARE', rect(ring.x1, 75, 0, 2000)),
            area('LNDARE', rect(ring.x1, -2000, 0, -75)),
            area('LNDARE', rect(ring.x0, ring.y1, ring.x1, 2000)),
            area('LNDARE', rect(ring.x0, -2000, ring.x1, ring.y0)),
        ]),
        DEPARE: fc([
            sea(0, -E, E, E),
            sea(-E, 2000, 0, E),
            sea(-E, -E, 0, -2000),
            sea(-E, -2000, -4000, 2000),
            sea(ring.x1, -75, 0, 75), // the channel in
            sea(lagoon.x0, lagoon.y0, lagoon.x1, lagoon.y1), // the lagoon
            bar(ring.x0, lagoon.y1, ring.x1, ring.y1),
            bar(ring.x0, ring.y0, ring.x1, lagoon.y0),
            bar(ring.x0, lagoon.y0, lagoon.x0, lagoon.y1),
            bar(lagoon.x1, lagoon.y0, ring.x1, lagoon.y1),
        ]),
    });
}

/**
 * A dredged channel out into a uniform band (package 125-06; fictional, the
 * shape of Shane's Port of Airlie → Nara Inlet route, 2026-10-08): a 54 m
 * channel charted 1.8 m running north from a deep basin, 0–2 m flats either
 * side, a 2–5 m band from 300 m short of its end, a 3.6–5 m pocket
 * north-west, 5–10 m water from 1.1 km north. Surveyed A1 throughout. No
 * lateral marks: the Seaway graph has no gates to route by, so this is the
 * engine's route as Auto ships it (tests/engine/sameTideChord.test.ts is the
 * engine's golden, marks and all).
 */
function channelScene(): void {
    const HALF = 27;
    const band = (d1: number, d2: number, x0: number, y0: number, x1: number, y1: number, holes: Polygon[] = []) =>
        area(
            'DEPARE',
            {
                type: 'Polygon',
                coordinates: [rect(x0, y0, x1, y1).coordinates[0], ...holes.map((h) => h.coordinates[0])],
            },
            { DRVAL1: d1, DRVAL2: d2 },
        );
    install({
        DEPARE: fc([
            band(5, 10, -E, 1100, E, E),
            band(2, 5, -E, 15, E, 1100, [rect(-1300, 620, -560, 1100)]),
            band(3.6, 5, -1300, 620, -560, 1100),
            band(2, 5, -E, -300, -HALF, 15),
            band(1.8, 5, -HALF, -1500, HALF, 15),
            band(2, 5, HALF, -300, E, 15),
            band(0, 2, -E, -1500, -HALF, -300),
            band(0, 2, HALF, -1500, E, -300),
            band(5, 10, -E, -E, E, -1500),
        ]),
        DRGARE: fc([area('DRGARE', rect(-HALF, -1500, HALF, 15), { DRVAL1: 1.8 })]),
        M_QUAL: fc([area('M_QUAL', rect(-E, -E, E, E), { CATZOC: 1 })]),
    });
}

const ceilingsAt = (highestM: number) => {
    const out: { lat: number; lon: number; highestM: number; days: number }[] = [];
    for (let lat = -31.5; lat <= -30.5; lat += 0.25)
        for (let lon = 160.5; lon <= 161.5; lon += 0.25) out.push({ lat, lon, highestM, days: 14 });
    return out;
};

const PROFILE = {
    length: { status: 'measured' as const, valueM: 14 },
    beam: { status: 'measured' as const, valueM: 4.9 },
    airDraft: { status: 'measured' as const, valueM: 18 },
    draftStatus: 'measured' as const,
};
const auto = (from: [number, number], to: [number, number]) => {
    const [fromLon, fromLat] = ll(...from);
    const [toLon, toLat] = ll(...to);
    return calculateThalassaProposal({
        departure: { lat: fromLat, lon: fromLon },
        destination: { lat: toLat, lon: toLon },
        draftM: 2.4,
        speedKts: 6,
        vesselProfile: structuredClone(PROFILE),
    });
};

/** Metres of the line inside a rectangle (sampled every 10 m). */
function metresInside(coords: [number, number][], r: typeof ISLAND, insetM = 0): number {
    let m = 0;
    for (let i = 0; i + 1 < coords.length; i++) {
        const [ax, ay] = xy(coords[i]);
        const [bx, by] = xy(coords[i + 1]);
        const seg = Math.hypot(bx - ax, by - ay);
        const n = Math.max(1, Math.ceil(seg / 10));
        for (let k = 0; k < n; k++) {
            const t = (k + 0.5) / n;
            const x = ax + (bx - ax) * t;
            const y = ay + (by - ay) * t;
            if (x > r.x0 + insetM && x < r.x1 - insetM && y > r.y0 + insetM && y < r.y1 - insetM) m += seg / n;
        }
    }
    return m;
}

beforeEach(() => {
    setAuthIdentityScope('engine-test-user');
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('no network in this test'));
    h.ceilings = [];
});
afterEach(() => {
    vi.restoreAllMocks();
    setAuthIdentityScope(null);
});

/** RE-PIN (package 125-05, Shane 2026-10-08: "better we just have red at
 *  the "dry" zones, rather than just shit caning the whole route"): where
 *  decision 11 found no way round, Auto used to refuse — "No route for 2.4 m
 *  draft: the only way through crosses …". It now gets the route through it,
 *  red, and this note names the stretch; never across the land beside it. */
const DRY_NOTE =
    /^Red on this route: .+ is charted 0–1 m and you need 2\.9 m \(2\.4 m draft \+ 0\.5 m under the keel\); the highest tide in the next 14 days is 1\.5 m, so no tide clears it\. Check it on the chart before you go\.$/;
/** The bank scene's land walls, either side of the 600 m gap. */
const WALLS = [
    { x0: -200, y0: -E, x1: 200, y1: -300 },
    { x0: -200, y0: 300, x1: 200, y1: E },
];

describe('Auto on the real engine, synthetic cells', { timeout: 180_000 }, () => {
    it('routes round the island, never across it, and the same way twice', async () => {
        islandScene();
        const first = await auto([-3000, 0], [3000, 0]);
        expect(first.provider).toBe('Thalassa');
        expect(Math.round(metresInside(first.coordinates, ISLAND)), 'metres across the island').toBe(0);
        expect(first.engine?.stateMask).not.toBeNull();
        expect(first.engine?.stateMask?.length).toBe(first.coordinates.length - 1);
        const second = await auto([-3000, 0], [3000, 0]);
        expect(JSON.stringify(second.coordinates)).toBe(JSON.stringify(first.coordinates));
    });

    it('a pin on the island: the engine stops at the water and Auto says so (owner decision 7)', async () => {
        islandScene();
        const route = await auto([-3000, 0], [0, 0]);
        // Never onto the island beyond its edge cells.
        expect(Math.round(metresInside(route.coordinates, ISLAND, 60)), 'metres onto the island').toBe(0);
        expect(route.warnings.some((w) => /charted land/.test(w))).toBe(true);
        expect(route.warnings.some((w) => /short of your destination pin/.test(w))).toBe(false);
    });

    it('a bank no tide clears and no way round: the route crosses it, red, the bank named (125-05)', async () => {
        bankScene();
        h.ceilings = ceilingsAt(1.5); // 1 m + 1.5 m < 2.9 m
        const route = await auto([-5000, 0], [5000, 0]);
        expect(route.warnings.filter((w) => DRY_NOTE.test(w))).toHaveLength(1);
        for (const wall of WALLS) expect(Math.round(metresInside(route.coordinates, wall)), 'metres on land').toBe(0);
        expect(Math.round(metresInside(route.coordinates, { x0: -200, y0: -300, x1: 200, y1: 300 }))).toBeGreaterThan(
            300,
        );
    });

    // Fixed 2026-10-01 (review of the Phase 3 swap; it was it.fails). With a
    // pin within ~4 km of the bank, the strict pass refused for water no tide
    // clears with a pin snapped far across the wall, and routeInshoreMain's
    // localized relax retry (zone capped at 4 km) returned a line through the
    // land wall beside the bank instead — 400 m on charted land, 19 m inside
    // its edge, drawn red, under the engine's 500 m land veto. The
    // independent review graded it caution, so it could be SAVED, and Plan
    // My Day rated it amber. A relaxed rescue that crosses charted land, or
    // water no tide clears, is no rescue now (relaxedRescueFault): the strict
    // refusal stands. Owner decision 11: the deep way round, or no route and
    // why. Pins 5 km either side (above) always refused.
    for (const [from, to] of [
        [-3000, 3000],
        [-1000, 1000],
        [-1000, 8000],
    ] as const) {
        it(`the same bank with pins at ${from} m and ${to} m: across the bank, red and named — never the land beside it`, async () => {
            bankScene();
            h.ceilings = ceilingsAt(1.5);
            const route = await auto([from, 0], [to, 0]);
            expect(route.warnings.filter((w) => DRY_NOTE.test(w))).toHaveLength(1);
            for (const wall of WALLS)
                expect(Math.round(metresInside(route.coordinates, wall)), 'metres on land').toBe(0);
        });
    }
});

// The integrity lens's scene (2026-10-01 review): a WATER pin behind a bar
// no tide clears, with land beside the bar. The relaxed route goes for the
// pin over that land (here 645 m of it, and the engine's land veto refuses
// it); the strict route stops short at the channel, and the decision-11
// verdict reads the gap from the pin to where the route reached — across the
// bar — and refuses, naming it. (The lens's exact path, a relaxed tail cut
// back off a spit — destinationLandTailTrimM — used to excuse that read; the
// excuse is gone. This scene does not reach that trim: measured, its relaxed
// route ends at the pin and is vetoed for the land first.)
// Package 125-06 (Shane, 2026-10-08, a fresh Auto route from Port of Airlie
// to Nara Inlet: "8 route notes · review required", a dog-leg west at the
// outer pair, "no reason to go to port here???"). Three of the notes are on
// every Auto route whatever it finds — the proposal-only line, how it was
// routed, and that beam and length are not used yet — and one explained the
// dog-leg. Now the route runs straight on (the same tide as the turn), and
// the count is of what this route found; the three are still listed.
describe('a fresh Auto route out of a channel into a uniform band (125-06)', { timeout: 180_000 }, () => {
    it('runs straight on, with no bend to explain', async () => {
        channelScene();
        const route = await auto([0, -1700], [3000, 9000]);
        const line = route.coordinates.map(xy);
        expect(Math.min(...line.filter(([, y]) => y > 40).map(([x]) => x))).toBeGreaterThan(-150);
        expect(route.warnings.some((w) => /the route bends/.test(w))).toBe(false);
    });

    it('counts what the route found, not the lines every Auto route carries', async () => {
        channelScene();
        const route = await auto([0, -1700], [3000, 9000]);
        const standing = route.warnings.filter((w) => isStandingRouteNote(w));
        expect(standing).toEqual([
            THALASSA_PLANNED_ONLY_WARNING,
            'Routed on this phone by Thalassa from your installed charts: draft 2.40 m + 0.5 m under the keel at chart datum (LAT). Tide is shown, never assumed.',
            'Beam and length are not used by the router yet.',
        ]);
        const toReview = routeNotesToReview(route.warnings);
        expect(toReview).toEqual(route.warnings.filter((w) => !standing.includes(w)));
        // What this route found: the channel's water (1.8 m) and the band's
        // (2.0 m) under the 2.9 m it needs, and the channel edge it runs by.
        expect(toReview.length).toBeLessThanOrEqual(route.warnings.length - 3);
        for (const note of toReview) expect(isStandingRouteNote(note)).toBe(false);
    });
});

describe('a water pin behind a bar no tide clears (owner decision 11)', { timeout: 180_000 }, () => {
    it('is routed in across the bar, red and named, not cut short — never over the land beside it (125-05)', async () => {
        lagoonScene();
        h.ceilings = ceilingsAt(1.5); // 1 m + 1.5 m < 2.9 m
        const route = await auto([3000, 0], [-2000, 0]);
        expect(route.warnings.filter((w) => DRY_NOTE.test(w))).toHaveLength(1);
        const end = xy(route.coordinates[route.coordinates.length - 1]);
        expect(Math.hypot(end[0] + 2000, end[1]), 'metres short of the pin').toBeLessThan(60);
        // The land round the lagoon (the ring's own blocks), never crossed.
        for (const land of [
            { x0: -1200, y0: 75, x1: 0, y1: 2000 },
            { x0: -1200, y0: -2000, x1: 0, y1: -75 },
            { x0: -2800, y0: 450, x1: -1200, y1: 2000 },
            { x0: -2800, y0: -2000, x1: -1200, y1: -450 },
        ])
            expect(Math.round(metresInside(route.coordinates, land)), 'metres on land').toBe(0);
    });

    it('a tide that clears the bar (1 m + 3 m ≥ 2.9 m) lets the route in, to the pin', async () => {
        lagoonScene();
        h.ceilings = ceilingsAt(3);
        const route = await auto([3000, 0], [-2000, 0]);
        const end = xy(route.coordinates[route.coordinates.length - 1]);
        expect(Math.hypot(end[0] + 2000, end[1]), 'metres short of the pin').toBeLessThan(60);
    });
});

// The safety lens's scene (a), 2026-10-01 review: a solid land wall with no
// way round. The engine's localized relax retry opens land up to 4 km from a
// far-snapped pin and its veto refuses only a land run over 500 m, so a 400 m
// wall came back as a red "route" straight across it, with no route note
// naming land. Auto refuses any charted land a route crosses away from a
// pin's own edge.
describe('Auto never draws a route across charted land, synthetic cells', { timeout: 180_000 }, () => {
    const LAND_REFUSAL =
        /^The only way Thalassa found crosses charted land near \d+\.\d{3}° S, \d+\.\d{3}° E\. No route\. Nothing changed\.$/;

    for (const [from, to] of [
        [-3000, 3000],
        [-1000, 1000],
    ] as const) {
        it(`a 400 m wall with pins at ${from} m and ${to} m: no route, and it says land`, async () => {
            wallScene(400);
            await expect(auto([from, 0], [to, 0])).rejects.toThrow(LAND_REFUSAL);
        });
    }

    // With tides loaded the engine itself keeps the strict route rather than
    // a relaxed one over land (inshoreRouterEngine routeInshoreMain), and
    // that route ends across the wall from the pin: no route by water.
    it('a 400 m wall with tides loaded: no route either — the water ends across the wall', async () => {
        wallScene(400);
        h.ceilings = ceilingsAt(1.5);
        await expect(auto([-3000, 0], [3000, 0])).rejects.toThrow(
            /^No route by water (to your destination|from your departure): the nearest water Thalassa could reach is \d+\.\d km from the pin\. Nothing changed\.$/,
        );
    });

    it('a 700 m wall: the engine itself refuses the land', async () => {
        wallScene(700);
        await expect(auto([-3000, 0], [3000, 0])).rejects.toThrow(/charted land/);
    });

    // The safety lens's pin-gap scene: pins 8 km either side, outside any
    // relax zone. The engine's far snap gave a "route" that ended 11.6 km
    // from the destination, on the wrong side of the wall, painted yellow,
    // saveable as a route to that destination.
    it('a 400 m wall with pins 8 km out: no route by water, and it says how far the water ends', async () => {
        wallScene(400);
        await expect(auto([-8000, 0], [8000, 0])).rejects.toThrow(
            /^No route by water (to your destination|from your departure): the nearest water Thalassa could reach is \d+\.\d km from the pin\. Nothing changed\.$/,
        );
    });
});

/**
 * Package 125-05b (Shane, 2026-10-08: "tried to do a route from the newport
 * canals to tangalooma, i got some message about it being dry at both ends????
 * … better we just have red at the "dry" zones, rather than just shit caning
 * the whole route"). A pin on a drying beach gets Auto's route all the way to
 * it, the beach red and named; a pin in a harbour behind drying flats is no
 * longer "no route by water" — the flats are crossed, red and named. A gap of
 * charted land is still no route.
 */
describe('Auto to a pin on drying ground (125-05b), synthetic cells', { timeout: 180_000 }, () => {
    /** The island with 500 m of beach drying 0.4 m along its west face. */
    function beachScene(): void {
        const { x0, y0, x1, y1 } = ISLAND;
        install({
            LNDARE: fc([area('LNDARE', rect(x0, y0, x1, y1))]),
            DEPARE: fc([
                sea(-E, -E, x0 - 500, E),
                sea(x1, -E, E, E),
                sea(x0 - 500, -E, x1, y0),
                sea(x0 - 500, y1, x1, E),
                area('DEPARE', rect(x0 - 500, y0, x0, y1), { DRVAL1: -0.4, DRVAL2: 0 }),
            ]),
        });
    }
    /** Sea to the west; 800 m of flats drying 1.2 m; a 1–2 m harbour basin
     *  in the land beyond — or, with `landGap`, 800 m of land instead. */
    function harbourScene(landGap = false): void {
        const gap = landGap
            ? { LNDARE: [area('LNDARE', rect(0, -2000, 800, 2000))], DEPARE: [] as Feature[] }
            : {
                  LNDARE: [] as Feature[],
                  DEPARE: [area('DEPARE', rect(0, -2000, 800, 2000), { DRVAL1: -1.2, DRVAL2: 0 })],
              };
        install({
            LNDARE: fc([
                ...gap.LNDARE,
                area('LNDARE', rect(800, -2000, 3000, -500)),
                area('LNDARE', rect(800, 500, 3000, 2000)),
                area('LNDARE', rect(1300, -500, 3000, 500)),
            ]),
            DEPARE: fc([
                sea(-E, -E, 0, E),
                sea(0, -E, 3000, -2000),
                sea(0, 2000, 3000, E),
                sea(3000, -E, E, E),
                ...gap.DEPARE,
                area('DEPARE', rect(800, -500, 1300, 500), { DRVAL1: 1, DRVAL2: 2 }),
            ]),
        });
    }
    const endGapM = (coords: [number, number][], pin: [number, number]): number => {
        const [x, y] = xy(coords[coords.length - 1]);
        return Math.hypot(x - pin[0], y - pin[1]);
    };

    it('a pin on the drying beach: Auto routes to it, the beach red and named — never "stops at its edge"', async () => {
        beachScene();
        const pin: [number, number] = [ISLAND.x0 - 320, 0];
        const route = await auto([-5000, 0], pin);
        // Was: ended at the deep water ~200–300 m short, "the route stops at its edge".
        expect(endGapM(route.coordinates, pin)).toBeLessThan(2);
        expect(route.warnings).toContainEqual(
            expect.stringMatching(
                /^Red on this route: your destination pin is on a drying bank — the last 1[789]0 m to it dries 0\.4 m and you need 2\.9 m \(2\.4 m draft \+ 0\.5 m under the keel\); there is no tide data for it\. It dries at low water\.$/,
            ),
        );
        expect(route.warnings.some((w) => /stops at its edge|short of your destination pin/.test(w))).toBe(false);
        expect(Math.round(metresInside(route.coordinates, ISLAND)), 'metres on the island').toBe(0);
    });

    for (const ceilings of [[], ceilingsAt(2.5)]) {
        it(`a harbour pin behind 800 m of drying flats${ceilings.length ? ', a 2.5 m top' : ''}: routed across them, red and named — not "no route by water"`, async () => {
            harbourScene();
            h.ceilings = ceilings;
            const pin: [number, number] = [850, 0];
            const route = await auto([-5000, 0], pin);
            expect(endGapM(route.coordinates, pin)).toBeLessThan(2);
            expect(route.warnings).toContainEqual(
                expect.stringMatching(
                    /^Red on this route: the way in to your destination pin crosses (7[89]0|8[0-4]0) m of .+, which dries 1\.2 m, and you need 2\.9 m/,
                ),
            );
            for (const land of [
                { x0: 800, y0: -2000, x1: 3000, y1: -500 },
                { x0: 800, y0: 500, x1: 3000, y1: 2000 },
                { x0: 1300, y0: -500, x1: 3000, y1: 500 },
            ])
                expect(Math.round(metresInside(route.coordinates, land)), 'metres on land').toBe(0);
        });
    }

    it('the same harbour behind 800 m of charted land: still no route — it says why', async () => {
        harbourScene(true);
        await expect(auto([-5000, 0], [850, 0])).rejects.toThrow(/No route by water to your destination|charted land/);
    });
});
