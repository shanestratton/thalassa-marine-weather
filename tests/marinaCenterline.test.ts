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
    centrelineSimplify,
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

describe('centrelineSimplify', () => {
    it('de-staircases a straight diagonal to its endpoints (no spurious bends)', () => {
        const w = 10,
            h = 10;
        const passable = new Uint8Array(w * h).fill(1);
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
        const out = centrelineSimplify(stair, passable, { width: w, height: h });
        // Stair noise ≤ 1 cell < tolerance → collapses to the straight diagonal.
        expect(out.length).toBe(2);
        expect(out[0]).toEqual({ x: 1, y: 1 });
        expect(out[out.length - 1]).toEqual({ x: 5, y: 5 });
    });

    it('PRESERVES a mid-channel arc that string-pull flattens onto the bank (the wall-hug)', () => {
        const w = 12,
            h = 8;
        const passable = new Uint8Array(w * h).fill(1);
        // A centreline that bows UP, away from the low edge — exactly what the
        // marina cost field produces in a channel running alongside land (the bank
        // is the bottom edge; the route belongs in the MIDDLE, up at y≈1).
        const arc: Cell[] = [
            { x: 0, y: 6 },
            { x: 2, y: 4 },
            { x: 4, y: 2 },
            { x: 6, y: 1 },
            { x: 8, y: 2 },
            { x: 10, y: 4 },
            { x: 11, y: 6 },
        ];
        const pulled = stringPull(arc, passable, { width: w, height: h });
        const kept = centrelineSimplify(arc, passable, { width: w, height: h });
        // Taut-pull throws the whole arc away: one straight chord along the low edge.
        expect(pulled.length).toBe(2);
        // Douglas–Peucker keeps the apex, so the route still rides mid-channel.
        expect(kept.length).toBeGreaterThan(2);
        const apexY = Math.min(...kept.map((c) => c.y));
        expect(apexY).toBeLessThanOrEqual(2);
    });

    it('never collapses a chord across land (water guard holds)', () => {
        const w = 11,
            h = 7;
        const passable = new Uint8Array(w * h).fill(1);
        // Carve a land headland the straight chord would cut through: block the
        // middle columns at the low rows so a taut shortcut is impossible.
        for (let y = 3; y < h; y++) for (let x = 4; x <= 6; x++) passable[y * w + x] = 0;
        // A path that detours UP and over the headland.
        const detour: Cell[] = [
            { x: 0, y: 5 },
            { x: 2, y: 4 },
            { x: 4, y: 1 },
            { x: 6, y: 1 },
            { x: 8, y: 4 },
            { x: 10, y: 5 },
        ];
        const kept = centrelineSimplify(detour, passable, { width: w, height: h });
        // Every retained segment must stay entirely in water.
        for (let i = 0; i < kept.length - 1; i++) {
            const a = kept[i];
            const b = kept[i + 1];
            const n = Math.max(Math.abs(b.x - a.x), Math.abs(b.y - a.y));
            for (let t = 0; t <= n; t++) {
                const x = Math.round(a.x + ((b.x - a.x) * t) / n);
                const y = Math.round(a.y + ((b.y - a.y) * t) / n);
                expect(passable[y * w + x]).toBe(1);
            }
        }
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

describe('routeMarina — corridor bias keeps the route in the channel, not the basin', () => {
    // Shane's Newport case in miniature: the satellite water is a NARROW curving channel
    // with a WIDE basin attached to one side. The medial axis (which prefers the widest
    // water) drifts into the basin; the supplied corridor (the coarse A* line that already
    // threads the channel) must pull it back so it rides the curving channel centre.
    const w = 80;
    const h = 50;
    function buildGrid(): { depth: Float32Array; corridor: Cell[] } {
        const depth = new Float32Array(w * h).fill(NaN); // NaN = land
        const wet = (x: number, y: number): void => {
            if (x >= 0 && y >= 0 && x < w && y < h) depth[y * w + x] = 10;
        };
        const corridor: Cell[] = [];
        for (let y = 2; y <= h - 3; y++) {
            // A ~21-cell-wide water body (like Newport's ~200 m basin at 12 m/cell, so the
            // EDT stays under the canalHalfWidth cap and the medial axis hits the TRUE centre
            // at x≈20). The navigable CHANNEL is the left side — the corridor at x=12 — while
            // the right half is non-channel basin. The medial axis rides x≈20 (centre); the
            // corridor must pull it left onto the channel at x≈12.
            for (let x = 10; x <= 30; x++) wet(x, y);
            corridor.push({ x: 12, y });
        }
        return { depth, corridor };
    }
    const distToCorridor = (c: Cell, corridor: Cell[]): number =>
        Math.min(...corridor.map((k) => Math.hypot(k.x - c.x, k.y - c.y)));

    it('drifts into the basin WITHOUT the corridor, tracks the channel WITH it', () => {
        const { depth, corridor } = buildGrid();
        const shape = { width: w, height: h };
        const start: Cell = { x: 12, y: 3 };
        const end: Cell = { x: 12, y: h - 4 };
        const base = { keelCells: 1, depthWeight: 0, canalHalfWidthCells: 12, bias: 5 };

        const noBias = routeMarina(depth, shape, start, end, base);
        expect(noBias).not.toBeNull();
        const noBiasMax = Math.max(...noBias!.cells.map((c) => distToCorridor(c, corridor)));

        const withBias = routeMarina(
            depth,
            shape,
            start,
            end,
            { ...base, corridorWeight: 8, corridorHalfWidthCells: 6 },
            corridor,
        );
        expect(withBias).not.toBeNull();
        const withBiasMax = Math.max(...withBias!.cells.map((c) => distToCorridor(c, corridor)));

        console.log(
            `[corridor-bias] max off-corridor: noBias=${noBiasMax.toFixed(1)} → withBias=${withBiasMax.toFixed(1)} cells`,
        );
        assertNoLandCrossing(withBias!.cells, depth, w);
        expect(noBiasMax).toBeGreaterThan(5); // the unbiased medial axis rides the basin centre, off the channel
        expect(withBiasMax).toBeLessThan(3); // the corridor pulls it back onto the channel side
    });
});

describe('routeMarina — corridor bias rounds bends instead of hugging the inside wall', () => {
    // Shane's Newport bend in miniature. An L-shaped 9-wide channel; the supplied corridor
    // (the coarse A* line) CUTS the inside of the curve. The flat corridor reward rides the
    // route onto the inside wall ("a little close to the wall on the bend"); the clearance
    // gate (corridorComfortCells) attenuates the reward near walls so the route rounds the
    // bend at comfortable clearance — while straights, where the corridor is mid-channel,
    // stay byte-identical (the gate is 1 there).
    const w = 60;
    const h = 60;
    function buildL(): { depth: Float32Array; corridor: Cell[]; water: Uint8Array } {
        const depth = new Float32Array(w * h).fill(NaN);
        const water = new Uint8Array(w * h);
        const wet = (x: number, y: number): void => {
            if (x >= 0 && y >= 0 && x < w && y < h) {
                depth[y * w + x] = 10;
                water[y * w + x] = 1;
            }
        };
        for (let y = 10; y <= 18; y++) for (let x = 5; x <= 40; x++) wet(x, y); // horizontal arm
        for (let y = 10; y <= 50; y++) for (let x = 32; x <= 40; x++) wet(x, y); // vertical arm
        // Corridor hugs the INSIDE corner (~2 cells off the inner walls).
        const corridor: Cell[] = [];
        for (let x = 5; x <= 33; x++) corridor.push({ x, y: 17 });
        for (let y = 17; y <= 50; y++) corridor.push({ x: 33, y });
        return { depth, corridor, water };
    }

    it('rounds the bend WITH the clearance gate, hugs the inside wall without it', () => {
        const { depth, corridor, water } = buildL();
        const shape = { width: w, height: h };
        const clearance = euclideanDistanceTransform(water, shape);
        const start: Cell = { x: 6, y: 14 };
        const end: Cell = { x: 36, y: 48 };
        const base = {
            keelCells: 1,
            depthWeight: 0,
            canalHalfWidthCells: 12,
            bias: 5,
            corridorWeight: 8,
            corridorHalfWidthCells: 6,
        };
        // Min wall-clearance the route holds through the corner region.
        const cornerMin = (cells: Cell[]): number => {
            let m = Infinity;
            for (const c of cells) {
                if (c.x >= 30 && c.x <= 42 && c.y >= 14 && c.y <= 22) m = Math.min(m, clearance[c.y * w + c.x]);
            }
            return m;
        };

        const flat = routeMarina(depth, shape, start, end, base, corridor);
        const gated = routeMarina(depth, shape, start, end, { ...base, corridorComfortCells: 4 }, corridor);
        expect(flat).not.toBeNull();
        expect(gated).not.toBeNull();
        assertNoLandCrossing(flat!.cells, depth, w);
        assertNoLandCrossing(gated!.cells, depth, w);

        const flatMin = cornerMin(flat!.cells);
        const gatedMin = cornerMin(gated!.cells);

        console.log(
            `[bend-gate] corner min clearance: flat=${flatMin.toFixed(1)} → gated=${gatedMin.toFixed(1)} cells`,
        );
        expect(flatMin).toBeLessThanOrEqual(2.5); // the flat reward seats the route on the inside wall
        expect(gatedMin).toBeGreaterThanOrEqual(flatMin + 1.5); // the gate pushes it off the wall
        expect(gatedMin).toBeGreaterThanOrEqual(3.5); // ... to comfortable clearance
        expect(gated!.minClearanceCells).toBeGreaterThanOrEqual(flat!.minClearanceCells); // no clearance regression
    });

    it('introduces NO wobble on a straight reach (gate = 1 near a mid-channel corridor)', () => {
        const sw = 30;
        const sh = 40;
        const depth = new Float32Array(sw * sh).fill(NaN);
        for (let y = 2; y <= sh - 3; y++) for (let x = 10; x <= 18; x++) depth[y * sw + x] = 10; // 9-wide straight
        const corridor: Cell[] = [];
        for (let y = 2; y <= sh - 3; y++) corridor.push({ x: 14, y }); // dead centre
        const base = {
            keelCells: 1,
            depthWeight: 0,
            canalHalfWidthCells: 12,
            bias: 5,
            corridorWeight: 8,
            corridorHalfWidthCells: 6,
            corridorComfortCells: 4,
        };
        const r = routeMarina(depth, { width: sw, height: sh }, { x: 14, y: 3 }, { x: 14, y: sh - 4 }, base, corridor);
        expect(r).not.toBeNull();
        const maxOff = Math.max(...r!.cells.map((c) => Math.abs(c.x - 14)));

        console.log(`[straight-gate] max off-centre = ${maxOff} cells`);
        expect(maxOff).toBeLessThanOrEqual(1);
    });
});
