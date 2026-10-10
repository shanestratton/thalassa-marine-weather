/**
 * openOwnCrewChat — one Crew Chat per skipper, found by owner (build 125).
 *
 * Shane 2026-10-09: "ok i get sign in to use crew chat. also, when i do
 * eventually get it to work, it say mackay - whitsundays at the top. can we
 * fix both of those issues". The skipper's card keyed the room to the passage
 * selected on this phone, looked it up by name through a raw PostgREST `or`
 * string (a passage name with parentheses broke the parse, so every tap minted
 * another room), and showed "Sign in" for every failure, signed in or not.
 *
 * Only the network is fake here. Its chat_channels insert refuses RETURNING
 * (insert().select()) with 42501 for an account that is not a chat moderator,
 * as the live database does: the room must be created without it. Every name,
 * boat and passage is fictional, from several countries.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── The fake network ──────────────────────────────────────────

interface Call {
    table: string;
    op: 'select' | 'insert';
    columns: string;
    filters: Array<[string, unknown]>;
    orders: Array<[string, boolean]>;
    usedOr: boolean;
    nameFilter: boolean;
    returning: boolean;
    payload: Record<string, unknown> | null;
    signal: AbortSignal | null;
}
interface Reply {
    data: unknown;
    error: { code?: string; message: string } | null;
    status: number;
}
type Step = 'find' | 'crew' | 'create' | 'member';

const net = vi.hoisted(() => {
    const state = {
        /** Who the locally stored session belongs to. */
        sessionUserId: null as string | null,
        /** Replaces getSession when set (slow, failing, throwing). */
        session: null as null | (() => Promise<{ data: { session: unknown }; error: unknown }>),
        /** A chat moderator may insert with RETURNING; anyone else gets 42501 (live, 2026-10-09). */
        moderator: false,
        channels: [] as Array<Record<string, unknown>>,
        members: [] as Array<{ channel_id: string; user_id: string }>,
        crew: [] as Array<{ id: string; owner_id: string; crew_user_id: string; status: string }>,
        calls: [] as Call[],
        clock: 0,
        /** Per-step overrides: a canned reply, a throw, or a hold. */
        override: {} as Partial<Record<Step, (call: Call) => Promise<Reply>>>,
        /** Runs just before our channel insert lands (another phone racing). */
        beforeCreate: null as null | (() => void),
        /**
         * chat_channels_one_crew_room_per_owner (20261010154500): a second
         * active private 👥 room for the same owner is refused with 23505.
         */
        oneRoomIndex: false,
        /** Who auth.uid() is on the server, for the RLS the fake applies. */
        authUid: () => state.sessionUserId,
    };
    return { state };
});

const touched = vi.hoisted(() => ({ chatService: false, passage: false, voyage: false }));

function stepOf(call: Call): Step | null {
    if (call.table === 'chat_channels') return call.op === 'insert' ? 'create' : 'find';
    if (call.table === 'channel_members' && call.op === 'insert') return 'member';
    if (call.table === 'vessel_crew') return 'crew';
    return null;
}

function stamp(): string {
    net.state.clock += 1;
    return new Date(Date.UTC(2026, 9, 9, 0, 10, 0, net.state.clock)).toISOString();
}

function serve(call: Call): Promise<Reply> {
    const step = stepOf(call);
    const override = step ? net.state.override[step] : undefined;
    if (override) return override(call);
    const uid = net.state.authUid();
    const filter = (column: string) => call.filters.find(([name]) => name === column)?.[1];
    if (call.table === 'chat_channels' && call.op === 'select') {
        let rows = net.state.channels.filter((row) => call.filters.every(([column, value]) => row[column] === value));
        // chat_channels_visible: the owner sees their own active room.
        rows = rows.filter((row) => row.owner_id === uid || net.state.moderator);
        for (const [column, ascending] of [...call.orders].reverse()) {
            rows = [...rows].sort((a, b) => {
                const left = String(a[column]);
                const right = String(b[column]);
                return (left < right ? -1 : left > right ? 1 : 0) * (ascending ? 1 : -1);
            });
        }
        return Promise.resolve({ data: rows.map((row) => ({ ...row })), error: null, status: 200 });
    }
    if (call.table === 'chat_channels' && call.op === 'insert') {
        const row = { ...(call.payload ?? {}) };
        // chat_channels_create: a moderator, or the owner of a private active room.
        const allowed =
            net.state.moderator || (row.owner_id === uid && row.is_private === true && row.status === 'active');
        // chat_channels_visible re-reads chat_channels by id before the row exists:
        // RETURNING fails for everyone but a moderator.
        if (!allowed || (call.returning && !net.state.moderator)) {
            return Promise.resolve({
                data: null,
                error: {
                    code: '42501',
                    message: 'new row violates row-level security policy for table "chat_channels"',
                },
                status: 403,
            });
        }
        net.state.beforeCreate?.();
        const crewRoom = (other: Record<string, unknown>) =>
            other.owner_id === row.owner_id &&
            other.is_private === true &&
            other.icon === '👥' &&
            other.status === 'active';
        if (net.state.oneRoomIndex && crewRoom(row) && net.state.channels.some(crewRoom)) {
            return Promise.resolve({
                data: null,
                error: {
                    code: '23505',
                    message: 'duplicate key value violates unique constraint "chat_channels_one_crew_room_per_owner"',
                },
                status: 409,
            });
        }
        const stored = { id: row.id ?? `server-${net.state.clock}`, created_at: stamp(), ...row };
        net.state.channels.push(stored);
        return Promise.resolve({ data: call.returning ? stored : null, error: null, status: 201 });
    }
    if (call.table === 'channel_members' && call.op === 'insert') {
        const row = call.payload as { channel_id: string; user_id: string };
        const room = net.state.channels.find((channel) => channel.id === row.channel_id);
        // channel_members_add: the channel's owner (or a moderator) adds rows.
        if (!net.state.moderator && room?.owner_id !== uid) {
            return Promise.resolve({
                data: null,
                error: { code: '42501', message: 'new row violates row-level security policy' },
                status: 403,
            });
        }
        if (net.state.members.some((m) => m.channel_id === row.channel_id && m.user_id === row.user_id)) {
            return Promise.resolve({
                data: null,
                error: { code: '23505', message: 'duplicate key value violates unique constraint' },
                status: 409,
            });
        }
        net.state.members.push({ channel_id: row.channel_id, user_id: row.user_id });
        return Promise.resolve({ data: null, error: null, status: 201 });
    }
    if (call.table === 'vessel_crew') {
        const owner = filter('owner_id');
        const rows = net.state.crew.filter((row) => owner === undefined || row.owner_id === owner);
        return Promise.resolve({ data: rows.slice(0, 1), error: null, status: 200 });
    }
    return Promise.resolve({ data: null, error: null, status: 200 });
}

function from(table: string) {
    const call: Call = {
        table,
        op: 'select',
        columns: '',
        filters: [],
        orders: [],
        usedOr: false,
        nameFilter: false,
        returning: false,
        payload: null,
        signal: null,
    };
    net.state.calls.push(call);
    let answer: Promise<Reply> | null = null;
    const builder: Record<string, unknown> = {};
    const chain = () => builder;
    Object.assign(builder, {
        select: (columns: string) => {
            if (call.op === 'insert') call.returning = true;
            else call.columns = columns;
            return builder;
        },
        insert: (payload: Record<string, unknown>) => {
            call.op = 'insert';
            call.payload = payload;
            return builder;
        },
        upsert: () => {
            throw new Error('upsert is not used: it needs an UPDATE policy the lockdown removes');
        },
        update: () => {
            throw new Error('no UPDATE path');
        },
        eq: (column: string, value: unknown) => {
            call.filters.push([column, value]);
            if (column === 'name') call.nameFilter = true;
            return builder;
        },
        or: () => {
            call.usedOr = true;
            return builder;
        },
        ilike: () => {
            call.nameFilter = true;
            return builder;
        },
        like: () => {
            call.nameFilter = true;
            return builder;
        },
        in: (column: string, value: unknown) => {
            call.filters.push([column, value]);
            return builder;
        },
        order: (column: string, options?: { ascending?: boolean }) => {
            call.orders.push([column, options?.ascending !== false]);
            return builder;
        },
        limit: chain,
        abortSignal: (signal: AbortSignal) => {
            call.signal = signal;
            return builder;
        },
        single: chain,
        maybeSingle: chain,
        then: (resolve: (reply: Reply) => unknown, reject: (error: unknown) => unknown) => {
            answer ??= serve(call);
            return answer.then(resolve, reject);
        },
    });
    return builder;
}

vi.mock('../services/supabase', () => ({
    supabase: {
        from: (table: string) => from(table),
        auth: {
            getSession: vi.fn(() =>
                net.state.session
                    ? net.state.session()
                    : Promise.resolve({
                          data: { session: net.state.sessionUserId ? { user: { id: net.state.sessionUserId } } : null },
                          error: null,
                      }),
            ),
            getUser: vi.fn(() => {
                throw new Error('openOwnCrewChat makes no getUser round trip');
            }),
        },
    },
}));

const logs = vi.hoisted(() => ({ warn: [] as unknown[][] }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({
        debug: vi.fn(),
        info: vi.fn(),
        warn: (...args: unknown[]) => logs.warn.push(args),
        error: vi.fn(),
    }),
}));

// Opening Crew Chat never asks the chat service anything (who is signed in,
// its channels), and never reads a passage or a voyage. After making a room it
// only drops the chat page's cached channel list; any other read is flagged.
const chatCache = vi.hoisted(() => ({ invalidateChannelCache: vi.fn() }));
vi.mock('../services/ChatService', () => ({
    ChatService: new Proxy(chatCache, {
        get(target, key) {
            if (key === 'invalidateChannelCache') return target.invalidateChannelCache;
            if (typeof key !== 'symbol' && key !== 'then') touched.chatService = true;
            return undefined;
        },
    }),
}));
vi.mock('../services/PassagePlanService', () => {
    touched.passage = true;
    return { getActivePassageId: () => 'sailed-passage' };
});
vi.mock('../services/VoyageService', () => {
    touched.voyage = true;
    // The passage selected on this phone was sailed days ago.
    return {
        getDraftVoyages: async () => [
            { id: 'sailed-passage', voyage_name: 'Lyttelton - Akaroa (2nd Leg)', status: 'completed' },
        ],
    };
});

import { openOwnCrewChat, crewChatFailureMessage, CREW_CHAT_OPEN_TIMEOUT_MS } from '../services/crew/crewChatRoom';
import { pickCrewChatRoom } from '../services/crew/crewChatGate';
import { setAuthIdentityScope } from '../services/authIdentityScope';

// ── Fixtures ──────────────────────────────────────────────────

const room = (id: string, name: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
    id,
    name,
    description: '',
    region: null,
    icon: '👥',
    is_global: false,
    is_private: true,
    owner_id: 'skipper-1',
    parent_id: null,
    status: 'active',
    created_at: createdAt,
    ...extra,
});

const crewChat = () => room('room-crew-chat', 'Crew Chat', '2026-10-01T02:00:00.000Z');
const passageCopies = () => [
    room('room-akaroa', 'Lyttelton - Akaroa (2nd Leg)', '2026-10-03T01:00:00.000Z'),
    room('room-funchal', 'Cádiz, Spain → Funchal', '2026-10-05T01:00:00.000Z'),
];

function signIn(userId: string) {
    net.state.sessionUserId = userId;
    setAuthIdentityScope(userId);
}

function giveCrew(ownerId = 'skipper-1') {
    net.state.crew.push({ id: `crew-row-${ownerId}`, owner_id: ownerId, crew_user_id: 'crew-1', status: 'accepted' });
}

const calls = (table: string, op: 'select' | 'insert') =>
    net.state.calls.filter((call) => call.table === table && call.op === op);
const channelInserts = () => calls('chat_channels', 'insert');
const finds = () => calls('chat_channels', 'select');
const memberInserts = () => calls('channel_members', 'insert');
const warned = () => logs.warn.map((args) => String(args[0]));

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

beforeEach(() => {
    net.state.sessionUserId = null;
    net.state.session = null;
    net.state.moderator = false;
    net.state.channels = [];
    net.state.members = [];
    net.state.crew = [];
    net.state.calls = [];
    net.state.clock = 0;
    net.state.override = {};
    net.state.beforeCreate = null;
    net.state.oneRoomIndex = false;
    logs.warn = [];
    chatCache.invalidateChannelCache.mockClear();
    localStorage.clear();
    signIn('skipper-1');
    // skipper-1 has crew (crew-1 aboard); crew-1 owns no crew of its own.
    giveCrew('skipper-1');
});

afterEach(() => {
    vi.useRealTimers();
    setAuthIdentityScope(null);
});

// ── Finding the room ──────────────────────────────────────────

describe('openOwnCrewChat finds the skipper’s one Crew Chat by owner', () => {
    it('opens with no passage selected, and never reads a passage, a voyage or the chat service', async () => {
        net.state.channels = [crewChat()];

        const result = await openOwnCrewChat();

        expect(result).toMatchObject({ ok: true, channel: { id: 'room-crew-chat', name: 'Crew Chat' } });
        expect(touched).toEqual({ chatService: false, passage: false, voyage: false });
        // Nothing was made, so the chat page's cached channel list stands.
        expect(chatCache.invalidateChannelCache).not.toHaveBeenCalled();
    });

    it('asks whether the account has crew beside the find, not after it', async () => {
        net.state.channels = [crewChat()];
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        net.state.override.find = async () => {
            await held;
            return { data: [crewChat()], error: null, status: 200 };
        };

        const pending = openOwnCrewChat();
        for (let i = 0; i < 5; i += 1) await Promise.resolve();
        // The find is still out, and the crew check has already gone.
        expect(calls('vessel_crew', 'select')).toHaveLength(1);
        expect(calls('vessel_crew', 'select')[0].filters).toEqual([['owner_id', 'skipper-1']]);
        release();

        await expect(pending).resolves.toMatchObject({ ok: true, channel: { id: 'room-crew-chat' } });
    });

    it('a stale passage named with parentheses changes nothing: the oldest room, no insert, no name filter', async () => {
        // The mocks above select 'sailed-passage' (a draft named with parentheses).
        net.state.channels = [crewChat(), ...passageCopies()];

        const result = await openOwnCrewChat();

        expect(result).toMatchObject({ ok: true, channel: { id: 'room-crew-chat' } });
        expect(channelInserts()).toHaveLength(0);
        expect(finds().length).toBeGreaterThan(0);
        for (const find of finds()) {
            expect(find.usedOr).toBe(false);
            expect(find.nameFilter).toBe(false);
            expect(find.filters).toEqual(
                expect.arrayContaining([
                    ['owner_id', 'skipper-1'],
                    ['is_private', true],
                    ['status', 'active'],
                    ['icon', '👥'],
                ]),
            );
            expect(find.orders).toEqual([
                ['created_at', true],
                ['id', true],
            ]);
        }
    });

    it('returns the oldest of the skipper’s rooms however often it is tapped, and never makes another', async () => {
        net.state.channels = [...passageCopies(), crewChat()];

        for (let tap = 0; tap < 5; tap += 1) {
            const result = await openOwnCrewChat();
            expect(result).toMatchObject({ ok: true, channel: { id: 'room-crew-chat' } });
        }
        expect(channelInserts()).toHaveLength(0);
        expect(net.state.channels).toHaveLength(3);
    });

    it('makes sure the skipper is a member, and counts "already a member" (23505) as success', async () => {
        net.state.channels = [crewChat()];
        net.state.members = [{ channel_id: 'room-crew-chat', user_id: 'skipper-1' }];

        const result = await openOwnCrewChat();

        expect(result).toMatchObject({ ok: true, channel: { id: 'room-crew-chat' } });
        expect(memberInserts()).toHaveLength(1);
        expect(memberInserts()[0].payload).toEqual({ channel_id: 'room-crew-chat', user_id: 'skipper-1' });
        expect(warned()).toEqual([]);
    });

    it('adds the membership row when it is missing', async () => {
        net.state.channels = [crewChat()];

        await openOwnCrewChat();

        expect(net.state.members).toEqual([{ channel_id: 'room-crew-chat', user_id: 'skipper-1' }]);
    });

    it('a refused membership row does not stop the owner opening their own room', async () => {
        net.state.channels = [crewChat()];
        net.state.override.member = async () => ({
            data: null,
            error: { code: '42501', message: 'new row violates row-level security policy' },
            status: 403,
        });

        const result = await openOwnCrewChat();

        expect(result).toMatchObject({ ok: true, channel: { id: 'room-crew-chat' } });
        expect(warned()).toEqual(['crew-chat: denied-member']);
    });
});

// ── Creating it, once ─────────────────────────────────────────

describe('With no room yet, a skipper with crew gets one, created without RETURNING', () => {
    it.each([
        ['a skipper who is not a chat moderator (RETURNING would be 42501)', false],
        ['a chat moderator', true],
    ])('%s: one insert with a supplied id, one membership, then the room read back', async (_label, moderator) => {
        net.state.moderator = moderator;

        const result = await openOwnCrewChat();

        expect(result.ok).toBe(true);
        expect(channelInserts()).toHaveLength(1);
        const insert = channelInserts()[0];
        expect(insert.returning).toBe(false);
        expect(insert.payload).toMatchObject({
            name: 'Crew Chat',
            description: '',
            icon: '👥',
            is_private: true,
            is_global: false,
            status: 'active',
            owner_id: 'skipper-1',
            parent_id: null,
        });
        expect(String(insert.payload?.id)).toMatch(UUID);
        // The chat page's cached channel list predates the room: it is dropped,
        // for this account only.
        expect(chatCache.invalidateChannelCache).toHaveBeenCalledExactlyOnceWith(
            expect.objectContaining({ key: 'user:skipper-1', userId: 'skipper-1' }),
        );
        expect(touched.chatService).toBe(false);
        expect(memberInserts()).toHaveLength(1);
        expect(memberInserts()[0].payload).toEqual({ channel_id: insert.payload?.id, user_id: 'skipper-1' });
        // The second find reads the new room back.
        expect(finds()).toHaveLength(2);
        expect(result).toMatchObject({ ok: true, channel: { id: insert.payload?.id, name: 'Crew Chat' } });
    });

    it('the fake reproduces the live trap: an insert WITH RETURNING fails 42501 for a non-moderator', async () => {
        const { supabase } = await import('../services/supabase');
        const reply = await (
            supabase as unknown as {
                from: (t: string) => { insert: (p: object) => { select: () => PromiseLike<Reply> } };
            }
        )
            .from('chat_channels')
            .insert({ id: 'x', owner_id: 'skipper-1', is_private: true, status: 'active' })
            .select();
        expect(reply.error?.code).toBe('42501');
    });

    it('two concurrent taps make one find and at most one insert, and both open the same room', async () => {
        const [first, second] = await Promise.all([openOwnCrewChat(), openOwnCrewChat()]);

        expect(channelInserts()).toHaveLength(1);
        expect(finds()).toHaveLength(2); // one find, then the read-back
        expect(first).toEqual(second);
        expect(first.ok).toBe(true);
    });

    it('two phones racing: when the read-back finds two rooms, both phones get the oldest', async () => {
        // The other phone's room lands a moment before ours.
        net.state.beforeCreate = () => {
            net.state.beforeCreate = null;
            net.state.channels.push(room('room-other-phone', 'Crew Chat', '2026-10-09T00:09:59.000Z'));
        };

        const thisPhone = await openOwnCrewChat();
        const otherPhone = await openOwnCrewChat();

        expect(thisPhone).toMatchObject({ ok: true, channel: { id: 'room-other-phone' } });
        expect(otherPhone).toMatchObject({ ok: true, channel: { id: 'room-other-phone' } });
        expect(channelInserts()).toHaveLength(1);
    });

    it('with one room per skipper in the database, a create that loses the race (23505) opens the other phone’s room', async () => {
        // The other phone's Crew Chat lands a moment before ours, and the
        // unique index refuses ours. That is not a failure: read it back.
        net.state.oneRoomIndex = true;
        net.state.beforeCreate = () => {
            net.state.beforeCreate = null;
            net.state.channels.push(room('room-other-phone', 'Crew Chat', '2026-10-09T00:09:59.000Z'));
        };

        const result = await openOwnCrewChat();

        expect(result).toMatchObject({ ok: true, channel: { id: 'room-other-phone', name: 'Crew Chat' } });
        expect(crewChatFailureMessage(result)).toBeNull();
        expect(channelInserts()).toHaveLength(1);
        expect(net.state.channels.map((channel) => channel.id)).toEqual(['room-other-phone']);
        // The find, then the read-back.
        expect(finds()).toHaveLength(2);
        expect(memberInserts()).toHaveLength(1);
        expect(memberInserts()[0].payload).toEqual({ channel_id: 'room-other-phone', user_id: 'skipper-1' });
        expect(warned()).toEqual([]);
    });

    it('a 23505 with no room to read back still does not open, and says why', async () => {
        net.state.override.create = async () => ({
            data: null,
            error: { code: '23505', message: 'duplicate key value violates unique constraint' },
            status: 409,
        });

        const result = await openOwnCrewChat();

        expect(result).toEqual({ ok: false, reason: 'denied', step: 'readback' });
        expect(finds()).toHaveLength(2);
        expect(memberInserts()).toHaveLength(0);
        expect(crewChatFailureMessage(result)).not.toMatch(/sign in/i);
    });

    it('a crew-only account with no room of its own is told so, and nothing is created', async () => {
        signIn('crew-1');

        const result = await openOwnCrewChat();

        expect(result).toEqual({ ok: false, reason: 'not_ready' });
        expect(channelInserts()).toHaveLength(0);
        expect(memberInserts()).toHaveLength(0);
        expect(warned()).toEqual(['crew-chat: no-own-crew']);
    });

    it('a crew-only account that owns an old 👥 room from an older build is told so, not sent into it', async () => {
        // Before 885ea04c a crew account with passage chat could make its own
        // passage-named room. Posting there would reach nobody.
        signIn('crew-1');
        net.state.channels = [
            room('room-orphan', 'Lyttelton - Akaroa (2nd Leg)', '2026-09-20T03:00:00.000Z', { owner_id: 'crew-1' }),
        ];

        const result = await openOwnCrewChat();

        expect(result).toEqual({ ok: false, reason: 'not_ready' });
        expect(crewChatFailureMessage(result)).toBe(
            "Your skipper hasn't opened Crew Chat yet. It shows here once they do.",
        );
        expect(channelInserts()).toHaveLength(0);
        expect(memberInserts()).toHaveLength(0);
        expect(net.state.members).toEqual([]);
    });

    it('a crew check that cannot be answered says so, and nothing is made or joined', async () => {
        net.state.override.crew = async () => ({
            data: null,
            error: { code: '', message: 'TypeError: Load failed' },
            status: 0,
        });

        const result = await openOwnCrewChat();

        expect(result).toEqual({ ok: false, reason: 'offline', step: 'crew' });
        expect(channelInserts()).toHaveLength(0);
        expect(memberInserts()).toHaveLength(0);
    });

    it('a 42501 on the insert itself is "denied", never "Sign in"', async () => {
        net.state.override.create = async () => ({
            data: null,
            error: { code: '42501', message: 'new row violates row-level security policy for table "chat_channels"' },
            status: 403,
        });

        const result = await openOwnCrewChat();

        expect(result).toEqual({ ok: false, reason: 'denied', step: 'create' });
        expect(crewChatFailureMessage(result)).not.toMatch(/sign in/i);
        expect(warned()).toEqual(['crew-chat: denied-create']);
    });
});

// ── Session and timing ────────────────────────────────────────

describe('Identity comes from the local session, with no round trip and no false "Sign in"', () => {
    it('a session still loading (3 s) opens the room, and taps during the wait share the one call', async () => {
        vi.useFakeTimers();
        net.state.channels = [crewChat()];
        net.state.session = () =>
            new Promise((resolve) =>
                setTimeout(() => resolve({ data: { session: { user: { id: 'skipper-1' } } }, error: null }), 3000),
            );

        const first = openOwnCrewChat();
        await vi.advanceTimersByTimeAsync(1000);
        const second = openOwnCrewChat();
        await vi.advanceTimersByTimeAsync(1000);
        const third = openOwnCrewChat();
        await vi.advanceTimersByTimeAsync(1000);

        const results = await Promise.all([first, second, third]);
        for (const result of results) expect(result).toMatchObject({ ok: true, channel: { id: 'room-crew-chat' } });
        expect(finds()).toHaveLength(1);
        expect(warned()).toEqual([]);
    });

    it('no session at all is the only "signed_out", with its own toast', async () => {
        net.state.sessionUserId = null;

        const result = await openOwnCrewChat();

        expect(result).toEqual({ ok: false, reason: 'signed_out' });
        expect(crewChatFailureMessage(result)).toBe('Sign in to use Crew Chat');
        expect(warned()).toEqual(['crew-chat: no-session']);
        expect(net.state.calls).toHaveLength(0);
    });

    it('signed out on this phone (no account in scope) is "signed_out" with no call made', async () => {
        setAuthIdentityScope(null);

        const result = await openOwnCrewChat();

        expect(result).toEqual({ ok: false, reason: 'signed_out' });
        expect(net.state.calls).toHaveLength(0);
    });

    it('a session read error is "offline"', async () => {
        net.state.session = async () => ({
            data: { session: null },
            error: { name: 'AuthRetryableFetchError', message: 'Failed to fetch', status: 0 },
        });

        const result = await openOwnCrewChat();

        expect(result).toEqual({ ok: false, reason: 'offline', step: 'session' });
        expect(warned()).toEqual(['crew-chat: offline']);
    });

    it('a refused refresh is "session_expired", though auth-js has already signed the account out', async () => {
        // auth-js 2.98: a 4xx refresh removes the session and awaits SIGNED_OUT
        // (the identity scope goes anonymous) before getSession returns.
        net.state.session = async () => {
            net.state.sessionUserId = null;
            setAuthIdentityScope(null);
            return {
                data: { session: null },
                error: { name: 'AuthApiError', message: 'Invalid Refresh Token: Refresh Token Not Found', status: 400 },
            };
        };

        const result = await openOwnCrewChat();

        expect(result).toEqual({ ok: false, reason: 'session_expired', step: 'session' });
        expect(crewChatFailureMessage(result)).toBe('Your sign-in has expired. Sign in again to open Crew Chat.');
        expect(warned()).toEqual(['crew-chat: session-expired']);
        expect(net.state.calls).toHaveLength(0);
    });

    it('a refused refresh with the account still in scope is "session_expired" too', async () => {
        net.state.session = async () => ({
            data: { session: null },
            error: { name: 'AuthApiError', message: 'Invalid Refresh Token: Already Used', status: 400 },
        });

        await expect(openOwnCrewChat()).resolves.toEqual({ ok: false, reason: 'session_expired', step: 'session' });
    });

    it('a refused refresh after another account signed in is "stale", not an expiry', async () => {
        net.state.session = async () => {
            signIn('crew-1');
            return {
                data: { session: null },
                error: { name: 'AuthApiError', message: 'Invalid Refresh Token: Refresh Token Not Found', status: 400 },
            };
        };

        await expect(openOwnCrewChat()).resolves.toEqual({ ok: false, reason: 'stale' });
        expect(net.state.calls).toHaveLength(0);
    });

    it('a dropped link on the find (fetch TypeError) is "offline"', async () => {
        net.state.override.find = async () => ({
            data: null,
            error: { code: '', message: 'TypeError: Failed to fetch' },
            status: 0,
        });

        const result = await openOwnCrewChat();

        expect(result).toEqual({ ok: false, reason: 'offline', step: 'find' });
    });

    it('a thrown TypeError is "offline" too', async () => {
        net.state.override.find = () => Promise.reject(new TypeError('Load failed'));

        const result = await openOwnCrewChat();

        expect(result).toEqual({ ok: false, reason: 'offline', step: 'find' });
    });

    it('a 401 (JWT expired) is "session_expired"', async () => {
        net.state.override.find = async () => ({
            data: null,
            error: { code: 'PGRST301', message: 'JWT expired' },
            status: 401,
        });

        const result = await openOwnCrewChat();

        expect(result).toEqual({ ok: false, reason: 'session_expired', step: 'find' });
        expect(crewChatFailureMessage(result)).toBe('Your sign-in has expired. Sign in again to open Crew Chat.');
        expect(warned()).toEqual(['crew-chat: session-expired']);
    });

    it('a 42501 on the find is "denied"', async () => {
        net.state.override.find = async () => ({
            data: null,
            error: { code: '42501', message: 'permission denied for table chat_channels' },
            status: 403,
        });

        const result = await openOwnCrewChat();

        expect(result).toEqual({ ok: false, reason: 'denied', step: 'find' });
        expect(warned()).toEqual(['crew-chat: denied-find']);
    });

    it('anything else is "failed", logged with its step', async () => {
        net.state.override.find = async () => ({
            data: null,
            error: { code: '42703', message: 'column does not exist' },
            status: 400,
        });

        const result = await openOwnCrewChat();

        expect(result).toEqual({ ok: false, reason: 'failed', step: 'find' });
        expect(crewChatFailureMessage(result)).toBe("Crew Chat didn't open. Try again.");
        expect(warned()).toEqual(['crew-chat: failed-find']);
    });

    it('past 15 s is "timeout", and the next tap starts afresh', async () => {
        vi.useFakeTimers();
        net.state.channels = [crewChat()];
        net.state.session = () => new Promise(() => {});

        const pending = openOwnCrewChat();
        await vi.advanceTimersByTimeAsync(CREW_CHAT_OPEN_TIMEOUT_MS);

        await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' });
        expect(CREW_CHAT_OPEN_TIMEOUT_MS).toBe(15_000);
        expect(crewChatFailureMessage({ ok: false, reason: 'timeout' })).toBe(
            "Couldn't reach Crew Chat. Check your connection and try again.",
        );
        expect(warned()).toEqual(['crew-chat: timeout']);

        net.state.session = null;
        await expect(openOwnCrewChat()).resolves.toMatchObject({ ok: true, channel: { id: 'room-crew-chat' } });
    });

    it('a timeout aborts the requests still out', async () => {
        vi.useFakeTimers();
        net.state.override.find = () => new Promise(() => {});

        const pending = openOwnCrewChat();
        await vi.advanceTimersByTimeAsync(CREW_CHAT_OPEN_TIMEOUT_MS);

        await expect(pending).resolves.toEqual({ ok: false, reason: 'timeout' });
        expect(finds()[0].signal?.aborted).toBe(true);
    });

    it('an account switch mid-tap is "stale": no toast, and nothing reaches the old account', async () => {
        net.state.channels = [crewChat()];
        let release!: () => void;
        const held = new Promise<void>((resolve) => {
            release = resolve;
        });
        net.state.override.find = async (call) => {
            await held;
            return { data: call.table === 'chat_channels' ? [crewChat()] : [], error: null, status: 200 };
        };

        const pending = openOwnCrewChat();
        await Promise.resolve();
        signIn('crew-1');
        release();

        const result = await pending;
        expect(result).toEqual({ ok: false, reason: 'stale' });
        expect(crewChatFailureMessage(result)).toBeNull();
        expect(warned()).toEqual(['crew-chat: identity-changed']);
    });

    it('a stored session that belongs to another account is "stale" too', async () => {
        net.state.sessionUserId = 'crew-1';

        const result = await openOwnCrewChat();

        expect(result).toEqual({ ok: false, reason: 'stale' });
        expect(net.state.calls).toHaveLength(0);
    });

    it('logs carry a reason only, never an id, a name or an email', async () => {
        net.state.override.find = async () => ({
            data: null,
            error: { code: '42501', message: 'denied for skipper-1 (skipper@example.test)' },
            status: 403,
        });
        await openOwnCrewChat();
        signIn('crew-1');
        net.state.override = {};
        await openOwnCrewChat();

        expect(logs.warn.length).toBeGreaterThan(0);
        for (const args of logs.warn) {
            expect(args).toHaveLength(1);
            expect(String(args[0])).toMatch(/^crew-chat: [a-z-]+$/);
        }
    });
});

// ── Every reason has its own words ────────────────────────────

describe('crewChatFailureMessage: honest copy, "Sign in" only when there is truly no session', () => {
    it.each([
        [{ reason: 'signed_out' }, 'Sign in to use Crew Chat'],
        [{ reason: 'session_expired' }, 'Your sign-in has expired. Sign in again to open Crew Chat.'],
        [{ reason: 'offline' }, "Couldn't reach Crew Chat. Check your connection and try again."],
        [{ reason: 'timeout' }, "Couldn't reach Crew Chat. Check your connection and try again."],
        [{ reason: 'denied', step: 'find' }, "Crew Chat couldn't be set up for this account. Try again shortly."],
        [{ reason: 'denied', step: 'member' }, "Crew Chat couldn't be set up for this account. Try again shortly."],
        [
            { reason: 'denied', step: 'create' },
            "Crew Chat can't be set up from this phone yet; it will work after the next update.",
        ],
        [{ reason: 'not_ready' }, "Your skipper hasn't opened Crew Chat yet. It shows here once they do."],
        [{ reason: 'failed' }, "Crew Chat didn't open. Try again."],
        [{ reason: 'stale' }, null],
    ] as const)('%o → %s', (failure, message) => {
        expect(crewChatFailureMessage({ ok: false, ...failure } as Parameters<typeof crewChatFailureMessage>[0])).toBe(
            message,
        );
    });
});

// ── The pick, shared with the crew's card ─────────────────────

describe('pickCrewChatRoom', () => {
    it('picks the owner’s oldest active private 👥 room, by age then id, never by name', () => {
        const rooms = [
            room('b-room', 'Bora Bora (Vaitape)', '2026-10-02T00:00:00.000Z'),
            room('a-room', '父島 → 母島', '2026-10-02T00:00:00.000Z'),
            room('z-room', "St. John's (NL) → Horta", '2026-10-07T00:00:00.000Z'),
            room('old-other', 'Crew Chat', '2026-09-01T00:00:00.000Z', { owner_id: 'skipper-2' }),
            room('old-public', 'Crew Chat', '2026-09-01T00:00:00.000Z', { is_private: false }),
            room('old-retired', 'Crew Chat', '2026-09-01T00:00:00.000Z', { status: 'archived' }),
            room('old-galley', 'Galley', '2026-09-01T00:00:00.000Z', { icon: '🍳' }),
        ];
        expect(pickCrewChatRoom(rooms as never, 'skipper-1')?.id).toBe('a-room');
        expect(pickCrewChatRoom(rooms as never, 'skipper-2')?.id).toBe('old-other');
        expect(pickCrewChatRoom(rooms as never, 'nobody')).toBeNull();
    });

    it('orders microsecond timestamps from the server correctly', () => {
        const rooms = [
            room('later', 'Crew Chat', '2026-10-09T00:10:00.123789+00:00'),
            room('earlier', 'Crew Chat', '2026-10-09T00:10:00.123456+00:00'),
        ];
        expect(pickCrewChatRoom(rooms as never, 'skipper-1')?.id).toBe('earlier');
    });
});
