/**
 * Offline Navigation Router Service
 *
 * Fully client-side routing using the pre-computed OSM navigation graph.
 * Uses ngraph for graph representation & A* pathfinding, and kdbush
 * for spatial indexing (snap user taps to nearest graph node).
 *
 * Architecture:
 *   1. Load thalassa_nav_graph JSON from Supabase Storage (or local cache)
 *   2. Build ngraph in memory + kdbush spatial index
 *   3. User taps → snap to nearest node via kdbush
 *   4. A* pathfinding → GeoJSON LineString for Mapbox rendering
 *
 * Graph format (from build_nav_graph.py):
 *   nodes: [[lon, lat], ...]
 *   edges: [[fromIdx, toIdx, weightNM], ...]
 */

import createGraph from 'ngraph.graph';
import { aStar } from 'ngraph.path';
import KDBush from 'kdbush';

// ── Types ─────────────────────────────────────────────────────────

interface NavGraphMeta {
    version: number;
    region: string;
    nodes: number;
    edges: number;
    total_nm: number;
}

interface NavGraphData {
    meta: NavGraphMeta;
    nodes: number[][]; // [[lon, lat], ...]
    edges: number[][]; // [[from, to, weight], ...]
}

interface RouteResult {
    /** Ordered waypoints [lon, lat] for Mapbox rendering */
    coordinates: [number, number][];
    /** Total distance in nautical miles */
    distanceNM: number;
    /** Number of waypoints */
    waypointCount: number;
    /** Computation time in ms */
    computeMs: number;
    /** GeoJSON Feature for direct Mapbox source consumption */
    geojson: GeoJSON.Feature<GeoJSON.LineString>;
}

// ── Constants ─────────────────────────────────────────────────────

const EARTH_RADIUS_NM = 3440.065;
const MAX_SNAP_NM = 5.0; // Max snap distance to graph node
const GRAPH_STORAGE_KEY = 'thalassa_nav_graph';

// ── Haversine ─────────────────────────────────────────────────────

function haversineNM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = (d: number) => d * Math.PI / 180;
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
        Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(a));
}

// ── Service Class ─────────────────────────────────────────────────

export class OfflineRouterService {
    private graph: ReturnType<typeof createGraph> | null = null;
    private spatialIndex: KDBush | null = null;
    private nodes: number[][] = [];
    private meta: NavGraphMeta | null = null;
    private loaded = false;
    private loading: Promise<void> | null = null;

    /**
     * Load the navigation graph from Supabase Storage.
     * Caches in localStorage for subsequent offline loads.
     */
    async load(
        supabaseUrl: string,
        region = 'se_queensland',
    ): Promise<void> {
        // Prevent duplicate loads
        if (this.loaded) return;
        if (this.loading) return this.loading;

        this.loading = this._doLoad(supabaseUrl, region);
        await this.loading;
    }

    private async _doLoad(supabaseUrl: string, region: string): Promise<void> {
        const t0 = performance.now();

        let data: NavGraphData;

        // Try localStorage cache first
        try {
            const cached = localStorage.getItem(`${GRAPH_STORAGE_KEY}_${region}`);
            if (cached) {
                data = JSON.parse(cached);
                console.log(`[OfflineRouter] Loaded "${region}" from cache (${data.meta.nodes} nodes)`);
            } else {
                throw new Error('No cache');
            }
        } catch {
            // Fetch from Supabase Storage
            const url = `${supabaseUrl}/storage/v1/object/public/nav-graphs/${region}.json`;
            console.log(`[OfflineRouter] Fetching: ${url}`);

            const resp = await fetch(url);
            if (!resp.ok) throw new Error(`Failed to load graph: ${resp.status}`);
            data = await resp.json();

            // Cache in localStorage (6.8MB fits within 10MB limit)
            try {
                localStorage.setItem(`${GRAPH_STORAGE_KEY}_${region}`, JSON.stringify(data));
            } catch (e) {
                console.warn('[OfflineRouter] localStorage cache failed (quota exceeded)');
            }
        }

        this.meta = data.meta;
        this.nodes = data.nodes;

        // ── Build ngraph ──
        const g = createGraph();

        // Add nodes (id = index)
        for (let i = 0; i < data.nodes.length; i++) {
            g.addNode(i, { lon: data.nodes[i][0], lat: data.nodes[i][1] });
        }

        // Add edges with distance weights
        for (const [from, to, weight] of data.edges) {
            g.addLink(from, to, { weight });
        }

        this.graph = g;

        // ── Build spatial index ──
        // kdbush indexes [lon, lat] for fast nearest-neighbor lookup
        this.spatialIndex = new KDBush(data.nodes.length);
        for (let i = 0; i < data.nodes.length; i++) {
            this.spatialIndex.add(data.nodes[i][0], data.nodes[i][1]);
        }
        this.spatialIndex.finish();

        this.loaded = true;
        const elapsed = performance.now() - t0;
        console.log(
            `[OfflineRouter] ✓ Ready: ${data.meta.nodes} nodes, ${data.meta.edges} edges, ` +
            `${data.meta.total_nm} NM (${elapsed.toFixed(0)}ms)`,
        );
    }

    /** Check if the router is loaded and ready. */
    get isReady(): boolean {
        return this.loaded;
    }

    /** Get the loaded region metadata. */
    get regionMeta(): NavGraphMeta | null {
        return this.meta;
    }

    /**
     * Snap a lat/lon coordinate to the nearest graph node.
     * Uses kdbush spatial index for O(√n) performance.
     */
    snapToNode(lat: number, lon: number): { nodeId: number; distNM: number } | null {
        if (!this.spatialIndex || !this.nodes.length) return null;

        // kdbush range query: search within ~0.1° box first
        const candidates = this.spatialIndex.range(
            lon - 0.1, lat - 0.1,
            lon + 0.1, lat + 0.1,
        );

        if (candidates.length === 0) {
            // Widen to 0.5° box
            const wider = this.spatialIndex.range(
                lon - 0.5, lat - 0.5,
                lon + 0.5, lat + 0.5,
            );
            if (wider.length === 0) return null;
            candidates.push(...wider);
        }

        // Find nearest by haversine
        let bestId = candidates[0];
        let bestDist = Infinity;

        for (const id of candidates) {
            const d = haversineNM(lat, lon, this.nodes[id][1], this.nodes[id][0]);
            if (d < bestDist) {
                bestDist = d;
                bestId = id;
            }
        }

        if (bestDist > MAX_SNAP_NM) return null;

        return { nodeId: bestId, distNM: bestDist };
    }

    /**
     * Route between two coordinates using A* pathfinding.
     * Returns a GeoJSON LineString for direct Mapbox rendering.
     */
    route(
        originLat: number, originLon: number,
        destLat: number, destLon: number,
        viaLat?: number, viaLon?: number,
    ): RouteResult | null {
        if (!this.graph || !this.nodes.length) {
            console.error('[OfflineRouter] Graph not loaded');
            return null;
        }

        const t0 = performance.now();

        // Snap origin and destination
        const snapOrigin = this.snapToNode(originLat, originLon);
        const snapDest = this.snapToNode(destLat, destLon);

        if (!snapOrigin || !snapDest) {
            console.warn(
                `[OfflineRouter] Snap failed: origin=${snapOrigin?.distNM.toFixed(1) ?? 'null'}NM, ` +
                `dest=${snapDest?.distNM.toFixed(1) ?? 'null'}NM`,
            );
            return null;
        }

        console.log(
            `[OfflineRouter] Snap: origin→[${snapOrigin.nodeId}] ${snapOrigin.distNM.toFixed(1)}NM, ` +
            `dest→[${snapDest.nodeId}] ${snapDest.distNM.toFixed(1)}NM`,
        );

        // Build pathfinder with A*
        const pathFinder = aStar(this.graph, {
            distance: (_fromNode, _toNode, link) => {
                return link.data?.weight ?? 1;
            },
            heuristic: (fromNode, toNode) => {
                const f = fromNode.data;
                const t = toNode.data;
                if (!f || !t) return 0;
                return haversineNM(f.lat, f.lon, t.lat, t.lon);
            },
        });

        let fullPath: number[];

        if (viaLat !== undefined && viaLon !== undefined) {
            // Route via a waypoint
            const snapVia = this.snapToNode(viaLat, viaLon);
            if (!snapVia) {
                console.warn('[OfflineRouter] Via point snap failed');
                return null;
            }

            const path1 = pathFinder.find(snapOrigin.nodeId, snapVia.nodeId);
            const path2 = pathFinder.find(snapVia.nodeId, snapDest.nodeId);

            if (!path1.length || !path2.length) {
                console.warn('[OfflineRouter] No path found through via point');
                return null;
            }

            // Merge paths (remove duplicate via node)
            fullPath = [
                ...path1.map(n => n.id as number),
                ...path2.slice(1).map(n => n.id as number),
            ];
        } else {
            const path = pathFinder.find(snapOrigin.nodeId, snapDest.nodeId);
            if (!path.length) {
                console.warn('[OfflineRouter] No path found');
                return null;
            }
            fullPath = path.map(n => n.id as number);
        }

        // Build coordinates array (including original origin/dest)
        const coordinates: [number, number][] = [
            [originLon, originLat],
            ...fullPath.map(id => [this.nodes[id][0], this.nodes[id][1]] as [number, number]),
            [destLon, destLat],
        ];

        // Calculate total distance
        let distanceNM = 0;
        for (let i = 1; i < coordinates.length; i++) {
            distanceNM += haversineNM(
                coordinates[i - 1][1], coordinates[i - 1][0],
                coordinates[i][1], coordinates[i][0],
            );
        }

        const computeMs = performance.now() - t0;

        // Build GeoJSON for Mapbox
        const geojson: GeoJSON.Feature<GeoJSON.LineString> = {
            type: 'Feature',
            properties: {
                distanceNM: Math.round(distanceNM * 10) / 10,
                waypointCount: coordinates.length,
                computeMs: Math.round(computeMs),
                router: 'offline_ngraph_astar',
                region: this.meta?.region ?? 'unknown',
            },
            geometry: {
                type: 'LineString',
                coordinates,
            },
        };

        console.log(
            `[OfflineRouter] ✓ ${coordinates.length} WPs, ${distanceNM.toFixed(1)} NM, ${computeMs.toFixed(0)}ms`,
        );

        return {
            coordinates,
            distanceNM: Math.round(distanceNM * 10) / 10,
            waypointCount: coordinates.length,
            computeMs: Math.round(computeMs),
            geojson,
        };
    }

    /** Clear the cached graph from localStorage. */
    clearCache(region = 'se_queensland'): void {
        localStorage.removeItem(`${GRAPH_STORAGE_KEY}_${region}`);
        console.log(`[OfflineRouter] Cache cleared for "${region}"`);
    }

    /** Dispose of the graph and free memory. */
    dispose(): void {
        this.graph = null;
        this.spatialIndex = null;
        this.nodes = [];
        this.meta = null;
        this.loaded = false;
        this.loading = null;
    }
}

// ── Singleton ─────────────────────────────────────────────────────

export const offlineRouter = new OfflineRouterService();
