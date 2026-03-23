/**
 * ListingCard — smoke tests (604 LOC marketplace component)
 */
import React from 'react';
import { render } from '@testing-library/react';
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
});
