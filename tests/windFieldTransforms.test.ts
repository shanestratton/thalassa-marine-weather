import { describe, expect, it } from 'vitest';
import { applyGustField } from '../services/weather/windFieldTransforms';
import type { WindGrid } from '../services/weather/windField';

/** Minimal 2×1 single-hour grid builder. */
function grid(over: Partial<WindGrid> = {}): WindGrid {
    return {
        u: [new Float32Array([3, 0])],
        v: [new Float32Array([4, 0])],
        speed: [new Float32Array([5, 0])],
        width: 2,
        height: 1,
        lats: [0],
        lons: [0, 1],
        north: 0,
        south: 0,
        west: 0,
        east: 1,
        totalHours: 1,
        ...over,
    };
}

const angle = (u: number, v: number) => Math.atan2(v, u);

describe('applyGustField', () => {
    it('is a no-op when the grid carries no gust data', () => {
        const g = grid();
        expect(applyGustField(g)).toBe(g); // same reference — untouched
    });

    it('is a no-op when the gust array is empty', () => {
        const g = grid({ gust: [] });
        expect(applyGustField(g)).toBe(g);
    });

    it('rescales u/v to the gust magnitude while preserving direction', () => {
        // Cell 0: wind (3,4) = 5 m/s; gust 10 m/s → magnitude doubles, same heading.
        const g = grid({ gust: [new Float32Array([10, 0])] });
        const out = applyGustField(g);

        const u0 = out.u[0][0];
        const v0 = out.v[0][0];
        expect(Math.hypot(u0, v0)).toBeCloseTo(10, 5); // magnitude == gust
        expect(out.speed[0][0]).toBeCloseTo(10, 5); // speed channel == gust
        expect(angle(u0, v0)).toBeCloseTo(angle(3, 4), 6); // direction preserved
    });

    it('leaves u/v at zero for a calm cell but still reports gust in speed', () => {
        // Cell 1 is calm (u=v=0). A nonzero gust there has no direction to ride.
        const g = grid({ gust: [new Float32Array([10, 8])] });
        const out = applyGustField(g);
        expect(out.u[0][1]).toBe(0);
        expect(out.v[0][1]).toBe(0);
        expect(out.speed[0][1]).toBeCloseTo(8, 5); // heatmap still shows the gust
    });

    it('does not mutate the input grid', () => {
        const g = grid({ gust: [new Float32Array([10, 0])] });
        const u0Before = g.u[0][0];
        applyGustField(g);
        expect(g.u[0][0]).toBe(u0Before); // original untouched (new arrays returned)
    });

    it('passes a hour through unchanged when that hour lacks gust data (ragged source)', () => {
        const g = grid({
            u: [new Float32Array([3, 0]), new Float32Array([6, 0])],
            v: [new Float32Array([4, 0]), new Float32Array([8, 0])],
            speed: [new Float32Array([5, 0]), new Float32Array([10, 0])],
            // Only hour 0 has gust; hour 1 is missing it.
            gust: [new Float32Array([10, 0])],
            totalHours: 2,
        });
        const out = applyGustField(g);
        // Hour 1 falls back to the original sustained-wind vector.
        expect(out.u[1][0]).toBe(6);
        expect(out.v[1][0]).toBe(8);
    });
});
