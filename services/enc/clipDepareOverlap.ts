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
import { diff as martinezDiff } from 'martinez-polygon-clipping';

export type Bbox = [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
type Ring = Position[];
type PolyRings = Ring[]; // [outer, ...holes]
/** MultiPolygon coordinate array — martinez's native geometry shape. */
export type CoverageGeom = Position[][][];

/** One finer cell's charted-water footprint for true-coverage clipping. */
export interface FineCoverage {
    /** DEPARE data-extent bbox — the cheap prefilter. */
    bbox: Bbox;
    /** The ACTUAL charted polygons (DEPARE + DRGARE), not their rectangle. */
    coverage: CoverageGeom;
    /** Strip-rect rasterisation of `coverage` (coverageMaskStrips) — the
     *  bounded fallback an over-cap martinez pair degrades to. Absent →
     *  the data-extent bbox is the fallback. Empty array = the three-state
     *  rule's "clip NOTHING" (never conflate with absent). */
    stripRects?: Bbox[];
}

/** Hard ceiling on the vertices martinez may see in ONE subject/clip pair
 *  (subject's current rings + the fine coverage's rings). This is THE
 *  bound the 2026-07-13 post-mortem demanded before the true-coverage
 *  glaze could return: martinez's allocation spike scales with input
 *  vertices, and an unbounded pair OOM-killed the whole renderer process
 *  — from a worker (workers protect against hangs, not process OOM).
 *  Over-cap pairs degrade to the strip-rect clip (Sutherland–Hodgman,
 *  bounded by construction) instead. 12k vertices keeps martinez's
 *  transient allocation in the low MB; the [glaze] stats line reports
 *  maxPairVertices so a device profiling session can tune this. */
export const GLAZE_MARTINEZ_VERTEX_CAP = 12_000;

/** Per-job telemetry the bounded clip accumulates — surfaced as the
 *  main-thread `[glaze]` warn line so the device session can see the
 *  exact/degraded split without a debugger. */
export interface CoverageClipStats {
    /** Pairs martinez actually clipped (exact result). */
    pairsExact: number;
    /** Pairs over GLAZE_MARTINEZ_VERTEX_CAP → strip-rect fallback. */
    pairsStripped: number;
    /** Pairs where martinez threw (degenerate ring) → rect fallback. */
    pairsRectFallback: number;
    /** Largest subject+clip vertex count seen (cap tuning signal). */
    maxPairVertices: number;
}

export const emptyClipStats = (): CoverageClipStats => ({
    pairsExact: 0,
    pairsStripped: 0,
    pairsRectFallback: 0,
    maxPairVertices: 0,
});

/** Total ring vertices in a multipolygon coordinate array. */
export function coverageVertexCount(geom: CoverageGeom): number {
    let n = 0;
    for (const poly of geom) for (const ring of poly) n += ring.length;
    return n;
}

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
 * Strip rects from the survey's ACTUAL polygons, rasterised — the fix
 * for the fix (2026-07-14): a channel survey's bands are long DIAGONAL
 * ribbons, so even per-feature bboxes are fat rectangles around them
 * and the staircase still blacked out the water beside the corridor.
 * Here each K-grid node is point-in-polygon tested against the real
 * coverage (plus every ring vertex marks its cell, catching slivers
 * between nodes), so the strips hug the ribbon itself. A node inside
 * ANY polygon marks its four adjacent cells — slight over-cover, which
 * is the conservative direction (coarse glaze removed a whisker wide,
 * never left painting over the fine survey's claims).
 */
export function coverageMaskStrips(coverage: CoverageGeom, extent: Bbox, k = 24, maxRects = 96): Bbox[] {
    if (coverage.length === 0) return [extent];
    const [ex0, ey0, ex1, ey1] = extent;
    const w = ex1 - ex0;
    const h = ey1 - ey0;
    if (!(w > 0) || !(h > 0)) return [extent];
    const covered: boolean[] = new Array(k * k).fill(false);
    const markCell = (x: number, y: number): void => {
        if (x >= 0 && y >= 0 && x < k && y < k) covered[y * k + x] = true;
    };
    // Ring vertices mark their cells directly (cheap sliver-catcher) —
    // and each ring's bbox is precomputed for the PIP prefilter below.
    const rings: Array<{ ring: Position[]; minX: number; minY: number; maxX: number; maxY: number }> = [];
    for (const poly of coverage) {
        for (const ring of poly) {
            let minX = Infinity,
                minY = Infinity,
                maxX = -Infinity,
                maxY = -Infinity;
            for (const p of ring) {
                markCell(Math.floor(((p[0] - ex0) / w) * k), Math.floor(((p[1] - ey0) / h) * k));
                if (p[0] < minX) minX = p[0];
                if (p[1] < minY) minY = p[1];
                if (p[0] > maxX) maxX = p[0];
                if (p[1] > maxY) maxY = p[1];
            }
            rings.push({ ring, minX, minY, maxX, maxY });
        }
    }
    // Grid NODES ((k+1)² points) PIP-tested even-odd; an inside node
    // marks its four adjacent cells. Ring-bbox prefilter keeps this from
    // jerking the main thread mid-zoom ("a little jerky at times", Shane
    // 2026-07-14): a ring whose y-range misses the node has no straddling
    // edges; one fully LEFT of the node contributes no crossings; one
    // fully RIGHT contributes an EVEN count (a closed ring crosses any
    // horizontal line an even number of times) — parity unchanged, all
    // three safely skipped. Typical node then tests 1-3 rings, not 179.
    for (let ny = 0; ny <= k; ny++) {
        const py = ey0 + (ny / k) * h;
        for (let nx = 0; nx <= k; nx++) {
            const px = ex0 + (nx / k) * w;
            let inside = false;
            for (const r of rings) {
                if (py < r.minY || py > r.maxY || px > r.maxX || px < r.minX) continue;
                const ring = r.ring;
                for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                    const yi = ring[i][1];
                    const yj = ring[j][1];
                    if (yi > py !== yj > py && px < ((ring[j][0] - ring[i][0]) * (py - yi)) / (yj - yi) + ring[i][0]) {
                        inside = !inside;
                    }
                }
            }
            if (inside) {
                markCell(nx - 1, ny - 1);
                markCell(nx, ny - 1);
                markCell(nx - 1, ny);
                markCell(nx, ny);
            }
        }
    }
    const strips = maskToStrips(covered, extent, k);
    // NON-EMPTY coverage that marked NOTHING lies entirely outside this
    // frame — there is nothing to clip HERE, so clip nothing. Falling
    // back to [extent] here is the whole-rectangle blackout (review
    // 2026-07-14: an out-of-frame shallow DRGARE pocket blacked out a
    // deep corridor cell's entire extent).
    if (strips.length === 0) return [];
    if (strips.length <= maxRects) return strips;
    // Over budget (fragmented reef-fringe shallows): degrade to a coarser
    // grid instead of the [extent] blackout. k=10 cannot overflow any
    // sane budget (≤ 5 runs/row × 10 rows = 50 strips), so this
    // terminates with real strips, never the whole rectangle.
    return k > 10 ? coverageMaskStrips(coverage, extent, Math.max(10, k >> 1), maxRects) : strips;
}

/** Shared strip merger: covered-cell mask → row-run rects, merging
 *  identical adjacent rows. Returns the RAW strips — empty and
 *  over-budget handling belongs to the callers, whose fallbacks
 *  differ (see coverageMaskStrips's empty/over-budget rules). */
function maskToStrips(covered: readonly boolean[], extent: Bbox, k: number): Bbox[] {
    const [ex0, ey0, ex1, ey1] = extent;
    const w = ex1 - ex0;
    const h = ey1 - ey0;
    // Row runs → strips, merging rows with identical runs.
    const rects: Bbox[] = [];
    let prevRuns: Array<[number, number]> = [];
    let stripStartRow = 0;
    const runsOfRow = (y: number): Array<[number, number]> => {
        const runs: Array<[number, number]> = [];
        let start = -1;
        for (let x = 0; x < k; x++) {
            if (covered[y * k + x]) {
                if (start < 0) start = x;
            } else if (start >= 0) {
                runs.push([start, x - 1]);
                start = -1;
            }
        }
        if (start >= 0) runs.push([start, k - 1]);
        return runs;
    };
    const flush = (endRow: number): void => {
        for (const [x0, x1] of prevRuns) {
            rects.push([
                ex0 + (x0 / k) * w,
                ey0 + (stripStartRow / k) * h,
                ex0 + ((x1 + 1) / k) * w,
                ey0 + ((endRow + 1) / k) * h,
            ]);
        }
    };
    for (let y = 0; y < k; y++) {
        const runs = runsOfRow(y);
        const same =
            runs.length === prevRuns.length && runs.every((r, i) => r[0] === prevRuns[i][0] && r[1] === prevRuns[i][1]);
        if (!same) {
            if (prevRuns.length > 0) flush(y - 1);
            prevRuns = runs;
            stripStartRow = y;
        }
    }
    if (prevRuns.length > 0) flush(k - 1);
    return rects;
}

/** Combined bbox of a multipolygon's outer rings. */
function coordsBbox(polys: CoverageGeom): Bbox {
    let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
    for (const poly of polys) {
        for (const p of poly[0] ?? []) {
            if (p[0] < minX) minX = p[0];
            if (p[1] < minY) minY = p[1];
            if (p[0] > maxX) maxX = p[0];
            if (p[1] > maxY) maxY = p[1];
        }
    }
    return [minX, minY, maxX, maxY];
}

/**
 * Subtract finer cells' ACTUAL charted coverage from a DEPARE feature
 * (martinez boolean difference). The rectangle version below cuts by the
 * finer cell's data-extent BBOX — wherever the finer survey charts only
 * part of that rectangle (surf strips, corners) the coarse band vanished
 * and raw imagery stared through as hard-edged dark boxes ("shaded areas
 * around some areas in shore", Shane 2026-07-12). True-coverage
 * subtraction leaves coarse paint everywhere the finer survey is
 * genuinely silent, so exactly one band covers charted water and ZERO
 * bands cover only what nobody charted.
 *
 * BOUNDED (2026-07-17, the re-enable precondition): martinez never sees a
 * subject+clip pair over `maxPairVertices`, and a shared `budget` (scoped
 * to one worker JOB) caps the AGGREGATE martinez work — both degrade
 * over-limit pairs to that fine's strip-rect clip (or its data-extent
 * rect when strips are absent), Sutherland–Hodgman, bounded by
 * construction.
 *
 * TWO-PHASE (round 2): every martinez pair runs FIRST on clean geometry;
 * every degraded pair's rects apply in ONE combined S–H pass at the END.
 * Set subtraction commutes, so the result is identical — but martinez
 * never sees strip-clip output (S–H emits edge-adjacent pieces, the
 * shape boolean-ops libraries are most fragile on). NOTE the honest
 * history: round 1's interleaving was first blamed for a repro's
 * exact=0/rect-fallback cascade, but that repro turned out to be running
 * martinez's BROKEN CJS build under node ("Y is not a constructor" —
 * the same interop trap the 2026-07-13 post-mortem documented); the
 * device's vite bundle uses the working ESM build (~4 ms per real
 * bounded pair). Two-phase stays as cheap insurance, verified by tests.
 *
 * Returns the original feature untouched when no coverage overlaps it,
 * null when swallowed whole, otherwise a NEW feature. Falls back to the
 * rectangle clip per fine cell if martinez rejects a degenerate ring —
 * a possible hole beats a crashed merge.
 */
export function clipFeatureOutsideCoverage(
    feature: Feature,
    fines: readonly FineCoverage[],
    maxPairVertices: number = GLAZE_MARTINEZ_VERTEX_CAP,
    stats?: CoverageClipStats,
    budget?: { remaining: number },
): Feature | null {
    const g = feature.geometry;
    if (!g || (g.type !== 'Polygon' && g.type !== 'MultiPolygon')) return feature;
    let coords: CoverageGeom =
        g.type === 'Polygon' ? [g.coordinates as PolyRings] : (g.coordinates as unknown as CoverageGeom);
    const fb = coordsBbox(coords);
    let subjectVerts = coverageVertexCount(coords);

    const coordsAsFeature = (): Feature => ({
        ...feature,
        geometry:
            coords.length === 1
                ? { type: 'Polygon', coordinates: coords[0] }
                : { type: 'MultiPolygon', coordinates: coords as MultiPolygon['coordinates'] },
    });

    let touched = false;
    // Phase 2's combined rect list — over-cap strips, over-budget strips,
    // and martinez-throw rect fallbacks all land here, applied in one
    // S–H pass after every martinez pair has run on clean geometry.
    const degradeRects: Bbox[] = [];

    for (const fine of fines) {
        if (!bboxesIntersect(fb, fine.bbox)) continue;
        const pairVerts = subjectVerts + coverageVertexCount(fine.coverage);
        if (stats && pairVerts > stats.maxPairVertices) stats.maxPairVertices = pairVerts;
        if (pairVerts > maxPairVertices || (budget != null && budget.remaining <= 0)) {
            // Over the per-pair or per-job martinez bound — degrade THIS
            // pair to the bounded strip clip. `stripRects: []` is the
            // three-state rule's "charted but nothing to clip": touch
            // nothing (falling back to the extent rect here would
            // re-create the whole-rectangle blackout the strips exist to
            // prevent).
            if (stats) stats.pairsStripped++;
            const rects = fine.stripRects ?? [fine.bbox];
            if (rects.length > 0) degradeRects.push(...rects);
            continue;
        }
        try {
            const out = martinezDiff(
                coords as unknown as Parameters<typeof martinezDiff>[0],
                fine.coverage as unknown as Parameters<typeof martinezDiff>[1],
            ) as unknown as CoverageGeom | null;
            touched = true;
            if (stats) stats.pairsExact++;
            if (budget) budget.remaining -= pairVerts;
            if (!out || out.length === 0) return null;
            coords = out;
            subjectVerts = coverageVertexCount(coords);
        } catch {
            if (stats) stats.pairsRectFallback++;
            degradeRects.push(fine.bbox);
        }
    }
    if (degradeRects.length > 0) {
        const before = coordsAsFeature();
        const clipped = clipFeatureOutsideBboxes(before, degradeRects);
        if (!clipped) return null;
        // Identity return = none of the rects touched the subject: only
        // then does the degrade pass leave `touched` alone.
        if (clipped !== before) {
            touched = true;
            const rg = clipped.geometry as Polygon | MultiPolygon;
            coords =
                rg.type === 'Polygon' ? [rg.coordinates as PolyRings] : (rg.coordinates as unknown as CoverageGeom);
        }
    }
    if (!touched) return feature;
    return coordsAsFeature();
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

    // Hot path (review 2026-07-14: 300 ms+ main-thread blocks): pieces
    // carry their bbox — computed ONCE, not re-walked per (piece, hole)
    // pair — and holes that can't touch the feature at all are dropped
    // up front. With 6 shadowing cells × 160 strip rects the old shape
    // walked a 3k-vertex ring up to 960 times for a miss.
    let pieces: Array<{ poly: PolyRings; bbox: Bbox }> = inputPolys.map((poly) => ({
        poly,
        bbox: ringBbox(poly[0]),
    }));
    const featBbox: Bbox = [
        Math.min(...pieces.map((p) => p.bbox[0])),
        Math.min(...pieces.map((p) => p.bbox[1])),
        Math.max(...pieces.map((p) => p.bbox[2])),
        Math.max(...pieces.map((p) => p.bbox[3])),
    ];
    const holes = bboxes.filter((hole) => bboxesIntersect(featBbox, hole));
    if (holes.length === 0) return feature;

    let touched = false;
    for (const hole of holes) {
        const next: Array<{ poly: PolyRings; bbox: Bbox }> = [];
        for (const piece of pieces) {
            if (!bboxesIntersect(piece.bbox, hole)) {
                next.push(piece);
                continue;
            }
            touched = true;
            if (bboxInside(piece.bbox, hole)) continue; // swallowed whole
            for (const rect of outsidePartition(piece.bbox, hole)) {
                const clipped = clipPolyToRect(piece.poly, rect);
                // Clip output is bounded by rect ∩ old bbox — a tight-enough
                // bbox for later intersection tests without re-walking rings.
                if (clipped) {
                    next.push({
                        poly: clipped,
                        bbox: [
                            Math.max(piece.bbox[0], rect[0]),
                            Math.max(piece.bbox[1], rect[1]),
                            Math.min(piece.bbox[2], rect[2]),
                            Math.min(piece.bbox[3], rect[3]),
                        ],
                    });
                }
            }
        }
        pieces = next;
        if (pieces.length === 0) return null;
    }
    if (!touched) return feature;

    const geometry: MultiPolygon | Polygon =
        pieces.length === 1
            ? { type: 'Polygon', coordinates: pieces[0].poly }
            : { type: 'MultiPolygon', coordinates: pieces.map((p) => p.poly) };
    return { ...feature, geometry };
}
