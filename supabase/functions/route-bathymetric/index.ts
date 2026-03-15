// deno-lint-ignore-file
declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: {
        get(key: string): string | undefined;
    };
};

/**
 * route-bathymetric — OSM Graph Dijkstra Marine Router
 *
 * TRAFFIC LIGHT ROUTING SYSTEM:
 *   🟢 Safe:     Plenty of clearance (depth > draft + 1m)
 *   🟠 Caution:  Tight clearance (draft < depth < draft + 1m)
 *   🔴 Danger:   Depth less than hull draft
 *
 * SOFT WALLS: Shallow water gets massive penalty weights instead of
 * being impassable. The router ALWAYS finds a route — but warns the
 * captain visually instead of crashing.
 *
 * Output: GeoJSON FeatureCollection with segments colored by safety.
 */

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function corsResponse(body: BodyInit | null, status: number, extra?: Record<string, string>) {
    return new Response(body, { status, headers: { ...CORS, ...extra } });
}

function jsonResponse(data: unknown, status = 200) {
    return corsResponse(JSON.stringify(data), status, { 'Content-Type': 'application/json' });
}

// ── Types ─────────────────────────────────────────────────────────

interface RouteRequest {
    origin: { lat: number; lon: number };
    destination: { lat: number; lon: number };
    via?: { lat: number; lon: number };
    vessel_draft?: number;
    region?: string;
}

interface RouteWaypoint {
    lat: number;
    lon: number;
    name: string;
    depth_m: number | null;
    safety: 'safe' | 'caution' | 'danger';
}

interface NavGraph {
    meta: {
        version: number;
        region: string;
        nodes: number;
        edges: number;
        total_nm: number;
        coord_order?: string; // 'lon_lat' or 'lon_lat_depth'
        depth_convention?: string; // 'negative_is_water'
        markers?: number;
        obstacles?: number;
    };
    nodes: number[][]; // [[lon, lat] or [lon, lat, depth_m], ...]
    edges: number[][]; // [[from, to, weight], ...]
    markers?: (number | string)[][]; // [[node_idx, '_class'], ...] for IALA penalties
    obstacles?: number[][]; // [[lon, lat], ...] for avoidance zones
}

// ── Constants ─────────────────────────────────────────────────────

const EARTH_RADIUS_NM = 3440.065;
const MAX_SNAP_NM = 5.0;
const GRAPH_CACHE_TTL = 3600000;
const DEFAULT_DRAFT = 2.0;

// ── Soft Wall Penalties ──
// These are additive costs applied to edges that traverse shallow water.
// The router will avoid them when deep-water alternatives exist,
// but will use them as a last resort (rather than refusing the route).
const CAUTION_PENALTY = 50; // Tight clearance penalty per edge
const DANGER_PENALTY = 5000; // Below-draft penalty per edge
const LAND_PENALTY = 10000; // On-land penalty per edge

// ── Geometry Density Penalty ──
// Edges longer than this threshold get a small additive penalty.
// This forces Dijkstra through short waterway edges (which trace river/channel
// geometry) instead of long seamark shortcuts (which skip geometry).
// Without this, routes have ~22 waypoints with straight-line segments.
// With this, routes have 100-300+ waypoints following actual waterways.
const LONG_EDGE_THRESHOLD_NM = 0.15; // ~280m — edges shorter than this are free
const LONG_EDGE_PENALTY_RATE = 0.5; // additive NM penalty per NM of edge length above threshold

// ── IALA Region A Penalties ──
// Red to port, green to starboard when HEADING IN (returning to port).
// Wrong-side penalty discourages routes that pass buoys on the wrong side.
const IALA_WRONG_SIDE_PENALTY = 2.0; // NM penalty for passing a buoy on the wrong side
const OBSTACLE_PROXIMITY_NM = 0.1; // ~185m check radius for obstacles
const OBSTACLE_PENALTY = 3.0; // NM penalty for edge near an obstacle

// ── Channel Preference ──
// Bonus (cost reduction) for edges that travel between two marker nodes.
// This strongly incentivizes staying in the marked channel (red/green buoys)
// instead of veering off into unmarked shallow water.
const CHANNEL_BONUS = 0.8; // Multiply edge weight by this when between markers (20% discount)

// ── Spherical Math ────────────────────────────────────────────────

function haversineNM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (d: number) => (d * Math.PI) / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(a));
}

// ── Safety Classification ─────────────────────────────────────────

function classifySafety(depthM: number | null, draftM: number): 'safe' | 'caution' | 'danger' {
    if (depthM === null || depthM === undefined) return 'safe'; // No depth data → assume safe
    // Convention: negative = below sea level (navigable water)
    const waterDepth = depthM <= 0 ? Math.abs(depthM) : 0; // positive = land = 0 depth
    if (waterDepth >= draftM + 1.0) return 'safe';
    if (waterDepth >= draftM) return 'caution';
    return 'danger';
}

function depthPenalty(depthM: number | null, draftM: number): number {
    if (depthM === null || depthM === undefined) return 0;
    const waterDepth = depthM <= 0 ? Math.abs(depthM) : 0;
    if (waterDepth >= draftM + 1.0) return 0; // Safe — no penalty
    if (waterDepth >= draftM) return CAUTION_PENALTY; // Caution — moderate penalty
    if (waterDepth > 0) return DANGER_PENALTY; // Danger — massive penalty
    return LAND_PENALTY; // Land — extreme penalty
}

// ── Binary Min-Heap ──────────────────────────────────────────────

interface HeapNode {
    f: number;
    idx: number;
}

class MinHeap {
    private d: HeapNode[] = [];
    get length() {
        return this.d.length;
    }
    push(node: HeapNode) {
        this.d.push(node);
        let i = this.d.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.d[p].f <= this.d[i].f) break;
            [this.d[p], this.d[i]] = [this.d[i], this.d[p]];
            i = p;
        }
    }
    pop(): HeapNode | undefined {
        if (!this.d.length) return undefined;
        const top = this.d[0];
        const last = this.d.pop()!;
        if (this.d.length > 0) {
            this.d[0] = last;
            let i = 0;
            while (true) {
                let s = i;
                const l = 2 * i + 1,
                    r = 2 * i + 2;
                if (l < this.d.length && this.d[l].f < this.d[s].f) s = l;
                if (r < this.d.length && this.d[r].f < this.d[s].f) s = r;
                if (s === i) break;
                [this.d[i], this.d[s]] = [this.d[s], this.d[i]];
                i = s;
            }
        }
        return top;
    }
}

// ── Graph Loading & Caching ──────────────────────────────────────

interface CachedGraph {
    graph: NavGraph;
    adjacency: number[][][]; // adjacency[nodeIdx] = [[neighborIdx, weight], ...]
    markerClass: Map<number, string>; // node_idx → 'port' | 'starboard' | 'cardinal' etc.
    obstacles: number[][]; // [[lon, lat], ...] obstacle locations for proximity checks
    hasDepth: boolean;
    loadedAt: number;
}

const graphCache = new Map<string, CachedGraph>();

async function loadGraph(region: string): Promise<CachedGraph> {
    const cached = graphCache.get(region);
    if (cached && Date.now() - cached.loadedAt < GRAPH_CACHE_TTL) {
        return cached;
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const graphUrl = `${supabaseUrl}/storage/v1/object/public/regions/${region}/nav_graph.json`;

    console.info(`[graph] Loading: ${graphUrl}`);
    const t0 = performance.now();

    const resp = await fetch(graphUrl);
    if (!resp.ok) throw new Error(`Failed to load graph "${region}": ${resp.status}`);

    const graph: NavGraph = await resp.json();
    const hasDepth = graph.meta.coord_order === 'lon_lat_depth';

    // Build adjacency
    const adjacency: number[][][] = new Array(graph.nodes.length);
    for (let i = 0; i < graph.nodes.length; i++) adjacency[i] = [];
    for (const edge of graph.edges) {
        adjacency[edge[0]].push([edge[1], edge[2]]);
        adjacency[edge[1]].push([edge[0], edge[2]]);
    }

    // Build marker lookup for IALA penalties
    const markerClass = new Map<number, string>();
    if (graph.markers) {
        for (const m of graph.markers) {
            markerClass.set(m[0] as number, m[1] as string);
        }
        console.info(`[graph] IALA markers: ${markerClass.size} (port/starboard/cardinal)`);
    }

    // Load obstacle positions for proximity avoidance
    const obstacles: number[][] = graph.obstacles ?? [];
    if (obstacles.length > 0) {
        console.info(`[graph] Obstacles: ${obstacles.length} (danger/special marks)`);
    }

    console.info(
        `[graph] Loaded "${region}": ${graph.meta.nodes} nodes, hasDepth=${hasDepth} (${(performance.now() - t0).toFixed(0)}ms)`,
    );

    const entry: CachedGraph = { graph, adjacency, markerClass, obstacles, hasDepth, loadedAt: Date.now() };
    graphCache.set(region, entry);
    return entry;
}

// ── Snap to Graph ────────────────────────────────────────────────

function snapToGraph(lat: number, lon: number, nodes: number[][]): { idx: number; dist: number } {
    let bestIdx = 0,
        bestDist = Infinity;
    for (let i = 0; i < nodes.length; i++) {
        if (Math.abs(nodes[i][1] - lat) > 0.5 || Math.abs(nodes[i][0] - lon) > 0.5) continue;
        const d = haversineNM(lat, lon, nodes[i][1], nodes[i][0]);
        if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
        }
    }
    return { idx: bestIdx, dist: bestDist };
}

// ── Bearing Calculation for IALA ─────────────────────────────────

function bearingDeg(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const lat1r = (lat1 * Math.PI) / 180;
    const lat2r = (lat2 * Math.PI) / 180;
    const x = Math.sin(dLon) * Math.cos(lat2r);
    const y = Math.cos(lat1r) * Math.sin(lat2r) - Math.sin(lat1r) * Math.cos(lat2r) * Math.cos(dLon);
    return ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360;
}

// ── Depth-Aware Dijkstra with IALA Penalties ─────────────────────

function dijkstra(
    startIdx: number,
    endIdx: number,
    adjacency: number[][][],
    nodes: number[][],
    nodeCount: number,
    draftM: number,
    hasDepth: boolean,
    markerClass: Map<number, string>,
    obstacles: number[][],
): { path: number[]; distance: number } | null {
    const dist = new Float64Array(nodeCount);
    dist.fill(Infinity);
    dist[startIdx] = 0;

    const prev = new Int32Array(nodeCount);
    prev.fill(-1);

    const heap = new MinHeap();
    heap.push({ f: 0, idx: startIdx });

    let expanded = 0;

    while (heap.length > 0) {
        const node = heap.pop()!;

        if (node.idx === endIdx) {
            const path: number[] = [];
            let cur = endIdx;
            while (cur !== -1) {
                path.push(cur);
                cur = prev[cur];
            }
            path.reverse();
            console.info(
                `[dijkstra] Found: ${path.length} nodes, ${dist[endIdx].toFixed(1)} cost, ${expanded} expanded`,
            );
            return { path, distance: dist[endIdx] };
        }

        if (node.f > dist[node.idx]) continue;
        expanded++;

        for (const [neighbor, weight] of adjacency[node.idx]) {
            // Base cost + depth penalty (soft wall)
            let penalty = 0;
            if (hasDepth) {
                const neighborDepth = nodes[neighbor][2] ?? null;
                penalty = depthPenalty(neighborDepth, draftM);
            }

            // Geometry density penalty: penalize long edges to force routing
            // through short waterway edges that trace actual waterway geometry.
            const edgeDistNM = haversineNM(
                nodes[node.idx][1],
                nodes[node.idx][0],
                nodes[neighbor][1],
                nodes[neighbor][0],
            );
            if (edgeDistNM > LONG_EDGE_THRESHOLD_NM) {
                penalty += (edgeDistNM - LONG_EDGE_THRESHOLD_NM) * LONG_EDGE_PENALTY_RATE;
            }

            // IALA Region A directional penalty:
            // When approaching a port/starboard marker, check if we're passing
            // it on the correct side. Red to port, green to starboard (heading in).
            const currentClass = markerClass.get(node.idx);
            const neighborClass = markerClass.get(neighbor);

            if (neighborClass === 'port' || neighborClass === 'starboard') {
                const routeBearing = bearingDeg(
                    nodes[node.idx][1],
                    nodes[node.idx][0],
                    nodes[neighbor][1],
                    nodes[neighbor][0],
                );
                const revBearing = bearingDeg(
                    nodes[neighbor][1],
                    nodes[neighbor][0],
                    nodes[node.idx][1],
                    nodes[node.idx][0],
                );
                let angleDiff = revBearing - routeBearing;
                if (angleDiff > 180) angleDiff -= 360;
                if (angleDiff < -180) angleDiff += 360;
                const buoySide = angleDiff < 0 ? 'port' : 'starboard';
                const correctSide = neighborClass === 'port' ? 'port' : 'starboard';
                if (buoySide !== correctSide) {
                    penalty += IALA_WRONG_SIDE_PENALTY;
                }
            }

            // Cost hierarchy preference:
            // Fairway-to-fairway: 0.5x (cheap highway — centerline routing)
            // Channel markers:    0.8x (between red/green buoys)
            // Virtual grid:       3.0x (already baked into graph edge weights)
            // Everything else:    1.0x standard
            let effectiveWeight = weight;
            if (currentClass === 'fairway' && neighborClass === 'fairway') {
                effectiveWeight *= 0.5; // Fairway discount — strongest incentive
            } else if (
                currentClass &&
                neighborClass &&
                (currentClass === 'port' || currentClass === 'starboard') &&
                (neighborClass === 'port' || neighborClass === 'starboard')
            ) {
                effectiveWeight *= CHANNEL_BONUS; // Channel marker discount
            }

            // Obstacle avoidance: check proximity to danger/special marks.
            // Edges passing near obstacles get a penalty.
            const midLon = (nodes[node.idx][0] + nodes[neighbor][0]) / 2;
            const midLat = (nodes[node.idx][1] + nodes[neighbor][1]) / 2;
            for (const obs of obstacles) {
                const dObs = haversineNM(midLat, midLon, obs[1], obs[0]);
                if (dObs < OBSTACLE_PROXIMITY_NM) {
                    penalty += OBSTACLE_PENALTY * (1 - dObs / OBSTACLE_PROXIMITY_NM);
                    break; // One penalty per edge is enough
                }
            }

            const newDist = dist[node.idx] + effectiveWeight + penalty;
            if (newDist < dist[neighbor]) {
                dist[neighbor] = newDist;
                prev[neighbor] = node.idx;
                heap.push({ f: newDist, idx: neighbor });
            }
        }
    }

    console.warn(`[dijkstra] No path found (expanded ${expanded})`);
    return null;
}

// ── Traffic Light Segmentation ───────────────────────────────────

interface TrafficSegment {
    coordinates: [number, number][];
    safety: 'safe' | 'caution' | 'danger';
    startIdx: number;
    endIdx: number;
}

function segmentRoute(waypoints: RouteWaypoint[]): TrafficSegment[] {
    if (waypoints.length < 2) return [];

    const segments: TrafficSegment[] = [];
    let currentSafety = waypoints[0].safety;
    let currentCoords: [number, number][] = [[waypoints[0].lon, waypoints[0].lat]];
    let startIdx = 0;

    for (let i = 1; i < waypoints.length; i++) {
        const wpSafety = waypoints[i].safety;

        if (wpSafety !== currentSafety) {
            // Close current segment (include this point as the endpoint)
            currentCoords.push([waypoints[i].lon, waypoints[i].lat]);
            segments.push({
                coordinates: currentCoords,
                safety: currentSafety,
                startIdx,
                endIdx: i,
            });

            // Start new segment (include this point as the start)
            currentSafety = wpSafety;
            currentCoords = [[waypoints[i].lon, waypoints[i].lat]];
            startIdx = i;
        } else {
            currentCoords.push([waypoints[i].lon, waypoints[i].lat]);
        }
    }

    // Close final segment
    if (currentCoords.length >= 2) {
        segments.push({
            coordinates: currentCoords,
            safety: currentSafety,
            startIdx,
            endIdx: waypoints.length - 1,
        });
    }

    return segments;
}

function buildTrafficFeatureCollection(
    segments: TrafficSegment[],
    totalNM: number,
    elapsed: number,
    region: string,
    draftM: number,
) {
    const features = segments.map((seg, i) => ({
        type: 'Feature' as const,
        properties: {
            safety: seg.safety,
            segmentIndex: i,
            pointCount: seg.coordinates.length,
        },
        geometry: {
            type: 'LineString' as const,
            coordinates: seg.coordinates,
        },
    }));

    return {
        type: 'FeatureCollection' as const,
        properties: {
            totalNM: Math.round(totalNM * 10) / 10,
            elapsed_ms: Math.round(elapsed),
            router: 'osm_graph_dijkstra',
            region,
            vessel_draft: draftM,
            segments: segments.length,
            hasDanger: segments.some((s) => s.safety === 'danger'),
            hasCaution: segments.some((s) => s.safety === 'caution'),
        },
        features,
    };
}

// ── Port Egress Tracks ───────────────────────────────────────────

interface PortEgressTrack {
    name: string;
    matchLat: number;
    matchLon: number;
    matchRadiusNM: number;
    exitMinIdx?: number;
    egress: { lat: number; lon: number; name: string }[];
}

const PORT_EGRESS_TRACKS: PortEgressTrack[] = [
    {
        name: 'Brisbane River',
        matchLat: -27.43,
        matchLon: 153.08,
        matchRadiusNM: 5,
        exitMinIdx: 32,
        egress: [
            { lat: -27.47788, lon: 153.03289, name: 'Kangaroo Point' },
            { lat: -27.47513, lon: 153.0331, name: 'Kangaroo Pt N' },
            { lat: -27.47232, lon: 153.03421, name: 'New Farm Reach' },
            { lat: -27.46892, lon: 153.03722, name: 'New Farm' },
            { lat: -27.46671, lon: 153.0408, name: 'Teneriffe' },
            { lat: -27.46504, lon: 153.04471, name: 'Newstead' },
            { lat: -27.46368, lon: 153.04898, name: 'Newstead E' },
            { lat: -27.4618, lon: 153.05268, name: 'Breakfast Creek' },
            { lat: -27.45845, lon: 153.05566, name: "Brett's Wharf" },
            { lat: -27.45501, lon: 153.05767, name: 'Bulimba Reach W' },
            { lat: -27.45323, lon: 153.05898, name: 'Bulimba Reach' },
            { lat: -27.45244, lon: 153.06245, name: 'Hamilton' },
            { lat: -27.45078, lon: 153.06456, name: 'Hamilton Reach' },
            { lat: -27.44836, lon: 153.06551, name: 'Portside' },
            { lat: -27.44645, lon: 153.06789, name: 'Bretts Wharf E' },
            { lat: -27.44612, lon: 153.07012, name: 'Eagle Farm' },
            { lat: -27.446, lon: 153.07287, name: 'Eagle Farm E' },
            { lat: -27.44649, lon: 153.07587, name: 'Kingsford Smith' },
            { lat: -27.44621, lon: 153.07888, name: 'Hedley Ave' },
            { lat: -27.44675, lon: 153.08177, name: 'Pinkenba W' },
            { lat: -27.44751, lon: 153.084, name: 'Pinkenba' },
            { lat: -27.44768, lon: 153.08677, name: 'Pinkenba E' },
            { lat: -27.44777, lon: 153.08995, name: 'Myrtletown' },
            { lat: -27.445, lon: 153.091, name: 'Myrtletown N' },
            { lat: -27.443, lon: 153.094, name: 'Luggage Pt W' },
            { lat: -27.439, lon: 153.097, name: 'Luggage Point' },
            { lat: -27.435, lon: 153.102, name: 'Whyte Island' },
            { lat: -27.428, lon: 153.107, name: 'Pinkenba Reach' },
            { lat: -27.422, lon: 153.114, name: 'Port of Brisbane W' },
            { lat: -27.415, lon: 153.121, name: 'Fisherman Islands W' },
            { lat: -27.408, lon: 153.13, name: 'Fisherman Islands' },
            { lat: -27.402, lon: 153.14, name: 'River Mouth' },
            { lat: -27.3993, lon: 153.15303, name: 'Mud Island' },
            { lat: -27.37, lon: 153.17, name: 'NW Channel' },
            { lat: -27.33, lon: 153.2, name: 'Moreton Bay' },
            { lat: -27.29, lon: 153.23, name: 'Outer Bay' },
            { lat: -27.25, lon: 153.25, name: 'Bay Safe Water Mark' },
        ],
    },
];

const BAY_APPROACH: { lat: number; lon: number; name: string }[] = [
    { lat: -27.38, lon: 153.17, name: 'River Mouth Exit' },
    { lat: -27.35, lon: 153.18, name: 'Moreton Bay South' },
    { lat: -27.28, lon: 153.185, name: 'Moreton Bay Central' },
    { lat: -27.23, lon: 153.19, name: 'E of Redcliffe' },
    { lat: -27.2, lon: 153.18, name: 'E of Scarborough' },
    { lat: -27.18, lon: 153.16, name: 'Rounding NE' },
    { lat: -27.17, lon: 153.13, name: 'North Tip' },
    { lat: -27.18, lon: 153.1, name: 'Rounding NW' },
    { lat: -27.198, lon: 153.098, name: 'Newport Approach' },
    { lat: -27.205, lon: 153.095, name: 'Newport Entrance' },
];

// ── Port Functions ───────────────────────────────────────────────

function findPortEgress(
    origin: { lat: number; lon: number },
    destination?: { lat: number; lon: number },
): { track: RouteWaypoint[]; handoff: { lat: number; lon: number } } | null {
    for (const port of PORT_EGRESS_TRACKS) {
        const dist = haversineNM(origin.lat, origin.lon, port.matchLat, port.matchLon);
        if (dist > port.matchRadiusNM) continue;

        let snapIdx = 0,
            snapDist = Infinity;
        for (let i = 0; i < port.egress.length; i++) {
            const d = haversineNM(origin.lat, origin.lon, port.egress[i].lat, port.egress[i].lon);
            if (d < snapDist) {
                snapDist = d;
                snapIdx = i;
            }
        }
        if (snapDist > 3.0) continue;

        let exitIdx = port.egress.length - 1;
        if (destination) {
            const minExit = Math.max(snapIdx, port.exitMinIdx ?? snapIdx);
            let bestTotal = Infinity,
                channelDist = 0;
            for (let i = snapIdx; i < port.egress.length; i++) {
                if (i > snapIdx)
                    channelDist += haversineNM(
                        port.egress[i - 1].lat,
                        port.egress[i - 1].lon,
                        port.egress[i].lat,
                        port.egress[i].lon,
                    );
                if (i >= minExit) {
                    const d = haversineNM(port.egress[i].lat, port.egress[i].lon, destination.lat, destination.lon);
                    if (channelDist + d < bestTotal) {
                        bestTotal = channelDist + d;
                        exitIdx = i;
                    }
                }
            }
        }

        const track: RouteWaypoint[] = [
            { lat: origin.lat, lon: origin.lon, name: 'Origin', depth_m: null, safety: 'safe' },
        ];
        for (let i = snapIdx; i <= exitIdx; i++) {
            track.push({
                lat: port.egress[i].lat,
                lon: port.egress[i].lon,
                name: port.egress[i].name,
                depth_m: null,
                safety: 'safe',
            });
        }

        return { track, handoff: { lat: port.egress[exitIdx].lat, lon: port.egress[exitIdx].lon } };
    }
    return null;
}

function findBayApproach(
    handoff: { lat: number; lon: number },
    destination: { lat: number; lon: number },
): RouteWaypoint[] | null {
    if (!(destination.lat > handoff.lat + 0.05 && destination.lon < handoff.lon - 0.02)) return null;

    let bestIdx = BAY_APPROACH.length - 1,
        bestDist = Infinity;
    for (let i = 0; i < BAY_APPROACH.length; i++) {
        const d = haversineNM(destination.lat, destination.lon, BAY_APPROACH[i].lat, BAY_APPROACH[i].lon);
        if (d < bestDist) {
            bestDist = d;
            bestIdx = i;
        }
    }

    const track: RouteWaypoint[] = [];
    for (let i = 0; i <= bestIdx; i++) {
        track.push({
            lat: BAY_APPROACH[i].lat,
            lon: BAY_APPROACH[i].lon,
            name: BAY_APPROACH[i].name,
            depth_m: null,
            safety: 'safe',
        });
    }
    track.push({ lat: destination.lat, lon: destination.lon, name: 'Destination', depth_m: null, safety: 'safe' });
    return track;
}

// ── Main Handler ─────────────────────────────────────────────────

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return corsResponse(null, 204);
    if (req.method !== 'POST') return jsonResponse({ error: 'POST required' }, 405);

    const t0 = performance.now();

    try {
        const body: RouteRequest = await req.json();
        const { origin, destination, via } = body;
        const region = body.region || 'se_queensland';
        const draftM = body.vessel_draft ?? DEFAULT_DRAFT;

        if (!origin?.lat || !origin?.lon || !destination?.lat || !destination?.lon) {
            return jsonResponse({ error: 'Missing origin/destination coordinates' }, 400);
        }

        console.info(
            `[route] ${origin.lat.toFixed(2)},${origin.lon.toFixed(2)} -> ${destination.lat.toFixed(2)},${destination.lon.toFixed(2)} | draft=${draftM}m`,
        );

        const { graph, adjacency, hasDepth, markerClass, obstacles } = await loadGraph(region);

        let allWP: RouteWaypoint[];

        // ── Pure graph routing (all routes via Dijkstra) ──
        const snapStart = snapToGraph(origin.lat, origin.lon, graph.nodes);
        const snapEnd = snapToGraph(destination.lat, destination.lon, graph.nodes);

        if (snapStart.dist > MAX_SNAP_NM || snapEnd.dist > MAX_SNAP_NM) {
            return jsonResponse(
                {
                    error: `Points too far from navigable waterways (origin: ${snapStart.dist.toFixed(1)}NM, dest: ${snapEnd.dist.toFixed(1)}NM)`,
                },
                422,
            );
        }

        console.info(
            `[route] Snapped: origin→node[${snapStart.idx}] (${snapStart.dist.toFixed(2)}NM), dest→node[${snapEnd.idx}] (${snapEnd.dist.toFixed(2)}NM)`,
        );

        if (via) {
            const snapVia = snapToGraph(via.lat, via.lon, graph.nodes);
            const leg1 = dijkstra(
                snapStart.idx,
                snapVia.idx,
                adjacency,
                graph.nodes,
                graph.nodes.length,
                draftM,
                hasDepth,
                markerClass,
                obstacles,
            );
            const leg2 = dijkstra(
                snapVia.idx,
                snapEnd.idx,
                adjacency,
                graph.nodes,
                graph.nodes.length,
                draftM,
                hasDepth,
                markerClass,
                obstacles,
            );
            if (!leg1 || !leg2) return jsonResponse({ error: 'No route found through via point' }, 422);

            const wp1 = leg1.path.map((idx) => {
                const d = hasDepth ? (graph.nodes[idx][2] ?? null) : null;
                return {
                    lat: graph.nodes[idx][1],
                    lon: graph.nodes[idx][0],
                    name: 'WP',
                    depth_m: d,
                    safety: classifySafety(d, draftM) as 'safe' | 'caution' | 'danger',
                };
            });
            const wp2 = leg2.path.map((idx) => {
                const d = hasDepth ? (graph.nodes[idx][2] ?? null) : null;
                return {
                    lat: graph.nodes[idx][1],
                    lon: graph.nodes[idx][0],
                    name: 'WP',
                    depth_m: d,
                    safety: classifySafety(d, draftM) as 'safe' | 'caution' | 'danger',
                };
            });
            allWP = [
                { lat: origin.lat, lon: origin.lon, name: 'Origin', depth_m: null, safety: 'safe' as const },
                ...wp1.slice(1),
                ...wp2.slice(1),
                { lat: destination.lat, lon: destination.lon, name: 'Arrival', depth_m: null, safety: 'safe' as const },
            ];
        } else {
            const result = dijkstra(
                snapStart.idx,
                snapEnd.idx,
                adjacency,
                graph.nodes,
                graph.nodes.length,
                draftM,
                hasDepth,
                markerClass,
                obstacles,
            );
            if (!result) return jsonResponse({ error: 'No route found' }, 422);

            allWP = [
                { lat: origin.lat, lon: origin.lon, name: 'Origin', depth_m: null, safety: 'safe' as const },
                ...result.path.map((idx) => {
                    const d = hasDepth ? (graph.nodes[idx][2] ?? null) : null;
                    return {
                        lat: graph.nodes[idx][1],
                        lon: graph.nodes[idx][0],
                        name: 'WP',
                        depth_m: d,
                        safety: classifySafety(d, draftM) as 'safe' | 'caution' | 'danger',
                    };
                }),
                { lat: destination.lat, lon: destination.lon, name: 'Arrival', depth_m: null, safety: 'safe' as const },
            ];
        }

        // ── Name waypoints ──
        const waypoints = allWP.map((wp, i) => ({
            ...wp,
            name:
                i === 0
                    ? 'Departure'
                    : i === allWP.length - 1
                      ? 'Arrival'
                      : wp.name !== 'WP'
                        ? wp.name
                        : `WP-${String(i).padStart(2, '0')}`,
        }));

        // ── Total distance ──
        let totalNM = 0;
        for (let i = 1; i < waypoints.length; i++) {
            totalNM += haversineNM(waypoints[i - 1].lat, waypoints[i - 1].lon, waypoints[i].lat, waypoints[i].lon);
        }

        const elapsed = performance.now() - t0;

        // ── Traffic Light Segmentation ──
        const segments = segmentRoute(waypoints);
        const trafficGeoJSON = buildTrafficFeatureCollection(segments, totalNM, elapsed, region, draftM);

        // ── Also build simple LineString for backwards compat ──
        const geojson = {
            type: 'Feature' as const,
            properties: {
                totalNM: Math.round(totalNM * 10) / 10,
                waypoints: waypoints.length,
                elapsed_ms: Math.round(elapsed),
                router: 'osm_graph_dijkstra',
                region,
                vessel_draft: draftM,
                hasDanger: segments.some((s) => s.safety === 'danger'),
                hasCaution: segments.some((s) => s.safety === 'caution'),
            },
            geometry: {
                type: 'LineString' as const,
                coordinates: waypoints.map((wp) => [wp.lon, wp.lat]),
            },
        };

        const safetyBreakdown = {
            safe: segments.filter((s) => s.safety === 'safe').length,
            caution: segments.filter((s) => s.safety === 'caution').length,
            danger: segments.filter((s) => s.safety === 'danger').length,
        };

        console.info(
            `[route] ✓ ${waypoints.length} WPs, ${totalNM.toFixed(1)} NM, ${elapsed.toFixed(0)}ms | safety: ${JSON.stringify(safetyBreakdown)}`,
        );

        return jsonResponse({
            waypoints,
            totalNM: Math.round(totalNM * 10) / 10,
            elapsed_ms: Math.round(elapsed),
            router: 'osm_graph_dijkstra',
            region,
            vessel_draft: draftM,
            safety: safetyBreakdown,
            geojson, // Backwards-compatible single LineString
            trafficGeoJSON, // NEW: Segmented FeatureCollection for traffic light
        });
    } catch (err) {
        console.error('[route] ERROR:', err);
        return jsonResponse({ error: err instanceof Error ? err.message : String(err) }, 500);
    }
});
