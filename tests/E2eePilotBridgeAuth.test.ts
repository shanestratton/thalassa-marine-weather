// @vitest-environment node
/**
 * Pure SDK/plugin fixtures only. These tests do not exercise a real Supabase
 * login, native bridge, Keychain, encrypted messages, TLS, or physical device.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    MEMORY_AUTH_OPTIONS,
    RESEARCH_LABEL,
    RESEARCH_SUPABASE_URL,
    ResearchAuthController,
    isResearchPublicApiKey,
    type NativeAccountResult,
    type NativeConfigurationResult,
    type NativeFenceResult,
    type ResearchAccount,
    type ResearchAuthDependencies,
    type ResearchAuthNativePlugin,
    type ResearchAuthSdk,
} from '../experiments/scuttlebutt-e2ee/bridge-web/auth';

const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222';
const DEVICE = '33333333-3333-4333-8333-333333333333';
const PUBLIC_KEY = 'sb_publishable_research_fixture';
const TOKEN_A = 'fixture-bearer-A';
const TOKEN_B = 'fixture-bearer-B';
const TOKEN_A_RENEWED = 'fixture-bearer-A-renewed';
const controllers: ResearchAuthController[] = [];
const unavailable = () => ({ status: 'unavailable' as const });
function configuration(): Extract<NativeConfigurationResult, { status: 'configured' }> {
    return {
        status: 'configured' as const,
        research: true as const,
        label: RESEARCH_LABEL,
        supabaseUrl: RESEARCH_SUPABASE_URL,
        publicApiKey: PUBLIC_KEY,
    };
}
function account(accountId = ACCOUNT_A): ResearchAccount {
    return { accountId, deviceId: DEVICE, credentialBinding: 'fixture-credential-1', serverVerified: true };
}
function authenticated(value = account()): NativeAccountResult {
    return { status: 'authenticated', account: value };
}
function session(access_token: string | null = TOKEN_A) {
    return { data: { session: access_token ? { access_token } : null }, error: null as unknown };
}
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
async function settle() {
    for (let index = 0; index < 45; index += 1) await Promise.resolve();
}
function legacyKey(role: string, ref?: string): string {
    return [
        Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url'),
        Buffer.from(JSON.stringify({ role, ...(ref ? { ref } : {}) })).toString('base64url'),
        'signature-fixture',
    ].join('.');
}

function fixture() {
    let sdkSession: { access_token: string } | null = null;
    let nativeAccount: ResearchAccount | null = null;
    let nativeFence = '';
    let fenceNumber = 0;
    let listener: Parameters<ResearchAuthSdk['onAuthStateChange']>[0] | undefined;
    let insideCallback = false;
    const operations: string[] = [];
    const unsubscribe = vi.fn();
    function emit(event: string) {
        insideCallback = true;
        try {
            listener?.(event, sdkSession);
        } finally {
            insideCallback = false;
        }
    }
    const sdk = {
        getSession: vi.fn<ResearchAuthSdk['getSession']>(async () => {
            expect(insideCallback).toBe(false);
            operations.push('sdk:get-session');
            return { data: { session: sdkSession }, error: null };
        }),
        signInWithPassword: vi.fn<ResearchAuthSdk['signInWithPassword']>(async ({ email }) => {
            expect(insideCallback).toBe(false);
            operations.push('sdk:sign-in');
            sdkSession = { access_token: email.startsWith('b@') ? TOKEN_B : TOKEN_A };
            emit('SIGNED_IN');
            return { data: { session: sdkSession }, error: null };
        }),
        signOut: vi.fn<ResearchAuthSdk['signOut']>(async () => {
            expect(insideCallback).toBe(false);
            operations.push('sdk:sign-out');
            sdkSession = null;
            emit('SIGNED_OUT');
            return { error: null };
        }),
        onAuthStateChange: vi.fn<ResearchAuthSdk['onAuthStateChange']>((callback) => {
            listener = callback;
            return { data: { subscription: { unsubscribe } } };
        }),
        stopAutoRefresh: vi.fn(),
    } satisfies ResearchAuthSdk;
    const native = {
        configuration: vi.fn<ResearchAuthNativePlugin['configuration']>(async () => configuration()),
        fenceSession: vi.fn<ResearchAuthNativePlugin['fenceSession']>(async ({ mode }) => {
            operations.push(`native:${mode}`);
            nativeAccount = null;
            nativeFence = `fixture-fence-${++fenceNumber}`;
            return { status: 'fenced', authFence: nativeFence };
        }),
        authenticate: vi.fn<ResearchAuthNativePlugin['authenticate']>(async ({ accessToken, authFence }) => {
            operations.push('native:authenticate');
            if (authFence !== nativeFence || ![TOKEN_A, TOKEN_B, TOKEN_A_RENEWED].includes(accessToken))
                return unavailable();
            nativeAccount = account(accessToken === TOKEN_B ? ACCOUNT_B : ACCOUNT_A);
            if (accessToken === TOKEN_A_RENEWED)
                nativeAccount = { ...nativeAccount, credentialBinding: 'fixture-credential-2' };
            return authenticated(nativeAccount);
        }),
        currentAccount: vi.fn<ResearchAuthNativePlugin['currentAccount']>(async () =>
            nativeAccount ? authenticated(nativeAccount) : unavailable(),
        ),
    } satisfies ResearchAuthNativePlugin;
    const createSdk = vi.fn<ResearchAuthDependencies['createSdk']>(() => {
        operations.push('sdk:create');
        return sdk;
    });
    const supported = vi.fn(() => true);
    const controller = new ResearchAuthController({ native, createSdk, supported });
    controllers.push(controller);
    return {
        controller,
        native,
        sdk,
        createSdk,
        supported,
        operations,
        emit,
        unsubscribe,
        setSdkSession(token: string | null) {
            sdkSession = token ? { access_token: token } : null;
        },
        expireNative() {
            nativeAccount = null;
        },
    };
}

afterEach(() => {
    for (const controller of controllers.splice(0)) controller.dispose();
    vi.restoreAllMocks();
});

describe('isolated auth-only research bridge with mocked SDK/native ports', () => {
    it('suspends native credentials on cold launch before constructing the memory-only SDK', async () => {
        const h = fixture();
        const fence = deferred<NativeFenceResult>();
        h.native.fenceSession.mockReturnValueOnce(fence.promise);
        const initialize = h.controller.initialize();
        await settle();
        expect(h.native.fenceSession).toHaveBeenCalledWith({ mode: 'verify' });
        expect(h.createSdk).not.toHaveBeenCalled();
        expect(h.sdk.getSession).not.toHaveBeenCalled();
        fence.resolve({ status: 'fenced', authFence: 'fixture-cold-fence' });
        await initialize;
        expect(h.controller.getState()).toEqual({ status: 'signed_out', account: null });
        expect(h.createSdk).toHaveBeenCalledWith(
            { supabaseUrl: RESEARCH_SUPABASE_URL, publicApiKey: PUBLIC_KEY },
            MEMORY_AUTH_OPTIONS,
        );
        expect(MEMORY_AUTH_OPTIONS.auth).toMatchObject({
            persistSession: false,
            autoRefreshToken: true,
            detectSessionInUrl: false,
        });
        expect(h.sdk.getSession).not.toHaveBeenCalled();
        expect(h.sdk.signInWithPassword).not.toHaveBeenCalled();
    });

    it('has no browser or production-session fallback', async () => {
        const h = fixture();
        h.supported.mockReturnValue(false);
        await h.controller.initialize();
        await h.controller.signIn('a@example.test', 'fixture-password');
        await h.controller.reverify();
        expect(h.controller.getState()).toEqual({ status: 'unsupported', account: null });
        expect(h.native.configuration).not.toHaveBeenCalled();
        expect(h.native.fenceSession).not.toHaveBeenCalled();
        expect(h.createSdk).not.toHaveBeenCalled();
    });

    it.each([
        { supabaseUrl: 'https://production-project.supabase.co' },
        { supabaseUrl: `${RESEARCH_SUPABASE_URL}/` },
        { supabaseUrl: `${RESEARCH_SUPABASE_URL}\n` },
        { supabaseUrl: RESEARCH_SUPABASE_URL.replace('https:', 'http:') },
        { research: false },
        { label: 'Encryption ready' },
        { publicApiKey: 'sb_secret_privileged-fixture' },
        { publicApiKey: legacyKey('service_role') },
        { publicApiKey: legacyKey('authenticated') },
        { publicApiKey: legacyKey('anon', 'different-project') },
        { publicApiKey: `${PUBLIC_KEY}\n` },
    ])('rejects unsafe or different-project native configuration %#', async (override) => {
        const h = fixture();
        h.native.configuration.mockResolvedValueOnce({ ...configuration(), ...override } as NativeConfigurationResult);
        await h.controller.initialize();
        expect(h.controller.getState()).toEqual({ status: 'unavailable', account: null });
        expect(h.native.fenceSession).not.toHaveBeenCalled();
        expect(h.createSdk).not.toHaveBeenCalled();
    });

    it('accepts only public-key classes and rejects a privileged JWT payload', () => {
        expect(isResearchPublicApiKey(PUBLIC_KEY)).toBe(true);
        expect(isResearchPublicApiKey(legacyKey('anon'))).toBe(true);
        expect(isResearchPublicApiKey(legacyKey('anon', 'kmtupdvwdgbhtssqqova'))).toBe(true);
        expect(isResearchPublicApiKey(legacyKey('service_role'))).toBe(false);
        expect(isResearchPublicApiKey('not-a-key')).toBe(false);
        expect(isResearchPublicApiKey('eyJ9.bad.signature')).toBe(false);
    });

    it('captures validated configuration before an asynchronous cold-start fence', async () => {
        const h = fixture();
        const config = configuration();
        h.native.configuration.mockResolvedValueOnce(config);
        const fence = deferred<NativeFenceResult>();
        h.native.fenceSession.mockReturnValueOnce(fence.promise);
        const initialize = h.controller.initialize();
        await settle();
        config.publicApiKey = 'sb_secret_replaced-fixture';
        fence.resolve({ status: 'fenced', authFence: 'fixture-cold-fence' });
        await initialize;
        expect(h.createSdk.mock.calls[0][0].publicApiKey).toBe(PUBLIC_KEY);
    });

    it.each([unavailable(), { status: 'fenced' as const, authFence: 'invalid\n' }])(
        'refuses cold start when native credential fencing is not confirmed %#',
        async (result) => {
            const h = fixture();
            h.native.fenceSession.mockResolvedValueOnce(result);
            await h.controller.initialize();
            expect(h.controller.getState().status).toBe('unavailable');
            expect(h.createSdk).not.toHaveBeenCalled();
        },
    );

    it('allows explicit native logout after failed cold continuation, then fresh selection', async () => {
        const h = fixture();
        h.native.fenceSession.mockResolvedValueOnce(unavailable());
        await h.controller.initialize();
        expect(h.controller.getState()).toEqual({ status: 'unavailable', account: null });
        expect(h.controller.canSignIn()).toBe(false);
        expect(h.controller.canSignOut()).toBe(true);
        expect(h.createSdk).not.toHaveBeenCalled();
        await h.controller.signOut();
        expect(h.native.fenceSession.mock.calls.map(([options]) => options.mode)).toEqual(['verify', 'sign_out']);
        expect(h.sdk.signOut).not.toHaveBeenCalled();
        expect(h.createSdk).toHaveBeenCalledTimes(1);
        expect(h.controller.canSignIn()).toBe(true);
        expect(h.controller.getState()).toEqual({ status: 'signed_out', account: null });
        await h.controller.signIn('b@example.test', 'fixture-password');
        expect(h.controller.getState().account?.accountId).toBe(ACCOUNT_B);
    });

    it('does not permit failed cold continuation to bypass a failed explicit logout', async () => {
        const h = fixture();
        h.native.fenceSession.mockResolvedValue(unavailable());
        await h.controller.initialize();
        await h.controller.signOut();
        await h.controller.signIn('b@example.test', 'fixture-password');
        expect(h.createSdk).not.toHaveBeenCalled();
        expect(h.native.authenticate).not.toHaveBeenCalled();
        expect(h.controller.getState()).toEqual({ status: 'unavailable', account: null });
    });

    it('has no native recovery action before validated isolated configuration', async () => {
        const h = fixture();
        h.native.configuration.mockResolvedValueOnce({ status: 'unavailable' });
        await h.controller.initialize();
        expect(h.controller.canSignOut()).toBe(false);
        await h.controller.signOut();
        expect(h.native.fenceSession).not.toHaveBeenCalled();
        expect(h.createSdk).not.toHaveBeenCalled();
    });

    it('retries SDK setup after a subscription failure without retaining partial state', async () => {
        const h = fixture();
        h.sdk.onAuthStateChange.mockImplementationOnce(() => {
            throw new Error('fixture-subscription-failure');
        });
        await h.controller.initialize();
        expect(h.controller.getState()).toEqual({ status: 'unavailable', account: null });
        expect(h.controller.canSignIn()).toBe(false);
        expect(h.sdk.stopAutoRefresh).toHaveBeenCalledTimes(1);
        await h.controller.signOut();
        expect(h.sdk.signOut).not.toHaveBeenCalled();
        expect(h.createSdk).toHaveBeenCalledTimes(2);
        expect(h.controller.canSignIn()).toBe(true);
        await h.controller.signIn('a@example.test', 'fixture-password');
        expect(h.controller.getState().account?.accountId).toBe(ACCOUNT_A);
    });

    it('waits for a durable verify fence before password sign-in', async () => {
        const h = fixture();
        await h.controller.initialize();
        const fence = deferred<NativeFenceResult>();
        const commitFence = h.native.fenceSession.getMockImplementation()!;
        h.native.fenceSession.mockImplementationOnce(async (options) => {
            await fence.promise;
            return commitFence(options);
        });
        const signIn = h.controller.signIn('a@example.test', 'fixture-password');
        await settle();
        expect(h.sdk.signInWithPassword).not.toHaveBeenCalled();
        fence.resolve({ status: 'fenced', authFence: 'fixture-release' });
        await signIn;
        expect(h.operations).toEqual([
            'native:verify',
            'sdk:create',
            'native:verify',
            'sdk:sign-in',
            'native:authenticate',
        ]);
        expect(h.native.authenticate).toHaveBeenCalledWith({ accessToken: TOKEN_A, authFence: 'fixture-fence-2' });
        expect(Object.keys(h.native.authenticate.mock.calls[0][0]).sort()).toEqual(['accessToken', 'authFence']);
        expect(h.controller.getState()).toEqual({ status: 'authenticated', account: account() });
        expect(h.controller.getState().account).not.toHaveProperty('lifecycleVersion');
        expect(h.controller.getState()).not.toHaveProperty('supportedContent');
    });

    it.each([unavailable(), { status: 'fenced' as const, authFence: 'bad\n' }])(
        'never acquires an SDK token after a failed/malformed verify fence %#',
        async (fence) => {
            const h = fixture();
            await h.controller.initialize();
            h.native.fenceSession.mockResolvedValueOnce(fence);
            await h.controller.signIn('a@example.test', 'fixture-password');
            expect(h.sdk.signInWithPassword).not.toHaveBeenCalled();
            h.native.fenceSession.mockResolvedValueOnce(fence);
            await h.controller.reverify();
            expect(h.sdk.getSession).not.toHaveBeenCalled();
            expect(h.native.authenticate).not.toHaveBeenCalled();
            expect(h.controller.getState()).toEqual({ status: 'unavailable', account: null });
        },
    );

    it('swallows rejected native and SDK diagnostics without exposing credentials', async () => {
        const h = fixture();
        await h.controller.initialize();
        h.native.fenceSession.mockRejectedValueOnce(new Error('fixture-password fixture-bearer'));
        await h.controller.signIn('a@example.test', 'fixture-password');
        expect(h.sdk.signInWithPassword).not.toHaveBeenCalled();
        h.sdk.signInWithPassword.mockResolvedValueOnce({
            ...session(),
            error: new Error('fixture-private-diagnostic'),
        });
        await h.controller.signIn('a@example.test', 'fixture-password');
        expect(h.native.authenticate).not.toHaveBeenCalled();
        expect(h.controller.getState()).toEqual({ status: 'unavailable', account: null });
    });

    it('does not accept native authentication without a matching live currentAccount', async () => {
        const h = fixture();
        await h.controller.initialize();
        h.native.currentAccount.mockResolvedValueOnce(authenticated(account(ACCOUNT_B)));
        await h.controller.signIn('a@example.test', 'fixture-password');
        expect(h.controller.getState()).toEqual({ status: 'unavailable', account: null });
    });

    it('takes identity only from native verification, ignoring SDK user and device claims', async () => {
        const h = fixture();
        await h.controller.initialize();
        const claimed = {
            data: {
                session: {
                    access_token: TOKEN_A,
                    user: { id: ACCOUNT_B, user_metadata: { deviceId: ACCOUNT_B, serverVerified: true } },
                },
            },
            error: null,
        };
        h.sdk.signInWithPassword.mockResolvedValueOnce(claimed);
        await h.controller.signIn('a@example.test', 'fixture-password');
        expect(h.controller.getState().account).toEqual(account(ACCOUNT_A));
        expect(Object.keys(h.controller.getState().account!).sort()).toEqual([
            'accountId',
            'credentialBinding',
            'deviceId',
            'serverVerified',
        ]);
    });

    it.each([
        unavailable(),
        { status: 'authenticated', account: { ...account(), serverVerified: false } },
        { status: 'authenticated', account: { ...account(), accountId: `${ACCOUNT_A}\n` } },
        { status: 'authenticated', account: { ...account(), credentialBinding: '' } },
        { status: 'ready', authority: account() },
    ])('refuses unavailable/malformed native account results without PM readiness %#', async (result) => {
        const h = fixture();
        await h.controller.initialize();
        h.native.authenticate.mockResolvedValueOnce(result as NativeAccountResult);
        await h.controller.signIn('a@example.test', 'fixture-password');
        expect(h.controller.getState()).toEqual({ status: 'unavailable', account: null });
        expect(h.native.currentAccount).not.toHaveBeenCalled();
    });

    it('invalidates visible authority immediately and refreshes outside the SDK callback lock', async () => {
        const h = fixture();
        await h.controller.initialize();
        await h.controller.signIn('a@example.test', 'fixture-password');
        h.setSdkSession(TOKEN_A_RENEWED);
        h.emit('TOKEN_REFRESHED');
        expect(h.controller.getState()).toEqual({ status: 'verifying', account: null });
        expect(h.sdk.getSession).not.toHaveBeenCalled();
        await settle();
        expect(h.sdk.getSession).toHaveBeenCalledTimes(1);
        expect(h.native.authenticate.mock.calls.at(-1)?.[0]).toEqual({
            accessToken: TOKEN_A_RENEWED,
            authFence: 'fixture-fence-3',
        });
        expect(h.controller.getState().account?.accountId).toBe(ACCOUNT_A);
        expect(h.controller.getState().account?.credentialBinding).toBe('fixture-credential-2');
    });

    it('refuses a refresh that attempts to replace the accepted native owner', async () => {
        const h = fixture();
        await h.controller.initialize();
        await h.controller.signIn('a@example.test', 'fixture-password');
        h.setSdkSession(TOKEN_B);
        h.emit('TOKEN_REFRESHED');
        await settle();
        expect(h.controller.getState()).toEqual({ status: 'unavailable', account: null });
        await h.controller.signOut();
        await h.controller.signIn('b@example.test', 'fixture-password');
        expect(h.controller.getState().account?.accountId).toBe(ACCOUNT_B);
    });

    it('hides account state on logout before native completion, then clears SDK memory', async () => {
        const h = fixture();
        await h.controller.initialize();
        await h.controller.signIn('a@example.test', 'fixture-password');
        const fence = deferred<NativeFenceResult>();
        h.native.fenceSession.mockReturnValueOnce(fence.promise);
        const logout = h.controller.signOut();
        expect(h.controller.getState().account).toBeNull();
        expect(h.sdk.signOut).not.toHaveBeenCalled();
        fence.resolve({ status: 'fenced', authFence: 'fixture-logout' });
        await logout;
        expect(h.sdk.signOut).toHaveBeenCalledWith({ scope: 'local' });
        expect(h.controller.getState()).toEqual({ status: 'signed_out', account: null });
    });

    it('keeps native sign-out failure unavailable even after successful SDK cleanup', async () => {
        const h = fixture();
        await h.controller.initialize();
        await h.controller.signIn('a@example.test', 'fixture-password');
        h.native.fenceSession.mockResolvedValueOnce(unavailable());
        await h.controller.signOut();
        expect(h.sdk.signOut).toHaveBeenCalledTimes(1);
        expect(h.controller.getState()).toEqual({ status: 'unavailable', account: null });
    });

    it('never restores a refresh response that arrives after logout', async () => {
        const h = fixture();
        await h.controller.initialize();
        await h.controller.signIn('a@example.test', 'fixture-password');
        const refreshed = deferred<Awaited<ReturnType<ResearchAuthSdk['getSession']>>>();
        h.sdk.getSession.mockReturnValueOnce(refreshed.promise);
        h.emit('TOKEN_REFRESHED');
        await settle();
        const logout = h.controller.signOut();
        expect(h.controller.getState().account).toBeNull();
        refreshed.resolve(session(TOKEN_B));
        await logout;
        await settle();
        expect(h.native.authenticate).toHaveBeenCalledTimes(1);
        expect(h.controller.getState()).toEqual({ status: 'signed_out', account: null });
    });

    it('rejects a stale native authenticate response after logout', async () => {
        const h = fixture();
        await h.controller.initialize();
        const pending = deferred<NativeAccountResult>();
        h.native.authenticate.mockReturnValueOnce(pending.promise);
        const signIn = h.controller.signIn('a@example.test', 'fixture-password');
        await settle();
        await h.controller.signOut();
        pending.resolve(authenticated());
        await signIn;
        expect(h.native.currentAccount).not.toHaveBeenCalled();
        expect(h.controller.getState()).toEqual({ status: 'signed_out', account: null });
    });

    it('does not dispatch token acquisition for a stale fence or queued stale SDK action', async () => {
        const h = fixture();
        await h.controller.initialize();
        const first = deferred<Awaited<ReturnType<ResearchAuthSdk['signInWithPassword']>>>();
        h.sdk.signInWithPassword.mockReturnValueOnce(first.promise);
        const signIn = h.controller.signIn('a@example.test', 'fixture-password');
        await settle();
        const reverify = h.controller.reverify();
        await settle();
        const logout = h.controller.signOut();
        first.resolve(session());
        await Promise.all([signIn, reverify, logout]);
        expect(h.sdk.getSession).not.toHaveBeenCalled();
        expect(h.native.authenticate).not.toHaveBeenCalled();
        expect(h.controller.getState()).toEqual({ status: 'signed_out', account: null });

        const fence = deferred<NativeFenceResult>();
        h.native.fenceSession.mockReturnValueOnce(fence.promise);
        const stale = h.controller.reverify();
        await settle();
        await h.controller.signOut();
        fence.resolve({ status: 'fenced', authFence: 'fixture-stale-fence' });
        await stale;
        expect(h.sdk.getSession).not.toHaveBeenCalled();
    });

    it('serializes overlapping password requests and publishes only the latest native account', async () => {
        const h = fixture();
        await h.controller.initialize();
        const first = deferred<Awaited<ReturnType<ResearchAuthSdk['signInWithPassword']>>>();
        h.sdk.signInWithPassword.mockReturnValueOnce(first.promise);
        const a = h.controller.signIn('a@example.test', 'fixture-password-A');
        await settle();
        const b = h.controller.signIn('b@example.test', 'fixture-password-B');
        await settle();
        expect(h.sdk.signInWithPassword).toHaveBeenCalledTimes(1);
        first.resolve(session(TOKEN_A));
        await Promise.all([a, b]);
        expect(h.sdk.signInWithPassword).toHaveBeenCalledTimes(2);
        expect(h.native.authenticate).toHaveBeenCalledTimes(1);
        expect(h.controller.getState().account?.accountId).toBe(ACCOUNT_B);
    });

    it('suspends unsolicited SDK sign-ins rather than granting native account access', async () => {
        const h = fixture();
        await h.controller.initialize();
        h.setSdkSession(TOKEN_A);
        h.emit('SIGNED_IN');
        await settle();
        expect(h.native.fenceSession.mock.calls.at(-1)?.[0]).toEqual({ mode: 'verify' });
        expect(h.sdk.signOut).toHaveBeenCalledTimes(1);
        expect(h.sdk.getSession).not.toHaveBeenCalled();
        expect(h.native.authenticate).not.toHaveBeenCalled();
        expect(h.controller.getState()).toEqual({ status: 'signed_out', account: null });
    });

    it('hides expired native account metadata without silently acquiring a token', async () => {
        const h = fixture();
        await h.controller.initialize();
        await h.controller.signIn('a@example.test', 'fixture-password');
        h.expireNative();
        await h.controller.checkCurrentAccount();
        expect(h.controller.getState()).toEqual({ status: 'unavailable', account: null });
        expect(h.sdk.getSession).not.toHaveBeenCalled();
    });

    it('suspends absent SDK sessions without a durable native sign-out', async () => {
        const h = fixture();
        await h.controller.initialize();
        await h.controller.reverify();
        expect(h.native.fenceSession.mock.calls.map(([options]) => options.mode)).toEqual([
            'verify',
            'verify',
            'verify',
        ]);
        expect(h.controller.getState()).toEqual({ status: 'signed_out', account: null });
    });

    it.each(['SIGNED_OUT', 'PASSWORD_RECOVERY', 'UNEXPECTED_EVENT'])(
        'keeps owner continuity but clears credentials on passive %s',
        async (event) => {
            const h = fixture();
            await h.controller.initialize();
            await h.controller.signIn('a@example.test', 'fixture-password');
            h.setSdkSession(null);
            h.emit(event);
            expect(h.controller.getState()).toEqual({ status: 'verifying', account: null });
            await settle();
            expect(h.native.fenceSession.mock.calls.every(([options]) => options.mode === 'verify')).toBe(true);
            expect(h.sdk.signOut).toHaveBeenCalledTimes(1);
            expect(h.controller.getState()).toEqual({ status: 'signed_out', account: null });
            // A permissive fake native port cannot bypass the controller's
            // retained owner. Real sealed-state continuity is a native probe.
            await h.controller.signIn('b@example.test', 'fixture-password');
            expect(h.controller.getState()).toEqual({ status: 'unavailable', account: null });
            await h.controller.signIn('a@example.test', 'fixture-password');
            expect(h.controller.getState().account?.accountId).toBe(ACCOUNT_A);
        },
    );

    it('keeps owner metadata across absent SDK sessions until explicit logout', async () => {
        const h = fixture();
        await h.controller.initialize();
        await h.controller.signIn('a@example.test', 'fixture-password');
        h.setSdkSession(null);
        await h.controller.reverify();
        expect(h.controller.getState()).toEqual({ status: 'signed_out', account: null });
        expect(h.native.fenceSession.mock.calls.every(([options]) => options.mode === 'verify')).toBe(true);
        await h.controller.signIn('b@example.test', 'fixture-password');
        expect(h.controller.getState().account).toBeNull();
        await h.controller.signIn('a@example.test', 'fixture-password');
        expect(h.controller.getState().account?.accountId).toBe(ACCOUNT_A);
        await h.controller.signOut();
        expect(h.native.fenceSession.mock.calls.at(-1)?.[0]).toEqual({ mode: 'sign_out' });
        await h.controller.signIn('b@example.test', 'fixture-password');
        expect(h.controller.getState().account?.accountId).toBe(ACCOUNT_B);
    });

    it('never revives an expired-token response after explicit logout during suspension', async () => {
        const h = fixture();
        await h.controller.initialize();
        await h.controller.signIn('a@example.test', 'fixture-password');
        const fence = deferred<NativeFenceResult>();
        h.native.fenceSession.mockReturnValueOnce(fence.promise);
        h.emit('SIGNED_OUT');
        await settle();
        await h.controller.signOut();
        fence.resolve({ status: 'fenced', authFence: 'fixture-stale-suspension' });
        await settle();
        expect(h.native.fenceSession.mock.calls.at(-1)?.[0]).toEqual({ mode: 'sign_out' });
        expect(h.sdk.signOut).toHaveBeenCalledTimes(1);
        expect(h.controller.getState()).toEqual({ status: 'signed_out', account: null });
    });

    it('disposal invalidates pending work and removes the SDK callback/refresh timer', async () => {
        const h = fixture();
        await h.controller.initialize();
        const fence = deferred<NativeFenceResult>();
        h.native.fenceSession.mockReturnValueOnce(fence.promise);
        const signIn = h.controller.signIn('a@example.test', 'fixture-password');
        h.controller.dispose();
        fence.resolve({ status: 'fenced', authFence: 'fixture-stale' });
        await signIn;
        expect(h.unsubscribe).toHaveBeenCalledTimes(1);
        expect(h.sdk.stopAutoRefresh).toHaveBeenCalledTimes(1);
        expect(h.sdk.signInWithPassword).not.toHaveBeenCalled();
        expect(h.controller.getState()).toEqual({ status: 'unavailable', account: null });
    });
});
