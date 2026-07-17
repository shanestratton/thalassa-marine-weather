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
import lineIntersect from '@turf/line-intersect';
import { lineString as turfLineString, point as turfPoint } from '@turf/helpers';
import type { Geometry, Position } from 'geojson';

import type { BBoxEntry, EncAreaGraze, EncCatzoc, EncHazard, EncHazardResult, EncHazardType } from './types';
import { ENC_HAZARD_DEPTH_M } from './types';
import { compareHazardSeverity } from './hazardSeverity';

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

/** How far from an exempt route terminal the berth exemption reaches
 *  (closing audit 2026-07-17): a shoal-area boundary crossing beyond this
 *  is a DIFFERENT arm of the feature, not the berth's own water, and
 *  still flags. ~500 m covers a marina basin + its entrance channel
 *  without reaching across a bay. */
export const BERTH_EXEMPT_RADIUS_M = 500;

// ── ZOC-aware lateral clearance margin (burn-down 2026-07-18 #1) ────

/**
 * Horizontal positional uncertainty (metres) of a charted feature by its
 * M_QUAL CATZOC — the IHO S-57 CATZOC table. A route that passes THIS close
 * to (but does not cross) a charted AREA hazard boundary is inside the
 * chart's own position error: at that separation "clear" is not a promise,
 * only an assumption. We surface it as a `segmentAreaGraze` advisory.
 *
 * IHO horizontal accuracy: A1 ±5 m, A2 ±20 m, B ±50 m, C ±500 m, D worse.
 * C/D/U are CAPPED to GRAZE_MARGIN_CAP_M here so the graze advisory stays a
 * SPECIFIC near-miss caveat and does not fire on every feature within half a
 * kilometre — the route-wide low-confidence CATZOC note (buildRouteAdvisories,
 * now ZOC ≥ B) already carries the "poorly surveyed, verify everything"
 * warning for that water, so the graze pass need not restate it 500 m wide.
 */
const POSITIONAL_CEP_M: Record<EncCatzoc, number> = {
    1: 5, // A1
    2: 20, // A2
    3: 50, // B
    4: 100, // C  (true CEP ±500 m — capped, see above)
    5: 100, // D  (worse than C — capped)
    6: 100, // U  (unassessed — capped)
};

/** Upper bound on the graze margin (m). C/D/U clamp here. Matches the
 *  point-hazard guard's order of magnitude so a graze can't out-reach a
 *  reroute. */
export const GRAZE_MARGIN_CAP_M = 100;

/** Margin (m) for a CATZOC. `null` (no M_QUAL under the segment) is treated
 *  as ZOC-B (±50 m), NOT worst-case: the separate `quality-unknown` note
 *  already tells the skipper the survey confidence is unassessed, so the
 *  graze margin needn't also blow out to the cap on every no-M_QUAL cell. */
export function zocMarginM(catzoc: EncCatzoc | null): number {
    if (catzoc == null) return POSITIONAL_CEP_M[3];
    return Math.min(POSITIONAL_CEP_M[catzoc] ?? GRAZE_MARGIN_CAP_M, GRAZE_MARGIN_CAP_M);
}

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

/** Perpendicular distance (metres) from a point to a segment a→b, using a
 *  local equirectangular projection about the query point — accurate at
 *  the sub-km ranges the guard radius cares about. */
function pointToSegmentMetres(
    plat: number,
    plon: number,
    alat: number,
    alon: number,
    blat: number,
    blon: number,
): number {
    const mLon = METRES_PER_DEG_LAT * Math.cos((plat * Math.PI) / 180);
    const ax = (alon - plon) * mLon;
    const ay = (alat - plat) * METRES_PER_DEG_LAT;
    const bx = (blon - plon) * mLon;
    const by = (blat - plat) * METRES_PER_DEG_LAT;
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 > 0 ? -((ax * dx + ay * dy) / len2) : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = ax + t * dx;
    const cy = ay + t * dy;
    return Math.sqrt(cx * cx + cy * cy);
}

/** Min distance (metres) between two segments a→b and c→d. Zero when they
 *  intersect; otherwise the smallest of the four endpoint-to-opposite-segment
 *  distances (the closest approach of two non-crossing segments always occurs
 *  at an endpoint). Reuses pointToSegmentMetres, so equirectangular about each
 *  probed point — accurate at the sub-km graze ranges. */
function segmentToSegmentMetres(
    alat: number,
    alon: number,
    blat: number,
    blon: number,
    clat: number,
    clon: number,
    dlat: number,
    dlon: number,
): number {
    return Math.min(
        pointToSegmentMetres(alat, alon, clat, clon, dlat, dlon),
        pointToSegmentMetres(blat, blon, clat, clon, dlat, dlon),
        pointToSegmentMetres(clat, clon, alat, alon, blat, blon),
        pointToSegmentMetres(dlat, dlon, alat, alon, blat, blon),
    );
}

/** Min clearance (metres) from a segment a→b to any edge of a polygon's rings
 *  (outer + holes), walking ring vertices as a polyline. Returns Infinity for
 *  a non-polygon geometry or an empty ring set. Bounded by the ring vertex
 *  count of the candidate polygons (already bbox-pre-filtered by the caller). */
function segmentToPolygonMetres(alat: number, alon: number, blat: number, blon: number, geom: Geometry): number {
    const rings: Position[][] =
        geom.type === 'Polygon' ? geom.coordinates : geom.type === 'MultiPolygon' ? geom.coordinates.flat() : [];
    let best = Infinity;
    for (const ring of rings) {
        for (let i = 0; i + 1 < ring.length; i++) {
            const c = ring[i];
            const d = ring[i + 1];
            const dist = segmentToSegmentMetres(alat, alon, blat, blon, c[1], c[0], d[1], d[0]);
            if (dist < best) best = dist;
        }
    }
    return best;
}

/** Min distance (metres) from a point to a Line/MultiLineString geometry. */
function distanceToLineMetres(lat: number, lon: number, geom: Geometry): number {
    const lines: Position[][] =
        geom.type === 'LineString' ? [geom.coordinates] : geom.type === 'MultiLineString' ? geom.coordinates : [];
    let best = Infinity;
    for (const line of lines) {
        for (let i = 0; i + 1 < line.length; i++) {
            const a = line[i];
            const b = line[i + 1];
            const d = pointToSegmentMetres(lat, lon, a[1], a[0], b[1], b[0]);
            if (d < best) best = d;
        }
    }
    return best;
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

// ── Caution / info areas (RESARE/CBLARE/PIPARE/TSSLPT) ─────────────

/**
 * A charted caution AREA the route validator warns on CROSSING (not a
 * grounding hazard — you can transit most, but you must KNOW: a restricted
 * zone, a submarine cable/pipeline no-anchor area, a TSS lane). SBDARE
 * (seabed nature) is deliberately NOT a caution — it's an anchoring aid, not
 * a crossing warning. Stored in its own tree, queried per route segment.
 */
export interface EncCautionArea {
    geometry: Geometry;
    /** S-57 class: RESARE / CBLARE / PIPARE / TSSLPT. */
    cls: string;
    /** RESTRN restriction code(s) for RESARE (comma list). */
    restrn?: string;
    /** OBJNAM if present. */
    name?: string;
}

interface CautionEntry {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    area: EncCautionArea;
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
        case 'SOUNDG':
            // Shoal spot sounding (parse-filtered to < threshold). Treat as
            // a shallow depth; the draft-aware re-eval decides downstream.
            // A depthless sounding asserts nothing — null so it can't stand
            // in as false "clear" coverage.
            if (hazard.minDepthM === null) return null;
            if (hazard.minDepthM < ENC_HAZARD_DEPTH_M) return 'shallow';
            return null;
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
    private readonly cautionTree: RBush<CautionEntry>;
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
        cautionAreas: EncCautionArea[] = [],
    ) {
        this.cellId = cellId;
        this.hazardTree = new RBush<BBoxEntry>();
        this.catzocTree = new RBush<CatzocEntry>();
        this.coastlineTree = new RBush<CoastlineEntry>();
        this.cautionTree = new RBush<CautionEntry>();

        const hazardEntries: BBoxEntry[] = [];
        let minLon = Infinity;
        let minLat = Infinity;
        let maxLon = -Infinity;
        let maxLat = -Infinity;

        for (const hazard of hazards) {
            let [hMinLon, hMinLat, hMaxLon, hMaxLat] = geometryBBox(hazard.geometry);
            // Thin hazards — point (rock/wreck/obstruction, incl. exploded
            // MultiPoints) and line (linear OBSTRN) — get a guard-radius
            // bbox pad so a route sample passing NEAR, not exactly on, still
            // selects them as a candidate. queryPoint then confirms with a
            // true distance test, so the square pad reads as a corridor.
            // Polygons (DEPARE/LNDARE/…) are unpadded (exact point-in-polygon).
            const gt = hazard.geometry.type;
            if (gt === 'Point' || gt === 'MultiPoint' || gt === 'LineString' || gt === 'MultiLineString') {
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

        // Build the caution-area tree (RESARE/CBLARE/PIPARE/TSSLPT). Own tree
        // like CATZOC/coastline: these are never grounding hazards, only a
        // crossing advisory, so they must not inflate the routing hazard query.
        const cautionEntries: CautionEntry[] = [];
        for (const area of cautionAreas) {
            const [aMinLon, aMinLat, aMaxLon, aMaxLat] = geometryBBox(area.geometry);
            cautionEntries.push({ minX: aMinLon, minY: aMinLat, maxX: aMaxLon, maxY: aMaxLat, area });
            if (aMinLon < minLon) minLon = aMinLon;
            if (aMinLat < minLat) minLat = aMinLat;
            if (aMaxLon > maxLon) maxLon = aMaxLon;
            if (aMaxLat > maxLat) maxLat = aMaxLat;
        }
        this.cautionTree.load(cautionEntries);

        this.bbox = Number.isFinite(minLon) ? [minLon, minLat, maxLon, maxLat] : [0, 0, 0, 0];
    }

    /**
     * Caution AREAS this route SEGMENT crosses (RESARE/CBLARE/PIPARE/TSSLPT) —
     * a warn-on-crossing advisory, NOT a reroute. Same segment-vs-polygon test
     * as segmentHazard (endpoint-inside OR the segment intersects an edge).
     */
    segmentCautions(lat1: number, lon1: number, lat2: number, lon2: number): EncCautionArea[] {
        const candidates = this.cautionTree.search({
            minX: Math.min(lon1, lon2),
            minY: Math.min(lat1, lat2),
            maxX: Math.max(lon1, lon2),
            maxY: Math.max(lat1, lat2),
        });
        if (candidates.length === 0) return [];
        const segLine = turfLineString([
            [lon1, lat1],
            [lon2, lat2],
        ]);
        const pA = turfPoint([lon1, lat1]);
        const pB = turfPoint([lon2, lat2]);
        const out: EncCautionArea[] = [];
        for (const entry of candidates) {
            const geom = entry.area.geometry;
            if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') continue;
            const crosses =
                booleanPointInPolygon(pA, geom) ||
                booleanPointInPolygon(pB, geom) ||
                lineIntersect(segLine, geom).features.length > 0;
            if (crosses) out.push(entry.area);
        }
        return out;
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
            } else if (geom.type === 'LineString' || geom.type === 'MultiLineString') {
                // Linear hazard (line OBSTRN — e.g. a charted foul-ground or
                // barrier). Same guard-radius corridor test as point hazards.
                inside = distanceToLineMetres(lat, lon, geom) <= POINT_HAZARD_GUARD_RADIUS_M;
            }
            if (!inside) continue;

            // Inside a charted feature (depth area, land, or a point hazard)
            // → this cell authoritatively covers the point, even when the
            // feature is DEEP water (classifyHazard → null below). EXCEPT a
            // spot sounding: a lone SOUNDG within the guard radius is hazard
            // EVIDENCE, never area coverage — it must not be able to suppress
            // the GEBCO fallback on its own (burn-down 2026-07-16).
            if (entry.hazard.layer !== 'SOUNDG') insideCharted = true;

            const type = classifyHazard(entry.hazard);
            if (!type) continue; // deep DEPARE/DRGARE — covered, not a hazard.

            // Most-severe wins via the SHARED comparator — worse TYPE first,
            // then (same type) the SHALLOWER / unknown depth. Calling the same
            // compareHazardSeverity the cross-cell fold uses makes the two
            // levels structurally incapable of disagreeing (audit: this was an
            // inline re-implementation of the ordering).
            if (bestType === null || compareHazardSeverity(type, entry.hazard.minDepthM, bestType, bestDepth) > 0) {
                bestType = type;
                bestDepth = entry.hazard.minDepthM;
            }
        }

        // A FOUND hazard is authoritative danger evidence regardless of area
        // coverage — a shoal sounding sitting in a coverage gap must still
        // flag. `soundingOnly` marks the no-area-coverage case so the caller
        // can fall through to GEBCO if the draft re-eval clears it (a lone
        // 12 m sounding must not certify the water around it).
        if (bestType !== null) {
            return {
                covered: true,
                hazard: true,
                minDepthM: bestDepth,
                hazardType: bestType,
                cellId: this.cellId,
                catzoc,
                ...(insideCharted ? {} : { soundingOnly: true }),
            };
        }

        // Inside the cell bbox and inside the candidates' bboxes, but inside
        // NO actual polygon → still a gap. Fall back to GEBCO.
        if (!insideCharted) {
            return { covered: false, hazard: false, minDepthM: null };
        }

        return { covered: true, hazard: false, minDepthM: null, cellId: this.cellId, catzoc };
    }

    /**
     * Worst POLYGON hazard the SEGMENT (lat1,lon1)→(lat2,lon2) CROSSES —
     * even when neither endpoint nor any discrete route sample falls inside
     * it. This closes the gap where a charted shoal DEPARE / LNDARE islet
     * NARROWER than the route sample spacing (231 m) slips between two
     * consecutive samples and reads as clear (mission audit #1, the top
     * remaining fail-dangerous finding).
     *
     * Only AREA features are tested here — point/line hazards are already
     * caught by the guarded queryPoint sampling, and re-testing them would
     * double-count. A segment "crosses" a polygon if either endpoint is
     * inside it OR the segment line intersects any polygon edge. Returns the
     * same covered/hazard shape as queryPoint so it folds through
     * mergeHazardResults identically; covered:false when this cell charts no
     * crossed polygon along the segment.
     */
    segmentHazard(
        lat1: number,
        lon1: number,
        lat2: number,
        lon2: number,
        exemptStart = false,
        exemptEnd = false,
    ): EncHazardResult {
        const candidates = this.hazardTree.search({
            minX: Math.min(lon1, lon2),
            minY: Math.min(lat1, lat2),
            maxX: Math.max(lon1, lon2),
            maxY: Math.max(lat1, lat2),
        });
        if (candidates.length === 0) {
            return { covered: false, hazard: false, minDepthM: null };
        }

        const segLine = turfLineString([
            [lon1, lat1],
            [lon2, lat2],
        ]);
        const pA = turfPoint([lon1, lat1]);
        const pB = turfPoint([lon2, lat2]);

        let bestType: EncHazardType | null = null;
        let bestDepth: number | null = null;
        let crossedCharted = false;

        for (const entry of candidates) {
            const geom = entry.hazard.geometry;
            let matched = false;
            if (geom.type === 'Polygon' || geom.type === 'MultiPolygon') {
                const inA = booleanPointInPolygon(pA, geom);
                const inB = booleanPointInPolygon(pB, geom);
                const boundaryCrossings = lineIntersect(segLine, geom).features;
                const crosses = inA || inB || boundaryCrossings.length > 0;
                // Berth exemption: the route's own origin/destination is often
                // inside a shoal AREA on purpose. When this endpoint is a route
                // TERMINAL, don't flag the leg merely for containing it — else
                // we'd detour the route away from its own start/finish. (Areas
                // only — a discrete rock is a hard hazard, never berth-exempt.)
                //
                // PER-LOCALITY (2026-07-17 closing audit, the last
                // fail-dangerous geometry in the routing path): the waiver
                // used to skip the ENTIRE (Multi)Polygon whenever the exempt
                // terminal sat anywhere inside it — a big terminal feature's
                // DISTANT arm crossed mid-leg was silently cleared. Now a
                // boundary crossing farther than BERTH_EXEMPT_RADIUS_M from
                // every exempt terminal still flags: the exemption covers the
                // berth's own water, never a different arm of the same
                // feature.
                if (crosses && ((exemptStart && inA) || (exemptEnd && inB))) {
                    const exemptPts: Array<[number, number]> = []; // [lat, lon]
                    if (exemptStart && inA) exemptPts.push([lat1, lon1]);
                    if (exemptEnd && inB) exemptPts.push([lat2, lon2]);
                    matched = boundaryCrossings.some((f) => {
                        const [cLon, cLat] = f.geometry.coordinates as [number, number];
                        return exemptPts.every(
                            ([eLat, eLon]) => metresBetween(cLat, cLon, eLat, eLon) > BERTH_EXEMPT_RADIUS_M,
                        );
                    });
                } else {
                    matched = crosses;
                }
            } else if (geom.type === 'Point') {
                // Point hazard within the guard corridor of the segment. This
                // is what catches a charted rock/wreck on a SHORT terminal leg
                // that sampleSegment skips (<231 m) — the sampled point query
                // can't see it, but the segment can (mission audit: terminal-
                // leg POINT blind zone). Also a redundant backstop on long legs.
                const [hLon, hLat] = geom.coordinates as [number, number];
                matched = pointToSegmentMetres(hLat, hLon, lat1, lon1, lat2, lon2) <= POINT_HAZARD_GUARD_RADIUS_M;
            } else if (geom.type === 'LineString' || geom.type === 'MultiLineString') {
                // Linear OBSTRN: the segment crosses it, or either endpoint is
                // within the guard corridor of it.
                matched =
                    lineIntersect(segLine, geom).features.length > 0 ||
                    distanceToLineMetres(lat1, lon1, geom) <= POINT_HAZARD_GUARD_RADIUS_M ||
                    distanceToLineMetres(lat2, lon2, geom) <= POINT_HAZARD_GUARD_RADIUS_M;
            }
            if (!matched) continue;

            crossedCharted = true;
            const type = classifyHazard(entry.hazard);
            if (!type) continue; // deep DEPARE/DRGARE the segment merely passes through.
            if (bestType === null || compareHazardSeverity(type, entry.hazard.minDepthM, bestType, bestDepth) > 0) {
                bestType = type;
                bestDepth = entry.hazard.minDepthM;
            }
        }

        if (!crossedCharted) {
            return { covered: false, hazard: false, minDepthM: null };
        }
        if (bestType === null) {
            return { covered: true, hazard: false, minDepthM: null, cellId: this.cellId };
        }
        return { covered: true, hazard: true, minDepthM: bestDepth, hazardType: bestType, cellId: this.cellId };
    }

    /**
     * Lateral NEAR-MISS of the SEGMENT to a charted AREA grounding hazard it
     * does NOT cross — the closest such boundary within the chart's ZOC-scaled
     * horizontal positional-uncertainty margin (burn-down 2026-07-18 #1).
     *
     * `segmentHazard` catches a leg that CROSSES a polygon; but a leg validated
     * "clean" can still run 5 m outside a drying-bank / shoal boundary in
     * ZOC-B (±50 m) water — inside the chart's own position error — with no
     * caveat. This returns that near-miss so the validator can advise a wider
     * berth. ADVISORY ONLY: it never reroutes and never suppresses coverage.
     *
     * AREA hazards only (land, shoal DEPARE/DRGARE, polygon OBSTRN), classified
     * by the SAME `classifyHazard` as the crossing test so graze and crossing
     * can never disagree about what counts as a hazard — the only difference is
     * cross → reroute vs near-miss → advise. Point/line hazards are excluded:
     * they already carry the 150 m guard radius in queryPoint/segmentHazard.
     *
     * Margin scales with survey confidence (zocMarginM at the segment
     * midpoint), so a well-surveyed channel (ZOC-A, ±5 m) does NOT fire on
     * normal channel-hugging while poorly-surveyed water flags at a wider
     * separation. A polygon the segment CROSSES (endpoint inside or edge
     * intersect) is skipped here — that is the crossing path's job. Returns the
     * most significant graze (land before shoal; then the closest) or null.
     */
    segmentAreaGraze(
        lat1: number,
        lon1: number,
        lat2: number,
        lon2: number,
        shoalDepthM: number = ENC_HAZARD_DEPTH_M,
    ): EncAreaGraze | null {
        const catzoc = this.queryCatzocAt((lat1 + lat2) / 2, (lon1 + lon2) / 2);
        const marginM = zocMarginM(catzoc);

        // Pad the segment bbox by the margin so a polygon whose (unpadded)
        // bbox sits up to marginM away is still a candidate — the crossing
        // search uses the exact bbox and would never see a near-miss.
        const dLat = marginM / METRES_PER_DEG_LAT;
        const midLat = (lat1 + lat2) / 2;
        const cosLat = Math.max(0.05, Math.cos((midLat * Math.PI) / 180));
        const dLon = marginM / (METRES_PER_DEG_LAT * cosLat);
        const candidates = this.hazardTree.search({
            minX: Math.min(lon1, lon2) - dLon,
            minY: Math.min(lat1, lat2) - dLat,
            maxX: Math.max(lon1, lon2) + dLon,
            maxY: Math.max(lat1, lat2) + dLat,
        });
        if (candidates.length === 0) return null;

        const segLine = turfLineString([
            [lon1, lat1],
            [lon2, lat2],
        ]);
        const pA = turfPoint([lon1, lat1]);
        const pB = turfPoint([lon2, lat2]);

        let best: EncAreaGraze | null = null;
        for (const entry of candidates) {
            const geom = entry.hazard.geometry;
            if (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon') continue;
            // Draft-aware AREA-hazard classification (cycle-4 closing audit #8:
            // the graze used classifyHazard's STATIC 15 m ENC_HAZARD_DEPTH_M
            // cutoff, so it over-warned a 2.4 m keel about deep-but-<15 m edges).
            // Land / polygon OBSTRN always count; a depth area counts ONLY when
            // it is actually too shallow FOR THE VESSEL — mirroring the CROSSING
            // path's encToHazardResult draft re-eval. `shoalDepthM` is the
            // positive-metres keel threshold (draft·1.5 + UKC); a route hugging a
            // deep-enough channel edge must NOT graze-flag.
            const layer = entry.hazard.layer;
            let type: EncHazardType | null;
            if (layer === 'LNDARE') type = 'land';
            else if (layer === 'OBSTRN') type = 'obstruction';
            else if (layer === 'DEPARE' || layer === 'DRGARE') {
                const d = entry.hazard.minDepthM;
                type = d == null || d < shoalDepthM ? 'shallow' : null;
            } else type = null;
            if (type === null) continue;
            // A polygon the segment actually crosses is a CROSSING, handled by
            // segmentHazard — never double-count it as a graze.
            if (
                booleanPointInPolygon(pA, geom) ||
                booleanPointInPolygon(pB, geom) ||
                lineIntersect(segLine, geom).features.length > 0
            ) {
                continue;
            }
            const clearanceM = segmentToPolygonMetres(lat1, lon1, lat2, lon2, geom);
            if (clearanceM > marginM) continue;
            const isLand = type === 'land';
            const bestIsLand = best?.type === 'land';
            // Land (drying bank / islet — the finding's scary case) outranks a
            // shoal graze; within the same class the CLOSEST wins.
            if (best === null || (isLand && !bestIsLand) || (isLand === bestIsLand && clearanceM < best.clearanceM)) {
                best = { clearanceM, marginM, catzoc, type };
            }
        }
        return best;
    }
}
