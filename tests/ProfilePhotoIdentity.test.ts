import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const mocks = vi.hoisted(() => ({
    from: vi.fn(),
    getUser: vi.fn(),
    storageFrom: vi.fn(),
    getAuthenticatedFunctionHeaders: vi.fn(),
}));

const cleanupMocks = vi.hoisted(() => ({
    capture: vi.fn(),
    retain: vi.fn(),
    retire: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: { getUser: mocks.getUser },
        from: mocks.from,
        storage: { from: mocks.storageFrom },
    },
    supabaseUrl: 'https://example.supabase.co',
}));

vi.mock('../services/supabaseAuth', () => ({
    getAuthenticatedFunctionHeaders: mocks.getAuthenticatedFunctionHeaders,
}));

vi.mock('../services/OwnedMediaCleanupService', () => ({
    captureOwnedMediaAuthorization: cleanupMocks.capture,
    retainUncertainOwnedMedia: cleanupMocks.retain,
    retireOwnedMedia: cleanupMocks.retire,
}));

import {
    getCachedAvatar,
    getProfile,
    removeProfilePhoto,
    updateProfile,
    uploadProfilePhoto,
} from '../services/ProfilePhotoService';
import type { ChatProfile } from '../services/ProfilePhotoService';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function installImageCompressionFakes() {
    class FakeFileReader {
        onload: ((event: ProgressEvent<FileReader>) => void) | null = null;
        onerror: (() => void) | null = null;

        readAsDataURL() {
            this.onload?.({
                target: { result: 'data:image/jpeg;base64,AQID' },
            } as unknown as ProgressEvent<FileReader>);
        }
    }

    class FakeImage {
        width = 128;
        height = 128;
        onload: (() => void) | null = null;
        onerror: (() => void) | null = null;

        set src(_value: string) {
            this.onload?.();
        }
    }

    vi.stubGlobal('FileReader', FakeFileReader);
    vi.stubGlobal('Image', FakeImage);
    const realCreateElement = document.createElement.bind(document);
    const compressed = {
        size: 3,
        type: 'image/jpeg',
        arrayBuffer: vi.fn().mockResolvedValue(Uint8Array.from([1, 2, 3]).buffer),
    } as unknown as Blob;
    vi.spyOn(document, 'createElement').mockImplementation(((tagName: string) => {
        if (tagName !== 'canvas') return realCreateElement(tagName);
        return {
            width: 0,
            height: 0,
            getContext: () => ({
                imageSmoothingEnabled: false,
                imageSmoothingQuality: 'low',
                drawImage: vi.fn(),
            }),
            toBlob: (callback: BlobCallback) => callback(compressed),
        } as unknown as HTMLCanvasElement;
    }) as typeof document.createElement);
}

const profile = (userId: string, avatarUrl: string): ChatProfile => ({
    user_id: userId,
    display_name: 'Sailor',
    avatar_url: avatarUrl,
    bio: null,
    vessel_name: null,
    vessel_type: null,
    home_port: null,
    looking_for_love: false,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
});

describe('ProfilePhotoService identity isolation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        mocks.getUser.mockResolvedValue({
            data: { user: { id: 'account-a' } },
            error: null,
        });
        mocks.getAuthenticatedFunctionHeaders.mockResolvedValue({
            Authorization: 'Bearer account-a',
            apikey: 'anon',
            'Content-Type': 'application/json',
        });
        cleanupMocks.capture.mockResolvedValue({ ownerId: 'account-a', accessToken: 'token-a' });
        cleanupMocks.retain.mockReturnValue(true);
        cleanupMocks.retire.mockResolvedValue(true);
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        vi.restoreAllMocks();
    });

    it('synchronously hides the previous account avatar cache', async () => {
        mocks.from.mockReturnValue({
            select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                    single: vi.fn().mockResolvedValue({
                        data: profile('public-sailor', 'https://images.test/a.jpg'),
                        error: null,
                    }),
                }),
            }),
        });

        await expect(getProfile('public-sailor')).resolves.toMatchObject({
            avatar_url: 'https://images.test/a.jpg',
        });
        expect(getCachedAvatar('public-sailor')).toBe('https://images.test/a.jpg');

        setAuthIdentityScope('account-b');

        expect(getCachedAvatar('public-sailor')).toBeNull();
    });

    it('drops a deferred A profile load without repopulating B cache', async () => {
        const query = deferred<{ data: ChatProfile; error: null }>();
        const single = vi.fn().mockReturnValue(query.promise);
        mocks.from.mockReturnValue({
            select: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({ single }),
            }),
        });

        const pending = getProfile('public-sailor');
        await vi.waitFor(() => expect(single).toHaveBeenCalledOnce());
        setAuthIdentityScope('account-b');
        query.resolve({ data: profile('public-sailor', 'https://images.test/a.jpg'), error: null });

        await expect(pending).resolves.toBeNull();
        expect(getCachedAvatar('public-sailor')).toBeNull();
    });

    it('keeps an in-flight update bound to A and reports stale completion', async () => {
        const update = deferred<{ data: null; error: null }>();
        const upsert = vi.fn().mockReturnValue(update.promise);
        mocks.from.mockReturnValue({ upsert });

        const pending = updateProfile({ display_name: 'Account A' });
        await vi.waitFor(() => expect(upsert).toHaveBeenCalledOnce());
        expect(upsert).toHaveBeenCalledWith(
            expect.objectContaining({
                user_id: 'account-a',
                display_name: 'Account A',
            }),
            { onConflict: 'user_id' },
        );

        setAuthIdentityScope('account-b');
        update.resolve({ data: null, error: null });

        await expect(pending).resolves.toBe(false);
    });

    it('stops a deferred A upload before any storage deletion or B write', async () => {
        installImageCompressionFakes();
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({
                text: '{"verdict":"approved","reason":"Safe"}',
            }),
        } as unknown as Response);
        const listing = deferred<{ data: { name: string }[]; error: null }>();
        const list = vi.fn().mockReturnValue(listing.promise);
        const remove = vi.fn().mockResolvedValue({ error: null });
        const upload = vi.fn().mockResolvedValue({ error: null });
        mocks.storageFrom.mockReturnValue({
            list,
            remove,
            upload,
            getPublicUrl: vi.fn(),
        });

        const pending = uploadProfilePhoto(new File([[1, 2, 3] as unknown as BlobPart], 'avatar.jpg'));
        await vi.waitFor(() => expect(list).toHaveBeenCalledWith('account-a'));

        setAuthIdentityScope('account-b');
        listing.resolve({ data: [{ name: 'old.jpg' }], error: null });

        await expect(pending).resolves.toEqual({
            success: false,
            error: 'Account changed during upload',
        });
        expect(remove).not.toHaveBeenCalled();
        expect(upload).not.toHaveBeenCalled();
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('retires the exact A object when identity changes after the upload lands', async () => {
        installImageCompressionFakes();
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({ text: '{"verdict":"approved","reason":"Safe"}' }),
        } as unknown as Response);
        const uploaded = deferred<{ error: null }>();
        const upload = vi.fn().mockReturnValue(uploaded.promise);
        const remove = vi.fn().mockResolvedValue({ error: null });
        mocks.storageFrom.mockReturnValue({
            list: vi.fn().mockResolvedValue({ data: [], error: null }),
            upload,
            remove,
            getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://images.test/account-a.jpg' } }),
        });

        const pending = uploadProfilePhoto(new File([[1, 2, 3] as unknown as BlobPart], 'avatar.jpg'));
        await vi.waitFor(() => expect(upload).toHaveBeenCalledOnce());
        const uploadedPath = upload.mock.calls[0][0] as string;

        setAuthIdentityScope('account-b');
        uploaded.resolve({ error: null });

        await expect(pending).resolves.toEqual({
            success: false,
            error: 'Account changed during upload',
        });
        expect(cleanupMocks.retire).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'account-a' }),
            { ownerId: 'account-a', accessToken: 'token-a' },
            'chat-avatars',
            uploadedPath,
        );
        expect(remove).not.toHaveBeenCalled();
        expect(uploadedPath).toMatch(/^account-a\/avatar-\d+[.]jpg$/);
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('retires the exact new object when the profile row rejects it', async () => {
        installImageCompressionFakes();
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({ text: '{"verdict":"approved","reason":"Safe"}' }),
        } as unknown as Response);
        const upload = vi.fn().mockResolvedValue({ error: null });
        const remove = vi.fn().mockResolvedValue({ error: null });
        mocks.storageFrom.mockReturnValue({
            list: vi.fn().mockResolvedValue({ data: [], error: null }),
            upload,
            remove,
            getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://images.test/account-a.jpg' } }),
        });
        const maybeSingle = vi.fn().mockResolvedValue({ data: null, error: { message: 'profile write rejected' } });
        mocks.from.mockReturnValue({
            upsert: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({ maybeSingle }),
            }),
        });

        await expect(uploadProfilePhoto(new File([[1, 2, 3] as unknown as BlobPart], 'avatar.jpg'))).resolves.toEqual({
            success: false,
            error: 'Could not save profile photo: profile write rejected',
        });

        const uploadedPath = upload.mock.calls[0][0] as string;
        expect(cleanupMocks.retire).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'account-a' }),
            { ownerId: 'account-a', accessToken: 'token-a' },
            'chat-avatars',
            uploadedPath,
        );
        expect(remove).not.toHaveBeenCalled();
    });

    it('retires the exact new object when a post-upload step throws', async () => {
        installImageCompressionFakes();
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({ text: '{"verdict":"approved","reason":"Safe"}' }),
        } as unknown as Response);
        const upload = vi.fn().mockResolvedValue({ error: null });
        const remove = vi.fn().mockResolvedValue({ error: null });
        mocks.storageFrom.mockReturnValue({
            list: vi.fn().mockResolvedValue({ data: [], error: null }),
            upload,
            remove,
            getPublicUrl: vi.fn(() => {
                throw new Error('URL construction failed');
            }),
        });

        await expect(uploadProfilePhoto(new File([[1, 2, 3] as unknown as BlobPart], 'avatar.jpg'))).resolves.toEqual({
            success: false,
            error: 'URL construction failed',
        });

        const uploadedPath = upload.mock.calls[0][0] as string;
        expect(cleanupMocks.retire).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'account-a' }),
            { ownerId: 'account-a', accessToken: 'token-a' },
            'chat-avatars',
            uploadedPath,
        );
        expect(remove).not.toHaveBeenCalled();
        expect(mocks.from).not.toHaveBeenCalled();
    });

    it('retains a canonical reconciliation job when the profile commit response is lost', async () => {
        installImageCompressionFakes();
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({ text: '{"verdict":"approved","reason":"Safe"}' }),
        } as unknown as Response);
        const upload = vi.fn().mockResolvedValue({ error: null });
        mocks.storageFrom.mockReturnValue({
            list: vi.fn().mockResolvedValue({ data: [{ name: 'old.jpg' }], error: null }),
            upload,
            getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl: 'https://images.test/account-a.jpg' } }),
        });
        mocks.from.mockReturnValue({
            upsert: vi.fn().mockReturnValue({
                select: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockRejectedValue(new Error('response lost after commit')),
                }),
            }),
        });

        await expect(uploadProfilePhoto(new File([[1, 2, 3] as unknown as BlobPart], 'avatar.jpg'))).resolves.toEqual({
            success: false,
            error: 'Could not verify saved profile photo: response lost after commit',
        });

        const freshPath = upload.mock.calls[0][0] as string;
        expect(cleanupMocks.retain).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'account-a' }),
            'chat-avatars',
            freshPath,
            { kind: 'chat-profile-avatar' },
        );
        expect(cleanupMocks.retain).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'account-a' }),
            'chat-avatars',
            'account-a/old.jpg',
            { kind: 'chat-profile-avatar' },
        );
        expect(cleanupMocks.retire).not.toHaveBeenCalled();
    });

    it('retires old minus new paths only after the exact owner row adopts the replacement', async () => {
        installImageCompressionFakes();
        vi.spyOn(globalThis, 'fetch').mockResolvedValue({
            ok: true,
            status: 200,
            json: vi.fn().mockResolvedValue({ text: '{"verdict":"approved","reason":"Safe"}' }),
        } as unknown as Response);
        const upload = vi.fn().mockResolvedValue({ error: null });
        const publicUrl = 'https://images.test/account-a-new.jpg';
        mocks.storageFrom.mockReturnValue({
            list: vi.fn().mockResolvedValue({ data: [{ name: 'old.jpg' }], error: null }),
            upload,
            getPublicUrl: vi.fn().mockReturnValue({ data: { publicUrl } }),
        });
        mocks.from.mockReturnValue({
            upsert: vi.fn((payload: { avatar_url: string }) => ({
                select: vi.fn().mockReturnValue({
                    maybeSingle: vi.fn().mockResolvedValue({
                        data: { user_id: 'account-a', avatar_url: payload.avatar_url },
                        error: null,
                    }),
                }),
            })),
        });

        await expect(uploadProfilePhoto(new File([[1, 2, 3] as unknown as BlobPart], 'avatar.jpg'))).resolves.toEqual({
            success: true,
            url: publicUrl,
        });

        const freshPath = upload.mock.calls[0][0] as string;
        expect(cleanupMocks.retire).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'account-a' }),
            { ownerId: 'account-a', accessToken: 'token-a' },
            'chat-avatars',
            'account-a/old.jpg',
        );
        expect(cleanupMocks.retire).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.anything(),
            'chat-avatars',
            freshPath,
        );
        expect(cleanupMocks.retain).not.toHaveBeenCalled();
    });

    it('nulls and verifies the exact profile row before retiring old avatar objects', async () => {
        const list = vi.fn().mockResolvedValue({ data: [{ name: 'old.jpg' }, { name: 'orphan.jpg' }], error: null });
        mocks.storageFrom.mockReturnValue({ list });
        const maybeSingle = vi.fn().mockResolvedValue({
            data: { user_id: 'account-a', avatar_url: null },
            error: null,
        });
        const select = vi.fn().mockReturnValue({ maybeSingle });
        const eq = vi.fn().mockReturnValue({ select });
        const update = vi.fn().mockReturnValue({ eq });
        mocks.from.mockReturnValue({ update });

        await expect(removeProfilePhoto()).resolves.toBe(true);

        expect(update).toHaveBeenCalledWith(expect.objectContaining({ avatar_url: null }));
        expect(eq).toHaveBeenCalledWith('user_id', 'account-a');
        expect(select).toHaveBeenCalledWith('user_id, avatar_url');
        expect(cleanupMocks.retire).toHaveBeenCalledTimes(2);
        expect(maybeSingle.mock.invocationCallOrder[0]).toBeLessThan(cleanupMocks.retire.mock.invocationCallOrder[0]);
    });

    it('does not accept or clean up a mutation response for another owner', async () => {
        mocks.storageFrom.mockReturnValue({
            list: vi.fn().mockResolvedValue({ data: [{ name: 'old.jpg' }], error: null }),
        });
        mocks.from.mockReturnValue({
            update: vi.fn().mockReturnValue({
                eq: vi.fn().mockReturnValue({
                    select: vi.fn().mockReturnValue({
                        maybeSingle: vi.fn().mockResolvedValue({
                            data: { user_id: 'account-b', avatar_url: null },
                            error: null,
                        }),
                    }),
                }),
            }),
        });

        await expect(removeProfilePhoto()).resolves.toBe(false);
        expect(cleanupMocks.retire).not.toHaveBeenCalled();
        expect(cleanupMocks.retain).toHaveBeenCalledWith(
            expect.objectContaining({ userId: 'account-a' }),
            'chat-avatars',
            'account-a/old.jpg',
            { kind: 'chat-profile-avatar' },
        );
    });

    it('stops a deferred A removal before deleting any stored files', async () => {
        const listing = deferred<{ data: { name: string }[]; error: null }>();
        const list = vi.fn().mockReturnValue(listing.promise);
        const remove = vi.fn().mockResolvedValue({ error: null });
        mocks.storageFrom.mockReturnValue({ list, remove });

        const pending = removeProfilePhoto();
        await vi.waitFor(() => expect(list).toHaveBeenCalledWith('account-a'));
        setAuthIdentityScope('account-b');
        listing.resolve({ data: [{ name: 'a.jpg' }], error: null });

        await expect(pending).resolves.toBe(false);
        expect(remove).not.toHaveBeenCalled();
        expect(mocks.from).not.toHaveBeenCalled();
    });
});
