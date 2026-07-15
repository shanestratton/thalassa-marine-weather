/**
 * ENC Cell Store — Capacitor Filesystem persistence for the
 * GeoJSON blobs produced by the Pi-side S-57 → GeoJSON converter.
 *
 * One file per cell at `Directory.Data/enc-cells/<cellId>.geojson`.
 * Files run ~0.5 MB median, ~7.6 MB largest across the measured AU corpus
 * (2026-07-16; a busy harbour cell is the top end), so we deliberately
 * keep them on the filesystem rather than in
 * IndexedDB or localStorage (both of which have origin-quota
 * limits we'd hit on a power-user fleet).
 *
 * The blob shape is the union of layer FeatureCollections returned
 * by the Pi conversion endpoint. The EncHazardService is
 * responsible for parsing this back into EncHazard records.
 *
 * Public API:
 *  - saveCellGeoJSON(cellId, blob) → relative filesystem path
 *  - loadCellGeoJSON(cellId)       → parsed JSON or null
 *  - deleteCellGeoJSON(cellId)     → idempotent delete
 *  - clearAllGeoJSON()             → delete the entire directory
 */

import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

import { createLogger } from '../../utils/createLogger';
import type { EncConversionResult } from './types';
import { ENC_GEOJSON_DIR } from './types';

const log = createLogger('EncCellStore');

// ── Helpers ────────────────────────────────────────────────────────

const DIRECTORY = Directory.Data;

function relPath(cellId: string): string {
    // S-57 cell IDs are alphanumeric (DSID/DSNM); guard anyway.
    const safe = cellId.replace(/[^A-Za-z0-9_-]/g, '_');
    return `${ENC_GEOJSON_DIR}/${safe}.geojson`;
}

/**
 * Ensure the parent directory exists. Capacitor's `writeFile`
 * requires the directory to exist; we create it lazily on first
 * write rather than at app-init time so we don't pay the cost when
 * no ENCs are imported.
 */
async function ensureDir(): Promise<void> {
    try {
        await Filesystem.mkdir({ path: ENC_GEOJSON_DIR, directory: DIRECTORY, recursive: true });
    } catch (err) {
        // Capacitor throws if the dir already exists — swallow.
        const msg = err instanceof Error ? err.message : String(err);
        if (!/exist/i.test(msg)) {
            log.warn('ensureDir failed', err);
            throw err;
        }
    }
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Parsed-blob memory cache (2026-07-11, Shane: "it seems to take a
 * long time for our new layer to show up"). Every render merge used
 * to re-read + re-JSON.parse EVERY cell from disk — and a cell-sync
 * storm triggers many merges back to back. Geometry objects are
 * shared into the merged FeatureCollections anyway (properties get
 * cloned, geometry doesn't), so caching the parsed blob costs little
 * beyond what the merge already retains. Invalidated on save/delete.
 */
const blobCache = new Map<string, { blob: EncConversionResult; sizeBytes: number }>();

/** LRU caps (2026-07-12): unbounded, the cache held all 172 parsed
 *  cells (~210 MB of JSON text, several × that as JS heap) and desktop
 *  Chrome's renderer OOM-died. The first fix capped ENTRY COUNT only —
 *  and a count cap alone can pin unbounded heap if cells are large, so
 *  it was the wrong bound (2026-07-12 audit, MAJOR). Eviction now respects a
 *  BYTE budget (JSON text length; JS heap runs a few × this) as well
 *  as the count. A handful of most-recent entries are always kept so
 *  one oversized cell can't thrash itself out of its own render loop.
 *  Map iteration order = insertion order; touchBlob() re-inserts on
 *  hit so eviction is least-recently-USED. */
// Real AU corpus (measured 2026-07-16): median cell ~0.5 MB, LARGEST ~7.6 MB
// — nothing like the hypothetical "50 MB" the old note guessed. So the BYTE
// budget is the memory bound that matters; the count cap just kept the LRU
// from growing unboundedly. At 32 the count bound bit first for these small
// cells (~16 MB of 0.5 MB cells) and evicted/re-parsed history the 48 MB
// budget had room for. Raised to 128 so the 48 MB byte cap is the real
// bound: the same peak memory now retains far more recently-panned cells,
// cutting the JSON.parse re-parse churn on a wide coastal pan. Memory is
// unchanged — BLOB_CACHE_MAX_BYTES is untouched.
const BLOB_CACHE_MAX = 128;
const BLOB_CACHE_MAX_BYTES = 48 * 1024 * 1024; // JSON text — heap ≈ few ×
const BLOB_CACHE_MIN_KEEP = 4;
let blobCacheBytes = 0;

/** Eviction decision for the blob LRU — pure so the caps interplay is
 *  unit-tested. Evict the oldest while over EITHER cap, but never below the
 *  min-keep floor (so a working set of a few cells can't thrash itself out
 *  of its own render loop, even if one is oversized). */
export function shouldEvictBlob(
    count: number,
    bytes: number,
    max = BLOB_CACHE_MAX,
    maxBytes = BLOB_CACHE_MAX_BYTES,
    minKeep = BLOB_CACHE_MIN_KEEP,
): boolean {
    return count > minKeep && (count > max || bytes > maxBytes);
}

function touchBlob(cellId: string): EncConversionResult | undefined {
    const hit = blobCache.get(cellId);
    if (hit) {
        blobCache.delete(cellId);
        blobCache.set(cellId, hit);
    }
    return hit?.blob;
}

function dropBlob(cellId: string): void {
    const hit = blobCache.get(cellId);
    if (hit) {
        blobCacheBytes -= hit.sizeBytes;
        blobCache.delete(cellId);
    }
}

function cacheBlob(cellId: string, blob: EncConversionResult, sizeBytes: number): void {
    dropBlob(cellId);
    blobCache.set(cellId, { blob, sizeBytes });
    blobCacheBytes += sizeBytes;
    while (shouldEvictBlob(blobCache.size, blobCacheBytes)) {
        const oldest = blobCache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        dropBlob(oldest);
    }
}

/**
 * Save the converted GeoJSON for a cell. Returns the relative path
 * the caller should persist in the cell metadata record, plus the
 * serialized byte length — importCell used to re-stringify the whole
 * multi-MB blob a second time just to measure it (2026-07-12 audit:
 * ~80 MB of transient UTF-16 per big cell, twice, on the UI thread).
 *
 * Overwrites if the file already exists (used when the user
 * re-imports an updated edition of the same cell).
 */
export async function saveCellGeoJSON(
    cellId: string,
    blob: EncConversionResult,
): Promise<{ path: string; sizeBytes: number }> {
    await ensureDir();
    const path = relPath(cellId);
    const data = JSON.stringify(blob);
    await Filesystem.writeFile({
        path,
        data,
        directory: DIRECTORY,
        encoding: Encoding.UTF8,
    });
    // We hold the fresh parsed blob right here — cache it instead of
    // forcing the next merge to re-read + re-parse what we just wrote.
    cacheBlob(cellId, blob, data.length);
    log.info(`saved cell ${cellId} → ${path} (${(data.length / 1024).toFixed(1)} KB)`);
    return { path, sizeBytes: data.length };
}

/**
 * Load and parse the GeoJSON for a cell. Returns null if the file
 * is missing or malformed. A missing blob falls back to the CLOUD
 * bucket once (desktop builder, Phase 5 — the browser can't reach
 * the Pi, so registered-but-not-downloaded cells hydrate on demand).
 */
export async function loadCellGeoJSON(cellId: string, cloudFallback = true): Promise<EncConversionResult | null> {
    const cached = touchBlob(cellId);
    if (cached) return cached;
    try {
        const path = relPath(cellId);
        const result = await Filesystem.readFile({
            path,
            directory: DIRECTORY,
            encoding: Encoding.UTF8,
        });
        const text = typeof result.data === 'string' ? result.data : await result.data.text();
        const parsed = JSON.parse(text) as EncConversionResult;
        if (!parsed || typeof parsed !== 'object' || !parsed.cellId) {
            log.warn(`loadCellGeoJSON ${cellId}: malformed JSON`);
            return null;
        }
        cacheBlob(cellId, parsed, text.length);
        return parsed;
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/not exist|ENOENT|File does not exist/i.test(msg)) {
            if (cloudFallback) {
                const { downloadCloudCell } = await import('./cloudCellSync');
                if (await downloadCloudCell(cellId)) return loadCellGeoJSON(cellId, false);
            }
            return null;
        }
        log.warn(`loadCellGeoJSON ${cellId} failed`, err);
        return null;
    }
}

/**
 * Delete a cell's GeoJSON blob. Idempotent — succeeds even if the
 * file is missing.
 */
export async function deleteCellGeoJSON(cellId: string): Promise<void> {
    dropBlob(cellId);
    try {
        await Filesystem.deleteFile({
            path: relPath(cellId),
            directory: DIRECTORY,
        });
        log.info(`deleted cell ${cellId}`);
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/not exist|ENOENT|File does not exist/i.test(msg)) return;
        log.warn(`deleteCellGeoJSON ${cellId} failed`, err);
    }
}

/**
 * Wipe the entire ENC GeoJSON directory. Used by "reset all
 * charts" admin action and by tests.
 */
export async function clearAllGeoJSON(): Promise<void> {
    blobCache.clear();
    blobCacheBytes = 0;
    try {
        await Filesystem.rmdir({
            path: ENC_GEOJSON_DIR,
            directory: DIRECTORY,
            recursive: true,
        });
        log.info('cleared all ENC GeoJSON blobs');
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (/not exist|ENOENT/i.test(msg)) return;
        log.warn('clearAllGeoJSON failed', err);
    }
}
