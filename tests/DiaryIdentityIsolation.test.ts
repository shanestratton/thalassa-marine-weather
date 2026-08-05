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
    isAuthIdentityScopeCurrent,
    setAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';

interface SupabaseControls {
    userId: string;
    inserts: Record<string, unknown>[];
    deletes: string[];
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
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

    it('reports a durable create commit even when identity changes immediately after the outbox write', async () => {
        const accountA = `create-commit-a-${testNumber}`;
        const accountB = `create-commit-b-${testNumber}`;
        setAuthIdentityScope(accountA);
        const internals = DiaryService as unknown as {
            _addPending(entry: DiaryEntry, scope: AuthIdentityScope): Promise<void>;
        };
        const originalAddPending = internals._addPending.bind(internals);
        const addPending = vi.spyOn(internals, '_addPending').mockImplementation(async (entry, scope) => {
            await originalAddPending(entry, scope);
            setAuthIdentityScope(accountB);
        });
        try {
            await expect(
                DiaryService.createEntry({
                    title: 'Committed before the watch changed',
                    body: 'The A outbox owns this entry and its media now.',
                    mood: 'good',
                }),
            ).resolves.toMatchObject({ owner_user_id: accountA });
            expect(
                JSON.parse(localStorage.getItem(keyFor('thalassa_diary_pending_v2', accountA)) ?? '[]'),
            ).toMatchObject([{ title: 'Committed before the watch changed', owner_user_id: accountA }]);
        } finally {
            addPending.mockRestore();
        }
    });

    it('reports durable update adoption even when its UI continuation becomes stale after the outbox write', async () => {
        const accountA = `update-commit-a-${testNumber}`;
        const accountB = `update-commit-b-${testNumber}`;
        setAuthIdentityScope(accountA);
        localStorage.setItem(
            keyFor('thalassa_diary_entries_v2', accountA),
            JSON.stringify([makeServerEntry('server-entry', accountA)]),
        );
        const operationScope = getAuthIdentityScope();
        const internals = DiaryService as unknown as {
            _savePending(entries: DiaryEntry[], scope?: AuthIdentityScope): boolean;
        };
        const originalSave = internals._savePending.bind(internals);
        const save = vi.spyOn(internals, '_savePending').mockImplementation((entries, scope) => {
            const persisted = originalSave(entries, scope);
            if (persisted) setAuthIdentityScope(accountB);
            return persisted;
        });
        try {
            await expect(
                DiaryService.updateEntry(
                    'server-entry',
                    { photos: [`storage:diary-photos:${accountA}/adopted.jpg`] },
                    { shouldContinue: () => isAuthIdentityScopeCurrent(operationScope) },
                ),
            ).resolves.toMatchObject({ ok: true });
            expect(
                JSON.parse(localStorage.getItem(keyFor('thalassa_diary_pending_v2', accountA)) ?? '[]'),
            ).toMatchObject([
                {
                    id: 'server-entry',
                    owner_user_id: accountA,
                    photos: [`storage:diary-photos:${accountA}/adopted.jpg`],
                },
            ]);
            expect(localStorage.getItem(keyFor('thalassa_diary_pending_v2', accountB))).toBeNull();
        } finally {
            save.mockRestore();
        }
    });

    it('does not report adoption when the authenticated server update matched no diary row', async () => {
        const account = `update-zero-row-${testNumber}`;
        const controls: SupabaseControls = { userId: account, inserts: [], deletes: [] };
        mockSupabase.current = createSupabaseMock(controls);
        setAuthIdentityScope(account);

        await expect(
            DiaryService.updateEntry('missing-server-entry', {
                photos: [`storage:diary-photos:${account}/still-compose-owned.jpg`],
            }),
        ).resolves.toEqual({ ok: false });
    });

    it('keeps A’s offline draft and media invisible and inert for B, then resumes it for A', async () => {
        const accountA = `account-a-${testNumber}`;
        const accountB = `account-b-${testNumber}`;
        const photo = 'data:image/jpeg;base64,QUJD';

        setAuthIdentityScope(accountA);
        const internals = DiaryService as unknown as {
            _registerMediaRef(ref: string, scope: AuthIdentityScope): void;
        };
        // uploadPhoto/saveUnsavedAudio register process-local refs in this
        // owner-scoped ledger. Register the legacy data URI through that same
        // boundary so this test exercises A/B isolation without bypassing the
        // production media-ownership check in createEntry.
        internals._registerMediaRef(photo, getAuthIdentityScope());
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

    it('persists an all-success photo handoff before relaying it and preserves the adopted object', async () => {
        const account = `photo-handoff-${testNumber}`;
        const controls: SupabaseControls = { userId: account, inserts: [], deletes: [] };
        const client = createSupabaseMock(controls);
        const remove = vi.fn().mockResolvedValue({ error: null });
        client.storage.from = vi.fn(() => ({
            upload: vi.fn(async () => ({ error: null })),
            remove,
            createSignedUrl: vi.fn(async () => ({ data: { signedUrl: 'https://signed.test/object' }, error: null })),
        }));
        mockSupabase.current = client;
        Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
        setAuthIdentityScope(account);

        const dataPhoto = 'data:image/jpeg;base64,SEFOREHANDOFF';
        const storageRef = `storage:diary-photos:${account}/adopted.jpg`;
        const queued: DiaryEntry = {
            ...makeServerEntry('offline-photo-handoff', account),
            photos: [dataPhoto],
            client_operation_id: 'photo-handoff-op',
            client_revision: 1,
        };
        localStorage.setItem(keyFor('thalassa_diary_pending_v2', account), JSON.stringify([queued]));

        const internals = DiaryService as unknown as {
            _uploadDataUri(value: string, scope: AuthIdentityScope): Promise<string | null>;
            _savePending(entries: DiaryEntry[], scope?: AuthIdentityScope): boolean;
        };
        const upload = vi.spyOn(internals, '_uploadDataUri').mockResolvedValue(storageRef);
        const originalSave = internals._savePending.bind(internals);
        const save = vi.spyOn(internals, '_savePending').mockImplementation((entries, scope) => {
            const persisted = originalSave(entries, scope);
            // The read-back reference is the commit point even if a helper's
            // ancillary success signal is lost.
            return entries.some((entry) => entry.photos.includes(storageRef)) ? false : persisted;
        });
        try {
            await DiaryService.syncPending();

            const adoptionCall = save.mock.calls.findIndex(([entries]) =>
                entries.some((entry) => entry.id === queued.id && entry.photos[0] === storageRef),
            );
            expect(adoptionCall).toBeGreaterThanOrEqual(0);
            expect(save.mock.invocationCallOrder[adoptionCall]).toBeLessThan(
                relay.submitDiaryDirect.mock.invocationCallOrder[0],
            );
            expect(relay.submitDiaryDirect).toHaveBeenCalledWith(expect.objectContaining({ photos: [storageRef] }));
            expect(remove).not.toHaveBeenCalled();
        } finally {
            upload.mockRestore();
            save.mockRestore();
        }
    });

    it('removes only the fresh photo object when the transformed outbox row cannot be saved', async () => {
        const account = `photo-handoff-fail-${testNumber}`;
        const controls: SupabaseControls = { userId: account, inserts: [], deletes: [] };
        const client = createSupabaseMock(controls);
        const remove = vi.fn().mockResolvedValue({ error: null });
        client.storage.from = vi.fn(() => ({
            upload: vi.fn(async () => ({ error: null })),
            remove,
            createSignedUrl: vi.fn(async () => ({ data: { signedUrl: 'https://signed.test/object' }, error: null })),
        }));
        mockSupabase.current = client;
        Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
        setAuthIdentityScope(account);

        const dataPhoto = 'data:image/jpeg;base64,SEFOREFAIL';
        const storageRef = `storage:diary-photos:${account}/uncommitted.jpg`;
        const queued: DiaryEntry = {
            ...makeServerEntry('offline-photo-handoff-fail', account),
            photos: [dataPhoto],
            client_operation_id: 'photo-handoff-fail-op',
            client_revision: 1,
        };
        localStorage.setItem(keyFor('thalassa_diary_pending_v2', account), JSON.stringify([queued]));

        const internals = DiaryService as unknown as {
            _uploadDataUri(value: string, scope: AuthIdentityScope): Promise<string | null>;
            _savePending(entries: DiaryEntry[], scope?: AuthIdentityScope): boolean;
        };
        const upload = vi.spyOn(internals, '_uploadDataUri').mockResolvedValue(storageRef);
        const originalSave = internals._savePending.bind(internals);
        const save = vi
            .spyOn(internals, '_savePending')
            .mockImplementation((entries, scope) =>
                entries.some((entry) => entry.photos.includes(storageRef)) ? false : originalSave(entries, scope),
            );
        try {
            await DiaryService.syncPending();

            expect(relay.submitDiaryDirect).not.toHaveBeenCalled();
            expect(remove).toHaveBeenCalledOnce();
            expect(remove).toHaveBeenCalledWith([`${account}/uncommitted.jpg`]);
            expect(
                JSON.parse(localStorage.getItem(keyFor('thalassa_diary_pending_v2', account)) ?? '[]'),
            ).toMatchObject([{ photos: [dataPhoto] }]);
        } finally {
            upload.mockRestore();
            save.mockRestore();
        }
    });

    it('does not adopt a data-URI voice memo when its storage ref cannot be saved to the outbox', async () => {
        const account = `audio-handoff-fail-${testNumber}`;
        const controls: SupabaseControls = { userId: account, inserts: [], deletes: [] };
        const client = createSupabaseMock(controls);
        const remove = vi.fn().mockResolvedValue({ error: null });
        client.storage.from = vi.fn(() => ({
            upload: vi.fn(async () => ({ error: null })),
            remove,
            createSignedUrl: vi.fn(async () => ({ data: { signedUrl: 'https://signed.test/object' }, error: null })),
        }));
        mockSupabase.current = client;
        Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
        setAuthIdentityScope(account);

        const dataAudio = 'data:audio/mp4;base64,SEFOREAUDIO';
        const storageRef = `storage:diary-audio:${account}/uncommitted.m4a`;
        const queued: DiaryEntry = {
            ...makeServerEntry('offline-audio-handoff-fail', account),
            audio_url: dataAudio,
            client_operation_id: 'audio-handoff-fail-op',
            client_revision: 1,
        };
        localStorage.setItem(keyFor('thalassa_diary_pending_v2', account), JSON.stringify([queued]));

        const internals = DiaryService as unknown as {
            _uploadAudioDataUri(value: string, scope: AuthIdentityScope): Promise<string | null>;
            _savePending(entries: DiaryEntry[], scope?: AuthIdentityScope): boolean;
        };
        const upload = vi.spyOn(internals, '_uploadAudioDataUri').mockResolvedValue(storageRef);
        const originalSave = internals._savePending.bind(internals);
        const save = vi
            .spyOn(internals, '_savePending')
            .mockImplementation((entries, scope) =>
                entries.some((entry) => entry.audio_url === storageRef) ? false : originalSave(entries, scope),
            );
        try {
            await DiaryService.syncPending();

            expect(relay.submitDiaryDirect).not.toHaveBeenCalled();
            expect(remove).toHaveBeenCalledOnce();
            expect(remove).toHaveBeenCalledWith([`${account}/uncommitted.m4a`]);
            expect(
                JSON.parse(localStorage.getItem(keyFor('thalassa_diary_pending_v2', account)) ?? '[]'),
            ).toMatchObject([{ audio_url: dataAudio }]);
        } finally {
            upload.mockRestore();
            save.mockRestore();
        }
    });

    it('discards an unsaved private photo by exact object path', async () => {
        const account = `photo-discard-${testNumber}`;
        const controls: SupabaseControls = { userId: account, inserts: [], deletes: [] };
        const client = createSupabaseMock(controls);
        const remove = vi.fn().mockResolvedValue({ error: null });
        client.storage.from = vi.fn(() => ({
            upload: vi.fn(async () => ({ error: null })),
            remove,
            createSignedUrl: vi.fn(async () => ({ data: { signedUrl: 'https://signed.test/object' }, error: null })),
        }));
        mockSupabase.current = client;
        setAuthIdentityScope(account);

        await DiaryService.discardUnsavedPhoto(`storage:diary-photos:${account}/compose-only.jpg`);

        expect(client.storage.from).toHaveBeenCalledWith('diary-photos');
        expect(remove).toHaveBeenCalledWith([`${account}/compose-only.jpg`]);
    });

    it('retires the exact private photo when identity changes after upload', async () => {
        const accountA = `photo-upload-a-${testNumber}`;
        const controls: SupabaseControls = { userId: accountA, inserts: [], deletes: [] };
        const client = createSupabaseMock(controls);
        const uploaded = deferred<{ error: null }>();
        const upload = vi.fn().mockReturnValue(uploaded.promise);
        const remove = vi.fn().mockResolvedValue({ error: null });
        client.storage.from = vi.fn(() => ({
            upload,
            remove,
            createSignedUrl: vi.fn(async () => ({ data: { signedUrl: 'https://signed.test/object' }, error: null })),
        }));
        mockSupabase.current = client;
        Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
        setAuthIdentityScope(accountA);
        const scope = getAuthIdentityScope();
        const internals = DiaryService as unknown as {
            _compressImage(file: File): Promise<Blob>;
            _uploadPhotoToStorage(file: File, uploadScope: AuthIdentityScope): Promise<string | null>;
        };
        const compress = vi
            .spyOn(internals, '_compressImage')
            .mockResolvedValue(new Blob(['compressed'], { type: 'image/jpeg' }));

        const pending = internals._uploadPhotoToStorage(new File(['raw'], 'diary.jpg', { type: 'image/jpeg' }), scope);
        await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
        const uploadedPath = upload.mock.calls[0][0] as string;

        setAuthIdentityScope(`photo-upload-b-${testNumber}`);
        uploaded.resolve({ error: null });

        await expect(pending).resolves.toBeNull();
        expect(remove).toHaveBeenCalledWith([uploadedPath]);
        expect(uploadedPath).toMatch(new RegExp(`^${accountA}/\\d+[.]jpg$`));
        compress.mockRestore();
    });

    it('retires the exact private audio object when identity changes after upload', async () => {
        const accountA = `audio-upload-a-${testNumber}`;
        const controls: SupabaseControls = { userId: accountA, inserts: [], deletes: [] };
        const client = createSupabaseMock(controls);
        const uploaded = deferred<{ error: null }>();
        const upload = vi.fn().mockReturnValue(uploaded.promise);
        const remove = vi.fn().mockResolvedValue({ error: null });
        client.storage.from = vi.fn(() => ({
            upload,
            remove,
            createSignedUrl: vi.fn(async () => ({ data: { signedUrl: 'https://signed.test/object' }, error: null })),
        }));
        mockSupabase.current = client;
        Object.defineProperty(globalThis.navigator, 'onLine', { value: true, configurable: true });
        setAuthIdentityScope(accountA);
        const scope = getAuthIdentityScope();
        const internals = DiaryService as unknown as {
            _uploadAudioBlob(blob: Blob, uploadScope: AuthIdentityScope): Promise<string | null>;
        };

        const pending = internals._uploadAudioBlob(new Blob(['memo'], { type: 'audio/mp4' }), scope);
        await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
        const uploadedPath = upload.mock.calls[0][0] as string;

        setAuthIdentityScope(`audio-upload-b-${testNumber}`);
        uploaded.resolve({ error: null });

        await expect(pending).resolves.toBeNull();
        expect(remove).toHaveBeenCalledWith([uploadedPath]);
        expect(uploadedPath).toMatch(new RegExp(`^${accountA}/\\d+[.]m4a$`));
    });
});
