import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeAuth = vi.hoisted(() => ({
    appleAuthorize: vi.fn(),
    googleInitialize: vi.fn(),
    googleSignIn: vi.fn(),
    googleSignOut: vi.fn(),
}));

const auth = vi.hoisted(() => ({
    signInWithIdToken: vi.fn(),
    updateUser: vi.fn(),
    signOut: vi.fn(),
}));

vi.mock('@capacitor-community/apple-sign-in', () => ({
    SignInWithApple: { authorize: nativeAuth.appleAuthorize },
}));
vi.mock('@codetrix-studio/capacitor-google-auth', () => ({
    GoogleAuth: {
        initialize: nativeAuth.googleInitialize,
        signIn: nativeAuth.googleSignIn,
        signOut: nativeAuth.googleSignOut,
    },
}));
vi.mock('../services/supabase', () => ({ supabase: { auth } }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

import { signInWithApple, signInWithGoogle, signOut } from '../services/auth/SocialAuthService';

function session(firstName?: string) {
    return {
        access_token: 'access',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: 1,
        refresh_token: 'refresh',
        user: {
            id: 'user-1',
            app_metadata: {},
            user_metadata: firstName ? { first_name: firstName } : {},
            aud: 'authenticated',
            created_at: '2026-01-01T00:00:00Z',
        },
    };
}

beforeEach(() => {
    vi.clearAllMocks();
    nativeAuth.googleInitialize.mockResolvedValue(undefined);
    nativeAuth.googleSignOut.mockResolvedValue(undefined);
    auth.updateUser.mockResolvedValue({ data: {}, error: null });
    auth.signOut.mockResolvedValue({ error: null });
});

describe('signInWithApple', () => {
    it('passes the native token and one-shot nonce to Supabase and saves a first-use name', async () => {
        nativeAuth.appleAuthorize.mockResolvedValue({
            response: {
                identityToken: 'apple-id-token',
                givenName: 'Ada',
                familyName: 'Lovelace',
            },
        });
        const signedIn = session();
        auth.signInWithIdToken.mockResolvedValue({ data: { session: signedIn }, error: null });

        await expect(signInWithApple()).resolves.toBe(signedIn);

        expect(nativeAuth.appleAuthorize).toHaveBeenCalledWith(
            expect.objectContaining({
                clientId: 'com.thalassa.weather',
                scopes: 'email name',
                nonce: expect.stringMatching(/^[a-f0-9]{64}$/),
            }),
        );
        const nativeNonce = nativeAuth.appleAuthorize.mock.calls[0][0].nonce;
        const supabaseArgs = auth.signInWithIdToken.mock.calls[0][0];
        expect(supabaseArgs).toEqual({
            provider: 'apple',
            token: 'apple-id-token',
            nonce: expect.stringMatching(/^[a-f0-9]{64}$/),
        });
        expect(supabaseArgs.nonce).not.toBe(nativeNonce);
        expect(auth.updateUser).toHaveBeenCalledWith({
            data: { first_name: 'Ada', last_name: 'Lovelace' },
        });
    });

    it.each([new Error('User cancelled'), { code: 1001 }])('normalises native cancellation', async (error) => {
        nativeAuth.appleAuthorize.mockRejectedValue(error);
        await expect(signInWithApple()).rejects.toThrow('CANCELLED');
        expect(auth.signInWithIdToken).not.toHaveBeenCalled();
    });

    it('gives a stable message for native failures and missing identity tokens', async () => {
        nativeAuth.appleAuthorize.mockRejectedValueOnce(new Error('native bridge failed'));
        await expect(signInWithApple()).rejects.toThrow("Apple Sign-In didn't complete");

        nativeAuth.appleAuthorize.mockResolvedValueOnce({ response: {} });
        await expect(signInWithApple()).rejects.toThrow('Apple returned no identity token');
    });

    it('surfaces Supabase errors and preserves an existing profile name', async () => {
        nativeAuth.appleAuthorize.mockResolvedValue({
            response: { identityToken: 'token', givenName: 'Ignored' },
        });
        auth.signInWithIdToken.mockResolvedValueOnce({
            data: { session: null },
            error: { message: 'Apple token rejected' },
        });
        await expect(signInWithApple()).rejects.toThrow('Apple token rejected');

        const signedIn = session('Skipper');
        auth.signInWithIdToken.mockResolvedValueOnce({ data: { session: signedIn }, error: null });
        await expect(signInWithApple()).resolves.toBe(signedIn);
        expect(auth.updateUser).not.toHaveBeenCalled();
    });
});

describe('signInWithGoogle', () => {
    it('initializes once, signs in twice, and never overwrites an existing friendly name', async () => {
        nativeAuth.googleSignIn.mockResolvedValue({
            authentication: { idToken: 'google-id-token' },
            givenName: 'Grace',
            familyName: 'Hopper',
        });
        const first = session();
        const named = session('Captain');
        auth.signInWithIdToken
            .mockResolvedValueOnce({ data: { session: first }, error: null })
            .mockResolvedValueOnce({ data: { session: named }, error: null });

        await expect(signInWithGoogle()).resolves.toBe(first);
        await expect(signInWithGoogle()).resolves.toBe(named);

        expect(nativeAuth.googleInitialize).toHaveBeenCalledOnce();
        expect(nativeAuth.googleSignIn).toHaveBeenCalledTimes(2);
        expect(auth.signInWithIdToken).toHaveBeenCalledWith({
            provider: 'google',
            token: 'google-id-token',
        });
        expect(auth.updateUser).toHaveBeenCalledOnce();
        expect(auth.updateUser).toHaveBeenCalledWith({
            data: { first_name: 'Grace', last_name: 'Hopper' },
        });
    });

    it.each([new Error('user_cancel'), new Error('popup_closed_by_user')])(
        'normalises native cancellation',
        async (error) => {
            nativeAuth.googleSignIn.mockRejectedValue(error);
            await expect(signInWithGoogle()).rejects.toThrow('CANCELLED');
        },
    );

    it('handles native failures, missing tokens, and Supabase rejection', async () => {
        nativeAuth.googleSignIn.mockRejectedValueOnce('native failure');
        await expect(signInWithGoogle()).rejects.toThrow("Google Sign-In didn't complete");

        nativeAuth.googleSignIn.mockResolvedValueOnce({ authentication: {} });
        await expect(signInWithGoogle()).rejects.toThrow('Google returned no identity token');

        nativeAuth.googleSignIn.mockResolvedValueOnce({ authentication: { idToken: 'bad-token' } });
        auth.signInWithIdToken.mockResolvedValueOnce({
            data: { session: null },
            error: { message: 'Google token rejected' },
        });
        await expect(signInWithGoogle()).rejects.toThrow('Google token rejected');
    });
});

describe('signOut', () => {
    it('signs out of both providers and tolerates an uninitialized Google plugin', async () => {
        await expect(signOut()).resolves.toBeUndefined();
        expect(nativeAuth.googleSignOut).toHaveBeenCalledOnce();
        expect(auth.signOut).toHaveBeenCalledOnce();

        nativeAuth.googleSignOut.mockRejectedValueOnce(new Error('not initialized'));
        await expect(signOut()).resolves.toBeUndefined();
        expect(auth.signOut).toHaveBeenCalledTimes(2);
    });
});
