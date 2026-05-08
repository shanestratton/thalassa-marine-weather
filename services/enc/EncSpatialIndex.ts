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

import type { BBoxEntry, EncHazard, EncHazardResult, EncHazardType } from './types';
import { ENC_HAZARD_DEPTH_M } from './types';

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
    }
}

// ── Spatial index ──────────────────────────────────────────────────

/**
 * Per-cell hazard index. Build once when a cell loads; query many.
 */
export class EncSpatialIndex {
    private readonly tree: RBush<BBoxEntry>;
    private readonly cellId: string;
    private readonly bbox: [number, number, number, number];
    private readonly hazardCount: number;

    constructor(cellId: string, hazards: EncHazard[]) {
        this.cellId = cellId;
        this.tree = new RBush<BBoxEntry>();

        const entries: BBoxEntry[] = [];
        let minLon = Infinity;
        let minLat = Infinity;
        let maxLon = -Infinity;
        let maxLat = -Infinity;

        for (const hazard of hazards) {
            const [hMinLon, hMinLat, hMaxLon, hMaxLat] = geometryBBox(hazard.geometry);
            entries.push({
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
        this.tree.load(entries);
        this.hazardCount = entries.length;
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

        const candidates = this.tree.search({
            minX: lon,
            minY: lat,
            maxX: lon,
            maxY: lat,
        });

        if (candidates.length === 0) {
            return { covered: true, hazard: false, minDepthM: null, cellId: this.cellId };
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
            return { covered: true, hazard: false, minDepthM: null, cellId: this.cellId };
        }

        return {
            covered: true,
            hazard: true,
            minDepthM: bestDepth,
            hazardType: bestType,
            cellId: this.cellId,
        };
    }
}
