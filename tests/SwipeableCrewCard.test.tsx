/**
 * SwipeableCrewCard — Component tests
 *
 * Tests rendering, status pills, register display, and click handlers. The
 * tier-1 card (2026-10-06): the person by name where the app knows it, the
 * status as a pill, Edit as a quiet icon button, the registers as one grid.
 */

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { SwipeableCrewCard } from '../components/crew/SwipeableCrewCard';
import { BreakableEmail } from '../components/crew/BreakableEmail';
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
            can_view_instruments: false,
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
        voyage_id: null,
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

    it('shows an "Active" pill for accepted status in captain mode', () => {
        const member = makeMember({ status: 'accepted' });
        render(<SwipeableCrewCard member={member} mode="captain" onDelete={vi.fn()} />);
        expect(screen.getByText('Active')).toHaveClass('crew-pill');
    });

    it('shows pending status in captain mode: an "Invited" pill, waiting for them to accept', () => {
        const member = makeMember({ status: 'pending', role: 'navigator' });
        render(<SwipeableCrewCard member={member} mode="captain" onDelete={vi.fn()} />);
        expect(screen.getByText('Invited')).toHaveClass('crew-pill');
        expect(screen.getByText('Navigator · Waiting for them to accept')).toBeTruthy();
    });

    it('shows declined status in captain mode', () => {
        const member = makeMember({ status: 'declined' });
        render(<SwipeableCrewCard member={member} mode="captain" onDelete={vi.fn()} />);
        expect(screen.getByText('Declined')).toHaveClass('crew-pill');
    });

    it('titles an accepted crew member by name and role, the email beneath', () => {
        const member = makeMember({ status: 'accepted', role: 'co-skipper' });
        render(<SwipeableCrewCard member={member} mode="captain" onDelete={vi.fn()} displayName="Mia Chen" />);
        expect(screen.getByText('Mia Chen')).toHaveClass('crew-card-title');
        expect(screen.getByText('Co-skipper · crew@example.com')).toBeTruthy();
        expect(screen.getByTestId('crew-avatar')).toHaveTextContent('MC');
    });

    it('keeps the email as the title until the invite is accepted, whatever name is passed', () => {
        const member = makeMember({ status: 'pending' });
        render(<SwipeableCrewCard member={member} mode="captain" onDelete={vi.fn()} displayName="Mia Chen" />);
        expect(screen.getByText('crew@example.com')).toHaveClass('crew-card-title');
        expect(screen.queryByText('Mia Chen')).toBeNull();
    });

    it('renders shared register chips as one list, a line glyph each and no emoji', () => {
        const member = makeMember({ shared_registers: ['stores', 'galley', 'equipment'] });
        render(<SwipeableCrewCard member={member} mode="captain" onDelete={vi.fn()} />);
        // Register labels should appear
        expect(screen.getByText(/Ship's Stores/)).toBeTruthy();
        expect(screen.getByText(/Galley/)).toBeTruthy();
        expect(screen.getByText(/Equipment/)).toBeTruthy();
        const chips = screen.getAllByRole('listitem');
        expect(screen.getByRole('list', { name: 'Shared registers' })).toHaveClass('crew-chips');
        expect(chips).toHaveLength(3);
        for (const chip of chips) expect(chip.querySelector('svg')).not.toBeNull();
        expect(screen.getByRole('list', { name: 'Shared registers' }).textContent).not.toMatch(
            /\p{Extended_Pictographic}/u,
        );
    });

    it('shows Edit button for captain mode with non-declined status', () => {
        const onEdit = vi.fn();
        const member = makeMember({ status: 'accepted' });
        render(<SwipeableCrewCard member={member} mode="captain" onDelete={vi.fn()} onEdit={onEdit} />);
        const editBtn = screen.getByRole('button', { name: 'Edit crew member details' });
        expect(editBtn).toHaveClass('crew-icon-btn');
        fireEvent.click(editBtn);
        expect(onEdit).toHaveBeenCalledOnce();
    });

    it('hides Edit button for declined status, and offers a quiet Remove in its place', () => {
        const onDelete = vi.fn();
        const member = makeMember({ status: 'declined' });
        render(<SwipeableCrewCard member={member} mode="captain" onDelete={onDelete} onEdit={vi.fn()} />);
        expect(screen.queryByRole('button', { name: 'Edit crew member details' })).toBeNull();
        fireEvent.click(screen.getByRole('button', { name: 'Remove the declined invite for crew@example.com' }));
        expect(onDelete).toHaveBeenCalledOnce();
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

    it('shows the anchor glyph in crew mode', () => {
        const member = makeMember();
        render(<SwipeableCrewCard member={member} mode="crew" onDelete={vi.fn()} />);
        expect(screen.getByTestId('crew-avatar').querySelector('svg')).not.toBeNull();
        expect(screen.queryByText('Active')).toBeNull();
    });

    it('shows "Skipper\'s Registers" label in crew mode', () => {
        const member = makeMember();
        render(<SwipeableCrewCard member={member} mode="crew" onDelete={vi.fn()} />);
        expect(screen.getByText("Skipper's Registers")).toBeTruthy();
    });
});

describe('BreakableEmail (a 320 px title broke mid-domain, 2026-10-06)', () => {
    const pieces = (email: string) => {
        const { container } = render(
            <p data-testid="title">
                <BreakableEmail email={email} />
            </p>,
        );
        const title = container.querySelector('[data-testid="title"]')!;
        return [...title.childNodes].map((node) => (node.nodeName === 'WBR' ? '|' : node.textContent)).join('');
    };

    it('breaks after the "@" and keeps a short domain whole, the text unchanged', () => {
        expect(pieces('sam.hollis@example.com')).toBe('sam.hollis@|example.com');
        expect(screen.getByText('sam.hollis@example.com')).toBeTruthy();
    });

    it('lets only a long domain break again, before its last "."', () => {
        expect(pieces('jo@harbourmaster-office.example.com.au')).toBe('jo@|harbourmaster-office.example.com|.au');
    });

    it('leaves anything that is not an address alone', () => {
        expect(pieces('no-at-sign')).toBe('no-at-sign');
    });
});
