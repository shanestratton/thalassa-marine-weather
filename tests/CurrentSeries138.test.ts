import { describe, expect, it } from 'vitest';
import {
    createCurrentSeriesSampler,
    splitCurrentBounds,
    validateCurrentSeries,
    CURRENT_SERIES_MAX_BYTES,
    type CurrentSeries,
} from '../services/weather/currentSeries';
import { createCurrentFieldFromSeries } from '../services/weather/CurrentFieldAdapter';
import { currentFieldFromSeries } from '../services/routing/env/CmemsCurrentField';

const T = Date.UTC(2026, 9, 16);
const H = 3_600_000;
function fixture(): CurrentSeries {
    return {
        schema: 1,
        model: 'CMEMS',
        dataset: 'generated-public-fixture',
        generation: 'generated-20261016',
        sourceSha256: 'a'.repeat(64),
        runMs: T,
        expiresMs: T + 120 * H,
        units: 'm/s',
        vectorBasis: 'true-east-north',
        depthM: 0,
        tiles: [
            {
                id: 'generated-cell',
                north: 1,
                south: 0,
                west: 0,
                east: 1,
                width: 2,
                height: 2,
                ocean: {
                    cadenceHours: 1,
                    times: [T, T + H],
                    u: [new Float32Array([0, 2, 0, 2]), new Float32Array([2, 4, 2, 4])],
                    v: [new Float32Array([1, 1, 1, 1]), new Float32Array([3, 3, 3, 3])],
                    known: [new Uint8Array([1, 1, 1, 1]), new Uint8Array([1, 1, 1, 1])],
                },
            },
        ],
    };
}

describe('strict public current series', () => {
    it('shares exact vectors between offshore relative clocks and inshore absolute ETA clocks', () => {
        const series = fixture();
        const offshore = createCurrentFieldFromSeries(series, T + H / 4)!;
        const inshore = currentFieldFromSeries(series);
        const vector = inshore.currentAt(0.5, 0.5, T + H / 2)!;
        expect(offshore.getCurrent(0.5, 0.5, 0.25)?.speed).toBeCloseTo(
            Math.hypot(vector.u, vector.v) * 1.9438444924406,
        );
        expect(offshore.getCurrent(0.5, 0.5, 0.25)?.direction).toBeCloseTo(45);
        expect(inshore.forecast).toMatchObject({ model: 'CMEMS', components: 'ocean', runMs: T });
        expect(createCurrentFieldFromSeries(series, NaN)).toBeNull();
    });
    it('interpolates actual u/v components in space and at a fractional absolute time', () => {
        const series = fixture();
        expect(validateCurrentSeries(series)).toBe(72);
        expect(createCurrentSeriesSampler(series)(0.5, 0.5, T + H / 2)).toMatchObject({
            u: 2,
            v: 2,
            components: 'ocean',
            model: 'CMEMS',
            runMs: T,
            generation: series.generation,
        });
    });
    it('interpolates a real three-hour model axis without treating indices as hours', () => {
        const series = fixture();
        series.model = 'RTOFS';
        series.tiles[0].ocean.cadenceHours = 3;
        series.tiles[0].ocean.times[1] = T + 3 * H;
        expect(createCurrentSeriesSampler(series)(0.5, 0.5, T + 1.5 * H)).toMatchObject({ u: 2, v: 2 });
    });
    it.each([-1, 1 + 1 / H])('does not extrapolate at hour%s', (hours) => {
        expect(createCurrentSeriesSampler(fixture())(0.5, 0.5, T + hours * H)).toBeNull();
    });
    it('ignores mathematically zero-weight NaN corners and temporal neighbours', () => {
        const series = fixture();
        const planes = series.tiles[0].ocean;
        planes.u[0].fill(NaN);
        planes.v[0].fill(NaN);
        planes.known[0].fill(0);
        planes.u[1].fill(NaN);
        planes.v[1].fill(NaN);
        planes.known[1].fill(0);
        planes.u[0][0] = 0;
        planes.v[0][0] = 0;
        planes.known[0][0] = 1;
        const sample = createCurrentSeriesSampler(series);
        expect(sample(1, 0, T)).toMatchObject({ u: 0, v: 0 });
        expect(sample(1, 0.001, T)).toBeNull();
        expect(sample(1, 0, T + 1)).toBeNull();
    });
    it('does not convert a land/unknown zero to a current', () => {
        const series = fixture();
        series.tiles[0].ocean.known[0][0] = 0;
        expect(createCurrentSeriesSampler(series)(1, 0, T)).toBeNull();
    });
    it('requires both tide components and a covering temporal bracket when tide is requested', () => {
        const series = fixture();
        expect(createCurrentSeriesSampler(series, 'ocean+tide')(0.5, 0.5, T)).toBeNull();
        series.tiles[0].tide = {
            cadenceHours: 1,
            times: [T, T + H],
            u: [new Float32Array(4).fill(0.5), new Float32Array(4).fill(0.5)],
            v: [new Float32Array(4).fill(-0.5), new Float32Array(4).fill(-0.5)],
            known: [new Uint8Array(4).fill(1), new Uint8Array(4).fill(1)],
        };
        expect(createCurrentSeriesSampler(series, 'ocean+tide')(0.5, 0.5, T + H / 2)).toMatchObject({ u: 2.5, v: 1.5 });
        series.tiles[0].tide.known[1][0] = 0;
        expect(createCurrentSeriesSampler(series, 'ocean+tide')(0.5, 0.5, T + H / 2)).toBeNull();
    });
    it('refuses unverified units, vector coordinates and foreign tidal components', () => {
        const series = fixture();
        expect(() => validateCurrentSeries({ ...series, units: 'cm/s' } as unknown as CurrentSeries)).toThrow('units');
        expect(() => validateCurrentSeries({ ...series, vectorBasis: 'grid' } as unknown as CurrentSeries)).toThrow(
            'basis',
        );
        series.model = 'RTOFS';
        series.tiles[0].ocean.cadenceHours = 3;
        series.tiles[0].ocean.times[1] = T + 3 * H;
        series.tiles[0].tide = series.tiles[0].ocean;
        expect(() => validateCurrentSeries(series)).toThrow('tidal model');
    });
    it.each([
        [T, T],
        [T + H, T],
        [T, T + 2 * H],
        [T, NaN],
    ])('refuses missing/nonmonotonic or invalid time axis%s', (a, b) => {
        const series = fixture();
        series.tiles[0].ocean.times = [a, b];
        expect(() => validateCurrentSeries(series)).toThrow('time axis');
    });
    it('refuses huge backing buffers even if a view has plausible dimensions', () => {
        const series = fixture();
        series.tiles[0].ocean.u[0] = new Float32Array(new ArrayBuffer(CURRENT_SERIES_MAX_BYTES + 1), 0, 4);
        expect(() => validateCurrentSeries(series)).toThrow('backing buffer');
    });
    it('rejects a known NaN and infinity even behind an unknown mask', () => {
        const series = fixture();
        series.tiles[0].ocean.u[0][0] = NaN;
        expect(() => validateCurrentSeries(series)).toThrow('nonfinite');
        series.tiles[0].ocean.known[0][0] = 0;
        series.tiles[0].ocean.u[0][0] = Infinity;
        expect(() => validateCurrentSeries(series)).toThrow('velocity');
    });
    it('samples both representations of the180-degree seam consistently', () => {
        const series = fixture();
        series.tiles[0].west = -180;
        series.tiles[0].east = -179;
        const sample = createCurrentSeriesSampler(series);
        expect(sample(0.5, 180, T)).toEqual(sample(0.5, -180, T));
        expect(sample(0.5, 179, T)).toBeNull();
    });
    it('splits wrapped bboxes and refuses invalid/empty bounds', () => {
        expect(splitCurrentBounds({ north: 1, south: 0, west: 179, east: -179 })).toEqual([
            { north: 1, south: 0, west: 179, east: 180 },
            { north: 1, south: 0, west: -180, east: -179 },
        ]);
        expect(splitCurrentBounds({ north: 1, south: 0, west: 1, east: 1 })).toBeNull();
        expect(splitCurrentBounds({ north: NaN, south: 0, west: 1, east: 2 })).toBeNull();
    });
});
