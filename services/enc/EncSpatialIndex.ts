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
            // S-57 convention: positive metres = depth below sea level.
            // null minDepth → unknown depth, treat as hazard.
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
            const [hMinLon, hMinLat, hMaxLon, hMaxLat] = geometryBBox(hazard.geometry);
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
     *  2. For each candidate, run point-in-polygon (or point-equals
     *     for Point geometries within a small tolerance — we don't
     *     do that today, but UWTROC/WRECKS at exact-pixel match is
     *     fine for now).
     *  3. Return the most-severe hit (`land` > `rock` > `wreck` >
     *     `obstruction` > `shallow`).
     *
     * Returns `covered: true, hazard: false` when the point is
     * inside the cell bbox but no hazard polygon contains it. This
     * is the authoritative "clear water" signal that lets the
     * caller skip GEBCO entirely.
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

        if (candidates.length === 0) {
            return { covered: true, hazard: false, minDepthM: null, cellId: this.cellId, catzoc };
        }

        const turfPt = turfPoint([lon, lat]);

        let bestType: EncHazardType | null = null;
        let bestDepth: number | null = null;
        const severity: Record<EncHazardType, number> = {
            land: 5,
            rock: 4,
            wreck: 3,
            obstruction: 2,
            shallow: 1,
            coast: 0, // never selected here — coastlines have their own tree
        };

        for (const entry of candidates) {
            const type = classifyHazard(entry.hazard);
            if (!type) continue; // DEPARE deeper than threshold → not a hazard.

            const geom = entry.hazard.geometry;
            let inside = false;
            if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
                inside = booleanPointInPolygon(turfPt, geom);
            } else if (geom.type === 'Point') {
                // Point hazards: bbox query already gave us exact-point
                // matches. UWTROC/WRECKS positions are typically rounded
                // to 1e-7 deg in S-57. Treat any bbox hit as a hit.
                inside = true;
            }
            if (!inside) continue;

            if (bestType === null || severity[type] > severity[bestType]) {
                bestType = type;
                bestDepth = entry.hazard.minDepthM;
            }
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
