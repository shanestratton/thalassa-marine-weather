/**
 * ChatHeader — Scuttlebutt's header (UX scorecard run 6).
 *
 * Pins the state-honesty fix: the green presence dot on the profile row is
 * drawn only for a signed-in skipper, never above the "Sign in to chat" card.
 * Run 7: the three header icons became one ⋮ Page actions menu.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
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
