/**
 * The router never refuses for dry or shallow water (package 125-05; Shane,
 * 2026-10-08: "tried to do a route from the newport canals to tangalooma, i
 * got some message about it being dry at both ends???? again, no one is going
 * to use it, if it is too tight. better we just have red at the "dry" zones,
 * rather than just shit caning the whole route").
 *
 * This supersedes the refuse-when-none part of owner decision 11
 * (2026-10-01): the deep way round is still preferred, but where there is
 * none the route goes through, the water no tide clears is drawn RED and each
 * stretch is named with its charted depth against draft + UKC
 * (RouteResult.dryRuns). No tide data is red 'no tide data', never a refusal.
 * 'Dry' is a charted drying area or water no tide clears — never land: the
 * hard-land and air-draft refusals stay.
 *
 * The synthetic chart is decision 11's own (tests/engine/noTideClears): two
 * 5–10 m basins split by a 300 m wall with a "Boat Passage" charted drying
 * −2.2..0, and (unless `noWayRound`) a 5–10 m channel 8.3 km north. Serene
 * Summer: 2.4 m draft, 0.5 m UKC — she needs 2.9 m.
 */
import type { Feature, FeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest, type RouteResult } from '../../services/inshoreRouterEngine';
import type { InshoreLayers, TideCeiling } from '../../services/engine/types';
import { auditUnvouchedHardLand } from '../../services/engine/safetyAudit';
import {
    inshoreRoutePieces,
    inshoreSegmentStates,
    routeTideDepths,
    type InshoreRoutePiece,
} from '../../components/map/inshoreRouteState';

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
const depare = (x0: number, y0: number, x1: number, y1: number, DRVAL1: number, DRVAL2?: number): Feature =>
    rect(x0, y0, x1, y1, { acronym: 'DEPARE', DRVAL1, ...(DRVAL2 === undefined ? {} : { DRVAL2 }) });
const land = (x0: number, y0: number, x1: number, y1: number): Feature => rect(x0, y0, x1, y1, { acronym: 'LNDARE' });

const WALL_W = 153.4;
const WALL_E = 153.403; // 300 m
const PASSAGE_S = -27.502;
const PASSAGE_N = -27.498;
const CHANNEL_S = -27.427;
const CHANNEL_N = -27.423;
/** Metres east at the chart's latitude, in degrees. */
const M_LON = 1 / (111_320 * Math.cos((27.5 * Math.PI) / 180));

/**
 * The east basin with a second obstruction (125-05 review fix-up,
 * 2026-10-09), whose bands never overlap (two unranked bands: the shallowest
 * wins, the deepest is what decision 11 proves by):
 *  • EAST_LAGOON — a land wall at 153.450–153.457 with a 700 m gap charted
 *    drying 1.2 m ("Lagoon Gap"), a 5–10 m harbour beyond it closed in by
 *    land: the only way to a pin in the harbour is across the gap;
 *  • EAST_POCKET — a 5–10 m pocket round (153.45, −27.5) ringed by ~300 m of
 *    ground drying 2.2 m ("Pocket Flats"): the only way to a pin in the
 *    pocket is across the ring.
 */
const LAGOON_W = 153.45;
const LAGOON_E = 153.457;
const EAST_LAGOON = {
    depare: [
        depare(WALL_E, -27.56, LAGOON_W, -27.42, 5, 10),
        depare(LAGOON_W, PASSAGE_S, LAGOON_E, PASSAGE_N, -1.2, 0),
        depare(LAGOON_E, -27.51, 153.5, -27.49, 5, 10),
    ],
    land: [
        land(LAGOON_W, -27.56, LAGOON_E, PASSAGE_S),
        land(LAGOON_W, PASSAGE_N, LAGOON_E, -27.42),
        land(LAGOON_E, -27.56, 153.5, -27.51),
        land(LAGOON_E, -27.49, 153.5, -27.42),
    ],
    seaare: [rect(LAGOON_W - 0.0005, PASSAGE_S, LAGOON_E + 0.0005, PASSAGE_N, { OBJNAM: 'Lagoon Gap' })],
};
const POCKET: [number, number, number, number] = [153.446, -27.504, 153.454, -27.496];
const RING: [number, number, number, number] = [153.443, -27.507, 153.457, -27.493];
const EAST_POCKET = {
    depare: [
        // The basin round the ring, in four pieces.
        depare(WALL_E, -27.56, RING[0], -27.42, 5, 10),
        depare(RING[2], -27.56, 153.5, -27.42, 5, 10),
        depare(RING[0], -27.56, RING[2], RING[1], 5, 10),
        depare(RING[0], RING[3], RING[2], -27.42, 5, 10),
        // The ring, drying 2.2 m, in four pieces, and the pocket inside it.
        depare(RING[0], RING[1], RING[2], POCKET[1], -2.2, 0),
        depare(RING[0], POCKET[3], RING[2], RING[3], -2.2, 0),
        depare(RING[0], POCKET[1], POCKET[0], POCKET[3], -2.2, 0),
        depare(POCKET[2], POCKET[1], RING[2], POCKET[3], -2.2, 0),
        depare(...POCKET, 5, 10),
    ],
    land: [] as Feature[],
    seaare: [rect(...RING, { OBJNAM: 'Pocket Flats' })],
};

/**
 * A pocket round (153.45, −27.5) in the east basin, `halfM` each way, charted
 * `pocket`, ringed `ringM` wide by ground charted `ring` and named `name`;
 * the basin round it in four pieces, so no two bands overlap.
 */
function eastRingedPocket(
    halfM: number,
    ringM: number,
    pocket: [number, number],
    ring: [number, number],
    name: string,
): { depare: Feature[]; land: Feature[]; seaare: Feature[] } {
    const [cx, cy] = [153.45, -27.5];
    const lat = (m: number) => m / 111_320;
    const lon = (m: number) => m * M_LON;
    const P = [cx - lon(halfM), cy - lat(halfM), cx + lon(halfM), cy + lat(halfM)];
    const R = [P[0] - lon(ringM), P[1] - lat(ringM), P[2] + lon(ringM), P[3] + lat(ringM)];
    return {
        depare: [
            depare(WALL_E, -27.56, R[0], -27.42, 5, 10),
            depare(R[2], -27.56, 153.5, -27.42, 5, 10),
            depare(R[0], -27.56, R[2], R[1], 5, 10),
            depare(R[0], R[3], R[2], -27.42, 5, 10),
            depare(R[0], R[1], R[2], P[1], ...ring),
            depare(R[0], P[3], R[2], R[3], ...ring),
            depare(R[0], P[1], P[0], P[3], ...ring),
            depare(P[2], P[1], R[2], P[3], ...ring),
            depare(P[0], P[1], P[2], P[3], ...pocket),
        ],
        land: [],
        seaare: [rect(R[0], R[1], R[2], R[3], { OBJNAM: name })],
    };
}
/** A 0.5–1 m shoal pocket ringed by 25 m of ground drying 0.5 m (the review's
 *  kept-tail probe, 2026-10-09): 1.2 km across, or 0.5 km (the control). */
const SHOAL_WIDE = eastRingedPocket(600, 25, [0.5, 1], [-0.5, 1], 'Kettle Bank');
const SHOAL_NARROW = eastRingedPocket(250, 25, [0.5, 1], [-0.5, 1], 'Kettle Bank');

/**
 * The basins, the wall and its openings. `passage`: the Boat Passage's band
 * (or, with `barM`, a 5–10 m passage with a bar that many metres across
 * charted `passage`, mid-wall); `noWayRound` leaves out the deep channel
 * north; `solidWall` leaves out the passage too (only land between the
 * basins); `lowBridgeOverPassage` puts a fixed bridge the mast cannot clear
 * across the passage. `east` reshapes the east basin round the destination
 * (EAST_LAGOON, EAST_POCKET). `variant` specks of land key each test's own
 * grid.
 */
function chart(
    passage: { d1: number; d2?: number },
    opts: {
        noWayRound?: boolean;
        solidWall?: boolean;
        barM?: number;
        lowBridgeOverPassage?: boolean;
        east?: 'lagoon' | 'pocket' | 'shoalWide' | 'shoalNarrow';
        variant?: number;
    } = {},
): InshoreLayers {
    const mid = (WALL_W + WALL_E) / 2;
    const passageBands = opts.solidWall
        ? []
        : opts.barM
          ? [
                depare(WALL_W, PASSAGE_S, mid - (opts.barM / 2) * M_LON, PASSAGE_N, 5, 10),
                depare(
                    mid - (opts.barM / 2) * M_LON,
                    PASSAGE_S,
                    mid + (opts.barM / 2) * M_LON,
                    PASSAGE_N,
                    passage.d1,
                    passage.d2,
                ),
                depare(mid + (opts.barM / 2) * M_LON, PASSAGE_S, WALL_E, PASSAGE_N, 5, 10),
            ]
          : [depare(WALL_W, PASSAGE_S, WALL_E, PASSAGE_N, passage.d1, passage.d2)];
    const wall = opts.solidWall
        ? [land(WALL_W, -27.56, WALL_E, -27.42)]
        : opts.noWayRound
          ? [land(WALL_W, -27.56, WALL_E, PASSAGE_S), land(WALL_W, PASSAGE_N, WALL_E, -27.42)]
          : [
                land(WALL_W, -27.56, WALL_E, PASSAGE_S),
                land(WALL_W, PASSAGE_N, WALL_E, CHANNEL_S),
                land(WALL_W, CHANNEL_N, WALL_E, -27.42),
            ];
    const specks = Array.from({ length: opts.variant ?? 0 }, (_, i) =>
        land(153.21 + i * 0.002, -27.35, 153.211 + i * 0.002, -27.349),
    );
    const east =
        opts.east === undefined
            ? null
            : { lagoon: EAST_LAGOON, pocket: EAST_POCKET, shoalWide: SHOAL_WIDE, shoalNarrow: SHOAL_NARROW }[opts.east];
    return {
        DEPARE: fc(
            depare(153.3, -27.56, WALL_W, -27.42, 5, 10),
            ...(east ? east.depare : [depare(WALL_E, -27.56, 153.5, -27.42, 5, 10)]),
            ...passageBands,
            ...(opts.noWayRound || opts.solidWall ? [] : [depare(WALL_W, CHANNEL_S, WALL_E, CHANNEL_N, 5, 10)]),
        ),
        LNDARE: fc(
            land(153.2, -27.42, 153.6, -27.3),
            land(153.2, -27.7, 153.6, -27.56),
            land(153.2, -27.56, 153.3, -27.42),
            land(153.5, -27.56, 153.6, -27.42),
            ...wall,
            ...(east?.land ?? []),
            ...specks,
        ),
        SEAARE: fc(
            rect(WALL_W - 0.001, PASSAGE_S, WALL_E + 0.001, PASSAGE_N, { OBJNAM: 'Boat Passage' }),
            ...(east?.seaare ?? []),
        ),
        ...(opts.lowBridgeOverPassage
            ? {
                  OBSTRN: fc(
                      rect(mid - 0.0004, PASSAGE_S - 0.002, mid + 0.0004, PASSAGE_N + 0.002, {
                          _class: 'low-clearance',
                          _name: 'test fixed bridge',
                          _clearanceM: 3.0,
                      }),
                  ),
              }
            : {}),
    };
}

/** One ceiling per 0.25° bucket over the chart, all `highestM`, 14 days. */
const ceilings = (highestM: number): TideCeiling[] => {
    const out: TideCeiling[] = [];
    for (let lat = -27.75; lat <= -27.25; lat += 0.25)
        for (let lon = 153.0; lon <= 153.75; lon += 0.25) out.push({ lat, lon, highestM, days: 14 });
    return out;
};

const REQ: RouteRequest = {
    fromLat: -27.5,
    fromLon: 153.35,
    toLat: -27.5,
    toLon: 153.45,
    draftM: 2.4,
    safetyM: 0.5,
    resolutionM: 50,
    unchartedPolicy: 'strict',
};
const isResult = (r: ReturnType<typeof routeInshore>): r is RouteResult => 'polyline' in r;

/** Does the route pass through the passage (any 10 m sample inside it)? */
function throughPassage(r: RouteResult): boolean {
    for (let i = 0; i + 1 < r.polyline.length; i++) {
        const [ax, ay] = r.polyline[i];
        const [bx, by] = r.polyline[i + 1];
        for (let k = 0; k <= 200; k++) {
            const x = ax + ((bx - ax) * k) / 200;
            const y = ay + ((by - ay) * k) / 200;
            if (x >= WALL_W && x <= WALL_E && y >= PASSAGE_S && y <= PASSAGE_N) return true;
        }
    }
    return false;
}

/** The drawn pieces as the planner draws them, with `highestM` the tide top
 *  (null: no tide data). */
function pieces(r: RouteResult, highestM: number | null): InshoreRoutePiece[] {
    const states = inshoreSegmentStates(r);
    expect(states, 'the safety masks arrive intact').not.toBeNull();
    return inshoreRoutePieces(r.polyline, states!, r.surveyRuns ?? [], r.chartedShallowSpans ?? [], {
        depthM: routeTideDepths(r),
        needM: 2.9,
        highestM,
    });
}

/** The drawn state of every 5 m sample inside a box (inset `insetM`). */
function statesInside(ps: readonly InshoreRoutePiece[], box: [number, number, number, number], insetM = 10) {
    const [x0, y0, x1, y1] = box;
    const ix = insetM * M_LON;
    const iy = insetM / 111_320;
    const out = new Set<string>();
    for (const p of ps) {
        for (let i = 0; i + 1 < p.coordinates.length; i++) {
            const [ax, ay] = p.coordinates[i];
            const [bx, by] = p.coordinates[i + 1];
            const n = Math.max(1, Math.ceil(Math.hypot((bx - ax) / M_LON, (by - ay) * 111_320) / 5));
            for (let k = 0; k <= n; k++) {
                const x = ax + ((bx - ax) * k) / n;
                const y = ay + ((by - ay) * k) / n;
                if (x > x0 + ix && x < x1 - ix && y > y0 + iy && y < y1 - iy) out.add(p.state);
            }
        }
    }
    return out;
}
const PASSAGE_BOX: [number, number, number, number] = [WALL_W, PASSAGE_S, WALL_E, PASSAGE_N];

describe('125-05 — no way round: a route through the dry water, red and named, never a refusal', () => {
    it('a 2.5 m top and only the drying Boat Passage: routed through it, the passage named and drawn red', () => {
        const layers = chart({ d1: -2.2, d2: 0 }, { noWayRound: true, variant: 40 });
        const r = routeInshore(layers, { ...REQ, tideCeilings: ceilings(2.5) });
        // Was 'no-tide-clears': "No route for 2.4 m draft: the only way
        // through crosses the Boat Passage, charted to dry 2.2 m; …".
        expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
        if (!isResult(r)) return;
        expect(throughPassage(r)).toBe(true);
        // Named: where, its charted depth, the tide and what the boat needs.
        expect(r.dryRuns).toHaveLength(1);
        const run = r.dryRuns![0];
        expect(run.place).toBe('the Boat Passage');
        expect(run.shallowestM).toBe(-2.2);
        expect(run.deepestM).toBe(0);
        expect(run.draftM).toBe(2.4);
        expect(run.needM).toBeCloseTo(2.9, 6);
        expect(run.tide).toEqual({ topM: 2.5, days: 14 });
        expect(run.lengthM).toBeGreaterThan(250);
        expect(run.lengthM).toBeLessThan(330);
        // Red over the passage — no tide clears it — with the tide in.
        expect([...statesInside(pieces(r, 2.5), PASSAGE_BOX)]).toEqual(['danger']);
        // Never across land.
        expect(auditUnvouchedHardLand(layers, r.polyline).maxRunM).toBe(0);
    });

    it('a 100 m bar across an otherwise deep passage, no way round: routed across the bar, the bar named', () => {
        const layers = chart({ d1: -2.2, d2: 0 }, { noWayRound: true, barM: 100, variant: 41 });
        const r = routeInshore(layers, { ...REQ, tideCeilings: ceilings(2.5) });
        expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
        if (!isResult(r)) return;
        expect(throughPassage(r)).toBe(true);
        expect(r.dryRuns?.length).toBe(1);
        expect(r.dryRuns![0].lengthM).toBeGreaterThan(60);
        expect(r.dryRuns![0].lengthM).toBeLessThan(140);
        const mid = (WALL_W + WALL_E) / 2;
        const bar: [number, number, number, number] = [mid - 50 * M_LON, PASSAGE_S, mid + 50 * M_LON, PASSAGE_N];
        expect([...statesInside(pieces(r, 2.5), bar)]).toEqual(['danger']);
    });

    it('a 30 m bar (however thin), no way round: routed across it, named', () => {
        const layers = chart({ d1: -2.2, d2: 0 }, { noWayRound: true, barM: 30, variant: 42 });
        const r = routeInshore(layers, { ...REQ, tideCeilings: ceilings(2.5) });
        expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
        if (!isResult(r)) return;
        expect(throughPassage(r)).toBe(true);
        expect(r.dryRuns?.length).toBe(1);
        expect(r.dryRuns![0].place).toBe('the Boat Passage');
    });

    it('a top that lifts only the charted 0 m end (3.0 m) is still red where it dries 2.2 m, and named', () => {
        // Decision 11's proof reads the band's DEEPEST value (0 + 3.0 ≥ 2.9:
        // not closed); the line is drawn — and named — by its SHALLOWEST
        // (−2.2 + 3.0 < 2.9: no tide clears that).
        const layers = chart({ d1: -2.2, d2: 0 }, { noWayRound: true, variant: 43 });
        const r = routeInshore(layers, { ...REQ, tideCeilings: ceilings(3.0) });
        expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
        if (!isResult(r)) return;
        expect(throughPassage(r)).toBe(true);
        expect(r.dryRuns?.map((d) => [d.place, d.shallowestM, d.tide?.topM])).toEqual([['the Boat Passage', -2.2, 3]]);
        expect([...statesInside(pieces(r, 3.0), PASSAGE_BOX)]).toEqual(['danger']);
    });

    it('a stretch a tide clears (0.5–1 m, 2.5 m top) is amber and not named: needs tide, not dry', () => {
        const layers = chart({ d1: 0.5, d2: 1 }, { noWayRound: true, variant: 49 });
        const r = routeInshore(layers, { ...REQ, tideCeilings: ceilings(2.5) });
        expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
        if (!isResult(r)) return;
        expect(throughPassage(r)).toBe(true);
        expect(r.dryRuns).toBeUndefined();
        expect([...statesInside(pieces(r, 2.5), PASSAGE_BOX)]).toEqual(['tide']);
    });

    it('no tide data: the drying passage is red "no tide data", named, never a refusal', () => {
        const layers = chart({ d1: -2.2, d2: 0 }, { noWayRound: true, variant: 44 });
        const r = routeInshore(layers, REQ);
        expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
        if (!isResult(r)) return;
        expect(throughPassage(r)).toBe(true);
        expect(r.dryRuns).toHaveLength(1);
        expect(r.dryRuns![0].tide).toBeNull();
        expect(r.dryRuns![0].shallowestM).toBe(-2.2);
        expect([...statesInside(pieces(r, null), PASSAGE_BOX)]).toEqual(['danger']);
    });
});

describe('125-05 — the deep way round is still preferred', () => {
    it('with the channel 8.3 km north and a 2.5 m top, the route goes round, over no dry water', () => {
        const layers = chart({ d1: -2.2, d2: 0 }, { variant: 45 });
        const r = routeInshore(layers, { ...REQ, tideCeilings: ceilings(2.5) });
        expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
        if (!isResult(r)) return;
        expect(throughPassage(r)).toBe(false);
        expect(Math.max(...r.polyline.map((p) => p[1]))).toBeGreaterThan(CHANNEL_S - 0.002);
        expect(r.dryRuns).toBeUndefined();
    });

    it('an all-deep route carries no dry stretch, tide or none', () => {
        const layers = chart({ d1: 5, d2: 10 }, { noWayRound: true, variant: 46 });
        for (const q of [REQ, { ...REQ, tideCeilings: ceilings(2.5) }]) {
            const r = routeInshore(layers, q);
            expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
            if (isResult(r)) expect(r.dryRuns).toBeUndefined();
        }
    });
});

/** Metres between two [lon, lat] points (flat, at the chart's latitude). */
const metres = (a: readonly number[], b: readonly number[]): number =>
    Math.hypot((a[0] - b[0]) / M_LON, (a[1] - b[1]) * 111_320);

describe('125-05 review fix-up — through only the water that has no way round', () => {
    // Two obstructions: the Boat Passage, with the deep channel 8.3 km north
    // round it, and one at the destination with no way round. The route goes
    // round by the channel and crosses only the second. The review
    // (2026-10-09) found the route built with no tide ceilings at all
    // returned instead — across the Boat Passage too, which the note then
    // named as water no tide clears.
    const roundByChannel = (r: RouteResult): boolean => Math.max(...r.polyline.map((p) => p[1])) > CHANNEL_S - 0.002;

    it('a harbour behind a drying gap — round by the channel, across the Lagoon Gap only', () => {
        // Strict, as the app routes. (Permissive has no hard-land audit, and
        // its localized relax zone round the cut-off pin crosses the lagoon's
        // land wall instead — today's behaviour, not this package's.)
        const layers = chart({ d1: -2.2, d2: 0 }, { east: 'lagoon', variant: 50 });
        const to: [number, number] = [153.48, -27.5];
        const r = routeInshore(layers, { ...REQ, toLon: to[0], toLat: to[1], tideCeilings: ceilings(2.5) });
        expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
        if (!isResult(r)) return;
        expect(throughPassage(r), 'the Boat Passage has a deep way round').toBe(false);
        expect(roundByChannel(r)).toBe(true);
        expect(r.dryRuns?.map((d) => [d.place, d.shallowestM])).toEqual([['Lagoon Gap', -1.2]]);
        expect(metres(r.polyline[r.polyline.length - 1], to)).toBeLessThan(100);
        expect(auditUnvouchedHardLand(layers, r.polyline).maxRunM).toBe(0);
    });

    for (const policy of ['strict', 'permissive'] as const) {
        it(`${policy}: a pin in a pocket ringed by drying flats — round by the channel, across the ring only`, () => {
            const layers = chart({ d1: -2.2, d2: 0 }, { east: 'pocket', variant: policy === 'strict' ? 51 : 52 });
            const r = routeInshore(layers, { ...REQ, unchartedPolicy: policy, tideCeilings: ceilings(2.5) });
            expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
            if (!isResult(r)) return;
            expect(throughPassage(r), 'the Boat Passage has a deep way round').toBe(false);
            expect(roundByChannel(r)).toBe(true);
            expect(r.dryRuns?.map((d) => d.place)).toEqual(['the Pocket Flats']);
            expect(metres(r.polyline[r.polyline.length - 1], [REQ.toLon, REQ.toLat])).toBeLessThan(100);
            expect(auditUnvouchedHardLand(layers, r.polyline).maxRunM).toBe(0);
        });
    }

    it('both obstructions with no way round: through both, both named', () => {
        const layers = chart({ d1: -2.2, d2: 0 }, { east: 'lagoon', noWayRound: true, variant: 53 });
        const r = routeInshore(layers, { ...REQ, toLon: 153.48, tideCeilings: ceilings(2.5) });
        expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
        if (!isResult(r)) return;
        expect(throughPassage(r)).toBe(true);
        expect(r.dryRuns?.map((d) => d.place)).toEqual(['the Boat Passage', 'Lagoon Gap']);
    });
});

describe('125-05 — a pin behind a drying ring keeps its charted tail, red', () => {
    // The pin lies in a 0.5–1 m shoal pocket (decision 7: a pin in charted
    // shallow water gets a route all the way to it), ringed by 25 m of ground
    // drying 0.5 m. The charted tail crosses the ring: only DRY water, so it
    // is held, not refused — and where today's endpoints would stop the route
    // more than 500 m short of the pin (Auto refuses that), the tail stands,
    // red, the ring named (review, 2026-10-09: no test reached this branch).
    const pin: [number, number] = [153.45, -27.5];

    for (const tide of [2.5, null] as const) {
        it(`a 1.2 km pocket, ${tide === null ? 'no tide data' : `a ${tide} m top`}: the route runs on to the pin across the ring, named`, () => {
            const layers = chart({ d1: -2.2, d2: 0 }, { east: 'shoalWide', variant: tide === null ? 54 : 55 });
            const r = routeInshore(layers, { ...REQ, ...(tide === null ? {} : { tideCeilings: ceilings(tide) }) });
            expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
            if (!isResult(r)) return;
            // Today's endpoints stopped ~900 m short (base 76911385).
            expect(metres(r.polyline[r.polyline.length - 1], pin)).toBeLessThan(30);
            expect(r.debug?.chartedEndDry).toBeTruthy();
            const ring = r.dryRuns?.find((d) => d.place === 'the Kettle Bank');
            expect(ring, JSON.stringify(r.dryRuns)).toBeDefined();
            expect(ring?.shallowestM).toBe(-0.5);
            expect(ring?.tide).toEqual(tide === null ? null : { topM: tide, days: 14 });
            // With a top, the Boat Passage is still gone round (no tide data
            // proves nothing: the short way, red 'no tide data', as before).
            if (tide !== null) expect(throughPassage(r)).toBe(false);
            expect(auditUnvouchedHardLand(layers, r.polyline).maxRunM).toBe(0);
        });
    }

    it("the control — a 0.5 km pocket: today's ending, within 500 m of the pin, still stands", () => {
        const layers = chart({ d1: -2.2, d2: 0 }, { east: 'shoalNarrow', variant: 56 });
        const r = routeInshore(layers, { ...REQ, tideCeilings: ceilings(2.5) });
        expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
        if (!isResult(r)) return;
        expect(r.debug?.chartedEndRejected).toBeTruthy();
        expect(r.debug?.chartedEndDry).toBeUndefined();
        const shortM = metres(r.polyline[r.polyline.length - 1], pin);
        expect(shortM).toBeGreaterThan(100);
        expect(shortM).toBeLessThan(500);
    });
});

describe('125-05 — the land and air-draft refusals stay', () => {
    it('a solid land wall between the basins: no route across it, tide or none', () => {
        const layers = chart({ d1: -2.2, d2: 0 }, { solidWall: true, variant: 47 });
        for (const q of [REQ, { ...REQ, tideCeilings: ceilings(2.5) }]) {
            const r = routeInshore(layers, q);
            if (isResult(r)) {
                // Whatever ships never crosses the wall.
                expect(auditUnvouchedHardLand(layers, r.polyline).maxRunM).toBe(0);
                expect(Math.max(...r.polyline.map((p) => p[0]))).toBeLessThan(WALL_W);
            } else {
                expect(r.code).not.toBe('no-tide-clears');
            }
        }
    });

    it('a fixed bridge the mast cannot clear across the only (drying) way: never under it', () => {
        const layers = chart({ d1: -2.2, d2: 0 }, { noWayRound: true, lowBridgeOverPassage: true, variant: 48 });
        for (const q of [REQ, { ...REQ, tideCeilings: ceilings(2.5) }]) {
            const r = routeInshore(layers, q);
            if (isResult(r)) {
                // A route may ship on one side (both pins snapped there, up
                // to the bridge) — never one that passes it.
                const mid = (WALL_W + WALL_E) / 2;
                const lons = r.polyline.map((p) => p[0]);
                expect(Math.min(...lons) < mid && Math.max(...lons) > mid).toBe(false);
            } else {
                expect(r.code).not.toBe('no-tide-clears');
            }
        }
    });
});

describe('125-05 — a global app: a drying harbour in the Wadden Sea with no tide data (fictional)', () => {
    // A fictional harbour on the Dutch Wadden coast: the harbour basin and the
    // tidal channel outside are 4–8 m, joined only by a 400 m gully charted
    // drying 1.2 m ("Meerhaven Gat"). No tide curve loaded for the place.
    const W = 6.1;
    const E = 6.106; // ≈ 400 m at 53.45° N
    const S = 53.448;
    const N = 53.452;
    const layers: InshoreLayers = {
        DEPARE: fc(depare(6.0, 53.44, W, 53.46, 4, 8), depare(E, 53.44, 6.2, 53.46, 4, 8), depare(W, S, E, N, -1.2, 0)),
        LNDARE: fc(
            land(5.95, 53.46, 6.25, 53.5),
            land(5.95, 53.4, 6.25, 53.44),
            land(5.95, 53.44, 6.0, 53.46),
            land(6.2, 53.44, 6.25, 53.46),
            land(W, 53.44, E, S),
            land(W, N, E, 53.46),
        ),
        SEAARE: fc(rect(W - 0.0005, S, E + 0.0005, N, { OBJNAM: 'Meerhaven Gat' })),
    };
    const q: RouteRequest = {
        fromLat: 53.45,
        fromLon: 6.05,
        toLat: 53.45,
        toLon: 6.15,
        draftM: 2.4,
        safetyM: 0.5,
        resolutionM: 50,
        unchartedPolicy: 'strict',
    };

    it('routes through the gully, red, and names it with its depth, the need and no tide data', () => {
        const r = routeInshore(layers, q);
        expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
        if (!isResult(r)) return;
        expect(r.dryRuns).toHaveLength(1);
        const run = r.dryRuns![0];
        expect(run.place).toBe('Meerhaven Gat');
        expect(run.shallowestM).toBe(-1.2);
        expect(run.tide).toBeNull();
        expect(run.needM).toBeCloseTo(2.9, 6);
        // Its position is in the north and east.
        expect(run.mid[0]).toBeGreaterThan(W);
        expect(run.mid[1]).toBeGreaterThan(53);
        const states = statesInside(pieces(r, null), [W, S, E, N]);
        expect([...states]).toEqual(['danger']);
    });
});
