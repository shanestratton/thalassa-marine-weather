/**
 * encIndexCache — the per-cell spatial-index LRU + failed-load set, lifted
 * out of the EncHazardService god-module. Locks in LRU touch, eviction, the
 * failed-load flag, and drop/clear.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
    touchIndex,
    cacheIndex,
    isIndexFailed,
    markIndexFailed,
    dropIndex,
    clearIndexCache,
    indexCacheSize,
} from '../../services/enc/encIndexCache';
import { EncSpatialIndex } from '../../services/enc/EncSpatialIndex';

const idx = (id: string) => new EncSpatialIndex(id, []);

describe('encIndexCache', () => {
    beforeEach(() => clearIndexCache());

    it('caches and retrieves an index; misses are undefined', () => {
        cacheIndex('a', idx('a'));
        expect(touchIndex('a')?.getCellId()).toBe('a');
        expect(touchIndex('missing')).toBeUndefined();
    });

    it('evicts the LEAST-recently-used beyond 24 (route-length candidate sets)', () => {
        for (let i = 0; i < 24; i++) cacheIndex(`k${i}`, idx(`k${i}`));
        touchIndex('k0'); // k0 → most-recently-used
        cacheIndex('k24', idx('k24')); // size 25 → evict LRU (k1, not k0)
        expect(indexCacheSize()).toBe(24);
        expect(touchIndex('k0')).toBeDefined(); // survived (was touched)
        expect(touchIndex('k1')).toBeUndefined(); // evicted
    });

    it('tracks + clears the failed-load flag', () => {
        expect(isIndexFailed('x')).toBe(false);
        markIndexFailed('x');
        expect(isIndexFailed('x')).toBe(true);
        dropIndex('x'); // forgets index + failed flag
        expect(isIndexFailed('x')).toBe(false);
    });

    it('dropIndex forgets both the index and the failed flag', () => {
        cacheIndex('a', idx('a'));
        markIndexFailed('a');
        dropIndex('a');
        expect(touchIndex('a')).toBeUndefined();
        expect(isIndexFailed('a')).toBe(false);
    });
});
