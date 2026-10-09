/**
 * ChatHeader — Scuttlebutt's header (UX scorecard run 6).
 *
 * Pins the state-honesty fix: the green presence dot on the profile row is
 * drawn only for a signed-in skipper, never above the "Sign in to chat" card.
 * Run 7: the three header icons became one ⋮ Page actions menu.
 * Build 125: a crew room reads "Crew Chat" with the boat under it, whatever
 * passage it was once named for (Shane 2026-10-09: "it say mackay -
 * whitsundays at the top"). Boats and passages are fictional.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({ user: null as { id: string } | null }));
/** The signed-in account's OWN boat (settings.vessel.name). */
const ownBoat = vi.hoisted(() => ({ name: undefined as string | undefined }));
const vesselNames = vi.hoisted(() => ({ fetch: vi.fn(async (_ownerId: string) => null as string | null) }));

vi.mock('../stores/authStore', () => {
    const useAuthStore = Object.assign((selector: (state: typeof authState) => unknown) => selector(authState), {
        getState: () => authState,
    });
    return { useAuthStore };
});
vi.mock('../stores/settingsStore', () => {
    const state = () => ({ settings: { vessel: ownBoat.name ? { name: ownBoat.name } : undefined } });
    const useSettingsStore = Object.assign((selector: (s: ReturnType<typeof state>) => unknown) => selector(state()), {
        getState: state,
    });
    return { useSettingsStore };
});
vi.mock('../services/VesselIdentityService', () => ({ fetchVesselNameForOwner: vesselNames.fetch }));

import { ChatHeader, type ChatHeaderProps } from '../components/chat/ChatHeader';
import type { ChatChannel } from '../services/ChatService';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const baseProps: ChatHeaderProps = {
    view: 'channels',
    activeChannel: null,
    myAvatarUrl: null,
    unreadDMs: 0,
    messageCount: 0,
    isUserBlocked: false,
    hasDMPartner: false,
    onGoBack: vi.fn(),
    onExit: vi.fn(),
    onOpenProfile: vi.fn(),
    onOpenDMInbox: vi.fn(),
    onToggleBlock: vi.fn(),
    onPropose: vi.fn(),
};

describe('ChatHeader', () => {
    beforeEach(() => {
        authState.user = null;
    });

    it('titles the root page Scuttlebutt, with one Page actions menu', () => {
        render(<ChatHeader {...baseProps} />);
        expect(screen.getByRole('heading', { level: 1, name: 'Scuttlebutt' })).toBeInTheDocument();
        // One header action, as on the Binder pages (UX scorecard run 7).
        const trigger = screen.getByRole('button', { name: 'Page actions' });
        expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByRole('button', { name: 'Open direct messages' })).not.toBeInTheDocument();

        fireEvent.click(trigger);
        expect(trigger).toHaveAttribute('aria-expanded', 'true');
        const menu = screen.getByRole('menu');
        expect(menu).toContainElement(screen.getByRole('menuitem', { name: 'Direct messages' }));
        expect(menu).toContainElement(screen.getByRole('menuitem', { name: 'Your profile' }));
        expect(menu).toContainElement(screen.getByRole('menuitem', { name: 'Propose a channel' }));
        expect(screen.getByRole('menuitem', { name: 'Direct messages' })).toHaveFocus();
    });

    it('runs the chosen action and closes the menu', () => {
        const onOpenDMInbox = vi.fn();
        const onPropose = vi.fn();
        render(<ChatHeader {...baseProps} onOpenDMInbox={onOpenDMInbox} onPropose={onPropose} />);
        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Direct messages' }));
        expect(onOpenDMInbox).toHaveBeenCalledOnce();
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
        fireEvent.click(screen.getByRole('menuitem', { name: 'Propose a channel' }));
        expect(onPropose).toHaveBeenCalledOnce();
    });

    it('closes on Escape and returns focus to the trigger', () => {
        render(<ChatHeader {...baseProps} />);
        const trigger = screen.getByRole('button', { name: 'Page actions' });
        fireEvent.click(trigger);
        fireEvent.keyDown(document, { key: 'Escape' });
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });

    it('draws no presence dot while signed out', () => {
        render(<ChatHeader {...baseProps} />);
        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
        const profile = screen.getByRole('menuitem', { name: 'Your profile' });
        expect(profile.querySelector('.bg-emerald-500')).toBeNull();
    });

    it('draws the presence dot once signed in', () => {
        authState.user = { id: 'sailor' };
        render(<ChatHeader {...baseProps} />);
        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
        const profile = screen.getByRole('menuitem', { name: 'Your profile' });
        expect(profile.querySelector('.bg-emerald-500')).not.toBeNull();
    });

    it('announces unread direct messages on the trigger and the menu row', () => {
        render(<ChatHeader {...baseProps} unreadDMs={3} />);
        const trigger = screen.getByRole('button', { name: 'Page actions, 3 unread direct messages' });
        expect(trigger).toHaveTextContent('3');
        fireEvent.click(trigger);
        expect(screen.getByRole('menuitem', { name: 'Direct messages, 3 unread' })).toBeInTheDocument();
    });
});

// ── Crew rooms: "Crew Chat", with the boat underneath (build 125) ──

const channel = (extra: Partial<ChatChannel>): ChatChannel => ({
    id: 'room-1',
    name: 'General',
    description: '',
    region: null,
    icon: '💬',
    is_global: true,
    is_private: false,
    owner_id: null,
    parent_id: null,
    created_at: '2026-10-01T00:00:00.000Z',
    ...extra,
});
/** A skipper's crew room, stored under an old passage name. */
const passageNamedRoom = channel({
    id: 'room-akaroa',
    name: 'Lyttelton - Akaroa (2nd Leg)',
    icon: '👥',
    is_global: false,
    is_private: true,
    owner_id: 'skipper-1',
});
const inRoom = (activeChannel: ChatChannel): ChatHeaderProps => ({ ...baseProps, view: 'messages', activeChannel });

/** What this phone last verified for a crew account (services/crew/crewChatGate). */
function rememberSkipperBoat(viewerId: string, ownerId: string, boat: string) {
    localStorage.setItem(
        `thalassa_crew_chat_gate_v1::${encodeURIComponent(`user:${viewerId}`)}`,
        JSON.stringify({
            version: 1,
            userId: viewerId,
            hasOwnedCrew: false,
            memberOwnerIds: [ownerId],
            channel: null,
            passage: null,
            vesselNames: { [ownerId]: boat },
        }),
    );
}

describe('ChatHeader in a crew room (Shane 2026-10-09)', () => {
    beforeEach(() => {
        authState.user = null;
        ownBoat.name = undefined;
        localStorage.clear();
        vesselNames.fetch.mockReset();
        vesselNames.fetch.mockResolvedValue(null);
    });
    afterEach(() => {
        cleanup();
        setAuthIdentityScope(null);
    });

    it('titles a passage-named crew room "Crew Chat", and the skipper sees their own boat under it', () => {
        setAuthIdentityScope('skipper-1');
        ownBoat.name = 'Kestrel';

        render(<ChatHeader {...inRoom(passageNamedRoom)} />);

        expect(screen.getByRole('heading', { level: 1, name: 'Crew Chat' })).toBeInTheDocument();
        expect(screen.getByText('Only visible to crew on the Kestrel')).toBeInTheDocument();
        expect(screen.queryByText(/Akaroa/)).not.toBeInTheDocument();
        expect(vesselNames.fetch).not.toHaveBeenCalled();
    });

    it("crew see the skipper's boat from what this phone remembers, never their own", () => {
        setAuthIdentityScope('crew-1');
        ownBoat.name = 'Albatross';
        rememberSkipperBoat('crew-1', 'skipper-1', 'Kestrel');

        render(<ChatHeader {...inRoom(passageNamedRoom)} />);

        expect(screen.getByRole('heading', { level: 1, name: 'Crew Chat' })).toBeInTheDocument();
        expect(screen.getByText('Only visible to crew on the Kestrel')).toBeInTheDocument();
        expect(screen.queryByText(/Albatross/)).not.toBeInTheDocument();
    });

    it("crew see the skipper's boat read live when nothing is remembered, never their own", async () => {
        setAuthIdentityScope('crew-1');
        ownBoat.name = 'Albatross';
        vesselNames.fetch.mockImplementation(async (ownerId: string) => (ownerId === 'skipper-1' ? 'Kestrel' : null));

        render(<ChatHeader {...inRoom(passageNamedRoom)} />);

        expect(await screen.findByText('Only visible to crew on the Kestrel')).toBeInTheDocument();
        expect(vesselNames.fetch).toHaveBeenCalledWith('skipper-1');
        expect(screen.queryByText(/Albatross/)).not.toBeInTheDocument();
    });

    it('with no boat name known, the subtitle reads "Private group"', async () => {
        setAuthIdentityScope('crew-1');
        ownBoat.name = 'Albatross';

        render(<ChatHeader {...inRoom(passageNamedRoom)} />);

        expect(screen.getByText('Private group')).toBeInTheDocument();
        await vi.waitFor(() => expect(vesselNames.fetch).toHaveBeenCalled());
        expect(screen.getByText('Private group')).toBeInTheDocument();
        expect(screen.queryByText(/Albatross/)).not.toBeInTheDocument();
    });

    it('a skipper with no boat name set also reads "Private group"', () => {
        setAuthIdentityScope('skipper-1');

        render(<ChatHeader {...inRoom(passageNamedRoom)} />);

        expect(screen.getByRole('heading', { level: 1, name: 'Crew Chat' })).toBeInTheDocument();
        expect(screen.getByText('Private group')).toBeInTheDocument();
    });

    it.each([['Cádiz, Spain → Funchal'], ["St. John's (NL) → Horta"], ['Bora Bora (Vaitape)'], ['父島 → 母島']])(
        'a crew room stored as %s reads "Crew Chat"',
        (name) => {
            setAuthIdentityScope('skipper-1');
            ownBoat.name = 'Kestrel';

            render(<ChatHeader {...inRoom({ ...passageNamedRoom, name })} />);

            expect(screen.getByRole('heading', { level: 1, name: 'Crew Chat' })).toBeInTheDocument();
            expect(screen.queryByText(name)).not.toBeInTheDocument();
        },
    );

    it('a public channel keeps its name and its description', () => {
        setAuthIdentityScope('skipper-1');
        ownBoat.name = 'Kestrel';

        render(<ChatHeader {...inRoom(channel({ name: 'General', description: 'Talk among sailors' }))} />);

        expect(screen.getByRole('heading', { level: 1, name: 'General' })).toBeInTheDocument();
        expect(screen.getByText('Talk among sailors')).toBeInTheDocument();
        expect(screen.queryByText(/Only visible to crew/)).not.toBeInTheDocument();
    });

    it("'Find Crew' still reads 'The Crew List'", () => {
        render(<ChatHeader {...inRoom(channel({ name: 'Find Crew', description: 'Berths offered' }))} />);

        expect(screen.getByRole('heading', { level: 1, name: 'The Crew List' })).toBeInTheDocument();
    });

    it('a private channel that is not a crew room keeps its own name and description', () => {
        setAuthIdentityScope('skipper-1');
        ownBoat.name = 'Kestrel';
        const galley = channel({
            name: 'Galley Club',
            description: 'Cooks only',
            icon: '🍳',
            is_global: false,
            is_private: true,
            owner_id: 'skipper-1',
        });

        render(<ChatHeader {...inRoom(galley)} />);

        expect(screen.getByRole('heading', { level: 1, name: 'Galley Club' })).toBeInTheDocument();
        expect(screen.getByText('Cooks only')).toBeInTheDocument();
        expect(screen.queryByText(/Only visible to crew/)).not.toBeInTheDocument();
    });
});
