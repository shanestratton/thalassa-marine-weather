/**
 * ENC Integration — shared types.
 *
 * See docs/ENC_INTEGRATION.md for the architecture.
 *
 * S-57 ENC cells (.000 files from hydrographic offices) are converted
 * server-side (on the user's Pi) to GeoJSON, then loaded on the device
 * and queried via a spatial index.
 *
 * These types describe:
 *  - The hazard records we extract from each S-57 layer
 *  - The cell metadata we persist (one record per imported cell)
 *  - The shape of a hazard query result
 *  - The RBush spatial-index entry format
 */

import type { Geometry } from 'geojson';

// ── S-57 source layers we care about ───────────────────────────────

/**
 * Subset of S-57 layers we extract for routing.
 *
 * - DEPARE: depth area polygons (the gold for hazard checks)
 * - LNDARE: land area polygons (always hazard)
 * - OBSTRN: general obstructions
 * - WRECKS: wrecks
 * - UWTROC: underwater rocks
 *
 * Phase 2 will add COALNE (coastline lines, used as proximity buffer).
 */
export type EncLayer = 'DEPARE' | 'LNDARE' | 'OBSTRN' | 'WRECKS' | 'UWTROC';

/**
 * Hazard type after layer normalisation. Used for UI labels and
 * downstream rendering.
 */
export type EncHazardType = 'land' | 'shallow' | 'obstruction' | 'wreck' | 'rock';

// ── Hazard geometry ────────────────────────────────────────────────

/**
 * A single hazard extracted from one ENC layer.
 *
 * - For DEPARE we keep DRVAL1 (the minimum depth in the polygon).
 *   A polygon with DRVAL1 < HAZARD_DEPTH_M is treated as hazardous.
 * - For LNDARE the polygon is always a hazard regardless of depth.
 * - For OBSTRN/WRECKS we keep VALSOU when the obstruction has a
 *   sounding; nullish VALSOU is treated as "always hazard."
 * - For UWTROC we always treat the point as hazard (rocks don't go
 *   away).
 *
 * `geometry` is GeoJSON (`Polygon`, `MultiPolygon`, `Point`, or
 * `LineString` — the latter is unused in Phase 1 but reserved for
 * COALNE in Phase 2).
 */
export interface EncHazard {
    layer: EncLayer;
    geometry: Geometry;
    /**
     * Minimum depth in metres. Sourced from DEPARE.DRVAL1 or
     * OBSTRN/WRECKS.VALSOU. `null` means depth is unknown — caller
     * must treat as hazard regardless of vessel draft.
     *
     * NOTE: S-57 uses positive depths below sea level. We keep the
     * S-57 convention here (positive = depth) and convert at the
     * comparison point. (GEBCO uses negative for depth — opposite!)
     */
    minDepthM: number | null;
    /** Human-readable descriptor for UI/debug logs. */
    description?: string;
}

// ── Cell metadata (persisted to localStorage) ──────────────────────

/**
 * One imported ENC cell.
 *
 * The cell ID is the S-57 dataset name (e.g. "AU530150" for an
 * Australian cell). Edition + source HO let us de-duplicate when a
 * user re-imports an updated cell.
 */
export interface EncCell {
    /** S-57 dataset name (DSID/DSNM). */
    id: string;
    /** Source hydrographic office (AHO, NOAA, UKHO, NZ, etc.). */
    sourceHO: string;
    /** Edition number from S-57 DSID. */
    edition: number;
    /** S-57 issue date (ISO 8601). */
    issued: string;
    /** When the user imported this cell into the device. */
    importedAt: string;
    /** [minLon, minLat, maxLon, maxLat]. */
    bbox: [number, number, number, number];
    /** Path to GeoJSON blob on device filesystem (Capacitor). */
    geojsonPath: string;
    /** Total hazard count across all loaded layers (UI stat). */
    hazardCount: number;
}

// ── Query result ───────────────────────────────────────────────────

/**
 * Result of a per-point hazard query.
 *
 * Three meaningful states:
 *  - `covered: false` — no ENC cell covers this point. Caller should
 *    fall back to GEBCO.
 *  - `covered: true, hazard: false` — point is inside an ENC cell
 *    but no hazard polygon contains it. Authoritative "clear water"
 *    answer; caller should NOT call GEBCO for this point.
 *  - `covered: true, hazard: true` — point is inside a hazard. Full
 *    detail in `hazardType` / `minDepthM`.
 */
export interface EncHazardResult {
    covered: boolean;
    hazard: boolean;
    minDepthM: number | null;
    hazardType?: EncHazardType;
    cellId?: string;
}

// ── Spatial index entry (RBush format) ─────────────────────────────

/**
 * RBush requires entries to expose `minX/minY/maxX/maxY`. We
 * compute the bbox of each hazard's geometry once at index-build
 * time and carry the underlying hazard alongside.
 */
export interface BBoxEntry {
    minX: number;
    minY: number;
    maxX: number;
    maxY: number;
    hazard: EncHazard;
    cellId: string;
}

// ── Conversion pipeline (Pi → device) ──────────────────────────────

/**
 * Wire format returned by the Pi-cache `/api/charts/enc/convert`
 * endpoint. The Pi runs `ogr2ogr -f GeoJSON` on each layer of
 * interest, packages cell metadata, and ships this JSON back.
 *
 * Layers are returned as raw GeoJSON FeatureCollections so we can
 * stream/parse them lazily on the device.
 */
export interface EncConversionResult {
    cellId: string;
    sourceHO: string;
    edition: number;
    issued: string;
    bbox: [number, number, number, number];
    layers: {
        DEPARE?: GeoJSON.FeatureCollection;
        LNDARE?: GeoJSON.FeatureCollection;
        OBSTRN?: GeoJSON.FeatureCollection;
        WRECKS?: GeoJSON.FeatureCollection;
        UWTROC?: GeoJSON.FeatureCollection;
    };
}

// ── Constants ──────────────────────────────────────────────────────

/**
 * Depth threshold at which a DEPARE polygon is treated as hazardous
 * (positive metres, S-57 convention). Anything shallower than this
 * is rejected by the routing validator.
 *
 * Matches the GEBCO threshold (`-15m`) flipped to S-57 convention.
 * Will become user-configurable (vessel draft + safety margin) in
 * Phase 3.
 */
export const ENC_HAZARD_DEPTH_M = 15;

/**
 * localStorage key prefix for cell metadata records.
 * One record per cell at `${ENC_METADATA_PREFIX}:${cellId}`.
 */
export const ENC_METADATA_PREFIX = 'thalassa.enc.cell';

/**
 * Capacitor Filesystem subdirectory for cached GeoJSON blobs.
 * One file per cell at `${ENC_GEOJSON_DIR}/${cellId}.geojson`.
 */
export const ENC_GEOJSON_DIR = 'enc-cells';
