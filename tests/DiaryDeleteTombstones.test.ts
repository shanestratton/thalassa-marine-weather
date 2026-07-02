/**
 * Diary delete — offline-first tombstones.
 *
 * Regression suite for the on-water "can't delete a diary entry" defect
 * (2026-07-03): deletes used to hard-require the network, so offline they
 * failed and the entry resurrected. Deletes now commit locally (tombstone +
 * cache scrub) and drain to the server when connectivity returns.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Mutable holder so individual tests can swap between "offline" (null) and a
// mocked client. The getter keeps DiaryService's `supabase` binding live.
const mockSupabase: { current: unknown } = { current: null };
vi.mock('../services/supabase', () => ({
    get supabase() {
        return mockSupabase.current;
    },
}));

import { DiaryService } from '../services/DiaryService';

const CACHE_KEY = 'thalassa_diary_entries_v2';
const PENDING_KEY = 'thalassa_diary_pending_v2';
const DELETED_KEY = 'thalassa_diary_deleted_v1';

const makeEntry = (id: string, overrides: Record<string, unknown> = {}) => ({
    id,
    user_id: 'u1',
    title: `Entry ${id}`,
    body: 'body',
    mood: 'good',
    photos: [],
    audio_url: null,
    latitude: null,
    longitude: null,
    location_name: '',
    weather_summary: '',
    voyage_id: null,
    tags: [],
    is_public: false,
    created_at: '2026-07-03T00:00:00.000Z',
    updated_at: '2026-07-03T00:00:00.000Z',
    ...overrides,
});

const readTombstones = (): { id: string; deletedAt: number }[] => JSON.parse(localStorage.getItem(DELETED_KEY) ?? '[]');

beforeEach(() => {
    localStorage.clear();
    mockSupabase.current = null;
});

describe('deleteEntry — offline commit', () => {
    it('deletes a synced (server-id) entry with no network and it stays gone', async () => {
        localStorage.setItem(CACHE_KEY, JSON.stringify([makeEntry('srv-1'), makeEntry('srv-2')]));

        const ok = await DiaryService.deleteEntry('srv-1');
        expect(ok).toBe(true);

        // Tombstone persisted for the drain
        expect(readTombstones().map((t) => t.id)).toContain('srv-1');

        // Gone from reads immediately, sibling untouched
        const entries = await DiaryService.getEntries(50);
        expect(entries.find((e) => e.id === 'srv-1')).toBeUndefined();
        expect(entries.find((e) => e.id === 'srv-2')).toBeDefined();

        // And getEntry agrees
        expect(await DiaryService.getEntry('srv-1')).toBeNull();
    });

    it('removes an offline- entry from pending and tombstones the offline id', async () => {
        localStorage.setItem(PENDING_KEY, JSON.stringify([makeEntry('offline-abc')]));

        const ok = await DiaryService.deleteEntry('offline-abc');
        expect(ok).toBe(true);

        const pending = JSON.parse(localStorage.getItem(PENDING_KEY) ?? '[]');
        expect(pending).toHaveLength(0);
        // Offline id tombstoned so a mid-flight sync can't resurrect it
        expect(readTombstones().map((t) => t.id)).toContain('offline-abc');
    });

    it('keeps the tombstone filter across a simulated relaunch (fresh reads)', async () => {
        localStorage.setItem(CACHE_KEY, JSON.stringify([makeEntry('srv-9')]));
        await DiaryService.deleteEntry('srv-9');

        // "Relaunch": the cache was scrubbed, but even if a stale copy comes
        // back (e.g. an old server payload), the tombstone must filter it.
        localStorage.setItem(CACHE_KEY, JSON.stringify([makeEntry('srv-9')]));
        const entries = await DiaryService.getEntries(50);
        expect(entries.find((e) => e.id === 'srv-9')).toBeUndefined();
    });
});

describe('tombstone store hygiene', () => {
    it('purges expired tombstones (7-day TTL) and stops filtering them', async () => {
        const expired = { id: 'srv-old', photos: [], deletedAt: Date.now() - 8 * 24 * 60 * 60 * 1000 };
        localStorage.setItem(DELETED_KEY, JSON.stringify([expired]));
        localStorage.setItem(CACHE_KEY, JSON.stringify([makeEntry('srv-old')]));

        const entries = await DiaryService.getEntries(50);
        // Expired tombstone abandoned — entry surfaces again rather than
        // being hidden forever by a delete that never drained.
        expect(entries.find((e) => e.id === 'srv-old')).toBeDefined();
        expect(readTombstones()).toHaveLength(0);
    });

    it('survives corrupted tombstone JSON', async () => {
        localStorage.setItem(DELETED_KEY, '{not json[');
        localStorage.setItem(CACHE_KEY, JSON.stringify([makeEntry('srv-1')]));

        const entries = await DiaryService.getEntries(50);
        expect(entries.find((e) => e.id === 'srv-1')).toBeDefined();
    });

    it('survives structurally-wrong tombstone records', async () => {
        localStorage.setItem(DELETED_KEY, JSON.stringify([{ nope: 1 }, 42, null, { id: 7 }]));
        const entries = await DiaryService.getEntries(50);
        expect(Array.isArray(entries)).toBe(true);
    });
});

describe('drainDeletedTombstones', () => {
    it('pushes committed deletes to the server and clears the tombstones', async () => {
        localStorage.setItem(CACHE_KEY, JSON.stringify([makeEntry('srv-1')]));
        await DiaryService.deleteEntry('srv-1'); // offline commit (supabase null)
        expect(readTombstones().map((t) => t.id)).toContain('srv-1');

        const deletedIds: string[] = [];
        mockSupabase.current = {
            from: () => ({
                select: () => ({
                    eq: () => ({ maybeSingle: async () => ({ data: null }) }),
                }),
                delete: () => ({
                    eq: async (_col: string, id: string) => {
                        deletedIds.push(id);
                        return { error: null };
                    },
                }),
            }),
            auth: { getUser: async () => ({ data: { user: null } }) },
        };

        await DiaryService.drainDeletedTombstones();

        expect(deletedIds).toContain('srv-1');
        expect(readTombstones().map((t) => t.id)).not.toContain('srv-1');
    });

    it('keeps the tombstone when the server delete fails, for the next drain', async () => {
        localStorage.setItem(CACHE_KEY, JSON.stringify([makeEntry('srv-2')]));
        await DiaryService.deleteEntry('srv-2');

        mockSupabase.current = {
            from: () => ({
                select: () => ({
                    eq: () => ({ maybeSingle: async () => ({ data: null }) }),
                }),
                delete: () => ({
                    eq: async () => ({ error: { message: 'network sadness' } }),
                }),
            }),
            auth: { getUser: async () => ({ data: { user: null } }) },
        };

        await DiaryService.drainDeletedTombstones();
        expect(readTombstones().map((t) => t.id)).toContain('srv-2');
    });

    it('skips offline- tombstones (they never reached the server)', async () => {
        localStorage.setItem(PENDING_KEY, JSON.stringify([makeEntry('offline-x')]));
        await DiaryService.deleteEntry('offline-x');

        const deletedIds: string[] = [];
        mockSupabase.current = {
            from: () => ({
                select: () => ({
                    eq: () => ({ maybeSingle: async () => ({ data: null }) }),
                }),
                delete: () => ({
                    eq: async (_col: string, id: string) => {
                        deletedIds.push(id);
                        return { error: null };
                    },
                }),
            }),
            auth: { getUser: async () => ({ data: { user: null } }) },
        };

        await DiaryService.drainDeletedTombstones();
        expect(deletedIds).toHaveLength(0);
        // Still there — expires via TTL, not via drain
        expect(readTombstones().map((t) => t.id)).toContain('offline-x');
    });
});

// ── Adversarial-review fixes (2026-07-03) ──────────────────────

const IDMAP_KEY = 'thalassa_diary_idmap_v1';

describe('stale offline-id deletes (id-map)', () => {
    it('kills the server twin when the offline id outlived the 120s sync buffer', async () => {
        // syncPending recorded the mapping at sync time; buffer long gone.
        localStorage.setItem(IDMAP_KEY, JSON.stringify([['offline-stale', 'srv-mapped']]));
        localStorage.setItem(CACHE_KEY, JSON.stringify([makeEntry('srv-mapped')]));

        const ok = await DiaryService.deleteEntry('offline-stale');
        expect(ok).toBe(true);

        // The SERVER id is tombstoned (drainable), not just the offline one
        expect(readTombstones().map((t) => t.id)).toContain('srv-mapped');
        const entries = await DiaryService.getEntries(50);
        expect(entries.find((e) => e.id === 'srv-mapped')).toBeUndefined();
    });

    it('resolveServerId survives corrupted id-map JSON', () => {
        localStorage.setItem(IDMAP_KEY, 'garbage{');
        expect(DiaryService.resolveServerId('offline-x')).toBeNull();
    });
});

describe('drain/refresh race (grace window)', () => {
    it('keeps filtering a drained id even if a stale payload rewrites the cache', async () => {
        localStorage.setItem(CACHE_KEY, JSON.stringify([makeEntry('srv-grace')]));
        await DiaryService.deleteEntry('srv-grace');

        mockSupabase.current = {
            from: () => ({
                select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
                delete: () => ({ eq: async () => ({ error: null }) }),
            }),
            auth: { getUser: async () => ({ data: { user: null } }) },
        };
        await DiaryService.drainDeletedTombstones();
        expect(readTombstones().map((t) => t.id)).not.toContain('srv-grace');

        // Simulate the in-flight pre-delete SELECT landing AFTER the drain
        // removed the tombstone: the stale payload writes the entry back.
        localStorage.setItem(CACHE_KEY, JSON.stringify([makeEntry('srv-grace')]));
        const entries = await DiaryService.getEntries(50);
        expect(entries.find((e) => e.id === 'srv-grace')).toBeUndefined();
        expect(await DiaryService.getEntry('srv-grace')).toBeNull();
    });
});

describe('quota-degraded tombstone writes', () => {
    it('still honours the delete in-session and drains it from memory', async () => {
        localStorage.setItem(CACHE_KEY, JSON.stringify([makeEntry('srv-quota')]));
        const orig = Storage.prototype.setItem;
        const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (
            this: Storage,
            k: string,
            v: string,
        ) {
            if (k === DELETED_KEY) throw new Error('QuotaExceededError');
            return orig.call(this, k, v);
        });
        try {
            const ok = await DiaryService.deleteEntry('srv-quota');
            expect(ok).toBe(true);
            // Nothing persisted…
            expect(readTombstones().map((t) => t.id)).not.toContain('srv-quota');
            // …but the delete still holds for this session
            const entries = await DiaryService.getEntries(50);
            expect(entries.find((e) => e.id === 'srv-quota')).toBeUndefined();
        } finally {
            spy.mockRestore();
        }

        // And the memory tombstone is drainable once the network is back
        const deletedIds: string[] = [];
        mockSupabase.current = {
            from: () => ({
                select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
                delete: () => ({
                    eq: async (_col: string, id: string) => {
                        deletedIds.push(id);
                        return { error: null };
                    },
                }),
            }),
            auth: { getUser: async () => ({ data: { user: null } }) },
        };
        await DiaryService.drainDeletedTombstones();
        expect(deletedIds).toContain('srv-quota');
    });
});

describe('server-side deletion order and storage cleanup', () => {
    const photoUrl = 'https://x.supabase.co/storage/v1/object/public/diary-photos/u1/pic.jpg';
    const audioUrl = 'https://x.supabase.co/storage/v1/object/public/diary-audio/u1/memo.webm';

    it('destroys nothing in storage when the row delete fails', async () => {
        localStorage.setItem(CACHE_KEY, JSON.stringify([makeEntry('srv-order', { photos: [photoUrl] })]));
        await DiaryService.deleteEntry('srv-order');

        const storageCalls: string[] = [];
        mockSupabase.current = {
            from: () => ({
                select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
                delete: () => ({ eq: async () => ({ error: { message: 'rls denied' } }) }),
            }),
            storage: {
                from: (bucket: string) => ({
                    remove: async (paths: string[]) => {
                        storageCalls.push(`${bucket}:${paths.join(',')}`);
                        return { error: null };
                    },
                }),
            },
            auth: { getUser: async () => ({ data: { user: null } }) },
        };
        await DiaryService.drainDeletedTombstones();

        // Row survived ⇒ photos must survive too (no dead-URL resurrection),
        // and the tombstone stays whole for the retry.
        expect(storageCalls).toHaveLength(0);
        expect(readTombstones().map((t) => t.id)).toContain('srv-order');
    });

    it('removes photos AND audio after the row is gone — row strictly first', async () => {
        localStorage.setItem(
            CACHE_KEY,
            JSON.stringify([makeEntry('srv-media', { photos: [photoUrl], audio_url: audioUrl })]),
        );
        await DiaryService.deleteEntry('srv-media');

        const ops: string[] = [];
        mockSupabase.current = {
            from: () => ({
                select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null }) }) }),
                delete: () => ({
                    eq: async (_col: string, id: string) => {
                        ops.push(`row:${id}`);
                        return { error: null };
                    },
                }),
            }),
            storage: {
                from: (bucket: string) => ({
                    remove: async (paths: string[]) => {
                        ops.push(`storage:${bucket}:${paths.join(',')}`);
                        return { error: null };
                    },
                }),
            },
            auth: { getUser: async () => ({ data: { user: null } }) },
        };
        await DiaryService.drainDeletedTombstones();

        expect(ops[0]).toBe('row:srv-media');
        expect(ops).toContain('storage:diary-photos:u1/pic.jpg');
        expect(ops).toContain('storage:diary-audio:u1/memo.webm');
        expect(readTombstones().map((t) => t.id)).not.toContain('srv-media');
    });
});
