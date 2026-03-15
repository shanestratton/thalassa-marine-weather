/**
 * Waterway Graph Router v3 — Canal-only A* for marina exit
 *
 * Key insight: when exiting a marina, ONLY follow canal edges.
 * Rivers, creeks, and drains are NOT navigable exit routes from a canal estate.
 * The canal network exits to open water at its northern/eastern terminus.
 *
 * Strategy:
 *   1. Snap origin to nearest CANAL node (waterway=canal only)
 *   2. BFS through CANAL edges only → discover canal component
 *   3. Find EXIT node (canal node closest to destination)
 *   4. A* through CANAL edges → follow every canal turn
 *   5. Straight line from exit to destination (open water)
 */

// ── Types ──────────────────────────────────────────────────────────

interface GraphNode {
    lat: number;
    lon: number;
}

interface GraphEdge {
    from: string;
    to: string;
    way_id: number;
    name: string;
    waterway: string;
    dist_m: number;
}

interface GraphData {
    metadata: {
        node_count: number;
        edge_count: number;
        junction_count: number;
    };
    nodes: Record<string, GraphNode>;
    edges: GraphEdge[];
}

interface AdjEntry {
    nodeId: string;
    dist_m: number;
    name: string;
}

// ── Graph loading ──────────────────────────────────────────────────

let graphData: GraphData | null = null;
let canalAdj: Map<string, AdjEntry[]> | null = null; // canal-only adjacency
let canalNodeIds: Set<string> | null = null; // nodes that belong to canal edges

async function loadGraph(): Promise<void> {
    if (graphData && canalAdj) return;

    const t0 = performance.now();
    try {
        const resp = await fetch('/data/waterway_graph.json');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        graphData = await resp.json();

        // Build CANAL-ONLY adjacency list
        canalAdj = new Map();
        canalNodeIds = new Set();
        let canalEdgeCount = 0;

        for (const edge of graphData!.edges) {
            // Only include canal and bridge edges (bridges connect canal junctions)
            if (edge.waterway !== 'canal' && edge.waterway !== 'bridge') continue;

            canalEdgeCount++;
            canalNodeIds.add(edge.from);
            canalNodeIds.add(edge.to);

            if (!canalAdj.has(edge.from)) canalAdj.set(edge.from, []);
            if (!canalAdj.has(edge.to)) canalAdj.set(edge.to, []);
            canalAdj.get(edge.from)!.push({ nodeId: edge.to, dist_m: edge.dist_m, name: edge.name });
            canalAdj.get(edge.to)!.push({ nodeId: edge.from, dist_m: edge.dist_m, name: edge.name });
        }

        const ms = (performance.now() - t0).toFixed(0);
    } catch (err) {
        console.error('[WaterwayGraph] Failed to load graph:', err);
        graphData = null;
        canalAdj = null;
        canalNodeIds = null;
    }
}

// ── Geometry helpers ───────────────────────────────────────────────

function fastDistM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dx = (lon2 - lon1) * Math.cos((((lat1 + lat2) / 2) * Math.PI) / 180) * 111320;
    const dy = (lat2 - lat1) * 111320;
    return Math.sqrt(dx * dx + dy * dy);
}

// ── Spatial snap (canal nodes only) ────────────────────────────────

function snapToCanalNode(
    lat: number,
    lon: number,
    maxDistM: number = 2000,
): { nodeId: string; distM: number; lat: number; lon: number } | null {
    if (!graphData || !canalNodeIds) return null;

    let best: { nodeId: string; distM: number; lat: number; lon: number } | null = null;

    for (const nodeId of canalNodeIds) {
        const node = graphData.nodes[nodeId];
        if (!node) continue;
        if (Math.abs(node.lat - lat) > 0.02) continue;
        if (Math.abs(node.lon - lon) > 0.02) continue;

        const d = fastDistM(lat, lon, node.lat, node.lon);
        if (d < maxDistM && (!best || d < best.distM)) {
            best = { nodeId, distM: d, lat: node.lat, lon: node.lon };
        }
    }

    return best;
}

// ── BFS through canal edges only ───────────────────────────────────

function findReachableCanalNodes(startId: string): Set<string> {
    if (!canalAdj) return new Set();

    const visited = new Set<string>();
    const queue: string[] = [startId];

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);

        const neighbors = canalAdj.get(current);
        if (neighbors) {
            for (const n of neighbors) {
                if (!visited.has(n.nodeId)) {
                    queue.push(n.nodeId);
                }
            }
        }
    }

    return visited;
}

// ── Find exit node ─────────────────────────────────────────────────

function findExitNode(
    reachable: Set<string>,
    destLat: number,
    destLon: number,
): { nodeId: string; distM: number } | null {
    if (!graphData) return null;

    let best: { nodeId: string; distM: number } | null = null;

    for (const nodeId of reachable) {
        const node = graphData.nodes[nodeId];
        if (!node) continue;
        const d = fastDistM(node.lat, node.lon, destLat, destLon);
        if (!best || d < best.distM) {
            best = { nodeId, distM: d };
        }
    }

    return best;
}

// ── A* through canal edges only ────────────────────────────────────

function astarCanal(startId: string, goalId: string): string[] | null {
    if (!canalAdj || !graphData) return null;

    const goalNode = graphData.nodes[goalId];
    if (!goalNode) return null;

    const openSet = new Map<string, { f: number; g: number }>();
    const cameFrom = new Map<string, string>();
    const gScore = new Map<string, number>();

    gScore.set(startId, 0);
    const startNode = graphData.nodes[startId];
    const h0 = fastDistM(startNode.lat, startNode.lon, goalNode.lat, goalNode.lon);
    openSet.set(startId, { f: h0, g: 0 });

    let iterations = 0;
    const maxIterations = 50000;

    while (openSet.size > 0 && iterations < maxIterations) {
        iterations++;

        let currentId = '';
        let currentF = Infinity;
        for (const [id, { f }] of openSet) {
            if (f < currentF) {
                currentF = f;
                currentId = id;
            }
        }

        if (currentId === goalId) {
            const path: string[] = [currentId];
            let c = currentId;
            while (cameFrom.has(c)) {
                c = cameFrom.get(c)!;
                path.unshift(c);
            }
            return path;
        }

        openSet.delete(currentId);
        const currentG = gScore.get(currentId) ?? Infinity;

        // CANAL EDGES ONLY
        const neighbors = canalAdj.get(currentId);
        if (!neighbors) continue;

        for (const neighbor of neighbors) {
            const tentativeG = currentG + neighbor.dist_m;
            const prevG = gScore.get(neighbor.nodeId) ?? Infinity;

            if (tentativeG < prevG) {
                cameFrom.set(neighbor.nodeId, currentId);
                gScore.set(neighbor.nodeId, tentativeG);

                const neighborNode = graphData!.nodes[neighbor.nodeId];
                if (neighborNode) {
                    const h = fastDistM(neighborNode.lat, neighborNode.lon, goalNode.lat, goalNode.lon);
                    openSet.set(neighbor.nodeId, { f: tentativeG + h, g: tentativeG });
                }
            }
        }
    }

    return null;
}

// ── Public API ─────────────────────────────────────────────────────

export async function graphRoute(
    originLat: number,
    originLon: number,
    destLat: number,
    destLon: number,
): Promise<{ coords: [number, number][]; distNM: number; snapDistM: number } | null> {
    await loadGraph();
    if (!graphData || !canalAdj) return null;

    const t0 = performance.now();

    // Step 1: Snap origin to nearest CANAL node
    const originSnap = snapToCanalNode(originLat, originLon, 2000);
    if (!originSnap) {
        return null;
    }
    // Step 2: BFS through CANAL edges only
    const reachable = findReachableCanalNodes(originSnap.nodeId);

    if (reachable.size < 3) {
        return null;
    }

    // Step 3: Find exit node (closest canal node to destination)
    const exitNode = findExitNode(reachable, destLat, destLon);
    if (!exitNode) {
        return null;
    }
    const exitGeo = graphData.nodes[exitNode.nodeId];
    // Step 4: A* through canal edges only
    const path = astarCanal(originSnap.nodeId, exitNode.nodeId);
    if (!path) {
        return null;
    }

    // Step 5: Convert to coordinates
    const coords: [number, number][] = [];
    coords.push([originLon, originLat]);

    for (const nodeId of path) {
        const node = graphData.nodes[nodeId];
        if (node) {
            coords.push([node.lon, node.lat]);
        }
    }

    // Straight line from canal exit to destination
    coords.push([destLon, destLat]);

    // Distance
    let totalM = 0;
    for (let i = 1; i < coords.length; i++) {
        totalM += fastDistM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    }
    const distNM = totalM / 1852;

    const ms = (performance.now() - t0).toFixed(0);
    return { coords, distNM, snapDistM: originSnap.distM };
}
