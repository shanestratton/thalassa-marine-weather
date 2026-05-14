/**
 * Inshore Router — A* pathfinding through ENC navigability grids.
 *
 * THIS IS THE PI-SIDE FALLBACK. The iOS app runs the same routing
 * pure function locally via `services/inshoreRouterEngine.ts` — those
 * two files are kept byte-identical apart from this docstring. The Pi
 * endpoint stays alive for direct HTTP consumers (curl, future
 * external integrations) and as a fallback if the device-side compute
 * breaks.
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
    distanceNM: number;
    gridSize: { width: number; height: number };
    bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
    debug?: RouteDebug;
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
 * Build a navigability grid for the given bbox, draft, and resolution.
 * Time complexity is roughly O(featureCount × cellsPerFeatureBbox).
 * Polygons rasterize in their bbox slice rather than the whole grid.
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
            water === 'canal' ||
            water === 'harbour' ||
            water === 'marina' ||
            water === 'dock' ||
            harbour === 'yes'
        );
    };
    const depare = layers.DEPARE?.features ?? [];
    for (const f of depare) {
        const g = f.geometry;
        if (g.type !== 'Polygon' && g.type !== 'MultiPolygon') continue;
        const props = f.properties as Record<string, unknown> | null;
        const drval1 = props?.['DRVAL1'];
        // S-57 DRVAL1 is positive depth in meters.
        const drval1Num = typeof drval1 === 'number' ? drval1 : null;
        const authoritative = isAuthoritativeDepare(props);

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
                    // Shallow water — block UNLESS an authoritative
                    // engineered-water DEPARE already claimed this cell.
                    // Coarse public bathymetry (30 m AusBathyTopo) can't
                    // resolve dredged marina basins / canals: it reads
                    // them at the shallow surrounding-terrain depth, and
                    // that shallow band would otherwise block the cell
                    // before the precise OSM marina/canal polygon claims
                    // it. The protectedCells guard makes the outcome
                    // order-independent — once authoritative water has
                    // claimed a cell, no shallow band re-blocks it.
                    // (2026-05-14: Newport canal-estate bug — the dredged
                    // canals read as 0.5-2 m in AusBathyTopo, so the
                    // whole marina was blocked and the route snapped
                    // ~2.4 km across the peninsula to the nearest water.)
                    if (protectedCells[idx] !== 1) {
                        cells[idx] = BLOCKED;
                    }
                } else {
                    // Deep enough for this vessel.
                    const prior = cells[idx];
                    if (Number.isNaN(prior)) {
                        // Cell was blocked by an earlier (shallow) band.
                        // An authoritative engineered-water DEPARE
                        // overrides that shallow reading — un-block the
                        // cell to the authoritative depth.
                        if (authoritative) cells[idx] = drval1Num;
                    } else if (prior === UNKNOWN_OPEN || drval1Num < prior) {
                        // Track shallowest known depth at this cell.
                        cells[idx] = drval1Num;
                    }
                    if (authoritative) protectedCells[idx] = 1;
                }
            }
        }
    }

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
                    const idx = y * width + x;
                    if (!protectedCells[idx]) {
                        cells[idx] = BLOCKED;
                        hardBlocked[idx] = 1;
                    }
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
            const g = f.geometry as Polygon | MultiPolygon;
            const pBbox = geometryBbox(g);
            const { x0, x1, y0, y1 } = polyToCellRange(pBbox);
            for (let y = y0; y <= y1; y++) {
                const lat = minLat + (y + 0.5) * dLat;
                for (let x = x0; x <= x1; x++) {
                    const lon = minLon + (x + 0.5) * dLon;
                    if (pointInGeometry(lon, lat, g)) {
                        cells[y * width + x] = BLOCKED;
                        hardBlocked[y * width + x] = 1;
                    }
                }
            }
        }
    };

    for (const f of layers.OBSTRN?.features ?? []) handlePointFeature(f);
    for (const f of layers.WRECKS?.features ?? []) handlePointFeature(f);
    for (const f of layers.UWTROC?.features ?? []) handlePointFeature(f);

    // ── Pass 4: FAIRWY + DRGARE — mark preferred channel cells ─────
    // We don't change the navigability of these cells (a navigable cell
    // stays navigable, a blocked cell stays blocked — fairways CAN
    // overlap with shallow flats at low tide, and the chart's DEPARE
    // pass is the authoritative source for "is there enough depth").
    // We just flag cells that fall inside a marked channel so the A*
    // cost function can prefer them.
    const markChannelPreference = (f: Feature): void => {
        if (!f.geometry || (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon')) return;
        const g = f.geometry as Polygon | MultiPolygon;
        const pBbox = geometryBbox(g);
        const { x0, x1, y0, y1 } = polyToCellRange(pBbox);
        if (x0 > x1 || y0 > y1) return;
        for (let y = y0; y <= y1; y++) {
            const lat = minLat + (y + 0.5) * dLat;
            for (let x = x0; x <= x1; x++) {
                const lon = minLon + (x + 0.5) * dLon;
                if (pointInGeometry(lon, lat, g)) {
                    const idx = y * width + x;
                    preferred[idx] = 1;
                    // Rescue: a marked fairway / dredged area is
                    // navigable water by definition. If coarse public
                    // bathymetry blocked this cell with a shallow
                    // DEPARE band, un-block it — the channel markers
                    // (placed by the harbour authority) are the
                    // authoritative "navigable" signal, not the 30 m
                    // raster. Never override a hard-blocked cell
                    // (LNDARE / obstruction). (2026-05-14: Newport —
                    // the marked exit channel was preferred-but-
                    // blocked, so it couldn't connect the canal to
                    // open water and the route snapped ~2 km across
                    // the peninsula.)
                    if (Number.isNaN(cells[idx]) && hardBlocked[idx] !== 1) {
                        cells[idx] = Math.max(draftM + safetyM, 5.0);
                    }
                }
            }
        }
    };
    for (const f of layers.FAIRWY?.features ?? []) markChannelPreference(f);
    for (const f of layers.DRGARE?.features ?? []) markChannelPreference(f);

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
                    if (Number.isNaN(cells[idx]) && hardBlocked[idx] !== 1) {
                        cells[idx] = Math.max(draftM + safetyM, 5.0);
                    }
                }
            }
        }
    };
    for (const f of layers.BOYLAT?.features ?? []) markMarkerRadius(f);
    for (const f of layers.BCNLAT?.features ?? []) markMarkerRadius(f);

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
    if (depth > 0) return 8.0;
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
    const budget = Math.max(cellCostAt(grid, a.x, a.y), cellCostAt(grid, b.x, b.y));
    for (const c of bresenhamCells(a.x, a.y, b.x, b.y)) {
        if (!isNavigable(grid, c.x, c.y)) return false;
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

    // A* must succeed because the destination cell is in the origin's
    // reachable component. Defensive: still handle null in case the
    // grid has a path-cost edge case I haven't anticipated.
    tPhase = mark('componentSnap', tPhase);
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

    // Convert grid path → polyline (cell centers) → simplified polyline.
    const polylineRaw: [number, number][] = smoothedCells.map((c) => gridToLatLon(grid, c.x, c.y));

    // Splice the user's input lat/lon back into the polyline ONLY when
    // the input is close enough to the snapped water cell that the
    // bridging segment stays in water. If the input geocoded to land
    // (city centres, marinas, suburbs) the snap moved hundreds of
    // metres to find navigable water — overriding the polyline endpoint
    // with that on-land input puts a visible "route crosses land"
    // segment from input to first water cell.
    //
    // Threshold = 150 m. Bigger than typical chart-marker tap precision
    // (~20 m) and the 50 m grid cell, smaller than the snap distances
    // (300-700 m) we see for shore-side geocodes. Inside that radius
    // the bridge segment is short enough we trust it doesn't cross
    // land; outside, we leave the snapped water cell as the visible
    // route start.
    // Always splice the input coords as the visible start/end of the
    // polyline. The bridge segment is shown as part of the route.
    // Visual feedback is the right primitive — if the bridge looks
    // like it crosses land, the user knows the input wasn't ideal.
    if (polylineRaw.length > 0) {
        polylineRaw[0] = [req.fromLon, req.fromLat];
        polylineRaw[polylineRaw.length - 1] = [req.toLon, req.toLat];
    }
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
        phaseTimings: timings,
    };
}
