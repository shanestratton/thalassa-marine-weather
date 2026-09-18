/**
 * Distance left ALONG the followed route, not the straight line to its end.
 *
 * Shane, 2026-09-17: the passage strip on the chart shows how much of the
 * passage is left. A route that doubles a headland is longer than the
 * great-circle line to the destination, and that difference is the point.
 *
 * The second half of this file sails a boat along routes tick by tick, feeding
 * each reckoning back in as the pane does — because the first memory rule
 * passed every single-shot test and, run that way, froze at each waypoint,
 * lagged on a densely drawn line and counted UP all the way home on an
 * out-and-back.
 */
import { describe, expect, it } from 'vitest';
import {
    MOTION_MIN_NM,
    buildRouteIndex,
    legLengthsNm,
    pointAlongRoute,
    progressAlongRoute,
    routeLengthNm,
    stationOnIndex,
    type RoutePoint,
} from '../services/routeProgress';
import { calculateBearing, calculateDistance } from '../utils/navigationCalculations';

// A dog-leg: 60 NM due north, then ~53 NM due east at 27°S.
const A = { lat: -28, lon: 153 };
const B = { lat: -27, lon: 153 };
const C = { lat: -27, lon: 154 };
const ROUTE = [A, B, C];

describe('route length', () => {
    it('sums the legs in nautical miles', () => {
        const legs = legLengthsNm(ROUTE);
        expect(legs).toHaveLength(2);
        expect(legs[0]).toBeCloseTo(60, 0); // one degree of latitude
        expect(legs[1]).toBeCloseTo(60 * Math.cos((27 * Math.PI) / 180), 0);
        expect(routeLengthNm(ROUTE)).toBeCloseTo(legs[0] + legs[1], 6);
    });
});

describe('progress along the route', () => {
    it('is zero at the origin and the whole route is left', () => {
        const p = progressAlongRoute(ROUTE, A)!;
        expect(p.alongNm).toBeCloseTo(0, 3);
        expect(p.remainingNm).toBeCloseTo(p.totalNm, 3);
        expect(p.legIndex).toBe(0);
    });

    it('half way up the first leg, half that leg is behind her', () => {
        const p = progressAlongRoute(ROUTE, { lat: -27.5, lon: 153 })!;
        expect(p.alongNm).toBeCloseTo(30, 0);
        expect(p.remainingNm).toBeCloseTo(p.totalNm - 30, 0);
        expect(p.offTrackNm).toBeLessThan(0.05);
    });

    it('counts distance ALONG the dog-leg, which is more than the straight line to the end', () => {
        const p = progressAlongRoute(ROUTE, { lat: -27.5, lon: 153 })!;
        const straight = calculateDistance(-27.5, 153, C.lat, C.lon);
        expect(p.remainingNm).toBeGreaterThan(straight + 5);
    });

    it('reports how far off the line she is, and still places her abeam of the right leg', () => {
        const p = progressAlongRoute(ROUTE, { lat: -27.5, lon: 153.1 })!; // ~5.3 NM east
        expect(p.legIndex).toBe(0);
        expect(p.offTrackNm).toBeGreaterThan(5);
        expect(p.offTrackNm).toBeLessThan(5.6);
        expect(p.alongNm).toBeCloseTo(30, 0);
    });

    it('adds the way back to the line to what is left, once she is meaningfully off it', () => {
        const on = progressAlongRoute(ROUTE, { lat: -27.5, lon: 153 })!;
        expect(on.toGoNm).toBeCloseTo(on.remainingNm, 6);
        const off = progressAlongRoute(ROUTE, { lat: -27.5, lon: 153.1 })!;
        expect(off.toGoNm).toBeCloseTo(off.remainingNm + off.offTrackNm, 6);
        // Abeam of the far end from twelve miles away is not "0.0 NM to go".
        const pastEnd = progressAlongRoute(ROUTE, { lat: -26.8, lon: 154 })!;
        expect(pastEnd.remainingNm).toBe(0);
        expect(pastEnd.toGoNm).toBeGreaterThan(10);
    });

    it('is nothing left at the destination', () => {
        const p = progressAlongRoute(ROUTE, C)!;
        expect(p.remainingNm).toBeCloseTo(0, 3);
        expect(p.toGoNm).toBeCloseTo(0, 3);
    });

    it('returns null rather than a zero that could read as "arrived"', () => {
        expect(progressAlongRoute([], A)).toBeNull();
        expect(progressAlongRoute([A], A)).toBeNull();
        expect(progressAlongRoute(ROUTE, null)).toBeNull();
        expect(progressAlongRoute(ROUTE, { lat: Number.NaN, lon: 153 })).toBeNull();
        expect(progressAlongRoute([A, { lat: 999, lon: 0 }], A)).toBeNull();
    });

    it('works across the antimeridian', () => {
        const route = [
            { lat: -18, lon: 179.5 },
            { lat: -18, lon: -179.5 },
        ];
        const p = progressAlongRoute(route, { lat: -18, lon: 180 })!;
        expect(p.totalNm).toBeCloseTo(60 * Math.cos((18 * Math.PI) / 180), 0);
        expect(p.alongNm).toBeCloseTo(p.totalNm / 2, 0);
    });

    it('copes with a route of thousands of points', () => {
        const long: RoutePoint[] = Array.from({ length: 20_000 }, (_, i) => ({ lat: -28 + i * 0.0001, lon: 153 }));
        const p = progressAlongRoute(long, { lat: -27.5, lon: 153 })!;
        expect(p.alongNm).toBeCloseTo(30, 0);
    });
});

/** Sail `track` fix by fix, carrying the pane's memory forward exactly as it does. */
function sail(route: RoutePoint[], track: RoutePoint[]) {
    let alongNm: number | undefined;
    let headingDeg: number | undefined;
    let ref: RoutePoint | null = null;
    return track.map((at) => {
        if (!ref) ref = at;
        else if (calculateDistance(ref.lat, ref.lon, at.lat, at.lon) >= MOTION_MIN_NM) {
            headingDeg = calculateBearing(ref.lat, ref.lon, at.lat, at.lon);
            ref = at;
        }
        const p = progressAlongRoute(route, at, { alongNm, headingDeg })!;
        alongNm = p.alongNm;
        return p;
    });
}

/** Points every `stepNm` along a polyline, by linear interpolation per leg. */
function along(route: RoutePoint[], stepNm: number): RoutePoint[] {
    const out: RoutePoint[] = [];
    for (let i = 0; i + 1 < route.length; i++) {
        const a = route[i];
        const b = route[i + 1];
        const len = calculateDistance(a.lat, a.lon, b.lat, b.lon);
        const n = Math.max(1, Math.round(len / stepNm));
        for (let k = i === 0 ? 0 : 1; k <= n; k++) {
            out.push({ lat: a.lat + ((b.lat - a.lat) * k) / n, lon: a.lon + ((b.lon - a.lon) * k) / n });
        }
    }
    return out;
}

describe('sailed fix by fix, with the memory the pane carries', () => {
    it('never freezes or jumps at a waypoint', () => {
        const route = [
            { lat: -27.2, lon: 153.1 },
            { lat: -27.1, lon: 153.1 }, // 6 NM north
            { lat: -27.03, lon: 153.17 }, // then a 40°-odd turn
        ];
        const fixes = along(route, 0.02);
        const run = sail(route, fixes);
        for (let i = 1; i < run.length; i++) {
            const step = run[i].alongNm - run[i - 1].alongNm;
            expect(step, `fix ${i}`).toBeGreaterThan(0.005); // always moving on
            expect(step, `fix ${i}`).toBeLessThan(0.06); // never a catch-up jump
        }
        expect(run[run.length - 1].remainingNm).toBeCloseTo(0, 2);
    });

    it('does not lag on a densely drawn line, and reads zero alongside at the end', () => {
        const dense: RoutePoint[] = Array.from({ length: 61 }, (_, i) => ({
            lat: -27.2 + (i * 0.05) / 60,
            lon: 153.1,
        }));
        const total = routeLengthNm(dense);
        const fixes = along(dense, 0.02);
        const run = sail(dense, fixes);
        // The truth is how far the fixes themselves have come along the line.
        let sailed = 0;
        run.forEach((p, i) => {
            if (i > 0) sailed += calculateDistance(fixes[i - 1].lat, fixes[i - 1].lon, fixes[i].lat, fixes[i].lon);
            expect(Math.abs(p.alongNm - Math.min(total, sailed)), `fix ${i}`).toBeLessThan(0.005);
        });
        expect(run[run.length - 1].toGoNm).toBeCloseTo(0, 2);
    });

    it('an out-and-back counts DOWN all the way home', () => {
        const berth = { lat: -27.2, lon: 153.1 };
        const turn = { lat: -27.2 + 10 / 60, lon: 153.1 }; // 10 NM north
        const route = [berth, turn, berth];
        const track = [...along([berth, turn], 0.05), ...along([turn, berth], 0.05).slice(1)];
        const run = sail(route, track);
        const toGo = run.map((p) => p.toGoNm);
        // Strictly non-increasing, 20 NM down to nothing.
        expect(toGo[0]).toBeCloseTo(20, 0);
        for (let i = 1; i < toGo.length; i++) expect(toGo[i], `fix ${i}`).toBeLessThanOrEqual(toGo[i - 1] + 0.06);
        expect(toGo[toGo.length - 1]).toBeCloseTo(0, 1);
        // Half way home she is on the return leg, 15 NM along.
        const halfHome = run[Math.round(track.length * 0.75)];
        expect(halfHome.legIndex).toBe(1);
        expect(halfHome.alongNm).toBeCloseTo(15, 0);
    });

    it('a return leg drawn a cable to one side is simply the nearer leg — memory gets no say', () => {
        const out = [
            { lat: -27.2, lon: 153.1 },
            { lat: -27.1, lon: 153.1 },
        ];
        const back = [
            { lat: -27.1, lon: 153.102 }, // ~0.1 NM east
            { lat: -27.2, lon: 153.102 },
        ];
        const route = [...out, ...back];
        const p = progressAlongRoute(route, { lat: -27.15, lon: 153.102 }, { alongNm: 3 })!;
        expect(p.legIndex).toBe(2);
        expect(p.offTrackNm).toBeLessThan(0.01);
    });

    it('a return drawn a few metres beside the way out does not flip her between them', () => {
        // A logbook track home, ~20 m east of the way out: nearest-leg alone
        // would hop between the two with every metre of GPS noise, and each
        // hop moves "to go" by twice the distance to the turn.
        const berth = { lat: -27.2, lon: 153.1 };
        const turn = { lat: -27.2 + 10 / 60, lon: 153.1 };
        const turnE = { lat: turn.lat, lon: 153.1002 };
        const berthE = { lat: berth.lat, lon: 153.1002 };
        const route = [berth, turn, turnE, berthE];
        // Homeward, weaving a few metres either side of BOTH lines.
        const track = along([turnE, berthE], 0.05).map((p, i) => ({
            lat: p.lat,
            lon: p.lon + (i % 2 ? -0.00015 : 0.00005),
        }));
        const run = sail(route, [...along([berth, turn], 0.05), ...track.slice(1)]).slice(-track.length + 3);
        for (const p of run) expect(p.legIndex).toBe(2);
        for (let i = 1; i < run.length; i++) expect(run[i].toGoNm).toBeLessThanOrEqual(run[i - 1].toGoNm + 0.06);
    });

    it('a round trip through one marina channel, with GPS noise and her own COG as the hint', () => {
        // Fairway east, a 100° turn into the channel, out to sea, across, and
        // home over the SAME points. Review simulated the first rule here and
        // it read 0.1 NM to go, 120 m into a 6 NM trip.
        const m = (north: number, east: number) => ({ lat: -27.2 + north / 111_320, lon: 153.1 + east / 99_000 });
        const out = [m(0, 0), m(0, 120), m(300, 170), m(4000, 170), m(4000, 2000)];
        const route = [...out, ...out.slice(0, -1).reverse()];
        const total = routeLengthNm(route);
        const truthTrack = along(route, 0.004); // ~7 m a fix: 3 kn at 2 s
        let seed = 7;
        const noise = () => {
            seed = (seed * 1103515245 + 12345) % 2147483648;
            return (seed / 2147483648 - 0.5) * 16; // ±8 m
        };
        let alongNm: number | undefined;
        let sailed = 0;
        let bad = 0;
        truthTrack.forEach((p, i) => {
            const next = truthTrack[Math.min(i + 1, truthTrack.length - 1)];
            if (i > 0) sailed += calculateDistance(truthTrack[i - 1].lat, truthTrack[i - 1].lon, p.lat, p.lon);
            const headingDeg =
                i + 1 < truthTrack.length ? calculateBearing(p.lat, p.lon, next.lat, next.lon) : undefined;
            const noisy = { lat: p.lat + noise() / 111_320, lon: p.lon + noise() / 99_000 };
            const got = progressAlongRoute(route, noisy, { alongNm, headingDeg })!;
            alongNm = got.alongNm;
            if (Math.abs(got.alongNm - Math.min(total, sailed)) >= 0.1) bad++;
        });
        expect(bad).toBe(0);
    });

    it('at anchor on shared water she stays on the leg she was on', () => {
        const berth = { lat: -27.2, lon: 153.1 };
        const turn = { lat: -27.2 + 10 / 60, lon: 153.1 };
        const route = [berth, turn, berth];
        const spot = { lat: -27.2 + 4 / 60, lon: 153.1 }; // 4 NM out, 16 NM along on the way home
        expect(progressAlongRoute(route, spot, { alongNm: 16.01 })!.legIndex).toBe(1);
        expect(progressAlongRoute(route, spot, { alongNm: 3.99 })!.legIndex).toBe(0);
        expect(progressAlongRoute(route, spot)!.legIndex).toBe(0); // just set off
    });
});

describe('the point a given distance down the route — where the ghost will be', () => {
    it('is the inverse of progressAlongRoute, all the way along a dog-leg', () => {
        const total = routeLengthNm(ROUTE);
        for (let along = 0; along <= total; along += 3.7) {
            const at = pointAlongRoute(ROUTE, along)!;
            const back = progressAlongRoute(ROUTE, at)!;
            expect(back.alongNm).toBeCloseTo(along, 2);
            expect(back.offTrackNm).toBeLessThan(0.01);
        }
    });

    it('points the way the route runs THERE: north on the first leg, east on the second', () => {
        expect(pointAlongRoute(ROUTE, 30)!.bearingDeg).toBeCloseTo(0, 0);
        const east = pointAlongRoute(ROUTE, 80)!;
        expect(east.legIndex).toBe(1);
        expect(east.bearingDeg).toBeGreaterThan(85);
        expect(east.bearingDeg).toBeLessThan(95);
    });

    it('at a waypoint she is already looking down the NEXT leg', () => {
        const atB = pointAlongRoute(ROUTE, legLengthsNm(ROUTE)[0])!;
        expect(atB.lat).toBeCloseTo(B.lat, 6);
        expect(atB.legIndex).toBe(1);
    });

    it('holds at the end and SAYS she has arrived — it does not sail on past the destination', () => {
        const total = routeLengthNm(ROUTE);
        const end = pointAlongRoute(ROUTE, total + 500)!;
        expect(end.lat).toBeCloseTo(C.lat, 6);
        expect(end.lon).toBeCloseTo(C.lon, 6);
        expect(end.alongNm).toBeCloseTo(total, 6);
        expect(end.arrived).toBe(true);
        expect(pointAlongRoute(ROUTE, total - 1)!.arrived).toBe(false);
    });

    it('holds at the start for a negative distance', () => {
        const start = pointAlongRoute(ROUTE, -5)!;
        expect(start.lat).toBeCloseTo(A.lat, 6);
        expect(start.alongNm).toBe(0);
    });

    it('walks over a doubled waypoint instead of dividing by its zero length', () => {
        const doubled = [A, B, B, C];
        const at = pointAlongRoute(doubled, legLengthsNm(doubled)[0] + 10)!;
        expect(Number.isFinite(at.lat) && Number.isFinite(at.lon) && Number.isFinite(at.bearingDeg)).toBe(true);
        expect(at.legIndex).toBe(2);
        const end = pointAlongRoute([A, B, C, C], 9999)!;
        expect(end.bearingDeg).toBeGreaterThan(85); // the last REAL leg, not a 0° from C to C
    });

    it('crosses the antimeridian without going the long way round', () => {
        const fiji = [
            { lat: -17, lon: 179 },
            { lat: -17, lon: -179 },
        ];
        const mid = pointAlongRoute(fiji, routeLengthNm(fiji) / 2)!;
        expect(Math.abs(Math.abs(mid.lon) - 180)).toBeLessThan(0.01);
    });

    it('is nothing for no route, a single point, or a route that is all one point', () => {
        expect(pointAlongRoute([], 1)).toBeNull();
        expect(pointAlongRoute([A], 1)).toBeNull();
        expect(pointAlongRoute([A, A, A], 1)).toBeNull();
        expect(pointAlongRoute(ROUTE, Number.NaN)).toBeNull();
    });
});

describe('a route measured once — the index the passage plan walks', () => {
    it('gives EXACTLY the answers pointAlongRoute gives, all the way along and past both ends', () => {
        for (const route of [ROUTE, [A, B, B, C], [A, B, C, C], [A, A, B, C]]) {
            const index = buildRouteIndex(route)!;
            expect(index.totalNm).toBeCloseTo(routeLengthNm(route), 9);
            for (let along = -5; along <= index.totalNm + 5; along += 2.3) {
                const slow = pointAlongRoute(route, along)!;
                const fast = stationOnIndex(index, along)!;
                expect(fast.lat).toBeCloseTo(slow.lat, 9);
                expect(fast.lon).toBeCloseTo(slow.lon, 9);
                expect(fast.bearingDeg).toBeCloseTo(slow.bearingDeg, 9);
                expect(fast.alongNm).toBeCloseTo(slow.alongNm, 9);
                expect(fast.arrived).toBe(slow.arrived);
            }
        }
    });

    it('agrees at the waypoints themselves, where the leg changes', () => {
        const index = buildRouteIndex(ROUTE)!;
        const atB = legLengthsNm(ROUTE)[0];
        expect(stationOnIndex(index, atB)!.legIndex).toBe(pointAlongRoute(ROUTE, atB)!.legIndex);
        expect(stationOnIndex(index, atB)!.legIndex).toBe(1);
    });

    it('does not re-measure the route per question: a 4,000-point trace answers 2,000 questions fast', () => {
        const trace: RoutePoint[] = Array.from({ length: 4000 }, (_, i) => ({
            lat: -28 + i * 0.0005,
            lon: 153 + Math.sin(i / 40) * 0.01,
        }));
        const index = buildRouteIndex(trace)!;
        const t0 = performance.now();
        for (let i = 0; i < 2000; i++) stationOnIndex(index, (index.totalNm * i) / 2000);
        expect(performance.now() - t0).toBeLessThan(50);
    });

    it('is no index for no route', () => {
        expect(buildRouteIndex([])).toBeNull();
        expect(buildRouteIndex([A])).toBeNull();
        expect(buildRouteIndex([A, A, A])).toBeNull();
        expect(stationOnIndex(buildRouteIndex(ROUTE)!, Number.NaN)).toBeNull();
    });
});
