/**
 * Marina Grid Router
 * 
 * Turf.js-powered router for close-quarters marina navigation.
 * Creates a 10m grid, removes land/obstacle points, and runs A*
 * to find a safe path from berth to marina exit.
 * 
 * This router is ONLY used within marina geofence zones where the 
 * OSM graph doesn't have enough resolution for safe navigation.
 */

import * as turf from '@turf/turf';
import type { Feature, Polygon, MultiPolygon, FeatureCollection, Point } from 'geojson';

// ── Types ──────────────────────────────────────────────────────────

interface GridNode {
    id: number;
    coords: [number, number]; // [lon, lat]
    neighbors: { id: number; weight: number }[];
}

export interface MarinaRouteResult {
    coordinates: [number, number][]; // [lon, lat] pairs
    distanceNM: number;
    waypointCount: number;
    computeMs: number;
}

// ── Constants ──────────────────────────────────────────────────────

const GRID_SPACING_M = 10;           // 10m grid resolution
const OBSTACLE_BUFFER_M = 15;        // 15m safety buffer (beam + clearance)
const NEIGHBOR_RADIUS_M = 15;        // Search radius for grid neighbors (catches diagonals: √(10²+10²) ≈ 14.1m)
const NM_PER_METER = 0.000539957;    // Conversion factor

// ── Min-Heap for A* ────────────────────────────────────────────────

interface HeapEntry { f: number; id: number; }

class MinHeap {
    private data: HeapEntry[] = [];
    get length() { return this.data.length; }

    push(entry: HeapEntry) {
        this.data.push(entry);
        let i = this.data.length - 1;
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (this.data[parent].f <= this.data[i].f) break;
            [this.data[parent], this.data[i]] = [this.data[i], this.data[parent]];
            i = parent;
        }
    }

    pop(): HeapEntry | undefined {
        if (!this.data.length) return undefined;
        const top = this.data[0];
        const last = this.data.pop()!;
        if (this.data.length > 0) {
            this.data[0] = last;
            let i = 0;
            while (true) {
                let smallest = i;
                const l = 2 * i + 1, r = 2 * i + 2;
                if (l < this.data.length && this.data[l].f < this.data[smallest].f) smallest = l;
                if (r < this.data.length && this.data[r].f < this.data[smallest].f) smallest = r;
                if (smallest === i) break;
                [this.data[smallest], this.data[i]] = [this.data[i], this.data[smallest]];
                i = smallest;
            }
        }
        return top;
    }
}

// ── Core Router ────────────────────────────────────────────────────

/**
 * Route from a berth position to a marina exit point, avoiding all obstacles.
 * 
 * @param startLon - Berth longitude
 * @param startLat - Berth latitude
 * @param exitLon - Marina exit longitude  
 * @param exitLat - Marina exit latitude
 * @param marinaBounds - Polygon defining the marina zone
 * @param obstacles - Optional obstacle polygons (land, breakwaters, piers)
 */
export async function routeThroughMarina(
    startLon: number,
    startLat: number,
    exitLon: number,
    exitLat: number,
    marinaBounds: Feature<Polygon | MultiPolygon>,
    obstacles?: FeatureCollection<Polygon | MultiPolygon>,
): Promise<MarinaRouteResult | null> {
    const t0 = performance.now();
    console.log(`[MarinaGrid] Routing from [${startLon.toFixed(4)}, ${startLat.toFixed(4)}] to exit [${exitLon.toFixed(4)}, ${exitLat.toFixed(4)}]`);

    // 1. Buffer obstacles by 15m for safety margin
    let bufferedObstacles: Feature<Polygon | MultiPolygon>[] = [];
    if (obstacles && obstacles.features.length > 0) {
        bufferedObstacles = obstacles.features
            .map(f => {
                try {
                    return turf.buffer(f, OBSTACLE_BUFFER_M, { units: 'meters' }) as Feature<Polygon | MultiPolygon>;
                } catch { return null; }
            })
            .filter((f): f is Feature<Polygon | MultiPolygon> => f !== null);
        console.log(`[MarinaGrid] Buffered ${bufferedObstacles.length} obstacle polygons by ${OBSTACLE_BUFFER_M}m`);
    }

    // 2. Generate point grid inside marina bounds
    const bbox = turf.bbox(marinaBounds);
    const grid = turf.pointGrid(bbox, GRID_SPACING_M, { units: 'meters' });
    console.log(`[MarinaGrid] Generated ${grid.features.length} grid points`);

    // 3. Filter out points inside obstacles or outside marina bounds
    const safePoints: Feature<Point>[] = [];
    for (const pt of grid.features) {
        // Must be inside marina bounds
        if (!turf.booleanPointInPolygon(pt, marinaBounds)) continue;

        // Must NOT be inside any buffered obstacle
        let blocked = false;
        for (const obs of bufferedObstacles) {
            if (turf.booleanPointInPolygon(pt, obs)) {
                blocked = true;
                break;
            }
        }
        if (!blocked) safePoints.push(pt);
    }
    console.log(`[MarinaGrid] Safe points after filtering: ${safePoints.length}`);

    if (safePoints.length < 2) {
        console.warn('[MarinaGrid] Not enough safe points — cannot route');
        return null;
    }

    // 4. Build graph nodes
    const nodes: GridNode[] = safePoints.map((pt, i) => ({
        id: i,
        coords: pt.geometry.coordinates as [number, number],
        neighbors: [],
    }));

    // 5. Connect neighboring nodes (up/down/left/right + diagonals)
    for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
            const dist = turf.distance(
                turf.point(nodes[i].coords),
                turf.point(nodes[j].coords),
                { units: 'meters' }
            );
            if (dist <= NEIGHBOR_RADIUS_M) {
                nodes[i].neighbors.push({ id: j, weight: dist });
                nodes[j].neighbors.push({ id: i, weight: dist });
            }
        }
    }

    // 6. Snap start and exit to nearest grid nodes
    const startNodeId = findNearestNode(startLon, startLat, nodes);
    const exitNodeId = findNearestNode(exitLon, exitLat, nodes);

    if (startNodeId === -1 || exitNodeId === -1) {
        console.warn(`[MarinaGrid] Cannot snap to grid: start=${startNodeId}, exit=${exitNodeId}`);
        return null;
    }

    console.log(`[MarinaGrid] Snapped: start→node[${startNodeId}], exit→node[${exitNodeId}]`);

    // 7. A* pathfinding
    const path = aStarSearch(nodes, startNodeId, exitNodeId);

    if (!path) {
        console.warn('[MarinaGrid] No path found through marina');
        return null;
    }

    // 8. Build coordinate array
    const rawCoords: [number, number][] = [
        [startLon, startLat],  // Exact start position
        ...path.map(id => nodes[id].coords),
        [exitLon, exitLat],    // Exact exit position
    ];

    // 9. Smooth the path with Bezier spline for natural-looking route
    let smoothCoords: [number, number][];
    try {
        if (rawCoords.length >= 3) {
            const line = turf.lineString(rawCoords);
            const smooth = turf.bezierSpline(line, { resolution: 10000, sharpness: 0.85 });
            smoothCoords = smooth.geometry.coordinates as [number, number][];
        } else {
            smoothCoords = rawCoords;
        }
    } catch {
        smoothCoords = rawCoords;
    }

    // 10. Calculate distance
    let distanceM = 0;
    for (let i = 1; i < smoothCoords.length; i++) {
        distanceM += turf.distance(
            turf.point(smoothCoords[i - 1]),
            turf.point(smoothCoords[i]),
            { units: 'meters' }
        );
    }

    const computeMs = performance.now() - t0;
    const distanceNM = distanceM * NM_PER_METER;

    console.log(
        `[MarinaGrid] ✓ ${smoothCoords.length} waypoints, ${distanceNM.toFixed(2)} NM, ${computeMs.toFixed(0)}ms`
    );

    return {
        coordinates: smoothCoords,
        distanceNM: Math.round(distanceNM * 100) / 100,
        waypointCount: smoothCoords.length,
        computeMs: Math.round(computeMs),
    };
}

// ── Helpers ────────────────────────────────────────────────────────

function findNearestNode(lon: number, lat: number, nodes: GridNode[]): number {
    let bestId = -1;
    let bestDist = Infinity;

    const pt = turf.point([lon, lat]);
    for (const node of nodes) {
        const dist = turf.distance(pt, turf.point(node.coords), { units: 'meters' });
        if (dist < bestDist) {
            bestDist = dist;
            bestId = node.id;
        }
    }
    return bestId;
}

function aStarSearch(nodes: GridNode[], startId: number, goalId: number): number[] | null {
    const goalCoords = nodes[goalId].coords;

    const gScore = new Float64Array(nodes.length).fill(Infinity);
    const fScore = new Float64Array(nodes.length).fill(Infinity);
    const cameFrom = new Int32Array(nodes.length).fill(-1);
    const closed = new Uint8Array(nodes.length);

    gScore[startId] = 0;
    fScore[startId] = heuristic(nodes[startId].coords, goalCoords);

    const open = new MinHeap();
    open.push({ f: fScore[startId], id: startId });

    while (open.length > 0) {
        const current = open.pop()!;

        if (current.id === goalId) {
            // Reconstruct path
            const path: number[] = [];
            let id = goalId;
            while (id !== -1) {
                path.push(id);
                id = cameFrom[id];
            }
            return path.reverse();
        }

        if (closed[current.id]) continue;
        closed[current.id] = 1;

        for (const neighbor of nodes[current.id].neighbors) {
            if (closed[neighbor.id]) continue;

            const tentativeG = gScore[current.id] + neighbor.weight;
            if (tentativeG < gScore[neighbor.id]) {
                cameFrom[neighbor.id] = current.id;
                gScore[neighbor.id] = tentativeG;
                fScore[neighbor.id] = tentativeG + heuristic(nodes[neighbor.id].coords, goalCoords);
                open.push({ f: fScore[neighbor.id], id: neighbor.id });
            }
        }
    }

    return null; // No path found
}

function heuristic(a: [number, number], b: [number, number]): number {
    // Simple Euclidean distance in meters (good enough for small areas)
    return turf.distance(turf.point(a), turf.point(b), { units: 'meters' });
}
