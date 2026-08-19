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

/**
 * The provisional boot identity — and, above all, the three ways it can be
 * WRONG, each of which must fence exactly as a real logout/login does.
 *
 * WHY IT EXISTS. The scope began as `anonymous` on every cold start and
 * stayed there until supabase.auth.getSession() resolved. In that window the
 * SAME user was fenced out of their OWN device state: the Log page read the
 * persisted tracking record under the wrong owner and got nothing, so the
 * live map's container did not exist for several seconds after launch
 * (Shane, 2026-08-20: "not even the outline of the box"). The scope now
 * boots from the last confirmed user id and the real session confirms or
 * overrides it.
 *
 * Each test re-imports the module so the boot-time read actually runs.
 */
describe('authIdentityScope — provisional boot identity', () => {
    const LAST_USER_KEY = 'thalassa_last_user_id_v1';

    const freshModule = async () => {
        vi.resetModules();
        return import('../services/authIdentityScope');
    };

    afterEach(() => {
        localStorage.removeItem(LAST_USER_KEY);
    });

    it('boots scoped to the last confirmed user, before any auth call', async () => {
        localStorage.setItem(LAST_USER_KEY, 'user-42');
        const mod = await freshModule();
        const scope = mod.getAuthIdentityScope();
        expect(scope.userId).toBe('user-42');
        expect(scope.key).toBe('user:user-42');
        // A scoped read made RIGHT NOW resolves under the real owner — which
        // is the whole point: the Log page's tracking seed no longer reads
        // under `anonymous` and gets fenced out of its own record.
        expect(mod.authScopedStorageKey('tracking')).toContain('user%3Auser-42');
    });

    it('boots anonymous when nothing was ever confirmed', async () => {
        const mod = await freshModule();
        expect(mod.getAuthIdentityScope().userId).toBeNull();
        expect(mod.getAuthIdentityScope().key).toBe('anonymous');
    });

    it('WRONG CASE 1 — session confirms the SAME user: a no-op, nothing resets', async () => {
        localStorage.setItem(LAST_USER_KEY, 'user-42');
        const mod = await freshModule();
        const seen = vi.fn();
        const unsub = mod.subscribeAuthIdentityScope(seen);
        const before = mod.getAuthIdentityScope();
        const after = mod.setAuthIdentityScope('user-42');
        expect(after).toBe(before);
        expect(after.generation).toBe(before.generation);
        expect(seen).not.toHaveBeenCalled(); // no fence fired — correct, same owner
        unsub();
    });

    it('WRONG CASE 2 — the user had logged out: flips to anonymous and FENCES', async () => {
        // A provisional identity must never outlive a session that says
        // "nobody". Same behaviour as a logout today: new generation, every
        // subscriber told, every in-flight read rejected.
        localStorage.setItem(LAST_USER_KEY, 'user-42');
        const mod = await freshModule();
        const seen = vi.fn();
        const unsub = mod.subscribeAuthIdentityScope(seen);
        const provisional = mod.getAuthIdentityScope();
        const real = mod.setAuthIdentityScope(null);
        expect(real.key).toBe('anonymous');
        expect(real.generation).toBe(provisional.generation + 1);
        expect(seen).toHaveBeenCalledOnce();
        expect(mod.isAuthIdentityScopeCurrent(provisional)).toBe(false);
        // And the mirror is cleared, so the NEXT boot does not re-seed a
        // user who is no longer signed in.
        expect(localStorage.getItem(LAST_USER_KEY)).toBeNull();
        unsub();
    });

    it('WRONG CASE 3 — a DIFFERENT user signed in: flips to them and FENCES', async () => {
        // Two accounts on one handset. The provisional scope is account A;
        // the session says account B. Every fence must reset, exactly as a
        // logout+login does, and B must never see A's state.
        localStorage.setItem(LAST_USER_KEY, 'user-A');
        const mod = await freshModule();
        const seen = vi.fn();
        const unsub = mod.subscribeAuthIdentityScope(seen);
        const provisional = mod.getAuthIdentityScope();
        const real = mod.setAuthIdentityScope('user-B');
        expect(real.userId).toBe('user-B');
        expect(real.generation).toBe(provisional.generation + 1);
        expect(seen).toHaveBeenCalledOnce();
        expect(mod.isAuthIdentityScopeCurrent(provisional)).toBe(false);
        // Scoped keys are now B's, not A's.
        expect(mod.authScopedStorageKey('tracking')).toContain('user%3Auser-B');
        expect(mod.authScopedStorageKey('tracking')).not.toContain('user-A');
        // Mirror updated for next boot.
        expect(localStorage.getItem(LAST_USER_KEY)).toBe('user-B');
        unsub();
    });

    it('mirrors every confirmed identity for the next boot', async () => {
        const mod = await freshModule();
        mod.setAuthIdentityScope('user-7');
        expect(localStorage.getItem(LAST_USER_KEY)).toBe('user-7');
        mod.setAuthIdentityScope(null);
        expect(localStorage.getItem(LAST_USER_KEY)).toBeNull();
    });
});
