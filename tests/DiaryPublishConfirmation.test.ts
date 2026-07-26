import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSupabase: { current: ReturnType<typeof createSupabaseMock> | null } = { current: null };

vi.mock('../services/supabase', () => ({
    get supabase() {
        return mockSupabase.current;
    },
}));

import { DiaryService, type DiaryEntry } from '../services/DiaryService';
import { authScopedStorageKey, setAuthIdentityScope, type AuthIdentityScope } from '../services/authIdentityScope';

interface PublishControls {
    userId: string;
    inserts: Record<string, unknown>[];
    updates: Record<string, unknown>[];
    updateResult: { data: { id: string; is_public: boolean } | null; error: { message: string } | null };
}

function createSupabaseMock(controls: PublishControls) {
    return {
        auth: {
            getUser: vi.fn(async () => ({ data: { user: { id: controls.userId } } })),
            getSession: vi.fn(async () => ({ data: { session: { user: { id: controls.userId } } } })),
            refreshSession: vi.fn(async () => ({ data: { session: { user: { id: controls.userId } } } })),
        },
        from: vi.fn(() => {
            const readChain = {
                eq: () => readChain,
                order: () => readChain,
                limit: async () => ({ data: [], error: null }),
                single: async () => ({ data: null, error: null }),
                maybeSingle: async () => ({ data: null, error: null }),
            };
            return {
                insert: (payload: Record<string, unknown>) => {
                    controls.inserts.push(payload);
                    return {
                        select: () => ({
                            single: async () => ({
                                data: {
                                    ...payload,
                                    id: `server-${controls.inserts.length}`,
                                    updated_at: payload.created_at,
                                },
                                error: null,
                            }),
                        }),
                    };
                },
                update: (payload: Record<string, unknown>) => {
                    controls.updates.push(payload);
                    const updateChain = {
                        eq: () => updateChain,
                        select: () => ({
                            maybeSingle: async () => controls.updateResult,
                        }),
                    };
                    return updateChain;
                },
                select: () => readChain,
            };
        }),
        storage: {
            from: vi.fn(() => ({
                upload: vi.fn(async () => ({ error: null })),
                remove: vi.fn(async () => ({ error: null })),
                createSignedUrl: vi.fn(async () => ({
                    data: { signedUrl: 'https://signed.test/object' },
                    error: null,
                })),
            })),
        },
    };
}

function keyFor(base: string, userId: string): string {
    const scope: AuthIdentityScope = { key: `user:${userId}`, userId, generation: 0 };
    return authScopedStorageKey(base, scope);
}

function entry(id: string, userId: string, isPublic = false): DiaryEntry {
    return {
        id,
        user_id: userId,
        owner_user_id: userId,
        title: 'A diary entry',
        body: 'The wind eased at dusk.',
        mood: 'good',
        photos: [],
        audio_url: null,
        latitude: null,
        longitude: null,
        location_name: '',
        weather_summary: '',
        voyage_id: null,
        tags: [],
        is_public: isPublic,
        created_at: '2026-07-26T00:00:00.000Z',
        updated_at: '2026-07-26T00:00:00.000Z',
    };
}

let serial = 0;

beforeEach(() => {
    serial += 1;
    localStorage.clear();
    mockSupabase.current = null;
    Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { status: 200 })),
    );
    setAuthIdentityScope(`publish-reset-${serial}`);
});

describe('DiaryService.setEntryPublished server confirmation', () => {
    it('keeps an offline entry private when publication cannot be confirmed', async () => {
        const userId = `offline-publisher-${serial}`;
        setAuthIdentityScope(userId);
        const pendingKey = keyFor('thalassa_diary_pending_v2', userId);
        localStorage.setItem(pendingKey, JSON.stringify([entry('offline-publish', userId)]));

        await expect(DiaryService.setEntryPublished('offline-publish', true)).resolves.toBe(false);

        const pending = JSON.parse(localStorage.getItem(pendingKey) ?? '[]') as DiaryEntry[];
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({ id: 'offline-publish', is_public: false });
    });

    it('never renders an optimistic public flag on an unconfirmed offline draft as live', async () => {
        const userId = `legacy-pending-publisher-${serial}`;
        setAuthIdentityScope(userId);
        localStorage.setItem(
            keyFor('thalassa_diary_pending_v2', userId),
            JSON.stringify([entry('offline-legacy-public', userId, true)]),
        );

        const entries = await DiaryService.getEntries();

        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({ id: 'offline-legacy-public', is_public: false });
        await expect(DiaryService.getEntry('offline-legacy-public')).resolves.toMatchObject({
            id: 'offline-legacy-public',
            is_public: false,
        });
    });

    it('recovers an owned cache-only offline draft into the durable sync queue', async () => {
        const userId = `cache-recovery-publisher-${serial}`;
        const controls: PublishControls = {
            userId,
            inserts: [],
            updates: [],
            updateResult: { data: { id: 'unused', is_public: false }, error: null },
        };
        mockSupabase.current = createSupabaseMock(controls);
        Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
        setAuthIdentityScope(userId);
        localStorage.setItem(
            keyFor('thalassa_diary_entries_v2', userId),
            JSON.stringify([entry('offline-cache-only', userId)]),
        );

        // getEntries starts both the recovery sync and a normal server
        // refresh. The refresh must retain the local words until recovery
        // durably moves them into the pending queue.
        await DiaryService.getEntries();
        await DiaryService.syncPending();

        expect(controls.inserts).toHaveLength(1);
        expect(controls.inserts[0]).toMatchObject({
            user_id: userId,
            title: 'A diary entry',
            is_public: false,
        });
        expect(JSON.parse(localStorage.getItem(keyFor('thalassa_diary_pending_v2', userId)) ?? '[]')).toEqual([]);
        expect((await DiaryService.getEntries()).map((item) => item.id)).toContain('server-1');
    });

    it('waits for a fresh offline entry to land, then confirms its public state remotely', async () => {
        const userId = `sync-publisher-${serial}`;
        const controls: PublishControls = {
            userId,
            inserts: [],
            updates: [],
            updateResult: { data: { id: 'server-1', is_public: true }, error: null },
        };
        mockSupabase.current = createSupabaseMock(controls);
        Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
        setAuthIdentityScope(userId);
        localStorage.setItem(
            keyFor('thalassa_diary_pending_v2', userId),
            JSON.stringify([entry('offline-publish', userId)]),
        );

        await expect(DiaryService.setEntryPublished('offline-publish', true)).resolves.toBe(true);

        expect(controls.inserts).toHaveLength(1);
        expect(controls.inserts[0]).toMatchObject({ user_id: userId, is_public: false });
        expect(controls.updates).toHaveLength(1);
        expect(controls.updates[0]).toMatchObject({ is_public: true });
    });

    it('uses the durable offline-to-server mapping after the short-lived sync buffer has gone', async () => {
        const userId = `mapped-publisher-${serial}`;
        const controls: PublishControls = {
            userId,
            inserts: [],
            updates: [],
            updateResult: { data: { id: 'server-mapped', is_public: true }, error: null },
        };
        mockSupabase.current = createSupabaseMock(controls);
        setAuthIdentityScope(userId);
        localStorage.setItem(
            keyFor('thalassa_diary_idmap_v1', userId),
            JSON.stringify([{ offlineId: 'offline-relaunched', serverId: 'server-mapped', owner_user_id: userId }]),
        );

        await expect(DiaryService.setEntryPublished('offline-relaunched', true)).resolves.toBe(true);
        expect(controls.updates).toHaveLength(1);
        expect(controls.updates[0]).toMatchObject({ is_public: true });
    });

    it('treats a zero-row RLS update as a failure rather than a false publish success', async () => {
        const userId = `blocked-publisher-${serial}`;
        const controls: PublishControls = {
            userId,
            inserts: [],
            updates: [],
            updateResult: { data: null, error: null },
        };
        mockSupabase.current = createSupabaseMock(controls);
        setAuthIdentityScope(userId);

        await expect(DiaryService.setEntryPublished('server-blocked', true)).resolves.toBe(false);
        expect(controls.updates).toHaveLength(1);
    });

    it('requires the returned row to confirm the requested public flag', async () => {
        const userId = `mismatch-publisher-${serial}`;
        const controls: PublishControls = {
            userId,
            inserts: [],
            updates: [],
            updateResult: { data: { id: 'server-mismatch', is_public: false }, error: null },
        };
        mockSupabase.current = createSupabaseMock(controls);
        setAuthIdentityScope(userId);

        await expect(DiaryService.setEntryPublished('server-mismatch', true)).resolves.toBe(false);
        expect(controls.updates).toHaveLength(1);
    });
});
