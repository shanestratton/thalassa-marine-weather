import React from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
    setPage: vi.fn(),
}));

vi.mock('../context/UIContext', () => ({
    useUI: () => ({ setPage: mocks.setPage }),
}));

import { ChatMessageList } from '../components/chat/ChatMessageList';
import type { ChatMessage } from '../services/ChatService';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { LocationStore } from '../stores/LocationStore';

const pinMessage: ChatMessage = {
    id: 'pin-message',
    channel_id: 'general',
    user_id: 'crew-a',
    display_name: 'Crew A',
    message: '📍PIN:-27.4705,153.0260|[POI] Account A anchorage',
    is_question: false,
    helpful_count: 0,
    is_pinned: false,
    deleted_at: null,
    created_at: '2026-07-23T00:00:00.000Z',
};

function renderList() {
    return render(
        <ChatMessageList
            messages={[pinMessage]}
            pinnedMessages={[]}
            isMod={false}
            isAdmin={false}
            isModerator={false}
            likedMessages={new Set()}
            showModMenu={null}
            showRankTooltip={null}
            importingTrackId={null}
            getAvatar={() => null}
            onOpenDMThread={vi.fn()}
            onMarkHelpful={vi.fn()}
            onReportMsg={vi.fn()}
            onToggleModMenu={vi.fn()}
            onDeleteMessage={vi.fn()}
            onPinMessage={vi.fn()}
            onMuteUser={vi.fn()}
            onBlockUser={vi.fn()}
            onMakeAdmin={vi.fn()}
            onSetRankTooltip={vi.fn()}
            onShowTrackDisclaimer={vi.fn()}
            messageEndRef={React.createRef<HTMLDivElement>()}
        />,
    );
}

describe('ChatMessageList pin navigation identity fence', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.useFakeTimers();
        localStorage.clear();
        sessionStorage.clear();
        delete window.__thalassaPinView;
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        vi.spyOn(LocationStore, 'setFromMapPin').mockResolvedValue(undefined);
    });

    afterEach(() => {
        setAuthIdentityScope(null);
        delete window.__thalassaPinView;
        vi.clearAllTimers();
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('tags the global handoff and recenter event with the exact generation', () => {
        const accountA = getAuthIdentityScope();
        const dispatch = vi.spyOn(window, 'dispatchEvent');
        localStorage.setItem(authScopedStorageKey('chat_last_channel', accountA), 'harbour-chat');
        renderList();

        fireEvent.click(screen.getByRole('button', { name: 'Pin message to channel' }));

        expect(window.__thalassaPinView).toEqual({
            lat: -27.4705,
            lng: 153.026,
            identity: accountA,
        });
        expect(sessionStorage.getItem(authScopedStorageKey('chat_return_to_channel', accountA))).toBe('harbour-chat');

        act(() => vi.advanceTimersByTime(500));

        const recenter = dispatch.mock.calls
            .map(([event]) => event)
            .find((event) => event.type === 'map-recenter') as CustomEvent;
        expect(recenter.detail).toEqual({
            lat: -27.4705,
            lon: 153.026,
            zoom: 7,
            identity: accountA,
        });
    });

    it('synchronously clears A global state and physically cancels its timer for B', () => {
        const dispatch = vi.spyOn(window, 'dispatchEvent');
        renderList();
        const baselineTimers = vi.getTimerCount();
        fireEvent.click(screen.getByRole('button', { name: 'Pin message to channel' }));
        expect(vi.getTimerCount()).toBe(baselineTimers + 1);

        act(() => {
            setAuthIdentityScope('account-b');
        });

        expect(window.__thalassaPinView).toBeUndefined();
        expect(vi.getTimerCount()).toBe(baselineTimers);
        act(() => vi.advanceTimersByTime(500));
        expect(dispatch.mock.calls.some(([event]) => event.type === 'map-recenter')).toBe(false);
    });

    it('does not arm an A timer if navigation itself synchronously exposes B', () => {
        const dispatch = vi.spyOn(window, 'dispatchEvent');
        mocks.setPage.mockImplementationOnce(() => {
            setAuthIdentityScope('account-b');
        });
        renderList();
        const baselineTimers = vi.getTimerCount();

        fireEvent.click(screen.getByRole('button', { name: 'Pin message to channel' }));

        expect(window.__thalassaPinView).toBeUndefined();
        expect(vi.getTimerCount()).toBe(baselineTimers);
        act(() => vi.advanceTimersByTime(500));
        expect(dispatch.mock.calls.some(([event]) => event.type === 'map-recenter')).toBe(false);
    });

    it('cancels the source recenter timer on unmount while preserving the tagged map handoff', () => {
        const dispatch = vi.spyOn(window, 'dispatchEvent');
        const accountA = getAuthIdentityScope();
        const view = renderList();
        const baselineTimers = vi.getTimerCount();
        fireEvent.click(screen.getByRole('button', { name: 'Pin message to channel' }));

        view.unmount();

        expect(vi.getTimerCount()).toBeLessThanOrEqual(baselineTimers);
        expect(window.__thalassaPinView?.identity).toBe(accountA);
        act(() => vi.advanceTimersByTime(500));
        expect(dispatch.mock.calls.some(([event]) => event.type === 'map-recenter')).toBe(false);

        act(() => setAuthIdentityScope('account-b'));
        expect(window.__thalassaPinView).toBeUndefined();
    });
});
