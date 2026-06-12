/**
 * Route-quality scorecard — Masterplan Stage I, Phase 1.
 *
 * Pure geometry metrics that turn "the route follows seamanship rules"
 * into numbers. The headline metric is wrongSidePasses — the owner's
 * complaint ("it won't follow red/green marker pairs") as an integer
 * with target 0. Every masterplan phase is verified as a scorecard
 * delta; Stage IV's Seaway Graph is promoted on these numbers, not vibes.
 *
 * All functions are pure and synchronous. Geometry runs on a local
 * equirectangular projection (metres, centred on the data) — exact
 * enough at fixture scale (<100 km) and keeps segment intersection
 * trivially planar.
 */

export interface LatLon {
    lat: number;
    lon: number;
}

/** A lateral-mark gate: the route should pass BETWEEN port and stbd. */
export interface Gate {
    port: LatLon;
    stbd: LatLon;
}

export type Polyline = [number, number][]; // [lon, lat] — GeoJSON convention

// ── Projection + primitives ─────────────────────────────────────────

const M_PER_DEG_LAT = 110_540;
const M_PER_DEG_LON_EQ = 111_320;

interface XY {
    x: number;
    y: number;
}

/** Local equirectangular projector centred on `ref` (metres). */
export function projector(ref: LatLon): (p: LatLon) => XY {
    const mPerLon = M_PER_DEG_LON_EQ * Math.cos((ref.lat * Math.PI) / 180);
    return (p) => ({ x: (p.lon - ref.lon) * mPerLon, y: (p.lat - ref.lat) * M_PER_DEG_LAT });
}

export function haversineM(a: LatLon, b: LatLon): number {
    const R = 6371000;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const s =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
}

const toLatLon = (pt: [number, number]): LatLon => ({ lat: pt[1], lon: pt[0] });

export function polylineLengthM(polyline: Polyline): number {
    let len = 0;
    for (let i = 0; i < polyline.length - 1; i++) len += haversineM(toLatLon(polyline[i]), toLatLon(polyline[i + 1]));
    return len;
}

/** Proper segment intersection (planar), inclusive of touching endpoints. */
function segmentsIntersect(p1: XY, p2: XY, q1: XY, q2: XY): boolean {
    const orient = (a: XY, b: XY, c: XY): number => {
        const v = (b.y - a.y) * (c.x - b.x) - (b.x - a.x) * (c.y - b.y);
        if (Math.abs(v) < 1e-9) return 0;
        return v > 0 ? 1 : 2;
    };
    const onSeg = (a: XY, b: XY, c: XY): boolean =>
        Math.min(a.x, b.x) - 1e-9 <= c.x &&
        c.x <= Math.max(a.x, b.x) + 1e-9 &&
        Math.min(a.y, b.y) - 1e-9 <= c.y &&
        c.y <= Math.max(a.y, b.y) + 1e-9;

    const o1 = orient(p1, p2, q1);
    const o2 = orient(p1, p2, q2);
    const o3 = orient(q1, q2, p1);
    const o4 = orient(q1, q2, p2);
    if (o1 !== o2 && o3 !== o4) return true;
    if (o1 === 0 && onSeg(p1, p2, q1)) return true;
    if (o2 === 0 && onSeg(p1, p2, q2)) return true;
    if (o3 === 0 && onSeg(q1, q2, p1)) return true;
    if (o4 === 0 && onSeg(q1, q2, p2)) return true;
    return false;
}

/** Distance from point c to segment ab (planar metres). */
function pointToSegmentM(c: XY, a: XY, b: XY): number {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const l2 = dx * dx + dy * dy;
    if (l2 === 0) return Math.hypot(c.x - a.x, c.y - a.y);
    let t = ((c.x - a.x) * dx + (c.y - a.y) * dy) / l2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(c.x - (a.x + t * dx), c.y - (a.y + t * dy));
}

function pointToPolylineM(c: XY, line: XY[]): number {
    let best = Infinity;
    for (let i = 0; i < line.length - 1; i++) best = Math.min(best, pointToSegmentM(c, line[i], line[i + 1]));
    return best;
}

/** Sample points every `stepM` along the route (projected). Includes both ends. */
function sampleRoute(route: XY[], stepM: number): XY[] {
    const out: XY[] = [];
    for (let i = 0; i < route.length - 1; i++) {
        const a = route[i];
        const b = route[i + 1];
        const segLen = Math.hypot(b.x - a.x, b.y - a.y);
        const n = Math.max(1, Math.ceil(segLen / stepM));
        for (let s = 0; s < n; s++) {
            const t = s / n;
            out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        }
    }
    out.push(route[route.length - 1]);
    return out;
}

// ── Gate audit — the headline metric ────────────────────────────────

export interface GateAudit {
    gatesTotal: number;
    /** Gates the route passed correctly BETWEEN the marks. */
    gatesPassed: number;
    /** Gates the route never engaged (no inner or wing crossing). */
    gatesMissed: number;
    /** THE headline metric: gates passed on the WRONG side — the route
     *  crossed a mark's outboard wing line instead of the gate. Target 0. */
    wrongSidePasses: number;
}

/**
 * Audit the route against lateral-mark gates.
 *
 * For each gate, three crossing lines are constructed (projected metres):
 *   - the INNER gate segment port↔stbd → crossing it = a correct pass;
 *   - a wing extending OUTBOARD from each mark along the pair axis
 *     (length `wingLenM`, masterplan: clamp(pairDistM, 60..150)) →
 *     crossing a wing = passing outside that mark = wrongSidePass.
 * A gate that the route crosses on BOTH (clipped a mark exactly) counts
 * as wrong-side — conservative by design.
 */
export function auditGates(polyline: Polyline, gates: Gate[], opts: { wingLenM?: number } = {}): GateAudit {
    if (gates.length === 0) return { gatesTotal: 0, gatesPassed: 0, gatesMissed: 0, wrongSidePasses: 0 };
    const ref = gates[0].port;
    const proj = projector(ref);
    const route = polyline.map((p) => proj(toLatLon(p)));

    let passed = 0;
    let missed = 0;
    let wrong = 0;

    for (const g of gates) {
        const P = proj(g.port);
        const S = proj(g.stbd);
        const pairDistM = Math.hypot(S.x - P.x, S.y - P.y);
        const wingLen = opts.wingLenM ?? Math.min(150, Math.max(60, pairDistM));
        const ux = pairDistM === 0 ? 1 : (S.x - P.x) / pairDistM;
        const uy = pairDistM === 0 ? 0 : (S.y - P.y) / pairDistM;
        const portWingEnd: XY = { x: P.x - ux * wingLen, y: P.y - uy * wingLen };
        const stbdWingEnd: XY = { x: S.x + ux * wingLen, y: S.y + uy * wingLen };

        let crossedInner = false;
        let crossedWing = false;
        for (let i = 0; i < route.length - 1; i++) {
            const a = route[i];
            const b = route[i + 1];
            if (!crossedInner && segmentsIntersect(a, b, P, S)) crossedInner = true;
            if (!crossedWing && (segmentsIntersect(a, b, P, portWingEnd) || segmentsIntersect(a, b, S, stbdWingEnd)))
                crossedWing = true;
            if (crossedInner && crossedWing) break;
        }

        if (crossedWing) wrong++;
        else if (crossedInner) passed++;
        else missed++;
    }

    return { gatesTotal: gates.length, gatesPassed: passed, gatesMissed: missed, wrongSidePasses: wrong };
}

// ── Channel discipline + XTE ────────────────────────────────────────

/**
 * Percentage (0–100) of the route's LENGTH lying within `halfWidthM` of
 * the channel centreline. 100 = perfect channel discipline.
 */
export function channelDisciplinePct(
    polyline: Polyline,
    centreline: LatLon[],
    opts: { halfWidthM?: number; stepM?: number } = {},
): number {
    if (polyline.length < 2 || centreline.length < 2) return 0;
    const halfWidthM = opts.halfWidthM ?? 100;
    const stepM = opts.stepM ?? 25;
    const ref = centreline[0];
    const proj = projector(ref);
    const route = polyline.map((p) => proj(toLatLon(p)));
    const centre = centreline.map(proj);
    const samples = sampleRoute(route, stepM);
    let inside = 0;
    for (const s of samples) if (pointToPolylineM(s, centre) <= halfWidthM) inside++;
    return (inside / samples.length) * 100;
}

/** Cross-track-error percentiles (metres) of the route vs the centreline. */
export function xtePercentiles(
    polyline: Polyline,
    centreline: LatLon[],
    opts: { stepM?: number } = {},
): { p50M: number; p95M: number } {
    if (polyline.length < 2 || centreline.length < 2) return { p50M: NaN, p95M: NaN };
    const stepM = opts.stepM ?? 25;
    const ref = centreline[0];
    const proj = projector(ref);
    const route = polyline.map((p) => proj(toLatLon(p)));
    const centre = centreline.map(proj);
    const d = sampleRoute(route, stepM)
        .map((s) => pointToPolylineM(s, centre))
        .sort((a, b) => a - b);
    const pick = (q: number): number => d[Math.min(d.length - 1, Math.floor(q * d.length))];
    return { p50M: pick(0.5), p95M: pick(0.95) };
}

// ── Shape metrics ───────────────────────────────────────────────────

/** Number of heading changes greater than `thresholdDeg` along the route. */
export function turnCount(polyline: Polyline, thresholdDeg = 25): number {
    if (polyline.length < 3) return 0;
    const ref = toLatLon(polyline[0]);
    const proj = projector(ref);
    const pts = polyline.map((p) => proj(toLatLon(p)));
    let count = 0;
    for (let i = 1; i < pts.length - 1; i++) {
        const h1 = Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x);
        const h2 = Math.atan2(pts[i + 1].y - pts[i].y, pts[i + 1].x - pts[i].x);
        let d = Math.abs(((h2 - h1) * 180) / Math.PI);
        if (d > 180) d = 360 - d;
        if (d > thresholdDeg) count++;
    }
    return count;
}

// ── Stepping audit (collab replies 23/26 — marker-stepping field bug) ──

export interface SteppingAudit {
    /** Heading changes ≥ thresholdDeg (default 20°) — raw kink count. */
    kinkCount: number;
    /** Kinks within proximityM (default 150 m) of a gate midpoint — the
     *  bead-on-a-string signature: Pass-5 discs pulling the path into a
     *  dogleg AT each gate. Target after the fairing pass: ~0 on
     *  straight-channel fixtures. */
    kinksNearGate: number;
    /** Consecutive kinks turning in OPPOSITE directions — stair-step
     *  alternation. A faired channel transit has runs of same-sign
     *  curvature; zig-zag alternates. */
    alternationPairs: number;
    /** Sharpest single turn (deg) — catches double-backs (≈180°). */
    maxKinkDeg: number;
}

/**
 * Quantify "stepping through the markers". Definitions match the
 * 2026-06-13 Pinkenba→Newport field repro so engine fixes land against
 * the same numbers the diagnosis used.
 */
export function auditStepping(
    polyline: Polyline,
    gates: Gate[] = [],
    opts: { thresholdDeg?: number; proximityM?: number } = {},
): SteppingAudit {
    const thresholdDeg = opts.thresholdDeg ?? 20;
    const proximityM = opts.proximityM ?? 150;
    if (polyline.length < 3) return { kinkCount: 0, kinksNearGate: 0, alternationPairs: 0, maxKinkDeg: 0 };

    const ref = toLatLon(polyline[0]);
    const proj = projector(ref);
    const pts = polyline.map((p) => proj(toLatLon(p)));
    const mids = gates.map((g) => {
        const P = proj(g.port);
        const S = proj(g.stbd);
        return { x: (P.x + S.x) / 2, y: (P.y + S.y) / 2 };
    });

    let kinkCount = 0;
    let kinksNearGate = 0;
    let alternationPairs = 0;
    let maxKinkDeg = 0;
    let prevSign = 0;
    for (let i = 1; i < pts.length - 1; i++) {
        const v1 = { x: pts[i].x - pts[i - 1].x, y: pts[i].y - pts[i - 1].y };
        const v2 = { x: pts[i + 1].x - pts[i].x, y: pts[i + 1].y - pts[i].y };
        const cross = v1.x * v2.y - v1.y * v2.x;
        const dot = v1.x * v2.x + v1.y * v2.y;
        const turnDeg = (Math.atan2(Math.abs(cross), dot) * 180) / Math.PI;
        if (turnDeg > maxKinkDeg) maxKinkDeg = turnDeg;
        if (turnDeg < thresholdDeg) continue;
        kinkCount++;
        const sign = cross > 0 ? 1 : cross < 0 ? -1 : 0;
        if (prevSign !== 0 && sign !== 0 && sign !== prevSign) alternationPairs++;
        prevSign = sign;
        for (const m of mids) {
            if (Math.hypot(pts[i].x - m.x, pts[i].y - m.y) <= proximityM) {
                kinksNearGate++;
                break;
            }
        }
    }
    return { kinkCount, kinksNearGate, alternationPairs, maxKinkDeg: Math.round(maxKinkDeg * 10) / 10 };
}

/** Lengths (m) of each consecutive run of caution segments. */
export function cautionRunLengthsM(polyline: Polyline, cautionMask?: boolean[]): number[] {
    if (!cautionMask || cautionMask.length === 0) return [];
    const runs: number[] = [];
    let current = 0;
    for (let i = 0; i < Math.min(cautionMask.length, polyline.length - 1); i++) {
        const segLen = haversineM(toLatLon(polyline[i]), toLatLon(polyline[i + 1]));
        if (cautionMask[i]) {
            current += segLen;
        } else if (current > 0) {
            runs.push(current);
            current = 0;
        }
    }
    if (current > 0) runs.push(current);
    return runs;
}

/** Route length / great-circle distance between the request endpoints. */
export function distanceRatio(polyline: Polyline, from: LatLon, to: LatLon): number {
    const direct = haversineM(from, to);
    if (direct === 0) return NaN;
    return polylineLengthM(polyline) / direct;
}

// ── Assembled scorecard ─────────────────────────────────────────────

export interface RouteScore {
    gates: GateAudit;
    channelDisciplinePct: number | null;
    xte: { p50M: number; p95M: number } | null;
    turnCount: number;
    stepping: SteppingAudit;
    cautionRunLengthsM: number[];
    distanceRatio: number;
    lengthM: number;
}

export function scoreRoute(opts: {
    polyline: Polyline;
    from: LatLon;
    to: LatLon;
    cautionMask?: boolean[];
    gates?: Gate[];
    centreline?: LatLon[];
    halfWidthM?: number;
}): RouteScore {
    const { polyline, from, to, cautionMask, gates = [], centreline } = opts;
    return {
        gates: auditGates(polyline, gates),
        channelDisciplinePct: centreline
            ? channelDisciplinePct(polyline, centreline, { halfWidthM: opts.halfWidthM })
            : null,
        xte: centreline ? xtePercentiles(polyline, centreline) : null,
        turnCount: turnCount(polyline),
        stepping: auditStepping(polyline, gates),
        cautionRunLengthsM: cautionRunLengthsM(polyline, cautionMask),
        distanceRatio: distanceRatio(polyline, from, to),
        lengthM: polylineLengthM(polyline),
    };
}
