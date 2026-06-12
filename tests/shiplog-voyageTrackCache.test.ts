/**
 * Tests for VoyageTrackCache v2 pure helpers — id normalisation (cached
 * tracks must survive mergeRecentEntries' offline_* purge), the cache
 * guard, and LRU eviction planning.
 */
import { describe, it, expect } from 'vitest';
import {
    shouldCacheTrack,
    normalizeCacheIds,
    evictionPlan,
    MAX_CACHED_VOYAGES,
} from '../services/shiplog/VoyageTrackCache';
import { mergeRecentEntries } from '../utils/voyageData';
import type { ShipLogEntry } from '../types';

function entry(id: string | undefined, voyageId = 'v1'): ShipLogEntry {
    return {
        id,
        voyageId,
        timestamp: '2026-06-13T00:00:00Z',
        latitude: -27.5,
        longitude: 153.0,
        entryType: 'auto',
    } as ShipLogEntry;
}

describe('shouldCacheTrack', () => {
    it('rejects sub-2-point tracks and oversized payloads', () => {
        expect(shouldCacheTrack(1, 100)).toBe(false);
        expect(shouldCacheTrack(2, 100)).toBe(true);
        expect(shouldCacheTrack(500, 5_000_000)).toBe(false);
    });
});

describe('normalizeCacheIds', () => {
    it('replaces offline_* and missing ids with stable trkc ids, keeps real ids', () => {
        const out = normalizeCacheIds([entry('offline_0'), entry(undefined), entry('db-real-id')], 'vX');
        expect(out[0].id).toBe('trkc_vX_0');
        expect(out[1].id).toBe('trkc_vX_1');
        expect(out[2].id).toBe('db-real-id');
    });

    it('normalised ids survive mergeRecentEntries (the offline_* purge)', () => {
        const cached = normalizeCacheIds([entry('offline_0', 'vX'), entry('offline_1', 'vX')], 'vX');
        // Simulate a later live-poll merge with an unrelated fresh batch —
        // raw offline_* ids would be PURGED here; trkc_* ids must persist.
        const merged = mergeRecentEntries(cached, [entry('offline_5', 'liveVoyage')]);
        expect(merged.filter((e) => e.voyageId === 'vX')).toHaveLength(2);
        // Sanity: un-normalised offline_* ids WOULD be purged.
        const rawMerged = mergeRecentEntries([entry('offline_0', 'vX')], [entry('offline_5', 'liveVoyage')]);
        expect(rawMerged.filter((e) => e.voyageId === 'vX')).toHaveLength(0);
    });
});

describe('evictionPlan', () => {
    const row = (voyageId: string, at: number) => ({ voyageId, at, points: 10 });

    it('evicts nothing while under the cap', () => {
        const index = [row('a', 1), row('b', 2)];
        expect(evictionPlan(index, 'b', 4)).toEqual([]);
    });

    it('evicts the oldest entries first and never the kept voyage', () => {
        const index = [row('oldest', 1), row('old', 2), row('newer', 3), row('keep', 0)];
        // Cap 3 → one over: evict 'oldest' (lowest at, excluding keep).
        expect(evictionPlan(index, 'keep', 3)).toEqual(['oldest']);
        // Cap 2 → two over.
        expect(evictionPlan(index, 'keep', 2)).toEqual(['oldest', 'old']);
    });

    it('default cap matches MAX_CACHED_VOYAGES', () => {
        const index = Array.from({ length: MAX_CACHED_VOYAGES + 2 }, (_, i) => row(`v${i}`, i));
        const evicted = evictionPlan(index, `v${MAX_CACHED_VOYAGES + 1}`);
        expect(evicted).toHaveLength(2);
        expect(evicted).toEqual(['v0', 'v1']);
    });
});
