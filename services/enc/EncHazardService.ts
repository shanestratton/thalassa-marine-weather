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

import { createLogger } from '../../utils/createLogger';
import * as cellStore from './EncCellStore';
import * as cellMeta from './EncCellMetadata';
import { shadowingCells, featureIsShadowed } from './scaleShadow';
import { EncSpatialIndex, type EncCatzocZone, type EncCoastline } from './EncSpatialIndex';
import type { EncCatzoc, EncCell, EncConversionResult, EncHazard, EncHazardResult, EncLayer } from './types';
import {
    buildLightCharacterLabel,
    encNavaidIconId,
    ialaRegionForSourceHO,
    lateralMarkColour,
    lightColourHex,
} from './types';

const log = createLogger('EncHazardService');

// ── In-memory index cache ──────────────────────────────────────────

/**
 * One EncSpatialIndex per loaded cell. Keyed by cell ID.
 * Built lazily on first query that touches a given cell.
 */
const indexes: Map<string, EncSpatialIndex> = new Map();

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
    const cached = indexes.get(cellId);
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
    indexes.set(cellId, index);
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
    const cells = cellMeta.cellsForBBox(bbox);
    await Promise.all(cells.map((c) => getOrBuildIndex(c.id)));
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

    // Pre-build all candidate indexes in parallel.
    const candidateIndexes: EncSpatialIndex[] = [];
    await Promise.all(
        candidateCells.map(async (cell) => {
            const idx = await getOrBuildIndex(cell.id);
            if (idx) candidateIndexes.push(idx);
        }),
    );

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
    const path = await cellStore.saveCellGeoJSON(blob.cellId, blob);

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
    const sizeBytes = JSON.stringify(blob).length;

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
    /** Lights / lighthouses (display only). */
    LIGHTS: FeatureCollection;
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
    /** Recommended tracks / leading lines (RECTRC line features).
     *  The same geometry the tracer grades leads against — drawing
     *  it is what lets a punter STEER by the lead (Shane 2026-07-09
     *  "show markers, leads, laterals and cardinals"). */
    RECTRC: FeatureCollection;
    /** Total cells contributing data. */
    cellCount: number;
}

let mergedCache: { version: number; data: EncMergedVectorData } | null = null;

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
export async function getMergedVectorData(): Promise<EncMergedVectorData | null> {
    const cells = cellMeta.listCells();
    if (cells.length === 0) {
        mergedCache = null;
        return null;
    }
    const currentVersion = cellMeta.getVersion();
    if (mergedCache && mergedCache.version === currentVersion) return mergedCache.data;

    const merged: EncMergedVectorData = {
        DEPARE: { type: 'FeatureCollection', features: [] },
        LNDARE: { type: 'FeatureCollection', features: [] },
        COALNE: { type: 'FeatureCollection', features: [] },
        OBSTRN: { type: 'FeatureCollection', features: [] },
        WRECKS: { type: 'FeatureCollection', features: [] },
        UWTROC: { type: 'FeatureCollection', features: [] },
        DEPCNT: { type: 'FeatureCollection', features: [] },
        LIGHTS: { type: 'FeatureCollection', features: [] },
        BOYLAT: { type: 'FeatureCollection', features: [] },
        BOYCAR: { type: 'FeatureCollection', features: [] },
        BCNLAT: { type: 'FeatureCollection', features: [] },
        BCNCAR: { type: 'FeatureCollection', features: [] },
        BOYSPP: { type: 'FeatureCollection', features: [] },
        BCNSPP: { type: 'FeatureCollection', features: [] },
        RECTRC: { type: 'FeatureCollection', features: [] },
        cellCount: 0,
    };

    // Scale-shadow de-confliction (the Tangalooma tan wall): an overview cell's
    // crude island/land polygons bulge over water a finer cell charts correctly.
    // Coarse-cell area geometry fully inside a much-finer cell's bbox is dropped
    // — the finer cell owns that ground. Applies to the chart-geometry classes
    // (land, depth areas, coastline, contours); point marks are untouched.
    const cellExtents = cells.map((c) => ({ id: c.id, bbox: c.bbox }));
    const SHADOWED_CLASSES = new Set(['LNDARE', 'DEPARE', 'COALNE', 'DEPCNT']);
    for (const cell of cells) {
        let blob;
        try {
            blob = await cellStore.loadCellGeoJSON(cell.id);
        } catch (err) {
            log.warn(`getMergedVectorData: failed to load cell ${cell.id}`, err);
            continue;
        }
        if (!blob) continue;
        merged.cellCount++;

        const ialaRegion = ialaRegionForSourceHO(cell.sourceHO);
        const shadows = shadowingCells({ id: cell.id, bbox: cell.bbox }, cellExtents);

        const tagAndPush = (
            target: keyof Omit<EncMergedVectorData, 'cellCount'>,
            fc: FeatureCollection | undefined,
        ) => {
            if (!fc || !Array.isArray(fc.features)) return;
            const dest = merged[target];
            for (const feat of fc.features) {
                if (!feat || !feat.geometry) continue;
                if (shadows.length > 0 && SHADOWED_CLASSES.has(target) && featureIsShadowed(feat, shadows)) continue;
                // Decorate properties with provenance so the map
                // can keep "which cell" context for clicks/etc.
                const props: Record<string, unknown> = {
                    ...(feat.properties ?? {}),
                    _cellId: cell.id,
                    _sourceHO: cell.sourceHO,
                    _ialaRegion: ialaRegion,
                };

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
                    target === 'BCNSPP'
                ) {
                    const featProps = (feat.properties ?? {}) as Record<string, unknown>;
                    props._icon = encNavaidIconId(target, featProps, ialaRegion);
                    props._priority =
                        target === 'BOYCAR' || target === 'BCNCAR'
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
        tagAndPush('RECTRC', blob.layers.RECTRC);
    }

    mergedCache = { version: currentVersion, data: merged };
    log.info(
        `merged vector data: ${merged.cellCount} cells, ` +
            `DEPARE(+DRGARE)=${merged.DEPARE.features.length}, DEPCNT=${merged.DEPCNT.features.length}, ` +
            `COALNE=${merged.COALNE.features.length}, ` +
            `OBSTRN+WRECKS+UWTROC=${merged.OBSTRN.features.length + merged.WRECKS.features.length + merged.UWTROC.features.length}, ` +
            `LIGHTS=${merged.LIGHTS.features.length}, ` +
            `lat (BOY+BCN)=${merged.BOYLAT.features.length + merged.BCNLAT.features.length}, ` +
            `card (BOY+BCN)=${merged.BOYCAR.features.length + merged.BCNCAR.features.length}, ` +
            `spp (BOY+BCN)=${merged.BOYSPP.features.length + merged.BCNSPP.features.length}, ` +
            `leads (RECTRC)=${merged.RECTRC.features.length}`,
    );
    return merged;
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
