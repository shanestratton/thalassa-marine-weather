/**
 * crossLine — Phase 13's side-correctness primitive (masterplan §3/§4).
 *
 * §4, verbatim: "every connector polyline is validated against gate
 * CROSS-LINES — crossing outside the mark-to-mark span is rejected and
 * re-solved". The cross-line of a full gate is the port→stbd segment
 * EXTENDED one gate-width beyond each mark:
 *
 *      t=-1 ····· t=0 ━━━━━━ t=1 ····· t=2
 *      (port wing) P   span    S  (stbd wing)
 *
 * A route segment crossing the SPAN (t ∈ [0,1]) passed between the
 * marks — correct. Crossing a WING passed on the wrong side of a mark:
 * 'port-outside' (t < 0) or 'stbd-outside' (t > 1). Validation returns
 * BOTH lists — violations for the §3 reject-and-re-solve loop, and
 * compliant crossings so compliance metrics stop being
 * by-construction (the Phase 12 shadow's gateCompliance caveat).
 *
 * Re-solve support: wingBlockedCells() rasterises the crossed wing onto
 * the engine grid as an EXCLUSION SET for connectToTargets' blockedIdx
 * option — never by mutating the cached grid (it is shared; the Phase
 * 12 review bled for that lesson). The §3 loop is then: validate →
 * block crossed wings → re-solve → validate again (the integration in
 * the Phase 13 router owns the loop; tests pin its convergence here).
 *
 * Half-gates (solo marks) carry keep-out segments per §3/§4: the IALA
 * meaning of an unpaired lateral is "the hazard runs from me TOWARD
 * SHORE — pass seaward". halfGateKeepOuts infers the shore side exactly
 * like the orchestrator's orientHazardsTowardLand (nearest LNDARE
 * vertex, unreliable beyond 5 km → no keep-out) and emits a mark→shore
 * segment that connectors may not cross; crossing it is a 'shore-side'
 * violation, re-solvable with keepOutBlockedCells like a wing. Unlike
 * the orchestrator's OBSTRN half-discs, these annotations exist ONLY on
 * the graph path — fixing §3's misclassification double-penalty (a
 * mispaired channel mark no longer walls the channel; it just forbids
 * the shoreward pass).
 */

import type { NavGrid } from '../inshoreRouterEngine';
import type { GateNode, SeawayLatLon } from './types';

// Graph-space metre conventions (match gateExtractor).
const M_PER_LAT = 110_540;
const mPerLonAt = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);

/** Wing extension factor: ±1 gate-width beyond each mark (§3). */
export const CROSS_LINE_WING_WIDTHS = 1;

export type WrongSide = 'port-outside' | 'stbd-outside' | 'shore-side';

export interface CrossLineViolation {
    gateId: string;
    side: WrongSide;
    /** Where the route crossed the wing. */
    at: SeawayLatLon;
    /** Polyline segment index (a→a+1) that crossed. */
    segIndex: number;
}

export interface CrossLineCrossing {
    gateId: string;
    /** Where the route crossed the span, between the marks. */
    at: SeawayLatLon;
    segIndex: number;
}

export interface CrossLineResult {
    ok: boolean;
    violations: CrossLineViolation[];
    /** Compliant between-the-marks crossings — a compliance NUMERATOR
     *  that is measured, not true by construction. */
    crossings: CrossLineCrossing[];
    /** Full gates checked (the compliance denominator candidate). */
    gatesChecked: number;
}

interface GateFrame {
    gate: GateNode;
    /** Port mark in lat/lon (frame anchor). */
    p: SeawayLatLon;
    /** Span vector P→S in metres. */
    vx: number;
    vy: number;
    mPerLon: number;
}

function frameOf(gate: GateNode): GateFrame | null {
    if (!gate.portMark || !gate.stbdMark) return null; // half-gates: keep-outs (halfGateKeepOuts), not cross-lines
    const p = gate.portMark;
    const mPerLon = mPerLonAt(p.lat);
    const vx = (gate.stbdMark.lon - p.lon) * mPerLon;
    const vy = (gate.stbdMark.lat - p.lat) * M_PER_LAT;
    if (Math.hypot(vx, vy) < 1) return null; // degenerate pair
    return { gate, p, vx, vy, mPerLon };
}

/**
 * Validate a polyline against the cross-lines of every FULL gate in
 * `gates`. Pure geometry — pass the gates actually relevant to the leg
 * (the §3 router validates each CONNECTOR leg against its channel's
 * gates; validating a whole route against every gate in the region
 * would flag legitimate passes of unrelated channels).
 */
export function validateAgainstCrossLines(polyline: SeawayLatLon[], gates: GateNode[]): CrossLineResult {
    const violations: CrossLineViolation[] = [];
    const crossings: CrossLineCrossing[] = [];
    let gatesChecked = 0;

    for (const gate of gates) {
        const f = frameOf(gate);
        if (!f) continue;
        gatesChecked++;
        for (let i = 1; i < polyline.length; i++) {
            const ax = (polyline[i - 1].lon - f.p.lon) * f.mPerLon;
            const ay = (polyline[i - 1].lat - f.p.lat) * M_PER_LAT;
            const bx = (polyline[i].lon - f.p.lon) * f.mPerLon;
            const by = (polyline[i].lat - f.p.lat) * M_PER_LAT;
            const rx = bx - ax;
            const ry = by - ay;
            const denom = rx * f.vy - ry * f.vx;
            if (Math.abs(denom) < 1e-9) continue; // parallel to the cross-line
            // a + u·r = t·v  (frame anchored at P)
            const u = (ax * f.vy - ay * f.vx) / -denom;
            const t = (ax * ry - ay * rx) / -denom;
            if (u < 0 || u > 1) continue; // crossing not on this segment
            if (t < -CROSS_LINE_WING_WIDTHS || t > 1 + CROSS_LINE_WING_WIDTHS) continue; // beyond the wings
            const at: SeawayLatLon = {
                lat: polyline[i - 1].lat + (polyline[i].lat - polyline[i - 1].lat) * u,
                lon: polyline[i - 1].lon + (polyline[i].lon - polyline[i - 1].lon) * u,
            };
            if (t >= 0 && t <= 1) {
                crossings.push({ gateId: gate.id, at, segIndex: i - 1 });
            } else {
                violations.push({
                    gateId: gate.id,
                    side: t < 0 ? 'port-outside' : 'stbd-outside',
                    at,
                    segIndex: i - 1,
                });
            }
        }
    }
    return { ok: violations.length === 0, violations, crossings, gatesChecked };
}

/**
 * Rasterise the crossed wing of a gate onto the engine grid: the cell
 * indices for connectToTargets' blockedIdx exclusion set, so the §3
 * re-solve routes through the span instead. Walks the wing segment
 * (mark → mark ± one gate-width) at half-cell steps with a one-cell
 * cross-track thickening (a zero-width line of cells leaks diagonals on
 * an 8-connected grid).
 */
export function wingBlockedCells(grid: NavGrid, gate: GateNode, side: WrongSide): Set<number> {
    const f = frameOf(gate);
    if (!f || side === 'shore-side') return new Set(); // shore-side: keepOutBlockedCells
    // Wing endpoints in the P-anchored metre frame.
    const from =
        side === 'port-outside'
            ? { x: -f.vx * CROSS_LINE_WING_WIDTHS, y: -f.vy * CROSS_LINE_WING_WIDTHS }
            : { x: f.vx, y: f.vy };
    const to =
        side === 'port-outside'
            ? { x: 0, y: 0 }
            : { x: f.vx * (1 + CROSS_LINE_WING_WIDTHS), y: f.vy * (1 + CROSS_LINE_WING_WIDTHS) };
    const a = { lat: f.p.lat + from.y / M_PER_LAT, lon: f.p.lon + from.x / f.mPerLon };
    const b = { lat: f.p.lat + to.y / M_PER_LAT, lon: f.p.lon + to.x / f.mPerLon };
    return segmentBlockedCells(grid, a, b);
}

/** Rasterise a lat/lon segment onto the grid at half-cell steps with a
 *  one-cell thickening (a zero-width cell line leaks diagonals on an
 *  8-connected grid). Shared by wing and keep-out blocking. */
function segmentBlockedCells(grid: NavGrid, a: SeawayLatLon, b: SeawayLatLon): Set<number> {
    const out = new Set<number>();
    const mPerLon = mPerLonAt(a.lat);
    const lenM = Math.hypot((b.lon - a.lon) * mPerLon, (b.lat - a.lat) * M_PER_LAT);
    const stepM = Math.min(grid.dLat * M_PER_LAT, grid.dLon * mPerLon) / 2;
    const steps = Math.max(1, Math.ceil(lenM / Math.max(1, stepM)));
    for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const lat = a.lat + (b.lat - a.lat) * t;
        const lon = a.lon + (b.lon - a.lon) * t;
        const cx = Math.floor((lon - grid.minLon) / grid.dLon);
        const cy = Math.floor((lat - grid.minLat) / grid.dLat);
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const x = cx + dx;
                const y = cy + dy;
                if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
                out.add(y * grid.width + x);
            }
        }
    }
    return out;
}

// ── Half-gate keep-outs (§3/§4) ─────────────────────────────────────

/** Beyond this, the nearest-land inference is unreliable — no keep-out
 *  (mirrors orientHazardsTowardLand's MAX_SHORE_DISTANCE_M). */
export const KEEPOUT_MAX_SHORE_DISTANCE_M = 5000;
/** Keep-out reach cap (mirrors the orchestrator's LATERAL_RADIUS_MAX_M
 *  — far enough to span a Scarborough-class reef strip, short enough
 *  not to wall a bay). */
export const KEEPOUT_REACH_MAX_M = 800;

export interface HalfGateKeepOut {
    gateId: string;
    /** The solo mark (segment anchor). */
    mark: SeawayLatLon;
    /** Segment end toward shore: reach = min(shore distance, cap). */
    toward: SeawayLatLon;
}

/** Flatten LNDARE feature coordinates to [lon, lat] vertices (the same
 *  walk orientHazardsTowardLand performs — duplicated 10 lines rather
 *  than importing the 2000-line orchestrator into a leaf module). */
export function flattenLandVertices(
    lndareFeatures: Array<{ geometry?: { type?: string; coordinates?: unknown } | null }>,
): [number, number][] {
    const out: [number, number][] = [];
    const walk = (coords: unknown): void => {
        if (!Array.isArray(coords)) return;
        if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
            out.push([coords[0] as number, coords[1] as number]);
            return;
        }
        for (const c of coords) walk(c);
    };
    for (const f of lndareFeatures) walk(f.geometry?.coordinates);
    return out;
}

/**
 * Keep-out segments for HALF gates: from the solo mark toward the
 * nearest land vertex (the §3 shore-side inference), reach =
 * min(shoreDist, KEEPOUT_REACH_MAX_M). No land within 5 km → no
 * keep-out (orientation unreliable; same fallback as the orchestrator).
 */
export function halfGateKeepOuts(gates: GateNode[], landVertices: [number, number][]): HalfGateKeepOut[] {
    const out: HalfGateKeepOut[] = [];
    if (landVertices.length === 0) return out;
    for (const gate of gates) {
        const solo =
            gate.portMark && !gate.stbdMark ? gate.portMark : !gate.portMark && gate.stbdMark ? gate.stbdMark : null;
        if (!solo) continue;
        const mPerLon = mPerLonAt(solo.lat);
        let bestD = Infinity;
        let bestX = 0;
        let bestY = 0;
        for (const [lon, lat] of landVertices) {
            const dx = (lon - solo.lon) * mPerLon;
            const dy = (lat - solo.lat) * M_PER_LAT;
            const d = Math.hypot(dx, dy);
            if (d < bestD) {
                bestD = d;
                bestX = dx;
                bestY = dy;
            }
        }
        if (!Number.isFinite(bestD) || bestD > KEEPOUT_MAX_SHORE_DISTANCE_M || bestD < 1) continue;
        const reach = Math.min(bestD, KEEPOUT_REACH_MAX_M);
        out.push({
            gateId: gate.id,
            mark: { lat: solo.lat, lon: solo.lon },
            toward: {
                lat: solo.lat + ((bestY / bestD) * reach) / M_PER_LAT,
                lon: solo.lon + ((bestX / bestD) * reach) / mPerLon,
            },
        });
    }
    return out;
}

/** Crossing a keep-out segment = passing between the solo mark and the
 *  shore — a 'shore-side' violation, same shape as wing violations so
 *  the §3 re-solve loop handles both uniformly. */
export function validateAgainstKeepOuts(polyline: SeawayLatLon[], keepOuts: HalfGateKeepOut[]): CrossLineViolation[] {
    const violations: CrossLineViolation[] = [];
    for (const ko of keepOuts) {
        const mPerLon = mPerLonAt(ko.mark.lat);
        const vx = (ko.toward.lon - ko.mark.lon) * mPerLon;
        const vy = (ko.toward.lat - ko.mark.lat) * M_PER_LAT;
        for (let i = 1; i < polyline.length; i++) {
            const ax = (polyline[i - 1].lon - ko.mark.lon) * mPerLon;
            const ay = (polyline[i - 1].lat - ko.mark.lat) * M_PER_LAT;
            const bx = (polyline[i].lon - ko.mark.lon) * mPerLon;
            const by = (polyline[i].lat - ko.mark.lat) * M_PER_LAT;
            const rx = bx - ax;
            const ry = by - ay;
            const denom = rx * vy - ry * vx;
            if (Math.abs(denom) < 1e-9) continue;
            const u = (ax * vy - ay * vx) / -denom;
            const t = (ax * ry - ay * rx) / -denom;
            if (u < 0 || u > 1 || t < 0 || t > 1) continue;
            violations.push({
                gateId: ko.gateId,
                side: 'shore-side',
                at: {
                    lat: polyline[i - 1].lat + (polyline[i].lat - polyline[i - 1].lat) * u,
                    lon: polyline[i - 1].lon + (polyline[i].lon - polyline[i - 1].lon) * u,
                },
                segIndex: i - 1,
            });
        }
    }
    return violations;
}

/** blockedIdx cells for a keep-out segment (the re-solve hook). */
export function keepOutBlockedCells(grid: NavGrid, ko: HalfGateKeepOut): Set<number> {
    return segmentBlockedCells(grid, ko.mark, ko.toward);
}
