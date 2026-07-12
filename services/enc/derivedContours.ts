/**
 * derivedContours — depth contours interpolated from our OWN spot
 * soundings, so shallow water reads as richly as a SonarChart HD sheet
 * WITHOUT the community-sonar guesswork (2026-07-12 competitive review,
 * item 3).
 *
 * HONESTY IS THE WHOLE POINT. These are NOT surveyed DEPCNT lines:
 *  - they are drawn dashed + faint + in a distinct teal-grey so a
 *    mariner can never mistake them for the official contour;
 *  - every feature carries `_derived: true` and its interpolated depth;
 *  - they are generated ONLY by LINEAR interpolation across Delaunay
 *    triangles whose three sounding vertices are all within
 *    MAX_EDGE_M of each other. A triangle spanning a data gap is
 *    EXTRAPOLATION dressed as fact — those are dropped, so a contour
 *    only appears where real soundings surround it on all sides.
 *
 * Method: Delaunay-triangulate the sounding points, then for each
 * contour level march the classic triangle-isoline: a plane at depth L
 * cuts a triangle in a single straight segment between the two edges
 * whose endpoints straddle L. Collect segments per level; the renderer
 * draws them as short dashes (no polyline stitching needed — dashes
 * read fine and stitching scattered segments is where false confidence
 * creeps in).
 *
 * Pure + unit-tested. Heavy (triangulation + per-level march), so the
 * merge calls it inside its time-sliced loop and it will move into the
 * Web Worker with the rest of the merge.
 */

import Delaunay from 'delaunator';
import type { Feature, LineString } from 'geojson';

export interface DerivedContourOptions {
    /** Depth levels (metres, chart datum) to contour. */
    levels?: number[];
    /** Drop any triangle whose longest edge exceeds this (metres) —
     *  the guard against extrapolating across a data gap. */
    maxEdgeM?: number;
    /** Skip the whole pass below this many soundings — too sparse to
     *  contour honestly. */
    minSoundings?: number;
}

/** Shallow-water levels — where densification actually helps a keel.
 *  Deliberately stops at 20 m: past that the official contours and the
 *  open-water read are plenty, and interpolating deep water just adds
 *  ink. */
export const DEFAULT_DERIVED_LEVELS = [2, 3, 4, 5, 7, 10, 15, 20];
const DEFAULT_MAX_EDGE_M = 600;
const DEFAULT_MIN_SOUNDINGS = 8;
const M_PER_DEG_LAT = 111_320;

interface Pt {
    lon: number;
    lat: number;
    d: number;
}

/** Great-circle-ish planar distance in metres (small distances). */
function distM(a: Pt, b: Pt): number {
    const midLat = ((a.lat + b.lat) / 2) * (Math.PI / 180);
    const dx = (b.lon - a.lon) * Math.cos(midLat) * M_PER_DEG_LAT;
    const dy = (b.lat - a.lat) * M_PER_DEG_LAT;
    return Math.hypot(dx, dy);
}

/** Interpolate the crossing point of level L on the edge p→q (assumes
 *  p.d and q.d straddle L). */
function crossing(p: Pt, q: Pt, level: number): [number, number] {
    const t = (level - p.d) / (q.d - p.d);
    return [p.lon + (q.lon - p.lon) * t, p.lat + (q.lat - p.lat) * t];
}

/**
 * Build interpolated-contour LineString features from a sounding set.
 * Input points are {lon, lat, d} where d is depth (metres, positive
 * down; drying heights are negative and are simply never crossed by a
 * positive contour level, which is correct).
 */
export function buildDerivedContours(points: Pt[], opts: DerivedContourOptions = {}): Feature<LineString>[] {
    const levels = opts.levels ?? DEFAULT_DERIVED_LEVELS;
    const maxEdgeM = opts.maxEdgeM ?? DEFAULT_MAX_EDGE_M;
    const minSoundings = opts.minSoundings ?? DEFAULT_MIN_SOUNDINGS;

    // De-dup coincident soundings (Delaunay hates duplicates) and drop
    // non-finite depths.
    const seen = new Set<string>();
    const pts: Pt[] = [];
    for (const p of points) {
        if (!Number.isFinite(p.lon) || !Number.isFinite(p.lat) || !Number.isFinite(p.d)) continue;
        const key = `${p.lon.toFixed(6)},${p.lat.toFixed(6)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pts.push(p);
    }
    if (pts.length < minSoundings) return [];

    const coords: [number, number][] = pts.map((p) => [p.lon, p.lat]);
    let del: { triangles: Uint32Array | number[] };
    try {
        del = Delaunay.from(coords);
    } catch {
        return [];
    }
    const tri = del.triangles;

    const out: Feature<LineString>[] = [];
    for (let t = 0; t < tri.length; t += 3) {
        const a = pts[tri[t]];
        const b = pts[tri[t + 1]];
        const c = pts[tri[t + 2]];
        // Extrapolation guard: any long edge means this triangle spans a
        // gap — skip it rather than invent depth across open water.
        if (distM(a, b) > maxEdgeM || distM(b, c) > maxEdgeM || distM(c, a) > maxEdgeM) continue;

        const dmin = Math.min(a.d, b.d, c.d);
        const dmax = Math.max(a.d, b.d, c.d);
        for (const level of levels) {
            if (level <= dmin || level > dmax) continue; // plane doesn't cut this triangle
            // The level crosses exactly the two edges whose endpoints
            // straddle it.
            const edges: Array<[Pt, Pt]> = [
                [a, b],
                [b, c],
                [c, a],
            ];
            const hits: [number, number][] = [];
            for (const [p, q] of edges) {
                if ((p.d < level && q.d >= level) || (q.d < level && p.d >= level)) {
                    hits.push(crossing(p, q, level));
                }
            }
            if (hits.length === 2) {
                out.push({
                    type: 'Feature',
                    geometry: { type: 'LineString', coordinates: [hits[0], hits[1]] },
                    properties: { _derived: true, _valdco: level, VALDCO: level },
                });
            }
        }
    }
    return out;
}
