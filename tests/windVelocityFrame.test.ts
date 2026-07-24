import { describe, expect, it } from 'vitest';
import type { WindGrid } from '../services/weather/windGridEncoding';
import { windGridFrameToVelocityData } from '../components/map/windVelocityFrame';

function makeGrid(overrides: Partial<WindGrid> = {}): WindGrid {
    return {
        u: [new Float32Array([1, 2, 3, 4]), new Float32Array([11, 12, 13, 14])],
        v: [new Float32Array([5, 6, 7, 8]), new Float32Array([15, 16, 17, 18])],
        speed: [new Float32Array(4), new Float32Array(4)],
        width: 2,
        height: 2,
        lats: [-30, -29],
        lons: [150, 151],
        north: -29,
        south: -30,
        west: 150,
        east: 151,
        totalHours: 2,
        ...overrides,
    };
}

describe('windGridFrameToVelocityData', () => {
    it('renders frame zero and flips south-to-north WindGrid rows for leaflet-velocity', () => {
        const data = windGridFrameToVelocityData(makeGrid(), 0);

        expect(data).not.toBeNull();
        expect(data?.[0].data).toEqual([3, 4, 1, 2]);
        expect(data?.[1].data).toEqual([7, 8, 5, 6]);
        expect(data?.[0].header).toMatchObject({
            nx: 2,
            ny: 2,
            dx: 1,
            dy: 1,
            lo1: 150,
            lo2: 151,
            la1: -29,
            la2: -30,
            parameterNumber: 2,
        });
        expect(data?.[1].header.parameterNumber).toBe(3);
    });

    it('interpolates fractional scrubber frames before flipping their rows', () => {
        const data = windGridFrameToVelocityData(makeGrid(), 0.5);

        expect(data?.[0].data).toEqual([8, 9, 6, 7]);
        expect(data?.[1].data).toEqual([12, 13, 10, 11]);
    });

    it('clamps negative, non-finite and out-of-range frame indexes', () => {
        expect(windGridFrameToVelocityData(makeGrid(), -10)?.[0].data).toEqual([3, 4, 1, 2]);
        expect(windGridFrameToVelocityData(makeGrid(), Number.NaN)?.[0].data).toEqual([3, 4, 1, 2]);
        expect(windGridFrameToVelocityData(makeGrid(), 99)?.[0].data).toEqual([13, 14, 11, 12]);
    });

    it('holds the valid base frame if the next interpolation frame is malformed', () => {
        const grid = makeGrid({
            u: [new Float32Array([1, 2, 3, 4]), new Float32Array([99])],
            v: [new Float32Array([5, 6, 7, 8]), new Float32Array([99])],
        });

        expect(windGridFrameToVelocityData(grid, 0.5)?.[0].data).toEqual([3, 4, 1, 2]);
        expect(windGridFrameToVelocityData(grid, 0.5)?.[1].data).toEqual([7, 8, 5, 6]);
    });

    it('rejects missing, empty and dimensionally invalid grids', () => {
        expect(windGridFrameToVelocityData(null, 0)).toBeNull();
        expect(windGridFrameToVelocityData(makeGrid({ totalHours: 0 }), 0)).toBeNull();
        expect(windGridFrameToVelocityData(makeGrid({ width: 0 }), 0)).toBeNull();
        expect(
            windGridFrameToVelocityData(
                makeGrid({
                    u: [new Float32Array([1])],
                    v: [new Float32Array([1])],
                    totalHours: 1,
                }),
                0,
            ),
        ).toBeNull();
    });
});
