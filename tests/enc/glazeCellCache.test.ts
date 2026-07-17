/**
 * glazeCellCache — the per-cell satellite-glaze LRU, lifted out of the
 * EncHazardService god-module. Locks in eviction, refresh, and the
 * mutate-in-place `upgraded` contract the merge relies on.
 */
import { describe, it, expect, beforeEach } from 'vitest';

import type { Feature } from 'geojson';

import {
    ensureGlazeCapacity,
    getGlazeCell,
    putGlazeCell,
    clearGlazeCell,
    glazeCellCacheSize,
    parkGlazeAssembly,
    takeGlazeAssembly,
    isGlazeInFlight,
    releaseGlazeAssemblies,
    clearAllGlazeAssemblies,
    glazeAssemblyCount,
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

describe('ensureGlazeCapacity — the LRU holds a whole merge (closing audit)', () => {
    beforeEach(() => clearGlazeCell());

    it('grows the cap so a large merge cannot evict its own cells mid-fold', () => {
        ensureGlazeCapacity(40); // 40-cell glaze merge declared
        for (let i = 0; i < 48; i++) putGlazeCell(`c${i}`, entry());
        expect(glazeCellCacheSize()).toBe(48); // 40+8 slack — all held
        expect(getGlazeCell('c0')).toBeDefined();
    });

    it('never shrinks below an earlier declaration', () => {
        ensureGlazeCapacity(40);
        ensureGlazeCapacity(5); // smaller later merge must not shrink the cap
        for (let i = 0; i < 48; i++) putGlazeCell(`k${i}`, entry());
        expect(glazeCellCacheSize()).toBe(48);
    });

    it('the FEATURE budget never evicts the ACTIVE merge’s own cells mid-fold (cycle-4 audit #3)', () => {
        const pt = (): Feature => ({
            type: 'Feature',
            properties: {},
            geometry: { type: 'Point', coordinates: [0, 0] },
        });
        const big = (n: number): GlazeCellEntry => ({ upgraded: false, feats: new Array(n).fill(pt()) });
        ensureGlazeCapacity(4); // a 4-cell glaze merge declares itself
        // 3 cells × 50k = 150k features — over the 120k budget — but every key
        // belongs to the active fold, so none may be dropped before dispatch.
        putGlazeCell('m0', big(50_000));
        putGlazeCell('m1', big(50_000));
        putGlazeCell('m2', big(50_000));
        expect(glazeCellCacheSize()).toBe(3);
        expect(getGlazeCell('m0')).toBeDefined(); // the fold's first cell survives
    });

    it('a PRIOR merge’s cells become evictable once a new merge starts', () => {
        const pt = (): Feature => ({
            type: 'Feature',
            properties: {},
            geometry: { type: 'Point', coordinates: [0, 0] },
        });
        const big = (n: number): GlazeCellEntry => ({ upgraded: false, feats: new Array(n).fill(pt()) });
        ensureGlazeCapacity(4);
        putGlazeCell('old0', big(80_000)); // pinned to merge 1
        ensureGlazeCapacity(4); // merge 2 begins → old0 unpinned
        putGlazeCell('new0', big(80_000)); // 160k > 120k → the now-unpinned old0 evicts
        expect(getGlazeCell('old0')).toBeUndefined();
        expect(getGlazeCell('new0')).toBeDefined();
    });
});

describe('worker-assembly parking — job-scoped, owner-checked (audit #5)', () => {
    const feat = (id: string): Feature => ({
        type: 'Feature',
        properties: { id },
        geometry: { type: 'Point', coordinates: [0, 0] },
    });

    beforeEach(() => clearAllGlazeAssemblies());

    it('parks and takes per (job, key) — the round trip returns exactly what parked', () => {
        parkGlazeAssembly(1, 'cellX@1', [feat('a'), feat('b')]);
        expect(isGlazeInFlight('cellX@1')).toBe(true);
        const got = takeGlazeAssembly(1, 'cellX@1');
        expect(got.map((f) => (f.properties as { id: string }).id)).toEqual(['a', 'b']);
        expect(isGlazeInFlight('cellX@1')).toBe(false);
        // Consumed — a second take is empty, never a duplicate.
        expect(takeGlazeAssembly(1, 'cellX@1')).toEqual([]);
    });

    it('OVERLAPPING JOBS on the same key cannot truncate each other (the audit scenario)', () => {
        parkGlazeAssembly(1, 'cellX@1', [feat('a1')]);
        parkGlazeAssembly(2, 'cellX@1', [feat('a2')]);
        // Job 1's answer takes ITS parked majority, not job 2's.
        expect(takeGlazeAssembly(1, 'cellX@1').map((f) => (f.properties as { id: string }).id)).toEqual(['a1']);
        // Job 2's parked entry survives job 1's consumption…
        expect(takeGlazeAssembly(2, 'cellX@1').map((f) => (f.properties as { id: string }).id)).toEqual(['a2']);
    });

    it('release is owner-checked: job B cleanup cannot clear job A in-flight claim', () => {
        parkGlazeAssembly(1, 'cellX@1', [feat('a')]);
        // Job 2 parked the same key later — it now owns the in-flight marker.
        parkGlazeAssembly(2, 'cellX@1', [feat('b')]);
        releaseGlazeAssemblies(1, ['cellX@1']); // job 1 errors out
        // Job 2's claim + parked entry both survive.
        expect(isGlazeInFlight('cellX@1')).toBe(true);
        expect(takeGlazeAssembly(2, 'cellX@1')).toHaveLength(1);
    });

    it('releaseGlazeAssemblies clears only the named job/keys', () => {
        parkGlazeAssembly(1, 'k1', [feat('a')]);
        parkGlazeAssembly(1, 'k2', [feat('b')]);
        parkGlazeAssembly(2, 'k3', [feat('c')]);
        releaseGlazeAssemblies(1, ['k1', 'k2']);
        expect(glazeAssemblyCount()).toBe(1);
        expect(isGlazeInFlight('k1')).toBe(false);
        expect(isGlazeInFlight('k3')).toBe(true);
    });

    it('clearAllGlazeAssemblies (worker death) drops everything', () => {
        parkGlazeAssembly(1, 'k1', [feat('a')]);
        parkGlazeAssembly(2, 'k2', [feat('b')]);
        clearAllGlazeAssemblies();
        expect(glazeAssemblyCount()).toBe(0);
        expect(isGlazeInFlight('k1')).toBe(false);
        expect(isGlazeInFlight('k2')).toBe(false);
    });
});
