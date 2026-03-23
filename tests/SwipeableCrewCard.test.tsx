/**
 * SwipeableCrewCard — Component tests
 *
 * Tests rendering, status badges, register display, and click handlers.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SwipeableCrewCard } from '../components/crew/SwipeableCrewCard';
import type { CrewMember } from '../services/CrewService';

// Mock useSwipeable — it depends on native touch handlers
vi.mock('../hooks/useSwipeable', () => ({
    useSwipeable: () => ({
        swipeOffset: 0,
        isSwiping: false,
        resetSwipe: vi.fn(),
        ref: { current: null },
    }),
}));

function makeMember(overrides: Partial<CrewMember> = {}): CrewMember {
    return {
        id: 'crew-1',
        owner_id: 'owner-1',
        crew_user_id: 'user-1',
        crew_email: 'crew@example.com',
        owner_email: 'captain@example.com',
        shared_registers: ['stores', 'galley'],
        permissions: {
            can_view_stores: true,
            can_edit_stores: false,
            can_view_galley: true,
            can_view_nav: false,
            can_view_weather: false,
            can_edit_log: false,
            can_view_passage: false,
            can_view_passage_meals: false,
            can_view_passage_chat: false,
            can_view_passage_route: false,
            can_view_passage_checklist: false,
        },
        status: 'accepted',
        role: 'deckhand',
        created_at: '2024-01-01T00:00:00Z',
        updated_at: '2024-01-01T00:00:00Z',
        ...overrides,
    };
}

describe('SwipeableCrewCard', () => {
    it('renders crew email in captain mode', () => {
        const member = makeMember();
        render(<SwipeableCrewCard member={member} mode="captain" onDelete={vi.fn()} />);
        expect(screen.getByText('crew@example.com')).toBeTruthy();
    });

    it('renders captain email in crew mode', () => {
        const member = makeMember();
        render(<SwipeableCrewCard member={member} mode="crew" onDelete={vi.fn()} />);
        expect(screen.getByText('captain@example.com')).toBeTruthy();
    });

    it('shows "✓ Active" for accepted status in captain mode', () => {
        const member = makeMember({ status: 'accepted' });
        render(<SwipeableCrewCard member={member} mode="captain" onDelete={vi.fn()} />);
        expect(screen.getByText('✓ Active')).toBeTruthy();
    });

    it('shows pending status in captain mode', () => {
        const member = makeMember({ status: 'pending' });
        render(<SwipeableCrewCard member={member} mode="captain" onDelete={vi.fn()} />);
        expect(screen.getByText('⏳ Waiting for them to accept')).toBeTruthy();
    });

    it('shows declined status in captain mode', () => {
        const member = makeMember({ status: 'declined' });
        render(<SwipeableCrewCard member={member} mode="captain" onDelete={vi.fn()} />);
        expect(screen.getByText('Declined')).toBeTruthy();
    });

    it('renders shared register badges', () => {
        const member = makeMember({ shared_registers: ['stores', 'galley', 'equipment'] });
        render(<SwipeableCrewCard member={member} mode="captain" onDelete={vi.fn()} />);
        // Register labels should appear
        expect(screen.getByText(/Ship's Stores/)).toBeTruthy();
        expect(screen.getByText(/Galley/)).toBeTruthy();
        expect(screen.getByText(/Equipment/)).toBeTruthy();
    });

    it('shows Edit button for captain mode with non-declined status', () => {
        const onEdit = vi.fn();
        const member = makeMember({ status: 'accepted' });
        render(<SwipeableCrewCard member={member} mode="captain" onDelete={vi.fn()} onEdit={onEdit} />);
        const editBtn = screen.getByText('Edit');
        expect(editBtn).toBeTruthy();
        fireEvent.click(editBtn);
        expect(onEdit).toHaveBeenCalledOnce();
    });

    it('hides Edit button for declined status', () => {
        const member = makeMember({ status: 'declined' });
        render(<SwipeableCrewCard member={member} mode="captain" onDelete={vi.fn()} onEdit={vi.fn()} />);
        expect(screen.queryByText('Edit')).toBeNull();
    });

    it('shows "swipe to remove" in captain mode', () => {
        const member = makeMember();
        render(<SwipeableCrewCard member={member} mode="captain" onDelete={vi.fn()} />);
        expect(screen.getByText('← swipe to remove')).toBeTruthy();
    });

    it('shows "swipe to leave" in crew mode', () => {
        const member = makeMember();
        render(<SwipeableCrewCard member={member} mode="crew" onDelete={vi.fn()} />);
        expect(screen.getByText('← swipe to leave')).toBeTruthy();
    });

    it('shows anchor emoji in crew mode', () => {
        const member = makeMember();
        render(<SwipeableCrewCard member={member} mode="crew" onDelete={vi.fn()} />);
        expect(screen.getByText('⚓')).toBeTruthy();
    });

    it('shows "Captain\'s Registers" label in crew mode', () => {
        const member = makeMember();
        render(<SwipeableCrewCard member={member} mode="crew" onDelete={vi.fn()} />);
        expect(screen.getByText("Captain's Registers")).toBeTruthy();
    });
});
