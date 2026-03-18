/**
 * CPA Calculation unit tests — harbour-aware collision risk assessment.
 *
 * Tests cover:
 * - Basic CPA/TCPA computation accuracy
 * - Harbour-aware risk levels (stationary, anchored, low speed)
 * - Edge cases (invalid inputs, parallel courses, diverging vessels)
 * - COLREGS-compliant danger/caution thresholds
 */
import { describe, it, expect } from 'vitest';
import { computeCpa } from './cpaCalculation';

// ── Test vessel positions ──
// Newport Harbour area (approx)
const NEWPORT = { lat: -33.735, lon: 151.305 };
// A point ~0.5 NM north of Newport
const NORTH_05 = { lat: -33.7267, lon: 151.305 };
// A point ~2 NM east of Newport
const _EAST_2 = { lat: -33.735, lon: 151.338 };

describe('computeCpa', () => {
    describe('basic computation', () => {
        it('returns null for invalid own position', () => {
            expect(computeCpa(NaN, 0, 0, 5, -33, 151, 180, 5)).toBeNull();
            expect(computeCpa(Infinity, 0, 0, 5, -33, 151, 180, 5)).toBeNull();
        });

        it('returns null for invalid target position', () => {
            expect(computeCpa(-33, 151, 0, 5, NaN, 151, 180, 5)).toBeNull();
        });

        it('computes distance between two points', () => {
            const result = computeCpa(NEWPORT.lat, NEWPORT.lon, 0, 5, NORTH_05.lat, NORTH_05.lon, 180, 5);
            expect(result).not.toBeNull();
            // ~0.5 NM apart
            expect(result!.distance).toBeGreaterThan(0.4);
            expect(result!.distance).toBeLessThan(0.6);
        });

        it('computes bearing correctly (target due north)', () => {
            const result = computeCpa(NEWPORT.lat, NEWPORT.lon, 0, 5, NORTH_05.lat, NORTH_05.lon, 180, 5);
            expect(result).not.toBeNull();
            // Bearing should be roughly 0° (north) — either 0 or close to 360
            expect(result!.bearing >= 355 || result!.bearing <= 5).toBe(true);
        });

        it('head-on collision produces small CPA', () => {
            // Two vessels heading straight at each other
            const result = computeCpa(
                -33.735,
                151.305,
                0,
                8, // Own: heading north at 8kn
                -33.72,
                151.305,
                180,
                8, // Target: heading south at 8kn
            );
            expect(result).not.toBeNull();
            expect(result!.cpa).toBeLessThan(0.1); // Nearly 0 CPA
            expect(result!.tcpa).toBeGreaterThan(0); // Converging
        });

        it('parallel courses produce large CPA', () => {
            // Two vessels heading same direction, side by side
            const result = computeCpa(
                -33.735,
                151.305,
                0,
                8, // Own: heading north at 8kn
                -33.735,
                151.32,
                0,
                8, // Target: same heading, east
            );
            expect(result).not.toBeNull();
            // CPA should be close to current distance (they never converge)
            expect(result!.cpa).toBeGreaterThan(0.5);
        });
    });

    describe('harbour-aware risk levels', () => {
        it('both vessels stationary → NONE', () => {
            const result = computeCpa(
                NEWPORT.lat,
                NEWPORT.lon,
                0,
                0.1, // Own barely moving
                NORTH_05.lat,
                NORTH_05.lon,
                0,
                0.2, // Target barely moving
            );
            expect(result).not.toBeNull();
            expect(result!.risk).toBe('NONE');
        });

        it('target anchored (nav_status 1) → NONE even if close', () => {
            const result = computeCpa(
                NEWPORT.lat,
                NEWPORT.lon,
                0,
                5,
                NORTH_05.lat,
                NORTH_05.lon,
                180,
                2,
                1, // anchored
            );
            expect(result).not.toBeNull();
            expect(result!.risk).toBe('NONE');
        });

        it('target moored (nav_status 5) → NONE', () => {
            const result = computeCpa(
                NEWPORT.lat,
                NEWPORT.lon,
                0,
                5,
                NORTH_05.lat,
                NORTH_05.lon,
                180,
                2,
                5, // moored
            );
            expect(result).not.toBeNull();
            expect(result!.risk).toBe('NONE');
        });

        it('target aground (nav_status 6) → NONE', () => {
            const result = computeCpa(
                NEWPORT.lat,
                NEWPORT.lon,
                0,
                5,
                NORTH_05.lat,
                NORTH_05.lon,
                180,
                2,
                6, // aground
            );
            expect(result).not.toBeNull();
            expect(result!.risk).toBe('NONE');
        });

        it('own vessel stationary, target slow → NONE', () => {
            const result = computeCpa(
                NEWPORT.lat,
                NEWPORT.lon,
                0,
                0.1,
                NORTH_05.lat,
                NORTH_05.lon,
                180,
                2,
                0, // underway
            );
            expect(result).not.toBeNull();
            expect(result!.risk).toBe('NONE');
        });

        it('own vessel stationary, fast target barrelling toward → CAUTION', () => {
            // Target at 5kn heading directly at us, very close
            const result = computeCpa(
                NEWPORT.lat,
                NEWPORT.lon,
                0,
                0.1, // Stationary
                -33.733,
                151.305,
                180,
                5, // Very close, heading south
                0,
            );
            expect(result).not.toBeNull();
            // Should be at most CAUTION (not DANGER) even if imminent
            expect(['NONE', 'CAUTION']).toContain(result!.risk);
        });

        it('low combined speed (< 3 kn) in harbour → SAFE', () => {
            const result = computeCpa(
                NEWPORT.lat,
                NEWPORT.lon,
                0,
                1.2,
                NORTH_05.lat,
                NORTH_05.lon,
                180,
                1.2,
                0, // underway
            );
            expect(result).not.toBeNull();
            expect(['SAFE', 'NONE']).toContain(result!.risk);
        });
    });

    describe('COLREGS underway thresholds', () => {
        it('head-on close quarters (CPA < 0.5, TCPA < 15) → DANGER', () => {
            // Two vessels heading straight at each other at speed
            const result = computeCpa(
                -33.735,
                151.305,
                0,
                8, // Own: heading north at 8kn
                -33.72,
                151.305,
                180,
                8, // Target: heading south at 8kn, ~0.9 NM away
                0,
            );
            expect(result).not.toBeNull();
            expect(result!.risk).toBe('DANGER');
        });

        it('diverging vessels → NONE', () => {
            // Both heading away from each other
            const result = computeCpa(
                -33.735,
                151.305,
                180,
                8, // Own: heading south
                -33.72,
                151.305,
                0,
                8, // Target: heading north (away)
                0,
            );
            expect(result).not.toBeNull();
            expect(result!.risk).toBe('NONE');
            expect(result!.tcpa).toBeLessThan(0);
        });

        it('passing well clear → SAFE', () => {
            // Vessels crossing at right angles, will pass well clear
            const result = computeCpa(
                -33.735,
                151.305,
                0,
                5, // Own: heading north
                -33.735,
                151.4,
                270,
                5, // Target: heading west, far east
                0,
            );
            expect(result).not.toBeNull();
            expect(result!.risk).toBe('SAFE');
        });
    });

    describe('edge cases', () => {
        it('same position, both stationary → NONE with zero distance', () => {
            const result = computeCpa(NEWPORT.lat, NEWPORT.lon, 0, 0, NEWPORT.lat, NEWPORT.lon, 0, 0);
            expect(result).not.toBeNull();
            expect(result!.distance).toBe(0);
            expect(result!.risk).toBe('NONE');
        });

        it('very far apart → SAFE', () => {
            const result = computeCpa(
                -33.735,
                151.305,
                0,
                5,
                -33.735,
                152.305,
                270,
                5, // ~50+ NM east
                0,
            );
            expect(result).not.toBeNull();
            // Will take ages to get close
            expect(['SAFE', 'NONE']).toContain(result!.risk);
        });

        it('no nav status passed → uses standard thresholds', () => {
            const result = computeCpa(-33.735, 151.305, 0, 8, -33.72, 151.305, 180, 8);
            expect(result).not.toBeNull();
            // Should use standard COLREGS thresholds (no anchored/moored exemption)
            expect(result!.risk).toBe('DANGER');
        });
    });
});
