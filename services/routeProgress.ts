/**
 * routeProgress — where is the boat ALONG the route she is following?
 *
 * Every "distance to go" on the chart until now was a great-circle line from
 * the boat to the destination (useDestinationFlag). That is the right number
 * for "how far is it" and the wrong one for "how much of this passage is
 * left": a route that doubles a headland is longer than the straight line,
 * and the difference is exactly the part a skipper is asking about.
 *
 * Pure functions, no stores. The passage pane uses `progressAlongRoute` now;
 * phase 2's scrubber starts its ghost from `alongNm` (Shane 2026-09-18: the
 * ghost starts from where the boat is, not from the route's origin).
 *
 * Geometry: each leg is short next to the Earth, so the closest point on a leg
 * is found on a local equirectangular plane centred on that leg, and every
 * DISTANCE that is reported comes from the same haversine the rest of the
 * chart uses (utils/navigationCalculations, nautical miles).
 *
 * WHICH LEG. The strictly nearest leg — always, within one continuous stretch
 * of the route. A hint only gets a say when two DISJOINT stretches share the
 * same water (an out-and-back, a crossing, a return drawn a few metres beside
 * the way out), and then in this order:
 *   1. the way she is actually moving (her COG when she has instruments and
 *      is making way, else her course made good) — a stretch she is sailing
 *      AGAINST is not the one she is on;
 *   2. where she was last reckoned along the route.
 * A stretch ends where the route doubles back on itself (a turn sharper than
 * REVERSAL_DEG), so the two halves of a two-leg out-and-back are two stretches
 * even though their legs are neighbours.
 *
 * An earlier version let "closest to where she was" outvote "nearest" within a
 * quarter mile. Review ran it tick by tick: it froze the figure at every
 * waypoint, lagged a quarter mile on a densely drawn line, and on an
 * out-and-back pinned her to the outbound leg so the distance to go climbed
 * all the way home. Memory chooses between stretches; it never overrules the
 * water within one.
 */
import { calculateBearing, calculateDistance } from '../utils/navigationCalculations';

export interface RoutePoint {
    lat: number;
    lon: number;
}

export interface RouteProgress {
    /** Distance sailed along the route to the point abeam of the boat, NM. */
    alongNm: number;
    /** What is left along the route from that point to its end, NM. */
    remainingNm: number;
    /**
     * What the skipper still has to sail: `remainingNm`, plus the distance back
     * to the line when she is meaningfully off it (>= OFF_LINE_COUNTS_NM). Without
     * this a boat abeam of the far end reads "0.0 NM to go" from ten miles away,
     * and one not yet on the route is told less than the truth.
     */
    toGoNm: number;
    /** Whole route, NM. */
    totalNm: number;
    /** How far the boat is off the route line, NM. */
    offTrackNm: number;
    /** Index of the leg (coords[i] → coords[i + 1]) the boat is abeam of. */
    legIndex: number;
    /** The point on the route abeam of the boat. */
    abeam: RoutePoint;
}

/** What the caller remembers from its last reckoning. Both optional. */
export interface RouteProgressHint {
    /** Where she was last reckoned along the route, NM. */
    alongNm?: number;
    /** Her course made good over the last MOTION_MIN_NM or more, degrees true. */
    headingDeg?: number;
}

/** Off the line by this much or more and the way back counts toward "to go". */
export const OFF_LINE_COUNTS_NM = 0.5;
/**
 * Stretches within this of the nearest leg share its water: GPS noise, ~15 m.
 * Any wider and a lagging hint can overrule a lane she is demonstrably ON.
 */
export const SAME_WATER_NM = 0.008;
/** Legs this close to a stretch's nearest leg speak for its direction. ~18 m. */
const STRETCH_VOICE_NM = 0.01;
/**
 * A course made good is only a course once she has moved this far. ~93 m —
 * more than a boat swings on her anchor, so lying to a hook on shared water
 * does not flip her between the way out and the way home.
 */
export const MOTION_MIN_NM = 0.05;
/** A turn sharper than this is the route doubling back: a new stretch. */
export const REVERSAL_DEG = 120;

const valid = (p: RoutePoint | null | undefined): p is RoutePoint =>
    !!p &&
    Number.isFinite(p.lat) &&
    Number.isFinite(p.lon) &&
    p.lat >= -90 &&
    p.lat <= 90 &&
    p.lon >= -180 &&
    p.lon <= 180;

/** Signed shortest longitude difference, degrees, antimeridian-safe. */
function dLon(from: number, to: number): number {
    let d = to - from;
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    return d;
}

/** Smallest angle between two bearings, 0…180. */
function angleBetween(a: number, b: number): number {
    const d = Math.abs(((((a - b) % 360) + 540) % 360) - 180);
    return d;
}

/** Length of every leg, NM. */
export function legLengthsNm(coords: readonly RoutePoint[]): number[] {
    const out: number[] = [];
    for (let i = 0; i + 1 < coords.length; i++) {
        out.push(calculateDistance(coords[i].lat, coords[i].lon, coords[i + 1].lat, coords[i + 1].lon));
    }
    return out;
}

export function routeLengthNm(coords: readonly RoutePoint[]): number {
    return legLengthsNm(coords).reduce((sum, nm) => sum + nm, 0);
}

/** Closest point on the leg a→b to p, as a fraction 0…1 along the leg. */
function closestOnLeg(p: RoutePoint, a: RoutePoint, b: RoutePoint): { t: number; point: RoutePoint } {
    const lat0 = ((a.lat + b.lat) / 2) * (Math.PI / 180);
    const kx = Math.cos(lat0);
    const bx = dLon(a.lon, b.lon) * kx;
    const by = b.lat - a.lat;
    const px = dLon(a.lon, p.lon) * kx;
    const py = p.lat - a.lat;
    const len2 = bx * bx + by * by;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
    let lon = a.lon + dLon(a.lon, b.lon) * t;
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;
    return { t, point: { lat: a.lat + (b.lat - a.lat) * t, lon } };
}

/** A place on the route and the way the route runs there. */
export interface RouteStation extends RoutePoint {
    /** Bearing of the leg she would be sailing there, degrees true. */
    bearingDeg: number;
    legIndex: number;
    /** `alongNm` after clamping to the route, NM. */
    alongNm: number;
    /** True when the asked-for distance ran past the end of the route. */
    arrived: boolean;
}

/**
 * The point `alongNm` down the route — the inverse of `progressAlongRoute`.
 * Phase 2's ghost: where she will be after sailing that far. Distances past
 * the end hold at the last point and say so (`arrived`); negative ones hold at
 * the start. Zero-length legs are walked over, never divided by.
 */
export function pointAlongRoute(coords: readonly RoutePoint[], alongNm: number): RouteStation | null {
    const route = coords.filter(valid);
    if (route.length < 2 || !Number.isFinite(alongNm)) return null;
    const legs = legLengthsNm(route);
    const totalNm = legs.reduce((sum, nm) => sum + nm, 0);
    const want = Math.max(0, Math.min(alongNm, totalNm));

    const bearingAt = (i: number): number =>
        calculateBearing(route[i].lat, route[i].lon, route[i + 1].lat, route[i + 1].lon);
    // The last leg that has any length: what "the way the route runs" means
    // when she is standing on its final point.
    let lastReal = -1;
    for (let i = legs.length - 1; i >= 0; i--) {
        if (legs[i] > 0) {
            lastReal = i;
            break;
        }
    }
    if (lastReal < 0) return null; // every point is the same point: not a route

    let before = 0;
    for (let i = 0; i < legs.length; i++) {
        if (legs[i] > 0 && want <= before + legs[i] && (want < before + legs[i] || i === lastReal)) {
            const t = (want - before) / legs[i];
            const a = route[i];
            const b = route[i + 1];
            let lon = a.lon + dLon(a.lon, b.lon) * t;
            if (lon > 180) lon -= 360;
            if (lon < -180) lon += 360;
            return {
                lat: a.lat + (b.lat - a.lat) * t,
                lon,
                bearingDeg: bearingAt(i),
                legIndex: i,
                alongNm: want,
                arrived: alongNm >= totalNm,
            };
        }
        before += legs[i];
    }
    const end = route[lastReal + 1];
    return {
        lat: end.lat,
        lon: end.lon,
        bearingDeg: bearingAt(lastReal),
        legIndex: lastReal,
        alongNm: totalNm,
        arrived: true,
    };
}

/**
 * A route measured ONCE: cumulative distance and bearing per leg.
 *
 * `pointAlongRoute` re-measures every leg on every call — fine for one ghost,
 * but phase 3's passage plan asks "where is she after this many miles?" several
 * hundred times per plan, and a traced route can be thousands of points. Build
 * the index once per route array; `stationOnIndex` is then a binary search.
 */
export interface RouteIndex {
    /** The valid points, in order. */
    points: RoutePoint[];
    /** cumNm[i] = distance from the start to points[i]. Same length as `points`. */
    cumNm: number[];
    /** bearingDeg[i] = bearing of leg i (points[i] → points[i+1]); NaN for a zero-length leg. */
    bearingDeg: number[];
    totalNm: number;
    /** Index of the last leg that has any length, or -1 when there is none. */
    lastRealLeg: number;
}

export function buildRouteIndex(coords: readonly RoutePoint[]): RouteIndex | null {
    const points = coords.filter(valid);
    if (points.length < 2) return null;
    const cumNm = [0];
    const bearingDeg: number[] = [];
    let lastRealLeg = -1;
    for (let i = 0; i + 1 < points.length; i++) {
        const nm = calculateDistance(points[i].lat, points[i].lon, points[i + 1].lat, points[i + 1].lon);
        cumNm.push(cumNm[i] + nm);
        if (nm > 0) {
            lastRealLeg = i;
            bearingDeg.push(calculateBearing(points[i].lat, points[i].lon, points[i + 1].lat, points[i + 1].lon));
        } else {
            bearingDeg.push(Number.NaN);
        }
    }
    if (lastRealLeg < 0) return null; // every point is the same point: not a route
    return { points, cumNm, bearingDeg, totalNm: cumNm[cumNm.length - 1], lastRealLeg };
}

/** `pointAlongRoute` on a prebuilt index: same answers, O(log n). */
export function stationOnIndex(index: RouteIndex, alongNm: number): RouteStation | null {
    if (!Number.isFinite(alongNm)) return null;
    const { points, cumNm, bearingDeg, totalNm, lastRealLeg } = index;
    const want = Math.max(0, Math.min(alongNm, totalNm));
    if (want >= totalNm) {
        const end = points[lastRealLeg + 1];
        return {
            lat: end.lat,
            lon: end.lon,
            bearingDeg: bearingDeg[lastRealLeg],
            legIndex: lastRealLeg,
            alongNm: totalNm,
            arrived: alongNm >= totalNm,
        };
    }
    // The LAST point whose cumulative distance is <= want: at a waypoint she is
    // already looking down the next leg, and zero-length legs are stepped over.
    let lo = 0;
    let hi = cumNm.length - 1;
    while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (cumNm[mid] <= want) lo = mid;
        else hi = mid - 1;
    }
    let leg = Math.min(lo, points.length - 2);
    while (leg < lastRealLeg && !(cumNm[leg + 1] > cumNm[leg])) leg += 1;
    const length = cumNm[leg + 1] - cumNm[leg];
    const t = length > 0 ? (want - cumNm[leg]) / length : 0;
    const a = points[leg];
    const b = points[leg + 1];
    let lon = a.lon + dLon(a.lon, b.lon) * t;
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;
    return {
        lat: a.lat + (b.lat - a.lat) * t,
        lon,
        bearingDeg: bearingDeg[leg],
        legIndex: leg,
        alongNm: want,
        arrived: false,
    };
}

interface Candidate {
    legIndex: number;
    point: RoutePoint;
    offTrackNm: number;
    alongNm: number;
}

/**
 * Progress of `position` along `coords`. Null when there is no route to be
 * along (fewer than two valid points) or no valid position — never a zero that
 * could be read as "arrived".
 */
export function progressAlongRoute(
    coords: readonly RoutePoint[],
    position: RoutePoint | null | undefined,
    hint: RouteProgressHint = {},
): RouteProgress | null {
    const route = coords.filter(valid);
    if (route.length < 2 || !valid(position)) return null;

    const legs = legLengthsNm(route);
    const totalNm = legs.reduce((sum, nm) => sum + nm, 0);

    const candidates: Candidate[] = [];
    let before = 0;
    let nearest = Infinity;
    for (let i = 0; i + 1 < route.length; i++) {
        const { t, point } = closestOnLeg(position, route[i], route[i + 1]);
        const offTrackNm = calculateDistance(position.lat, position.lon, point.lat, point.lon);
        if (offTrackNm < nearest) nearest = offTrackNm;
        candidates.push({ legIndex: i, point, offTrackNm, alongNm: before + legs[i] * t });
        before += legs[i];
    }

    const bearingOf = (legIndex: number): number | null =>
        legs[legIndex] === 0
            ? null
            : calculateBearing(
                  route[legIndex].lat,
                  route[legIndex].lon,
                  route[legIndex + 1].lat,
                  route[legIndex + 1].lon,
              );

    // Legs sharing the nearest leg's water, grouped into continuous stretches.
    const near = candidates.filter((c) => c.offTrackNm <= nearest + SAME_WATER_NM);
    const stretches: Candidate[][] = [];
    for (const c of near) {
        const current = stretches[stretches.length - 1];
        const last = current?.[current.length - 1];
        let continues = !!last && c.legIndex === last.legIndex + 1;
        if (continues && last) {
            const a = bearingOf(last.legIndex);
            const b = bearingOf(c.legIndex);
            if (a !== null && b !== null && angleBetween(a, b) > REVERSAL_DEG) continues = false;
        }
        if (continues && current) current.push(c);
        else stretches.push([c]);
    }
    const nearestIn = (stretch: Candidate[]): Candidate =>
        stretch.reduce((a, b) => (b.offTrackNm < a.offTrackNm ? b : a));

    let chosen = stretches.map(nearestIn);
    if (chosen.length > 1 && typeof hint.headingDeg === 'number' && Number.isFinite(hint.headingDeg)) {
        const heading = hint.headingDeg;
        // A stretch is "against her" only if EVERY leg of it that is about as
        // near as its nearest runs against her course. At a corner the nearest
        // single leg flips with a few metres of noise; its neighbour does not.
        const withHer = chosen.filter((c, i) =>
            stretches[i].some((leg) => {
                if (leg.offTrackNm > c.offTrackNm + STRETCH_VOICE_NM) return false;
                const b = bearingOf(leg.legIndex);
                return b !== null && angleBetween(heading, b) <= 90;
            }),
        );
        if (withHer.length > 0) chosen = withHer;
    }
    let best = chosen.reduce((a, b) => (b.offTrackNm < a.offTrackNm ? b : a));
    if (chosen.length > 1 && typeof hint.alongNm === 'number' && Number.isFinite(hint.alongNm)) {
        const was = hint.alongNm;
        // `<=` so that an exact tie goes to the LATER stretch: progress is forward.
        best = chosen.reduce((a, b) => (Math.abs(b.alongNm - was) <= Math.abs(a.alongNm - was) ? b : a));
    }

    const remainingNm = Math.max(0, totalNm - best.alongNm);
    return {
        alongNm: best.alongNm,
        remainingNm,
        toGoNm: remainingNm + (best.offTrackNm >= OFF_LINE_COUNTS_NM ? best.offTrackNm : 0),
        totalNm,
        offTrackNm: best.offTrackNm,
        legIndex: best.legIndex,
        abeam: best.point,
    };
}
