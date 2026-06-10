/**
 * Tests for VoyageSummaryCache — the local-first summary store that lets the
 * Log list paint instantly from the phone before the network refresh.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// Stateful in-memory Preferences mock (the global setup mock is read-only).
const store = new Map<string, string>();
vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: vi.fn(async ({ key }: { key: string }) => ({ value: store.get(key) ?? null })),
        set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            store.set(key, value);
        }),
        remove: vi.fn(async ({ key }: { key: string }) => {
            store.delete(key);
        }),
    },
}));

import { getCachedSummaries, setCachedSummaries } from '../services/shiplog/VoyageSummaryCache';
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

describe('VoyageSummaryCache', () => {
    beforeEach(() => store.clear());

    it('round-trips summaries for a user', async () => {
        await setCachedSummaries('user-1', [summary('a'), summary('b')]);
        const out = await getCachedSummaries('user-1');
        expect(out?.map((s) => s.voyageId)).toEqual(['a', 'b']);
    });

    it('keys per-user — one account never sees another’s cache', async () => {
        await setCachedSummaries('user-1', [summary('a')]);
        await setCachedSummaries('user-2', [summary('z')]);
        expect((await getCachedSummaries('user-1'))?.map((s) => s.voyageId)).toEqual(['a']);
        expect((await getCachedSummaries('user-2'))?.map((s) => s.voyageId)).toEqual(['z']);
    });

    it('returns null for an unknown user / empty cache', async () => {
        expect(await getCachedSummaries('nobody')).toBeNull();
    });

    it('returns null for a null/undefined userId (signed out)', async () => {
        expect(await getCachedSummaries(null)).toBeNull();
        expect(await getCachedSummaries(undefined)).toBeNull();
    });

    it('no-ops a write with no userId', async () => {
        await setCachedSummaries(null, [summary('a')]);
        expect(store.size).toBe(0);
    });

    it('last write wins', async () => {
        await setCachedSummaries('user-1', [summary('a')]);
        await setCachedSummaries('user-1', [summary('b'), summary('c')]);
        expect((await getCachedSummaries('user-1'))?.map((s) => s.voyageId)).toEqual(['b', 'c']);
    });
});
