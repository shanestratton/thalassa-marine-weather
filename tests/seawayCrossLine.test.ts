/**
 * Phase 13 prep fixtures — cross-line side-validation (masterplan §3/§4).
 *
 * §4: "every connector polyline is validated against gate cross-lines —
 * crossing outside the mark-to-mark span is rejected and re-solved."
 *
 *  • GEOMETRY — span crossing reads compliant; wing crossings read the
 *    correct side (port-outside / stbd-outside); beyond the wings is no
 *    finding at all; parallel tracks don't crash; half-gates are skipped
 *    (their §3 keep-out half-planes are the integration commit's job).
 *  • RE-SOLVE LOOP — the §3 primitive end-to-end on a real connector
 *    search: a route that cuts a wing gets the wing rasterised into
 *    connectToTargets' blockedIdx exclusion set and re-solved until
 *    validation passes — converging through the SPAN, with the cached
 *    grid never mutated (byte-checked).
 *
 * Pure-geometry tests share the connector suite's grid conventions;
 * exclusive lon-region 165.x.
 */

import { describe, expect, it } from 'vitest';
import { aStar, chainCostM, type NavGrid } from '../services/inshoreRouterEngine';
import { connectToTargets, type ConnectorTarget } from '../services/seaway/connector';
import {
    CROSS_LINE_WING_WIDTHS,
    halfGateKeepOuts,
    keepOutBlockedCells,
    validateAgainstCrossLines,
    validateAgainstKeepOuts,
    wingBlockedCells,
} from '../services/seaway/crossLine';
import type { GateNode, SeawayLatLon } from '../services/seaway/types';

// ── Helpers ─────────────────────────────────────────────────────────

const RES_M = 50;
const M_PER_DEG_LAT = 111_320;
const MIN_LON = 165.0;
const MIN_LAT = -27.3;

function makeGrid(width: number, height: number, depth = 12): NavGrid {
    const midLat = MIN_LAT + (height * RES_M) / M_PER_DEG_LAT / 2;
    const mPerLon = 111_320 * Math.cos((midLat * Math.PI) / 180);
    return {
        width,
        height,
        minLon: MIN_LON,
        minLat: MIN_LAT,
        dLon: RES_M / mPerLon,
        dLat: RES_M / M_PER_DEG_LAT,
        cells: new Float32Array(width * height).fill(depth),
        preferred: new Uint8Array(width * height),
    };
}

const cellLatLon = (g: NavGrid, x: number, y: number): SeawayLatLon => ({
    lat: g.minLat + (y + 0.5) * g.dLat,
    lon: g.minLon + (x + 0.5) * g.dLon,
});

const M_LAT = 1 / 110_540;

/** N-S oriented full gate: port mark NORTH of mid, stbd SOUTH, width 2·halfM. */
function gate(id: string, mid: SeawayLatLon, halfM: number): GateNode {
    return {
        id,
        channelKey: 'X',
        station: 1,
        portMark: { lat: mid.lat + halfM * M_LAT, lon: mid.lon, side: 'port', source: 'chart' },
        stbdMark: { lat: mid.lat - halfM * M_LAT, lon: mid.lon, side: 'stbd', source: 'chart' },
        mid,
        buoyageBearingDeg: 90,
        confidence: 0.95,
    };
}

const MID: SeawayLatLon = { lat: -27.2, lon: 165.1 };
const G = gate('X/g1', MID, 100); // marks ±100 m N/S of mid; wings reach ±300 m

/** E-W track passing the gate's longitude at `latOffsetM` from the mid. */
const track = (latOffsetM: number): SeawayLatLon[] => [
    { lat: MID.lat + latOffsetM * M_LAT, lon: 165.09 },
    { lat: MID.lat + latOffsetM * M_LAT, lon: 165.11 },
];

describe('cross-line geometry — span vs wings vs beyond', () => {
    it('between the marks ⇒ compliant crossing, no violation', () => {
        const r = validateAgainstCrossLines(track(0), [G]);
        expect(r.ok).toBe(true);
        expect(r.crossings).toHaveLength(1);
        expect(r.crossings[0].gateId).toBe('X/g1');
        expect(r.gatesChecked).toBe(1);
    });

    it('outside the PORT mark (north of it, within one gate-width) ⇒ port-outside violation', () => {
        const r = validateAgainstCrossLines(track(150), [G]); // 100 < 150 < 300
        expect(r.ok).toBe(false);
        expect(r.violations).toHaveLength(1);
        expect(r.violations[0].side).toBe('port-outside');
        expect(r.violations[0].at.lon).toBeCloseTo(165.1, 4);
    });

    it('outside the STBD mark ⇒ stbd-outside violation', () => {
        const r = validateAgainstCrossLines(track(-150), [G]);
        expect(r.ok).toBe(false);
        expect(r.violations[0].side).toBe('stbd-outside');
    });

    it('beyond the wing tips (±1 gate-width past the marks) ⇒ no finding — far passes are legal', () => {
        // Wing reaches 100 + 200 = 300 m; pass at 400 m.
        const r = validateAgainstCrossLines(track(400), [G]);
        expect(r.ok).toBe(true);
        expect(r.crossings).toHaveLength(0);
        expect(r.violations).toHaveLength(0);
    });

    it('a track PARALLEL to the cross-line is no crossing (and no crash)', () => {
        const parallel: SeawayLatLon[] = [
            { lat: MID.lat - 0.002, lon: 165.1 },
            { lat: MID.lat + 0.002, lon: 165.1 },
        ];
        // N-S track along the gate's own longitude — colinear-ish with the
        // span; the parallel guard must not divide by ~zero.
        const r = validateAgainstCrossLines(parallel, [G]);
        expect(r.violations).toHaveLength(0);
    });

    it('half-gates are skipped in v1 (their §3 keep-out half-planes are the integration commit)', () => {
        const half: GateNode = { ...G, id: 'X/h1', stbdMark: undefined };
        const r = validateAgainstCrossLines(track(150), [half]);
        expect(r.gatesChecked).toBe(0);
        expect(r.ok).toBe(true);
    });

    it('wing constant is the §3 value', () => {
        expect(CROSS_LINE_WING_WIDTHS).toBe(1);
    });
});

describe('cross-line re-solve — validate → block wing → re-search converges through the span', () => {
    it('a connector that cut the stbd wing re-solves between the marks; the cached grid is never mutated', () => {
        // 120×80 deep grid. Gate mid sits 150 m NORTH of the straight
        // origin→target line: marks at +50/+250 m, so the straight line
        // (at 0) crosses the stbd wing (+50 down to −150 m). Blocking the
        // wing leaves two legal escapes — through the span (~100 m
        // deviation) or around the south tip (~175 m, still beyond one
        // gate-width = a lawful far pass) — the span is cheaper, so the
        // §3 loop converges THROUGH the gate, which is what we pin.
        const g = makeGrid(120, 80);
        const origin = cellLatLon(g, 10, 40);
        const targetCell = { x: 110, y: 40 };
        const gateMid: SeawayLatLon = { lat: origin.lat + 150 * M_LAT, lon: cellLatLon(g, 60, 40).lon };
        const GATE = gate('R/g1', gateMid, 100);
        const target: ConnectorTarget = { id: 't', kind: 'gate-mid', ...cellLatLon(g, targetCell.x, targetCell.y) };

        const cellsBefore = g.cells.slice();

        // Pass 1: unconstrained — cuts the wing.
        const first = connectToTargets(g, origin, [target]);
        expect(first.results[0].reached).toBe(true);
        const path1 = first.results[0].path.map((c) => cellLatLon(g, c.x, c.y));
        const v1 = validateAgainstCrossLines(path1, [GATE]);
        expect(v1.ok).toBe(false);
        expect(v1.violations[0].side).toBe('stbd-outside');

        // §3 loop: block each crossed wing, re-solve, until valid (or
        // give up — the integration router will refuse then).
        const blocked = new Set<number>();
        let solved = first;
        let valid = v1;
        for (let round = 0; round < 4 && !valid.ok; round++) {
            for (const viol of valid.violations) {
                for (const idx of wingBlockedCells(g, GATE, viol.side)) blocked.add(idx);
            }
            solved = connectToTargets(g, origin, [target], { blockedIdx: blocked });
            expect(solved.results[0].reached).toBe(true);
            valid = validateAgainstCrossLines(
                solved.results[0].path.map((c) => cellLatLon(g, c.x, c.y)),
                [GATE],
            );
        }
        expect(valid.ok).toBe(true);
        // ...and it converged THROUGH the span, not by detouring beyond
        // the wing tips: a compliant crossing is recorded.
        expect(valid.crossings.map((c) => c.gateId)).toContain('R/g1');

        // The re-solved route is costlier (it deviated) but sane: within
        // the §3 per-leg detour cap of the unconstrained optimum.
        const ref = aStar(g, { x: 10, y: 40 }, targetCell);
        const refCost = chainCostM(g, ref!);
        expect(solved.results[0].costM).toBeGreaterThanOrEqual(refCost - 1e-6);
        expect(solved.results[0].costM).toBeLessThan(refCost * 1.35);

        // The shared cached grid was NEVER mutated by blocking.
        expect(g.cells).toEqual(cellsBefore);
    });
});

describe('half-gate keep-outs (§3/§4 — pass seaward of a solo mark)', () => {
    const SOLO_MID: SeawayLatLon = { lat: -27.2, lon: 165.3 };
    const half = (id: string): GateNode => ({
        id,
        channelKey: 'H',
        station: 1,
        portMark: { lat: SOLO_MID.lat, lon: SOLO_MID.lon, side: 'port', source: 'chart' },
        mid: SOLO_MID,
        buoyageBearingDeg: 90,
        confidence: 0.95,
    });
    // A land vertex 400 m NORTH of the mark — shore side is north.
    const LAND: [number, number][] = [[SOLO_MID.lon, SOLO_MID.lat + 400 * M_LAT]];

    it('infers the shore side from the nearest LNDARE vertex; reach = min(shoreDist, cap)', () => {
        const kos = halfGateKeepOuts([half('H/h1')], LAND);
        expect(kos).toHaveLength(1);
        expect(kos[0].gateId).toBe('H/h1');
        // Segment points north, 400 m (shoreDist < 800 cap).
        expect(kos[0].toward.lat).toBeCloseTo(SOLO_MID.lat + 400 * M_LAT, 6);
        expect(kos[0].toward.lon).toBeCloseTo(SOLO_MID.lon, 6);
    });

    it('no land within 5 km ⇒ no keep-out (orientation unreliable, same fallback as the orchestrator)', () => {
        const farLand: [number, number][] = [[SOLO_MID.lon, SOLO_MID.lat + 6000 * M_LAT]];
        expect(halfGateKeepOuts([half('H/h2')], farLand)).toHaveLength(0);
        expect(halfGateKeepOuts([half('H/h3')], [])).toHaveLength(0);
    });

    it('full gates produce no keep-out (they have cross-lines instead)', () => {
        expect(halfGateKeepOuts([G], LAND)).toHaveLength(0);
    });

    it("crossing between mark and shore ⇒ 'shore-side' violation; passing seaward ⇒ clean", () => {
        const kos = halfGateKeepOuts([half('H/h4')], LAND);
        const shoreward: SeawayLatLon[] = [
            { lat: SOLO_MID.lat + 200 * M_LAT, lon: 165.29 },
            { lat: SOLO_MID.lat + 200 * M_LAT, lon: 165.31 },
        ];
        const v = validateAgainstKeepOuts(shoreward, kos);
        expect(v).toHaveLength(1);
        expect(v[0].side).toBe('shore-side');
        const seaward: SeawayLatLon[] = [
            { lat: SOLO_MID.lat - 200 * M_LAT, lon: 165.29 },
            { lat: SOLO_MID.lat - 200 * M_LAT, lon: 165.31 },
        ];
        expect(validateAgainstKeepOuts(seaward, kos)).toHaveLength(0);
    });

    it('re-solve: blocking the keep-out pushes the connector seaward of the mark', () => {
        // Deep grid; solo port mark 100 m north of the straight
        // origin→target line, land vertex 400 m further north. The
        // straight line passes 100 m SHOREWARD-side... no: mark at +100,
        // shore at +500 — the keep-out spans +100..+500; the straight
        // line at 0 passes seaward already. Flip: put the mark SOUTH of
        // the line (-100) with land far north (+500): keep-out runs from
        // -100 up to +300, crossing the route line — pass 1 violates,
        // blocking re-solves BELOW the mark (seaward = away from land).
        const g = makeGrid(120, 80);
        const origin = cellLatLon(g, 10, 40);
        const targetCell = { x: 110, y: 40 };
        const markPos: SeawayLatLon = { lat: origin.lat - 100 * M_LAT, lon: cellLatLon(g, 60, 40).lon };
        const HG: GateNode = {
            id: 'H/h5',
            channelKey: 'H',
            station: 1,
            portMark: { ...markPos, side: 'port', source: 'chart' },
            mid: markPos,
            buoyageBearingDeg: 90,
            confidence: 0.95,
        };
        const land: [number, number][] = [[markPos.lon, markPos.lat + 500 * M_LAT]];
        const kos = halfGateKeepOuts([HG], land);
        expect(kos).toHaveLength(1);

        const target: ConnectorTarget = { id: 't', kind: 'gate-mid', ...cellLatLon(g, targetCell.x, targetCell.y) };
        const first = connectToTargets(g, origin, [target]);
        const path1 = first.results[0].path.map((c) => cellLatLon(g, c.x, c.y));
        expect(validateAgainstKeepOuts(path1, kos)).not.toHaveLength(0);

        const blocked = new Set<number>();
        for (const idx of keepOutBlockedCells(g, kos[0])) blocked.add(idx);
        const solved = connectToTargets(g, origin, [target], { blockedIdx: blocked });
        expect(solved.results[0].reached).toBe(true);
        const path2 = solved.results[0].path.map((c) => cellLatLon(g, c.x, c.y));
        expect(validateAgainstKeepOuts(path2, kos)).toHaveLength(0);
        // Re-solved SEAWARD: at the mark's longitude the route sits south
        // of the mark (away from the land vertex).
        const atMark = path2.reduce((best, p) =>
            Math.abs(p.lon - markPos.lon) < Math.abs(best.lon - markPos.lon) ? p : best,
        );
        expect(atMark.lat).toBeLessThan(markPos.lat);
    });
});
