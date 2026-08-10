/**
 * mergedDataCache — the merged-vector memo + single-flight guard, lifted out
 * of the EncHazardService god-module. Locks in the 2-slot eviction, the
 * live-object contract the worker upgrade relies on, and the inflight dedup.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
    getMergedData,
    putMergedData,
    clearMergedData,
    getInflightMerge,
    setInflightMerge,
    deleteInflightMerge,
    mergedDataCacheSize,
    mergedPinnedBytes,
} from '../../services/enc/mergedDataCache';
import { createEmptyMergedVectorData } from '../../services/enc/EncHazardService';

const MB = 1024 * 1024;

describe('mergedDataCache', () => {
    beforeEach(() => clearMergedData());

    it('stores + returns a merge; misses are undefined', () => {
        putMergedData('a', createEmptyMergedVectorData());
        expect(getMergedData('a')).toBeDefined();
        expect(getMergedData('missing')).toBeUndefined();
    });

    it('returns the LIVE object — the worker upgrade mutates it in place', () => {
        putMergedData('a', createEmptyMergedVectorData());
        getMergedData('a')!.cellCount = 7;
        expect(getMergedData('a')!.cellCount).toBe(7);
    });

    it('holds 4 slots (zoom-bucket excursions, closing audit), evicting the oldest', () => {
        for (const k of ['a', 'b', 'c', 'd', 'e']) putMergedData(k, createEmptyMergedVectorData());
        expect(mergedDataCacheSize()).toBe(4);
        expect(getMergedData('a')).toBeUndefined(); // oldest evicted
        expect(getMergedData('e')).toBeDefined();
    });

    it('single-flight: set/get/delete an inflight build promise', async () => {
        const p = Promise.resolve(null);
        setInflightMerge('k', p);
        expect(getInflightMerge('k')).toBe(p);
        deleteInflightMerge('k');
        expect(getInflightMerge('k')).toBeUndefined();
    });
});

/**
 * The pinned-byte budget — added 2026-08-10, the round every other bound
 * survived. Overlap eviction keeps any merge sharing ≥1 cell with the
 * newest, and adjacent coastal windows ALWAYS share a boundary cell — so a
 * plotting run chains partial overlaps into "4 merges pinning 25 cells"
 * (~150 MB parsed, held by reference, invisible to every other budget).
 * The union of pinned text bytes is the number that predicts the kill, and
 * these tests pin the budget on it.
 */
describe('pinned-byte budget', () => {
    beforeEach(() => clearMergedData());

    const cellsOf = (ids: string[], eachMB: number) => ids.map((id) => ({ id, sizeBytes: eachMB * MB }));

    it('counts shared cells once', () => {
        putMergedData('a', createEmptyMergedVectorData(), cellsOf(['C1', 'C2'], 10));
        putMergedData('b', createEmptyMergedVectorData(), cellsOf(['C2', 'C3'], 10));
        // Union C1,C2,C3 at 10 MB each — NOT 40.
        expect(mergedPinnedBytes()).toBe(30 * MB);
    });

    it('evicts oldest chained-overlap merges once the union passes the budget', () => {
        // The 2026-08-10 shape: windows marching up the coast, each sharing
        // exactly one boundary cell with its neighbour — every one survives
        // the overlap test while pinning mostly NEW water.
        putMergedData('w1', createEmptyMergedVectorData(), cellsOf(['A', 'B', 'C'], 8));
        putMergedData('w2', createEmptyMergedVectorData(), cellsOf(['C', 'D', 'E'], 8));
        putMergedData('w3', createEmptyMergedVectorData(), cellsOf(['E', 'F', 'G'], 8));
        // Union so far: A-G = 56 MB > 48 — w1 must already be gone.
        expect(getMergedData('w1')).toBeUndefined();
        expect(getMergedData('w3')).toBeDefined();
        expect(mergedPinnedBytes()).toBeLessThanOrEqual(48 * MB);
    });

    it('never evicts the merge that just landed, even a huge one', () => {
        putMergedData('big', createEmptyMergedVectorData(), cellsOf(['X1', 'X2'], 30));
        expect(getMergedData('big')).toBeDefined();
    });

    it('a true zoom excursion (same cells) stays nearly free and is kept', () => {
        putMergedData('z11', createEmptyMergedVectorData(), cellsOf(['A', 'B'], 12));
        putMergedData('z13', createEmptyMergedVectorData(), cellsOf(['A', 'B'], 12));
        expect(getMergedData('z11')).toBeDefined();
        expect(getMergedData('z13')).toBeDefined();
        expect(mergedPinnedBytes()).toBe(24 * MB);
    });

    it('merges stored without sizes weigh zero — no worse than the pre-budget world', () => {
        putMergedData('legacy', createEmptyMergedVectorData(), [{ id: 'L1' }, { id: 'L2' }]);
        expect(mergedPinnedBytes()).toBe(0);
        expect(getMergedData('legacy')).toBeDefined();
    });
});
