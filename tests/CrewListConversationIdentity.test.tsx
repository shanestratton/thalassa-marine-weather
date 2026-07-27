import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { CrewIntroConversation, CrewIntroMessage } from '../services/LonelyHeartsService';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const crewService = vi.hoisted(() => ({
    getCrewIntroConversation: vi.fn(),
    getCrewIntroMessages: vi.fn(),
    sendCrewIntroMessage: vi.fn(),
}));

const toastMocks = vi.hoisted(() => ({
    error: vi.fn(),
}));

vi.mock('../services/LonelyHeartsService', () => ({
    LonelyHeartsService: crewService,
}));

vi.mock('../components/Toast', () => ({
    toast: toastMocks,
}));

import { useCrewListConversation } from '../hooks/useCrewListConversation';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const conversation: CrewIntroConversation = {
    id: 'conversation-a',
    intro_request_id: 'intro-a',
    participant_one_id: 'account-a',
    participant_two_id: 'casey-a',
    created_at: '2026-07-27T00:00:00.000Z',
};

const sentMessage: CrewIntroMessage = {
    id: 'message-a',
    conversation_id: 'conversation-a',
    sender_id: 'account-a',
    message: 'A private message',
    created_at: '2026-07-27T00:01:00.000Z',
};

describe('Crew List conversation identity fencing', () => {
    beforeEach(() => {
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        vi.clearAllMocks();
        crewService.getCrewIntroConversation.mockResolvedValue(null);
        crewService.getCrewIntroMessages.mockResolvedValue([]);
        crewService.sendCrewIntroMessage.mockResolvedValue(null);
    });

    it('does not fetch or render A private messages after the authenticated identity changes', async () => {
        const conversationA = deferred<CrewIntroConversation | null>();
        crewService.getCrewIntroConversation.mockReturnValueOnce(conversationA.promise);

        const rendered = renderHook(() => useCrewListConversation('intro-a'));
        await waitFor(() => expect(crewService.getCrewIntroConversation).toHaveBeenCalledWith('intro-a'));

        act(() => setAuthIdentityScope('account-b'));
        conversationA.resolve(conversation);
        await act(async () => conversationA.promise);

        await waitFor(() => expect(rendered.result.current.loading).toBe(false));
        expect(rendered.result.current.messages).toEqual([]);
        expect(rendered.result.current.draft).toBe('');
        expect(crewService.getCrewIntroMessages).not.toHaveBeenCalled();
    });

    it('drops an in-flight A send before it can surface a message or busy state for B', async () => {
        const sentA = deferred<CrewIntroMessage | null>();
        crewService.getCrewIntroConversation.mockResolvedValue(conversation);
        crewService.getCrewIntroMessages.mockResolvedValue([]);
        crewService.sendCrewIntroMessage.mockReturnValueOnce(sentA.promise);

        const rendered = renderHook(() => useCrewListConversation('intro-a'));
        await waitFor(() => expect(crewService.getCrewIntroMessages).toHaveBeenCalledWith('intro-a', 200));
        await waitFor(() => expect(rendered.result.current.loading).toBe(false));

        act(() => rendered.result.current.setDraft('A private message'));
        let pending!: Promise<void>;
        act(() => {
            pending = rendered.result.current.send();
        });
        await waitFor(() =>
            expect(crewService.sendCrewIntroMessage).toHaveBeenCalledWith('intro-a', 'A private message'),
        );

        act(() => setAuthIdentityScope('account-b'));
        sentA.resolve(sentMessage);
        await act(async () => pending);

        await waitFor(() => expect(rendered.result.current.loading).toBe(false));
        expect(rendered.result.current.messages).toEqual([]);
        expect(rendered.result.current.draft).toBe('');
        expect(rendered.result.current.sending).toBe(false);
        expect(toastMocks.error).not.toHaveBeenCalled();
    });
});
