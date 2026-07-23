/**
 * Tests for VoyageSummaryCache — the local-first summary store that lets the
 * Log list paint instantly from the phone before the network refresh.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stateful in-memory Preferences mock (the global setup mock is read-only).
const mocks = vi.hoisted(() => ({
    store: new Map<string, string>(),
    delayedGet: null as null | {
        started: Promise<void>;
        markStarted: () => void;
        release: Promise<void>;
        doRelease: () => void;
    },
    delayedSet: null as null | {
        started: Promise<void>;
        markStarted: () => void;
        release: Promise<void>;
        doRelease: () => void;
    },
}));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: vi.fn(async ({ key }: { key: string }) => {
            const gate = mocks.delayedGet;
            if (gate) {
                gate.markStarted();
                await gate.release;
            }
            return { value: mocks.store.get(key) ?? null };
        }),
        set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            const gate = mocks.delayedSet;
            if (gate) {
                gate.markStarted();
                await gate.release;
            }
            mocks.store.set(key, value);
        }),
        remove: vi.fn(async ({ key }: { key: string }) => {
            mocks.store.delete(key);
        }),
    },
}));

import { getCachedSummaries, setCachedSummaries } from '../services/shiplog/VoyageSummaryCache';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import type { VoyageSummary } from '../services/shiplog/VoyageSummary';

const summary = (voyageId: string): VoyageSummary => ({
    voyageId,
    entryCount: 5,
    startedAt: '2026-02-01T00:00:00.000Z',
    endedAt: '2026-02-01T03:00:00.000Z',
    totalDistanceNM: 18,
    avgSpeedKts: 6,
    hasManual: false,
    isPlannedRoute: false,
    isImported: false,
    firstLat: -27,
    firstLon: 153,
    lastLat: -27.2,
    lastLon: 153.1,
    firstIsOnWater: true,
    landFraction: 0,
});

function deferredGate() {
    let markStarted!: () => void;
    let doRelease!: () => void;
    const started = new Promise<void>((resolve) => {
        markStarted = resolve;
    });
    const release = new Promise<void>((resolve) => {
        doRelease = resolve;
    });
    return { started, markStarted, release, doRelease };
}

describe('VoyageSummaryCache', () => {
    beforeEach(() => {
        mocks.store.clear();
        mocks.delayedGet = null;
        mocks.delayedSet = null;
        setAuthIdentityScope('user-1');
    });

    it('round-trips summaries for a user', async () => {
        await setCachedSummaries([summary('a'), summary('b')]);
        const out = await getCachedSummaries();
        expect(out?.map((s) => s.voyageId)).toEqual(['a', 'b']);
    });

    it('keys per-user — one account never sees another’s cache', async () => {
        await setCachedSummaries([summary('a')]);
        setAuthIdentityScope('user-2');
        await setCachedSummaries([summary('z')]);
        expect((await getCachedSummaries())?.map((s) => s.voyageId)).toEqual(['z']);
        setAuthIdentityScope('user-1');
        expect((await getCachedSummaries())?.map((s) => s.voyageId)).toEqual(['a']);
    });

    it('returns null for an unknown user / empty cache', async () => {
        setAuthIdentityScope('nobody');
        expect(await getCachedSummaries()).toBeNull();
    });

    it('returns null while signed out', async () => {
        setAuthIdentityScope(null);
        expect(await getCachedSummaries()).toBeNull();
    });

    it('no-ops a write while signed out', async () => {
        setAuthIdentityScope(null);
        await setCachedSummaries([summary('a')]);
        expect(mocks.store.size).toBe(0);
    });

    it('last write wins', async () => {
        await setCachedSummaries([summary('a')]);
        await setCachedSummaries([summary('b'), summary('c')]);
        expect((await getCachedSummaries())?.map((s) => s.voyageId)).toEqual(['b', 'c']);
    });

    it('rejects an owner envelope forged at the current account key', async () => {
        await setCachedSummaries([summary('a')]);
        const key = [...mocks.store.keys()][0];
        const parsed = JSON.parse(mocks.store.get(key) ?? '{}') as Record<string, unknown>;
        mocks.store.set(key, JSON.stringify({ ...parsed, ownerKey: 'user:user-2', ownerUserId: 'user-2' }));

        await expect(getCachedSummaries()).resolves.toBeNull();
    });

    it('rejects a captured scope after A→B', async () => {
        const scopeA = getAuthIdentityScope();
        setAuthIdentityScope('user-2');

        await expect(getCachedSummaries(scopeA)).resolves.toBeNull();
        await setCachedSummaries([summary('a')], scopeA);
        expect(mocks.store.size).toBe(0);
    });

    it('drops a deferred A read after switching to B', async () => {
        await setCachedSummaries([summary('a')]);
        const gate = deferredGate();
        mocks.delayedGet = gate;
        const staleRead = getCachedSummaries();
        await gate.started;

        setAuthIdentityScope('user-2');
        gate.doRelease();

        await expect(staleRead).resolves.toBeNull();
    });

    it('keeps a deferred A write out of B’s cache', async () => {
        const gate = deferredGate();
        mocks.delayedSet = gate;
        const staleWrite = setCachedSummaries([summary('a')]);
        await gate.started;

        setAuthIdentityScope('user-2');
        mocks.delayedSet = null;
        await setCachedSummaries([summary('b')]);
        gate.doRelease();
        await staleWrite;

        await expect(getCachedSummaries()).resolves.toEqual([summary('b')]);
        expect(mocks.store.size).toBe(2);
    });
});
