/**
 * GOLDEN (fictional): a turn for depth that buys no tide is no turn (package
 * 125-06; Shane, 2026-10-08, an Auto route from Port of Airlie to Nara Inlet:
 * "no reason to go to port here??? why not go straight??? the depth is the
 * same, 4m which is well within our limits").
 *
 * Measured on the Pi's cells (scratch replay, strict, 2.4 m draft): out of
 * the marina's dredged channel (charted 1.8 m) the route dog-legged west at
 * the outer pair — 865 m north-west over a 2–5 m band charted 2.0 m, north up
 * a 3.6–5 m pocket of the 1:12,000 chart, then north-east into 5–10 m — where
 * straight on crosses 1,143 m of the same 2.0 m band, for 355 m more sailing.
 * Not a lead (none charted there), not a caution or restricted area (the
 * router reads none), not the string pull's doing and not a grid stair: A*
 * prices every cell of water charted under draft + UKC at the flat 40× caution
 * cost, so it minimised metres over the 2.0 m band; the pull then held the
 * chord to "never more of that water than the run" and "no colour spreads".
 * With a 1.4 m draft (that band clears the keel) the same route ran straight
 * out of the channel. But the turn needs the same tide as the straight line —
 * its own water is charted no deeper at its shallowest (2.0 m), and the
 * channel just behind it (1.8 m) sets the tide for both — so it buys nothing.
 *
 * The rule (engine/stringPull sameTideNoWorse; DECIDED 2026-10-09 on Shane's
 * words): after the pull, a run whose own water is charted under the keel's
 * need is replaced by its chord where the chord is as safe in every way but
 * one — it may run longer over water charted under the need, at most twice as
 * far as the run does and at most a kilometre more, but never over water
 * shallower than the run's shallowest, never over drying ground, and nothing
 * else (no hazard, land, uncharted water, mark passed on its other side or
 * nearer, survey error, bank or band nearer) may grow. Where the straight
 * line would need MORE tide, or keep the boat over that water more than twice
 * as long, the turn stays and the route notes say why (depthBendOf).
 *
 * Synthetic charts in a local metric frame, run in both hemispheres: a 54 m
 * channel charted 1.8 m running north from a deep basin between four pairs,
 * 0–2 m flats either side, a 2–5 m band beyond its outer pair, a 3.6–5 m
 * pocket north-west, 5–10 m water from 1.1 km north, the pin 9.5 km NNE.
 * Need 2.9 m (2.4 m draft + 0.5 m UKC). Fictional: no real chart, place or
 * route.
 */
import type { Feature, FeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest, type RouteResult } from '../../services/inshoreRouterEngine';
import { buildNavGrid } from '../../services/engine/navGrid';
import {
    chartMarkPoints,
    lateralMarkGates,
    lineExposureReader,
    memoExposure,
    pathNoWorse,
    pullTaut,
    SAME_TIDE_MAX_RATIO,
    SAME_TIDE_REACH_M,
    sameTideNoWorse,
    straightenSameTide,
} from '../../services/engine/stringPull';
import type { InshoreLayers } from '../../services/engine/types';
import { pairWingFeatures } from '../../services/pairWings';
import { chartAreaIndexFor, chartedDepthAt } from '../../services/routing/leadLandClip';

type P = [number, number];
const KY = 111_320;

/** A local metric frame round (lat0, lon0): x m east, y m north. */
function frame(lat0: number, lon0: number) {
    const kx = KY * Math.cos((lat0 * Math.PI) / 180);
    const at = (x: number, y: number): P => [lon0 + x / kx, lat0 + y / KY];
    const metres = ([lon, lat]: readonly [number, number]): P => [(lon - lon0) * kx, (lat - lat0) * KY];
    return { at, metres };
}
/** A northern-hemisphere frame west of Greenwich and a southern one east of
 *  it — open ocean both, nothing charted there in reality. */
const FRAMES = [
    { name: 'north-west (35°N 45°W)', lat0: 35.0, lon0: -45.0 },
    { name: 'south-east (31°S 161°E)', lat0: -31.0, lon0: 161.0 },
] as const;

const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const HALF = 27;
const PAIRS = [0, -380, -760, -1140];
/** The 5–10 m band's southern edge. */
const DEEP_Y = 1100;
const FROM_XY: P = [0, -1700];
const TO_XY: P = [3000, 9000];

interface Scene {
    /** The 3.6–5 m pocket's box [x0, y0, x1, y1] (null: none). */
    pocket?: [number, number, number, number] | null;
    /** Where the 5–10 m band begins (default DEEP_Y). */
    deepY?: number;
    /** More depth areas (a shallower patch on the straight line). */
    extra?: [number, number, number, number, number, number][];
    /** Land beyond the outer pair (a headland), boxes [x0, y0, x1, y1]. */
    land?: [number, number, number, number][];
    /** The app's outboard wings at every pair (InshoreRouter step 4.5). */
    wings?: boolean;
}

function sceneIn(f: ReturnType<typeof frame>, scene: Scene = {}) {
    const { at } = f;
    const ring = (x0: number, y0: number, x1: number, y1: number): P[] => [
        at(x0, y0),
        at(x1, y0),
        at(x1, y1),
        at(x0, y1),
        at(x0, y0),
    ];
    const poly = (props: Record<string, unknown>, rings: P[][]): Feature => ({
        type: 'Feature',
        properties: props,
        geometry: { type: 'Polygon', coordinates: rings },
    });
    const band = (d1: number, d2: number, x0: number, y0: number, x1: number, y1: number, holes: P[][] = []) =>
        poly({ acronym: 'DEPARE', DRVAL1: d1, DRVAL2: d2 }, [ring(x0, y0, x1, y1), ...holes]);
    const beacon = (x: number, y: number, catlam: number): Feature => ({
        type: 'Feature',
        properties: { acronym: 'BCNLAT', CATLAM: catlam },
        geometry: { type: 'Point', coordinates: at(x, y) },
    });
    const deepY = scene.deepY ?? DEEP_Y;
    const pocket: [number, number, number, number] | null =
        scene.pocket === undefined ? [-1300, 620, -560, deepY] : scene.pocket;
    const land = scene.land ?? [];
    const holes = [
        ...(pocket ? [ring(...pocket)] : []),
        ...(scene.extra ?? []).map(([, , x0, y0, x1, y1]) => ring(x0, y0, x1, y1)),
    ];
    /** Each headland's part inside the box [y0, y1] of a band, as a hole. */
    const landIn = (y0: number, y1: number): P[][] =>
        land
            .map(([lx0, ly0, lx1, ly1]) => [lx0, Math.max(ly0, y0), lx1, Math.min(ly1, y1)] as const)
            .filter(([, a, , b]) => a < b)
            .map(([lx0, a, lx1, b]) => ring(lx0, a, lx1, b));
    const port = (y: number) => f.at(HALF, y);
    const stbd = (y: number) => f.at(-HALF, y);
    const wings = scene.wings
        ? PAIRS.flatMap((y) =>
              pairWingFeatures({ lon: port(y)[0], lat: port(y)[1] }, { lon: stbd(y)[0], lat: stbd(y)[1] }),
          )
        : [];
    return {
        ...(land.length > 0 ? { LNDARE: fc(...land.map((r) => poly({ acronym: 'LNDARE' }, [ring(...r)]))) } : {}),
        ...(wings.length > 0 ? { OBSTRN: fc(...(wings as unknown as Feature[])) } : {}),
        DEPARE: fc(
            band(5, 10, -9000, deepY, 9000, 12000, landIn(deepY, 12000)),
            // The 2–5 m band beyond the outer pair, round the pocket.
            band(2, 5, -9000, 15, 9000, deepY, [...holes, ...landIn(15, deepY)]),
            ...(pocket ? [band(3.6, 5, ...pocket)] : []),
            ...(scene.extra ?? []).map(([d1, d2, x0, y0, x1, y1]) => band(d1, d2, x0, y0, x1, y1)),
            band(2, 5, -9000, -300, -HALF, 15),
            band(1.8, 5, -HALF, -1500, HALF, 15),
            band(2, 5, HALF, -300, 9000, 15),
            band(0, 2, -9000, -1500, -HALF, -300),
            band(0, 2, HALF, -1500, 9000, -300),
            band(5, 10, -9000, -6000, 9000, -1500),
        ),
        DRGARE: fc(poly({ acronym: 'DRGARE', DRVAL1: 1.8 }, [ring(-HALF, -1500, HALF, 15)])),
        // The app's lateral-mark ribbon: 100 m either side of the pairs.
        FAIRWY: fc(poly({ _layer: 'FAIRWY', _class: 'synthetic-channel-segment' }, [ring(-100, -1140, 100, 0)])),
        BCNLAT: fc(...PAIRS.flatMap((y) => [beacon(-HALF, y, 2), beacon(HALF, y, 1)])),
    } as unknown as InshoreLayers;
}

function route(f: ReturnType<typeof frame>, layers: InshoreLayers, strict: boolean): RouteResult {
    const [fromLon, fromLat] = f.at(...FROM_XY);
    const [toLon, toLat] = f.at(...TO_XY);
    const req: RouteRequest = {
        fromLat,
        fromLon,
        toLat,
        toLon,
        draftM: 2.4,
        safetyM: 0.5,
        resolutionM: 50,
        obstructionBufferM: 60,
        ...(strict ? { unchartedPolicy: 'strict' as const } : {}),
    };
    const r = routeInshore(layers, req);
    if ('error' in r) throw new Error(`${r.code}: ${r.error}`);
    return r;
}

/** Perpendicular distance (m) of point p from the line a→b, all in metres. */
const offLine = (p: P, a: P, b: P): number => {
    const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
    return Math.abs((p[0] - a[0]) * dy - (p[1] - a[1]) * dx) / Math.hypot(dx, dy);
};
const lengthM = (line: readonly P[]): number =>
    line.slice(1).reduce((m, q, k) => m + Math.hypot(q[0] - line[k][0], q[1] - line[k][1]), 0);

/** The least charted depth along a line, every 5 m. */
function leastDepth(f: ReturnType<typeof frame>, layers: InshoreLayers, line: readonly P[]): number {
    const bands = chartAreaIndexFor(layers).depth;
    let least = Infinity;
    for (let i = 0; i + 1 < line.length; i++) {
        const [a, b] = [f.metres(line[i]), f.metres(line[i + 1])];
        const n = Math.max(1, Math.ceil(Math.hypot(b[0] - a[0], b[1] - a[1]) / 5));
        for (let k = 0; k <= n; k++) {
            const d = chartedDepthAt(bands, ...f.at(a[0] + ((b[0] - a[0]) * k) / n, a[1] + ((b[1] - a[1]) * k) / n));
            if (d !== null && d < least) least = d;
        }
    }
    return least;
}

/** The route's last vertex at the outer pair or just past it (where it
 *  leaves the channel), and the index of the next. */
function exitOf(line: readonly P[]): { from: P; next: number } {
    const next = line.findIndex(([, y]) => y > 200);
    return { from: line[next - 1], next };
}

describe.each(FRAMES)('GOLDEN (fictional): out of a channel into a uniform 2–5 m band, $name', ({ lat0, lon0 }) => {
    const f = frame(lat0, lon0);

    it.each([true, false])('runs straight on from the outer pair, not west to the pocket (strict %s)', (strict) => {
        const layers = sceneIn(f);
        const r = route(f, layers, strict);
        const line = r.polyline.map((p) => f.metres(p));
        // Measured against the straight line from where the route leaves the
        // channel to the pin. Before the fix: 918 m off it (south-east frame)
        // and 1,293 m (north-west), west at the pocket, strict and permissive.
        const { from, next } = exitOf(line);
        expect(next).toBeGreaterThan(0);
        expect(from[1]).toBeLessThanOrEqual(200);
        const worst = Math.max(...line.slice(next).map((p) => offLine(p, from, TO_XY)));
        expect(worst).toBeLessThanOrEqual(75);
        // Never into the pocket: nothing west of the channel's own wings.
        expect(Math.min(...line.slice(next).map(([x]) => x))).toBeGreaterThan(-150);
        // No longer than the straight line on, give a cell.
        expect(lengthM(line.slice(next - 1))).toBeLessThanOrEqual(
            Math.hypot(TO_XY[0] - from[0], TO_XY[1] - from[1]) + 50,
        );
        // The same tide as the turn: past the channel, never shallower than
        // the 2–5 m band's 2.0 m.
        expect(leastDepth(f, layers, r.polyline.slice(next - 1))).toBeGreaterThanOrEqual(2);
        // And no bend to explain.
        expect(r.depthBend).toBeUndefined();
        expect(r.debug?.sameTidePulled).toBeGreaterThan(0);
    });

    it.each([true, false])('rounds a headland from the outer pair, not west to the pocket (strict %s)', (strict) => {
        // Review, 2026-10-09: a chord from the pair to the pin crosses a
        // headland, so the turn the same-tide pull leaves slides to its
        // corner (on the Pi's cells, Pioneer Point). The pocket 0.3 km
        // past the pair, the band 0.9 km deep, the app's wings at every
        // pair. Before: 0.6 km west to the pocket, ~740 m longer than the
        // way round the corner from the pair (both frames, both policies).
        const CORNER: P = [500, 1600];
        const layers = sceneIn(f, {
            wings: true,
            pocket: [-1500, 300, -600, 900],
            deepY: 900,
            land: [[CORNER[0], 15, 4000, CORNER[1]]],
        });
        const line = route(f, layers, strict).polyline.map((p) => f.metres(p));
        const k = line.findIndex(([, y]) => y >= 0);
        const [a, b] = [line[k - 1], line[k]];
        const xAtPair = a[0] + ((b[0] - a[0]) * (0 - a[1])) / (b[1] - a[1] || 1);
        expect(Math.abs(xAtPair)).toBeLessThan(HALF);
        expect(Math.min(...line.slice(k).map(([x]) => x))).toBeGreaterThan(-150);
        const shortestM = Math.hypot(CORNER[0], CORNER[1]) + Math.hypot(TO_XY[0] - CORNER[0], TO_XY[1] - CORNER[1]);
        expect(lengthM([[xAtPair, 0], ...line.slice(k)])).toBeLessThanOrEqual(shortestM + 75);
        expect(line.every(([x, y]) => !(x > CORNER[0] && y > 15 && y < CORNER[1]))).toBe(true);
    });

    it('keeps a turn where the straight line needs more tide', () => {
        // A 1.0–2.0 m patch across the straight line, 300–700 m on: the route
        // still turns, to keep the boat off water needing 0.9 m MORE tide than
        // the band — now round the patch itself, not out to the pocket.
        const layers = sceneIn(f, { extra: [[1, 2, -100, 300, 700, 700]] });
        const r = route(f, layers, true);
        const line = r.polyline.map((p) => f.metres(p));
        const { from, next } = exitOf(line);
        // Not the straight line: it passes the patch to the west.
        expect(Math.max(...line.slice(next).map((p) => offLine(p, from, TO_XY)))).toBeGreaterThan(100);
        expect(line.slice(next).some(([x, y]) => x < -100 && y > 300)).toBe(true);
        // Never over the patch, nor the band's 2.0 m bettered by going over it.
        expect(leastDepth(f, layers, [f.at(...from), ...r.polyline.slice(next)])).toBeGreaterThanOrEqual(2);
    });

    it('keeps a turn where straight on is more than twice as long over that water', () => {
        // The pocket 0.3 km off, not 0.6: from where the route leaves the
        // channel it crosses ~420 m of the 2.0 m band to the pocket, where the
        // straight line on crosses ~1.1 km of it — 2.7 times. A real saving of
        // water under the keel's need: kept.
        const layers = sceneIn(f, { pocket: [-1300, 300, -300, DEEP_Y] });
        const r = route(f, layers, true);
        const line = r.polyline.map((p) => f.metres(p));
        const { next } = exitOf(line);
        expect(line.slice(next).some(([x, y]) => x < -250 && y > 250)).toBe(true);
    });
});

describe('the same-tide pull (engine/stringPull pullTaut sameTide)', () => {
    const f = frame(-31.0, 161.0);
    const { at } = f;
    /** The turn, hand drawn (metres): the outer pair's square-off, into the
     *  pocket, up it, into the 5–10 m band. Its chord crosses ~1,160 m of the
     *  2.0 m band where the turn crosses ~795 m (1.46 times, ~370 m more). */
    const BEND: P[] = [
        [0, 54],
        [-600, 660],
        [-640, 1060],
        [-560, 1200],
    ];
    /** The scene and the turn scaled `k` times about the outer pair. */
    const scaled = (k: number, scene: Scene = {}) => ({
        layers: sceneIn(f, { pocket: [-1300 * k, 620 * k, -560 * k, DEEP_Y * k], deepY: DEEP_Y * k, ...scene }),
        line: BEND.map(([x, y], i) => (i === 0 ? at(x, y) : at(x * k, y * k))),
    });
    const pullOn = (layers: InshoreLayers, line: P[], sameTide: boolean) => {
        const [w, s] = at(-6000, -3000);
        const [e, n] = at(3000, 6000);
        const grid = buildNavGrid(layers, [w, s, e, n], 50, 2.4, 0.5, 60);
        return pullTaut(line, {
            exposureOf: lineExposureReader({
                layers,
                grid,
                draftM: 2.4,
                safetyM: 0.5,
                obstructionBufferM: 60,
                strictUncharted: true,
            }),
            marks: chartMarkPoints(layers),
            corridorM: Math.SQRT2 * 50,
            sameTide,
        });
    };

    it('takes the chord across the same water the turn crosses, and only with the option', () => {
        const { layers, line } = scaled(1);
        expect(pullOn(layers, line, false).polyline).toEqual(line);
        const pulled = pullOn(layers, line, true);
        expect(pulled.polyline).toEqual([line[0], line[3]]);
        expect(pulled.fromSeg).toEqual([0]);
    });

    // A patch on the chord only (the turn passes ~140 m west of it).
    const ON_CHORD = [-240, 340, -100, 460] as const;

    it('never where the chord crosses shallower water than the turn', () => {
        const { layers, line } = scaled(1, { extra: [[1, 2, ...ON_CHORD]] });
        expect(pullOn(layers, line, true).polyline).toEqual(line);
    });

    it('never over ground that dries, even where the turn crosses it too', () => {
        // A drying patch at the start, under both the turn and the chord.
        const { layers, line } = scaled(1, { extra: [[-1, 0, -60, 60, 20, 140]] });
        expect(pullOn(layers, line, true).polyline).toEqual(line);
    });

    it('never past a mark on its other side', () => {
        // A beacon between the turn and its chord (the chord passes ~140 m
        // east of it, the turn ~150 m west).
        const { layers, line } = scaled(1);
        (layers as unknown as { BCNSPP: FeatureCollection }).BCNSPP = fc({
            type: 'Feature',
            properties: { acronym: 'BCNSPP' },
            geometry: { type: 'Point', coordinates: at(-460, 700) },
        });
        expect(pullOn(layers, line, true).polyline).toEqual(line);
    });

    it(`at most ${SAME_TIDE_MAX_RATIO} times as far over that water`, () => {
        // The pocket 0.3 km off: the turn crosses ~400 m of the 2.0 m band,
        // the chord ~1,070 m (2.7 times).
        const layers = sceneIn(f, { pocket: [-1300, 300, -300, DEEP_Y] });
        const line: P[] = [at(0, 54), at(-320, 330), at(-340, 1060), at(-240, 1200)];
        expect(pullOn(layers, line, true).polyline).toEqual(line);
    });

    it(`only over water within ${SAME_TIDE_REACH_M} m of where the turn's begins: the same tide`, () => {
        // The same turn 1.5 times the size: its chord into the 5–10 m band
        // leaves the 2.0 m band ~1.6 km on, taken. 2.2 times the size: ~2.4 km
        // on — the ratio still holds (1.46), but that water is crossed a
        // quarter of an hour after the turn's begins: kept (a shorter chord
        // into the pocket may be taken).
        const near = scaled(1.5);
        expect(pullOn(near.layers, near.line, true).polyline).toEqual([near.line[0], near.line[3]]);
        const far = scaled(2.2);
        const pulled = pullOn(far.layers, far.line, true).polyline.map((p) => f.metres(p));
        expect(pulled.length).toBeGreaterThan(2);
        expect(pulled.some(([x, y]) => x < -560 * 2.2 && y > 620 * 2.2)).toBe(true);
    });
});

/**
 * GOLDEN (fictional): the route leaves the channel one segment short of its
 * outer pair (review, 2026-10-09). On the Pi's cells a pin 50 m along the same
 * marina sent A* out of the channel through its side 147 m short of the outer
 * pair, the pair's green 100 m on the route's wrong side, and 724 m west to
 * the pocket. Every chord out of that turn passed the green nearer than the
 * turn did (one passed it at 1 m) or crossed the headland, so the same-tide
 * pull drew none; and the pair threaded alone ran its leg on further off the
 * fairway's ribbon than the turn, so the plain gates left it. The same-tide
 * stage now threads the pair, straightens the route from its centre and slides
 * the turn left to the headland's corner (engine/stringPull straightenSameTide).
 *
 * The bare engine's A* on these charts threads the outer pair (the app's
 * ribbon and wings decide where it leaves the channel), so the route is drawn
 * as A* drew it on the Pi's cells — the channel's follower to 150 m short of
 * the outer pair, out through the side 79 m past the green, west to the
 * pocket, up it, out — and handed to the stage the engine runs, over the
 * scene's own nav grid, in both hemispheres. A headland north-east of the
 * pair stands across the line from the pair to the pin. Bound: from the outer
 * pair to the pin, the route is at most 75 m longer than the shortest way
 * round the headland's corner, threads the pair between its marks, and never
 * goes west of the channel's wings.
 */
describe.each(FRAMES)('GOLDEN (fictional): out of the channel short of its outer pair, $name', ({ lat0, lon0 }) => {
    const f = frame(lat0, lon0);
    const { at } = f;
    /** The headland's corner nearest the route, and the pin beyond it: the
     *  leg on from the pocket passes the corner ~60 m off (as the leg on to
     *  Nara Inlet passed Pioneer Point's). */
    const CORNER: P = [400, 2500];
    const PIN: P = [4553, 9000];
    const layers = sceneIn(f, { wings: true, land: [[CORNER[0], 1300, 2000, CORNER[1]]] });
    const [w, s] = at(-6000, -3000);
    const [e, n] = at(4000, 10_000);
    const grid = buildNavGrid(layers, [w, s, e, n], 50, 2.4, 0.5, 60);
    const exposureOf = memoExposure(
        lineExposureReader({ layers, grid, draftM: 2.4, safetyM: 0.5, obstructionBufferM: 60, strictUncharted: true }),
    );
    /** As A* drew it: the follower, then the turn to the pocket and out. */
    const DRAWN: P[] = [[0, -1600], [0, -150], [-560, 640], [-600, 1060], [-520, 1200], PIN];
    const stage = (follower: 'channel' | 'channel and the leg on') => {
        const line = DRAWN.map(([x, y]) => at(x, y));
        // The follower's segment is a marked channel's (unpullable, its own
        // kind); with 'the leg on', so is the last leg (a tier-2 span to the
        // pin: Pi cells, from another marina pin, 2026-10-09).
        const followerSeg = (k: number) => k === 0 || (follower === 'channel and the leg on' && k === DRAWN.length - 2);
        return straightenSameTide(line, {
            pinnedOf: (pl) => pl.map((_, i) => i === 0 || i === pl.length - 1),
            pullable: line.slice(1).map((_, k) => !followerSeg(k)),
            runKey: line.slice(1).map((_, k) => (followerSeg(k) ? 'Y' : '')),
            exposureOf,
            marks: chartMarkPoints(layers),
            corridorM: Math.SQRT2 * 50,
            gates: lateralMarkGates(layers),
        });
    };
    const shortestM = Math.hypot(CORNER[0], CORNER[1]) + Math.hypot(PIN[0] - CORNER[0], PIN[1] - CORNER[1]);

    it.each(['channel', 'channel and the leg on'] as const)(
        'threads the outer pair and runs on to the headland, not west to the pocket (follower: %s)',
        (follower) => {
            const before = DRAWN;
            // As drawn: 79 m outside the green, 600 m west, ~460 m longer.
            const fromPairBefore = lengthM([[0, 0], ...before.slice(2)]);
            expect(fromPairBefore - shortestM).toBeGreaterThan(400);
            const r = stage(follower);
            const line = r.polyline.map((p) => f.metres(p));
            expect(r.threaded).toBeGreaterThan(0);
            // Through the outer pair, between its marks.
            const k = line.findIndex(([, y]) => y >= 0);
            const [a, b] = [line[k - 1], line[k]];
            const xAtPair = a[0] + ((b[0] - a[0]) * (0 - a[1])) / (b[1] - a[1] || 1);
            expect(Math.abs(xAtPair)).toBeLessThan(HALF);
            // Never west of the channel's wings.
            expect(Math.min(...line.map(([x]) => x))).toBeGreaterThan(-150);
            // From the pair, within 75 m of the shortest way round the corner.
            const fromPair = lengthM([[xAtPair, 0], ...line.slice(k)]);
            expect(fromPair).toBeLessThanOrEqual(shortestM + 75);
            // Round the headland, never over it.
            expect(line.every(([x, y]) => !(x > CORNER[0] && x < 2000 && y > 1300 && y < CORNER[1]))).toBe(true);
            // Past the channel, never shallower than the band's 2.0 m.
            const out = line.findIndex(([, y]) => y > 20);
            expect(leastDepth(f, layers, [at(xAtPair, 20), ...r.polyline.slice(out)])).toBeGreaterThanOrEqual(2);
        },
    );
});

/**
 * What the same tide does not change (review, 2026-10-09). A tide that carries
 * the boat over the run's 2.0 m carries it over the chord's — but it moves no
 * reef's edge and improves no survey. Fictional strips in a local metric
 * frame: a 2–5 m band (charted 2.0 m) round the start, so the run needs a
 * tide, then 5–10 m water. Need 2.9 m (2.4 m draft + 0.5 m UKC).
 */
describe.each(FRAMES)('sameTideNoWorse holds what tide does not move, $name', ({ lat0, lon0 }) => {
    const f = frame(lat0, lon0);
    const { at } = f;
    const rect = (x0: number, y0: number, x1: number, y1: number): P[] => [
        at(x0, y0),
        at(x1, y0),
        at(x1, y1),
        at(x0, y1),
        at(x0, y0),
    ];
    const area = (
        props: Record<string, unknown>,
        box: [number, number, number, number],
        holes: P[][] = [],
    ): Feature => ({
        type: 'Feature',
        properties: props,
        geometry: { type: 'Polygon', coordinates: [rect(...box), ...holes] },
    });
    const depare = (d1: number, d2: number, box: [number, number, number, number], holes: P[][] = []) =>
        area({ acronym: 'DEPARE', DRVAL1: d1, DRVAL2: d2 }, box, holes);
    /** The strip, the deep water (round the given patches) and the patches. */
    const chartWith = (patches: [number, number, [number, number, number, number]][], extra = {}) =>
        ({
            DEPARE: fc(
                depare(2, 5, [-3000, -500, 3000, 500]),
                depare(
                    5,
                    10,
                    [-3000, 500, 3000, 6000],
                    patches.map(([, , b]) => rect(...b)),
                ),
                ...patches.map(([d1, d2, b]) => depare(d1, d2, b)),
            ),
            ...extra,
        }) as unknown as InshoreLayers;
    const readerFor = (layers: InshoreLayers) => {
        const [w, s] = at(-3000, -1000);
        const [e, n] = at(3000, 6000);
        const grid = buildNavGrid(layers, [w, s, e, n], 50, 2.4, 0.5, 60);
        return lineExposureReader({
            layers,
            grid,
            draftM: 2.4,
            safetyM: 0.5,
            obstructionBufferM: 60,
            strictUncharted: true,
        });
    };
    const weigh = (layers: InshoreLayers, run: P[]) => {
        const read = readerFor(layers);
        const line = run.map(([x, y]) => at(x, y));
        const chord = read(line[0], line[line.length - 1]);
        const legs = line.slice(1).map((q, k) => read(line[k], q));
        return { plain: pathNoWorse([chord], legs), sameTide: sameTideNoWorse(chord, legs) };
    };

    it('never a chord nearer a drying reef the run kept away from, for passing another as near', () => {
        // The run turns 10 m off reef R1 (dries 1.0 m); its chord would pass
        // reef R2 (dries 0.5 m) 15 m off — inside a drying band's 30 m — where
        // the run kept ~575 m from it. Before the fix the run's pass by R1 let
        // the chord through: R1 is "as near and at least as shallow".
        const run: P[] = [
            [0, 0],
            [-600, 1500],
            [0, 3000],
        ];
        const R1: [number, number, [number, number, number, number]] = [-1, 0, [-700, 1450, -610, 1550]];
        const R2: [number, number, [number, number, number, number]] = [-0.5, 0, [15, 1400, 100, 1600]];
        expect(weigh(chartWith([R1, R2]), run)).toEqual({ plain: false, sameTide: false });
        // Without R2 the chord needs no more tide and is as safe: taken.
        expect(weigh(chartWith([R1]), run).sameTide).toBe(true);
    });

    it('never a chord over more poor survey than its run, however near the tide', () => {
        // CATZOC A1 everywhere but two patches of D: the run crosses ~690 m of
        // one, the chord ~900 m of the other, 2.05–2.95 km along — out of the
        // strip, beyond the reach. Before the fix a survey's grade could grow
        // as the water under the keel's need may (twice the run's).
        const run: P[] = [
            [0, 0],
            [-400, 2500],
            [0, 4000],
        ];
        const zone = (CATZOC: number, box: [number, number, number, number], holes: P[][] = []) =>
            area({ acronym: 'M_QUAL', CATZOC }, box, holes);
        const onRun: [number, number, number, number] = [-500, 2200, -300, 2900];
        const onChord: [number, number, number, number] = [-100, 2050, 100, 2950];
        const survey = (patches: [number, number, number, number][]) => ({
            M_QUAL: fc(
                zone(
                    1,
                    [-3000, -1000, 3000, 6000],
                    patches.map((b) => rect(...b)),
                ),
                ...patches.map((b) => zone(5, b)),
            ),
        });
        expect(weigh(chartWith([], survey([onRun, onChord])), run)).toEqual({ plain: false, sameTide: false });
        // With the poor survey on the run alone, the chord is taken.
        expect(weigh(chartWith([], survey([onRun])), run).sameTide).toBe(true);
    });
});
