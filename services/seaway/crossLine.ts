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
 * v1 scope, deliberate and visible:
 *  - FULL gates only. Solo-mark half-gates carry keep-out HALF-PLANES
 *    per §3 (from orientHazardsTowardLand's shore-side inference) — that
 *    needs the LNDARE context wired through, deferred to the Phase 13
 *    integration commit, flagged in the collab channel.
 */

import type { NavGrid } from '../inshoreRouterEngine';
import type { GateNode, SeawayLatLon } from './types';

// Graph-space metre conventions (match gateExtractor).
const M_PER_LAT = 110_540;
const mPerLonAt = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);

/** Wing extension factor: ±1 gate-width beyond each mark (§3). */
export const CROSS_LINE_WING_WIDTHS = 1;

export type WrongSide = 'port-outside' | 'stbd-outside';

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
    if (!gate.portMark || !gate.stbdMark) return null; // half-gates: §3 half-planes, deferred
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
    const out = new Set<number>();
    const f = frameOf(gate);
    if (!f) return out;
    // Wing endpoints in the P-anchored metre frame.
    const from =
        side === 'port-outside'
            ? { x: -f.vx * CROSS_LINE_WING_WIDTHS, y: -f.vy * CROSS_LINE_WING_WIDTHS }
            : { x: f.vx, y: f.vy };
    const to =
        side === 'port-outside'
            ? { x: 0, y: 0 }
            : { x: f.vx * (1 + CROSS_LINE_WING_WIDTHS), y: f.vy * (1 + CROSS_LINE_WING_WIDTHS) };
    const stepM = Math.min(grid.dLat * M_PER_LAT, grid.dLon * f.mPerLon) / 2;
    const lenM = Math.hypot(to.x - from.x, to.y - from.y);
    const steps = Math.max(1, Math.ceil(lenM / Math.max(1, stepM)));
    for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const mx = from.x + (to.x - from.x) * t;
        const my = from.y + (to.y - from.y) * t;
        const lat = f.p.lat + my / M_PER_LAT;
        const lon = f.p.lon + mx / f.mPerLon;
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
