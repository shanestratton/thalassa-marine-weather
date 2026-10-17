import { describe, expect, it } from 'vitest';
import {
    renderScalarGridImage,
    sampleScalarGrid,
    SCALAR_MERCATOR_LAT,
    type ScalarGrid,
    type ScalarColourStop,
} from '../services/weather/scalarGridImage';

const grey: readonly ScalarColourStop[] = [
    [0, 0, 0, 0, 255],
    [100, 100, 100, 100, 255],
];
const grid = (patch: Partial<ScalarGrid> = {}): ScalarGrid => ({
    width: 2,
    height: 2,
    west: 10,
    south: -10,
    dx: 10,
    dy: 20,
    values: new Float32Array([0, 20, 40, 60]),
    validMask: new Uint8Array([1, 1, 1, 1]),
    ...patch,
});

describe('unit-neutral scalar grid images', () => {
    it('uses south-first original cells and bilinear weights without mutating inputs', () => {
        const source = grid();
        expect(sampleScalarGrid(source, 15, 0)).toBe(30);
        expect(sampleScalarGrid(source, 10, -10)).toBe(0);
        expect(sampleScalarGrid(source, 20, 10)).toBe(60);
        const image = renderScalarGridImage(source, grey, { width: 1, height: 1 });
        expect([...image.data]).toEqual([30, 30, 30, 255]);
        expect([...source.values]).toEqual([0, 20, 40, 60]);
        image.data[0] = 99;
        expect(source.values[0]).toBe(0);
    });

    it('keeps any missing contributing cell unknown, including NaN and nonbinary masks', () => {
        for (const source of [
            grid({ validMask: new Uint8Array([1, 0, 1, 1]) }),
            grid({ validMask: new Uint8Array([1, 2, 1, 1]) }),
            grid({ values: new Float32Array([0, NaN, 40, 60]) }),
        ]) {
            expect(sampleScalarGrid(source, 15, 0)).toBeNull();
            expect(sampleScalarGrid(source, 10, -10)).toBe(0);
            expect([...renderScalarGridImage(source, grey, { width: 1, height: 1 }).data]).toEqual([0, 0, 0, 0]);
        }
    });

    it('does not extrapolate beyond regional cells, poles or nonfinite coordinates', () => {
        for (const [lon, lat] of [
            [9, 0],
            [21, 0],
            [15, -11],
            [15, 11],
            [NaN, 0],
            [10, Infinity],
        ]) {
            expect(sampleScalarGrid(grid(), lon, lat)).toBeNull();
        }
        const image = renderScalarGridImage(grid(), grey, { width: 1, height: 1, bounds: [-20, -10, -10, 10] });
        expect([...image.data]).toEqual([0, 0, 0, 0]);
    });

    it('wraps a periodic dateline without inventing a repeated eastern cell', () => {
        const source = grid({
            width: 4,
            west: -180,
            dx: 90,
            wrapLongitude: true,
            values: new Float32Array([0, 10, 20, 30, 0, 10, 20, 30]),
            validMask: new Uint8Array(8).fill(1),
        });
        expect(sampleScalarGrid(source, 135, 0)).toBe(15);
        expect(sampleScalarGrid(source, -225, 0)).toBe(15);
        expect(sampleScalarGrid(source, 180, 0)).toBe(0);
        const image = renderScalarGridImage(source, grey, { width: 1, height: 1, bounds: [170, -10, 190, 10] });
        expect(image.coordinates).toEqual([
            [170, 10],
            [190, 10],
            [190, -10],
            [170, -10],
        ]);
        expect(image.data[0]).toBe(0);
    });

    it('does not bridge a missing cell across the periodic seam', () => {
        const source = grid({
            width: 4,
            west: -180,
            dx: 90,
            wrapLongitude: true,
            values: new Float32Array(8).fill(50),
            validMask: new Uint8Array([0, 1, 1, 1, 0, 1, 1, 1]),
        });
        expect(sampleScalarGrid(source, 135, 0)).toBeNull();
        expect(sampleScalarGrid(source, 90, 0)).toBe(50);
    });

    it('paints Mercator pixel centres instead of shifting the field poleward', () => {
        const source = grid({ south: 0, dy: 80, values: new Float32Array([0, 0, 80, 80]) });
        const image = renderScalarGridImage(source, grey, { width: 1, height: 1 });
        const mercatorMidLatitude =
            ((2 * Math.atan(Math.exp(Math.log(Math.tan(Math.PI / 4 + (80 * Math.PI) / 360)) / 2)) - Math.PI / 2) *
                180) /
            Math.PI;
        expect(mercatorMidLatitude).toBeCloseTo(57.04516, 4);
        expect(image.data[0]).toBe(Math.round(mercatorMidLatitude));
        expect(image.data[0]).not.toBe(40);
        expect(image.coordinates).toEqual([
            [10, 80],
            [20, 80],
            [20, 0],
            [10, 0],
        ]);
    });

    it('clips global poles at the Mercator limit and emits north-first rows', () => {
        const source = grid({ south: -90, dy: 180, values: new Float32Array([0, 0, 100, 100]) });
        const image = renderScalarGridImage(source, grey, { width: 1, height: 2 });
        expect(image.coordinates).toEqual([
            [10, SCALAR_MERCATOR_LAT],
            [20, SCALAR_MERCATOR_LAT],
            [20, -SCALAR_MERCATOR_LAT],
            [10, -SCALAR_MERCATOR_LAT],
        ]);
        expect(image.data[0]).toBeGreaterThan(image.data[4]);
    });

    it('clamps to supplied colour endpoints and interpolates alpha in native units', () => {
        const source = grid({ values: new Float32Array(4).fill(-5) });
        const stops: readonly ScalarColourStop[] = [
            [-10, 0, 20, 40, 0],
            [0, 100, 120, 140, 200],
        ];
        expect([...renderScalarGridImage(source, stops, { width: 1, height: 1 }).data]).toEqual([50, 70, 90, 100]);
        expect([
            ...renderScalarGridImage(grid({ values: new Float32Array(4).fill(-50) }), stops, { width: 1, height: 1 })
                .data,
        ]).toEqual([0, 20, 40, 0]);
        expect([
            ...renderScalarGridImage(grid({ values: new Float32Array(4).fill(50) }), stops, { width: 1, height: 1 })
                .data,
        ]).toEqual([100, 120, 140, 200]);
    });

    it.each([
        { width: 1 },
        { height: 1 },
        { width: 2.5 },
        { dx: 0 },
        { dy: -1 },
        { west: 181 },
        { south: -91 },
        { south: 80, dy: 20 },
        { values: new Float32Array(3) },
        { validMask: new Uint8Array(3) },
        { wrapLongitude: true },
        { dx: 361 },
        { width: 1100001, height: 2 },
    ])('refuses malformed or oversized source metadata %j', (patch) => {
        expect(() => sampleScalarGrid(grid(patch), 10, 0)).toThrow(RangeError);
    });

    it.each([
        { width: 0 },
        { height: 1025 },
        { width: 1.5 },
        { bounds: [10, -90, 20, 10] },
        { bounds: [10, -10, 10, 10] },
        { bounds: [170, -10, -170, 10] },
        { bounds: [-180, -10, 181, 10] },
        { bounds: [10, -10, 20, NaN] },
    ])('refuses invalid image bounds and allocations %j', (options) => {
        expect(() =>
            renderScalarGridImage(grid(), grey, options as Parameters<typeof renderScalarGridImage>[2]),
        ).toThrow(RangeError);
    });

    const invalidPalettes = [
        [],
        [[0, 0, 0, 0, 0]],
        [
            [1, 0, 0, 0, 0],
            [0, 0, 0, 0, 0],
        ],
        [
            [0, 0, 0, 0, 0],
            [0, 0, 0, 0, 0],
        ],
        [
            [0, 0, 0, 0, 0],
            [1, 256, 0, 0, 0],
        ],
        [
            [0, 0, 0, 0, 0],
            [1, 0, 0, 0, NaN],
        ],
    ];
    it.each(invalidPalettes.map((stops) => ({ stops })))('refuses invalid caller palettes %j', ({ stops }) => {
        expect(() => renderScalarGridImage(grid(), stops as unknown as ScalarColourStop[])).toThrow(RangeError);
    });

    it('checks cancellation before allocation, per row and before returning owned pixels', () => {
        let checks = 0;
        const check = () => {
            if (++checks === 3) throw new DOMException('retired', 'AbortError');
        };
        expect(() => renderScalarGridImage(grid(), grey, { width: 4, height: 4, check })).toThrow('retired');
        expect(checks).toBe(3);
        checks = 0;
        renderScalarGridImage(grid(), grey, {
            width: 1,
            height: 1,
            check: () => {
                checks++;
            },
        });
        expect(checks).toBe(3);
    });
});
