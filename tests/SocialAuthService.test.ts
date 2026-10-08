import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativeAuth = vi.hoisted(() => ({
    appleAuthorize: vi.fn(),
}));

const auth = vi.hoisted(() => ({
    signInWithIdToken: vi.fn(),
    updateUser: vi.fn(),
    signOut: vi.fn(),
    // auth-js's own network-free session removal (fires SIGNED_OUT).
    _removeSession: vi.fn(),
}));
const authStore = vi.hoisted(() => ({
    fenceSignedOutOnThisDevice: vi.fn(),
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
vi.mock('../stores/authStore', () => authStore);
const log = vi.hoisted(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
}));
vi.mock('../utils/createLogger', () => ({ createLogger: () => log }));

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

const APPLE_1000 = "Apple Sign-In didn't complete (Apple error 1000). Try again.";

/** A rejection as Capacitor delivers it: an Error carrying the native call's code. */
function nativeError(message: string, code: string) {
    return Object.assign(new Error(message), { code });
}

function appleSuccess() {
    return {
        response: {
            identityToken: 'apple-id-token',
            authorizationCode: 'one-time-apple-code',
            user: 'apple-user-1',
        },
    };
}

/** What reached Sentry: the messages of the Errors handed to log.error. */
function reportedFailures(): string[] {
    return log.error.mock.calls.flatMap((args: unknown[]) =>
        args.filter((arg): arg is Error => arg instanceof Error).map((error) => error.message),
    );
}

beforeEach(() => {
    vi.clearAllMocks();
    auth.updateUser.mockResolvedValue({ data: {}, error: null });
    auth.signOut.mockResolvedValue({ error: null });
    auth._removeSession.mockResolvedValue(undefined);
    authStore.fenceSignedOutOnThisDevice.mockResolvedValue(undefined);
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

    it.each([
        new Error('User cancelled'),
        { code: 1001 },
        // The patched plugin: iOS's own description plus the code (ASAuthorizationError.canceled).
        nativeError(
            'The operation couldn’t be completed. (com.apple.AuthenticationServices.AuthorizationError error 1001.)',
            '1001',
        ),
        // The unpatched plugin rejects with the description alone, in the phone's language.
        new Error(
            'The operation couldn’t be completed. (com.apple.AuthenticationServices.AuthorizationError error 1001.)',
        ),
        new Error(
            'Der Vorgang konnte nicht abgeschlossen werden. (com.apple.AuthenticationServices.AuthorizationError Fehler 1001.)',
        ),
    ])('normalises native cancellation (1001 only) and reports nothing', async (error) => {
        nativeAuth.appleAuthorize.mockRejectedValue(error);
        await expect(signInWithApple()).rejects.toThrow('CANCELLED');
        expect(auth.signInWithIdToken).not.toHaveBeenCalled();
        expect(log.error).not.toHaveBeenCalled();
    });

    it.each([
        nativeError(
            'The operation couldn’t be completed. (com.apple.AuthenticationServices.AuthorizationError error 1000.)',
            '1000',
        ),
        new Error(
            'The operation couldn’t be completed. (com.apple.AuthenticationServices.AuthorizationError error 1000.)',
        ),
        new Error(
            'L’opération n’a pas pu s’achever. (erreur com.apple.AuthenticationServices.AuthorizationError 1000.)',
        ),
        { code: 1000 },
    ])('never treats Apple error 1000 (unknown) as a cancel: it says so and reports the step', async (error) => {
        nativeAuth.appleAuthorize.mockRejectedValue(error);

        await expect(signInWithApple()).rejects.toThrow(APPLE_1000);

        expect(auth.signInWithIdToken).not.toHaveBeenCalled();
        expect(reportedFailures()).toEqual(['apple_signin_failed step=authorize code=1000 reason=apple_error']);
    });

    it('names any other Apple authorization code, and keeps a stable message for a bridge failure', async () => {
        nativeAuth.appleAuthorize.mockRejectedValueOnce(nativeError('The operation couldn’t be completed.', '1004'));
        await expect(signInWithApple()).rejects.toThrow("Apple Sign-In didn't complete (Apple error 1004). Try again.");

        nativeAuth.appleAuthorize.mockRejectedValueOnce(new Error('native bridge failed'));
        await expect(signInWithApple()).rejects.toThrow(
            "Apple Sign-In didn't complete. Try again or use another method.",
        );

        // The patched plugin's own non-Apple codes are reported as they are.
        nativeAuth.appleAuthorize.mockRejectedValueOnce(
            nativeError('A newer Sign in with Apple request replaced this one', 'SUPERSEDED'),
        );
        await expect(signInWithApple()).rejects.toThrow(
            "Apple Sign-In didn't complete. Try again or use another method.",
        );

        nativeAuth.appleAuthorize.mockResolvedValueOnce({ response: {} });
        await expect(signInWithApple()).rejects.toThrow('Apple returned no identity token');

        expect(reportedFailures()).toEqual([
            'apple_signin_failed step=authorize code=1004 reason=apple_error',
            'apple_signin_failed step=authorize code=none reason=bridge',
            'apple_signin_failed step=authorize code=SUPERSEDED reason=bridge',
            'apple_signin_failed step=authorize code=none reason=no_identity_token',
        ]);
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
        functions.invoke.mockResolvedValue({
            data: null,
            error: { name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function' },
        });

        await expect(signInWithApple()).rejects.toThrow(
            "Apple Sign-In couldn't reach Thalassa. Check your connection and try again.",
        );

        expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
        expect(nativeCredentialState.clearBoundAppleCredential).toHaveBeenCalledOnce();
        expect(auth.updateUser).not.toHaveBeenCalled();
        expect(reportedFailures()).toEqual(['apple_signin_failed step=register_token code=fetch reason=fetch_error']);
        // Supabase signed it out, so nothing further is needed.
        expect(auth._removeSession).not.toHaveBeenCalled();
        expect(authStore.fenceSignedOutOnThisDevice).not.toHaveBeenCalled();
    });

    describe('when the discard cannot sign the session out through Supabase', () => {
        // auth-js 2.98: signOut({ scope: 'local' }) still POSTs /logout, and on
        // a network error or a 5xx it returns (or throws) without removing the
        // session. Offline is exactly when register-apple-token fails too.
        const offlineRegistration = () => {
            nativeAuth.appleAuthorize.mockResolvedValue(appleSuccess());
            auth.signInWithIdToken.mockResolvedValue({ data: { session: session() }, error: null });
            functions.invoke.mockResolvedValue({
                data: null,
                error: { name: 'FunctionsFetchError', message: 'Failed to send a request to the Edge Function' },
            });
        };

        it.each([
            ['returns an error', () => auth.signOut.mockResolvedValue({ error: { name: 'AuthRetryableFetchError' } })],
            ['throws', () => auth.signOut.mockRejectedValue(new TypeError('Load failed'))],
            ['returns a 5xx', () => auth.signOut.mockResolvedValue({ error: { name: 'AuthApiError', status: 503 } })],
        ])('removes the session on this device and fences the app when signOut %s', async (_label, failSignOut) => {
            offlineRegistration();
            failSignOut();

            await expect(signInWithApple()).rejects.toThrow(
                "Apple Sign-In couldn't reach Thalassa. Check your connection and try again.",
            );

            expect(auth._removeSession).toHaveBeenCalledOnce();
            expect(auth._removeSession.mock.invocationCallOrder[0]).toBeGreaterThan(
                auth.signOut.mock.invocationCallOrder[0],
            );
            expect(authStore.fenceSignedOutOnThisDevice).toHaveBeenCalledOnce();
            expect(reportedFailures()).toEqual([
                'apple_signin_failed step=register_token code=fetch reason=fetch_error',
            ]);
        });

        it('still fences the app, and reports it, when the local removal fails as well', async () => {
            offlineRegistration();
            auth.signOut.mockResolvedValue({ error: { name: 'AuthRetryableFetchError' } });
            auth._removeSession.mockRejectedValue(new DOMException('Keychain busy', 'InvalidStateError'));

            await expect(signInWithApple()).rejects.toThrow("Apple Sign-In couldn't reach Thalassa.");

            expect(authStore.fenceSignedOutOnThisDevice).toHaveBeenCalledOnce();
            expect(reportedFailures()).toEqual([
                'apple_signin_failed step=register_token code=fetch reason=fetch_error',
                'apple_signin_discard_failed reason=InvalidStateError',
            ]);
        });

        it('fails closed after a device-binding failure too', async () => {
            nativeAuth.appleAuthorize.mockResolvedValue(appleSuccess());
            auth.signInWithIdToken.mockResolvedValue({ data: { session: session() }, error: null });
            nativeCredentialState.bindAppleCredentialUser.mockRejectedValue(new Error('Keychain write failed'));
            auth.signOut.mockResolvedValue({ error: { name: 'AuthRetryableFetchError' } });

            await expect(signInWithApple()).rejects.toThrow("Apple Sign-In couldn't finish securely on this device.");

            expect(functions.invoke).not.toHaveBeenCalled();
            expect(auth._removeSession).toHaveBeenCalledOnce();
            expect(authStore.fenceSignedOutOnThisDevice).toHaveBeenCalledOnce();
        });
    });

    it('an unrecognised registration error still fails closed with the server label', async () => {
        nativeAuth.appleAuthorize.mockResolvedValue(appleSuccess());
        auth.signInWithIdToken.mockResolvedValue({ data: { session: session() }, error: null });
        functions.invoke.mockResolvedValue({ data: null, error: { message: 'Edge unavailable' } });

        await expect(signInWithApple()).rejects.toThrow("Apple Sign-In couldn't finish (server, error). Try again.");

        expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
        expect(reportedFailures()).toEqual(['apple_signin_failed step=register_token code=error reason=unknown']);
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

        await expect(signInWithApple()).rejects.toThrow(
            "Apple Sign-In couldn't finish securely on this device. Try again.",
        );

        expect(functions.invoke).not.toHaveBeenCalled();
        expect(nativeCredentialState.clearBoundAppleCredential).toHaveBeenCalledOnce();
        expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
        expect(reportedFailures()).toEqual(['apple_signin_failed step=bind_credential code=native reason=unknown']);
    });

    it.each([
        ['Apple credential is not authorized', 'not_authorized'],
        ['Could not secure the Apple credential binding', 'keychain'],
        ['Could not verify the Apple credential state', 'state_check'],
    ])('classifies the native binding failure %j without echoing it', async (nativeMessage, reason) => {
        nativeAuth.appleAuthorize.mockResolvedValue(appleSuccess());
        auth.signInWithIdToken.mockResolvedValue({ data: { session: session() }, error: null });
        nativeCredentialState.bindAppleCredentialUser.mockRejectedValue(new Error(nativeMessage));

        await expect(signInWithApple()).rejects.toThrow("Apple Sign-In couldn't finish securely");

        expect(reportedFailures()).toEqual([`apple_signin_failed step=bind_credential code=native reason=${reason}`]);
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
            error: { name: 'AuthApiError', message: 'Apple token rejected', status: 400, code: 'bad_jwt' },
        });
        await expect(signInWithApple()).rejects.toThrow("Apple Sign-In couldn't finish (account, 400). Try again.");
        expect(reportedFailures()).toEqual(['apple_signin_failed step=supabase_id_token code=400 reason=bad_jwt']);

        const signedIn = session('Skipper');
        auth.signInWithIdToken.mockResolvedValueOnce({ data: { session: signedIn }, error: null });
        await expect(signInWithApple()).resolves.toBe(signedIn);
        expect(auth.updateUser).not.toHaveBeenCalled();
    });

    it('tells an offline sailor the account step could not be reached', async () => {
        nativeAuth.appleAuthorize.mockResolvedValue(appleSuccess());
        auth.signInWithIdToken.mockResolvedValue({
            data: { session: null },
            error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 },
        });

        await expect(signInWithApple()).rejects.toThrow(
            "Apple Sign-In couldn't reach Thalassa. Check your connection and try again.",
        );

        expect(functions.invoke).not.toHaveBeenCalled();
        expect(reportedFailures()).toEqual([
            'apple_signin_failed step=supabase_id_token code=0 reason=AuthRetryableFetchError',
        ]);
    });

    it.each([
        [
            502,
            { error: 'Apple token registration failed; start Sign in with Apple again' },
            "Apple Sign-In couldn't finish (server, 502). Try again.",
            'code=502 reason=http_error',
        ],
        [
            401,
            { error: 'Invalid or expired session' },
            "Apple Sign-In couldn't finish (server, 401). Try again.",
            'code=401 reason=http_error',
        ],
        [
            403,
            { error: 'The authenticated account is not linked to Apple' },
            "Apple Sign-In couldn't finish (server, 403). Try again.",
            'code=403 reason=http_error',
        ],
        [
            503,
            { error: 'Apple token registration is not configured' },
            "Apple Sign-In couldn't finish (server, 503). Try again.",
            'code=503 reason=http_error',
        ],
        [
            409,
            {
                error: 'Another Apple sign-in for this account finished at the same moment; start Sign in with Apple again',
                retryable: true,
            },
            'Another Apple sign-in for this account finished at the same moment. Try again.',
            'code=409 reason=retryable',
        ],
    ])(
        'register-apple-token HTTP %i keeps the sheet honest: step label, status, no session kept',
        async (status, body, message, report) => {
            nativeAuth.appleAuthorize.mockResolvedValue(appleSuccess());
            auth.signInWithIdToken.mockResolvedValue({ data: { session: session() }, error: null });
            functions.invoke.mockResolvedValue({
                data: null,
                error: {
                    name: 'FunctionsHttpError',
                    message: 'Edge Function returned a non-2xx status code',
                    context: new Response(JSON.stringify(body), { status }),
                },
            });

            await expect(signInWithApple()).rejects.toThrow(message);

            expect(auth.signOut).toHaveBeenCalledWith({ scope: 'local' });
            expect(nativeCredentialState.clearBoundAppleCredential).toHaveBeenCalledOnce();
            expect(reportedFailures()).toEqual([`apple_signin_failed step=register_token ${report}`]);
        },
    );

    it('reports a registration reply that is not a registration, and a relay failure', async () => {
        nativeAuth.appleAuthorize.mockResolvedValue(appleSuccess());
        auth.signInWithIdToken.mockResolvedValue({ data: { session: session() }, error: null });
        functions.invoke.mockResolvedValueOnce({ data: { registered: false }, error: null });
        await expect(signInWithApple()).rejects.toThrow(
            "Apple Sign-In couldn't finish (server, invalid reply). Try again.",
        );

        functions.invoke.mockResolvedValueOnce({
            data: null,
            error: { name: 'FunctionsRelayError', message: 'Relay Error invoking the Edge Function', context: {} },
        });
        await expect(signInWithApple()).rejects.toThrow("Apple Sign-In couldn't finish (server, relay). Try again.");

        expect(reportedFailures()).toEqual([
            'apple_signin_failed step=register_token code=200 reason=invalid_response',
            'apple_signin_failed step=register_token code=relay reason=relay_error',
        ]);
    });

    it('never puts a token, code, nonce, email or Apple user id in a log line, Sentry report or banner', async () => {
        const secrets = {
            identityToken: 'SENTINEL-IDENTITY-TOKEN.eyJhbGciOiJSUzI1NiJ9',
            authorizationCode: 'SENTINEL-AUTHORIZATION-CODE-c0ffee',
            user: '000999.SENTINELAPPLEUSER.0042',
            email: 'sentinel.sailor@example.invalid',
            refresh: 'SENTINEL-REFRESH-TOKEN',
            access: 'SENTINEL-ACCESS-TOKEN',
        };
        const response = {
            response: {
                identityToken: secrets.identityToken,
                authorizationCode: secrets.authorizationCode,
                user: secrets.user,
                email: secrets.email,
                givenName: 'Ines',
                familyName: 'Quintana',
            },
        };
        const signedIn = {
            ...session(),
            access_token: secrets.access,
            refresh_token: secrets.refresh,
            user: { ...session().user, email: secrets.email },
        };
        const banners: string[] = [];
        const attempt = async () => {
            try {
                await signInWithApple();
            } catch (error) {
                banners.push(error instanceof Error ? error.message : String(error));
            }
        };

        // Every failing step, each one carrying the secrets in its error text.
        nativeAuth.appleAuthorize.mockRejectedValueOnce(
            nativeError(`Apple failed for ${secrets.email} ${secrets.user}`, '1000'),
        );
        await attempt();
        nativeAuth.appleAuthorize.mockRejectedValueOnce(new Error(`bridge died holding ${secrets.identityToken}`));
        await attempt();
        nativeAuth.appleAuthorize.mockResolvedValue(response);
        auth.signInWithIdToken.mockResolvedValueOnce({
            data: { session: null },
            error: {
                name: 'AuthApiError',
                message: `Bad id_token ${secrets.identityToken}`,
                status: 400,
                code: 'bad_jwt',
            },
        });
        await attempt();
        auth.signInWithIdToken.mockResolvedValue({ data: { session: signedIn }, error: null });
        nativeCredentialState.bindAppleCredentialUser.mockRejectedValueOnce(new Error(`Keychain ${secrets.user}`));
        await attempt();
        functions.invoke.mockResolvedValueOnce({
            data: null,
            error: {
                name: 'FunctionsHttpError',
                message: `non-2xx for ${secrets.authorizationCode}`,
                context: new Response(JSON.stringify({ error: `bad code ${secrets.authorizationCode}` }), {
                    status: 502,
                }),
            },
        });
        await attempt();
        functions.invoke.mockResolvedValueOnce({
            data: null,
            error: { name: 'FunctionsFetchError', message: secrets.refresh },
        });
        await attempt();
        auth.signOut.mockResolvedValueOnce({ error: { message: `sign-out refused for ${secrets.access}` } });
        functions.invoke.mockResolvedValueOnce({ data: { registered: false, echo: secrets.refresh }, error: null });
        await attempt();

        const nonces = nativeAuth.appleAuthorize.mock.calls.map(([options]) => options.nonce as string);
        const rawNonces = auth.signInWithIdToken.mock.calls.map(([options]) => options.nonce as string);
        expect(nonces.length).toBeGreaterThan(0);
        expect(rawNonces.length).toBeGreaterThan(0);
        const said = JSON.stringify([
            log.error.mock.calls,
            log.warn.mock.calls,
            log.info.mock.calls,
            log.debug.mock.calls,
            banners,
        ]);
        for (const secret of [...Object.values(secrets), ...nonces, ...rawNonces]) {
            expect(said).not.toContain(secret);
        }
        // And the Sentry reports are the step-tagged Errors, nothing else.
        expect(reportedFailures()).toHaveLength(7);
        for (const call of log.error.mock.calls) {
            expect(call.some((arg: unknown) => arg instanceof Error)).toBe(true);
        }
    });
});

describe('signOut', () => {
    it('signs out of Supabase', async () => {
        await expect(signOut()).resolves.toBeUndefined();
        expect(auth.signOut).toHaveBeenCalledOnce();
    });
});
