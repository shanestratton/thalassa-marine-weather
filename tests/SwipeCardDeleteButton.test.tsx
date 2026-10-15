/**
 * Equipment and Checklists rows: the swipe's Delete is a real, named button
 * once the row is swiped open, and nothing at all to VoiceOver before
 * (126-B10b; binder audit EQ-6), as the Maintenance, Stores and Documents
 * cards already are. It was a bare div: opacity hid it from the eye only, so
 * VoiceOver read an unnamed "Delete" before every row and could not press it.
 *
 * Fictional gear and lists only: a 'Watermaker', 'Pre-departure' and its
 * 'Check bilge pump'.
 */
import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EquipmentItem } from '../types';
import type { ChecklistEntry } from '../services/vessel/LocalChecklistService';

const swipe = vi.hoisted(() => ({ offset: 0, resetSwipe: vi.fn() }));

// The swipe is a native touch gesture: the test sets how far it is open.
vi.mock('../hooks/useSwipeable', () => ({
    useSwipeable: () => ({
        swipeOffset: swipe.offset,
        isSwiping: false,
        resetSwipe: swipe.resetSwipe,
        ref: () => undefined,
    }),
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

import { SwipeableEquipmentCard } from '../components/vessel/equipment/SwipeableEquipmentCard';
import { SwipeableItemCard } from '../components/vessel/checklists/SwipeableItemCard';

const NOW = '2026-10-15T01:00:00.000Z';

const watermaker: EquipmentItem = {
    id: 'e-wm',
    user_id: 'skipper-1',
    equipment_name: 'Watermaker',
    category: 'Plumbing',
    make: 'Make',
    model: 'Model',
    serial_number: 'SN-FICTIONAL',
    installation_date: null,
    warranty_expiry: null,
    manual_uri: null,
    notes: null,
    created_at: NOW,
    updated_at: NOW,
};

const preDeparture: ChecklistEntry = {
    id: 'h-pre',
    type: 'heading',
    text: 'Pre-departure',
    heading_id: null,
    order: 1,
    created_at: NOW,
    updated_at: NOW,
};

const bilge: ChecklistEntry = {
    id: 'i-bilge',
    type: 'detail',
    text: 'Check bilge pump',
    heading_id: 'h-pre',
    order: 2,
    created_at: NOW,
    updated_at: NOW,
};

interface CardCase {
    label: string;
    name: string;
    card: (onDelete: () => void) => React.ReactElement;
}

const CASES: CardCase[] = [
    {
        label: 'Equipment',
        name: 'Watermaker',
        card: (onDelete) => (
            <SwipeableEquipmentCard item={watermaker} onTap={vi.fn()} onDelete={onDelete} onContextMenu={vi.fn()} />
        ),
    },
    {
        label: 'Checklists, a checklist',
        name: 'Pre-departure',
        card: (onDelete) => (
            <SwipeableItemCard entry={preDeparture} onEdit={vi.fn()} onDelete={onDelete} isHeading itemCount={1} />
        ),
    },
    {
        label: 'Checklists, an item',
        name: 'Check bilge pump',
        card: (onDelete) => <SwipeableItemCard entry={bilge} onEdit={vi.fn()} onDelete={onDelete} />,
    },
];

beforeEach(() => {
    swipe.offset = 0;
    swipe.resetSwipe.mockClear();
});

describe.each(CASES)('$label: the swipe’s Delete', (c) => {
    it('is hidden from VoiceOver and out of the tab order until the row is swiped open', () => {
        const onDelete = vi.fn();
        const { container } = render(c.card(onDelete));

        expect(screen.queryByRole('button', { name: `Delete ${c.name}` })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();
        const action = container.querySelector<HTMLElement>('.bg-red-600')!;
        expect(action).toHaveAttribute('aria-hidden', 'true');
        expect(action).toHaveAttribute('tabindex', '-1');
        expect(action).not.toHaveAttribute('role');

        // A key press on the hidden action does nothing.
        fireEvent.keyDown(action, { key: 'Enter' });
        expect(onDelete).not.toHaveBeenCalled();
    });

    it('swiped open, it is a button named for the row, and a tap deletes and closes the swipe', () => {
        swipe.offset = 80;
        const onDelete = vi.fn();
        render(c.card(onDelete));

        const button = screen.getByRole('button', { name: `Delete ${c.name}` });
        expect(button).toHaveAttribute('tabindex', '0');
        expect(button).not.toHaveAttribute('aria-hidden');
        fireEvent.click(button);
        expect(onDelete).toHaveBeenCalledTimes(1);
        expect(swipe.resetSwipe).toHaveBeenCalledTimes(1);
    });

    it('swiped open, Enter and Space press it from the keyboard; other keys do not', () => {
        swipe.offset = 80;
        const onDelete = vi.fn();
        render(c.card(onDelete));
        const button = screen.getByRole('button', { name: `Delete ${c.name}` });

        fireEvent.keyDown(button, { key: 'Tab' });
        expect(onDelete).not.toHaveBeenCalled();
        fireEvent.keyDown(button, { key: 'Enter' });
        fireEvent.keyDown(button, { key: ' ' });
        expect(onDelete).toHaveBeenCalledTimes(2);
    });
});

describe('Equipment on a shared register', () => {
    it('has no Delete at all, swiped or not', () => {
        swipe.offset = 80;
        render(<SwipeableEquipmentCard item={watermaker} onTap={vi.fn()} onContextMenu={vi.fn()} />);
        expect(screen.queryByRole('button', { name: /^Delete/ })).not.toBeInTheDocument();
    });
});
