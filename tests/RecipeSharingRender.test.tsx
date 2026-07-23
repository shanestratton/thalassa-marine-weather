import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { ChatMessage, DirectMessage, DMConversation } from '../services/ChatService';
import { ChatMessageList } from '../components/chat/ChatMessageList';
import { ChatDMInbox, ChatDMThread } from '../components/chat/ChatDMView';

const recipeMessage = 'A reliable one-pot dinner.\n🍳RECIPE:recipe-123|Fish%20%7C%20Chips|4|45|';

const channelMessage: ChatMessage = {
    id: 'message-1',
    channel_id: 'general',
    user_id: 'captain-1',
    display_name: 'Skipper',
    message: recipeMessage,
    is_question: false,
    helpful_count: 0,
    is_pinned: false,
    deleted_at: null,
    created_at: new Date().toISOString(),
};

describe('recipe share rendering', () => {
    it('renders a structured recipe card in a channel instead of the encoded token', () => {
        render(
            <ChatMessageList
                messages={[channelMessage]}
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

        expect(screen.getByRole('button', { name: 'Fish | Chips recipe. View details' })).toBeInTheDocument();
        expect(screen.getByText('A reliable one-pot dinner.')).toBeInTheDocument();
        expect(screen.queryByText(/🍳RECIPE:/)).not.toBeInTheDocument();
    });

    it('renders the same recipe card in a direct-message thread', () => {
        const directMessage: DirectMessage = {
            id: 'dm-1',
            sender_id: 'captain-1',
            recipient_id: 'self',
            sender_name: 'Skipper',
            message: recipeMessage,
            read: true,
            created_at: new Date().toISOString(),
        };

        render(<ChatDMThread thread={[directMessage]} partnerName="Skipper" />);

        expect(screen.getByRole('button', { name: 'Fish | Chips recipe. View details' })).toBeInTheDocument();
        expect(screen.queryByText(/🍳RECIPE:/)).not.toBeInTheDocument();
    });

    it('uses a readable recipe title in the DM inbox preview', () => {
        const conversation: DMConversation = {
            user_id: 'captain-1',
            display_name: 'Skipper',
            last_message: recipeMessage,
            last_at: new Date().toISOString(),
            unread_count: 0,
        };

        render(<ChatDMInbox conversations={[conversation]} onOpenThread={vi.fn()} />);

        expect(screen.getByText('🍳 Fish | Chips')).toBeInTheDocument();
        expect(screen.queryByText(/🍳RECIPE:/)).not.toBeInTheDocument();
    });

    it('labels a queued direct message honestly until reconnect delivery', () => {
        render(
            <ChatDMThread
                partnerName="Skipper"
                thread={[
                    {
                        id: 'queued-dm',
                        sender_id: 'self',
                        recipient_id: 'captain-1',
                        sender_name: 'You',
                        message: 'Offshore hello',
                        read: true,
                        created_at: new Date().toISOString(),
                        delivery_status: 'queued',
                    },
                ]}
            />,
        );

        expect(screen.getByRole('status')).toHaveTextContent('Queued — sends when online');
    });
});
