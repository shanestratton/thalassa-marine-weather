/**
 * destinationPoint — canonical great-circle projection guard.
 *
 * Round-trips the projection against the canonical distance/bearing
 * implementations (same 3440.065 NM sphere): projecting D NM at bearing B
 * and then measuring back with calculateDistance/calculateBearing must
 * reproduce D and B. Also pins the antimeridian normalisation to [-180, 180]
 * that the isochrone router's projectPosition established (Fix 7).
 */
import { describe, it, expect } from 'vitest';
import { calculateBearing, calculateDistance, destinationPoint } from '../utils/navigationCalculations';

describe('destinationPoint round-trip (canonical sphere)', () => {
    it('projects 10 NM at 45° from Moreton Bay and measures back to the same leg', () => {
        const dest = destinationPoint(-27, 153, 45, 10);
        expect(calculateDistance(-27, 153, dest.lat, dest.lon)).toBeCloseTo(10, 6);
        expect(calculateBearing(-27, 153, dest.lat, dest.lon)).toBeCloseTo(45, 6);
    });

    it('round-trips a spread of bearings and distances', () => {
        const cases: Array<[number, number, number, number]> = [
            [-27, 153, 0, 1],
            [-27, 153, 90, 25],
            [-27, 153, 200.5, 120],
            [60, 10, 315, 60],
            [0, 0, 137, 300],
        ];
        for (const [lat, lon, brg, nm] of cases) {
            const dest = destinationPoint(lat, lon, brg, nm);
            expect(calculateDistance(lat, lon, dest.lat, dest.lon)).toBeCloseTo(nm, 5);
            // Compare bearings on the circle so 359.99° vs 0.01° stays close.
            const got = calculateBearing(lat, lon, dest.lat, dest.lon);
            const diff = Math.abs(((got - brg + 540) % 360) - 180);
            expect(diff).toBeLessThanOrEqual(1e-5);
        }
    });

    it('normalises longitude across the antimeridian to [-180, 180]', () => {
        // 20 NM due east from lon 179.9 crosses the date line.
        const dest = destinationPoint(-17, 179.9, 90, 20);
        expect(dest.lon).toBeGreaterThanOrEqual(-180);
        expect(dest.lon).toBeLessThanOrEqual(180);
        expect(dest.lon).toBeLessThan(0); // wrapped to the western hemisphere
        // Distance/bearing back must still agree despite the wrap.
        expect(calculateDistance(-17, 179.9, dest.lat, dest.lon)).toBeCloseTo(20, 5);
        expect(calculateBearing(-17, 179.9, dest.lat, dest.lon)).toBeCloseTo(90, 3);
    });

    it('zero distance is the identity', () => {
        const dest = destinationPoint(-27.5, 153.2, 123, 0);
        expect(dest.lat).toBeCloseTo(-27.5, 10);
        expect(dest.lon).toBeCloseTo(153.2, 10);
    });
});
