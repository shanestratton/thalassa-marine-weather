/**
 * Land backstop tests — the caller-side sweep that rejects inshore routes
 * crossing land through chart-coverage gaps (Newport→Mooloolaba field bug:
 * the engine routed dead-straight over Bribie Island with zero caution
 * because uncharted space is engine-navigable).
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    findLandRuns,
    inshoreRouteCrossesLand,
    samplePolyline,
    MIN_RUN_SAMPLES,
    type LonLat,
} from '../services/routing/landBackstop';
import type { DepthResult } from '../services/GebcoDepthService';
import { GebcoDepthService } from '../services/GebcoDepthService';

const d = (depth: number | null, i = 0): DepthResult => ({ lat: -27 - i * 0.001, lon: 153, depth_m: depth });

describe('findLandRuns', () => {
    it('clean water → no runs', () => {
        expect(findLandRuns([d(-20), d(-15), d(-8), d(-30)])).toEqual([]);
    });

    it('a solid island reads as one long run', () => {
        const runs = findLandRuns([d(-20), d(0), d(5), d(12), d(3), d(-18)]);
        expect(runs.length).toBe(1);
        expect(runs[0].startIdx).toBe(1);
        expect(runs[0].samples).toBe(4);
    });

    it('a single coastal-pixel kiss is below the rejection threshold', () => {
        const runs = findLandRuns([d(-20), d(1), d(-20)]);
        expect(runs.length).toBe(1);
        expect(runs[0].samples).toBe(1);
        expect(runs[0].samples).toBeLessThan(MIN_RUN_SAMPLES); // caller filters it out
    });

    it('null depths (ETOPO fetch gaps) break runs — unknown is not land', () => {
        const runs = findLandRuns([d(2), d(null), d(2)]);
        expect(runs.length).toBe(2);
        expect(runs.every((r) => r.samples === 1)).toBe(true);
    });

    it('dredged channels (negative ETOPO elevation) never read as land', () => {
        expect(findLandRuns([d(-2.1), d(-1.5), d(-3)])).toEqual([]);
    });
});

describe('inshoreRouteCrossesLand', () => {
    const route: LonLat[] = [
        [153, -27],
        [153.01, -27],
    ];

    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('verifies a fully sampled below-sea-level ocean route', async () => {
        vi.spyOn(GebcoDepthService, 'queryRouteDepths').mockImplementation(async (points) =>
            points.map(({ lat, lon }) => ({ lat, lon, depth_m: -25 })),
        );

        await expect(inshoreRouteCrossesLand(route)).resolves.toMatchObject({
            status: 'verified',
            crossesLand: false,
        });
    });

    it('rejects a positive-elevation island run', async () => {
        vi.spyOn(GebcoDepthService, 'queryRouteDepths').mockImplementation(async (points) =>
            points.map(({ lat, lon }, index) => ({ lat, lon, depth_m: index === 0 ? -25 : 4 })),
        );

        await expect(inshoreRouteCrossesLand(route)).resolves.toMatchObject({
            status: 'verified',
            crossesLand: true,
        });
    });

    it('reports null depth coverage as unavailable instead of clear', async () => {
        vi.spyOn(GebcoDepthService, 'queryRouteDepths').mockImplementation(async (points) =>
            points.map(({ lat, lon }, index) => ({ lat, lon, depth_m: index === 1 ? null : -25 })),
        );

        const result = await inshoreRouteCrossesLand(route);
        expect(result.status).toBe('unavailable');
        expect(result.crossesLand).toBe(false);
        expect(result.samplesChecked).toBeLessThan(result.samplesRequested);
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
