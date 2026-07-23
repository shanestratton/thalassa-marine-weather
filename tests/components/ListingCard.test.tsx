/**
 * ListingCard — smoke tests (604 LOC marketplace component)
 */
import React from 'react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../../services/ChatService', () => ({ ChatService: { sendDM: vi.fn() } }));
vi.mock('../../services/SellerRatingService', () => ({
    SellerRatingService: {
        getSellerReputation: vi.fn().mockResolvedValue(null),
        hasRated: vi.fn().mockResolvedValue(false),
        rateSeller: vi.fn().mockResolvedValue(true),
    },
    SellerReputation: {},
}));
vi.mock('../../theme', () => ({ t: { border: { default: 'border-white/5' } } }));
vi.mock('../../hooks/useSwipeable', () => ({
    useSwipeable: () => ({ swipeOffset: 0, isSwiping: false, resetSwipe: vi.fn(), ref: { current: null } }),
}));
vi.mock('../../utils/keyboardScroll', () => ({ scrollInputAboveKeyboard: vi.fn() }));
vi.mock('./helpers', () => ({
    formatPrice: (p: number, c: string) => `${c} ${p}`,
    getConditionColor: () => 'text-white',
    getAvatarGradient: () => 'from-sky-500 to-blue-500',
    timeAgo: () => '1h ago',
}));

import { ListingCard } from '../../components/marketplace/ListingCard';

describe('ListingCard', () => {
    const mockListing = {
        id: 'test-1',
        title: 'Test Marine Radio',
        description: 'VHF radio in excellent condition',
        price: 250,
        currency: 'AUD',
        category: 'Electronics' as const,
        condition: 'Like New' as const,
        location_name: 'Sydney',
        images: [],
        seller_id: 'user-1',
        seller_name: 'John',
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
        sold_at: null,
        status: 'available' as const,
    };

    const defaultProps = {
        listing: mockListing,
        isOwn: false,
        onMessageSeller: vi.fn(),
        onMarkSold: vi.fn(),
        onDelete: vi.fn(),
    };

    beforeEach(() => vi.clearAllMocks());

    it('renders without crashing', () => {
        const { container } = render(<ListingCard {...defaultProps} />);
        expect(container).toBeDefined();
    });

    it('renders listing title', () => {
        const { container } = render(<ListingCard {...defaultProps} />);
        expect(container.textContent).toContain('Test Marine Radio');
    });

    it('renders listing price', () => {
        const { container } = render(<ListingCard {...defaultProps} />);
        expect(container.textContent).toContain('250');
    });

    it('opens a conversation without silently sending a template message', async () => {
        const onMessageSeller = vi.fn().mockResolvedValue(true);
        render(<ListingCard {...defaultProps} onMessageSeller={onMessageSeller} />);

        fireEvent.click(screen.getByRole('button', { name: 'Message Seller' }));

        await waitFor(() => expect(onMessageSeller).toHaveBeenCalledWith(mockListing));
        expect(onMessageSeller).toHaveBeenCalledTimes(1);
    });

    it('sends an explicit offer exactly once through the parent workflow', async () => {
        const onMessageSeller = vi.fn().mockResolvedValue(true);
        render(<ListingCard {...defaultProps} onMessageSeller={onMessageSeller} />);

        fireEvent.click(screen.getByRole('button', { name: 'Show Offer Input' }));
        fireEvent.change(screen.getByPlaceholderText('Your offer'), { target: { value: '200' } });
        fireEvent.click(screen.getByRole('button', { name: 'Send offer to seller' }));

        await waitFor(() =>
            expect(onMessageSeller).toHaveBeenCalledWith(mockListing, expect.stringMatching(/I'd like to offer .*200/)),
        );
        expect(onMessageSeller).toHaveBeenCalledTimes(1);
        expect(screen.queryByPlaceholderText('Your offer')).not.toBeInTheDocument();
    });
});
