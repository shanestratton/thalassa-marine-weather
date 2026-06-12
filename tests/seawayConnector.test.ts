/**
 * Phase 11 fixtures — connector mode + portals (masterplan §3).
 *
 * The masterplan's verification criterion, verbatim: "engine test proves
 * origin→{K portals} costs match K independent A* runs within 1%, at
 * ≤1.3× single-run latency."
 *
 *  • COST PARITY — one connectToTargets call vs K independent engine
 *    aStar runs over a deliberately mixed grid (land wall with two gaps,
 *    a 1× preferred ribbon, a 6.4× shallow band, a 40× caution patch):
 *    per-target costM must match chainCostM(aStar path) within 1%
 *    (they should be identical to float noise — same kernel).
 *  • LATENCY — asserted on HEAP POPS, the deterministic compute proxy
 *    (wall-clock flakes under CI load): the single multi-target search
 *    must pop ≤ 1.3× the LARGEST single A* run's pops for the clustered-
 *    portals case the connector exists for (channel-end portals sit
 *    within a few gate-spacings of each other).
 *  • BUDGET — a portal whose only path is a huge detour (>1.5× direct
 *    through the worst real-water tier) terminates the search instead of
 *    flooding the grid: reached:false, while a sane target in the same
 *    call still connects.
 *  • PORTALS — synthesizePortals on a compiled synthetic channel: one
 *    portal per terminal, one median gate-spacing outward along the
 *    channel axis; deep-water snap pulls a portal off a CAUTION shoal;
 *    crossing channels emit a junction portal.
 *
 * Grids here are constructed directly (Float32Array), not via
 * buildNavGrid — the connector contract is the GRID + cost kernel, and
 * building cells from synthetic layers is already pinned by the
 * seamanship/uncharted suites.
 */

import { describe, expect, it } from 'vitest';
import { aStar, chainCostM, type NavGrid } from '../services/inshoreRouterEngine';
import {
    CONNECTOR_BUDGET_FACTOR,
    connectToTargets,
    synthesizePortals,
    type ConnectorTarget,
} from '../services/seaway/connector';
import { compileSeawayGraph } from '../services/seaway/graphCompiler';

// ── Synthetic grid (engine conventions: 50 m cells at lat ≈ -27.2) ──

const RES_M = 50;
const M_PER_DEG_LAT = 111_320;
const MIN_LON = 153.0;
const MIN_LAT = -27.3;

function makeGrid(width: number, height: number, depth = 12): NavGrid {
    const midLat = MIN_LAT + ((height * RES_M) / M_PER_DEG_LAT) / 2;
    const mPerLon = 111_320 * Math.cos((midLat * Math.PI) / 180);
    const cells = new Float32Array(width * height).fill(depth);
    return {
        width,
        height,
        minLon: MIN_LON,
        minLat: MIN_LAT,
        dLon: RES_M / mPerLon,
        dLat: RES_M / M_PER_DEG_LAT,
        cells,
        preferred: new Uint8Array(width * height),
    };
}

const idx = (g: NavGrid, x: number, y: number): number => y * g.width + x;
const cellLatLon = (g: NavGrid, x: number, y: number): { lat: number; lon: number } => ({
    lat: g.minLat + (y + 0.5) * g.dLat,
    lon: g.minLon + (x + 0.5) * g.dLon,
});
const fillRect = (g: NavGrid, x0: number, y0: number, x1: number, y1: number, v: number): void => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g.cells[idx(g, x, y)] = v;
};
const preferRect = (g: NavGrid, x0: number, y0: number, x1: number, y1: number): void => {
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) g.preferred[idx(g, x, y)] = 1;
};

const target = (g: NavGrid, id: string, x: number, y: number): ConnectorTarget => ({
    id,
    kind: 'portal',
    ...cellLatLon(g, x, y),
});

describe('connector — cost parity + latency vs K independent A* runs', () => {
    // 120×80 mixed grid: a N-S land wall at x=60 with gaps at y∈[18,22]
    // and y∈[55,60]; a preferred 1× ribbon through the south gap; a 6.4×
    // shallow band; a 40× caution patch in the north gap's western
    // approach. Non-trivial topology — optimal paths to the four targets
    // differ in which gap they take and what water they accept.
    const buildFixtureGrid = (): NavGrid => {
        const g = makeGrid(120, 80);
        fillRect(g, 60, 0, 62, 79, NaN); // the wall
        fillRect(g, 60, 18, 62, 22, 12); // north gap (deep)
        fillRect(g, 60, 55, 62, 60, 12); // south gap (deep)
        fillRect(g, 30, 30, 59, 45, 3); // shallow band west of the wall (6.4×)
        fillRect(g, 45, 14, 59, 26, -1); // caution apron before the north gap (40×)
        preferRect(g, 40, 56, 85, 59); // preferred ribbon through the south gap
        return g;
    };
    const ORIGIN_CELL = { x: 10, y: 40 };
    // Clustered east-side targets — the channel-end portal scenario.
    const TARGET_CELLS = [
        { id: 'p1', x: 90, y: 50 },
        { id: 'p2', x: 95, y: 58 },
        { id: 'p3', x: 100, y: 44 },
        { id: 'p4', x: 92, y: 64 },
    ];

    it('one multi-target search matches 4 independent A* runs within 1% (expected: float-identical)', () => {
        const g = buildFixtureGrid();
        const targets = TARGET_CELLS.map((t) => target(g, t.id, t.x, t.y));
        const search = connectToTargets(g, cellLatLon(g, ORIGIN_CELL.x, ORIGIN_CELL.y), targets);

        expect(search.results.map((r) => r.reached)).toEqual([true, true, true, true]);
        for (let i = 0; i < TARGET_CELLS.length; i++) {
            const ref = aStar(g, ORIGIN_CELL, { x: TARGET_CELLS[i].x, y: TARGET_CELLS[i].y });
            expect(ref).not.toBeNull();
            const refCost = chainCostM(g, ref!);
            const got = search.results[i].costM;
            expect(Math.abs(got - refCost) / refCost).toBeLessThan(0.01);
            // Path endpoints are the requested cells.
            const p = search.results[i].path;
            expect(p[0]).toEqual(ORIGIN_CELL);
            expect(p[p.length - 1]).toEqual({ x: TARGET_CELLS[i].x, y: TARGET_CELLS[i].y });
        }
    });

    it('pops ≤ 1.3× the largest single A* run (deterministic latency proxy)', () => {
        const g = buildFixtureGrid();
        const targets = TARGET_CELLS.map((t) => target(g, t.id, t.x, t.y));
        const search = connectToTargets(g, cellLatLon(g, ORIGIN_CELL.x, ORIGIN_CELL.y), targets);

        let maxSinglePops = 0;
        for (const t of TARGET_CELLS) {
            const stats = { popped: 0 };
            aStar(g, ORIGIN_CELL, { x: t.x, y: t.y }, stats);
            if (stats.popped > maxSinglePops) maxSinglePops = stats.popped;
        }
        expect(search.popped).toBeLessThanOrEqual(Math.ceil(maxSinglePops * 1.3));
    });
});

describe('connector — budget termination (cost >1.5× direct)', () => {
    it('refuses a portal walled behind a huge detour; a sane target in the same call still connects', () => {
        // U-shaped wall around the target, open only to the far east: the
        // only path is a ~3× geometric detour through 12 m water (4×
        // tier) — far beyond 1.5 × euclid × 6.4. The near target sits in
        // open water south of the origin.
        const g = makeGrid(160, 80);
        // U-wall: three sides around (40,40), open to the east at x=120.
        fillRect(g, 30, 30, 120, 31, NaN); // top arm
        fillRect(g, 30, 49, 120, 50, NaN); // bottom arm
        fillRect(g, 30, 30, 31, 50, NaN); // west wall (faces the origin)
        const walled = target(g, 'walled', 40, 40);
        const near = target(g, 'near', 12, 60);
        const search = connectToTargets(g, cellLatLon(g, 10, 40), [walled, near]);

        const [w, n] = search.results;
        expect(n.reached).toBe(true);
        expect(n.withinBudget).toBe(true);
        expect(w.reached).toBe(false);
        expect(w.costM).toBe(Infinity);
        // Sanity on the budget itself: direct line is blocked, so the
        // budget is 1.5 × euclid × worst-real-water (6.4) ≈ 1.5×9.6×~1.5km.
        expect(w.budgetM).toBeGreaterThan(0);
        expect(w.budgetM).toBeLessThan(CONNECTOR_BUDGET_FACTOR * 6.4 * 1700);
    });
});

// ── Portal synthesis ────────────────────────────────────────────────

/** A numbered N-S lateral channel as BOYLAT-ish features: ports west,
 *  stbds east, gates every ~500 m heading north (station ascends
 *  northward → the south end is seaward by IALA convention). */
const M_LAT = 1 / 110_540;
function channelFeatures(lonCentre: number, latStart: number, gates: number, key: string): unknown[] {
    const out: unknown[] = [];
    const halfWidthDeg = 0.001; // ≈100 m either side
    for (let i = 0; i < gates; i++) {
        const lat = latStart + i * 500 * M_LAT;
        out.push(
            {
                type: 'Feature',
                properties: { CATLAM: 1, OBJNAM: `${key}${i * 2 + 1}` },
                geometry: { type: 'Point', coordinates: [lonCentre - halfWidthDeg, lat] },
            },
            {
                type: 'Feature',
                properties: { CATLAM: 2, OBJNAM: `${key}${i * 2 + 2}` },
                geometry: { type: 'Point', coordinates: [lonCentre + halfWidthDeg, lat] },
            },
        );
    }
    return out;
}

describe('synthesizePortals — terminal portals one median spacing outward', () => {
    it('emits 2 portals on a 4-gate channel, ~500 m beyond the terminal mids along the axis', () => {
        const { graph } = compileSeawayGraph({
            chartFeatures: channelFeatures(153.05, -27.25, 4, 'T') as never,
        });
        expect(graph.channels).toHaveLength(1);
        const portals = synthesizePortals(graph);
        expect(portals.filter((p) => p.kind === 'portal')).toHaveLength(2);

        const seaward = portals.find((p) => p.id.endsWith('portal-seaward'))!;
        const inner = portals.find((p) => p.id.endsWith('portal-inner'))!;
        // Channel runs south→north; seaward portal extends ~500 m SOUTH of
        // the first gate, inner ~500 m NORTH of the last.
        expect(seaward.lat).toBeLessThan(-27.25);
        expect(seaward.lat).toBeCloseTo(-27.25 - 500 * M_LAT, 3);
        expect(inner.lat).toBeGreaterThan(-27.25 + 3 * 500 * M_LAT);
        expect(inner.lat).toBeCloseTo(-27.25 + 4 * 500 * M_LAT, 3);
        // On-axis: longitude unchanged.
        expect(seaward.lon).toBeCloseTo(153.05, 5);
        expect(inner.lon).toBeCloseTo(153.05, 5);
        // No grid supplied → not snapped, and consumers can see that.
        expect(seaward.snapped).toBe(false);
    });

    it('deep-snap pulls a portal off a CAUTION shoal onto charted-deep water', () => {
        const { graph } = compileSeawayGraph({
            chartFeatures: channelFeatures(153.05, -27.25, 4, 'S') as never,
        });
        // Grid covering the channel + approaches, all deep — except a
        // caution shoal blob right where the seaward portal would land.
        const g = makeGrid(200, 200);
        const seawardIdeal = { lat: -27.25 - 500 * M_LAT, lon: 153.05 };
        const ix = Math.floor((seawardIdeal.lon - g.minLon) / g.dLon);
        const iy = Math.floor((seawardIdeal.lat - g.minLat) / g.dLat);
        fillRect(g, ix - 4, iy - 4, ix + 4, iy + 4, -1); // CAUTION blob (≈450 m square)

        const portals = synthesizePortals(graph, { grid: g });
        const seaward = portals.find((p) => p.id.endsWith('portal-seaward'))!;
        expect(seaward.snapped).toBe(true);
        // It moved off the blob…
        const sx = Math.floor((seaward.lon - g.minLon) / g.dLon);
        const sy = Math.floor((seaward.lat - g.minLat) / g.dLat);
        expect(g.cells[idx(g, sx, sy)]).toBeGreaterThan(0);
        // …but stayed within one gate-spacing of the ideal point.
        const movedM = Math.hypot(
            (seaward.lon - seawardIdeal.lon) * 111_320 * Math.cos((-27.25 * Math.PI) / 180),
            (seaward.lat - seawardIdeal.lat) * 110_540,
        );
        expect(movedM).toBeLessThanOrEqual(520);
    });

    it('two crossing channels emit a junction portal near the meet', () => {
        const nsFeatures = channelFeatures(153.05, -27.25, 5, 'N');
        // E-W channel crossing the N-S one near its 3rd gate: ports north,
        // stbds south, gates every ~500 m heading east.
        const ewFeatures: unknown[] = [];
        const crossLat = -27.25 + 2 * 500 * M_LAT;
        const mPerLonHere = 111_320 * Math.cos((crossLat * Math.PI) / 180);
        for (let i = 0; i < 5; i++) {
            const lon = 153.05 + (i - 2) * (500 / mPerLonHere);
            ewFeatures.push(
                {
                    type: 'Feature',
                    properties: { CATLAM: 1, OBJNAM: `W${i * 2 + 1}` },
                    geometry: { type: 'Point', coordinates: [lon, crossLat + 0.001] },
                },
                {
                    type: 'Feature',
                    properties: { CATLAM: 2, OBJNAM: `W${i * 2 + 2}` },
                    geometry: { type: 'Point', coordinates: [lon, crossLat - 0.001] },
                },
            );
        }
        const { graph } = compileSeawayGraph({
            chartFeatures: [...nsFeatures, ...ewFeatures] as never,
        });
        expect(graph.channels.length).toBeGreaterThanOrEqual(2);
        const portals = synthesizePortals(graph);
        const junctions = portals.filter((p) => p.kind === 'junction');
        expect(junctions).toHaveLength(1);
        // The junction sits at the crossing (both channels pass through it).
        expect(junctions[0].lat).toBeCloseTo(crossLat, 3);
        expect(junctions[0].lon).toBeCloseTo(153.05, 3);
        expect(junctions[0].channelKeys).toHaveLength(2);
    });
});
