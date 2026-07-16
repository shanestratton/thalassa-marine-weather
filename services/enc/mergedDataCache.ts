/**
 * mergedDataCache — the merged-vector-data memo + the single-flight guard.
 *
 * The merge output depends only on the SELECTED CELL SET + registry version +
 * densify/glaze flags + sounding-LOD bucket (never the raw window), so it
 * memoizes cleanly by that key. TWO slots — the windowed render merge and the
 * seaway-debug full merge stop evicting each other. `inflight` dedups
 * concurrent builds of the same key into one promise.
 *
 * NOTE: the geometry worker mutates a cached merge IN PLACE (swapping in the
 * hole-free glaze / derived contours), relying on getMergedData returning the
 * live object — the Map holds the same reference, so that still works.
 *
 * Extracted from the EncHazardService god-module (mission audit: 16 mutable
 * caches in one namespace). The EncMergedVectorData import is type-only
 * (erased at runtime) so there is no import cycle.
 */
import type { EncMergedVectorData } from './EncHazardService';

const cache = new Map<string, EncMergedVectorData>();
const MAX_ENTRIES = 2;
const inflight = new Map<string, Promise<EncMergedVectorData | null>>();

/** The cached merge for a key, or undefined. Returns the LIVE object — the
 *  worker upgrade mutates it in place. */
export function getMergedData(key: string): EncMergedVectorData | undefined {
    return cache.get(key);
}

/** Store a merge, evicting the oldest beyond the (small) MAX_ENTRIES. */
export function putMergedData(key: string, merged: EncMergedVectorData): void {
    cache.set(key, merged);
    while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}

/** Drop every cached merge (registry version change / reset). */
export function clearMergedData(): void {
    cache.clear();
}

/** The in-flight build promise for a key, or undefined (single-flight). */
export function getInflightMerge(key: string): Promise<EncMergedVectorData | null> | undefined {
    return inflight.get(key);
}

export function setInflightMerge(key: string, build: Promise<EncMergedVectorData | null>): void {
    inflight.set(key, build);
}

export function deleteInflightMerge(key: string): void {
    inflight.delete(key);
}

/** Current cached-merge count (test/stat hook). */
export function mergedDataCacheSize(): number {
    return cache.size;
}
