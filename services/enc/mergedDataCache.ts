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
/** Text bytes per cell id, recorded as merges land. Sizes are stable per
 *  registry version, so last-write-wins is fine. */
const cellBytes = new Map<string, number>();
const inflight = new Map<string, Promise<EncMergedVectorData | null>>();

/**
 * The most TEXT BYTES the cached merges may pin between them (union over
 * their cell sets — shared cells count once).
 *
 * Added 2026-08-10, the round that outlived every other bound: with merges
 * capped at 32 MB, serialized one-at-a-time, and grids byte-budgeted, the
 * renderer still died at a routine merge-start with the census reading
 * "4 merges pinning 25 cells". The overlap eviction below keeps any merge
 * sharing ≥1 cell with the newest — and adjacent coastal windows ALWAYS
 * share a boundary cell, so a plotting run chains partial overlaps straight
 * past the policy: each survivor pins ~13 NEW cells. 25 pinned cells is
 * ~50 MB of text, roughly 150 MB parsed, held by reference and invisible
 * to every other budget. 48 MB (the blob LRU's own cap) keeps the newest
 * merge plus a genuinely-overlapping neighbour and nothing more.
 */
const MAX_PINNED_TEXT_BYTES = 48 * 1024 * 1024;

/** Union text bytes pinned by the cached merges (shared cells count once). */
export function mergedPinnedBytes(): number {
    const union = new Set<string>();
    for (const cells of cellSets.values()) for (const id of cells) union.add(id);
    let total = 0;
    for (const id of union) total += cellBytes.get(id) ?? 0;
    return total;
}

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
 * Store a merge. `cells` are the cells whose geometry this merge PINS —
 * see the cellSets note above; without them eviction cannot tell a cheap
 * zoom excursion from an expensive pan. `sizeBytes` (text bytes per cell,
 * where known) feeds the pinned-byte budget; a merge stored without sizes
 * weighs zero, which only ever under-evicts back to the pre-budget world.
 */
export function putMergedData(
    key: string,
    merged: EncMergedVectorData,
    cells?: readonly { id: string; sizeBytes?: number }[],
): void {
    cache.set(key, merged);
    if (cells) {
        cellSets.set(key, new Set(cells.map((c) => c.id)));
        for (const c of cells) if (c.sizeBytes != null) cellBytes.set(c.id, c.sizeBytes);
    }

    for (const dead of planMergeEviction([...cache.keys()], (k) => cellSets.get(k), key)) {
        cache.delete(dead);
        cellSets.delete(dead);
    }

    // Byte budget on whatever the overlap policy kept: chained partial
    // overlaps let a plotting run keep 4 merges over mostly-different water
    // (the 2026-08-10 census: 25 distinct pinned cells). Drop the OLDEST
    // surviving merges — never the one that just landed — until the union
    // of pinned text fits the budget.
    while (cache.size > 1 && mergedPinnedBytes() > MAX_PINNED_TEXT_BYTES) {
        const oldest = cache.keys().next().value;
        if (oldest === undefined || oldest === key) break;
        cache.delete(oldest);
        cellSets.delete(oldest);
    }
}

/** Drop every cached merge (registry version change / reset). */
export function clearMergedData(): void {
    cache.clear();
    cellSets.clear();
    // Sizes are only stable within a registry version, and this is called on
    // the version change.
    cellBytes.clear();
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

/**
 * How many DISTINCT cells the cached merges are pinning between them.
 *
 * This is the number that actually predicts a WebContent kill, and it is not
 * visible anywhere else: EncCellStore's byte budget counts only cells still in
 * its own LRU, while these merges hold parsed geometry BY REFERENCE and keep
 * it alive after eviction. Four merges sharing one viewport pin ~14 cells;
 * four over disjoint water pin ~56, which is the half-gigabyte case measured
 * on 2026-07-22.
 *
 * Cheap: a union of at most MAX_ENTRIES small sets, called a few times a
 * minute by the census.
 */
export function mergedPinnedCellCount(): number {
    const union = new Set<string>();
    for (const cells of cellSets.values()) for (const id of cells) union.add(id);
    return union.size;
}
