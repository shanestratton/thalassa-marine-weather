/**
 * Convex hull (monotone chain) for [lon, lat] points.
 *
 * WHY A HULL AND NOT A SMOOTHED LINE. At anchor a stationary GNSS receiver
 * wanders 5–15 m, and worse alongside a marina where the fix bounces off the
 * rigging and neighbouring hulls. Joining consecutive raw fixes with a line
 * turns that into a zigzag that reads like the boat sprinting back and forth
 * (Shane 2026-09-05, at z20.2 with a 0.003 nm scale bar).
 *
 * Smoothing the line only makes a prettier wander, and it DELAYS the moment a
 * genuine drag becomes visible — the wrong trade on a safety surface. The hull
 * answers the question actually being asked at anchor: how far have I swung,
 * and is that still inside my circle? It hides nothing, because any real
 * movement expands it immediately, and the raw fixes stay drawn underneath.
 *
 * Planar maths on degrees is correct for this use. A swing envelope is tens of
 * metres across; the longitude/latitude scale difference cannot change which
 * points are on the hull at that size, and the result is only ever handed
 * straight back to the map as a polygon.
 */

export type LonLat = [number, number];

/** Cross product of OA × OB. >0 counter-clockwise, <0 clockwise, 0 collinear. */
function cross(o: LonLat, a: LonLat, b: LonLat): number {
    return (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
}

/**
 * The convex hull in counter-clockwise order, WITHOUT a repeated closing
 * point — callers that need a GeoJSON ring close it themselves.
 *
 * Fewer than three distinct points has no area, so the input is returned
 * de-duplicated and unchanged: one fix is a point, two are a line, and both
 * are honest answers that a caller can choose how to draw.
 */
export function convexHull(points: readonly LonLat[]): LonLat[] {
    const unique = new Map<string, LonLat>();
    for (const p of points) {
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
        unique.set(`${p[0]},${p[1]}`, p);
    }
    const pts = [...unique.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    if (pts.length < 3) return pts;

    const lower: LonLat[] = [];
    for (const p of pts) {
        while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
        lower.push(p);
    }

    const upper: LonLat[] = [];
    for (let i = pts.length - 1; i >= 0; i--) {
        const p = pts[i];
        while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
        upper.push(p);
    }

    // Both halves repeat the two endpoints; drop them once.
    lower.pop();
    upper.pop();
    return lower.concat(upper);
}

/**
 * The hull as a closed GeoJSON linear ring, or null when there is no area to
 * draw. A caller with one or two fixes has nothing to shade and should keep
 * drawing the raw points alone.
 */
export function hullRing(points: readonly LonLat[]): LonLat[] | null {
    const hull = convexHull(points);
    if (hull.length < 3) return null;
    return [...hull, hull[0]];
}
