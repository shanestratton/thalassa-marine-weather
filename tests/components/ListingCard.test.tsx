/**
 * ListingCard — smoke tests (603 LOC marketplace component)
 */
import React from 'react';
import { render } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../utils/system', () => ({ triggerHaptic: vi.fn() }));

import { ListingCard } from '../../components/marketplace/ListingCard';

describe('ListingCard', () => {
    const mockListing = {
        id: 'test-1',
        title: 'Test Marine Radio',
        description: 'VHF radio in excellent condition',
        price: 250,
        currency: 'AUD',
        category: 'electronics' as const,
        condition: 'excellent' as const,
        location: 'Sydney',
        images: [],
        seller_id: 'user-1',
        seller_name: 'John',
        created_at: new Date().toISOString(),
        status: 'active' as const,
    };

    beforeEach(() => vi.clearAllMocks());

    it('renders without crashing', () => {
        const { container } = render(<ListingCard listing={mockListing} onTap={vi.fn()} />);
        expect(container).toBeDefined();
    });

    it('renders listing title', () => {
        const { container } = render(<ListingCard listing={mockListing} onTap={vi.fn()} />);
        expect(container.textContent).toContain('Test Marine Radio');
    });

    it('renders listing price', () => {
        const { container } = render(<ListingCard listing={mockListing} onTap={vi.fn()} />);
        expect(container.textContent).toContain('250');
    });
});
