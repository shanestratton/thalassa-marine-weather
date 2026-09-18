import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatDMCompose, ChatDMInbox, ChatDMThread, type ChatDMComposeProps } from '../components/chat/ChatDMView';
import { reconcileOptimisticMessage } from '../components/chat/chatUtils';

describe('self-test private message UI', () => {
    it('offers a real button with no other sailors or previous messages, and only one self entry after a send', () => {
        const onOpenThread = vi.fn();
        const view = render(<ChatDMInbox conversations={[]} currentUserId="account-a" onOpenThread={onOpenThread} />);
        fireEvent.click(screen.getByRole('button', { name: 'Open self-test conversation' }));
        expect(onOpenThread).toHaveBeenCalledExactlyOnceWith('account-a', 'Self test');
        view.rerender(
            <ChatDMInbox
                currentUserId="account-a"
                onOpenThread={onOpenThread}
                conversations={[
                    {
                        user_id: 'account-a',
                        display_name: 'Me',
                        last_message: 'A real test',
                        last_at: new Date().toISOString(),
                        unread_count: 0,
                    },
                ]}
            />,
        );
        expect(screen.getAllByRole('button')).toHaveLength(1);
        view.rerender(<ChatDMInbox conversations={[]} currentUserId={null} onOpenThread={onOpenThread} />);
        expect(screen.queryByRole('button', { name: 'Open self-test conversation' })).not.toBeInTheDocument();
    });

    it('labels saved self messages honestly and keeps them on the sender side', () => {
        render(
            <ChatDMThread
                currentUserId="account-a"
                isSelfConversation
                partnerName="Self test"
                thread={[
                    {
                        id: 'saved',
                        sender_id: 'account-a',
                        recipient_id: 'account-a',
                        sender_name: 'Me',
                        message: 'A real saved test',
                        read: true,
                        created_at: new Date().toISOString(),
                    },
                ]}
            />,
        );
        expect(screen.getByText(/messages are saved to your own account/)).toBeVisible();
        expect(screen.getByText('A real saved test').closest('.msg-enter')).toHaveClass('justify-end');
    });

    it('explains self-only blocking and keeps confirmed Unblock reachable', () => {
        const props: ChatDMComposeProps = {
            dmText: 'Test draft',
            setDmText: vi.fn(),
            partnerName: 'Self test',
            isSelfConversation: true,
            keyboardOffset: 0,
            isUserBlocked: true,
            blockedByMe: true,
            blockStatusLoading: false,
            blockStatusError: null,
            blockMutationPending: false,
            onRetryBlockStatus: vi.fn(),
            showBlockConfirm: false,
            setShowBlockConfirm: vi.fn(),
            onSendDM: vi.fn(),
            onBlock: vi.fn(),
            onUnblock: vi.fn(),
        };
        const view = render(<ChatDMCompose {...props} />);
        expect(screen.getByRole('status')).toHaveTextContent('Your self-test conversation is blocked.');
        fireEvent.click(screen.getByRole('button', { name: 'Unblock self-test conversation' }));
        expect(props.setShowBlockConfirm).toHaveBeenCalledWith(true);
        view.rerender(<ChatDMCompose {...props} showBlockConfirm />);
        expect(screen.getByText(/Messages to yourself will be available again/)).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Confirm unblock self-test conversation' }));
        expect(props.onUnblock).toHaveBeenCalledOnce();
        view.rerender(<ChatDMCompose {...props} showBlockConfirm isUserBlocked={false} blockedByMe={false} />);
        expect(screen.getByText(/Your account and public posts are unaffected/)).toBeVisible();
        fireEvent.click(screen.getByRole('button', { name: 'Confirm block self-test conversation' }));
        expect(props.onBlock).toHaveBeenCalledOnce();
        view.rerender(
            <ChatDMCompose
                {...props}
                showBlockConfirm
                isUserBlocked={false}
                blockedByMe={false}
                blockStatusError="Unable to verify blocking."
            />,
        );
        expect(screen.getByRole('button', { name: 'Confirm block self-test conversation' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled();
    });

    it('reconciles an optimistic row once when its server echo already exists', () => {
        const optimistic = { id: 'opt-1', message: 'Test', delivery_status: 'sending' };
        const confirmed = { id: 'server-1', message: 'Test' };
        expect(reconcileOptimisticMessage([optimistic, confirmed], optimistic.id, confirmed)).toEqual([confirmed]);
    });
});
