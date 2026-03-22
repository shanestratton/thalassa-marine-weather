/**
 * windVector — Unit tests for wind vector calculation.
 *
 * WindData takes uComponent/vComponent (m/s) and returns speedKnots/directionDegrees.
 */
import { describe, it, expect } from 'vitest';
import { calculateWindVector, WindData } from './windVector';

describe('calculateWindVector', () => {
    it('calculates for pure northward wind (v > 0, u = 0)', () => {
        const data: WindData = { uComponent: 0, vComponent: 10 };
        const result = calculateWindVector(data);
        expect(result.speedKnots).toBeGreaterThan(0);
        expect(typeof result.directionDegrees).toBe('number');
    });

    it('calculates for pure eastward wind (u > 0, v = 0)', () => {
        const data: WindData = { uComponent: 10, vComponent: 0 };
        const result = calculateWindVector(data);
        expect(result.speedKnots).toBeGreaterThan(0);
    });

    it('handles zero wind speed', () => {
        const data: WindData = { uComponent: 0, vComponent: 0 };
        const result = calculateWindVector(data);
        expect(result.speedKnots).toBeCloseTo(0, 5);
    });

    it('calculates correct speed in knots for known values', () => {
        // 10 m/s ≈ 19.44 knots
        const data: WindData = { uComponent: 10, vComponent: 0 };
        const result = calculateWindVector(data);
        expect(result.speedKnots).toBeCloseTo(19.44, 0);
    });

    it('returns direction in 0-360 range', () => {
        const data: WindData = { uComponent: 5, vComponent: -5 };
        const result = calculateWindVector(data);
        expect(result.directionDegrees).toBeGreaterThanOrEqual(0);
        expect(result.directionDegrees).toBeLessThanOrEqual(360);
    });
});
