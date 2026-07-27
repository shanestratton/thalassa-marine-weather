import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSupabase: { current: ReturnType<typeof createSupabaseMock> | null } = { current: null };
const relay = vi.hoisted(() => ({
    handoffDiaryToPi: vi.fn(),
    submitDiaryDirect: vi.fn(),
    cancelDiaryOnPi: vi.fn(),
    cancelDiaryDirect: vi.fn(),
    canAttemptDiaryCloudDelivery: vi.fn(),
    syncPiDiaryRelayInternetPolicy: vi.fn(),
}));
const tracking = vi.hoisted(() => ({
    resolveActiveVoyageId: vi.fn(),
    resolveActiveBoatId: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    get supabase() {
        return mockSupabase.current;
    },
}));

vi.mock('../services/DiaryRelayTransport', () => ({
    handoffDiaryToPi: relay.handoffDiaryToPi,
    submitDiaryDirect: relay.submitDiaryDirect,
    cancelDiaryOnPi: relay.cancelDiaryOnPi,
    cancelDiaryDirect: relay.cancelDiaryDirect,
    canAttemptDiaryCloudDelivery: relay.canAttemptDiaryCloudDelivery,
    syncPiDiaryRelayInternetPolicy: relay.syncPiDiaryRelayInternetPolicy,
}));

vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        resolveActiveVoyageId: tracking.resolveActiveVoyageId,
        resolveActiveBoatId: tracking.resolveActiveBoatId,
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
    relay.handoffDiaryToPi.mockReset().mockResolvedValue(null);
    relay.cancelDiaryOnPi.mockReset().mockResolvedValue(false);
    relay.cancelDiaryDirect.mockReset().mockResolvedValue(false);
    relay.canAttemptDiaryCloudDelivery.mockReset().mockImplementation(() => navigator.onLine);
    relay.syncPiDiaryRelayInternetPolicy.mockReset().mockResolvedValue(false);
    tracking.resolveActiveVoyageId.mockReset().mockResolvedValue(undefined);
    tracking.resolveActiveBoatId.mockReset().mockResolvedValue(undefined);
    relay.submitDiaryDirect
        .mockReset()
        .mockImplementation(async (payload: { client_operation_id: string; client_revision: number }) => ({
            id: `server-${payload.client_operation_id}`,
            user_id: getAuthIdentityScope().userId,
            client_operation_id: payload.client_operation_id,
            client_revision: payload.client_revision,
        }));
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { status: 200 })),
    );
    setAuthIdentityScope(`reset-${testNumber}`);
});

describe('DiaryService auth identity isolation', () => {
    it('binds a new diary entry to the cast-off vessel and preserves it through the direct relay envelope', async () => {
        const account = `vessel-bound-${testNumber}`;
        const boatId = '2e39983f-5d86-4dcb-b6f9-34df05c08d90';
        tracking.resolveActiveVoyageId.mockResolvedValue('voyage-bound');
        tracking.resolveActiveBoatId.mockResolvedValue(boatId);
        setAuthIdentityScope(account);

        const entry = await DiaryService.createEntry({
            title: 'A note under way',
            body: 'The breeze filled in after breakfast.',
            mood: 'good',
        });

        expect(entry).toMatchObject({ voyage_id: 'voyage-bound', boat_id: boatId });
        expect(JSON.parse(localStorage.getItem(keyFor('thalassa_diary_pending_v2', account)) ?? '[]')).toMatchObject([
            { boat_id: boatId, voyage_id: 'voyage-bound' },
        ]);

        // createEntry starts a local-only background pass. Let that pass
        // settle before enabling the direct cloud route for this assertion.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        const controls: SupabaseControls = { userId: account, inserts: [], deletes: [] };
        mockSupabase.current = createSupabaseMock(controls);
        Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
        await DiaryService.syncPending();

        expect(relay.submitDiaryDirect).toHaveBeenCalledWith(expect.objectContaining({ boat_id: boatId }));
    });

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
        expect(relay.submitDiaryDirect).not.toHaveBeenCalled();

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

        expect(relay.submitDiaryDirect).toHaveBeenCalledTimes(1);
        expect(relay.submitDiaryDirect.mock.calls[0][0]).toMatchObject({
            title: 'A private offline log',
        });
        expect(relay.submitDiaryDirect.mock.calls[0][0]).toHaveProperty('client_operation_id');
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
        expect(relay.submitDiaryDirect).not.toHaveBeenCalled();
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
        Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
        setAuthIdentityScope(accountA);
        await DiaryService.drainDeletedTombstones();
        expect(controlsA.deletes).toEqual(['server-a']);
    });
});
