/**
 * Inshore Router — A* pathfinding through ENC navigability grids.
 *
 * Why this exists
 * ───────────────
 * The deep-water routing engine in Thalassa (isochrone + corridor) is
 * designed for ocean passages with weather optimization. It bails on
 * anything under 100 NM and refuses river/inshore passages because:
 *   - Both endpoints are inland → no straight-line corridor works
 *   - GEBCO bathymetry (15 arc-sec ≈ 460m) misses river channels
 *   - Wind grids don't matter at 6 knots through a 300m channel
 *
 * What this does
 * ──────────────
 * Takes the converted ENC GeoJSON for one or more cells, rasterizes the
 * vector hazard layers (LNDARE, DEPARE, OBSTRN, WRECKS, UWTROC) into a
 * 2D navigability grid at meter-scale resolution (default 50m), then
 * runs A* with 8-neighbor moves to find the shortest channel-following
 * path between two points. Output is a simplified polyline.
 *
 * Why on the Pi
 * ─────────────
 * The Pi already holds the converted GeoJSON in its persistent chart
 * store. Building the grid + A* is single-digit seconds for a typical
 * harbor cell on Pi 5 hardware. Doing it on-device would require
 * shipping multi-MB grids over the boat LAN; the pi → polyline round-
 * trip is a few KB at most.
 *
 * Algorithm
 * ─────────
 * 1. Compute route bbox = origin/dest envelope expanded by margin.
 * 2. Rasterize layers onto a [height x width] grid:
 *    - Default = navigable (depth unknown).
 *    - LNDARE polygon → cell blocked.
 *    - DEPARE polygon w/ DRVAL1 < draft+safety → cell blocked.
 *    - DEPARE polygon w/ DRVAL1 ≥ draft+safety → cell depth = DRVAL1.
 *    - OBSTRN/WRECKS/UWTROC point within buffer → cell blocked.
 * 3. Snap origin/destination to nearest navigable cell (BFS).
 * 4. A* with 8-neighbor moves, cost = step distance, h = great-circle.
 * 5. Reconstruct + Douglas-Peucker simplify.
 *
 * MVP notes
 * ─────────
 * Single-cell only. Multi-cell stitching is Phase 13.2.
 * Default permissive ("no data = open"); tide-aware draft is Phase 13.3.
 * No channel preference cost yet (would penalize leaving DEPARE >5m).
 */

import type { Feature, FeatureCollection, Polygon, MultiPolygon, Point, Position } from 'geojson';

// ── Types ──────────────────────────────────────────────────────────

/**
 * The subset of layers we actually consume. Other ENC layers in the
 * cell blob (COALNE, LIGHTS, BOYLAT, etc.) are ignored — they're
 * either redundant with LNDARE (COALNE) or display-only.
 */
export interface InshoreLayers {
    LNDARE?: FeatureCollection;
    DEPARE?: FeatureCollection;
    OBSTRN?: FeatureCollection;
    WRECKS?: FeatureCollection;
    UWTROC?: FeatureCollection;
}

export interface RouteRequest {
    fromLat: number;
    fromLon: number;
    toLat: number;
    toLon: number;
    /** Vessel draft in meters. Required — drives DEPARE filtering. */
    draftM: number;
    /** Additional clearance above draft in meters. Default 1.0 m. */
    safetyM?: number;
    /** Grid cell size in meters. Default 50 m. */
    resolutionM?: number;
    /** Buffer around point obstructions in meters. Default 30 m. */
    obstructionBufferM?: number;
}

/**
 * Diagnostics emitted alongside both success and failure responses.
 * Lets a caller see grid health (how navigable the route bbox is)
 * without parsing the full polyline. Specifically useful when a
 * route fails: tells the user "we built a 30k-cell grid, only 1200
 * were navigable, your origin snapped to (x,y) but couldn't reach
 * destination's component" — much better than a bare 'no-path'.
 */
export interface RouteDebug {
    gridSize: { width: number; height: number };
    cellsTotal: number;
    cellsNavigable: number;
    cellsBlocked: number;
    /** Cells reachable via 8-neighbor flood-fill from the origin's snapped cell. */
    cellsReachableFromOrigin?: number;
    /** Origin snap result in cell coordinates + surrounding lat/lon. */
    originSnap?: { x: number; y: number; snappedLat: number; snappedLon: number; snapDistanceM: number };
    /** Destination snap result. */
    destinationSnap?: { x: number; y: number; snappedLat: number; snappedLon: number; snapDistanceM: number };
}

export interface RouteResult {
    polyline: [number, number][]; // [lon, lat], lon-first per GeoJSON convention
    distanceNM: number;
    gridSize: { width: number; height: number };
    bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
    debug?: RouteDebug;
}

export interface RouteFailure {
    error: string;
    /** Optional sub-reason for UI categorization. */
    code?:
        | 'origin-on-land'
        | 'destination-on-land'
        | 'destination-disconnected'
        | 'no-path'
        | 'origin-out-of-bounds'
        | 'destination-out-of-bounds'
        | 'empty-grid';
    debug?: RouteDebug;
}

// ── Geometry helpers ────────────────────────────────────────────────

const M_PER_DEG_LAT = 111_320;
function mPerDegLon(lat: number): number {
    return 111_320 * Math.cos((lat * Math.PI) / 180);
}

/** Great-circle distance in meters using the haversine formula. */
function haversineM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6_371_000;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const dφ = ((lat2 - lat1) * Math.PI) / 180;
    const dλ = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Ray-casting point-in-polygon for a single ring.
 * Coordinates are [lon, lat]. Returns true if (lon, lat) is inside.
 */
function pointInRing(lon: number, lat: number, ring: Position[]): boolean {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const xi = ring[i][0];
        const yi = ring[i][1];
        const xj = ring[j][0];
        const yj = ring[j][1];
        const intersects = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
        if (intersects) inside = !inside;
    }
    return inside;
}

/**
 * Point-in-(Polygon|MultiPolygon). Outer ring contains; inner rings
 * (holes) subtract. Polygon[0] is outer, Polygon[1+] are holes.
 */
function pointInGeometry(lon: number, lat: number, geom: Polygon | MultiPolygon): boolean {
    if (geom.type === 'Polygon') {
        if (!pointInRing(lon, lat, geom.coordinates[0])) return false;
        for (let h = 1; h < geom.coordinates.length; h++) {
            if (pointInRing(lon, lat, geom.coordinates[h])) return false; // in hole
        }
        return true;
    }
    // MultiPolygon
    for (const poly of geom.coordinates) {
        if (!pointInRing(lon, lat, poly[0])) continue;
        let inHole = false;
        for (let h = 1; h < poly.length; h++) {
            if (pointInRing(lon, lat, poly[h])) {
                inHole = true;
                break;
            }
        }
        if (!inHole) return true;
    }
    return false;
}

/**
 * Compute the bbox of a polygon/multipolygon geometry as
 * [minLon, minLat, maxLon, maxLat]. Used to skip cells that can't
 * possibly be inside the polygon.
 */
function geometryBbox(geom: Polygon | MultiPolygon): [number, number, number, number] {
    let minLon = Infinity,
        minLat = Infinity,
        maxLon = -Infinity,
        maxLat = -Infinity;
    const rings = geom.type === 'Polygon' ? [geom.coordinates[0]] : geom.coordinates.map((p) => p[0]);
    for (const ring of rings) {
        for (const [lon, lat] of ring) {
            if (lon < minLon) minLon = lon;
            if (lon > maxLon) maxLon = lon;
            if (lat < minLat) minLat = lat;
            if (lat > maxLat) maxLat = lat;
        }
    }
    return [minLon, minLat, maxLon, maxLat];
}

// ── Grid ────────────────────────────────────────────────────────────

/**
 * Cell state encoded as a single Float32 value:
 *   NaN   = blocked (land / shallow / obstruction)
 *   ≥0    = navigable, value is depth in meters (0 = unknown but open)
 */
const BLOCKED = Number.NaN;
const UNKNOWN_OPEN = 0;

interface NavGrid {
    width: number;
    height: number;
    /** Geographic origin: bbox SW corner. */
    minLon: number;
    minLat: number;
    /** Cell sizes in degrees. */
    dLon: number;
    dLat: number;
    /** Float32Array length = width*height. NaN = blocked, ≥0 = depth. */
    cells: Float32Array;
}

function isNavigable(grid: NavGrid, x: number, y: number): boolean {
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return false;
    return !Number.isNaN(grid.cells[y * grid.width + x]);
}

function gridToLatLon(grid: NavGrid, x: number, y: number): [number, number] {
    // Cell center
    const lon = grid.minLon + (x + 0.5) * grid.dLon;
    const lat = grid.minLat + (y + 0.5) * grid.dLat;
    return [lon, lat];
}

function latLonToGrid(grid: NavGrid, lat: number, lon: number): { x: number; y: number } {
    const x = Math.floor((lon - grid.minLon) / grid.dLon);
    const y = Math.floor((lat - grid.minLat) / grid.dLat);
    return { x, y };
}

/**
 * Build a navigability grid for the given bbox, draft, and resolution.
 * Time complexity is roughly O(featureCount × cellsPerFeatureBbox).
 * Polygons rasterize in their bbox slice rather than the whole grid.
 */
function buildNavGrid(
    layers: InshoreLayers,
    bbox: [number, number, number, number],
    resolutionM: number,
    draftM: number,
    safetyM: number,
    obstructionBufferM: number,
): NavGrid {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    const midLat = (minLat + maxLat) / 2;
    const mPerLon = mPerDegLon(midLat);

    // Cell size in degrees, sized to the configured meter resolution.
    const dLon = resolutionM / mPerLon;
    const dLat = resolutionM / M_PER_DEG_LAT;
    const width = Math.max(1, Math.ceil((maxLon - minLon) / dLon));
    const height = Math.max(1, Math.ceil((maxLat - minLat) / dLat));

    const cells = new Float32Array(width * height);
    cells.fill(UNKNOWN_OPEN); // permissive default — see header doc
    const grid: NavGrid = { width, height, minLon, minLat, dLon, dLat, cells };

    // Helper to convert a polygon bbox to grid coordinate range.
    const polyToCellRange = (
        polyBbox: [number, number, number, number],
    ): { x0: number; x1: number; y0: number; y1: number } => {
        const x0 = Math.max(0, Math.floor((polyBbox[0] - minLon) / dLon));
        const x1 = Math.min(width - 1, Math.ceil((polyBbox[2] - minLon) / dLon));
        const y0 = Math.max(0, Math.floor((polyBbox[1] - minLat) / dLat));
        const y1 = Math.min(height - 1, Math.ceil((polyBbox[3] - minLat) / dLat));
        return { x0, x1, y0, y1 };
    };

    // ── Pass 1: DEPARE — assign depth values ────────────────────────
    // Done first so a subsequent LNDARE pass overrides shallow water
    // with land-block on cells where both apply (rare but possible).
    const depare = layers.DEPARE?.features ?? [];
    for (const f of depare) {
        const g = f.geometry;
        if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') continue;
        const drval1 = (f.properties as Record<string, unknown> | null)?.['DRVAL1'];
        // S-57 DRVAL1 is positive depth in meters.
        const drval1Num = typeof drval1 === 'number' ? drval1 : null;

        const pBbox = geometryBbox(g);
        const { x0, x1, y0, y1 } = polyToCellRange(pBbox);
        if (x0 > x1 || y0 > y1) continue;

        for (let y = y0; y <= y1; y++) {
            const lat = minLat + (y + 0.5) * dLat;
            for (let x = x0; x <= x1; x++) {
                const lon = minLon + (x + 0.5) * dLon;
                if (!pointInGeometry(lon, lat, g)) continue;
                const idx = y * width + x;

                if (drval1Num == null) {
                    // No depth value — keep "open unknown" unless already set deeper.
                    continue;
                }
                if (drval1Num < draftM + safetyM) {
                    cells[idx] = BLOCKED;
                } else {
                    // Track shallowest known depth at this cell.
                    const prior = cells[idx];
                    if (Number.isNaN(prior)) {
                        // already blocked
                    } else if (prior === UNKNOWN_OPEN || drval1Num < prior) {
                        cells[idx] = drval1Num;
                    }
                }
            }
        }
    }

    // ── Pass 2: LNDARE — block land cells unconditionally ───────────
    const lndare = layers.LNDARE?.features ?? [];
    for (const f of lndare) {
        const g = f.geometry;
        if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') continue;
        const pBbox = geometryBbox(g);
        const { x0, x1, y0, y1 } = polyToCellRange(pBbox);
        if (x0 > x1 || y0 > y1) continue;

        for (let y = y0; y <= y1; y++) {
            const lat = minLat + (y + 0.5) * dLat;
            for (let x = x0; x <= x1; x++) {
                const lon = minLon + (x + 0.5) * dLon;
                if (pointInGeometry(lon, lat, g)) {
                    cells[y * width + x] = BLOCKED;
                }
            }
        }
    }

    // ── Pass 3: point obstructions — block radius around each ──────
    const blockPointBuffer = (lat: number, lon: number): void => {
        const dLatBuf = obstructionBufferM / M_PER_DEG_LAT;
        const dLonBuf = obstructionBufferM / mPerLon;
        const x0 = Math.max(0, Math.floor((lon - dLonBuf - minLon) / dLon));
        const x1 = Math.min(width - 1, Math.ceil((lon + dLonBuf - minLon) / dLon));
        const y0 = Math.max(0, Math.floor((lat - dLatBuf - minLat) / dLat));
        const y1 = Math.min(height - 1, Math.ceil((lat + dLatBuf - minLat) / dLat));
        for (let y = y0; y <= y1; y++) {
            const cellLat = minLat + (y + 0.5) * dLat;
            for (let x = x0; x <= x1; x++) {
                const cellLon = minLon + (x + 0.5) * dLon;
                const dM = haversineM(cellLat, cellLon, lat, lon);
                if (dM <= obstructionBufferM) {
                    cells[y * width + x] = BLOCKED;
                }
            }
        }
    };

    const handlePointFeature = (f: Feature): void => {
        if (!f.geometry) return;
        if (f.geometry.type === 'Point') {
            const [lon, lat] = (f.geometry as Point).coordinates;
            blockPointBuffer(lat, lon);
        } else if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') {
            // For polygon obstructions, treat the polygon area itself as blocked.
            const g = f.geometry as Polygon | MultiPolygon;
            const pBbox = geometryBbox(g);
            const { x0, x1, y0, y1 } = polyToCellRange(pBbox);
            for (let y = y0; y <= y1; y++) {
                const lat = minLat + (y + 0.5) * dLat;
                for (let x = x0; x <= x1; x++) {
                    const lon = minLon + (x + 0.5) * dLon;
                    if (pointInGeometry(lon, lat, g)) cells[y * width + x] = BLOCKED;
                }
            }
        }
    };

    for (const f of layers.OBSTRN?.features ?? []) handlePointFeature(f);
    for (const f of layers.WRECKS?.features ?? []) handlePointFeature(f);
    for (const f of layers.UWTROC?.features ?? []) handlePointFeature(f);

    return grid;
}

/**
 * BFS outward from (lat, lon) to find the nearest cell that satisfies
 * `accept`. Returns null if nothing within `maxRadiusCells` matches.
 *
 * Two-flavor wrapper to support both:
 *   - "find nearest navigable cell" (used to snap origin)
 *   - "find nearest cell in the origin's connected component"
 *     (used to snap destination, prevents "wrong pond" failures)
 */
function snapWithPredicate(
    grid: NavGrid,
    lat: number,
    lon: number,
    maxRadiusCells: number,
    accept: (cellIdx: number) => boolean,
): { x: number; y: number } | null {
    const start = latLonToGrid(grid, lat, lon);
    if (start.x < 0 || start.y < 0 || start.x >= grid.width || start.y >= grid.height) {
        return null;
    }
    if (accept(start.y * grid.width + start.x)) return start;

    const visited = new Uint8Array(grid.width * grid.height);
    visited[start.y * grid.width + start.x] = 1;
    let frontier: { x: number; y: number; r: number }[] = [{ x: start.x, y: start.y, r: 0 }];

    while (frontier.length) {
        const next: typeof frontier = [];
        for (const { x, y, r } of frontier) {
            if (r > maxRadiusCells) return null;
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
                    const idx = ny * grid.width + nx;
                    if (visited[idx]) continue;
                    visited[idx] = 1;
                    if (accept(idx)) return { x: nx, y: ny };
                    next.push({ x: nx, y: ny, r: r + 1 });
                }
            }
        }
        frontier = next;
    }
    return null;
}

function snapToNavigable(
    grid: NavGrid,
    lat: number,
    lon: number,
    maxRadiusCells: number,
): { x: number; y: number } | null {
    return snapWithPredicate(grid, lat, lon, maxRadiusCells, (idx) => !Number.isNaN(grid.cells[idx]));
}

/**
 * Flood-fill 8-neighbor from `start`, marking every reachable
 * navigable cell. Output is a Uint8Array sized to the grid
 * (1 = reachable, 0 = blocked or never visited).
 *
 * Used to compute the connected component containing the origin
 * BEFORE snapping the destination. If we naively snap destination
 * to its nearest navigable cell, that cell can be in a totally
 * unrelated body of water (the geocoded "Port Wentworth" might
 * sit closer to a flooded marsh than to the actual Savannah River
 * channel that connects to origin). Snapping into the origin's
 * connected component guarantees A* finds a path.
 */
function reachableCellsFrom(grid: NavGrid, start: { x: number; y: number }): Uint8Array {
    const total = grid.width * grid.height;
    const reachable = new Uint8Array(total);
    const startIdx = start.y * grid.width + start.x;
    reachable[startIdx] = 1;
    // Using a flat queue with head index instead of shift() — shift()
    // is O(n) per pop in V8, which would make this loop quadratic on
    // a large grid.
    const queue = new Int32Array(total);
    queue[0] = startIdx;
    let qHead = 0;
    let qTail = 1;
    while (qHead < qTail) {
        const idx = queue[qHead++];
        const x = idx % grid.width;
        const y = Math.floor(idx / grid.width);
        for (let dy = -1; dy <= 1; dy++) {
            const ny = y + dy;
            if (ny < 0 || ny >= grid.height) continue;
            for (let dx = -1; dx <= 1; dx++) {
                if (dx === 0 && dy === 0) continue;
                const nx = x + dx;
                if (nx < 0 || nx >= grid.width) continue;
                const nIdx = ny * grid.width + nx;
                if (reachable[nIdx]) continue;
                if (Number.isNaN(grid.cells[nIdx])) continue;
                reachable[nIdx] = 1;
                queue[qTail++] = nIdx;
            }
        }
    }
    return reachable;
}

// ── Min-heap for A* open set ────────────────────────────────────────

interface HeapEntry {
    f: number; // priority = g + h
    idx: number; // grid index
}

class MinHeap {
    private a: HeapEntry[] = [];
    push(e: HeapEntry): void {
        this.a.push(e);
        this.bubbleUp(this.a.length - 1);
    }
    pop(): HeapEntry | undefined {
        if (this.a.length === 0) return undefined;
        const top = this.a[0];
        const last = this.a.pop()!;
        if (this.a.length > 0) {
            this.a[0] = last;
            this.sinkDown(0);
        }
        return top;
    }
    get size(): number {
        return this.a.length;
    }
    private bubbleUp(i: number): void {
        const item = this.a[i];
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (this.a[p].f <= item.f) break;
            this.a[i] = this.a[p];
            i = p;
        }
        this.a[i] = item;
    }
    private sinkDown(i: number): void {
        const item = this.a[i];
        const n = this.a.length;
        while (true) {
            const l = 2 * i + 1;
            const r = 2 * i + 2;
            let smallest = i;
            if (l < n && this.a[l].f < this.a[smallest].f) smallest = l;
            if (r < n && this.a[r].f < this.a[smallest].f) smallest = r;
            if (smallest === i) break;
            this.a[i] = this.a[smallest];
            i = smallest;
        }
        this.a[i] = item;
    }
}

// ── A* ───────────────────────────────────────────────────────────────

/**
 * Cost multiplier per cell based on its known depth.
 *
 * Why this exists: without it, A* finds the geometrically shortest
 * path. In a wide bay or harbor that produces a straight line that
 * cuts diagonally across the chart, ignoring the dredged channel.
 * Channels in ENCs show as DEPARE polygons with deep DRVAL1 values
 * (often 10-20m+); shallow flats around them have shallower DRVAL1.
 *
 * By making deeper water cheaper than shallow/unknown water, A*
 * naturally prefers to stay in the channel even when a straighter
 * route exists. The multipliers are gentle — we still want short
 * routes — but enough to bias toward marked deep water.
 *
 * IMPORTANT: all multipliers must be ≥ 1.0 to keep the haversine
 * heuristic admissible. We never make travel CHEAPER than straight
 * line, only more expensive in less-preferred water.
 *
 *   depth >= 10m → 1.00 (baseline — preferred channel)
 *   depth >= 5m  → 1.10 (moderate — fine for most cruisers)
 *   depth >= 0   → 1.30 (shallow but navigable for shallow draft)
 *   depth == 0   → 5.00 (UNKNOWN_OPEN — strong penalty against marsh
 *                        and unsurveyed water)
 *
 * The 5× UNKNOWN_OPEN penalty (was 1.5×) tightens the route to the
 * marked channel: the Savannah test produced a polyline that drifted
 * into marsh areas where DEPARE didn't cover. With 5× cost, A* will
 * accept up to a 5km marked-channel detour to avoid 1km of marsh.
 * Routes through DEPARE-only water look noticeably tighter to the
 * channel after this change.
 */
function cellCostMultiplier(depth: number): number {
    if (depth >= 10) return 1.0;
    if (depth >= 5) return 1.1;
    if (depth > 0) return 1.3;
    return 5.0; // UNKNOWN_OPEN — strong penalty against unsurveyed water
}

/**
 * 8-neighbor A* on the navigability grid. Distance cost is meter-step
 * × cellCostMultiplier(depth). Heuristic = straight-line meter distance
 * to goal (admissible because all multipliers are ≥ 1.0).
 */
function aStar(
    grid: NavGrid,
    start: { x: number; y: number },
    end: { x: number; y: number },
): { x: number; y: number }[] | null {
    const w = grid.width;
    const h = grid.height;
    const total = w * h;

    const gScore = new Float64Array(total);
    gScore.fill(Infinity);
    const cameFrom = new Int32Array(total);
    cameFrom.fill(-1);

    const startIdx = start.y * w + start.x;
    const endIdx = end.y * w + end.x;

    // Pre-compute mPerLon at grid's mid-latitude. The variation across
    // a 5 NM grid is < 0.1% — using a constant lets us avoid a cos()
    // per neighbor expansion (saves ~30% on a 200×200 grid).
    const midLat = grid.minLat + (grid.height * grid.dLat) / 2;
    const mPerLonGrid = mPerDegLon(midLat);

    gScore[startIdx] = 0;
    const heuristic = (x: number, y: number): number => {
        const dx = (end.x - x) * grid.dLon * mPerLonGrid;
        const dy = (end.y - y) * grid.dLat * M_PER_DEG_LAT;
        return Math.sqrt(dx * dx + dy * dy);
    };

    const open = new MinHeap();
    open.push({ f: heuristic(start.x, start.y), idx: startIdx });

    // 8-neighbor offsets — base step distances in meters get computed
    // once below using the precomputed mPerLonGrid.
    const NEIGHBORS: { dx: number; dy: number }[] = [
        { dx: 1, dy: 0 },
        { dx: -1, dy: 0 },
        { dx: 0, dy: 1 },
        { dx: 0, dy: -1 },
        { dx: 1, dy: 1 },
        { dx: 1, dy: -1 },
        { dx: -1, dy: 1 },
        { dx: -1, dy: -1 },
    ];
    // Pre-compute meter step length for each of the 8 directions
    // (cardinal vs diagonal). All cells have the same dLat/dLon so
    // these are identical for every cell — saves the sqrt-per-edge.
    const stepLengthsM = NEIGHBORS.map(({ dx, dy }) =>
        Math.sqrt((dx * grid.dLon * mPerLonGrid) ** 2 + (dy * grid.dLat * M_PER_DEG_LAT) ** 2),
    );

    while (open.size > 0) {
        const { idx } = open.pop()!;
        if (idx === endIdx) {
            // Reconstruct.
            const path: { x: number; y: number }[] = [];
            let cur = idx;
            while (cur !== -1) {
                path.push({ x: cur % w, y: Math.floor(cur / w) });
                cur = cameFrom[cur];
            }
            return path.reverse();
        }
        const cx = idx % w;
        const cy = Math.floor(idx / w);
        const curG = gScore[idx];

        for (let n = 0; n < NEIGHBORS.length; n++) {
            const { dx, dy } = NEIGHBORS[n];
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const nIdx = ny * w + nx;
            const cellDepth = grid.cells[nIdx];
            if (Number.isNaN(cellDepth)) continue; // blocked

            const tentativeG = curG + stepLengthsM[n] * cellCostMultiplier(cellDepth);
            if (tentativeG < gScore[nIdx]) {
                cameFrom[nIdx] = idx;
                gScore[nIdx] = tentativeG;
                open.push({ f: tentativeG + heuristic(nx, ny), idx: nIdx });
            }
        }
    }
    return null;
}

// ── Line-of-sight smoothing ─────────────────────────────────────────

/**
 * Bresenham's line algorithm. Iterates the cells touched by the line
 * from (x0,y0) to (x1,y1). Used to test whether two cells have an
 * unobstructed straight-line path between them.
 */
function* bresenhamCells(x0: number, y0: number, x1: number, y1: number): Generator<{ x: number; y: number }> {
    const dx = Math.abs(x1 - x0);
    const dy = Math.abs(y1 - y0);
    const sx = x0 < x1 ? 1 : -1;
    const sy = y0 < y1 ? 1 : -1;
    let err = dx - dy;
    let x = x0;
    let y = y0;
    while (true) {
        yield { x, y };
        if (x === x1 && y === y1) break;
        const e2 = 2 * err;
        if (e2 > -dy) {
            err -= dy;
            x += sx;
        }
        if (e2 < dx) {
            err += dx;
            y += sy;
        }
    }
}

function lineOfSightClear(grid: NavGrid, a: { x: number; y: number }, b: { x: number; y: number }): boolean {
    for (const c of bresenhamCells(a.x, a.y, b.x, b.y)) {
        if (!isNavigable(grid, c.x, c.y)) return false;
    }
    return true;
}

/**
 * "String-pulling" smoothing on the A* output path.
 *
 * Why: A* on an 8-neighbor grid with diagonal cost = sqrt(2) finds
 * a cost-optimal path, but the path's GEOMETRY is often stair-shaped
 * (alternating diagonal + cardinal moves) when the goal isn't on a
 * pure diagonal. Two paths can have identical cost but very different
 * shapes — A* picks one arbitrarily.
 *
 * Smoothing fixes this without changing optimality: walk the path,
 * for each anchor point find the furthest subsequent point reachable
 * by a straight line through navigable cells. Replace the intermediate
 * stair-steps with the direct line. Result is much closer to the
 * geometrically-shortest polyline through the navigable region.
 */
function smoothPath(grid: NavGrid, path: { x: number; y: number }[]): { x: number; y: number }[] {
    if (path.length < 3) return path;
    const out: { x: number; y: number }[] = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
        let j = path.length - 1;
        // Binary-search-ish: find the furthest j with a clear line.
        // Linear scan from the back is cheap because clears happen
        // most of the time on long open stretches.
        while (j > i + 1) {
            if (lineOfSightClear(grid, path[i], path[j])) break;
            j--;
        }
        out.push(path[j]);
        i = j;
    }
    return out;
}

// ── Polyline simplification (Douglas-Peucker) ───────────────────────

/**
 * Perpendicular distance from point P to segment AB, in degrees.
 * Used purely for relative comparison; no need for meters.
 */
function perpendicularDistanceDeg(p: [number, number], a: [number, number], b: [number, number]): number {
    const dx = b[0] - a[0];
    const dy = b[1] - a[1];
    if (dx === 0 && dy === 0) {
        return Math.hypot(p[0] - a[0], p[1] - a[1]);
    }
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / (dx * dx + dy * dy)));
    const projX = a[0] + t * dx;
    const projY = a[1] + t * dy;
    return Math.hypot(p[0] - projX, p[1] - projY);
}

function douglasPeucker(points: [number, number][], toleranceDeg: number): [number, number][] {
    if (points.length < 3) return points.slice();
    let maxD = 0;
    let idx = 0;
    for (let i = 1; i < points.length - 1; i++) {
        const d = perpendicularDistanceDeg(points[i], points[0], points[points.length - 1]);
        if (d > maxD) {
            maxD = d;
            idx = i;
        }
    }
    if (maxD > toleranceDeg) {
        const left = douglasPeucker(points.slice(0, idx + 1), toleranceDeg);
        const right = douglasPeucker(points.slice(idx), toleranceDeg);
        return left.slice(0, -1).concat(right);
    }
    return [points[0], points[points.length - 1]];
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Compute an inshore route through one or more ENC cells.
 *
 * The caller is responsible for unioning the layers — for an MVP we
 * accept a single merged set of FeatureCollections. Multi-cell routes
 * just need to concat features into a single InshoreLayers struct
 * before calling this.
 */
export function routeInshore(layers: InshoreLayers, req: RouteRequest): RouteResult | RouteFailure {
    const safetyM = req.safetyM ?? 1.0;
    const resolutionM = req.resolutionM ?? 50;
    const obstructionBufferM = req.obstructionBufferM ?? 30;

    // Build a route bbox = origin/destination envelope expanded
    // generously. The padding has to be SYMMETRIC across both axes —
    // earlier versions padded each axis by its own span, which left a
    // mostly-N-S route with almost no E-W margin. Real-world example:
    // Newport→Brisbane port is 18 km N-S × 1 km E-W as the crow flies,
    // but the actual navigable channel through Moreton Bay sits 5-7 km
    // east of that line. With per-axis padding (~0.02°≈2 km min), the
    // bbox missed the deepwater channel entirely and the origin
    // snapped into a 5-cell marina basin.
    //
    // Now: pad BOTH axes by 25% of the LARGER span (with a 0.05°≈5.5km
    // floor). That gives lateral room equal to the route's longer
    // dimension percentage — enough for harbour approaches that don't
    // run along the great-circle line.
    const minLat = Math.min(req.fromLat, req.toLat);
    const maxLat = Math.max(req.fromLat, req.toLat);
    const minLon = Math.min(req.fromLon, req.toLon);
    const maxLon = Math.max(req.fromLon, req.toLon);
    const maxSpan = Math.max(maxLat - minLat, maxLon - minLon);
    const padLat = Math.max(maxSpan * 0.25, 0.05);
    const padLon = Math.max(maxSpan * 0.25, 0.05);
    const bbox: [number, number, number, number] = [minLon - padLon, minLat - padLat, maxLon + padLon, maxLat + padLat];

    const grid = buildNavGrid(layers, bbox, resolutionM, req.draftM, safetyM, obstructionBufferM);
    if (grid.width === 0 || grid.height === 0) {
        return { error: 'Empty grid', code: 'empty-grid' };
    }

    // Tally grid health for diagnostics — useful when the user
    // reports "no-path" and we need to know whether the grid was
    // mostly land (bad chart for this route) or mostly navigable
    // with a topology issue.
    let blocked = 0;
    for (let i = 0; i < grid.cells.length; i++) {
        if (Number.isNaN(grid.cells[i])) blocked++;
    }
    const debug: RouteDebug = {
        gridSize: { width: grid.width, height: grid.height },
        cellsTotal: grid.cells.length,
        cellsNavigable: grid.cells.length - blocked,
        cellsBlocked: blocked,
    };

    // ── Snap origin ──
    const maxSnapCells = Math.ceil(5_000 / resolutionM);
    const startCell = snapToNavigable(grid, req.fromLat, req.fromLon, maxSnapCells);
    if (!startCell) {
        return {
            error: 'Origin point and surrounding area are not navigable for this draft',
            code: 'origin-on-land',
            debug,
        };
    }
    {
        const [snapLon, snapLat] = gridToLatLon(grid, startCell.x, startCell.y);
        debug.originSnap = {
            x: startCell.x,
            y: startCell.y,
            snappedLat: snapLat,
            snappedLon: snapLon,
            snapDistanceM: haversineM(req.fromLat, req.fromLon, snapLat, snapLon),
        };
    }

    // ── Connected component from origin ──
    // Flood-fills every navigable cell reachable by 8-neighbor moves
    // from the origin. Pre-computed before snapping the destination
    // so we can guarantee the destination snap lands in a cell that
    // A* can actually reach. Without this step, "no-path" failures
    // happen when origin and destination both snap to nearby water
    // that turns out to be different lakes/marshes/ponds.
    const reachable = reachableCellsFrom(grid, startCell);
    let reachableCount = 0;
    for (let i = 0; i < reachable.length; i++) reachableCount += reachable[i];
    debug.cellsReachableFromOrigin = reachableCount;

    // ── Snap destination INTO the origin's connected component ──
    const endCell = snapWithPredicate(grid, req.toLat, req.toLon, maxSnapCells, (idx) => reachable[idx] === 1);
    if (!endCell) {
        // Destination might be on land OR in a disconnected water body.
        // Distinguish for a more useful error:
        const navOnly = snapToNavigable(grid, req.toLat, req.toLon, maxSnapCells);
        if (!navOnly) {
            return {
                error: 'Destination point and surrounding area are not navigable for this draft',
                code: 'destination-on-land',
                debug,
            };
        }
        return {
            error: 'Destination is in a disconnected body of water — no navigable channel reaches it from the origin within the route bbox',
            code: 'destination-disconnected',
            debug,
        };
    }
    {
        const [snapLon, snapLat] = gridToLatLon(grid, endCell.x, endCell.y);
        debug.destinationSnap = {
            x: endCell.x,
            y: endCell.y,
            snappedLat: snapLat,
            snappedLon: snapLon,
            snapDistanceM: haversineM(req.toLat, req.toLon, snapLat, snapLon),
        };
    }

    // A* must succeed because the destination cell is in the origin's
    // reachable component. Defensive: still handle null in case the
    // grid has a path-cost edge case I haven't anticipated.
    const cells = aStar(grid, startCell, endCell);
    if (!cells) {
        return { error: 'A* failed despite reachability flood-fill — should be impossible', code: 'no-path', debug };
    }

    // String-pull the A* output to remove stair-step artifacts.
    const smoothedCells = smoothPath(grid, cells);

    // Convert grid path → polyline (cell centers) → simplified polyline.
    const polylineRaw: [number, number][] = smoothedCells.map((c) => gridToLatLon(grid, c.x, c.y));
    polylineRaw[0] = [req.fromLon, req.fromLat];
    polylineRaw[polylineRaw.length - 1] = [req.toLon, req.toLat];
    // DP tolerance ≈ 1/4 cell. Tighter than the original 1/2 cell —
    // keeps more turn detail in winding channels (Savannah River
    // bends look noticeably closer to the actual channel after this).
    // The bandwidth cost is small (typically 20-40 polyline points
    // for a harbor route).
    const tolDeg = Math.min(grid.dLat, grid.dLon) * 0.25;
    const polyline = douglasPeucker(polylineRaw, tolDeg);

    // Compute total length in NM along the simplified polyline.
    let distM = 0;
    for (let i = 1; i < polyline.length; i++) {
        distM += haversineM(polyline[i - 1][1], polyline[i - 1][0], polyline[i][1], polyline[i][0]);
    }

    return {
        polyline,
        distanceNM: distM / 1852,
        gridSize: { width: grid.width, height: grid.height },
        bbox,
        debug,
    };
}
