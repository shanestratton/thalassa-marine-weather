/**
 * Waterway Graph Router — A* pathfinding on OSM waterway network
 *
 * Loads the precomputed waterway_graph.json and provides:
 *   - Snap any lat/lon to nearest graph node
 *   - A* shortest-path routing through the canal/river network
 *   - Returns ordered [lon, lat][] coordinates following every turn
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

/**
 * Load the waterway graph data and build adjacency list.
 */
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

/**
 * Find the nearest graph node to a given lat/lon.
 * Returns node ID and distance in meters.
 */
function snapToGraph(
    lat: number, lon: number, maxDistM: number = 5000
): { nodeId: string; distM: number; lat: number; lon: number } | null {
    if (!nodeList) return null;

    let best: { nodeId: string; distM: number; lat: number; lon: number } | null = null;

    for (const node of nodeList) {
        // Quick lat filter (1 degree ≈ 111km)
        if (Math.abs(node.lat - lat) > 0.05) continue;
        if (Math.abs(node.lon - lon) > 0.05) continue;

        const d = fastDistM(lat, lon, node.lat, node.lon);
        if (d < maxDistM && (!best || d < best.distM)) {
            best = { nodeId: node.id, distM: d, lat: node.lat, lon: node.lon };
        }
    }

    return best;
}

// ── A* Pathfinding ─────────────────────────────────────────────────

/**
 * A* shortest path from startNode to goalNode through the waterway graph.
 * Returns ordered array of node IDs, or null if no path found.
 */
function astar(
    startId: string, goalId: string
): string[] | null {
    if (!adjacency || !graphData) return null;

    const goalNode = graphData.nodes[goalId];
    if (!goalNode) return null;

    // Priority queue using a simple sorted array (good enough for our graph size)
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
            // Reconstruct path
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
 * Route through the waterway graph from origin to a point near the destination.
 *
 * 1. Snaps origin to nearest graph node
 * 2. Snaps destination to nearest graph node
 * 3. A* pathfinding between them
 * 4. Returns ordered [lon, lat][] coordinates
 *
 * Returns null if either snap fails or no path exists.
 */
export async function graphRoute(
    originLat: number, originLon: number,
    destLat: number, destLon: number,
): Promise<{ coords: [number, number][]; distNM: number; snapDistM: number } | null> {
    await loadGraph();
    if (!graphData || !adjacency) return null;

    const t0 = performance.now();

    // Snap origin
    const originSnap = snapToGraph(originLat, originLon, 2000);
    if (!originSnap) {
        console.log(`[WaterwayGraph] No node within 2000m of origin [${originLat.toFixed(4)}, ${originLon.toFixed(4)}]`);
        return null;
    }
    console.log(`[WaterwayGraph] Origin snap: node ${originSnap.nodeId} at ${originSnap.distM.toFixed(0)}m`);

    // Snap destination
    const destSnap = snapToGraph(destLat, destLon, 10000);
    if (!destSnap) {
        console.log(`[WaterwayGraph] No node within 10000m of dest [${destLat.toFixed(4)}, ${destLon.toFixed(4)}]`);
        return null;
    }
    console.log(`[WaterwayGraph] Dest snap: node ${destSnap.nodeId} at ${destSnap.distM.toFixed(0)}m`);

    // A* pathfinding
    const path = astar(originSnap.nodeId, destSnap.nodeId);
    if (!path) {
        console.log(`[WaterwayGraph] No path found between nodes`);
        return null;
    }

    // Convert node IDs to coordinates [lon, lat]
    const coords: [number, number][] = [];

    // Add actual origin position first (before snap point)
    coords.push([originLon, originLat]);

    // Add all graph nodes along the path
    for (const nodeId of path) {
        const node = graphData.nodes[nodeId];
        if (node) {
            coords.push([node.lon, node.lat]);
        }
    }

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
