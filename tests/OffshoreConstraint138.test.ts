import { describe, expect, it, vi } from 'vitest';
import { computeOffshoreKernel } from '../services/isochrone/offshoreKernel';
import { routeSegmentAllowed } from '../services/routing/routeConstraints';
const polar = {
    windSpeeds: [5, 10, 15],
    angles: [0, 45, 90, 135, 180],
    matrix: [
        [0, 0, 0],
        [3, 5, 6],
        [4, 6, 7],
        [3, 5, 6],
        [2, 4, 5],
    ],
};
const wind = { getWind: () => ({ speed: 10, direction: 270 }) };
describe('the real offshore expansion respects user barriers', () => {
    it('cannot return an arrival or recovery shortcut after every expanded segment is refused', async () => {
        const segmentAllowed = vi.fn(() => false);
        const result = await computeOffshoreKernel(
            { lat: 0, lon: 0 },
            { lat: 0, lon: 0.5 },
            '2026-10-17T12:00:00Z',
            polar,
            wind,
            { timeStepHours: 1, maxHours: 12, useDepthPenalty: false, segmentAllowed },
        );
        expect(segmentAllowed).toHaveBeenCalled();
        expect(result).toBeNull();
    });
    it('keeps every final smoothed segment on the permitted side of a spherical half-line', async () => {
        const rays = [{ lat: 0, lon: 0.25, bearing: 0 }];
        const segmentAllowed = (a: { lat: number; lon: number }, b: { lat: number; lon: number }) =>
            routeSegmentAllowed(a, b, rays);
        const result = await computeOffshoreKernel(
            { lat: -0.1, lon: 0 },
            { lat: -0.1, lon: 0.5 },
            '2026-10-17T12:00:00Z',
            polar,
            wind,
            { timeStepHours: 1, maxHours: 12, useDepthPenalty: false, segmentAllowed },
        );
        expect(result).not.toBeNull();
        expect(result!.route.every((p, i) => !i || segmentAllowed(result!.route[i - 1], p))).toBe(true);
    });
});
