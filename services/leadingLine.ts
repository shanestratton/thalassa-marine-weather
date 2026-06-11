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
    /** Capture point on the outermost transit's seaward extension — the
     *  route's divert target ("stand off, then get on the leads"). */
    anchor: LatLon;
    /** The sailed transit run: [anchor, turn(s)…, breakOff, dest]. Every
     *  vertex lies on a transit LINE in open water — never at a beacon. */
    chain: LatLon[];
    /** How many leading lines the approach uses (1 = single transit,
     *  2 = a dog-leg). */
    lineCount: number;
}

/**
 * Build the charted leading-line APPROACH to a destination as the skipper
 * actually sails it. A leading line's charted geometry is the segment between
 * its two BEACONS — which routinely stand ON shore or drying banks. You never
 * sail to a beacon: you sail the transit LINE (the marks kept in line),
 * offset seaward of them. So the approach is built from transit-line
 * geometry, not mark positions:
 *
 *   • breakOff = the destination projected onto the inner transit line —
 *     ride the lead until abeam the anchorage, then break off.
 *   • For a dog-leg, the turn = the INTERSECTION of the two transit lines;
 *     you ride the outer transit to the turn, then the inner transit in.
 *   • anchor = a capture point `captureM` back along the outer transit's
 *     seaward extension — where the route joins the lead.
 *
 * A line "serves" the destination when its nearer end is within `maxDestM`.
 * Returns null when no leading line serves the destination (normal routing).
 */
export function buildLeadingApproach(
    dest: LatLon,
    lines: LeadingLine[],
    opts: { maxDestM?: number; linkM?: number; captureM?: number } = {},
): LeadingApproach | null {
    const maxDestM = opts.maxDestM ?? 1500;
    const linkM = opts.linkM ?? 1800;
    const captureM = opts.captureM ?? 800;
    if (lines.length === 0) return null;

    // Local planar metres around the destination (the whole approach spans a
    // few km at most — equirectangular is plenty).
    const mPerLat = 110_540;
    const mPerLon = 111_320 * Math.cos((dest.lat * Math.PI) / 180);
    const toM = (p: LatLon): { x: number; y: number } => ({
        x: (p.lon - dest.lon) * mPerLon,
        y: (p.lat - dest.lat) * mPerLat,
    });
    const fromM = (m: { x: number; y: number }): LatLon => ({
        lat: dest.lat + m.y / mPerLat,
        lon: dest.lon + m.x / mPerLon,
    });

    interface Oriented {
        seaward: LatLon;
        landward: LatLon;
    }
    // Orient each line: landward = the end nearer the destination. (Used for
    // serving/chaining and the OUTER sail direction; the inner sail direction
    // is derived from the turn geometry, which is robust even when the
    // destination lies between the inner marks.)
    const oriented: Oriented[] = lines
        .filter((l) => l.pts.length >= 2 && distM(l.pts[0], l.pts[l.pts.length - 1]) > 10)
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

    // Find the OUTER lead of a dog-leg: the line whose landward end links to
    // the inner's seaward end within linkM (the charted hand-off).
    let outer: Oriented | null = null;
    let outerD = linkM;
    for (const o of oriented) {
        if (o === inner) continue;
        const d = distM(o.landward, inner.seaward);
        if (d < outerD) {
            outerD = d;
            outer = o;
        }
    }

    // Inner transit line (point + unit direction, metres).
    const iA = toM(inner.seaward);
    const iB = toM(inner.landward);
    const iLen = Math.hypot(iB.x - iA.x, iB.y - iA.y);
    const iDir = { x: (iB.x - iA.x) / iLen, y: (iB.y - iA.y) / iLen };
    // breakOff = dest (origin) projected onto the inner transit line.
    const tBreak = -(iA.x * iDir.x + iA.y * iDir.y);
    const breakM = { x: iA.x + iDir.x * tBreak, y: iA.y + iDir.y * tBreak };
    // Sanity: the lead must actually point at the anchorage.
    if (Math.hypot(breakM.x, breakM.y) > maxDestM) return null;
    const breakOff = fromM(breakM);

    if (outer) {
        // Dog-leg: turn at the intersection of the two transit lines.
        const oA = toM(outer.seaward);
        const oB = toM(outer.landward);
        const oLen = Math.hypot(oB.x - oA.x, oB.y - oA.y);
        const oDir = { x: (oB.x - oA.x) / oLen, y: (oB.y - oA.y) / oLen };
        const denom = oDir.x * iDir.y - oDir.y * iDir.x;
        if (Math.abs(denom) > 1e-6) {
            // Solve oA + s·oDir = iA + t·iDir.
            const dx = iA.x - oA.x;
            const dy = iA.y - oA.y;
            const s = (dx * iDir.y - dy * iDir.x) / denom;
            const turnM = { x: oA.x + oDir.x * s, y: oA.y + oDir.y * s };
            const turnToBreakM = Math.hypot(breakM.x - turnM.x, breakM.y - turnM.y);
            // Course change at the turn: outer sail dir (toward its marks)
            // onto the run-in dir (turn → breakOff).
            const inDir = { x: (breakM.x - turnM.x) / turnToBreakM, y: (breakM.y - turnM.y) / turnToBreakM };
            const cosTurn = oDir.x * inDir.x + oDir.y * inDir.y;
            // A genuine dog-leg: a real run between turn and break-off, and a
            // moderate course change (< ~120°). Degenerate → single-lead.
            if (turnToBreakM > 50 && turnToBreakM < 5000 && cosTurn > -0.5) {
                const anchorM = { x: turnM.x - oDir.x * captureM, y: turnM.y - oDir.y * captureM };
                const anchor = fromM(anchorM);
                return { anchor, chain: [anchor, fromM(turnM), breakOff, dest], lineCount: 2 };
            }
        }
    }

    // Single transit: capture point captureM seaward of the break-off along
    // the inner transit's seaward extension.
    const anchorM = { x: breakM.x - iDir.x * captureM, y: breakM.y - iDir.y * captureM };
    const anchor = fromM(anchorM);
    return { anchor, chain: [anchor, breakOff, dest], lineCount: 1 };
}
