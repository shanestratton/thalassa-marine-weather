/**
 * Inshore Router Engine — A* pathfinding through ENC navigability grids.
 *
 * THIS IS A DEVICE-SIDE COPY of the pure-compute router that previously
 * lived only on the Pi at `pi-cache/src/services/inshoreRouter.ts`. The
 * two files are kept in sync by hand. Don't add Node-specific imports
 * here — this code runs in the iOS Capacitor web bundle.
 *
 * Why this lives on the phone now
 * ────────────────────────────────
 * The Pi-only version forced every inshore route through a 30-40 s
 * HTTP round-trip with a 60 s CapacitorHttp timeout. Multiple parallel
 * callers (useVoyageForm + usePassagePlanner) queued on the single
 * Node event loop and wedged the server. iPhone CPU is several times
 * faster than a Pi 5, the cell GeoJSON is already on the device after
 * the Pi-cache sync, and there's no network step — so we run the same
 * pure function locally and skip every shared failure mode.
 *
 * The Pi keeps `/api/enc/route` as an external/fallback endpoint, but
 * the iOS app no longer uses it on the hot path.
 *
 * What this does
 * ──────────────
 * Takes the converted ENC GeoJSON for one or more cells, rasterizes the
 * vector hazard layers (LNDARE, DEPARE, OBSTRN, WRECKS, UWTROC) into a
 * 2D navigability grid at meter-scale resolution (default 50m), then
 * runs A* with 8-neighbor moves to find the shortest channel-following
 * path between two points. Output is a simplified polyline.
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
    /**
     * Marked fairway polygons (S-57 FAIRWY) — the channel area itself.
     * Cells inside FAIRWY get the baseline routing cost (1.0×) so A*
     * stays inside the marked channel where one exists.
     */
    FAIRWY?: FeatureCollection;
    /**
     * Engineered deep water (S-57 DRGARE — dredged area). Treated the
     * same as FAIRWY for routing purposes: stay inside it when one
     * exists, even if a geometrically shorter path through generic
     * deep water exists outside it.
     */
    DRGARE?: FeatureCollection;
    /**
     * Lateral buoys (S-57 BOYLAT) — port + starboard channel markers.
     * Used by Pass 5 of buildNavGrid to mark cells within
     * MARKER_CHANNEL_RADIUS_M as preferred, so chains of paired
     * markers form an implicit channel corridor for A* to follow.
     * Useful when the chart has no FAIRWY/DRGARE polygons but does
     * have marker points (e.g. the SE QLD regional nav-markers file).
     */
    BOYLAT?: FeatureCollection;
    /**
     * Lateral beacons (S-57 BCNLAT) — fixed-marker analogue of BOYLAT.
     * Same channel-inference treatment.
     */
    BCNLAT?: FeatureCollection;
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
    /**
     * Minimum cells in the origin's connected component before the
     * snap accepts it. Default 25 (≈62,500 m² at 50 m resolution).
     * Lower for tight harbour entrances, raise to demand bigger water.
     */
    minComponentCells?: number;
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
    /**
     * Per-segment caution flag, length `polyline.length - 1`.
     * `cautionMask[i] === true` means the segment polyline[i]→polyline[i+1]
     * crosses one or more CAUTION cells — water that reads too shallow
     * for this vessel in our coarse bathymetry but is not land/hazard.
     * The renderer draws these segments red so the skipper verifies
     * depth locally. Absent on cloud results that predate this field.
     */
    cautionMask?: boolean[];
    distanceNM: number;
    gridSize: { width: number; height: number };
    bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
    debug?: RouteDebug;
    /**
     * Per-phase timing in ms. Useful for finding the bottleneck during
     * speed optimisation. Keys: buildNavGrid, labelComponents,
     * componentSnap, aStar, smoothPath.
     */
    phaseTimings?: Record<string, number>;
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
 * Rogue-triangle detector for SENC-emitted MultiPolygon features.
 *
 * AU oeSENC AREA records use GLU TRIANGLE_FAN primitives where the fan's
 * centre can be a vertex on one side of a concave polygon and the outer
 * vertices walk the OTHER side — producing degenerate "spanning" triangles
 * that cross polygon-internal voids (rivers cutting through mainland,
 * harbours cutting into coastline). Each AREA emits as a MultiPolygon of
 * single-triangle rings, so the rogue spans are visible as triangles with:
 *
 *   - one very long edge (≫ chart-scale norm) and/or
 *   - extreme aspect ratio (slivers).
 *
 * For LNDARE these triangles bleed into water (Rivergate marina was inside
 * one). For DEPARE/DRGARE/FAIRWY they bleed into land — that's the cause of
 * 2026-05-19 Newport→Lytton routing across the Redcliffe peninsula and
 * zig-zagging inland to Lytton: the deep shipping-channel DEPARE polygon's
 * rogue triangle un-blocked an inland Brisbane corridor.
 *
 * Filter heuristic: max edge > 2 km (no legitimate harbour-scale triangle
 * spans that far) OR aspect ratio > 10 (sliver). Polygons failing this drop
 * out of rasterisation entirely; the non-rogue triangles in the same
 * feature still cover the polygon correctly.
 */
const ROGUE_TRI_MAX_EDGE_M = 2_000;
const ROGUE_TRI_ASPECT = 10;
function isRogueTriangleRing(ring: Position[]): boolean {
    if (ring.length < 3) return false;
    const e1 = haversineM(ring[0][1], ring[0][0], ring[1][1], ring[1][0]);
    const e2 = haversineM(ring[1][1], ring[1][0], ring[2][1], ring[2][0]);
    const e3 = haversineM(ring[2][1], ring[2][0], ring[0][1], ring[0][0]);
    const max = Math.max(e1, e2, e3);
    if (max > ROGUE_TRI_MAX_EDGE_M) return true;
    const min = Math.min(e1, e2, e3);
    return min > 0 && max / min > ROGUE_TRI_ASPECT;
}
/**
 * Drop rogue triangle rings from a MultiPolygon. Single-polygon features
 * pass through unchanged (only triangle-soup MultiPolygons have the bug).
 * Returns null when every ring is rogue (rare — usually a feature has both
 * rogue and legitimate triangles).
 */
function filterRogueTriangles(geom: Polygon | MultiPolygon): Polygon | MultiPolygon | null {
    if (geom.type === 'Polygon') {
        // Real outer-ring polygons (multi-vertex) aren't subject to the
        // triangulation pathology. Only flag literal 3-vertex triangles.
        if (geom.coordinates[0].length <= 4 && isRogueTriangleRing(geom.coordinates[0])) return null;
        return geom;
    }
    const kept = geom.coordinates.filter((poly) => {
        const ring = poly[0];
        if (ring.length > 4) return true; // not a triangle — keep
        return !isRogueTriangleRing(ring);
    });
    if (kept.length === 0) return null;
    return { type: 'MultiPolygon', coordinates: kept };
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

/**
 * Scanline polygon rasterizer — visit every grid cell strictly inside
 * a Polygon or MultiPolygon, calling `callback(x, y)` per cell.
 *
 * Why this exists
 * ───────────────
 * Pass 1 (DEPARE) was 97% of buildNavGrid in the wild (36.88 s of
 * 38.27 s on a Newport → Brisbane route, May 2026). The previous
 * implementation did one `pointInGeometry()` per cell × per polygon
 * — for a 50-vertex DEPARE polygon covering a 50×50 cell range that's
 * 125,000 ray-cast vertex ops. A scanline fill instead does ~edges
 * per row + cells per row = ~5,000 ops on the same input. The bigger
 * the polygon (more cells, more vertices), the bigger the win.
 *
 * Algorithm
 * ─────────
 * Classic even-odd scanline fill with hole support:
 *   1. For each scanline row y, sweep ALL ring edges (outer + holes)
 *      and collect x-coordinates where the edge crosses lat(y).
 *   2. Sort the crossings ascending. Even-odd parity — between
 *      [0,1], [2,3], [4,5]… is inside; in between is outside.
 *   3. For each "inside" range, snap to cell columns and call the
 *      visitor for each cell whose centre falls inside.
 *
 * Holes work naturally with parity: a hole edge contributes a
 * crossing that flips the inside flag back to outside for that span.
 *
 * Vertex-exactly-on-scanline handling is the strict-greater test
 * `(yi > lat) !== (yj > lat)` — same convention as the existing
 * pointInRing, so the two paths agree on edge cases (cells whose
 * centre lies on a polygon boundary).
 *
 * Cost vs old per-cell pointInGeometry:
 *   • E vertices, R rows, W cells/row, polygon covers ~R×W cells
 *   • Old: R × W × E ray-cast vertex ops
 *   • New: R × E (edge scan) + R × W (fill) ≈ R × (E + W)
 *   • Speedup ≈ W × E / (E + W). For W=E=50: 25×.
 */
function rasterizePolygonCells(
    grid: { width: number; height: number; minLon: number; minLat: number; dLon: number; dLat: number },
    geom: Polygon | MultiPolygon,
    callback: (x: number, y: number) => void,
): void {
    const polygons: Position[][][] = geom.type === 'Polygon' ? [geom.coordinates] : geom.coordinates;
    const { width, height, minLon, minLat, dLon, dLat } = grid;

    for (const poly of polygons) {
        // Per-polygon row range from the outer ring's lat extent.
        // Inner rings (holes) live entirely inside the outer, so they
        // can't extend the row range.
        const outer = poly[0];
        let minLatPoly = Infinity;
        let maxLatPoly = -Infinity;
        for (let i = 0; i < outer.length; i++) {
            const lat = outer[i][1];
            if (lat < minLatPoly) minLatPoly = lat;
            if (lat > maxLatPoly) maxLatPoly = lat;
        }
        const y0 = Math.max(0, Math.floor((minLatPoly - minLat) / dLat));
        const y1 = Math.min(height - 1, Math.ceil((maxLatPoly - minLat) / dLat));
        if (y1 < y0) continue;

        // Reuse one scratch array per polygon to avoid per-row GC churn.
        const crossings: number[] = [];

        for (let y = y0; y <= y1; y++) {
            const lat = minLat + (y + 0.5) * dLat;
            crossings.length = 0;

            // Collect crossings from outer + holes alike. Even-odd
            // parity below handles hole subtraction without needing
            // an explicit "skip" pass.
            for (const ring of poly) {
                for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
                    const yi = ring[i][1];
                    const yj = ring[j][1];
                    if (yi > lat !== yj > lat) {
                        const xi = ring[i][0];
                        const xj = ring[j][0];
                        const x = ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
                        crossings.push(x);
                    }
                }
            }
            if (crossings.length < 2) continue;
            crossings.sort((a, b) => a - b);

            // Pair-fill: [0..1], [2..3], … are inside spans (even-odd).
            for (let k = 0; k + 1 < crossings.length; k += 2) {
                const lonStart = crossings[k];
                const lonEnd = crossings[k + 1];
                // First column whose cell-centre is ≥ lonStart, last
                // whose centre is ≤ lonEnd. The centre-test is what
                // matches the old per-cell pointInGeometry semantics
                // exactly — we still classify by cell centre, just
                // without paying the ray-cast on each one.
                const xStart = Math.max(0, Math.ceil((lonStart - minLon) / dLon - 0.5));
                const xEnd = Math.min(width - 1, Math.floor((lonEnd - minLon) / dLon - 0.5));
                for (let x = xStart; x <= xEnd; x++) {
                    callback(x, y);
                }
            }
        }
    }
}

// ── Grid ────────────────────────────────────────────────────────────

/**
 * Cell state encoded as a single Float32 value:
 *   NaN   = blocked (land / shallow / obstruction)
 *   ≥0    = navigable, value is depth in meters (0 = unknown but open)
 */
const BLOCKED = Number.NaN;
const UNKNOWN_OPEN = 0;
// CAUTION: soft-blocked. The cell reads too shallow for this vessel in
// our (coarse, public) bathymetry — but it is NOT land and NOT a
// charted hazard. A* MAY route through it, at a steep cost penalty, so
// it only does when there is no real-water path. Segments of the
// output that cross CAUTION cells are flagged in `cautionMask` so the
// renderer can draw them red — "our data says shallow here, skipper
// verifies". This is what lets canal estates (Newport) and shallow
// tidal approaches route end-to-end instead of snapping kilometres to
// the nearest surveyed-deep water. Negative sentinel so it's distinct
// from BLOCKED (NaN), UNKNOWN_OPEN (0), and any real depth (>= 0).
const CAUTION = -1;

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
    /**
     * Per-cell channel preference flag (1 = inside FAIRWY or DRGARE,
     * 0 = outside). When set, A* uses the baseline 1.0× cost regardless
     * of depth — this is how the router "stays in the marked channel"
     * when one exists, even if a geometrically shorter path through
     * generic deep water is available.
     */
    preferred: Uint8Array;
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
 * Process-wide cache for buildNavGrid output. Keyed by the inputs that
 * deterministically produce a grid. Grid build is the routing pipeline's
 * dominant cost (20+ s for the Brisbane test case at 50 m resolution) so
 * even simple memoisation lets repeated routes against the same cell
 * pack skip everything except A* (which is ~50 ms).
 *
 * Cache key composition:
 *   - bbox, resolutionM, draftM, safetyM, obstructionBufferM (route params)
 *   - feature-counts-per-layer signature (cheap fingerprint of the merged
 *     layer data; sufficient given the layer data is deterministic upstream
 *     from cell-pack + Supabase nav markers + iOS-side pairing)
 *
 * The signature is best-effort — distinct layer payloads with matching
 * feature counts would collide. Fine for now; tighten with a content hash
 * if we ever hit it.
 *
 * Hard size cap of 5 grids (≈1 MB at 200×400×4 bytes) to bound memory.
 */
interface CachedNavGrid {
    grid: NavGrid;
    ts: number;
}
const navGridCache = new Map<string, CachedNavGrid>();
const NAV_GRID_CACHE_MAX = 5;

function buildNavGridCached(
    layers: InshoreLayers,
    bbox: [number, number, number, number],
    resolutionM: number,
    draftM: number,
    safetyM: number,
    obstructionBufferM: number,
): { grid: NavGrid; cacheHit: boolean } {
    const sig = [
        layers.LNDARE?.features.length ?? 0,
        layers.DEPARE?.features.length ?? 0,
        layers.OBSTRN?.features.length ?? 0,
        layers.WRECKS?.features.length ?? 0,
        layers.UWTROC?.features.length ?? 0,
        layers.FAIRWY?.features.length ?? 0,
        layers.DRGARE?.features.length ?? 0,
        layers.BOYLAT?.features.length ?? 0,
        layers.BCNLAT?.features.length ?? 0,
    ].join(',');
    const key = `${bbox.join(',')}_${resolutionM}_${draftM}_${safetyM}_${obstructionBufferM}_${sig}`;
    const cached = navGridCache.get(key);
    if (cached) {
        cached.ts = Date.now();
        return { grid: cached.grid, cacheHit: true };
    }
    const grid = buildNavGrid(layers, bbox, resolutionM, draftM, safetyM, obstructionBufferM);
    if (navGridCache.size >= NAV_GRID_CACHE_MAX) {
        let oldestKey: string | null = null;
        let oldestTs = Infinity;
        for (const [k, v] of navGridCache) {
            if (v.ts < oldestTs) {
                oldestTs = v.ts;
                oldestKey = k;
            }
        }
        if (oldestKey) navGridCache.delete(oldestKey);
    }
    navGridCache.set(key, { grid, ts: Date.now() });
    return { grid, cacheHit: false };
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
    // Per-pass timing — a single Newport→Brisbane build was clocked at
    // 37.8 s and accounted for 97% of the route compute. Without per-
    // pass numbers we can't tell which polygon scanner is the
    // bottleneck (DEPARE has 1500+ polygons but small grids; LNDARE has
    // 200 polygons but huge bboxes; OBSTRN is 500+ points; FAIRWY is
    // moderate). The summary at the bottom of this function logs the
    // breakdown so the optimisation target is data-driven.
    const buildT0 = Date.now();
    const passTimings: Record<string, number> = {};
    const featureCounts: Record<string, number> = {};
    const markPass = (label: string, start: number, featureCount: number): void => {
        passTimings[label] = Date.now() - start;
        featureCounts[label] = featureCount;
    };

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
    const preferred = new Uint8Array(width * height);
    // Per-cell "protected" flag: 1 = DEPARE came from an authoritative
    // engineered-water source (marina, basin, dock, canal) and the
    // LNDARE pass MUST NOT re-block this cell, even if a chunky
    // GMRT-derived LNDARE polygon covers it. Generic OSM `natural=water`
    // and bathymetry-derived DEPARE do NOT get this protection — they
    // can be erroneously placed and LNDARE should beat them.
    const protectedCells = new Uint8Array(width * height);
    // Per-cell "hard blocked" flag: 1 = blocked by LNDARE (land) or a
    // point obstruction (OBSTRN / WRECKS / UWTROC). A cell merely
    // blocked by a shallow DEPARE band has hardBlocked = 0. Pass 4
    // (FAIRWY) and Pass 5 (paired channel midpoints) are allowed to
    // RESCUE a shallow-blocked cell back to navigable — a marked
    // channel is navigable water by definition — but must never
    // override a hard-blocked cell (actual land / charted hazard).
    const hardBlocked = new Uint8Array(width * height);
    const grid: NavGrid = { width, height, minLon, minLat, dLon, dLat, cells, preferred };

    // Capture grid-build setup time separately. Anything north of a
    // few ms here points to wasted re-work (we already pay for this on
    // each call — buildNavGridCached is a separate concern).
    markPass('setup', buildT0, width * height);

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

    // ── Pass 1: DEPARE — assign depth values + flag authoritative ───
    // Done first so a subsequent LNDARE pass overrides shallow water
    // with land-block on cells where both apply (rare but possible).
    //
    // A DEPARE feature whose source is "authoritative engineered
    // water" (OSM marina basin, dock, canal, landuse=basin) also sets
    // `protectedCells[idx] = 1`. The LNDARE pass below skips those
    // cells — they're real water that the boat needs even if a chunky
    // bathymetry-derived LNDARE polygon happens to cover them. Generic
    // `natural=water` and plain bathymetry-derived DEPARE bands do NOT
    // get protection; if LNDARE says it's land, they get blocked.
    const isAuthoritativeDepare = (props: Record<string, unknown> | null): boolean => {
        if (!props) return false;
        const leisure = props['leisure'];
        // `landuse=basin` and `water=basin` REMOVED from the authoritative
        // whitelist (2026-05-14). Suburban OSM tags inland stormwater
        // retention ponds and drainage basins with these tags; on the
        // Redcliffe Peninsula (Newport→Brisbane bbox) there are dozens
        // of them, each unblocking a phantom 3-4 m DEPARE corridor across
        // land. Real marina basins are tagged `leisure=marina` (kept).
        // Real navigable canals are tagged `waterway=canal` (also kept).
        const waterway = props['waterway'];
        const water = props['water'];
        const harbour = props['harbour'];
        return (
            leisure === 'marina' ||
            waterway === 'dock' ||
            waterway === 'canal' ||
            waterway === 'fairway' ||
            // `water=*` subtags for marina contexts (Newport canals use
            // these for the side arms branching off the main basin)
            water === 'canal' ||
            water === 'harbour' ||
            water === 'marina' ||
            water === 'dock' ||
            harbour === 'yes'
        );
    };
    const depare = layers.DEPARE?.features ?? [];
    const tPassDepare = Date.now();
    for (const f of depare) {
        const g = f.geometry;
        if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') continue;
        const props = f.properties as Record<string, unknown> | null;
        const drval1 = props?.['DRVAL1'];
        // S-57 DRVAL1 is positive depth in meters.
        const drval1Num = typeof drval1 === 'number' ? drval1 : null;
        if (drval1Num == null) continue; // no depth → nothing to do
        // Authoritative water means "trust this over LNDARE". REVERTED
        // 2026-05-19: S-57 chart DEPARE polygons in AU oeSENC have outer
        // rings that bleed slightly onto land in their tessellation. The
        // diagnostic on Newport→Lytton showed LNDARE skipped 1.41M cell-
        // hits because DEPARE protected them, vs only 26k cells actually
        // blocked. Rogue-triangle filtering on DEPARE wasn't enough — most
        // bleed triangles are small/square (not slivers).
        //
        // Returning to the OSM-tag-only authoritative gate. The trade-off:
        // ENC river destinations buried in LNDARE-bleed (Rivergate marina
        // was inside an LNDARE triangle) won't reach via this path. The
        // endpoint carve handles the destination itself; if no chart-
        // authoritative DEPARE/DRGARE/FAIRWY connects the carve to open
        // water, the route fails with destination-disconnected. That's
        // an honest failure mode — better than crossing visible land.
        const authoritative = isAuthoritativeDepare(props);
        const shallow = drval1Num < draftM + safetyM;

        // Scanline-rasterize the polygon and apply cell updates inside
        // the per-cell callback. ~25× faster than the old "per cell,
        // pointInGeometry" loop on real DEPARE shapes (50+ vertex
        // bathymetry contours covering 50×50+ cell ranges).
        rasterizePolygonCells(grid, g, (x, y) => {
            const idx = y * width + x;

            if (shallow) {
                // Shallow water — mark CAUTION (soft-block) UNLESS an
                // authoritative engineered-water DEPARE already
                // claimed this cell. Coarse public bathymetry (30 m
                // AusBathyTopo) can't resolve dredged marina basins /
                // canals or shallow tidal approaches: it reads them
                // at the shallow surrounding-terrain depth. CAUTION
                // keeps the cell *navigable* (A* may route through it
                // at a steep cost, the renderer draws it red) instead
                // of hard-BLOCKED — so canal estates and shallow
                // approaches route end-to-end with an honest "verify
                // depth" flag rather than the route snapping
                // kilometres to the nearest surveyed-deep water.
                // protectedCells guard keeps the outcome order-
                // independent: once authoritative water claims a
                // cell, no shallow band downgrades it.
                if (protectedCells[idx] !== 1) {
                    cells[idx] = CAUTION;
                }
            } else {
                // Deep enough for this vessel.
                const prior = cells[idx];
                if (Number.isNaN(prior)) {
                    // Cell hard-blocked by an earlier pass — only an
                    // authoritative DEPARE un-blocks it.
                    if (authoritative) cells[idx] = drval1Num;
                } else if (prior === UNKNOWN_OPEN || prior === CAUTION || drval1Num < prior) {
                    // Upgrade an unknown / caution cell to real depth,
                    // or track the shallowest known real depth.
                    cells[idx] = drval1Num;
                }
                if (authoritative) protectedCells[idx] = 1;
            }
        });
    }

    markPass('pass1-DEPARE', tPassDepare, depare.length);

    // ── Pass 2: LNDARE — block land cells, except authoritative water ─
    // Earlier conflict rule was "DEPARE > 0 beats LNDARE", which let
    // ANY DEPARE feature override LNDARE — including bathymetry-derived
    // deep bands that happened to cover the actual peninsula, and
    // misclassified `natural=water` OSM polygons. The route then
    // crossed straight over land (Scarborough peninsula bug).
    //
    // New rule: LNDARE blocks cells unconditionally UNLESS the DEPARE
    // pass flagged them `protectedCells[idx] = 1`. That flag is only
    // set for OSM features tagged `leisure=marina`, `landuse=basin`,
    // `waterway=dock`, or `waterway=canal` — authoritative engineered
    // water that we trust over any chunky LNDARE. Other DEPARE sources
    // (plain `natural=water`, plain bathymetry contours) lose to LNDARE
    // on overlap, which is the safer "stay in the wet" default the
    // user asked for.
    //
    // Trade-off: marinas/canals stay reachable; misclassified inland
    // water polygons stop creating phantom navigable land. The right
    // long-term fix is OSM coastline as LNDARE so the land polygons
    // are accurate sub-10 m instead of 60 m-pixel chunky.
    const lndare = layers.LNDARE?.features ?? [];
    const tPassLndare = Date.now();
    for (const f of lndare) {
        const g = f.geometry;
        if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') continue;
        // NO rogue filter on LNDARE: real chart-source LNDARE for narrow
        // land features (Redcliffe peninsula, river banks) naturally has
        // long-edge fan triangles that LOOK rogue but are correctly
        // covering the elongated polygon. Filtering them leaves big gaps
        // (peninsula's rcid 4500 had 49% of its 3146 triangles flagged as
        // rogue by edge/aspect heuristics) and A* threads through. Better
        // to over-block (LNDARE bleeds across rivers → some water shows
        // as land) and rely on S-57 DEPARE authoritative override in
        // pass 1 to un-block actual surveyed water.
        rasterizePolygonCells(grid, g, (x, y) => {
            const idx = y * width + x;
            if (!protectedCells[idx]) {
                cells[idx] = BLOCKED;
                hardBlocked[idx] = 1;
            }
        });
    }

    markPass('pass2-LNDARE', tPassLndare, lndare.length);
    // DIAG-LANDPROBE (temp 2026-05-19): sample known-land + known-water
    // points so we can read the engine's actual classification.
    const diagProbe = (lat: number, lon: number, label: string) => {
        const px = Math.floor((lon - minLon) / dLon);
        const py = Math.floor((lat - minLat) / dLat);
        if (px < 0 || py < 0 || px >= width || py >= height) {
            console.warn(`[PROBE] ${label} (${lat},${lon}): OUT OF GRID`);
            return;
        }
        const idx = py * width + px;
        const v = cells[idx];
        const state = Number.isNaN(v)
            ? 'BLOCKED'
            : v < 0
              ? 'CAUTION'
              : v === 0
                ? 'UNKNOWN_OPEN'
                : 'depth=' + v.toFixed(1);
        const prot = protectedCells[idx] === 1 ? ' [protected]' : '';
        console.warn(`[PROBE] ${label} (${lat},${lon}) grid[${px},${py}]: ${state}${prot}`);
    };
    diagProbe(-27.25, 153.105, 'peninsula-middle (should be LAND)');
    diagProbe(-27.21, 153.13, 'peninsula-east (should be LAND)');
    diagProbe(-27.3, 153.13, 'bramble-bay (should be water)');
    diagProbe(-27.33, 153.13, 'pt2-coast (should be water)');
    // DIAG-BRESENHAM (temp 2026-05-19): walk a line from Newport to the
    // reported pt2 (-27.33, 153.13) and count blocked cells. The smoother
    // would only emit this as a single segment if EVERY cell on this line
    // were navigable. If we see blocked cells here, the smoother is
    // bypassing lineOfSightClear somehow.
    const probeBresenham = (fromLat: number, fromLon: number, toLat: number, toLon: number, label: string) => {
        const fx = Math.floor((fromLon - minLon) / dLon);
        const fy = Math.floor((fromLat - minLat) / dLat);
        const tx = Math.floor((toLon - minLon) / dLon);
        const ty = Math.floor((toLat - minLat) / dLat);
        let blocked = 0;
        let cautionN = 0;
        let unknown = 0;
        let depth = 0;
        let total = 0;
        const samples: string[] = [];
        for (const c of bresenhamCells(fx, fy, tx, ty)) {
            total++;
            if (c.x < 0 || c.y < 0 || c.x >= width || c.y >= height) continue;
            const v = cells[c.y * width + c.x];
            if (Number.isNaN(v)) {
                blocked++;
                if (samples.length < 4) samples.push(`[${c.x},${c.y}]BLOCKED`);
            } else if (v < 0) cautionN++;
            else if (v === 0) unknown++;
            else depth++;
        }
        console.warn(
            `[BRESENHAM ${label}] (${fromLat.toFixed(3)},${fromLon.toFixed(3)})→(${toLat.toFixed(3)},${toLon.toFixed(3)}) total=${total} BLOCKED=${blocked} caution=${cautionN} unknown=${unknown} depth=${depth} ${samples.join(' ')}`,
        );
    };
    probeBresenham(-27.2135, 153.0875, -27.3335, 153.1335, 'Newport→pt2');

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
                    hardBlocked[y * width + x] = 1;
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
            rasterizePolygonCells(grid, f.geometry as Polygon | MultiPolygon, (x, y) => {
                const idx = y * width + x;
                cells[idx] = BLOCKED;
                hardBlocked[idx] = 1;
            });
        }
    };

    const tPassPoints = Date.now();
    const obstrnFeatures = layers.OBSTRN?.features ?? [];
    const wrecksFeatures = layers.WRECKS?.features ?? [];
    const uwtrocFeatures = layers.UWTROC?.features ?? [];
    for (const f of obstrnFeatures) handlePointFeature(f);
    for (const f of wrecksFeatures) handlePointFeature(f);
    for (const f of uwtrocFeatures) handlePointFeature(f);
    markPass('pass3-points', tPassPoints, obstrnFeatures.length + wrecksFeatures.length + uwtrocFeatures.length);

    // ── Pass 4: FAIRWY + DRGARE — mark preferred channel cells ─────
    // We don't change the navigability of these cells (a navigable cell
    // stays navigable, a blocked cell stays blocked — fairways CAN
    // overlap with shallow flats at low tide, and the chart's DEPARE
    // pass is the authoritative source for "is there enough depth").
    // We just flag cells that fall inside a marked channel so the A*
    // cost function can prefer them.
    const markChannelPreference = (f: Feature): void => {
        if (!f.geometry || (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon')) return;
        // Filter rogue triangles same as DEPARE/LNDARE — a DRGARE rogue
        // span (e.g. across the Pinkenba river bend) would otherwise rescue
        // an inland Brisbane corridor as preferred channel.
        const filtered = filterRogueTriangles(f.geometry as Polygon | MultiPolygon);
        if (!filtered) return;
        const g = filtered;
        const rescueDepth = Math.max(draftM + safetyM, 5.0);
        // S-57 charted features carry an `acronym` property (e.g. 'DRGARE',
        // 'FAIRWY') set by senc-extractor's geojsonEmitter. OSM-derived
        // mock channels don't. A chart-authoritative dredged area or
        // fairway is *surveyed navigable water* — when it overlaps an
        // LNDARE polygon (which happens on real ENC charts because the
        // SENC's GLU-tessellated LNDARE primitives can span across
        // river concavities), the DRGARE/FAIRWY is the truth.
        //
        // This is the inverse of the 2026-05-14 Scarborough peninsula
        // fix: that fix locked LNDARE down so bathymetry-derived DEPARE
        // couldn't unblock real land. Chart DRGARE/FAIRWY are a different
        // signal class — they exist because a harbour authority surveyed
        // and dredged the channel, so they get the keys back. OSM-derived
        // channel features (no `acronym`) still respect LNDARE's hard-block.
        const props = f.properties as Record<string, unknown> | null;
        const isChartAuthoritative = typeof props?.acronym === 'string';
        rasterizePolygonCells(grid, g, (x, y) => {
            const idx = y * width + x;
            preferred[idx] = 1;
            const blockedOrShallow = Number.isNaN(cells[idx]) || cells[idx] < 0;
            if (!blockedOrShallow) return;
            // Chart DRGARE/FAIRWY rescues hard-blocked cells too —
            // LNDARE polygons on ENC charts span river concavities, and
            // the dredged-channel polygon is the authoritative "this is
            // navigable" overlay. OSM channels still respect hardBlocked.
            if (hardBlocked[idx] === 1 && !isChartAuthoritative) return;
            cells[idx] = rescueDepth;
        });
    };
    const tPassFairwy = Date.now();
    const fairwyFeatures = layers.FAIRWY?.features ?? [];
    const drgareFeatures = layers.DRGARE?.features ?? [];
    for (const f of fairwyFeatures) markChannelPreference(f);
    for (const f of drgareFeatures) markChannelPreference(f);
    markPass('pass4-FAIRWY+DRGARE', tPassFairwy, fairwyFeatures.length + drgareFeatures.length);

    // ── Pass 5: Lateral markers → preferred-cell radius ─────────────
    // When the iOS side pairs port+starboard markers and emits the
    // midpoint as a BOYLAT Point with `_pairDistanceM` on it, we use
    // that distance to size the preferred radius — capping it at
    // half the pair distance so the preferred zone never extends
    // past either marker. Without this cap a 80 m radius around a
    // midpoint of a narrow (e.g. 100 m) pair leaks 30 m past the
    // marker on the shore side, and A* threads the route on the
    // wrong side of the green marker. User flagged this at the
    // Scarborough peninsula bend on 2026-05-12.
    //
    // For markers without `_pairDistanceM` (raw beacons / buoys
    // outside the paired pipeline), we fall back to the default
    // 80 m radius — those are best-effort hints, not pair midpoints.
    const MARKER_CHANNEL_RADIUS_DEFAULT_M = 80;
    const MARKER_CHANNEL_RADIUS_MIN_M = 15;
    const MARKER_CHANNEL_PAIR_MARGIN_M = 5;
    const markMarkerRadius = (f: Feature): void => {
        if (!f.geometry || f.geometry.type !== 'Point') return;
        const [lon, lat] = (f.geometry as Point).coordinates;

        const pairDistM = (f.properties as { _pairDistanceM?: number } | null)?._pairDistanceM;

        // Only the iOS-paired channel midpoints (which carry
        // `_pairDistanceM`) generate preferred-cell zones. Pack-level
        // BOYLAT/BCNLAT features (from OSM seamarks via the pack
        // generator) get NO preferred zone. Why:
        //
        //   • A paired midpoint really IS a channel — the boat passes
        //     between two markers, so attracting A* to the area
        //     between them is correct.
        //   • A pack-level OSM beacon_lateral is a single point on a
        //     real chart. It might be a paired channel marker OR a
        //     SOLO reef-edge marker (Scarborough Reef beacon is the
        //     canonical example, confirmed via Navionics 2026-05-13).
        //     If it's solo, the 80 m preferred radius around the
        //     marker becomes an *attractor* drawing A* right onto the
        //     reef instead of pushing it seaward. We can't tell from
        //     the pack data alone which it is, so we treat ALL pack-
        //     level laterals as no-op rather than as attractors.
        //
        // Cost of being wrong: if a real channel pair exists in the
        // pack data without an iOS-side pairing record, A* won't see
        // it as preferred. That's fine — A* still routes through deep
        // water, just without an explicit channel bias.
        if (typeof pairDistM !== 'number' || pairDistM <= 0) {
            return;
        }
        const radius = Math.max(
            MARKER_CHANNEL_RADIUS_MIN_M,
            Math.min(MARKER_CHANNEL_RADIUS_DEFAULT_M, pairDistM / 2 - MARKER_CHANNEL_PAIR_MARGIN_M),
        );

        const dLatBuf = radius / M_PER_DEG_LAT;
        const dLonBuf = radius / mPerLon;
        const x0 = Math.max(0, Math.floor((lon - dLonBuf - minLon) / dLon));
        const x1 = Math.min(width - 1, Math.ceil((lon + dLonBuf - minLon) / dLon));
        const y0 = Math.max(0, Math.floor((lat - dLatBuf - minLat) / dLat));
        const y1 = Math.min(height - 1, Math.ceil((lat + dLatBuf - minLat) / dLat));
        for (let y = y0; y <= y1; y++) {
            const cellLat = minLat + (y + 0.5) * dLat;
            for (let x = x0; x <= x1; x++) {
                const cellLon = minLon + (x + 0.5) * dLon;
                const dM = haversineM(cellLat, cellLon, lat, lon);
                if (dM <= radius) {
                    const idx = y * width + x;
                    preferred[idx] = 1;
                    // Rescue shallow-blocked cells inside a paired
                    // channel midpoint zone — same rationale as the
                    // FAIRWY pass: the boat passes between the two
                    // markers, so this is navigable channel water even
                    // where coarse bathymetry reads it shallow. Never
                    // override a hard-blocked cell (LNDARE / hazard).
                    if ((Number.isNaN(cells[idx]) || cells[idx] < 0) && hardBlocked[idx] !== 1) {
                        // Rescue a hard-blocked OR caution-marked cell to
                        // real navigable depth — the marked channel is
                        // authoritative over both a shallow bathymetry
                        // reading and a coastline-buffer over-reach.
                        cells[idx] = Math.max(draftM + safetyM, 5.0);
                    }
                }
            }
        }
    };
    const tPassMarkers = Date.now();
    const boylatFeatures = layers.BOYLAT?.features ?? [];
    const bcnlatFeatures = layers.BCNLAT?.features ?? [];
    for (const f of boylatFeatures) markMarkerRadius(f);
    for (const f of bcnlatFeatures) markMarkerRadius(f);
    markPass('pass5-markers', tPassMarkers, boylatFeatures.length + bcnlatFeatures.length);

    // Per-pass breakdown — surfaces which polygon scanner is the hot
    // path. Format: pass=Nms(F features) so the eye can pair time
    // against feature count at a glance.
    const buildTotal = Date.now() - buildT0;
    const breakdown = Object.entries(passTimings)
        .map(([k, v]) => `${k}=${v}ms(${featureCounts[k]}f)`)
        .join(' ');
    console.warn(
        `[inshoreEngine] buildNavGrid total=${buildTotal}ms grid=${width}x${height}(${(width * height).toLocaleString()}cells) — ${breakdown}`,
    );

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
 * Label every connected component of navigable cells in the grid.
 *
 * Returns `labels` (Int32Array, -1 for blocked cells, 0+ for component
 * ID) and `sizes` (Map of label → cell count).
 *
 * Why this exists: at coarse bathymetry resolutions (GMRT 60m, GEBCO
 * 460m) a coastal origin point often snaps into a tiny 2-5 cell pocket
 * — a marina basin, mud-flat puddle, or single deeper pixel — that's
 * surrounded by shallow blocked cells and disconnected from the main
 * bay. Without component awareness the snap finds the closest navigable
 * cell, which is exactly that wrong pocket. With it we can demand the
 * snap target sits in a sizeable water body before accepting it.
 *
 * One pass through the grid, O(cells). Cheap compared to grid build.
 */
function labelConnectedComponents(grid: NavGrid): { labels: Int32Array; sizes: Map<number, number> } {
    const total = grid.width * grid.height;
    const labels = new Int32Array(total);
    labels.fill(-1);
    const sizes = new Map<number, number>();
    const queue = new Int32Array(total);
    let nextLabel = 0;

    for (let seed = 0; seed < total; seed++) {
        if (labels[seed] !== -1) continue;
        if (Number.isNaN(grid.cells[seed])) continue;

        const labelId = nextLabel++;
        labels[seed] = labelId;
        queue[0] = seed;
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
                    if (labels[nIdx] !== -1) continue;
                    if (Number.isNaN(grid.cells[nIdx])) continue;
                    labels[nIdx] = labelId;
                    queue[qTail++] = nIdx;
                }
            }
        }
        sizes.set(labelId, qTail);
    }
    return { labels, sizes };
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
 *   depth == 0   → 50.0 (UNKNOWN_OPEN — strong penalty against marsh,
 *                        sliver gaps, and unsurveyed water)
 *
 * UNKNOWN_OPEN was 5× originally (compared to 1.5× before that). The
 * 5× value still wasn't enough at public-data resolutions: ogr2ogr's
 * polygon simplifier leaves narrow slivers between adjacent simplified
 * DEPARE polygons, and a 5× penalty was small enough that A* threaded
 * routes through them — producing paths that visually appeared to
 * cross "marked-shallow" polygons even though the underlying grid
 * cells were technically in the gap between bands. Bumped to 50× so
 * A* will detour up to 50 cells through marked-deep water before
 * accepting a single unmarked cell.
 */
function cellCostMultiplier(depth: number, preferred: boolean): number {
    // Cells inside a marked fairway / dredged area always get the
    // baseline cost regardless of depth band — that's how we get
    // A* to follow the channel instead of cutting across deeper
    // open water nearby.
    if (preferred) return 1.0;

    // Outside marked channels, prefer deeper water but allow shallow
    // navigable cells. The penalties are stiffer than before (was
    // 1.1/1.3/5.0 → now 1.5/2.5/50) because we now have FAIRWY data
    // for the "right" path and want to push A* into it. A 1.5×
    // penalty for "deep but unmarked" water means a 50% detour
    // through fairway beats a straight shot through unmarked deep
    // water — about right when the chart actually has fairways.
    // Steep cost gradient between "marked channel" (FAIRWY) and "just
    // navigable deep water" so A* commits to channels even when a
    // ~25% shorter straight-line route exists through generic
    // bathymetry-deep cells. Earlier 1.2× for deep water meant a
    // direct 11 NM line at 1.2× (13.2 NM-equiv) beat the 15 NM
    // channel-following path at 1.0× (15 NM-equiv); the route cut
    // straight across the Brisbane River shipping channel instead
    // of riding it.
    //
    // With deep = 2.5×, the direct line becomes 11 × 2.5 = 27.5
    // NM-equiv vs channel at 15 NM-equiv — A* now prefers the
    // channel route decisively. The boat is then routed through
    // marked safe water rather than open bay.
    //
    // 2026-05-12: bumped deep from 2.5 → 5.0. Coverage analysis
    // showed that even with 2.5× deep cost, the channel was only
    // winning when FAIRWY coverage was > 70% along the path. The
    // synthetic FAIRWY ribbon at 30 m half-width left gaps where
    // cell-centre sampling missed the polygon, dropping effective
    // coverage to ~50% — at which point direct-line through deep
    // beat the channel detour. Pairing this with the iOS-side
    // ribbon widening (30 → 100 m half-width) plus a stiffer 5×
    // gradient makes the channel route win even at 60% coverage.
    if (depth >= 10) return 5.0;
    if (depth >= 5) return 6.0;
    // depth ∈ (0, 5) — shallow but passes the draft+safety cutoff.
    // Tried 18× on 2026-05-15 to push A* harder toward deep water at
    // Brisbane (user: "we will need to get out and push"). Combined
    // with the trailing-window PCA change, the result regressed
    // Newport — user "that broke the newport end". Back to 8×. The
    // Brisbane "favours shallow over deep" issue is more likely a
    // data-coverage problem (the 3 m bathymetry around the river
    // mouth is what the 30 m AusBathyTopo actually reads; the deep
    // shipping channel needs FAIRWY coverage to win) than a cost-
    // tuning one — pushing cost further amplifies routing artefacts.
    if (depth > 0) return 8.0;
    // CAUTION (depth < 0, the -1 sentinel) — soft-blocked: too shallow
    // for this vessel per our coarse bathymetry, but not land/hazard.
    // 40× — A* strongly prefers real water (5× the worst real-water
    // cost of 8×, 8× the typical deep-water 5×), but won't take an
    // insane detour to avoid caution. History:
    //   • 400× was the first cut and sent A* on ~10 km zigzag legs
    //     to dodge a single caution cell.
    //   • 25× routed Brisbane fine end-to-end but A* would accept a
    //     caution stretch when an "obvious" slightly-longer deep
    //     alternative existed.
    //   • 80× — tried 2026-05-15 to push A* harder toward deep
    //     alternatives at Brisbane. It made things WORSE — the
    //     bigger detour budget combined with the CLUSTER_LINK_M=900
    //     regression produced a huge westward zigzag through caution
    //     territory ("more red" overall). The 40× balance was right;
    //     the "favouring shallow over deep" at Brisbane is most
    //     likely a DATA limit — the "deep alternative" the user can
    //     see on screen reads as caution in our 30 m bathymetry too,
    //     so no cost tune fixes it. Needs better depth data.
    //   • Reverted to 40×.
    if (depth < 0) return 40.0;
    // UNKNOWN_OPEN — 500× (see earlier rationale). With non-preferred
    // bathymetry now at 2.5-5.0× the relative gap to unknown is
    // smaller (100× → 200×), still decisive.
    return 500.0;
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

            const cellPreferred = grid.preferred[nIdx] === 1;
            const tentativeG = curG + stepLengthsM[n] * cellCostMultiplier(cellDepth, cellPreferred);
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

/**
 * Cost multiplier at a specific grid cell. Thin wrapper over
 * cellCostMultiplier that reads depth + preferred straight from
 * the grid arrays.
 */
function cellCostAt(grid: NavGrid, x: number, y: number): number {
    const idx = y * grid.width + x;
    return cellCostMultiplier(grid.cells[idx], grid.preferred[idx] === 1);
}

function lineOfSightClear(grid: NavGrid, a: { x: number; y: number }, b: { x: number; y: number }): boolean {
    // Cost-aware line of sight. The smoothed straight line must not
    // route through water STRICTLY WORSE than either endpoint already
    // uses. This is what keeps smoothPath from collapsing a channel
    // traversal into a corner-cutting diagonal: inside a FAIRWY both
    // endpoints are cost 1.0, so the line can only "see through" other
    // 1.0 cells — it has to stay in the channel, threading the marker
    // pairs A* routed it through. In open water both endpoints are
    // 5.0, so the line is free to cut across other 5.0 cells.
    //
    // Before this was cost-blind (just `isNavigable`), which let
    // smoothPath straight-line from a channel's entrance to its exit
    // because the open water ALONGSIDE the channel is technically
    // navigable — producing routes that visibly ignored the "stay
    // between the markers" rule (the Brisbane River bug, 2026-05-14).
    //
    // Also: never smooth ACROSS the CAUTION boundary. A straight line
    // is clear only if every cell shares the anchor's caution-state.
    // Without this, smoothPath strings a long diagonal from real water
    // straight THROUGH shallow caution water — the cost-budget gate
    // doesn't stop it because budget = max(endpoints), and a caution
    // endpoint (400×) lifts the bar high enough for the 400× caution
    // cells in between to pass. Result: long diagonals cutting corners
    // across shallow flats, and mostly-deep segments wrongly flagged
    // red. Splitting at the boundary keeps red runs and normal runs as
    // cleanly-bounded segments that follow the real cell path.
    const aCaution = grid.cells[a.y * grid.width + a.x] < 0;
    const budget = Math.max(cellCostAt(grid, a.x, a.y), cellCostAt(grid, b.x, b.y));
    for (const c of bresenhamCells(a.x, a.y, b.x, b.y)) {
        if (!isNavigable(grid, c.x, c.y)) return false;
        if (grid.cells[c.y * grid.width + c.x] < 0 !== aCaution) return false;
        if (cellCostAt(grid, c.x, c.y) > budget) return false;
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

    // Per-phase timing — we have no idea where the 25-65 s on iOS is going
    // without measuring. Once we have numbers we can stop guessing and
    // attack the actual bottleneck.
    const timings: Record<string, number> = {};
    const t0Total = Date.now();
    const mark = (label: string, start: number): number => {
        const now = Date.now();
        timings[label] = (timings[label] ?? 0) + (now - start);
        return now;
    };

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

    let tPhase = Date.now();
    const { grid, cacheHit: gridCacheHit } = buildNavGridCached(
        layers,
        bbox,
        resolutionM,
        req.draftM,
        safetyM,
        obstructionBufferM,
    );
    tPhase = mark(gridCacheHit ? 'buildNavGridCacheHit' : 'buildNavGrid', tPhase);
    if (grid.width === 0 || grid.height === 0) {
        return { error: 'Empty grid', code: 'empty-grid' };
    }

    // Tally grid health for diagnostics — useful when the user
    // reports "no-path" and we need to know whether the grid was
    // mostly land (bad chart for this route) or mostly navigable
    // with a topology issue.

    // ── Endpoint carve ──────────────────────────────────────────────
    // When the user picks an origin/destination, they're asserting "this
    // is water". On ENC charts where LNDARE's GLU-tessellated TRIANGLE_FAN
    // primitives can bleed across narrow rivers (Brisbane River + Rivergate
    // marina is the verified case), the exact endpoint cell can end up
    // hard-blocked even though it's a real marina. Carve a small radius
    // around each endpoint as forced-navigable so the snap algorithm has
    // a target and A* can connect through.
    //
    // 60 m radius — narrow enough to fit any sane marina basin / river
    // bend without bleeding to the opposite shore on a 50 m grid; just
    // big enough that even a slight position error puts the carve in the
    // right water body.
    const mPerLonHere = mPerDegLon((grid.minLat + grid.minLat + grid.height * grid.dLat) / 2);
    const carveEndpoint = (lat: number, lon: number, radiusM: number): void => {
        const dLatBuf = radiusM / M_PER_DEG_LAT;
        const dLonBuf = radiusM / mPerLonHere;
        const x0 = Math.max(0, Math.floor((lon - dLonBuf - grid.minLon) / grid.dLon));
        const x1 = Math.min(grid.width - 1, Math.ceil((lon + dLonBuf - grid.minLon) / grid.dLon));
        const y0 = Math.max(0, Math.floor((lat - dLatBuf - grid.minLat) / grid.dLat));
        const y1 = Math.min(grid.height - 1, Math.ceil((lat + dLatBuf - grid.minLat) / grid.dLat));
        const carveDepth = Math.max((req.draftM ?? 1.5) + 1.0, 5.0);
        for (let y = y0; y <= y1; y++) {
            const cellLat = grid.minLat + (y + 0.5) * grid.dLat;
            for (let x = x0; x <= x1; x++) {
                const cellLon = grid.minLon + (x + 0.5) * grid.dLon;
                if (haversineM(cellLat, cellLon, lat, lon) > radiusM) continue;
                const idx = y * grid.width + x;
                grid.cells[idx] = carveDepth;
                grid.preferred[idx] = 1; // attract A* to enter via the bubble
            }
        }
    };
    carveEndpoint(req.fromLat, req.fromLon, 60);
    carveEndpoint(req.toLat, req.toLon, 60);

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

    // ── Label connected components ──
    // One pass to bucket every navigable cell into its 8-connected
    // water body. Drives the shared-component snap below.
    const { labels, sizes } = labelConnectedComponents(grid);
    tPhase = mark('labelComponents', tPhase);

    // ── Shared-component snap ──────────────────────────────────────
    // For each sizeable component, find its nearest cell to origin AND
    // to destination. Pick the component minimising combined snap
    // distance. This guarantees origin and destination land in the
    // SAME component (so A* succeeds), and at coarse bathymetry
    // resolutions it often produces a better route than greedy "snap
    // origin to nearest big water, hope destination fits".
    //
    // The earlier two-step approach (snap origin first, require
    // destination same-component) failed on routes like Newport →
    // Brisbane Port where each endpoint is closest to a different
    // component but a third — the main bay — is reachable from both.
    //
    // Snap radius is generous (10 km). Newport's nearest deep channel
    // sits 6-8 km east in main Moreton Bay; the old 5 km radius
    // couldn't reach it.
    const minComponentCells = req.minComponentCells ?? 25;
    const maxSnapCells = Math.ceil(10_000 / resolutionM);

    let bestStart: { x: number; y: number } | null = null;
    let bestEnd: { x: number; y: number } | null = null;
    let bestLabel = -1;
    let bestCombinedM = Infinity;
    let bestComponentSize = 0;

    for (const [label, size] of sizes) {
        if (size < minComponentCells) continue;
        const startCandidate = snapWithPredicate(
            grid,
            req.fromLat,
            req.fromLon,
            maxSnapCells,
            (idx) => labels[idx] === label,
        );
        if (!startCandidate) continue;
        const endCandidate = snapWithPredicate(
            grid,
            req.toLat,
            req.toLon,
            maxSnapCells,
            (idx) => labels[idx] === label,
        );
        if (!endCandidate) continue;

        const [startLon, startLat] = gridToLatLon(grid, startCandidate.x, startCandidate.y);
        const [endLon, endLat] = gridToLatLon(grid, endCandidate.x, endCandidate.y);
        const combinedM =
            haversineM(req.fromLat, req.fromLon, startLat, startLon) + haversineM(req.toLat, req.toLon, endLat, endLon);

        if (combinedM < bestCombinedM) {
            bestCombinedM = combinedM;
            bestLabel = label;
            bestStart = startCandidate;
            bestEnd = endCandidate;
            bestComponentSize = size;
        }
    }

    if (!bestStart || !bestEnd) {
        // No sizeable component lies within snap radius of both endpoints.
        // Distinguish "origin on land" from "no shared water body".
        const originNav = snapToNavigable(grid, req.fromLat, req.fromLon, maxSnapCells);
        const destNav = snapToNavigable(grid, req.toLat, req.toLon, maxSnapCells);
        if (!originNav) {
            return {
                error: 'Origin point and surrounding area are not navigable for this draft',
                code: 'origin-on-land',
                debug,
            };
        }
        if (!destNav) {
            return {
                error: 'Destination point and surrounding area are not navigable for this draft',
                code: 'destination-on-land',
                debug,
            };
        }
        return {
            error: 'Origin and destination are in disconnected water bodies — no shared navigable channel reaches both within the route bbox',
            code: 'destination-disconnected',
            debug,
        };
    }

    const startCell = bestStart;
    const endCell = bestEnd;
    debug.cellsReachableFromOrigin = bestComponentSize;
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
    // Silence the unused-variable warning while preserving the
    // diagnostic value of bestLabel in any future debug output.
    void bestLabel;
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

    tPhase = mark('componentSnap', tPhase);

    // A* must succeed because the destination cell is in the origin's
    // reachable component. Defensive: still handle null in case the
    // grid has a path-cost edge case I haven't anticipated.
    const cells = aStar(grid, startCell, endCell);
    tPhase = mark('aStar', tPhase);
    if (!cells) {
        return { error: 'A* failed despite reachability flood-fill — should be impossible', code: 'no-path', debug };
    }

    // String-pull the A* output to remove stair-step artifacts.
    const smoothedCells = smoothPath(grid, cells);
    tPhase = mark('smoothPath', tPhase);
    const totalMs = Date.now() - t0Total;
    const breakdown = Object.entries(timings)
        .map(([k, v]) => `${k}=${v}ms`)
        .join(' ');
    console.warn(`[inshoreEngine] routeInshore total=${totalMs}ms — ${breakdown}`);

    // Convert grid path → polyline (cell centers). Keep each smoothed
    // cell's caution-state alongside so Douglas-Peucker can be run
    // per caution-run below — DP itself is not caution-aware, so
    // DP'ing the whole polyline re-merges a caution patch into an
    // adjacent deep run and the route draws a long mostly-deep leg
    // entirely red (the Brisbane "red but could go another way" bug).
    const polylineRaw: [number, number][] = smoothedCells.map((c) => gridToLatLon(grid, c.x, c.y));
    const cautionRaw: boolean[] = smoothedCells.map((c) => grid.cells[c.y * grid.width + c.x] < 0);

    // Always splice the input coords as the visible start/end of the
    // polyline. The bridge segment from input → first water cell
    // (and last water cell → input) is shown as part of the route.
    //
    // Earlier versions tried various gates (150 m threshold, LNDARE-
    // crossing check) to hide the bridge when it would visually cross
    // land — but that meant routes silently appeared to start/end
    // somewhere different from where the user tapped. Confusing.
    //
    // User-visible behaviour now:
    //   - tap in open water → route visibly starts at the tap, bridge
    //     is short and over water, looks correct
    //   - tap in marina canal / on dock → bridge segment visibly
    //     crosses dock structures, signalling "your tap wasn't in
    //     clean water — move the pin if you want a cleaner approach"
    //   - tap miles inland → long bridge over land, obvious that the
    //     input was wrong
    //
    // Visual feedback is the right primitive for this — we don't have
    // the routing constraints to know whether the user *meant* a
    // marina exit or a coastline tap.
    if (polylineRaw.length > 0) {
        polylineRaw[0] = [req.fromLon, req.fromLat];
        polylineRaw[polylineRaw.length - 1] = [req.toLon, req.toLat];
    }
    // DP tolerance ≈ 1/4 cell. Tighter than the original 1/2 cell —
    // keeps more turn detail in winding channels (Savannah River
    // bends look noticeably closer to the actual channel after this).
    const tolDeg = Math.min(grid.dLat, grid.dLon) * 0.25;

    // Build the final polyline + per-segment cautionMask together.
    // smoothPath already split the path at caution boundaries; we keep
    // DP from re-merging across them by splitting polylineRaw into
    // runs of constant caution-state, Douglas-Peucker'ing each run
    // independently, then concatenating (the boundary point is shared
    // between adjacent runs). A segment is "caution" if EITHER of its
    // endpoint cells is caution — the transition segment is flagged
    // red, conservatively.
    let polyline: [number, number][];
    const cautionMask: boolean[] = [];
    if (polylineRaw.length < 2) {
        polyline = polylineRaw.slice();
    } else {
        const segCaution: boolean[] = [];
        for (let i = 0; i < polylineRaw.length - 1; i++) {
            segCaution.push(cautionRaw[i] || cautionRaw[i + 1]);
        }
        polyline = [];
        let runStart = 0;
        for (let i = 0; i <= segCaution.length; i++) {
            const atEnd = i === segCaution.length;
            if (atEnd || segCaution[i] !== segCaution[runStart]) {
                // run = segments [runStart, i) → points [runStart, i]
                const simplified = douglasPeucker(polylineRaw.slice(runStart, i + 1), tolDeg);
                const runCaution = segCaution[runStart];
                // skip the boundary point shared with the previous run
                const from = polyline.length === 0 ? 0 : 1;
                for (let k = from; k < simplified.length; k++) polyline.push(simplified[k]);
                for (let k = 0; k < simplified.length - 1; k++) cautionMask.push(runCaution);
                runStart = i;
            }
        }
    }

    // Compute total length in NM along the simplified polyline.
    let distM = 0;
    for (let i = 1; i < polyline.length; i++) {
        distM += haversineM(polyline[i - 1][1], polyline[i - 1][0], polyline[i][1], polyline[i][0]);
    }

    return {
        polyline,
        cautionMask,
        distanceNM: distM / 1852,
        gridSize: { width: grid.width, height: grid.height },
        bbox,
        debug,
        phaseTimings: timings,
    };
}
