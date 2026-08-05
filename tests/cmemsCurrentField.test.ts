/**
 * Phase 8 Lane A: CmemsCurrentField — bilinear/temporal sampling over a
 * synthetic 2×2×2 THCU grid with hand-computable expectations, plus the
 * loader's null-clean degradation over a mocked currentsGrid cache.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { currentFieldFromGrid, getCurrentField } from '../services/routing/env/CmemsCurrentField';
import type { WindGrid } from '../services/weather/windField';

const HOUR = 3_600_000;
// Step-0 reference moment — arbitrary but fixed so offsets are hand-checkable.
const T0 = Date.UTC(2026, 5, 12, 0, 0, 0);

/**
 * Synthetic 2×2×2 grid. Rows north→south (THCU layout):
 *   hour 0:  u = [1, 2,    v = u × 10
 *                 3, 4]
 *   hour 1:  u/v doubled.
 * Corners: (10N,100E)=index 0, (10N,101E)=1, (9N,100E)=2, (9N,101E)=3.
 */
function makeGrid(overrides: Partial<WindGrid> = {}): WindGrid {
    const u0 = new Float32Array([1, 2, 3, 4]);
    const v0 = new Float32Array([10, 20, 30, 40]);
    const u1 = new Float32Array([2, 4, 6, 8]);
    const v1 = new Float32Array([20, 40, 60, 80]);
    return {
        u: [u0, u1],
        v: [v0, v1],
        speed: [new Float32Array(4), new Float32Array(4)],
        width: 2,
        height: 2,
        lats: [10, 9],
        lons: [100, 101],
        north: 10,
        south: 9,
        west: 100,
        east: 101,
        totalHours: 2,
        landMask: new Uint8Array(4),
        ...overrides,
    };
}

describe('currentFieldFromGrid — sampling', () => {
    const field = currentFieldFromGrid(makeGrid(), T0);

    it('tags provenance CMEMS_HOURLY', () => {
        expect(field.provenance).toBe('CMEMS_HOURLY');
    });

    it('returns exact corner values at step 0 (rows north→south)', () => {
        expect(field.currentAt(10, 100, T0)).toEqual({ u: 1, v: 10 }); // NW corner = plane index 0
        expect(field.currentAt(10, 101, T0)).toEqual({ u: 2, v: 20 });
        expect(field.currentAt(9, 100, T0)).toEqual({ u: 3, v: 30 });
        expect(field.currentAt(9, 101, T0)).toEqual({ u: 4, v: 40 });
    });

    it('bilinear centre = mean of the 4 corners', () => {
        const c = field.currentAt(9.5, 100.5, T0);
        expect(c?.u).toBeCloseTo(2.5, 6); // (1+2+3+4)/4
        expect(c?.v).toBeCloseTo(25, 6);
    });

    it('bilinear edge midpoints interpolate one axis only', () => {
        // North edge midpoint: (1+2)/2; west edge midpoint: (1+3)/2.
        expect(field.currentAt(10, 100.5, T0)?.u).toBeCloseTo(1.5, 6);
        expect(field.currentAt(9.5, 100, T0)?.u).toBeCloseTo(2, 6);
    });

    it('temporal blend at the half hour = mean of step 0 and step 1', () => {
        const c = field.currentAt(10, 100, T0 + 0.5 * HOUR);
        expect(c?.u).toBeCloseTo(1.5, 6); // (1+2)/2
        expect(c?.v).toBeCloseTo(15, 6);
        // Centre at half-hour: spatial mean 2.5 blends to 5.0 → 3.75.
        expect(field.currentAt(9.5, 100.5, T0 + 0.5 * HOUR)?.u).toBeCloseTo(3.75, 6);
    });

    it('hits step 1 exactly at +1 h (last step, no clamp needed)', () => {
        expect(field.currentAt(10, 100, T0 + HOUR)).toEqual({ u: 2, v: 20 });
    });

    it('returns null outside the bbox', () => {
        expect(field.currentAt(10.01, 100.5, T0)).toBeNull(); // north of grid
        expect(field.currentAt(8.99, 100.5, T0)).toBeNull(); // south of grid
        expect(field.currentAt(9.5, 99.99, T0)).toBeNull(); // west of grid
        expect(field.currentAt(9.5, 101.01, T0)).toBeNull(); // east of grid
    });

    it('returns null outside the time range — no clamping', () => {
        expect(field.currentAt(10, 100, T0 - 1)).toBeNull(); // before step 0
        expect(field.currentAt(10, 100, T0 + HOUR + 1)).toBeNull(); // after last step
    });

    it('returns null where a plane holds non-finite fill values', () => {
        const grid = makeGrid();
        grid.u[0][0] = NaN; // mask the NW corner at step 0
        const f = currentFieldFromGrid(grid, T0);
        expect(f.currentAt(10, 100, T0)).toBeNull();
        expect(f.currentAt(9, 101, T0)).toEqual({ u: 4, v: 40 }); // SE corner untouched
    });

    it('fails closed without an exact-size verified land mask', () => {
        expect(currentFieldFromGrid(makeGrid({ landMask: undefined }), T0).currentAt(9.5, 100.5, T0)).toBeNull();
        expect(
            currentFieldFromGrid(makeGrid({ landMask: new Uint8Array(3) }), T0).currentAt(9.5, 100.5, T0),
        ).toBeNull();
    });

    it('rejects masked nonzero-weight coast corners but preserves exact ocean corners', () => {
        const mask = new Uint8Array([1, 0, 0, 0]); // NW is land; other three are ocean.
        const coastal = currentFieldFromGrid(makeGrid({ landMask: mask }), T0);
        expect(coastal.currentAt(10, 100, T0)).toBeNull();
        expect(coastal.currentAt(9.5, 100.5, T0)).toBeNull();
        // The masked NW cell has exactly zero interpolation weight here.
        expect(coastal.currentAt(10, 101, T0)).toEqual({ u: 2, v: 20 });
        expect(coastal.currentAt(9, 101, T0 + HOUR)).toEqual({ u: 8, v: 80 });
    });
});

describe('currentFieldFromGrid — honest step indexing', () => {
    it('uses explicit stepHours as the temporal axis (no index==hour assumption)', () => {
        // Same planes, but steps are h0 and h3 — half-way is +1.5 h.
        const field = currentFieldFromGrid(makeGrid({ stepHours: [0, 3] }), T0);
        expect(field.currentAt(10, 100, T0 + 1.5 * HOUR)?.u).toBeCloseTo(1.5, 6);
        expect(field.currentAt(10, 100, T0 + 3 * HOUR)?.u).toBeCloseTo(2, 6);
        // Coverage extends to the LAST STEP TIME, not totalHours−1.
        expect(field.currentAt(10, 100, T0 + 3 * HOUR + 1)).toBeNull();
    });

    it('falls back to hourly when stepHours length mismatches totalHours', () => {
        const field = currentFieldFromGrid(makeGrid({ stepHours: [0, 3, 6] }), T0);
        // Unreliable axis discarded → hourly: +1 h is the last step.
        expect(field.currentAt(10, 100, T0 + HOUR)?.u).toBeCloseTo(2, 6);
        expect(field.currentAt(10, 100, T0 + 1.5 * HOUR)).toBeNull();
    });
});

describe('getCurrentField — public-beta global-download hold', () => {
    const point = { lat: 9.5, lon: 100.5 };
    const range = { startMs: T0, endMs: T0 + HOUR };

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns null without performing any network request', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        expect(await getCurrentField(point, range)).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('also resolves null immediately for an already-aborted caller', async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal('fetch', fetchSpy);
        const controller = new AbortController();
        controller.abort();
        expect(await getCurrentField(point, range, controller.signal)).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
    });
});
