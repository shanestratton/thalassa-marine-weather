/**
 * A crew member's Crew Chat card opens the skipper's Crew Chat they are
 * already in, with no passage selected (Shane 2026-10-02: Crew Chat is every
 * crew member's by default, no tick box).
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
