/**
 * Tests for ListSkeleton component
 */
import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { ListSkeleton } from '../components/ui/ListSkeleton';

describe('ListSkeleton', () => {
    it('renders default 5 skeleton cards', () => {
        const { container } = render(<ListSkeleton />);
        const cards = container.querySelectorAll('.animate-pulse');
        expect(cards.length).toBe(5);
    });

    it('renders custom count of skeleton cards', () => {
        const { container } = render(<ListSkeleton count={3} />);
        const cards = container.querySelectorAll('.animate-pulse');
        expect(cards.length).toBe(3);
    });

    it('renders header stat cards when showHeader is true', () => {
        const { container } = render(<ListSkeleton count={2} showHeader />);
        // 3 stat cards + 2 list cards = 5 total
        const cards = container.querySelectorAll('.animate-pulse');
        expect(cards.length).toBe(5);
    });

    it('does not render header by default', () => {
        const { container } = render(<ListSkeleton count={2} />);
        const cards = container.querySelectorAll('.animate-pulse');
        expect(cards.length).toBe(2);
    });
});
