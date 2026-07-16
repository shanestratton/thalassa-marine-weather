/**
 * derivedContourCache — a tiny LRU of worker-computed derived depth contours,
 * keyed by the merge's selection cache key.
 *
 * Same key ⇒ identical sounding set ⇒ identical contours, so a re-merge reuses
 * the computed LineStrings synchronously (no flicker, no redundant worker
 * pass). Holds only LineString segments (small), and is capped WELL ABOVE the
 * merged-data cache so it survives the excursion that evicts the merge.
 *
 * Extracted from the EncHazardService god-module (mission audit: 11+ mutable
 * caches in one namespace) so this concern owns its own state + is unit-tested.
 */
import type { Feature } from 'geojson';

const cache = new Map<string, Feature[]>();
const MAX_ENTRIES = 12;

/** The cached derived contours for a selection key, or undefined. Reading does
 *  NOT refresh LRU position — callers that want to keep a hit alive re-put it. */
export function getDerivedContours(key: string): Feature[] | undefined {
    return cache.get(key);
}

/** Store (or refresh) a selection's derived contours, evicting the oldest
 *  beyond MAX_ENTRIES. Re-inserting an existing key moves it to newest. */
export function putDerivedContours(key: string, feats: Feature[]): void {
    cache.delete(key);
    cache.set(key, feats);
    while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}

/** Test/reset hook — drop everything. */
export function clearDerivedContours(): void {
    cache.clear();
}

/** Current entry count (test/stat hook). */
export function derivedContourCacheSize(): number {
    return cache.size;
}
