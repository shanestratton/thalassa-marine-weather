/**
 * A crew member's Crew Chat card opens the skipper's Crew Chat they are
 * already in, with no passage selected (Shane 2026-10-02: Crew Chat is every
 * crew member's by default, no tick box).
 *
 * The card names the vessel whose group it opens (Shane 2026-10-02: "it is
 * the correct group, but it is just saying the wrong vessel"). A crew member
 * who owns a boat of their own must see the skipper's boat, never their own.
 * Vessel names here are fictional.
 */
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ChannelList } from '../components/chat/ChannelList';
import type { ChatChannel } from '../services/ChatService';

vi.mock('../services/PassagePlanService', () => ({ getActivePassageId: vi.fn(() => null) }));

const crewChat = {
    id: 'crew-chat-1',
    name: 'Crew Chat',
    description: 'Private',
    icon: '👥',
    is_private: true,
    is_global: false,
    owner_id: 'skipper-1',
    status: 'active',
    created_at: '2026-10-01T00:00:00Z',
} as unknown as ChatChannel;

const props = (extra: Partial<React.ComponentProps<typeof ChannelList>> = {}) =>
    ({
        channels: [crewChat],
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
        memberChannelIds: new Set(['crew-chat-1']),
        proposalParentId: null,
        setProposalParentId: vi.fn(),
        ...extra,
    }) as React.ComponentProps<typeof ChannelList>;

afterEach(() => cleanup());

describe('Crew Chat card for crew (2026-10-02)', () => {
    it('opens the Crew Chat the crew member is already in, without a selected passage', async () => {
        const p = props({ hasCrewInvited: true, crewChatChannel: crewChat });
        render(<ChannelList {...p} />);
        fireEvent.click(screen.getByRole('button', { name: 'Crew Chat (Private Group)' }));
        await Promise.resolve();
        expect(p.onOpenChannel).toHaveBeenCalledWith(crewChat);
    });

    it('is hidden when there is no crew relationship', () => {
        render(<ChannelList {...props()} />);
        expect(screen.queryByRole('button', { name: 'Crew Chat (Private Group)' })).toBeNull();
    });
});

describe('Crew Chat card names the vessel whose group it opens (2026-10-02)', () => {
    const card = () => screen.getByRole('button', { name: 'Crew Chat (Private Group)' });

    it('crew who own a vessel see the connected vessel, not their own', () => {
        render(
            <ChannelList
                {...props({
                    hasCrewInvited: true,
                    crewChatChannel: crewChat,
                    vesselName: 'Kestrel',
                    crewChatVesselName: 'Albatross',
                })}
            />,
        );
        expect(card()).toHaveTextContent('Only visible to crew on the Albatross');
        expect(card()).not.toHaveTextContent('Kestrel');
    });

    it('a skipper sees their own vessel', () => {
        render(<ChannelList {...props({ hasCrewInvited: true, vesselName: 'Kestrel' })} />);
        expect(card()).toHaveTextContent('Only visible to crew on the Kestrel');
    });

    it("a skipper's card ignores a connected-vessel name meant for crew", () => {
        render(
            <ChannelList
                {...props({ hasCrewInvited: true, vesselName: 'Kestrel', crewChatVesselName: 'Albatross' })}
            />,
        );
        expect(card()).toHaveTextContent('Only visible to crew on the Kestrel');
        expect(card()).not.toHaveTextContent('Albatross');
    });

    // Build 125 (Shane 2026-10-09: "it say mackay - whitsundays at the top"):
    // a crew room is the skipper's one Crew Chat, never a passage, so a room
    // still stored under a passage name no longer names that passage. Without
    // the skipper's boat the card says "the vessel". This pinned "in Newport
    // to Airlie" until 125; changed on purpose.
    it("never names a passage the group was once called, nor the crew member's vessel", () => {
        const passageChat = { ...crewChat, name: 'Lyttelton - Akaroa (2nd Leg)' } as ChatChannel;
        render(
            <ChannelList
                {...props({
                    channels: [passageChat],
                    hasCrewInvited: true,
                    crewChatChannel: passageChat,
                    vesselName: 'Kestrel',
                })}
            />,
        );
        expect(card()).toHaveTextContent('Only visible to crew on the vessel');
        expect(card()).not.toHaveTextContent('Akaroa');
        expect(card()).not.toHaveTextContent('Kestrel');
    });

    it.each([
        ['the generic group name', 'Crew Chat'],
        ['a blank group name', '   '],
    ])('with %s and no vessel name it says "the vessel", never the crew member\'s own', (_label, name) => {
        const group = { ...crewChat, name } as ChatChannel;
        render(
            <ChannelList
                {...props({
                    channels: [group],
                    hasCrewInvited: true,
                    crewChatChannel: group,
                    vesselName: 'Kestrel',
                    crewChatVesselName: '  ',
                })}
            />,
        );
        expect(card()).toHaveTextContent('Only visible to crew on the vessel');
        expect(card()).not.toHaveTextContent('Kestrel');
    });
});
