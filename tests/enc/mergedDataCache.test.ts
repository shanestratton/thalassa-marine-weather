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

    it('holds only 2 slots (windowed + full merge), evicting the oldest', () => {
        putMergedData('a', createEmptyMergedVectorData());
        putMergedData('b', createEmptyMergedVectorData());
        putMergedData('c', createEmptyMergedVectorData());
        expect(mergedDataCacheSize()).toBe(2);
        expect(getMergedData('a')).toBeUndefined(); // oldest evicted
        expect(getMergedData('c')).toBeDefined();
    });

    it('single-flight: set/get/delete an inflight build promise', async () => {
        const p = Promise.resolve(null);
        setInflightMerge('k', p);
        expect(getInflightMerge('k')).toBe(p);
        deleteInflightMerge('k');
        expect(getInflightMerge('k')).toBeUndefined();
    });
});
