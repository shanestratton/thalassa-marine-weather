/**
 * ENC Spatial Index — RBush-backed point lookup over hazard polygons.
 *
 * Built from a list of EncHazard records (one cell's worth of
 * extracted DEPARE/LNDARE/OBSTRN/WRECKS/UWTROC features). Provides
 * fast point-in-bbox candidate selection plus precise point-in-
 * polygon hazard testing via @turf.
 *
 * Build is O(n log n); each query is O(log n + k) where k = number
 * of bbox candidates. For typical Australian cells (1k–10k hazards)
 * a query is sub-millisecond.
 *
 * Threading: this is in-memory, per-cell. Multiple cells are
 * composed at the EncHazardService layer above. We don't share
 * one global index because cells load lazily by route bbox.
 */

import RBush from 'rbush';
import { booleanPointInPolygon } from '@turf/boolean-point-in-polygon';
import { point as turfPoint } from '@turf/helpers';
import type { Geometry, Position } from 'geojson';

import type { BBoxEntry, EncCatzoc, EncHazard, EncHazardResult, EncHazardType } from './types';
import { ENC_HAZARD_DEPTH_M } from './types';
import { HAZARD_TYPE_SEVERITY, depthSeverity } from './hazardSeverity';

// ── Point-hazard guard radius ──────────────────────────────────────

/**
 * Guard radius (metres) around POINT hazards — isolated dangers:
 * UWTROC, point WRECKS/OBSTRN, and exploded MultiPoint clusters.
 *
 * A point hazard has a ZERO-AREA bbox at its exact coordinate, so a
 * route sampled at ~231 m (landAvoidance FINE_SAMPLE_SPACING_NM = 0.125
 * NM) intervals never lands EXACTLY on a rock — the router would plot
 * straight over a charted isolated danger and only mention it in the
 * passive proximity report. We pad each point hazard's index bbox by
 * this radius and confirm candidates with a true-circle distance test
 * in queryPoint, so any sample within R metres detects it.
 *
 * R (150 m) is deliberately > half the 231 m sample spacing (≈116 m):
 * an on-track danger can never slip between two consecutive samples.
 * It doubles as a sane minimum berth for a charted rock/wreck. This is
 * FAIL-SAFE — an over-wide radius causes an unnecessary detour, never a
 * sail-over. (mission audit: point hazards were undetectable to routing.)
 */
export const POINT_HAZARD_GUARD_RADIUS_M = 150;

const METRES_PER_DEG_LAT = 111_320;
const EARTH_RADIUS_M = 6_371_000;

/**
 * Great-circle distance in metres (equirectangular approximation —
 * exact to well under 0.01% at the sub-km ranges we ever measure here,
 * and far cheaper than a full haversine per candidate).
 */
function metresBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const latRad = ((lat1 + lat2) / 2) * (Math.PI / 180);
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const x = dLon * Math.cos(latRad);
    const y = dLat;
    return Math.sqrt(x * x + y * y) * EARTH_RADIUS_M;
}

// ── CATZOC zone (M_QUAL) ───────────────────────────────────────────

/**
 * Internal RBush entry for an M_QUAL polygon. We index these in a
 * separate tree from hazards because they always cover the whole
 * cell — including them in the hazard tree would explode the
 * candidate count for every routing query.
 */
interface CatzocEntry {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    geometry: Geometry;
    catzoc: EncCatzoc;
}

/**
 * Public shape of an M_QUAL feature handed in to the index. The
 * `catzoc` value is the `CATZOC` attribute of the source M_QUAL
 * polygon (1..6).
 */
export interface EncCatzocZone {
    geometry: Geometry;
    catzoc: EncCatzoc;
}

// ── Coastline (COALNE) ────────────────────────────────────────────

/**
 * RBush entry for a coastline feature. Geometry is typically a
 * LineString or MultiLineString. Stored separately from hazards
 * because the route validator never reroutes around COALNE — it's
 * only used for proximity warnings in the hazard report.
 */
interface CoastlineEntry {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    geometry: Geometry;
}

/**
 * Public shape passed to the spatial index for COALNE features.
 */
export interface EncCoastline {
    geometry: Geometry;
}

// ── BBox computation ───────────────────────────────────────────────

/**
 * Compute the GeoJSON bbox `[minLon, minLat, maxLon, maxLat]` of a
 * geometry. Handles Point, MultiPoint, LineString, MultiLineString,
 * Polygon, MultiPolygon. Throws on GeometryCollection (we don't
 * expect those in S-57 output).
 */
export function geometryBBox(geom: Geometry): [number, number, number, number] {
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;

    const visitCoord = (coord: Position) => {
        const lon = coord[0];
        const lat = coord[1];
        if (lon < minLon) minLon = lon;
        if (lat < minLat) minLat = lat;
        if (lon > maxLon) maxLon = lon;
        if (lat > maxLat) maxLat = lat;
    };

    const visitCoords = (coords: unknown): void => {
        if (!Array.isArray(coords)) return;
        if (coords.length === 0) return;
        // Leaf: [lon, lat] | [lon, lat, alt]
        if (typeof coords[0] === 'number') {
            visitCoord(coords as Position);
            return;
        }
        // Recurse
        for (const sub of coords) visitCoords(sub);
    };

    if (geom.type === 'GeometryCollection') {
        throw new Error('EncSpatialIndex: GeometryCollection not supported');
    }
    visitCoords(geom.coordinates);

    if (!Number.isFinite(minLon)) {
        throw new Error(`EncSpatialIndex: empty geometry of type ${geom.type}`);
    }
    return [minLon, minLat, maxLon, maxLat];
}

// ── Hazard classification ─────────────────────────────────────────

/**
 * Map an EncHazard to its UI-facing hazard type.
 *
 * For DEPARE we only return 'shallow' if the polygon's minimum
 * depth is at-or-below the hazard threshold; deeper DEPARE polygons
 * are NOT hazards (they're explicit "clear water" coverage).
 */
function classifyHazard(hazard: EncHazard): EncHazardType | null {
    switch (hazard.layer) {
        case 'LNDARE':
            return 'land';
        case 'DEPARE':
        case 'DRGARE':
            // Depth areas (incl. dredged) — S-57 positive metres = depth
            // below datum. null minDepth → unknown depth, treat as hazard.
            if (hazard.minDepthM === null) return 'shallow';
            if (hazard.minDepthM < ENC_HAZARD_DEPTH_M) return 'shallow';
            return null; // Deeper than threshold — clear water.
        case 'OBSTRN':
            return 'obstruction';
        case 'WRECKS':
            return 'wreck';
        case 'UWTROC':
            return 'rock';
        case 'COALNE':
            // Coastlines are stored in their own tree and never
            // returned as point-in-polygon hazards. Defensive: if
            // one ends up here, it's a soft 'coast' hazard.
            return 'coast';
    }
}

// ── Spatial index ──────────────────────────────────────────────────

/**
 * Per-cell hazard index. Build once when a cell loads; query many.
 *
 * Two internal R-trees:
 *  - `hazardTree` — DEPARE/LNDARE/OBSTRN/WRECKS/UWTROC features
 *  - `catzocTree` — M_QUAL polygons. Always queried separately
 *    because they typically cover the whole cell.
 */
export class EncSpatialIndex {
    private readonly hazardTree: RBush<BBoxEntry>;
    private readonly catzocTree: RBush<CatzocEntry>;
    private readonly coastlineTree: RBush<CoastlineEntry>;
    private readonly cellId: string;
    private readonly bbox: [number, number, number, number];
    private readonly hazardCount: number;
    private readonly catzocRange: [EncCatzoc, EncCatzoc] | null;
    private readonly coastlineCount: number;

    constructor(
        cellId: string,
        hazards: EncHazard[],
        catzocZones: EncCatzocZone[] = [],
        coastlines: EncCoastline[] = [],
    ) {
        this.cellId = cellId;
        this.hazardTree = new RBush<BBoxEntry>();
        this.catzocTree = new RBush<CatzocEntry>();
        this.coastlineTree = new RBush<CoastlineEntry>();

        const hazardEntries: BBoxEntry[] = [];
        let minLon = Infinity;
        let minLat = Infinity;
        let maxLon = -Infinity;
        let maxLat = -Infinity;

        for (const hazard of hazards) {
            let [hMinLon, hMinLat, hMaxLon, hMaxLat] = geometryBBox(hazard.geometry);
            // Point hazards (rock/wreck/obstruction, incl. exploded
            // MultiPoints) get a guard-radius bbox pad so a route sample
            // passing NEAR — not exactly on — a charted danger still
            // selects it as a candidate. queryPoint then confirms with a
            // true-circle distance test, so the square pad reads as a
            // circle. Polygons (DEPARE/LNDARE/…) are unpadded.
            if (hazard.geometry.type === 'Point') {
                const dLat = POINT_HAZARD_GUARD_RADIUS_M / METRES_PER_DEG_LAT;
                const cosLat = Math.max(0.05, Math.cos((hMinLat * Math.PI) / 180));
                const dLon = POINT_HAZARD_GUARD_RADIUS_M / (METRES_PER_DEG_LAT * cosLat);
                hMinLon -= dLon;
                hMaxLon += dLon;
                hMinLat -= dLat;
                hMaxLat += dLat;
            }
            hazardEntries.push({
                minX: hMinLon,
                minY: hMinLat,
                maxX: hMaxLon,
                maxY: hMaxLat,
                hazard,
                cellId,
            });
            if (hMinLon < minLon) minLon = hMinLon;
            if (hMinLat < minLat) minLat = hMinLat;
            if (hMaxLon > maxLon) maxLon = hMaxLon;
            if (hMaxLat > maxLat) maxLat = hMaxLat;
        }

        // Bulk-load is much faster than insert-per-entry for large lists.
        this.hazardTree.load(hazardEntries);
        this.hazardCount = hazardEntries.length;

        // Build the CATZOC tree from M_QUAL polygons.
        const catzocEntries: CatzocEntry[] = [];
        let bestCatzoc: EncCatzoc | null = null;
        let worstCatzoc: EncCatzoc | null = null;
        for (const zone of catzocZones) {
            const [zMinLon, zMinLat, zMaxLon, zMaxLat] = geometryBBox(zone.geometry);
            catzocEntries.push({
                minX: zMinLon,
                minY: zMinLat,
                maxX: zMaxLon,
                maxY: zMaxLat,
                geometry: zone.geometry,
                catzoc: zone.catzoc,
            });
            if (zMinLon < minLon) minLon = zMinLon;
            if (zMinLat < minLat) minLat = zMinLat;
            if (zMaxLon > maxLon) maxLon = zMaxLon;
            if (zMaxLat > maxLat) maxLat = zMaxLat;
            if (bestCatzoc === null || zone.catzoc < bestCatzoc) bestCatzoc = zone.catzoc;
            if (worstCatzoc === null || zone.catzoc > worstCatzoc) worstCatzoc = zone.catzoc;
        }
        this.catzocTree.load(catzocEntries);
        this.catzocRange = bestCatzoc !== null && worstCatzoc !== null ? [bestCatzoc, worstCatzoc] : null;

        // Build coastline tree.
        const coastlineEntries: CoastlineEntry[] = [];
        for (const c of coastlines) {
            const [cMinLon, cMinLat, cMaxLon, cMaxLat] = geometryBBox(c.geometry);
            coastlineEntries.push({
                minX: cMinLon,
                minY: cMinLat,
                maxX: cMaxLon,
                maxY: cMaxLat,
                geometry: c.geometry,
            });
            if (cMinLon < minLon) minLon = cMinLon;
            if (cMinLat < minLat) minLat = cMinLat;
            if (cMaxLon > maxLon) maxLon = cMaxLon;
            if (cMaxLat > maxLat) maxLat = cMaxLat;
        }
        this.coastlineTree.load(coastlineEntries);
        this.coastlineCount = coastlineEntries.length;

        this.bbox = Number.isFinite(minLon) ? [minLon, minLat, maxLon, maxLat] : [0, 0, 0, 0];
    }

    /**
     * Cell ID this index represents. Used by the service layer to
     * stamp results with provenance.
     */
    getCellId(): string {
        return this.cellId;
    }

    /**
     * Cell bounding box (union of all hazards). Used for "does this
     * cell cover lat/lon?" pre-filtering before we go into the
     * R-tree.
     */
    getCellBBox(): [number, number, number, number] {
        return this.bbox;
    }

    /**
     * Total hazards in this cell (UI stat).
     */
    getHazardCount(): number {
        return this.hazardCount;
    }

    /**
     * CATZOC range (best..worst) present in this cell's M_QUAL
     * coverage. Null when M_QUAL was not present.
     */
    getCatzocRange(): [EncCatzoc, EncCatzoc] | null {
        return this.catzocRange;
    }

    /**
     * Total coastline (COALNE) features in this cell.
     */
    getCoastlineCount(): number {
        return this.coastlineCount;
    }

    /**
     * Search COALNE features whose bbox intersects `bbox`. Used by
     * the hazard-report service to compute closest-approach
     * distances from the route to charted coastline.
     */
    searchCoastlinesInBBox(bbox: [number, number, number, number]): { geometry: Geometry }[] {
        const [minLon, minLat, maxLon, maxLat] = bbox;
        return this.coastlineTree.search({
            minX: minLon,
            minY: minLat,
            maxX: maxLon,
            maxY: maxLat,
        });
    }

    /**
     * Search every hazard whose bounding box intersects `bbox`.
     * Used by the hazard-report service to find OBSTRN/WRECKS/
     * UWTROC features near a planned route, not just exactly under
     * a sample point.
     *
     * Results include the underlying EncHazard plus its bbox so
     * the caller can do precise distance work without a second
     * geometry pass.
     *
     * `bbox` is `[minLon, minLat, maxLon, maxLat]`.
     */
    searchInBBox(bbox: [number, number, number, number]): BBoxEntry[] {
        const [minLon, minLat, maxLon, maxLat] = bbox;
        return this.hazardTree.search({
            minX: minLon,
            minY: minLat,
            maxX: maxLon,
            maxY: maxLat,
        });
    }

    /**
     * Resolve the CATZOC at a single point. Walks the M_QUAL tree
     * and returns the value of the most-pessimistic polygon
     * containing the point (i.e. higher CATZOC numbers win — D
     * beats B beats A1, because we prefer to surface the worst
     * case to the user).
     *
     * Returns `null` when no M_QUAL polygon covers the point —
     * either no M_QUAL data was present in the source cell, or
     * the cell has gaps in M_QUAL coverage (rare).
     */
    queryCatzocAt(lat: number, lon: number): EncCatzoc | null {
        if (this.catzocRange === null) return null;
        const candidates = this.catzocTree.search({ minX: lon, minY: lat, maxX: lon, maxY: lat });
        if (candidates.length === 0) return null;
        const turfPt = turfPoint([lon, lat]);
        let worst: EncCatzoc | null = null;
        for (const entry of candidates) {
            const geom = entry.geometry;
            if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') continue;
            if (!booleanPointInPolygon(turfPt, geom)) continue;
            if (worst === null || entry.catzoc > worst) worst = entry.catzoc;
        }
        return worst;
    }

    /**
     * True if `lat,lon` falls inside this cell's bbox. O(1) gate
     * before doing the more expensive R-tree query.
     */
    containsPoint(lat: number, lon: number): boolean {
        const [minLon, minLat, maxLon, maxLat] = this.bbox;
        return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
    }

    /**
     * Query a single point. Returns the hazard result with cell-
     * level provenance.
     *
     * Algorithm:
     *  1. R-tree bbox query → candidate hazards whose bboxes
     *     contain the point.
     *  2. For each candidate, run point-in-polygon (polygons) or a
     *     true-circle distance test within POINT_HAZARD_GUARD_RADIUS_M
     *     (point hazards — so a route sample passing near a charted rock
     *     detects it without landing exactly on the coordinate).
     *  3. Return the most-severe hit (`land` > `rock` > `wreck` >
     *     `obstruction` > `shallow`; ties broken by shallower/unknown depth).
     *
     * COVERAGE (mission audit, the fail-dangerous fix): `covered: true` means
     * the point falls INSIDE an actual charted feature (a DEPARE/DRGARE depth
     * area, land, or a hazard) — the authoritative "we have ENC data here"
     * signal that lets the caller skip GEBCO. A point inside the cell BBOX
     * but inside no charted polygon (a data gap / unsurveyed area — S-57
     * UNSARE isn't extracted) returns `covered: false` so the router falls
     * back to GEBCO instead of trusting a false-clear. Charted deep water
     * still returns `covered: true, hazard: false`.
     */
    queryPoint(lat: number, lon: number): EncHazardResult {
        if (!this.containsPoint(lat, lon)) {
            return { covered: false, hazard: false, minDepthM: null };
        }

        const catzoc = this.queryCatzocAt(lat, lon);

        const candidates = this.hazardTree.search({
            minX: lon,
            minY: lat,
            maxX: lon,
            maxY: lat,
        });

        // No charted feature's bbox even contains the point → this cell
        // charts NOTHING here: a data gap / unsurveyed area inside its own
        // bbox. NOT authoritatively clear — covered:false lets the router
        // fall back to GEBCO rather than trust a false-clear (mission audit,
        // the UNSARE/unsurveyed grounding gap: covered used to key off the
        // cell BBOX, so gap water read as ENC-validated clear water).
        if (candidates.length === 0) {
            return { covered: false, hazard: false, minDepthM: null };
        }

        const turfPt = turfPoint([lon, lat]);

        let bestType: EncHazardType | null = null;
        let bestDepth: number | null = null;
        let insideCharted = false; // point falls inside SOME charted feature

        for (const entry of candidates) {
            const geom = entry.hazard.geometry;
            let inside = false;
            if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
                inside = booleanPointInPolygon(turfPt, geom);
            } else if (geom.type === 'Point') {
                // Point hazard (rock/wreck/obstruction). The candidate came
                // from the guard-radius-PADDED bbox; confirm it with a real
                // distance test so the true detection zone is a circle of
                // POINT_HAZARD_GUARD_RADIUS_M, not the padded square. This is
                // what lets a 231 m-spaced route sample detect a charted rock
                // it doesn't land exactly on (mission audit fix).
                const [hLon, hLat] = geom.coordinates as [number, number];
                inside = metresBetween(lat, lon, hLat, hLon) <= POINT_HAZARD_GUARD_RADIUS_M;
            }
            if (!inside) continue;

            // Inside a charted feature (depth area, land, or a point hazard)
            // → this cell authoritatively covers the point, even when the
            // feature is DEEP water (classifyHazard → null below).
            insideCharted = true;

            const type = classifyHazard(entry.hazard);
            if (!type) continue; // deep DEPARE/DRGARE — covered, not a hazard.

            // Most-severe wins: worse TYPE first, then (same type) the
            // SHALLOWER / unknown depth — the SAME tiebreak as the cross-cell
            // mergeHazardResults, so within-cell and across-cell can never
            // disagree (audit: the within-cell pick dropped the depth tiebreak).
            if (
                bestType === null ||
                HAZARD_TYPE_SEVERITY[type] > HAZARD_TYPE_SEVERITY[bestType] ||
                (HAZARD_TYPE_SEVERITY[type] === HAZARD_TYPE_SEVERITY[bestType] &&
                    depthSeverity(entry.hazard.minDepthM) > depthSeverity(bestDepth))
            ) {
                bestType = type;
                bestDepth = entry.hazard.minDepthM;
            }
        }

        // Inside the cell bbox and inside the candidates' bboxes, but inside
        // NO actual polygon → still a gap. Fall back to GEBCO.
        if (!insideCharted) {
            return { covered: false, hazard: false, minDepthM: null };
        }

        if (bestType === null) {
            return { covered: true, hazard: false, minDepthM: null, cellId: this.cellId, catzoc };
        }

        return {
            covered: true,
            hazard: true,
            minDepthM: bestDepth,
            hazardType: bestType,
            cellId: this.cellId,
            catzoc,
        };
    }
}
