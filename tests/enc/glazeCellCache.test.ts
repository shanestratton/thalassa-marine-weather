/**
 * glazeCellCache — the per-cell satellite-glaze LRU, lifted out of the
 * EncHazardService god-module. Locks in eviction, refresh, and the
 * mutate-in-place `upgraded` contract the merge relies on.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import {
    getGlazeCell,
    putGlazeCell,
    clearGlazeCell,
    glazeCellCacheSize,
    type GlazeCellEntry,
} from '../../services/enc/glazeCellCache';

const entry = (upgraded = false): GlazeCellEntry => ({ upgraded, feats: [] });

describe('glazeCellCache', () => {
    beforeEach(() => clearGlazeCell());

    it('stores and returns entries by key', () => {
        putGlazeCell('a', entry());
        expect(getGlazeCell('a')).toBeDefined();
        expect(getGlazeCell('missing')).toBeUndefined();
    });

    it('returns the LIVE object — mutating .upgraded updates the cache', () => {
        putGlazeCell('a', entry(false));
        getGlazeCell('a')!.upgraded = true; // the merge does exactly this
        expect(getGlazeCell('a')!.upgraded).toBe(true);
    });

    it('evicts the OLDEST beyond 32 entries', () => {
        for (let i = 0; i < 33; i++) putGlazeCell(`k${i}`, entry());
        expect(glazeCellCacheSize()).toBe(32);
        expect(getGlazeCell('k0')).toBeUndefined(); // oldest evicted
        expect(getGlazeCell('k32')).toBeDefined(); // newest kept
    });

    it('re-putting a key refreshes it to newest', () => {
        for (let i = 0; i < 32; i++) putGlazeCell(`k${i}`, entry());
        putGlazeCell('k0', entry(true)); // refresh k0 → newest
        putGlazeCell('k32', entry()); // pushes to 33 → evict oldest (k1, not k0)
        expect(getGlazeCell('k0')?.upgraded).toBe(true); // survived
        expect(getGlazeCell('k1')).toBeUndefined();
    });
});
