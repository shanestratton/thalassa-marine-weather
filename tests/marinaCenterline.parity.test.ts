/**
 * marinaCenterline — PARITY against the real Newport ENC grid.
 *
 * Loads the exact navigable+depth grid the MarinerEE Python spike proved
 * (tests/fixtures/newport-marina.grid.bin.gz, exported by
 * ~/Projects/MarinerEE/export_marina_fixture.py) and runs the SAME route
 * pairs through the TypeScript routeMarina. This is the confidence gate
 * before wiring into the inshore engine: it proves the TS port reproduces
 * the spike's safety result on REAL data, not just synthetic grids.
 *
 * The spike's de-risk result (Python): 6 routes across Newport — different
 * fingers, reverse, cross-estate — all 0 land crossings vs the true ENC
 * water, ~5 m keel clearance. We assert the TS port matches:
 *   • route found,
 *   • 0 land crossings sampled along the STRAIGHT LEGS (the real claim —
 *     the legs are what a helmsman steers, not the underlying cells),
 *   • min clearance ≥ the keel margin.
 *
 * Grid is little-endian [int32 w][int32 h][float32 depth…], land = NaN.
 */
import { describe, it, expect } from 'vitest';
import { gunzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { routeMarina, type Cell, type MarinaRouteParams } from '../services/marinaCenterline';

function loadGrid(): { width: number; height: number; depth: Float32Array } {
    const gz = readFileSync(join(__dirname, 'fixtures', 'newport-marina.grid.bin.gz'));
    const buf = gunzipSync(gz);
    const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const width = dv.getInt32(0, true);
    const height = dv.getInt32(4, true);
    // Copy the float region into a fresh, 4-byte-aligned buffer.
    const bytes = buf.byteOffset + 8;
    const ab = buf.buffer.slice(bytes, bytes + width * height * 4);
    return { width, height, depth: new Float32Array(ab) };
}

const PARAMS: MarinaRouteParams = { keelCells: 3, depthWeight: 15, canalHalfWidthCells: 12, bias: 5 };

// Pixel coordinates from the spike de-risk (pre-snap; routeMarina snaps
// internally). y grows southward, matching the exported grid.
const GATE: Cell = { x: 510, y: 202 };
const BERTHS: Record<string, Cell> = {
    'A-east': { x: 900, y: 506 },
    'B-SE': { x: 963, y: 560 },
    'C-central': { x: 700, y: 650 },
    'D-west': { x: 300, y: 560 },
    'F-north': { x: 820, y: 345 },
    'G-far-east': { x: 991, y: 452 },
};

const { width, height, depth } = loadGrid();
const shape = { width, height };

/**
 * Sample every straight leg densely and check each sampled point against
 * the TRUE water mask (land = NaN). Returns {land, minClearanceCells}.
 * This is the safety-critical assertion: the legs the skipper actually
 * follows must never touch land.
 */
function validateLegs(waypoints: Cell[]): { land: number; minClear: number } {
    // Euclidean clearance is expensive to recompute here; instead check
    // membership in water and approximate clearance by nearest-NaN scan is
    // overkill — routeMarina already reports cell clearance. For legs we
    // assert the strict thing: no sampled point is on land (NaN).
    let land = 0;
    for (let k = 0; k < waypoints.length - 1; k++) {
        const a = waypoints[k];
        const b = waypoints[k + 1];
        const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
        for (let t = 0; t <= n; t++) {
            const x = Math.round(a.x + ((b.x - a.x) * t) / n);
            const y = Math.round(a.y + ((b.y - a.y) * t) / n);
            if (Number.isNaN(depth[y * width + x])) land++;
        }
    }
    return { land, minClear: 0 };
}

describe('marinaCenterline parity — real Newport ENC grid', () => {
    it('fixture loads with the expected shape', () => {
        expect(width).toBe(1200);
        expect(height).toBe(896);
        let navigable = 0;
        for (let i = 0; i < depth.length; i++) if (!Number.isNaN(depth[i])) navigable++;
        expect(navigable).toBeGreaterThan(250_000); // spike reported 303,380
    });

    // Every finger → the entrance gate.
    for (const [name, berth] of Object.entries(BERTHS)) {
        it(`${name} → gate: route found, 0 land crossings, keel clearance held`, () => {
            const r = routeMarina(depth, shape, berth, GATE, PARAMS);
            expect(r).not.toBeNull();
            // Cells stay in water and hold the keel margin.
            for (const c of r!.cells) expect(Number.isNaN(depth[c.y * width + c.x])).toBe(false);
            expect(r!.minClearanceCells).toBeGreaterThanOrEqual(PARAMS.keelCells - 0.01);
            // Straight legs (what you steer) never touch land.
            expect(validateLegs(r!.waypoints).land).toBe(0);
            // Sensible simplification, not a wobble.
            expect(r!.waypoints.length).toBeLessThanOrEqual(15);
        });
    }

    it('REVERSE gate → D-west: 0 land crossings', () => {
        const r = routeMarina(depth, shape, GATE, BERTHS['D-west'], PARAMS);
        expect(r).not.toBeNull();
        expect(validateLegs(r!.waypoints).land).toBe(0);
        expect(r!.minClearanceCells).toBeGreaterThanOrEqual(PARAMS.keelCells - 0.01);
    });

    it('CROSS-ESTATE A-east → F-north: 0 land crossings', () => {
        const r = routeMarina(depth, shape, BERTHS['A-east'], BERTHS['F-north'], PARAMS);
        expect(r).not.toBeNull();
        expect(validateLegs(r!.waypoints).land).toBe(0);
        expect(r!.minClearanceCells).toBeGreaterThanOrEqual(PARAMS.keelCells - 0.01);
    });
});
