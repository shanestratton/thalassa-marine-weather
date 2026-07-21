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
// 2 → 4 (closing audit): keys are zoom-BUCKETED, so a z11↔z13 excursion
// holds three distinct keys for the same water — 2 slots evicted merges
// that were about to be re-requested. 4 holds a realistic excursion;
// entries are feature-collection references, not copies.
const MAX_ENTRIES = 4;

/**
 * Cell ids each cached merge holds geometry for.
 *
 * "References, not copies" is exactly the problem: mergeFold pushes feature
 * geometry BY REFERENCE, so a cached merge PINS its source cells' parsed
 * GeoJSON. That retention is invisible to EncCellStore's byte budget, which
 * only counts cells still in its own LRU.
 *
 * Device measurement (Shane, 2026-07-22, Moreton Bay): ONE 14-cell viewport
 * merge pinned 43.8 MB of cell text — the blob LRU's whole 48 MB cap, at ~3×
 * that once parsed. Four such merges over DISJOINT cell sets, which is
 * precisely what a long pan up the coast produces, pin ~175 MB of text and
 * roughly half a gigabyte of heap. That is the ceiling the WebView dies at.
 *
 * The count cap alone can't tell the two cases apart: a zoom excursion over
 * the SAME water holds 4 keys that share nearly all their cells (pinning is
 * shared, so it is almost free — the case MAX_ENTRIES=4 was raised for),
 * while panning holds 4 keys with nothing in common. So evict on OVERLAP
 * rather than on age: a merge that shares no cell with the newest one is
 * geometry we have panned away from and will not come back to soon.
 */
const cellSets = new Map<string, ReadonlySet<string>>();
const inflight = new Map<string, Promise<EncMergedVectorData | null>>();

/** The cached merge for a key, or undefined. Returns the LIVE object — the
 *  worker upgrade mutates it in place. */
export function getMergedData(key: string): EncMergedVectorData | undefined {
    return cache.get(key);
}

/**
 * Which cached merges to keep once `key` lands. Pure so the eviction policy
 * is testable without a map.
 *
 * Order: newest first. Entries sharing at least one cell with the newest are
 * candidates to keep (a zoom excursion over the same water); entries sharing
 * NOTHING are dropped outright, however recent — that is geometry we have
 * panned away from, and it is what pins half a gigabyte on a long coastal
 * pan. The MAX_ENTRIES cap still applies to whatever survives.
 */
export function planMergeEviction(
    orderedKeys: readonly string[],
    cellsOf: (key: string) => ReadonlySet<string> | undefined,
    newestKey: string,
    maxEntries = MAX_ENTRIES,
): string[] {
    const newest = cellsOf(newestKey);
    const keep: string[] = [newestKey];
    // Walk newest-to-oldest so the cap keeps the most recent overlappers.
    for (let i = orderedKeys.length - 1; i >= 0; i--) {
        const k = orderedKeys[i];
        if (k === newestKey || keep.length >= maxEntries) continue;
        const set = cellsOf(k);
        // Unknown cell set on either side → we cannot tell a pan from a zoom
        // excursion, so degrade to the previous age-based behaviour and keep
        // it (subject to the cap). Callers that pass cellIds opt in to the
        // tighter policy; a caller that doesn't is no worse off than before.
        if (!set || !newest) {
            keep.push(k);
            continue;
        }
        let overlaps = false;
        for (const id of set) {
            if (newest.has(id)) {
                overlaps = true;
                break;
            }
        }
        if (overlaps) keep.push(k);
    }
    return orderedKeys.filter((k) => !keep.includes(k));
}

/**
 * Store a merge. `cellIds` are the cells whose geometry this merge PINS —
 * see the cellSets note above; without them eviction cannot tell a cheap
 * zoom excursion from an expensive pan.
 */
export function putMergedData(key: string, merged: EncMergedVectorData, cellIds?: readonly string[]): void {
    cache.set(key, merged);
    if (cellIds) cellSets.set(key, new Set(cellIds));

    for (const dead of planMergeEviction([...cache.keys()], (k) => cellSets.get(k), key)) {
        cache.delete(dead);
        cellSets.delete(dead);
    }
}

/** Drop every cached merge (registry version change / reset). */
export function clearMergedData(): void {
    cache.clear();
    cellSets.clear();
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
