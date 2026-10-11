/**
 * Plan Your Day's two routing switches (127-PYD-2), in one place.
 *
 * Shane, 2026-10-10: "when you select somewhere, and plot on the chart. it
 * goes direct. straight over hills. rocks, other boats, land, sea, air, you
 * name it … so can we incorporate the autorouting into the plan your day
 * thingy." His decisions the same day: (1) routing ON for his account only in
 * 127's TestFlight, OFF for testers, a one-line flip later; (2) the "Route
 * round the land" TAP, with route-on-open only if his three marina timings
 * (Coral Sea Marina → Cid Harbour, Whitehaven, Daydream) are all ≤ 8 s.
 *
 * "His account" is the signed-in session whose email is the chat's own
 * platform owner (services/chat/constants.ts, read-only here) AND whose user
 * id is this identity scope's. A rollout flag, not a security boundary: the
 * route runs on the phone either way, behind Auto's own gates (signed in,
 * Auto route (trial) on, charts at both ends).
 */
import { isAuthIdentityScopeCurrent, type AuthIdentityScope } from '../authIdentityScope';
import { PLATFORM_OWNER_EMAIL } from '../chat/constants';
import { supabase } from '../supabase';
import { useAuthStore } from '../../stores/authStore';

/** Decision 1 (Shane 2026-10-10): his account only in 127. The one-line flip after his smoke: 'owner' → 'everyone'. */
export const PYD_ROUTING_FOR: 'owner' | 'everyone' = 'owner';
/** Decision 2: the "Route round the land" tap. True only if his three marina timings are all ≤ 8 s ("Routed in N s"). */
export const PYD_ROUTE_ON_OPEN: boolean = false;

/** Who is offered routing at all. The owner's timing line is his alone, whatever this says. */
export function pydRoutingAudience(isOwner: boolean): boolean {
    return isOwner || PYD_ROUTING_FOR !== 'owner';
}

type SessionLike = { user?: { id?: string | null; email?: string | null } | null } | null | undefined;

/** The owner: the session's email is the platform owner's AND its user is this scope's. */
export function isOwnerSession(
    session: SessionLike,
    scope: Pick<AuthIdentityScope, 'userId'>,
    ownerEmail = PLATFORM_OWNER_EMAIL,
): boolean {
    const user = session?.user;
    return !!scope.userId && user?.id === scope.userId && user.email?.toLowerCase() === ownerEmail.toLowerCase();
}

/**
 * Read once per sheet open: the signed-in user the app holds (authStore),
 * else the stored session (supabase.auth.getSession). The held user first,
 * as at sea an expired token's refresh fails and getSession says no session
 * after ~25 s of retries, though the app is still signed in. Signed out, a
 * failed read or an account change on the way is not the owner.
 */
export async function readOwnerAccount(scope: AuthIdentityScope): Promise<boolean> {
    if (!scope.userId) return false;
    const held = useAuthStore.getState().user;
    if (held?.id === scope.userId) return isAuthIdentityScopeCurrent(scope) && isOwnerSession({ user: held }, scope);
    try {
        const session = supabase ? (await supabase.auth.getSession()).data.session : null;
        return isAuthIdentityScopeCurrent(scope) && isOwnerSession(session, scope);
    } catch {
        return false;
    }
}
