/**
 * A skipper's Crew Chat card opens the skipper's one Crew Chat (build 125).
 *
 * Shane 2026-10-09: "ok i get sign in to use crew chat". He was signed in.
 * The card needed a passage selected, went through the chat service's
 * remembered user (null on a visit where its boot sign-in lagged), and showed
 * "Sign in to use Crew Chat" for every null; a throw did nothing at all.
 *
 * Now the card asks openOwnCrewChat (services/crew/crewChatRoom) and says
 * what actually happened. Boats and people are fictional.
 */
import React from 'react';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const room = vi.hoisted(() => ({
    open: vi.fn(),
}));
const chat = vi.hoisted(() => ({
    initialize: vi.fn(),
    // Not signed in to chat: the old path would have shown "Sign in".
    createVoyageChannel: vi.fn(async () => null),
}));
const toasts = vi.hoisted(() => ({ error: vi.fn(), success: vi.fn() }));
const logs = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock('../services/supabase', () => ({ supabase: null }));
vi.mock('../services/crew/crewChatRoom', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/crew/crewChatRoom')>()),
    openOwnCrewChat: room.open,
}));
vi.mock('../services/ChatService', () => ({ ChatService: chat }));
// No passage is selected on this phone.
vi.mock('../services/PassagePlanService', () => ({ getActivePassageId: vi.fn(() => null) }));
vi.mock('../services/VoyageService', () => ({ getDraftVoyages: vi.fn(async () => []) }));
vi.mock('../components/Toast', () => ({ toast: toasts }));
vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: logs.warn, error: vi.fn() }),
}));

import { ChannelList } from '../components/chat/ChannelList';
import type { ChatChannel } from '../services/ChatService';

const crewChat = {
    id: 'room-crew-chat',
    name: 'Crew Chat',
    description: '',
    region: null,
    icon: '👥',
    is_global: false,
    is_private: true,
    owner_id: 'skipper-1',
    parent_id: null,
    created_at: '2026-10-01T02:00:00.000Z',
} as ChatChannel;

const props = (extra: Partial<React.ComponentProps<typeof ChannelList>> = {}) =>
    ({
        channels: [],
        onOpenChannel: vi.fn(),
        onRequestAccess: vi.fn(),
        isMod: false,
        showProposalForm: false,
        setShowProposalForm: vi.fn(),
        proposalIcon: '',
        setProposalIcon: vi.fn(),
        proposalName: '',
        setProposalName: vi.fn(),
        proposalDesc: '',
        setProposalDesc: vi.fn(),
        proposalIsPrivate: false,
        setProposalIsPrivate: vi.fn(),
        proposalSent: false,
        onProposeChannel: vi.fn(),
        memberChannelIds: new Set<string>(),
        proposalParentId: null,
        setProposalParentId: vi.fn(),
        hasCrewInvited: true,
        vesselName: 'Kestrel',
        ...extra,
    }) as React.ComponentProps<typeof ChannelList>;

const card = () => screen.getByRole('button', { name: 'Crew Chat (Private Group)' });
/** Let the card's dynamic imports and awaits settle. */
const settle = async () => {
    await act(async () => {
        for (let i = 0; i < 20; i += 1) await Promise.resolve();
        await new Promise((resolve) => setTimeout(resolve, 0));
    });
};

// Load the card's lazy modules once, so a tap settles in a few ticks.
beforeAll(async () => {
    await import('../services/crew/crewChatRoom');
    await import('../services/ChatService');
});

beforeEach(() => {
    vi.clearAllMocks();
    room.open.mockResolvedValue({ ok: true, channel: crewChat });
    chat.initialize.mockResolvedValue(undefined);
});

afterEach(() => cleanup());

describe("A skipper's Crew Chat card (Shane 2026-10-09)", () => {
    it('opens the oldest room with no passage selected, and no "Select a passage" toast', async () => {
        const p = props();
        render(<ChannelList {...p} />);

        fireEvent.click(card());
        await settle();

        expect(room.open).toHaveBeenCalledTimes(1);
        expect(p.onOpenChannel).toHaveBeenCalledExactlyOnceWith(crewChat);
        expect(toasts.error).not.toHaveBeenCalled();
    });

    it('opens even when the chat service is not signed in: the false "Sign in" is gone', async () => {
        const p = props();
        render(<ChannelList {...p} />);

        fireEvent.click(card());
        await settle();

        expect(p.onOpenChannel).toHaveBeenCalledExactlyOnceWith(crewChat);
        expect(chat.createVoyageChannel).not.toHaveBeenCalled();
        expect(toasts.error).not.toHaveBeenCalledWith('Sign in to use Crew Chat');
    });

    it.each([
        [{ reason: 'signed_out' }, 'Sign in to use Crew Chat'],
        [{ reason: 'session_expired' }, 'Your sign-in has expired. Sign in again to open Crew Chat.'],
        [{ reason: 'offline' }, "Couldn't reach Crew Chat. Check your connection and try again."],
        [{ reason: 'timeout' }, "Couldn't reach Crew Chat. Check your connection and try again."],
        [{ reason: 'denied', step: 'find' }, "Crew Chat couldn't be set up for this account. Try again shortly."],
        [
            { reason: 'denied', step: 'create' },
            "Crew Chat can't be set up from this phone yet; it will work after the next update.",
        ],
        [{ reason: 'not_ready' }, "Your skipper hasn't opened Crew Chat yet. It shows here once they do."],
        [{ reason: 'failed', step: 'find' }, "Crew Chat didn't open. Try again."],
    ] as const)('%o shows its own toast', async (failure, message) => {
        room.open.mockResolvedValue({ ok: false, ...failure });
        const p = props();
        render(<ChannelList {...p} />);

        fireEvent.click(card());
        await settle();

        expect(toasts.error).toHaveBeenCalledExactlyOnceWith(message);
        expect(p.onOpenChannel).not.toHaveBeenCalled();
        if (failure.reason !== 'signed_out') {
            expect(toasts.error).not.toHaveBeenCalledWith('Sign in to use Crew Chat');
        }
    });

    it('an account switch mid-tap ("stale") shows nothing and opens nothing', async () => {
        room.open.mockResolvedValue({ ok: false, reason: 'stale' });
        const p = props();
        render(<ChannelList {...p} />);

        fireEvent.click(card());
        await settle();

        expect(toasts.error).not.toHaveBeenCalled();
        expect(p.onOpenChannel).not.toHaveBeenCalled();
    });

    it('five rapid taps make one call, the card is busy meanwhile, and the room opens once', async () => {
        let finish!: (result: unknown) => void;
        room.open.mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const p = props();
        render(<ChannelList {...p} />);

        fireEvent.click(card());
        await settle();
        expect(card()).toHaveAttribute('aria-busy', 'true');
        for (let tap = 0; tap < 4; tap += 1) fireEvent.click(card());
        await settle();

        expect(room.open).toHaveBeenCalledTimes(1);
        await act(async () => finish({ ok: true, channel: crewChat }));
        await settle();

        expect(p.onOpenChannel).toHaveBeenCalledExactlyOnceWith(crewChat);
        expect(card()).not.toHaveAttribute('aria-busy', 'true');
    });

    it('a slow open shows on the card itself: dimmed, "Opening Crew Chat…", a turning arrow', async () => {
        // A marina or satellite link can take seconds; the card must not look
        // the same as before the tap (review, build 125).
        let finish!: (result: unknown) => void;
        room.open.mockReturnValue(
            new Promise((resolve) => {
                finish = resolve;
            }),
        );
        const p = props();
        render(<ChannelList {...p} />);
        expect(screen.getByText('Only visible to crew on the Kestrel')).toBeInTheDocument();
        expect(screen.queryByTestId('crew-chat-opening')).toBeNull();

        fireEvent.click(card());
        await settle();

        expect(within(card()).getByText('Opening Crew Chat…')).toBeInTheDocument();
        expect(within(card()).getByTestId('crew-chat-opening')).toBeInTheDocument();
        expect(within(card()).queryByText('›')).toBeNull();
        expect(card()).toHaveClass('opacity-70');
        // The card keeps its name for a screen reader; aria-busy says it is working.
        expect(card()).toHaveAccessibleName('Crew Chat (Private Group)');

        await act(async () => finish({ ok: false, reason: 'offline' }));
        await settle();

        expect(screen.getByText('Only visible to crew on the Kestrel')).toBeInTheDocument();
        expect(screen.queryByTestId('crew-chat-opening')).toBeNull();
        expect(within(card()).getByText('›')).toBeInTheDocument();
        expect(card()).not.toHaveClass('opacity-70');
    });

    it('a throw is never silent: it says so and logs a reason', async () => {
        room.open.mockRejectedValue(new Error('chunk failed to load'));
        const p = props();
        render(<ChannelList {...p} />);

        fireEvent.click(card());
        await settle();

        expect(toasts.error).toHaveBeenCalledExactlyOnceWith("Crew Chat didn't open. Try again.");
        expect(logs.warn).toHaveBeenCalledWith('crew-chat: failed-tap');
        expect(p.onOpenChannel).not.toHaveBeenCalled();
        // The card can be tapped again.
        expect(card()).not.toHaveAttribute('aria-busy', 'true');
    });

    it('kicks the chat service sign-in on the tap, and never waits for it', async () => {
        chat.initialize.mockReturnValue(new Promise(() => {}));
        const p = props();
        render(<ChannelList {...p} />);

        fireEvent.click(card());
        await settle();

        expect(chat.initialize).toHaveBeenCalled();
        expect(p.onOpenChannel).toHaveBeenCalledExactlyOnceWith(crewChat);
    });

    it('a chat service sign-in that fails does not stop the room opening', async () => {
        chat.initialize.mockRejectedValue(new Error('no user yet'));
        const p = props();
        render(<ChannelList {...p} />);

        fireEvent.click(card());
        await settle();

        expect(p.onOpenChannel).toHaveBeenCalledExactlyOnceWith(crewChat);
        expect(toasts.error).not.toHaveBeenCalled();
    });
});

describe('The crew view is unchanged', () => {
    it("a crew member's card opens the skipper's room it was handed, and never calls openOwnCrewChat", async () => {
        const skippersRoom = { ...crewChat, id: 'room-skipper', owner_id: 'skipper-1' } as ChatChannel;
        const p = props({ crewChatChannel: skippersRoom, vesselName: 'Albatross', crewChatVesselName: 'Kestrel' });
        render(<ChannelList {...p} />);

        fireEvent.click(card());
        await settle();

        expect(p.onOpenChannel).toHaveBeenCalledExactlyOnceWith(skippersRoom);
        expect(room.open).not.toHaveBeenCalled();
        expect(chat.initialize).not.toHaveBeenCalled();
    });
});
