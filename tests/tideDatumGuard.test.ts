import { describe, expect, it } from 'vitest';
import { buildTideCurve } from '../services/TideHeightService';
import type { WorldTidesResponse } from '../types/api';

/** Pure interpolation fixtures do not grant provider permission to production. */
const synthetic = (datum?: string): WorldTidesResponse => ({
    status: 200,
    responseDatum: datum,
    extremes: [
        { dt: 1000, date: '', height: 0.1, type: 'Low' },
        { dt: 22600, date: '', height: 2.1, type: 'High' },
    ],
});

describe('pure curve datum validation, independent of provider-use permission', () => {
    it('retains explicit LAT on an isolated synthetic interpolation fixture', () => {
        expect(buildTideCurve(synthetic('LAT'))?.datum).toBe('LAT');
    });
    it.each(['MLLW', 'LLWLT', 'MSL', undefined])('refuses %s instead of relabelling it LAT', (datum) => {
        expect(buildTideCurve(synthetic(datum))).toBeNull();
    });
    it('never lets the requested LAT override an explicitly different response datum', () => {
        expect(buildTideCurve({ ...synthetic('MLLW'), requestDatum: 'LAT' })).toBeNull();
    });
});
