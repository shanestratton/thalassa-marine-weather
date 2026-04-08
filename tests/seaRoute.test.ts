import { describe, it, expect } from 'vitest';
import { generateSeaRoute } from '../utils/seaRoute';

describe('generateSeaRoute', () => {
    it('returns empty for no waypoints', () => {
        expect(generateSeaRoute([])).toEqual([]);
    });

    it('returns single point unchanged', () => {
        const wp = [{ lat: -33.8, lon: 151.2 }];
        expect(generateSeaRoute(wp)).toEqual(wp);
    });

    it('generates intermediate points between two waypoints', () => {
        const route = generateSeaRoute([
            { lat: -33.8, lon: 151.2 }, // Sydney
            { lat: -37.8, lon: 144.9 }, // Melbourne
        ]);
        // Should have more points than just start and end
        expect(route.length).toBeGreaterThan(2);
        // First and last should be close to originals
        expect(route[0].lat).toBeCloseTo(-33.8, 1);
        expect(route[0].lon).toBeCloseTo(151.2, 1);
        expect(route[route.length - 1].lat).toBeCloseTo(-37.8, 1);
        expect(route[route.length - 1].lon).toBeCloseTo(144.9, 1);
    });

    it('uses adaptive point density — short hops get fewer points', () => {
        // Short hop: ~5 NM
        const shortRoute = generateSeaRoute([
            { lat: -33.8, lon: 151.2 },
            { lat: -33.85, lon: 151.25 },
        ]);
        // Long passage: ~500 NM
        const longRoute = generateSeaRoute([
            { lat: -33.8, lon: 151.2 },
            { lat: -37.8, lon: 144.9 },
        ]);
        expect(longRoute.length).toBeGreaterThan(shortRoute.length);
    });

    it('handles very close points (< 1km)', () => {
        const route = generateSeaRoute([
            { lat: -33.8, lon: 151.2 },
            { lat: -33.8001, lon: 151.2001 },
        ]);
        // Should return just [from, to] for very close points
        expect(route.length).toBeGreaterThanOrEqual(2);
    });

    it('chains multiple waypoints without duplication at joints', () => {
        const route = generateSeaRoute([
            { lat: -33.8, lon: 151.2 },
            { lat: -35.0, lon: 150.0 },
            { lat: -37.8, lon: 144.9 },
        ]);
        // No duplicate coords at waypoint joints
        for (let i = 1; i < route.length; i++) {
            const prev = route[i - 1];
            const curr = route[i];
            const same = prev.lat === curr.lat && prev.lon === curr.lon;
            expect(same).toBe(false);
        }
    });

    it('all intermediate points have valid lat/lon', () => {
        const route = generateSeaRoute([
            { lat: 51.5, lon: -0.1 }, // London
            { lat: 40.7, lon: -74.0 }, // New York
        ]);
        for (const pt of route) {
            expect(pt.lat).toBeGreaterThanOrEqual(-90);
            expect(pt.lat).toBeLessThanOrEqual(90);
            expect(pt.lon).toBeGreaterThanOrEqual(-180);
            expect(pt.lon).toBeLessThanOrEqual(180);
        }
    });

    it('generates great circle curve (lat varies non-linearly)', () => {
        // Transatlantic: London to New York
        const route = generateSeaRoute([
            { lat: 51.5, lon: -0.1 },
            { lat: 40.7, lon: -74.0 },
        ]);
        // Great circle goes NORTH of the straight line on Mercator
        // Midpoint should have lat > average of endpoints
        const avgLat = (51.5 + 40.7) / 2; // 46.1
        const midIdx = Math.floor(route.length / 2);
        expect(route[midIdx].lat).toBeGreaterThan(avgLat);
    });
});
