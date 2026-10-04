/**
 * A lateral gate the route passes OUTSIDE its marks is threaded through its
 * centre where that is at least as safe (Shane, 2026-10-04, an Auto route out
 * of Port of Airlie: leg 4→5 "charted awash at low tide — needs +2.9 m tide",
 * "wrong side of the green (starboard) mark — pass between the pair").
 *
 * Measured on the Pi's cells (2026-10-04): the marina's dredged channel is
 * 54 m wide, charted 1.8 m, between pairs of beacons 370 m apart, with 0.0 m
 * flats either side for its first 700 m and 2.0 m water beyond. The app lays
 * a 200 m synthetic FAIRWY ribbon along the pairs, and every ribbon cell is
 * priced as channel; the gate follower declined ('entry-land'), so the
 * smoothed A* chord stayed — straight from the channel's foot to the
 * ribbon's corner, over the flats outside green 3 and out past green 1 on
 * its wrong side. The span is a channel's (unpullable), and threadGateCentres
 * only threaded gates crossed BETWEEN their marks. Through the pairs it is
 * 31 m more of the same water under the keel's need, and the least depth
 * rises from 0.0 m to the channel's 1.8 m.
 *
 * The rule (engine/stringPull threadGateCentres; DECIDED 2026-10-04): a gate
 * whose line the route crosses beyond one of its marks, within MARK_WATCH_M
 * (150 m) of it, in a channel the route is using — it passes between the
 * marks of the channel's next pair (in line, within 1 km, red to the same
 * side) — is threaded through its centre: the vertex by it moved there, or
 * the centre added; failing that, square through the pair for a gate's width
 * before the turn. Only when the new path is at most twice the gate's width
 * longer (60 m at least) and at least as safe (pathNoWorse with the detour's
 * length): no state the old one never had, no shallower water, no water
 * nothing proves, no nearer a shallow band than the old came to one at least
 * as shallow, and no more of any exposure than the old had, save the detour's
 * own extra length (as its samples read it) over water only shallower —
 * charted fairway included. One measure trades on such a detour and is not
 * held on its own: a wing cell left for a shallow-band cell (the same
 * caution, between the marks). Every other mark keeps its side and its
 * distance, and the marks of a gate put right are passed no nearer than
 * before, than 25 m, or than the gate's centre does. A follower never draws a
 * line outside its own marks, so a channel's span and its seam are threaded
 * too. Measured on the Pi's cells: on Shane's pin the turn at the outer
 * pair's centre cut 30 m of its green's wing, and on the Port of Airlie →
 * Daydream and Whitehaven routes the leg on from it passed green 1 at 18 m;
 * squared through the pair, none, and 29 m.
 *
 * Synthetic charts in a local metric frame round (LON0, LAT0): a 54 m channel
 * charted 1.8 m running north from a deep basin, pairs every 380 m, green
 * (starboard) to the west; 0.0 m flats either side to 300 m short of the
 * outer pair, 2.0 m water beyond, a 3.6 m pocket to the north-west and 5–10 m
 * further north. Need 2.9 m (2.4 m draft + 0.5 m UKC).
 */
import type { Feature, FeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest, type RouteResult } from '../../services/inshoreRouterEngine';
import { buildNavGrid } from '../../services/engine/navGrid';
import {
    chartMarkPoints,
    lateralMarkGates,
    lineExposureReader,
    threadGateCentres,
    type MarkGate,
} from '../../services/engine/stringPull';
import type { InshoreLayers } from '../../services/engine/types';
import { pairWingFeatures } from '../../services/pairWings';
import { chartAreaIndexFor, chartedDepthAt } from '../../services/routing/leadLandClip';

const LAT0 = -21.6;
const LON0 = 150.4;
const KY = 111_320;
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
type P = [number, number];
/** [lon, lat] of a point `x` m east and `y` m north of (LON0, LAT0). */
const at = (x: number, y: number): P => [LON0 + x / KX, LAT0 + y / KY];
const metres = ([lon, lat]: readonly [number, number]): P => [(lon - LON0) * KX, (lat - LAT0) * KY];
const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const ring = (x0: number, y0: number, x1: number, y1: number): P[] => [
    at(x0, y0),
    at(x1, y0),
    at(x1, y1),
    at(x0, y1),
    at(x0, y0),
];
const area = (props: Record<string, unknown>, x0: number, y0: number, x1: number, y1: number): Feature => ({
    type: 'Feature',
    properties: props,
    geometry: { type: 'Polygon', coordinates: [ring(x0, y0, x1, y1)] },
});
const band = (d1: number, d2: number, ...box: [number, number, number, number]): Feature =>
    area({ acronym: 'DEPARE', DRVAL1: d1, DRVAL2: d2 }, ...box);
const beacon = (x: number, y: number, catlam: number): Feature => ({
    type: 'Feature',
    properties: { acronym: 'BCNLAT', CATLAM: catlam },
    geometry: { type: 'Point', coordinates: at(x, y) },
});

/** The channel's half width, and its pairs (the outer one at y = 0). */
const HALF = 27;
const PAIRS = [0, -380, -760, -1140];
/** The app's outboard wings for every pair (InshoreRouter Step 4.5). */
const wings = (): Feature[] =>
    PAIRS.flatMap((y) => {
        const [port, stbd] = [at(HALF, y), at(-HALF, y)];
        return pairWingFeatures({ lon: port[0], lat: port[1] }, { lon: stbd[0], lat: stbd[1] }) as unknown as Feature[];
    });
/** The chart; `extra` adds features to DEPARE (a patch on the way out). */
const chart = (extra: Feature[] = [], obstrn: Feature[] = []): InshoreLayers =>
    ({
        OBSTRN: fc(...obstrn),
        DEPARE: fc(
            band(5, 10, -6000, 1250, 6000, 6000),
            band(2, 5, -6000, 15, -1300, 1250),
            band(2, 5, -500, 15, 6000, 1250),
            band(2, 5, -1300, 15, -500, 450),
            band(3.6, 5, -1300, 450, -500, 1250),
            band(2, 5, -6000, -300, -HALF, 15),
            band(1.8, 5, -HALF, -1500, HALF, 15),
            band(2, 5, HALF, -300, 6000, 15),
            band(0, 2, -6000, -1500, -HALF, -300),
            band(0, 2, HALF, -1500, 6000, -300),
            band(5, 10, -6000, -6000, 6000, -1500),
            ...extra,
        ),
        DRGARE: fc(area({ acronym: 'DRGARE', DRVAL1: 1.8 }, -HALF, -1500, HALF, 15)),
        // The app's lateral-mark ribbon: 100 m either side of the pairs.
        FAIRWY: fc(area({ _layer: 'FAIRWY', _class: 'synthetic-channel-segment' }, -100, -1140, 100, 0)),
        BCNLAT: fc(...PAIRS.flatMap((y) => [beacon(-HALF, y, 2), beacon(HALF, y, 1)])),
    }) as unknown as InshoreLayers;

/** Where a→b crosses the gate's own segment, between its marks. */
const crossesGate = (a: P, b: P, g: MarkGate): boolean => {
    const [p, q] = [g.port, g.stbd];
    const d = (b[0] - a[0]) * (q[1] - p[1]) - (b[1] - a[1]) * (q[0] - p[0]);
    if (d === 0) return false;
    const t = ((p[0] - a[0]) * (q[1] - p[1]) - (p[1] - a[1]) * (q[0] - p[0])) / d;
    const u = ((p[0] - a[0]) * (b[1] - a[1]) - (p[1] - a[1]) * (b[0] - a[0])) / d;
    return t >= -1e-9 && t <= 1 + 1e-9 && u >= -1e-9 && u <= 1 + 1e-9;
};
const threadsGate = (line: readonly P[], g: MarkGate): boolean =>
    line.slice(1).some((b, i) => crossesGate(line[i], b, g));
/** The gate whose centre is `y` m north. */
const gateAt = (gates: readonly MarkGate[], y: number): MarkGate => {
    const g = gates.find((x) => Math.abs(metres(x.centre)[1] - y) < 1);
    if (!g) throw new Error(`no gate at y=${y}`);
    return g;
};
/** The least charted depth along a line, every 5 m. */
const leastDepth = (layers: InshoreLayers, line: readonly P[]): number => {
    const bands = chartAreaIndexFor(layers).depth;
    let least = Infinity;
    for (let i = 0; i + 1 < line.length; i++) {
        const [a, b] = [metres(line[i]), metres(line[i + 1])];
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5));
        for (let k = 0; k <= n; k++) {
            const d = chartedDepthAt(bands, ...at(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n));
            if (d !== null && d < least) least = d;
        }
    }
    return least;
};

/** How near a line passes a point (m). */
const clearOf = (line: readonly P[], p: P): number => {
    const [px, py] = metres(p);
    let best = Infinity;
    for (let i = 0; i + 1 < line.length; i++) {
        const [ax, ay] = metres(line[i]);
        const [bx, by] = metres(line[i + 1]);
        const [dx, dy] = [bx - ax, by - ay];
        const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
        best = Math.min(best, Math.hypot(px - ax - t * dx, py - ay - t * dy));
    }
    return best;
};
/** Deep water everywhere, and these marks ([x, y, CATLAM]). */
const deep = (...marks: [number, number, number][]): InshoreLayers =>
    ({
        DEPARE: fc(band(5, 10, -6000, -6000, 6000, 6000)),
        BCNLAT: fc(...marks.map(([x, y, c]) => beacon(x, y, c))),
    }) as unknown as InshoreLayers;

const thread = (layers: InshoreLayers, line: P[], pullable?: boolean[], runKey?: string[]) => {
    const [w, s] = at(-3000, -3000);
    const [e, n] = at(3000, 4000);
    const grid = buildNavGrid(layers, [w, s, e, n], 25, 2.4, 0.5, 60);
    const gates = lateralMarkGates(layers);
    return {
        gates,
        out: threadGateCentres(line, {
            gates,
            marks: chartMarkPoints(layers),
            corridorM: Math.SQRT2 * 25,
            pullable,
            runKey,
            exposureOf: lineExposureReader({
                layers,
                grid,
                draftM: 2.4,
                safetyM: 0.5,
                obstructionBufferM: 60,
                strictUncharted: false,
            }),
        }),
    };
};

describe('a gate passed outside its marks is threaded through its centre (Port of Airlie, 2026-10-04)', () => {
    it('the route out of the basin keeps between every pair to the outer one', () => {
        const [fromLon, fromLat] = at(0, -1700);
        const [toLon, toLat] = at(900, 2600);
        const req: RouteRequest = {
            fromLat,
            fromLon,
            toLat,
            toLon,
            draftM: 2.4,
            safetyM: 0.5,
            resolutionM: 25,
            obstructionBufferM: 60,
        };
        const layers = chart();
        const r = routeInshore(layers, req);
        if ('error' in r) throw new Error(`${r.code}: ${r.error}`);
        const line = (r as RouteResult).polyline;
        const gates = lateralMarkGates(layers);
        expect(gates).toHaveLength(4);
        // Measured before the fix: the channel span ran from its foot
        // straight to the ribbon's north-west corner — outside the greens of
        // the 760 m and 380 m pairs, over the 0.0 m flats, and out 82 m past
        // the outer green.
        for (const y of PAIRS) expect(threadsGate(line, gateAt(gates, y)), `pair at y=${y}`).toBe(true);
        expect(leastDepth(layers, line)).toBeGreaterThanOrEqual(1.8);
    });

    it('moves the turn short of the outer pair onto its centre, then squares through it', () => {
        // The field route's shape: up the channel, its follower stopping 82 m
        // short of the outer pair, then north-west outside the outer green.
        // Turned at the pair's centre, the leg north-west would pass the
        // green 18 m off (review, 2026-10-04: green 1 at 18 m on the real
        // poa-daydream route) — nearer than MARK_COMFORT_M and than the
        // centre itself passes it; through the pair square to its line for
        // a gate's width first, 29 m.
        const layers = chart();
        const line = [at(0, -1200), at(0, -82), at(-700, 645), at(-700, 1500)];
        const { gates, out } = thread(layers, line, [false, true, true], ['Y', '', '']);
        const outer = gateAt(gates, 0);
        expect(threadsGate(line, outer)).toBe(false);
        expect(out.threaded).toBe(1);
        expect(out.polyline).toHaveLength(5);
        expect(out.polyline[1]).toEqual(outer.centre);
        const [cx, cy] = metres(outer.centre);
        const [sx, sy] = metres(out.polyline[2]);
        expect(Math.abs(sx - cx)).toBeLessThan(0.5);
        expect(sy - cy).toBeCloseTo(outer.widthM, 0);
        expect(out.polyline.slice(3)).toEqual([line[2], line[3]]);
        for (const m of [outer.port, outer.stbd]) expect(clearOf(out.polyline, m)).toBeGreaterThanOrEqual(24.5);
        expect(out.onCentre).toEqual([false, true, true, false, false]);
        // The channel's leg stays the channel's.
        expect(out.fromSeg).toEqual([0, 1, 1, 2]);
    });

    it("threads a channel's span that passes the greens outside over the flats (Shane's pin)", () => {
        // The channel span from the foot to a turn west of the outer pair:
        // 7 m outside the 760 m green and 26 m outside the 380 m green, over
        // the 0.0 m flats; then north-west, 97 m outside the outer green.
        const layers = chart();
        const line = [at(5, -1500), at(-70, -60), at(-700, 645)];
        expect(leastDepth(layers, line)).toBe(0);
        const { gates, out } = thread(layers, line, [false, true], ['Y', '']);
        for (const y of [-760, -380, 0]) expect(threadsGate(line, gateAt(gates, y)), `before, y=${y}`).toBe(false);
        expect(out.threaded).toBeGreaterThanOrEqual(1);
        for (const y of PAIRS) expect(threadsGate(out.polyline, gateAt(gates, y)), `after, y=${y}`).toBe(true);
        expect(leastDepth(layers, out.polyline)).toBeGreaterThanOrEqual(1.8);
        expect(out.polyline[0]).toEqual(line[0]);
        expect(out.polyline[out.polyline.length - 1]).toEqual(line[2]);
    });

    it('squares through the pair where a turn at its centre would cut the green outboard (wings)', () => {
        // Shane's pin, past the 380 m pair: a turn 43 m west of the outer
        // green and 29 m short of its line, then north-west, crossing that
        // line 78 m outside the green — clear of its 60 m wing. Turned at the
        // pair's centre, the line would cut 20 m of the wing just past the
        // green; through the pair square to its line for a gate's width, none.
        // (Up the channel through the 380 m pair first: a route using it.)
        const layers = chart([], wings());
        const line = [at(0, -500), at(0, -200), at(-70, -29), at(-720, 517)];
        const { gates, out } = thread(layers, line, [false, false, true], ['Y', 'Y', '']);
        const outer = gateAt(gates, 0);
        expect(out.threaded).toBeGreaterThanOrEqual(1);
        expect(out.polyline).toHaveLength(5);
        expect(out.polyline.slice(0, 2)).toEqual(line.slice(0, 2));
        expect(out.polyline[2]).toEqual(outer.centre);
        const [cx, cy] = metres(outer.centre);
        const [sx, sy] = metres(out.polyline[3]);
        expect(Math.abs(sx - cx)).toBeLessThan(0.5);
        expect(sy - cy).toBeCloseTo(outer.widthM, 0);
        expect(out.polyline[4]).toEqual(line[3]);
        expect(threadsGate(line, outer)).toBe(false);
        expect(threadsGate(out.polyline, outer)).toBe(true);
    });

    it('not where the way through the pair is less safe: a drying patch past it keeps the line', () => {
        // A drying patch just north-west of the outer pair, on the line from
        // its centre to the turn and 38 m off the line outside: the way
        // through is shallower than the way outside.
        const layers = chart([band(-1, 0, -60, 20, -20, 60)]);
        const line = [at(0, -1200), at(0, -82), at(-700, 645), at(-700, 1500)];
        const { out } = thread(layers, line, [false, true, true], ['Y', '', '']);
        expect(out.threaded).toBe(0);
        expect(out.polyline).toEqual(line);
    });

    it('not where the way through the pair leaves a charted fairway the line kept to', () => {
        // The field route's shape, its leg north-west along the edge of a
        // charted (not the app's synthetic) fairway 40 m wide. Through the
        // pair, the line would leave that fairway for ~800 m — far more than
        // its own extra length: a fairway is held on a detour like any water
        // only shallower (review, 2026-10-04).
        const [p, q] = [
            [0, -82],
            [-700, 645],
        ];
        const len = Math.hypot(q[0] - p[0], q[1] - p[1]);
        // 40 m to the south-west of the leg.
        const [nx, ny] = [(-(q[1] - p[1]) / len) * 40, ((q[0] - p[0]) / len) * 40];
        const lane: Feature = {
            type: 'Feature',
            properties: { acronym: 'FAIRWY' },
            geometry: {
                type: 'Polygon',
                coordinates: [
                    [
                        at(p[0], p[1]),
                        at(q[0], q[1]),
                        at(q[0] + nx, q[1] + ny),
                        at(p[0] + nx, p[1] + ny),
                        at(p[0], p[1]),
                    ],
                ],
            },
        };
        const layers = chart();
        (layers as unknown as { FAIRWY: FeatureCollection }).FAIRWY.features.push(lane);
        const line = [at(0, -1200), at(0, -82), at(-700, 645), at(-700, 1500)];
        const { out } = thread(layers, line, [false, true, true], ['Y', '', '']);
        expect(out.threaded).toBe(0);
        expect(out.polyline).toEqual(line);
    });

    it('a route only crossing the channel near its outer pair is left alone', () => {
        // Across the channel between the outer two pairs, then on north-east
        // over the outer pair's line 140 m beyond its red: it never passes
        // between a pair of this channel, so it is not using it — threading
        // the outer pair would only add a zig-zag (review, 2026-10-04).
        const layers = chart();
        const line = [at(-500, -200), at(500, 100)];
        const { gates, out } = thread(layers, line);
        for (const y of PAIRS) expect(threadsGate(line, gateAt(gates, y))).toBe(false);
        expect(out.threaded).toBe(0);
        expect(out.polyline).toEqual(line);
    });

    it('a lone pair passed 100 m off in open water is left alone', () => {
        // No channel to use: one pair, in deep water, its green passed 100 m
        // outside (review, 2026-10-04: a 127 m V-shaped zig-zag).
        const layers = deep([27, 0, 1], [-27, 0, 2]);
        const line = [at(-200, -400), at(-54, 400)];
        const { out } = thread(layers, line);
        expect(out.threaded).toBe(0);
        expect(out.polyline).toEqual(line);
    });

    it("pairs a buoyage change makes of one side's marks are not one channel", () => {
        // A 280 m channel running east whose buoyage turns at x = 0: the red
        // and green either side of the turn on each bank pair as gates, but
        // red to opposite sides. A line across the channel through the north
        // bank's pair at its centre, then south-west, passes the south bank's
        // 61 m beyond its green: in line with the first, but not a channel
        // (review, 2026-10-04: a crossing dragged through two false gates).
        const layers = deep([-50, 140, 1], [50, 140, 2], [-50, -140, 2], [50, -140, 1]);
        const line = [at(0, 400), at(0, 100), at(-231, -400)];
        const { gates, out } = thread(layers, line);
        expect(gates).toHaveLength(2);
        expect(out.threaded).toBe(0);
        expect(out.polyline).toEqual(line);
    });

    it('a line well clear of the marks is left alone', () => {
        // 373 m west of the greens: past every pair's line, but nowhere near.
        const layers = chart();
        const line = [at(-400, -1300), at(-400, 600), at(-400, 1500)];
        const { out } = thread(layers, line);
        expect(out.threaded).toBe(0);
        expect(out.polyline).toEqual(line);
    });
});
