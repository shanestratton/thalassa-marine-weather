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
    usesNativeEncryptedLargeStorage: () => false,
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

import {
    clearCachedVoyageTrack,
    getCachedVoyageTrack,
    setCachedVoyageTrack,
} from '../services/shiplog/VoyageTrackCache';
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
    it('preserves a full cached passage when stop supplies only two tail points', async () => {
        const fullTrack = [...track('departure'), ...track('arrival')];
        await setCachedVoyageTrack('same-voyage', fullTrack);
        const tail = track('tail');
        const firstTailPoint = tail[0];
        const readTailPoint = vi.fn(() => firstTailPoint);
        Object.defineProperty(tail, 0, { get: readTailPoint });

        await setCachedVoyageTrack('same-voyage', tail, getAuthIdentityScope(), { preserveExisting: true });

        expect(readTailPoint).not.toHaveBeenCalled();
        await expect(getCachedVoyageTrack('same-voyage')).resolves.toEqual(fullTrack);
    });

    it('still stores a partial stop snapshot when no cached history exists', async () => {
        const tail = track('tail');

        await setCachedVoyageTrack('same-voyage', tail, getAuthIdentityScope(), { preserveExisting: true });

        await expect(getCachedVoyageTrack('same-voyage')).resolves.toEqual(tail);
    });

    it('lets a complete fetch replace a larger cache without resurrecting deleted entries', async () => {
        const retained = track('retained');
        await setCachedVoyageTrack('same-voyage', [...track('deleted'), ...retained]);

        await setCachedVoyageTrack('same-voyage', retained);

        await expect(getCachedVoyageTrack('same-voyage')).resolves.toEqual(retained);
    });

    it('serializes an explicit clear after an in-flight partial snapshot without resurrecting it', async () => {
        const gate = deferredGate();
        mocks.delayedLoad = gate;
        const writing = setCachedVoyageTrack('same-voyage', track('tail'), getAuthIdentityScope(), {
            preserveExisting: true,
        });
        await gate.started;
        const clearing = clearCachedVoyageTrack('same-voyage');
        gate.doRelease();
        await Promise.all([writing, clearing]);
        mocks.delayedLoad = null;

        await expect(getCachedVoyageTrack('same-voyage')).resolves.toBeNull();
        expect(mocks.files.size).toBe(0);
    });

    it('abandons a partial snapshot when identity changes during the existing-cache check', async () => {
        const gate = deferredGate();
        mocks.delayedLoad = gate;
        const writing = setCachedVoyageTrack('same-voyage', track('a'), getAuthIdentityScope(), {
            preserveExisting: true,
        });
        await gate.started;
        setAuthIdentityScope('cache-b');
        gate.doRelease();
        await writing;
        mocks.delayedLoad = null;

        expect(mocks.files.size).toBe(0);
        expect(mocks.prefs.size).toBe(0);
        await setCachedVoyageTrack('same-voyage', track('b'), getAuthIdentityScope(), { preserveExisting: true });
        await expect(getCachedVoyageTrack('same-voyage')).resolves.toEqual(track('b'));
        setAuthIdentityScope('cache-a');
        await expect(getCachedVoyageTrack('same-voyage')).resolves.toBeNull();
    });

    it('stops inspecting an oversized track and preserves its existing cache', async () => {
        await setCachedVoyageTrack('same-voyage', track('existing'));
        const oversized = track('oversized');
        oversized[0].notes = 'x'.repeat(4_000_001);
        const nextEntry = oversized[1];
        const readNextEntry = vi.fn(() => nextEntry);
        Object.defineProperty(oversized, 1, { get: readNextEntry });

        await setCachedVoyageTrack('same-voyage', oversized);

        expect(readNextEntry).not.toHaveBeenCalled();
        await expect(getCachedVoyageTrack('same-voyage')).resolves.toEqual(track('existing'));
    });

    it('yields before preparing a large cache and abandons it if the account changes', async () => {
        const entries = Array.from({ length: 10_000 }, () => track('large')[0]);
        const readFirstEntry = vi.fn(() => track('large')[0]);
        Object.defineProperty(entries, 0, { get: readFirstEntry });

        const writing = setCachedVoyageTrack('same-voyage', entries);
        // Let the account lock enter its callback, but not its first timer.
        await Promise.resolve();
        expect(readFirstEntry).not.toHaveBeenCalled();
        setAuthIdentityScope('cache-b');
        await writing;

        expect(readFirstEntry).not.toHaveBeenCalled();
        expect(mocks.files.size).toBe(0);
        expect(mocks.prefs.size).toBe(0);
    });

    it('stops once the accumulated cache budget is exceeded without reading the remaining rows', async () => {
        const entries = Array.from({ length: 3 }, () => ({ ...track('large')[0], notes: 'x'.repeat(2_000_000) }));
        const thirdEntry = entries[2];
        const readThirdEntry = vi.fn(() => thirdEntry);
        Object.defineProperty(entries, 2, { get: readThirdEntry });

        await setCachedVoyageTrack('same-voyage', entries);

        expect(readThirdEntry).not.toHaveBeenCalled();
        expect(mocks.files.size).toBe(0);
        expect(mocks.prefs.size).toBe(0);
    });

    it('rechecks account ownership after yielding between cache preparation batches', async () => {
        const entries = Array.from({ length: 300 }, () => track('large')[0]);
        const firstBatchEnd = entries[127];
        Object.defineProperty(entries, 127, {
            get: () => {
                setTimeout(() => setAuthIdentityScope('cache-b'), 0);
                return firstBatchEnd;
            },
        });
        const nextEntry = entries[128];
        const readNextBatch = vi.fn(() => nextEntry);
        Object.defineProperty(entries, 128, { get: readNextBatch });

        await setCachedVoyageTrack('same-voyage', entries);

        expect(readNextBatch).not.toHaveBeenCalled();
        expect(mocks.files.size).toBe(0);
        expect(mocks.prefs.size).toBe(0);
    });

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
