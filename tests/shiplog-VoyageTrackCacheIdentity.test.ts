import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    prefs: new Map<string, string>(),
    files: new Map<string, unknown>(),
    delayedLoad: null as null | {
        started: Promise<void>;
        markStarted: () => void;
        release: Promise<void>;
        doRelease: () => void;
    },
    delayedSave: null as null | {
        started: Promise<void>;
        markStarted: () => void;
        release: Promise<void>;
        doRelease: () => void;
    },
}));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: async ({ key }: { key: string }) => ({ value: mocks.prefs.get(key) ?? null }),
        set: async ({ key, value }: { key: string; value: string }) => {
            mocks.prefs.set(key, value);
        },
    },
}));

vi.mock('../services/nativeStorage', () => ({
    saveLargeData: async (key: string, value: unknown) => {
        const gate = mocks.delayedSave;
        if (gate) {
            gate.markStarted();
            await gate.release;
        }
        mocks.files.set(key, structuredClone(value));
    },
    loadLargeData: async (key: string) => {
        const gate = mocks.delayedLoad;
        if (gate) {
            gate.markStarted();
            await gate.release;
        }
        return structuredClone(mocks.files.get(key) ?? null);
    },
    deleteLargeData: async (key: string) => {
        mocks.files.delete(key);
    },
}));

import { getCachedVoyageTrack, setCachedVoyageTrack } from '../services/shiplog/VoyageTrackCache';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import type { ShipLogEntry } from '../types';

function track(owner: string, voyageId = 'same-voyage'): ShipLogEntry[] {
    return [0, 1].map(
        (index) =>
            ({
                id: `${owner}-${index}`,
                voyageId,
                timestamp: `2026-07-23T00:00:0${index}.000Z`,
                latitude: index,
                longitude: index,
                entryType: 'auto',
            }) as ShipLogEntry,
    );
}

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

beforeEach(() => {
    mocks.prefs.clear();
    mocks.files.clear();
    mocks.delayedLoad = null;
    mocks.delayedSave = null;
    setAuthIdentityScope('cache-a');
});

describe('VoyageTrackCache account isolation', () => {
    it('namespaces identical voyage ids across A→B→A', async () => {
        await setCachedVoyageTrack('same-voyage', track('a'));

        setAuthIdentityScope('cache-b');
        await expect(getCachedVoyageTrack('same-voyage')).resolves.toBeNull();
        await setCachedVoyageTrack('same-voyage', track('b'));
        await expect(getCachedVoyageTrack('same-voyage')).resolves.toEqual(track('b'));

        setAuthIdentityScope('cache-a');
        await expect(getCachedVoyageTrack('same-voyage')).resolves.toEqual(track('a'));
        expect(mocks.files.size).toBe(2);
    });

    it('fails closed on unattributed global v1/v2 cache metadata', async () => {
        mocks.prefs.set(
            'thalassa_voyage_track_cache_v1',
            JSON.stringify({ voyageId: 'same-voyage', entries: track('legacy') }),
        );
        mocks.prefs.set(
            'thalassa_voyage_track_index_v2',
            JSON.stringify([{ voyageId: 'same-voyage', at: 1, points: 2 }]),
        );
        // Even a forged v3 index at the scoped key is rejected unless its
        // owner envelope matches.
        mocks.prefs.set(
            authScopedStorageKey('thalassa_voyage_track_index_v3'),
            JSON.stringify({
                version: 3,
                ownerKey: 'user:somebody-else',
                ownerUserId: 'somebody-else',
                rows: [{ voyageId: 'same-voyage', at: 1, points: 2 }],
            }),
        );

        await expect(getCachedVoyageTrack('same-voyage')).resolves.toBeNull();
        expect(mocks.files.size).toBe(0);
    });

    it('drops a deferred A read result after switching to B', async () => {
        await setCachedVoyageTrack('same-voyage', track('a'));
        const gate = deferredGate();
        mocks.delayedLoad = gate;

        const staleRead = getCachedVoyageTrack('same-voyage');
        await gate.started;
        setAuthIdentityScope('cache-b');
        gate.doRelease();

        await expect(staleRead).resolves.toBeNull();
        mocks.delayedLoad = null;
        await expect(getCachedVoyageTrack('same-voyage')).resolves.toBeNull();
    });

    it('cannot let a deferred A write overwrite B cache files or index', async () => {
        const scopeA = getAuthIdentityScope();
        const gate = deferredGate();
        mocks.delayedSave = gate;
        const staleWrite = setCachedVoyageTrack('same-voyage', track('a'));
        await gate.started;

        setAuthIdentityScope('cache-b');
        mocks.delayedSave = null;
        await setCachedVoyageTrack('same-voyage', track('b'));
        gate.doRelease();
        await staleWrite;

        await expect(getCachedVoyageTrack('same-voyage')).resolves.toEqual(track('b'));
        setAuthIdentityScope('cache-a');
        // The native bridge may finish A's already-issued file write, but the
        // stale generation cannot touch its index or any B artifact. A's next
        // legitimate read repairs its own orphaned index row.
        await expect(getCachedVoyageTrack('same-voyage')).resolves.toEqual(track('a'));
        expect(mocks.files.size).toBe(2);
        const repaired = JSON.parse(
            mocks.prefs.get(authScopedStorageKey('thalassa_voyage_track_index_v3', scopeA)) ?? '{}',
        ) as { ownerUserId?: string; rows?: unknown[] };
        expect(repaired).toMatchObject({ ownerUserId: 'cache-a' });
        expect(repaired.rows).toHaveLength(1);
    });
});
