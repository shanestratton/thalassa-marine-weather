import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ChatMessageList } from '../components/chat/ChatMessageList';
import type { ChatMessage } from '../services/ChatService';

vi.mock('../context/UIContext', () => ({ useUI: () => ({ setPage: vi.fn() }) }));

function renderMessage(moderation_status: ChatMessage['moderation_status']) {
    const message: ChatMessage = {
        id: 'own-message',
        channel_id: 'general',
        user_id: 'self',
        display_name: 'Me',
        message: 'Fair winds, crew!',
        is_question: false,
        helpful_count: 0,
        is_pinned: false,
        deleted_at: null,
        created_at: '2026-10-02T00:00:00Z',
        moderation_status,
    };
    return render(
        <ChatMessageList
            messages={[message]}
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

describe('own channel message delivery labels', () => {
    it.each([
        ['pending', 'Message awaiting moderation', '…'],
        ['held', 'Message not delivered', '!'],
        ['rejected', 'Message not posted', '!'],
        ['approved', 'Message published', '✓'],
    ] as const)('renders %s honestly', (status, label, symbol) => {
        renderMessage(status);
        expect(screen.getByLabelText(label)).toHaveTextContent(symbol);
        expect(screen.queryByLabelText('Message delivered')).not.toBeInTheDocument();
        expect(screen.queryByText('✓✓')).not.toBeInTheDocument();
        if (status === 'held') expect(screen.getByRole('status')).toHaveTextContent('Not delivered');
    });
});
