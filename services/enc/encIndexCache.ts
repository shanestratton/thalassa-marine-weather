/**
 * encIndexCache — the per-cell spatial-index LRU + the failed-load set.
 *
 * Indexes are built lazily from blobs (tens of ms) and kept warm for a
 * passage leg. LRU-CAPPED (2026-07-12 audit): "we don't evict aggressively"
 * was sized for the 1–10-cell era, but a long coastal session pinned 30+
 * cells' full hazard geometry — surviving even blob-cache eviction, so
 * freeing a blob stopped freeing memory. `failedLoads` tracks cells whose
 * blob was missing/corrupt so a query doesn't retry them every time.
 *
 * Extracted from the EncHazardService god-module (mission audit: 16 mutable
 * caches in one namespace) so the index-cache concern owns its own state.
 */
import type { EncSpatialIndex } from './EncSpatialIndex';

const indexes = new Map<string, EncSpatialIndex>();
/** 12 covered a bay-scale window but a LONG coastal route's candidate set
 *  (Brisbane→Cairns ≈ 30 cells) evicted mid-validation, so every query batch
 *  rebuilt indexes it had just built (burn-down: resize for route-length
 *  candidate sets). 24 was raised to 32 (2026-07-17 audit: 24 still sat
 *  BELOW the acknowledged ~30-cell set, so the sequential scan thrashed —
 *  eviction one step ahead of the scan rebuilt every index per batch).
 *  32 holds the full candidate set + slack; the original leak this cap
 *  fixed was 30+ PINNED indexes with no eviction at all — still bounded. */
const INDEX_CACHE_MAX = 32;
const failedLoads = new Map<string, number>();

/** Get a cached index, refreshing its LRU position (most-recently-used). */
export function touchIndex(cellId: string): EncSpatialIndex | undefined {
    const hit = indexes.get(cellId);
    if (hit) {
        indexes.delete(cellId);
        indexes.set(cellId, hit);
    }
    return hit;
}

/** Cache an index, evicting the least-recently-used beyond INDEX_CACHE_MAX. */
export function cacheIndex(cellId: string, index: EncSpatialIndex): void {
    indexes.delete(cellId);
    indexes.set(cellId, index);
    while (indexes.size > INDEX_CACHE_MAX) {
        const oldest = indexes.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        indexes.delete(oldest);
    }
}

/** Failed loads retry after a cooldown, not never (2026-07-17 audit
 *  finding #1: a transient read failure — mid-hydration, FS hiccup —
 *  used to pin the cell failed for the WHOLE SESSION, silently dropping
 *  its water to GEBCO for every route until restart). A genuinely
 *  corrupt blob still only costs one re-load attempt per minute. */
export const INDEX_FAIL_RETRY_MS = 60_000;

/** True if this cell's blob recently failed to load (cooldown running). */
export function isIndexFailed(cellId: string): boolean {
    const at = failedLoads.get(cellId);
    if (at === undefined) return false;
    if (Date.now() - at < INDEX_FAIL_RETRY_MS) return true;
    failedLoads.delete(cellId); // cooldown over — let the next query retry
    return false;
}

/** Record that a cell's blob failed to load (missing/corrupt). */
export function markIndexFailed(cellId: string): void {
    failedLoads.set(cellId, Date.now());
}

/** Cells currently in the failed state — feeds the route advisory that
 *  tells the skipper charted water fell back to GEBCO. */
export function failedCellIds(): string[] {
    return [...failedLoads.keys()].filter((id) => isIndexFailed(id));
}

/** Forget a cell entirely — index + failed flag (on re-import / removal). */
export function dropIndex(cellId: string): void {
    indexes.delete(cellId);
    failedLoads.delete(cellId);
}

/** Drop every cached index + failed flag (bulk re-import / reset). */
export function clearIndexCache(): void {
    indexes.clear();
    failedLoads.clear();
}

/** Current cached-index count (test/stat hook). */
export function indexCacheSize(): number {
    return indexes.size;
}
