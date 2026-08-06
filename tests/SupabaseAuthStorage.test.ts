import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('../services/supabase');

const storageMocks = vi.hoisted(() => {
    process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://auth-storage-test.supabase.co';
    process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'auth-storage-test-anon-key';
    const secure = new Map<string, string>();
    const legacyNative = new Map<string, string>();
    const allowedKeys = new Set([
        'thalassa-auth-session',
        'thalassa-auth-session-code-verifier',
        'thalassa-auth-session-user',
    ]);
    const assertAllowed = (key: string) => {
        if (!allowedKeys.has(key)) throw new Error(`native allowlist rejects ${key}`);
    };
    return {
        secure,
        legacyNative,
        allowedKeys,
        secureGet: vi.fn(async (key: string) => {
            assertAllowed(key);
            return secure.get(key) ?? null;
        }),
        secureSet: vi.fn(async (key: string, value: string) => {
            assertAllowed(key);
            secure.set(key, value);
        }),
        secureRemove: vi.fn(async (key: string) => {
            assertAllowed(key);
            secure.delete(key);
        }),
        preferencesGet: vi.fn(async ({ key }: { key: string }) => ({ value: legacyNative.get(key) ?? null })),
        preferencesSet: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            legacyNative.set(key, value);
        }),
        preferencesRemove: vi.fn(async ({ key }: { key: string }) => {
            legacyNative.delete(key);
        }),
    };
});

vi.mock('@supabase/supabase-js', () => ({
    createClient: () => ({
        auth: {
            getSession: vi.fn(),
        },
        from: vi.fn(),
    }),
}));

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: storageMocks.preferencesGet,
        set: storageMocks.preferencesSet,
        remove: storageMocks.preferencesRemove,
    },
}));

vi.mock('../services/auth/secureStorage', () => ({
    SECURE_AUTH_STORAGE_KEYS: [...storageMocks.allowedKeys],
    usesNativeSecureStorage: () => true,
    getSecureValue: storageMocks.secureGet,
    setSecureValue: storageMocks.secureSet,
    removeSecureValue: storageMocks.secureRemove,
}));

import { capacitorAuthStorage, migrateAuthSessionToCapacitor } from '../services/supabase';

const SESSION_KEY = 'thalassa-auth-session';
const CODE_VERIFIER_KEY = `${SESSION_KEY}-code-verifier`;
const USER_KEY = `${SESSION_KEY}-user`;
const INSTALL_MARKER_KEY = 'thalassa-secure-auth-install-v1';

describe('Supabase native auth storage', () => {
    beforeEach(async () => {
        // Wait for the module's one-shot migration before resetting its mocked
        // backends for an individual race scenario.
        await capacitorAuthStorage.getItem(SESSION_KEY);
        for (const key of storageMocks.allowedKeys) await capacitorAuthStorage.removeItem(key);
        localStorage.clear();
        storageMocks.secure.clear();
        storageMocks.legacyNative.clear();
        vi.clearAllMocks();
    });

    it('purges a stale local bearer duplicate when native storage is already authoritative', async () => {
        storageMocks.secure.set(SESSION_KEY, 'native-current-session');
        localStorage.setItem(SESSION_KEY, 'stale-local-session');

        await migrateAuthSessionToCapacitor();

        expect(storageMocks.secure.get(SESSION_KEY)).toBe('native-current-session');
        expect(localStorage.getItem(SESSION_KEY)).toBeNull();
        expect(storageMocks.secureSet).not.toHaveBeenCalled();
    });

    it('copies a legacy local session once and removes the plaintext shadow', async () => {
        localStorage.setItem(SESSION_KEY, 'legacy-local-session');

        await migrateAuthSessionToCapacitor();

        expect(storageMocks.secure.get(SESSION_KEY)).toBe('legacy-local-session');
        expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    });

    it('purges a Keychain bearer record orphaned by an iOS reinstall', async () => {
        storageMocks.legacyNative.delete(INSTALL_MARKER_KEY);
        storageMocks.secure.set(SESSION_KEY, 'session-from-uninstalled-copy');

        await migrateAuthSessionToCapacitor();

        expect(storageMocks.secure.has(SESSION_KEY)).toBe(false);
        expect(storageMocks.legacyNative.get(INSTALL_MARKER_KEY)).toBe('keychain-boundary-ready');
    });

    it('preserves and migrates a reviewed legacy bearer record when the install marker is introduced', async () => {
        storageMocks.legacyNative.delete(INSTALL_MARKER_KEY);
        localStorage.setItem(SESSION_KEY, 'upgrade-session');

        await migrateAuthSessionToCapacitor();

        expect(storageMocks.secure.get(SESSION_KEY)).toBe('upgrade-session');
        expect(localStorage.getItem(SESSION_KEY)).toBeNull();
        expect(storageMocks.legacyNative.get(INSTALL_MARKER_KEY)).toBe('keychain-boundary-ready');
    });

    it('read-verifies a legacy Preferences session before removing the plaintext copy', async () => {
        storageMocks.legacyNative.set(SESSION_KEY, 'legacy-preferences-session');

        await migrateAuthSessionToCapacitor();

        expect(storageMocks.secure.get(SESSION_KEY)).toBe('legacy-preferences-session');
        expect(storageMocks.legacyNative.has(SESSION_KEY)).toBe(false);
        expect(storageMocks.secureGet).toHaveBeenCalledWith(SESSION_KEY);
    });

    it('migrates the PKCE verifier and retires every reviewed plaintext auth key', async () => {
        storageMocks.legacyNative.set(CODE_VERIFIER_KEY, 'pkce-verifier');
        localStorage.setItem(USER_KEY, 'legacy-user');

        await migrateAuthSessionToCapacitor();

        expect(storageMocks.secure.get(CODE_VERIFIER_KEY)).toBe('pkce-verifier');
        expect(storageMocks.secure.get(USER_KEY)).toBe('legacy-user');
        expect(storageMocks.legacyNative.has(CODE_VERIFIER_KEY)).toBe(false);
        expect(localStorage.getItem(USER_KEY)).toBeNull();
    });

    it('keeps migrated Keychain state authoritative and retries a failed local shadow cleanup', async () => {
        localStorage.setItem(SESSION_KEY, 'legacy-local-session');
        const removeSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => {
            throw new Error('local storage unavailable');
        });

        await migrateAuthSessionToCapacitor();

        expect(storageMocks.secure.get(SESSION_KEY)).toBe('legacy-local-session');
        expect(localStorage.getItem(SESSION_KEY)).toBe('legacy-local-session');

        removeSpy.mockRestore();
        await migrateAuthSessionToCapacitor();
        expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    });

    it('purges both stores on logout so a later migration cannot resurrect the account', async () => {
        storageMocks.secure.set(SESSION_KEY, 'account-a-session');
        localStorage.setItem(SESSION_KEY, 'account-a-session');
        await migrateAuthSessionToCapacitor();

        await capacitorAuthStorage.removeItem(SESSION_KEY);
        await migrateAuthSessionToCapacitor();

        expect(storageMocks.secure.has(SESSION_KEY)).toBe(false);
        expect(localStorage.getItem(SESSION_KEY)).toBeNull();
        expect(storageMocks.secureSet).not.toHaveBeenCalled();
    });

    it('does not report logout complete while a legacy Preferences bearer record survives', async () => {
        storageMocks.secure.set(SESSION_KEY, 'account-a-session');
        storageMocks.legacyNative.set(SESSION_KEY, 'account-a-session');
        localStorage.setItem(SESSION_KEY, 'account-a-session');
        storageMocks.preferencesRemove.mockRejectedValueOnce(new Error('Preferences unavailable'));

        await expect(capacitorAuthStorage.removeItem(SESSION_KEY)).rejects.toThrow('Preferences unavailable');
        expect(storageMocks.secure.has(SESSION_KEY)).toBe(false);
        expect(storageMocks.legacyNative.get(SESSION_KEY)).toBe('account-a-session');
        expect(localStorage.getItem(SESSION_KEY)).toBe('account-a-session');

        await expect(capacitorAuthStorage.removeItem(SESSION_KEY)).resolves.toBeUndefined();
        expect(storageMocks.legacyNative.has(SESSION_KEY)).toBe(false);
        expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    });

    it('does not report a secure write complete while a plaintext Preferences shadow survives', async () => {
        storageMocks.legacyNative.set(SESSION_KEY, 'stale-session');
        localStorage.setItem(SESSION_KEY, 'stale-session');
        storageMocks.preferencesRemove.mockRejectedValueOnce(new Error('Preferences unavailable'));

        await expect(capacitorAuthStorage.setItem(SESSION_KEY, 'fresh-session')).rejects.toThrow(
            'Preferences unavailable',
        );
        expect(storageMocks.secure.get(SESSION_KEY)).toBe('fresh-session');
        expect(storageMocks.legacyNative.get(SESSION_KEY)).toBe('stale-session');
        expect(localStorage.getItem(SESSION_KEY)).toBe('stale-session');

        await expect(capacitorAuthStorage.setItem(SESSION_KEY, 'fresh-session')).resolves.toBeUndefined();
        expect(storageMocks.legacyNative.has(SESSION_KEY)).toBe(false);
        expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    });

    it('does not report a secure write complete while a plaintext local shadow survives', async () => {
        localStorage.setItem(SESSION_KEY, 'stale-session');
        const removeSpy = vi.spyOn(Storage.prototype, 'removeItem').mockImplementationOnce(() => {
            throw new Error('local storage unavailable');
        });

        await expect(capacitorAuthStorage.setItem(SESSION_KEY, 'fresh-session')).rejects.toThrow(
            'local storage unavailable',
        );
        expect(storageMocks.secure.get(SESSION_KEY)).toBe('fresh-session');
        expect(localStorage.getItem(SESSION_KEY)).toBe('stale-session');

        removeSpy.mockRestore();
        await expect(capacitorAuthStorage.setItem(SESSION_KEY, 'fresh-session')).resolves.toBeUndefined();
        expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    });

    it('serializes a delayed migration before logout, leaving logout as the final mutation', async () => {
        let releaseNativeWrite: (() => void) | undefined;
        storageMocks.secureSet.mockImplementationOnce(
            (key: string, value: string) =>
                new Promise<void>((resolve) => {
                    releaseNativeWrite = () => {
                        storageMocks.secure.set(key, value);
                        resolve();
                    };
                }),
        );
        localStorage.setItem(SESSION_KEY, 'account-a-session');

        const migration = migrateAuthSessionToCapacitor();
        await vi.waitFor(() => expect(storageMocks.secureSet).toHaveBeenCalledOnce());
        const logout = capacitorAuthStorage.removeItem(SESSION_KEY);
        expect(storageMocks.secureRemove).not.toHaveBeenCalled();

        releaseNativeWrite?.();
        await migration;
        await logout;

        expect(storageMocks.secure.has(SESSION_KEY)).toBe(false);
        expect(localStorage.getItem(SESSION_KEY)).toBeNull();
        expect(storageMocks.secureRemove).toHaveBeenCalledWith(SESSION_KEY);
    });

    it('serves repeated session reads from memory while preserving write and logout ordering', async () => {
        const key = CODE_VERIFIER_KEY;
        await capacitorAuthStorage.setItem(key, 'session-a');
        vi.clearAllMocks();

        await expect(capacitorAuthStorage.getItem(key)).resolves.toBe('session-a');
        await expect(capacitorAuthStorage.getItem(key)).resolves.toBe('session-a');
        expect(storageMocks.secureGet).not.toHaveBeenCalled();

        await capacitorAuthStorage.setItem(key, 'session-b');
        await expect(capacitorAuthStorage.getItem(key)).resolves.toBe('session-b');
        expect(storageMocks.secureGet).not.toHaveBeenCalled();

        await capacitorAuthStorage.removeItem(key);
        await expect(capacitorAuthStorage.getItem(key)).resolves.toBeNull();
        expect(storageMocks.secureGet).not.toHaveBeenCalled();
    });

    it('rejects keys outside the exact Supabase Auth storage contract', async () => {
        await expect(capacitorAuthStorage.setItem('thalassa-auth-session-unreviewed', 'secret')).rejects.toThrow(
            'native allowlist rejects',
        );
    });
});
