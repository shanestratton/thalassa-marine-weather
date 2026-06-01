/**
 * leadingLine — charted leading-line (transit) follower. The routing-stack
 * refinement that snaps a route onto the EXACT charted navigation_line where
 * it transits one, so the track follows correct vessel procedure: line up the
 * two leading marks and steer the transit. Runs AFTER the A* route + Fairlead.
 *
 * A leading line (OSM `seamark:type=navigation_line`, category=leading) is a
 * straight charted transit: two marks you keep aligned to stay mid-channel.
 * The engine's Pass 5b already ATTRACTS A* toward these lines (a ~150 m
 * preferred corridor); this module SNAPS the route onto the line itself, so
 * instead of "near the channel" you get "dead on the transit" — the way a
 * skipper actually steers a leading line.
 *
 * Self-contained pure functions over lat/lon (no engine import) so they can be
 * parity-tested in isolation — same pattern as fairlead.ts.
 */

export interface LatLon {
    lat: number;
    lon: number;
}

/** A charted leading line = its polyline geometry (≥2 points). Leading lines
 *  are straight, but a multi-vertex transit is tolerated. */
export interface LeadingLine {
    pts: LatLon[];
}

/** Minimal GeoJSON-ish shape so this module needn't depend on @types/geojson. */
interface LineFeatureLike {
    geometry?: { type?: string; coordinates?: unknown } | null;
    properties?: Record<string, unknown> | null;
}

/** Metres between two lat/lon (local equirectangular — fine at channel scale). */
export function distM(a: LatLon, b: LatLon): number {
    const mPerLat = 110_540;
    const mPerLon = 111_320 * Math.cos((a.lat * Math.PI) / 180);
    return Math.hypot((b.lon - a.lon) * mPerLon, (b.lat - a.lat) * mPerLat);
}

/** Bearing (degrees, [0,360)) from a→b in local planar metres. */
function bearingDeg(a: LatLon, b: LatLon): number {
    const mPerLat = 110_540;
    const mPerLon = 111_320 * Math.cos((a.lat * Math.PI) / 180);
    const dx = (b.lon - a.lon) * mPerLon;
    const dy = (b.lat - a.lat) * mPerLat;
    let deg = (Math.atan2(dx, dy) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    return deg;
}

/** Smallest angular difference (degrees) treating both as UNDIRECTED lines, so
 *  10° and 190° are 0° apart. Range [0,90]. */
function lineAngleDiffDeg(a: number, b: number): number {
    let d = Math.abs(a - b) % 180;
    if (d > 90) d = 180 - d;
    return d;
}

/** Project p onto segment a→b; closest point + its distance from p. */
function projectToSegment(p: LatLon, a: LatLon, b: LatLon): { point: LatLon; dist: number } {
    const mLat = 110_540;
    const mLon = 111_320 * Math.cos((a.lat * Math.PI) / 180);
    const bx = (b.lon - a.lon) * mLon;
    const by = (b.lat - a.lat) * mLat;
    const px = (p.lon - a.lon) * mLon;
    const py = (p.lat - a.lat) * mLat;
    const len2 = bx * bx + by * by;
    let t = len2 > 0 ? (px * bx + py * by) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const point = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
    return { point, dist: distM(p, point) };
}

/** Nearest point on a (multi-segment) line to p. */
function projectToLine(p: LatLon, line: LatLon[]): { point: LatLon; dist: number } {
    let best = { point: line[0], dist: Infinity };
    for (let i = 0; i < line.length - 1; i++) {
        const pr = projectToSegment(p, line[i], line[i + 1]);
        if (pr.dist < best.dist) best = pr;
    }
    return best;
}

/** True if any point sampled ~every stepM along the polyline satisfies pred. */
export function anyAlong(pts: LatLon[], stepM: number, pred: (p: LatLon) => boolean): boolean {
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i];
        const b = pts[i + 1];
        const n = Math.max(1, Math.ceil(distM(a, b) / stepM));
        for (let k = 0; k <= n; k++) {
            const t = k / n;
            if (pred({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t })) return true;
        }
    }
    return false;
}

/** Total along-path length (metres) of poly[from..to] inclusive. */
function runLengthM(poly: LatLon[], from: number, to: number): number {
    let m = 0;
    for (let i = from; i < to; i++) m += distM(poly[i], poly[i + 1]);
    return m;
}

/**
 * Parse OSM NAVLINE features (LineString/MultiLineString) into leading lines.
 * The Pi already filters out `category=clearing` at emission, so every NAVLINE
 * feature reaching the engine is a leading/transit line we can snap onto.
 */
export function parseLeadingLines(features: LineFeatureLike[]): LeadingLine[] {
    const out: LeadingLine[] = [];
    for (const f of features) {
        const g = f.geometry;
        if (!g || !Array.isArray(g.coordinates)) continue;
        const rings: number[][][] =
            g.type === 'LineString'
                ? [g.coordinates as number[][]]
                : g.type === 'MultiLineString'
                  ? (g.coordinates as number[][][])
                  : [];
        for (const coords of rings) {
            const pts: LatLon[] = coords
                .filter((c) => Array.isArray(c) && c.length >= 2 && Number.isFinite(c[0]) && Number.isFinite(c[1]))
                .map((c) => ({ lat: c[1], lon: c[0] }));
            if (pts.length >= 2) out.push({ pts });
        }
    }
    return out;
}

export interface SnapOptions {
    /** Route vertex within this of a line counts as "on the corridor". */
    corridorM?: number;
    /** Minimum transit length to snap (avoid snapping a brush-by). */
    minRunM?: number;
    /** Max UNDIRECTED angle between the route run and the line for it to count
     *  as a genuine transit (vs a perpendicular crossing). */
    maxAngleDeg?: number;
    /** Hard land (NaN/out-of-grid) test. The spliced run is validated against
     *  it — never snap a transit across solid land. */
    isBlocked?: (p: LatLon) => boolean;
    /** Caution (shallow/soft) test. Used only to flag the on-line segment's
     *  caution HONESTLY — it stays red if the transit genuinely crosses caution
     *  water, clean where Pass 5b rescued the leading-line corridor. */
    isCaution?: (p: LatLon) => boolean;
}

export interface SnapResult {
    polyline: LatLon[];
    cautionMask: boolean[];
    /** Number of leading lines the route was snapped onto. */
    snapped: number;
}

/**
 * Snap a route onto the charted leading lines it transits. For each line, find
 * the contiguous run of route vertices that hugs it (within `corridorM`), is
 * long enough (`minRunM`) and roughly parallel (`maxAngleDeg`), then replace
 * that run with the straight on-line segment between the run's projected
 * endpoints — the literal transit. The route's first/last vertices (origin and
 * destination) are NEVER moved. The spliced run is validated against
 * `isBlocked`; any solid-land crossing aborts that snap and leaves the route.
 *
 * The cautionMask is carried through: the on-line segment is flagged caution
 * only if it genuinely crosses caution water — so a snapped transit goes from
 * red "near the channel" to clean "on the channel", honestly.
 */
export function snapToLeadingLines(
    polyline: LatLon[],
    cautionMask: boolean[],
    lines: LeadingLine[],
    opts: SnapOptions = {},
): SnapResult {
    const corridorM = opts.corridorM ?? 120;
    const minRunM = opts.minRunM ?? 150;
    const maxAngleDeg = opts.maxAngleDeg ?? 35;
    const { isBlocked, isCaution } = opts;

    let poly = polyline.slice();
    let caution = cautionMask.slice();
    let snapped = 0;

    for (const line of lines) {
        // Need ≥4 vertices so clamping to the interior still leaves a real run.
        if (poly.length < 4 || line.pts.length < 2) continue;

        // Which route vertices hug this line?
        const near = poly.map((v) => projectToLine(v, line.pts).dist < corridorM);

        // Longest contiguous run of `near`.
        let bestStart = -1;
        let bestEnd = -1;
        let i = 0;
        while (i < near.length) {
            if (!near[i]) {
                i++;
                continue;
            }
            let j = i;
            while (j + 1 < near.length && near[j + 1]) j++;
            if (j - i > bestEnd - bestStart) {
                bestStart = i;
                bestEnd = j;
            }
            i = j + 1;
        }
        if (bestStart < 0) continue;

        // Keep origin + destination fixed: clamp the run to the interior.
        const runStart = Math.max(1, bestStart);
        const runEnd = Math.min(poly.length - 2, bestEnd);
        if (runStart >= runEnd) continue;

        // Long enough to be a genuine transit, not a momentary brush-by?
        if (runLengthM(poly, runStart, runEnd) < minRunM) continue;

        // Roughly parallel to the line (else it's a perpendicular crossing)?
        const runBearing = bearingDeg(poly[runStart], poly[runEnd]);
        const lineBearing = bearingDeg(line.pts[0], line.pts[line.pts.length - 1]);
        if (lineAngleDiffDeg(runBearing, lineBearing) > maxAngleDeg) continue;

        // Project the run endpoints onto the line → the on-line transit segment.
        const projA = projectToLine(poly[runStart], line.pts).point;
        const projB = projectToLine(poly[runEnd], line.pts).point;

        // Never snap across solid land. Validate entry-bridge + transit +
        // exit-bridge against hard-blocked water (caution is allowed — the
        // approach to a leading line is often shallow).
        const spliced = [poly[runStart - 1], projA, projB, poly[runEnd + 1]];
        if (isBlocked && anyAlong(spliced, 25, isBlocked)) continue;

        // Honest caution: the on-line transit stays red only if it actually
        // crosses caution water (it won't, where Pass 5b rescued the corridor).
        const onLineCaution = isCaution ? anyAlong([projA, projB], 25, isCaution) : false;

        // Splice: replace vertices [runStart..runEnd] with [projA, projB].
        //   newPoly    = poly[0..runStart-1] + projA + projB + poly[runEnd+1..]
        //   newCaution = caution[0..runStart-1] + onLineCaution + caution[runEnd..]
        // (lengths reconcile: the run's interior vertices collapse to the
        //  straight on-line segment; both endpoints' bridges keep their caution.)
        poly = [...poly.slice(0, runStart), projA, projB, ...poly.slice(runEnd + 1)];
        caution = [...caution.slice(0, runStart), onLineCaution, ...caution.slice(runEnd)];
        snapped++;
    }

    return { polyline: poly, cautionMask: caution, snapped };
}

export interface LeadingApproach {
    /** Seaward end of the outermost serving leading line — the route's divert
     *  target ("make the seaward mark"). */
    anchor: LatLon;
    /** The full transit run, seaward→landward, ending at the destination:
     *  [anchor, outer.landward, …, inner.seaward, inner.landward, dest]. */
    chain: LatLon[];
    /** How many leading lines the approach chains through (1 = single transit,
     *  2 = a dog-leg). */
    lineCount: number;
}

/**
 * Build the charted leading-line APPROACH to a destination: the seaward anchor
 * the route should make for, plus the transit chain that runs the leads in.
 *
 * A leading line "serves" the destination when its LANDWARD end (the end nearer
 * the destination) is within `maxDestM`. From the innermost serving line we
 * chain OUTWARD — each next line's landward end links to the running seaward
 * frontier within `linkM` — to follow a dog-leg out to the seaward mark. The
 * route then approaches via that mark and steers each transit in, the way a
 * skipper plans it: "make the seaward mark, get on the leads, run her in."
 *
 * Returns null when no leading line serves the destination (normal routing).
 */
export function buildLeadingApproach(
    dest: LatLon,
    lines: LeadingLine[],
    opts: { maxDestM?: number; linkM?: number } = {},
): LeadingApproach | null {
    const maxDestM = opts.maxDestM ?? 1500;
    const linkM = opts.linkM ?? 1800;
    if (lines.length === 0) return null;

    interface Oriented {
        seaward: LatLon;
        landward: LatLon;
    }
    // Orient each line: landward = the end nearer the destination.
    const oriented: Oriented[] = lines
        .filter((l) => l.pts.length >= 2)
        .map((l) => {
            const a = l.pts[0];
            const b = l.pts[l.pts.length - 1];
            return distM(a, dest) <= distM(b, dest) ? { landward: a, seaward: b } : { landward: b, seaward: a };
        });

    // Serving lines: landward end within maxDestM of the destination.
    const serving = oriented.filter((o) => distM(o.landward, dest) <= maxDestM);
    if (serving.length === 0) return null;

    // Innermost = the serving line whose landward end is nearest the destination.
    serving.sort((p, q) => distM(p.landward, dest) - distM(q.landward, dest));
    const inner = serving[0];

    // Chain outward from the seaward frontier through lines whose landward end
    // links to it (the dog-leg).
    const used = new Set<Oriented>([inner]);
    const innerToOuter: Oriented[] = [inner];
    let frontier = inner.seaward;
    for (let guard = 0; guard < oriented.length; guard++) {
        let best: Oriented | null = null;
        let bestD = linkM;
        for (const o of oriented) {
            if (used.has(o)) continue;
            const d = distM(o.landward, frontier);
            if (d < bestD) {
                bestD = d;
                best = o;
            }
        }
        if (!best) break;
        used.add(best);
        innerToOuter.push(best);
        frontier = best.seaward;
    }

    const seawardToInner = innerToOuter.slice().reverse(); // [outermost, …, inner]
    const anchor = seawardToInner[0].seaward;
    const chain: LatLon[] = [];
    for (const o of seawardToInner) chain.push(o.seaward, o.landward);
    chain.push(dest);
    return { anchor, chain, lineCount: seawardToInner.length };
}
