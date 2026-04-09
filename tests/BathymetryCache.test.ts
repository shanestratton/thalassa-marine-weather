/**
 * BathymetryCache — Unit tests
 *
 * Tests the pure grid lookup functions: getDepthFromCache, isLand, isNearShore.
 * Does NOT test preloadBathymetry (async fetch).
 */

import { describe, it, expect } from 'vitest';
import { getDepthFromCache, isLand, isNearShore } from '../services/BathymetryCache';
import type { BathymetryGrid } from '../services/BathymetryCache';

// ── Helper: build a test grid ───────────────────────────────────

function makeGrid(overrides: Partial<BathymetryGrid> = {}): BathymetryGrid {
    // Default: 5×5 grid, -40 to -36 lat, 150 to 154 lon, all deep water
    const rows = 5;
    const cols = 5;
    const data = new Float32Array(rows * cols);
    data.fill(-100); // Deep water

    return {
        south: -40,
        north: -36,
        west: 150,
        east: 154,
        latStep: 1,
        lonStep: 1,
        rows,
        cols,
        data,
        ...overrides,
    };
}

// ── getDepthFromCache ───────────────────────────────────────────

describe('getDepthFromCache', () => {
    it('returns depth for a point within the grid', () => {
        const grid = makeGrid();
        const depth = getDepthFromCache(grid, -38, 152);
        expect(depth).toBe(-100);
    });

    it('returns null for point outside grid bounds (south)', () => {
        const grid = makeGrid();
        expect(getDepthFromCache(grid, -41, 152)).toBeNull();
    });

    it('returns null for point outside grid bounds (north)', () => {
        const grid = makeGrid();
        expect(getDepthFromCache(grid, -35, 152)).toBeNull();
    });

    it('returns null for point outside grid bounds (west)', () => {
        const grid = makeGrid();
        expect(getDepthFromCache(grid, -38, 149)).toBeNull();
    });

    it('returns null for point outside grid bounds (east)', () => {
        const grid = makeGrid();
        expect(getDepthFromCache(grid, -38, 155)).toBeNull();
    });

    it('returns null for NaN data (no coverage)', () => {
        const grid = makeGrid();
        grid.data[12] = NaN; // Center cell
        expect(getDepthFromCache(grid, -38, 152)).toBeNull();
    });

    it('returns correct depth for specific cell', () => {
        const grid = makeGrid();
        // Set cell at row 2, col 3 to -45m
        grid.data[2 * 5 + 3] = -45;
        const depth = getDepthFromCache(grid, -38, 153);
        expect(depth).toBe(-45);
    });

    it('returns positive value for land', () => {
        const grid = makeGrid();
        grid.data[2 * 5 + 2] = 50; // 50m above sea level
        const depth = getDepthFromCache(grid, -38, 152);
        expect(depth).toBe(50);
    });
});

// ── isLand ──────────────────────────────────────────────────────

describe('isLand', () => {
    it('returns false for deep water', () => {
        const grid = makeGrid();
        expect(isLand(grid, -38, 152)).toBe(false);
    });

    it('returns true when point is on land (depth >= 0)', () => {
        const grid = makeGrid();
        // Set a cell to land
        grid.data[2 * 5 + 2] = 10;
        expect(isLand(grid, -38, 152)).toBe(true);
    });

    it('returns true when adjacent cell is land (conservative)', () => {
        const grid = makeGrid();
        // Set cell at [2][3] to land — adjacent to [2][2]
        grid.data[2 * 5 + 3] = 5;
        // Point near the boundary should still detect land
        expect(isLand(grid, -38, 152.4)).toBe(true);
    });

    it('returns false for points outside grid', () => {
        const grid = makeGrid();
        grid.data.fill(100); // All land
        expect(isLand(grid, -50, 152)).toBe(false); // Way outside
    });

    it('detects land at grid edges', () => {
        const grid = makeGrid();
        grid.data[0] = 10; // SW corner is land
        expect(isLand(grid, -40, 150)).toBe(true);
    });
});

// ── isNearShore ─────────────────────────────────────────────────

describe('isNearShore', () => {
    it('returns false in open ocean (all cells deep)', () => {
        const grid = makeGrid();
        expect(isNearShore(grid, -38, 152, 2)).toBe(false);
    });

    it('returns true when land is within radius', () => {
        const grid = makeGrid();
        // Set cell at [1][1] to land
        grid.data[1 * 5 + 1] = 10;
        // Check from [2][2] with radius=2 — should detect land at [1][1]
        expect(isNearShore(grid, -38, 152, 2)).toBe(true);
    });

    it('returns false when land is beyond radius', () => {
        const grid = makeGrid();
        // Set cell at [0][0] to land
        grid.data[0] = 10;
        // Check from [4][4] with radius=1 — too far
        expect(isNearShore(grid, -36, 154, 1)).toBe(false);
    });

    it('returns false for points outside grid', () => {
        const grid = makeGrid();
        grid.data.fill(100);
        expect(isNearShore(grid, -50, 152)).toBe(false);
    });

    it('default radius is 2', () => {
        const grid = makeGrid();
        grid.data[1 * 5 + 1] = 10;
        // Using default radius — should still detect
        expect(isNearShore(grid, -38, 152)).toBe(true);
    });
});
