import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('../services/supabase');

const storageMocks = vi.hoisted(() => {
    process.env.SUPABASE_URL = process.env.SUPABASE_URL || 'https://auth-storage-test.supabase.co';
    process.env.SUPABASE_KEY = process.env.SUPABASE_KEY || 'auth-storage-test-anon-key';
    const native = new Map<string, string>();
    return {
        native,
        get: vi.fn(async ({ key }: { key: string }) => ({ value: native.get(key) ?? null })),
        set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            native.set(key, value);
        }),
        remove: vi.fn(async ({ key }: { key: string }) => {
            native.delete(key);
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
        get: storageMocks.get,
        set: storageMocks.set,
        remove: storageMocks.remove,
    },
}));

import { capacitorAuthStorage, migrateAuthSessionToCapacitor } from '../services/supabase';

const SESSION_KEY = 'thalassa-auth-session';

describe('Supabase native auth storage', () => {
    beforeEach(async () => {
        // Wait for the module's one-shot migration before resetting its mocked
        // backends for an individual race scenario.
        await capacitorAuthStorage.getItem('__queue_barrier__');
        localStorage.clear();
        storageMocks.native.clear();
        vi.clearAllMocks();
    });

    it('purges a stale local bearer duplicate when native storage is already authoritative', async () => {
        storageMocks.native.set(SESSION_KEY, 'native-current-session');
        localStorage.setItem(SESSION_KEY, 'stale-local-session');

        await migrateAuthSessionToCapacitor();

        expect(storageMocks.native.get(SESSION_KEY)).toBe('native-current-session');
        expect(localStorage.getItem(SESSION_KEY)).toBeNull();
        expect(storageMocks.set).not.toHaveBeenCalled();
    });

    it('copies a legacy local session once and removes the plaintext shadow', async () => {
        localStorage.setItem(SESSION_KEY, 'legacy-local-session');

        await migrateAuthSessionToCapacitor();

        expect(storageMocks.native.get(SESSION_KEY)).toBe('legacy-local-session');
        expect(localStorage.getItem(SESSION_KEY)).toBeNull();
    });

    it('purges both stores on logout so a later migration cannot resurrect the account', async () => {
        storageMocks.native.set(SESSION_KEY, 'account-a-session');
        localStorage.setItem(SESSION_KEY, 'account-a-session');
        await migrateAuthSessionToCapacitor();

        await capacitorAuthStorage.removeItem(SESSION_KEY);
        await migrateAuthSessionToCapacitor();

        expect(storageMocks.native.has(SESSION_KEY)).toBe(false);
        expect(localStorage.getItem(SESSION_KEY)).toBeNull();
        expect(storageMocks.set).not.toHaveBeenCalled();
    });

    it('serializes a delayed migration before logout, leaving logout as the final mutation', async () => {
        let releaseNativeWrite: (() => void) | undefined;
        storageMocks.set.mockImplementationOnce(
            ({ key, value }: { key: string; value: string }) =>
                new Promise<void>((resolve) => {
                    releaseNativeWrite = () => {
                        storageMocks.native.set(key, value);
                        resolve();
                    };
                }),
        );
        localStorage.setItem(SESSION_KEY, 'account-a-session');

        const migration = migrateAuthSessionToCapacitor();
        await vi.waitFor(() => expect(storageMocks.set).toHaveBeenCalledOnce());
        const logout = capacitorAuthStorage.removeItem(SESSION_KEY);
        expect(storageMocks.remove).not.toHaveBeenCalled();

        releaseNativeWrite?.();
        await migration;
        await logout;

        expect(storageMocks.native.has(SESSION_KEY)).toBe(false);
        expect(localStorage.getItem(SESSION_KEY)).toBeNull();
        expect(storageMocks.remove).toHaveBeenCalledWith({ key: SESSION_KEY });
    });
});
