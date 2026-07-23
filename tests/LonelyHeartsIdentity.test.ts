import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { supabase } from '../services/supabase';

const photoMocks = vi.hoisted(() => ({
    compressImage: vi.fn(),
    moderatePhoto: vi.fn(),
}));

vi.mock('../services/ProfilePhotoService', () => ({
    compressImage: photoMocks.compressImage,
    moderatePhoto: photoMocks.moderatePhoto,
}));

import { LonelyHeartsService } from '../services/LonelyHeartsService';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function queryFor<T>(result: T | Promise<T>) {
    const promise = Promise.resolve(result);
    const query: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ['select', 'insert', 'update', 'upsert', 'delete', 'eq', 'neq', 'in', 'not', 'gte', 'limit']) {
        query[method] = vi.fn().mockReturnValue(query);
    }
    query.single = vi.fn().mockReturnValue(promise);
    query.then = vi.fn((resolve, reject) => promise.then(resolve, reject));
    return query;
}

const authUser = (id: string) => ({
    data: { user: { id } },
    error: null,
});

describe('LonelyHeartsService identity isolation', () => {
    const getUser = supabase!.auth.getUser as ReturnType<typeof vi.fn>;
    const getSession = supabase!.auth.getSession as ReturnType<typeof vi.fn>;
    const from = supabase!.from as ReturnType<typeof vi.fn>;
    const storageFrom = supabase!.storage.from as ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        getUser.mockReset().mockResolvedValue(authUser('account-a'));
        getSession.mockReset().mockResolvedValue({ data: { session: null }, error: null });
        from.mockReset();
        storageFrom.mockReset().mockReturnValue({
            upload: vi.fn().mockResolvedValue({ error: null }),
            getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://example.test/photo.jpg' } }),
        });
        photoMocks.compressImage.mockReset().mockResolvedValue(new Blob(['photo'], { type: 'image/jpeg' }));
        photoMocks.moderatePhoto.mockReset().mockResolvedValue({ verdict: 'approved' });
    });

    it('makes deferred init stateless and never falls back to a cached session', async () => {
        const authA = deferred<ReturnType<typeof authUser>>();
        getUser.mockReturnValueOnce(authA.promise);

        const pendingInit = LonelyHeartsService.init();
        setAuthIdentityScope('account-b');
        authA.resolve(authUser('account-a'));
        await pendingInit;

        expect(getSession).not.toHaveBeenCalled();

        getUser.mockResolvedValue(authUser('account-b'));
        const profileQuery = queryFor({
            data: {
                user_id: 'account-b',
                first_name: 'B',
                skills: [],
                vibe: [],
                languages: [],
                interests: [],
                photos: [],
            },
            error: null,
        });
        from.mockReturnValue(profileQuery);

        const profile = await LonelyHeartsService.getCrewProfile();
        expect(profile?.user_id).toBe('account-b');
        expect(profileQuery.eq).toHaveBeenCalledWith('user_id', 'account-b');
    });

    it('drops a deferred account-A self profile and validates the returned owner row', async () => {
        const profileResult = deferred<{ data: Record<string, unknown>; error: null }>();
        const profileQuery = queryFor(profileResult.promise);
        from.mockReturnValue(profileQuery);

        const pending = LonelyHeartsService.getCrewProfile();
        await vi.waitFor(() => expect(profileQuery.single).toHaveBeenCalledOnce());
        setAuthIdentityScope('account-b');
        profileResult.resolve({
            data: {
                user_id: 'account-a',
                first_name: 'A secret',
                skills: [],
                vibe: [],
                languages: [],
                interests: [],
                photos: [],
            },
            error: null,
        });

        await expect(pending).resolves.toBeNull();

        setAuthIdentityScope('account-a');
        getUser.mockResolvedValue(authUser('account-a'));
        const wrongOwnerQuery = queryFor({
            data: { user_id: 'account-b', photos: [], interests: [] },
            error: null,
        });
        from.mockReturnValue(wrongOwnerQuery);
        await expect(LonelyHeartsService.getDatingProfile()).resolves.toBeNull();
    });

    it('preserves anonymous public target-profile reads without treating them as self reads', async () => {
        setAuthIdentityScope(null);
        getUser.mockClear();
        const publicQuery = queryFor({
            data: {
                user_id: 'public-sailor',
                first_name: 'Public',
                photos: [],
                interests: [],
            },
            error: null,
        });
        from.mockReturnValue(publicQuery);

        const profile = await LonelyHeartsService.getDatingProfile('public-sailor');

        expect(profile?.user_id).toBe('public-sailor');
        expect(publicQuery.eq).toHaveBeenCalledWith('user_id', 'public-sailor');
        expect(getUser).not.toHaveBeenCalled();
    });

    it('does not start an A mutation after auth resolves under B and always pins payload ownership', async () => {
        const authA = deferred<ReturnType<typeof authUser>>();
        getUser.mockReturnValueOnce(authA.promise);

        const staleUpdate = LonelyHeartsService.updateCrewProfile({ bio: 'A secret' });
        setAuthIdentityScope('account-b');
        authA.resolve(authUser('account-a'));

        await expect(staleUpdate).resolves.toBe(false);
        expect(from).not.toHaveBeenCalled();

        setAuthIdentityScope('account-a');
        getUser.mockResolvedValue(authUser('account-a'));
        const updateQuery = queryFor({ error: null });
        from.mockReturnValue(updateQuery);
        const hostileUpdates = { bio: 'Safe', user_id: 'account-b' } as never;

        await expect(LonelyHeartsService.updateCrewProfile(hostileUpdates)).resolves.toBe(true);
        expect(updateQuery.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ bio: 'Safe', user_id: 'account-a' }),
            { onConflict: 'user_id' },
        );
    });

    it('snapshots mutable profile updates before awaiting authentication', async () => {
        const authA = deferred<ReturnType<typeof authUser>>();
        getUser.mockReturnValue(authA.promise);
        const updateQuery = queryFor({ error: null });
        from.mockReturnValue(updateQuery);
        const updates = { interests: ['Original'] };

        const pending = LonelyHeartsService.updateDatingProfile(updates);
        updates.interests.push('Mutated during auth');
        authA.resolve(authUser('account-a'));

        await expect(pending).resolves.toBe(true);
        expect(updateQuery.upsert).toHaveBeenCalledWith(
            expect.objectContaining({ user_id: 'account-a', interests: ['Original'] }),
            { onConflict: 'user_id' },
        );
    });

    it('owner-binds reports and returns false when an A report completes under B', async () => {
        const reportWrite = deferred<{ error: null }>();
        const reportQuery = queryFor(reportWrite.promise);
        from.mockReturnValue(reportQuery);

        const pending = LonelyHeartsService.reportUser('target-1', '  Safety concern  ');
        await vi.waitFor(() => expect(reportQuery.insert).toHaveBeenCalledOnce());
        expect(reportQuery.insert).toHaveBeenCalledWith(
            expect.objectContaining({
                reporter_id: 'account-a',
                reported_id: 'target-1',
                reason: 'Safety concern',
            }),
        );

        setAuthIdentityScope('account-b');
        reportWrite.resolve({ error: null });
        await expect(pending).resolves.toBe(false);
    });

    it('stops an A like before the mutual-match stage and owner-binds the written like', async () => {
        const likeWrite = deferred<{ error: null }>();
        const likeQuery = queryFor(likeWrite.promise);
        from.mockReturnValue(likeQuery);

        const pending = LonelyHeartsService.recordLike('target-1', true);
        await vi.waitFor(() => expect(likeQuery.upsert).toHaveBeenCalledOnce());
        expect(likeQuery.upsert).toHaveBeenCalledWith(
            { liker_id: 'account-a', liked_id: 'target-1', is_like: true },
            { onConflict: 'liker_id,liked_id' },
        );

        setAuthIdentityScope('account-b');
        likeWrite.resolve({ error: null });

        await expect(pending).resolves.toEqual({ matched: false });
        expect(from).toHaveBeenCalledTimes(1);
    });

    it('does not let an A super-like continue to its message update after switching to B', async () => {
        const mutualResult = deferred<{ data: { id: string }; error: null }>();
        let likesCall = 0;
        from.mockImplementation((table: string) => {
            expect(table).toBe('sailor_likes');
            likesCall += 1;
            if (likesCall === 1) return queryFor({ error: null });
            if (likesCall === 2) return queryFor(mutualResult.promise);
            throw new Error('Stale super-like reached its message update');
        });

        const pending = LonelyHeartsService.recordSuperLike('target-1', 'A private note');
        await vi.waitFor(() => expect(likesCall).toBe(2));
        setAuthIdentityScope('account-b');
        mutualResult.resolve({ data: { id: 'mutual-like' }, error: null });

        await expect(pending).resolves.toEqual({ matched: false });
        expect(from).toHaveBeenCalledTimes(2);
    });

    it('stops a multi-stage A browse before fetching private profile details', async () => {
        const blockedQuery = queryFor({ data: [], error: null });
        const chatResult = deferred<{ data: Record<string, unknown>[]; error: null }>();
        const chatQuery = queryFor(chatResult.promise);
        from.mockImplementation((table: string) => {
            if (table === 'sailor_blocks') return blockedQuery;
            if (table === 'chat_profiles') return chatQuery;
            throw new Error(`Unexpected table: ${table}`);
        });

        const pending = LonelyHeartsService.getDatingProfilesToBrowse();
        await vi.waitFor(() => expect(chatQuery.limit).toHaveBeenCalledWith(100));
        expect(chatQuery.neq).toHaveBeenCalledWith('user_id', 'account-a');

        setAuthIdentityScope('account-b');
        chatResult.resolve({
            data: [{ user_id: 'target-a', display_name: 'A result' }],
            error: null,
        });

        await expect(pending).resolves.toEqual([]);
        expect(from).toHaveBeenCalledTimes(2);
    });

    it('stops a multi-stage A match load before profile enrichment', async () => {
        const theirLikes = deferred<{ data: { liker_id: string; created_at: string }[]; error: null }>();
        let likesCall = 0;
        from.mockImplementation((table: string) => {
            if (table === 'sailor_blocks') return queryFor({ data: [], error: null });
            if (table === 'sailor_likes') {
                likesCall += 1;
                if (likesCall === 1) {
                    return queryFor({
                        data: [{ liked_id: 'target-1', created_at: '2026-01-01T00:00:00.000Z' }],
                        error: null,
                    });
                }
                return queryFor(theirLikes.promise);
            }
            throw new Error(`Unexpected enrichment table: ${table}`);
        });

        const pending = LonelyHeartsService.getMatches();
        await vi.waitFor(() => expect(likesCall).toBe(2));
        setAuthIdentityScope('account-b');
        theirLikes.resolve({
            data: [{ liker_id: 'target-1', created_at: '2026-01-02T00:00:00.000Z' }],
            error: null,
        });

        await expect(pending).resolves.toEqual([]);
        expect(from).toHaveBeenCalledTimes(3);
    });

    it('halts an account-A crew photo chain after deferred compression', async () => {
        const compressed = deferred<Blob>();
        photoMocks.compressImage.mockReturnValue(compressed.promise);
        const file = new File(['raw'], 'crew.jpg', { type: 'image/jpeg' });

        const pending = LonelyHeartsService.uploadCrewPhoto(file);
        await vi.waitFor(() => expect(photoMocks.compressImage).toHaveBeenCalledWith(file));
        setAuthIdentityScope('account-b');
        compressed.resolve(new Blob(['compressed'], { type: 'image/jpeg' }));

        await expect(pending).resolves.toEqual({ success: false, error: 'Account changed' });
        expect(photoMocks.moderatePhoto).not.toHaveBeenCalled();
        expect(storageFrom).not.toHaveBeenCalled();
        expect(from).not.toHaveBeenCalled();
    });

    it('halts an account-A dating photo chain after upload without reading or writing B profile', async () => {
        const uploaded = deferred<{ error: null }>();
        const upload = vi.fn().mockReturnValue(uploaded.promise);
        storageFrom.mockReturnValue({
            upload,
            getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://example.test/a.jpg' } }),
        });
        const file = new File(['raw'], 'dating.jpg', { type: 'image/jpeg' });

        const pending = LonelyHeartsService.uploadDatingPhoto(file, 2);
        await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
        expect(upload.mock.calls[0][0]).toMatch(/^dating\/account-a\/2_/);

        setAuthIdentityScope('account-b');
        uploaded.resolve({ error: null });

        await expect(pending).resolves.toEqual({ success: false, error: 'Account changed' });
        expect(from).not.toHaveBeenCalled();
    });
});
