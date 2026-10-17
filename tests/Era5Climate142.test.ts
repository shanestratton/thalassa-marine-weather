import { describe, it, expect } from 'vitest';
import {
    assessEra5Climate,
    climateCellKey,
    climateRouteWeights,
    climateTileKey,
    lowerExposureMonths,
    parseClimateCell,
    climateExpectedHours,
} from '../services/climatology/era5Climate';
import { climateCellFixture } from './fixtures/climate142';

describe('142 hourly climate distributions and route qualification', () => {
    it('uses actual1991–2020 calendar hours including eight February leap days', () => {
        expect(climateExpectedHours(1)).toBe((30 * 28 + 8) * 24);
        expect(climateExpectedHours(0)).toBe(30 * 31 * 24);
        expect(parseClimateCell(climateCellFixture())).not.toBeNull();
    });
    it('refuses invalid cells, mixed/missing months and contradictory histogram/count/exceedance claims', () => {
        const mutations = [
            (c: ReturnType<typeof climateCellFixture>) => {
                c.key = '91,153';
            },
            (c: ReturnType<typeof climateCellFixture>) => {
                c.months.pop();
            },
            (c: ReturnType<typeof climateCellFixture>) => {
                c.months[0].windRose[0] = -1;
            },
            (c: ReturnType<typeof climateCellFixture>) => {
                c.months[0].windCount--;
            },
            (c: ReturnType<typeof climateCellFixture>) => {
                c.months[0].galeCount = 1;
            },
            (c: ReturnType<typeof climateCellFixture>) => {
                c.months[0].highWaveCount = 1;
            },
            (c: ReturnType<typeof climateCellFixture>) => {
                c.months[0].windYears = 2 ** 30;
            },
            (c: ReturnType<typeof climateCellFixture>) => {
                c.months[0].windCount = 1;
                c.months[0].windRose[2] = 1;
            },
        ];
        mutations.forEach((mutate) => {
            const c = climateCellFixture();
            mutate(c);
            expect(parseClimateCell(c)).toBeNull();
        });
    });
    it('keeps date-line routes short, supports reverse routes and refuses antipodal/invalid/over-budget geometry', () => {
        const forward = climateRouteWeights([
            {
                points: [
                    { lat: 0, lon: 179.7 },
                    { lat: 0, lon: -179.7 },
                ],
            },
        ]);
        const reverse = climateRouteWeights([
            {
                points: [
                    { lat: 0, lon: -179.7 },
                    { lat: 0, lon: 179.7 },
                ],
            },
        ]);
        expect([...forward.keys()]).toEqual(['0,-180']);
        expect([...forward.values()][0]).toBeCloseTo(36, 0);
        expect([...reverse.values()][0]).toBeCloseTo([...forward.values()][0], 7);
        expect(() =>
            climateRouteWeights([
                {
                    points: [
                        { lat: 0, lon: 0 },
                        { lat: 0, lon: 180 },
                    ],
                },
            ]),
        ).toThrow(/Ambiguous/);
        expect(() =>
            climateRouteWeights([
                {
                    points: [
                        { lat: NaN, lon: 0 },
                        { lat: 1, lon: 1 },
                    ],
                },
            ]),
        ).toThrow();
        expect(() =>
            climateRouteWeights([
                {
                    points: [
                        { lat: 0, lon: 0 },
                        { lat: 0, lon: 0 },
                    ],
                },
            ]),
        ).toThrow();
        expect(() =>
            climateRouteWeights(
                Array.from({ length: 15 }, () => ({
                    points: [
                        { lat: 0, lon: 0 },
                        { lat: 0, lon: 170 },
                    ],
                })),
            ),
        ).toThrow(/limit/);
        expect(climateCellKey(0, 180)).toBe('0,-180');
        expect(climateTileKey('0,-180')).toBe('18_0');
    });
    it('weights local frequencies by route length rather than pooling spatially correlated sample counts', () => {
        const first = climateCellFixture('0,0'),
            second = climateCellFixture('0,1');
        const row = second.months[0];
        row.windRose[2] = 0;
        row.windRose[6] = row.windCount;
        row.galeCount = row.windCount;
        const summary = assessEra5Climate(
            new Map([
                ['0,0', 90],
                ['0,1', 10],
            ]),
            new Map([
                ['0,0', first],
                ['0,1', second],
            ]),
        );
        expect(summary[0].gales).toBeCloseTo(0.1, 12);
        expect(summary[0].windRose.reduce((a, b) => a + b, 0)).toBeCloseTo(1);
        expect(summary[0].complete).toBe(true);
        expect(lowerExposureMonths(summary)).toEqual([1, 2, 3]);
    });
    it('does not call missing ocean cells calm or rank partial routes as best-month guidance', () => {
        const summary = assessEra5Climate(
            new Map([
                ['0,0', 90],
                ['0,1', 10],
            ]),
            new Map([['0,0', climateCellFixture('0,0')]]),
        );
        expect(summary[0]).toMatchObject({ coveredNm: 90, totalNm: 100, complete: false, windCalm: 0 });
        expect(lowerExposureMonths(summary)).toEqual([]);
        const partial = climateCellFixture('0,0');
        partial.months.forEach((row) => {
            row.windYears = 0;
        });
        expect(assessEra5Climate(new Map([['0,0', 100]]), new Map([['0,0', partial]]))[0].coveredNm).toBe(0);
    });
});
