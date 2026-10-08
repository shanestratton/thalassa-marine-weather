import { beforeEach, describe, expect, it, vi } from 'vitest';

const authMocks = vi.hoisted(() => ({
    getSession: vi.fn(),
    onAuthStateChange: vi.fn(),
    signOut: vi.fn(),
    initializePush: vi.fn(),
    setPushUser: vi.fn(() => Promise.resolve()),
    clearPushUser: vi.fn(() => Promise.resolve()),
    setSentryUser: vi.fn(),
    initLocalDatabase: vi.fn<(owner: string | null) => Promise<void>>(() => Promise.resolve()),
    clearAppleBinding: vi.fn(() => Promise.resolve()),
    bindAppleCredential: vi.fn(() => Promise.resolve()),
    safetyCheck: vi.fn(() => Promise.resolve()),
}));

const accountA = {
    id: 'account-a',
    email: 'a@example.com',
    user_metadata: {},
    identities: [
        {
            provider: 'apple',
            identity_id: 'apple-sub-account-a',
            identity_data: { sub: 'apple-sub-account-a' },
        },
    ],
};

vi.mock('../services/supabase', () => ({
    supabase: {
        auth: {
            getSession: authMocks.getSession,
            onAuthStateChange: authMocks.onAuthStateChange,
            signOut: authMocks.signOut,
        },
    },
}));

vi.mock('../services/PushNotificationService', () => ({
    PushNotificationService: {
        initialize: authMocks.initializePush,
        setUser: authMocks.setPushUser,
        clearUser: authMocks.clearPushUser,
    },
}));

vi.mock('../services/sentry', () => ({
    setUser: authMocks.setSentryUser,
}));

vi.mock('../services/auth/appleCredentialState', () => ({
    bindAppleCredentialUser: authMocks.bindAppleCredential,
    clearBoundAppleCredential: authMocks.clearAppleBinding,
}));

vi.mock('../services/vessel/LocalDatabase', () => ({
    initLocalDatabase: authMocks.initLocalDatabase,
}));

vi.mock('../services/activeSafetyInterlock', () => ({
    assertNoActiveSafetyMonitor: authMocks.safetyCheck,
}));

async function loadAuthenticatedStore() {
    const identity = await import('../services/authIdentityScope');
    const { useAuthStore } = await import('../stores/authStore');
    await vi.waitFor(() => expect(useAuthStore.getState().authChecked).toBe(true));
    expect(useAuthStore.getState().user?.id).toBe(accountA.id);
    return { identity, useAuthStore };
}

beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    authMocks.getSession.mockResolvedValue({ data: { session: { user: accountA } } });
    authMocks.onAuthStateChange.mockReturnValue({
        data: { subscription: { unsubscribe: vi.fn() } },
    });
    authMocks.signOut.mockResolvedValue({ error: null });
    authMocks.safetyCheck.mockResolvedValue(undefined);
});

describe('authStore logout isolation', () => {
    it('checks safety first and leaves every subsystem anonymous after success', async () => {
        const { identity, useAuthStore } = await loadAuthenticatedStore();
        authMocks.initLocalDatabase.mockClear();
        authMocks.clearPushUser.mockClear();

        const logout = useAuthStore.getState().logout();

        await logout;

        expect(authMocks.safetyCheck).toHaveBeenCalledWith('sign out');
        expect(authMocks.clearPushUser).toHaveBeenCalledOnce();
        expect(authMocks.initLocalDatabase).toHaveBeenCalledWith(null);
        expect(authMocks.signOut).toHaveBeenCalledOnce();
        expect(useAuthStore.getState().user).toBeNull();
        expect(identity.getAuthIdentityScope().key).toBe('anonymous');
    });

    it('fully restores the previous account when Supabase rejects sign-out', async () => {
        const signOutError = new Error('network refused sign-out');
        authMocks.signOut.mockResolvedValueOnce({ error: signOutError });
        const { identity, useAuthStore } = await loadAuthenticatedStore();
        authMocks.initLocalDatabase.mockClear();
        authMocks.setPushUser.mockClear();
        authMocks.setSentryUser.mockClear();

        await expect(useAuthStore.getState().logout()).rejects.toBe(signOutError);

        expect(authMocks.initLocalDatabase.mock.calls.map(([owner]) => owner)).toEqual([null, 'account-a']);
        expect(authMocks.setPushUser).toHaveBeenCalledWith('account-a');
        expect(authMocks.bindAppleCredential).toHaveBeenCalledWith('apple-sub-account-a');
        expect(authMocks.setSentryUser).toHaveBeenLastCalledWith({ id: 'account-a' });
        expect(identity.getAuthIdentityScope().userId).toBe('account-a');
        expect(useAuthStore.getState().user?.id).toBe('account-a');
    });

    it('does not mutate identity or contact sign-out services while a safety monitor is active', async () => {
        const safetyError = new Error('Man Overboard is active on this device. Clear it before you sign out.');
        authMocks.safetyCheck.mockRejectedValueOnce(safetyError);
        const { identity, useAuthStore } = await loadAuthenticatedStore();
        authMocks.signOut.mockClear();
        authMocks.clearPushUser.mockClear();
        authMocks.initLocalDatabase.mockClear();

        await expect(useAuthStore.getState().logout()).rejects.toBe(safetyError);

        expect(authMocks.signOut).not.toHaveBeenCalled();
        expect(authMocks.clearPushUser).not.toHaveBeenCalled();
        expect(authMocks.initLocalDatabase).not.toHaveBeenCalled();
        expect(identity.getAuthIdentityScope().userId).toBe(accountA.id);
        expect(useAuthStore.getState().user?.id).toBe(accountA.id);
    });

    it('does not sign out when push isolation cannot make the native device safe', async () => {
        const isolationError = new Error('push isolation failed');
        authMocks.clearPushUser.mockRejectedValueOnce(isolationError);
        const { identity, useAuthStore } = await loadAuthenticatedStore();
        authMocks.signOut.mockClear();
        authMocks.setPushUser.mockClear();

        await expect(useAuthStore.getState().logout()).rejects.toBe(isolationError);

        expect(authMocks.signOut).not.toHaveBeenCalled();
        expect(authMocks.setPushUser).toHaveBeenCalledWith('account-a');
        expect(identity.getAuthIdentityScope().userId).toBe('account-a');
        expect(useAuthStore.getState().user?.id).toBe('account-a');
    });

    it('restores the previous account when signOut throws instead of returning an error', async () => {
        authMocks.signOut.mockRejectedValueOnce(new Error('offline'));
        const { identity, useAuthStore } = await loadAuthenticatedStore();

        await expect(useAuthStore.getState().logout()).rejects.toThrow('offline');

        expect(identity.getAuthIdentityScope().userId).toBe('account-a');
        expect(useAuthStore.getState().user?.id).toBe('account-a');
        expect(authMocks.setPushUser).toHaveBeenCalledWith('account-a');
        expect(authMocks.bindAppleCredential).toHaveBeenCalledWith('apple-sub-account-a');
    });

    it('keeps the app fenced when an Apple binding cannot be restored after logout rollback', async () => {
        authMocks.signOut.mockResolvedValueOnce({ error: new Error('network refused sign-out') });
        authMocks.bindAppleCredential.mockRejectedValueOnce(new Error('Apple credential revoked'));
        const { identity, useAuthStore } = await loadAuthenticatedStore();

        await expect(useAuthStore.getState().logout()).rejects.toThrow('network refused sign-out');

        expect(authMocks.bindAppleCredential).toHaveBeenCalledWith('apple-sub-account-a');
        expect(useAuthStore.getState().user).toBeNull();
        expect(identity.getAuthIdentityScope().userId).toBeNull();
    });

    it('fences a native revoked event only when its Apple subject matches the current account', async () => {
        const { identity, useAuthStore } = await loadAuthenticatedStore();
        const { handleNativeAppleCredentialRevocation } = await import('../stores/authStore');
        authMocks.signOut.mockClear();
        authMocks.clearPushUser.mockClear();
        authMocks.initLocalDatabase.mockClear();

        await handleNativeAppleCredentialRevocation('apple-sub-account-a');

        expect(useAuthStore.getState().user).toBeNull();
        expect(identity.getAuthIdentityScope().userId).toBeNull();
        expect(authMocks.signOut).toHaveBeenCalledWith({ scope: 'local' });
        expect(authMocks.clearPushUser).toHaveBeenCalledOnce();
        expect(authMocks.initLocalDatabase).toHaveBeenCalledWith(null);
    });

    it('ignores a retained Apple revocation event from a different account', async () => {
        const { identity, useAuthStore } = await loadAuthenticatedStore();
        const { handleNativeAppleCredentialRevocation } = await import('../stores/authStore');
        authMocks.signOut.mockClear();
        authMocks.clearPushUser.mockClear();

        await handleNativeAppleCredentialRevocation('apple-sub-old-account');

        expect(useAuthStore.getState().user?.id).toBe('account-a');
        expect(identity.getAuthIdentityScope().userId).toBe('account-a');
        expect(authMocks.signOut).not.toHaveBeenCalled();
        expect(authMocks.clearPushUser).not.toHaveBeenCalled();
        expect(authMocks.clearAppleBinding).toHaveBeenCalled();
    });
});

describe('a native Apple revocation that finishes late (cause 6, build 124)', () => {
    type AuthCallback = (event: string, session: { user: typeof accountA } | null) => void;
    const authCallback = () => authMocks.onAuthStateChange.mock.calls[0][0] as AuthCallback;
    function deferred() {
        let resolve!: () => void;
        const promise = new Promise<void>((res) => {
            resolve = res;
        });
        return { promise, resolve };
    }
    // A fresh retry by the same sailor is the same Supabase user in a new session object.
    const retriedAccountA = () => ({ ...accountA, last_sign_in_at: '2026-10-08T03:00:00Z' });

    it('cannot sign out a fresh retry of the same account that landed while it was still tidying up', async () => {
        const { identity, useAuthStore } = await loadAuthenticatedStore();
        const { handleNativeAppleCredentialRevocation } = await import('../stores/authStore');
        const pushRelease = deferred();
        authMocks.clearPushUser.mockReturnValueOnce(pushRelease.promise);

        const revocation = handleNativeAppleCredentialRevocation('apple-sub-account-a');
        await vi.waitFor(() => expect(authMocks.signOut).toHaveBeenCalledWith({ scope: 'local' }));
        expect(useAuthStore.getState().user).toBeNull();

        // The sailor taps Sign in with Apple again; Supabase signs the retry in.
        authCallback()('SIGNED_IN', { user: retriedAccountA() });
        expect(useAuthStore.getState().user?.id).toBe('account-a');

        pushRelease.resolve();
        await revocation;

        expect(useAuthStore.getState().user?.id).toBe('account-a');
        expect(identity.getAuthIdentityScope().userId).toBe('account-a');
    });

    it('cannot sign out a different account that signed in while it was tidying up', async () => {
        const { useAuthStore } = await loadAuthenticatedStore();
        const { handleNativeAppleCredentialRevocation } = await import('../stores/authStore');
        const pushRelease = deferred();
        authMocks.clearPushUser.mockReturnValueOnce(pushRelease.promise);

        const revocation = handleNativeAppleCredentialRevocation('apple-sub-account-a');
        await vi.waitFor(() => expect(authMocks.signOut).toHaveBeenCalled());
        authCallback()('SIGNED_IN', {
            user: { ...accountA, id: 'account-b', identities: [] } as unknown as typeof accountA,
        });
        pushRelease.resolve();
        await revocation;

        expect(useAuthStore.getState().user?.id).toBe('account-b');
    });

    it('still fences the revoked session when a stale callback re-shows it before the local sign-out lands', async () => {
        const { identity, useAuthStore } = await loadAuthenticatedStore();
        const { handleNativeAppleCredentialRevocation } = await import('../stores/authStore');
        const signOutDone = deferred();
        authMocks.signOut.mockImplementationOnce(async () => {
            await signOutDone.promise;
            return { error: null };
        });

        const revocation = handleNativeAppleCredentialRevocation('apple-sub-account-a');
        await vi.waitFor(() => expect(authMocks.signOut).toHaveBeenCalled());
        // The revoked session itself, refreshed or recovered before it was removed.
        authCallback()('TOKEN_REFRESHED', { user: accountA });
        authCallback()('SIGNED_IN', { user: accountA });
        signOutDone.resolve();
        await revocation;

        expect(useAuthStore.getState().user).toBeNull();
        expect(identity.getAuthIdentityScope().userId).toBeNull();
    });

    it('fails closed when the local sign-out could not remove the revoked session', async () => {
        const { useAuthStore } = await loadAuthenticatedStore();
        const { handleNativeAppleCredentialRevocation } = await import('../stores/authStore');
        const pushRelease = deferred();
        authMocks.clearPushUser.mockReturnValueOnce(pushRelease.promise);
        authMocks.signOut.mockResolvedValueOnce({ error: new Error('offline') });

        const revocation = handleNativeAppleCredentialRevocation('apple-sub-account-a');
        await vi.waitFor(() => expect(authMocks.signOut).toHaveBeenCalled());
        await Promise.resolve();
        authCallback()('SIGNED_IN', { user: accountA });
        pushRelease.resolve();
        await revocation;

        expect(useAuthStore.getState().user).toBeNull();
    });
});

describe('fenceSignedOutOnThisDevice (a discarded Apple session that Supabase could not sign out, build 124)', () => {
    it('leaves every subsystem anonymous without calling Supabase', async () => {
        const { identity, useAuthStore } = await loadAuthenticatedStore();
        const { fenceSignedOutOnThisDevice } = await import('../stores/authStore');
        authMocks.signOut.mockClear();
        authMocks.clearPushUser.mockClear();
        authMocks.initLocalDatabase.mockClear();
        authMocks.setSentryUser.mockClear();

        await fenceSignedOutOnThisDevice();

        expect(useAuthStore.getState().user).toBeNull();
        expect(useAuthStore.getState().authChecked).toBe(true);
        expect(identity.getAuthIdentityScope().userId).toBeNull();
        expect(authMocks.setSentryUser).toHaveBeenCalledWith(null);
        expect(authMocks.clearPushUser).toHaveBeenCalledOnce();
        expect(authMocks.initLocalDatabase).toHaveBeenCalledWith(null);
        expect(authMocks.signOut).not.toHaveBeenCalled();
    });

    it('still fences when a cleanup step fails', async () => {
        const { identity, useAuthStore } = await loadAuthenticatedStore();
        const { fenceSignedOutOnThisDevice } = await import('../stores/authStore');
        authMocks.clearPushUser.mockRejectedValueOnce(new Error('push release failed'));
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

        await expect(fenceSignedOutOnThisDevice()).resolves.toBeUndefined();

        expect(useAuthStore.getState().user).toBeNull();
        expect(identity.getAuthIdentityScope().userId).toBeNull();
        expect(authMocks.initLocalDatabase).toHaveBeenLastCalledWith(null);
        consoleError.mockRestore();
    });
});
