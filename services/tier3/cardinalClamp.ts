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
import type { NavGrid } from '../engine/types';
import { mPerDegLon, haversineM, latLonToGrid } from '../engine/geometry';

const M_PER_DEG_LAT = 111_320;

export interface CardinalDisc {
    lat: number;
    lon: number;
    /** Safe direction (boat passes on this side). */
    dir: 'n' | 'e' | 's' | 'w';
    radiusM: number;
}

/**
 * A solo IALA-A lateral mark fed to the same clamp. Side is from CATLAM (1 = port/red,
 * 2 = stbd/green). Unlike a cardinal, a lateral's safe side is TRAVEL-relative (it depends on the
 * direction of buoyage), so its safe vector is resolved from the route's local tangent at the
 * closest approach — see `applyDetour`.
 */
export interface LateralClampMark {
    lat: number;
    lon: number;
    side: 'port' | 'stbd';
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
        .map((m) => ({ lat: m.lat, lon: m.lon, kind: 'lateral', safeVec: null, side: m.side }));
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
        // Safe-side unit vector. Cardinal: fixed quadrant. Lateral: TRAVEL-relative — the safe side
        // is RIGHT of travel for a red (port-hand) mark and LEFT for a green (stbd) mark, the IALA-A
        // rule when the boat runs WITH the direction of buoyage (inbound / upstream — the documented
        // scope). The tangent is taken from the closest-approach segment of the CURRENT route.
        let safe: readonly [number, number];
        if (!isLateral) {
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
        // Entry/exit vertices ±rampM along-track from the closest approach.
        let eIdx = bk;
        let accE = haversineM(P[1], P[0], pts[bk][1], pts[bk][0]);
        while (eIdx > 0 && accE < rampM) {
            accE += haversineM(pts[eIdx][1], pts[eIdx][0], pts[eIdx - 1][1], pts[eIdx - 1][0]);
            eIdx--;
        }
        let xIdx = bk + 1;
        let accX = haversineM(P[1], P[0], pts[bk + 1][1], pts[bk + 1][0]);
        while (xIdx < pts.length - 1 && accX < rampM) {
            accX += haversineM(pts[xIdx][1], pts[xIdx][0], pts[xIdx + 1][1], pts[xIdx + 1][0]);
            xIdx++;
        }
        // Never move a gate / canal vertex, and don't fight an opposed cardinal already committed here.
        for (let i = eIdx; i <= xIdx; i++) {
            if (prot[i]) return 'prot';
            const ca = committedAxis[i];
            if (ca && ca[0] * safe[0] + ca[1] * safe[1] < 0) return 'prot';
        }
        const E = pts[eIdx];
        const X = pts[xIdx];
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
        // Land-validate the whole detour; if any part would cross land, leave the route alone here.
        const full: [number, number][] = [E, ...interior, X];
        for (let i = 0; i < full.length - 1; i++) {
            if (segCrossesLand(grid, full[i], full[i + 1])) return 'land';
        }
        // Splice the bezier interior in place of the original interior (E and X are kept as anchors).
        const removeCount = xIdx - eIdx - 1;
        const fillFalse = interior.map(() => false);
        pts.splice(eIdx + 1, removeCount, ...interior);
        red.splice(eIdx + 1, removeCount, ...fillFalse);
        prot.splice(eIdx + 1, removeCount, ...fillFalse);
        committedAxis.splice(eIdx + 1, removeCount, ...interior.map(() => safe));
        const newX = eIdx + 1 + interior.length;
        for (let i = eIdx; i <= newX; i++) committedAxis[i] = safe;
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
