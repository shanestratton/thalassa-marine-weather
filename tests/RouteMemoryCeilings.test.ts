// @vitest-environment node
/**
 * The Airlie Jetsam hunt (2026-09-02): a third, ~450nm route crashed the
 * phone while the chart expanded around the Whitsundays. Verified culprits,
 * each pinned here:
 *
 *  - navGridCache was count-capped (5) under a "≈1 MB each" comment while
 *    long-route grids weigh 50-70 MB — up to ~350 MB parked for the session.
 *  - isCanalNarrow measured width in CELLS on a grid whose cells had grown
 *    to ~830 m, so island passages read as "canals"…
 *  - …which triggered the fine 12 m pass, whose narrow branch had NO length
 *    cap, over an archipelago-sized crop.
 */
import { describe, expect, it, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { NAV_GRID_CACHE_BYTE_BUDGET, navGridBytes, navGridCache, trimNavGridCache } from '../services/engine/navGrid';
import { coarseCellM, isCanalNarrow, MAX_FINE_PASS_COARSE_RES_M } from '../services/tier3/fineCanalGrid';
import type { NavGrid } from '../services/engine/types';

const fakeGrid = (cellCount: number): NavGrid =>
    ({
        width: cellCount,
        height: 1,
        cells: new Float32Array(cellCount),
        shallowDepthM: new Float32Array(cellCount),
        landBlocked: new Uint8Array(cellCount),
        minLat: 0,
        minLon: 0,
        dLat: 50 / 111_320,
        dLon: 50 / 111_320,
    }) as unknown as NavGrid;

describe('navGridCache byte budget', () => {
    beforeEach(() => navGridCache.clear());

    it('navGridBytes sums every typed-array field', () => {
        const grid = fakeGrid(1000);
        // 2× Float32 (4B) + 1× Uint8 = 9 B/cell.
        expect(navGridBytes(grid)).toBe(9000);
    });

    it('trims oldest-first down to the byte budget', () => {
        const mb = 1024 * 1024;
        navGridCache.set('a', { grid: fakeGrid(0), ts: 1, bytes: 30 * mb });
        navGridCache.set('b', { grid: fakeGrid(0), ts: 2, bytes: 30 * mb });
        navGridCache.set('c', { grid: fakeGrid(0), ts: 3, bytes: 30 * mb });
        trimNavGridCache(NAV_GRID_CACHE_BYTE_BUDGET); // 48 MB
        expect([...navGridCache.keys()]).toEqual(['c']);
        trimNavGridCache(0); // the memory-warning dump
        expect(navGridCache.size).toBe(0);
    });
});

describe('the canal question is asked in metres', () => {
    /** A horizontal water channel `widthCells` tall in a sea of land. */
    const channelGrid = (cellM: number, widthCells: number): NavGrid => {
        const W = 24;
        const H = 24;
        const cells = new Float32Array(W * H).fill(Number.NaN); // land
        const mid = Math.floor(H / 2);
        const half = Math.floor(widthCells / 2);
        for (let y = mid - half; y <= mid + half; y++) {
            for (let x = 0; x < W; x++) cells[y * W + x] = 10; // water
        }
        const d = cellM / 111_320;
        return { width: W, height: H, cells, minLat: 0, minLon: 0, dLat: d, dLon: d } as unknown as NavGrid;
    };

    const midPolyline = (grid: { dLat: number; dLon: number }, cellsY: number): [number, number][] => {
        const lat = (cellsY + 0.5) * grid.dLat;
        return [
            [2.5 * grid.dLon, lat],
            [20.5 * grid.dLon, lat],
        ];
    };

    it('a 5-cell channel at native 50m cells is a canal', () => {
        const grid = channelGrid(50, 5);
        const line = midPolyline(grid, 12);
        expect(coarseCellM(grid)).toBeCloseTo(50, 0);
        expect(isCanalNarrow(grid, line, { fromIdx: 0, toIdx: 1 } as never)).toBe(true);
    });

    it('the same 5-cell channel at 830m cells — 4km of open water — is NOT', () => {
        // This is the Whitsundays illusion: island passages kilometres wide
        // read "≤8 cells" on a coarsened grid and armed the uncapped 12m
        // fine pass. In metres, 4.1km can never be a canal.
        const grid = channelGrid(830, 5);
        const line = midPolyline(grid, 12);
        expect(coarseCellM(grid)).toBeCloseTo(830, 0);
        expect(isCanalNarrow(grid, line, { fromIdx: 0, toIdx: 1 } as never)).toBe(false);
    });
});

describe('source pins — every layer of the ceiling', () => {
    const fine = readFileSync(resolve(process.cwd(), 'services/tier3/fineCanalGrid.ts'), 'utf8');
    const pipeline = readFileSync(resolve(process.cwd(), 'services/engine/tierPipeline.ts'), 'utf8');
    const grid = readFileSync(resolve(process.cwd(), 'services/engine/navGrid.ts'), 'utf8');
    const gauge = readFileSync(resolve(process.cwd(), 'services/native/memoryGauge.ts'), 'utf8');

    it('the fine pass declines outright on a coarsened grid', () => {
        expect(MAX_FINE_PASS_COARSE_RES_M).toBe(100);
        expect(fine).toContain("return { leg: null, diag: 'coarse-grid' };");
        expect(fine).toContain('if (coarseCellM(coarseGrid) > MAX_FINE_PASS_COARSE_RES_M) return false;');
    });

    it('the fine builder holds a hard cell budget of its own', () => {
        expect(pipeline).toContain('const MAX_FINE_CELLS = 2_000_000;');
        expect(pipeline).toContain(
            'if (!Number.isFinite(projectedCells) || projectedCells > MAX_FINE_CELLS) return null;',
        );
    });

    it('the memory warning also sheds the ENC hazard indexes', () => {
        // Field trail 2026-09-02: death at 87s of Whitsundays merge churn —
        // the ENC index cache (~100-190MB, session-lived) was the biggest
        // remaining droppable ballast. Indexes rebuild lazily; a browse
        // hiccup beats a dead app.
        expect(gauge).toContain('clearIndexCache()');
    });

    it('the grid cache admits by bytes and the memory warning dumps it', () => {
        expect(grid).toContain('trimNavGridCache(Math.max(0, NAV_GRID_CACHE_BYTE_BUDGET - bytes));');
        expect(gauge).toContain('trimNavGridCache(0)');
    });
});
