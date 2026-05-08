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
 * Hazard layers (drive routing detours):
 * - DEPARE: depth area polygons (the gold for hazard checks)
 * - LNDARE: land area polygons (always hazard)
 * - OBSTRN: general obstructions
 * - WRECKS: wrecks
 * - UWTROC: underwater rocks
 *
 * Soft / info layers (rendered + reported, never reroute):
 * - COALNE: coastline lines, used for proximity warnings
 * - LIGHTS: lights / lighthouses (display only)
 * - BOYLAT: lateral buoys (display only)
 * - BOYCAR: cardinal buoys (display only)
 * - M_QUAL: zones of confidence (CATZOC). Tagged on every result.
 */
export type EncLayer = 'DEPARE' | 'LNDARE' | 'OBSTRN' | 'WRECKS' | 'UWTROC' | 'COALNE';

/**
 * Aids-to-navigation layers. Display-only — never affect routing,
 * never appear in the hazard report. Carried separately from
 * EncLayer because the hazard pipeline iterates EncLayer and we
 * don't want navaids walked into hazard processing.
 */
export type EncNavaidLayer = 'LIGHTS' | 'BOYLAT' | 'BOYCAR';

/**
 * Layers we ship in the conversion result but treat as info-only.
 * Listed separately so type-checkers don't complain when the
 * hazard pipeline iterates EncLayer.
 */
export type EncInfoLayer = 'M_QUAL';

/**
 * Hazard type after layer normalisation. Used for UI labels and
 * downstream rendering. `coast` is a soft hazard surfaced only by
 * the proximity report — routes are never rerouted around it,
 * just flagged when they pass close.
 */
export type EncHazardType = 'land' | 'shallow' | 'obstruction' | 'wreck' | 'rock' | 'coast';

/**
 * S-57 CATZOC (Categories of Zone of Confidence) values for
 * M_QUAL polygons. Numeric IHO codes — we keep them as numbers
 * because that's what GDAL outputs.
 *
 * 1 = A1 — full systematic survey, ±5 m horizontal, ±0.5 m + 1% depth
 * 2 = A2 — full systematic survey, ±20 m horizontal, ±1.0 m + 2% depth
 * 3 = B  — full systematic survey, ±50 m horizontal, ±1.0 m + 2% depth
 * 4 = C  — partial / less rigorous survey, ±500 m horizontal, ±2.0 m + 5% depth
 * 5 = D  — poor / sparse soundings, worse than C
 * 6 = U  — unassessed — quality of survey not assessed
 *
 * Lower number = higher confidence. CATZOC C/D/U routes warrant a
 * "verify visually" warning to the user. CATZOC U is the danger
 * zone — Pacific atolls and remote shores are often U.
 */
export type EncCatzoc = 1 | 2 | 3 | 4 | 5 | 6;

/** Human-readable letter codes used in IHO publications. */
export const CATZOC_LABELS: Record<EncCatzoc, string> = {
    1: 'A1',
    2: 'A2',
    3: 'B',
    4: 'C',
    5: 'D',
    6: 'U',
};

/**
 * True if a route passing through `c` should surface a "verify
 * visually" warning. C/D/U zones have positional uncertainty of
 * 500 m or worse — small islets/reefs may be off-chart.
 */
export function isLowConfidenceCatzoc(c: EncCatzoc | null | undefined): boolean {
    if (c == null) return true; // No M_QUAL data → assume worst.
    return c >= 4;
}

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
    /**
     * CATZOC range present in the cell's M_QUAL coverage.
     * `[best, worst]` (smaller numbers = higher confidence).
     * Null when M_QUAL data was not present in the source cell.
     */
    catzocRange?: [EncCatzoc, EncCatzoc] | null;
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
 *
 * `catzoc` is the M_QUAL CATZOC at the queried point, when the
 * cell ships M_QUAL data. Null means no M_QUAL polygon covers this
 * exact point (rare — most cells have full M_QUAL coverage).
 */
export interface EncHazardResult {
    covered: boolean;
    hazard: boolean;
    minDepthM: number | null;
    hazardType?: EncHazardType;
    cellId?: string;
    catzoc?: EncCatzoc | null;
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
        /** Coastline LineStrings — used for proximity warnings only. */
        COALNE?: GeoJSON.FeatureCollection;
        /** Lights / lighthouses (point features). Display only. */
        LIGHTS?: GeoJSON.FeatureCollection;
        /** Lateral buoys (point features). Display only. */
        BOYLAT?: GeoJSON.FeatureCollection;
        /** Cardinal buoys (point features). Display only. */
        BOYCAR?: GeoJSON.FeatureCollection;
        /** Zones of confidence (CATZOC). Info-only — not a hazard. */
        M_QUAL?: GeoJSON.FeatureCollection;
    };
}

/**
 * Wire format for batch (multi-cell) conversion results. The Pi
 * always returns this shape from `/api/enc/result/:id` so the
 * client can handle single-cell uploads (`cells.length === 1`)
 * and ZIP uploads (`cells.length === N`) with the same code path.
 *
 * `skipped` lists cells the Pi could not convert — e.g. a corrupted
 * `.000` inside a multi-cell ZIP — so the UI can surface them
 * without aborting the whole batch.
 */
export interface EncConversionBatch {
    cells: EncConversionResult[];
    skipped?: { filename: string; error: string }[];
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
