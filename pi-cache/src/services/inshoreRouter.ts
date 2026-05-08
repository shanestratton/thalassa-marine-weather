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

export interface RouteResult {
    polyline: [number, number][]; // [lon, lat], lon-first per GeoJSON convention
    distanceNM: number;
    gridSize: { width: number; height: number };
    bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
}

export interface RouteFailure {
    error: string;
    /** Optional sub-reason for UI categorization. */
    code?:
        | 'origin-on-land'
        | 'destination-on-land'
        | 'no-path'
        | 'origin-out-of-bounds'
        | 'destination-out-of-bounds'
        | 'empty-grid';
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
 * BFS outward from (lat, lon) to find the nearest navigable cell.
 * Returns null if nothing within `maxRadiusCells` is open.
 *
 * Used to snap origin/destination — they often geocode to a city
 * center on land, but the user actually departs from a nearby dock.
 */
function snapToNavigable(
    grid: NavGrid,
    lat: number,
    lon: number,
    maxRadiusCells: number,
): { x: number; y: number } | null {
    const start = latLonToGrid(grid, lat, lon);
    if (start.x < 0 || start.y < 0 || start.x >= grid.width || start.y >= grid.height) {
        return null;
    }
    if (isNavigable(grid, start.x, start.y)) return start;

    const visited = new Uint8Array(grid.width * grid.height);
    visited[start.y * grid.width + start.x] = 1;
    let frontier: { x: number; y: number; r: number }[] = [{ ...start, r: 0 }];

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
                    if (isNavigable(grid, nx, ny)) return { x: nx, y: ny };
                    next.push({ x: nx, y: ny, r: r + 1 });
                }
            }
        }
        frontier = next;
    }
    return null;
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
 * 8-neighbor A* on the navigability grid. Distance cost uses the
 * actual meter-distance between cell centers; heuristic uses the
 * straight-line meter distance to goal (admissible).
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

    gScore[startIdx] = 0;
    const heuristic = (x: number, y: number): number => {
        // Cell-distance × resolution heuristic. Slightly underestimates
        // (admissible) — uses Euclidean instead of haversine for speed.
        const dx = (end.x - x) * grid.dLon * mPerDegLon(grid.minLat + y * grid.dLat);
        const dy = (end.y - y) * grid.dLat * M_PER_DEG_LAT;
        return Math.sqrt(dx * dx + dy * dy);
    };

    const open = new MinHeap();
    open.push({ f: heuristic(start.x, start.y), idx: startIdx });

    // 8-neighbor offsets with their per-step costs (in cell units).
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

        for (const { dx, dy } of NEIGHBORS) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (!isNavigable(grid, nx, ny)) continue;

            const stepM = Math.sqrt(
                (dx * grid.dLon * mPerDegLon(grid.minLat + cy * grid.dLat)) ** 2 +
                    (dy * grid.dLat * M_PER_DEG_LAT) ** 2,
            );
            const tentativeG = curG + stepM;
            const nIdx = ny * w + nx;
            if (tentativeG < gScore[nIdx]) {
                cameFrom[nIdx] = idx;
                gScore[nIdx] = tentativeG;
                open.push({ f: tentativeG + heuristic(nx, ny), idx: nIdx });
            }
        }
    }
    return null;
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

    // Build a route bbox = origin/destination envelope expanded by 10%
    // so A* has wiggle room to swing around obstacles.
    const minLat = Math.min(req.fromLat, req.toLat);
    const maxLat = Math.max(req.fromLat, req.toLat);
    const minLon = Math.min(req.fromLon, req.toLon);
    const maxLon = Math.max(req.fromLon, req.toLon);
    const padLat = Math.max((maxLat - minLat) * 0.1, 0.005); // ≥0.005° (~550 m)
    const padLon = Math.max((maxLon - minLon) * 0.1, 0.005);
    const bbox: [number, number, number, number] = [minLon - padLon, minLat - padLat, maxLon + padLon, maxLat + padLat];

    const grid = buildNavGrid(layers, bbox, resolutionM, req.draftM, safetyM, obstructionBufferM);
    if (grid.width === 0 || grid.height === 0) {
        return { error: 'Empty grid', code: 'empty-grid' };
    }

    // Snap origin/destination. Allow up to 5km of search radius —
    // that's enough to reach the river from a city-center geocode.
    const maxSnapCells = Math.ceil(5_000 / resolutionM);
    const startCell = snapToNavigable(grid, req.fromLat, req.fromLon, maxSnapCells);
    if (!startCell) {
        return {
            error: 'Origin point and surrounding area are not navigable for this draft',
            code: 'origin-on-land',
        };
    }
    const endCell = snapToNavigable(grid, req.toLat, req.toLon, maxSnapCells);
    if (!endCell) {
        return {
            error: 'Destination point and surrounding area are not navigable for this draft',
            code: 'destination-on-land',
        };
    }

    const cells = aStar(grid, startCell, endCell);
    if (!cells) {
        return { error: 'No navigable path found between origin and destination', code: 'no-path' };
    }

    // Convert grid path → polyline (cell centers) → simplified polyline.
    const polylineRaw: [number, number][] = cells.map((c) => gridToLatLon(grid, c.x, c.y));
    // Replace first/last with the actual requested points so the line
    // ends at the user's pin, not the snapped grid cell.
    polylineRaw[0] = [req.fromLon, req.fromLat];
    polylineRaw[polylineRaw.length - 1] = [req.toLon, req.toLat];
    // Tolerance ~1/2 cell — keeps channel detail without zigzag noise.
    const tolDeg = Math.min(grid.dLat, grid.dLon) * 0.5;
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
    };
}
