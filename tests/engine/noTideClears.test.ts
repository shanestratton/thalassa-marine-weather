/**
 * Owner decision 11 (Shane, 2026-10-01): "ok avoid water no tide can clear".
 *
 * The router must not route through water no tide can clear for this boat.
 * It takes the deep way round — Newport → Rivergate round Fisherman Islands,
 * not through the Boat Passage that dries 2.2 m — and where there is no way
 * round it draws no route and says why: the spot, its charted depth, the
 * highest tide and what the boat needs.
 *
 * PROOF, not suspicion: unclearable only when the band's DEEPEST value
 * (DRVAL2) plus the highest tide known there is still short of draft + UKC.
 * A 0–2 m band at a 2.5 m top stays routable (2 + 2.5 ≥ 2.9); a band with no
 * DRVAL2 proves nothing; a place with no tide ceiling proves nothing.
 *
 * The synthetic chart: two deep basins split by a thin wall of land with two
 * openings — a 300 m "Boat Passage" charted drying −2.2..0 at the pins'
 * latitude, and a 5–10 m channel 8.3 km north. Through the passage is the
 * cheaper way today (a drying cell costs 120×, the 16.6 km detour 5.6× a
 * metre), so without the tide the route crosses it, red. Serene Summer: 2.4 m draft,
 * 0.5 m UKC — she needs 2.9 m.
 *
 * RE-PIN (package 125-05, Shane 2026-10-08: "better we just have red at the
 * "dry" zones, rather than just shit caning the whole route"): where there is
 * no way round, the route now goes THROUGH, red, each stretch named
 * (RouteResult.dryRuns) — never 'no-tide-clears'. The refusal's own words are
 * kept on debug.noTideRefusal and pinned below as they were. The deep way
 * round is still taken wherever there is one (unchanged).
 */
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest, type RouteResult } from '../../services/inshoreRouterEngine';
import type { InshoreLayers, TideCeiling } from '../../services/engine/types';
import { buildNavGridCached, getCachedNavGrid, navGridCacheKey } from '../../services/engine/navGrid';
import {
    noTideClearsRuns,
    noTideRunPlace,
    quantiseCeilingM,
    tideBucketKey,
    tideCeilingLookup,
} from '../../services/engine/tideCeiling';
import { tideCurveBucket } from '../../services/TideHeightService';

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

// The wall between the basins, and its two openings.
const WALL_W = 153.4;
const WALL_E = 153.403; // 300 m
const PASSAGE_S = -27.502;
const PASSAGE_N = -27.498;
const CHANNEL_S = -27.427;
const CHANNEL_N = -27.423;
// A 0–0.3 m flat in the east basin (the pocket case).
const POCKET: [number, number, number, number] = [153.46, -27.52, 153.48, -27.5];

// A thin bar (2026-10-01): the passage charted 5–10 m but for a 100 m
// (two-cell) drying bar across it, mid-wall. The default grid can leave a
// proved bar that thin open (a band a tide clears touches its cells), so A*
// may take it; the finished route is then held to the chart itself.
const BAR_W = 153.401;
const BAR_E = 153.402;

/** Metres east at the chart's latitude, in degrees. */
const M_LON = 1 / (111_320 * Math.cos((27.5 * Math.PI) / 180));

/** The passage's bands: all `passage`, or 5–10 m with bars charted `passage`. */
function passageBands(
    passage: { d1: number; d2?: number },
    opts: { thinBar?: boolean; barM?: number; twoBarsM?: number },
): Feature[] {
    const mid = (WALL_W + WALL_E) / 2;
    const bars: [number, number][] = opts.thinBar
        ? [[BAR_W, BAR_E]]
        : opts.barM
          ? [[mid - (opts.barM / 2) * M_LON, mid + (opts.barM / 2) * M_LON]]
          : opts.twoBarsM
            ? [
                  [mid - (75 + opts.twoBarsM) * M_LON, mid - 75 * M_LON],
                  [mid + 75 * M_LON, mid + (75 + opts.twoBarsM) * M_LON],
              ]
            : [];
    if (bars.length === 0) return [depare(WALL_W, PASSAGE_S, WALL_E, PASSAGE_N, passage.d1, passage.d2)];
    const out: Feature[] = [];
    let west = WALL_W;
    for (const [w, e] of bars) {
        out.push(
            depare(west, PASSAGE_S, w, PASSAGE_N, 5, 10),
            depare(w, PASSAGE_S, e, PASSAGE_N, passage.d1, passage.d2),
        );
        west = e;
    }
    out.push(depare(west, PASSAGE_S, WALL_E, PASSAGE_N, 5, 10));
    return out;
}

/** Two basins charted 5–10 m, the passage charted `passage` (DRVAL1, DRVAL2) —
 *  or, with `thinBar`, 5–10 m with a 100 m bar charted `passage` across it —
 *  and, unless `noWayRound`, a 5–10 m channel 8.3 km north. Land all round.
 *  `variant` adds that many specks of land inside the northern land, so each
 *  test's layers key their own grid (the grid cache keys on feature counts). */
function chart(
    passage: { d1: number; d2?: number },
    opts: {
        noWayRound?: boolean;
        pocket?: boolean;
        variant?: number;
        thinBar?: boolean;
        /** A bar this many metres across, mid-wall, in a 5–10 m passage. */
        barM?: number;
        /** Two bars this many metres across, 150 m apart, mid-wall. */
        twoBarsM?: number;
    } = {},
): InshoreLayers {
    const east: Feature = opts.pocket
        ? {
              type: 'Feature',
              properties: { acronym: 'DEPARE', DRVAL1: 5, DRVAL2: 10 },
              geometry: {
                  type: 'Polygon',
                  coordinates: [
                      [
                          [WALL_E, -27.56],
                          [153.5, -27.56],
                          [153.5, -27.42],
                          [WALL_E, -27.42],
                          [WALL_E, -27.56],
                      ],
                      [
                          [POCKET[0], POCKET[1]],
                          [POCKET[0], POCKET[3]],
                          [POCKET[2], POCKET[3]],
                          [POCKET[2], POCKET[1]],
                          [POCKET[0], POCKET[1]],
                      ],
                  ],
              },
          }
        : depare(WALL_E, -27.56, 153.5, -27.42, 5, 10);
    const DEPARE = fc(
        depare(153.3, -27.56, WALL_W, -27.42, 5, 10),
        east,
        ...passageBands(passage, opts),
        ...(opts.noWayRound ? [] : [depare(WALL_W, CHANNEL_S, WALL_E, CHANNEL_N, 5, 10)]),
        // Water that never dries but no tide clears for a 2.9 m need at a
        // 2.5 m top (0.3 + 2.5 < 2.9).
        ...(opts.pocket ? [depare(POCKET[0], POCKET[1], POCKET[2], POCKET[3], 0, 0.3)] : []),
    );
    const wall = opts.noWayRound
        ? [land(WALL_W, -27.56, WALL_E, PASSAGE_S), land(WALL_W, PASSAGE_N, WALL_E, -27.42)]
        : [
              land(WALL_W, -27.56, WALL_E, PASSAGE_S),
              land(WALL_W, PASSAGE_N, WALL_E, CHANNEL_S),
              land(WALL_W, CHANNEL_N, WALL_E, -27.42),
          ];
    const specks = Array.from({ length: opts.variant ?? 0 }, (_, i) =>
        land(153.21 + i * 0.01, -27.35, 153.215 + i * 0.01, -27.345),
    );
    return {
        DEPARE,
        LNDARE: fc(
            land(153.2, -27.42, 153.6, -27.3),
            land(153.2, -27.7, 153.6, -27.56),
            land(153.2, -27.56, 153.3, -27.42),
            land(153.5, -27.56, 153.6, -27.42),
            ...wall,
            ...specks,
        ),
        SEAARE: fc(rect(WALL_W - 0.001, PASSAGE_S, WALL_E + 0.001, PASSAGE_N, { OBJNAM: 'Boat Passage' })),
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

describe('decision 11 — water no tide can clear is avoided', () => {
    it('premise: without tide data the route takes the short way, through the drying passage', () => {
        const r = routeInshore(chart({ d1: -2.2, d2: 0 }), REQ);
        expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
        if (!isResult(r)) return;
        expect(throughPassage(r)).toBe(true);
    });

    it('with the highest tide 2.5 m the drying passage (0 + 2.5 < 2.9) is impassable: the route goes the deep way round', () => {
        const q = { ...REQ, tideCeilings: ceilings(2.5) };
        const r = routeInshore(chart({ d1: -2.2, d2: 0 }), q);
        expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
        if (!isResult(r)) return;
        expect(throughPassage(r)).toBe(false);
        // Round by the channel 8.3 km north.
        expect(Math.max(...r.polyline.map((p) => p[1]))).toBeGreaterThan(CHANNEL_S - 0.002);
        expect(r.distanceNM).toBeGreaterThan(7);
        // Nothing on it that no tide clears, by the chart itself.
        expect(
            noTideClearsRuns(chart({ d1: -2.2, d2: 0 }), r.polyline, tideCeilingLookup(q.tideCeilings), 2.9),
        ).toEqual([]);
        // Both pins are open water: reached, not snapped away.
        expect(r.debug?.originSnap?.snapDistanceM ?? 0).toBeLessThan(60);
        expect(r.debug?.destinationSnap?.snapDistanceM ?? 0).toBeLessThan(60);
        expect(r.debug?.noTideClearsCells ?? 0).toBeGreaterThan(0);
    });

    it('with no way round the route goes through, red and named — the refusal’s words kept for the log (125-05)', () => {
        const layers = chart({ d1: -2.2, d2: 0 }, { noWayRound: true });
        // Premise: today it routes through.
        const today = routeInshore(layers, REQ);
        expect(isResult(today) && throughPassage(today)).toBe(true);
        const r = routeInshore(layers, { ...REQ, tideCeilings: ceilings(2.5) });
        expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
        if (!isResult(r)) return;
        expect(throughPassage(r)).toBe(true);
        expect(r.dryRuns?.[0]?.place).toBe('the Boat Passage');
        expect(r.debug?.noTideRefusal).toBe(
            'No route for 2.4 m draft: the only way through crosses the Boat Passage, charted to dry 2.2 m; ' +
                'the highest tide in the next 14 days is 2.5 m and you need 2.9 m.',
        );
    });

    it('a higher tide that clears the passage lets the route through (0 + 3.0 ≥ 2.9)', () => {
        const r = routeInshore(chart({ d1: -2.2, d2: 0 }, { noWayRound: true, variant: 1 }), {
            ...REQ,
            tideCeilings: ceilings(3.0),
        });
        expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
        if (!isResult(r)) return;
        expect(throughPassage(r)).toBe(true);
    });

    it('a 0–2 m band (the Newport canal estate) is NOT blocked by its 0 m end: 2 + 2.5 ≥ 2.9', () => {
        const layers = chart({ d1: 0, d2: 2 }, { noWayRound: true, variant: 2 });
        const r = routeInshore(layers, { ...REQ, tideCeilings: ceilings(2.5) });
        expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
        if (!isResult(r)) return;
        expect(throughPassage(r)).toBe(true);
        expect(r.debug?.noTideClearsCells ?? 0).toBe(0);
    });

    it('a band with no DRVAL2 proves nothing: not blocked (decision 10 still draws it red)', () => {
        const layers = chart({ d1: -2.2 }, { noWayRound: true, variant: 3 });
        const r = routeInshore(layers, { ...REQ, tideCeilings: ceilings(2.5) });
        expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
        if (!isResult(r)) return;
        expect(throughPassage(r)).toBe(true);
        // Still red: caution over the passage.
        expect(r.cautionMask?.some(Boolean)).toBe(true);
    });

    it('a place with no tide ceiling proves nothing: the passage routes as before', () => {
        const layers = chart({ d1: -2.2, d2: 0 }, { noWayRound: true, variant: 4 });
        // A ceiling only for the west basin's bucket (lon 153.25), none where the passage is (153.5).
        const west: TideCeiling[] = [{ lat: -27.5, lon: 153.3, highestM: 2.5, days: 14 }];
        const r = routeInshore(layers, { ...REQ, tideCeilings: west });
        expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
        if (!isResult(r)) return;
        expect(throughPassage(r)).toBe(true);
    });

    // Package 125-05b (Shane, 2026-10-08: "better we just have red at the
    // "dry" zones, rather than just shit caning the whole route"): the route
    // runs on to the pin across the flat, red and named. It used to stop at
    // the flat's edge, 1 km short of the pin.
    it('a pin in water that never dries but no tide clears: the route runs on to it, red, the tail named', () => {
        const layers = chart({ d1: -2.2, d2: 0 }, { pocket: true });
        const q = { ...REQ, toLat: -27.51, toLon: 153.47, tideCeilings: ceilings(2.5) };
        const r = routeInshore(layers, q);
        expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
        if (!isResult(r)) return;
        expect(r.pinOffWater?.destination).toBe('no-tide');
        const [lon, lat] = r.polyline[r.polyline.length - 1];
        expect(Math.abs(lon - q.toLon) + Math.abs(lat - q.toLat)).toBeLessThan(1e-7);
        const tail = r.dryRuns?.find((d) => d.pin?.end === 'destination');
        expect(tail, JSON.stringify(r.dryRuns)).toBeDefined();
        expect(tail!.pin).toEqual({ end: 'destination', at: 'on' });
        expect(tail!.shallowestM).toBe(0);
        expect(tail!.deepestM).toBe(0.3);
        expect(tail!.tide).toEqual({ topM: 2.5, days: 14 });
        expect(tail!.lengthM).toBeGreaterThan(950);
        expect(tail!.lengthM).toBeLessThan(1200);
        // That water is crossed by the tail alone: inside the flat, to the pin.
        const runs = noTideClearsRuns(layers, r.polyline, tideCeilingLookup(q.tideCeilings), 2.9);
        expect(runs).toHaveLength(1);
        expect(runs[0].end[0]).toBeCloseTo(q.toLon, 6);
        expect(runs[0].start[0]).toBeGreaterThan(POCKET[0] - 1e-4);
    });
});

describe('decision 11 — a proved bar too thin for the grid to close (the retry)', () => {
    // The default grid can leave a bar one or two cells across open (a 50 m
    // cell is classed by its centre; a creek narrower than a cell must stay
    // open), and the final check against the chart used to let up to 150 m
    // of it through: the route crossed the 100 m bar, red. A crossing with
    // no local way round now refuses the attempt — and before that refusal
    // stands the engine routes again with the crossed band closed
    // (fix-up, 2026-10-01: every cell it touches, not every proved cell).
    it('premise: without tide data the route takes the passage, across the bar', () => {
        const r = routeInshore(chart({ d1: -2.2, d2: 0 }, { thinBar: true, variant: 6 }), REQ);
        expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
        if (!isResult(r)) return;
        expect(throughPassage(r)).toBe(true);
    });

    it('with a 2.5 m top the route goes the deep way round instead of across the 100 m bar', () => {
        const layers = chart({ d1: -2.2, d2: 0 }, { thinBar: true, variant: 7 });
        const q = { ...REQ, tideCeilings: ceilings(2.5) };
        const r = routeInshore(layers, q);
        expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
        if (!isResult(r)) return;
        expect(throughPassage(r)).toBe(false);
        expect(Math.max(...r.polyline.map((p) => p[1]))).toBeGreaterThan(CHANNEL_S - 0.002);
        // Not even a cell of it on the route, by the chart itself.
        const worst = noTideClearsRuns(layers, r.polyline, tideCeilingLookup(q.tideCeilings), 2.9)[0];
        expect(worst?.lengthM ?? 0).toBeLessThanOrEqual(50);
    });

    it('with no way round the bar is the only way through: the route crosses it, red and named (125-05)', () => {
        const layers = chart({ d1: -2.2, d2: 0 }, { thinBar: true, noWayRound: true, variant: 8 });
        const r = routeInshore(layers, { ...REQ, tideCeilings: ceilings(2.5) });
        expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
        if (!isResult(r)) return;
        expect(throughPassage(r)).toBe(true);
        expect(r.dryRuns?.length).toBe(1);
        expect(r.debug?.noTideRefusal).toBe(
            'No route for 2.4 m draft: the only way through crosses the Boat Passage, charted to dry 2.2 m; ' +
                'the highest tide in the next 14 days is 2.5 m and you need 2.9 m.',
        );
    });

    it('a 0–2 m bar is clearable (2 + 2.5 ≥ 2.9): the route crosses it, no retry', () => {
        const layers = chart({ d1: 0, d2: 2 }, { thinBar: true, noWayRound: true, variant: 9 });
        const r = routeInshore(layers, { ...REQ, tideCeilings: ceilings(2.5) });
        expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
        if (!isResult(r)) return;
        expect(throughPassage(r)).toBe(true);
    });
});

describe('decision 11 — a bar however thin is a crossing (fix-up, 2026-10-01)', () => {
    // The default grid leaves a bar thinner than about two cells open, and
    // the old final check let up to one grid cell of it through, measured
    // between its first and last proved samples — 30, 49 and 59 m bars were
    // routed straight over with no way round, 5.33 NM, as a success. Now a
    // stretch of such water with no local way round it (a 10 m raster round
    // it) is a crossing, whatever its width: refused, routed again with the
    // crossed band closed, and refused for good only where that finds no way.
    const refusal =
        'No route for 2.4 m draft: the only way through crosses the Boat Passage, charted to dry 2.2 m; ' +
        'the highest tide in the next 14 days is 2.5 m and you need 2.9 m.';
    for (const [i, barM] of [
        [0, 30],
        [1, 50],
    ] as const) {
        it(`no way round: a ${barM} m bar is the only way through — the route crosses it, red and named (125-05)`, () => {
            const layers = chart({ d1: -2.2, d2: 0 }, { barM, noWayRound: true, variant: 20 + i });
            // Premise: without the tide it routes across the bar.
            const today = routeInshore(layers, REQ);
            expect(isResult(today) && throughPassage(today)).toBe(true);
            const r = routeInshore(layers, { ...REQ, tideCeilings: ceilings(2.5) });
            expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
            if (!isResult(r)) return;
            expect(throughPassage(r)).toBe(true);
            expect(r.dryRuns?.[0]?.place).toBe('the Boat Passage');
            expect(r.debug?.noTideRefusal).toBe(refusal);
        });
    }

    it('a 40 m bar with the deep way round 8 km north: the route goes round, over none of it', () => {
        const layers = chart({ d1: -2.2, d2: 0 }, { barM: 40, variant: 22 });
        const q = { ...REQ, tideCeilings: ceilings(2.5) };
        const r = routeInshore(layers, q);
        expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
        if (!isResult(r)) return;
        expect(throughPassage(r)).toBe(false);
        expect(Math.max(...r.polyline.map((p) => p[1]))).toBeGreaterThan(CHANNEL_S - 0.002);
        expect(noTideClearsRuns(layers, r.polyline, tideCeilingLookup(q.tideCeilings), 2.9)).toEqual([]);
    });

    it('two 45 m bars 150 m apart: round them when there is a way, across them, red, when there is none', () => {
        const q = { ...REQ, tideCeilings: ceilings(2.5) };
        const round = routeInshore(chart({ d1: -2.2, d2: 0 }, { twoBarsM: 45, variant: 23 }), q);
        expect(isResult(round), 'error' in round ? round.error : '').toBe(true);
        if (isResult(round)) {
            expect(throughPassage(round)).toBe(false);
            expect(round.dryRuns).toBeUndefined();
        }
        const none = routeInshore(chart({ d1: -2.2, d2: 0 }, { twoBarsM: 45, noWayRound: true, variant: 24 }), q);
        expect(isResult(none), 'error' in none ? `${none.code}: ${none.error}` : '').toBe(true);
        if (!isResult(none)) return;
        expect(throughPassage(none)).toBe(true);
        expect(none.dryRuns?.length).toBeGreaterThan(0);
        expect(none.debug?.noTideRefusal).toMatch(/^No route for 2\.4 m draft/);
    });

    it('a long route’s coarser grid (120 m cells) does not widen what it may cross: a 100 m bar with no way round', () => {
        // MAX_ROUTE_CELLS coarsens a 30–50 NM route to 80–130 m cells; the
        // old tolerance was the cell, so a 100 m bar passed at 120 m.
        const layers = chart({ d1: -2.2, d2: 0 }, { thinBar: true, noWayRound: true, variant: 25 });
        const r = routeInshore(layers, { ...REQ, resolutionM: 120, tideCeilings: ceilings(2.5) });
        // Since 125-05 the crossing is routed, red — and still found: named.
        expect(isResult(r), 'error' in r ? `${r.code}: ${r.error}` : '').toBe(true);
        if (!isResult(r)) return;
        expect(r.debug?.noTideRefusal).toMatch(/^No route for 2\.4 m draft/);
        expect(r.dryRuns?.length).toBe(1);
    });
});

/** Metres north, in degrees. */
const M_LAT = 1 / 111_320;

/**
 * Two 5–10 m basins split by a 2 km flat charted drying −2.2..0, land north
 * and south of it; the only way through is a creek `widthM` across charted
 * `creek` — a dog-leg (east, north, east) or one straight diagonal.
 */
function creekChart(
    shape: 'dogleg' | 'diagonal',
    widthM: number,
    creek: { d1: number; d2: number },
    variant: number,
): InshoreLayers {
    const W = 153.4;
    const E = 153.42;
    const N = -27.48;
    const S = -27.52;
    let creekRing: [number, number][];
    let north: [number, number][];
    let south: [number, number][];
    if (shape === 'dogleg') {
        const hy = (widthM / 2) * M_LAT;
        const hx = (widthM / 2) * M_LON;
        const [y1, y2, xm] = [-27.5, -27.496, 153.41];
        creekRing = [
            [W, y1 - hy],
            [xm + hx, y1 - hy],
            [xm + hx, y2 - hy],
            [E, y2 - hy],
            [E, y2 + hy],
            [xm - hx, y2 + hy],
            [xm - hx, y1 + hy],
            [W, y1 + hy],
            [W, y1 - hy],
        ];
        north = [
            [W, y1 + hy],
            [xm - hx, y1 + hy],
            [xm - hx, y2 + hy],
            [E, y2 + hy],
            [E, N],
            [W, N],
            [W, y1 + hy],
        ];
        south = [
            [W, S],
            [E, S],
            [E, y2 - hy],
            [xm + hx, y2 - hy],
            [xm + hx, y1 - hy],
            [W, y1 - hy],
            [W, S],
        ];
    } else {
        const [ya, yb] = [-27.502, -27.494];
        const angle = Math.atan2((yb - ya) / M_LAT, (E - W) / M_LON);
        const hy = ((widthM / 2) * M_LAT) / Math.cos(angle);
        creekRing = [
            [W, ya - hy],
            [E, yb - hy],
            [E, yb + hy],
            [W, ya + hy],
            [W, ya - hy],
        ];
        north = [
            [W, ya + hy],
            [E, yb + hy],
            [E, N],
            [W, N],
            [W, ya + hy],
        ];
        south = [
            [W, S],
            [E, S],
            [E, yb - hy],
            [W, ya - hy],
            [W, S],
        ];
    }
    const poly = (ring: [number, number][], props: Record<string, unknown>): Feature => ({
        type: 'Feature',
        properties: props,
        geometry: { type: 'Polygon', coordinates: [ring] },
    });
    const specks = Array.from({ length: variant }, (_, i) =>
        land(153.21 + i * 0.002, -27.35, 153.211 + i * 0.002, -27.349),
    );
    return {
        DEPARE: fc(
            depare(153.3, S, W, N, 5, 10),
            depare(E, S, 153.5, N, 5, 10),
            poly(north, { acronym: 'DEPARE', DRVAL1: -2.2, DRVAL2: 0 }),
            poly(south, { acronym: 'DEPARE', DRVAL1: -2.2, DRVAL2: 0 }),
            poly(creekRing, { acronym: 'DEPARE', DRVAL1: creek.d1, DRVAL2: creek.d2 }),
        ),
        LNDARE: fc(
            land(153.2, N, 153.6, -27.3),
            land(153.2, -27.7, 153.6, S),
            land(153.2, S, 153.3, N),
            land(153.5, S, 153.6, N),
            ...specks,
        ),
        SEAARE: fc(rect(W, S, E, N, { OBJNAM: 'Drying Flats' })),
    };
}

describe('decision 11 — a creek narrower than a grid cell is a way through (fix-up, 2026-10-01)', () => {
    // No 50 m cell centre lands in a 30 m creek, so every cell along it was
    // proved and closed, and the route was refused for "the only way
    // through" the flats — false: a charted way through exists. A band a
    // tide clears that touches a proved cell now keeps it open, and the
    // stretches the 50 m geometry draws over the flats are redrawn along the
    // creek on a 10 m raster.
    const q = {
        ...REQ,
        toLat: -27.496,
        tideCeilings: ceilings(2.5),
    };
    for (const [i, shape, creek] of [
        [0, 'dogleg', { d1: 5, d2: 10 }],
        [1, 'diagonal', { d1: 0, d2: 2 }],
    ] as const) {
        it(`a 30 m ${shape} creek charted ${creek.d1}–${creek.d2} m: routed through it, over no more than a clip of the flats`, () => {
            const layers = creekChart(shape, 30, creek, 30 + i);
            const r = routeInshore(layers, q);
            expect(isResult(r), 'error' in r ? r.error : '').toBe(true);
            if (!isResult(r)) return;
            const runs = noTideClearsRuns(layers, r.polyline, tideCeilingLookup(q.tideCeilings), 2.9);
            for (const run of runs) expect(run.lengthM).toBeLessThanOrEqual(30);
            // Through the flats, not round them (there is no way round).
            expect(Math.min(...r.polyline.map((p) => p[0]))).toBeLessThan(153.4);
            expect(Math.max(...r.polyline.map((p) => p[0]))).toBeGreaterThan(153.42);
        });
    }
});

describe('decision 11 — the tide ceilings key the grid cache', () => {
    const layers = chart({ d1: -2.2, d2: 0 }, { variant: 5 });
    const bbox: [number, number, number, number] = [153.27, -27.58, 153.53, -27.42];
    it('the key changes with the ceiling, and a quantised-equal ceiling shares it', () => {
        const key = (c?: TideCeiling[]) => navGridCacheKey(layers, bbox, 50, 2.4, 0.5, 30, false, [], 'safest', c);
        expect(key(ceilings(2.5))).not.toBe(key());
        expect(key(ceilings(2.5))).not.toBe(key(ceilings(2.6)));
        // Rounded UP to 0.1 m: 2.51 reads as 2.6, never as 2.5.
        expect(key(ceilings(2.51))).toBe(key(ceilings(2.6)));
        expect(quantiseCeilingM(2.5)).toBe(2.5);
        expect(quantiseCeilingM(2.51)).toBe(2.6);
        // No ceilings is exactly today's key.
        expect(key([])).toBe(navGridCacheKey(layers, bbox, 50, 2.4, 0.5, 30, false, []));
        // The retry's grid (the crossed bands closed) is its own (fix-up,
        // 2026-10-01: keyed by the bands, not one flag).
        const bar = {
            geometry: depare(WALL_W, PASSAGE_S, WALL_E, PASSAGE_N, -2.2, 0).geometry as Polygon,
            deepestM: 0,
            rank: null,
        };
        const withBar = navGridCacheKey(layers, bbox, 50, 2.4, 0.5, 30, false, [], 'safest', ceilings(2.5), [bar]);
        expect(withBar).not.toBe(key(ceilings(2.5)));
        expect(navGridCacheKey(layers, bbox, 50, 2.4, 0.5, 30, false, [], 'safest', ceilings(2.5), [bar])).toBe(
            withBar,
        );
    });

    it('a grid built with ceilings is found only with the same ceilings', () => {
        buildNavGridCached(layers, bbox, 50, 2.4, 0.5, 30, false, [], 'safest', ceilings(2.5));
        expect(getCachedNavGrid(layers, bbox, 50, 2.4, 0.5, 30, false, [], ceilings(2.5))?.noTideClears).toBeTruthy();
        const other = getCachedNavGrid(layers, bbox, 50, 2.4, 0.5, 30, false, [], ceilings(3.0));
        expect(other?.noTideClears).toBeFalsy();
    });

    it('a refusal names the spot: a small sea area by name, a whole bay with its position', () => {
        const run = {
            lengthM: 110,
            start: [153.204, -27.4194] as [number, number],
            end: [153.205, -27.4194] as [number, number],
            mid: [153.2043, -27.4194] as [number, number],
            shallowestM: -0.6,
            deepestM: 0,
            highestM: 2.5,
            days: 14,
        };
        const bay = rect(152.9, -27.9, 153.5, -27.0, { OBJNAM: 'Moreton Bay' });
        const passage = rect(153.157, -27.4235, 153.1973, -27.3935, { OBJNAM: 'Boat Passage' });
        // The real-chart Wynnum check (2026-10-01): only the whole bay holds it.
        expect(noTideRunPlace({ SEAARE: fc(bay) }, run)).toBe('Moreton Bay near 27.419° S, 153.204° E');
        const inPassage = {
            ...run,
            start: [153.18, -27.41],
            end: [153.181, -27.41],
            mid: [153.18, -27.41],
        } as typeof run;
        expect(noTideRunPlace({ SEAARE: fc(bay, passage) }, inPassage)).toBe('the Boat Passage');
        expect(noTideRunPlace({}, run)).toBe('water near 27.419° S, 153.204° E');
    });

    it('the words say the curve’s own top; the proof reads it rounded up (fix-up, 2026-10-01)', () => {
        // "the highest tide … is 2.5 m" was printed for a curve that topped at
        // 2.41 m: the quantised ceiling stood in for the curve in the words.
        const at = tideCeilingLookup([{ lat: -27.5, lon: 153.5, highestM: 2.41, days: 14 }]).at(-27.5, 153.5);
        expect(at?.highestM).toBe(2.5);
        expect(at?.topM).toBe(2.41);
        const layers = chart({ d1: -2.2, d2: 0 }, { noWayRound: true, variant: 26 });
        const r = routeInshore(layers, {
            ...REQ,
            tideCeilings: ceilings(2.5).map((c) => ({ ...c, highestM: 2.41 })),
        });
        // Since 125-05 the route goes through; the words are kept, and the
        // dry stretch carries the curve's own top too.
        expect(isResult(r) ? r.debug?.noTideRefusal : `refused: ${r.error}`).toBe(
            'No route for 2.4 m draft: the only way through crosses the Boat Passage, charted to dry 2.2 m; ' +
                'the highest tide in the next 14 days is 2.4 m and you need 2.9 m.',
        );
        expect(isResult(r) ? r.dryRuns?.[0]?.tide?.topM : null).toBe(2.41);
    });

    it("the engine's bucket is the tide cache's bucket", () => {
        for (const [lat, lon] of [
            [-27.5, 153.35],
            [-27.126, 153.374],
            [-27.374, 153.126],
            [-19.26, 146.82],
            [35.12, -120.62],
        ])
            expect(tideBucketKey(lat, lon)).toBe(tideCurveBucket(lat, lon));
    });
});
