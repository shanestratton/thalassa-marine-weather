import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSupabase: { current: ReturnType<typeof createSupabaseMock> | null } = { current: null };

vi.mock('../services/supabase', () => ({
    get supabase() {
        return mockSupabase.current;
    },
}));

import { DiaryService, type DiaryEntry } from '../services/DiaryService';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    setAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';

interface SupabaseControls {
    userId: string;
    inserts: Record<string, unknown>[];
    deletes: string[];
}

function createSupabaseMock(controls: SupabaseControls) {
    return {
        auth: {
            getUser: vi.fn(async () => ({ data: { user: { id: controls.userId } } })),
            getSession: vi.fn(async () => ({ data: { session: { user: { id: controls.userId } } } })),
            refreshSession: vi.fn(async () => ({ data: { session: { user: { id: controls.userId } } } })),
        },
        from: vi.fn((_table: string) => {
            let selectedId = '';
            const filter = {
                eq: (_column: string, value: string) => {
                    selectedId = value;
                    return filter;
                },
                order: () => ({
                    limit: async () => ({ data: [], error: null }),
                }),
                maybeSingle: async () => ({
                    data: selectedId.startsWith('gone-') ? null : { id: selectedId },
                }),
                single: async () => ({ data: null, error: null }),
            };
            return {
                insert: (payload: Record<string, unknown>) => {
                    controls.inserts.push(payload);
                    return {
                        select: () => ({
                            single: async () => ({
                                data: {
                                    id: `server-${controls.inserts.length}`,
                                    ...payload,
                                    updated_at: payload.created_at,
                                },
                                error: null,
                            }),
                        }),
                    };
                },
                select: (_columns: string) => filter,
                delete: () => ({
                    eq: (_column: string, id: string) => ({
                        select: async () => {
                            controls.deletes.push(id);
                            return { data: [{ id }], error: null };
                        },
                    }),
                }),
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

function scopeFor(userId: string): AuthIdentityScope {
    return { key: `user:${userId}`, userId, generation: 0 };
}

function keyFor(base: string, userId: string): string {
    return authScopedStorageKey(base, scopeFor(userId));
}

function makeServerEntry(id: string, userId: string): DiaryEntry {
    return {
        id,
        user_id: userId,
        owner_user_id: userId,
        title: `${userId}'s entry`,
        body: 'Private journal body',
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
        created_at: '2026-07-23T00:00:00.000Z',
        updated_at: '2026-07-23T00:00:00.000Z',
    };
}

let testNumber = 0;

beforeEach(() => {
    testNumber += 1;
    localStorage.clear();
    mockSupabase.current = null;
    Object.defineProperty(globalThis.navigator, 'onLine', { value: false, configurable: true });
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { status: 200 })),
    );
    setAuthIdentityScope(`reset-${testNumber}`);
});

describe('DiaryService auth identity isolation', () => {
    it('keeps A’s offline draft and media invisible and inert for B, then resumes it for A', async () => {
        const accountA = `account-a-${testNumber}`;
        const accountB = `account-b-${testNumber}`;
        const photo = 'data:image/jpeg;base64,QUJD';

        setAuthIdentityScope(accountA);
        const draft = await DiaryService.createEntry({
            title: 'A private offline log',
            body: 'Only A may read or upload this.',
            mood: 'rough',
            photos: [photo],
        });

        expect((await DiaryService.getEntries()).map((entry) => entry.id)).toContain(draft.id);
        expect(await DiaryService.resolvePhotoUrl(photo)).toBe(photo);

        const controlsB: SupabaseControls = { userId: accountB, inserts: [], deletes: [] };
        mockSupabase.current = createSupabaseMock(controlsB);
        Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
        setAuthIdentityScope(accountB);

        expect(await DiaryService.getEntries()).toEqual([]);
        expect(await DiaryService.getEntry(draft.id)).toBeNull();
        expect(await DiaryService.resolvePhotoUrl(photo)).toBeNull();
        await DiaryService.syncPending();
        expect(controlsB.inserts).toEqual([]);

        // Even if stale UI hands B A's offline id, it only creates a B-scoped
        // no-op tombstone. A's queue and bytes remain untouched.
        await DiaryService.deleteEntry(draft.id);
        expect(JSON.parse(localStorage.getItem(keyFor('thalassa_diary_pending_v2', accountA)) ?? '[]')).toHaveLength(1);

        const controlsA: SupabaseControls = { userId: accountA, inserts: [], deletes: [] };
        mockSupabase.current = createSupabaseMock(controlsA);
        setAuthIdentityScope(accountA);

        expect((await DiaryService.getEntries()).map((entry) => entry.id)).toContain(draft.id);
        expect(await DiaryService.resolvePhotoUrl(photo)).toBe(photo);
        await DiaryService.syncPending();

        expect(controlsA.inserts).toHaveLength(1);
        expect(controlsA.inserts[0]).toMatchObject({
            user_id: accountA,
            title: 'A private offline log',
        });
        expect(controlsB.inserts).toEqual([]);
        expect(JSON.parse(localStorage.getItem(keyFor('thalassa_diary_pending_v2', accountA)) ?? '[]')).toEqual([]);
    });

    it('quarantines ambiguous legacy drafts instead of exposing or uploading them', async () => {
        const accountB = `legacy-b-${testNumber}`;
        const legacyDraft = {
            ...makeServerEntry('offline-legacy', 'local'),
            owner_user_id: undefined,
            title: 'Unattributed private legacy bytes',
            photos: ['data:image/jpeg;base64,U0VDUkVU'],
        };
        delete legacyDraft.owner_user_id;
        localStorage.setItem('thalassa_diary_pending_v2', JSON.stringify([legacyDraft]));

        const controls: SupabaseControls = { userId: accountB, inserts: [], deletes: [] };
        mockSupabase.current = createSupabaseMock(controls);
        Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
        setAuthIdentityScope(accountB);

        expect(await DiaryService.getEntries()).toEqual([]);
        await DiaryService.syncPending();
        expect(controls.inserts).toEqual([]);
        expect(localStorage.getItem('thalassa_diary_pending_v2')).toBeNull();

        const quarantine = localStorage.getItem('thalassa_diary_quarantine_v1') ?? '';
        expect(quarantine).toContain('Unattributed private legacy bytes');
        expect(quarantine).toContain('legacy records had no validated owner');
    });

    it('partitions validated legacy cache rows by their server user_id', async () => {
        const accountA = `legacy-a-${testNumber}`;
        const accountB = `legacy-b-${testNumber}`;
        localStorage.setItem(
            'thalassa_diary_entries_v2',
            JSON.stringify([makeServerEntry('a-row', accountA), makeServerEntry('b-row', accountB)]),
        );

        setAuthIdentityScope(accountB);
        expect((await DiaryService.getEntries()).map((entry) => entry.id)).toEqual(['b-row']);

        setAuthIdentityScope(accountA);
        expect((await DiaryService.getEntries()).map((entry) => entry.id)).toEqual(['a-row']);
        expect(getAuthIdentityScope().userId).toBe(accountA);
    });

    it('never drains A’s tombstone while B is the authenticated account', async () => {
        const accountA = `delete-a-${testNumber}`;
        const accountB = `delete-b-${testNumber}`;
        localStorage.setItem(
            keyFor('thalassa_diary_entries_v2', accountA),
            JSON.stringify([makeServerEntry('server-a', accountA)]),
        );

        setAuthIdentityScope(accountA);
        await DiaryService.deleteEntry('server-a');

        const controlsB: SupabaseControls = { userId: accountB, inserts: [], deletes: [] };
        mockSupabase.current = createSupabaseMock(controlsB);
        setAuthIdentityScope(accountB);
        await DiaryService.drainDeletedTombstones();
        expect(controlsB.deletes).toEqual([]);

        const controlsA: SupabaseControls = { userId: accountA, inserts: [], deletes: [] };
        mockSupabase.current = createSupabaseMock(controlsA);
        setAuthIdentityScope(accountA);
        await DiaryService.drainDeletedTombstones();
        expect(controlsA.deletes).toEqual(['server-a']);
    });
});
