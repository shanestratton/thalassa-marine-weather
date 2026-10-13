/**
 * Plan Your Day's two routing switches (127-PYD-2; Shane's decisions,
 * 2026-10-10): routing ON for his account only in 127's TestFlight, and the
 * "Route round the land" TAP (route-on-open only once his marina timings are
 * all ≤ 8 s). "His account" is the signed-in session whose email is the
 * platform owner's AND whose user id is this identity scope's: a rollout
 * flag, not a security boundary.
 *
 * Fictional accounts only: the owner's address is never written here, and
 * the cases that need an email pass a fictional one.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    PYD_ROUTE_ON_OPEN,
    PYD_ROUTING_FOR,
    isOwnerSession,
    pydRoutingAudience,
    readOwnerAccount,
} from '../services/dayPlanner/pydRouting';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { PLATFORM_OWNER_EMAIL } from '../services/chat/constants';
import { supabase } from '../services/supabase';
import { useAuthStore } from '../stores/authStore';

const OWNER = 'skipper@example.invalid';
const scope = (userId: string | null) => ({ userId });

afterEach(() => {
    setAuthIdentityScope(null);
    useAuthStore.setState({ user: null });
    vi.mocked(supabase!.auth.getSession).mockResolvedValue({ data: { session: null }, error: null } as never);
});

describe('the switches ship as decided', () => {
    it("routing is for the owner's account only, and the tap, not route-on-open", () => {
        expect(PYD_ROUTING_FOR).toBe('owner');
        expect(PYD_ROUTE_ON_OPEN).toBe(false);
    });

    it("the audience is the owner alone while PYD_ROUTING_FOR is 'owner'", () => {
        expect(pydRoutingAudience(true)).toBe(true);
        expect(pydRoutingAudience(false)).toBe(false);
    });
});

describe('the owner is the email AND the user id', () => {
    it('both match: the owner (the email in any case)', () => {
        const session = { user: { id: 'user-fixture-1', email: 'Skipper@Example.invalid' } };
        expect(isOwnerSession(session, scope('user-fixture-1'), OWNER)).toBe(true);
    });

    it("a matching email on another scope's user id is not the owner", () => {
        const session = { user: { id: 'user-fixture-2', email: OWNER } };
        expect(isOwnerSession(session, scope('user-fixture-1'), OWNER)).toBe(false);
    });

    it('another email on the right user id is not the owner', () => {
        const session = { user: { id: 'user-fixture-1', email: 'crew@example.invalid' } };
        expect(isOwnerSession(session, scope('user-fixture-1'), OWNER)).toBe(false);
    });

    it('signed out is not the owner: no scope user, no session, no email', () => {
        expect(isOwnerSession({ user: { id: 'user-fixture-1', email: OWNER } }, scope(null), OWNER)).toBe(false);
        expect(isOwnerSession(null, scope('user-fixture-1'), OWNER)).toBe(false);
        expect(isOwnerSession({ user: { id: 'user-fixture-1' } }, scope('user-fixture-1'), OWNER)).toBe(false);
    });

    it("keys on the chat's own platform-owner constant by default, read-only", () => {
        const session = { user: { id: 'user-fixture-1', email: PLATFORM_OWNER_EMAIL } };
        expect(isOwnerSession(session, scope('user-fixture-1'))).toBe(true);
        expect(isOwnerSession({ user: { id: 'user-fixture-1', email: OWNER } }, scope('user-fixture-1'))).toBe(false);
    });
});

describe('read once per sheet open, from the stored session', () => {
    it("the stored session's owner, on this scope", async () => {
        setAuthIdentityScope('user-fixture-1');
        vi.mocked(supabase!.auth.getSession).mockResolvedValue({
            data: { session: { user: { id: 'user-fixture-1', email: PLATFORM_OWNER_EMAIL } } },
            error: null,
        } as never);
        expect(await readOwnerAccount(getAuthIdentityScope())).toBe(true);
    });

    it('signed out asks nothing and is not the owner', async () => {
        const getSession = vi.mocked(supabase!.auth.getSession);
        getSession.mockClear();
        expect(await readOwnerAccount(getAuthIdentityScope())).toBe(false);
        expect(getSession).not.toHaveBeenCalled();
    });

    it('an account change while it reads is not the owner', async () => {
        setAuthIdentityScope('user-fixture-1');
        const asked = getAuthIdentityScope();
        vi.mocked(supabase!.auth.getSession).mockImplementation(async () => {
            setAuthIdentityScope('user-fixture-2');
            return {
                data: { session: { user: { id: 'user-fixture-1', email: PLATFORM_OWNER_EMAIL } } },
                error: null,
            } as never;
        });
        expect(await readOwnerAccount(asked)).toBe(false);
    });

    it("at sea with an expired token: the app's signed-in user is the owner, though the refresh fails", async () => {
        // Review 2026-10-11: getSession's refresh fails offline after ~25 s and says no session.
        setAuthIdentityScope('user-fixture-1');
        useAuthStore.setState({ user: { id: 'user-fixture-1', email: PLATFORM_OWNER_EMAIL } as never });
        const getSession = vi.mocked(supabase!.auth.getSession);
        getSession.mockClear();
        getSession.mockResolvedValue({ data: { session: null }, error: null } as never);
        expect(await readOwnerAccount(getAuthIdentityScope())).toBe(true);
        expect(getSession).not.toHaveBeenCalled();
        // Held for another account, or not the owner's address: not the owner.
        useAuthStore.setState({ user: { id: 'user-fixture-1', email: OWNER } as never });
        expect(await readOwnerAccount(getAuthIdentityScope())).toBe(false);
        useAuthStore.setState({ user: { id: 'user-fixture-2', email: PLATFORM_OWNER_EMAIL } as never });
        expect(await readOwnerAccount(getAuthIdentityScope())).toBe(false);
    });

    it('a session read that fails is not the owner', async () => {
        setAuthIdentityScope('user-fixture-1');
        vi.mocked(supabase!.auth.getSession).mockRejectedValue(new Error('storage unavailable'));
        expect(await readOwnerAccount(getAuthIdentityScope())).toBe(false);
    });
});
