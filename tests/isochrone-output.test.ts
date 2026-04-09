/**
 * Isochrone Output — Unit tests
 *
 * Tests turn waypoint detection (course change thresholds, DEP/ARR)
 * and GeoJSON output generation.
 */

import { describe, it, expect } from 'vitest';
import { detectTurnWaypoints, isochroneToGeoJSON } from '../services/isochrone/output';
import type { IsochroneNode, IsochroneResult } from '../services/isochrone/types';

// ── Helpers ─────────────────────────────────────────────────────

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

// ── detectTurnWaypoints ─────────────────────────────────────────

describe('detectTurnWaypoints', () => {
    it('returns empty for route with < 2 nodes', () => {
        expect(detectTurnWaypoints([], '2025-06-15T00:00:00Z')).toEqual([]);
        expect(detectTurnWaypoints([makeNode({})], '2025-06-15T00:00:00Z')).toEqual([]);
    });

    it('always includes DEP and ARR waypoints', () => {
        const route = [
            makeNode({ lat: -33, lon: 151 }),
            makeNode({ lat: -33.5, lon: 151.2, timeHours: 3, distance: 30 }),
            makeNode({ lat: -34, lon: 151.4, timeHours: 6, distance: 60 }),
        ];

        const waypoints = detectTurnWaypoints(route, '2025-06-15T00:00:00Z');
        expect(waypoints[0].id).toBe('DEP');
        expect(waypoints[waypoints.length - 1].id).toBe('ARR');
    });

    it('DEP waypoint has correct coordinates', () => {
        const route = [makeNode({ lat: -33, lon: 151 }), makeNode({ lat: -34, lon: 152, timeHours: 6, distance: 60 })];

        const wps = detectTurnWaypoints(route, '2025-06-15T00:00:00Z');
        expect(wps[0].lat).toBe(-33);
        expect(wps[0].lon).toBe(151);
        expect(wps[0].bearingChange).toBe(0);
    });

    it('detects sharp course change', () => {
        // Straight south then sharp turn east
        const route = [
            makeNode({ lat: 0, lon: 0 }),
            makeNode({ lat: -1, lon: 0, timeHours: 3, distance: 60 }),
            makeNode({ lat: -1, lon: 1, timeHours: 6, distance: 120 }),
            makeNode({ lat: -1, lon: 2, timeHours: 9, distance: 180 }),
        ];

        const wps = detectTurnWaypoints(route, '2025-06-15T00:00:00Z');
        // Should have DEP + at least one WP + ARR
        expect(wps.length).toBeGreaterThanOrEqual(3);
    });

    it('ETA is correct based on departure time + timeHours', () => {
        const route = [makeNode({ lat: 0, lon: 0 }), makeNode({ lat: -1, lon: 0, timeHours: 6, distance: 60 })];

        const wps = detectTurnWaypoints(route, '2025-06-15T00:00:00Z');
        expect(wps[wps.length - 1].eta).toBe('2025-06-15T06:00:00.000Z');
    });

    it('respects custom threshold', () => {
        // Small course change — should be ignored with high threshold
        const route = [
            makeNode({ lat: 0, lon: 0 }),
            makeNode({ lat: -1, lon: 0.05, timeHours: 3, distance: 60 }),
            makeNode({ lat: -2, lon: 0.1, timeHours: 6, distance: 120 }),
            makeNode({ lat: -3, lon: 0.15, timeHours: 9, distance: 180 }),
        ];

        const wpsStrict = detectTurnWaypoints(route, '2025-06-15T00:00:00Z', 45);
        // With high threshold, only DEP and ARR
        expect(wpsStrict.length).toBe(2);
    });
});

// ── isochroneToGeoJSON ──────────────────────────────────────────

describe('isochroneToGeoJSON', () => {
    it('produces a GeoJSON LineString for the route', () => {
        const result: IsochroneResult = {
            route: [makeNode({ lat: 0, lon: 0 }), makeNode({ lat: -1, lon: 1 })],
            isochrones: [],
            totalDistanceNM: 60,
            totalDurationHours: 10,
            arrivalTime: '2025-06-15T10:00:00Z',
            routeCoordinates: [
                [0, 0],
                [1, -1],
            ],
            shallowFlags: [false, false],
        };

        const geojson = isochroneToGeoJSON(result);

        expect(geojson.route.type).toBe('Feature');
        expect(geojson.route.geometry.type).toBe('LineString');
        expect(geojson.route.geometry.coordinates).toHaveLength(2);
        expect(geojson.route.properties?.totalNM).toBe(60);
    });

    it('produces wavefront FeatureCollection', () => {
        const result: IsochroneResult = {
            route: [],
            isochrones: [
                {
                    timeHours: 6,
                    nodes: [
                        makeNode({ lat: 0, lon: 0 }),
                        makeNode({ lat: 0, lon: 1 }),
                        makeNode({ lat: -1, lon: 0.5 }),
                    ],
                },
            ],
            totalDistanceNM: 0,
            totalDurationHours: 0,
            arrivalTime: '',
            routeCoordinates: [],
            shallowFlags: [],
        };

        const geojson = isochroneToGeoJSON(result);
        expect(geojson.wavefronts.type).toBe('FeatureCollection');
        expect(geojson.wavefronts.features.length).toBe(1);
    });

    it('filters out isochrones with < 3 nodes', () => {
        const result: IsochroneResult = {
            route: [],
            isochrones: [
                { timeHours: 3, nodes: [makeNode({}), makeNode({})] }, // Only 2 — skipped
                {
                    timeHours: 6,
                    nodes: [makeNode({ lon: 0 }), makeNode({ lon: 1 }), makeNode({ lon: 2 })],
                },
            ],
            totalDistanceNM: 0,
            totalDurationHours: 0,
            arrivalTime: '',
            routeCoordinates: [],
            shallowFlags: [],
        };

        const geojson = isochroneToGeoJSON(result);
        expect(geojson.wavefronts.features.length).toBe(1);
    });
});
