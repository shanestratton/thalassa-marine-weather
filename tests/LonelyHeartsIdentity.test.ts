import { beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { supabase } from '../services/supabase';

const photoMocks = vi.hoisted(() => ({
    compressImage: vi.fn(),
    moderatePhoto: vi.fn(),
}));

const cleanupMocks = vi.hoisted(() => ({
    capture: vi.fn(),
    retain: vi.fn(),
    retire: vi.fn(),
}));

vi.mock('../services/ProfilePhotoService', () => ({
    compressImage: photoMocks.compressImage,
    moderatePhoto: photoMocks.moderatePhoto,
}));

vi.mock('../services/OwnedMediaCleanupService', () => ({
    captureOwnedMediaAuthorization: cleanupMocks.capture,
    retainUncertainOwnedMedia: cleanupMocks.retain,
    retireOwnedMedia: cleanupMocks.retire,
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
    for (const method of [
        'select',
        'insert',
        'update',
        'upsert',
        'delete',
        'eq',
        'neq',
        'in',
        'not',
        'gte',
        'limit',
        'or',
        'order',
    ]) {
        query[method] = vi.fn().mockReturnValue(query);
    }
    query.single = vi.fn().mockReturnValue(promise);
    query.maybeSingle = vi.fn().mockReturnValue(promise);
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
        cleanupMocks.capture.mockReset().mockResolvedValue({ ownerId: 'account-a', accessToken: 'token-a' });
        cleanupMocks.retain.mockReset().mockReturnValue(true);
        cleanupMocks.retire.mockReset().mockResolvedValue(true);
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

    it('retires the exact private Crew List object when identity changes after upload', async () => {
        const profileQuery = queryFor({
            data: {
                user_id: 'account-a',
                crew_photo_path: null,
                crew_photo_paths: [],
                photos: [],
                skills: [],
                vibe: [],
                languages: [],
                interests: [],
            },
            error: null,
        });
        from.mockReturnValue(profileQuery);
        const uploaded = deferred<{ error: null }>();
        const upload = vi.fn().mockReturnValue(uploaded.promise);
        const remove = vi.fn().mockResolvedValue({ error: null });
        storageFrom.mockReturnValue({ upload, remove });

        const pending = LonelyHeartsService.uploadCrewPhoto(new File(['raw'], 'crew.jpg', { type: 'image/jpeg' }));
        await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
        const uploadedPath = upload.mock.calls[0][0] as string;

        setAuthIdentityScope('account-b');
        uploaded.resolve({ error: null });

        await expect(pending).resolves.toEqual({ success: false, error: 'Account changed' });
        expect(cleanupMocks.retire).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'account-a' }),
            { ownerId: 'account-a', accessToken: 'token-a' },
            'crew-list-photos',
            uploadedPath,
        );
        expect(remove).not.toHaveBeenCalled();
        expect(uploadedPath).toMatch(/^account-a\/.+[.]jpg$/);
        expect(profileQuery.upsert).not.toHaveBeenCalled();
    });

    it('halts an account-A dating photo chain after upload without reading or writing B profile', async () => {
        const uploaded = deferred<{ error: null }>();
        const upload = vi.fn().mockReturnValue(uploaded.promise);
        const remove = vi.fn().mockResolvedValue({ error: null });
        storageFrom.mockReturnValue({
            upload,
            remove,
            getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://example.test/a.jpg' } }),
        });
        const profileQuery = queryFor({
            data: {
                user_id: 'account-a',
                photos: [],
                interests: [],
            },
            error: null,
        });
        from.mockReturnValue(profileQuery);
        const file = new File(['raw'], 'dating.jpg', { type: 'image/jpeg' });

        const pending = LonelyHeartsService.uploadDatingPhoto(file, 2);
        await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
        expect(upload.mock.calls[0][0]).toMatch(/^dating\/account-a\/2_/);

        setAuthIdentityScope('account-b');
        uploaded.resolve({ error: null });

        await expect(pending).resolves.toEqual({ success: false, error: 'Account changed' });
        expect(cleanupMocks.retire).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'account-a' }),
            { ownerId: 'account-a', accessToken: 'token-a' },
            'chat-avatars',
            upload.mock.calls[0][0],
        );
        expect(remove).not.toHaveBeenCalled();
        expect(from).toHaveBeenCalledTimes(1);
        expect(profileQuery.upsert).not.toHaveBeenCalled();
    });

    it('retires the old Crew List primary only after the exact owner row adopts its replacement', async () => {
        const oldPrimary = 'account-a/old-primary.jpg';
        const profileQuery = queryFor({
            data: {
                user_id: 'account-a',
                crew_photo_path: oldPrimary,
                crew_photo_paths: [oldPrimary, 'account-a/extra.jpg'],
                skills: [],
                vibe: [],
                languages: [],
                interests: [],
            },
            error: null,
        });
        const upsert = vi.fn((payload: Record<string, unknown>) =>
            queryFor({
                data: {
                    user_id: 'account-a',
                    crew_photo_path: payload.crew_photo_path,
                    crew_photo_paths: payload.crew_photo_paths,
                },
                error: null,
            }),
        );
        let tableCall = 0;
        from.mockImplementation(() => {
            tableCall += 1;
            return tableCall === 1 ? profileQuery : { upsert };
        });
        const upload = vi.fn().mockResolvedValue({ error: null });
        const createSignedUrls = vi.fn((paths: string[]) =>
            Promise.resolve({ data: [{ path: paths[0], signedUrl: 'https://signed.test/new' }], error: null }),
        );
        storageFrom.mockReturnValue({ upload, createSignedUrls });

        const result = await LonelyHeartsService.uploadCrewPhoto(new File(['raw'], 'crew.jpg'), {
            persistPrimary: true,
        });

        expect(result).toMatchObject({ success: true, url: 'https://signed.test/new' });
        const freshPath = upload.mock.calls[0][0] as string;
        expect(upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                user_id: 'account-a',
                crew_photo_path: freshPath,
                crew_photo_paths: [freshPath, 'account-a/extra.jpg'],
            }),
            { onConflict: 'user_id' },
        );
        expect(cleanupMocks.retire).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'account-a' }),
            { ownerId: 'account-a', accessToken: 'token-a' },
            'crew-list-photos',
            oldPrimary,
        );
        expect(cleanupMocks.retire).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            'crew-list-photos',
            freshPath,
        );
    });

    it('retains Crew List reference reconciliation when the adoption response is lost', async () => {
        const oldPrimary = 'account-a/old-primary.jpg';
        const profileQuery = queryFor({
            data: {
                user_id: 'account-a',
                crew_photo_path: oldPrimary,
                crew_photo_paths: [oldPrimary],
                skills: [],
                vibe: [],
                languages: [],
                interests: [],
            },
            error: null,
        });
        const upsert = vi.fn().mockReturnValue({
            select: vi.fn().mockReturnValue({
                maybeSingle: vi.fn().mockRejectedValue(new Error('response lost after commit')),
            }),
        });
        let tableCall = 0;
        from.mockImplementation(() => {
            tableCall += 1;
            return tableCall === 1 ? profileQuery : { upsert };
        });
        const upload = vi.fn().mockResolvedValue({ error: null });
        storageFrom.mockReturnValue({
            upload,
            createSignedUrls: vi.fn().mockResolvedValue({
                data: [{ path: oldPrimary, signedUrl: 'https://signed.test/old' }],
                error: null,
            }),
        });

        await expect(LonelyHeartsService.uploadCrewPhoto(new File(['raw'], 'crew.jpg'))).resolves.toEqual({
            success: false,
            error: 'response lost after commit',
        });

        const freshPath = upload.mock.calls[0][0] as string;
        expect(cleanupMocks.retain).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'account-a' }),
            'crew-list-photos',
            freshPath,
            { kind: 'crew-photo' },
        );
        expect(cleanupMocks.retain).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'account-a' }),
            'crew-list-photos',
            oldPrimary,
            { kind: 'crew-photo' },
        );
        expect(cleanupMocks.retire).not.toHaveBeenCalled();
    });

    it('retires old minus new dating objects after an exact owner-row replacement', async () => {
        const oldUrl = 'https://example.supabase.co/storage/v1/object/public/chat-avatars/dating/account-a/0_old.jpg';
        const newUrl = 'https://example.supabase.co/storage/v1/object/public/chat-avatars/dating/account-a/0_new.jpg';
        const profileQuery = queryFor({
            data: { user_id: 'account-a', photos: [oldUrl], interests: [] },
            error: null,
        });
        const upsert = vi.fn((payload: Record<string, unknown>) =>
            queryFor({ data: { user_id: 'account-a', photos: payload.photos }, error: null }),
        );
        let tableCall = 0;
        from.mockImplementation(() => {
            tableCall += 1;
            return tableCall === 1 ? profileQuery : { upsert };
        });
        const upload = vi.fn().mockResolvedValue({ error: null });
        storageFrom.mockReturnValue({
            upload,
            getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: newUrl } }),
        });

        await expect(LonelyHeartsService.uploadDatingPhoto(new File(['raw'], 'dating.jpg'), 0)).resolves.toEqual({
            success: true,
            url: newUrl,
        });

        expect(cleanupMocks.retire).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'account-a' }),
            { ownerId: 'account-a', accessToken: 'token-a' },
            'chat-avatars',
            'dating/account-a/0_old.jpg',
        );
        expect(cleanupMocks.retain).not.toHaveBeenCalled();
    });

    it('commits and reads back dating removal before retiring the removed public object', async () => {
        const removedUrl =
            'https://example.supabase.co/storage/v1/object/public/chat-avatars/dating/account-a/0_old.jpg';
        const retainedUrl =
            'https://example.supabase.co/storage/v1/object/public/chat-avatars/dating/account-a/1_keep.jpg';
        const profileQuery = queryFor({
            data: { user_id: 'account-a', photos: [removedUrl, retainedUrl], interests: [] },
            error: null,
        });
        const maybeSingle = vi.fn().mockResolvedValue({
            data: { user_id: 'account-a', photos: [retainedUrl] },
            error: null,
        });
        const select = vi.fn().mockReturnValue({ maybeSingle });
        const eq = vi.fn().mockReturnValue({ select });
        const update = vi.fn().mockReturnValue({ eq });
        let tableCall = 0;
        from.mockImplementation(() => {
            tableCall += 1;
            return tableCall === 1 ? profileQuery : { update };
        });

        await expect(LonelyHeartsService.removeDatingPhoto(0)).resolves.toBe(true);

        expect(update).toHaveBeenCalledWith(expect.objectContaining({ photos: [retainedUrl] }));
        expect(eq).toHaveBeenCalledWith('user_id', 'account-a');
        expect(cleanupMocks.retire).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'account-a' }),
            { ownerId: 'account-a', accessToken: 'token-a' },
            'chat-avatars',
            'dating/account-a/0_old.jpg',
        );
        expect(maybeSingle.mock.invocationCallOrder[0]).toBeLessThan(cleanupMocks.retire.mock.invocationCallOrder[0]);
    });

    it('rejects an affected-row mismatch and reconciles rather than deleting dating media', async () => {
        const removedUrl =
            'https://example.supabase.co/storage/v1/object/public/chat-avatars/dating/account-a/0_old.jpg';
        const profileQuery = queryFor({
            data: { user_id: 'account-a', photos: [removedUrl], interests: [] },
            error: null,
        });
        const update = vi.fn().mockReturnValue(
            queryFor({
                data: { user_id: 'account-b', photos: [] },
                error: null,
            }),
        );
        let tableCall = 0;
        from.mockImplementation(() => {
            tableCall += 1;
            return tableCall === 1 ? profileQuery : { update };
        });

        await expect(LonelyHeartsService.removeDatingPhoto(0)).resolves.toBe(false);
        expect(cleanupMocks.retire).not.toHaveBeenCalled();
        expect(cleanupMocks.retain).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'account-a' }),
            'chat-avatars',
            'dating/account-a/0_old.jpg',
            { kind: 'dating-photo' },
        );
    });

    it('does not let a stale account-A accepted-introduction lookup reach its Crew List conversation', async () => {
        const acceptedIntro = deferred<{ data: Record<string, unknown>; error: null }>();
        const requestQuery = queryFor(acceptedIntro.promise);
        from.mockImplementation((table: string) => {
            if (table === 'crew_intro_requests') return requestQuery;
            throw new Error(`A stale Crew List intro lookup reached ${table}`);
        });

        const pending = LonelyHeartsService.getCrewIntroMessages('intro-a');
        await vi.waitFor(() => expect(requestQuery.maybeSingle).toHaveBeenCalledOnce());

        setAuthIdentityScope('account-b');
        acceptedIntro.resolve({
            data: {
                id: 'intro-a',
                sender_id: 'account-a',
                recipient_id: 'target-a',
                status: 'accepted',
            },
            error: null,
        });

        await expect(pending).resolves.toEqual([]);
        expect(from).toHaveBeenCalledTimes(1);
        expect(from).toHaveBeenCalledWith('crew_intro_requests');
    });

    it('does not let a stale account-A conversation resolution write a Crew List message for B', async () => {
        const conversationResult = deferred<{ data: Record<string, unknown>; error: null }>();
        const requestQuery = queryFor({
            data: {
                id: 'intro-a',
                sender_id: 'account-a',
                recipient_id: 'target-a',
                status: 'accepted',
            },
            error: null,
        });
        const conversationQuery = queryFor(conversationResult.promise);
        from.mockImplementation((table: string) => {
            if (table === 'crew_intro_requests') return requestQuery;
            if (table === 'crew_intro_conversations') return conversationQuery;
            throw new Error(`A stale Crew List message send reached ${table}`);
        });

        const pending = LonelyHeartsService.sendCrewIntroMessage('intro-a', 'A private hello');
        await vi.waitFor(() => expect(conversationQuery.maybeSingle).toHaveBeenCalledOnce());

        setAuthIdentityScope('account-b');
        conversationResult.resolve({
            data: {
                id: 'conversation-a',
                intro_request_id: 'intro-a',
                participant_one_id: 'account-a',
                participant_two_id: 'target-a',
                created_at: '2026-07-27T00:00:00.000Z',
            },
            error: null,
        });

        await expect(pending).resolves.toBeNull();
        expect(from).toHaveBeenCalledTimes(2);
        expect(from).toHaveBeenCalledWith('crew_intro_requests');
        expect(from).toHaveBeenCalledWith('crew_intro_conversations');
    });
});
