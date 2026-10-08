import { GoTrueClient } from '@supabase/auth-js';
import type { LockFunc, SupportedStorage } from '@supabase/auth-js';
import { describe, expect, it, vi } from 'vitest';

/**
 * The installed auth-js, as Sign in with Apple's discard relies on it (build
 * 124, package AC). signOut({ scope: 'local' }) still POSTs /logout first, and
 * when that call fails (offline, a 5xx) it returns the error and keeps the
 * session. SocialAuthService then removes the session on this device with
 * auth-js's own _removeSession, which needs no network and fires SIGNED_OUT.
 * That method is not public API, so this pins both halves to the installed
 * version: an auth-js upgrade that changes either one fails here first.
 */

const STORAGE_KEY = 'thalassa-auth-session';

class MemoryStorage implements SupportedStorage {
    readonly values = new Map<string, string>();
    getItem(key: string): string | null {
        return this.values.get(key) ?? null;
    }
    setItem(key: string, value: string): void {
        this.values.set(key, value);
    }
    removeItem(key: string): void {
        this.values.delete(key);
    }
}

const processLocalLock: LockFunc = async <Result>(
    _name: string,
    _acquireTimeout: number,
    operation: () => Promise<Result>,
): Promise<Result> => operation();

/** A fictional, unsigned access token: auth-js only reads its claims here. */
function fictionalAccessToken(sub: string, exp: number): string {
    const part = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${part({ alg: 'HS256', typ: 'JWT' })}.${part({ sub, exp, aud: 'authenticated', role: 'authenticated' })}.c2ln`;
}

function storedSession(): string {
    const expiresAt = Math.floor(Date.now() / 1000) + 3600;
    return JSON.stringify({
        access_token: fictionalAccessToken('sailor-in-valparaiso', expiresAt),
        refresh_token: 'fictional-refresh',
        token_type: 'bearer',
        expires_in: 3600,
        expires_at: expiresAt,
        user: {
            id: 'sailor-in-valparaiso',
            aud: 'authenticated',
            app_metadata: { provider: 'apple' },
            user_metadata: {},
            created_at: '2026-01-01T00:00:00Z',
        },
    });
}

describe('installed auth-js: a local sign-out that cannot reach Supabase', () => {
    it.each([
        ['offline', async () => Promise.reject(new TypeError('Load failed'))],
        ['a 503', async () => new Response('upstream unavailable', { status: 503 })],
    ])(
        'keeps the session when /logout is %s, and _removeSession then removes it with SIGNED_OUT',
        async (_label, reply) => {
            const storage = new MemoryStorage();
            storage.setItem(STORAGE_KEY, storedSession());
            const network = vi.fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>(reply);
            const auth = new GoTrueClient({
                url: 'https://auth-logout-contract.invalid',
                headers: { apikey: 'offline-contract-test' },
                storageKey: STORAGE_KEY,
                storage,
                persistSession: true,
                autoRefreshToken: false,
                detectSessionInUrl: false,
                fetch: network as unknown as typeof fetch,
                lock: processLocalLock,
            });
            await auth.initialize();
            const events: string[] = [];
            const { data } = auth.onAuthStateChange((event) => {
                events.push(event);
            });

            try {
                const { error } = await auth.signOut({ scope: 'local' });

                expect(error).not.toBeNull();
                expect(String(network.mock.calls[0]?.[0])).toContain('/logout?scope=local');
                expect(storage.getItem(STORAGE_KEY)).not.toBeNull();
                expect(events).not.toContain('SIGNED_OUT');

                const removal = (auth as unknown as { _removeSession?: () => Promise<void> })._removeSession;
                expect(typeof removal).toBe('function');
                const callsBefore = network.mock.calls.length;
                await removal!.call(auth);

                expect(network.mock.calls.length).toBe(callsBefore);
                expect(storage.getItem(STORAGE_KEY)).toBeNull();
                expect(events).toContain('SIGNED_OUT');
                expect((await auth.getSession()).data.session).toBeNull();
            } finally {
                data.subscription.unsubscribe();
            }
        },
    );
});
