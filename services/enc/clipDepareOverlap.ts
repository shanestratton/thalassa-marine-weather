/**
 * clipDepareOverlap — cut coarse-cell DEPARE bands OUT of finer cells'
 * coverage for the RENDER merge (Shane 2026-07-11: "hard darker shaded
 * areas... ruining my day").
 *
 * The satellite glaze paints depth bands translucently, and translucent
 * fills STACK: everywhere a coarse cell and a finer cell both charted
 * the same water, the glaze double-painted into a hard-edged darker
 * patch. Whole-bbox scale-shadowing can't help — it only drops coarse
 * features that sit entirely inside finer coverage; the big partial-
 * overlap polygons survive whole. This module subtracts the finer
 * cells' bboxes from those survivors geometrically, so exactly ONE
 * band covers any point of water.
 *
 * No boolean-ops dependency: the OUTSIDE of an axis-aligned rectangle
 * partitions into 4 NON-overlapping rectangles (left slab, right slab,
 * middle-top, middle-bottom), and clipping an arbitrary polygon to an
 * axis-aligned rectangle is plain Sutherland–Hodgman (4 half-plane
 * passes). Pieces are disjoint by construction — subtracting several
 * bboxes iterates the same step over the running piece list.
 *
 * Grid-side conflict resolution is separate (finest-survey-wins ranks
 * in navGrid); this is purely about what the punter SEES.
 */
import type { Feature, MultiPolygon, Polygon, Position } from 'geojson';

type Bbox = [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
type Ring = Position[];
type PolyRings = Ring[]; // [outer, ...holes]

const EPS = 1e-12;

/** One Sutherland–Hodgman pass: keep the side of the ring where keep(p) is true. */
function clipRingHalfPlane(
    ring: Ring,
    inside: (p: Position) => boolean,
    intersect: (a: Position, b: Position) => Position,
): Ring {
    const out: Ring = [];
    for (let i = 0; i < ring.length; i++) {
        const cur = ring[i];
        const prev = ring[(i + ring.length - 1) % ring.length];
        const curIn = inside(cur);
        const prevIn = inside(prev);
        if (curIn) {
            if (!prevIn) out.push(intersect(prev, cur));
            out.push(cur);
        } else if (prevIn) {
            out.push(intersect(prev, cur));
        }
    }
    return out;
}

/** Clip a ring to an axis-aligned rect. Returns [] when nothing remains. */
function clipRingToRect(ring: Ring, [minX, minY, maxX, maxY]: Bbox): Ring {
    // Open the ring (drop a duplicated closing point) for clipping.
    let r = ring;
    if (r.length > 1 && r[0][0] === r[r.length - 1][0] && r[0][1] === r[r.length - 1][1]) {
        r = r.slice(0, -1);
    }
    const lerpX = (a: Position, b: Position, x: number): Position => [
        x,
        a[1] + ((b[1] - a[1]) * (x - a[0])) / (b[0] - a[0] || EPS),
    ];
    const lerpY = (a: Position, b: Position, y: number): Position => [
        a[0] + ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1] || EPS),
        y,
    ];
    r = clipRingHalfPlane(
        r,
        (p) => p[0] >= minX,
        (a, b) => lerpX(a, b, minX),
    );
    if (r.length < 3) return [];
    r = clipRingHalfPlane(
        r,
        (p) => p[0] <= maxX,
        (a, b) => lerpX(a, b, maxX),
    );
    if (r.length < 3) return [];
    r = clipRingHalfPlane(
        r,
        (p) => p[1] >= minY,
        (a, b) => lerpY(a, b, minY),
    );
    if (r.length < 3) return [];
    r = clipRingHalfPlane(
        r,
        (p) => p[1] <= maxY,
        (a, b) => lerpY(a, b, maxY),
    );
    if (r.length < 3) return [];
    r.push([r[0][0], r[0][1]]); // re-close
    return r;
}

function ringBbox(ring: Ring): Bbox {
    let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
    for (const p of ring) {
        if (p[0] < minX) minX = p[0];
        if (p[1] < minY) minY = p[1];
        if (p[0] > maxX) maxX = p[0];
        if (p[1] > maxY) maxY = p[1];
    }
    return [minX, minY, maxX, maxY];
}

const bboxesIntersect = (a: Bbox, b: Bbox): boolean => !(a[2] <= b[0] || a[0] >= b[2] || a[3] <= b[1] || a[1] >= b[3]);
const bboxInside = (inner: Bbox, outer: Bbox): boolean =>
    inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];

/** Clip a polygon (outer + holes) to a rect; null when nothing remains. */
function clipPolyToRect(poly: PolyRings, rect: Bbox): PolyRings | null {
    const outer = clipRingToRect(poly[0], rect);
    if (outer.length < 4) return null;
    const out: PolyRings = [outer];
    for (let h = 1; h < poly.length; h++) {
        const hole = clipRingToRect(poly[h], rect);
        if (hole.length >= 4) out.push(hole);
    }
    return out;
}

/**
 * The complement of `hole` within `frame`, as up to 4 NON-overlapping
 * rects: full-height left/right slabs plus middle top/bottom. Disjoint
 * by construction — the pieces they produce can never double-paint.
 */
function outsidePartition(frame: Bbox, hole: Bbox): Bbox[] {
    const h: Bbox = [
        Math.max(hole[0], frame[0]),
        Math.max(hole[1], frame[1]),
        Math.min(hole[2], frame[2]),
        Math.min(hole[3], frame[3]),
    ];
    const rects: Bbox[] = [];
    if (h[0] > frame[0]) rects.push([frame[0], frame[1], h[0], frame[3]]); // left slab
    if (h[2] < frame[2]) rects.push([h[2], frame[1], frame[2], frame[3]]); // right slab
    if (h[3] < frame[3]) rects.push([h[0], h[3], h[2], frame[3]]); // middle top
    if (h[1] > frame[1]) rects.push([h[0], frame[1], h[2], h[1]]); // middle bottom
    return rects;
}

/**
 * Subtract the given bboxes from a LINE feature (DEPCNT contours,
 * COALNE coastlines) — the same double-paint disease as the fills,
 * drawn as duplicate/criss-crossing lines where coarse and fine cells
 * overlap. Per segment: drop the parts inside any bbox, keep the rest
 * as split line pieces. Returns the ORIGINAL feature untouched when
 * nothing overlaps, null when swallowed whole.
 */
export function clipLineFeatureOutsideBboxes(feature: Feature, allBboxes: readonly Bbox[]): Feature | null {
    const g = feature.geometry;
    if (!g || (g.type !== 'LineString' && g.type !== 'MultiLineString')) return feature;
    const inputLines: Position[][] = g.type === 'LineString' ? [g.coordinates] : g.coordinates;

    // Feature-level prefilter (review major: every segment allocated a
    // param Set against every bbox in the library) — only bboxes that
    // touch this feature's own extent can affect it; none → identity.
    let fMinX = Infinity,
        fMinY = Infinity,
        fMaxX = -Infinity,
        fMaxY = -Infinity;
    for (const line of inputLines) {
        for (const p of line) {
            if (p[0] < fMinX) fMinX = p[0];
            if (p[1] < fMinY) fMinY = p[1];
            if (p[0] > fMaxX) fMaxX = p[0];
            if (p[1] > fMaxY) fMaxY = p[1];
        }
    }
    const bboxes = allBboxes.filter((b) => !(fMaxX <= b[0] || fMinX >= b[2] || fMaxY <= b[1] || fMinY >= b[3]));
    if (bboxes.length === 0) return feature;

    const insideAny = (p: Position): boolean =>
        bboxes.some((b) => p[0] >= b[0] && p[0] <= b[2] && p[1] >= b[1] && p[1] <= b[3]);

    // Split each line at bbox boundaries by sampling segment crossings.
    // Exact param clipping per bbox edge: for each segment, collect the
    // entry/exit parameters against every bbox, then keep sub-segments
    // whose midpoints are outside all bboxes.
    const segParams = (a: Position, b: Position): number[] => {
        const ts = new Set<number>([0, 1]);
        for (const [minX, minY, maxX, maxY] of bboxes) {
            for (const [axis, bound] of [
                [0, minX],
                [0, maxX],
                [1, minY],
                [1, maxY],
            ] as const) {
                const da = a[axis];
                const db = b[axis];
                if (da === db) continue;
                const t = (bound - da) / (db - da);
                if (t > 0 && t < 1) ts.add(t);
            }
        }
        return Array.from(ts).sort((x, y) => x - y);
    };

    let touched = false;
    const outLines: Position[][] = [];
    for (const line of inputLines) {
        let current: Position[] = [];
        const flush = (): void => {
            if (current.length >= 2) outLines.push(current);
            current = [];
        };
        for (let i = 0; i < line.length - 1; i++) {
            const a = line[i];
            const b = line[i + 1];
            // Per-segment quick reject — segments clear of every relevant
            // bbox pass through without the param machinery.
            const sMinX = Math.min(a[0], b[0]);
            const sMaxX = Math.max(a[0], b[0]);
            const sMinY = Math.min(a[1], b[1]);
            const sMaxY = Math.max(a[1], b[1]);
            if (!bboxes.some((bb) => !(sMaxX <= bb[0] || sMinX >= bb[2] || sMaxY <= bb[1] || sMinY >= bb[3]))) {
                if (current.length === 0) current.push(a);
                current.push(b);
                continue;
            }
            const ts = segParams(a, b);
            for (let k = 0; k < ts.length - 1; k++) {
                const t0 = ts[k];
                const t1 = ts[k + 1];
                const mid: Position = [a[0] + ((b[0] - a[0]) * (t0 + t1)) / 2, a[1] + ((b[1] - a[1]) * (t0 + t1)) / 2];
                const p0: Position = t0 === 0 ? a : [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0];
                const p1: Position = t1 === 1 ? b : [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1];
                if (insideAny(mid)) {
                    touched = true;
                    flush();
                } else {
                    if (current.length === 0) current.push(p0);
                    current.push(p1);
                }
            }
        }
        flush();
    }
    if (!touched) return feature;
    if (outLines.length === 0) return null;
    return {
        ...feature,
        geometry:
            outLines.length === 1
                ? { type: 'LineString', coordinates: outLines[0] }
                : { type: 'MultiLineString', coordinates: outLines },
    };
}

/**
 * Subtract the given bboxes from a DEPARE feature's polygons. Returns:
 *  - the ORIGINAL feature when no bbox overlaps it (fast identity path),
 *  - null when the bboxes swallow it whole,
 *  - otherwise a NEW feature (never mutates the cached blob) whose
 *    MultiPolygon pieces are pairwise disjoint outside the bboxes.
 */
export function clipFeatureOutsideBboxes(feature: Feature, bboxes: readonly Bbox[]): Feature | null {
    const g = feature.geometry;
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return feature;
    const inputPolys: PolyRings[] =
        g.type === 'Polygon' ? [g.coordinates as PolyRings] : (g.coordinates as PolyRings[]);

    let touched = false;
    let pieces: PolyRings[] = inputPolys;
    for (const hole of bboxes) {
        const next: PolyRings[] = [];
        for (const poly of pieces) {
            const fb = ringBbox(poly[0]);
            if (!bboxesIntersect(fb, hole)) {
                next.push(poly);
                continue;
            }
            touched = true;
            if (bboxInside(fb, hole)) continue; // swallowed whole
            for (const rect of outsidePartition(fb, hole)) {
                const clipped = clipPolyToRect(poly, rect);
                if (clipped) next.push(clipped);
            }
        }
        pieces = next;
        if (pieces.length === 0) return null;
    }
    if (!touched) return feature;

    const geometry: MultiPolygon | Polygon =
        pieces.length === 1
            ? { type: 'Polygon', coordinates: pieces[0] }
            : { type: 'MultiPolygon', coordinates: pieces };
    return { ...feature, geometry };
}
