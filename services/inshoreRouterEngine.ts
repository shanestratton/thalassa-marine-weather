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

import type {
    Feature,
    FeatureCollection,
    LineString,
    MultiLineString,
    Polygon,
    MultiPolygon,
    Point,
    Position,
} from 'geojson';

import { createLogger } from '../utils/createLogger';
import { routeMarina, type Cell } from './marinaCenterline';
import { parseLateralMarks, refineWithFairlead, type LatLon } from './fairlead';
import {
    parseLeadingLines,
    snapToLeadingLines,
    buildLeadingApproach,
    distM as llDistM,
    anyAlong as llAnyAlong,
} from './leadingLine';
// Three-tier contract path (docs/THREE_TIER_ROUTING.md). segmentRoute + the
// tier routers operate on the contract's [lon,lat] tuple LatLon, which the
// engine's [number,number][] polyline satisfies structurally — so no LatLon
// import is needed here (and no collision with fairlead's {lat,lon} LatLon).
import { segmentRoute, type TierSpan } from './routing/segmentRoute';
import { routeTier3, type Tier3Context } from './tier3/tier3Router';
import { stitchLegs } from './glue/gluer';
import { isRefusal, freezeLeg, type Leg, type LegResult } from './routing/legContract';

const engineLog = createLogger('inshoreEngine');

// Verbose routing diagnostics (per-component dumps, cell-state traces,
// phase timings, bridge/snap reasoning). Gated OFF for production: the
// minifier dead-code-eliminates `if (ENGINE_DEBUG)` so neither the logs
// NOR their (sometimes expensive grid-walking) compute ship. Flip to
// true locally to debug a route. Operational fallback logs (destination-
// disconnected relax, far-snap retry) stay unconditional below.
const ENGINE_DEBUG = false;

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
    /**
     * OSM coastline LineStrings (natural=coastline). Used to plug
     * LNDARE gaps where the chart's LNDARE tessellation misses the
     * actual land boundary (Newport peninsula 2026-05-19: chart
     * LNDARE was missing the canal-estate islands, so A* threaded
     * a straight diagonal across them from the canal exit to the
     * bay). Each LineString segment is Bresenham-rasterized as a
     * thin hardBlocked strip — enough to stop A* from crossing the
     * boundary even when the polygon LNDARE has the hole.
     */
    COASTLINE?: FeatureCollection;
    /**
     * OSM waterway=canal/fairway/dock LineStrings — the navigable
     * centreline of dredged channels (marina exit channels, port
     * approach cuts). The inverse of COASTLINE: each segment is
     * Bresenham-rasterized as a 1-cell NAVIGABLE corridor (protected
     * water) so canal estates connect to open water across chart
     * LNDARE that tessellates the channel banks as land at 50 m
     * resolution. Newport Marina 2026-05-20: the canal interior was
     * a 349-cell isolated component because the exit channel (a
     * waterway=canal LineString, not a closed polygon) was being
     * dropped — origin tap snapped 2 km out into Bramble Bay.
     */
    CANAL?: FeatureCollection;
    /**
     * OSM navigation-line LineStrings (seamark leading/transit lines) —
     * the charted dredged-channel centreline ships steer along. Unlike
     * CANAL (which just carves navigable water to connect islanded
     * pockets), NAVLINE is rasterised into a PREFERRED corridor (a few
     * cells wide) AND rescues shallow/blocked cells to navigable, so A*
     * is actively ATTRACTED onto the marked channel and rides it through
     * bars/approaches the coarse bathymetry reads as too shallow. Added
     * 2026-05-20 for the Brisbane River mouth bar (the dredged cut isn't
     * in chart FAIRWY and the lateral markers are too sparse to stitch,
     * but OSM has it as navigation_line).
     */
    NAVLINE?: FeatureCollection;
    /**
     * S-57 RECTRC (Recommended Track) LineStrings — the hydrographer's OFFICIAL
     * recommended route through a channel/approach, drawn on the chart (with
     * CATTRK + ORIENT bearing). Where present this is the AUTHORITATIVE channel
     * line: the tier-3 router snaps the route onto it FIRST, ahead of the
     * derived buoy/leading-line follow. The "definitive set of routes out of
     * the marina" — it ships inside the ENC, we just plumb it through. Added
     * 2026-06-18 (Newport carries 43 RECTRC segments we were ignoring).
     */
    RECTRC?: FeatureCollection;
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
    /**
     * Uncharted-space policy (field bug 2026-06-12, Newport→Mooloolaba:
     * with the corridor's layers empty the engine returned a dead-
     * straight 32.7 NM line over Bribie Island with ZERO caution flags —
     * UNKNOWN_OPEN's permissive default means uncharted islands don't
     * exist; see ROUTING_COLLAB reply 16).
     *
     *   'permissive' (default) — legacy behaviour: no-evidence space is
     *     freely navigable at 500× cost and the output mask stays clean.
     *     Correct for unit fixtures that lay only the features under
     *     test, and for fully-charted harbour corridors.
     *   'strict' — the LIVE orchestrator setting. Cells with NO water
     *     evidence (no DEPARE verdict, not FAIRWY/DRGARE-preferred, no
     *     OSM water) are flagged in `cautionMask` when crossed, and a
     *     route whose longest contiguous no-evidence run exceeds
     *     UNCHARTED_MAX_RUN_M is refused with code 'uncharted-corridor'
     *     — uncharted ≠ open, structurally, not as a cost knob.
     */
    unchartedPolicy?: 'permissive' | 'strict';
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
    /** True when the marina-centerline pipeline refined a clean-water route
     *  (mid-channel keel-safe straight legs) instead of plain A*+smoothPath. */
    marinaCenterline?: boolean;
    /** True when the two-tier fine marina pass was accepted over the 50 m
     *  main route (short routes that validated cleaner on a ~10 m grid). */
    twoTierFine?: boolean;
    /** Channel key when Fairlead spliced a buoyed-channel segment (the route
     *  follows the lateral marks there), else absent. */
    fairlead?: string;
    /** Present when the three-tier contract path (segmentRoute → per-span tier
     *  routers → glue) produced the final route instead of the monolith
     *  fairlead/leading splice. Value = the joined leg provenance (e.g.
     *  'tier3:fairlead(BC)+lead | tier2:passthrough'). Absent ⇒ the path
     *  refused and the route fell back to the proven splice chain. */
    threeTier?: string;
    /** Count of charted leading lines (navigation_line transits) the route was
     *  snapped onto — "line up the marks" vessel procedure. Absent if none. */
    leadingLine?: number;
    /** Count of charted leading lines the route APPROACHED via (route-via-
     *  transit: make the seaward mark, run the leads into the destination).
     *  Absent if the destination isn't served by leading lines. */
    leadingApproach?: number;
    /** Longest contiguous no-water-evidence run along the final polyline in
     *  metres (strict unchartedPolicy only). The refusal threshold is
     *  UNCHARTED_MAX_RUN_M — present on success AND on 'uncharted-corridor'
     *  failures so the caller can see how close/far the route was. */
    unchartedMaxRunM?: number;
    /** True when an 'uncharted-corridor' refusal came from the sub-second
     *  400 m coarse pre-check instead of the full fine-grid pass (reply 19
     *  fix 3 — strict refusals used to pay the whole 20-47 s build first). */
    coarsePrecheck?: boolean;
    /** Grid-relaxation params the ACCEPTED pass was built with (absent =
     *  strict, no zones). The Phase 12 shadow router must look up the
     *  SAME grid — the cache key includes both — or relax-zone routes
     *  (canal-estate berth starts) read as phantom 'no-entry' connector
     *  failures on the strict grid and poison the promotion dataset. */
    relaxedLndare?: boolean;
    relaxZones?: RelaxZone[];
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
        | 'empty-grid'
        | 'uncharted-corridor';
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

// Exported for services/seaway/connector.ts (Phase 11) — the connector
// runs on the SAME grid + cost function as the engine, by construction.
export interface NavGrid {
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
    /**
     * Per-cell LAND flag (1 = blocked by LNDARE / coastline / the LNDARE
     * coastal buffer — actual terra firma). A point-hazard buffer (WRECKS /
     * OBSTRN / UWTROC) blocks `cells` but does NOT set this. The leading-line
     * splice validators use it so a charted lead is never vetoed by the very
     * hazard it exists to guide past (the Tangalooma WRECKS veto), while
     * still never crossing land. Optional for cached-grid back-compat.
     */
    landBlocked?: Uint8Array;
    /**
     * Per-cell NO-WATER-EVIDENCE flag (1 = at the end of the grid build the
     * cell was still UNKNOWN_OPEN with no DEPARE verdict, no FAIRWY/DRGARE
     * preference, no OSM water and no protection — nothing in any source
     * vouches there is water here). Evidence-based, NOT coverage-bbox-based:
     * the Sunshine Coast ribbon cells' bboxes cover Bribie Island while
     * containing zero LNDARE (reply 16 cause #3), so bbox containment proves
     * nothing. Under unchartedPolicy 'strict' these cells flag caution when
     * crossed and long runs refuse the route. A post-build rescue (endpoint
     * carve, bridges) clears the flag implicitly: readers must pair it with
     * `cells[idx] === UNKNOWN_OPEN`. Optional for cached-grid back-compat.
     */
    unvouched?: Uint8Array;
    /**
     * Per-cell "INJECTED canal/marina channel water" flag: 1 = the cell was
     * claimed by the nearshore Mapbox vector-water fill we INJECTED for routing
     * (a DEPARE feature tagged `_source === 'mapbox-water'` over the endpoint
     * corridor crops). This is STRICTLY NARROWER than osmWaterCells: it excludes
     * generic chart OSM rivers/harbours/lakes, the thin Pass-1b OSM canal carve
     * (which already routes fine and is baked into the route-fixture baselines),
     * and — by construction — the open bay (the injection only ever covers the
     * ~4 km crops around origin + destination). The tier
     * router uses it to (a) classify these vertices tier-3 (a canal, not "deep
     * open water") and (b) force the fine centreline pass over them even though
     * the wide injected fill defeats the coarse narrowness probe. Optional for
     * cached-grid + test back-compat (omitted ⇒ treated as all-zero).
     */
    injectedCanal?: Uint8Array;
}

/**
 * Refusal threshold for unchartedPolicy 'strict': the longest contiguous
 * run of no-evidence cells the final polyline may cross, in metres. 1 NM —
 * generous against false positives (ogr2ogr sliver gaps between DEPARE
 * bands are 1-3 cells ≈ 50-150 m and merely flag red; marina basins are
 * OSM-vouched; the endpoint carve vouches 60 m around each tap) while any
 * genuine chart-coverage hole is tens of kilometres (Bribie: a 32.7 NM
 * route with ~0% evidence). One knob, one fixture: inshoreRouter.uncharted.
 */
export const UNCHARTED_MAX_RUN_M = 1852;

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

/**
 * A circular zone (tap centre + radius) within which LNDARE/coastline
 * cells are relaxed to CAUTION (traversable at 500× cost, flagged red)
 * instead of hard-blocked. Used by the far-snap retry to thread the
 * charted-land barrier islanding an endpoint (Newport's canal estate)
 * WITHOUT relaxing the whole grid — global relaxation let A* shortcut
 * straight across the mainland (verified land-crossing 2026-05-20).
 * Confining relaxation to a bounded zone around the problem endpoint
 * keeps every mid-route mainland cell hard-blocked, so the only red
 * cells are the genuine barrier the user must pilot through.
 */
export interface RelaxZone {
    lat: number;
    lon: number;
    radiusM: number;
}

function relaxZonesKey(relaxZones: RelaxZone[]): string {
    if (relaxZones.length === 0) return 'none';
    return relaxZones.map((z) => `${z.lat.toFixed(3)},${z.lon.toFixed(3)},${Math.round(z.radiusM)}`).join('|');
}

function navGridCacheKey(
    layers: InshoreLayers,
    bbox: [number, number, number, number],
    resolutionM: number,
    draftM: number,
    safetyM: number,
    obstructionBufferM: number,
    relaxedLndare: boolean,
    relaxZones: RelaxZone[],
): string {
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
        layers.COASTLINE?.features.length ?? 0,
        layers.CANAL?.features.length ?? 0,
        layers.NAVLINE?.features.length ?? 0,
    ].join(',');
    return `${bbox.join(',')}_${resolutionM}_${draftM}_${safetyM}_${obstructionBufferM}_${relaxedLndare ? 'relaxed' : 'strict'}_rz${relaxZonesKey(relaxZones)}_${sig}`;
}

/**
 * READ-ONLY cache lookup for the Phase 12 shadow router: returns the
 * already-built grid for these exact params, or null — it NEVER builds.
 * The shadow must never pay a synchronous grid build on the main thread
 * (the adversarial review measured a guaranteed miss for fine-pass
 * results: the fine bbox at 50 m is a key no live path ever builds, and
 * the orphan entry would evict a hot grid from the 5-slot LRU). A null
 * here becomes a reasoned 'grid-not-cached' report, never silent work.
 */
export function getCachedNavGrid(
    layers: InshoreLayers,
    bbox: [number, number, number, number],
    resolutionM: number,
    draftM: number,
    safetyM: number,
    obstructionBufferM: number,
    relaxedLndare: boolean = false,
    relaxZones: RelaxZone[] = [],
): NavGrid | null {
    const key = navGridCacheKey(
        layers,
        bbox,
        resolutionM,
        draftM,
        safetyM,
        obstructionBufferM,
        relaxedLndare,
        relaxZones,
    );
    const cached = navGridCache.get(key);
    if (!cached) return null;
    cached.ts = Date.now();
    return cached.grid;
}

function buildNavGridCached(
    layers: InshoreLayers,
    bbox: [number, number, number, number],
    resolutionM: number,
    draftM: number,
    safetyM: number,
    obstructionBufferM: number,
    relaxedLndare: boolean = false,
    relaxZones: RelaxZone[] = [],
): { grid: NavGrid; cacheHit: boolean } {
    const key = navGridCacheKey(
        layers,
        bbox,
        resolutionM,
        draftM,
        safetyM,
        obstructionBufferM,
        relaxedLndare,
        relaxZones,
    );
    const cached = navGridCache.get(key);
    if (cached) {
        cached.ts = Date.now();
        return { grid: cached.grid, cacheHit: true };
    }
    const grid = buildNavGrid(
        layers,
        bbox,
        resolutionM,
        draftM,
        safetyM,
        obstructionBufferM,
        relaxedLndare,
        relaxZones,
    );
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
    /**
     * When true, ALL LNDARE cells become CAUTION (high-cost 500×
     * traversable) instead of BLOCKED, grid-wide. Reserved for the
     * destination-disconnected last-resort retry — the rare case where a
     * chart's mainland LNDARE polygon includes a river course without a
     * proper hole and strict routing finds NO path at all. A* still
     * prefers real water (8×) over relaxed land (40×) so it only crosses
     * land where no water route exists.
     */
    relaxedLndare: boolean = false,
    /**
     * Bounded zones within which LNDARE/coastline relax to CAUTION even
     * when `relaxedLndare` is false. Used by the far-snap retry to thread
     * the charted-land barrier islanding an endpoint (Newport) while
     * keeping every mid-route mainland cell hard-blocked. Empty = no
     * localized relaxation.
     */
    relaxZones: RelaxZone[] = [],
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
    // DEPARE-only verdict per cell (NaN = no DEPARE coverage): the depth the
    // chart's depth areas assign here, IGNORING a later LNDARE override. Lets
    // the synthetic lateral-mark ribbon (Pass 4) restore charted water that
    // LNDARE *bleed* falsely hard-blocked — un-blocking the buoyed channel
    // WITHOUT faking depth, and never touching real land (NaN → stays blocked).
    const depareVerdict = new Float32Array(width * height).fill(NaN);
    const preferred = new Uint8Array(width * height);
    // Per-cell "protected" flag: 1 = a DEPARE (chart S-57 OR authoritative
    // OSM engineered water) claimed this cell as deep, so the LNDARE pass
    // doesn't hard-block it. Generic OSM `natural=water` and bathymetry-
    // derived DEPARE do NOT get this protection — LNDARE beats them.
    const protectedCells = new Uint8Array(width * height);
    // Per-cell "OSM-vouched water" flag: 1 = the protection above came
    // from an OSM-authoritative source (marina/canal/dock/river) or an
    // OSM canal carve — NOT from a chart S-57 DEPARE. Used by Pass 2 to
    // tell apart the two protected cases when a chart LNDARE collides:
    //   • OSM-vouched (Newport canals, Brisbane River LNDARE-bleed) → keep
    //     clean navigable; OSM is the trusted source over chunky LNDARE.
    //   • chart-DEPARE-only (a coarse overview-cell landmask bulging over a
    //     finer-survey deep channel — e.g. Tangalooma Roads off Moreton
    //     Island) → the two chart layers DISAGREE, so flag CAUTION (red)
    //     rather than draw confident clean water over charted land.
    const osmWaterCells = new Uint8Array(width * height);
    // Per-cell "injected nearshore canal water" flag (see NavGrid.injectedCanal).
    // The Mapbox-water DEPARE fill (_source==='mapbox-water') we injected for
    // routing, RESTRICTED (after the LNDARE passes) to cells with charted LAND
    // within MARINA_NEAR_CELLS — i.e. the canal CHANNEL bounded by the marina lots,
    // NOT the open-bay part of the ~4 km crop (land far away). The canal is often
    // charted as a COARSE ENC DEPARE (reads deep ⇒ tier-2), so the discriminator
    // is narrowness/land-proximity, NOT ENC-gap. Bounding it keeps the canal's
    // tier-3 span short (fits the fine length cap, small fine grid). Kept separate
    // from osmWaterCells (broader, drives the LNDARE-conflict logic).
    const injectedCanalCells = new Uint8Array(width * height);
    // Per-cell "hard blocked" flag: 1 = blocked by LNDARE (land) or a
    // point obstruction (OBSTRN / WRECKS / UWTROC). A cell merely
    // blocked by a shallow DEPARE band has hardBlocked = 0. Pass 4
    // (FAIRWY) and Pass 5 (paired channel midpoints) are allowed to
    // RESCUE a shallow-blocked cell back to navigable — a marked
    // channel is navigable water by definition — but must never
    // override a hard-blocked cell (actual land / charted hazard).
    const hardBlocked = new Uint8Array(width * height);
    // LAND-only subset of hardBlocked (LNDARE / coastline / coastal buffer —
    // never point-hazard buffers). See NavGrid.landBlocked.
    const landBlocked = new Uint8Array(width * height);
    const grid: NavGrid = { width, height, minLon, minLat, dLon, dLat, cells, preferred, landBlocked };

    // Capture grid-build setup time separately. Anything north of a
    // few ms here points to wasted re-work (we already pay for this on
    // each call — buildNavGridCached is a separate concern).
    markPass('setup', buildT0, width * height);

    // Localized LNDARE relaxation mask. A cell with relaxMask[idx]===1
    // gets CAUTION instead of BLOCKED in the LNDARE (Pass 2) and
    // coastline (Pass 2b) passes, and is exempt from the Pass 6 buffer —
    // so a far-snapped endpoint can thread the charted-land barrier that
    // islands it, flagged red, while every cell OUTSIDE the zone stays
    // hard-blocked. This is the bounded replacement for the old
    // grid-wide `relaxedLndare` far-snap retry, which let A* cut straight
    // across the mainland. Building the mask is O(cells inside the
    // zones) — a few thousand cells per zone, cheap.
    const relaxMask = new Uint8Array(width * height);
    for (const z of relaxZones) {
        const dLatR = z.radiusM / M_PER_DEG_LAT;
        const dLonR = z.radiusM / mPerLon;
        const zx0 = Math.max(0, Math.floor((z.lon - dLonR - minLon) / dLon));
        const zx1 = Math.min(width - 1, Math.ceil((z.lon + dLonR - minLon) / dLon));
        const zy0 = Math.max(0, Math.floor((z.lat - dLatR - minLat) / dLat));
        const zy1 = Math.min(height - 1, Math.ceil((z.lat + dLatR - minLat) / dLat));
        for (let y = zy0; y <= zy1; y++) {
            const cellLat = minLat + (y + 0.5) * dLat;
            for (let x = zx0; x <= zx1; x++) {
                const cellLon = minLon + (x + 0.5) * dLon;
                if (haversineM(cellLat, cellLon, z.lat, z.lon) > z.radiusM) continue;
                relaxMask[y * width + x] = 1;
            }
        }
    }

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
        const natural = props['natural'];
        const harbour = props['harbour'];
        return (
            leisure === 'marina' ||
            waterway === 'dock' ||
            waterway === 'canal' ||
            waterway === 'fairway' ||
            waterway === 'river' ||
            waterway === 'riverbank' ||
            // `water=*` subtags for marina contexts (Newport canals use
            // these for the side arms branching off the main basin)
            water === 'canal' ||
            water === 'harbour' ||
            water === 'marina' ||
            water === 'dock' ||
            water === 'river' ||
            water === 'lake' ||
            // OsmRouteOverlayService injects natural=water polygons into
            // DEPARE for rivers / harbours / basins. They're OSM-derived
            // navigable water — authoritative to override LNDARE-bleed.
            natural === 'water' ||
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
        // Chart-source DEPARE (acronym='DEPARE' from senc-extractor) is
        // hydrographic-survey data. With the Eulerian ring fix (2026-05-19)
        // these polygons now have proper outer rings — they no longer
        // bleed across the coastline as the triangle-soup did. So trust
        // them to win against LNDARE on overlap (e.g. marina basins where
        // chart has a tiny DEPARE inside a chunky mainland LNDARE).
        // OSM-derived DEPARE (no acronym) still uses the old OSM-tag gate
        // (Scarborough peninsula safeguard).
        const isS57Depare = typeof props?.acronym === 'string';
        // OSM-vouched = authoritative water that is NOT a chart S-57 DEPARE
        // (marina/canal/dock/river injected by OsmRouteOverlayService). These
        // keep clean navigable even under a chunky LNDARE; chart-DEPARE-only
        // protection that collides with chart LNDARE is flagged CAUTION instead.
        const osmVouched = !isS57Depare && isAuthoritativeDepare(props);
        const authoritative = isS57Depare || osmVouched;
        const shallow = drval1Num < draftM + safetyM;
        // INJECTED nearshore canal water we added for routing (Mapbox vector
        // water over the endpoint crops). Tagged regardless of the shallow/deep
        // branch so a deep-draft vessel (where 5 m reads shallow) still marks
        // the canal — it's a canal either way, just caution-flagged if shallow.
        const isMapboxWater = props?.['_source'] === 'mapbox-water';

        // Scanline-rasterize the polygon and apply cell updates inside
        // the per-cell callback. ~25× faster than the old "per cell,
        // pointInGeometry" loop on real DEPARE shapes (50+ vertex
        // bathymetry contours covering 50×50+ cell ranges).
        rasterizePolygonCells(grid, g, (x, y) => {
            const idx = y * width + x;

            // Tag injected Mapbox canal water (both branches) → tier-3 + fine pass.
            // Narrowed to the actual channel after the LNDARE passes (see below).
            if (isMapboxWater) injectedCanalCells[idx] = 1;

            // Record the DEPARE-only verdict (independent of any later LNDARE
            // hard-block), tracking the shallowest real depth or CAUTION — so
            // Pass 4 can restore charted water under LNDARE bleed for a marked
            // channel without fabricating depth.
            const prevV = depareVerdict[idx];
            if (shallow) {
                if (Number.isNaN(prevV)) depareVerdict[idx] = CAUTION;
            } else if (Number.isNaN(prevV) || prevV === CAUTION || drval1Num < prevV) {
                depareVerdict[idx] = drval1Num;
            }

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
                if (osmVouched) osmWaterCells[idx] = 1;
            }
        });
    }

    markPass('pass1-DEPARE', tPassDepare, depare.length);

    // ── Pass 1b: OSM canal LineStrings — carve navigable corridors ───
    // The inverse of the Pass 2b coastline strip. Each waterway=canal/
    // fairway/dock LineString (a dredged-channel centreline) is
    // Bresenham-rasterised as a 1-cell NAVIGABLE corridor: cells set to
    // a safe depth and flagged protected. Runs BEFORE Pass 2 (LNDARE),
    // Pass 2b (coastline) and Pass 6 (LNDARE buffer) so the protected
    // flag makes all three skip these cells — the corridor survives even
    // where chart LNDARE tessellates the canal banks as land.
    //
    // Newport Marina 2026-05-20: the marina basin polygon (OSM
    // leisure=marina) is captured as authoritative water, but the
    // ~600 m exit channel out to Hays Inlet is a waterway=canal
    // LineString. Without this pass it was dropped, the canal estate
    // was a 349-cell isolated component, and the origin tap snapped 2 km
    // out into Bramble Bay. Carving the channel connects the estate to
    // the bay so the route starts where the user actually tapped.
    const canalFeatures = layers.CANAL?.features ?? [];
    const tPassCanal = Date.now();
    const canalDepth = Math.max(draftM + safetyM, 5.0);
    for (const f of canalFeatures) {
        const g = f.geometry;
        if (!g) continue;
        let lineRings: Position[][] = [];
        if (g.type === 'LineString') lineRings = [(g as LineString).coordinates];
        else if (g.type === 'MultiLineString') lineRings = (g as MultiLineString).coordinates;
        else continue;
        for (const coords of lineRings) {
            for (let i = 0; i < coords.length - 1; i++) {
                const [lon0, lat0] = coords[i];
                const [lon1, lat1] = coords[i + 1];
                const gx0 = Math.floor((lon0 - minLon) / dLon);
                const gy0 = Math.floor((lat0 - minLat) / dLat);
                const gx1 = Math.floor((lon1 - minLon) / dLon);
                const gy1 = Math.floor((lat1 - minLat) / dLat);
                for (const c of bresenhamCells(gx0, gy0, gx1, gy1)) {
                    if (c.x < 0 || c.y < 0 || c.x >= width || c.y >= height) continue;
                    const idx = c.y * width + c.x;
                    // Carve to a safe navigable depth unless an earlier
                    // pass already claimed real (deeper) water here.
                    if (Number.isNaN(cells[idx]) || cells[idx] < 0 || cells[idx] === UNKNOWN_OPEN) {
                        cells[idx] = canalDepth;
                    }
                    protectedCells[idx] = 1;
                    osmWaterCells[idx] = 1; // OSM canal carve — keep clean under LNDARE
                    // NB: deliberately NOT flagged injectedCanal. The OSM carve is a
                    // thin 1-cell centreline that already routes fine and is baked
                    // into the threeTierNewport + seaway corpus baselines; only the
                    // WIDE Mapbox-water fill (which reads tier-2 + notnarrow) needs
                    // the tier-3 + forced-fine treatment.
                }
            }
        }
    }
    markPass('pass1b-canal', tPassCanal, canalFeatures.length);

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
            if (protectedCells[idx]) {
                // This cell was claimed as deep water by a DEPARE pass, yet a
                // chart LNDARE polygon also covers it. Two sub-cases:
                //   • OSM-vouched water (Newport canals, Brisbane River
                //     LNDARE-bleed) → trust OSM, keep clean navigable.
                //   • chart-S57-DEPARE only → the chart's own DEPARE and
                //     LNDARE layers DISAGREE here (typically a coarse
                //     overview-cell landmask bulging over a finer-survey deep
                //     channel — Tangalooma Roads off Moreton Island). Don't
                //     present confident clean water over charted land:
                //     downgrade to CAUTION so the renderer flags it red and
                //     A* only crosses it absent an all-water alternative.
                //     hardBlocked stays 0 so the route can still reach a
                //     destination that genuinely sits in such a conflict zone.
                if (osmWaterCells[idx] !== 1 && cells[idx] >= 0) {
                    cells[idx] = CAUTION;
                }
                return;
            }
            if (relaxedLndare || relaxMask[idx] === 1) {
                // CAUTION-mode: A* can traverse at 500× cost. Don't set
                // hardBlocked so FAIRWY/DRGARE rescue still applies.
                if (cells[idx] === UNKNOWN_OPEN) cells[idx] = CAUTION;
            } else {
                cells[idx] = BLOCKED;
                hardBlocked[idx] = 1;
                landBlocked[idx] = 1;
            }
        });
    }

    markPass('pass2-LNDARE', tPassLndare, lndare.length);

    // ── Pass 2b: OSM coastline (lines) — block the thin land/water boundary ─
    // Rasterises each natural=coastline LineString with Bresenham so cells
    // touched by the coast boundary are hardBlocked. Plugs gaps in chart
    // LNDARE polygons — Newport canal-estate islands have working chart
    // LNDARE for the suburb perimeter but no polygon for the small island
    // between the marina canal and Bramble Bay, so A* threaded straight
    // from the canal exit NE to the bay across "navigable" cells. With
    // the coastline strip blocked, the Bresenham line-of-sight check in
    // smoothPath now sees those cells as blocked and forces A* through
    // the actual canal/bay corridor.
    //
    // Same `protectedCells` guard as Pass 2 so engineered water
    // (leisure=marina, waterway=dock/canal) stays passable across a
    // coastline alignment mistake. Same relaxedLndare bypass so the
    // disconnected-destination retry isn't choked by coastline gaps.
    const coastline = layers.COASTLINE?.features ?? [];
    const tPassCoast = Date.now();
    let coastCellsBlocked = 0;
    for (const f of coastline) {
        const g = f.geometry;
        if (!g) continue;
        let lineRings: Position[][] = [];
        if (g.type === 'LineString') lineRings = [(g as LineString).coordinates];
        else if (g.type === 'MultiLineString') lineRings = (g as MultiLineString).coordinates;
        else continue;
        for (const coords of lineRings) {
            for (let i = 0; i < coords.length - 1; i++) {
                const [lon0, lat0] = coords[i];
                const [lon1, lat1] = coords[i + 1];
                const gx0 = Math.floor((lon0 - minLon) / dLon);
                const gy0 = Math.floor((lat0 - minLat) / dLat);
                const gx1 = Math.floor((lon1 - minLon) / dLon);
                const gy1 = Math.floor((lat1 - minLat) / dLat);
                for (const c of bresenhamCells(gx0, gy0, gx1, gy1)) {
                    if (c.x < 0 || c.y < 0 || c.x >= width || c.y >= height) continue;
                    const idx = c.y * width + c.x;
                    if (protectedCells[idx]) continue;
                    if (relaxedLndare || relaxMask[idx] === 1) {
                        if (cells[idx] === UNKNOWN_OPEN) cells[idx] = CAUTION;
                    } else {
                        cells[idx] = BLOCKED;
                        hardBlocked[idx] = 1;
                        landBlocked[idx] = 1;
                        coastCellsBlocked++;
                    }
                }
            }
        }
    }
    markPass('pass2b-coastline', tPassCoast, coastline.length);

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
        // Pair-wings (Step 4.5, masterplan Phase 3) travel in OBSTRN but are
        // NOT obstructions: Pass 5c rasterises them to CAUTION + preferred=0.
        // Hard-blocking them here would turn a mispair into no-path instead
        // of a red wiggle.
        if ((f.properties as { _class?: string } | null)?._class === 'pair-wing') return;
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
    let ribbonUnblockedCells = 0; // synthetic mark-ribbon cells un-blocked from LNDARE bleed (DEPARE-vouched)
    const markChannelPreference = (f: Feature): void => {
        if (!f.geometry || (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon')) return;
        const g = f.geometry as Polygon | MultiPolygon;
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
        //
        // EXTENSION (2026-05-19): OSM water polygons tagged `water=river`
        // or `harbour=yes` and wider than ~200 m are promoted to this
        // chart-authoritative class via `_promotePreferred` set in
        // InshoreRouter.ts. Without this, the Brisbane River shipping
        // channel cells (which sit inside an over-bleeding mainland
        // LNDARE polygon on the AU SENC) couldn't be rescued by their
        // own OSM water tag, and A* would route through Bramble Bay
        // shallows instead of along the river. The promotion is gated
        // on tag + minimum width to keep suburban ponds out.
        const props = f.properties as Record<string, unknown> | null;
        const isChartAuthoritative = typeof props?.acronym === 'string' || props?._promotePreferred === true;
        // The synthetic lateral-mark ribbon (chain-ordered port/starboard
        // midpoints from InshoreRouter Step 5). NOT a surveyed chart fairway,
        // so it must not fabricate depth. But where it overlaps cells the
        // chart's OWN DEPARE calls water, it restores that verdict to un-block
        // LNDARE *bleed* (the AU SENC blocks the bay channel under a coastal
        // land polygon) — the offline equivalent of a charted fairway. Cells
        // with no DEPARE coverage are real land and stay blocked.
        const isMarkRibbon = props?._class === 'synthetic-channel-segment';
        rasterizePolygonCells(grid, g, (x, y) => {
            const idx = y * width + x;
            preferred[idx] = 1;
            const blockedOrShallow = Number.isNaN(cells[idx]) || cells[idx] < 0;
            if (!blockedOrShallow) return;
            if (isMarkRibbon) {
                // Restore the chart's DEPARE verdict (real depth, or CAUTION
                // if genuinely shallow) ONLY where LNDARE bleed hard-blocked
                // charted water. No DEPARE here → real land → leave blocked.
                // Honest: a shallow marked channel stays CAUTION (red), it is
                // never fabricated into deep water.
                const v = depareVerdict[idx];
                if (hardBlocked[idx] === 1 && !Number.isNaN(v)) {
                    cells[idx] = v;
                    ribbonUnblockedCells++;
                }
                return;
            }
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
    if (ENGINE_DEBUG)
        engineLog.warn(
            `pass4: lateral-mark ribbon un-blocked ${ribbonUnblockedCells} LNDARE-bleed cells (DEPARE-vouched, honest depth)`,
        );

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

    // ── Pass 5b: OSM navigation lines → preferred channel corridor ───
    // Charted leading/transit lines (seamark navigation_line) are the
    // dredged-channel centreline ships steer along. Bresenham-rasterise
    // each into a ~3-cell-wide PREFERRED corridor and rescue shallow
    // (CAUTION) / unknown cells along it to navigable depth — so A* is
    // attracted onto the marked channel AND can ride it through bars the
    // 30 m bathymetry reads as too shallow. Never touches hardBlocked
    // (real land / charted hazard) cells. Runs after Pass 2 (LNDARE, so
    // hardBlocked is set) and before Pass 6 (buffer skips preferred cells,
    // so the corridor isn't sealed). The Brisbane River mouth bar is the
    // canonical case: the dredged cut isn't in chart FAIRWY and the
    // lateral markers are too sparse to stitch, but OSM has it as
    // navigation_line — without this the route cut a red CAUTION diagonal
    // straight across the bar instead of riding the channel.
    const navlineFeatures = layers.NAVLINE?.features ?? [];
    const tPassNavline = Date.now();
    const navDepth = Math.max(draftM + safetyM, 5.0);
    const NAVLINE_BRUSH_CELLS = 1; // 1-cell Chebyshev radius → ~3-cell (≈150 m) wide corridor
    let navlineCellsMarked = 0;
    const stampNavlineCell = (cx: number, cy: number): void => {
        for (let dy = -NAVLINE_BRUSH_CELLS; dy <= NAVLINE_BRUSH_CELLS; dy++) {
            for (let dx = -NAVLINE_BRUSH_CELLS; dx <= NAVLINE_BRUSH_CELLS; dx++) {
                const nx = cx + dx;
                const ny = cy + dy;
                if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                const idx = ny * width + nx;
                if (hardBlocked[idx] === 1) continue; // never carve real land
                preferred[idx] = 1; // attract A* onto the marked channel
                if (cells[idx] < 0 || cells[idx] === UNKNOWN_OPEN) {
                    // Rescue a shallow-reading (CAUTION) or unknown cell on
                    // the charted channel to navigable — the leading line
                    // IS the dredged deep water.
                    cells[idx] = navDepth;
                    navlineCellsMarked++;
                }
            }
        }
    };
    for (const f of navlineFeatures) {
        const g = f.geometry;
        if (!g) continue;
        let lineRings: Position[][] = [];
        if (g.type === 'LineString') lineRings = [(g as LineString).coordinates];
        else if (g.type === 'MultiLineString') lineRings = (g as MultiLineString).coordinates;
        else continue;
        for (const coords of lineRings) {
            for (let i = 0; i < coords.length - 1; i++) {
                const [lon0, lat0] = coords[i];
                const [lon1, lat1] = coords[i + 1];
                const gx0 = Math.floor((lon0 - minLon) / dLon);
                const gy0 = Math.floor((lat0 - minLat) / dLat);
                const gx1 = Math.floor((lon1 - minLon) / dLon);
                const gy1 = Math.floor((lat1 - minLat) / dLat);
                for (const c of bresenhamCells(gx0, gy0, gx1, gy1)) {
                    stampNavlineCell(c.x, c.y);
                }
            }
        }
    }
    markPass('pass5b-navline', tPassNavline, navlineFeatures.length);
    if (ENGINE_DEBUG && navlineFeatures.length > 0) {
        console.warn(
            `[inshoreEngine] NAVLINE: ${navlineFeatures.length} navigation lines → ${navlineCellsMarked} channel cells rescued/preferred`,
        );
    }

    // ── Pass 5c: pair-wings → outboard CAUTION ──────────────────────
    // Masterplan §3 Phase 3. Each accepted port/stbd pair carries two
    // `_class:'pair-wing'` rectangles extending OUTBOARD from its marks
    // (Step 4.5 in InshoreRouter; geometry in services/pairWings.ts —
    // matches the scorecard's audit wings). Rasterised to CAUTION +
    // preferred=0 so passing outside a mark costs 500× — the cost-level
    // encoding of "the gate is BETWEEN the marks".
    //
    // Ordering is load-bearing: AFTER Pass 5 marker radii and Pass 5b's
    // ribbon/navline rescue, so neither can re-clean a wing cell on
    // channels narrower than ~2× the preferred radius. Never touches
    // hardBlocked or NaN cells (a mispaired wing must degrade the route
    // to a red wiggle, not carve land or create no-path).
    const tPassWings = Date.now();
    let wingCellsMarked = 0;
    let wingFeatureCount = 0;
    for (const f of layers.OBSTRN?.features ?? []) {
        const props = f.properties as { _class?: string; _spine?: [number, number][] } | null;
        if (props?._class !== 'pair-wing') continue;
        const spine = props._spine;
        if (!spine || spine.length < 2) continue;
        wingFeatureCount++;
        // Stamp the wing's SPINE via Bresenham — the 30 m-wide polygon can
        // straddle zero cell centres on a 50–100 m grid, so the spine is the
        // rasterisation contract (same reasoning as the NAVLINE pass). But
        // only poison cells whose CENTRE is strictly OUTBOARD of the mark:
        // Bresenham's first cell contains the mark itself, and at 100 m
        // resolution that cell is often the gate's edge — stamping it
        // caution-stripes the very gate the wing exists to protect.
        const [markLon, markLat] = spine[0];
        const [endLon, endLat] = spine[spine.length - 1];
        const mPerLonW = M_PER_DEG_LAT * Math.cos((markLat * Math.PI) / 180);
        const wx = (endLon - markLon) * mPerLonW;
        const wy = (endLat - markLat) * M_PER_DEG_LAT;
        const wLen = Math.hypot(wx, wy);
        if (wLen < 1) continue;
        const uxW = wx / wLen;
        const uyW = wy / wLen;
        const gx0 = Math.floor((markLon - minLon) / dLon);
        const gy0 = Math.floor((markLat - minLat) / dLat);
        const gx1 = Math.floor((endLon - minLon) / dLon);
        const gy1 = Math.floor((endLat - minLat) / dLat);
        for (const c of bresenhamCells(gx0, gy0, gx1, gy1)) {
            if (c.x < 0 || c.y < 0 || c.x >= width || c.y >= height) continue;
            const idx = c.y * width + c.x;
            if (hardBlocked[idx] === 1 || Number.isNaN(cells[idx])) continue; // never touch land/blocked
            // Outboard test: project the cell CENTRE onto the wing axis.
            const cLon = minLon + (c.x + 0.5) * dLon;
            const cLat = minLat + (c.y + 0.5) * dLat;
            const s = (cLon - markLon) * mPerLonW * uxW + (cLat - markLat) * M_PER_DEG_LAT * uyW;
            if (s <= 0) continue; // centre inboard of (or at) the mark — the gate's own cell
            if (cells[idx] === CAUTION && preferred[idx] === 0) continue; // already stamped
            cells[idx] = CAUTION;
            preferred[idx] = 0;
            wingCellsMarked++;
        }
    }
    markPass('pass5c-wings', tPassWings, wingFeatureCount);
    if (ENGINE_DEBUG && wingFeatureCount > 0) {
        engineLog.warn(`pass5c: ${wingFeatureCount} pair-wings → ${wingCellsMarked} outboard CAUTION cells`);
    }

    // ── Pass 6: LNDARE 1-cell buffer ─────────────────────────────────
    // The scanline rasterizer marks cells whose centre is inside an
    // LNDARE polygon. Cells along the polygon boundary whose centre is
    // OUTSIDE but pixels overlap stay navigable — A* can then thread a
    // 50m water sliver hugging the coastline that visually looks like
    // crossing land (verified on AU OC-61-10ENB5 Newport → Pinkenba
    // 2026-05-19). Add a 1-cell skin so cells adjacent to any LNDARE-
    // blocked cell are also blocked.
    //
    // Runs LAST so `preferred` flags from FAIRWY/DRGARE (pass 4) and
    // marker-pair midpoints (pass 5) are already set — those cells are
    // skipped to keep charted channels open. Also skips real-depth cells
    // (chart DEPARE claimed them as deep water). Skipped entirely in
    // relaxedLndare mode where the whole point is to thread "land" cells.
    if (!relaxedLndare) {
        const tPassBuffer = Date.now();
        const lndareSeed = new Uint8Array(width * height);
        for (let i = 0; i < cells.length; i++) {
            if (hardBlocked[i] === 1) lndareSeed[i] = 1;
        }
        let bufferedCount = 0;
        for (let y = 0; y < height; y++) {
            for (let x = 0; x < width; x++) {
                const idx = y * width + x;
                if (lndareSeed[idx] === 1) continue;
                if (preferred[idx] === 1) continue;
                // Don't re-seal a localized relax corridor: cells inside a
                // relax zone are intentionally CAUTION (the barrier we're
                // threading red); buffering them shut would re-island the
                // far-snapped endpoint we're trying to reach.
                if (relaxMask[idx] === 1) continue;
                const prior = cells[idx];
                if (prior > 0) continue; // chart DEPARE-claimed deep water

                // 2026-05-20: also skip cells that are 8-adjacent to any
                // protectedCells (OSM marina/canal/water or chart S57
                // DEPARE). This dilates protection by one cell so that
                // narrow water passages at marina exits don't get sealed
                // by the buffer.
                //
                // The Newport Marina case: chart LNDARE tessellates the
                // canal banks at 50m resolution but the actual marina exit
                // channel is 60-100m wide. The OSM marina polygon protects
                // cells inside the marina basin, but cells just outside the
                // basin (the exit channel itself) are CAUTION water that
                // Pass 6 was buffering shut. Result: Newport canal interior
                // was a 349-cell isolated component, origin tap snapped 2 km
                // away to the big bay component, the visible route appeared
                // to start 2 km from where the user tapped.
                //
                // By exempting cells adjacent to protected ones, the
                // exit-channel buffer is suppressed and the canal connects
                // to the bay through its natural opening. Pass 2 LNDARE
                // still blocks the actual land cells unconditionally —
                // only the 1-cell skin around them is relaxed near
                // protected water.
                let adjacentToProtected = false;
                for (let dy = -1; dy <= 1 && !adjacentToProtected; dy++) {
                    for (let dx = -1; dx <= 1 && !adjacentToProtected; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                        if (protectedCells[ny * width + nx] === 1) adjacentToProtected = true;
                    }
                }
                if (adjacentToProtected) continue;

                let neighborBlocked = false;
                for (let dy = -1; dy <= 1 && !neighborBlocked; dy++) {
                    for (let dx = -1; dx <= 1 && !neighborBlocked; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
                        if (lndareSeed[ny * width + nx] === 1) neighborBlocked = true;
                    }
                }
                if (neighborBlocked) {
                    cells[idx] = BLOCKED;
                    hardBlocked[idx] = 1;
                    landBlocked[idx] = 1;
                    bufferedCount++;
                }
            }
        }
        markPass('pass6-LNDARE-buffer', tPassBuffer, bufferedCount);
    }

    // ── No-water-evidence mask (see NavGrid.unvouched) ───────────────
    // Computed AFTER every pass so any rescue/promotion above counts as
    // evidence. Derived purely from this build's inputs, so it caches
    // with the grid — no cache-key change.
    {
        const tPassUnvouched = Date.now();
        const unvouched = new Uint8Array(width * height);
        let unvouchedCount = 0;
        for (let idx = 0; idx < cells.length; idx++) {
            if (
                cells[idx] === UNKNOWN_OPEN &&
                preferred[idx] === 0 &&
                Number.isNaN(depareVerdict[idx]) &&
                osmWaterCells[idx] === 0 &&
                protectedCells[idx] === 0
            ) {
                unvouched[idx] = 1;
                unvouchedCount++;
            }
        }
        grid.unvouched = unvouched;
        markPass('unvouched-mask', tPassUnvouched, unvouchedCount);
    }
    // Narrow the injected-canal mask to the actual CHANNEL: keep only cells with
    // charted LAND (landBlocked, set by the LNDARE passes above) within
    // MARINA_NEAR_CELLS. A canal channel is bounded by the marina lots a cell or
    // two away; open bay in the ~4 km nearshore crop has land far off and is
    // dropped — so the canal's tier-3 span stays the channel, fits the fine length
    // cap, and the fine grid stays small. (No-op when no cell is near land, e.g.
    // a fully open crop, and on test/fixture grids with no injected cells.)
    const MARINA_NEAR_CELLS = 6; // ~300 m at 50 m: keeps the canal + immediate approach
    if (landBlocked.some((v) => v === 1)) {
        for (let idx = 0; idx < injectedCanalCells.length; idx++) {
            if (!injectedCanalCells[idx]) continue;
            const cx = idx % width;
            const cy = (idx / width) | 0;
            let nearLand = false;
            for (let dy = -MARINA_NEAR_CELLS; dy <= MARINA_NEAR_CELLS && !nearLand; dy++) {
                const ny = cy + dy;
                if (ny < 0 || ny >= height) continue;
                for (let dx = -MARINA_NEAR_CELLS; dx <= MARINA_NEAR_CELLS; dx++) {
                    const nx = cx + dx;
                    if (nx < 0 || nx >= width) continue;
                    if (landBlocked[ny * width + nx] === 1) {
                        nearLand = true;
                        break;
                    }
                }
            }
            if (!nearLand) injectedCanalCells[idx] = 0;
        }
    }
    // Ride the injected-canal mask on the grid (derived purely from this build's
    // inputs, like unvouched — no cache-key change). Tier-3 classification + the
    // forced fine pass read it.
    grid.injectedCanal = injectedCanalCells;

    // Per-pass breakdown — surfaces which polygon scanner is the hot
    // path. Format: pass=Nms(F features) so the eye can pair time
    // against feature count at a glance.
    const buildTotal = Date.now() - buildT0;
    const breakdown = Object.entries(passTimings)
        .map(([k, v]) => `${k}=${v}ms(${featureCounts[k]}f)`)
        .join(' ');
    if (ENGINE_DEBUG)
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

/** Exported for the heap-invariant unit test (tests/minHeap.test.ts) —
 *  the 2026-06-11 sinkDown bug silently degraded every A* route. */
export class MinHeap {
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
        // Hole pattern: children are hoisted up and `item` is placed last, so
        // every comparison must be against ITEM's priority — never against
        // this.a[i], which after the first hoist holds the hoisted child.
        // (The old version compared a[smallest] with smallest=i: the loop
        // terminated early and `item` landed above smaller children, breaking
        // the heap invariant — A* popped non-minimal nodes and returned
        // measurably suboptimal routes. Found 2026-06-11 via the seamanship
        // fixtures: 289,493 m-eq path on a grid with a 73,048 m-eq optimum.)
        while (true) {
            const l = 2 * i + 1;
            const r = 2 * i + 2;
            let smallest = -1;
            let smallestF = item.f;
            if (l < n && this.a[l].f < smallestF) {
                smallest = l;
                smallestF = this.a[l].f;
            }
            if (r < n && this.a[r].f < smallestF) {
                smallest = r;
            }
            if (smallest === -1) break;
            this.a[i] = this.a[smallest];
            i = smallest;
        }
        this.a[i] = item;
    }
}

// ── A* ───────────────────────────────────────────────────────────────

/** Metres-equivalent surcharge for stepping OFF a preferred corridor
 *  (preferred=1 → preferred=0). Wired through aStar AND chainCostM so the
 *  search and the smoothing price edges identically. 0 = inert; flipped to
 *  the masterplan Phase 3 value (250) in its own knob commit. */
export const EXIT_PENALTY_M = 250;

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
export function cellCostMultiplier(depth: number, preferred: boolean): number {
    // Cells inside a marked fairway / dredged area always get the
    // baseline cost regardless of depth band — that's how we get
    // A* to follow the channel instead of cutting across deeper
    // open water nearby.
    //
    // 2026-05-20: tried depth-grading this (deep 1.0× / shallow 2.5×) to
    // make A* ride the deep dredged centre. It BACKFIRED — the Brisbane
    // shipping channel reads as 2 m in the 30 m bathymetry, so penalising
    // shallow preferred cells pushed A* OFF the channel onto a coast-
    // hugging path with more caution (Shane: "brisbane end it hugging the
    // coast now, it is not right"). The real lever is the vessel draft
    // (it was coming through at 0.914 m / 3 ft, far too shallow for a
    // 55' Tayana, so everything reads navigable) + FAIRWY coverage, NOT
    // cost tuning. Reverted to flat 1.0×.
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
    //
    // RETUNED 5/6/8 → 4/4.8/6.4 (2026-06-12, the Phase 3b bundle's one
    // knob, swept with the scorecard — ROUTING_COLLAB replies 12–13).
    // The 5× era was partly masked by the cost-blind smoother erasing
    // corridor detours; once smoothing/centerline became cost-no-worse,
    // honest geometry exposed 5× as over-aggressive (Tangalooma golden
    // +21%). Sweep at {2.5, 3, 4, 5} × all fixtures + goldens:
    //   2.5 → gate-shortcut un-flips (0/5 gates);
    //   3   → staggered ≥90% discipline un-flips (79.7);
    //   4   → ALL flips hold (GS 5/5, STAG 92.6, MID 10/11) and
    //         Tangalooma settles at +14.5% (18.43 NM) vs +21% at 5×;
    //   5   → same flips, Tangalooma +21%.
    // 4 is the smallest value that keeps every seamanship flip.
    if (depth >= 10) return 4.0;
    if (depth >= 5) return 4.8;
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
    if (depth > 0) return 6.4;
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
 *
 * Exported for the Phase 11 connector parity fixture (K independent A*
 * runs are the reference the multi-target search must match within 1%).
 * `stats.popped`, when supplied, counts heap pops — the deterministic
 * latency proxy the fixture asserts on (wall-clock flakes in CI).
 */
export function aStar(
    grid: NavGrid,
    start: { x: number; y: number },
    end: { x: number; y: number },
    stats?: { popped: number },
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
        if (stats) stats.popped++;
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
        const curPreferred = grid.preferred[idx] === 1;

        for (let n = 0; n < NEIGHBORS.length; n++) {
            const { dx, dy } = NEIGHBORS[n];
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            const nIdx = ny * w + nx;
            const cellDepth = grid.cells[nIdx];
            if (Number.isNaN(cellDepth)) continue; // blocked

            const cellPreferred = grid.preferred[nIdx] === 1;
            // Corridor-exit surcharge (additive ≥0 → the distance heuristic
            // stays admissible; cellCostMultiplier untouched, flat-preferred
            // doctrine preserved). See EXIT_PENALTY_M.
            const exitPenalty = curPreferred && !cellPreferred ? EXIT_PENALTY_M : 0;
            const tentativeG = curG + stepLengthsM[n] * cellCostMultiplier(cellDepth, cellPreferred) + exitPenalty;
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
 * Total traversal cost (metres-equivalent) of a chain of 8-neighbour grid
 * cells, priced EXACTLY like A*'s neighbour expansion: step length ×
 * destination-cell multiplier, plus EXIT_PENALTY_M on every
 * preferred→non-preferred transition. Used by smoothPath's cost-no-worse
 * rule and the marina-centerline acceptance gate, so no post-A* refinement
 * can silently undo a cost-optimal detour.
 */
export function chainCostM(grid: NavGrid, chain: { x: number; y: number }[]): number {
    const mPerLonG = M_PER_DEG_LAT * Math.cos(((grid.minLat + (grid.height * grid.dLat) / 2) * Math.PI) / 180);
    const stepLonM = grid.dLon * mPerLonG;
    const stepLatM = grid.dLat * M_PER_DEG_LAT;
    let cost = 0;
    for (let i = 1; i < chain.length; i++) {
        const dx = Math.abs(chain[i].x - chain[i - 1].x);
        const dy = Math.abs(chain[i].y - chain[i - 1].y);
        const stepM = Math.hypot(dx * stepLonM, dy * stepLatM);
        cost += stepM * cellCostAt(grid, chain[i].x, chain[i].y);
        const fromPref = grid.preferred[chain[i - 1].y * grid.width + chain[i - 1].x] === 1;
        const toPref = grid.preferred[chain[i].y * grid.width + chain[i].x] === 1;
        if (fromPref && !toPref) cost += EXIT_PENALTY_M;
    }
    return cost;
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
    // Prefix sums of the path's TRUE cost, so any subpath's cost is O(1).
    // A chord may only replace a subpath when the chord's own cost is no
    // worse — without this, a route whose ENDS sit in expensive open water
    // (budget = max(endpoints)) could have its entire cost-optimal channel
    // detour collapsed into a straight expensive chord, silently undoing the
    // gate-following A* just paid for. (Found 2026-06-11 calibrating the
    // Phase 3 gate-shortcut fixture: A* threaded the marked dog-leg; the
    // smoother returned the straight line. Landed per ROUTING_COLLAB
    // reply 13 — a correctness fix under the geometry-is-the-law doctrine.)
    const prefix: number[] = [0];
    for (let k = 1; k < path.length; k++) {
        prefix.push(prefix[k - 1] + chainCostM(grid, [path[k - 1], path[k]]));
    }
    const out: { x: number; y: number }[] = [path[0]];
    let i = 0;
    while (i < path.length - 1) {
        let j = path.length - 1;
        // Linear scan from the back is cheap because clears happen
        // most of the time on long open stretches.
        while (j > i + 1) {
            if (lineOfSightClear(grid, path[i], path[j])) {
                const chord = Array.from(bresenhamCells(path[i].x, path[i].y, path[j].x, path[j].y));
                const chordCost = chainCostM(grid, chord);
                if (chordCost <= (prefix[j] - prefix[i]) * 1.0001 + 1e-6) break;
            }
            j--;
        }
        out.push(path[j]);
        i = j;
    }
    return out;
}

// ── Fairing across midpoint-disc sequences ──────────────────────────

/** Bounded cost give-back for fairing: a chord may replace a subpath
 *  costing up to this factor LESS — the explicit, documented carve-out
 *  from smoothPath's cost-no-worse rule, safe because the gate-serving
 *  test below makes wrong-siding structurally impossible. Calibrated on
 *  the stepping fixture (bead-hop ratios ≈ 1.12-1.15); the gate-shortcut
 *  dog-leg's erase ratio is ≥ ~3×, far outside it. */
const FAIRING_MAX_COST_FACTOR = 1.25;
/** A faired chord must pass within this fraction of each served gate's
 *  half-width — margin against 50 m cell quantisation. */
const FAIRING_GATE_FRACTION = 0.9;

export interface FairingMidpoint {
    lat: number;
    lon: number;
    halfWidthM: number;
}

/** The Pass-5 channel midpoints (orchestrator Step 4) with their real
 *  gate half-widths — the fairing pass's gate-serving truth. */
function collectFairingMidpoints(layers: InshoreLayers): FairingMidpoint[] {
    const out: FairingMidpoint[] = [];
    const scan = (features: unknown[] | undefined): void => {
        for (const f of (features ?? []) as Array<{
            geometry?: { type?: string; coordinates?: [number, number] } | null;
            properties?: { _class?: string; _pairDistanceM?: number } | null;
        }>) {
            if (f.properties?._class !== 'channel_midpoint') continue;
            const pairDistM = f.properties._pairDistanceM;
            if (typeof pairDistM !== 'number' || pairDistM <= 0) continue;
            if (f.geometry?.type !== 'Point' || !Array.isArray(f.geometry.coordinates)) continue;
            const [lon, lat] = f.geometry.coordinates;
            out.push({ lat, lon, halfWidthM: pairDistM / 2 });
        }
    };
    scan(layers.BOYLAT?.features as unknown[]);
    scan(layers.BCNLAT?.features as unknown[]);
    return out;
}

/**
 * Collapse waypoint subpaths to chords across midpoint-disc sequences
 * (the marker-stepping fix — see the call site for doctrine). Greedy
 * longest-chord like smoothPath; a chord is accepted only when
 *   (a) every chord cell is navigable, non-caution, and not excluded
 *       (strict no-evidence cells via `isExcluded`);
 *   (b) every midpoint the SUBPATH served (within its own half-width)
 *       is still within FAIRING_GATE_FRACTION × half-width of the chord;
 *   (c) chordCost ≤ subpathCost × FAIRING_MAX_COST_FACTOR.
 */
export function fairPath(
    grid: NavGrid,
    chain: { x: number; y: number }[],
    midpoints: FairingMidpoint[],
    isExcluded: (idx: number) => boolean,
): { x: number; y: number }[] {
    if (chain.length < 3) return chain;
    const mPerLonG = mPerDegLon(grid.minLat + (grid.height * grid.dLat) / 2);
    // Cell side in metres — the grid's resolvable precision. Used to floor
    // the gate-serving tolerance below (sub-grid gates carry no side the
    // raster can express). Mirrors line ~2437 (tryMarinaCenterline).
    const gridResM = grid.dLat * M_PER_DEG_LAT;
    const toLL = (c: { x: number; y: number }): [number, number] => [
        grid.minLon + (c.x + 0.5) * grid.dLon,
        grid.minLat + (c.y + 0.5) * grid.dLat,
    ];
    const distToSegM = (m: FairingMidpoint, a: [number, number], b: [number, number]): number => {
        const ax = (a[0] - m.lon) * mPerLonG;
        const ay = (a[1] - m.lat) * M_PER_DEG_LAT;
        const bx = (b[0] - m.lon) * mPerLonG;
        const by = (b[1] - m.lat) * M_PER_DEG_LAT;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 > 0 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
        return Math.hypot(ax + dx * t, ay + dy * t);
    };
    const distToChainM = (m: FairingMidpoint, lo: number, hi: number): number => {
        let best = Infinity;
        for (let k = lo; k < hi; k++) {
            const d = distToSegM(m, toLL(chain[k]), toLL(chain[k + 1]));
            if (d < best) best = d;
        }
        return best;
    };
    const chordClear = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => {
        for (const c of bresenhamCells(a.x, a.y, b.x, b.y)) {
            const idx = c.y * grid.width + c.x;
            const d = grid.cells[idx];
            if (Number.isNaN(d) || d < 0 || isExcluded(idx)) return false;
        }
        return true;
    };
    const prefix: number[] = [0];
    for (let k = 1; k < chain.length; k++) {
        prefix.push(prefix[k - 1] + chainCostM(grid, [chain[k - 1], chain[k]]));
    }

    const out: { x: number; y: number }[] = [chain[0]];
    let i = 0;
    while (i < chain.length - 1) {
        let j = chain.length - 1;
        for (; j > i + 1; j--) {
            if (!chordClear(chain[i], chain[j])) continue;
            const chord = Array.from(bresenhamCells(chain[i].x, chain[i].y, chain[j].x, chain[j].y));
            const chordCost = chainCostM(grid, chord);
            if (chordCost > (prefix[j] - prefix[i]) * FAIRING_MAX_COST_FACTOR + 1e-6) continue;
            // Gate-serving: every midpoint the subpath served must stay
            // served by the chord.
            const a = toLL(chain[i]);
            const b = toLL(chain[j]);
            let serves = true;
            for (const m of midpoints) {
                if (distToChainM(m, i, j) > m.halfWidthM) continue; // subpath didn't serve it
                // Sub-grid gates (half-width < cell) can't be sided more
                // tightly than the raster resolves, so floor the serving
                // tolerance at half a cell. INERT for resolvable gates
                // (half-width ≥ ~gridResM/1.8 keeps the tight 0.9 guard),
                // so wrong-siding stays impossible — see fairing-subgrid
                // fixture + reply 30 proof.
                const tolM = Math.max(m.halfWidthM * FAIRING_GATE_FRACTION, gridResM * 0.5);
                if (distToSegM(m, a, b) > tolM) {
                    serves = false;
                    break;
                }
            }
            if (serves) break;
        }
        out.push(chain[j]);
        i = j;
    }
    return out;
}

// ── Marina-centerline refinement (MarinerEE port) ───────────────────
//
// Re-routes a CLEAN-water A* corridor with the centerline pipeline
// (services/marinaCenterline.ts): rides mid-channel with keel clearance
// and comes out as straight legs. Used only when the A* corridor has no
// caution cells — the marina/canal/clean-bay case — so marginal-water
// routes that must stay RED (the Brisbane bar) keep their tuned path.
// Returns the centerline waypoints (cells), or null to fall back to
// smoothPath (over-eroded / disconnected at the keel margin / leg
// validation failed → never fabricate, always defer to the proven A*).

/** Keel-clearance margin in cells, derived from the grid resolution.
 *  Target ~5 m off a wall (the spike's 3 px ≈ 5 m), min 1 cell so even a
 *  coarse grid keeps the route off the immediate bank. */
function keelCellsFor(resolutionM: number): number {
    const KEEL_M = 5;
    return Math.max(1, Math.round(KEEL_M / Math.max(1, resolutionM)));
}

/**
 * Clearance-aware Douglas-Peucker for the marina centerline. Collapses a
 * run of cells to a straight chord ONLY when that chord (a) stays within
 * tolerance of every intermediate point AND (b) crosses no land/caution
 * cell. So grid stair-steps on the straights flatten to clean diagonals,
 * but a corner — even a gentle one whose apex sits within the tolerance —
 * is never shaved, because the shortcut chord would clip the bank and the
 * clearance test forces the split. Operates in CELL space.
 */
function simplifyMarinaCells(cells: { x: number; y: number }[], grid: NavGrid): { x: number; y: number }[] {
    if (cells.length < 3) return cells.slice();
    const TOL = 1.6; // cells — generous; the clearance check is the safety net
    const chordClear = (a: { x: number; y: number }, b: { x: number; y: number }): boolean => {
        for (const c of bresenhamCells(a.x, a.y, b.x, b.y)) {
            const d = grid.cells[c.y * grid.width + c.x];
            if (Number.isNaN(d) || d < 0) return false;
        }
        return true;
    };
    const out: { x: number; y: number }[] = [];
    const rec = (lo: number, hi: number): void => {
        if (hi <= lo + 1) {
            out.push(cells[lo]);
            return;
        }
        const a = cells[lo];
        const b = cells[hi];
        let maxDev = 0;
        let idx = lo;
        for (let i = lo + 1; i < hi; i++) {
            const dev = perpendicularDistanceDeg([cells[i].x, cells[i].y], [a.x, a.y], [b.x, b.y]);
            if (dev > maxDev) {
                maxDev = dev;
                idx = i;
            }
        }
        if (maxDev <= TOL && chordClear(a, b)) {
            out.push(cells[lo]); // chord is safe + straight enough → drop the middle
        } else {
            rec(lo, idx);
            rec(idx, hi);
        }
    };
    rec(0, cells.length - 1);
    out.push(cells[cells.length - 1]);
    return out;
}

function tryMarinaCenterline(
    grid: NavGrid,
    start: { x: number; y: number },
    end: { x: number; y: number },
): { x: number; y: number }[] | null {
    // Actual metres-per-cell from the built grid (req.resolutionM is
    // optional; the grid's dLat is the ground truth).
    const resolutionM = grid.dLat * M_PER_DEG_LAT;
    // Build a depth array for the centerline pass: only CONFIDENT water is
    // navigable. NaN (land/hazard) and negative (CAUTION) → blocked; 0
    // (unknown/open) → nominal 1 m; positive → charted depth. Caution is
    // blocked here because the centerline route is the "clean" route; any
    // route that needs to touch caution water stays on the A* path with
    // its red flags.
    const n = grid.width * grid.height;
    const depth = new Float32Array(n);
    for (let i = 0; i < n; i++) {
        const d = grid.cells[i];
        depth[i] = Number.isNaN(d) || d < 0 ? NaN : d === 0 ? 1.0 : d;
    }

    const result = routeMarina(depth, { width: grid.width, height: grid.height }, start as Cell, end as Cell, {
        keelCells: keelCellsFor(resolutionM),
        depthWeight: 15.0,
        canalHalfWidthCells: 12,
        bias: 5.0,
    });
    if (!result) return null;

    // Return the raw mid-channel centerline CELLS, not routeMarina's
    // string-pulled waypoints. The engine's downstream Douglas-Peucker
    // (¼-cell tolerance) simplifies these shape-preservingly — straight
    // legs on straight runs — but, unlike the greedy line-of-sight
    // string-pull, it NEVER shortcuts across a bend's inside corner (which
    // shaved the canal corners). The cells all sit in the keel-eroded graph
    // by construction; belt-and-braces check that none is land/caution.
    const cells = result.cells;
    for (const c of cells) {
        const d = grid.cells[c.y * grid.width + c.x];
        if (Number.isNaN(d) || d < 0) return null;
    }
    // De-staircase BEFORE returning, but CLEARANCE-AWARE so it never shaves
    // a corner. The raw centerline steps N/S/E/W (a "staticy" stairstep on
    // diagonals); plain Douglas-Peucker smooths it but at a tolerance loose
    // enough to remove the stairs it ALSO cuts a gentle bend whose apex sits
    // within tolerance. simplifyMarinaCells collapses a stair-run to a
    // straight chord ONLY when that chord stays in clear water — any chord
    // that would clip land/caution is split and kept. Clean diagonals on the
    // straights, every corner honoured.
    return simplifyMarinaCells(cells, grid);
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

/** @internal exported for the douglas-peucker termination regression test. */
export function douglasPeucker(
    points: [number, number][],
    toleranceDeg: number,
    /** Optional land guard: returns true if the straight chord a→b crosses
     *  land. When it does, the span is NOT collapsed — the bend vertices are
     *  kept — so the simplifier can never cut a chord across a canal bank (the
     *  Newport canal-bend corner-clip, 2026-06-18). */
    chordCrossesLand?: (a: [number, number], b: [number, number]) => boolean,
): [number, number][] {
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
    // Recurse ONLY on a geometric split. maxD > tol guarantees idx ≥ 1, so both
    // sub-slices strictly shrink and the recursion always terminates. (The land
    // guard must NEVER gate this branch: on a near-straight chord that merely
    // nicks a land cell, maxD is ~0 and idx stays 0, so points.slice(idx) ===
    // points.slice(0) — the same array — and the right branch recurses on itself
    // forever → stack overflow → the engine throws → the passage falls through to
    // the "route too short" bail. That was the 2026-06-18 canal regression.)
    if (maxD > toleranceDeg) {
        const left = douglasPeucker(points.slice(0, idx + 1), toleranceDeg, chordCrossesLand);
        const right = douglasPeucker(points.slice(idx), toleranceDeg, chordCrossesLand);
        return left.slice(0, -1).concat(right);
    }
    // Geometry says collapse to the chord — but never collapse a chord that
    // cuts across a canal bank. Keep every vertex (no recursion, terminates).
    if (chordCrossesLand?.(points[0], points[points.length - 1])) {
        return points.slice();
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
/** Grid overrides for the fine marina pass (two-tier routing). When set,
 *  force a specific cell size + a fixed padding (small bbox) instead of the
 *  defaults — used to resolve narrow canals the 50 m main grid can't. */
interface GridOverride {
    resolutionM: number;
    padDeg: number;
}

function routeInshoreMain(
    layers: InshoreLayers,
    req: RouteRequest,
    gridOverride?: GridOverride,
): RouteResult | RouteFailure {
    // Try strict first — LNDARE blocks land. With proper ring assembly
    // (Eulerian/linear-chain fix landed 2026-05-19) this gives accurate
    // results for most routes. But certain charts represent rivers as
    // "inside" a giant mainland LNDARE polygon with no inner-ring hole
    // (verified on AU OC-61-351824 rcid 4500: Brisbane mainland is one
    // 3503-vert polygon, no holes — the river course is inside it). For
    // destinations inside such polygons, retry with LNDARE relaxed to
    // CAUTION (cost 500× water). A* prefers actual water cells massively
    // over caution, so it won't cross real land masses — only the
    // chart-says-land-but-really-water river/harbour interior cells get
    // traversed, flagged red in the polyline so the user verifies.
    const strict = routeInshoreOnce(layers, req, false, [], gridOverride);
    if ('error' in strict) {
        if (strict.code !== 'destination-disconnected') return strict;
        // Last resort: strict found NO path because the destination is
        // inside a giant mainland LNDARE with no inner-ring hole. Relax
        // GRID-WIDE — A* still prefers real water (8×) over relaxed land
        // (40×), so it only crosses land where no water route exists at
        // all. This is the only place we relax globally; the far-snap
        // path below uses bounded zones instead.
        console.warn(
            '[inshoreEngine] strict pass failed destination-disconnected — retrying with LNDARE relaxed grid-wide to CAUTION (last resort)',
        );
        return routeInshoreOnce(layers, req, true, [], gridOverride);
    }

    // Strict succeeded — but did it start/end where the user actually
    // tapped? When an endpoint sits in a pocket cut off from the routable
    // water body (Newport Marina's shallow canal estate, a drying inlet),
    // the shared-component snap silently drags that endpoint to the
    // nearest big-water cell — Newport snaps the origin ~2 km out into
    // Bramble Bay, so the visible route starts 2 km from the berth and
    // the impassable stretch is hidden in an invisible bridge segment.
    //
    // Honest fix (Shane's call 2026-05-20): if an endpoint snapped far,
    // retry with LNDARE relaxed to CAUTION — but ONLY inside a bounded
    // zone around that endpoint's tap, NOT grid-wide. The first cut at
    // this relaxed the whole grid; A* then found cheaper CAUTION (40×)
    // shortcuts straight across the mainland mid-route and the route
    // crossed land (verified 2026-05-20: "that went sideways. it crossed
    // land"). Confining relaxation to a circle around the problem
    // endpoint lets A* thread the local barrier — which the polyline
    // flags in cautionMask and the renderer draws RED as a "verify
    // pilotage / your draft won't clear this" warning — while every
    // mid-route mainland cell stays hard-blocked, so the route cannot
    // shortcut across land. No fake deep water is carved; the marginal
    // barrier is shown honestly in red.
    //
    // The zone radius scales with how far the endpoint snapped (the
    // barrier is at least that wide) plus margin, capped at 4 km so the
    // relaxed region never spans far enough to reach a competing water
    // body that would let A* shortcut. We only relax around an endpoint
    // that actually snapped far — a well-connected endpoint (Rivergate
    // dest snapped 3 m) gets no zone.
    const FAR_SNAP_M = 500;
    const originSnapM = strict.debug?.originSnap?.snapDistanceM ?? 0;
    const destSnapM = strict.debug?.destinationSnap?.snapDistanceM ?? 0;
    const zoneRadiusFor = (snapM: number): number => Math.min(snapM * 1.5 + 500, 4000);
    const relaxZones: RelaxZone[] = [];
    if (originSnapM > FAR_SNAP_M) {
        relaxZones.push({ lat: req.fromLat, lon: req.fromLon, radiusM: zoneRadiusFor(originSnapM) });
    }
    if (destSnapM > FAR_SNAP_M) {
        relaxZones.push({ lat: req.toLat, lon: req.toLon, radiusM: zoneRadiusFor(destSnapM) });
    }
    if (relaxZones.length === 0) return strict;

    const strictWorstSnapM = Math.max(originSnapM, destSnapM);
    console.warn(
        `[inshoreEngine] endpoint snapped far (origin ${Math.round(originSnapM)}m / dest ${Math.round(destSnapM)}m) — retrying with ${relaxZones.length} localized relax zone(s) so the route starts at the real berth (barrier shown red, mainland stays blocked)`,
    );
    const relaxed = routeInshoreOnce(layers, req, false, relaxZones, gridOverride);
    if ('error' in relaxed) return strict;
    const relaxedWorstSnapM = Math.max(
        relaxed.debug?.originSnap?.snapDistanceM ?? Infinity,
        relaxed.debug?.destinationSnap?.snapDistanceM ?? Infinity,
    );
    // Require a meaningful improvement (≥200 m) before swapping, so we
    // don't trade an all-real-water route for a red-flagged one on a tie.
    if (relaxedWorstSnapM < strictWorstSnapM - 200) {
        console.warn(
            `[inshoreEngine] localized-relaxed route starts ${Math.round(relaxedWorstSnapM)}m from tap (vs ${Math.round(strictWorstSnapM)}m strict) — using relaxed, barrier flagged red`,
        );
        return relaxed;
    }
    return strict;
}

/**
 * Public inshore router — TWO-TIER.
 *
 * 1. MAIN pass: routeInshoreMain at the default 50 m grid + full padding.
 *    Carries all the tuned logic (strict/relax retries, far-snap zones, red
 *    caution-flagging) and is the GUARANTEED result / fallback.
 * 2. FINE pass (short routes only): re-route on a small fine-resolution grid
 *    (~10 m, tight padding) so narrow marina/canal channels — which a 50 m
 *    cell is too coarse to resolve — come out mid-channel and clean (the
 *    MarinerEE marina-centerline then fires inside it). Used ONLY if it
 *    VALIDATES against the main route (fineRefinementIsBetter): no endpoint
 *    snaps further (the disconnection/dead-end signature), no new caution,
 *    no wild detour. Otherwise we keep the main route.
 *
 * Worst case = the main 50 m route (today's 99/100). The fine pass can only
 * improve the canal detail, never break the route — the failure mode that
 * bit the earlier single-grid attempt (reverted 765046b3) is caught by the
 * validation and falls back here.
 */
/** Coarse pre-check resolution (reply 19 fix 3). */
const COARSE_PRECHECK_RES_M = 400;

export function routeInshore(layers: InshoreLayers, req: RouteRequest): RouteResult | RouteFailure {
    const spanDeg = Math.max(Math.abs(req.toLat - req.fromLat), Math.abs(req.toLon - req.fromLon));

    // ── Strict coarse pre-check (field hang 2026-06-12, reply 19) ────
    // A strict 'uncharted-corridor' refusal used to pay the full fine
    // grid build + A* (20-47 s SYNCHRONOUS on device) before saying no —
    // with stale/missing cells, the commonest outcome froze the UI
    // longest. Run the same pipeline on a 400 m grid first (≈64× fewer
    // cells, sub-second). Conservative-correct direction: a coarse cell
    // is vouched if ANY evidence touches it, so coarse unvouched runs
    // are a subset of fine ones and a coarse refusal implies the fine
    // pass would refuse too. Pathological exception accepted: a charted
    // ribbon narrower than 400 m flanked by void can close at coarse
    // resolution — implying confidence through that is what honest-red
    // exists to prevent. Any OTHER coarse failure (no-path etc.) is
    // ignored: coarse topology is unreliable for success, only the
    // unvouched measure is trusted.
    if (req.unchartedPolicy === 'strict' && spanDeg > 0.02 && (req.resolutionM ?? 50) < COARSE_PRECHECK_RES_M) {
        const coarse = routeInshoreMain(layers, req, {
            resolutionM: COARSE_PRECHECK_RES_M,
            padDeg: Math.max(spanDeg * 0.5, 0.08),
        });
        if ('error' in coarse && coarse.code === 'uncharted-corridor') {
            coarse.debug = { ...(coarse.debug as RouteDebug), coarsePrecheck: true } as RouteDebug;
            return coarse;
        }
    }

    const main = routeInshoreMain(layers, req);
    if ('error' in main) return main;

    // Long routes already route fine at 50 m, and a fine grid over their
    // span would blow up the cell count — only short (marina/canal-scale)
    // routes get the fine pass. A caller that pinned resolutionM keeps it.
    if (spanDeg >= 0.06 || req.resolutionM) return main; // 0.06° ≈ 3.5 NM

    const fine = routeInshoreMain(layers, req, { resolutionM: 10, padDeg: 0.008 });
    if ('error' in fine) return main;

    if (fineRefinementIsBetter(fine, main, req)) {
        if (ENGINE_DEBUG)
            engineLog.warn(
                `two-tier: fine marina pass accepted (${fine.gridSize.width}x${fine.gridSize.height}, ${fine.polyline.length} pts) over main (${main.gridSize.width}x${main.gridSize.height}, ${main.polyline.length} pts)`,
            );
        fine.debug = { ...(fine.debug as RouteDebug), twoTierFine: true } as RouteDebug;
        return fine;
    }
    return main;
}

/** Accept the fine marina route only if it's at least as safe as the main
 *  route AND doesn't dead-end short of where the user tapped. Because both
 *  routes splice the input coords as their visible endpoints, truncation
 *  shows up as a larger SNAP distance (the real water ends far from the tap
 *  with a bridge segment), not in the polyline ends — so we gate on that. */
function fineRefinementIsBetter(fine: RouteResult, main: RouteResult, _req: RouteRequest): boolean {
    const SNAP_TOL_M = 200;
    const worseSnap = (f?: number, m?: number): boolean => (f ?? 0) > (m ?? 0) + SNAP_TOL_M;
    // 1. No endpoint snapped meaningfully FURTHER than main — the fine grid
    //    disconnecting a narrow canal snaps the endpoint deep into the
    //    estate (the truncation/dead-end signature). Reject that.
    if (worseSnap(fine.debug?.originSnap?.snapDistanceM, main.debug?.originSnap?.snapDistanceM)) return false;
    if (worseSnap(fine.debug?.destinationSnap?.snapDistanceM, main.debug?.destinationSnap?.snapDistanceM)) return false;
    // 2. No NEW caution — never trade an all-clean route for a red-flagged one.
    const fineCaution = (fine.cautionMask ?? []).filter(Boolean).length;
    const mainCaution = (main.cautionMask ?? []).filter(Boolean).length;
    if (fineCaution > mainCaution) return false;
    // 3. Not a wild detour — much longer than main means it wandered.
    if (fine.distanceNM > main.distanceNM * 1.5 + 0.1) return false;
    return true;
}

function routeInshoreOnce(
    layers: InshoreLayers,
    req: RouteRequest,
    relaxedLndare: boolean,
    relaxZones: RelaxZone[] = [],
    gridOverride?: GridOverride,
): RouteResult | RouteFailure {
    const safetyM = req.safetyM ?? 1.0;
    const resolutionM = gridOverride?.resolutionM ?? req.resolutionM ?? 50;
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
    // 2026-05-19: bumped multiplier 0.25→0.5 and floor 0.05→0.08. The
    // Newport→Pinkenba route was hitting the grid's east edge at exactly
    // Luggage Point (Brisbane River mouth, lon ~153.18). The corridor
    // east of Fisherman Islands that links north Moreton Bay to the
    // river fell outside the grid, leaving the bay and river as two
    // disconnected components (74,357 cells north / 4,592 cells south)
    // with origin reaching only the north and destination only the
    // south. The visible "route through the airport" was just the
    // post-snap bridge segment. With 0.5×, this Newport route gets
    // ~0.10° (~11 km) lateral padding — enough to include the corridor
    // east of Fisherman Islands so the components merge.
    //
    // Short routes (maxSpan ≤ 0.16°) still hit the 0.08° floor; not
    // dramatically larger than before but a touch more breathing room
    // for marina exits.
    const minLat = Math.min(req.fromLat, req.toLat);
    const maxLat = Math.max(req.fromLat, req.toLat);
    const minLon = Math.min(req.fromLon, req.toLon);
    const maxLon = Math.max(req.fromLon, req.toLon);
    const maxSpan = Math.max(maxLat - minLat, maxLon - minLon);
    // Fine marina pass forces a small fixed padding (tight bbox keeps the
    // fine-cell count bounded); otherwise the tuned generous padding.
    const padLat = gridOverride ? gridOverride.padDeg : Math.max(maxSpan * 0.5, 0.08);
    const padLon = gridOverride ? gridOverride.padDeg : Math.max(maxSpan * 0.5, 0.08);
    const bbox: [number, number, number, number] = [minLon - padLon, minLat - padLat, maxLon + padLon, maxLat + padLat];

    let tPhase = Date.now();
    const { grid, cacheHit: gridCacheHit } = buildNavGridCached(
        layers,
        bbox,
        resolutionM,
        req.draftM,
        safetyM,
        obstructionBufferM,
        relaxedLndare,
        relaxZones,
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
        ...(relaxedLndare ? { relaxedLndare: true } : {}),
        ...(relaxZones.length > 0 ? { relaxZones } : {}),
    };

    // ── Label connected components ──
    // One pass to bucket every navigable cell into its 8-connected
    // water body. Drives the shared-component snap below.
    let { labels, sizes } = labelConnectedComponents(grid);
    tPhase = mark('labelComponents', tPhase);

    // ── Component bridge ────────────────────────────────────────────
    // Connect a small origin/destination component to the main routing
    // component across a THIN barrier. Marina canal estates (Newport)
    // sit a short distance from open water, separated by an entrance
    // cut / seawall that chart LNDARE over-represents as land and that
    // OSM canal LineStrings stop short of (they trace the residential
    // canals up to the seawall and end). If origin and destination snap
    // to different components but the shortest gap between them is short
    // — a thin cut, not a real landmass — carve a 1-cell corridor across
    // it so they merge into one navigable body.
    //
    // 2026-05-20: Newport Marina canal estate was a 361-cell isolated
    // component, origin tap snapping 2 km out to the bay. The estate's
    // entrance to open water is a sub-500 m cut that no data source
    // captured cleanly. Capped at 10 cells (500 m) so we never bridge a
    // genuine landmass — only an entrance-width barrier the boat really
    // does pass through.
    {
        // Two-tier bridge:
        //   • gap ≤ NAV cells (≤500 m): a real entrance cut the chart
        //     over-represents as land. Carve NAVIGABLE — the boat does
        //     pass through, it's just mischarted.
        //   • NAV < gap ≤ CAUTION cells (≤2.5 km): a wider barrier we
        //     can't confirm is passable from data (Newport canal estate
        //     → bay: the entrance is a sub-2 km cut no source maps as
        //     water). Carve CAUTION (red) — A* exits the islanded pocket
        //     at the SHORTEST gap (geometrically the marina entrance, not
        //     a goal-biased diagonal across the suburb), and the corridor
        //     renders red as a "verify pilotage, draft may not clear"
        //     warning. This replaces the localized relax-CIRCLE for the
        //     islanded-endpoint case: a circle let A* cut goal-ward across
        //     land (Shane 2026-05-20: "follow the canals until it runs out
        //     of room — it is going the wrong way"); a single narrow
        //     corridor at the shortest gap forces the correct exit.
        const MAX_BRIDGE_CELLS = 10; // 500 m navigable
        const MAX_CAUTION_BRIDGE_CELLS = 60; // 3 km red corridor
        // The CAUTION search is O(smallCells × window²). Only run the
        // wide (±50) window for genuinely small islanded pockets (marina
        // canal estates ≤ a few thousand cells); for big components fall
        // back to the cheap ±10 window so we never pay 100M+ iterations.
        const SMALL_FOR_CAUTION_BRIDGE = 3000;
        // Generous snap radius just to identify which component each
        // endpoint belongs to (same 10 km used by the shared-component
        // snap below).
        const bridgeSnapCells = Math.ceil(10_000 / resolutionM);
        const oCell = snapToNavigable(grid, req.fromLat, req.fromLon, bridgeSnapCells);
        const dCell = snapToNavigable(grid, req.toLat, req.toLon, bridgeSnapCells);
        const lo = oCell ? labels[oCell.y * grid.width + oCell.x] : 0;
        const ld = dCell ? labels[dCell.y * grid.width + dCell.x] : 0;
        if (lo > 0 && ld > 0 && lo !== ld) {
            // Bridge the smaller component to the larger one.
            const small = (sizes.get(lo) ?? 0) <= (sizes.get(ld) ?? 0) ? lo : ld;
            const large = small === lo ? ld : lo;
            const smallSize = sizes.get(small) ?? 0;
            const searchCap = smallSize <= SMALL_FOR_CAUTION_BRIDGE ? MAX_CAUTION_BRIDGE_CELLS : MAX_BRIDGE_CELLS;
            // Collect the small component's cells once, then probe each
            // for a large-component cell within searchCap.
            let bestGap = Infinity;
            let bestSmall: { x: number; y: number } | null = null;
            let bestLarge: { x: number; y: number } | null = null;
            for (let y = 0; y < grid.height; y++) {
                for (let x = 0; x < grid.width; x++) {
                    if (labels[y * grid.width + x] !== small) continue;
                    for (let dy = -searchCap; dy <= searchCap; dy++) {
                        for (let dx = -searchCap; dx <= searchCap; dx++) {
                            const nx = x + dx;
                            const ny = y + dy;
                            if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
                            if (labels[ny * grid.width + nx] !== large) continue;
                            const gap = Math.hypot(dx, dy);
                            if (gap < bestGap) {
                                bestGap = gap;
                                bestSmall = { x, y };
                                bestLarge = { x: nx, y: ny };
                            }
                        }
                    }
                }
            }
            if (bestSmall && bestLarge && bestGap <= searchCap) {
                // ≤ NAV gap → navigable (real entrance cut); wider →
                // CAUTION (red, verify-pilotage barrier).
                const asCaution = bestGap > MAX_BRIDGE_CELLS;
                const carveDepth = Math.max((req.draftM ?? 1.5) + 1.0, 5.0);
                const carveValue = asCaution ? CAUTION : carveDepth;
                for (const c of bresenhamCells(bestSmall.x, bestSmall.y, bestLarge.x, bestLarge.y)) {
                    if (c.x < 0 || c.y < 0 || c.x >= grid.width || c.y >= grid.height) continue;
                    const idx = c.y * grid.width + c.x;
                    // Only fill blocked/unknown/caution cells — never
                    // downgrade real charted water along the corridor.
                    if (Number.isNaN(grid.cells[idx]) || grid.cells[idx] < 0 || grid.cells[idx] === UNKNOWN_OPEN) {
                        grid.cells[idx] = carveValue;
                    }
                }
                if (ENGINE_DEBUG)
                    engineLog.warn(
                        `BRIDGE: carved comp ${small}(${smallSize} cells) → ${large}(${sizes.get(large)} cells) across ${Math.round(bestGap * resolutionM)}m as ${asCaution ? 'CAUTION(red)' : 'navigable'}`,
                    );
                const relabeled = labelConnectedComponents(grid);
                labels = relabeled.labels;
                sizes = relabeled.sizes;
            } else {
                if (ENGINE_DEBUG)
                    engineLog.warn(
                        `BRIDGE: origin comp ${lo} / dest comp ${ld} — nearest gap ${Math.round(bestGap * resolutionM)}m > ${searchCap * resolutionM}m, not bridged`,
                    );
            }
        }
    }

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

    // DEBUG 2026-05-19: dump the top 5 connected components by size,
    // each with bbox + can-origin-snap-here + can-dest-snap-here. Tells
    // us at a glance which component contains the river (vs the bay)
    // and how far each endpoint is from each component. The snap
    // algorithm below picks the component minimising combined snap
    // distance, so seeing all the candidates clarifies WHY it picks
    // what it picks.
    if (ENGINE_DEBUG) {
        const sortedComponents = [...sizes.entries()]
            .filter(([, size]) => size >= minComponentCells)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
        engineLog.warn(`COMPONENTS top ${sortedComponents.length} (min size ${minComponentCells} cells):`);
        for (const [label, size] of sortedComponents) {
            let minX = Infinity;
            let maxX = -Infinity;
            let minY = Infinity;
            let maxY = -Infinity;
            for (let y = 0; y < grid.height; y++) {
                for (let x = 0; x < grid.width; x++) {
                    if (labels[y * grid.width + x] === label) {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
            }
            const [bboxWLon, bboxSLat] = gridToLatLon(grid, minX, minY);
            const [bboxELon, bboxNLat] = gridToLatLon(grid, maxX, maxY);
            const oSnap = snapWithPredicate(
                grid,
                req.fromLat,
                req.fromLon,
                maxSnapCells,
                (idx) => labels[idx] === label,
            );
            const dSnap = snapWithPredicate(grid, req.toLat, req.toLon, maxSnapCells, (idx) => labels[idx] === label);
            const oDistM = oSnap
                ? Math.round(
                      haversineM(
                          req.fromLat,
                          req.fromLon,
                          gridToLatLon(grid, oSnap.x, oSnap.y)[1],
                          gridToLatLon(grid, oSnap.x, oSnap.y)[0],
                      ),
                  )
                : null;
            const dDistM = dSnap
                ? Math.round(
                      haversineM(
                          req.toLat,
                          req.toLon,
                          gridToLatLon(grid, dSnap.x, dSnap.y)[1],
                          gridToLatLon(grid, dSnap.x, dSnap.y)[0],
                      ),
                  )
                : null;
            engineLog.warn(
                `  • label=${label} size=${size} bbox=[${bboxSLat.toFixed(3)},${bboxWLon.toFixed(3)} → ${bboxNLat.toFixed(3)},${bboxELon.toFixed(3)}]  origin-snap=${oDistM != null ? oDistM + 'm' : 'OUT-OF-RANGE'}  dest-snap=${dDistM != null ? dDistM + 'm' : 'OUT-OF-RANGE'}`,
            );
        }
    }

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

    // DEBUG 2026-05-19: surface the snap distances so we can spot when
    // the destination got pulled far from where the user actually
    // tapped. A "12 km destination snap" is the smoking gun for the
    // destination cell being in a different connected component than
    // the origin (componentSnap then picks the largest component both
    // endpoints can reach, even if it means dragging the destination
    // across the map). The visible "bridge" segment from the route's
    // last cell to the user input is what looks like routing through
    // land but is actually post-snap fiction.
    if (ENGINE_DEBUG)
        engineLog.warn(
            `SNAP: origin ${haversineM(req.fromLat, req.fromLon, debug.originSnap?.snappedLat ?? 0, debug.originSnap?.snappedLon ?? 0).toFixed(0)}m  •  dest ${haversineM(req.toLat, req.toLon, debug.destinationSnap?.snappedLat ?? 0, debug.destinationSnap?.snappedLon ?? 0).toFixed(0)}m  •  componentSize=${bestComponentSize} cells`,
        );

    // A* must succeed because the destination cell is in the origin's
    // reachable component. Defensive: still handle null in case the
    // grid has a path-cost edge case I haven't anticipated.
    const cells = aStar(grid, startCell, endCell);
    tPhase = mark('aStar', tPhase);
    if (!cells) {
        return { error: 'A* failed despite reachability flood-fill — should be impossible', code: 'no-path', debug };
    }

    // Marina-centerline refinement: ride mid-channel with keel clearance as
    // straight legs through the marina/canal. The centerline pipeline owns the
    // CLEAN PREFIX of the route (the marina/canal) — scoped at the first
    // caution cell, so a downstream caution stretch (the bay channel, the
    // Brisbane bar) no longer switches the centerline OFF for the canal too.
    // The canal keeps its corner-respecting centerline; A* keeps the caution
    // remainder. A failed/disconnected centerline pass → keep the proven A*.
    let smoothedCells: { x: number; y: number }[];
    const firstCautionIdx = cells.findIndex((c) => grid.cells[c.y * grid.width + c.x] < 0);
    const cleanPrefixEnd = firstCautionIdx === -1 ? cells.length - 1 : firstCautionIdx - 1;
    // Need ≥2 clean cells (a real canal run) for the centerline to mean anything.
    let marinaCells = cleanPrefixEnd >= 1 ? tryMarinaCenterline(grid, startCell, cells[cleanPrefixEnd]) : null;
    if (marinaCells && marinaCells.length >= 2) {
        // Cost-no-worse gate: the centerline pipeline routes on the WATER
        // MASK alone — preferred corridors, marker ribbons, wings and exit
        // penalties are invisible to it. In a canal that's fine (the
        // centerline IS the corridor, near-identical cost); on open clean
        // water it would replace A*'s gate-threading dog-leg with a straight
        // line, bulldozing the seamanship the cost model just paid for
        // (Claude A's "marinaCenterline=true on a straight line" note —
        // confirmed against the Phase 3 gate-shortcut fixture). Accept the
        // centerline only when its true-grid cost is within 5% of the A*
        // prefix it replaces. Landed per ROUTING_COLLAB reply 13.
        const centreChain: { x: number; y: number }[] = [];
        for (let k = 0; k < marinaCells.length - 1; k++) {
            for (const c of bresenhamCells(
                marinaCells[k].x,
                marinaCells[k].y,
                marinaCells[k + 1].x,
                marinaCells[k + 1].y,
            )) {
                const last = centreChain[centreChain.length - 1];
                if (!last || last.x !== c.x || last.y !== c.y) centreChain.push(c);
            }
        }
        const centreCost = chainCostM(grid, centreChain);
        const prefixCost = chainCostM(grid, cells.slice(0, cleanPrefixEnd + 1));
        if (centreCost > prefixCost * 1.05 + 1e-6) {
            if (ENGINE_DEBUG)
                engineLog.warn(
                    `marina-centerline: REJECTED by cost gate (centerline ${Math.round(centreCost)} m-eq vs A* prefix ${Math.round(prefixCost)}) — keeping the A* corridor`,
                );
            marinaCells = null;
        }
    }
    if (marinaCells && marinaCells.length >= 2) {
        debug.marinaCenterline = true;
        if (firstCautionIdx === -1) {
            // Entire route is clean → the centerline owns all of it.
            smoothedCells = marinaCells;
        } else {
            // Stitch: centerline canal prefix + string-pulled A* caution
            // suffix (they share the boundary cell cells[cleanPrefixEnd]).
            const suffix = smoothPath(grid, cells.slice(cleanPrefixEnd));
            smoothedCells = marinaCells.concat(suffix.slice(1));
        }
        if (ENGINE_DEBUG)
            engineLog.warn(
                `marina-centerline: clean prefix ${cleanPrefixEnd + 1}/${cells.length} A* cells → ${marinaCells.length} centerline legs${firstCautionIdx === -1 ? '' : ' + A* caution suffix'}`,
            );
    } else {
        // String-pull the A* output to remove stair-step artifacts.
        smoothedCells = smoothPath(grid, cells);
    }
    tPhase = mark('smoothPath', tPhase);

    // Strict unchartedPolicy: a no-evidence cell reads as caution too —
    // "nothing says there is water here" renders red exactly like "our
    // bathymetry says too shallow". Paired with cells === UNKNOWN_OPEN so
    // post-build rescues (endpoint carve, bridges) clear it implicitly.
    const strictUncharted = req.unchartedPolicy === 'strict';
    const isUnvouchedIdx = (idx: number): boolean =>
        strictUncharted &&
        grid.unvouched !== undefined &&
        grid.unvouched[idx] === 1 &&
        grid.cells[idx] === UNKNOWN_OPEN &&
        grid.preferred[idx] === 0;

    // ── Fairing pass (field bug 2026-06-13: "stepping through the
    // markers", Pinkenba→Newport — ROUTING_COLLAB replies A-23/26) ────
    // Each Pass-5 channel_midpoint is a preferred 1.0× disc in 4× water
    // with EXIT_PENALTY stickiness: A*'s cost-optimal path maximises
    // in-disc distance, bending at every bead — straight legs disc-to-
    // disc, a kink per gate. smoothPath correctly refuses to fair it
    // (the straight chord loses the disc discounts — cost-no-worse).
    // fairPath is the DOCUMENTED carve-out: collapse a subpath to its
    // chord at a bounded cost give-back, but ONLY when the chord still
    // SERVES every gate the subpath served — within each gate's own
    // half-width (_pairDistanceM/2), the engine-side form of the
    // cross-line "may I cut this corner" test. A marked dog-leg around
    // a hazard can never be erased: its chord either crosses caution
    // (excluded), misses the gates (excluded), or costs ≥ ~3× — far
    // beyond the 1.25 give-back. Runs BEFORE the strict re-anchor so
    // boundary waypoints are re-inserted on the FINAL geometry.
    const fairingMids = collectFairingMidpoints(layers);
    if (fairingMids.length > 0 && smoothedCells.length >= 3) {
        smoothedCells = fairPath(grid, smoothedCells, fairingMids, isUnvouchedIdx);
        tPhase = mark('fairing', tPhase);
    }

    // Re-anchor state boundaries the smoother legally erased: smoothPath
    // may collapse a COST-EQUAL chord across a caution/no-evidence patch
    // when the A* path through it was equally straight — the patch then
    // hides inside one waypoint segment, and endpoint-sampled cautionRaw
    // below can't see it. Walk each smoothed segment's Bresenham line and
    // re-insert a waypoint at every effective-state flip, so red runs
    // start and end at the real boundaries (and the clean parts of a long
    // chord stay clean instead of the whole leg flagging red). Inserted
    // points lie ON the chord — geometry and distance are unchanged.
    if (strictUncharted && smoothedCells.length >= 2) {
        const stateAt = (cx: number, cy: number): boolean => {
            const idx = cy * grid.width + cx;
            return grid.cells[idx] < 0 || isUnvouchedIdx(idx);
        };
        const rebuilt: { x: number; y: number }[] = [smoothedCells[0]];
        for (let i = 1; i < smoothedCells.length; i++) {
            const a = smoothedCells[i - 1];
            const b = smoothedCells[i];
            let prev = stateAt(a.x, a.y);
            for (const c of bresenhamCells(a.x, a.y, b.x, b.y)) {
                if (c.x === a.x && c.y === a.y) continue;
                const s = stateAt(c.x, c.y);
                if (s !== prev) {
                    const last = rebuilt[rebuilt.length - 1];
                    if (last.x !== c.x || last.y !== c.y) rebuilt.push({ x: c.x, y: c.y });
                    prev = s;
                }
            }
            const lastW = rebuilt[rebuilt.length - 1];
            if (lastW.x !== b.x || lastW.y !== b.y) rebuilt.push(b);
        }
        smoothedCells = rebuilt;
    }
    const totalMs = Date.now() - t0Total;
    const breakdown = Object.entries(timings)
        .map(([k, v]) => `${k}=${v}ms`)
        .join(' ');
    if (ENGINE_DEBUG) console.warn(`[inshoreEngine] routeInshore total=${totalMs}ms — ${breakdown}`);

    // DEBUG 2026-05-19: trace cell-state along the final smoothed polyline.
    // For each adjacent waypoint pair, sample up to 6 evenly-spaced cells
    // along the Bresenham line and log the cell's effective depth, the
    // preferred flag, and the lat/lon. Tells us *directly* whether the
    // OBSTRN-injected airport bbox is actually hard-blocking the cells
    // the route claims to thread, or whether FAIRWY rescue is letting
    // the route through (rescued cells have positive depth AND
    // preferred=1, blocked cells have NaN). Remove once Brisbane Airport
    // routing is sorted.
    if (ENGINE_DEBUG && smoothedCells.length >= 2) {
        const traceLines: string[] = [];
        for (let i = 0; i < smoothedCells.length - 1; i++) {
            const a = smoothedCells[i];
            const b = smoothedCells[i + 1];
            const cellsOnLine = Array.from(bresenhamCells(a.x, a.y, b.x, b.y));
            const sampleCount = Math.min(6, cellsOnLine.length);
            const step = Math.max(1, Math.floor(cellsOnLine.length / sampleCount));
            const samples: { x: number; y: number }[] = [];
            for (let s = 0; s < cellsOnLine.length; s += step) samples.push(cellsOnLine[s]);
            if (cellsOnLine.length > 0 && samples[samples.length - 1] !== cellsOnLine[cellsOnLine.length - 1]) {
                samples.push(cellsOnLine[cellsOnLine.length - 1]);
            }
            traceLines.push(`  seg ${i}→${i + 1} (${cellsOnLine.length} cells):`);
            for (const s of samples) {
                const idx = s.y * grid.width + s.x;
                const depth = grid.cells[idx];
                const pref = grid.preferred[idx];
                const [lon, lat] = gridToLatLon(grid, s.x, s.y);
                const depthStr = Number.isNaN(depth)
                    ? 'NaN(BLOCKED)'
                    : depth < 0
                      ? `CAUTION(${depth})`
                      : depth === 0
                        ? 'UNKNOWN(0)'
                        : `depth=${depth.toFixed(1)}m`;
                traceLines.push(`    @${lat.toFixed(4)},${lon.toFixed(4)} ${depthStr} preferred=${pref}`);
            }
        }
        engineLog.warn(`CELL TRACE along smoothed polyline (${smoothedCells.length - 1} segments):`);
        for (const line of traceLines) engineLog.warn(line);
    }

    // Convert grid path → polyline (cell centers). Keep each smoothed
    // cell's caution-state alongside so Douglas-Peucker can be run
    // per caution-run below — DP itself is not caution-aware, so
    // DP'ing the whole polyline re-merges a caution patch into an
    // adjacent deep run and the route draws a long mostly-deep leg
    // entirely red (the Brisbane "red but could go another way" bug).
    const polylineRaw: [number, number][] = smoothedCells.map((c) => gridToLatLon(grid, c.x, c.y));
    const cautionRaw: boolean[] = smoothedCells.map((c) => {
        const idx = c.y * grid.width + c.x;
        return grid.cells[idx] < 0 || isUnvouchedIdx(idx);
    });

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

    // Land guard for the simplifier: true if the straight chord a→b crosses a
    // landBlocked cell. Stops Douglas-Peucker collapsing a canal bend into a
    // chord that slices across the bank (the Newport canal corner-clip).
    const dpStepM = Math.max(15, resolutionM / 3);
    const chordCrossesLand = (a: [number, number], b: [number, number]): boolean => {
        if (!grid.landBlocked) return false;
        const segM = haversineM(a[1], a[0], b[1], b[0]);
        const steps = Math.max(1, Math.ceil(segM / dpStepM));
        for (let s = 1; s < steps; s++) {
            const t = s / steps;
            const { x, y } = latLonToGrid(grid, a[1] + (b[1] - a[1]) * t, a[0] + (b[0] - a[0]) * t);
            if (x >= 0 && y >= 0 && x < grid.width && y < grid.height && grid.landBlocked[y * grid.width + x] === 1)
                return true;
        }
        return false;
    };

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
                const simplified = douglasPeucker(polylineRaw.slice(runStart, i + 1), tolDeg, chordCrossesLand);
                const runCaution = segCaution[runStart];
                // skip the boundary point shared with the previous run
                const from = polyline.length === 0 ? 0 : 1;
                for (let k = from; k < simplified.length; k++) polyline.push(simplified[k]);
                for (let k = 0; k < simplified.length - 1; k++) cautionMask.push(runCaution);
                runStart = i;
            }
        }
    }

    // ── Three-tier contract path (PHASE 4, docs/THREE_TIER_ROUTING.md) ──
    // segmentRoute → per-span tier routers → glue, REPLACING the sequential
    // fairlead/leading splices below. A contract leg cannot silently mutate
    // across a tier seam (the implicit-splice bug class), and a tier-3 span
    // re-homes onto the lateral-mark follower WITHOUT the 0.59-near-frac skip
    // that left the Newport end stepped. On ANY refusal it returns null and we
    // run the EXACT proven monolith chain below — so the live route can never
    // get worse than today. Caution is recomputed here (not in the tier
    // routers) with the strict-uncharted rule, so red rendering is unchanged.
    let finalPolyline: [number, number][];
    let finalCaution: boolean[];
    // Monolith-path debug flags (set only on the fallback branch).
    let flFairlead: string | undefined;
    let llLeadingLines: number | undefined;
    let laLeadingApproach: number | undefined;
    const threeTier = applyThreeTier(
        polyline,
        grid,
        layers,
        req.draftM,
        safetyM,
        obstructionBufferM,
        relaxedLndare,
        relaxZones,
    );
    if (threeTier) {
        finalPolyline = threeTier.polyline;
        // SAFETY: caution is recomputed ALONG each segment, not just at its two
        // vertices. A tier leg can cross a bar / unvouched sliver BETWEEN two
        // clean-water vertices; per-vertex sampling drops that red flag — a
        // SILENT bar crossing (A's sweep bucket-1 regression). Sample every
        // stepM with the SAME rule as cautionRaw (charted-shallow <0 OR
        // strict-unvouched), reproducing the monolith's re-anchored semantics.
        const cautionStepM = Math.max(25, resolutionM / 2);
        const segCrossesCaution = (lonA: number, latA: number, lonB: number, latB: number): boolean => {
            const segM = haversineM(latA, lonA, latB, lonB);
            const steps = Math.max(1, Math.ceil(segM / cautionStepM));
            for (let s = 0; s <= steps; s++) {
                const t = s / steps;
                const { x, y } = latLonToGrid(grid, latA + (latB - latA) * t, lonA + (lonB - lonA) * t);
                if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
                const idx = y * grid.width + x;
                if (grid.cells[idx] < 0 || isUnvouchedIdx(idx)) return true;
            }
            return false;
        };
        finalCaution = [];
        for (let i = 0; i < finalPolyline.length - 1; i++) {
            const a = finalPolyline[i];
            const b = finalPolyline[i + 1];
            finalCaution.push(segCrossesCaution(a[0], a[1], b[0], b[1]));
        }
        debug.threeTier = threeTier.provenance;
        if (ENGINE_DEBUG)
            engineLog.warn(
                `[3tier] ${threeTier.spanCount} spans, ${polyline.length}→${finalPolyline.length} pts — ${threeTier.provenance}`,
            );
    } else {
        // Fallback — the proven monolith splice chain, byte-identical to before.
        // Fairlead: where the route transits a buoyed channel in OPEN water
        // (past the marina/canal MarinerEE owns), follow the lateral marks.
        const fl = applyFairleadAtGrid(polyline, cautionMask, grid, layers);
        // Leading-line snap: ride a charted navigation_line transit it follows.
        const ll = applyLeadingLineSnap(fl.polyline, fl.cautionMask, grid, layers);
        // Leading-line APPROACH: come into a charted-lead destination via the lead.
        const la = applyLeadingLineApproach(ll.polyline, ll.cautionMask, grid, layers);
        finalPolyline = la.polyline;
        finalCaution = la.cautionMask;
        flFairlead = fl.fairlead;
        llLeadingLines = ll.leadingLines;
        laLeadingApproach = la.leadingApproach;
    }

    // Compute total length in NM along the final polyline.
    let distM = 0;
    for (let i = 1; i < finalPolyline.length; i++) {
        distM += haversineM(finalPolyline[i - 1][1], finalPolyline[i - 1][0], finalPolyline[i][1], finalPolyline[i][0]);
    }

    // ── Engine-boundary water-vouched sweep (strict policy only) ─────
    // The FINAL polyline (post smoothing / fairlead / leading-line
    // splices) is geometry-sampled at half-cell steps against the
    // no-evidence mask. Runs accumulate ACROSS vertices — a coverage
    // hole doesn't reset at a turn. Longest run beyond UNCHARTED_MAX_
    // RUN_M ⇒ refuse: no source vouches there is water for >1 NM of
    // this route, and "no data" must never render as confident clean
    // water (Bribie field bug, reply 16). Short runs were already
    // caution-flagged red by cautionRaw above. Out-of-grid samples
    // can't occur for A*-derived geometry and are ignored if splices
    // produce one. The GEBCO caller-side backstop remains the third net.
    let unchartedMaxRunM = 0;
    if (strictUncharted && finalPolyline.length >= 2) {
        const tSweep = Date.now();
        const stepM = Math.max(25, resolutionM / 2);
        let runM = 0;
        for (let i = 1; i < finalPolyline.length; i++) {
            const [lonA, latA] = finalPolyline[i - 1];
            const [lonB, latB] = finalPolyline[i];
            const segM = haversineM(latA, lonA, latB, lonB);
            const steps = Math.max(1, Math.ceil(segM / stepM));
            for (let s = 1; s <= steps; s++) {
                const t = s / steps;
                const { x, y } = latLonToGrid(grid, latA + (latB - latA) * t, lonA + (lonB - lonA) * t);
                const inGrid = x >= 0 && y >= 0 && x < grid.width && y < grid.height;
                if (inGrid && isUnvouchedIdx(y * grid.width + x)) {
                    runM += segM / steps;
                    if (runM > unchartedMaxRunM) unchartedMaxRunM = runM;
                } else {
                    runM = 0;
                }
            }
        }
        mark('unchartedSweep', tSweep);
        if (unchartedMaxRunM > UNCHARTED_MAX_RUN_M) {
            return {
                error: `Route crosses ${(unchartedMaxRunM / 1852).toFixed(1)} NM of uncharted water — no installed chart covers that stretch`,
                code: 'uncharted-corridor',
                debug: { ...debug, unchartedMaxRunM: Math.round(unchartedMaxRunM) } as RouteDebug,
            };
        }
    }

    return {
        polyline: finalPolyline,
        cautionMask: finalCaution,
        distanceNM: distM / 1852,
        gridSize: { width: grid.width, height: grid.height },
        bbox,
        debug: {
            ...debug,
            ...(flFairlead ? { fairlead: flFairlead } : {}),
            ...(llLeadingLines ? { leadingLine: llLeadingLines } : {}),
            ...(laLeadingApproach ? { leadingApproach: laLeadingApproach } : {}),
            ...(strictUncharted ? { unchartedMaxRunM: Math.round(unchartedMaxRunM) } : {}),
        } as RouteDebug,
        phaseTimings: timings,
    };
}

/** Shane-confirmed rising-tide bar margin (docs/THREE_TIER_ROUTING.md §1.5).
 *  Feeds the tier-2 marks-free depth gate (→ 5 m all-tide for a 2.4 m draft). */
const TIER_TIDE_SAFETY_M = 0.5;

/**
 * Build a passthrough Leg for a tier-1/2 span: KEEP the A* sub-polyline (the
 * engine already routed deep water well — the standalone routeTier2 is for the
 * future boundary-node-driven path, not for refining an existing A* route).
 * Endpoints pinned to the span's shared-seam BoundaryNodes; caution + depth
 * recomputed per-vertex from the grid.
 */
function passthroughLeg(span: TierSpan, polyline: readonly [number, number][], grid: NavGrid): Leg {
    const sub = polyline.slice(span.fromIdx, span.toIdx + 1).map(([lon, lat]) => [lon, lat] as [number, number]);
    sub[0] = span.entry.at as [number, number];
    sub[sub.length - 1] = span.exit.at as [number, number];
    let controlling = Infinity;
    const cautionMask = sub.map(([lon, lat]) => {
        const { x, y } = latLonToGrid(grid, lat, lon);
        if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return false;
        const d = grid.cells[y * grid.width + x];
        if (!Number.isNaN(d) && d >= 0) controlling = Math.min(controlling, d);
        return Number.isNaN(d) || d < 0;
    });
    return freezeLeg({
        tierId: span.tier,
        entry: span.entry,
        exit: span.exit,
        polyline: sub,
        cautionMask,
        depthSource: span.tier === 1 ? 'gebco' : 'charted',
        controllingDepthM: Number.isFinite(controlling) ? controlling : null,
        provenance: `tier${span.tier}:passthrough`,
    });
}

/**
 * Three-tier contract path (docs/THREE_TIER_ROUTING.md) — segment the REAL A*
 * route into ordered tier spans, route each by tier, glue with the concat-only
 * Gluer. Tier-3 spans re-home onto the lateral-mark follower WITHOUT the
 * silent-passthrough skip that left Newport stepped; tier-1/2 spans keep the
 * proven A* geometry. Returns the final geometry, or null on ANY refusal
 * (segmentation / a tier / a seam double-back) so the caller falls back to the
 * monolith splice — the live route can never get WORSE than today.
 *
 * Caution is NOT returned here: the caller recomputes it in-scope with the
 * strict-uncharted rule (isUnvouchedIdx), so red rendering matches the monolith.
 */
function applyThreeTier(
    polyline: [number, number][],
    grid: NavGrid,
    layers: InshoreLayers,
    draftM: number,
    safetyM: number,
    obstructionBufferM: number,
    relaxedLndare: boolean,
    relaxZones: RelaxZone[],
): { polyline: [number, number][]; provenance: string; spanCount: number } | null {
    if (polyline.length < 2) return null;

    const markFeatures = [...(layers.BOYLAT?.features ?? []), ...(layers.BCNLAT?.features ?? [])];
    const marks = parseLateralMarks(markFeatures as Parameters<typeof parseLateralMarks>[0]);
    const leadingLines = parseLeadingLines((layers.NAVLINE?.features ?? []) as Parameters<typeof parseLeadingLines>[0]);

    // ── RECTRC: snap onto the OFFICIAL recommended track FIRST ──
    // Where the chart carries a hydrographer-drawn recommended track, that IS
    // the route — snap onto it before deriving anything from buoys (authoritative
    // > derived). landBlocked-only veto: a RECTRC is a charted safe route, so a
    // narrow-channel cell the coarse grid calls NaN must not block it.
    let route = polyline;
    let rectrcSnapped = 0;
    const rectrcLines = parseLeadingLines((layers.RECTRC?.features ?? []) as Parameters<typeof parseLeadingLines>[0]);
    if (rectrcLines.length > 0) {
        const landOnly = (p: { lat: number; lon: number }): boolean => {
            const { x, y } = latLonToGrid(grid, p.lat, p.lon);
            if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return false;
            return grid.landBlocked ? grid.landBlocked[y * grid.width + x] === 1 : false;
        };
        const snapped = snapToLeadingLines(
            route.map(([lon, lat]) => ({ lat, lon })),
            route.map(() => false),
            rectrcLines,
            { corridorM: 300, minRunM: 80, maxAngleDeg: 45, isBlocked: landOnly },
        );
        if (snapped.snapped > 0) {
            route = snapped.polyline.map((p) => [p.lon, p.lat] as [number, number]);
            rectrcSnapped = snapped.snapped;
        }
    }

    // refuseUnchartedRunM: null — the engine's strict-uncharted sweep below owns
    // the refuse-on-no-evidence decision; segmentRoute must NOT unilaterally
    // refuse (a relaxed berth-start crosses unvouched water) or the whole path
    // silently falls back to the monolith. Unknown runs ride as caution spans.
    const spans = segmentRoute(route, grid, marks, draftM, safetyM, TIER_TIDE_SAFETY_M, {
        refuseUnchartedRunM: null,
    });
    if (isRefusal(spans)) {
        if (ENGINE_DEBUG) engineLog.warn(`[3tier] FALLBACK — segmentRoute refused (${spans.reason})`);
        return null;
    }
    // A degenerate span would starve a tier router — bail to the proven path.
    if (spans.some((s) => s.toIdx - s.fromIdx < 1)) {
        if (ENGINE_DEBUG) engineLog.warn(`[3tier] FALLBACK — degenerate span`);
        return null;
    }

    // Inject a fine-grid builder so a narrow canal span no buoyed-channel
    // refiner resolves is re-routed on a SEPARATE ~12 m grid (the corner-clip
    // cure) instead of emitting the coarse A* slice that clips the bend. The
    // closure captures buildNavGridCached (same builder, tiny crop, same
    // draft/safety/buffer as the coarse grid) so tier3 never imports the engine.
    // Any build failure returns null → the span keeps its coarse A* slice, so
    // the fine pass can only IMPROVE a canal leg, never disconnect a route.
    const buildFineGrid = (
        fineBbox: readonly [number, number, number, number],
        fineResolutionM: number,
    ): NavGrid | null => {
        try {
            return buildNavGridCached(
                layers,
                [fineBbox[0], fineBbox[1], fineBbox[2], fineBbox[3]],
                fineResolutionM,
                draftM,
                safetyM,
                obstructionBufferM,
                // Match the COARSE route's relax state. Newport's berth is
                // islanded, so the rendered route is the localized-relaxed retry;
                // building the fine grid strict made it see the relaxed-LNDARE
                // stretch as land (the persistent barrier/1189m). Same relax ⇒ the
                // fine grid agrees with the route it's refining.
                relaxedLndare,
                relaxZones,
            ).grid;
        } catch {
            return null;
        }
    };
    const ctx3: Tier3Context = { grid, marks, leadingLines, buildFineGrid };
    const results: LegResult[] = spans.map((span) =>
        span.tier === 3 ? routeTier3(span, route, ctx3) : passthroughLeg(span, route, grid),
    );

    const glued = stitchLegs(results);
    if (glued.refusal || glued.polyline.length < 2) {
        const why = glued.refusal ? `${glued.refusal.reason}@${glued.refusal.atIndex}` : `empty`;
        if (ENGINE_DEBUG) engineLog.warn(`[3tier] FALLBACK — glue refused (${why})`);
        return null;
    }
    const rectrcTag = rectrcSnapped > 0 ? `rectrc×${rectrcSnapped} → ` : '';
    // TEMP on-device diag — confirms RECTRC snap + gate-follow engage on Shane's
    // live Newport grid. Re-gate behind ENGINE_DEBUG once confirmed.
    engineLog.warn(
        `[3tier] ENGAGED ${rectrcTag}spans=${spans.map((s) => `t${s.tier}[${s.fromIdx}-${s.toIdx}]`).join(' ')} prov="${glued.legs.map((l) => l.provenance).join(' | ')}"`,
    );

    const outPoly = glued.polyline.map((p) => [p[0], p[1]] as [number, number]);
    return {
        polyline: outPoly,
        provenance: `${rectrcTag}${glued.legs.map((l) => l.provenance).join(' | ')}`,
        spanCount: spans.length,
    };
}

/**
 * Fairlead at the grid stage — follows the lateral marks through a buoyed
 * channel, scoped to OPEN water and validated against the real navigable grid.
 *
 *  - isLand uses the GRID (blocked OR caution cell), so it catches estate land
 *    the raw LNDARE polygons miss — the gap that drew lines across the canal.
 *  - The marina exit is the first route vertex in open water (no blocked cell
 *    within ~150 m); Fairlead only acts from there on, never in the canal.
 *  - refineWithFairlead requires a genuine along-channel transit and validates
 *    the whole spliced run against isLand; any failure → route unchanged.
 */
function applyFairleadAtGrid(
    polyline: [number, number][],
    cautionMask: boolean[],
    grid: NavGrid,
    layers: InshoreLayers,
): { polyline: [number, number][]; cautionMask: boolean[]; fairlead?: string } {
    const passthrough = { polyline, cautionMask };
    const markFeatures = [...(layers.BOYLAT?.features ?? []), ...(layers.BCNLAT?.features ?? [])];
    if (markFeatures.length < 3 || polyline.length < 2) return passthrough;
    const marks = parseLateralMarks(markFeatures as Parameters<typeof parseLateralMarks>[0]);
    if (marks.length < 3) return passthrough;

    const poly: LatLon[] = polyline.map(([lon, lat]) => ({ lat, lon }));
    const w = grid.width;
    const h = grid.height;

    const isLand = (p: LatLon): boolean => {
        const { x, y } = latLonToGrid(grid, p.lat, p.lon);
        if (x < 0 || y < 0 || x >= w || y >= h) return true;
        const d = grid.cells[y * w + x];
        return Number.isNaN(d) || d < 0;
    };

    const resM = grid.dLat * M_PER_DEG_LAT;
    const openCells = Math.max(2, Math.round(150 / Math.max(1, resM)));
    const isOpen = (p: LatLon): boolean => {
        const { x, y } = latLonToGrid(grid, p.lat, p.lon);
        for (let dy = -openCells; dy <= openCells; dy++) {
            for (let dx = -openCells; dx <= openCells; dx++) {
                if (dx * dx + dy * dy > openCells * openCells) continue;
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= w || ny >= h || Number.isNaN(grid.cells[ny * w + nx])) return false;
            }
        }
        return true;
    };
    let fromIdx = poly.length; // never, unless open water is found
    for (let i = 0; i < poly.length; i++) {
        if (isOpen(poly[i])) {
            fromIdx = i;
            break;
        }
    }

    const refined = refineWithFairlead(poly, marks, isLand, { fromIdx, cautionMask });
    if (!refined.replacedRange) return passthrough;

    const newPolyline: [number, number][] = refined.polyline.map((p) => [p.lon, p.lat]);
    // refineWithFairlead re-aligns the caution mask across every splice (kept
    // segments keep their flag, spliced bridges/centrelines are clean). Use it
    // when its length matches; fall back to the input mask defensively.
    const newCaution: boolean[] =
        refined.cautionMask && refined.cautionMask.length === newPolyline.length - 1
            ? refined.cautionMask
            : cautionMask;

    if (ENGINE_DEBUG)
        engineLog.warn(`fairlead: spliced "${refined.channelKey}" channel from open-water vertex ${fromIdx}`);
    return { polyline: newPolyline, cautionMask: newCaution, fairlead: refined.channelKey ?? undefined };
}

/**
 * Leading-line snap at the grid stage — snaps the route onto the charted
 * navigation_line transit it follows, so the track sits dead on the leading
 * line ("line up the marks") instead of merely near the Pass-5b corridor band.
 *
 *  - isBlocked uses the GRID (NaN / out-of-bounds) so a transit never snaps
 *    across solid land. Caution water is allowed (leading-line approaches are
 *    often shallow), and the on-line segment keeps its red HONESTLY.
 *  - Origin/destination are never moved; only the in-passage transit snaps.
 */
function applyLeadingLineSnap(
    polyline: [number, number][],
    cautionMask: boolean[],
    grid: NavGrid,
    layers: InshoreLayers,
): { polyline: [number, number][]; cautionMask: boolean[]; leadingLines: number } {
    const passthrough = { polyline, cautionMask, leadingLines: 0 };
    const navFeatures = layers.NAVLINE?.features ?? [];
    if (navFeatures.length === 0 || polyline.length < 4) return passthrough;
    const lines = parseLeadingLines(navFeatures as Parameters<typeof parseLeadingLines>[0]);
    if (lines.length === 0) return passthrough;

    const w = grid.width;
    const h = grid.height;
    const cellAt = (p: LatLon): number => {
        const { x, y } = latLonToGrid(grid, p.lat, p.lon);
        if (x < 0 || y < 0 || x >= w || y >= h) return NaN;
        return grid.cells[y * w + x];
    };
    // LAND-only veto: a charted lead is never vetoed by a point-hazard buffer
    // (WRECKS/OBSTRN) — the lead exists to guide PAST those. Land still
    // aborts. Hazard-buffer crossings stay honest via the caution flag.
    const isBlocked = (p: LatLon): boolean => {
        const { x, y } = latLonToGrid(grid, p.lat, p.lon);
        if (x < 0 || y < 0 || x >= w || y >= h) return true;
        return grid.landBlocked ? grid.landBlocked[y * w + x] === 1 : Number.isNaN(grid.cells[y * w + x]);
    };
    const isCaution = (p: LatLon): boolean => {
        const d = cellAt(p);
        return Number.isNaN(d) || d < 0; // hazard-buffer (NaN) or shallow → red
    };

    const poly: LatLon[] = polyline.map(([lon, lat]) => ({ lat, lon }));
    const r = snapToLeadingLines(poly, cautionMask, lines, { isBlocked, isCaution });
    if (r.snapped === 0) return passthrough;

    const newPolyline: [number, number][] = r.polyline.map((p) => [p.lon, p.lat]);
    if (ENGINE_DEBUG)
        engineLog.warn(`leading-line: snapped route onto ${r.snapped} charted transit(s) (line up the marks)`);
    return { polyline: newPolyline, cautionMask: r.cautionMask, leadingLines: r.snapped };
}

/**
 * Leading-line APPROACH at the grid stage — when the destination is served by
 * charted leading line(s), re-route the final approach to come in VIA the
 * transit: make the seaward mark, then steer each lead into the anchorage.
 * Proper pilotage instead of A*'s shortest-path straight-in.
 *
 *  - Diverts at the route vertex nearest the seaward anchor (the boat heads for
 *    the mark from there); leaves the route untouched if the route never comes
 *    within MAX_BRIDGE_M of the anchor — those leads don't serve this passage.
 *  - The spliced approach is validated against hard land; any crossing aborts.
 *  - Caution carried honestly per the grid (clean where Pass 5b rescued the
 *    leads, red where genuinely shallow).
 */
function applyLeadingLineApproach(
    polyline: [number, number][],
    cautionMask: boolean[],
    grid: NavGrid,
    layers: InshoreLayers,
): { polyline: [number, number][]; cautionMask: boolean[]; leadingApproach: number } {
    const passthrough = { polyline, cautionMask, leadingApproach: 0 };
    const navFeatures = layers.NAVLINE?.features ?? [];
    if (navFeatures.length === 0 || polyline.length < 2) {
        if (ENGINE_DEBUG) engineLog.warn(`leading-line approach: SKIP — navFeatures=${navFeatures.length}`);
        return passthrough;
    }
    const lines = parseLeadingLines(navFeatures as Parameters<typeof parseLeadingLines>[0]);
    if (lines.length === 0) {
        if (ENGINE_DEBUG) engineLog.warn('leading-line approach: SKIP — no parseable lines');
        return passthrough;
    }

    const last = polyline[polyline.length - 1];
    const dest: LatLon = { lat: last[1], lon: last[0] };
    const approach = buildLeadingApproach(dest, lines);
    if (!approach) {
        if (ENGINE_DEBUG)
            engineLog.warn(
                `leading-line approach: SKIP — no serving lead within maxDestM of dest ${dest.lat.toFixed(4)},${dest.lon.toFixed(4)} (${lines.length} lines)`,
            );
        return passthrough;
    }

    const w = grid.width;
    const h = grid.height;
    const cellAt = (p: LatLon): number => {
        const { x, y } = latLonToGrid(grid, p.lat, p.lon);
        if (x < 0 || y < 0 || x >= w || y >= h) return NaN;
        return grid.cells[y * w + x];
    };
    // LAND-only veto — same rationale as the snap above: the Tangalooma
    // WRECKS' buffer cells sit ON the charted approach line, and a lead must
    // not be vetoed by the very hazard it exists to guide past. Land aborts;
    // hazard-buffer crossings render caution (isCautionOrBlocked below).
    const isBlocked = (p: LatLon): boolean => {
        const { x, y } = latLonToGrid(grid, p.lat, p.lon);
        if (x < 0 || y < 0 || x >= w || y >= h) return true;
        return grid.landBlocked ? grid.landBlocked[y * w + x] === 1 : Number.isNaN(grid.cells[y * w + x]);
    };
    const isCautionOrBlocked = (p: LatLon): boolean => {
        const d = cellAt(p);
        return Number.isNaN(d) || d < 0;
    };

    const poly: LatLon[] = polyline.map(([lon, lat]) => ({ lat, lon }));

    // Divert at the route vertex nearest the seaward anchor (never the dest
    // itself). If the route never comes within MAX_BRIDGE_M of the anchor, the
    // leads run the wrong way for this passage → leave the route alone.
    //
    // SPLICE-JUNCTION GUARD (field artefact 2026-06-13, Newport approach,
    // ROUTING_COLLAB A-23/26: a ±171° spike-and-return at idx 148-150).
    // Nearest-vertex divert had NO direction discipline: when the route's
    // tail already sits ON the lead axis between anchor and dest, the
    // splice yanked it BACKWARD to the anchor and ran forward again —
    // out, ~180° turn, back. Both splice junctions (route→anchor at the
    // divert, divert→anchor→turn at the anchor) now obey the same
    // |turn| ≤ 120° family as buildLeadingApproach's internal dog-leg
    // guard (cos > −0.5). Candidates are tried nearest-first; a route
    // already lined up past the anchor finds NO compliant divert and the
    // approach is skipped — it was already doing what the leads ask.
    const MAX_BRIDGE_M = 1500;
    const APPROACH_TURN_MIN_COS = -0.5; // |turn| ≤ 120° at every splice junction
    const turnCos = (a: LatLon, b: LatLon, c: LatLon): number => {
        const mPerLon = mPerDegLon(b.lat);
        const ux = (b.lon - a.lon) * mPerLon;
        const uy = (b.lat - a.lat) * M_PER_DEG_LAT;
        const vx = (c.lon - b.lon) * mPerLon;
        const vy = (c.lat - b.lat) * M_PER_DEG_LAT;
        const lu = Math.hypot(ux, uy);
        const lv = Math.hypot(vx, vy);
        if (lu < 1 || lv < 1) return 1; // degenerate legs can't reverse
        return (ux * vx + uy * vy) / (lu * lv);
    };
    const candidates: Array<{ i: number; d: number }> = [];
    for (let i = 0; i < poly.length - 1; i++) {
        const d = llDistM(poly[i], approach.anchor);
        if (d < MAX_BRIDGE_M) candidates.push({ i, d });
    }
    candidates.sort((a, b) => a.d - b.d);
    let divertIdx = -1;
    for (const { i } of candidates) {
        const atDivert = i === 0 ? 1 : turnCos(poly[i - 1], poly[i], approach.anchor);
        const atAnchor = turnCos(poly[i], approach.anchor, approach.chain[1]);
        if (atDivert >= APPROACH_TURN_MIN_COS && atAnchor >= APPROACH_TURN_MIN_COS) {
            divertIdx = i;
            break;
        }
    }
    if (divertIdx < 0) {
        if (ENGINE_DEBUG)
            engineLog.warn(
                candidates.length === 0
                    ? `leading-line approach: SKIP — route never within ${MAX_BRIDGE_M}m of anchor ${approach.anchor.lat.toFixed(4)},${approach.anchor.lon.toFixed(4)}`
                    : `leading-line approach: SKIP — every divert candidate (${candidates.length}) would splice a >120° reversal (route already lined up past the anchor)`,
            );
        return passthrough;
    }

    // Never route the approach across solid land (the leads themselves are
    // navigable; the divert bridge must not cut a headland).
    const spliced = [poly[divertIdx], ...approach.chain];
    if (llAnyAlong(spliced, 25, isBlocked)) {
        if (ENGINE_DEBUG) {
            // Pinpoint the first land crossing for diagnosis.
            let hit = '';
            outer: for (let i = 0; i < spliced.length - 1; i++) {
                const a = spliced[i];
                const b = spliced[i + 1];
                const n = Math.max(1, Math.ceil(llDistM(a, b) / 25));
                for (let k = 0; k <= n; k++) {
                    const t = k / n;
                    const p = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
                    if (isBlocked(p)) {
                        hit = `seg ${i}→${i + 1} @ ${p.lat.toFixed(5)},${p.lon.toFixed(5)}`;
                        break outer;
                    }
                }
            }
            engineLog.warn(
                `leading-line approach: SKIP — spliced chain crosses LAND (divert ${divertIdx}, first land ${hit}; chain ${spliced.map((p) => `${p.lat.toFixed(4)},${p.lon.toFixed(4)}`).join(' → ')})`,
            );
        }
        return passthrough;
    }

    // Keep the route up to the divert vertex, then the transit chain
    // (anchor → leads → dest).
    const newPoly = [...poly.slice(0, divertIdx + 1), ...approach.chain];
    const newPolyline: [number, number][] = newPoly.map((p) => [p.lon, p.lat]);

    // Rebuild caution: prefix preserved; each new approach segment flagged
    // per the grid (clean on rescued leads, red where genuinely shallow).
    const newCaution: boolean[] = cautionMask.slice(0, divertIdx);
    for (let i = divertIdx; i < newPoly.length - 1; i++) {
        newCaution.push(llAnyAlong([newPoly[i], newPoly[i + 1]], 25, isCautionOrBlocked));
    }

    if (ENGINE_DEBUG)
        engineLog.warn(
            `leading-line approach: routed via ${approach.lineCount} charted transit(s) — seaward anchor ${approach.anchor.lat.toFixed(4)},${approach.anchor.lon.toFixed(4)}, divert vertex ${divertIdx}`,
        );
    return { polyline: newPolyline, cautionMask: newCaution, leadingApproach: approach.lineCount };
}
