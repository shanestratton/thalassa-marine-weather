/**
 * crewChatRoom — the skipper's one Crew Chat: found by owner, made once.
 *
 * Shane 2026-10-09: "ok i get sign in to use crew chat. also, when i do
 * eventually get it to work, it say mackay - whitsundays at the top. can we
 * fix both of those issues". He was signed in. The card keyed the room to the
 * passage selected on this phone, went through the chat service's remembered
 * user (null on any visit where its boot sign-in lagged), looked the room up
 * by name through a raw PostgREST `or` string that a passage name with
 * parentheses broke (so taps minted 28 copies), and showed "Sign in" for
 * every failure.
 *
 * Now there is one Crew Chat per skipper: the OLDEST active private 👥 room
 * the account owns (pickCrewChatRoom, the same pick the crew's card makes).
 * A passage is context, not the room's identity.
 *
 * - Identity is the local session (getSession waits for the stored session to
 *   load; no getUser round trip, and the chat service is never asked who is
 *   signed in; after a create, only its cached channel list is dropped).
 * - An account with no crew of its own gets `not_ready`, even if it owns an
 *   old 👥 room, and nothing is made. A skipper with crew and no room yet
 *   gets 'Crew Chat', created with a client id and WITHOUT RETURNING: on the
 *   live database a non-moderator's insert().select() fails 42501, because
 *   chat_channels_visible re-reads the row before it exists. Then the room is
 *   read back, and the oldest wins, so two phones racing land in one room.
 * - Membership is a plain insert; 23505 means already a member. No upsert and
 *   no UPDATE (the chat lockdown removes those paths). The owner reads and
 *   posts through can_access_chat_channel's owner branch, so a refused
 *   membership row is logged and the room still opens.
 * - Taps share one call per identity; the call is bounded at 15 s; an
 *   account change mid-call returns `stale` and nothing for the old account.
 * - Every failure has its own reason and words; "Sign in" means no session.
 *   Logs carry a reason only, never ids, names or emails.
 */
import type { ChatChannel } from '../chat/types';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from '../authIdentityScope';
import { supabase } from '../supabase';
import { createLogger } from '../../utils/createLogger';
import { pickCrewChatRoom } from './crewChatGate';

const log = createLogger('CrewChat');

export const CREW_CHAT_OPEN_TIMEOUT_MS = 15_000;
const ROOM_COLUMNS = 'id,name,description,region,icon,is_global,is_private,owner_id,parent_id,created_at';
/** Enough of the oldest rooms to pick from, never the whole history. */
const FIND_LIMIT = 10;

export type CrewChatFailure =
    | 'signed_out'
    | 'session_expired'
    | 'offline'
    | 'timeout'
    | 'denied'
    | 'not_ready'
    | 'failed'
    | 'stale';
export type CrewChatStep = 'session' | 'find' | 'crew' | 'create' | 'readback';
export type CrewChatOpenResult =
    | { ok: true; channel: ChatChannel }
    | { ok: false; reason: CrewChatFailure; step?: CrewChatStep };
type Failure = Extract<CrewChatOpenResult, { ok: false }>;

const UNREACHABLE = "Couldn't reach Crew Chat. Check your connection and try again.";
const MESSAGES: Record<CrewChatFailure, string | null> = {
    signed_out: 'Sign in to use Crew Chat',
    session_expired: 'Your sign-in has expired. Sign in again to open Crew Chat.',
    offline: UNREACHABLE,
    timeout: UNREACHABLE,
    denied: "Crew Chat couldn't be set up for this account. Try again shortly.",
    not_ready: "Your skipper hasn't opened Crew Chat yet. It shows here once they do.",
    failed: "Crew Chat didn't open. Try again.",
    stale: null,
};

/** The toast for a failure, or null when nothing should show (opened, or `stale`). */
export function crewChatFailureMessage(result: CrewChatOpenResult): string | null {
    if (result.ok) return null;
    // A refused create waits on the server fix that ships with this build.
    if (result.reason === 'denied' && (result.step === 'create' || result.step === 'readback')) {
        return "Crew Chat can't be set up from this phone yet; it will work after the next update.";
    }
    return MESSAGES[result.reason];
}

const LOG_WORDS: Partial<Record<CrewChatFailure, string>> = {
    signed_out: 'no-session',
    session_expired: 'session-expired',
    not_ready: 'no-own-crew',
    stale: 'identity-changed',
};
const words = (reason: CrewChatFailure) => LOG_WORDS[reason] ?? reason;

function fail(reason: CrewChatFailure, step?: CrewChatStep): Failure {
    const perStep = step && (reason === 'denied' || reason === 'failed');
    log.warn(`crew-chat: ${words(reason)}${perStep ? `-${step}` : ''}`);
    return step ? { ok: false, reason, step } : { ok: false, reason };
}

interface Reply {
    data: unknown;
    error: unknown;
    status?: number;
}

/** A request's reply; a throw becomes an error reply, so every step classifies alike. */
async function send(request: PromiseLike<Reply>): Promise<Reply> {
    try {
        return await request;
    } catch (error) {
        return { data: null, error };
    }
}

const field = (error: unknown, key: string): unknown =>
    typeof error === 'object' && error !== null ? (error as Record<string, unknown>)[key] : undefined;

/** What a database or network error means for the sailor. */
function classify(error: unknown, status?: number): CrewChatFailure {
    const code = String(field(error, 'code') ?? '');
    const message = String(field(error, 'message') ?? '');
    const http = status ?? field(error, 'status');
    if (code === '42501' || http === 403) return 'denied';
    if (http === 401 || code.startsWith('PGRST30') || /jwt/i.test(message)) return 'session_expired';
    if (http === 0 || field(error, 'name') === 'TypeError' || /fetch|network|load failed/i.test(message)) {
        return 'offline';
    }
    return 'failed';
}

/**
 * The chat page's cached channel list predates a room just made, so a lookup
 * in it (the return from a pin drop) would miss the room until the next
 * refresh. Drop it, as the old createVoyageChannel did. Only a cache: a
 * failure here changes nothing for the sailor.
 */
async function forgetChannelList(scope: AuthIdentityScope): Promise<void> {
    try {
        const { ChatService } = await import('../ChatService');
        ChatService.invalidateChannelCache(scope);
    } catch {
        // The next channel refresh brings the room in.
    }
}

async function run(scope: AuthIdentityScope, signal: AbortSignal): Promise<CrewChatOpenResult> {
    const db = supabase;
    if (!db) return fail('failed', 'session');
    const userId = scope.userId as string;
    /** After every await: timed out (already reported) or another account (stale). */
    const halted = (): Failure | null => {
        if (signal.aborted) return { ok: false, reason: 'timeout' };
        return isAuthIdentityScopeCurrent(scope) ? null : fail('stale');
    };

    let sessionUser: unknown;
    try {
        const { data, error } = await db.auth.getSession();
        if (signal.aborted) return { ok: false, reason: 'timeout' };
        if (error) {
            // A refused refresh (4xx) is an expired sign-in; anything else is
            // the link. auth-js signs the account out (SIGNED_OUT) before a
            // refused refresh returns, so the scope may already be anonymous:
            // that is still this account's expiry, not another account.
            const status = field(error, 'status');
            const refused = typeof status === 'number' && status >= 400 && status < 500;
            if (refused && (isAuthIdentityScopeCurrent(scope) || !getAuthIdentityScope().userId)) {
                return fail('session_expired', 'session');
            }
            return halted() ?? fail('offline', 'session');
        }
        const stop = halted();
        if (stop) return stop;
        if (!data?.session) return fail('signed_out');
        sessionUser = data.session.user?.id;
    } catch (error) {
        return halted() ?? fail(classify(error) === 'offline' ? 'offline' : 'failed', 'session');
    }
    if (sessionUser !== userId) return fail('stale');

    const find = () =>
        send(
            db
                .from('chat_channels')
                .select(ROOM_COLUMNS)
                .eq('owner_id', userId)
                .eq('is_private', true)
                .eq('status', 'active')
                .eq('icon', '👥')
                .order('created_at', { ascending: true })
                .order('id', { ascending: true })
                .limit(FIND_LIMIT)
                .abortSignal(signal),
        );
    const rooms = (reply: Reply) => (Array.isArray(reply.data) ? (reply.data as ChatChannel[]) : []);

    // Only a skipper with crew has a Crew Chat: the card's own gate. Asked
    // beside the find, so it costs no time, and asked even when a room is
    // found: a crew-only account may own an old 👥 room from an older build,
    // and posting there would reach nobody.
    const [found, crew] = await Promise.all([
        find(),
        send(db.from('vessel_crew').select('id').eq('owner_id', userId).limit(1).abortSignal(signal)),
    ]);
    let stop = halted();
    if (stop) return stop;
    if (found.error) return fail(classify(found.error, found.status), 'find');
    if (crew.error) return fail(classify(crew.error, crew.status), 'crew');
    if (!Array.isArray(crew.data) || crew.data.length === 0) return fail('not_ready');
    let room = pickCrewChatRoom(rooms(found), userId);

    if (!room) {
        const created = await send(
            db
                .from('chat_channels')
                .insert({
                    id: crypto.randomUUID(),
                    name: 'Crew Chat',
                    description: '',
                    icon: '👥',
                    region: null,
                    is_global: false,
                    is_private: true,
                    owner_id: userId,
                    parent_id: null,
                    status: 'active',
                })
                .abortSignal(signal),
        );
        stop = halted();
        if (stop) return stop;
        // 23505: chat_channels_one_crew_room_per_owner refused a second room,
        // so another phone made it first. Read that one back.
        if (created.error && field(created.error, 'code') !== '23505') {
            return fail(classify(created.error, created.status), 'create');
        }
        await forgetChannelList(scope);

        // Read it back: two phones racing both land in the oldest room.
        const again = await find();
        stop = halted();
        if (stop) return stop;
        if (again.error) return fail(classify(again.error, again.status), 'readback');
        room = pickCrewChatRoom(rooms(again), userId);
        if (!room) return fail('denied', 'readback');
    }

    // The room actually returned gets the membership row (in a race, the
    // oldest, not necessarily the one this phone made).
    const joined = await send(
        db.from('channel_members').insert({ channel_id: room.id, user_id: userId }).abortSignal(signal),
    );
    stop = halted();
    if (stop) return stop;
    if (joined.error && field(joined.error, 'code') !== '23505') {
        log.warn(`crew-chat: ${words(classify(joined.error, joined.status))}-member`);
    }
    return { ok: true, channel: room };
}

const inFlight = new Map<string, Promise<CrewChatOpenResult>>();

/**
 * Open the signed-in account's own Crew Chat: find it, or make it once.
 * Never throws. Calls made while one is out share it.
 */
export function openOwnCrewChat(): Promise<CrewChatOpenResult> {
    const scope = getAuthIdentityScope();
    if (!scope.userId) return Promise.resolve(fail('signed_out'));
    const key = `${scope.key}#${scope.generation}`;
    const running = inFlight.get(key);
    if (running) return running;

    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<CrewChatOpenResult>((resolve) => {
        timer = setTimeout(() => {
            controller.abort();
            resolve(fail(isAuthIdentityScopeCurrent(scope) ? 'timeout' : 'stale'));
        }, CREW_CHAT_OPEN_TIMEOUT_MS);
    });
    const work: Promise<CrewChatOpenResult> = Promise.race([
        run(scope, controller.signal).catch(() => fail('failed')),
        timeout,
    ]).finally(() => {
        clearTimeout(timer);
        if (inFlight.get(key) === work) inFlight.delete(key);
    });
    inFlight.set(key, work);
    return work;
}
