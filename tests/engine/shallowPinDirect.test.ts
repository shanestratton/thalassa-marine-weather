/**
 * A pin in shallow charted water goes DIRECT, amber (Shane, 2026-10-03: "A
 * start pin in very shallow water sends the route out to deep water and back,
 * instead of going direct with an amber warning. - fix that").
 *
 * Owner decision 7 gave a pin in charted water shallower than the keel needs
 * a 'needs tide' tail: the way through its own charted water to the cheapest
 * deep-enough water, walked cell by cell. When the route does not come back
 * past the pin (the no-out-and-back cut, 2026-10-01), that tail is the route's
 * whole start: two pins in one shallow bay went out to the deep water and back
 * (shallow to shallow), and a tail across open flats was the grid's 8-connected
 * staircase. Now the tail runs straight from the pin to the point on the route
 * that makes the route shortest — never longer than the charted way it
 * replaces, and never through land, a drying bank, water no chart covers or no
 * tide clears, a charted hazard's keep-out or a low structure. Where no
 * straight line passes, the charted way stays and the route says why. Both
 * ends.
 *
 * Synthetic charts in a local metric frame round (LON0, LAT0); need 2.9 m
 * (2.4 m draft + 0.5 m UKC); the flats are charted 1.2–2 m, never drying.
 */
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { routeInshore, type RouteRequest, type RouteResult } from '../../services/inshoreRouterEngine';
import { haversineM } from '../../services/engine/geometry';
import { hazardBufferSegments } from '../../services/engine/safetyAudit';
import type { InshoreLayers } from '../../services/engine/types';
import { revisits } from '../helpers/routeRevisits';
import { tracerContextFromLayers, validateTraceLeg } from '../../services/routeTracer';
import { inshoreRouteCaveats } from '../../components/map/inshoreRouteNotice';

const LAT0 = -27.47;
const LON0 = 153.3;
const KY = 111_320;
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
/** [lon, lat] of a point `x` m east and `y` m north of (LON0, LAT0). */
const at = (x: number, y: number): [number, number] => [LON0 + x / KX, LAT0 + y / KY];
const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const poly = (pts: [number, number][], props: Record<string, unknown>): Feature => ({
    type: 'Feature',
    properties: props,
    geometry: { type: 'Polygon', coordinates: [[...pts.map(([x, y]) => at(x, y)), at(pts[0][0], pts[0][1])]] },
});
const box = (x0: number, y0: number, x1: number, y1: number, props: Record<string, unknown>): Feature =>
    poly(
        [
            [x0, y0],
            [x1, y0],
            [x1, y1],
            [x0, y1],
        ],
        props,
    );
const flats = (pts: [number, number][]) => poly(pts, { acronym: 'DEPARE', DRVAL1: 1.2, DRVAL2: 2 });
const deepWater = (pts: [number, number][]) => poly(pts, { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 20 });
const land = (x0: number, y0: number, x1: number, y1: number) => box(x0, y0, x1, y1, { acronym: 'LNDARE' });
const NEED_M = 2.9;
const req = (from: [number, number], to: [number, number]): RouteRequest => {
    const [fromLon, fromLat] = at(...from);
    const [toLon, toLat] = at(...to);
    return { fromLat, fromLon, toLat, toLon, draftM: 2.4, safetyM: 0.5, resolutionM: 50 };
};
const ok = (r: ReturnType<typeof routeInshore>): RouteResult => {
    if ('error' in r) throw new Error(`${r.code}: ${r.error}`);
    return r;
};
const lengthM = (p: readonly [number, number][]): number =>
    p.slice(1).reduce((m, q, i) => m + haversineM(p[i][1], p[i][0], q[1], q[0]), 0);
const metres = ([lon, lat]: readonly [number, number]): [number, number] => [(lon - LON0) * KX, (lat - LAT0) * KY];

/** A shallow bay (x -3000…3000, y -1500…1500) with deep water east of it, land round both. */
const bay = (): InshoreLayers =>
    ({
        DEPARE: fc(
            flats([
                [-3000, -1500],
                [3000, -1500],
                [3000, 1500],
                [-3000, 1500],
            ]),
            deepWater([
                [3000, -1500],
                [6000, -1500],
                [6000, 1500],
                [3000, 1500],
            ]),
        ),
        LNDARE: fc(
            land(-5000, -4000, 8000, -1500),
            land(-5000, 1500, 8000, 4000),
            land(-5000, -1500, -3000, 1500),
            land(6000, -1500, 8000, 1500),
        ),
    }) as InshoreLayers;

describe('shallow to shallow: two pins in one shallow bay', () => {
    it('goes straight across the bay, amber, never out to the deep water and back', () => {
        const q = req([-1000, 0], [0, 500]);
        const r = ok(routeInshore(bay(), q));
        const directM = haversineM(q.fromLat, q.fromLon, q.toLat, q.toLon);
        expect(r.polyline[0]).toEqual([q.fromLon, q.fromLat]);
        expect(r.polyline[r.polyline.length - 1]).toEqual([q.toLon, q.toLat]);
        expect(lengthM(r.polyline)).toBeLessThan(1.02 * directM);
        expect(revisits(r.polyline)).toBe(false);
        // Never east of the flats.
        expect(Math.max(...r.polyline.map((p) => metres(p)[0]))).toBeLessThan(3000);
        // All of it is the pins' own needs-tide water: caution, with its run.
        expect(r.cautionMask?.every(Boolean)).toBe(true);
        expect(r.shallowRuns?.some((s) => s.endpointTail)).toBe(true);
        expect(r.shallowRuns?.find((s) => s.endpointTail)?.minDepthM).toBe(1.2);
        expect(r.debug?.directTail?.origin ?? r.debug?.directTail?.destination).toBeDefined();
    });
});

/** Flats south-west of a diagonal edge y = x / 2 + 800; deep water north-east of it. */
const diagonal = (): InshoreLayers =>
    ({
        DEPARE: fc(
            flats([
                [-4000, -4000],
                [4000, -4000],
                [4000, 2800],
                [-4000, -1200],
            ]),
            deepWater([
                [-4000, -1200],
                [4000, 2800],
                [4000, 6000],
                [-4000, 6000],
            ]),
        ),
        LNDARE: fc(
            land(-6000, -6000, 6000, -4000),
            land(-6000, -4000, -4000, 6000),
            land(4000, -4000, 6000, 6000),
            land(-6000, 6000, 6000, 8000),
        ),
    }) as InshoreLayers;

describe('a departure on open flats', () => {
    // The pin is 715 m (perpendicular) from the deep water; the grid's way
    // there was a 779 m staircase (N, then NW at 45°). The direct line may be
    // no longer than that way plus two cells, so it cannot cross the 1.27 km of
    // flats straight toward the destination — it leaves the flats as directly
    // as that allows, toward where it joins the route.
    const PERP_M = 800 / Math.hypot(1, 0.5);
    const foot: [number, number] = [-PERP_M * Math.sin(Math.atan(0.5)), PERP_M * Math.cos(Math.atan(0.5))];
    const viaFootM = (to: [number, number]): number => PERP_M + Math.hypot(to[0] - foot[0], to[1] - foot[1]);
    /** The deep water's edge is y = x / 2 + 800. */
    const onEdge = (p: readonly [number, number]): number => {
        const [x, y] = metres(p);
        return y - (x / 2 + 800);
    };

    it('leaves in one straight line to the deep water, not the grid’s staircase', () => {
        const q = req([0, 0], [2500, 4500]);
        const r = ok(routeInshore(diagonal(), q));
        expect(r.polyline[0]).toEqual([q.fromLon, q.fromLat]);
        // The tail — the stretch before the line first reaches deep water — is
        // one straight segment, ending where the deep water starts.
        const tail = r.shallowRuns?.find((s) => s.endpointTail === 'origin');
        expect(tail).toBeDefined();
        expect(tail!.endSeg).toBe(0);
        expect(r.cautionMask?.[0]).toBe(true);
        expect(r.cautionMask?.slice(1)).not.toContain(true);
        expect(Math.abs(onEdge(r.polyline[1]))).toBeLessThan(40);
        expect(tail!.lengthM).toBeLessThan(1.1 * PERP_M);
        // No longer than the nearest deep water and on from there.
        expect(lengthM(r.polyline)).toBeLessThan(1.02 * viaFootM([2500, 4500]));
        expect(r.debug?.directTail?.origin).toBeDefined();
        expect(revisits(r.polyline)).toBe(false);
    });

    it('symmetrically, an arrival on the flats comes in one straight line', () => {
        const q = req([2500, 4500], [0, 0]);
        const r = ok(routeInshore(diagonal(), q));
        expect(r.polyline[r.polyline.length - 1]).toEqual([q.toLon, q.toLat]);
        const tail = r.shallowRuns?.find((s) => s.endpointTail === 'destination');
        expect(tail).toBeDefined();
        expect(tail!.startSeg).toBe(r.polyline.length - 2);
        expect(Math.abs(onEdge(r.polyline[r.polyline.length - 2]))).toBeLessThan(40);
        expect(tail!.lengthM).toBeLessThan(1.1 * PERP_M);
        expect(lengthM(r.polyline)).toBeLessThan(1.02 * viaFootM([2500, 4500]));
        expect(r.debug?.directTail?.destination).toBeDefined();
    });

    it('never through a charted hazard’s keep-out: a rock on the direct line is passed outside its buffer', () => {
        // An unknown-depth rock 20 m off the straight line from the pin toward the destination.
        const rock: Feature = {
            type: 'Feature',
            properties: { acronym: 'UWTROC', WATLEV: 3 },
            geometry: { type: 'Point', coordinates: at(250 + 20, 450 - 11) },
        };
        const layers = { ...diagonal(), UWTROC: fc(rock) } as InshoreLayers;
        const r = ok(routeInshore(layers, req([0, 0], [2500, 4500])));
        const tailSegs = (r.shallowRuns?.find((s) => s.endpointTail === 'origin')?.endSeg ?? 0) + 1;
        const near = hazardBufferSegments(r.polyline, layers, 30, NEED_M);
        expect(near.slice(0, tailSegs)).not.toContain(true);
    });
});

/** A 0–2 m channel 200 m wide running north from the pin, then east to deep water; land everywhere else. */
const dogleg = (): InshoreLayers =>
    ({
        DEPARE: fc(
            flats([
                [-100, -2000],
                [100, -2000],
                [100, 0],
                [2000, 0],
                [2000, 200],
                [-100, 200],
            ]),
            deepWater([
                [2000, -1000],
                [4000, -1000],
                [4000, 1000],
                [2000, 1000],
            ]),
        ),
        LNDARE: fc(
            land(-3000, -4000, -100, 3000),
            land(100, -4000, 2000, 0),
            land(-100, -4000, 100, -2000),
            land(-100, 200, 2000, 3000),
            land(2000, 1000, 6000, 3000),
            land(2000, -4000, 6000, -1000),
            land(4000, -1000, 6000, 1000),
        ),
    }) as InshoreLayers;

describe('never through water no tide clears (owner decision 11)', () => {
    it('a bar charted 0–0.5 m on the straight way is passed round, not crossed', () => {
        // Highest tide 2.0 m: the flats (2 m + 2 m) clear 2.9 m; the bar (0.5 m + 2 m) never does.
        const bar = box(-700, 250, 0, 420, { acronym: 'DEPARE', DRVAL1: 0, DRVAL2: 0.5 });
        // The flats with the bar cut out of them, so the bar alone charts its water.
        const [flatsBand, deepBand] = diagonal().DEPARE!.features;
        const holed: Feature = {
            ...flatsBand,
            geometry: {
                type: 'Polygon',
                coordinates: [
                    (flatsBand.geometry as Polygon).coordinates[0],
                    (bar.geometry as Polygon).coordinates[0].slice().reverse(),
                ],
            },
        };
        const layers = { ...diagonal(), DEPARE: fc(bar, holed, deepBand) } as InshoreLayers;
        const tideCeilings = [];
        for (let lat = -27.6; lat <= -27.35; lat += 0.05)
            for (let lon = 153.2; lon <= 153.45; lon += 0.05) tideCeilings.push({ lat, lon, highestM: 2, days: 14 });
        const r = ok(routeInshore(layers, { ...req([0, 0], [2500, 4500]), tideCeilings }));
        for (let i = 0; i + 1 < r.polyline.length; i++) {
            const [ax, ay] = metres(r.polyline[i]);
            const [bx, by] = metres(r.polyline[i + 1]);
            for (let k = 0; k <= 100; k++) {
                const x = ax + ((bx - ax) * k) / 100;
                const y = ay + ((by - ay) * k) / 100;
                expect(
                    x > -700 && x < 0 && y > 250 && y < 420,
                    `segment ${i} crosses the bar at (${x.toFixed(0)}, ${y.toFixed(0)})`,
                ).toBe(false);
            }
        }
        expect(r.polyline[0]).toEqual(at(0, 0));
    });
});

describe('where no straight line passes', () => {
    it('keeps the charted way through the dog-leg and says why', () => {
        const r = ok(routeInshore(dogleg(), req([0, -1900], [3500, 0])));
        expect(r.debug?.directTail?.origin).toBeUndefined();
        expect(r.debug?.directTailRefused?.origin).toBe('charted land');
        expect(r.pinTail?.origin?.direct).toBe(false);
        expect(r.pinTail?.origin?.why).toBe('charted land');
        // The route notes say so, with the pin's depth and the tide it needs.
        expect(inshoreRouteCaveats({ pinTail: r.pinTail })).toEqual([
            'Your departure pin is in 1.2 m charted water — the route starts there and needs +1.7 m of tide. It leaves through its charted water, not in a straight line: a straight line would cross charted land.',
        ]);
        // Still the pin's own water up the channel and round the corner.
        expect(r.shallowRuns?.some((s) => s.endpointTail === 'origin')).toBe(true);
        for (const p of r.polyline) {
            const [x, y] = metres(p);
            expect(x < 110 || y > -10, `(${x.toFixed(0)}, ${y.toFixed(0)}) cuts the corner`).toBe(true);
        }
    });
});

describe('what the route says about a shallow pin', () => {
    it('names the pin’s charted depth and the tide it needs', () => {
        const r = ok(routeInshore(diagonal(), req([0, 0], [2500, 4500])));
        expect(r.pinTail?.origin).toMatchObject({ depthM: 1.2, needsM: 1.7, direct: true });
        expect(r.pinTail?.destination).toBeUndefined();
        // A direct tail needs no route note: its leg names it.
        expect(inshoreRouteCaveats({ pinTail: r.pinTail })).toEqual([]);
    });
});

describe('the leg review names a shallow pin (Auto marks its first and last legs)', () => {
    const bbox = [...at(-1500, -1500), ...at(1500, 2000)] as [number, number, number, number];
    const ctx = tracerContextFromLayers(diagonal(), [], bbox, 2.4);
    const point = ([lon, lat]: [number, number]) => ({ lat, lon });
    const pin = point(at(0, 0));
    const deep = point(at(-300, 1200));
    const needsLines = (messages: string[]) => messages.filter((m) => /needs \+/.test(m));

    it('a departure: "starts in 1.2 m charted water — needs +1.7 m tide", said once', () => {
        const v = validateTraceLeg(pin, deep, ctx, { pinStart: true });
        const messages = v.issues.map((i) => i.message);
        expect(messages).toContain('starts in 1.2 m charted water — needs +1.7 m tide');
        expect(needsLines(messages)).toHaveLength(1);
        expect(v.grade).toBe('danger');
        expect(v.needsTide).toBe(true);
    });

    it('an arrival: "ends in 1.2 m charted water — needs +1.7 m tide"', () => {
        const v = validateTraceLeg(deep, pin, ctx, { pinEnd: true });
        expect(v.issues.map((i) => i.message)).toContain('ends in 1.2 m charted water — needs +1.7 m tide');
    });

    it('a leg that is not a pin’s keeps its usual words', () => {
        const v = validateTraceLeg(pin, deep, ctx);
        const messages = v.issues.map((i) => i.message);
        expect(messages).toContain('1.2 m charted — needs +1.7 m tide');
        expect(messages.some((m) => m.startsWith('starts in'))).toBe(false);
    });

    it('a pin in deep water says nothing about it', () => {
        const v = validateTraceLeg(deep, point(at(300, 1500)), ctx, { pinStart: true, pinEnd: true });
        expect(v.issues.some((i) => /^(starts|ends) in/.test(i.message))).toBe(false);
    });
});

// Fix-up review (2026-10-03): the direct line was ranked by length alone.
describe('never shallower than the way it replaces', () => {
    /** A 2.0–2.5 m gutter from the pin north, then east to deep water, through flats charted shallower. */
    const gutter = (flatD1: number, flatD2: number): InshoreLayers => {
        const flat = { acronym: 'DEPARE', DRVAL1: flatD1, DRVAL2: flatD2 };
        const gut = { acronym: 'DEPARE', DRVAL1: 2.0, DRVAL2: 2.5 };
        return {
            DEPARE: fc(
                box(-1500, -1000, -60, 1500, flat),
                box(-60, -1000, 1500, -60, flat),
                box(60, -60, 1500, 540, flat),
                box(-60, 660, 1500, 1500, flat),
                box(-60, -60, 60, 540, gut),
                box(-60, 540, 1500, 660, gut),
                box(1500, -1000, 4000, 1500, { acronym: 'DEPARE', DRVAL1: 10, DRVAL2: 20 }),
            ),
            LNDARE: fc(
                land(-3000, -3000, 6000, -1000),
                land(-3000, 1500, 6000, 3000),
                land(-3000, -1000, -1500, 1500),
                land(4000, -1000, 6000, 1500),
            ),
        } as InshoreLayers;
    };
    /** Metres of the route over the flats (west of the deep water, outside the gutter). */
    const overFlatsM = (r: RouteResult): number => {
        let m = 0;
        for (let i = 0; i + 1 < r.polyline.length; i++) {
            const [ax, ay] = metres(r.polyline[i]);
            const [bx, by] = metres(r.polyline[i + 1]);
            const n = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay)));
            for (let k = 0; k < n; k++) {
                const x = ax + ((bx - ax) * (k + 0.5)) / n;
                const y = ay + ((by - ay) * (k + 0.5)) / n;
                if (x >= 1500) continue;
                const inGutter = (x > -60 && x < 60 && y > -60 && y < 540) || (x > -60 && y > 540 && y < 660);
                if (!inGutter) m += Math.hypot(bx - ax, by - ay) / n;
            }
        }
        return m;
    };
    // The charted tail takes the gutter (the deeper way, tailStepWeight); the
    // straight line to the route cut 1,460 m across the flats, and the tail
    // then needed +2.9 m of tide where the gutter needs +0.9 m — while the
    // route still said "2.0 m, +0.9 m, direct".
    for (const [d1, d2] of [
        [0, 0.5],
        [0.8, 1.2],
    ] as const) {
        it(`a pin in a 2 m gutter through ${d1}–${d2} m flats keeps the gutter, and says why`, () => {
            const r = ok(routeInshore(gutter(d1, d2), req([0, 0], [3000, 0])));
            expect(overFlatsM(r)).toBeLessThan(20);
            expect(r.shallowRuns?.find((s) => s.endpointTail === 'origin')?.minDepthM).toBe(2);
            expect(r.debug?.directTail?.origin).toBeUndefined();
            const why = `shallower water than its charted way (${d1.toFixed(1)} m charted, against 2.0 m)`;
            expect(r.debug?.directTailRefused?.origin).toBe(why);
            expect(r.pinTail?.origin).toEqual({ depthM: 2, needsM: 0.9, direct: false, why });
            expect(inshoreRouteCaveats({ pinTail: r.pinTail })).toEqual([
                `Your departure pin is in 2.0 m charted water — the route starts there and needs +0.9 m of tide. It leaves through its charted water, not in a straight line: a straight line would cross ${why}.`,
            ]);
        });
    }

    it('the tide is the tail’s own: a pin in a 2 m pocket whose way out crosses 1.5 m needs +1.4 m', () => {
        const pocket = box(-200, -200, 200, 200, { acronym: 'DEPARE', DRVAL1: 2.0, DRVAL2: 2.5 });
        const flatsAround: Feature = {
            type: 'Feature',
            properties: { acronym: 'DEPARE', DRVAL1: 1.5, DRVAL2: 2 },
            geometry: {
                type: 'Polygon',
                coordinates: [
                    (box(-3000, -1500, 3000, 1000, {}).geometry as Polygon).coordinates[0],
                    (pocket.geometry as Polygon).coordinates[0].slice().reverse(),
                ],
            },
        };
        const layers = {
            DEPARE: fc(
                pocket,
                flatsAround,
                deepWater([
                    [-3000, 1000],
                    [3000, 1000],
                    [3000, 3000],
                    [-3000, 3000],
                ]),
            ),
            LNDARE: fc(
                land(-5000, -4000, 5000, -1500),
                land(-5000, 3000, 5000, 5000),
                land(-5000, -1500, -3000, 3000),
                land(3000, -1500, 5000, 3000),
            ),
        } as InshoreLayers;
        const r = ok(routeInshore(layers, req([0, 0], [0, 2000])));
        expect(r.pinTail?.origin).toEqual({ depthM: 2, needsM: 1.4, leastM: 1.5, direct: true });
        expect(r.shallowRuns?.find((s) => s.endpointTail === 'origin')?.minDepthM).toBe(1.5);
    });
});

// Fix-up review (2026-10-03): shallow to shallow across a narrow deep strip.
describe('shallow to shallow across a deep strip the line barely reads', () => {
    // The review's randomised case (seed 47): an 81 m deep strip, slanted,
    // through a 1.2–2 m bay. The line to the other pin read deep at one ~10 m
    // sample, too short to split at, and everything after it — 1.2 km of
    // charted 1.2 m into the destination pin — was marked deep, with no
    // destination tail.
    const rng = (seed: number): (() => number) => {
        let s = seed >>> 0;
        return () => {
            s = (s * 1664525 + 1013904223) >>> 0;
            return s / 2 ** 32;
        };
    };
    const R = rng(47 * 104729);
    const u = (a: number, b: number): number => a + (b - a) * R();
    const w = u(20, 90);
    const th = u(-0.6, 0.6);
    const cx = u(-300, 300);
    const [dx, dy] = [Math.sin(th) * 3000, Math.cos(th) * 3000];
    const [nx, ny] = [(Math.cos(th) * w) / 2, (-Math.sin(th) * w) / 2];
    const layers = {
        DEPARE: fc(
            poly(
                [
                    [-3000, -1500],
                    [3000, -1500],
                    [3000, 1500],
                    [-3000, 1500],
                ],
                { acronym: 'DEPARE', DRVAL1: 1.2, DRVAL2: 2, _scaleRank: 4 },
            ),
            poly(
                [
                    [cx - dx - nx, -dy - ny],
                    [cx - dx + nx, -dy + ny],
                    [cx + dx + nx, dy + ny],
                    [cx + dx - nx, dy - ny],
                ],
                { acronym: 'DEPARE', DRVAL1: 6, DRVAL2: 10, _scaleRank: 5 },
            ),
            deepWater([
                [3000, -1500],
                [6000, -1500],
                [6000, 1500],
                [3000, 1500],
            ]),
        ),
        LNDARE: fc(
            land(-5000, -4000, 8000, -1500),
            land(-5000, 1500, 8000, 4000),
            land(-5000, -1500, -3000, 1500),
            land(6000, -1500, 8000, 1500),
        ),
    } as InshoreLayers;
    const from: [number, number] = [u(-1500, -400), u(-1000, 1000)];
    const to: [number, number] = [u(400, 1500), u(-1000, 1000)];
    /** Metres from the strip's centreline. */
    const offStrip = (p: readonly [number, number]): number => {
        const [x, y] = metres(p);
        return Math.abs((x - cx) * Math.cos(th) - y * Math.sin(th));
    };

    it('keeps the whole line the pins’ water: caution to the destination pin, with its tail', () => {
        expect(w).toBeCloseTo(81, 0);
        const r = ok(routeInshore(layers, req(from, to)));
        expect(r.polyline[r.polyline.length - 1]).toEqual(at(...to));
        expect(r.cautionMask?.[r.polyline.length - 2]).toBe(true);
        expect(r.shallowRuns?.some((s) => s.endpointTail === 'destination')).toBe(true);
        // Nothing outside the strip is drawn as deep water.
        r.polyline.slice(1).forEach((q, i) => {
            if (r.cautionMask?.[i]) return;
            expect(
                offStrip(r.polyline[i]) < w / 2 + 15 && offStrip(q) < w / 2 + 15,
                `segment ${i} is marked deep but leaves the strip`,
            ).toBe(true);
        });
    });
});
