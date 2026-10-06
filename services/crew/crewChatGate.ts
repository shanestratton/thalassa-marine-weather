/**
 * crewChatGate — what the Crew Chat card on the Scuttlebutt page needs to
 * know, remembered per account and read live in parallel.
 *
 * Shane 2026-10-06: "the crew chat - private group takes about 5-10 seconds
 * to arrive in the scuttlebutt page ... they all need to come at the same
 * time. and fast". The card used to wait on a serial chain (channels, crew
 * repair, fresh channels, profile, crew rows, vessel names) while every other
 * card painted at once. Now:
 *
 * - The last gate this device VERIFIED for the account is kept here
 *   (authScopedStorageKey, so another account never reads it and account
 *   deletion sweeps it), and the card paints from it with the other cards.
 * - The live reads below run at the same time as the channel load. Each
 *   returns null when it could not get an answer (offline at sea, an auth
 *   race): the card then keeps what it last knew. Only an ANSWER changes it.
 * - The card is a way in, never the authority: opening the group is still
 *   checked by RLS, so a card a beat out of date fails like any closed door.
 *
 * Kept free of UI and of the chat service, so the page's first paint does
 * not wait on either.
 */
import type { ChatChannel } from '../chat/types';
import { authScopedStorageKey, isAuthIdentityScopeCurrent, type AuthIdentityScope } from '../authIdentityScope';
import { supabase } from '../supabase';

const GATE_KEY = 'thalassa_crew_chat_gate_v1';
/** Accepted memberships are normally one; never keep or read without a bound. */
export const MAX_CREW_CHAT_OWNERS = 8;
/** One account's channel memberships; past this the answer is partial. */
const MAX_CHANNEL_MEMBERSHIPS = 500;

/** The last Crew Chat gate this device verified for one account. */
export interface CrewChatGateMemory {
    version: 1;
    /** The account it was verified for (the storage key says so too). */
    userId: string;
    /** The account has invited crew of its own (any vessel_crew row it owns). */
    hasOwnedCrew: boolean;
    /** The skippers this account is accepted crew for. */
    memberOwnerIds: string[];
    /** The skipper's Crew Chat this account was last verified a member of. */
    channel: ChatChannel | null;
    /** The passage-chat grant, for the passage it was read for. */
    passage: { voyageId: string; canViewChat: boolean } | null;
    /** The skippers' vessel names (vessel_identity), by owner id. */
    vesselNames: Record<string, string>;
}

/** A skipper's Crew Chat: a private 👥 group someone else owns. */
export function isCrewChatGroup(channel: ChatChannel | null | undefined, viewerId: string | null): boolean {
    return (
        !!channel &&
        channel.is_private === true &&
        channel.icon === '👥' &&
        typeof channel.owner_id === 'string' &&
        !!channel.owner_id &&
        channel.owner_id !== viewerId
    );
}

// ── The remembered gate ────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ids(value: unknown, viewerId: string): string[] {
    if (!Array.isArray(value)) return [];
    const out = new Set<string>();
    for (const id of value) {
        if (typeof id === 'string' && id.trim() && id !== viewerId) out.add(id.trim());
        if (out.size >= MAX_CREW_CHAT_OWNERS) break;
    }
    return [...out];
}

function stringOrNull(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

/** Only the channel's own fields, and only a skipper's Crew Chat. */
function parseChannel(value: unknown, viewerId: string): ChatChannel | null {
    if (!isRecord(value) || typeof value.id !== 'string' || !value.id) return null;
    const channel: ChatChannel = {
        id: value.id,
        name: typeof value.name === 'string' ? value.name : '',
        description: typeof value.description === 'string' ? value.description : '',
        region: stringOrNull(value.region),
        icon: typeof value.icon === 'string' ? value.icon : '',
        is_global: value.is_global === true,
        is_private: value.is_private === true,
        owner_id: stringOrNull(value.owner_id),
        parent_id: stringOrNull(value.parent_id),
        created_at: typeof value.created_at === 'string' ? value.created_at : '',
    };
    return isCrewChatGroup(channel, viewerId) ? channel : null;
}

function parseNames(value: unknown): Record<string, string> {
    if (!isRecord(value)) return {};
    const names: Record<string, string> = {};
    for (const [ownerId, name] of Object.entries(value).slice(0, MAX_CREW_CHAT_OWNERS)) {
        if (ownerId && typeof name === 'string' && name.trim()) names[ownerId] = name.trim().slice(0, 200);
    }
    return names;
}

function parseMemory(raw: string | null, viewerId: string): CrewChatGateMemory | null {
    if (!raw) return null;
    try {
        const value: unknown = JSON.parse(raw);
        if (!isRecord(value) || value.version !== 1 || value.userId !== viewerId) return null;
        const passage = isRecord(value.passage) ? value.passage : null;
        return {
            version: 1,
            userId: viewerId,
            hasOwnedCrew: value.hasOwnedCrew === true,
            memberOwnerIds: ids(value.memberOwnerIds, viewerId),
            channel: parseChannel(value.channel, viewerId),
            passage:
                passage && typeof passage.voyageId === 'string' && passage.voyageId
                    ? { voyageId: passage.voyageId, canViewChat: passage.canViewChat === true }
                    : null,
            vesselNames: parseNames(value.vesselNames),
        };
    } catch {
        return null;
    }
}

/** The gate last verified for this account, or null (signed out, none yet, or unreadable). */
export function readCrewChatGateMemory(scope: AuthIdentityScope): CrewChatGateMemory | null {
    if (!scope.userId) return null;
    try {
        if (typeof localStorage === 'undefined') return null;
        return parseMemory(localStorage.getItem(authScopedStorageKey(GATE_KEY, scope)), scope.userId);
    } catch {
        return null;
    }
}

/** Remember a verified gate for this account. Skips an unchanged gate; never throws. */
export function rememberCrewChatGate(scope: AuthIdentityScope, memory: CrewChatGateMemory): void {
    if (!scope.userId || memory.userId !== scope.userId || !isAuthIdentityScopeCurrent(scope)) return;
    try {
        if (typeof localStorage === 'undefined') return;
        const key = authScopedStorageKey(GATE_KEY, scope);
        const next = JSON.stringify(memory);
        if (localStorage.getItem(key) !== next) localStorage.setItem(key, next);
    } catch {
        /* storage unavailable: the card still follows the live answer this visit */
    }
}

// ── Live reads ─────────────────────────────────────────────────

/** The live crew rows, as RLS shows them to this account. */
export interface CrewChatRows {
    hasOwnedCrew: boolean;
    memberOwnerIds: string[];
}

/**
 * Does the locally held session still belong to this scope? getSession reads
 * the persisted session (no round trip, unlike getUser); every query below is
 * filtered by RLS on the server, so this only stops a read for one account
 * landing under another.
 */
async function sessionOwns(scope: AuthIdentityScope): Promise<boolean> {
    if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return false;
    try {
        const { data } = await supabase.auth.getSession();
        return data?.session?.user?.id === scope.userId && isAuthIdentityScopeCurrent(scope);
    } catch {
        return false;
    }
}

/**
 * Has this account invited crew, and whose crew is it? Both questions in one
 * round trip of parallel reads. Null when there is no answer: an error is
 * never read as "no crew", so a dropped link cannot take the card away.
 */
export async function readCrewChatRows(scope: AuthIdentityScope): Promise<CrewChatRows | null> {
    if (!supabase || !(await sessionOwns(scope))) return null;
    const userId = scope.userId as string;
    try {
        const [owned, memberships] = await Promise.all([
            supabase.from('vessel_crew').select('id').eq('owner_id', userId).limit(1),
            supabase
                .from('vessel_crew')
                .select('owner_id')
                .eq('crew_user_id', userId)
                .eq('status', 'accepted')
                .limit(MAX_CREW_CHAT_OWNERS * 4),
        ]);
        if (!isAuthIdentityScopeCurrent(scope)) return null;
        if (owned.error || memberships.error || !Array.isArray(owned.data) || !Array.isArray(memberships.data)) {
            return null;
        }
        return {
            hasOwnedCrew: owned.data.length > 0,
            memberOwnerIds: ids(
                memberships.data.map((row: { owner_id?: unknown }) => row?.owner_id),
                userId,
            ),
        };
    } catch {
        return null;
    }
}

/** The channels this account is a member of, as far as the answer goes. */
export interface CrewChatChannelMemberships {
    ids: ReadonlySet<string>;
    /** False when the answer was cut at its bound: a missing id is then unknown, not "no". */
    complete: boolean;
}

/**
 * Every channel this account is a member of (channel_members, its own rows).
 * Needs no channel list, so it runs alongside the channel load instead of
 * after it, and ahead of the chat service's own sign-in. Null on no answer.
 */
export async function readCrewChatChannelMemberships(
    scope: AuthIdentityScope,
): Promise<CrewChatChannelMemberships | null> {
    if (!supabase || !(await sessionOwns(scope))) return null;
    const userId = scope.userId as string;
    try {
        const { data, error } = await supabase
            .from('channel_members')
            .select('channel_id')
            .eq('user_id', userId)
            .limit(MAX_CHANNEL_MEMBERSHIPS);
        if (!isAuthIdentityScopeCurrent(scope) || error || !Array.isArray(data)) return null;
        const found = new Set<string>();
        for (const row of data as Array<{ channel_id?: unknown }>) {
            if (typeof row?.channel_id === 'string' && row.channel_id) found.add(row.channel_id);
        }
        return { ids: found, complete: data.length < MAX_CHANNEL_MEMBERSHIPS };
    } catch {
        return null;
    }
}
