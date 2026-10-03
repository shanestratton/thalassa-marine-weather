/**
 * Cardinal safe-side clamp — a geometric post-process on the FINAL assembled inshore route.
 *
 * Why this exists (and why a bigger OBSTRN disc didn't work): the route near a cardinal is
 * produced by gate/track followers (tier2:chain straight gate-to-gate, tier2:rectrc charted
 * track) and raw A* slices (tier3:passthrough) that DISCARD the obstacle grid after they run.
 * So no avoidance disc, at any size, can steer those segments. By the time legs are stitched
 * into one polyline they all look identical — `[lon,lat][]` — which is the only layer that can
 * enforce a cardinal's safe side uniformly across every segment type.
 *
 * A cardinal carries an intrinsic safe DIRECTION (CATCAM): an East cardinal ⇒ pass to its EAST.
 * This clamp nudges any route vertex that runs on a cardinal's HAZARD side back onto its safe
 * side. It only ever MOVES vertices (never blocks cells), and it no-ops whenever the safe side
 * is land — so it can never disconnect the route the way an oversized disc could.
 *
 * Mandatory safety guards (from the design review):
 *  1. Zero cardinals ⇒ byte-identical no-op (the golden/repro suites feed no cardinals).
 *  2. Land test uses the SAME signal A* uses (cells=NaN), not landBlocked — so a DEPARE-over-
 *     LNDARE conflict (charted depth under charted land, which A* routes through) doesn't wrongly
 *     forbid the push, while real land + uncharted water (cells=NaN) are still refused.
 *  3. Opposed cardinals (E vs W) that touch the same vertex ⇒ pin it (no last-writer-wins).
 *  4. Only honour a cardinal within CLAMP_BAND_M of the route — farther marks never move it.
 *  5. Canal-RED vertices (via the index-aligned redMask) are never moved.
 *  6. TRUE lateral-pair gate vertices (via gateSegKeys — chain/fairlead only, NOT a tier2
 *     recommended track) are never moved, and protected segments are not densified, so the
 *     downstream segKey-based YELLOW recompute survives.
 */
import type { InshoreLayers, NavGrid } from '../engine/types';
import { mPerDegLon, haversineM, latLonToGrid } from '../engine/geometry';
import {
    navLineLeads,
    parseLeadingLines,
    snapToLeadingLines,
    type LatLon,
    type LeadingLine,
    type SnapOptions,
    type SnapResult,
} from '../leadingLine';

const M_PER_DEG_LAT = 111_320;

export interface CardinalDisc {
    lat: number;
    lon: number;
    /** Safe direction (boat passes on this side). */
    dir: 'n' | 'e' | 's' | 'w';
    radiusM: number;
}

/**
 * A solo lateral mark fed to the same clamp. Side is the CATLAM treat-as side (port-hand /
 * stbd-hand — identical semantics in IALA regions A and B). A lateral's safe side depends on the
 * direction of buoyage: when the caller can derive that direction (the IALA numbering convention —
 * seq ascends FROM seaward — gives it through the mark's channel neighbours), it passes the
 * ABSOLUTE safe vector in `safeVec`, which holds for both inbound AND outbound legs. Without it,
 * the clamp falls back to the route's local travel tangent at the closest approach — correct only
 * when the boat runs WITH the buoyage direction (see `applyDetour`).
 */
export interface LateralClampMark {
    lat: number;
    lon: number;
    side: 'port' | 'stbd';
    /** Absolute safe-side unit vector (east, north), from the derived direction of buoyage. */
    safeVec?: readonly [number, number];
}

// Safe-side unit vectors in (east, north) metres. Mirrors SAFE_ANGLE in InshoreRouter.ts.
const SAFE_VEC: Record<'n' | 'e' | 's' | 'w', readonly [number, number]> = {
    e: [1, 0],
    w: [-1, 0],
    n: [0, 1],
    s: [0, -1],
};

// Only honour a cardinal whose nearest route vertex is within this distance (GUARD 4): a mark
// farther off the track is not this route's to round, so it never displaces it. 700 m (~0.38 NM)
// is large enough to catch a cardinal the route is genuinely passing wide of (Q(3)W ~535 m) but
// small enough to ignore marks off to the side.
const CLAMP_BAND_M = 700;
// Backstop so a single apex push can't run away; the band already bounds it to ≤ CLAMP_BAND_M + CLEARANCE_M.
const MAX_PUSH_M = 800;
const CLEARANCE_M = 90; // the detour's peak offset PAST the safe line, at the closest approach
const RAMP_M = 700; // along-track half-width of the detour curve — larger = gentler bulge
const DENSIFY_M = 25; // sample spacing along the detour bezier
const SMOOTH_ITERS = 24; // moving-average passes that round the raw A* grid-staircase in open water

// ── Lateral (solo red/green) dials ───────────────────────────────────────────────────────────
// A solo lateral only governs the route within roughly a gate-width — tighter than a cardinal's
// open-water band so a mark off to the side (a different channel) never displaces the route.
const LATERAL_BAND_M = 200;
// An opposite-side mark this close ⇒ the two form a channel GATE the chain/fairlead/egress routing
// already threads dead-centre. Clamping one mark of a pair would shove the route off the gate (the
// reverted prototype's failure), so paired marks are dropped before the clamp ever sees them.
const LATERAL_PAIR_DIST_M = 200;
// Only detour when the route is GENUINELY on the wrong side — a small deadband absorbs the global
// smoother's sub-metre jitter so a mark the route already respects stays a byte-identical no-op.
const LATERAL_DEADBAND_M = 10;
// Push a wrong-side solo lateral just onto its safe side (a modest clearance — the mark sits at a
// channel/hazard edge, so a large bulge could overshoot a narrow passage the way a cardinal won't).
const LATERAL_CLEARANCE_M = 30;
// Along-track half-width of a lateral detour — tighter than a cardinal's so the bulge stays local
// to the solo mark and is less likely to ramp into a protected gate/canal vertex (→ a 'prot' bail).
const LATERAL_RAMP_M = 350;

const segKey = (a: readonly [number, number], b: readonly [number, number]): string =>
    `${a[0]}|${a[1]}→${b[0]}|${b[1]}`;

/** Closest point on segment [a,b] to a mark — returns the param t∈[0,1] and the distance (m). */
function closestOnSeg(
    lat: number,
    lon: number,
    a: readonly [number, number],
    b: readonly [number, number],
): { t: number; distM: number } {
    const mPerLon = mPerDegLon(lat);
    const ax = (a[0] - lon) * mPerLon;
    const ay = (a[1] - lat) * M_PER_DEG_LAT;
    const bx = (b[0] - lon) * mPerLon;
    const by = (b[1] - lat) * M_PER_DEG_LAT;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return { t, distM: Math.hypot(ax + t * dx, ay + t * dy) };
}

/**
 * Pull cardinal discs out of OBSTRN. Only `_class:'iala-oriented-hazard'` features carrying a
 * `_cardinalDir` AND the stamped true marker position survive (GUARD 7) — land-bearing-inferred
 * hazards and pair-wings are ignored.
 */
export function parseCardinalDiscs(
    features: ReadonlyArray<{ properties?: Record<string, unknown> | null }>,
): CardinalDisc[] {
    const out: CardinalDisc[] = [];
    for (const f of features ?? []) {
        const p = f?.properties as Record<string, unknown> | null | undefined;
        if (!p || p._class !== 'iala-oriented-hazard') continue;
        const dir = p._cardinalDir;
        if (dir !== 'n' && dir !== 'e' && dir !== 's' && dir !== 'w') continue;
        const lat = Number(p._markerLat);
        const lon = Number(p._markerLon);
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue; // GUARD 7 — never derive from the half-disc centroid
        const radiusM = Number(p._radiusM);
        out.push({ lat, lon, dir, radiusM: Number.isFinite(radiusM) ? radiusM : CLAMP_BAND_M });
    }
    return out;
}

/** Within this of a cardinal its danger's whole half is its wrong side; beyond, only its hazard
 *  quadrant — the leg review's rule (routeTracer CARDINAL_CLEAR_M). */
export const CARDINAL_HALF_M = 90;
/** A cardinal's wrong side reaches this far and no further — the leg review's band (routeTracer
 *  CARDINAL_BAND_M), however far the router's disc reaches (its radius, 400–1000 m, is sized to
 *  reach the route; G2 review, 2026-10-04). */
export const CARDINAL_REACH_M = 400;
/** A leg within this of a charted lead, on its heading (±LEAD_RIDE_DEG), rides it: the transit
 *  the hydrographer drew past the mark outranks its side rule (routeTracer ridingLeadAt). */
const LEAD_RIDE_M = 40;
const LEAD_RIDE_DEG = 30;
/** Sample step for a line's metres on a cardinal's wrong side. */
const WRONG_SIDE_STEP_M = 5;
/** A snap may add at most this on a cardinal's wrong side (sampling noise only). */
const CARDINAL_SNAP_TIE_M = 1;

/** Bearing (rad, atan2(east, north)) from a to b, [lon, lat]. */
const bearingRad = (a: readonly [number, number], b: readonly [number, number]): number =>
    Math.atan2((b[0] - a[0]) * mPerDegLon(a[1]), (b[1] - a[1]) * M_PER_DEG_LAT);

/**
 * Whether a point lies on a cardinal's WRONG SIDE — the one rule the router's mask
 * (cardinalWrongSideMetres) and the leg review (routeTracer validateTraceLeg §2) both read, at
 * every point of a line (G2 review, 2026-10-04: the mask read every point within the disc's radius,
 * the review only a leg's closest point within 400 m, so a leg could be red and refused while its
 * review said clear). Within CARDINAL_REACH_M of the mark and on its danger side: the danger's
 * whole half within CARDINAL_HALF_M, beyond that only its hazard quadrant (±45° of the danger's
 * direction), a centimetre's grace on either line — on the mark's own meridian (for an east
 * cardinal) is a side, on the 45° line the danger's.
 */
export function cardinalWrongSideAt(c: Pick<CardinalDisc, 'lat' | 'lon' | 'dir'>, lon: number, lat: number): boolean {
    const ex = (lon - c.lon) * mPerDegLon(c.lat);
    const ny = (lat - c.lat) * M_PER_DEG_LAT;
    const distM = Math.hypot(ex, ny);
    if (!(distM <= CARDINAL_REACH_M)) return false;
    const safe = SAFE_VEC[c.dir];
    const sideM = ex * safe[0] + ny * safe[1];
    const acrossM = Math.abs(ex * safe[1] - ny * safe[0]);
    return sideM < -0.01 && (distM < CARDINAL_HALF_M || acrossM <= -sideM + 0.01);
}

/**
 * Per segment of `polyline` ([lon, lat]), the metres of it on a cardinal's WRONG SIDE
 * (cardinalWrongSideAt, read every WRONG_SIDE_STEP_M along it; G2, 2026-10-04). A stretch riding a
 * charted lead (`leads`: within 40 m of one and within 30° of its heading) is not counted: the
 * transit outranks the mark's side rule, as in the leg review. On the Pi's cells with no regional
 * marker file, Newport → Rivergate passed 12 m on the WEST side of the river mouth's east cardinal
 * (-27.39651, 153.15337), drawn as channel.
 */
export function cardinalWrongSideMetres(
    polyline: readonly (readonly [number, number])[],
    discs: readonly CardinalDisc[],
    leads: readonly { pts: readonly { lat: number; lon: number }[] }[] = [],
): number[] {
    const out = new Array<number>(Math.max(0, polyline.length - 1)).fill(0);
    if (discs.length === 0) return out;
    const riding = (lon: number, lat: number, brg: number): boolean =>
        leads.some((lead) => {
            let best = Infinity;
            let at = -1;
            for (let i = 1; i < lead.pts.length; i++) {
                const p = lead.pts[i - 1];
                const q = lead.pts[i];
                const d = pointToSegM(lat, lon, [p.lon, p.lat], [q.lon, q.lat]);
                if (d < best) {
                    best = d;
                    at = i;
                }
            }
            if (!(best <= LEAD_RIDE_M)) return false;
            const p = lead.pts[at - 1];
            const q = lead.pts[at];
            let dDeg = Math.abs(((brg - bearingRad([p.lon, p.lat], [q.lon, q.lat])) * 180) / Math.PI) % 180;
            if (dDeg > 90) dDeg = 180 - dDeg;
            return dDeg <= LEAD_RIDE_DEG;
        });
    for (let i = 0; i + 1 < polyline.length; i++) {
        const a = polyline[i];
        const b = polyline[i + 1];
        const near = discs.filter((c) => pointToSegM(c.lat, c.lon, a, b) <= CARDINAL_REACH_M);
        if (near.length === 0) continue;
        const lengthM = haversineM(a[1], a[0], b[1], b[0]);
        const n = Math.max(1, Math.ceil(lengthM / WRONG_SIDE_STEP_M));
        const brg = bearingRad(a, b);
        for (let k = 0; k < n; k++) {
            const t = (k + 0.5) / n;
            const lon = a[0] + (b[0] - a[0]) * t;
            const lat = a[1] + (b[1] - a[1]) * t;
            const wrong = near.some((c) => cardinalWrongSideAt(c, lon, lat));
            if (wrong && !riding(lon, lat, brg)) out[i] += lengthM / n;
        }
    }
    return out;
}

/** The cardinals a route's layers carry (OBSTRN discs) and the charted leads that may ride past
 *  them (CATNAV 3 NAVLNE, RECTRC) — what cardinalWrongSideMetres reads. */
export function cardinalContext(layers: Pick<InshoreLayers, 'OBSTRN' | 'NAVLINE' | 'RECTRC'>): {
    discs: CardinalDisc[];
    leads: LeadingLine[];
} {
    return {
        discs: parseCardinalDiscs(layers.OBSTRN?.features ?? []),
        leads: parseLeadingLines([
            ...navLineLeads(layers.NAVLINE?.features ?? []),
            ...(layers.RECTRC?.features ?? []),
        ] as never),
    };
}

/** Per segment, whether some of it lies on a cardinal's wrong side (cardinalWrongSideMetres). */
export function cardinalWrongSideMask(
    polyline: readonly (readonly [number, number])[],
    layers: Pick<InshoreLayers, 'OBSTRN' | 'NAVLINE' | 'RECTRC'>,
): boolean[] {
    const { discs, leads } = cardinalContext(layers);
    return cardinalWrongSideMetres(polyline, discs, leads).map((m) => m > 0);
}

/** A line's metres on a cardinal's wrong side, in all. */
export function cardinalWrongSideTotalM(
    line: readonly LatLon[],
    discs: readonly CardinalDisc[],
    leads: readonly LeadingLine[],
): number {
    if (discs.length === 0) return 0;
    return cardinalWrongSideMetres(
        line.map((p) => [p.lon, p.lat] as [number, number]),
        discs,
        leads,
    ).reduce((m, x) => m + x, 0);
}

/**
 * snapToLeadingLines one line at a time — the loop it runs over `lines`, so with no cardinal (or
 * none the snaps touch) the result is the same — keeping each line's snap only where it adds no
 * metre on a cardinal's wrong side (G2, 2026-10-04); `refused` counts the lines it kept off. A
 * charted track is snapped with land as its only veto, so its join from the route ran 12 m on the
 * west side of the Brisbane River mouth's east cardinal; the track itself passes 60 m east of it.
 */
export function snapKeepingCardinalSide(
    polyline: LatLon[],
    cautionMask: boolean[],
    lines: readonly LeadingLine[],
    opts: SnapOptions,
    discs: readonly CardinalDisc[],
    leads: readonly LeadingLine[],
): SnapResult & { refused: number } {
    if (discs.length === 0) return { ...snapToLeadingLines(polyline, cautionMask, [...lines], opts), refused: 0 };
    let out: SnapResult & { refused: number } = { polyline, cautionMask, snapped: 0, refused: 0 };
    let was = cardinalWrongSideTotalM(polyline, discs, leads);
    for (const line of lines) {
        const r = snapToLeadingLines(out.polyline, out.cautionMask, [line], opts);
        if (r.snapped === 0) continue;
        const now = cardinalWrongSideTotalM(r.polyline, discs, leads);
        if (now > was + CARDINAL_SNAP_TIE_M) {
            out.refused++;
            continue;
        }
        out = {
            polyline: r.polyline,
            cautionMask: r.cautionMask,
            snapped: out.snapped + r.snapped,
            refused: out.refused,
        };
        was = now;
    }
    return out;
}

/**
 * Un-navigable for the clamp = the same signal A* uses: cells is NaN (blocked). We deliberately do
 * NOT use landBlocked: this area has DEPARE-over-LNDARE conflicts (charted depth UNDER a charted-
 * land polygon) that A* routes straight through — landBlocked flags those as "land" and would wrongly
 * forbid the push onto the cardinal's safe side (Shane's Q(3)W: the "Charted land area" east of it has
 * navigable depth, so cells≥0 there). cells=NaN still catches real land (LNDARE with no depth) and
 * uncharted water, which we correctly refuse to push onto.
 */
function isHardLand(grid: NavGrid, lon: number, lat: number): boolean {
    const { x, y } = latLonToGrid(grid, lat, lon);
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return false;
    return Number.isNaN(grid.cells[y * grid.width + x]);
}

function segCrossesLand(grid: NavGrid, a: readonly [number, number], b: readonly [number, number]): boolean {
    const lenM = haversineM(a[1], a[0], b[1], b[0]);
    const steps = Math.max(1, Math.ceil(lenM / 25));
    for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        if (isHardLand(grid, a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)) return true;
    }
    return false;
}

/** Distance (m) from a mark to a route SEGMENT [a,b] — NOT just its endpoints, so a long sparse
 *  leg (rectrc / gate-astar) passing close is still caught even when both vertices are far away. */
function pointToSegM(lat: number, lon: number, a: readonly [number, number], b: readonly [number, number]): number {
    const mPerLon = mPerDegLon(lat);
    const ax = (a[0] - lon) * mPerLon;
    const ay = (a[1] - lat) * M_PER_DEG_LAT;
    const bx = (b[0] - lon) * mPerLon;
    const by = (b[1] - lat) * M_PER_DEG_LAT;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? -(ax * dx + ay * dy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(ax + t * dx, ay + t * dy);
}

/** A mark generalised for the clamp. A cardinal carries a FIXED absolute safe vector (N/E/S/W); a
 *  lateral carries `safeVec:null` + `side`, and its safe vector is resolved per-detour from the
 *  route's local travel tangent (the IALA side is relative to the direction of buoyage). */
interface MarkSafe {
    lat: number;
    lon: number;
    kind: 'cardinal' | 'lateral';
    safeVec: readonly [number, number] | null;
    side?: 'port' | 'stbd';
}

/**
 * Force the route onto each mark's SAFE side on the final assembled polyline: first a global smooth
 * that rounds the raw A* grid-staircase in open water, then one analytical bezier detour per mark
 * that bulges to clearance at the closest approach and rejoins the track tangentially — smooth AND
 * correct by construction. Handles two mark kinds:
 *   • CARDINALS (BOYCAR/BCNCAR) — absolute N/E/S/W safe quadrant.
 *   • SOLO LATERALS (BOYLAT/BCNLAT) — IALA-A red-to-port / green-to-starboard, TRAVEL-relative.
 *     Only un-paired marks are honoured: a port/stbd PAIR is a channel gate the chain/fairlead/
 *     egress routing already threads dead-centre, so clamping one mark of a pair would shove the
 *     route off the gate (the reverted prototype's failure). Paired marks are dropped here, and a
 *     detour is additionally refused on a gate/canal vertex via the shared `prot` mask.
 * No-ops when no marks are present or the route already clears them all (the golden/repro routes,
 * whose every near-route lateral is either paired or already on the correct side, stay byte-identical).
 */
export function clampRouteToCardinalSafeSide(
    polyline: readonly [number, number][],
    redMask: readonly boolean[],
    cardinals: readonly CardinalDisc[],
    grid: NavGrid,
    opts: { gateSegKeys: ReadonlySet<string>; laterals?: readonly LateralClampMark[] },
): {
    polyline: [number, number][];
    redMask: boolean[];
    relevant: number;
    movedCardinals: number;
    movedLaterals: number;
    reasons: string[];
} {
    const cardinalMarks: MarkSafe[] = cardinals.map((c) => ({
        lat: c.lat,
        lon: c.lon,
        kind: 'cardinal',
        safeVec: SAFE_VEC[c.dir],
    }));
    // Keep only SOLO laterals — no opposite-side partner within a gate-width (LATERAL_PAIR_DIST_M).
    const laterals = opts.laterals ?? [];
    const isSolo = (m: LateralClampMark): boolean =>
        !laterals.some(
            (o) =>
                o !== m &&
                o.side !== m.side &&
                Math.hypot((o.lon - m.lon) * mPerDegLon(m.lat), (o.lat - m.lat) * M_PER_DEG_LAT) <= LATERAL_PAIR_DIST_M,
        );
    const lateralMarks: MarkSafe[] = laterals
        .filter(isSolo)
        .map((m) => ({ lat: m.lat, lon: m.lon, kind: 'lateral', safeVec: m.safeVec ?? null, side: m.side }));
    const marks: MarkSafe[] = [...cardinalMarks, ...lateralMarks];
    // GUARD 1 — byte-identical no-op when there are no marks at all.
    if (marks.length === 0) {
        // Return the input REFERENCES (not copies) so a no-op is truly byte-identical downstream.
        return {
            polyline: polyline as [number, number][],
            redMask: redMask as boolean[],
            relevant: 0,
            movedCardinals: 0,
            movedLaterals: 0,
            reasons: [],
        };
    }

    // Protected = canal RED (index-aligned, GUARD 5) OR a lateral-pair gate endpoint (gateSegKeys,
    // GUARD 6), computed on the ORIGINAL polyline before any densify.
    const origProtected = polyline.map((p, i) => {
        if (redMask[i]) return true;
        const a = i > 0 && opts.gateSegKeys.has(segKey(polyline[i - 1], p));
        const b = i + 1 < polyline.length && opts.gateSegKeys.has(segKey(p, polyline[i + 1]));
        return a || b;
    });

    // Working arrays aligned to the polyline. No densify — the smooth + bezier shape the geometry.
    const pts: [number, number][] = polyline.map((p) => [p[0], p[1]] as [number, number]);
    const red: boolean[] = [...redMask];
    const prot: boolean[] = [...origProtected];

    // ── 1. Global smooth: round the raw A* grid-staircase in the open-water stretches the router never
    //       smooths (the "stepping"). Gates + canal RED are pinned; each pass is land-validated and a
    //       whole pass is rolled back if it would touch land, so it only ever rounds navigable water. ─
    {
        const smoothable = pts.map((p, idx) => idx > 0 && idx < pts.length - 1 && !prot[idx] && !red[idx]);
        for (let it = 0; it < SMOOTH_ITERS; it++) {
            const cand = pts.map((p) => [p[0], p[1]] as [number, number]);
            for (let idx = 1; idx < pts.length - 1; idx++) {
                if (!smoothable[idx]) continue;
                cand[idx] = [
                    0.25 * pts[idx - 1][0] + 0.5 * pts[idx][0] + 0.25 * pts[idx + 1][0],
                    0.25 * pts[idx - 1][1] + 0.5 * pts[idx][1] + 0.25 * pts[idx + 1][1],
                ];
            }
            let bad = false;
            for (let idx = 0; idx < cand.length - 1; idx++) {
                if (!smoothable[idx] && !smoothable[idx + 1]) continue;
                if (segCrossesLand(grid, cand[idx], cand[idx + 1])) {
                    bad = true;
                    break;
                }
            }
            if (bad) break;
            for (let idx = 0; idx < pts.length; idx++) pts[idx] = cand[idx];
        }
    }

    // ── 2. Analytical detour per cardinal: one smooth bezier that bulges to clearance on the SAFE side
    //       at the route's closest approach and rejoins the track tangentially. Smooth AND correct by
    //       construction — no iterative push/pin tug-of-war (that was the stepping ⇄ wrong-side flip). ─
    let movedCardinals = 0;
    let movedLaterals = 0;
    const reasons: string[] = []; // per relevant mark: moved | safe | prot | land
    // Safe axis already committed to each vertex by a prior detour, so an opposed mark can't fight
    // it (two opposed marks near each other → first one wins, the second no-ops there).
    const committedAxis: (readonly [number, number] | null)[] = new Array(pts.length).fill(null);

    // One detour — mutates pts/red/prot/committedAxis in place, recomputing on the CURRENT route.
    const applyDetour = (m: MarkSafe): string => {
        const isLateral = m.kind === 'lateral';
        const mPerLon = mPerDegLon(m.lat);
        let best = Infinity;
        let bk = 0;
        let bt = 0;
        for (let k = 0; k + 1 < pts.length; k++) {
            const { t, distM } = closestOnSeg(m.lat, m.lon, pts[k], pts[k + 1]);
            if (distM < best) {
                best = distM;
                bk = k;
                bt = t;
            }
        }
        const band = isLateral ? LATERAL_BAND_M : CLAMP_BAND_M;
        if (best > band) return 'safe'; // route doesn't come near this mark
        // Safe-side unit vector. Cardinal: fixed quadrant. Lateral with a derived direction of
        // buoyage: ABSOLUTE (orientation-invariant — an outbound leg no longer mirrors the rule
        // onto the hazard side). Lateral without one: TRAVEL-relative fallback — safe is RIGHT of
        // travel for a port-hand mark and LEFT for a stbd-hand mark, correct when the boat runs
        // WITH the buoyage direction (inbound / upstream — the documented fallback scope). The
        // tangent is taken from the closest-approach segment of the CURRENT route.
        let safe: readonly [number, number];
        if (!isLateral || m.safeVec) {
            safe = m.safeVec as readonly [number, number];
        } else {
            let te = (pts[bk + 1][0] - pts[bk][0]) * mPerLon;
            let tn = (pts[bk + 1][1] - pts[bk][1]) * M_PER_DEG_LAT;
            const tl = Math.hypot(te, tn);
            if (tl < 1e-6) return 'safe'; // degenerate segment — no travel direction
            te /= tl;
            tn /= tl;
            safe = m.side === 'port' ? [tn, -te] : [-tn, te];
        }
        const P: [number, number] = [
            pts[bk][0] + (pts[bk + 1][0] - pts[bk][0]) * bt,
            pts[bk][1] + (pts[bk + 1][1] - pts[bk][1]) * bt,
        ];
        const sideP = (P[0] - m.lon) * mPerLon * safe[0] + (P[1] - m.lat) * M_PER_DEG_LAT * safe[1];
        // Cardinal: push to CLEARANCE even if already slightly past. Lateral: only fire when GENUINELY
        // wrong-side (beyond the jitter deadband), then push just onto the safe side.
        const triggerBelow = isLateral ? -LATERAL_DEADBAND_M : CLEARANCE_M;
        const clearTarget = isLateral ? LATERAL_CLEARANCE_M : CLEARANCE_M;
        const rampM = isLateral ? LATERAL_RAMP_M : RAMP_M;
        if (sideP >= triggerBelow) return 'safe'; // already on the safe side
        // Apex: the closest-approach point pushed onto the safe side by `clearance`.
        const push = Math.min(MAX_PUSH_M, clearTarget - sideP);
        const A: [number, number] = [P[0] + (safe[0] * push) / mPerLon, P[1] + (safe[1] * push) / M_PER_DEG_LAT];
        // Entry/exit anchors at EXACTLY ±rampM along-track from the closest
        // approach. The previous version walked whole VERTICES only, so on a
        // sparse span (a single 3.4 km A* leg near the mark) E and X became
        // far endpoints, the apex-at-midpoint bezier overshot the exit and
        // folded into a ~193° hairpin — the Newport golden's 180°/163° kinks
        // (double-back audit, 2026-07-09). Where the ramp lands inside a long
        // segment we CUT a new anchor vertex into it instead.
        type Anchor = { coord: [number, number]; idx: number; cut: boolean };
        // Walk from P (step -1 = backward toward index 0, +1 = forward)
        // accumulating along-track metres. cut=true anchors carry the index
        // of their segment-START vertex; cut=false means the route ended
        // inside the ramp and the anchor is that endpoint vertex.
        const findAnchor = (step: -1 | 1): Anchor => {
            const first = step === -1 ? bk : bk + 1; // first vertex out from P
            let acc = haversineM(P[1], P[0], pts[first][1], pts[first][0]);
            if (acc >= rampM) {
                // Ramp ends between P and the first vertex — the cut lies on
                // the closest-approach segment (bk, bk+1) itself.
                const t = rampM / acc;
                return {
                    coord: [P[0] + (pts[first][0] - P[0]) * t, P[1] + (pts[first][1] - P[1]) * t],
                    idx: bk,
                    cut: true,
                };
            }
            let idx = first;
            while (step === -1 ? idx > 0 : idx < pts.length - 1) {
                const next = idx + step;
                const segLen = haversineM(pts[idx][1], pts[idx][0], pts[next][1], pts[next][0]);
                if (acc + segLen >= rampM) {
                    const t = (rampM - acc) / segLen;
                    return {
                        coord: [
                            pts[idx][0] + (pts[next][0] - pts[idx][0]) * t,
                            pts[idx][1] + (pts[next][1] - pts[idx][1]) * t,
                        ],
                        idx: Math.min(idx, next),
                        cut: true,
                    };
                }
                acc += segLen;
                idx = next;
            }
            return { coord: [pts[idx][0], pts[idx][1]], idx, cut: false };
        };
        const entry = findAnchor(-1);
        const exit = findAnchor(1);
        const E = entry.coord;
        const X = exit.coord;
        // Original vertices consumed by the detour (inclusive range). Both
        // anchor styles keep their reference vertex: a vertex-anchor stays
        // itself; a cut-anchor keeps its segment-start vertex outside the
        // splice and inserts the cut alongside the bezier interior.
        const removeStart = entry.idx + 1;
        const removeEnd = exit.cut ? exit.idx : exit.idx - 1;
        // Never move a gate / canal vertex, and don't fight an opposed cardinal already committed here.
        const checkHi = exit.cut ? exit.idx + 1 : exit.idx;
        for (let i = entry.idx; i <= checkHi; i++) {
            if (prot[i]) return 'prot';
            const ca = committedAxis[i];
            if (ca && ca[0] * safe[0] + ca[1] * safe[1] < 0) return 'prot';
        }
        // Quadratic bezier whose control point puts the curve through the apex A at its midpoint.
        const P1: [number, number] = [2 * A[0] - (E[0] + X[0]) / 2, 2 * A[1] - (E[1] + X[1]) / 2];
        const ctrlLen = haversineM(E[1], E[0], P1[1], P1[0]) + haversineM(P1[1], P1[0], X[1], X[0]);
        const n = Math.max(2, Math.ceil(ctrlLen / DENSIFY_M));
        const interior: [number, number][] = [];
        for (let s = 1; s < n; s++) {
            const t = s / n;
            const u = 1 - t;
            interior.push([
                u * u * E[0] + 2 * u * t * P1[0] + t * t * X[0],
                u * u * E[1] + 2 * u * t * P1[1] + t * t * X[1],
            ]);
        }
        const full: [number, number][] = [E, ...interior, X];
        // A detour may never violate the engine's own de-spike contract: if
        // the bezier still turns harder than 100° anywhere (degenerate
        // geometry the ramp cut can't fix), leave the route alone — a missed
        // clamp is a caution, a hairpin is a route that doubles back.
        let worstTurn = 0;
        for (let i = 1; i + 1 < full.length; i++) {
            const e1 = (full[i][0] - full[i - 1][0]) * mPerLon;
            const n1 = (full[i][1] - full[i - 1][1]) * M_PER_DEG_LAT;
            const e2 = (full[i + 1][0] - full[i][0]) * mPerLon;
            const n2 = (full[i + 1][1] - full[i][1]) * M_PER_DEG_LAT;
            const l1 = Math.hypot(e1, n1);
            const l2 = Math.hypot(e2, n2);
            if (l1 < 1e-6 || l2 < 1e-6) continue;
            const cos = Math.max(-1, Math.min(1, (e1 * e2 + n1 * n2) / (l1 * l2)));
            worstTurn = Math.max(worstTurn, (Math.acos(cos) * 180) / Math.PI);
        }
        if (worstTurn > 100) return 'safe';
        // Land-validate the whole detour; if any part would cross land, leave the route alone here.
        for (let i = 0; i < full.length - 1; i++) {
            if (segCrossesLand(grid, full[i], full[i + 1])) return 'land';
        }
        // Splice: cut anchors are INSERTED with the interior; vertex anchors
        // stay in place flanking it.
        const inserted: [number, number][] = [...(entry.cut ? [E] : []), ...interior, ...(exit.cut ? [X] : [])];
        const removeCount = Math.max(0, removeEnd - removeStart + 1);
        const fillFalse = inserted.map(() => false);
        pts.splice(removeStart, removeCount, ...inserted);
        red.splice(removeStart, removeCount, ...fillFalse);
        prot.splice(removeStart, removeCount, ...fillFalse);
        committedAxis.splice(removeStart, removeCount, ...inserted.map(() => safe));
        // Commit the axis on the kept vertices flanking the splice too, so an
        // opposed mark can't drag the anchors (mirrors the old E..X commit).
        const lo = Math.max(0, removeStart - 1);
        const hi = Math.min(pts.length - 1, removeStart + inserted.length);
        for (let i = lo; i <= hi; i++) committedAxis[i] = safe;
        return 'moved';
    };

    // Process the marks the route comes near, in along-track order (each detour recomputes on the
    // running route so the splices compose cleanly).
    const ordered = marks
        .map((m) => {
            let best = Infinity;
            let bk = 0;
            for (let k = 0; k + 1 < pts.length; k++) {
                const d = pointToSegM(m.lat, m.lon, pts[k], pts[k + 1]);
                if (d < best) {
                    best = d;
                    bk = k;
                }
            }
            return { m, bk, best };
        })
        .filter((o) => o.best <= (o.m.kind === 'lateral' ? LATERAL_BAND_M : CLAMP_BAND_M))
        .sort((a, b) => a.bk - b.bk);
    const relevant = ordered.length;

    for (const { m } of ordered) {
        const r = applyDetour(m);
        reasons.push(r);
        if (r === 'moved') {
            if (m.kind === 'lateral') movedLaterals++;
            else movedCardinals++;
        }
    }

    // Nothing detoured (every mark already clear / land / gated): return the ORIGINAL geometry
    // byte-identical — the global smooth only earns its keep when a detour actually fires.
    if (movedCardinals === 0 && movedLaterals === 0) {
        return {
            polyline: polyline as [number, number][],
            redMask: redMask as boolean[],
            relevant,
            movedCardinals: 0,
            movedLaterals: 0,
            reasons,
        };
    }
    return { polyline: pts, redMask: red, relevant, movedCardinals, movedLaterals, reasons };
}
