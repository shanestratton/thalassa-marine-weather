/**
 * Triangle mesh → polygon rings.
 *
 * Why this exists
 * ───────────────
 * A SENC stores AREA features as a pre-tessellated triangle mesh — that IS the
 * format; it is a render cache, not a topology store. `featureParser` (the
 * oeSENC path) recovers real polygon rings from the edge-vector index the
 * oeSENC ships alongside. A SENC with no such index reaches the app as raw
 * triangles unless something rebuilds the rings, which is what this does.
 * (It was written for the S-63 parser, retired in 127: S-63 opens in OpenCPN
 * only. It stays as a general mesh tool with its own tests.)
 *
 * Measured on a mesh-only cell in 2026-08: DEPARE arrived as hundreds of
 * features made of ~100k triangles and ZERO rings. Rendered, that is ~100k
 * separately-antialiased fills (shattered, streaky water) plus thousands of
 * near-zero slivers and some zero-area triangles.
 *
 * How it works
 * ────────────
 * Boundary extraction, not re-triangulation. Every interior edge of a
 * consistently-wound mesh appears exactly twice, once in each direction
 * (a→b in one triangle, b→a in its neighbour). Cancel those pairs and what
 * remains is precisely the outline, already correctly oriented: outer rings
 * wind one way, holes the other. No geometry is invented and no vertex moves,
 * so the result is the same shape the chart author drew.
 *
 * This is deliberately independent of SENC internals — it works on the
 * triangles we already have, so it needs no new parsing of the encrypted
 * format and is unit-testable without a chart, a dongle or a Pi.
 */

export type Pt = [number, number];
export type Tri = [Pt, Pt, Pt];
/** One polygon: outer ring first, then any holes (S-57/GeoJSON convention). */
export type PolygonRings = Pt[][];

/**
 * Vertex snapping grid, in degrees. ~1e-9° is about 0.1 mm — far below any
 * charted precision, so this cannot move a vertex meaningfully, but it makes
 * shared vertices compare EXACTLY. Adjacent triangles usually carry
 * bit-identical coordinates (same source vertex, same Mercator conversion),
 * but a single ULP of difference would leave an interior edge uncancelled and
 * tear a false hole through the middle of a depth area.
 */
const QUANT = 1e9;

const q = (v: number): number => Math.round(v * QUANT);
const keyOf = (p: Pt): string => `${q(p[0])},${q(p[1])}`;

/** Twice the signed area of a ring. Positive = counter-clockwise. */
export function signedArea2(ring: Pt[]): number {
    let sum = 0;
    for (let i = 0; i < ring.length - 1; i++) {
        sum += ring[i][0] * ring[i + 1][1] - ring[i + 1][0] * ring[i][1];
    }
    return sum;
}

/** Even-odd point-in-ring. Used only to nest holes inside their outer ring. */
function pointInRing(pt: Pt, ring: Pt[]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 2; i < ring.length - 1; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if (yi > pt[1] !== yj > pt[1] && pt[0] < ((xj - xi) * (pt[1] - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

/**
 * Dissolve a triangle mesh into polygon rings.
 *
 * Returns null when the mesh cannot be resolved into a sane outline — the
 * caller must then keep the triangles. Failing closed matters: a half-built
 * outline would silently redraw a depth area with the wrong shape, and a
 * wrongly-shaped depth area is a grounding, not a cosmetic bug.
 */
export function meshToPolygons(triangles: Tri[]): PolygonRings[] | null {
    if (triangles.length === 0) return null;

    // ── 1. Drop degenerate triangles ──────────────────────────────────
    // A zero-area triangle contributes edges that cannot cancel (its two
    // identical vertices make a self-edge), which would leave spurs hanging
    // off the boundary. They carry no area, so dropping them changes nothing
    // about the shape — and they are exactly the slivers that rendered as
    // dark streaks.
    const coords = new Map<string, Pt>();
    const directed = new Map<string, number>();
    let kept = 0;
    let meshArea2 = 0;

    for (const tri of triangles) {
        const k = [keyOf(tri[0]), keyOf(tri[1]), keyOf(tri[2])];
        if (k[0] === k[1] || k[1] === k[2] || k[0] === k[2]) continue;
        const a2 =
            (tri[1][0] - tri[0][0]) * (tri[2][1] - tri[0][1]) - (tri[2][0] - tri[0][0]) * (tri[1][1] - tri[0][1]);
        if (a2 === 0) continue;
        kept++;
        meshArea2 += Math.abs(a2);
        for (let i = 0; i < 3; i++) coords.set(k[i], tri[i]);

        // ── 2. Cancel interior edges ──────────────────────────────────
        // Walk each triangle in ITS OWN winding order. If the opposite
        // direction is already outstanding, the two triangles share this edge
        // — cancel both. Otherwise it is outstanding until a neighbour claims
        // it. What survives is the boundary.
        //
        // Winding is normalised per triangle rather than assumed: the SENC
        // ships GL_TRIANGLE_STRIP and _FAN primitives, and a strip alternates
        // orientation every other triangle. A parser may already swap odd
        // strip triangles, but normalising here means this module is correct
        // for any mesh handed to it rather than relying on that.
        const [i0, i1, i2] = a2 > 0 ? [0, 1, 2] : [0, 2, 1];
        const order = [k[i0], k[i1], k[i2]];
        for (let i = 0; i < 3; i++) {
            const from = order[i];
            const to = order[(i + 1) % 3];
            const opposite = `${to}|${from}`;
            const outstanding = directed.get(opposite) ?? 0;
            if (outstanding > 0) {
                if (outstanding === 1) directed.delete(opposite);
                else directed.set(opposite, outstanding - 1);
            } else {
                const self = `${from}|${to}`;
                directed.set(self, (directed.get(self) ?? 0) + 1);
            }
        }
    }

    if (kept === 0) return null;

    // ── 3. Chain the surviving edges into closed loops ────────────────
    const next = new Map<string, string[]>();
    for (const [edge, count] of directed) {
        const sep = edge.indexOf('|');
        const from = edge.slice(0, sep);
        const to = edge.slice(sep + 1);
        const list = next.get(from) ?? [];
        for (let i = 0; i < count; i++) list.push(to);
        next.set(from, list);
    }

    const loops: Pt[][] = [];
    for (const start of Array.from(next.keys())) {
        while ((next.get(start)?.length ?? 0) > 0) {
            const ring: Pt[] = [];
            let cursor = start;
            // Bounded by the edge count: a malformed mesh must not spin here.
            for (let guard = 0; guard <= directed.size + 1; guard++) {
                const outs = next.get(cursor);
                if (!outs || outs.length === 0) break;
                const step = outs.pop() as string;
                const pt = coords.get(cursor);
                if (!pt) return null;
                ring.push(pt);
                cursor = step;
                if (cursor === start) {
                    const first = coords.get(start);
                    if (!first) return null;
                    ring.push(first);
                    break;
                }
            }
            // An unclosed chain means the mesh was not manifold. Rather than
            // emit a torn outline, hand the whole feature back as triangles.
            if (ring.length < 4 || keyOf(ring[0]) !== keyOf(ring[ring.length - 1])) return null;
            loops.push(ring);
        }
    }
    if (loops.length === 0) return null;

    // ── 4. Sort outers from holes, then nest ──────────────────────────
    // Winding was normalised in step 2, so an outer boundary comes out
    // counter-clockwise and a hole clockwise. No containment test is needed
    // to CLASSIFY them — only to decide which outer each hole belongs to.
    const outers: { ring: Pt[]; area2: number; holes: Pt[][] }[] = [];
    const holes: Pt[][] = [];
    for (const ring of loops) {
        const a2 = signedArea2(ring);
        if (a2 > 0) outers.push({ ring, area2: a2, holes: [] });
        else if (a2 < 0) holes.push(ring);
    }
    if (outers.length === 0) return null;

    for (const hole of holes) {
        // Smallest containing outer wins — an island inside a lake inside an
        // island nests correctly that way.
        let best: (typeof outers)[number] | null = null;
        for (const outer of outers) {
            if (!pointInRing(hole[0], outer.ring)) continue;
            if (!best || outer.area2 < best.area2) best = outer;
        }
        // A hole belonging to no outer means the classification is untrustworthy.
        if (!best) return null;
        best.holes.push(hole);
    }

    // ── 5. Area check ─────────────────────────────────────────────────
    // The outline must enclose the same area the triangles covered. This is
    // the guard that catches a plausible-looking but wrong reconstruction —
    // exactly the "chained a ring across half the chart" failure the oeSENC
    // path documents. 0.1% tolerance absorbs quantisation only.
    let outlineArea2 = 0;
    for (const outer of outers) {
        outlineArea2 += Math.abs(outer.area2);
        for (const hole of outer.holes) outlineArea2 -= Math.abs(signedArea2(hole));
    }
    if (meshArea2 === 0) return null;
    if (Math.abs(outlineArea2 - meshArea2) / meshArea2 > 0.001) return null;

    return outers.map((outer) => [outer.ring, ...outer.holes]);
}
