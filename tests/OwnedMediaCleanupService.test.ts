import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    setAuthIdentityScope,
    type AuthIdentityScope,
} from '../services/authIdentityScope';

const OWNER_A = '11111111-1111-4111-8111-111111111111';
const OWNER_B = '99999999-9999-4999-8999-999999999999';
const RECIPE_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_RECIPE_ID = '33333333-3333-4333-8333-333333333333';
const CLEANUP_KEY = 'thalassa_owned_media_cleanup_v1';

type QueryResult = { data: Record<string, unknown> | null; error: { message: string } | null };

const supabaseMocks = vi.hoisted(() => {
    const getSession = vi.fn();
    const getUser = vi.fn();
    const read = vi.fn<(table: string, filters: Array<[string, unknown]>) => Promise<QueryResult>>();
    const remove = vi.fn();

    const from = vi.fn((table: string) => {
        const filters: Array<[string, unknown]> = [];
        const query = {
            select: vi.fn(() => query),
            eq: vi.fn((column: string, value: unknown) => {
                filters.push([column, value]);
                return query;
            }),
            maybeSingle: vi.fn(() => read(table, filters)),
        };
        return query;
    });

    const storageFrom = vi.fn((bucket: string) => ({
        remove: (paths: string[]) => remove(bucket, paths),
    }));

    return { from, getSession, getUser, read, remove, storageFrom };
});

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: {
            getSession: supabaseMocks.getSession,
            getUser: supabaseMocks.getUser,
        },
        from: supabaseMocks.from,
        storage: { from: supabaseMocks.storageFrom },
    },
    supabaseAnonKey: 'test-anon-key',
    supabaseUrl: 'https://test.supabase.co',
}));

import {
    captureOwnedMediaAuthorization,
    reconcileOwnedMediaCleanup,
    retainUncertainOwnedMedia,
    retireOwnedMedia,
    type OwnedMediaCleanupJob,
    type OwnedMediaReference,
} from '../services/OwnedMediaCleanupService';

function storageKey(scope: AuthIdentityScope): string {
    return authScopedStorageKey(CLEANUP_KEY, scope);
}

function readQueue(scope: AuthIdentityScope): OwnedMediaCleanupJob[] {
    return JSON.parse(localStorage.getItem(storageKey(scope)) || '[]') as OwnedMediaCleanupJob[];
}

function writeQueue(scope: AuthIdentityScope, jobs: OwnedMediaCleanupJob[]): void {
    localStorage.setItem(storageKey(scope), JSON.stringify(jobs));
}

function job(
    scope: AuthIdentityScope,
    bucket: OwnedMediaCleanupJob['bucket'],
    path: string,
    reference: OwnedMediaReference,
    createdAt: number,
): OwnedMediaCleanupJob {
    return { ownerId: scope.userId!, bucket, path, reference, createdAt };
}

function storageUrl(bucket: OwnedMediaCleanupJob['bucket'], path: string): string {
    return `https://test.supabase.co/storage/v1/object/public/${bucket}/${path}`;
}

function canonicalRows(rows: Record<string, Record<string, unknown> | null>) {
    return rows;
}

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

async function settleQueuedReconciliation(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

describe('OwnedMediaCleanupService', () => {
    let scopeA: AuthIdentityScope;

    beforeEach(async () => {
        localStorage.clear();
        vi.clearAllMocks();
        supabaseMocks.getUser.mockResolvedValue({ data: { user: { id: OWNER_A } }, error: null });
        supabaseMocks.getSession.mockResolvedValue({
            data: { session: { access_token: 'token-a', user: { id: OWNER_A } } },
            error: null,
        });
        supabaseMocks.read.mockResolvedValue({ data: null, error: null });
        supabaseMocks.remove.mockResolvedValue({ error: null });
        setAuthIdentityScope(null);
        scopeA = setAuthIdentityScope(OWNER_A);
        await settleQueuedReconciliation();
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        setAuthIdentityScope(null);
    });

    it('keeps retry jobs owner-scoped and rejects mismatched reference/path contracts', () => {
        const avatarPath = `${OWNER_A}/avatar-1.jpg`;
        setAuthIdentityScope(OWNER_B);

        expect(retainUncertainOwnedMedia(scopeA, 'chat-avatars', avatarPath, { kind: 'chat-profile-avatar' })).toBe(
            true,
        );
        expect(
            retainUncertainOwnedMedia(scopeA, 'chat-avatars', `${OWNER_B}/avatar.jpg`, {
                kind: 'chat-profile-avatar',
            }),
        ).toBe(false);
        expect(
            retainUncertainOwnedMedia(scopeA, 'chat-avatars', `${OWNER_A}/`, {
                kind: 'chat-profile-avatar',
            }),
        ).toBe(false);
        expect(
            retainUncertainOwnedMedia(scopeA, 'chat-avatars', `dating/${OWNER_A}/dating.jpg`, {
                kind: 'chat-profile-avatar',
            }),
        ).toBe(false);
        expect(
            retainUncertainOwnedMedia(scopeA, 'crew-list-photos', `${OWNER_A}/crew.jpg`, {
                kind: 'dating-photo',
            }),
        ).toBe(false);
        expect(
            retainUncertainOwnedMedia(scopeA, 'recipe-photos', `${OWNER_A}/${OTHER_RECIPE_ID}.jpg`, {
                kind: 'recipe-photo',
                recipeId: RECIPE_ID,
            }),
        ).toBe(false);

        expect(readQueue(scopeA)).toEqual([
            expect.objectContaining({
                ownerId: OWNER_A,
                bucket: 'chat-avatars',
                path: avatarPath,
                reference: { kind: 'chat-profile-avatar' },
            }),
        ]);
        expect(localStorage.getItem(authScopedStorageKey(CLEANUP_KEY, getAuthIdentityScope()))).toBeNull();
    });

    it('uses a captured A token after an A-to-B switch without persisting it', async () => {
        const fetchMock = vi.fn().mockResolvedValue({ ok: true });
        vi.stubGlobal('fetch', fetchMock);
        setAuthIdentityScope(OWNER_B);

        await expect(
            retireOwnedMedia(
                scopeA,
                { ownerId: OWNER_A, accessToken: 'captured-secret-token' },
                'chat-avatars',
                `${OWNER_A}/avatar-1.jpg`,
            ),
        ).resolves.toBe(true);

        expect(fetchMock).toHaveBeenCalledWith(
            'https://test.supabase.co/storage/v1/object/chat-avatars',
            expect.objectContaining({
                method: 'DELETE',
                headers: expect.objectContaining({ Authorization: 'Bearer captured-secret-token' }),
                body: JSON.stringify({ prefixes: [`${OWNER_A}/avatar-1.jpg`] }),
            }),
        );
        expect(localStorage.getItem(storageKey(scopeA))).toBeNull();
    });

    it('persists a token-free retry when captured-token deletion fails', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false }));
        setAuthIdentityScope(OWNER_B);

        await expect(
            retireOwnedMedia(
                scopeA,
                { ownerId: OWNER_A, accessToken: 'captured-secret-token' },
                'crew-list-photos',
                `${OWNER_A}/crew.jpg`,
            ),
        ).resolves.toBe(false);

        const persisted = localStorage.getItem(storageKey(scopeA));
        expect(persisted).not.toContain('captured-secret-token');
        expect(JSON.parse(persisted || '[]')).toEqual([
            expect.objectContaining({
                ownerId: OWNER_A,
                bucket: 'crew-list-photos',
                path: `${OWNER_A}/crew.jpg`,
                reference: { kind: 'unreferenced' },
            }),
        ]);
    });

    it('captures authorization only while the session and identity still match', async () => {
        await expect(captureOwnedMediaAuthorization(scopeA)).resolves.toEqual({
            ownerId: OWNER_A,
            accessToken: 'token-a',
        });

        const session = deferred<{
            data: { session: { access_token: string; user: { id: string } } };
            error: null;
        }>();
        supabaseMocks.getSession.mockReturnValueOnce(session.promise);
        const pending = captureOwnedMediaAuthorization(scopeA);
        setAuthIdentityScope(OWNER_B);
        session.resolve({
            data: { session: { access_token: 'late-token-a', user: { id: OWNER_A } } },
            error: null,
        });

        await expect(pending).resolves.toBeNull();
        supabaseMocks.getSession.mockRejectedValueOnce(new Error('native auth unavailable'));
        const scopeB = getAuthIdentityScope();
        await expect(captureOwnedMediaAuthorization(scopeB)).resolves.toBeNull();
    });

    it.each([
        {
            label: 'profile avatar URL',
            bucket: 'chat-avatars' as const,
            path: `${OWNER_A}/avatar.jpg`,
            reference: { kind: 'chat-profile-avatar' } as const,
            rows: canonicalRows({
                chat_profiles: { avatar_url: storageUrl('chat-avatars', `${OWNER_A}/avatar.jpg`) },
            }),
        },
        {
            label: 'dating photo URL array',
            bucket: 'chat-avatars' as const,
            path: `dating/${OWNER_A}/0.jpg`,
            reference: { kind: 'dating-photo' } as const,
            rows: canonicalRows({
                sailor_dating_profiles: {
                    photos: [storageUrl('chat-avatars', `dating/${OWNER_A}/0.jpg`)],
                },
            }),
        },
        {
            label: 'Crew List direct path array',
            bucket: 'crew-list-photos' as const,
            path: `${OWNER_A}/crew.jpg`,
            reference: { kind: 'crew-photo' } as const,
            rows: canonicalRows({
                sailor_crew_profiles: {
                    crew_photo_path: `${OWNER_A}/crew.jpg`,
                    crew_photo_paths: [`${OWNER_A}/crew.jpg`],
                },
            }),
        },
        {
            label: 'recipe photo URL',
            bucket: 'recipe-photos' as const,
            path: `${OWNER_A}/${RECIPE_ID}.jpg`,
            reference: { kind: 'recipe-photo', recipeId: RECIPE_ID } as const,
            rows: canonicalRows({
                community_recipes: {
                    image_url: storageUrl('recipe-photos', `${OWNER_A}/${RECIPE_ID}.jpg`),
                },
                recipes: null,
            }),
        },
    ])('retires a $label ticket without deleting referenced bytes', async ({ bucket, path, reference, rows }) => {
        writeQueue(scopeA, [job(scopeA, bucket, path, reference, 1)]);
        supabaseMocks.read.mockImplementation(async (table) => ({
            data: rows[table] ?? null,
            error: null,
        }));

        await reconcileOwnedMediaCleanup(scopeA);

        expect(supabaseMocks.remove).not.toHaveBeenCalled();
        expect(readQueue(scopeA)).toEqual([]);
    });

    it('deletes only a positively unreferenced exact path and retries a Storage error', async () => {
        const path = `${OWNER_A}/avatar-old.jpg`;
        writeQueue(scopeA, [job(scopeA, 'chat-avatars', path, { kind: 'chat-profile-avatar' }, 1)]);
        supabaseMocks.read.mockResolvedValue({
            data: { avatar_url: storageUrl('chat-avatars', `${OWNER_A}/avatar-current.jpg`) },
            error: null,
        });
        supabaseMocks.remove.mockResolvedValueOnce({ error: { message: 'offline' } });

        await reconcileOwnedMediaCleanup(scopeA);
        expect(readQueue(scopeA)).toHaveLength(1);

        await reconcileOwnedMediaCleanup(scopeA);
        expect(supabaseMocks.remove).toHaveBeenNthCalledWith(2, 'chat-avatars', [path]);
        expect(readQueue(scopeA)).toEqual([]);
    });

    it('fails closed when a non-empty canonical URL cannot be mapped to an exact Storage path', async () => {
        const path = `${OWNER_A}/avatar-old.jpg`;
        writeQueue(scopeA, [job(scopeA, 'chat-avatars', path, { kind: 'chat-profile-avatar' }, 1)]);
        supabaseMocks.read.mockResolvedValue({
            data: {
                avatar_url: `https://cdn.example.test/storage/v1/object/public/chat-avatars/${path}`,
            },
            error: null,
        });

        await reconcileOwnedMediaCleanup(scopeA);

        expect(supabaseMocks.remove).not.toHaveBeenCalled();
        expect(readQueue(scopeA)).toHaveLength(1);
    });

    it('does not delete or rewrite A queue state after identity changes during a canonical read', async () => {
        const path = `${OWNER_A}/avatar.jpg`;
        writeQueue(scopeA, [job(scopeA, 'chat-avatars', path, { kind: 'chat-profile-avatar' }, 1)]);
        const read = deferred<QueryResult>();
        supabaseMocks.read.mockReturnValueOnce(read.promise);

        const pending = reconcileOwnedMediaCleanup(scopeA);
        await vi.waitFor(() => expect(supabaseMocks.read).toHaveBeenCalledOnce());
        setAuthIdentityScope(OWNER_B);
        read.resolve({ data: null, error: null });
        await pending;

        expect(supabaseMocks.remove).not.toHaveBeenCalled();
        expect(readQueue(scopeA)).toHaveLength(1);
    });

    it('preserves a newer job written while an older reconciliation awaits the network', async () => {
        const oldPath = `${OWNER_A}/avatar-old.jpg`;
        const newPath = `dating/${OWNER_A}/new.jpg`;
        const oldJob = job(scopeA, 'chat-avatars', oldPath, { kind: 'chat-profile-avatar' }, 1);
        const newJob = job(scopeA, 'chat-avatars', newPath, { kind: 'dating-photo' }, 2);
        writeQueue(scopeA, [oldJob]);
        const read = deferred<QueryResult>();
        supabaseMocks.read.mockReturnValueOnce(read.promise);

        const pending = reconcileOwnedMediaCleanup(scopeA);
        await vi.waitFor(() => expect(supabaseMocks.read).toHaveBeenCalledOnce());
        writeQueue(scopeA, [oldJob, newJob]);
        read.resolve({ data: null, error: null });
        await pending;

        expect(supabaseMocks.remove).toHaveBeenCalledWith('chat-avatars', [oldPath]);
        expect(readQueue(scopeA)).toEqual([newJob]);
    });
});
