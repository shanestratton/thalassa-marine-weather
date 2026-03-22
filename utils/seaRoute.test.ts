/**
 * seaRoute — Unit tests for great-circle sea route generation.
 */
import { describe, it, expect } from 'vitest';
import { generateSeaRoute } from './seaRoute';

describe('generateSeaRoute', () => {
    it('generates intermediate points along a route', () => {
        const waypoints = [
            { lat: -27.5, lon: 153.0 }, // Brisbane
            { lat: -20.0, lon: 148.7 }, // Airlie Beach
        ];
        const route = generateSeaRoute(waypoints);
        expect(route.length).toBeGreaterThan(2);
    });

    it('returns original points when only one waypoint', () => {
        const waypoints = [{ lat: -27.5, lon: 153.0 }];
        const route = generateSeaRoute(waypoints);
        expect(route.length).toBe(1);
    });

    it('returns empty array for empty input', () => {
        const route = generateSeaRoute([]);
        expect(route).toEqual([]);
    });

    it('preserves start and end coordinates', () => {
        const waypoints = [
            { lat: -33.86, lon: 151.2 }, // Sydney
            { lat: -27.47, lon: 153.03 }, // Brisbane
        ];
        const route = generateSeaRoute(waypoints);
        expect(route[0].lat).toBeCloseTo(-33.86, 1);
        expect(route[route.length - 1].lat).toBeCloseTo(-27.47, 1);
    });

    it('handles multi-waypoint routes', () => {
        const waypoints = [
            { lat: -33.86, lon: 151.2 },
            { lat: -27.47, lon: 153.03 },
            { lat: -20.0, lon: 148.7 },
        ];
        const route = generateSeaRoute(waypoints);
        expect(route.length).toBeGreaterThan(3);
    });
});
