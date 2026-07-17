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
} from '../../services/enc/mergedDataCache';
import { createEmptyMergedVectorData } from '../../services/enc/EncHazardService';

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
