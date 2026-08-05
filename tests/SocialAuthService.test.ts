import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeAuth = vi.hoisted(() => ({
    appleAuthorize: vi.fn(),
}));

const auth = vi.hoisted(() => ({
    signInWithIdToken: vi.fn(),
    updateUser: vi.fn(),
    signOut: vi.fn(),
}));
const functions = vi.hoisted(() => ({
    invoke: vi.fn(),
}));
const nativeCredentialState = vi.hoisted(() => ({
    bindAppleCredentialUser: vi.fn(),
    clearBoundAppleCredential: vi.fn(),
}));

vi.mock('@capacitor-community/apple-sign-in', () => ({
    SignInWithApple: { authorize: nativeAuth.appleAuthorize },
}));
vi.mock('../services/supabase', () => ({ supabase: { auth, functions } }));
vi.mock('../services/auth/appleCredentialState', () => nativeCredentialState);
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({
        info: vi.fn(),
        warn: vi.fn(),
        error: vi.fn(),
        debug: vi.fn(),
    }),
}));

import { signInWithApple, signOut } from '../services/auth/SocialAuthService';

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
    auth.updateUser.mockResolvedValue({ data: {}, error: null });
    auth.signOut.mockResolvedValue({ error: null });
    functions.invoke.mockResolvedValue({ data: { registered: true }, error: null });
    nativeCredentialState.bindAppleCredentialUser.mockResolvedValue(undefined);
    nativeCredentialState.clearBoundAppleCredential.mockResolvedValue(undefined);
});

describe('signInWithApple', () => {
    it('passes the native token and one-shot nonce to Supabase and saves a first-use name', async () => {
        nativeAuth.appleAuthorize.mockResolvedValue({
            response: {
                identityToken: 'apple-id-token',
                authorizationCode: 'one-time-apple-code',
                user: 'apple-user-1',
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
        expect(functions.invoke).toHaveBeenCalledWith('register-apple-token', {
            body: { authorizationCode: 'one-time-apple-code' },
        });
        expect(auth.signInWithIdToken.mock.invocationCallOrder[0]).toBeLessThan(
            functions.invoke.mock.invocationCallOrder[0],
        );
        expect(nativeCredentialState.bindAppleCredentialUser).toHaveBeenCalledWith('apple-user-1');
        expect(nativeCredentialState.bindAppleCredentialUser.mock.invocationCallOrder[0]).toBeLessThan(
            functions.invoke.mock.invocationCallOrder[0],
        );
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

    it('rejects a response with no authorization code before creating a Supabase session', async () => {
        nativeAuth.appleAuthorize.mockResolvedValue({ response: { identityToken: 'apple-id-token' } });

        await expect(signInWithApple()).rejects.toThrow('Apple returned no authorization code');
        expect(auth.signInWithIdToken).not.toHaveBeenCalled();
        expect(functions.invoke).not.toHaveBeenCalled();
    });

    it('fails closed and discards the local session when server-side token registration fails', async () => {
        nativeAuth.appleAuthorize.mockResolvedValue({
            response: {
                identityToken: 'apple-id-token',
                authorizationCode: 'one-time-apple-code',
                user: 'apple-user-1',
                givenName: 'Not persisted',
            },
        });
        auth.signInWithIdToken.mockResolvedValue({ data: { session: session() }, error: null });
        functions.invoke.mockResolvedValue({ data: null, error: { message: 'Edge unavailable' } });

        await expect(signInWithApple()).rejects.toThrow("couldn't finish securely");

        expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
        expect(nativeCredentialState.clearBoundAppleCredential).toHaveBeenCalledOnce();
        expect(auth.updateUser).not.toHaveBeenCalled();
    });

    it('fails closed when the native credential-state binding cannot be secured', async () => {
        nativeAuth.appleAuthorize.mockResolvedValue({
            response: {
                identityToken: 'apple-id-token',
                authorizationCode: 'one-time-apple-code',
                user: 'apple-user-1',
            },
        });
        auth.signInWithIdToken.mockResolvedValue({ data: { session: session() }, error: null });
        nativeCredentialState.bindAppleCredentialUser.mockRejectedValue(new Error('Keychain unavailable'));

        await expect(signInWithApple()).rejects.toThrow("couldn't finish securely");

        expect(functions.invoke).not.toHaveBeenCalled();
        expect(nativeCredentialState.clearBoundAppleCredential).toHaveBeenCalledOnce();
        expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
    });

    it('surfaces Supabase errors and preserves an existing profile name', async () => {
        nativeAuth.appleAuthorize.mockResolvedValue({
            response: {
                identityToken: 'token',
                authorizationCode: 'apple-code',
                user: 'apple-user-1',
                givenName: 'Ignored',
            },
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

describe('signOut', () => {
    it('signs out of Supabase', async () => {
        await expect(signOut()).resolves.toBeUndefined();
        expect(auth.signOut).toHaveBeenCalledOnce();
    });
});
