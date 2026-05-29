/**
 * marinaCenterline — algorithm correctness on small, hand-verifiable grids.
 *
 * These prove the TS ports of the MarinerEE primitives behave (EDT,
 * largest-component, centerline Dijkstra, string-pull, and the full
 * routeMarina pipeline) before we run the full-Newport parity fixture and
 * wire into the inshore engine. The safety invariant under test is the
 * one that matters: a returned route never crosses land, and an
 * unconnected start/end returns null (show RED, don't fake passage).
 */
import { describe, it, expect } from 'vitest';
import {
    euclideanDistanceTransform,
    largestComponent,
    stringPull,
    routeMarina,
    type Cell,
} from '../services/marinaCenterline';

describe('euclideanDistanceTransform', () => {
    it('1D: distance grows from the background into the object', () => {
        // mask 0 1 1 1 0 → object cells measure distance to nearest 0.
        const d = euclideanDistanceTransform(new Uint8Array([0, 1, 1, 1, 0]), { width: 5, height: 1 });
        expect(Array.from(d)).toEqual([0, 1, 2, 1, 0]);
    });

    it('2D: centre of a 3x3 block is sqrt(2) from the diagonal background', () => {
        // 5x5 all object except the border is background.
        const w = 5,
            h = 5;
        const m = new Uint8Array(w * h);
        for (let y = 1; y < 4; y++) for (let x = 1; x < 4; x++) m[y * w + x] = 1;
        const d = euclideanDistanceTransform(m, { width: w, height: h });
        // Centre (2,2): nearest background is a border cell; the closest is
        // orthogonal at distance 2 (e.g. (2,0)) vs diagonal (0,0)=2√2, so 2.
        expect(d[2 * w + 2]).toBeCloseTo(2, 5);
        // An edge-of-block cell (1,2): nearest bg (0,2) at distance 1.
        expect(d[2 * w + 1]).toBeCloseTo(1, 5);
    });
});

describe('largestComponent', () => {
    it('keeps the big blob, drops the orphan', () => {
        const w = 10,
            h = 3;
        const m = new Uint8Array(w * h);
        // Big blob: x 0..5 on row 1. Orphan: x 8..9 on row 1.
        for (let x = 0; x <= 5; x++) m[1 * w + x] = 1;
        for (let x = 8; x <= 9; x++) m[1 * w + x] = 1;
        const out = largestComponent(m, { width: w, height: h });
        expect(out[1 * w + 3]).toBe(1); // in big blob
        expect(out[1 * w + 8]).toBe(0); // orphan dropped
        expect(out[1 * w + 9]).toBe(0);
    });
});

describe('stringPull', () => {
    it('collapses a staircase along open ground to its endpoints', () => {
        const w = 10,
            h = 10;
        const passable = new Uint8Array(w * h).fill(1);
        // A staircased diagonal from (1,1) to (5,5).
        const stair: Cell[] = [
            { x: 1, y: 1 },
            { x: 2, y: 1 },
            { x: 2, y: 2 },
            { x: 3, y: 2 },
            { x: 3, y: 3 },
            { x: 4, y: 3 },
            { x: 4, y: 4 },
            { x: 5, y: 4 },
            { x: 5, y: 5 },
        ];
        const pulled = stringPull(stair, passable, { width: w, height: h });
        // Open ground → straight line, just the two endpoints.
        expect(pulled.length).toBe(2);
        expect(pulled[0]).toEqual({ x: 1, y: 1 });
        expect(pulled[pulled.length - 1]).toEqual({ x: 5, y: 5 });
    });
});

/** Helper: assert no cell of a path sits on land (NaN depth). */
function assertNoLandCrossing(cells: Cell[], depth: Float32Array, width: number) {
    for (const c of cells) {
        expect(Number.isNaN(depth[c.y * width + c.x])).toBe(false);
    }
}

describe('routeMarina', () => {
    const params = { keelCells: 2, depthWeight: 15, canalHalfWidthCells: 6, bias: 5 };

    it('straight channel → few straight legs, 0 land crossings, keel clearance held', () => {
        const w = 60,
            h = 21;
        const depth = new Float32Array(w * h).fill(NaN);
        for (let y = 7; y <= 13; y++) for (let x = 2; x < w - 2; x++) depth[y * w + x] = 5;
        const r = routeMarina(depth, { width: w, height: h }, { x: 3, y: 10 }, { x: w - 3, y: 10 }, params);
        expect(r).not.toBeNull();
        assertNoLandCrossing(r!.cells, depth, w);
        expect(r!.waypoints.length).toBeLessThanOrEqual(3); // essentially straight
        expect(r!.minClearanceCells).toBeGreaterThanOrEqual(params.keelCells);
    });

    it('L-shaped channel → keeps the necessary bend, still 0 land crossings', () => {
        const w = 40,
            h = 40;
        const depth = new Float32Array(w * h).fill(NaN);
        // Horizontal leg (rows 4..10, x 4..30) + vertical leg (x 24..30, y 4..34).
        for (let y = 4; y <= 10; y++) for (let x = 4; x <= 30; x++) depth[y * w + x] = 5;
        for (let y = 4; y <= 34; y++) for (let x = 24; x <= 30; x++) depth[y * w + x] = 5;
        const r = routeMarina(depth, { width: w, height: h }, { x: 5, y: 7 }, { x: 27, y: 33 }, params);
        expect(r).not.toBeNull();
        assertNoLandCrossing(r!.cells, depth, w);
        // A bend is forced → more than 2 waypoints, but still a handful.
        expect(r!.waypoints.length).toBeGreaterThanOrEqual(3);
        expect(r!.waypoints.length).toBeLessThanOrEqual(8);
    });

    it('disconnected basins → null (no safe passage; never fake it)', () => {
        const w = 40,
            h = 20;
        const depth = new Float32Array(w * h).fill(NaN);
        // Two separate water boxes with a land wall between (no connection).
        for (let y = 6; y <= 13; y++) for (let x = 2; x <= 15; x++) depth[y * w + x] = 5;
        for (let y = 6; y <= 13; y++) for (let x = 24; x <= 37; x++) depth[y * w + x] = 5;
        const r = routeMarina(depth, { width: w, height: h }, { x: 5, y: 10 }, { x: 30, y: 10 }, params);
        expect(r).toBeNull();
    });
});
