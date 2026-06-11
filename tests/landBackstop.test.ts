/**
 * Land backstop tests — the caller-side sweep that rejects inshore routes
 * crossing land through chart-coverage gaps (Newport→Mooloolaba field bug:
 * the engine routed dead-straight over Bribie Island with zero caution
 * because uncharted space is engine-navigable).
 */

import { describe, expect, it } from 'vitest';
import { findLandRuns, samplePolyline, MIN_RUN_SAMPLES, type LonLat } from '../services/routing/landBackstop';
import type { DepthResult } from '../services/GebcoDepthService';

const d = (depth: number | null, i = 0): DepthResult => ({ lat: -27 - i * 0.001, lon: 153, depth_m: depth });

describe('findLandRuns', () => {
    it('clean water → no runs', () => {
        expect(findLandRuns([d(20), d(15), d(8), d(30)])).toEqual([]);
    });

    it('a solid island reads as one long run', () => {
        const runs = findLandRuns([d(20), d(0), d(-5), d(-12), d(-3), d(18)]);
        expect(runs.length).toBe(1);
        expect(runs[0].startIdx).toBe(1);
        expect(runs[0].samples).toBe(4);
    });

    it('a single coastal-pixel kiss is below the rejection threshold', () => {
        const runs = findLandRuns([d(20), d(-1), d(20)]);
        expect(runs.length).toBe(1);
        expect(runs[0].samples).toBe(1);
        expect(runs[0].samples).toBeLessThan(MIN_RUN_SAMPLES); // caller filters it out
    });

    it('null depths (GEBCO gaps) break runs — unknown is not land', () => {
        const runs = findLandRuns([d(-2), d(null), d(-2)]);
        expect(runs.length).toBe(2);
        expect(runs.every((r) => r.samples === 1)).toBe(true);
    });

    it('dredged channels (positive water depth) never read as land', () => {
        expect(findLandRuns([d(2.1), d(1.5), d(3)])).toEqual([]);
    });
});

describe('samplePolyline', () => {
    it('samples a long leg at the step interval, both ends included', () => {
        // ~11.1 km due north → ~28 samples at 400 m + endpoints
        const line: LonLat[] = [
            [153, -27.0],
            [153, -26.9],
        ];
        const samples = samplePolyline(line, 400, 180);
        expect(samples.length).toBeGreaterThan(25);
        expect(samples.length).toBeLessThan(32);
        expect(samples[0]).toEqual([153, -27.0]);
        expect(samples[samples.length - 1]).toEqual([153, -26.9]);
    });

    it('caps total samples on very long routes', () => {
        const line: LonLat[] = [
            [153, -27.5],
            [153, -25.0], // ~278 km
        ];
        const samples = samplePolyline(line, 400, 180);
        expect(samples.length).toBeLessThanOrEqual(181);
    });

    it('degenerate input passes through', () => {
        expect(samplePolyline([[153, -27]] as LonLat[])).toEqual([[153, -27]]);
    });
});
