/**
 * ChatHeader — Scuttlebutt's header (UX scorecard run 6).
 *
 * Pins the state-honesty fix: the green presence dot on the profile button is
 * drawn only for a signed-in skipper, never above the "Sign in to chat" card.
 */
import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({ user: null as { id: string } | null }));

vi.mock('../stores/authStore', () => {
    const useAuthStore = Object.assign((selector: (state: typeof authState) => unknown) => selector(authState), {
        getState: () => authState,
    });
    return { useAuthStore };
});

import { ChatHeader, type ChatHeaderProps } from '../components/chat/ChatHeader';

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

    it('titles the root page Scuttlebutt as the page heading, with its three actions', () => {
        render(<ChatHeader {...baseProps} />);
        expect(screen.getByRole('heading', { level: 1, name: 'Scuttlebutt' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Propose a new channel' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Open your profile' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Open direct messages' })).toBeInTheDocument();
    });

    it('draws no presence dot while signed out', () => {
        render(<ChatHeader {...baseProps} />);
        const profile = screen.getByRole('button', { name: 'Open your profile' });
        expect(profile.querySelector('.bg-emerald-500')).toBeNull();
    });

    it('draws the presence dot once signed in', () => {
        authState.user = { id: 'sailor' };
        render(<ChatHeader {...baseProps} />);
        const profile = screen.getByRole('button', { name: 'Open your profile' });
        expect(profile.querySelector('.bg-emerald-500')).not.toBeNull();
    });

    it('announces unread direct messages in the button name', () => {
        render(<ChatHeader {...baseProps} unreadDMs={3} />);
        expect(screen.getByRole('button', { name: 'Open direct messages, 3 unread' })).toBeInTheDocument();
    });
});
