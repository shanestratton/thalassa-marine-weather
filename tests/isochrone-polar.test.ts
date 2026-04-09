/**
 * Isochrone Polar Performance — Unit tests
 *
 * Tests the factory-based polar speed lookup: interpolation between
 * TWS/TWA brackets, clamping, and edge cases.
 */

import { describe, it, expect } from 'vitest';
import { createPolarSpeedLookup } from '../services/isochrone/polar';
import type { PolarData } from '../types';

// ── Helper: simple polar data ───────────────────────────────────

function makeSimplePolar(): PolarData {
    return {
        windSpeeds: [6, 10, 16, 20],
        angles: [52, 60, 75, 90, 110, 120, 135, 150],
        matrix: [
            // TWA 52: [TWS 6, 10, 16, 20]
            [3.5, 5.2, 6.1, 6.3],
            // TWA 60
            [4.0, 5.8, 6.8, 7.0],
            // TWA 75
            [4.5, 6.2, 7.5, 7.8],
            // TWA 90
            [4.8, 6.5, 7.8, 8.1],
            // TWA 110
            [4.6, 6.3, 7.6, 7.9],
            // TWA 120
            [4.2, 5.9, 7.2, 7.5],
            // TWA 135
            [3.8, 5.4, 6.5, 6.8],
            // TWA 150
            [3.2, 4.8, 5.8, 6.0],
        ],
    } as PolarData;
}

// ── Tests ───────────────────────────────────────────────────────

describe('createPolarSpeedLookup', () => {
    it('returns exact values at grid points', () => {
        const polar = makeSimplePolar();
        const lookup = createPolarSpeedLookup(polar, 10); // TWS = 10 (exact bracket)
        expect(lookup(90)).toBeCloseTo(6.5, 1); // matrix[3][1]
    });

    it('interpolates between TWA brackets', () => {
        const polar = makeSimplePolar();
        const lookup = createPolarSpeedLookup(polar, 10);

        // TWA 67.5 is halfway between 60 and 75
        const speed = lookup(67.5);
        const expected = (5.8 + 6.2) / 2; // midpoint
        expect(speed).toBeCloseTo(expected, 1);
    });

    it('interpolates between TWS brackets', () => {
        const polar = makeSimplePolar();
        // TWS 13 is between 10 and 16
        const lookup = createPolarSpeedLookup(polar, 13);
        const speed = lookup(90);

        // 6.5 + (7.8 - 6.5) * (13-10)/(16-10) = 6.5 + 0.65 = 7.15
        expect(speed).toBeCloseTo(7.15, 1);
    });

    it('clamps TWA below minimum angle', () => {
        const polar = makeSimplePolar();
        const lookup = createPolarSpeedLookup(polar, 10);

        // TWA 30 is below min angle 52 — should clamp to 52
        expect(lookup(30)).toBeCloseTo(lookup(52), 5);
    });

    it('clamps TWA above maximum angle', () => {
        const polar = makeSimplePolar();
        const lookup = createPolarSpeedLookup(polar, 10);

        // TWA 170 is above max angle 150 — should clamp to 150
        expect(lookup(170)).toBeCloseTo(lookup(150), 5);
    });

    it('clamps TWS below minimum wind speed', () => {
        const polar = makeSimplePolar();
        const lookup = createPolarSpeedLookup(polar, 2); // Below min TWS of 6
        // Should use TWS=6 values
        expect(lookup(90)).toBeCloseTo(4.8, 1); // matrix[3][0]
    });

    it('clamps TWS above maximum wind speed', () => {
        const polar = makeSimplePolar();
        const lookup = createPolarSpeedLookup(polar, 30); // Above max TWS of 20
        // Should use TWS=20 values
        expect(lookup(90)).toBeCloseTo(8.1, 1); // matrix[3][3]
    });

    it('handles negative TWA (symmetric)', () => {
        const polar = makeSimplePolar();
        const lookup = createPolarSpeedLookup(polar, 10);

        // abs(-90) = 90
        expect(lookup(-90)).toBeCloseTo(lookup(90), 5);
    });

    it('returns 0 for empty polar data', () => {
        const emptyPolar = { windSpeeds: [], angles: [], matrix: [] } as unknown as PolarData;
        const lookup = createPolarSpeedLookup(emptyPolar, 10);
        expect(lookup(90)).toBe(0);
    });

    it('speed increases from close-hauled to beam reach', () => {
        const polar = makeSimplePolar();
        const lookup = createPolarSpeedLookup(polar, 10);

        const closeHauled = lookup(52);
        const beamReach = lookup(90);
        expect(beamReach).toBeGreaterThan(closeHauled);
    });

    it('speed decreases from beam reach to deep downwind', () => {
        const polar = makeSimplePolar();
        const lookup = createPolarSpeedLookup(polar, 10);

        const beamReach = lookup(90);
        const downwind = lookup(150);
        expect(beamReach).toBeGreaterThan(downwind);
    });
});
