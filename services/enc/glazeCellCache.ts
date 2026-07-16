/**
 * glazeCellCache — a small LRU of per-cell satellite-GLAZE fills, keyed
 * `v{ver}:{cellId}:{sortedShadowIds}`.
 *
 * A cell's glaze depends only on its own DEPARE bands + which finer cells
 * shadow it — both immutable per registry version — so it memoizes cleanly.
 * `upgraded` marks entries the geometry worker has re-clipped against TRUE
 * fine-survey coverage (hole-free); un-upgraded entries hold the instant
 * rectangle clip and are re-queued for upgrade on use. Callers mutate
 * `entry.upgraded` in place on the object this returns (Map holds the same
 * reference), so a get-then-set-upgraded still updates the cache.
 *
 * Extracted from the EncHazardService god-module (mission audit: 16 mutable
 * caches in one namespace) so this concern owns its own state + is unit-tested.
 */
import type { Feature } from 'geojson';

export interface GlazeCellEntry {
    upgraded: boolean;
    feats: Feature[];
}

const cache = new Map<string, GlazeCellEntry>();
const MAX_ENTRIES = 32;

/** The cached glaze entry for a key, or undefined. Returns the live object —
 *  mutating `.upgraded` on it updates the cache in place. */
export function getGlazeCell(key: string): GlazeCellEntry | undefined {
    return cache.get(key);
}

/** Store (or refresh) a cell's glaze entry, evicting the oldest beyond MAX. */
export function putGlazeCell(key: string, entry: GlazeCellEntry): void {
    cache.delete(key);
    cache.set(key, entry);
    while (cache.size > MAX_ENTRIES) {
        const oldest = cache.keys().next().value as string | undefined;
        if (oldest === undefined) break;
        cache.delete(oldest);
    }
}

/** Test/reset hook — drop everything. */
export function clearGlazeCell(): void {
    cache.clear();
}

/** Current entry count (test/stat hook). */
export function glazeCellCacheSize(): number {
    return cache.size;
}
