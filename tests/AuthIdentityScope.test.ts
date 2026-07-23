import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    setAuthIdentityScope,
    subscribeAuthIdentityScope,
} from '../services/authIdentityScope';

afterEach(() => {
    setAuthIdentityScope(null);
    vi.restoreAllMocks();
});

describe('authIdentityScope', () => {
    it('normalizes identities and treats the same identity as a no-op', () => {
        const seen = vi.fn();
        const unsubscribe = subscribeAuthIdentityScope(seen);

        const first = setAuthIdentityScope('  skipper@example.com  ');
        const repeated = setAuthIdentityScope('skipper@example.com');

        expect(repeated).toBe(first);
        expect(getAuthIdentityScope()).toBe(first);
        expect(first.userId).toBe('skipper@example.com');
        expect(seen).toHaveBeenCalledOnce();
        expect(authScopedStorageKey('private data', first)).toBe('private data::user%3Askipper%40example.com');
        unsubscribe();
    });

    it('continues fencing every subscriber when one subscriber throws', () => {
        const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const first = vi.fn(() => {
            throw new Error('broken subscriber');
        });
        const second = vi.fn();
        const unsubscribeFirst = subscribeAuthIdentityScope(first);
        const unsubscribeSecond = subscribeAuthIdentityScope(second);

        const next = setAuthIdentityScope('account-b');

        expect(first).toHaveBeenCalledOnce();
        expect(second).toHaveBeenCalledWith(next, expect.objectContaining({ userId: null }));
        expect(getAuthIdentityScope()).toBe(next);
        expect(consoleError).toHaveBeenCalledWith('[AuthIdentityScope] Identity subscriber failed:', expect.any(Error));

        unsubscribeFirst();
        unsubscribeSecond();
    });

    it('uses a distinct anonymous namespace with a new generation after logout', () => {
        const account = setAuthIdentityScope('account-a');
        const anonymous = setAuthIdentityScope(null);

        expect(account.key).toBe('user:account-a');
        expect(anonymous).toMatchObject({ key: 'anonymous', userId: null });
        expect(anonymous.generation).toBe(account.generation + 1);
        expect(authScopedStorageKey('queue', anonymous)).toBe('queue::anonymous');
    });
});
