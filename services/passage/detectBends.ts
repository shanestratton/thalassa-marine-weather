/**
 * detectBends — find direction-change points on a polyline and surface
 * them as waypoints.
 *
 * The bathymetric / weather routers in `services/bathymetricRouter.ts`
 * + `services/weatherRouter.ts` produce a `routeGeoJSON` LineString
 * that follows a curved sea path — bending around shoals, around
 * weather, etc. The Gemini step before them only emits the high-level
 * named waypoints (departure / arrival / a handful of intermediate
 * ports). The actual route's bends — where the boat must change
 * heading — aren't captured anywhere a downstream consumer (logbook,
 * picker round-trip) can see.
 *
 * This module finds those bends. Strategy:
 *
 *   1. RDP-simplify the polyline to drop noise/quasi-straight segments
 *      (epsilon expressed in meters, calibrated for ocean-scale routes).
 *   2. Walk the simplified vertex sequence; flag any vertex where the
 *      bearing change vs the previous segment exceeds the threshold
 *      (one compass point = 22.5°, same as the ship-log course-change
 *      detector).
 *   3. Skip vertices within `minSpacingNm` of an existing named
 *      waypoint or another detected bend — avoids piling 5 synthetic
 *      WPs into the same dock approach.
 *
 * Returns coordinate + bend angle pairs; the caller turns them into
 * `Waypoint` records and merges them into `plan.waypoints` in passage
 * order.
 */

const TURN_THRESHOLD_DEG = 22.5;
const MIN_SPACING_NM = 1.0; // one nautical mile — keeps synthetic WPs from doubling up
const RDP_EPSILON_M = 200; // ~0.1nm tolerance — drops digital noise, keeps real geometry
const NM_PER_DEG_LAT = 60; // close enough for the spacing heuristic

export interface DetectedBend {
    /** Coordinate where the boat changes heading. */
    coordinates: { lat: number; lon: number };
    /** Heading delta in degrees (0–180, always positive). */
    bendDeg: number;
    /** Index into the original polyline (post-simplification). Useful for ordering. */
    indexAfterSimplify: number;
}

export interface DetectBendsOptions {
    /** Minimum heading-change in degrees to count as a bend. Default 22.5. */
    thresholdDeg?: number;
    /** Minimum NM spacing from existing named waypoints / other bends. Default 1nm. */
    minSpacingNm?: number;
    /** RDP epsilon in metres. Default 200m. */
    epsilonMeters?: number;
    /** Lat/lon of pre-existing named waypoints — synthetic bends won't be added near these. */
    existingWaypoints?: Array<{ lat: number; lon: number }>;
}

/**
 * Detect bends in a GeoJSON LineString polyline.
 *
 * `coordinates` is the LineString's `coordinates` array — i.e. an array
 * of `[lon, lat]` GeoJSON tuples. The function is endian-explicit so
 * we don't get flipped accidentally; tests cover that.
 */
export function detectBends(coordinates: Array<[number, number]>, options: DetectBendsOptions = {}): DetectedBend[] {
    const thresholdDeg = options.thresholdDeg ?? TURN_THRESHOLD_DEG;
    const minSpacingNm = options.minSpacingNm ?? MIN_SPACING_NM;
    const epsilonMeters = options.epsilonMeters ?? RDP_EPSILON_M;
    const existing = options.existingWaypoints ?? [];

    if (coordinates.length < 3) return [];

    // 1. RDP-simplify so micro-noise doesn't trip the threshold.
    const simplified = rdpSimplify(coordinates, epsilonMeters);
    if (simplified.length < 3) return [];

    // 2. Walk vertices, flag direction-change > threshold.
    const candidates: DetectedBend[] = [];
    for (let i = 1; i < simplified.length - 1; i++) {
        const prev = simplified[i - 1];
        const here = simplified[i];
        const next = simplified[i + 1];
        const incoming = bearing(prev[1], prev[0], here[1], here[0]);
        const outgoing = bearing(here[1], here[0], next[1], next[0]);
        const delta = headingDelta(incoming, outgoing);
        if (delta < thresholdDeg) continue;
        candidates.push({
            coordinates: { lat: here[1], lon: here[0] },
            bendDeg: delta,
            indexAfterSimplify: i,
        });
    }

    // 3. Reject candidates within minSpacingNm of an existing waypoint
    //    OR of another already-accepted bend. Walk in passage order so
    //    earlier bends win when they cluster.
    const accepted: DetectedBend[] = [];
    const isClose = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
        haversineNm(a.lat, a.lon, b.lat, b.lon) < minSpacingNm;

    for (const c of candidates) {
        if (existing.some((wp) => isClose(c.coordinates, wp))) continue;
        if (accepted.some((b) => isClose(c.coordinates, b.coordinates))) continue;
        accepted.push(c);
    }

    return accepted;
}

// ── Geometry helpers ─────────────────────────────────────────────────

function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const y = Math.sin(dLon) * Math.cos((lat2 * Math.PI) / 180);
    const x =
        Math.cos((lat1 * Math.PI) / 180) * Math.sin((lat2 * Math.PI) / 180) -
        Math.sin((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.cos(dLon);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

function headingDelta(a: number, b: number): number {
    let d = Math.abs(a - b) % 360;
    if (d > 180) d = 360 - d;
    return d;
}

function haversineMeters(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6_371_000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    return haversineMeters(lat1, lon1, lat2, lon2) / 1852;
    // 1852 m = 1 nautical mile (international definition)
    void NM_PER_DEG_LAT;
}

/** Perpendicular distance from P to line A→B in meters. */
function perpendicularDistanceMeters(
    pLon: number,
    pLat: number,
    aLon: number,
    aLat: number,
    bLon: number,
    bLat: number,
): number {
    const dAP = haversineMeters(aLat, aLon, pLat, pLon);
    const dAB = haversineMeters(aLat, aLon, bLat, bLon);
    if (dAB < 0.01) return dAP;
    const bearAB = bearing(aLat, aLon, bLat, bLon);
    const bearAP = bearing(aLat, aLon, pLat, pLon);
    const R = 6_371_000;
    const cross = Math.asin(Math.sin(dAP / R) * Math.sin(((bearAP - bearAB) * Math.PI) / 180)) * R;
    return Math.abs(cross);
}

/** Iterative Ramer–Douglas–Peucker on `[lon, lat]` tuples. */
function rdpSimplify(points: Array<[number, number]>, epsilonMeters: number): Array<[number, number]> {
    if (points.length <= 2) return points.slice();
    const keep = new Set<number>([0, points.length - 1]);
    const stack: Array<[number, number]> = [[0, points.length - 1]];
    while (stack.length) {
        const [start, end] = stack.pop()!;
        if (end - start < 2) continue;
        let maxDist = 0;
        let maxIdx = start;
        for (let i = start + 1; i < end; i++) {
            const d = perpendicularDistanceMeters(
                points[i][0],
                points[i][1],
                points[start][0],
                points[start][1],
                points[end][0],
                points[end][1],
            );
            if (d > maxDist) {
                maxDist = d;
                maxIdx = i;
            }
        }
        if (maxDist > epsilonMeters) {
            keep.add(maxIdx);
            stack.push([start, maxIdx]);
            stack.push([maxIdx, end]);
        }
    }
    return Array.from(keep)
        .sort((a, b) => a - b)
        .map((i) => points[i]);
}
