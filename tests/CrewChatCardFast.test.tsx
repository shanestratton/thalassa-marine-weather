/**
 * The Crew Chat card arrives with the other cards, and fast.
 *
 * Shane 2026-10-06: "the crew chat - private group takes about 5-10 seconds
 * to arrive in the scuttlebutt page, can we also fix that, they all need to
 * come at the same time. and fast". The card waited on a serial chain
 * (channels, then the crew repair, then fresh channels, then the profile,
 * then the crew rows, then the vessel names); every other card painted at
 * once.
 *
 * Only the network is fake here (Supabase and the chat service), so these
 * tests hold the page to what it does, not to how it is wired. People and
 * vessels are fictional.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { User } from '@supabase/supabase-js';

// ── The fake network ──────────────────────────────────────────

interface Query {
    table: string;
    columns: string;
    filters: Array<[string, unknown]>;
}
interface Reply {
    data: unknown;
    error: unknown;
}

const net = vi.hoisted(() => {
    const state = {
        /** Who Supabase says is signed in. */
        userId: null as string | null,
        /** How every table query answers; tests replace it. */
        reply: (_query: Query): Promise<Reply> => Promise.resolve({ data: [], error: null }),
        /** How long the auth server takes to answer getUser (a network call). */
        authUser: (): Promise<void> => Promise.resolve(),
    };
    const from = (table: string) => {
        const query: Query = { table, columns: '', filters: [] };
        let answer: Promise<Reply> | null = null;
        const builder: Record<string, unknown> = {};
        const chain = () => builder;
        Object.assign(builder, {
            select: (columns: string) => {
                query.columns = columns;
                return builder;
            },
            eq: (column: string, value: unknown) => {
                query.filters.push([column, value]);
                return builder;
            },
            in: (column: string, value: unknown) => {
                query.filters.push([column, value]);
                return builder;
            },
            order: chain,
            limit: chain,
            range: chain,
            abortSignal: chain,
            single: chain,
            maybeSingle: chain,
            then: (resolve: (reply: Reply) => unknown, reject: (error: unknown) => unknown) => {
                answer ??= state.reply(query);
                return answer.then(resolve, reject);
            },
        });
        return builder;
    };
    return { state, from };
});

vi.mock('../services/supabase', () => ({
    supabase: {
        from: (table: string) => net.from(table),
        auth: {
            getUser: vi.fn(async () => {
                await net.state.authUser();
                return { data: { user: net.state.userId ? { id: net.state.userId } : null }, error: null };
            }),
            getSession: vi.fn(async () => ({
                data: { session: net.state.userId ? { user: { id: net.state.userId } } : null },
                error: null,
            })),
            onAuthStateChange: vi.fn().mockReturnValue({ data: { subscription: { unsubscribe: vi.fn() } } }),
        },
    },
}));

// ── The page's other dependencies (as tests/ChatPage.test.tsx) ──

vi.mock('@capacitor/keyboard', () => ({
    Keyboard: { addListener: vi.fn(() => Promise.resolve({ remove: vi.fn() })) },
}));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../context/SettingsContext', () => ({
    useSettings: () => ({
        // The signed-in account's OWN boat. A crew member's card never names it.
        settings: { userName: 'Test', vessel: { name: 'Kestrel' } },
        updateSettings: vi.fn(),
    }),
    SettingsProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../hooks/useKeyboardScroll', () => ({ useKeyboardScroll: () => ({ current: null }) }));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

vi.mock('../services/ChatService', () => ({
    ChatService: {
        initialize: vi.fn(),
        reconcileAcceptedCrewChannels: vi.fn(),
        getChannels: vi.fn(),
        getChannelsFresh: vi.fn(),
        getMessages: vi.fn().mockResolvedValue([]),
        sendMessage: vi.fn().mockResolvedValue(null),
        subscribeToChannel: vi.fn(() => vi.fn()),
        getCurrentUser: vi.fn(),
        getRole: vi.fn().mockReturnValue('member'),
        isMod: vi.fn().mockReturnValue(false),
        isAdmin: vi.fn().mockReturnValue(false),
        isModerator: vi.fn().mockReturnValue(false),
        getCurrentUserId: vi.fn().mockReturnValue(null),
        getDMConversations: vi.fn().mockResolvedValue([]),
        getDMThread: vi.fn().mockResolvedValue([]),
        subscribeToDMs: vi.fn(() => vi.fn()),
        getUnreadDMCount: vi.fn().mockResolvedValue(0),
        markHelpful: vi.fn(),
        blockUser: vi.fn(),
        unblockUser: vi.fn(),
        isBlocked: vi.fn().mockResolvedValue(false),
        getDMBlockStatus: vi.fn().mockResolvedValue({ blockedByMe: false, blockedEitherDirection: false }),
        getBlockedUsers: vi.fn().mockResolvedValue([]),
        listAllUsersWithRoles: vi.fn().mockResolvedValue([]),
        isMuted: vi.fn().mockReturnValue(false),
        getMutedUntil: vi.fn().mockReturnValue(null),
        destroy: vi.fn(),
        isChannelMember: vi.fn(),
    },
}));
vi.mock('../services/ContentModerationService', () => ({
    moderateMessage: vi.fn().mockResolvedValue({ safe: true }),
    reportMessage: vi.fn(),
}));
vi.mock('../services/VesselIdentityService', () => ({ fetchVesselNameForOwner: vi.fn() }));
vi.mock('../services/PassagePlanService', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../services/PassagePlanService')>();
    return { ...actual, getPassageStatus: vi.fn() };
});

vi.mock('../components/SignInScreen', () => ({ SignInScreen: () => null }));
vi.mock('../components/chat/ChatErrorBoundary', () => ({
    ChatErrorBoundary: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('../components/chat/ChatHeader', () => ({ ChatHeader: () => <div>Crew Talk</div> }));
vi.mock('../components/chat/ChatMessageList', () => ({ ChatMessageList: () => null }));
vi.mock('../components/chat/ChatComposer', () => ({ ChatComposer: () => null }));
vi.mock('../components/chat/ChatProfileView', () => ({ ChatProfileView: () => null }));
vi.mock('../components/chat/ChatDMView', () => ({
    ChatDMInbox: () => null,
    ChatDMThread: () => null,
    ChatDMCompose: () => null,
}));
vi.mock('../components/chat/TypingIndicator', () => ({ TypingIndicator: () => null }));
vi.mock('../components/chat/WelcomeBanner', () => ({ WelcomeBanner: () => null }));
vi.mock('../components/chat/AuthBanner', () => ({ AuthBanner: () => null }));
vi.mock('../components/Toast', async (importOriginal) => {
    const actual = await importOriginal<typeof import('../components/Toast')>();
    return { ...actual, toast: { ...actual.toast, error: vi.fn() } };
});

/** Every Crew Chat card the list was handed, in paint order. */
const paints = vi.hoisted(
    () =>
        [] as Array<{
            card: boolean;
            channel: string;
            vesselName: string;
            crewChatVesselName: string;
        }>,
);
vi.mock('../components/chat/ChannelList', () => ({
    ChannelList: (props: {
        onOpenChannel: (channel: { id: string }) => void;
        hasCrewInvited?: boolean;
        crewChatChannel?: { id: string } | null;
        vesselName?: string;
        crewChatVesselName?: string;
    }) => {
        const paint = {
            card: !!props.hasCrewInvited,
            channel: props.crewChatChannel?.id ?? '',
            vesselName: props.vesselName ?? '',
            crewChatVesselName: props.crewChatVesselName ?? '',
        };
        paints.push(paint);
        return (
            <div
                data-testid="channel-list"
                data-card={String(paint.card)}
                data-channel={paint.channel}
                data-vessel-name={paint.vesselName}
                data-crew-chat-vessel-name={paint.crewChatVesselName}
            >
                Channels
                {props.crewChatChannel && (
                    <button onClick={() => props.onOpenChannel(props.crewChatChannel!)}>Open Crew Chat</button>
                )}
            </div>
        );
    },
}));

import { ChatPage } from '../components/ChatPage';
import { ChatService, type ChatChannel } from '../services/ChatService';
import { fetchVesselNameForOwner } from '../services/VesselIdentityService';
import { NO_PASSAGE_ACCESS, getPassageStatus, setActivePassage } from '../services/PassagePlanService';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { useAuthStore } from '../stores/authStore';
import { toast } from '../components/Toast';
import { pickCrewChatRoom } from '../services/crew/crewChatGate';

// ── Fixtures ──────────────────────────────────────────────────

const general = {
    id: 'general',
    name: 'General',
    description: 'General chat',
    region: null,
    icon: '💬',
    is_global: true,
    is_private: false,
    owner_id: null,
    parent_id: null,
    created_at: '2026-10-01T00:00:00Z',
} as ChatChannel;
const groupOf = (ownerId: string) =>
    ({
        ...general,
        id: `crew-chat-${ownerId}`,
        name: 'Crew Chat',
        description: 'Private crew group',
        icon: '👥',
        is_global: false,
        is_private: true,
        owner_id: ownerId,
    }) as ChatChannel;

const GATE_KEY = 'thalassa_crew_chat_gate_v1';
const gateKey = (userId: string) => `${GATE_KEY}::${encodeURIComponent(`user:${userId}`)}`;
/** What this device last verified for an account (the remembered gate). */
function remember(userId: string, gate: Record<string, unknown>) {
    localStorage.setItem(
        gateKey(userId),
        JSON.stringify({
            version: 1,
            userId,
            hasOwnedCrew: false,
            memberOwnerIds: [],
            channel: null,
            passage: null,
            vesselNames: {},
            ...gate,
        }),
    );
}
const remembered = (userId: string) => JSON.parse(localStorage.getItem(gateKey(userId)) ?? 'null');

function signIn(userId: string) {
    net.state.userId = userId;
    setAuthIdentityScope(userId);
    useAuthStore.setState({ user: { id: userId } as User });
}

const never = <T,>() => new Promise<T>(() => {});
/** A network answer that takes `ms` (fake timers in the timing tests). */
const after = <T,>(value: T, ms = 1000) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

/** Rows the vessel_crew table holds, as RLS shows them to the signed-in account. */
interface Tables {
    ownedCrew?: Array<{ owner_id: string; crew_user_id: string; status: string }>;
    memberships?: Array<{ owner_id: string; crew_user_id: string; status: string }>;
    channelMembers?: string[];
}
function answer(tables: Tables, delay?: (reply: Reply) => Promise<Reply>) {
    net.state.reply = (query) => {
        const filter = (column: string) => query.filters.find(([name]) => name === column)?.[1];
        let reply: Reply = { data: [], error: null };
        if (query.table === 'vessel_crew' && filter('owner_id') !== undefined) {
            reply = { data: (tables.ownedCrew ?? []).map((row, i) => ({ id: `own-${i}`, ...row })), error: null };
        } else if (query.table === 'vessel_crew' && filter('crew_user_id') !== undefined) {
            reply = { data: (tables.memberships ?? []).map((row, i) => ({ id: `mem-${i}`, ...row })), error: null };
        } else if (query.table === 'channel_members') {
            const wanted = filter('channel_id');
            const ids = (tables.channelMembers ?? []).filter((id) =>
                wanted === undefined ? true : Array.isArray(wanted) ? wanted.includes(id) : wanted === id,
            );
            const rows = ids.map((id) => ({ channel_id: id, user_id: net.state.userId }));
            // isChannelMember-style single-row reads get one row or null.
            reply = { data: typeof wanted === 'string' ? (rows[0] ?? null) : rows, error: null };
        } else {
            reply = { data: null, error: null };
        }
        return delay ? delay(reply) : Promise.resolve(reply);
    };
}

/** Hold every table read until `release()`: the list paints first. */
function held() {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
        release = resolve;
    });
    return { release, delay: (reply: Reply) => gate.then(() => reply) };
}

const list = () => screen.getByTestId('channel-list');
const firstPaint = () => paints[0];

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    paints.length = 0;
    net.state.authUser = () => Promise.resolve();
    answer({});
    vi.mocked(ChatService.initialize).mockResolvedValue(undefined);
    vi.mocked(ChatService.reconcileAcceptedCrewChannels).mockResolvedValue({ status: 'ok', joinedCount: 0 });
    vi.mocked(ChatService.getChannels).mockResolvedValue([general]);
    vi.mocked(ChatService.getChannelsFresh).mockResolvedValue([]);
    vi.mocked(ChatService.getCurrentUser).mockResolvedValue(null);
    vi.mocked(ChatService.isChannelMember).mockResolvedValue(false);
    vi.mocked(fetchVesselNameForOwner).mockResolvedValue(null);
    vi.mocked(getPassageStatus).mockResolvedValue(NO_PASSAGE_ACCESS);
});

afterEach(() => {
    cleanup();
    useAuthStore.setState({ user: null });
    net.state.userId = null;
    setAuthIdentityScope(null);
    vi.useRealTimers();
});

/** Every live read this page could wait on, held open. */
function holdTheNetwork() {
    net.state.reply = () => never<Reply>();
    net.state.authUser = () => never<void>();
    vi.mocked(getPassageStatus).mockReturnValue(never());
    vi.mocked(fetchVesselNameForOwner).mockReturnValue(never());
    vi.mocked(ChatService.isChannelMember).mockReturnValue(never());
    vi.mocked(ChatService.reconcileAcceptedCrewChannels).mockReturnValue(never());
}

// ── First paint, from what this device already knows ──────────

describe('Crew Chat card paints with the other cards (Shane 2026-10-06)', () => {
    it("a skipper's card is on the list's first paint, while every live read is still out", async () => {
        signIn('skipper-1');
        remember('skipper-1', { hasOwnedCrew: true });
        holdTheNetwork();

        render(<ChatPage />);

        await screen.findByTestId('channel-list');
        expect(firstPaint()).toEqual({ card: true, channel: '', vesselName: 'Kestrel', crewChatVesselName: '' });
    });

    it("a crew member's card is on the first paint, opening the skipper's group and naming her boat", async () => {
        signIn('crew-a');
        remember('crew-a', {
            memberOwnerIds: ['skipper-1'],
            channel: groupOf('skipper-1'),
            vesselNames: { 'skipper-1': 'Albatross' },
        });
        holdTheNetwork();

        render(<ChatPage />);

        await screen.findByTestId('channel-list');
        expect(firstPaint()).toEqual({
            card: true,
            channel: 'crew-chat-skipper-1',
            vesselName: '',
            crewChatVesselName: 'Albatross',
        });
    });

    it('a fresher vessel name swaps in with no paint in between', async () => {
        signIn('crew-a');
        remember('crew-a', {
            memberOwnerIds: ['skipper-1'],
            channel: groupOf('skipper-1'),
            vesselNames: { 'skipper-1': 'Albatross' },
        });
        answer({
            memberships: [{ owner_id: 'skipper-1', crew_user_id: 'crew-a', status: 'accepted' }],
            channelMembers: ['crew-chat-skipper-1'],
        });
        vi.mocked(fetchVesselNameForOwner).mockResolvedValue('Albatross II');

        render(<ChatPage />);

        await waitFor(() => expect(list()).toHaveAttribute('data-crew-chat-vessel-name', 'Albatross II'));
        // Every paint of the card carried a name: never the generic wording.
        expect(paints.every((paint) => paint.card && paint.channel === 'crew-chat-skipper-1')).toBe(true);
        expect(paints.map((paint) => paint.crewChatVesselName)).not.toContain('');
        expect(remembered('crew-a').vesselNames).toEqual({ 'skipper-1': 'Albatross II' });
    });
});

// ── Nothing remembered: as fast as the slowest single read ────

describe('With nothing remembered, the card lands with the slowest single read, not their sum', () => {
    /** Every network call the page makes takes one second. */
    function everyCallTakesOneSecond() {
        vi.mocked(ChatService.initialize).mockImplementation(() => after(undefined));
        vi.mocked(ChatService.getChannels).mockImplementation(() => after([general, groupOf('skipper-1')]));
        vi.mocked(ChatService.reconcileAcceptedCrewChannels).mockImplementation(() =>
            after({ status: 'ok' as const, joinedCount: 0 }),
        );
        vi.mocked(ChatService.getChannelsFresh).mockImplementation(() => after([general, groupOf('skipper-1')]));
        vi.mocked(ChatService.getCurrentUser).mockImplementation(() => after(null));
        vi.mocked(ChatService.isChannelMember).mockImplementation((id: string) => after(id === 'crew-chat-skipper-1'));
        vi.mocked(getPassageStatus).mockImplementation(() => after(NO_PASSAGE_ACCESS));
        vi.mocked(fetchVesselNameForOwner).mockImplementation((ownerId: string) =>
            after(ownerId === 'skipper-1' ? 'Albatross' : null),
        );
        net.state.authUser = () => after(undefined);
    }
    const flush = async (ms: number) => {
        await act(async () => {
            await vi.advanceTimersByTimeAsync(ms);
        });
    };

    it("a skipper's card is there one second in, with the list", async () => {
        vi.useFakeTimers();
        signIn('skipper-1');
        everyCallTakesOneSecond();
        answer({ ownedCrew: [{ owner_id: 'skipper-1', crew_user_id: 'crew-a', status: 'accepted' }] }, (reply) =>
            after(reply),
        );

        render(<ChatPage />);
        await flush(1000);

        expect(list()).toHaveAttribute('data-card', 'true');
        expect(paints.filter((paint) => !paint.card)).toEqual([]);
        expect(remembered('skipper-1')).toMatchObject({ hasOwnedCrew: true });
    });

    it("a crew member's card is there one second in, and her name one read later", async () => {
        vi.useFakeTimers();
        signIn('crew-a');
        everyCallTakesOneSecond();
        answer(
            {
                memberships: [{ owner_id: 'skipper-1', crew_user_id: 'crew-a', status: 'accepted' }],
                channelMembers: ['crew-chat-skipper-1'],
            },
            (reply) => after(reply),
        );

        render(<ChatPage />);
        await flush(1000);

        expect(list()).toHaveAttribute('data-card', 'true');
        expect(list()).toHaveAttribute('data-channel', 'crew-chat-skipper-1');
        expect(list()).toHaveAttribute('data-vessel-name', '');

        await flush(1000);
        expect(list()).toHaveAttribute('data-crew-chat-vessel-name', 'Albatross');
        expect(remembered('crew-a')).toMatchObject({
            memberOwnerIds: ['skipper-1'],
            channel: { id: 'crew-chat-skipper-1', owner_id: 'skipper-1' },
            vesselNames: { 'skipper-1': 'Albatross' },
        });
    });
});

// ── The live answer wins, at once ─────────────────────────────

describe('A remembered card follows the live answer', () => {
    it('hides at once when the skipper has removed this crew member, and is forgotten', async () => {
        signIn('crew-a');
        remember('crew-a', {
            memberOwnerIds: ['skipper-1'],
            channel: groupOf('skipper-1'),
            vesselNames: { 'skipper-1': 'Albatross' },
        });
        const live = held();
        answer({ memberships: [], channelMembers: ['crew-chat-skipper-1'] }, live.delay);

        const first = render(<ChatPage />);

        await screen.findByTestId('channel-list');
        expect(firstPaint().card).toBe(true);
        await act(async () => live.release());
        await waitFor(() => expect(list()).toHaveAttribute('data-card', 'false'));
        expect(list()).toHaveAttribute('data-channel', '');
        expect(remembered('crew-a')).toMatchObject({ memberOwnerIds: [], channel: null });

        // The next visit starts without it.
        first.unmount();
        paints.length = 0;
        holdTheNetwork();
        render(<ChatPage />);
        await screen.findByTestId('channel-list');
        expect(firstPaint().card).toBe(false);
    });

    it('hides when the group no longer lists this account', async () => {
        signIn('crew-a');
        remember('crew-a', { memberOwnerIds: ['skipper-1'], channel: groupOf('skipper-1') });
        const live = held();
        answer(
            {
                memberships: [{ owner_id: 'skipper-1', crew_user_id: 'crew-a', status: 'accepted' }],
                channelMembers: [],
            },
            live.delay,
        );

        render(<ChatPage />);

        await screen.findByTestId('channel-list');
        expect(firstPaint().card).toBe(true);
        await act(async () => live.release());
        await waitFor(() => expect(list()).toHaveAttribute('data-card', 'false'));
        expect(remembered('crew-a')).toMatchObject({ channel: null });
    });

    it('hides a passage-chat card when the skipper unticks chat for that passage', async () => {
        signIn('crew-a');
        setActivePassage('voyage-1');
        remember('crew-a', {
            memberOwnerIds: ['skipper-1'],
            passage: { voyageId: 'voyage-1', canViewChat: true },
        });
        answer({ memberships: [{ owner_id: 'skipper-1', crew_user_id: 'crew-a', status: 'accepted' }] });
        let unticked!: () => void;
        vi.mocked(getPassageStatus).mockReturnValue(
            new Promise((resolve) => {
                unticked = () => resolve(NO_PASSAGE_ACCESS);
            }),
        );

        render(<ChatPage />);

        await screen.findByTestId('channel-list');
        expect(firstPaint()).toMatchObject({ card: true, channel: '', vesselName: '' });
        await act(async () => unticked());
        await waitFor(() => expect(list()).toHaveAttribute('data-card', 'false'));
        expect(remembered('crew-a')).toMatchObject({ passage: { voyageId: 'voyage-1', canViewChat: false } });
    });

    it('an unticked passage stays hidden while it is re-checked, and is never remembered as ticked again', async () => {
        signIn('crew-a');
        setActivePassage('voyage-1');
        remember('crew-a', {
            memberOwnerIds: ['skipper-1'],
            passage: { voyageId: 'voyage-1', canViewChat: true },
        });
        answer({ memberships: [{ owner_id: 'skipper-1', crew_user_id: 'crew-a', status: 'accepted' }] });
        vi.mocked(getPassageStatus).mockResolvedValueOnce(NO_PASSAGE_ACCESS).mockReturnValue(never());

        render(<ChatPage />);
        await waitFor(() => expect(list()).toHaveAttribute('data-card', 'false'));
        expect(remembered('crew-a')).toMatchObject({ passage: { voyageId: 'voyage-1', canViewChat: false } });

        // Re-checks still out: the same passage, then another and back again.
        paints.length = 0;
        act(() => setActivePassage('voyage-1'));
        act(() => setActivePassage('voyage-2'));
        act(() => setActivePassage('voyage-1'));
        await act(async () => {
            for (let i = 0; i < 10; i += 1) await Promise.resolve();
        });
        expect(paints.some((paint) => paint.card)).toBe(false);
        expect(remembered('crew-a')).toMatchObject({ passage: { voyageId: 'voyage-1', canViewChat: false } });
    });

    it('a remembered group this account has just lost opens to a closed door, not a crash', async () => {
        signIn('crew-a');
        remember('crew-a', { memberOwnerIds: ['skipper-1'], channel: groupOf('skipper-1') });
        holdTheNetwork();
        // RLS refuses the read: the group is no longer this account's.
        vi.mocked(ChatService.getMessages).mockRejectedValueOnce(new Error('permission denied for chat_messages'));

        render(<ChatPage />);

        await screen.findByTestId('channel-list');
        fireEvent.click(screen.getByRole('button', { name: 'Open Crew Chat' }));
        await waitFor(() =>
            expect(toast.error).toHaveBeenCalledWith(
                "Messages couldn't be loaded. Check your connection and try again.",
            ),
        );
        expect(ChatService.getMessages).toHaveBeenCalledWith('crew-chat-skipper-1');
        expect(screen.getByText('Crew Talk')).toBeInTheDocument();
    });

    it('keeps the card when a live read fails (offline at sea): only an answer changes it', async () => {
        signIn('skipper-1');
        remember('skipper-1', { hasOwnedCrew: true });
        net.state.reply = () => Promise.resolve({ data: null, error: { message: 'Failed to fetch' } });

        render(<ChatPage />);

        await screen.findByTestId('channel-list');
        await act(async () => {
            for (let i = 0; i < 20; i += 1) await Promise.resolve();
        });
        expect(paints.every((paint) => paint.card)).toBe(true);
        expect(remembered('skipper-1')).toMatchObject({ hasOwnedCrew: true });
    });
});

// ── Skipper and crew meet in one room (build 125) ─────────────

describe("The crew card opens the skipper's OLDEST room, the one the skipper's card opens (Shane 2026-10-09)", () => {
    /** An old 'Crew Chat' and a newer passage-named copy that sorts first by name. */
    const oldest = { ...groupOf('skipper-1'), id: 'crew-chat-oldest', created_at: '2026-10-01T02:00:00.000Z' };
    const newer = {
        ...groupOf('skipper-1'),
        id: 'crew-chat-akaroa',
        name: 'Akaroa - Lyttelton (2nd Leg)',
        created_at: '2026-10-07T01:00:00.000Z',
    };

    it('two confirmed rooms of one skipper: the oldest wins, not the first by name', async () => {
        signIn('crew-a');
        // The chat service lists by name: the newer copy comes first.
        vi.mocked(ChatService.getChannels).mockResolvedValue([general, newer, oldest]);
        answer({
            memberships: [{ owner_id: 'skipper-1', crew_user_id: 'crew-a', status: 'accepted' }],
            channelMembers: ['crew-chat-akaroa', 'crew-chat-oldest'],
        });

        render(<ChatPage />);

        await waitFor(() => expect(list()).toHaveAttribute('data-channel', 'crew-chat-oldest'));
        expect(pickCrewChatRoom([newer, oldest], 'skipper-1')?.id).toBe('crew-chat-oldest');
        await waitFor(() => expect(remembered('crew-a')?.channel?.id).toBe('crew-chat-oldest'));
    });

    it('the remembered room still paints first, then the oldest confirmed room takes over', async () => {
        signIn('crew-a');
        remember('crew-a', { memberOwnerIds: ['skipper-1'], channel: newer });
        vi.mocked(ChatService.getChannels).mockResolvedValue([general, newer, oldest]);
        const live = held();
        answer(
            {
                memberships: [{ owner_id: 'skipper-1', crew_user_id: 'crew-a', status: 'accepted' }],
                channelMembers: ['crew-chat-akaroa', 'crew-chat-oldest'],
            },
            live.delay,
        );

        render(<ChatPage />);

        await screen.findByTestId('channel-list');
        expect(firstPaint()).toMatchObject({ card: true, channel: 'crew-chat-akaroa' });
        await act(async () => live.release());
        await waitFor(() => expect(list()).toHaveAttribute('data-channel', 'crew-chat-oldest'));
    });
});

// ── One account's card never reaches another ──────────────────

describe("One account's remembered card never shows to another", () => {
    it('a different account signed in on this phone never sees it', async () => {
        remember('skipper-1', { hasOwnedCrew: true });
        signIn('crew-b');
        holdTheNetwork();

        render(<ChatPage />);

        await screen.findByTestId('channel-list');
        expect(paints.some((paint) => paint.card)).toBe(false);
    });

    it('an account switch drops the card at once and leaves each account its own', async () => {
        remember('skipper-1', { hasOwnedCrew: true });
        signIn('skipper-1');
        holdTheNetwork();

        render(<ChatPage />);
        await waitFor(() => expect(list()).toHaveAttribute('data-card', 'true'));

        paints.length = 0;
        act(() => signIn('crew-b'));
        await waitFor(() => expect(paints.length).toBeGreaterThan(0));
        expect(paints.some((paint) => paint.card)).toBe(false);
        expect(remembered('skipper-1')).toMatchObject({ hasOwnedCrew: true });
        expect(remembered('crew-b')?.hasOwnedCrew ?? false).toBe(false);
    });

    it("a straight switch to another account never paints or remembers the last account's group", async () => {
        // Crew A is in skipper-1's group. Crew B is skipper-1's crew too, but
        // not in the group, and the phone goes from A to B with no sign-out.
        signIn('crew-a');
        remember('crew-b', { memberOwnerIds: ['skipper-1'] });
        vi.mocked(ChatService.getChannels).mockResolvedValue([general, groupOf('skipper-1')]);
        vi.mocked(ChatService.isChannelMember).mockImplementation(async (id) => id === 'crew-chat-skipper-1');
        answer({
            memberships: [{ owner_id: 'skipper-1', crew_user_id: 'crew-a', status: 'accepted' }],
            channelMembers: ['crew-chat-skipper-1'],
        });

        render(<ChatPage />);
        await waitFor(() => expect(list()).toHaveAttribute('data-channel', 'crew-chat-skipper-1'));
        await waitFor(() => expect(remembered('crew-a')?.channel?.id).toBe('crew-chat-skipper-1'));

        paints.length = 0;
        holdTheNetwork();
        act(() => signIn('crew-b'));
        await waitFor(() => expect(paints.length).toBeGreaterThan(0));
        await act(async () => {
            for (let i = 0; i < 10; i += 1) await Promise.resolve();
        });
        expect(paints.some((paint) => paint.channel === 'crew-chat-skipper-1')).toBe(false);
        expect(remembered('crew-b')).toMatchObject({ channel: null });
        expect(remembered('crew-a')?.channel?.id).toBe('crew-chat-skipper-1');
    });

    it('signed out, no remembered card shows', async () => {
        remember('skipper-1', { hasOwnedCrew: true });
        holdTheNetwork();

        render(<ChatPage />);

        await screen.findByTestId('channel-list');
        expect(paints.some((paint) => paint.card)).toBe(false);
    });
});
