import { describe, expect, it, vi } from 'vitest';
import { atmosPressureSymbols } from '../services/weather/atmosPressure';
import type { AtmosView } from '../services/weather/api/atmosSession';
import { generateSelectedPressureSymbols } from '../services/weather/isobars';

function view(): AtmosView {
    const values = new Float32Array(360 * 181);
    for (let row = 0; row < 181; row++) for (let col = 0; col < 360; col++) values[row * 360 + col] = 100_000 + col * 5;
    return {
        dataset: 'ifs-pressure',
        generation: 'test',
        runMs: 0,
        validMs: 0,
        isCurrent: () => true,
        fields: {
            pressure: {
                width: 360,
                height: 181,
                west: -180,
                south: -90,
                dx: 1,
                dy: 1,
                wrapLongitude: true,
                values,
                validMask: new Uint8Array(values.length).fill(1),
            },
        },
    };
}

describe('selected atmospheric pressure symbols', () => {
    it('uses actual Pa values as hPa contours with bounded Mercator latitudes', () => {
        const input = view();
        const result = atmosPressureSymbols(input);
        expect(result.contours.features.length).toBeGreaterThan(0);
        expect(Object.keys(result).sort()).toEqual(['centers', 'contours']);
        for (const feature of result.contours.features) {
            expect(feature.properties?.pressure).toBeGreaterThanOrEqual(1000);
            expect(feature.properties?.pressure).toBeLessThanOrEqual(1018);
            expect(feature.geometry.type).toBe('LineString');
            if (feature.geometry.type === 'LineString')
                for (const [lon, lat] of feature.geometry.coordinates) {
                    expect(lon).toBeGreaterThanOrEqual(-180);
                    expect(lon).toBeLessThanOrEqual(180);
                    expect(Math.abs(lat)).toBeLessThanOrEqual(85);
                }
        }
        expect(input.fields.pressure?.values[360]).toBe(100_000);
    });

    it('never draws a contour across an unknown cell', () => {
        const result = generateSelectedPressureSymbols(
            {
                values: [
                    [1000, NaN],
                    [1004, 1004],
                ],
                lats: [0, 1],
                lons: [0, 1],
                rows: 2,
                cols: 2,
            },
            () => undefined,
        );
        expect(result.contours.features).toEqual([]);
    });

    it('checks original source retirement throughout conversion and contouring', () => {
        const input = view();
        let checks = 0;
        input.isCurrent = () => ++checks < 100;
        expect(() => atmosPressureSymbols(input)).toThrow(/retired/);
        expect(checks).toBe(100);
    });

    it('refuses malformed units, unbounded matrices and adversarial output instead of allocating all frames', () => {
        const check = vi.fn();
        expect(() =>
            generateSelectedPressureSymbols(
                {
                    values: [
                        [101200, 101200],
                        [101200, 101200],
                    ],
                    lats: [0, 1],
                    lons: [0, 1],
                    rows: 2,
                    cols: 2,
                },
                check,
            ),
        ).toThrow(/units/);
        expect(() =>
            generateSelectedPressureSymbols({ values: [], lats: [], lons: [], rows: 500, cols: 500 }, check),
        ).toThrow(/bounds/);
        const values = Array.from({ length: 100 }, (_, row) =>
            Array.from({ length: 100 }, (_, col) => ((row + col) % 2 ? 950 : 1050)),
        );
        expect(() =>
            generateSelectedPressureSymbols(
                {
                    values,
                    lats: Array.from({ length: 100 }, (_, i) => i),
                    lons: Array.from({ length: 100 }, (_, i) => i),
                    rows: 100,
                    cols: 100,
                },
                check,
            ),
        ).toThrow(/output exceeds/);
    });
});
