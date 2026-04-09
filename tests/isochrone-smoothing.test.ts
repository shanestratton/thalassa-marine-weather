/**
 * Isochrone Smoothing — Unit tests
 *
 * Tests backtracking from arrival node through isochrone chain,
 * and Douglas-Peucker route smoothing.
 */

import { describe, it, expect } from 'vitest';
import { backtrack, smoothRoute } from '../services/isochrone/smoothing';
import type { IsochroneNode, Isochrone } from '../services/isochrone/types';

// ── Helper ──────────────────────────────────────────────────────

function makeNode(overrides: Partial<IsochroneNode>): IsochroneNode {
    return {
        lat: 0,
        lon: 0,
        timeHours: 0,
        bearing: 0,
        speed: 6,
        tws: 12,
        twa: 90,
        parentIndex: null,
        distance: 0,
        ...overrides,
    };
}

// ── backtrack ───────────────────────────────────────────────────

describe('backtrack', () => {
    it('returns just the arrival node for single isochrone', () => {
        const arrival = makeNode({ lat: -34, lon: 152, timeHours: 6 });
        const path = backtrack([], 0, arrival);
        expect(path).toHaveLength(1);
        expect(path[0]).toBe(arrival);
    });

    it('reconstructs path through isochrone chain', () => {
        const iso0: Isochrone = {
            timeHours: 0,
            nodes: [makeNode({ lat: -33, lon: 151, parentIndex: null, distance: 0 })],
        };
        const iso1: Isochrone = {
            timeHours: 6,
            nodes: [makeNode({ lat: -34, lon: 151.5, parentIndex: 0, distance: 60 })],
        };
        const arrival = makeNode({ lat: -35, lon: 152, parentIndex: 0, distance: 120, timeHours: 12 });

        const path = backtrack([iso0, iso1], 2, arrival);

        expect(path.length).toBe(3);
        expect(path[0].lat).toBe(-33);
        expect(path[1].lat).toBe(-34);
        expect(path[2].lat).toBe(-35);
    });

    it('handles broken chain (null parentIndex)', () => {
        const iso0: Isochrone = { timeHours: 0, nodes: [makeNode({ parentIndex: null })] };
        const arrival = makeNode({ parentIndex: null, timeHours: 6 });

        const path = backtrack([iso0], 1, arrival);
        expect(path).toHaveLength(1); // Only arrival
    });
});

// ── smoothRoute ─────────────────────────────────────────────────

describe('smoothRoute', () => {
    it('returns route unchanged if <= 3 points', () => {
        const route = [makeNode({ lat: 0, lon: 0 }), makeNode({ lat: -1, lon: 1 }), makeNode({ lat: -2, lon: 2 })];
        const smoothed = smoothRoute(route);
        expect(smoothed).toHaveLength(3);
    });

    it('preserves first and last waypoints', () => {
        const route = Array.from({ length: 20 }, (_, i) =>
            makeNode({
                lat: -33 + i * 0.1,
                lon: 151 + i * 0.1,
                timeHours: i * 3,
                distance: i * 15,
            }),
        );
        const smoothed = smoothRoute(route);
        expect(smoothed[0].lat).toBe(route[0].lat);
        expect(smoothed[smoothed.length - 1].lat).toBe(route[route.length - 1].lat);
    });

    it('reduces waypoint count for straight-line routes', () => {
        // Straight line south — many intermediate points are redundant
        const route = Array.from({ length: 30 }, (_, i) =>
            makeNode({
                lat: -33 - i * 0.5,
                lon: 151,
                timeHours: i * 3,
                distance: i * 30,
            }),
        );
        const smoothed = smoothRoute(route);
        expect(smoothed.length).toBeLessThan(route.length);
    });

    it('preserves turns in the route', () => {
        // Route with a clear turn
        const route = [
            makeNode({ lat: 0, lon: 0, distance: 0 }),
            makeNode({ lat: -1, lon: 0, distance: 60 }),
            makeNode({ lat: -2, lon: 0, distance: 120 }),
            makeNode({ lat: -3, lon: 0, distance: 180 }),
            // Sharp turn east
            makeNode({ lat: -3, lon: 1, distance: 240 }),
            makeNode({ lat: -3, lon: 2, distance: 300 }),
            makeNode({ lat: -3, lon: 3, distance: 360 }),
            makeNode({ lat: -3, lon: 4, distance: 420 }),
        ];
        const smoothed = smoothRoute(route);
        // The turn point at (-3, 0) should be preserved
        const turnKept = smoothed.some((n) => n.lat === -3 && n.lon === 0);
        expect(turnKept).toBe(true);
    });
});
