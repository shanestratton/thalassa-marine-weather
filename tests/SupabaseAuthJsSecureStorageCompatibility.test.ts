import { AuthUnknownError, GoTrueClient } from '@supabase/auth-js';
import type { LockFunc, SupportedStorage } from '@supabase/auth-js';
import { describe, expect, it, vi } from 'vitest';

const STORAGE_KEY = 'thalassa-auth-session';
const REVIEWED_STORAGE_KEYS = [STORAGE_KEY, `${STORAGE_KEY}-code-verifier`, `${STORAGE_KEY}-user`] as const;
const reviewedStorageKeySet = new Set<string>(REVIEWED_STORAGE_KEYS);

type StorageOperation = {
    method: 'get' | 'set' | 'remove';
    key: string;
};

/**
 * Mirrors the native plugin's fail-closed exact allowlist. Any new key used by
 * auth-js must be reviewed before this contract and the Keychain plugin move.
 */
class NativeFaithfulAuthStorage implements SupportedStorage {
    readonly operations: StorageOperation[] = [];
    private readonly values = new Map<string, string>();

    seed(key: (typeof REVIEWED_STORAGE_KEYS)[number], value: string): void {
        this.values.set(key, value);
    }

    getItem(key: string): string | null {
        this.assertReviewed(key);
        this.operations.push({ method: 'get', key });
        return this.values.get(key) ?? null;
    }

    setItem(key: string, value: string): void {
        this.assertReviewed(key);
        this.operations.push({ method: 'set', key });
        this.values.set(key, value);
    }

    removeItem(key: string): void {
        this.assertReviewed(key);
        this.operations.push({ method: 'remove', key });
        this.values.delete(key);
    }

    private assertReviewed(key: string): void {
        if (!reviewedStorageKeySet.has(key)) throw new Error(`auth-js requested unreviewed storage key: ${key}`);
    }
}

const processLocalLock: LockFunc = async <Result>(
    _name: string,
    _acquireTimeout: number,
    operation: () => Promise<Result>,
): Promise<Result> => operation();

describe('installed auth-js secure-storage compatibility', () => {
    it('initializes and completes PKCE/save/remove flows within the reviewed native key family', async () => {
        window.history.replaceState(null, '', '/');

        const storage = new NativeFaithfulAuthStorage();
        storage.seed(`${STORAGE_KEY}-code-verifier`, JSON.stringify('retained-pkce-verifier'));
        const networkFetch = vi.fn(async () => {
            throw new Error('The storage compatibility test must not make a network request');
        });

        const auth = new GoTrueClient({
            url: 'https://auth-storage-contract.invalid',
            headers: { apikey: 'offline-contract-test' },
            storageKey: STORAGE_KEY,
            storage,
            persistSession: true,
            autoRefreshToken: false,
            detectSessionInUrl: true,
            flowType: 'pkce',
            fetch: networkFetch as unknown as typeof fetch,
            lock: processLocalLock,
        });

        try {
            const initialized = await auth.initialize();
            expect(initialized.error).not.toBeInstanceOf(AuthUnknownError);
            expect(initialized.error).toBeNull();
            expect(storage.operations).toContainEqual({
                method: 'get',
                key: `${STORAGE_KEY}-code-verifier`,
            });

            const oauth = await auth.signInWithOAuth({
                provider: 'google',
                options: { skipBrowserRedirect: true },
            });
            expect(oauth.error).toBeNull();
            expect(storage.operations).toContainEqual({
                method: 'set',
                key: `${STORAGE_KEY}-code-verifier`,
            });

            const signedOut = await auth.signOut({ scope: 'local' });
            expect(signedOut.error).toBeNull();

            const mutations = storage.operations.filter(({ method }) => method === 'set' || method === 'remove');
            expect(mutations.length).toBeGreaterThan(0);
            expect(mutations.every(({ key }) => reviewedStorageKeySet.has(key))).toBe(true);
            expect(storage.operations.filter(({ method }) => method === 'remove')).toEqual(
                expect.arrayContaining([
                    { method: 'remove', key: STORAGE_KEY },
                    { method: 'remove', key: `${STORAGE_KEY}-code-verifier` },
                ]),
            );
            expect(networkFetch).not.toHaveBeenCalled();
        } finally {
            await auth.stopAutoRefresh();
        }
    });
});
