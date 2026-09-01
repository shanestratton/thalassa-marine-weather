/**
 * SavedRoutePicker — legs sit FLUSH under their passage heading, and the
 * "(Nth Leg)" badge survives narrow screens.
 *
 * Shane 2026-08-27: "can we not have the legs indented. just have them under
 * the passage name, with the dog leg arrow" — the ↳ glyph alone marks a leg
 * row; no margin/width offset may return. Same day: leg 2 of Newport–Mackay
 * rendered with no "(2nd Leg)" — the badge now travels as its own row field,
 * rendered OUTSIDE the truncating name span so a long route name can never
 * eat it. Ordering stays passage → legs (by ordinal) → standalone.
 */
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { SavedRoutePicker, type SavedRoutePickerRow } from '../components/crew/SavedRoutePicker';

vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));

const rows: SavedRoutePickerRow[] = [
    {
        id: 'standalone-1',
        name: 'Bay run',
        detail: '12 NM',
        kind: 'standalone',
        groupKey: 'standalone-1',
        stamp: 100,
    },
    {
        id: 'trip-passage',
        name: 'Newport - Mackay (Passage)',
        detail: '2 legs · 480 NM',
        kind: 'passage',
        groupKey: 'trip-1',
        stamp: 300,
    },
    {
        id: 'leg-2',
        name: 'Newport - Mackay',
        legBadge: '(2nd Leg)',
        detail: 'Leg 2 · 290 NM',
        kind: 'leg',
        legOrdinal: 2,
        groupKey: 'trip-1',
        stamp: 250,
    },
    {
        id: 'leg-1',
        name: 'Newport - Mackay',
        legBadge: '(1st Leg)',
        detail: 'Leg 1 · 190 NM',
        kind: 'leg',
        legOrdinal: 1,
        groupKey: 'trip-1',
        stamp: 200,
    },
];

function openPicker(selectedId = '') {
    render(<SavedRoutePicker rows={rows} selectedId={selectedId} onSelect={vi.fn()} />);
    fireEvent.click(screen.getByRole('combobox', { name: 'Saved Routes' }));
    return screen.getByRole('listbox', { name: 'Saved Routes' });
}

describe('SavedRoutePicker flush legs', () => {
    it('renders leg rows without any indent offset, marked by the dog-leg arrow', () => {
        openPicker();
        for (const badge of ['(1st Leg)', '(2nd Leg)']) {
            const option = screen.getByRole('option', { name: new RegExp(badge.replace(/[()]/g, '\\$&')) });
            expect(option.className).not.toMatch(/\bml-\d/);
            expect(option.className).not.toMatch(/calc\(100%/);
            expect(within(option).getByText('↳')).toBeTruthy();
        }
    });

    it('keeps the leg badge outside the truncating name span', () => {
        const listbox = openPicker();
        for (const badge of ['(1st Leg)', '(2nd Leg)']) {
            const badgeSpan = within(listbox).getByText(badge);
            expect(badgeSpan.className).toContain('shrink-0');
            expect(badgeSpan.className).not.toContain('truncate');
            expect(badgeSpan.closest('.truncate')).toBeNull();
        }
    });

    it('shows the badged name on the closed trigger', () => {
        render(<SavedRoutePicker rows={rows} selectedId="leg-2" onSelect={vi.fn()} />);
        expect(screen.getByRole('combobox', { name: 'Saved Routes' }).textContent).toContain(
            'Newport - Mackay (2nd Leg)',
        );
    });

    it('keeps the group order: passage heading, legs by ordinal, then day sails by stamp', () => {
        const listbox = openPicker();
        const rowTexts = Array.from(listbox.querySelectorAll('[role="option"], [role="presentation"]')).map(
            (el) => el.textContent ?? '',
        );
        expect(rowTexts).toHaveLength(5);
        expect(rowTexts[0]).toContain('Clear selection');
        expect(rowTexts[1]).toContain('(Passage)');
        expect(rowTexts[2]).toContain('(1st Leg)');
        expect(rowTexts[3]).toContain('(2nd Leg)');
        expect(rowTexts[4]).toContain('Bay run');
    });

    it('offers the passage row as a heading, not a selectable option', () => {
        openPicker();
        const optionNames = screen.getAllByRole('option').map((option) => option.textContent ?? '');
        expect(optionNames.some((text) => text.includes('(Passage)'))).toBe(false);
    });
});
