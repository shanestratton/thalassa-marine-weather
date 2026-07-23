/**
 * conversationSync — Realtime-backed sharing of Calypso conversations
 * across crew on the same vessel.
 *
 * The voice console drives this in two directions:
 *
 *   1. **Outbound** (this skipper just got an answer): on every
 *      successful Calypso turn, `publishTurn()` writes a row to
 *      voice_conversations. Postgres RLS gates writes to the
 *      authenticated user authoring the turn on their own vessel.
 *
 *   2. **Inbound** (someone else on this vessel is talking to Calypso):
 *      `start()` subscribes to a per-vessel Realtime channel. Every
 *      INSERT from a crewmate becomes an `onRemoteTurn` callback in
 *      the console, which merges it into the shared conversation log.
 *
 * Audio is intentionally NOT shared — only text. The skipper who asked
 * hears their own answer; everyone else sees the transcript + answer.
 *
 * Vessel scope: matches the existing vessel_identity / vessel_crew
 * model (owner_id is the captain's user_id, accepted crew can read).
 *
 * If the user isn't signed in or isn't on a vessel, start() returns a
 * no-op handle. The voice console keeps working with local-only history,
 * just without sharing.
 */

import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '../supabase';
import type { VoiceQueryResponse, VoiceTurn } from '../../types/voice';
import {
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../authIdentityScope';

interface VoiceConversationRow {
    id: string;
    vessel_owner_id: string;
    user_id: string;
    user_name: string;
    transcript: string;
    answer_text: string;
    source: 'cloud' | 'bosun' | 'unknown';
    tool_calls: VoiceQueryResponse['tool_calls'] | null;
    created_at: string;
}

export interface ConversationSyncHandle {
    /** True if the user is on a vessel and the channel is live. */
    readonly active: boolean;
    /** The vessel scope (captain's user_id) the channel is bound to, or null. */
    readonly vesselOwnerId: string | null;
    /** This skipper's user_id (so we can dedupe self-originated remote turns). */
    readonly currentUserId: string | null;
    /** Tear down the Realtime subscription. Idempotent. */
    stop(): Promise<void>;
}

export interface StartSyncOptions {
    /**
     * Called for every INSERT that arrives via Realtime — typically a
     * crewmate's turn. Self-originated inserts are skipped (we already
     * applied them locally when publishTurn was called).
     */
    onRemoteTurn: (turn: VoiceTurn) => void;
}

// ── Vessel resolution ──────────────────────────────────────────

/**
 * Figure out the vessel-scope to use for sharing. The user could be:
 *   - A captain (owns a vessel_identity row) → vessel_owner_id = self
 *   - Accepted crew on someone else's vessel → vessel_owner_id = that captain
 *   - Both (own a boat AND crew on others) → prefer own vessel
 *   - Neither → null (sharing not available, console runs local-only)
 *
 * Returns null on any auth error so the console fails open to local-only.
 */
function isAuthenticatedScopeCurrent(scope: AuthIdentityScope): scope is AuthIdentityScope & { userId: string } {
    return Boolean(scope.userId) && isAuthIdentityScopeCurrent(scope);
}

async function resolveVesselOwnerId(scope: AuthIdentityScope & { userId: string }): Promise<string | null> {
    if (!supabase || !isAuthenticatedScopeCurrent(scope)) return null;
    // Path A: do they own a vessel?
    const { data: ownVessel, error: ownVesselError } = await supabase
        .from('vessel_identity')
        .select('owner_id')
        .eq('owner_id', scope.userId)
        .maybeSingle();
    if (!isAuthenticatedScopeCurrent(scope)) return null;
    if (!ownVesselError && ownVessel?.owner_id === scope.userId) return scope.userId;

    // Path B: are they accepted crew on someone's vessel? Pick most recent.
    const { data: membership, error: membershipError } = await supabase
        .from('vessel_crew')
        .select('owner_id, updated_at')
        .eq('crew_user_id', scope.userId)
        .eq('status', 'accepted')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
    if (!isAuthenticatedScopeCurrent(scope) || membershipError) return null;
    return typeof membership?.owner_id === 'string' && membership.owner_id.trim() ? membership.owner_id : null;
}

/** Best-effort display name lookup. Falls back to email local-part, then "Skipper". */
async function resolveDisplayName(scope: AuthIdentityScope & { userId: string }): Promise<string | null> {
    if (!supabase || !isAuthenticatedScopeCurrent(scope)) return null;
    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!isAuthenticatedScopeCurrent(scope) || user?.id !== scope.userId) return null;
    const meta = user.user_metadata as Record<string, unknown> | undefined;
    const fromMeta = typeof meta?.display_name === 'string' ? meta.display_name.trim() : '';
    if (fromMeta) return fromMeta;
    const emailName = user.email?.split('@')[0]?.trim();
    if (emailName) return emailName;
    return 'Skipper';
}

// ── Row → VoiceTurn shape ──────────────────────────────────────

function rowToTurn(row: VoiceConversationRow, expectedVesselOwnerId: string): VoiceTurn | null {
    if (
        !row ||
        row.vessel_owner_id !== expectedVesselOwnerId ||
        typeof row.id !== 'string' ||
        !row.id ||
        typeof row.user_id !== 'string' ||
        !row.user_id ||
        typeof row.user_name !== 'string' ||
        typeof row.transcript !== 'string' ||
        typeof row.answer_text !== 'string' ||
        typeof row.created_at !== 'string' ||
        !['cloud', 'bosun', 'unknown'].includes(row.source)
    ) {
        return null;
    }
    const timestamp = new Date(row.created_at).getTime();
    if (!Number.isFinite(timestamp)) return null;
    return {
        id: row.id,
        timestamp,
        transcript: row.transcript,
        response: {
            transcript: row.transcript,
            answer_text: row.answer_text,
            audio_b64: undefined, // text-only across the wire
            source: row.source,
            tool_calls: Array.isArray(row.tool_calls) ? row.tool_calls : undefined,
            // userName attribution lives on the turn itself (added below)
        },
        userName: row.user_name,
        userId: row.user_id,
    };
}

// ── Public API ─────────────────────────────────────────────────

const NOOP_HANDLE: ConversationSyncHandle = {
    active: false,
    vesselOwnerId: null,
    currentUserId: null,
    async stop() {
        /* nothing to tear down */
    },
};
Object.freeze(NOOP_HANDLE);

/**
 * A public handle deliberately contains only display-friendly identifiers.
 * Keep the exact auth generation out-of-band so a stale or caller-forged
 * handle can never be used as authority for a write.
 */
const handleScopes = new WeakMap<ConversationSyncHandle, AuthIdentityScope & { userId: string }>();

/**
 * Subscribe to per-vessel Realtime updates and return a handle whose
 * stop() tears the channel down. Always resolves — never throws — so
 * the voice console can call this on mount without try/catch.
 *
 * If the user isn't authenticated or isn't on a vessel, returns a
 * no-op handle with active=false. The console then runs in local-only
 * mode (existing behaviour pre-sharing).
 */
export async function startConversationSync(opts: StartSyncOptions): Promise<ConversationSyncHandle> {
    if (!supabase) return NOOP_HANDLE;
    const scope = getAuthIdentityScope();
    if (!isAuthenticatedScopeCurrent(scope)) return NOOP_HANDLE;
    // Pin a non-null reference so TypeScript's narrowing survives across
    // the await + closures below (top-level `supabase` is module-scope
    // so the compiler can't prove it doesn't go null between calls).
    const sb = supabase;
    let channel: RealtimeChannel | null = null;
    try {
        const { data: authData } = await sb.auth.getUser();
        const user = authData.user;
        if (!isAuthenticatedScopeCurrent(scope) || user?.id !== scope.userId) return NOOP_HANDLE;

        const vesselOwnerId = await resolveVesselOwnerId(scope);
        if (!vesselOwnerId || !isAuthenticatedScopeCurrent(scope)) return NOOP_HANDLE;

        let stopped = false;
        let stopPromise: Promise<void> | null = null;
        let unsubscribeIdentity = () => {};
        const handle: ConversationSyncHandle = {
            get active() {
                return !stopped && isAuthenticatedScopeCurrent(scope);
            },
            vesselOwnerId,
            currentUserId: scope.userId,
            async stop() {
                if (stopPromise) return stopPromise;
                stopped = true;
                unsubscribeIdentity();
                const channelToRemove = channel;
                stopPromise = (async () => {
                    if (!channelToRemove) return;
                    try {
                        await sb.removeChannel(channelToRemove);
                    } catch {
                        /* idempotent — silently ignore if already gone */
                    }
                })();
                return stopPromise;
            },
        };

        channel = sb
            .channel(`voice-conv:${vesselOwnerId}`)
            .on(
                'postgres_changes',
                {
                    event: 'INSERT',
                    schema: 'public',
                    table: 'voice_conversations',
                    filter: `vessel_owner_id=eq.${vesselOwnerId}`,
                },
                (payload) => {
                    if (stopped || !isAuthenticatedScopeCurrent(scope)) return;
                    const row = payload.new as VoiceConversationRow;
                    // Skip self-originated turns — we already added them
                    // locally when publishTurn was called. Realtime echoes
                    // every INSERT to the channel, including our own.
                    if (row?.user_id === scope.userId) return;
                    const turn = rowToTurn(row, vesselOwnerId);
                    if (turn && !stopped && isAuthenticatedScopeCurrent(scope)) {
                        opts.onRemoteTurn(turn);
                    }
                },
            )
            .subscribe();

        unsubscribeIdentity = subscribeAuthIdentityScope(() => {
            if (!isAuthenticatedScopeCurrent(scope)) void handle.stop();
        });
        handleScopes.set(handle, scope);
        if (!isAuthenticatedScopeCurrent(scope)) {
            await handle.stop();
            return NOOP_HANDLE;
        }
        return handle;
    } catch {
        if (channel) {
            try {
                await sb.removeChannel(channel);
            } catch {
                /* best-effort cleanup after failed channel setup */
            }
        }
        return NOOP_HANDLE;
    }
}

/**
 * Insert a turn into voice_conversations so crew see it in real-time.
 * Should be called AFTER the turn is appended to the local store, so
 * the row's `id` matches the local turn id (lets the Realtime echo
 * dedupe via id).
 *
 * Returns true on success, false if sharing isn't available (no auth,
 * not on a vessel, RLS rejected) — caller continues with local-only.
 */
export async function publishTurn(
    handle: ConversationSyncHandle,
    turn: VoiceTurn,
    response: VoiceQueryResponse,
): Promise<boolean> {
    if (!supabase) return false;
    if (!handle.active || !handle.vesselOwnerId || !handle.currentUserId) return false;
    const scope = handleScopes.get(handle);
    if (
        !scope ||
        !isAuthenticatedScopeCurrent(scope) ||
        handle.currentUserId !== scope.userId ||
        typeof handle.vesselOwnerId !== 'string' ||
        !handle.vesselOwnerId.trim()
    ) {
        return false;
    }
    const userName = await resolveDisplayName(scope);
    if (!userName || !handle.active || !isAuthenticatedScopeCurrent(scope)) return false;
    const { error } = await supabase.from('voice_conversations').insert({
        id: turn.id, // reuse the client-generated id so the Realtime echo dedupes
        vessel_owner_id: handle.vesselOwnerId,
        user_id: handle.currentUserId,
        user_name: userName,
        transcript: turn.transcript,
        answer_text: response.answer_text,
        source: response.source,
        tool_calls: response.tool_calls ?? null,
    });
    if (!handle.active || !isAuthenticatedScopeCurrent(scope)) return false;
    if (error) {
        console.warn('[conversationSync] publishTurn failed:', error.message);
        return false;
    }
    return true;
}
