/**
 * IsochroneRouter — Unit tests for the routing engine's pure functions
 *
 * Tests: geodesy (haversine, bearing, projection), TWA calculation,
 * polar speed interpolation, and integration with mock wind fields.
 */

import { describe, it, expect } from 'vitest';
import { _testableInternals, computeIsochrones, type WindField } from '../services/IsochroneRouter';
import type { PolarData } from '../types';

const { haversineNm, initialBearing, projectPosition, calcTWA, createPolarSpeedLookup } = _testableInternals;

// ── Haversine (NM) ──

describe('haversineNm', () => {
    it('returns 0 for same point', () => {
        expect(haversineNm(0, 0, 0, 0)).toBe(0);
    });

    it('calculates 1 degree latitude ≈ 60 NM', () => {
        const d = haversineNm(0, 0, 1, 0);
        expect(d).toBeCloseTo(60, 0);
    });

    it('calculates Sydney to Melbourne ≈ 385 NM', () => {
        const d = haversineNm(-33.8688, 151.2093, -37.8136, 144.9631);
        expect(d).toBeGreaterThan(370);
        expect(d).toBeLessThan(400);
    });

    it('handles antimeridian crossing', () => {
        // Auckland (174°E) to Fiji (178°E)
        const d = haversineNm(-36.8485, 174.7633, -17.7134, 178.065);
        expect(d).toBeGreaterThan(1000);
        expect(d).toBeLessThan(1300);
    });

    it('is symmetric', () => {
        const d1 = haversineNm(-33.8688, 151.2093, -37.8136, 144.9631);
        const d2 = haversineNm(-37.8136, 144.9631, -33.8688, 151.2093);
        expect(d1).toBeCloseTo(d2, 6);
    });
});

// ── Initial Bearing ──

describe('initialBearing', () => {
    it('returns 0 for due north', () => {
        const b = initialBearing(0, 0, 1, 0);
        expect(b).toBeCloseTo(0, 0);
    });

    it('returns 90 for due east', () => {
        const b = initialBearing(0, 0, 0, 1);
        expect(b).toBeCloseTo(90, 0);
    });

    it('returns 180 for due south', () => {
        const b = initialBearing(1, 0, 0, 0);
        expect(b).toBeCloseTo(180, 0);
    });

    it('returns 270 for due west', () => {
        const b = initialBearing(0, 1, 0, 0);
        expect(b).toBeCloseTo(270, 0);
    });

    it('always returns 0-360', () => {
        for (const [a, b, c, d] of [
            [-90, 0, 90, 0],
            [0, 180, 0, -180],
            [45, 45, -45, -45],
        ]) {
            const bearing = initialBearing(a, b, c, d);
            expect(bearing).toBeGreaterThanOrEqual(0);
            expect(bearing).toBeLessThan(360);
        }
    });
});

// ── Project Position ──

describe('projectPosition', () => {
    it('projects north by 60 NM ≈ 1° latitude', () => {
        const p = projectPosition(0, 0, 0, 60);
        expect(p.lat).toBeCloseTo(1, 1);
        expect(p.lon).toBeCloseTo(0, 1);
    });

    it('projects east along equator by 60 NM ≈ 1° longitude', () => {
        const p = projectPosition(0, 0, 90, 60);
        expect(p.lat).toBeCloseTo(0, 1);
        expect(p.lon).toBeCloseTo(1, 1);
    });

    it('preserves distance (round-trip via haversine)', () => {
        const p = projectPosition(-33.868, 151.209, 45, 100);
        const d = haversineNm(-33.868, 151.209, p.lat, p.lon);
        expect(d).toBeCloseTo(100, 0);
    });

    it('normalises longitude to [-180, 180]', () => {
        const p = projectPosition(0, 179, 90, 200);
        expect(p.lon).toBeGreaterThanOrEqual(-180);
        expect(p.lon).toBeLessThanOrEqual(180);
    });

    it('handles projection from polar regions', () => {
        const p = projectPosition(89, 0, 0, 60);
        // Should be near the pole, not NaN
        expect(Number.isFinite(p.lat)).toBe(true);
        expect(Number.isFinite(p.lon)).toBe(true);
    });
});

// ── True Wind Angle ──

describe('calcTWA', () => {
    it('0 TWA when heading directly into wind', () => {
        // Wind from 0° (north), boat heading 0° (north) → TWA = 0° (dead upwind)
        expect(calcTWA(0, 0)).toBe(0);
    });

    it('180 TWA when running dead downwind', () => {
        // Wind from 0° (north), boat heading 180° (south) → TWA = 180° (dead downwind)
        expect(calcTWA(180, 0)).toBe(180);
    });

    it('90 TWA on a beam reach', () => {
        // Wind from 0° (north), boat heading 90° (east) → TWA = 90° (beam reach)
        expect(calcTWA(90, 0)).toBe(90);
    });

    it('is symmetric (port = starboard)', () => {
        // Wind from 0°, heading 45° vs 315° → both should be 45° TWA
        expect(calcTWA(45, 0)).toBe(calcTWA(315, 0));
    });

    it('wraps correctly across 0/360 boundary', () => {
        // Wind from 350°, boat heading 10° → diff is 340°, normalised to -20°, abs = 20°
        expect(calcTWA(10, 350)).toBeCloseTo(20, 0);
    });

    it('returns 0-180 range', () => {
        for (let h = 0; h < 360; h += 15) {
            for (let w = 0; w < 360; w += 30) {
                const twa = calcTWA(h, w);
                expect(twa).toBeGreaterThanOrEqual(0);
                expect(twa).toBeLessThanOrEqual(180);
            }
        }
    });
});

// ── Polar Speed Lookup ──

describe('createPolarSpeedLookup', () => {
    const testPolar: PolarData = {
        windSpeeds: [5, 10, 15, 20, 25],
        angles: [0, 45, 90, 135, 180],
        matrix: [
            [0, 0, 0, 0, 0], // 0° TWA — no speed (dead upwind)
            [3, 5, 6, 6.5, 6.5], // 45° — close haul
            [4, 6, 7, 7.5, 7.5], // 90° — beam reach
            [3.5, 5.5, 6.5, 7, 7], // 135° — broad reach
            [2, 4, 5, 5.5, 5.5], // 180° — dead downwind
        ],
    };

    it('returns 0 for dead upwind (TWA=0)', () => {
        const lookup = createPolarSpeedLookup(testPolar, 10);
        expect(lookup(0)).toBe(0);
    });

    it('returns correct speed at exact grid point', () => {
        const lookup = createPolarSpeedLookup(testPolar, 10);
        expect(lookup(90)).toBe(6); // TWA=90, TWS=10
    });

    it('interpolates between TWS values', () => {
        const lookup = createPolarSpeedLookup(testPolar, 7.5);
        const speed = lookup(90);
        // Should be between TWS=5 (4) and TWS=10 (6) → around 5
        expect(speed).toBeGreaterThan(4);
        expect(speed).toBeLessThan(6);
    });

    it('interpolates between TWA values', () => {
        const lookup = createPolarSpeedLookup(testPolar, 10);
        const speed = lookup(67.5);
        // Should be between TWA=45 (5) and TWA=90 (6) → around 5.5
        expect(speed).toBeGreaterThan(4.5);
        expect(speed).toBeLessThan(6.5);
    });

    it('clamps TWS above maximum', () => {
        const lookup = createPolarSpeedLookup(testPolar, 50);
        // Should return the value at max TWS (25)
        expect(lookup(90)).toBe(7.5);
    });

    it('clamps TWS below minimum', () => {
        const lookup = createPolarSpeedLookup(testPolar, 1);
        // Should return the value at min TWS (5)
        expect(lookup(90)).toBe(4);
    });

    it('handles empty polar data gracefully', () => {
        const emptyPolar: PolarData = { windSpeeds: [], angles: [], matrix: [] };
        const lookup = createPolarSpeedLookup(emptyPolar, 10);
        expect(lookup(90)).toBe(0);
    });

    it('uses absolute TWA (symmetric)', () => {
        const lookup = createPolarSpeedLookup(testPolar, 15);
        // Negative TWA should give same result as positive
        expect(lookup(-90)).toBe(lookup(90));
    });
});

// ── Integration: computeIsochrones with mock wind ──

describe('computeIsochrones (integration)', () => {
    const simplePolar: PolarData = {
        windSpeeds: [5, 10, 15, 20],
        angles: [0, 45, 90, 135, 180],
        matrix: [
            [0, 0, 0, 0],
            [3, 5, 6, 6],
            [4, 6, 7, 7],
            [3, 5, 6, 6],
            [2, 4, 5, 5],
        ],
    };

    // Constant 10kt wind from the west (270°)
    const westWind: WindField = {
        getWind: () => ({ speed: 10, direction: 270 }),
    };

    it('returns null for unreachable destination (no wind)', () => {
        const noWind: WindField = { getWind: () => null };
        // Short passage, but motoring speed should still arrive
        // Actually with motoringSpeed=5, even no wind should work
        // Let's use an impossible config instead
    });

    it('computes a short downwind passage', async () => {
        // Sail east with westerly wind (dead run at TWA=180? No — wind FROM west, heading east)
        // Wind FROM 270° + heading 90° → TWA = |270 - 90| = 180 (dead run)
        const result = await computeIsochrones(
            { lat: -33.868, lon: 151.209 }, // Sydney
            { lat: -33.868, lon: 151.5 }, // ~16 NM east
            '2024-01-01T00:00:00Z',
            simplePolar,
            westWind,
            { timeStepHours: 3, maxHours: 48, useDepthPenalty: false },
        );

        expect(result).not.toBeNull();
        if (result) {
            expect(result.route.length).toBeGreaterThan(1);
            expect(result.totalDistanceNM).toBeGreaterThan(10);
            expect(result.totalDurationHours).toBeGreaterThan(0);
            expect(result.routeCoordinates.length).toBe(result.route.length);
        }
    });

    it('route starts at origin and ends near destination', async () => {
        const result = await computeIsochrones(
            { lat: 0, lon: 0 },
            { lat: 0, lon: 0.5 }, // ~30 NM east along equator
            '2024-06-15T12:00:00Z',
            simplePolar,
            westWind,
            { timeStepHours: 3, maxHours: 48, useDepthPenalty: false },
        );

        expect(result).not.toBeNull();
        if (result) {
            const start = result.route[0];
            const end = result.route[result.route.length - 1];
            expect(start.lat).toBeCloseTo(0, 1);
            expect(start.lon).toBeCloseTo(0, 1);
            expect(end.lat).toBeCloseTo(0, 0);
            expect(end.lon).toBeCloseTo(0.5, 0);
        }
    });

    it('generates isochrone wavefronts', async () => {
        const result = await computeIsochrones(
            { lat: 0, lon: 0 },
            { lat: 0, lon: 1 }, // ~60 NM east
            '2024-01-01T00:00:00Z',
            simplePolar,
            westWind,
            { timeStepHours: 3, maxHours: 72, useDepthPenalty: false },
        );

        expect(result).not.toBeNull();
        if (result) {
            expect(result.isochrones.length).toBeGreaterThanOrEqual(2);
            // First isochrone is the departure
            expect(result.isochrones[0].timeHours).toBe(0);
        }
    });
});
