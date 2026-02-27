/**
 * Waterway Graph Router — A* pathfinding on OSM waterway network
 *
 * Loads the precomputed waterway_graph.json and provides:
 *   - Snap any lat/lon to nearest graph node
 *   - BFS to discover reachable component
 *   - A* shortest-path to the EXIT node (furthest reachable node toward destination)
 *   - Returns ordered [lon, lat][] coordinates following every canal turn
 *
 * Works for ANY marina/canal in the SE QLD region.
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

// ── Graph loading & adjacency ──────────────────────────────────────

let graphData: GraphData | null = null;
let adjacency: Map<string, AdjEntry[]> | null = null;
let nodeList: { id: string; lat: number; lon: number }[] | null = null;

async function loadGraph(): Promise<void> {
    if (graphData && adjacency) return;

    const t0 = performance.now();
    try {
        const resp = await fetch('/data/waterway_graph.json');
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
        graphData = await resp.json();

        // Build adjacency list (bidirectional — canals are navigable both ways)
        adjacency = new Map();
        for (const edge of graphData!.edges) {
            if (!adjacency.has(edge.from)) adjacency.set(edge.from, []);
            if (!adjacency.has(edge.to)) adjacency.set(edge.to, []);
            adjacency.get(edge.from)!.push({ nodeId: edge.to, dist_m: edge.dist_m, name: edge.name });
            adjacency.get(edge.to)!.push({ nodeId: edge.from, dist_m: edge.dist_m, name: edge.name });
        }

        // Build flat node list for spatial search
        nodeList = Object.entries(graphData!.nodes).map(([id, n]) => ({
            id, lat: n.lat, lon: n.lon,
        }));

        const ms = (performance.now() - t0).toFixed(0);
        console.log(
            `[WaterwayGraph] Loaded: ${graphData!.metadata.node_count} nodes, ` +
            `${graphData!.metadata.edge_count} edges, ` +
            `${graphData!.metadata.junction_count} junctions (${ms}ms)`
        );
    } catch (err) {
        console.error('[WaterwayGraph] Failed to load graph:', err);
        graphData = null;
        adjacency = null;
        nodeList = null;
    }
}

// ── Geometry helpers ───────────────────────────────────────────────

function fastDistM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dx = (lon2 - lon1) * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180) * 111320;
    const dy = (lat2 - lat1) * 111320;
    return Math.sqrt(dx * dx + dy * dy);
}

// ── Spatial snap ───────────────────────────────────────────────────

function snapToGraph(
    lat: number, lon: number, maxDistM: number = 5000
): { nodeId: string; distM: number; lat: number; lon: number } | null {
    if (!nodeList) return null;

    let best: { nodeId: string; distM: number; lat: number; lon: number } | null = null;

    for (const node of nodeList) {
        if (Math.abs(node.lat - lat) > 0.05) continue;
        if (Math.abs(node.lon - lon) > 0.05) continue;

        const d = fastDistM(lat, lon, node.lat, node.lon);
        if (d < maxDistM && (!best || d < best.distM)) {
            best = { nodeId: node.id, distM: d, lat: node.lat, lon: node.lon };
        }
    }

    return best;
}

// ── BFS: Find reachable component ──────────────────────────────────

/**
 * BFS from startNode to find all reachable nodes (connected component).
 * Returns the set of reachable node IDs.
 */
function findReachableNodes(startId: string): Set<string> {
    if (!adjacency) return new Set();

    const visited = new Set<string>();
    const queue: string[] = [startId];

    while (queue.length > 0) {
        const current = queue.shift()!;
        if (visited.has(current)) continue;
        visited.add(current);

        const neighbors = adjacency.get(current);
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

/**
 * Find the EXIT node: the reachable node that's closest to the destination.
 * This is where the canal network "exits" toward open water.
 */
function findExitNode(
    reachable: Set<string>,
    destLat: number, destLon: number,
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

// ── A* Pathfinding ─────────────────────────────────────────────────

function astar(startId: string, goalId: string): string[] | null {
    if (!adjacency || !graphData) return null;

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

        // Find node with lowest f score
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
            console.log(`[A*] Found path: ${path.length} nodes, ${iterations} iterations`);
            return path;
        }

        openSet.delete(currentId);
        const currentG = gScore.get(currentId) ?? Infinity;

        const neighbors = adjacency.get(currentId);
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

    console.warn(`[A*] No path found after ${iterations} iterations`);
    return null;
}

// ── Public API ─────────────────────────────────────────────────────

/**
 * Route through the waterway graph from origin toward destination.
 *
 * Strategy:
 * 1. Snap origin to nearest graph node
 * 2. BFS to find all reachable nodes (connected component)
 * 3. Find the EXIT node (reachable node closest to destination)
 * 4. A* pathfind from origin to exit node
 * 5. Return the path coordinates — MapHub extends to destination
 */
export async function graphRoute(
    originLat: number, originLon: number,
    destLat: number, destLon: number,
): Promise<{ coords: [number, number][]; distNM: number; snapDistM: number } | null> {
    await loadGraph();
    if (!graphData || !adjacency) return null;

    const t0 = performance.now();

    // Step 1: Snap origin to nearest graph node
    const originSnap = snapToGraph(originLat, originLon, 2000);
    if (!originSnap) {
        console.log(`[WaterwayGraph] No node within 2000m of origin [${originLat.toFixed(4)}, ${originLon.toFixed(4)}]`);
        return null;
    }
    console.log(`[WaterwayGraph] Origin snap: node ${originSnap.nodeId} at ${originSnap.distM.toFixed(0)}m`);

    // Step 2: BFS to find reachable component
    const reachable = findReachableNodes(originSnap.nodeId);
    console.log(`[WaterwayGraph] Reachable component: ${reachable.size} nodes`);

    // Step 3: Find exit node (closest reachable node to destination)
    const exitNode = findExitNode(reachable, destLat, destLon);
    if (!exitNode) {
        console.log(`[WaterwayGraph] No exit node found`);
        return null;
    }
    const exitGeo = graphData.nodes[exitNode.nodeId];
    console.log(`[WaterwayGraph] Exit node: ${exitNode.nodeId} at [${exitGeo.lat.toFixed(5)}, ${exitGeo.lon.toFixed(5)}], ${(exitNode.distM / 1852).toFixed(1)} NM from dest`);

    // Step 4: A* pathfind from origin to exit
    const path = astar(originSnap.nodeId, exitNode.nodeId);
    if (!path) {
        console.log(`[WaterwayGraph] A* failed — should not happen within component`);
        return null;
    }

    // Step 5: Convert to coordinates
    const coords: [number, number][] = [];

    // Start from actual origin position
    coords.push([originLon, originLat]);

    // Add all graph nodes along the path
    for (const nodeId of path) {
        const node = graphData.nodes[nodeId];
        if (node) {
            coords.push([node.lon, node.lat]);
        }
    }

    // Add the actual destination at the end (straight line from exit to destination)
    coords.push([destLon, destLat]);

    // Calculate total distance
    let totalM = 0;
    for (let i = 1; i < coords.length; i++) {
        totalM += fastDistM(coords[i - 1][1], coords[i - 1][0], coords[i][1], coords[i][0]);
    }
    const distNM = totalM / 1852;

    const ms = (performance.now() - t0).toFixed(0);
    console.log(`[WaterwayGraph] Route: ${coords.length} WPs, ${distNM.toFixed(1)} NM, ${ms}ms`);

    return { coords, distNM, snapDistM: originSnap.distM };
}
