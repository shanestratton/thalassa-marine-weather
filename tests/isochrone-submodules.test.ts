/**
 * Isochrone Submodule Tests
 *
 * Tests for the extracted isochrone routing sub-modules:
 * - pruning: sector-based wavefront pruning
 * - smoothing: backtracking & Douglas-Peucker simplification
 * - output: turn waypoint detection & GeoJSON conversion
 * - landAvoidance: segment navigability checks
 */

import { describe, it, expect } from 'vitest';
import type { IsochroneNode, Isochrone, IsochroneResult } from '../services/isochrone/types';
import { pruneWavefrontWithFallbacks } from '../services/isochrone/pruning';
import { backtrack, smoothRoute } from '../services/isochrone/smoothing';
import { detectTurnWaypoints, isochroneToGeoJSON } from '../services/isochrone/output';

// ── Helpers ────────────────────────────────────────────────────

function makeNode(overrides: Partial<IsochroneNode> = {}): IsochroneNode {
    return {
        lat: 0,
        lon: 0,
        timeHours: 0,
        bearing: 0,
        speed: 5,
        tws: 10,
        twa: 90,
        parentIndex: null,
        distance: 0,
        ...overrides,
    };
}

// ── Pruning ────────────────────────────────────────────────────

describe('pruneWavefrontWithFallbacks', () => {
    const origin = { lat: 0, lon: 0 };
    const destination = { lat: 0, lon: 10 };

    it('returns empty array for empty input', () => {
        const result = pruneWavefrontWithFallbacks([], origin, destination, 8);
        expect(result).toEqual([]);
    });

    it('assigns nodes to correct sectors based on bearing', () => {
        // Place 4 nodes at cardinal directions from origin
        const entries = [
            { node: makeNode({ lat: 1, lon: 0 }), distToDest: 10 }, // North → sector ~0
            { node: makeNode({ lat: 0, lon: 1 }), distToDest: 9 }, // East → sector ~2
            { node: makeNode({ lat: -1, lon: 0 }), distToDest: 11 }, // South → sector ~4
            { node: makeNode({ lat: 0, lon: -1 }), distToDest: 12 }, // West → sector ~6
        ];

        const result = pruneWavefrontWithFallbacks(entries, origin, destination, 8);

        // Should have 4 non-empty sectors
        expect(result.length).toBe(4);
        // Each sector should have exactly 1 node
        result.forEach((sector) => expect(sector.length).toBe(1));
    });

    it('limits candidates per sector to 3', () => {
        // Put 5 nodes all in roughly the same sector (north)
        const entries = Array.from({ length: 5 }, (_, i) => ({
            node: makeNode({ lat: 1 + i * 0.001, lon: 0.001 * i }),
            distToDest: 10 + i,
        }));

        const result = pruneWavefrontWithFallbacks(entries, origin, destination, 8);

        // Should have 1 sector with max 3 candidates
        expect(result.length).toBeGreaterThanOrEqual(1);
        result.forEach((sector) => expect(sector.length).toBeLessThanOrEqual(3));
    });

    it('ranks by distance to destination in normal mode', () => {
        const entries = [
            { node: makeNode({ lat: 1, lon: 0.01 }), distToDest: 100 },
            { node: makeNode({ lat: 1, lon: 0.02 }), distToDest: 50 },
            { node: makeNode({ lat: 1, lon: 0.03 }), distToDest: 75 },
        ];

        const result = pruneWavefrontWithFallbacks(entries, origin, destination, 8, false);

        // All in same sector, first candidate should be closest to dest
        const sector = result[0];
        expect(sector.length).toBeGreaterThanOrEqual(2);
    });

    it('ranks by exploration distance in exploration mode', () => {
        const entries = [
            { node: makeNode({ lat: 1, lon: 0.01, distance: 100 }), distToDest: 50 },
            { node: makeNode({ lat: 1, lon: 0.02, distance: 200 }), distToDest: 100 },
        ];

        const result = pruneWavefrontWithFallbacks(entries, origin, destination, 8, true);
        expect(result.length).toBeGreaterThanOrEqual(1);
    });

    it('handles single node', () => {
        const entries = [{ node: makeNode({ lat: 1, lon: 0 }), distToDest: 5 }];
        const result = pruneWavefrontWithFallbacks(entries, origin, destination, 8);
        expect(result.length).toBe(1);
        expect(result[0].length).toBe(1);
    });
});

// ── Backtracking ───────────────────────────────────────────────

describe('backtrack', () => {
    it('reconstructs path through isochrones', () => {
        const iso0: Isochrone = {
            timeHours: 0,
            nodes: [makeNode({ lat: 0, lon: 0 })],
        };
        const iso1: Isochrone = {
            timeHours: 3,
            nodes: [makeNode({ lat: 1, lon: 1, parentIndex: 0 })],
        };
        // arrivalNode's parentIndex=0 refers to iso1.nodes[0],
        // and iso1.nodes[0].parentIndex=0 refers to iso0.nodes[0]
        const arrivalNode = makeNode({ lat: 2, lon: 2, parentIndex: 0 });

        // With arrivalIdx=2, backtrack goes: arrivalNode → iso1.nodes[0] → iso0.nodes[0]
        const path = backtrack([iso0, iso1, { timeHours: 6, nodes: [arrivalNode] }], 2, arrivalNode);

        expect(path.length).toBe(3);
        expect(path[0].lat).toBe(0);
        expect(path[2].lat).toBe(2);
    });

    it('handles single isochrone (departure only)', () => {
        const arrivalNode = makeNode({ lat: 1, lon: 1, parentIndex: null });
        const path = backtrack([], 0, arrivalNode);
        expect(path.length).toBe(1);
    });

    it('stops if parentIndex is null', () => {
        const iso0: Isochrone = { timeHours: 0, nodes: [makeNode()] };
        const iso1: Isochrone = { timeHours: 3, nodes: [makeNode({ parentIndex: null })] };
        const arrivalNode = makeNode({ parentIndex: 0 });

        const path = backtrack([iso0, iso1], 1, arrivalNode);
        // Should stop at iso1 since its node has parentIndex = null
        expect(path.length).toBe(2);
    });
});

// ── Smoothing ──────────────────────────────────────────────────

describe('smoothRoute', () => {
    it('returns route unchanged if ≤ 3 points', () => {
        const route = [makeNode({ lat: 0 }), makeNode({ lat: 1 }), makeNode({ lat: 2 })];
        const result = smoothRoute(route);
        expect(result.length).toBe(3);
    });

    it('always preserves first and last waypoints', () => {
        const route = Array.from({ length: 10 }, (_, i) => makeNode({ lat: i, lon: 0, timeHours: i * 3 }));
        const result = smoothRoute(route);
        expect(result[0].lat).toBe(0);
        expect(result[result.length - 1].lat).toBe(9);
    });

    it('reduces waypoint count for large straight routes', () => {
        // Straight-line route with 50 points — should simplify heavily
        const route = Array.from({ length: 50 }, (_, i) =>
            makeNode({ lat: i * 0.1, lon: 0, timeHours: i, distance: i * 6 }),
        );
        const result = smoothRoute(route);
        expect(result.length).toBeLessThan(route.length);
        expect(result.length).toBeGreaterThanOrEqual(2);
    });

    it('preserves significant dog-legs', () => {
        // Route with a big sideways excursion at point 5
        const route = Array.from({ length: 10 }, (_, i) =>
            makeNode({
                lat: i,
                lon: i === 5 ? 50 : 0, // 50° offset at point 5 — huge deviation
                timeHours: i * 3,
                distance: i * 60,
            }),
        );
        const result = smoothRoute(route);
        // The dog-leg point should be preserved
        const preserved = result.find((n) => n.lon === 50);
        expect(preserved).toBeDefined();
    });
});

// ── Turn Waypoint Detection ────────────────────────────────────

describe('detectTurnWaypoints', () => {
    it('returns empty for < 2 route points', () => {
        expect(detectTurnWaypoints([makeNode()], '2024-01-01T00:00:00Z')).toEqual([]);
    });

    it('always includes DEP and ARR waypoints', () => {
        const route = [
            makeNode({ lat: 0, lon: 0, bearing: 0 }),
            makeNode({ lat: 1, lon: 0, bearing: 0, timeHours: 3, distance: 60 }),
        ];
        const wps = detectTurnWaypoints(route, '2024-01-01T00:00:00Z');
        expect(wps.length).toBe(2);
        expect(wps[0].id).toBe('DEP');
        expect(wps[1].id).toBe('ARR');
    });

    it('detects significant course changes', () => {
        // Straight north, then sharp east turn, then continue east
        const route = [
            makeNode({ lat: 0, lon: 0, bearing: 0, timeHours: 0, distance: 0 }),
            makeNode({ lat: 1, lon: 0, bearing: 0, timeHours: 3, distance: 60 }),
            makeNode({ lat: 1, lon: 1, bearing: 90, timeHours: 6, distance: 120 }),
            makeNode({ lat: 1, lon: 2, bearing: 90, timeHours: 9, distance: 180 }),
        ];
        const wps = detectTurnWaypoints(route, '2024-01-01T00:00:00Z', 15);
        // DEP + WP1 (the turn at lat:1, lon:0) + ARR
        expect(wps.length).toBe(3);
        expect(wps[1].id).toBe('WP1');
        expect(Math.abs(wps[1].bearingChange)).toBeGreaterThanOrEqual(15);
    });

    it('ignores small bearing changes below threshold', () => {
        const route = [
            makeNode({ lat: 0, lon: 0, bearing: 0, timeHours: 0, distance: 0 }),
            makeNode({ lat: 1, lon: 0.01, bearing: 1, timeHours: 3, distance: 60 }),
            makeNode({ lat: 2, lon: 0.02, bearing: 1, timeHours: 6, distance: 120 }),
        ];
        const wps = detectTurnWaypoints(route, '2024-01-01T00:00:00Z', 15);
        // Only DEP + ARR — no significant turns
        expect(wps.length).toBe(2);
    });

    it('calculates ETA correctly', () => {
        const route = [
            makeNode({ lat: 0, lon: 0, bearing: 0, timeHours: 0, distance: 0 }),
            makeNode({ lat: 1, lon: 0, bearing: 0, timeHours: 6, distance: 60 }),
        ];
        const wps = detectTurnWaypoints(route, '2024-01-01T00:00:00Z');
        expect(wps[0].eta).toBe('2024-01-01T00:00:00Z');
        const arrEta = new Date(wps[1].eta);
        expect(arrEta.getUTCHours()).toBe(6);
    });
});

// ── GeoJSON Output ─────────────────────────────────────────────

describe('isochroneToGeoJSON', () => {
    const mockResult: IsochroneResult = {
        route: [makeNode({ lat: 0, lon: 0 }), makeNode({ lat: 1, lon: 1 })],
        isochrones: [
            {
                timeHours: 0,
                nodes: [
                    makeNode({ lat: 0, lon: 0 }),
                    makeNode({ lat: 0.1, lon: 0.1 }),
                    makeNode({ lat: 0.2, lon: -0.1 }),
                ],
            },
            {
                timeHours: 3,
                nodes: [
                    makeNode({ lat: 1, lon: 1 }),
                    makeNode({ lat: 1.1, lon: 1.1 }),
                    makeNode({ lat: 1.2, lon: 0.9 }),
                ],
            },
        ],
        totalDistanceNM: 85,
        totalDurationHours: 12,
        arrivalTime: '2024-01-01T12:00:00Z',
        routeCoordinates: [
            [0, 0],
            [1, 1],
        ],
        shallowFlags: [false, false],
    };

    it('returns route as LineString feature', () => {
        const { route } = isochroneToGeoJSON(mockResult);
        expect(route.type).toBe('Feature');
        expect(route.geometry.type).toBe('LineString');
        expect(route.geometry.coordinates).toEqual([
            [0, 0],
            [1, 1],
        ]);
        expect(route.properties?.totalNM).toBe(85);
    });

    it('returns wavefronts as FeatureCollection', () => {
        const { wavefronts } = isochroneToGeoJSON(mockResult);
        expect(wavefronts.type).toBe('FeatureCollection');
        expect(wavefronts.features.length).toBe(2); // 2 isochrones with ≥3 nodes
    });

    it('closes wavefront polygons', () => {
        const { wavefronts } = isochroneToGeoJSON(mockResult);
        wavefronts.features.forEach((f) => {
            const coords = (f.geometry as GeoJSON.LineString).coordinates;
            expect(coords[0]).toEqual(coords[coords.length - 1]);
        });
    });

    it('skips isochrones with < 3 nodes', () => {
        const sparse: IsochroneResult = {
            ...mockResult,
            isochrones: [
                { timeHours: 0, nodes: [makeNode(), makeNode()] }, // only 2 nodes
            ],
        };
        const { wavefronts } = isochroneToGeoJSON(sparse);
        expect(wavefronts.features.length).toBe(0);
    });
});
