/**
 * Checklists with VoiceOver and a keyboard (132-B20).
 *
 * - Reordering is a mode of its own: the ⋮'s Reorder items shows each item's
 *   two arrows, 44 pt each and named for the item, and Done puts them away.
 *   They used to sit on every item, 32 px tall, beside its 44 pt Edit.
 * - A move keeps the focus on the arrow that made it (or the other one, at
 *   the end of the list), and VoiceOver hears where the item went.
 * - The ⋮ is Diary's menu: named with its state, Escape closes it.
 * - The Add sheet's Type is a named group, and Under checklist names its select.
 *
 * ChecklistRuns.test.tsx's harness (service mocked). Fictional lists only:
 * 'Pre-departure' and 'Heavy weather'.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getAllMock } = vi.hoisted(() => ({ getAllMock: vi.fn() }));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../utils/system', () => ({ triggerHaptic: vi.fn() }));
vi.mock('../hooks/useRealtimeSync', () => ({ useRealtimeSync: vi.fn(), useRealtimeSyncMulti: vi.fn() }));
vi.mock('../services/vessel/SyncService', () => ({ onSyncComplete: () => () => undefined }));
vi.mock('../services/vessel/LocalChecklistService', () => ({
    LocalChecklistService: {
        getAll: getAllMock,
        getRuns: vi.fn(() => []),
        create: vi.fn(),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue(undefined),
        saveRun: vi.fn(),
    },
}));
vi.mock('../services/vessel/LocalMaintenanceService', () => ({
    LocalMaintenanceService: { createRepair: vi.fn() },
}));
vi.mock('../services/vessel/LocalDatabase', () => ({ generateUUID: vi.fn(() => 'run-1') }));
vi.mock('../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { ChecklistsPage } from '../components/vessel/ChecklistsPage';
import { LocalChecklistService, type ChecklistEntry } from '../services/vessel/LocalChecklistService';

// The sheets' keyboard scroll calls window.scrollBy, which jsdom lacks.
window.scrollBy = () => undefined;

const at = '2026-01-01T00:00:00.000Z';
function entry(id: string, text: string, headingId: string | null, order: number): ChecklistEntry {
    return {
        id,
        type: headingId ? 'detail' : 'heading',
        text,
        heading_id: headingId,
        order,
        created_at: at,
        updated_at: at,
    };
}
const LISTS = [
    entry('h-pre', 'Pre-departure', null, 1),
    entry('i-bilge', 'Bilge pump', 'h-pre', 2),
    entry('i-seacocks', 'Close seacocks', 'h-pre', 3),
    entry('h-heavy', 'Heavy weather', null, 4),
    entry('i-jib', 'Storm jib hanked on', 'h-heavy', 5),
];
const update = vi.mocked(LocalChecklistService.update);

const arrow = (text: string, direction: 'up' | 'down') =>
    screen.queryByRole('button', { name: `Move ${text} ${direction}` });

function startReorder() {
    fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Reorder items' }));
}

beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    getAllMock.mockReturnValue(LISTS);
    update.mockResolvedValue({} as never);
});

describe('Reorder mode (132-B20)', () => {
    it('keeps the arrows off the list until Reorder items, then shows 44 pt arrows named for each item', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        expect(arrow('Bilge pump', 'up')).toBeNull();
        expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
        expect(screen.getByRole('button', { name: 'Edit checklist item: Bilge pump' })).toBeInTheDocument();

        startReorder();
        for (const text of ['Bilge pump', 'Close seacocks', 'Storm jib hanked on']) {
            for (const direction of ['up', 'down'] as const) {
                const button = arrow(text, direction)!;
                expect(button).toBeInTheDocument();
                // 44 CSS px at every root size, not min-h-11 (2.75rem).
                expect(button.className).toContain('h-[44px]');
                expect(button.className).toContain('w-[44px]');
            }
        }
        // Each list's ends: the first item cannot go up, the last cannot go down.
        expect(arrow('Bilge pump', 'up')).toBeDisabled();
        expect(arrow('Bilge pump', 'down')).toBeEnabled();
        expect(arrow('Close seacocks', 'down')).toBeDisabled();
        expect(arrow('Storm jib hanked on', 'up')).toBeDisabled();
        expect(arrow('Storm jib hanked on', 'down')).toBeDisabled();
        // Nothing else to press on a row while reordering: no Edit, no Run.
        expect(screen.queryByRole('button', { name: /^Edit checklist item/ })).toBeNull();
        expect(screen.queryByRole('button', { name: /^Run / })).toBeNull();
        expect(screen.queryByRole('textbox', { name: 'Search checklists' })).toBeNull();
        expect(screen.getByText('Move items with the arrows, then tap Done.')).toBeInTheDocument();
    });

    it('a tap on a row while reordering opens nothing', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        startReorder();
        fireEvent.click(screen.getByText('Bilge pump'));
        expect(screen.queryByRole('dialog')).toBeNull();
    });

    it('moves an item, says where it went, and keeps the focus on its arrows as the list redraws', async () => {
        update.mockImplementation(async (id: string) => {
            // The second write lands: the list now reads seacocks first.
            if (id === 'i-seacocks')
                getAllMock.mockReturnValue([
                    LISTS[0],
                    { ...LISTS[1], order: 3 },
                    { ...LISTS[2], order: 2 },
                    LISTS[3],
                    LISTS[4],
                ]);
            return {} as never;
        });
        render(<ChecklistsPage onBack={vi.fn()} />);
        startReorder();
        const down = arrow('Bilge pump', 'down')!;
        down.focus();
        await act(async () => {
            fireEvent.click(down);
        });

        expect(update.mock.calls).toEqual([
            ['i-bilge', { order: 3 }],
            ['i-seacocks', { order: 2 }],
        ]);
        expect(screen.getByText('Bilge pump moved to 2 of 2')).toHaveAttribute('role', 'status');
        // Bilge pump is last now: its down arrow is spent, so its up arrow has the focus.
        await waitFor(() => expect(arrow('Bilge pump', 'up')).toHaveFocus());
        expect(arrow('Bilge pump', 'down')).toBeDisabled();
        const order = screen
            .getAllByRole('button', { name: /^Move .* up$/ })
            .map((button) => button.getAttribute('aria-label'));
        expect(order).toEqual(['Move Close seacocks up', 'Move Bilge pump up', 'Move Storm jib hanked on up']);
    });

    it('Done puts the arrows away and gives the focus back to the ⋮', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        startReorder();
        fireEvent.click(screen.getByRole('button', { name: 'Done' }));
        expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
        expect(screen.getByRole('button', { name: 'Edit checklist item: Bilge pump' })).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Page actions' })).toHaveFocus();
    });

    it('offers no Reorder while no checklist has two items', () => {
        getAllMock.mockReturnValue(LISTS.filter((e) => e.id !== 'i-seacocks'));
        render(<ChecklistsPage onBack={vi.fn()} />);
        expect(screen.queryByRole('button', { name: 'Page actions' })).toBeNull();
        expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
    });
});

describe('the ⋮ is a menu (132-B20)', () => {
    it('is named with its state, puts the focus inside, and Escape closes it back to the ⋮', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        const trigger = screen.getByRole('button', { name: 'Page actions' });
        expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
        fireEvent.click(trigger);
        expect(trigger).toHaveAttribute('aria-expanded', 'true');
        const menu = screen.getByRole('menu', { name: 'Checklist actions' });
        expect(trigger).toHaveAttribute('aria-controls', menu.id);
        expect(screen.getByRole('menuitem', { name: 'Reorder items' })).toHaveFocus();
        fireEvent.keyDown(menu, { key: 'Escape' });
        expect(screen.queryByRole('menu')).toBeNull();
        expect(trigger).toHaveFocus();
    });
});

describe('the Add sheet names its fields (132-B20)', () => {
    it("names Type as a group of two, and Under checklist's select", () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Add checklist or item' }));
        const type = screen.getByRole('group', { name: 'Type' });
        expect(
            within(type)
                .getAllByRole('button')
                .map((button) => button.textContent?.trim()),
        ).toEqual(['Checklist', 'Item']);
        const under = screen.getByRole('combobox', { name: 'Under checklist' });
        expect(under).toHaveValue('h-pre');
        expect(under.className).toContain('min-h-[44px]');
    });
});
