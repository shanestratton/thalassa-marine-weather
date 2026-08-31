import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockSupabase: { current: ReturnType<typeof createSupabaseMock> | null } = { current: null };
const relay = vi.hoisted(() => ({
    handoffDiaryToPi: vi.fn(),
    hasReachableDiaryCloud: vi.fn(),
    canAttemptDiaryCloudDelivery: vi.fn(),
    submitDiaryDirect: vi.fn(),
    cancelDiaryOnPi: vi.fn(),
    cancelDiaryDirect: vi.fn(),
    syncPiDiaryRelayInternetPolicy: vi.fn(),
}));
const shipLog = vi.hoisted(() => ({
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
    hasReachableDiaryCloud: relay.hasReachableDiaryCloud,
    canAttemptDiaryCloudDelivery: relay.canAttemptDiaryCloudDelivery,
    submitDiaryDirect: relay.submitDiaryDirect,
    cancelDiaryOnPi: relay.cancelDiaryOnPi,
    cancelDiaryDirect: relay.cancelDiaryDirect,
    syncPiDiaryRelayInternetPolicy: relay.syncPiDiaryRelayInternetPolicy,
}));

vi.mock('../services/ShipLogService', () => ({
    ShipLogService: {
        resolveActiveVoyageId: shipLog.resolveActiveVoyageId,
        resolveActiveBoatId: shipLog.resolveActiveBoatId,
    },
}));

import { DiaryService, type DiaryEntry } from '../services/DiaryService';
import { authScopedStorageKey, setAuthIdentityScope, type AuthIdentityScope } from '../services/authIdentityScope';

interface PublishControls {
    userId: string;
    inserts: Record<string, unknown>[];
    writes?: Array<{
        method: 'insert' | 'upsert';
        payload: Record<string, unknown> | Record<string, unknown>[];
        options?: Record<string, unknown>;
    }>;
    writeResults?: Array<{
        data: Record<string, unknown> | null;
        error: { message: string; code?: string; details?: string } | null;
    }>;
    updates: Record<string, unknown>[];
    updateResult: { data: { id: string; is_public: boolean } | null; error: { message: string } | null };
}

function createSupabaseMock(controls: PublishControls) {
    const write =
        (method: 'insert' | 'upsert') =>
        (payload: Record<string, unknown> | Record<string, unknown>[], options?: Record<string, unknown>) => {
            if (method === 'insert' && !Array.isArray(payload)) controls.inserts.push(payload);
            const writes = controls.writes ?? (controls.writes = []);
            writes.push({ method, payload, options });
            const nextResult = controls.writeResults?.shift();
            const row = Array.isArray(payload) ? payload[0] : payload;
            return {
                select: () => ({
                    single: async () =>
                        nextResult ?? {
                            data: {
                                ...row,
                                id: `server-${writes.length}`,
                                updated_at: row?.created_at,
                            },
                            error: null,
                        },
                }),
            };
        };

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
                insert: write('insert'),
                upsert: write('upsert'),
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
    relay.handoffDiaryToPi.mockReset().mockResolvedValue(null);
    relay.hasReachableDiaryCloud.mockReset().mockResolvedValue(true);
    relay.canAttemptDiaryCloudDelivery.mockReset().mockImplementation(() => navigator.onLine);
    relay.submitDiaryDirect.mockReset().mockResolvedValue(null);
    relay.cancelDiaryOnPi.mockReset().mockResolvedValue(false);
    relay.cancelDiaryDirect.mockReset().mockResolvedValue(false);
    relay.syncPiDiaryRelayInternetPolicy.mockReset().mockResolvedValue(false);
    shipLog.resolveActiveVoyageId.mockReset().mockResolvedValue(undefined);
    shipLog.resolveActiveBoatId.mockReset().mockResolvedValue(undefined);
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => new Response(null, { status: 200 })),
    );
    setAuthIdentityScope(`publish-reset-${serial}`);
});

describe('DiaryService.setEntryPublished server confirmation', () => {
    it('inherits the active track for an omitted voyage id but preserves an explicit unassigned diary entry', async () => {
        const userId = `voyage-association-${serial}`;
        setAuthIdentityScope(userId);
        shipLog.resolveActiveVoyageId.mockResolvedValue('voyage-active');

        const attached = await DiaryService.createEntry({
            title: 'Underway note',
            body: 'A reef came in before the squall.',
            mood: 'good',
        });
        const deliberatelyUnassigned = await DiaryService.createEntry({
            title: 'Harbour note',
            body: 'Written after the voyage ended.',
            mood: 'neutral',
            voyage_id: null,
        });
        const optionalUndefined = await DiaryService.createEntry({
            title: 'Form passthrough note',
            body: 'An optional prop must behave like an omitted one.',
            mood: 'good',
            voyage_id: undefined,
        });

        expect(attached.voyage_id).toBe('voyage-active');
        expect(deliberatelyUnassigned.voyage_id).toBeNull();
        expect(optionalUndefined.voyage_id).toBe('voyage-active');
        expect(shipLog.resolveActiveVoyageId).toHaveBeenCalledTimes(2);
    });

    it('retains an offline publication request as a durable queued intent', async () => {
        const userId = `offline-publisher-${serial}`;
        setAuthIdentityScope(userId);
        const pendingKey = keyFor('thalassa_diary_pending_v2', userId);
        localStorage.setItem(pendingKey, JSON.stringify([entry('offline-publish', userId)]));

        await DiaryService.setEntryPublished('offline-publish', true);

        const pending = JSON.parse(localStorage.getItem(pendingKey) ?? '[]') as Array<
            DiaryEntry & { publish_requested?: boolean }
        >;
        expect(pending).toHaveLength(1);
        expect(pending[0]).toMatchObject({ id: 'offline-publish', is_public: false, publish_requested: true });
    });

    it('rejects a new diary save when no durable pending-outbox write survives', async () => {
        const userId = `persistence-failure-${serial}`;
        setAuthIdentityScope(userId);
        const originalSetItem = Storage.prototype.setItem;
        const setItem = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
            if (key.includes('thalassa_diary_pending_v2')) throw new Error('QuotaExceededError');
            return originalSetItem.call(this, key, value);
        });

        await expect(
            DiaryService.createEntry({
                title: 'Never pretend this saved',
                body: 'Keep the compose sheet open.',
                mood: 'neutral',
            }),
        ).rejects.toThrow('durably persisted');

        expect(setItem).toHaveBeenCalled();
        expect(localStorage.getItem(keyFor('thalassa_diary_pending_v2', userId))).toBeNull();
        setItem.mockRestore();
    });

    it('sanitizes legacy optimistic public flags until the server confirms publication', async () => {
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

    it('syncs a queued public entry with a stable client operation id across retries', async () => {
        const userId = `durable-public-sync-${serial}`;
        const controls: PublishControls = {
            userId,
            inserts: [],
            updates: [],
            updateResult: { data: { id: 'unused', is_public: false }, error: null },
        };
        mockSupabase.current = createSupabaseMock(controls);
        relay.submitDiaryDirect
            .mockResolvedValueOnce(null)
            .mockImplementationOnce(async (payload: { client_operation_id: string; client_revision: number }) => ({
                status: 'accepted',
                entry: {
                    id: 'server-public',
                    user_id: userId,
                    is_public: true,
                    client_operation_id: payload.client_operation_id,
                    client_revision: payload.client_revision,
                },
            }));
        Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
        setAuthIdentityScope(userId);
        const pendingKey = keyFor('thalassa_diary_pending_v2', userId);
        localStorage.setItem(
            pendingKey,
            JSON.stringify([{ ...entry('offline-public-intent', userId), publish_requested: true }]),
        );

        await DiaryService.syncPending();

        const pendingAfterFailedSync = JSON.parse(localStorage.getItem(pendingKey) ?? '[]') as Array<
            DiaryEntry & { publish_requested?: boolean }
        >;
        expect(pendingAfterFailedSync).toMatchObject([
            { id: 'offline-public-intent', is_public: false, publish_requested: true },
        ]);
        expect(relay.submitDiaryDirect).toHaveBeenCalledTimes(1);
        const firstPayload = relay.submitDiaryDirect.mock.calls[0][0] as Record<string, unknown>;
        expect(firstPayload).toMatchObject({ is_public: true, client_revision: 1 });
        expect(firstPayload.client_operation_id).toEqual(expect.any(String));

        await DiaryService.syncPending();

        expect(relay.submitDiaryDirect).toHaveBeenCalledTimes(2);
        const retryPayload = relay.submitDiaryDirect.mock.calls[1][0] as Record<string, unknown>;
        expect(retryPayload).toMatchObject({ is_public: true, client_revision: 1 });
        expect(retryPayload.client_operation_id).toBe(firstPayload.client_operation_id);
        expect(JSON.parse(localStorage.getItem(pendingKey) ?? '[]')).toEqual([]);
    });

    it('keeps a newer local revision when a delayed Pi response is stale', async () => {
        const userId = `revision-publisher-${serial}`;
        const controls: PublishControls = {
            userId,
            inserts: [],
            updates: [],
            updateResult: { data: { id: 'unused', is_public: false }, error: null },
        };
        mockSupabase.current = createSupabaseMock(controls);
        Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
        setAuthIdentityScope(userId);
        const pendingKey = keyFor('thalassa_diary_pending_v2', userId);
        localStorage.setItem(
            pendingKey,
            JSON.stringify([
                {
                    ...entry('offline-revision', userId),
                    client_operation_id: 'diary_revision_1',
                    client_revision: 2,
                    body: 'The corrected, newer text.',
                },
            ]),
        );
        const stale = {
            id: 'server-revision',
            user_id: userId,
            client_operation_id: 'diary_revision_1',
            client_revision: 1,
            is_public: false,
        };
        relay.handoffDiaryToPi.mockResolvedValue({ accepted: true, status: 'synced', entry: stale });
        relay.submitDiaryDirect.mockResolvedValue({ status: 'accepted', entry: stale });

        await DiaryService.syncPending();

        expect(JSON.parse(localStorage.getItem(pendingKey) ?? '[]')).toMatchObject([
            { id: 'offline-revision', client_revision: 2, body: 'The corrected, newer text.' },
        ]);
    });

    it('never lets an in-flight r1 completion erase an edit made as r2', async () => {
        const userId = `racing-publisher-${serial}`;
        const controls: PublishControls = {
            userId,
            inserts: [],
            updates: [],
            updateResult: { data: { id: 'unused', is_public: false }, error: null },
        };
        mockSupabase.current = createSupabaseMock(controls);
        Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
        setAuthIdentityScope(userId);
        const pendingKey = keyFor('thalassa_diary_pending_v2', userId);
        localStorage.setItem(
            pendingKey,
            JSON.stringify([
                {
                    ...entry('offline-race', userId),
                    client_operation_id: 'diary_race_1',
                    client_revision: 1,
                },
            ]),
        );

        let resolvePi: ((value: unknown) => void) | undefined;
        relay.handoffDiaryToPi
            .mockImplementationOnce(
                () =>
                    new Promise((resolve) => {
                        resolvePi = resolve;
                    }),
            )
            .mockResolvedValue(null);
        relay.submitDiaryDirect.mockResolvedValue(null);

        const syncing = DiaryService.syncPending();
        await vi.waitFor(() => expect(relay.handoffDiaryToPi).toHaveBeenCalledTimes(1));
        await expect(DiaryService.updateEntry('offline-race', { body: 'The r2 correction.' })).resolves.toMatchObject({
            ok: true,
        });
        resolvePi?.({
            accepted: true,
            status: 'synced',
            entry: {
                id: 'server-race',
                user_id: userId,
                client_operation_id: 'diary_race_1',
                client_revision: 1,
            },
        });
        await syncing;

        expect(JSON.parse(localStorage.getItem(pendingKey) ?? '[]')).toMatchObject([
            { id: 'offline-race', client_operation_id: 'diary_race_1', client_revision: 2, body: 'The r2 correction.' },
        ]);
    });

    it('rejects a canonical row for another operation instead of retiring this draft', async () => {
        const userId = `wrong-operation-publisher-${serial}`;
        const controls: PublishControls = {
            userId,
            inserts: [],
            updates: [],
            updateResult: { data: { id: 'unused', is_public: false }, error: null },
        };
        mockSupabase.current = createSupabaseMock(controls);
        Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
        setAuthIdentityScope(userId);
        const pendingKey = keyFor('thalassa_diary_pending_v2', userId);
        localStorage.setItem(
            pendingKey,
            JSON.stringify([
                {
                    ...entry('offline-wrong-operation', userId),
                    client_operation_id: 'diary_expected_operation',
                    client_revision: 1,
                },
            ]),
        );
        relay.submitDiaryDirect.mockResolvedValue({
            status: 'accepted',
            entry: {
                id: 'server-wrong-operation',
                user_id: userId,
                client_operation_id: 'diary_some_other_operation',
                client_revision: 1,
            },
        });

        await DiaryService.syncPending();

        expect(JSON.parse(localStorage.getItem(pendingKey) ?? '[]')).toMatchObject([
            { id: 'offline-wrong-operation', client_operation_id: 'diary_expected_operation' },
        ]);
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
        relay.submitDiaryDirect.mockImplementation(
            async (payload: { client_operation_id: string; client_revision: number }) => ({
                status: 'accepted',
                entry: {
                    id: 'server-1',
                    user_id: userId,
                    is_public: false,
                    client_operation_id: payload.client_operation_id,
                    client_revision: payload.client_revision,
                },
            }),
        );
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

        expect(relay.submitDiaryDirect).toHaveBeenCalledTimes(1);
        expect(relay.submitDiaryDirect.mock.calls[0][0]).toMatchObject({
            title: 'A diary entry',
            is_public: false,
        });
        expect(JSON.parse(localStorage.getItem(keyFor('thalassa_diary_pending_v2', userId)) ?? '[]')).toEqual([]);
        expect((await DiaryService.getEntries()).map((item) => item.id)).toContain('server-1');
    });

    it('syncs a fresh public request directly instead of first landing it as private', async () => {
        const userId = `sync-publisher-${serial}`;
        const controls: PublishControls = {
            userId,
            inserts: [],
            updates: [],
            updateResult: { data: { id: 'server-1', is_public: true }, error: null },
        };
        mockSupabase.current = createSupabaseMock(controls);
        relay.submitDiaryDirect.mockImplementation(
            async (payload: { client_operation_id: string; client_revision: number }) => ({
                status: 'accepted',
                entry: {
                    id: 'server-1',
                    user_id: userId,
                    is_public: true,
                    client_operation_id: payload.client_operation_id,
                    client_revision: payload.client_revision,
                },
            }),
        );
        Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
        setAuthIdentityScope(userId);
        localStorage.setItem(
            keyFor('thalassa_diary_pending_v2', userId),
            JSON.stringify([entry('offline-publish', userId)]),
        );

        await expect(DiaryService.setEntryPublished('offline-publish', true)).resolves.toBe(true);

        expect(relay.submitDiaryDirect).toHaveBeenCalledTimes(1);
        expect(relay.submitDiaryDirect.mock.calls[0][0]).toMatchObject({ is_public: true, client_revision: 2 });
        expect(relay.submitDiaryDirect.mock.calls[0][0]).toHaveProperty('client_operation_id');
        expect(controls.updates).toHaveLength(0);
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
