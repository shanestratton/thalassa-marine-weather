/**
 * ENC Hazard Service — public API for ENC-based routing checks.
 *
 * Composes the three lower-level pieces:
 *   - EncCellMetadata (which cells do I have, where are they?)
 *   - EncCellStore    (load GeoJSON blobs from device filesystem)
 *   - EncSpatialIndex (RBush + point-in-polygon, per cell)
 *
 * Hands a clean batch-query interface up to HazardQueryService:
 *   queryHazards(points[]) → EncHazardResult[]
 *
 * Per-cell spatial indexes are built lazily on first use and
 * cached in memory for the session. We don't evict aggressively in
 * Phase 1 — most users will have 1–10 cells, and the cost of
 * rebuilding an index from a 10k-feature cell is meaningful (tens
 * of ms). Phase 3 can add LRU eviction if a fleet user starts
 * importing every Australian cell.
 *
 * Lifecycle:
 *   1. Pi-cache converts a .000 → JSON (EncConversionResult)
 *   2. EncImportService calls importCell(result)
 *      → blob written to filesystem (EncCellStore)
 *      → metadata record written (EncCellMetadata)
 *   3. landAvoidance later asks HazardQueryService for hazards
 *      → HazardQueryService asks queryHazards()
 *      → we resolve relevant cells from metadata
 *      → load + index any not-yet-loaded cells
 *      → run point-in-polygon for each query point
 */

import type { Feature, FeatureCollection } from 'geojson';
import { accumulateCellLayers, applySoundingLod, createClipGeometryMemos } from './mergeFold';
import { dispatchGeometryWork, type GlazeUpgradeItem } from './geometryUpgrades';
// Consumers (render hook, tests) reach the worker plumbing through this
// module's established surface — re-export the carved-out subsystem.
export { subscribeGeometryUpgrades, buildContourPayload } from './geometryUpgrades';
import { ensureGlazeCapacity } from './glazeCellCache';
import { touchIndex, cacheIndex, isIndexFailed, markIndexFailed, dropIndex, clearIndexCache } from './encIndexCache';
import {
    getMergedData,
    putMergedData,
    clearMergedData,
    getInflightMerge,
    setInflightMerge,
    deleteInflightMerge,
} from './mergedDataCache';

import { createLogger } from '../../utils/createLogger';
import { mapWithConcurrency } from '../../utils/concurrency';
import * as cellStore from './EncCellStore';
import * as cellMeta from './EncCellMetadata';
import { cellScaleRank } from './scaleShadow';
import { type CoverageGeom, type FineCoverage } from './clipDepareOverlap';
import { EncSpatialIndex } from './EncSpatialIndex';
import {
    buildCatzocZones,
    buildCautionAreas,
    buildCoastlines,
    buildHazardsForCell,
    readNumber,
} from './encHazardParse';
import type { EncCautionArea } from './EncSpatialIndex';
import { mergeHazardResults, grazeOutranks } from './hazardSeverity';
import { ENC_HAZARD_DEPTH_M } from './types';
import type { EncAreaGraze, EncCatzoc, EncCell, EncConversionResult, EncHazardResult } from './types';
import { crumb } from '../../utils/flightRecorder';

const log = createLogger('EncHazardService');

// Macrotask yield WITHOUT the timer clamp: iOS/WebKit clamps setTimeout(0) to
// ~1–4 ms, and the merge's time-slicer yields ~40 times per merge — 40–160 ms
// of pure waiting per merge (z10-boot audit, 2026-07-16). A MessageChannel
// post lands on the next macrotask unclamped. Falls back to setTimeout where
// MessageChannel is unavailable.
const yieldChannel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
let yieldWaiters: Array<() => void> = [];
if (yieldChannel) {
    yieldChannel.port1.onmessage = () => {
        const waiters = yieldWaiters;
        yieldWaiters = [];
        for (const w of waiters) w();
    };
}
function macroYield(): Promise<void> {
    if (!yieldChannel) return new Promise((resolve) => setTimeout(resolve, 0));
    return new Promise((resolve) => {
        yieldWaiters.push(resolve);
        yieldChannel.port2.postMessage(null);
    });
}

// ── In-memory index cache ──────────────────────────────────────────

/**
 * One EncSpatialIndex per loaded cell. Keyed by cell ID.
 * Built lazily on first query that touches a given cell.
 *
 * LRU-CAPPED (2026-07-12 audit): "we don't evict aggressively" was
 * sized for the 1–10-cell era; the shipped library is 172 cells and a
 * long coastal routing session pinned 30+ cells' full hazard geometry
 * for the session — surviving even blob-cache eviction, so freeing the
 * blob stopped freeing memory. Indexes rebuild from blobs in tens of
 * ms; keeping a passage-leg's worth warm is plenty.
 */
// The per-cell spatial-index LRU + failed-load set now own their own module
// (encIndexCache.ts) — one more step decomposing this god-module's caches
// (mission audit). touchIndex/cacheIndex/isIndexFailed/markIndexFailed/
// dropIndex/clearIndexCache are imported below.

// ── GeoJSON → EncHazard parsing ───────────────────────────────────
// Extracted to ./encHazardParse (pure + unit-tested — this path feeds the
// router's grounding-avoidance index, so it earns its own coverage).

// ── Lazy index loader ─────────────────────────────────────────────

/**
 * Get (or build) the spatial index for one cell. Returns null if
 * the cell metadata is missing, the blob is missing/corrupt, or
 * the cell has no hazards.
 */
async function getOrBuildIndex(cellId: string): Promise<EncSpatialIndex | null> {
    const cached = touchIndex(cellId);
    if (cached) return cached;
    if (isIndexFailed(cellId)) return null;

    const meta = cellMeta.getCell(cellId);
    if (!meta) {
        log.warn(`getOrBuildIndex ${cellId}: no metadata record`);
        markIndexFailed(cellId);
        return null;
    }

    const blob = await cellStore.loadCellGeoJSON(cellId);
    if (!blob) {
        log.warn(`getOrBuildIndex ${cellId}: GeoJSON missing or corrupt — user will need to re-import`);
        markIndexFailed(cellId);
        return null;
    }

    // COARSE-SLICED (closing audit: the four builds + RBush construction
    // ran as ONE synchronous gulp per cell on the routing path — a dense
    // harbour cell froze a frame mid-validation). A macrotask between
    // stages keeps frames flowing; total CPU unchanged.
    const hazards = buildHazardsForCell(blob);
    await macroYield();
    const catzocZones = buildCatzocZones(blob);
    const coastlines = buildCoastlines(blob);
    await macroYield();
    const cautionAreas = buildCautionAreas(blob);
    const index = new EncSpatialIndex(cellId, hazards, catzocZones, coastlines, cautionAreas);
    cacheIndex(cellId, index);
    log.info(
        `built spatial index for cell ${cellId}: ${hazards.length} hazards, ` +
            `${catzocZones.length} CATZOC zones, ${coastlines.length} coastlines, ` +
            `${cautionAreas.length} caution areas`,
    );
    return index;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * True if any ENC cells are imported. Used by HazardQueryService
 * to early-exit when no ENCs exist.
 */
export function hasAnyCells(): boolean {
    return cellMeta.listCells().length > 0;
}

/**
 * List every imported cell (metadata only — does not touch the
 * filesystem). Used by the chart locker UI.
 */
export function getCoverage(): EncCell[] {
    return cellMeta.listCells();
}

/**
 * True if any imported cell's bbox intersects `bbox`. Cheap O(n)
 * over the small metadata list — does not load any GeoJSON.
 *
 * `bbox` is `[minLon, minLat, maxLon, maxLat]`.
 */
export function hasCoverageFor(bbox: [number, number, number, number]): boolean {
    return cellMeta.cellsForBBox(bbox).length > 0;
}

/**
 * Pre-warm spatial indexes for every cell intersecting `bbox`.
 * Optional — `queryHazards` will lazy-load on demand — but useful
 * for the validator to call once at the start of routing so the
 * first query isn't paying the index-build cost.
 */
export async function preloadForBBox(bbox: [number, number, number, number]): Promise<void> {
    // CAPPED pool, not Promise.all: a route-length bbox over the
    // 172-cell cloud library used to fire dozens of simultaneous
    // multi-MB downloads + main-thread parses (2026-07-12 audit —
    // marina-wifi route planning stalled for minutes).
    const cells = cellMeta.cellsForBBox(bbox);
    await mapWithConcurrency(cells, 4, (c) => getOrBuildIndex(c.id));
}

/**
 * Batch-query hazards for an array of points.
 *
 * For each point:
 *  - If no imported cell covers the point → `covered: false`
 *    (caller falls back to GEBCO)
 *  - If a cell covers the point → run the cell's spatial index
 *    and return the (possibly clear-water) authoritative answer
 *
 * If a point falls into multiple overlapping cells (e.g. AHO +
 * NOAA in Torres Strait), we merge results by severity: any
 * hazard hit wins, otherwise the first covered "clear" answer.
 */
/**
 * Resolve the spatial indexes for every imported cell intersecting `bbox`,
 * built through the capped pool (same flood risk as preloadForBBox when the
 * bbox spans a route) and DETERMINISTICALLY sorted by cellId. The severity
 * fold is a total order so correctness never depended on iteration order,
 * but the pool completes nondeterministically — the sort makes per-segment
 * caution lists and any diagnostic output reproducible. (Burn-down: this
 * block was triplicated across the three query APIs.)
 */
async function resolveCandidateIndexes(bbox: [number, number, number, number]): Promise<EncSpatialIndex[]> {
    const candidateCells = cellMeta.cellsForBBox(bbox);
    if (candidateCells.length === 0) return [];
    const out: EncSpatialIndex[] = [];
    await mapWithConcurrency(candidateCells, 4, async (cell) => {
        const idx = await getOrBuildIndex(cell.id);
        if (idx) out.push(idx);
    });
    out.sort((a, b) => a.getCellId().localeCompare(b.getCellId()));
    return out;
}

export async function queryHazards(points: { lat: number; lon: number }[]): Promise<EncHazardResult[]> {
    const results: EncHazardResult[] = new Array(points.length);
    if (points.length === 0) return results;
    if (!hasAnyCells()) {
        for (let i = 0; i < points.length; i++) {
            results[i] = { covered: false, hazard: false, minDepthM: null };
        }
        return results;
    }

    // Compute the bbox of the query so we can pre-resolve the
    // candidate cell set once instead of per-point.
    let qMinLon = Infinity;
    let qMinLat = Infinity;
    let qMaxLon = -Infinity;
    let qMaxLat = -Infinity;
    for (const p of points) {
        if (p.lon < qMinLon) qMinLon = p.lon;
        if (p.lat < qMinLat) qMinLat = p.lat;
        if (p.lon > qMaxLon) qMaxLon = p.lon;
        if (p.lat > qMaxLat) qMaxLat = p.lat;
    }
    const candidateIndexes = await resolveCandidateIndexes([qMinLon, qMinLat, qMaxLon, qMaxLat]);
    if (candidateIndexes.length === 0) {
        for (let i = 0; i < points.length; i++) {
            results[i] = { covered: false, hazard: false, minDepthM: null };
        }
        return results;
    }

    // Per-point query against the resolved indexes. Fold every covering
    // cell's result through mergeHazardResults, which keeps the MOST SEVERE
    // (most conservative for grounding). It's a total-order max, so the
    // nondeterministic candidate-resolution order can't change the answer,
    // and a shallower/worse hazard from a second overlapping cell can't be
    // masked by the first cell's milder one (mission-audit fix).
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        let merged: EncHazardResult = { covered: false, hazard: false, minDepthM: null };
        for (const idx of candidateIndexes) {
            const r = idx.queryPoint(p.lat, p.lon);
            if (!r.covered) continue;
            merged = mergeHazardResults(merged, r);
        }
        results[i] = merged;
    }
    return results;
}

/**
 * Segment-level companion to queryHazards: for each segment, the worst
 * POLYGON hazard it CROSSES, folded across every covering cell via the
 * same total-order mergeHazardResults. Catches a charted shoal/islet
 * thinner than the route sample spacing that the point query would miss
 * between samples (mission audit #1). ENC-only — GEBCO is raster (no
 * polygons), so the sampled point query remains its backstop.
 */
export async function querySegmentHazards(
    segments: {
        lat1: number;
        lon1: number;
        lat2: number;
        lon2: number;
        exemptStart?: boolean;
        exemptEnd?: boolean;
    }[],
    // Positive-metres keel threshold (draft·1.5 + UKC) for the DRAFT-AWARE
    // lateral-graze classification (cycle-4 audit #8). Defaults to the static
    // shallow ceiling when the caller has no draft — HazardQueryService always
    // supplies the real per-vessel value.
    grazeShoalDepthM: number = ENC_HAZARD_DEPTH_M,
): Promise<EncHazardResult[]> {
    const results: EncHazardResult[] = new Array(segments.length);
    if (segments.length === 0) return results;
    const miss = () => ({ covered: false as const, hazard: false as const, minDepthM: null });
    if (!hasAnyCells()) {
        for (let i = 0; i < segments.length; i++) results[i] = miss();
        return results;
    }

    let qMinLon = Infinity;
    let qMinLat = Infinity;
    let qMaxLon = -Infinity;
    let qMaxLat = -Infinity;
    for (const s of segments) {
        qMinLon = Math.min(qMinLon, s.lon1, s.lon2);
        qMinLat = Math.min(qMinLat, s.lat1, s.lat2);
        qMaxLon = Math.max(qMaxLon, s.lon1, s.lon2);
        qMaxLat = Math.max(qMaxLat, s.lat1, s.lat2);
    }
    const candidateIndexes = await resolveCandidateIndexes([qMinLon, qMinLat, qMaxLon, qMaxLat]);
    if (candidateIndexes.length === 0) {
        for (let i = 0; i < segments.length; i++) results[i] = miss();
        return results;
    }

    for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        let merged: EncHazardResult = miss();
        // Lateral-graze near-miss (burn-down 2026-07-18 #1) rides its OWN fold
        // channel: mergeHazardResults returns one winning result wholesale, so
        // a graze from a NON-winning cell would be dropped. Accumulate it
        // independently of the severity merge and attach it after.
        let graze: EncAreaGraze | null = null;
        for (const idx of candidateIndexes) {
            const r = idx.segmentHazard(s.lat1, s.lon1, s.lat2, s.lon2, s.exemptStart, s.exemptEnd);
            if (r.covered) merged = mergeHazardResults(merged, r);
            const g = idx.segmentAreaGraze(s.lat1, s.lon1, s.lat2, s.lon2, grazeShoalDepthM);
            if (g) graze = foldGraze(graze, g);
        }
        results[i] = graze ? { ...merged, graze } : merged;
    }
    return results;
}

/** Fold two per-cell lateral grazes into the more significant one for the same
 *  segment: land (drying bank / islet) before shoal/obstruction, then the
 *  closest. Mirrors the ranking inside segmentAreaGraze so the cross-cell fold
 *  and the per-cell pick agree. */
function foldGraze(a: EncAreaGraze | null, b: EncAreaGraze | null): EncAreaGraze | null {
    if (a === null) return b;
    if (b === null) return a;
    return grazeOutranks(a, b) ? a : b; // the ONE graze ordering (hazardSeverity)
}

/**
 * Caution AREAS each route SEGMENT crosses (restricted / cable / pipeline /
 * TSS), composed across every covering cell and de-duped by class+name+RESTRN.
 * A warn-on-crossing advisory — never a reroute. Empty when no ENC coverage.
 */
export async function querySegmentCautions(
    segments: { lat1: number; lon1: number; lat2: number; lon2: number }[],
): Promise<EncCautionArea[][]> {
    const results: EncCautionArea[][] = segments.map(() => []);
    if (segments.length === 0 || !hasAnyCells()) return results;

    let qMinLon = Infinity;
    let qMinLat = Infinity;
    let qMaxLon = -Infinity;
    let qMaxLat = -Infinity;
    for (const s of segments) {
        qMinLon = Math.min(qMinLon, s.lon1, s.lon2);
        qMinLat = Math.min(qMinLat, s.lat1, s.lat2);
        qMaxLon = Math.max(qMaxLon, s.lon1, s.lon2);
        qMaxLat = Math.max(qMaxLat, s.lat1, s.lat2);
    }
    const candidateIndexes = await resolveCandidateIndexes([qMinLon, qMinLat, qMaxLon, qMaxLat]);
    if (candidateIndexes.length === 0) return results;

    for (let i = 0; i < segments.length; i++) {
        const s = segments[i];
        const seen = new Set<string>();
        for (const idx of candidateIndexes) {
            for (const area of idx.segmentCautions(s.lat1, s.lon1, s.lat2, s.lon2)) {
                const key = `${area.cls}|${area.name ?? ''}|${area.restrn ?? ''}`;
                if (seen.has(key)) continue;
                seen.add(key);
                results[i].push(area);
            }
        }
    }
    return results;
}

// ── Import / mutation ─────────────────────────────────────────────

/**
 * Import a converted cell. Persists the GeoJSON blob to filesystem
 * and writes the metadata record. Drops any in-memory index for
 * this cell ID so the next query rebuilds it from the new blob.
 *
 * Used by the ChartLocker import flow once Pi conversion succeeds.
 */
export async function importCell(blob: EncConversionResult): Promise<EncCell> {
    // sizeBytes rides back from the save — it used to be re-measured
    // with a SECOND full JSON.stringify of the multi-MB blob right
    // after the save's own (2026-07-12 audit: ~2× CPU + a transient
    // twin allocation per imported cell, on the UI thread).
    const { path, sizeBytes } = await cellStore.saveCellGeoJSON(blob.cellId, blob);

    // Rough hazard count for the metadata record (without parsing
    // every feature). Small inaccuracy is fine — UI stat only.
    // We exclude M_QUAL from this count because it's coverage
    // info, not a hazard.
    let hazardCount = 0;
    for (const [layer, fc] of Object.entries(blob.layers)) {
        if (layer === 'M_QUAL') continue;
        if (fc && Array.isArray(fc.features)) hazardCount += fc.features.length;
    }

    // Compute the cell's CATZOC range up front so the UI can show
    // it without forcing a spatial-index build.
    const zones = buildCatzocZones(blob);
    let catzocRange: [EncCatzoc, EncCatzoc] | null = null;
    if (zones.length > 0) {
        let best: EncCatzoc = zones[0].catzoc;
        let worst: EncCatzoc = zones[0].catzoc;
        for (const z of zones) {
            if (z.catzoc < best) best = z.catzoc;
            if (z.catzoc > worst) worst = z.catzoc;
        }
        catzocRange = [best, worst];
    }

    // sizeBytes — content fingerprint used by syncEncFromPi to detect
    // re-extractions with the same cellId+edition (e.g. when the
    // senc-extractor's rogue-triangle filter improves). Stringify length
    // matches the bytes the Pi reported in its installed-cells index.
    const cell: EncCell = {
        id: blob.cellId,
        sourceHO: blob.sourceHO,
        edition: blob.edition,
        issued: blob.issued,
        importedAt: new Date().toISOString(),
        bbox: blob.bbox,
        geojsonPath: path,
        hazardCount,
        catzocRange,
        sizeBytes,
    };
    cellMeta.putCell(cell);

    // Drop any stale index — next query rebuilds.
    dropIndex(cell.id);

    const catzocStr = catzocRange ? ` CATZOC ${catzocRange[0]}..${catzocRange[1]}` : '';
    log.info(`imported cell ${cell.id} (${cell.sourceHO} ed.${cell.edition}): ${hazardCount} features${catzocStr}`);
    return cell;
}

/**
 * Forget a cell: remove metadata, delete blob, drop any cached
 * spatial index. Idempotent.
 */
export async function removeCell(cellId: string): Promise<void> {
    cellMeta.removeCell(cellId);
    await cellStore.deleteCellGeoJSON(cellId);
    dropIndex(cellId);
    log.info(`removed cell ${cellId}`);
}

/**
 * Drop the in-memory index cache without touching persistent
 * storage. Used for tests and for the "reload charts" admin
 * action.
 */
export function dropIndexCache(): void {
    clearIndexCache();
}

/**
 * Lazy-load (if needed) and return the spatial index for a single
 * cell. Used by the hazard-report service to do multi-cell bbox
 * searches without exposing the whole index Map.
 *
 * Returns null if metadata is missing, the GeoJSON blob is
 * unreadable, or the cell ID is unknown. Failed loads retry after a
 * 60 s cooldown (encIndexCache.INDEX_FAIL_RETRY_MS) — a transient read
 * failure recovers on a later query; re-import clears immediately.
 */
export async function getIndexForCell(cellId: string): Promise<EncSpatialIndex | null> {
    return getOrBuildIndex(cellId);
}

// ── Merged-vector access (for the map vector layer) ───────────────

/**
 * Per-layer merged FeatureCollections across every imported cell.
 * Returned by `getMergedVectorData`; consumed by EncVectorLayer
 * to push to Mapbox as GeoJSON sources.
 *
 * Each feature is decorated with `cellId` and `sourceHO` in its
 * properties so the rendering layer can keep provenance for
 * click-handlers and per-cell styling.
 */
export interface EncMergedVectorData {
    /** Depth areas. Includes DRGARE (dredged areas) — both carry
     *  DRVAL1 so dredged basins shade with the same draft-aware
     *  bands as natural depth areas. */
    DEPARE: FeatureCollection;
    LNDARE: FeatureCollection;
    COALNE: FeatureCollection;
    OBSTRN: FeatureCollection;
    WRECKS: FeatureCollection;
    UWTROC: FeatureCollection;
    /** Depth contour lines (VALDCO metres). Display only. */
    DEPCNT: FeatureCollection;
    /** Depth contours INTERPOLATED from our own spot soundings (honest
     *  densification, `_derived: true`) — drawn dashed/faint so they can
     *  never pass for surveyed DEPCNT. See services/enc/derivedContours.ts. */
    DEPCNT_DERIVED: FeatureCollection;
    /** Lights / lighthouses (display only). */
    LIGHTS: FeatureCollection;
    /** Light-sector arcs + limit legs, generated at merge time from
     *  sectored LIGHTS features (SECTR1/SECTR2/COLOUR) — the night
     *  approach read "am I in the white, red, or green?". Display only.
     *  See services/enc/lightSectors.ts. */
    LIGHTSEC: FeatureCollection;
    /** Lateral buoys (display only). */
    BOYLAT: FeatureCollection;
    /** Cardinal buoys (display only). */
    BOYCAR: FeatureCollection;
    /** Lateral beacons — rigid lateral marks (display only). */
    BCNLAT: FeatureCollection;
    /** Cardinal beacons — rigid cardinal marks (display only). */
    BCNCAR: FeatureCollection;
    /** Special-purpose buoys — yellow X (display only). */
    BOYSPP: FeatureCollection;
    /** Special-purpose beacons — yellow X (display only). */
    BCNSPP: FeatureCollection;
    /** Safe-water marks — RW fairway/landfall (display only). */
    BOYSAW: FeatureCollection;
    BCNSAW: FeatureCollection;
    /** Isolated-danger marks — BRB, navigable water all round (display only). */
    BOYISD: FeatureCollection;
    BCNISD: FeatureCollection;
    /** Recommended tracks / leading lines (RECTRC line features).
     *  The same geometry the tracer grades leads against — drawing
     *  it is what lets a punter STEER by the lead (Shane 2026-07-09
     *  "show markers, leads, laterals and cardinals"). */
    RECTRC: FeatureCollection;
    /** Spot soundings, EXPLODED to one Point per measurement with a
     *  minimal `{_d, _minZoom?}` property bag (Shane 2026-07-09 "more
     *  depth measurements in close"). Source cells carry them as
     *  MultiPoint clouds (SENC: 2-D coords + `depths` array; ogr2ogr:
     *  25D coords) — kept compact on disk, exploded here because a
     *  Mapbox symbol layer can only label per-FEATURE, not per-vertex. */
    SOUNDG: FeatureCollection;
    /** DEPARE(+DRGARE) with coarse-cell polygons geometrically CUT OUT
     *  of finer cells' charted coverage (clipDepareOverlap — "that
     *  day" arrived 2026-07-12). The satellite GLAZE paints bands
     *  translucently, and translucent fills STACK: everywhere two
     *  cells charted the same water the glaze double-painted into
     *  hard-edged darker wedges ("horrible 80's style rendering").
     *  Chart mode keeps drawing the UNCLIPPED collection — its fills
     *  are near-opaque and coarse→fine paint order already hides
     *  overlaps without the clip's bare-patch risk. */
    DEPARE_GLAZE: FeatureCollection;
    /** ONE label point per named sea area (SEAARE OBJNAM — "Mooloolah
     *  River", "Pumicestone Passage"), deduped finest-cell-wins across
     *  the window. Point features `{_name}` only — the polygons never
     *  leave the merge (Shane 2026-07-13: "put the channel name in the
     *  channels"). */
    SEAARE_LABELS: FeatureCollection;
    /** Caution / information AREAS — restricted (RESARE), submarine cable
     *  (CBLARE), pipeline (PIPARE), seabed nature (SBDARE), TSS lane part
     *  (TSSLPT). ONE collection; each feature tagged `_caution` with its
     *  S-57 class so the render can style them apart. Chart furniture — a
     *  best-in-class ENC flags no-anchor / restricted / TSS zones. */
    CAUTION_AREAS: FeatureCollection;
    /** Marked fairway polygons — rendered as a dashed boundary LINE only
     *  (a tappable fill would blanket the channel and steal the water tap).
     *  Also the routing preference input. */
    FAIRWY: FeatureCollection;
    /** Total cells contributing data. */
    cellCount: number;
}

/**
 * Merged-data memo — keyed by the SELECTED CELL SET + registry version,
 * not raw window coords (2026-07-12 audit): a pinch-zoom from z8 to z16
 * used to rebuild byte-identical output ~8 times because every whole-
 * zoom crossing minted a new window key over the same cells. TWO slots
 * so the windowed render merge and the seaway debug full merge stop
 * evicting each other on every moveend.
 */
// The merged-data memo + single-flight guard now own their own module
// (mergedDataCache.ts) — get/put/clearMergedData + get/set/deleteInflightMerge
// imported below. One more step decomposing this god-module's caches.

/** DEPARE data extents are deterministic per parsed blob — memoized by
 *  blob identity so re-merges skip the full coordinate re-walk
 *  (100k+ coords per coastal cell, every window escape). Evicts with
 *  the blob itself (WeakMap). */
const depareExtentCache = new WeakMap<object, [number, number, number, number] | null>();

// Per-cell GLAZE output cache now owns its own module (glazeCellCache.ts) —
// one more step decomposing this god-module's 16 module-scope caches
// (mission audit). getGlazeCell/putGlazeCell are imported below.

/** Durable memo for the worker's derived contours — the DEPCNT_DERIVED
 *  analogue of glazeCellCache (2026-07-15). Without it the contours live
 *  ONLY inside the merged-data object, and mergedCache holds just
 *  MERGED_CACHE_MAX entries: a stepwise zoom excursion past z12 and back
 *  evicts the d1 merge, so the rebuild returns empty DEPCNT_DERIVED and
 *  the faint densification BLANKS until the re-dispatched worker answers
 *  (~a few hundred ms). Keyed by the merge cacheKey — which already
 *  encodes cell set + densify flag + sounding-LOD bucket, so an identical
 *  key means an identical sounding set means identical contours — a
 *  re-merge reuses the computed lines synchronously: no flicker, no
 *  redundant worker pass. Now owns its own module (derivedContourCache.ts)
 *  as one step of decomposing this god-module's 11+ caches. */

/**
 * Build the per-layer FeatureCollections by reading every imported
 * cell's GeoJSON from filesystem and concatenating features. Cached
 * across calls within a single cell-list version (i.e. until the
 * user imports or removes a cell).
 *
 * Memory caveat: this loads every cell's full vector data into
 * memory at once. For the typical 1-10 cell user, ~5-50 MB total
 * — fine for Capacitor iOS. For a fleet user with 50+ cells, this
 * is a future optimisation (viewport-filter the merge).
 *
 * Returns null when no cells are imported (so the caller can skip
 * mounting the Mapbox source entirely).
 */
/** A cell only joins a WINDOWED merge when its bbox diagonal is at
 *  least this fraction of the window's — below it the cell paints a
 *  postage stamp of sub-pixel detail while its parsed blob still costs
 *  megabytes of heap. Zoom in and the window shrinks past the ratio,
 *  pulling the fine cell in.
 *  0.05 → 0.01 (2026-07-12 'a little blocky at this zoom'): 5% of a
 *  bay-zoom window is ~150 screen px — it was evicting 1:8k-1:22k
 *  harbour surveys mid-zoom and leaving the 1:90k cell to paint their
 *  water in chunky generalised bands. 1% ≈ a ~30 px footprint: still
 *  culls true postage stamps at coastline zoom, keeps every survey
 *  that's actually legible.
 *  ZOOM-SPLIT (2026-07-13): the 0.01 crispness only matters zoomed IN.
 *  Below z10 an absolute chart-table floor applies instead (see
 *  minCellDiag in getMergedVectorData) — the 0.045-ratio attempt still
 *  let all ~47 one-degree coastal cells into a z6.9 window and the
 *  renderer OOM'd on their stacked geometry. */
const WINDOW_MIN_DIAG_RATIO = 0.01;

function bboxIntersects(a: [number, number, number, number], b: [number, number, number, number]): boolean {
    return a[0] <= b[2] && a[2] >= b[0] && a[1] <= b[3] && a[3] >= b[1];
}

function bboxDiag(b: [number, number, number, number]): number {
    return Math.hypot(b[2] - b[0], b[3] - b[1]);
}

export async function getMergedVectorData(
    /**
     * Optional render window [minLon, minLat, maxLon, maxLat] — merge
     * ONLY the cells worth painting there (Phase 9, forced by the
     * 2026-07-12 desktop tab OOM: the completed 172-cell cloud bucket
     * made the all-cells merge hold ~210 MB of GeoJSON text as parsed
     * heap, and Chrome's renderer died the moment satellite rasters
     * stacked on top). No window = the old full merge (seaway debug
     * compile and other whole-library consumers).
     */
    window?: [number, number, number, number],
    /**
     * Current map zoom. Gates the EXPENSIVE sounding-derived contour
     * pass (Delaunay + march) to zooms where it actually renders (z13+
     * layer; compute from z12 for headroom). Without this the pass ran
     * over EVERY merged sounding at EVERY zoom — at z10 over a wide
     * window that's tens of thousands of points triangulated for
     * contours that never draw, hanging the page (2026-07-12, the web
     * "Page Unresponsive" at z10.2). Omitted (seaway/full merge) = no
     * derived contours.
     */
    zoom?: number,
): Promise<EncMergedVectorData | null> {
    const allCells = cellMeta.listCells();
    if (allCells.length === 0) {
        clearMergedData();
        return null;
    }
    // Stricter cell-selection floor at wide passage zoom (see the ratio
    // constants) — fewer, larger cells so a z7-8 window doesn't load the
    // whole coast's fine geometry it can't even show.
    // ZOOM-GRADED SELECTION (2026-07-13, the crash that survived every
    // other cut): the device log showed 47-49 cells joining a z6.7-6.9
    // merge — depare=15643 polygons plus the unlogged contours/land/
    // coastline from the same cells, tens of thousands of features and
    // millions of vertices tiled into GPU buffers for a view where the
    // 1° coastal cells are barely legible. Select like a chart table
    // instead: ocean zoom gets the ocean charts, passage zoom the
    // coastal series, harbour zoom everything legible.
    const zBucket = zoom != null ? Math.round(zoom) : null;
    // LOOSENED one grade (2026-07-14, "best resolution possible at lower
    // zooms"): the original floors were set mid-OOM-war; the mitigations
    // that landed since (sub-pixel feature cull below z10, sounding LOD,
    // glaze z10+ gate, tile-cache cap) make extra cells far cheaper —
    // their invisible detail is culled before it costs tiles. Each band
    // now admits the next-finer series; the cull keeps the geometry that
    // reaches Mapbox bounded to what's actually legible.
    const minCellDiag = (): number => {
        if (zBucket == null) return 0; // full merge — everything
        if (zBucket < 7) return 1.2; // ocean: overviews + the 1° coastal series
        if (zBucket < 9) return 0.35; // passage: + approach-scale cells
        if (zBucket < 10) return 0.12; // pre-nav: + harbour cells
        return 0; // nav: legibility ratio below decides
    };
    const floorDeg = minCellDiag();
    const cells = window
        ? allCells.filter((c) => {
              if (!bboxIntersects(c.bbox, window)) return false;
              const d = bboxDiag(c.bbox);
              if (floorDeg > 0) return d >= floorDeg;
              return d >= bboxDiag(window) * WINDOW_MIN_DIAG_RATIO;
          })
        : allCells;
    if (cells.length === 0) return null;
    const densify = zoom != null && zoom >= DERIVED_CONTOUR_MIN_ZOOM;
    // Build the heavy satellite glaze (2nd depth-geometry copy) only when
    // zoomed in enough to navigate by it. zoom==null (seaway/full merge)
    // never needs the glaze, so skip it there too — pure memory saved.
    const buildGlaze = zoom != null && zoom >= GLAZE_MIN_ZOOM;
    // Sounding LOD bucket (2026-07-13): the merged SOUNDG heap over a wide
    // z7-9 window is ~30 k symbols (device log), the single biggest and
    // priciest layer — symbol collision + text layout, mostly SCAMIN-
    // hidden but ALL loaded into the source. Bucket the merge by rounded
    // zoom so we can drop soundings that can't render at this scale (see
    // the filter after the density ladder). Aligns with the hook's per-
    // whole-zoom re-merge cadence. 99 = seaway/full merge, no LOD filter.
    const soundBucket = zoom != null ? Math.round(zoom) : 99;
    // Key by what actually determines the output: the cell set (merge
    // geometry depends only on the selected cells, never on the window
    // that selected them) + the registry version + whether derived
    // contours were computed + whether the glaze was built (so a wide
    // no-glaze merge and a zoomed-in with-glaze merge over the same cell
    // set don't collide).
    const cacheKey = `v${cellMeta.getVersion()}:${densify ? 'd1' : 'd0'}:${buildGlaze ? 'g1' : 'g0'}:s${soundBucket}:${cells
        .map((c) => c.id)
        .sort()
        .join(',')}`;
    const cached = getMergedData(cacheKey);
    if (cached) return cached;
    const inflight = getInflightMerge(cacheKey);
    if (inflight) return inflight;
    const build = buildMergedVectorData(cells, cacheKey, densify, buildGlaze, zoom);
    setInflightMerge(cacheKey, build);
    try {
        return await build;
    } catch (e) {
        if (e instanceof MergeSupersededError) {
            // Cooperative abort (2026-07-17 audit): fast panning used to
            // stack concurrent full merges whose outputs were evicted
            // almost immediately — a superseded WINDOWED merge now bails
            // at its next slice boundary instead of burning to completion.
            log.warn('[perf] merge superseded mid-build — abandoned at slice boundary');
            return null;
        }
        throw e;
    } finally {
        deleteInflightMerge(cacheKey);
    }
}

/** Thrown inside a windowed merge's cooperative yielder when a NEWER
 *  windowed merge has started — the map has moved on, finish is waste. */
class MergeSupersededError extends Error {
    constructor() {
        super('merge superseded');
    }
}
/** Monotonic id of the newest WINDOWED merge (full/seaway merges — zoom
 *  null — never participate: they serve a different consumer). */
let windowedMergeGen = 0;

/** Sounding-derived contours run in encGeometryWorker (2026-07-13) —
 *  the Delaunay + isoline march hung the main thread when it ran here
 *  (2026-07-12). The merge returns without them; the worker's answer is
 *  swapped into the cached merge and pushed via the upgrade hook. */
/** Derived contours only render at z13+; compute from z12 for headroom.
 *  Below this the pass is skipped entirely — it's the merge's heaviest
 *  discretionary cost and invisible when zoomed out. */
const DERIVED_CONTOUR_MIN_ZOOM = 12;
/** The satellite keel-glaze (overlap-clipped DEPARE_GLAZE — a full SECOND
 *  copy of the depth-area geometry) is only built at z ≥ this. At a wide
 *  z7-9 passage view the window pulls the whole coast's cells including
 *  the 1:3M ocean overview, and doubling all that band geometry for the
 *  glaze tipped Chrome's renderer into an OOM crash ("Aw, Snap"; Shane
 *  2026-07-13, "locks up as the white layer arrives ~z7-8"). The glaze is
 *  a zoomed-in "is this water safe for my keel" read — useless at passage
 *  scale — so gating it here sheds the heaviest wide-view layer with no
 *  visual loss: passage overview shows clean imagery, the glaze fades in
 *  as you close the coast to navigate. */
/** 9.5, not 10 (Shane 2026-07-14: "when we get to zoom 10 can we get the
 *  layer to pop immediately — quite a delay at the moment"): the glaze
 *  merge used to START only once the punter arrived at z10, so the white
 *  wash trailed in seconds later. Building from z9.5 pre-warms it half a
 *  zoom early — right at the bucket boundary (round(9.5)=10), so the
 *  bucket-crossing re-merge is the SAME merge — and by z10 the glaze is
 *  already uploaded. The z7-8 wide-window OOM stays safely away: a z9.5
 *  window is bay-scale, nothing like the whole-coast z7 pull. */
export const GLAZE_MIN_ZOOM = 9.5;
/** Fine bands at least this deep never clip the coarse glaze. With
 *  unsafe glaze at opacity 0, the clip only protects against coarse
 *  SAFE-white over fine UNSAFE water — a fine band deeper than any
 *  plausible keel's safety depth is safe for everyone, so clipping
 *  under it buys nothing and its strip-mask halo shows as blocks.
 *  Was 10 m ("any keel"), now 5 m: 10 dragged every 9-ish-metre band
 *  into the mask, and once the glaze clip started seeing adjacent-band
 *  neighbours (a0b67d39) their halos tiled the mid-depth water with
 *  grey rectangles ("blocky squares floating around", 2026-07-14
 *  round 2). 5 m still covers a 4.5 m-safety keel — deeper-draft
 *  vessels than that aren't reading a white glaze for guidance. */
const GLAZE_CLIP_MAX_SAFE_M = 5;

/** Shallow-band clip footprint from a cell's DEPARE/DRGARE collections:
 *  polygon coords of every band shallower than GLAZE_CLIP_MAX_SAFE_M
 *  (missing DRVAL1 → treated shallow, conservative). May legitimately
 *  return EMPTY — a corridor-only channel cell whose bands are all deep
 *  clips NOTHING. Callers must never conflate empty with "unknown":
 *  falling back to the data-extent rectangle on empty blacked out whole
 *  corridor-cell extents ("large steps through the shipping channel",
 *  2026-07-14). */
export function shallowClipCoverage(collections: Array<FeatureCollection | undefined>): CoverageGeom {
    const polys: CoverageGeom = [];
    for (const fc of collections) {
        for (const f of fc?.features ?? []) {
            const g = f?.geometry;
            if (!g) continue;
            // readNumber, not a bare property read: ogr2ogr cells carry
            // lowercase names and string-quoted numerics (hard rule 2 —
            // the "every contour 0 m" incident), and a missed deep-band
            // exclusion re-classifies whole corridors as shallow.
            const drval1 = readNumber(f, 'DRVAL1');
            if (drval1 != null && drval1 >= GLAZE_CLIP_MAX_SAFE_M) continue;
            if (g.type === 'Polygon') polys.push(g.coordinates as CoverageGeom[number]);
            else if (g.type === 'MultiPolygon') polys.push(...(g.coordinates as unknown as CoverageGeom));
        }
    }
    return polys;
}

/** "Is the user mid-gesture?" probe, registered by the map hook (it
 *  answers map.isMoving()). The merge's time-slicer parks while this
 *  returns true so merge work never competes with a live pan/zoom for
 *  frame time. Null (no map yet / hook unmounted) means never park. */
let mergeInteractionProbe: (() => boolean) | null = null;
export function setMergeInteractionProbe(probe: (() => boolean) | null): void {
    mergeInteractionProbe = probe;
}
/** loadCellBlobsAndExtents — the merge's first phase, lifted from
 *  buildMergedVectorData (#2b, pure move): read each cell's LOCAL blob
 *  (never cloud — the background hydrator fills the rest) and compute its
 *  DEPARE/DRGARE extent. Mutates the passed accumulators in place;
 *  missing cells go to missingBlobs for hydration. */
async function loadCellBlobsAndExtents(
    cellsCoarseToFine: readonly { id: string; bbox: [number, number, number, number] }[],
    loadedBlobs: Map<string, EncConversionResult>,
    depareExtent: Map<string, [number, number, number, number]>,
    missingBlobs: string[],
    yieldIfNeeded: () => Promise<void>,
    /** Throws MergeSupersededError if a newer merge has claimed the slot.
     *  Unlike yieldIfNeeded this is NOT time-gated — it is an integer compare,
     *  so it can be called every iteration and aborts promptly. */
    throwIfSuperseded: () => void = () => {},
): Promise<void> {
    // READ-AHEAD PIPELINE (z10-boot audit #11): the Capacitor bridge read is
    // true async IO, so up to 3 cell reads run ahead of the SERIAL parse +
    // extent tail below — phase-1 wall drops from Σ(read+parse) toward
    // max(reads, parses). Parsing stays one-at-a-time under the time-slicer,
    // so main-thread chunking is unchanged. LOCAL blobs only (no remote
    // fallback): paint what's on hand NOW — the background hydrator fetches
    // the rest and each arrival re-notifies into the debounced merge (the
    // "fresh Vercel browser stared at a bare map" fix, 2026-07-12).
    const READ_AHEAD = 3;
    const reads = new Map<string, ReturnType<typeof cellStore.readCellRaw>>();
    let nextRead = 0;
    const pump = (): void => {
        while (nextRead < cellsCoarseToFine.length && reads.size < READ_AHEAD + 1) {
            const id = cellsCoarseToFine[nextRead++].id;
            reads.set(id, cellStore.readCellRaw(id));
        }
    };
    pump();
    for (const cell of cellsCoarseToFine) {
        // Bail BEFORE paying for this cell. Panning supersedes merges
        // constantly (device log 2026-07-22: ~45 aborts to ~7 completions).
        // The load phase's only previous check was the yieldIfNeeded() below,
        // which sits INSIDE the per-cell try whose catch swallowed everything
        // — so no abort could escape the load loop at all, and every doomed
        // merge read and parsed its ENTIRE cell list before dying in the
        // compute phase. This is CPU and transient-allocation churn (the
        // parse itself is off-thread in encParseWorker; the main thread pays
        // the bridge read and the structured clone), not a retained-memory
        // leak — both caches downstream are bounded.
        throwIfSuperseded();
        try {
            const raw0 = await (reads.get(cell.id) ?? cellStore.readCellRaw(cell.id));
            reads.delete(cell.id);
            pump();
            let blob: EncConversionResult | null;
            if (raw0.kind === 'cached') {
                blob = raw0.blob;
            } else if (raw0.kind === 'text') {
                blob = await cellStore.parseAndCacheCellTextAsync(cell.id, raw0.text);
                await yieldIfNeeded(); // multi-MB JSON.parse just ran synchronously
            } else {
                blob = null;
            }
            if (!blob) {
                missingBlobs.push(cell.id);
                continue;
            }
            loadedBlobs.set(cell.id, blob);
            let raw = depareExtentCache.get(blob);
            if (raw === undefined) {
                let minLon = Infinity,
                    minLat = Infinity,
                    maxLon = -Infinity,
                    maxLat = -Infinity;
                const visit = (coords: unknown): void => {
                    if (!Array.isArray(coords)) return;
                    if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
                        const lon = coords[0] as number;
                        const lat = coords[1] as number;
                        if (lon < minLon) minLon = lon;
                        if (lat < minLat) minLat = lat;
                        if (lon > maxLon) maxLon = lon;
                        if (lat > maxLat) maxLat = lat;
                        return;
                    }
                    for (const c of coords) visit(c);
                };
                // DEPARE + DRGARE: S-57 Group 1 means dredged areas
                // REPLACE depth areas, so DRGARE geometry can sit wholly
                // outside the DEPARE hull. The clip coverage includes
                // DRGARE, and a frame that excluded it rasterised such
                // coverage to ZERO cells → whole-extent fallback → the
                // corridor blackout, one seam down (review 2026-07-14).
                for (const fc of [blob.layers.DEPARE, blob.layers.DRGARE]) {
                    for (const f of fc?.features ?? []) {
                        const g = f?.geometry;
                        if (!g || g.type === 'GeometryCollection') continue;
                        visit((g as { coordinates?: unknown }).coordinates);
                    }
                }
                raw =
                    Number.isFinite(minLon) && maxLon > minLon && maxLat > minLat
                        ? [minLon, minLat, maxLon, maxLat]
                        : null;
                depareExtentCache.set(blob, raw);
            }
            if (raw) {
                depareExtent.set(cell.id, [
                    Math.max(raw[0], cell.bbox[0]),
                    Math.max(raw[1], cell.bbox[1]),
                    Math.min(raw[2], cell.bbox[2]),
                    Math.min(raw[3], cell.bbox[3]),
                ]);
            }
        } catch (err) {
            // A supersede is not a load failure — let it out. yieldIfNeeded()
            // below throws MergeSupersededError from INSIDE this try, so
            // without this rethrow every abandoned merge would file a bogus
            // "failed to load cell" warning into the device log that is
            // currently the only reliable window into this bug.
            if (err instanceof MergeSupersededError) throw err;
            log.warn(`getMergedVectorData: failed to load cell ${cell.id}`, err);
        }
    }
}

/**
 * The empty merged-vector shell every layer accumulates into — one FC per
 * ENC layer + cellCount. Pure factory extracted from buildMergedVectorData
 * so the merge's start state is single-sourced and unit-testable (the merge
 * body itself resists isolation — heavy module + loop state).
 */
export function createEmptyMergedVectorData(): EncMergedVectorData {
    const fc = (): FeatureCollection => ({ type: 'FeatureCollection', features: [] });
    return {
        DEPARE: fc(),
        LNDARE: fc(),
        COALNE: fc(),
        OBSTRN: fc(),
        WRECKS: fc(),
        UWTROC: fc(),
        DEPCNT: fc(),
        DEPCNT_DERIVED: fc(),
        LIGHTS: fc(),
        BOYLAT: fc(),
        BOYCAR: fc(),
        BCNLAT: fc(),
        BCNCAR: fc(),
        BOYSPP: fc(),
        BCNSPP: fc(),
        BOYSAW: fc(),
        BCNSAW: fc(),
        BOYISD: fc(),
        BCNISD: fc(),
        RECTRC: fc(),
        SOUNDG: fc(),
        DEPARE_GLAZE: fc(),
        SEAARE_LABELS: fc(),
        LIGHTSEC: fc(),
        CAUTION_AREAS: fc(),
        FAIRWY: fc(),
        cellCount: 0,
    };
}

/** The per-merge feature-count summary line. Extracted from the merge tail. */
function logMergeSummary(merged: EncMergedVectorData): void {
    log.info(
        `merged vector data: ${merged.cellCount} cells, ` +
            `DEPARE(+DRGARE)=${merged.DEPARE.features.length}, DEPCNT=${merged.DEPCNT.features.length}, ` +
            `COALNE=${merged.COALNE.features.length}, ` +
            `OBSTRN+WRECKS+UWTROC=${merged.OBSTRN.features.length + merged.WRECKS.features.length + merged.UWTROC.features.length}, ` +
            `LIGHTS=${merged.LIGHTS.features.length}, ` +
            `lat (BOY+BCN)=${merged.BOYLAT.features.length + merged.BCNLAT.features.length}, ` +
            `card (BOY+BCN)=${merged.BOYCAR.features.length + merged.BCNCAR.features.length}, ` +
            `spp (BOY+BCN)=${merged.BOYSPP.features.length + merged.BCNSPP.features.length}, ` +
            `leads (RECTRC)=${merged.RECTRC.features.length}, ` +
            `soundings=${merged.SOUNDG.features.length}`,
    );
}

async function buildMergedVectorData(
    cells: EncCell[],
    cacheKey: string,
    densify: boolean,
    buildGlaze: boolean,
    zoom?: number,
): Promise<EncMergedVectorData | null> {
    // TIME-SLICED (2026-07-12 audit, MAJOR): the merge — parse, clone,
    // extent-walk, glaze clip, sounding explode — used to run as ONE
    // long main-thread task (100–800 ms; multi-cell mid-zoom windows
    // worse), freezing the map and the GPS chase on every window
    // escape. Yielding a macrotask every ~12 ms of work keeps frames
    // flowing; total CPU is unchanged but the freeze is gone.
    //
    // GESTURE-PAUSED (2026-07-14, "a little jerky when i am zooming and
    // moving about"): a 12 ms slice inside a 16 ms frame still drops
    // that frame, and a merge kicked off by the LAST moveend is often
    // mid-flight when the next flick starts. While the interaction
    // probe reports a live gesture, slices park in short naps (capped —
    // a camera-follow animation must not starve the merge forever).
    // SUPERSEDED-ABORT (2026-07-17 audit): a windowed merge claims the
    // newest-generation slot; when a newer windowed merge starts, this one
    // bails at its next slice boundary (getMergedVectorData converts the
    // throw to the callers' established null-means-cancelled contract).
    const myWindowGen = zoom != null ? ++windowedMergeGen : null;
    /** Cheap, un-gated supersede check — an integer compare, safe to call in
     *  a tight loop. yieldIfNeeded only reaches its own check once a slice has
     *  run 12 ms, which is far too late when the expensive step is a single
     *  multi-MB parse. */
    const throwIfSuperseded = (): void => {
        if (myWindowGen != null && myWindowGen !== windowedMergeGen) throw new MergeSupersededError();
    };
    let sliceStart = performance.now();
    const yieldIfNeeded = async (): Promise<void> => {
        // Un-gated first: a stale merge should die at the next call site, not
        // wait for a 12 ms slice to elapse.
        throwIfSuperseded();
        if (performance.now() - sliceStart < 12) return;
        // macroYield (MessageChannel) dodges iOS's 1–4 ms setTimeout clamp;
        // the 80 ms gesture-park naps below stay real timers on purpose.
        await macroYield();
        let parkedMs = 0;
        while (mergeInteractionProbe?.() && parkedMs < 2000) {
            await new Promise<void>((resolve) => setTimeout(resolve, 80));
            parkedMs += 80;
        }
        if (myWindowGen != null && myWindowGen !== windowedMergeGen) throw new MergeSupersededError();
        sliceStart = performance.now();
    };

    const merged = createEmptyMergedVectorData();

    // Sampled at the START, because a wide merge takes seconds and the queue
    // decision at the bottom of this function happens after every await. The
    // picker sets hydrationPaused=false the instant a location is COMMITTED,
    // so a merge begun over an un-synced coast while paused would otherwise
    // land just after the commit and file its 15-40 cell walk anyway — the
    // download storm arriving exactly as the Glass mounts. Both this and the
    // live flag must allow it (see the queue site below).
    const hydrationAllowedAtStart = !hydrationPaused;

    // Scale-shadow de-confliction (the Tangalooma tan wall): an overview cell's
    // crude island/land polygons bulge over water a finer cell charts correctly.
    // Coarse-cell area geometry fully inside a much-finer cell's bbox is dropped
    // — the finer cell owns that ground. Applies to the chart-geometry classes
    // (land, depth areas, coastline, contours); point marks are untouched.
    const cellExtents = cells.map((c) => ({ id: c.id, bbox: c.bbox }));
    // COARSE → FINE merge order: overlapping near-opaque fills paint in
    // source order, so the finer survey's bands must come LAST to draw on
    // top. Whole-bbox shadowing alone can't stop a huge coarse polygon
    // that pokes outside finer coverage from painting over it (the
    // Newport-approach "dries 2 m over a surveyed 2–5 m band" conflict,
    // 2026-07-11) — order is what resolves the partial overlaps here.
    const cellsCoarseToFine = [...cells].sort((a, b) => cellScaleRank(a.bbox) - cellScaleRank(b.bbox));
    // Glaze-LRU invariant (closing audit): the cache must hold this whole
    // merge's glaze cells or the all-or-nothing upgrade self-defeats.
    if (buildGlaze) ensureGlazeCapacity(cellsCoarseToFine.length);

    // Pass 1: load blobs and compute each cell's DEPARE DATA EXTENT — the
    // ground it ACTUALLY charts. Dropping/clipping coarse features by the
    // registry bbox carved bare black rectangles wherever a fine cell's
    // bbox outran its charted data (Shane 2026-07-11, NW of Bribie: the
    // Newport cell's bbox spans half the bay; its bands chart a fraction
    // of it). The fineness DECISION stays on the registry bbox (the scale
    // heuristic); the CUTTING geometry uses the data extent.
    const loadedBlobs = new Map<string, NonNullable<Awaited<ReturnType<typeof cellStore.loadCellGeoJSON>>>>();
    const depareExtent = new Map<string, [number, number, number, number]>();
    const missingBlobs: string[] = [];
    // Perf split (z10-boot audit #2): read+parse vs merge compute, measured —
    // the one warn line at the tail turns boot-speed guesses into numbers.
    const perfT0 = performance.now();
    await loadCellBlobsAndExtents(
        cellsCoarseToFine,
        loadedBlobs,
        depareExtent,
        missingBlobs,
        yieldIfNeeded,
        throwIfSuperseded,
    );
    const perfLoadMs = performance.now() - perfT0;

    // ring-assembly: the per-merge clip-geometry memoisers (charted-shallow
    // coverage, strip-rect glaze masks, per-layer line extents) over this
    // run's loaded blobs — see mergeFold.createClipGeometryMemos. The three
    // load-bearing states of `coverageFor`, the strip-rect rationale, and the
    // line-extent seam de-dup all live in that module's docs now.
    // shallowClipCoverage is injected: it lives here (its own test imports it)
    // so the fold module stays a cycle-free leaf.
    const { coverageFor, stripRectsFor, lineLayerExtent } = createClipGeometryMemos(loadedBlobs, shallowClipCoverage);

    // Sub-pixel cull threshold for area/line features: ~2 px in degrees
    // at the merge's zoom bucket (512 px tiles). Every windowed merge
    // culls — a whole-zoom crossing re-merges with a tighter threshold,
    // so nothing visible is ever missing at the zoom you're actually at.
    // Trimming invisible scraps at nav zoom shrinks the DEPARE upload
    // (the one setData the frame-stagger can't split). 0 on the full
    // merge only.
    const cullDeg = zoom != null ? ((78271.484 / 2 ** Math.round(zoom)) * 2) / 111_320 : 0;

    // Named sea areas — dedupe by name across cells; iterating
    // coarse→fine means the finest chart's label point wins (its
    // geometry traces the channel best).
    const seaareByName = new Map<string, Feature>();

    // Per-merge bookkeeping for the worker's true-coverage glaze upgrade.
    const glazeUpgradeQueue: GlazeUpgradeItem[] = [];
    // The job's shared coverage library (cellId → FineCoverage) the queue
    // items reference by id — cloned to the worker ONCE per job.
    const glazeCoverageLib = new Map<string, FineCoverage>();
    const mergeGlazeKeys: string[] = [];

    for (const cell of cellsCoarseToFine) {
        const blob = loadedBlobs.get(cell.id);
        if (!blob) continue;
        // layer-accumulation: fold this cell's blob into the merged shell in
        // COARSE→FINE order (finest paints last) — tag provenance, drop
        // scale-shadowed area geometry, de-dup coarse lines, pre-bake mark /
        // light render props, build the glaze, reduce named areas, explode
        // soundings. See mergeFold.accumulateCellLayers.
        await accumulateCellLayers(cell, blob, {
            merged,
            cellExtents,
            depareExtent,
            coverageFor,
            stripRectsFor,
            lineLayerExtent,
            seaareByName,
            glazeCoverageLib,
            glazeUpgradeQueue,
            mergeGlazeKeys,
            buildGlaze,
            cullDeg,
            yieldIfNeeded,
        });
    }
    merged.SEAARE_LABELS.features = [...seaareByName.values()];

    // Sounding-LOD finalise (density ladder + look-ahead cull) on the MERGED
    // heap — see mergeFold.applySoundingLod.
    await applySoundingLod(merged, zoom, yieldIfNeeded);

    // Pass the cell set: this merge PINS these cells' geometry by reference,
    // and eviction needs to know that to tell a zoom excursion (shares cells,
    // nearly free) from a pan (shares nothing, pins a whole second viewport).
    putMergedData(
        cacheKey,
        merged,
        cells.map((c) => c.id),
    );

    // Hand the heavy geometry (contours + optional glaze upgrade) to the
    // worker; answers swap into this cached merge via the geometry-upgrade
    // hook. CONTOURS (Delaunay, bounded) dispatch when enabled + under cap;
    // GLAZE only rides along when GLAZE_WORKER_ENABLED queued cells above.
    dispatchGeometryWork(cacheKey, merged, densify, glazeUpgradeQueue, mergeGlazeKeys, glazeCoverageLib);

    // BOTH gates: unpaused when this merge STARTED and still unpaused now. A
    // wide merge takes seconds, and the picker unpauses the instant a location
    // is committed — without the start gate, a merge begun over an un-synced
    // coast lands just after the commit and files its 15-40 cell walk anyway,
    // so the download storm arrives exactly as the Glass mounts.
    if (missingBlobs.length > 0 && hydrationAllowedAtStart && !hydrationPaused) {
        log.warn(`merge painted ${merged.cellCount} local cells; hydrating ${missingBlobs.length} from the cloud`);
        crumb('enc:walk-start', `${missingBlobs.length}cells`);
        void hydrateMissingCells(missingBlobs).then(() => crumb('enc:walk-done'));
    } else if (missingBlobs.length > 0) {
        log.warn(
            `merge painted ${merged.cellCount} local cells; ${missingBlobs.length} missing — hydration paused (picker)`,
        );
    }
    logMergeSummary(merged);
    // warn, not info (info is silent in prod): the boot-speed ground truth.
    const perfBytes = cells.reduce((s, c) => s + (c.sizeBytes ?? 0), 0);
    // blobCache + merge-memo occupancy ride along so a long pan SHOWS whether
    // the caches are the ratchet, instead of us inferring it. blobText is JSON
    // text; parsed heap runs ~3× that, and an evicted cell is not freed while
    // any cached merge still references its geometry.
    const bc = cellStore.blobCacheStats();
    log.warn(
        `[perf] merge ${merged.cellCount} cells (${(perfBytes / 1024 / 1024).toFixed(1)} MB reg): ` +
            `load+parse=${Math.round(perfLoadMs)}ms, compute=${Math.round(performance.now() - perfT0 - perfLoadMs)}ms, ` +
            `total=${Math.round(performance.now() - perfT0)}ms, missing=${missingBlobs.length}, ` +
            `blobCache=${bc.entries} cells/${bc.textMB}MBtext`,
    );
    return merged;
}

// ── Background blob hydration ─────────────────────────────────────

/** Single-flight guard — one hydration walk at a time. */
let hydrationRunning = false;

/**
 * Pause switch for the cloud-hydration walk — MapHub holds this true
 * while the map is in picker mode. Panning the location picker from
 * home water to an un-synced region (SE QLD → the GBR, 74 cells /
 * 95 MB) otherwise files a 15-40-cell download walk whose every
 * arrival bumps the registry version and forces a full wide-band
 * re-merge — repeated multi-10-MB allocation spikes in exactly the
 * 47-49-cell z6.7 merge regime that has produced a renderer OOM on
 * device before (see the band-merge note above). The picker only
 * needs a tappable map; already-local cells still render. The Charts
 * page proper is unaffected.
 */
let hydrationPaused = false;
export function setEncHydrationPaused(paused: boolean): void {
    hydrationPaused = paused;
}

/** Failed downloads wait out a cooldown before another attempt —
 *  every window-escape pan used to re-run a doomed sequential fetch
 *  loop over the same missing cells (offline: forever, 2026-07-12
 *  audit). Success clears the cell's cooldown. */
const hydrationCooldownUntil = new Map<string, number>();
const HYDRATION_RETRY_COOLDOWN_MS = 60_000;

/** Cells per paint wave during a hydration walk. Each wave costs one
 *  full wide-band re-merge + a 14-source Mapbox re-upload, so this is
 *  the direct lever on the OOM: a 40-cell walk goes from ~40 merges to
 *  ~6. Small enough that the chart still fills in visibly. */
const HYDRATION_NOTIFY_BATCH = 8;

/** …and a wave at least this often regardless, so a slow link (one cell
 *  per 5 s) doesn't sit on a half-drawn chart waiting for the 8th cell. */
const HYDRATION_NOTIFY_MAX_INTERVAL_MS = 10_000;

// ── Hydration progress (2026-07-12 audit, UX MAJOR) ───────────────
// Downloading was completely SILENT: a registered-but-not-yet-
// downloaded cell rendered as the same dark shell as genuinely
// uncharted water, and a cruiser panning to tomorrow's anchorage
// concluded the app had no chart there. The map surfaces this as a
// "Chart downloading… (n of m)" chip.

export interface EncHydrationProgress {
    /** Cells still to attempt in the current walk (0 = idle). */
    remaining: number;
    /** Size of the walk when it started. */
    total: number;
}

let hydrationProgress: EncHydrationProgress = { remaining: 0, total: 0 };
const hydrationListeners = new Set<(p: EncHydrationProgress) => void>();

function setHydrationProgress(next: EncHydrationProgress): void {
    hydrationProgress = next;
    for (const l of hydrationListeners) {
        try {
            l(hydrationProgress);
        } catch {
            /* listener errors never break the walk */
        }
    }
}

export function getHydrationProgress(): EncHydrationProgress {
    return hydrationProgress;
}

/** Subscribe to hydration progress. Returns an unsubscribe fn. */
export function subscribeHydration(listener: (p: EncHydrationProgress) => void): () => void {
    hydrationListeners.add(listener);
    return () => {
        hydrationListeners.delete(listener);
    };
}

/**
 * Fetch missing cell blobs from the cloud bucket, one at a time, in
 * the background. Each success touches the registry (putCell notify)
 * so the debounced ENC refresh re-merges and the chart fills in cell
 * by cell. Signed-out browsers fail quietly (private bucket — the
 * licensing gate) and the chart honestly stays absent.
 */
async function hydrateMissingCells(cellIds: string[]): Promise<void> {
    if (hydrationRunning || cellIds.length === 0) return;
    hydrationRunning = true;
    // Cooldown-filtered up front so the chip's "n of m" is honest —
    // cells sitting out a failure cooldown aren't "downloading".
    const now = Date.now();
    const walk = cellIds.filter((id) => {
        const waitUntil = hydrationCooldownUntil.get(id);
        return waitUntil === undefined || now >= waitUntil;
    });
    if (walk.length === 0) {
        hydrationRunning = false;
        return;
    }
    setHydrationProgress({ remaining: walk.length, total: walk.length });
    // Coalesce the registry notifies this walk will fire (see
    // EncCellMetadata.suspendNotifications). Un-batched, a 40-cell walk
    // forced ~40 full wide-band re-merges; batched it forces ~6.
    cellMeta.suspendNotifications();
    let flushedAt = Date.now();
    let flushedCount = 0;
    try {
        const { downloadCloudCell } = await import('./cloudCellSync');
        // PARALLEL, pool of 3 (z10-boot audit #5): one-at-a-time downloads
        // made the cold walk O(N) on the slowest cell — one stalled socket
        // (30 s deadline) head-of-line blocked the entire coast. Three slots
        // ≈ 2–3× faster fill without drowning marina wifi that's also pulling
        // the raster pyramid; downloadCloudCell dedupes per cell, and the
        // notify max-wait upstream paints in waves as cells land.
        let done = 0;
        const runOne = async (id: string): Promise<void> => {
            const ok = await downloadCloudCell(id);
            if (ok) {
                hydrationCooldownUntil.delete(id);
                // Guarantee a notify even when the download didn't patch
                // provenance — an idempotent registry touch re-triggers
                // the debounced merge.
                const rec = cellMeta.getCell(id);
                if (rec) cellMeta.putCell(rec);
            } else {
                hydrationCooldownUntil.set(id, Date.now() + HYDRATION_RETRY_COOLDOWN_MS);
            }
            done++;
            setHydrationProgress({ remaining: walk.length - done, total: walk.length });
            // Paint in waves, but in BATCHES. The first arrival flushes
            // immediately — an early first wave is deliberate (z10-boot
            // batch: trailing-only coalescing starved the cold boot and
            // nothing painted until the whole walk finished). After that
            // one wave per HYDRATION_NOTIFY_BATCH cells, with a max
            // interval so a slow link still paints on a human timescale.
            const sinceFlush = Date.now() - flushedAt;
            if (
                done === 1 ||
                done - flushedCount >= HYDRATION_NOTIFY_BATCH ||
                sinceFlush >= HYDRATION_NOTIFY_MAX_INTERVAL_MS
            ) {
                flushedAt = Date.now();
                flushedCount = done;
                cellMeta.flushNotifications();
            }
        };
        const queue = [...walk];
        await Promise.all(
            Array.from({ length: Math.min(3, queue.length) }, async () => {
                // Pause check per cell: a walk already in flight when the
                // picker opens stops after the current downloads instead of
                // draining the remaining 40-cell coast.
                for (let id = queue.shift(); id !== undefined && !hydrationPaused; id = queue.shift()) {
                    await runOne(id);
                }
            }),
        );
    } catch (err) {
        log.warn(`hydration walk failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
        hydrationRunning = false;
        setHydrationProgress({ remaining: 0, total: 0 });
        // Outermost resume flushes the tail so the last cells to land
        // always paint, walk completed or aborted.
        cellMeta.resumeNotifications();
    }
}

// ── Reactivity passthrough ────────────────────────────────────────

/**
 * Subscribe to cell-list changes (import / remove). Re-exported
 * from EncCellMetadata so consumers don't need to drill into the
 * private storage layer.
 */
export const subscribe = cellMeta.subscribe;

/**
 * Current version counter — bumped on every put/remove. Useful as
 * a React hook dependency so re-renders pick up cell-list changes.
 */
export const getVersion = cellMeta.getVersion;
