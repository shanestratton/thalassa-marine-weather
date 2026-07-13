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

import type { Feature, FeatureCollection, Point } from 'geojson';
import { assignSoundingDensityMinZoom } from './soundingDensity';

import { createLogger } from '../../utils/createLogger';
import { mapWithConcurrency } from '../../utils/concurrency';
import * as cellStore from './EncCellStore';
import * as cellMeta from './EncCellMetadata';
import { shadowingCells, featureIsShadowed, cellScaleRank } from './scaleShadow';
import { clipFeatureOutsideBboxes, coverageMaskStrips, type CoverageGeom } from './clipDepareOverlap';
import { EncSpatialIndex, type EncCatzocZone, type EncCoastline } from './EncSpatialIndex';
import type { EncCatzoc, EncCell, EncConversionResult, EncHazard, EncHazardResult, EncLayer } from './types';
import {
    buildLightCharacterLabel,
    encNavaidIconId,
    ialaRegionForSourceHO,
    lateralMarkColour,
    lightColourHex,
} from './types';
import { buildSectorFeatures, readSectorBearings } from './lightSectors';

const log = createLogger('EncHazardService');

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
const indexes: Map<string, EncSpatialIndex> = new Map();
const INDEX_CACHE_MAX = 12;

function touchIndex(cellId: string): EncSpatialIndex | undefined {
    const hit = indexes.get(cellId);
    if (hit) {
        indexes.delete(cellId);
        indexes.set(cellId, hit);
    }
    return hit;
}

function cacheIndex(cellId: string, index: EncSpatialIndex): void {
    indexes.delete(cellId);
    indexes.set(cellId, index);
    while (indexes.size > INDEX_CACHE_MAX) {
        const oldest = indexes.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        indexes.delete(oldest);
    }
}

/**
 * Cells we've already attempted to load, for which the GeoJSON
 * blob was missing/corrupt. We don't keep retrying these on every
 * query — re-import or a session restart is required.
 */
const failedLoads: Set<string> = new Set();

// ── GeoJSON → EncHazard parsing ───────────────────────────────────

/**
 * Read a numeric attribute from a GeoJSON feature's properties.
 * S-57 → GeoJSON conversion via ogr2ogr typically lowercases
 * attribute names and may quote numeric values as strings; handle
 * both.
 */
function readNumber(feat: Feature, ...names: string[]): number | null {
    const props = feat.properties ?? {};
    for (const name of names) {
        const v = (props as Record<string, unknown>)[name] ?? (props as Record<string, unknown>)[name.toLowerCase()];
        if (v == null) continue;
        const n = typeof v === 'number' ? v : Number(v);
        if (Number.isFinite(n)) return n;
    }
    return null;
}

/**
 * Convert a parsed FeatureCollection into our internal EncHazard
 * shape. Handles per-layer attribute extraction:
 *
 *  - DEPARE: minDepth from DRVAL1
 *  - OBSTRN/WRECKS: minDepth from VALSOU (positive = depth below sea level)
 *  - LNDARE/UWTROC: depth N/A (always hazard)
 */
function featuresToHazards(layer: EncLayer, fc: FeatureCollection): EncHazard[] {
    const out: EncHazard[] = [];
    for (const feat of fc.features ?? []) {
        if (!feat || !feat.geometry) continue;
        let minDepthM: number | null = null;
        if (layer === 'DEPARE') {
            minDepthM = readNumber(feat, 'DRVAL1', 'drval1');
        } else if (layer === 'OBSTRN' || layer === 'WRECKS') {
            minDepthM = readNumber(feat, 'VALSOU', 'valsou');
        }
        out.push({
            layer,
            geometry: feat.geometry,
            minDepthM,
            description: typeof feat.properties?.OBJNAM === 'string' ? feat.properties.OBJNAM : undefined,
        });
    }
    return out;
}

/**
 * Build the EncHazard list for a converted cell across every
 * layer of interest.
 */
function buildHazardsForCell(blob: EncConversionResult): EncHazard[] {
    const all: EncHazard[] = [];
    const layerPairs: [EncLayer, FeatureCollection | undefined][] = [
        ['DEPARE', blob.layers.DEPARE],
        ['LNDARE', blob.layers.LNDARE],
        ['OBSTRN', blob.layers.OBSTRN],
        ['WRECKS', blob.layers.WRECKS],
        ['UWTROC', blob.layers.UWTROC],
    ];
    for (const [layer, fc] of layerPairs) {
        if (!fc) continue;
        all.push(...featuresToHazards(layer, fc));
    }
    return all;
}

/**
 * Pull the COALNE LineStrings out of a converted cell. Filters
 * down to Polygon/Point-shaped junk that GDAL sometimes emits.
 */
function buildCoastlines(blob: EncConversionResult): EncCoastline[] {
    const fc = blob.layers.COALNE;
    if (!fc || !Array.isArray(fc.features)) return [];
    const out: EncCoastline[] = [];
    for (const feat of fc.features) {
        if (!feat || !feat.geometry) continue;
        if (feat.geometry.type !== 'LineString' && feat.geometry.type !== 'MultiLineString') continue;
        out.push({ geometry: feat.geometry });
    }
    return out;
}

/**
 * Build the CATZOC zone list from a cell's M_QUAL FeatureCollection.
 * Skips features without a usable CATZOC attribute (1..6).
 */
function buildCatzocZones(blob: EncConversionResult): EncCatzocZone[] {
    const fc = blob.layers.M_QUAL;
    if (!fc || !Array.isArray(fc.features)) return [];
    const zones: EncCatzocZone[] = [];
    for (const feat of fc.features) {
        if (!feat || !feat.geometry) continue;
        if (feat.geometry.type !== 'Polygon' && feat.geometry.type !== 'MultiPolygon') continue;
        const raw = readNumber(feat, 'CATZOC', 'catzoc');
        if (raw == null) continue;
        const rounded = Math.round(raw);
        if (rounded < 1 || rounded > 6) continue;
        zones.push({ geometry: feat.geometry, catzoc: rounded as EncCatzoc });
    }
    return zones;
}

// ── Lazy index loader ─────────────────────────────────────────────

/**
 * Get (or build) the spatial index for one cell. Returns null if
 * the cell metadata is missing, the blob is missing/corrupt, or
 * the cell has no hazards.
 */
async function getOrBuildIndex(cellId: string): Promise<EncSpatialIndex | null> {
    const cached = touchIndex(cellId);
    if (cached) return cached;
    if (failedLoads.has(cellId)) return null;

    const meta = cellMeta.getCell(cellId);
    if (!meta) {
        log.warn(`getOrBuildIndex ${cellId}: no metadata record`);
        failedLoads.add(cellId);
        return null;
    }

    const blob = await cellStore.loadCellGeoJSON(cellId);
    if (!blob) {
        log.warn(`getOrBuildIndex ${cellId}: GeoJSON missing or corrupt — user will need to re-import`);
        failedLoads.add(cellId);
        return null;
    }

    const hazards = buildHazardsForCell(blob);
    const catzocZones = buildCatzocZones(blob);
    const coastlines = buildCoastlines(blob);
    const index = new EncSpatialIndex(cellId, hazards, catzocZones, coastlines);
    cacheIndex(cellId, index);
    log.info(
        `built spatial index for cell ${cellId}: ${hazards.length} hazards, ` +
            `${catzocZones.length} CATZOC zones, ${coastlines.length} coastlines`,
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
    const candidateCells = cellMeta.cellsForBBox([qMinLon, qMinLat, qMaxLon, qMaxLat]);

    if (candidateCells.length === 0) {
        for (let i = 0; i < points.length; i++) {
            results[i] = { covered: false, hazard: false, minDepthM: null };
        }
        return results;
    }

    // Pre-build the candidate indexes through the capped pool — same
    // flood risk as preloadForBBox when the query bbox spans a route.
    const candidateIndexes: EncSpatialIndex[] = [];
    await mapWithConcurrency(candidateCells, 4, async (cell) => {
        const idx = await getOrBuildIndex(cell.id);
        if (idx) candidateIndexes.push(idx);
    });

    // Per-point query against the resolved indexes.
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        let merged: EncHazardResult = { covered: false, hazard: false, minDepthM: null };
        for (const idx of candidateIndexes) {
            const r = idx.queryPoint(p.lat, p.lon);
            if (!r.covered) continue;
            if (!merged.covered) {
                merged = r;
                continue;
            }
            // Already covered by an earlier cell — escalate to hazard
            // if any cell flagged this point.
            if (r.hazard && !merged.hazard) merged = r;
        }
        results[i] = merged;
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
    indexes.delete(cell.id);
    failedLoads.delete(cell.id);

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
    indexes.delete(cellId);
    failedLoads.delete(cellId);
    log.info(`removed cell ${cellId}`);
}

/**
 * Drop the in-memory index cache without touching persistent
 * storage. Used for tests and for the "reload charts" admin
 * action.
 */
export function dropIndexCache(): void {
    indexes.clear();
    failedLoads.clear();
}

/**
 * Lazy-load (if needed) and return the spatial index for a single
 * cell. Used by the hazard-report service to do multi-cell bbox
 * searches without exposing the whole index Map.
 *
 * Returns null if metadata is missing, the GeoJSON blob is
 * unreadable, or the cell ID is unknown. Failed loads stay null
 * for the rest of the session — re-import to clear.
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
const mergedCache = new Map<string, EncMergedVectorData>();
const MERGED_CACHE_MAX = 2;

/** Single-flight per key — overlapping calls (hook debounce + routing)
 *  share one build instead of doubling the heaviest CPU in the app. */
const inflightMerges = new Map<string, Promise<EncMergedVectorData | null>>();

/** DEPARE data extents are deterministic per parsed blob — memoized by
 *  blob identity so re-merges skip the full coordinate re-walk
 *  (100k+ coords per coastal cell, every window escape). Evicts with
 *  the blob itself (WeakMap). */
const depareExtentCache = new WeakMap<object, [number, number, number, number] | null>();

/** Per-cell GLAZE output cache. The output for a coarse cell depends
 *  only on its own blob + the shadowing cells that clip it, both
 *  immutable per registry version, so it memoizes cleanly. Keyed
 *  `v{ver}:{cellId}:{sortedShadowIds}`; capped, LRU by insertion order.
 *  `upgraded` marks entries the geometry worker has re-clipped against
 *  TRUE fine-survey coverage (hole-free); un-upgraded entries hold the
 *  instant rectangle clip and are re-queued for upgrade on use. */
const glazeCellCache = new Map<string, { upgraded: boolean; feats: Feature[] }>();
const GLAZE_CELL_CACHE_MAX = 32;

function putGlazeCell(key: string, entry: { upgraded: boolean; feats: Feature[] }): void {
    glazeCellCache.delete(key);
    glazeCellCache.set(key, entry);
    while (glazeCellCache.size > GLAZE_CELL_CACHE_MAX) {
        const oldest = glazeCellCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        glazeCellCache.delete(oldest);
    }
}

// ── Async geometry upgrades (the heavy-geometry worker) ────────────
//
// The 2026-07-13 OOM hunt's lasting rule: heavy geometry (martinez
// true-coverage glaze clip, derived-contour Delaunay) never runs on
// the main thread. The merge returns the FAST version instantly;
// encGeometryWorker computes the good version and these hooks swap it
// into the cached merge + notify the render hook. A dead worker is
// harmless — the fast version simply stays up.

interface PendingGeometryJob {
    /** mergedCache key whose DEPARE_GLAZE / DEPCNT_DERIVED to upgrade. */
    cacheKey: string;
    /** Ordered per-cell glaze keys composing that merge's glaze. */
    glazeKeys: string[];
}

let geoWorker: Worker | null = null;
let geoWorkerBroken = false;
let geoJobSeq = 0;
const pendingGeometryJobs = new Map<number, PendingGeometryJob>();
const geometryUpgradeListeners = new Set<() => void>();

/** Notify when a background geometry upgrade landed in the cached merge —
 *  the render hook re-pushes just the affected sources. */
export function subscribeGeometryUpgrades(cb: () => void): () => void {
    geometryUpgradeListeners.add(cb);
    return () => geometryUpgradeListeners.delete(cb);
}

function notifyGeometryUpgrade(): void {
    for (const cb of geometryUpgradeListeners) {
        try {
            cb();
        } catch {
            /* listener errors never break the pipeline */
        }
    }
}

/** Rebuild a cached merge's glaze collection from the per-cell cache
 *  (post-upgrade). Skips silently if the merge or any cell entry has
 *  been evicted — the next natural re-merge redoes it. */
function applyGlazeUpgrade(job: PendingGeometryJob): void {
    const cached = mergedCache.get(job.cacheKey);
    if (!cached) return;
    const feats: Feature[] = [];
    for (const key of job.glazeKeys) {
        const entry = glazeCellCache.get(key);
        if (!entry) return; // evicted mid-flight — abandon, stay on fast version
        feats.push(...entry.feats);
    }
    cached.DEPARE_GLAZE.features = feats;
    notifyGeometryUpgrade();
}

function getGeoWorker(): Worker | null {
    if (geoWorkerBroken) return null;
    if (geoWorker) return geoWorker;
    if (typeof Worker === 'undefined') return null;
    try {
        geoWorker = new Worker(new URL('./encGeometryWorker.ts', import.meta.url), { type: 'module' });
    } catch {
        geoWorkerBroken = true;
        return null;
    }
    geoWorker.onerror = () => {
        // Worker died (OOM/bug): the page is unaffected, the fast glaze
        // stays up. Don't respawn — same input would kill it again.
        geoWorkerBroken = true;
        geoWorker = null;
        pendingGeometryJobs.clear();
        log.warn('geometry worker died — staying on fast glaze/contours this session');
    };
    geoWorker.onmessage = (
        ev: MessageEvent<{ jobId: number; type: string; glazeKey?: string; features?: Feature[]; message?: string }>,
    ) => {
        const { jobId, type, glazeKey, features, message } = ev.data;
        const job = pendingGeometryJobs.get(jobId);
        if (type === 'glaze-cell' && glazeKey && features) {
            putGlazeCell(glazeKey, { upgraded: true, feats: features });
            return;
        }
        if (type === 'contours' && features && job) {
            const cached = mergedCache.get(job.cacheKey);
            if (cached) {
                cached.DEPCNT_DERIVED.features = features;
                notifyGeometryUpgrade();
            }
            return;
        }
        if (type === 'done' && job) {
            pendingGeometryJobs.delete(jobId);
            if (job.glazeKeys.length > 0) applyGlazeUpgrade(job);
            return;
        }
        if (type === 'error') {
            pendingGeometryJobs.delete(jobId);
            log.warn(`geometry worker job failed (fast version stays): ${message ?? 'unknown'}`);
        }
    };
    return geoWorker;
}

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
        mergedCache.clear();
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
    const cached = mergedCache.get(cacheKey);
    if (cached) return cached;
    const inflight = inflightMerges.get(cacheKey);
    if (inflight) return inflight;
    const build = buildMergedVectorData(cells, cacheKey, densify, buildGlaze, zoom);
    inflightMerges.set(cacheKey, build);
    try {
        return await build;
    } finally {
        inflightMerges.delete(cacheKey);
    }
}

/** Sounding-derived contours run in encGeometryWorker (2026-07-13) —
 *  the Delaunay + isoline march hung the main thread when it ran here
 *  (2026-07-12). The merge returns without them; the worker's answer is
 *  swapped into the cached merge and pushed via the upgrade hook. */
/** Light sectors stay ON — generation is O(sectored-lights), cheap, and
 *  it's the flagship night-approach feature. Flag exists so it can be
 *  killed instantly if it ever proves otherwise. */
const LIGHT_SECTORS_ENABLED = true;

/** Derived contours only render at z13+; compute from z12 for headroom.
 *  Below this the pass is skipped entirely — it's the merge's heaviest
 *  discretionary cost and invisible when zoomed out. */
const DERIVED_CONTOUR_MIN_ZOOM = 12;
/** Hard ceiling on soundings fed to the Delaunay pass — belt-and-braces
 *  against a pathological dense window even inside the zoom gate. A
 *  harbour window runs a few thousand; 30k triangulates in well under a
 *  frame, past that we skip rather than risk a hang. */
const DERIVED_CONTOUR_MAX_SOUNDINGS = 30_000;
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
export const GLAZE_MIN_ZOOM = 10;
/** Fine bands at least this deep never clip the coarse glaze. With
 *  unsafe glaze at opacity 0, the clip only protects against coarse
 *  SAFE-white over fine UNSAFE water — and no keel this app serves
 *  needs more than ~10 m under it, so a ≥10 m fine band is safe for
 *  everyone and white-over-white overlap is harmless. Excluding deep
 *  bands from the clip coverage removes the strip-mask staircase that
 *  flanked deep channel corridors ("black steps", 2026-07-14). */
const GLAZE_CLIP_MAX_SAFE_M = 10;

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
/** GEOMETRY WORKER DISPATCH DISABLED (2026-07-13, second crash): moving
 *  martinez off the main thread did NOT stop the OOM — a Worker is a
 *  separate THREAD in the SAME renderer process, so its allocation
 *  spike still kills the whole tab ("Aw, Snap" returned within minutes
 *  of the worker shipping; the flag-off build before it was confirmed
 *  crash-free). Workers protect against HANGS, not process OOM. The
 *  true-coverage clip needs a bounded algorithm (or per-pair vertex
 *  caps + chunked jobs) before this flips back on; until then the
 *  instant rectangle glaze is the only glaze, and derived contours stay
 *  dark. All worker scaffolding (encGeometryWorker, upgrade hook,
 *  per-cell memo) is wired and tested — bound the inputs, flip the
 *  flag. */
const GEOMETRY_WORKER_ENABLED = false;

/** "Is the user mid-gesture?" probe, registered by the map hook (it
 *  answers map.isMoving()). The merge's time-slicer parks while this
 *  returns true so merge work never competes with a live pan/zoom for
 *  frame time. Null (no map yet / hook unmounted) means never park. */
let mergeInteractionProbe: (() => boolean) | null = null;
export function setMergeInteractionProbe(probe: (() => boolean) | null): void {
    mergeInteractionProbe = probe;
}
/** Keep soundings whose density-ladder `_minZoom` is within this many
 *  levels of the current zoom; the rest can't render yet and only bloat
 *  the (very expensive) symbol source. A whole-zoom re-merge refreshes
 *  the set, so the look-ahead just needs to cover one hook re-merge step. */
const SOUNDING_LOD_LOOKAHEAD = 2;

/** Geometry classes eligible for the wide-zoom sub-pixel cull. Point
 *  layers (marks, lights, hazards) are NEVER culled — a point has zero
 *  extent but full meaning. */
const SUBPIXEL_CULLABLE = new Set(['DEPARE', 'LNDARE', 'COALNE', 'DEPCNT']);

/** Bbox diagonal of a polygon/line feature in degrees; Infinity for
 *  point/other geometry so the sub-pixel cull can never touch it. */
function featureDiagDeg(feat: Feature): number {
    const g = feat.geometry;
    if (
        !g ||
        (g.type !== 'Polygon' && g.type !== 'MultiPolygon' && g.type !== 'LineString' && g.type !== 'MultiLineString')
    ) {
        return Infinity;
    }
    let minX = Infinity,
        minY = Infinity,
        maxX = -Infinity,
        maxY = -Infinity;
    const visit = (coords: unknown): void => {
        if (!Array.isArray(coords)) return;
        if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
            const x = coords[0] as number;
            const y = coords[1] as number;
            if (x < minX) minX = x;
            if (y < minY) minY = y;
            if (x > maxX) maxX = x;
            if (y > maxY) maxY = y;
            return;
        }
        for (const c of coords) visit(c);
    };
    visit((g as { coordinates?: unknown }).coordinates);
    if (!Number.isFinite(minX)) return Infinity;
    return Math.hypot(maxX - minX, maxY - minY);
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
    let sliceStart = performance.now();
    const yieldIfNeeded = async (): Promise<void> => {
        if (performance.now() - sliceStart < 12) return;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        let parkedMs = 0;
        while (mergeInteractionProbe?.() && parkedMs < 2000) {
            await new Promise<void>((resolve) => setTimeout(resolve, 80));
            parkedMs += 80;
        }
        sliceStart = performance.now();
    };

    const merged: EncMergedVectorData = {
        DEPARE: { type: 'FeatureCollection', features: [] },
        LNDARE: { type: 'FeatureCollection', features: [] },
        COALNE: { type: 'FeatureCollection', features: [] },
        OBSTRN: { type: 'FeatureCollection', features: [] },
        WRECKS: { type: 'FeatureCollection', features: [] },
        UWTROC: { type: 'FeatureCollection', features: [] },
        DEPCNT: { type: 'FeatureCollection', features: [] },
        DEPCNT_DERIVED: { type: 'FeatureCollection', features: [] },
        LIGHTS: { type: 'FeatureCollection', features: [] },
        BOYLAT: { type: 'FeatureCollection', features: [] },
        BOYCAR: { type: 'FeatureCollection', features: [] },
        BCNLAT: { type: 'FeatureCollection', features: [] },
        BCNCAR: { type: 'FeatureCollection', features: [] },
        BOYSPP: { type: 'FeatureCollection', features: [] },
        BCNSPP: { type: 'FeatureCollection', features: [] },
        BOYSAW: { type: 'FeatureCollection', features: [] },
        BCNSAW: { type: 'FeatureCollection', features: [] },
        BOYISD: { type: 'FeatureCollection', features: [] },
        BCNISD: { type: 'FeatureCollection', features: [] },
        RECTRC: { type: 'FeatureCollection', features: [] },
        SOUNDG: { type: 'FeatureCollection', features: [] },
        DEPARE_GLAZE: { type: 'FeatureCollection', features: [] },
        SEAARE_LABELS: { type: 'FeatureCollection', features: [] },
        LIGHTSEC: { type: 'FeatureCollection', features: [] },
        cellCount: 0,
    };

    // Scale-shadow de-confliction (the Tangalooma tan wall): an overview cell's
    // crude island/land polygons bulge over water a finer cell charts correctly.
    // Coarse-cell area geometry fully inside a much-finer cell's bbox is dropped
    // — the finer cell owns that ground. Applies to the chart-geometry classes
    // (land, depth areas, coastline, contours); point marks are untouched.
    const cellExtents = cells.map((c) => ({ id: c.id, bbox: c.bbox }));
    const SHADOWED_CLASSES = new Set(['LNDARE', 'DEPARE', 'COALNE', 'DEPCNT']);
    // COARSE → FINE merge order: overlapping near-opaque fills paint in
    // source order, so the finer survey's bands must come LAST to draw on
    // top. Whole-bbox shadowing alone can't stop a huge coarse polygon
    // that pokes outside finer coverage from painting over it (the
    // Newport-approach "dries 2 m over a surveyed 2–5 m band" conflict,
    // 2026-07-11) — order is what resolves the partial overlaps here.
    const cellsCoarseToFine = [...cells].sort((a, b) => cellScaleRank(a.bbox) - cellScaleRank(b.bbox));

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
    for (const cell of cellsCoarseToFine) {
        try {
            // LOCAL blobs only (cloudFallback=false): a registry full of
            // cloud placeholders used to make this loop download the
            // ENTIRE chart library sequentially before painting ANYTHING
            // — a fresh Vercel browser stared at a bare map for tens of
            // minutes (Shane 2026-07-12: "waited a good 5 minutes...
            // not working"). Paint what's on hand NOW; the background
            // hydrator below fetches the rest, and each arrival
            // re-notifies into the debounced merge — the chart fills in
            // cell by cell.
            const blob = await cellStore.loadCellGeoJSON(cell.id, false);
            if (!blob) {
                missingBlobs.push(cell.id);
                continue;
            }
            loadedBlobs.set(cell.id, blob);
            await yieldIfNeeded(); // multi-MB JSON.parse just ran synchronously
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
            log.warn(`getMergedVectorData: failed to load cell ${cell.id}`, err);
        }
    }

    // Charted-water footprint per SHADOWING cell, memoized for this run
    // — feeds the glaze's coverage subtraction. Coordinate arrays are
    // shared with the cached blob, never cloned. THREE states, and the
    // distinction is load-bearing (2026-07-14, "large steps through the
    // shipping channel" — conflating the last two blacked out whole
    // corridor-cell extents):
    //   null              → blob unavailable: fall back to clipping the
    //                       whole data extent (conservative).
    //   []                → charted, but nothing shallow: clip NOTHING.
    //   polys (non-empty) → clip under strip-rasterised polys.
    const coverageMemo = new Map<string, CoverageGeom | null>();
    const coverageFor = (cellId: string): CoverageGeom | null => {
        const memo = coverageMemo.get(cellId);
        if (memo !== undefined) return memo;
        const b = loadedBlobs.get(cellId);
        const cov = b ? shallowClipCoverage([b.layers.DEPARE, b.layers.DRGARE]) : null;
        coverageMemo.set(cellId, cov);
        return cov;
    };

    // Strip-rect coverage per shadowing cell for the glaze clip (see
    // coverageMaskStrips): the survey's REAL polygons rasterised into a
    // staircase of rects that hugs the charted ribbon. Feature bboxes
    // were tried first and failed — a channel cell's bands are long
    // diagonal ribbons, so their bboxes blacked out the water beside
    // the corridor (2026-07-14, "we still have these black squares").
    // Memoized per merge run — the same cell shadows many coarse cells.
    const stripRectsMemo = new Map<string, [number, number, number, number][]>();
    const stripRectsFor = (cellId: string, extent: [number, number, number, number]) => {
        const memo = stripRectsMemo.get(cellId);
        if (memo) return memo;
        const cov = coverageFor(cellId);
        // k=40: shallow-band-only coverage (see coverageFor) leaves far
        // fewer inside-nodes, so a finer grid stays ~1 ms with the ring-
        // bbox prefilter while halving the quantisation halo around banks.
        // NOTE: coverageMaskStrips falls back to [extent] on EMPTY input,
        // so the nothing-shallow case must short-circuit to [] here.
        const rects = cov == null ? [extent] : cov.length === 0 ? [] : coverageMaskStrips(cov, extent, 40, 160);
        stripRectsMemo.set(cellId, rects);
        return rects;
    };

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
    const glazeUpgradeQueue: Array<{
        cellId: string;
        glazeKey: string;
        features: Feature[];
        coverages: Array<{ bbox: [number, number, number, number]; coverage: CoverageGeom }>;
    }> = [];
    const mergeGlazeKeys: string[] = [];

    for (const cell of cellsCoarseToFine) {
        const blob = loadedBlobs.get(cell.id);
        if (!blob) continue;
        await yieldIfNeeded(); // per-cell clone/clip/explode is the heavy loop
        merged.cellCount++;

        const ialaRegion = ialaRegionForSourceHO(cell.sourceHO);
        // Shadow list re-anchored on DATA extents: a finer cell with no
        // DEPARE (marks-only) never erases coarse bands at all.
        const shadows = shadowingCells({ id: cell.id, bbox: cell.bbox }, cellExtents)
            .map((s) => (depareExtent.has(s.id) ? { id: s.id, bbox: depareExtent.get(s.id)! } : null))
            .filter((s): s is { id: string; bbox: [number, number, number, number] } => s !== null);

        const tagAndPush = (
            target: keyof Omit<EncMergedVectorData, 'cellCount'>,
            fc: FeatureCollection | undefined,
        ) => {
            if (!fc || !Array.isArray(fc.features)) return;
            const dest = merged[target];
            for (const feat of fc.features) {
                if (!feat || !feat.geometry) continue;
                // Sub-pixel cull (2026-07-13, the z7-8 OOM): at passage zoom
                // a shoal patch / islet / contour scrap smaller than ~2 px
                // cannot be seen, but still costs worker tiling + GPU
                // buffers — and a 47-cell wide window carries thousands of
                // them. cullDeg is 0 only on the full merge.
                if (cullDeg > 0 && SUBPIXEL_CULLABLE.has(target) && featureDiagDeg(feat) < cullDeg) continue;
                if (shadows.length > 0 && SHADOWED_CLASSES.has(target) && featureIsShadowed(feat, shadows)) continue;
                // GEOMETRY CLIPPING RETIRED (2026-07-11, same day it
                // shipped): cutting coarse DEPARE out of a finer cell's
                // data-extent RECTANGLE left bare black holes wherever the
                // fine cell charts only part of that rectangle (Shane:
                // "the horrible black lines are back" — black boxes over
                // the Bribie channel). In the chart-first world the fills
                // are near-opaque and the merge is sorted coarse→fine, so
                // finest-paints-last hides overlaps WITHOUT cutting holes.
                // (The satellite GLAZE can re-stack translucently — it's a
                // manual peek now; a proper coverage-geometry clip is the
                // future fix if that ever grates. clipDepareOverlap.ts
                // stays for that day.)
                // Decorate properties with provenance so the map
                // can keep "which cell" context for clicks/etc.
                const props: Record<string, unknown> = {
                    ...(feat.properties ?? {}),
                    _cellId: cell.id,
                    _sourceHO: cell.sourceHO,
                    _ialaRegion: ialaRegion,
                };
                // Fineness rank rides along on DEPARE so the renderer can
                // retire a coarse cell's bands at zooms beyond its survey's
                // competence (the "1980s edges", 2026-07-11). Set on the new
                // props object — never stamped into the cached blob here.
                if (target === 'DEPARE') props._scaleRank = cellScaleRank(cell.bbox);

                // Pre-compute the display colour for lateral marks
                // (BOYLAT/BCNLAT) so the renderer doesn't need a
                // case expression that knows about IALA regions.
                // Cardinal marks (BOYCAR/BCNCAR) are always yellow.
                if (target === 'BOYLAT' || target === 'BCNLAT') {
                    const catlamRaw = (feat.properties?.CATLAM ?? feat.properties?.catlam) as unknown;
                    const catlam = typeof catlamRaw === 'number' ? catlamRaw : Number(catlamRaw);
                    props._displayColor = lateralMarkColour(Number.isFinite(catlam) ? catlam : null, ialaRegion);
                }

                // Pre-bake the IALA symbol id + collision priority so
                // the renderer's symbol layers stay dumb expressions.
                // Cardinals mark danger → lowest sort key (wins
                // collision placement), laterals next, specials last.
                if (
                    target === 'BOYLAT' ||
                    target === 'BCNLAT' ||
                    target === 'BOYCAR' ||
                    target === 'BCNCAR' ||
                    target === 'BOYSPP' ||
                    target === 'BCNSPP' ||
                    target === 'BOYSAW' ||
                    target === 'BCNSAW' ||
                    target === 'BOYISD' ||
                    target === 'BCNISD'
                ) {
                    const featProps = (feat.properties ?? {}) as Record<string, unknown>;
                    props._icon = encNavaidIconId(target, featProps, ialaRegion);
                    // Danger marks (cardinals + isolated danger) win the
                    // collision engine, then laterals + safe water, then
                    // specials.
                    props._priority =
                        target === 'BOYCAR' || target === 'BCNCAR' || target === 'BOYISD' || target === 'BCNISD'
                            ? 0
                            : target === 'BOYSPP' || target === 'BCNSPP'
                              ? 2
                              : 1;
                }

                // Lights: pre-bake everything the renderer + label
                // layers need so paint expressions stay coalesces.
                //  - _lightTier: VALNMR >= 10 NM = 'major' (always
                //    shown); missing VALNMR defaults minor (correct
                //    bias — only 26/400 live lights carry VALNMR).
                //  - _lightColor: first code of the comma-split
                //    S-57 COLOUR string → display hex.
                //  - _lightLabel: 'Fl(2)G 5s 12m 8M' character
                //    string, omitted when LITCHR is absent.
                if (target === 'LIGHTS') {
                    const featProps = (feat.properties ?? {}) as Record<string, unknown>;
                    const valnmr = Number(featProps.VALNMR ?? featProps.valnmr);
                    props._lightTier = Number.isFinite(valnmr) && valnmr >= 10 ? 'major' : 'minor';
                    const colHex = lightColourHex(featProps.COLOUR ?? featProps.colour);
                    if (colHex) props._lightColor = colHex;
                    const label = buildLightCharacterLabel(featProps);
                    if (label) props._lightLabel = label;
                    // Sectored light → generate the coloured arc + limit
                    // legs into LIGHTSEC (night-approach read). Each S-57
                    // sector is its own LIGHTS feature, so this fires per
                    // sector and one light's sectors accrete naturally.
                    const bearings = LIGHT_SECTORS_ENABLED ? readSectorBearings(featProps) : null;
                    if (bearings && feat.geometry?.type === 'Point') {
                        const secProps = {
                            _cellId: cell.id,
                            _minZoom: typeof props._minZoom === 'number' ? props._minZoom : undefined,
                            OBJNAM: featProps.OBJNAM ?? featProps.objnam,
                            _lightLabel: label ?? undefined,
                        };
                        merged.LIGHTSEC.features.push(
                            ...buildSectorFeatures({
                                position: feat.geometry.coordinates as [number, number],
                                sectr1: bearings.sectr1,
                                sectr2: bearings.sectr2,
                                colorHex: colHex ?? '#f0e030',
                                baseProps: secProps,
                            }),
                        );
                    }
                }

                dest.features.push({ ...feat, properties: props });
            }
        };

        tagAndPush('DEPARE', blob.layers.DEPARE);
        // DRGARE (dredged areas) carries DRVAL1 just like DEPARE —
        // merge into the same collection so dredged basins shade
        // with the draft-aware depth bands instead of rendering as
        // chart holes.
        tagAndPush('DEPARE', blob.layers.DRGARE);
        // Glaze variant — built from the ORIGINAL band features (NOT the
        // post-featureIsShadowed survivors). Two grades:
        //  - INSTANT (here, main thread): finer cells' data-extent
        //    RECTANGLES subtracted (Sutherland–Hodgman, microseconds).
        //    May leave surf-strip dark boxes where a fine survey charts
        //    only part of its rectangle.
        //  - UPGRADED (encGeometryWorker): the finer cells' ACTUAL charted
        //    coverage subtracted (martinez) — exactly one band over
        //    charted water, zero holes ("shaded areas around some areas
        //    in shore", Shane 2026-07-12). Swapped in via the geometry-
        //    upgrade hook when the worker answers; NEVER computed here
        //    (it OOM-killed the WebView, device log 2026-07-13).
        // ZOOM-GATED to nav zoom — a second copy of every band across a
        // passage-zoom window fed the z7-8 OOM. See GLAZE_MIN_ZOOM.
        if (buildGlaze) {
            // Memo key: the glaze for this cell is fully determined by its
            // own blob (cellId + version) and the SHADOWING cells that clip
            // it (their ids, sorted — same set for both grades).
            const glazeKey = `${cacheKey.split(':')[0]}:${cell.id}:${shadows
                .map((s) => s.id)
                .sort()
                .join(',')}`;
            const cached = glazeCellCache.get(glazeKey);
            let needQueue = false;
            if (cached) {
                putGlazeCell(glazeKey, cached); // refresh LRU position
                for (const f of cached.feats) merged.DEPARE_GLAZE.features.push(f);
                needQueue = !cached.upgraded && shadows.length > 0;
            } else {
                const glazeRank = cellScaleRank(cell.bbox);
                // Strip rects, not the whole data-extent rectangle: a
                // narrow channel survey's rect clipped the coarse SAFE
                // glaze out of the water it never charts — dark squares
                // marching up the NE Channel at bay zoom (2026-07-14).
                // Strips hug the fine features (conservative: bbox ⊇
                // band), so coarse white survives only where the fine
                // survey is silent.
                const finerRects = shadows.flatMap((s) => stripRectsFor(s.id, s.bbox));
                const glazeOut: Feature[] = [];
                for (const fc of [blob.layers.DEPARE, blob.layers.DRGARE]) {
                    for (const feat of fc?.features ?? []) {
                        if (!feat || !feat.geometry) continue;
                        const base: Feature = {
                            ...feat,
                            properties: { ...(feat.properties ?? {}), _scaleRank: glazeRank },
                        };
                        const glazed = finerRects.length > 0 ? clipFeatureOutsideBboxes(base, finerRects) : base;
                        if (glazed) glazeOut.push(glazed);
                        // EVERY feature, not every 64th (review 2026-07-14):
                        // one multi-thousand-vertex band vs hundreds of clip
                        // rects costs whole milliseconds, so a 64-feature
                        // stride let 300 ms+ run uninterrupted between yield
                        // checks. The check itself early-returns in <1 µs
                        // when the 12 ms slice isn't up.
                        if (finerRects.length > 0) await yieldIfNeeded();
                    }
                }
                for (const f of glazeOut) merged.DEPARE_GLAZE.features.push(f);
                putGlazeCell(glazeKey, { upgraded: shadows.length === 0, feats: glazeOut });
                needQueue = shadows.length > 0;
            }
            if (needQueue && GEOMETRY_WORKER_ENABLED) {
                // Payload for the worker's true-coverage upgrade: the
                // decorated base features + the shadowing cells' actual
                // charted polygons (coordinate arrays shared with the
                // cached blobs — structured-clone copies them off-thread).
                // Gated on the flag so a disabled worker costs ZERO — no
                // payload copies built just to be thrown away.
                const fineCoverages = shadows
                    .map((s) => {
                        const cov = coverageFor(s.id);
                        // Empty = nothing shallow = nothing to subtract.
                        return cov && cov.length > 0 ? { bbox: s.bbox, coverage: cov } : null;
                    })
                    .filter((c): c is { bbox: [number, number, number, number]; coverage: CoverageGeom } => c !== null);
                if (fineCoverages.length > 0) {
                    const glazeRank = cellScaleRank(cell.bbox);
                    const baseFeats: Feature[] = [];
                    for (const fc of [blob.layers.DEPARE, blob.layers.DRGARE]) {
                        for (const feat of fc?.features ?? []) {
                            if (!feat || !feat.geometry) continue;
                            baseFeats.push({
                                ...feat,
                                properties: { ...(feat.properties ?? {}), _scaleRank: glazeRank },
                            });
                        }
                    }
                    glazeUpgradeQueue.push({
                        cellId: cell.id,
                        glazeKey,
                        features: baseFeats,
                        coverages: fineCoverages,
                    });
                } else {
                    // No real coverage to subtract — the rectangle grade IS final.
                    const entry = glazeCellCache.get(glazeKey);
                    if (entry) entry.upgraded = true;
                }
            }
            mergeGlazeKeys.push(glazeKey);
        }
        tagAndPush('LNDARE', blob.layers.LNDARE);
        tagAndPush('COALNE', blob.layers.COALNE);
        tagAndPush('OBSTRN', blob.layers.OBSTRN);
        tagAndPush('WRECKS', blob.layers.WRECKS);
        tagAndPush('UWTROC', blob.layers.UWTROC);
        tagAndPush('DEPCNT', blob.layers.DEPCNT);
        tagAndPush('LIGHTS', blob.layers.LIGHTS);
        tagAndPush('BOYLAT', blob.layers.BOYLAT);
        tagAndPush('BOYCAR', blob.layers.BOYCAR);
        tagAndPush('BCNLAT', blob.layers.BCNLAT);
        tagAndPush('BCNCAR', blob.layers.BCNCAR);
        tagAndPush('BOYSPP', blob.layers.BOYSPP);
        tagAndPush('BCNSPP', blob.layers.BCNSPP);
        tagAndPush('BOYSAW', blob.layers.BOYSAW);
        tagAndPush('BCNSAW', blob.layers.BCNSAW);
        tagAndPush('BOYISD', blob.layers.BOYISD);
        tagAndPush('BCNISD', blob.layers.BCNISD);
        tagAndPush('RECTRC', blob.layers.RECTRC);

        // Named sea areas → ONE label point per name ("put the channel
        // name in the channels", Shane 2026-07-13). Skips tagAndPush: the
        // polygons are label carriers only — reducing them here keeps a
        // bay-sized SEAARE from ever entering the render heap. Label
        // anchor = outer-ring vertex average of the largest polygon (a
        // curving river's centroid can drift slightly off-axis; readable,
        // and the finest chart's tighter geometry wins the dedupe).
        for (const feat of blob.layers.SEAARE?.features ?? []) {
            const g = feat?.geometry;
            if (!g) continue;
            const props = (feat.properties ?? {}) as Record<string, unknown>;
            const name = typeof props.OBJNAM === 'string' ? props.OBJNAM.trim() : '';
            if (!name) continue;
            // The AU SENC emits most named areas as POINTS — the
            // cartographer's own label anchor, use it verbatim. Polygon
            // SEAARE falls back to the largest-ring vertex average.
            let anchor: [number, number] | null = null;
            if (g.type === 'Point') {
                const c = g.coordinates as number[];
                if (Number.isFinite(c?.[0]) && Number.isFinite(c?.[1])) anchor = [c[0], c[1]];
            } else if (g.type === 'Polygon' || g.type === 'MultiPolygon') {
                const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
                let ring: number[][] | null = null;
                for (const poly of polys) {
                    const outer = poly?.[0] as number[][] | undefined;
                    if (outer && outer.length >= 4 && (!ring || outer.length > ring.length)) ring = outer;
                }
                if (ring) {
                    let sx = 0;
                    let sy = 0;
                    const n = ring.length - 1; // skip the closing duplicate vertex
                    for (let i = 0; i < n; i++) {
                        sx += ring[i][0];
                        sy += ring[i][1];
                    }
                    anchor = [sx / n, sy / n];
                }
            }
            if (!anchor) continue;
            const labelProps: Record<string, unknown> = { _name: name };
            // SCAMIN gates the 1:90k channel/bank names to z12.6 — "need
            // to be at zoom 13 to see any names... probably a bit high"
            // (Shane 2026-07-14). Same doctrine as the sounding ladder:
            // SCAMIN is paper declutter advice, not law. Keep the
            // HIERARCHY (bay names before bank names) but pull the whole
            // ladder ~2.5 levels earlier: 12.6→10.1, 11.6→9.1, 8.5→the
            // layer floor. Collision handles the density.
            if (typeof props._minZoom === 'number') {
                labelProps._minZoom = Math.max(7, props._minZoom - 2.5);
            }
            seaareByName.set(name, {
                type: 'Feature',
                geometry: { type: 'Point', coordinates: anchor },
                properties: labelProps,
            });
        }

        // Soundings: explode each MultiPoint cloud into labelled points.
        // DELIBERATELY skips tagAndPush — no provenance/_cellId decoration:
        // a harbour cell carries thousands of soundings and the minimal
        // {_d, _minZoom?} bag is what keeps the merged heap sane. Depth
        // comes from the SENC `depths` array, the 25D Z, or VALSOU —
        // whichever the extraction path supplied.
        for (const feat of blob.layers.SOUNDG?.features ?? []) {
            const g = feat?.geometry;
            if (!g) continue;
            const featProps = (feat.properties ?? {}) as Record<string, unknown>;
            const minZoom = typeof featProps._minZoom === 'number' ? featProps._minZoom : undefined;
            const depthsArr = Array.isArray(featProps.depths) ? (featProps.depths as unknown[]) : null;
            const coords: number[][] =
                g.type === 'MultiPoint'
                    ? (g.coordinates as number[][])
                    : g.type === 'Point'
                      ? [g.coordinates as number[]]
                      : [];
            for (let i = 0; i < coords.length; i++) {
                const c = coords[i];
                if (!Array.isArray(c) || !Number.isFinite(c[0]) || !Number.isFinite(c[1])) continue;
                const raw = depthsArr?.[i] ?? c[2] ?? featProps.VALSOU ?? featProps.DEPTH;
                const d = typeof raw === 'number' ? raw : Number(raw);
                if (!Number.isFinite(d)) continue;
                const props: Record<string, unknown> = { _d: Math.round(d * 10) / 10 };
                if (minZoom !== undefined) props._minZoom = minZoom;
                merged.SOUNDG.features.push({
                    type: 'Feature',
                    geometry: { type: 'Point', coordinates: [c[0], c[1]] },
                    properties: props,
                });
            }
        }
    }

    merged.SEAARE_LABELS.features = [...seaareByName.values()];

    // Density ladder: bake "one number per ~90 px of glass" min-zooms
    // onto the merged sounding heap, shallowest-first (safety: the
    // surviving number is always the scariest nearby). Runs on the
    // MERGED set, not per cell — per-cell passes double density at
    // every cell seam.
    await yieldIfNeeded(); // the ladder is one indivisible hot pass
    assignSoundingDensityMinZoom(merged.SOUNDG.features as Array<Feature<Point>>);

    // Sounding LOD cull (2026-07-13, the z7-8 OOM): the ladder just stamped
    // every sounding with the min-zoom it becomes visible at. A wide-window
    // merge holds ~30 k of them (device log) but SCAMIN hides all but a
    // handful at passage scale — yet every one still loads into the source
    // as a collision-tested text symbol, the single heaviest layer on the
    // map. Drop the ones that can't render within LOOKAHEAD of the current
    // zoom; a whole-zoom re-merge (the cache bucket) refreshes the set as
    // the punter closes in. zoom==null (seaway/full merge) keeps them all.
    if (zoom != null) {
        const cap = zoom + SOUNDING_LOD_LOOKAHEAD;
        merged.SOUNDG.features = merged.SOUNDG.features.filter((f) => {
            const mz = (f.properties as { _minZoom?: number } | null)?._minZoom;
            return typeof mz !== 'number' || mz <= cap;
        });
    }

    mergedCache.set(cacheKey, merged);
    while (mergedCache.size > MERGED_CACHE_MAX) {
        const oldest = mergedCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        mergedCache.delete(oldest);
    }

    // Hand the HEAVY geometry to the worker: the true-coverage glaze
    // upgrade (queued per cell above) and the sounding-derived contours
    // (Delaunay + isoline march — hung the main thread 2026-07-12,
    // OOM-killed it 2026-07-13 when run here). Both answers swap into
    // this cached merge via the geometry-upgrade hook. No worker (old
    // WebView, died earlier this session) = the fast version stays up.
    const wantContours =
        GEOMETRY_WORKER_ENABLED && densify && merged.SOUNDG.features.length <= DERIVED_CONTOUR_MAX_SOUNDINGS;
    if (glazeUpgradeQueue.length > 0 || wantContours) {
        const worker = getGeoWorker();
        if (worker) {
            const jobId = ++geoJobSeq;
            pendingGeometryJobs.set(jobId, {
                cacheKey,
                glazeKeys: glazeUpgradeQueue.length > 0 ? mergeGlazeKeys : [],
            });
            const contourPoints = wantContours
                ? merged.SOUNDG.features.map((f) => {
                      const c = (f.geometry as Point).coordinates;
                      return { lon: c[0], lat: c[1], d: Number((f.properties as { _d?: number })?._d) };
                  })
                : undefined;
            try {
                worker.postMessage({ jobId, glazeCells: glazeUpgradeQueue, contourPoints });
            } catch (err) {
                pendingGeometryJobs.delete(jobId);
                log.warn(`geometry worker dispatch failed: ${err instanceof Error ? err.message : String(err)}`);
            }
        }
    }
    if (missingBlobs.length > 0) {
        log.warn(`merge painted ${merged.cellCount} local cells; hydrating ${missingBlobs.length} from the cloud`);
        void hydrateMissingCells(missingBlobs);
    }
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
    return merged;
}

// ── Background blob hydration ─────────────────────────────────────

/** Single-flight guard — one hydration walk at a time. */
let hydrationRunning = false;

/** Failed downloads wait out a cooldown before another attempt —
 *  every window-escape pan used to re-run a doomed sequential fetch
 *  loop over the same missing cells (offline: forever, 2026-07-12
 *  audit). Success clears the cell's cooldown. */
const hydrationCooldownUntil = new Map<string, number>();
const HYDRATION_RETRY_COOLDOWN_MS = 60_000;

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
    try {
        const { downloadCloudCell } = await import('./cloudCellSync');
        for (let i = 0; i < walk.length; i++) {
            const id = walk[i];
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
            setHydrationProgress({ remaining: walk.length - i - 1, total: walk.length });
        }
    } catch (err) {
        log.warn(`hydration walk failed: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
        hydrationRunning = false;
        setHydrationProgress({ remaining: 0, total: 0 });
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
