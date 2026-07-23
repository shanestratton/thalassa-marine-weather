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
}));

const accountA = {
    id: 'account-a',
    email: 'a@example.com',
    user_metadata: {},
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

vi.mock('../services/vessel/LocalDatabase', () => ({
    initLocalDatabase: authMocks.initLocalDatabase,
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
});

describe('authStore logout isolation', () => {
    it('hides the account immediately and leaves every subsystem anonymous after success', async () => {
        const { identity, useAuthStore } = await loadAuthenticatedStore();
        authMocks.initLocalDatabase.mockClear();
        authMocks.clearPushUser.mockClear();

        const logout = useAuthStore.getState().logout();

        expect(useAuthStore.getState().user).toBeNull();
        expect(identity.getAuthIdentityScope().userId).toBeNull();
        await logout;

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

        const logout = useAuthStore.getState().logout();
        expect(useAuthStore.getState().user).toBeNull();
        expect(identity.getAuthIdentityScope().userId).toBeNull();

        await expect(logout).rejects.toBe(signOutError);

        expect(authMocks.initLocalDatabase.mock.calls.map(([owner]) => owner)).toEqual([null, 'account-a']);
        expect(authMocks.setPushUser).toHaveBeenCalledWith('account-a');
        expect(authMocks.setSentryUser).toHaveBeenLastCalledWith({
            id: 'account-a',
            email: 'a@example.com',
        });
        expect(identity.getAuthIdentityScope().userId).toBe('account-a');
        expect(useAuthStore.getState().user?.id).toBe('account-a');
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
    });
});
