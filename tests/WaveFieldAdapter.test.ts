import { describe, expect, it } from 'vitest';
import { createWaveFieldFromSamples } from '../services/weather/WaveFieldAdapter';
const start = Date.parse('2026-10-17T00:00:00Z');
const sample = (extra = {}) => ({
    lat: 0,
    lon: 0,
    heightM: [1, 2, 3],
    periodS: [8, 8, 8],
    directionFromDeg: [350, 10, 30],
    ...extra,
});
const data = (samples = [sample()]) => ({ referenceTimeIso: new Date(start).toISOString(), totalHours: 3, samples });
describe('wave forecast coverage and planned clock', () => {
    it('uses departure plus offset and circular direction interpolation', () => {
        const field = createWaveFieldFromSamples(data(), start + 3_600_000)!;
        expect(field.getWave(0, 0, 0)?.heightM).toBe(2);
        const first = createWaveFieldFromSamples(data(), start)!.getWave(0, 0, 0.5)!;
        expect(first.heightM).toBe(1.5);
        expect(first.directionFromDeg % 360).toBe(0);
    });
    it('never clamps beyond the last forecast or before the first', () => {
        const field = createWaveFieldFromSamples(data(), start)!;
        expect(field.getWave(0, 0, -0.1)).toBeNull();
        expect(field.getWave(0, 0, 2)?.heightM).toBe(3);
        expect(field.getWave(0, 0, 2.1)).toBeNull();
    });
    it('does not turn a missing sheltered sample into calm or borrow a farther offshore sample', () => {
        const field = createWaveFieldFromSamples(
            data([sample({ heightM: [NaN, NaN, NaN] }), sample({ lon: 1 })]),
            start,
        )!;
        expect(field.getWave(0, 0, 0)).toBeNull();
    });
    it('requires both forecast brackets but accepts an exact observed hour', () => {
        const field = createWaveFieldFromSamples(data([sample({ heightM: [1, NaN, 3] })]), start)!;
        expect(field.getWave(0, 0, 0)?.heightM).toBe(1);
        expect(field.getWave(0, 0, 0.5)).toBeNull();
    });
});
