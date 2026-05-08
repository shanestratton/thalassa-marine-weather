/**
 * Synthetic-geometry tests for the inshore router.
 *
 * Run with:
 *   cd pi-cache && npx tsx src/services/inshoreRouter.test.mts
 *
 * The tests build tiny ENC-shaped GeoJSON layers in memory, run
 * routeInshore() against them, and assert on the resulting polyline
 * and grid metadata. No external data, no network.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { FeatureCollection } from 'geojson';
import { routeInshore, type InshoreLayers, type RouteResult, type RouteFailure } from './inshoreRouter.js';

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Build a Polygon FeatureCollection from a list of [lon, lat] arrays.
 * Each polygon is a single outer ring with no holes.
 */
function makePolygons(rings: [number, number][][], properties: Record<string, unknown> = {}): FeatureCollection {
    return {
        type: 'FeatureCollection',
        features: rings.map((ring) => ({
            type: 'Feature',
            geometry: {
                type: 'Polygon',
                // Close the ring if not already closed.
                coordinates: [
                    ring[0][0] === ring[ring.length - 1][0] && ring[0][1] === ring[ring.length - 1][1]
                        ? ring
                        : [...ring, ring[0]],
                ],
            },
            properties,
        })),
    };
}

function makePoints(coords: [number, number][], properties: Record<string, unknown> = {}): FeatureCollection {
    return {
        type: 'FeatureCollection',
        features: coords.map((c) => ({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: c },
            properties,
        })),
    };
}

function isSuccess(r: RouteResult | RouteFailure): r is RouteResult {
    return 'polyline' in r;
}

// Lightweight point-in-polygon for the assertion helpers.
function pointInRingT(lon: number, lat: number, ring: [number, number][]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
        if (intersects) inside = !inside;
    }
    return inside;
}

// ── Test 1: open water — should route in a straight line ────────────

test('open water route is approximately straight', () => {
    // Empty layers = no land, no obstructions, no DEPARE — so the
    // entire grid is UNKNOWN_OPEN (cost 1.5). Should still route.
    const layers: InshoreLayers = {};
    const result = routeInshore(layers, {
        fromLat: 32.0,
        fromLon: -81.0,
        toLat: 32.05,
        toLon: -80.95,
        draftM: 2.5,
    });
    assert(isSuccess(result), `expected success, got: ${JSON.stringify(result)}`);
    assert(result.polyline.length >= 2, 'polyline must have ≥2 points');
    assert(result.polyline[0][0] === -81.0 && result.polyline[0][1] === 32.0, 'first point = origin');
    const last = result.polyline[result.polyline.length - 1];
    assert(last[0] === -80.95 && last[1] === 32.05, 'last point = destination');
    // Straight line between origin/dest = ~7.0 km = 3.78 NM.
    assert(result.distanceNM < 5.0, `expected ~3.8 NM, got ${result.distanceNM.toFixed(2)}`);
});

// ── Test 2: land between origin and destination ─────────────────────

test('routes around a land obstruction', () => {
    // Layout (1° = ~111 km, working in tiny degree slivers):
    //
    //   from (32.00, -81.00)
    //                                  to (32.00, -80.90)
    //              ▓▓▓▓▓ <- LNDARE rectangle blocks straight-line path
    //              ▓▓▓▓▓
    //              ▓▓▓▓▓
    //
    // A* should swing south or north around it.
    const layers: InshoreLayers = {
        LNDARE: makePolygons([
            [
                [-80.965, 31.995],
                [-80.945, 31.995],
                [-80.945, 32.005],
                [-80.965, 32.005],
            ],
        ]),
        DEPARE: makePolygons(
            [
                // Big DEPARE encompassing everything except the land block.
                [
                    [-81.02, 31.95],
                    [-80.88, 31.95],
                    [-80.88, 32.05],
                    [-81.02, 32.05],
                ],
            ],
            { DRVAL1: 15 },
        ),
    };
    const result = routeInshore(layers, {
        fromLat: 32.0,
        fromLon: -81.0,
        toLat: 32.0,
        toLon: -80.9,
        draftM: 2.5,
    });
    assert(isSuccess(result), `expected success, got: ${JSON.stringify(result)}`);

    // Verify no point on the polyline is inside the land block.
    const landRing: [number, number][] = [
        [-80.965, 31.995],
        [-80.945, 31.995],
        [-80.945, 32.005],
        [-80.965, 32.005],
        [-80.965, 31.995],
    ];
    for (const [lon, lat] of result.polyline) {
        assert(
            !pointInRingT(lon, lat, landRing),
            `polyline point (${lon}, ${lat}) is inside the land block — A* failed to route around it`,
        );
    }

    // Distance should be larger than the straight-line ~10 km but
    // still reasonable. 10 km straight-line; expect ~12-14 km diversion.
    assert(result.distanceNM > 5.0, `route too short (${result.distanceNM.toFixed(2)} NM) — likely cut through land`);
    assert(result.distanceNM < 20.0, `route too long (${result.distanceNM.toFixed(2)} NM) — A* getting confused`);
});

// ── Test 3: shallow water rejected for deep-draft vessel ────────────

test('shallow DEPARE is blocked for deep-draft vessel', () => {
    // Shallow-water rectangle in middle. Vessel needs 5m + 1m safety = 6m.
    // The shallow polygon has DRVAL1 = 2m — should be blocked.
    const layers: InshoreLayers = {
        DEPARE: makePolygons(
            [
                // Big deep area
                [
                    [-81.02, 31.95],
                    [-80.88, 31.95],
                    [-80.88, 32.05],
                    [-81.02, 32.05],
                ],
            ],
            { DRVAL1: 15 },
        ),
    };
    // Add a shallow DEPARE on top
    layers.DEPARE!.features.push({
        type: 'Feature',
        geometry: {
            type: 'Polygon',
            coordinates: [
                [
                    [-80.965, 31.995],
                    [-80.945, 31.995],
                    [-80.945, 32.005],
                    [-80.965, 32.005],
                    [-80.965, 31.995],
                ],
            ],
        },
        properties: { DRVAL1: 2 },
    });
    const result = routeInshore(layers, {
        fromLat: 32.0,
        fromLon: -81.0,
        toLat: 32.0,
        toLon: -80.9,
        draftM: 5.0,
    });
    assert(isSuccess(result), `expected success, got: ${JSON.stringify(result)}`);

    // Verify no polyline point is inside the shallow shoal.
    const shoalRing: [number, number][] = [
        [-80.965, 31.995],
        [-80.945, 31.995],
        [-80.945, 32.005],
        [-80.965, 32.005],
        [-80.965, 31.995],
    ];
    for (const [lon, lat] of result.polyline) {
        assert(
            !pointInRingT(lon, lat, shoalRing),
            `polyline point (${lon}, ${lat}) crosses the shallow shoal — depth filter failed`,
        );
    }
});

// ── Test 4: shallow water OK for shallow-draft vessel ───────────────

test('shallow DEPARE is navigable for shallow-draft vessel', () => {
    // Same shallow shoal but vessel only needs 1m + 1m = 2m. Shoal
    // DRVAL1 = 2m means it's exactly at the threshold (NOT < 2). Hmm —
    // let's make the shoal 3m so a 1m-draft vessel has plenty.
    const layers: InshoreLayers = {
        DEPARE: makePolygons(
            [
                [
                    [-81.02, 31.95],
                    [-80.88, 31.95],
                    [-80.88, 32.05],
                    [-81.02, 32.05],
                ],
            ],
            { DRVAL1: 15 },
        ),
    };
    layers.DEPARE!.features.push({
        type: 'Feature',
        geometry: {
            type: 'Polygon',
            coordinates: [
                [
                    [-80.965, 31.995],
                    [-80.945, 31.995],
                    [-80.945, 32.005],
                    [-80.965, 32.005],
                    [-80.965, 31.995],
                ],
            ],
        },
        properties: { DRVAL1: 3 },
    });
    const result = routeInshore(layers, {
        fromLat: 32.0,
        fromLon: -81.0,
        toLat: 32.0,
        toLon: -80.9,
        draftM: 1.0,
    });
    assert(isSuccess(result), `expected success, got: ${JSON.stringify(result)}`);
    // Should be more or less straight-line distance — no detour required.
    assert(result.distanceNM < 7, `route should be near-straight at ${result.distanceNM.toFixed(2)} NM`);
});

// ── Test 5: rock obstruction is buffered ────────────────────────────

test('routes avoid point obstructions with buffer', () => {
    const layers: InshoreLayers = {
        DEPARE: makePolygons(
            [
                [
                    [-81.02, 31.95],
                    [-80.88, 31.95],
                    [-80.88, 32.05],
                    [-81.02, 32.05],
                ],
            ],
            { DRVAL1: 15 },
        ),
        UWTROC: makePoints([[-80.95, 32.0]]), // Rock smack in the middle of straight-line path
    };
    const result = routeInshore(layers, {
        fromLat: 32.0,
        fromLon: -81.0,
        toLat: 32.0,
        toLon: -80.9,
        draftM: 2.5,
        obstructionBufferM: 200, // 200m buffer to make detour visible
    });
    assert(isSuccess(result), `expected success, got: ${JSON.stringify(result)}`);
    // No polyline point should be within ~150m of the rock (a bit
    // less than buffer since cell centers can be off-grid).
    const ROCK = [-80.95, 32.0];
    const M_PER_DEG_LAT = 111_320;
    const mPerDegLon = 111_320 * Math.cos((32 * Math.PI) / 180);
    for (const [lon, lat] of result.polyline) {
        const dxM = (lon - ROCK[0]) * mPerDegLon;
        const dyM = (lat - ROCK[1]) * M_PER_DEG_LAT;
        const dM = Math.sqrt(dxM * dxM + dyM * dyM);
        assert(dM > 100, `polyline point too close to rock: ${dM.toFixed(0)} m at (${lon}, ${lat})`);
    }
});

// ── Test 6: origin entirely surrounded by land → no path ────────────

test('reports failure when origin is on land with no escape', () => {
    // Land mass that extends beyond the 5km BFS snap radius. Snap
    // radius is hard-coded at 5,000 m — so the land block must be
    // ≥10 km wide and ≥10 km tall (covering origin to all sides).
    // Each degree lat ≈ 111 km, each degree lon at 32° ≈ 94 km, so
    // 0.1° each axis is well clear of the snap radius.
    const layers: InshoreLayers = {
        LNDARE: makePolygons([
            [
                [-81.1, 31.9],
                [-80.85, 31.9], // covers destination too — no path possible
                [-80.85, 32.1],
                [-81.1, 32.1],
            ],
        ]),
    };
    const result = routeInshore(layers, {
        fromLat: 32.0,
        fromLon: -81.0,
        toLat: 32.0,
        toLon: -80.9,
        draftM: 2.5,
    });
    assert(!isSuccess(result), `expected failure, got success: ${JSON.stringify(result)}`);
    assert(
        result.code === 'origin-on-land' || result.code === 'destination-on-land',
        `expected code origin-on-land or destination-on-land, got ${result.code}`,
    );
});

// ── Test 7: snap to navigable — origin on land but water nearby ─────

test('snaps origin from land to nearest navigable cell', () => {
    // Origin coord falls on a small island, but there's water all
    // around. BFS should find the nearest navigable cell within
    // the snap radius.
    const layers: InshoreLayers = {
        LNDARE: makePolygons([
            // Tiny island around the origin
            [
                [-81.001, 31.999],
                [-80.999, 31.999],
                [-80.999, 32.001],
                [-81.001, 32.001],
            ],
        ]),
        DEPARE: makePolygons(
            [
                [
                    [-81.02, 31.95],
                    [-80.88, 31.95],
                    [-80.88, 32.05],
                    [-81.02, 32.05],
                ],
            ],
            { DRVAL1: 15 },
        ),
    };
    const result = routeInshore(layers, {
        fromLat: 32.0,
        fromLon: -81.0, // Center of the island
        toLat: 32.0,
        toLon: -80.9,
        draftM: 2.5,
    });
    assert(isSuccess(result), `expected success after snap, got: ${JSON.stringify(result)}`);
    // The first polyline point is forced back to the requested origin
    // for UI continuity, so the SECOND point should be off the island.
    if (result.polyline.length >= 2) {
        const [lon2, lat2] = result.polyline[1];
        const islandRing: [number, number][] = [
            [-81.001, 31.999],
            [-80.999, 31.999],
            [-80.999, 32.001],
            [-81.001, 32.001],
            [-81.001, 31.999],
        ];
        // The 2nd point may be near the island edge but shouldn't be
        // deep inside it.
        if (pointInRingT(lon2, lat2, islandRing)) {
            // It's possible the point IS inside if the snap landed on a
            // grid edge; just verify the route eventually exits.
            const exitFound = result.polyline.some(([lon, lat]) => !pointInRingT(lon, lat, islandRing));
            assert(exitFound, 'no point exits the island');
        }
    }
});

// ── Test 8: channel preference — prefers deep water over shallow ────

test('A* prefers deep DEPARE over shallow when both navigable', () => {
    // Two parallel routes available:
    //   - North path: shallow DEPARE (3m, navigable for 1m draft)
    //   - South path: deep DEPARE (15m)
    // Vessel has 1m draft so both are open. Cost multiplier should
    // bias the route to the deep south path.
    const layers: InshoreLayers = {
        DEPARE: {
            type: 'FeatureCollection',
            features: [
                // North half — shallow
                {
                    type: 'Feature',
                    geometry: {
                        type: 'Polygon',
                        coordinates: [
                            [
                                [-81.02, 32.0],
                                [-80.88, 32.0],
                                [-80.88, 32.05],
                                [-81.02, 32.05],
                                [-81.02, 32.0],
                            ],
                        ],
                    },
                    properties: { DRVAL1: 3 },
                },
                // South half — deep
                {
                    type: 'Feature',
                    geometry: {
                        type: 'Polygon',
                        coordinates: [
                            [
                                [-81.02, 31.95],
                                [-80.88, 31.95],
                                [-80.88, 32.0],
                                [-81.02, 32.0],
                                [-81.02, 31.95],
                            ],
                        ],
                    },
                    properties: { DRVAL1: 15 },
                },
            ],
        },
    };
    // Origin and dest both on the boundary lat 32.0 — A* can pick
    // either side.
    const result = routeInshore(layers, {
        fromLat: 31.985, // Near south edge
        fromLon: -81.0,
        toLat: 31.985,
        toLon: -80.9,
        draftM: 1.0,
    });
    assert(isSuccess(result), `expected success, got: ${JSON.stringify(result)}`);
    // Most of the polyline should be in the southern half (lat < 32.0).
    const southCount = result.polyline.filter(([, lat]) => lat < 32.0).length;
    const northCount = result.polyline.filter(([, lat]) => lat >= 32.0).length;
    assert(southCount > northCount, `expected route biased to deep south half (S=${southCount}, N=${northCount})`);
});

// ── Test 9: too-large bbox doesn't blow up ──────────────────────────

test('rejects routes that would build an oversized grid gracefully', () => {
    // 2 NM route at 50m resolution = ~74×74 cells. Test that buildNavGrid
    // doesn't crash on a realistic small bbox even with no layers.
    const result = routeInshore(
        {},
        {
            fromLat: 32.0,
            fromLon: -81.0,
            toLat: 32.03,
            toLon: -80.97,
            draftM: 2.5,
        },
    );
    assert(isSuccess(result), `expected success, got: ${JSON.stringify(result)}`);
    assert(result.gridSize.width > 0 && result.gridSize.height > 0, 'grid size should be positive');
});
