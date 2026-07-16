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
 *  candidate sets). 24 holds a passage leg's worth; the original leak this
 *  cap fixed was 30+ PINNED indexes with no eviction at all — still bounded. */
const INDEX_CACHE_MAX = 24;
const failedLoads = new Set<string>();

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

/** True if this cell's blob was already found missing/corrupt. */
export function isIndexFailed(cellId: string): boolean {
    return failedLoads.has(cellId);
}

/** Record that a cell's blob failed to load (missing/corrupt). */
export function markIndexFailed(cellId: string): void {
    failedLoads.add(cellId);
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
