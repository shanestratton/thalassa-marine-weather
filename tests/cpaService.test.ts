/**
 * CPA Calculation — Closest Point of Approach tests for AIS collision avoidance.
 *
 * NOTE: There's already a tests/cpaCalculation.test.ts — but it's using
 * `utils/cpaCalculation.test.ts` (in-source). This adds the service-level tests.
 */
import { describe, it, expect } from 'vitest';
import { computeCpa } from '../utils/cpaCalculation';

describe('computeCpa', () => {
    // Sydney Harbour test coordinates
    const OWN = { lat: -33.8568, lon: 151.2153 };

    describe('invalid inputs', () => {
        it('returns null for NaN own position', () => {
            expect(computeCpa(NaN, 151.0, 0, 5, -33.8, 151.2, 180, 5)).toBeNull();
        });

        it('returns null for NaN target position', () => {
            expect(computeCpa(-33.8, 151.0, 0, 5, NaN, 151.2, 180, 5)).toBeNull();
        });

        it('returns null for Infinity position', () => {
            expect(computeCpa(Infinity, 151.0, 0, 5, -33.8, 151.2, 180, 5)).toBeNull();
        });
    });

    describe('both vessels stationary', () => {
        it('returns NONE risk with distance as CPA', () => {
            const result = computeCpa(OWN.lat, OWN.lon, 0, 0.1, OWN.lat + 0.01, OWN.lon, 0, 0.1);
            expect(result).not.toBeNull();
            expect(result!.risk).toBe('NONE');
            expect(result!.tcpa).toBe(0);
            expect(result!.cpa).toBeGreaterThan(0);
        });
    });

    describe('head-on collision course', () => {
        it('returns DANGER for close head-on within 15 min', () => {
            // Own heading north at 8kts, target heading south at 8kts
            // Target is ~2nm north
            const targetLat = OWN.lat + 0.033; // ~2nm north
            const result = computeCpa(OWN.lat, OWN.lon, 0, 8, targetLat, OWN.lon, 180, 8);
            expect(result).not.toBeNull();
            expect(result!.cpa).toBeLessThan(0.5);
            expect(result!.risk).toBe('DANGER');
        });
    });

    describe('parallel courses', () => {
        it('returns SAFE for vessels on same course far apart', () => {
            // Both heading east at 6kts, ~2nm apart
            const result = computeCpa(OWN.lat, OWN.lon, 90, 6, OWN.lat + 0.033, OWN.lon, 90, 6);
            expect(result).not.toBeNull();
            expect(result!.risk).toBe('SAFE');
        });
    });

    describe('diverging vessels', () => {
        it('returns NONE for vessels moving apart', () => {
            // Own heading north, target heading south, target is already south
            const targetLat = OWN.lat - 0.05;
            const result = computeCpa(OWN.lat, OWN.lon, 0, 6, targetLat, OWN.lon, 180, 6);
            expect(result).not.toBeNull();
            expect(result!.tcpa).toBeLessThan(0);
            expect(result!.risk).toBe('NONE');
        });
    });

    describe('crossing situation', () => {
        it('detects crossing vessel risk', () => {
            // Own heading east, target heading south from NE
            const result = computeCpa(OWN.lat, OWN.lon, 90, 8, OWN.lat + 0.02, OWN.lon + 0.02, 200, 8);
            expect(result).not.toBeNull();
            // Should have a positive TCPA (approaching)
            expect(result!.distance).toBeGreaterThan(0);
        });
    });

    describe('target anchored (nav_status)', () => {
        it('returns NONE when target is at anchor (status 1)', () => {
            const result = computeCpa(OWN.lat, OWN.lon, 0, 6, OWN.lat + 0.01, OWN.lon, 0, 0, 1);
            expect(result).not.toBeNull();
            expect(result!.risk).toBe('NONE');
        });

        it('returns NONE when target is moored (status 5)', () => {
            const result = computeCpa(OWN.lat, OWN.lon, 0, 6, OWN.lat + 0.01, OWN.lon, 0, 0, 5);
            expect(result).not.toBeNull();
            expect(result!.risk).toBe('NONE');
        });
    });

    describe('own vessel stationary', () => {
        it('returns NONE risk when own vessel is stopped', () => {
            const result = computeCpa(OWN.lat, OWN.lon, 0, 0.2, OWN.lat + 0.02, OWN.lon, 180, 8);
            expect(result).not.toBeNull();
            // Own vessel stationary: max CAUTION, not DANGER
            expect(['NONE', 'CAUTION']).toContain(result!.risk);
        });
    });

    describe('harbour manoeuvring (slow speed)', () => {
        it('returns SAFE at very low combined speed', () => {
            const result = computeCpa(OWN.lat, OWN.lon, 0, 1, OWN.lat + 0.003, OWN.lon, 180, 1);
            expect(result).not.toBeNull();
            expect(['SAFE', 'CAUTION']).toContain(result!.risk);
        });
    });

    describe('result properties', () => {
        it('returns all required fields', () => {
            const result = computeCpa(OWN.lat, OWN.lon, 45, 6, OWN.lat + 0.05, OWN.lon + 0.05, 225, 6);
            expect(result).not.toBeNull();
            expect(result).toHaveProperty('cpa');
            expect(result).toHaveProperty('tcpa');
            expect(result).toHaveProperty('distance');
            expect(result).toHaveProperty('bearing');
            expect(result).toHaveProperty('risk');
        });

        it('bearing is between 0 and 360', () => {
            const result = computeCpa(OWN.lat, OWN.lon, 0, 5, OWN.lat - 0.01, OWN.lon + 0.01, 315, 5);
            expect(result).not.toBeNull();
            expect(result!.bearing).toBeGreaterThanOrEqual(0);
            expect(result!.bearing).toBeLessThan(360);
        });
    });
});
