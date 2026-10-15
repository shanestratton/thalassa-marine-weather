/**
 * Ship's Stores with VoiceOver and a keyboard (132-B20).
 *
 * - An item can be deleted from its Edit sheet, with the same Undo as the
 *   swipe: neither VoiceOver nor a keyboard can swipe, so they could not
 *   delete at all. Never on a skipper's shared Stores, as the swipe is not.
 * - A card opens from the keyboard: its words are a button that says whether
 *   the card is open, and a tap on them toggles it once.
 * - The Barcode fields are named by their labels; the camera buttons, the
 *   unit picker and the card's − and + are 44 px at every root size.
 * - The ⋮ is Diary's menu: named with its state, Escape closes it.
 *
 * The real LocalDatabase on the mocked (memory) filesystem under the real page
 * (StoresEditDelta.test.tsx's harness). Fictional stores only.
 */
import React from 'react';
import { readFileSync } from 'node:fs';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryItem } from '../types';

vi.mock('../services/supabase', () => ({
    supabase: {
        channel: () => {
            const api = { on: () => api, subscribe: () => api };
            return api;
        },
        removeChannel: vi.fn(),
    },
}));
vi.mock('../services/vessel/SyncService', () => ({
    onSyncComplete: () => () => undefined,
    onStatusChange: () => () => undefined,
    isFullReconciliationPending: () => false,
    requestFullReconciliation: vi.fn().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] }),
    requestCatchUpSync: vi.fn(),
    syncNow: vi.fn().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] }),
    forceFullPull: vi.fn().mockResolvedValue(0),
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: { settings: { vessel: { name: string } } }) => unknown) =>
        selector({ settings: { vessel: { name: 'Fictional Boat' } } }),
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { initLocalDatabase, mergePulledRecords } from '../services/vessel/LocalDatabase';
import { LocalInventoryService } from '../services/vessel/LocalInventoryService';
import { InventoryList } from '../components/vessel/InventoryList';
import { InventoryScanner } from '../components/vessel/InventoryScanner';
import { SwipeableInventoryCard } from '../components/vessel/inventory/SwipeableInventoryCard';

// The sheets' keyboard scroll calls window.scrollBy, which jsdom lacks.
window.scrollBy = () => undefined;

const NOW = '2026-10-15T01:00:00.000Z';
let accountCounter = 0;

function batteries(owner: string, extra: Partial<InventoryItem> = {}): InventoryItem {
    return {
        id: 's-aa',
        user_id: owner,
        barcode: '9300000000017',
        item_name: 'AA batteries',
        description: null,
        category: 'Electrical',
        quantity: 12,
        min_quantity: 4,
        unit: 'whole',
        location_zone: 'Nav station',
        location_specific: 'Top drawer',
        expiry_date: null,
        created_at: NOW,
        updated_at: NOW,
        ...extra,
    } as InventoryItem;
}

async function openEditSheet(): Promise<HTMLElement> {
    render(<InventoryList onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit AA batteries' }));
    return screen.findByRole('dialog', { name: 'Edit item' });
}

beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    accountCounter += 1;
    const me = `skipper-${accountCounter}`;
    act(() => setAuthIdentityScope(me));
    await initLocalDatabase(me);
    localStorage.setItem(`thalassa_inventory_deduped::user%3A${me}`, '1');
    await mergePulledRecords('inventory_items', [batteries(me)]);
});

afterEach(() => {
    vi.useRealTimers();
    act(() => setAuthIdentityScope(null));
    localStorage.clear();
});

describe('Delete from the Edit sheet (132-B20)', () => {
    it('closes the sheet, takes the card off with an Undo, and Undo brings it back', async () => {
        const spy = vi.spyOn(LocalInventoryService, 'delete');
        const sheet = await openEditSheet();
        fireEvent.click(within(sheet).getByRole('button', { name: 'Delete item' }));

        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit item' })).not.toBeInTheDocument());
        expect(screen.queryByText('AA batteries')).not.toBeInTheDocument();
        expect(screen.getByText('"AA batteries" deleted')).toBeInTheDocument();
        // Nothing is deleted while the Undo waits.
        expect(spy).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: 'Undo delete action' }));
        expect(await screen.findByText('AA batteries')).toBeInTheDocument();
        expect(spy).not.toHaveBeenCalled();
        expect(LocalInventoryService.getItem('s-aa')).not.toBeNull();
    });

    it('is the last thing in the sheet, under the fields, and never on a shared Stores', async () => {
        const sheet = await openEditSheet();
        // Last among the scrolling fields; Save keeps the pinned footer to itself.
        const body = sheet.querySelector<HTMLElement>('[data-modal-sheet-body]')!;
        const remove = within(sheet).getByRole('button', { name: 'Delete item' });
        expect(within(body).getAllByRole('button').at(-1)).toBe(remove);
        const footer = sheet.querySelector<HTMLElement>('[data-modal-sheet-footer]')!;
        expect(
            within(footer)
                .getAllByRole('button')
                .map((button) => button.textContent),
        ).toEqual(['Save changes']);
        // The swipe and this Delete are both the skipper's alone.
        const page = readFileSync('components/vessel/InventoryList.tsx', 'utf8');
        expect(page).toMatch(/\{!sharedBinder && \(\s*<Button\s+variant="danger"/);
    });
});

describe('the Barcode fields and the camera buttons (132-B20)', () => {
    it('the Edit sheet names its Barcode field, and its camera button is 44 px', async () => {
        const sheet = await openEditSheet();
        const field = within(sheet).getByRole('textbox', { name: 'Barcode' });
        expect(field).toHaveValue('9300000000017');
        expect(field.className).toContain('min-h-[44px]');
        const camera = within(sheet).getByRole('button', { name: 'Scan barcode with camera' });
        expect(camera.className).toContain('min-h-[44px]');
        expect(camera.className).toContain('min-w-[44px]');
        expect(within(sheet).getByRole('combobox', { name: 'Unit' }).className).toContain('min-h-[44px]');
    });

    it('the Add sheet names its Barcode field, and Scan is 44 px', () => {
        render(<InventoryScanner onClose={vi.fn()} onItemSaved={vi.fn()} onAdjust={vi.fn()} units="metric" />);
        const sheet = screen.getByRole('dialog', { name: 'Add item' });
        const field = within(sheet).getByRole('textbox', { name: 'Barcode' });
        expect(field).toHaveAttribute('placeholder', 'Optional');
        const scan = within(sheet).getByRole('button', { name: 'Scan barcode' });
        expect(scan.className).toContain('min-h-[44px]');
        expect(scan.className).not.toMatch(/\bmin-h-11\b/);
    });
});

describe('the cards open from the keyboard (132-B20)', () => {
    const item = batteries('skipper-x');

    it('the words are a button that says whether the card is open, and toggles it once', () => {
        const onTap = vi.fn();
        const { rerender } = render(
            <SwipeableInventoryCard item={item} units="metric" isExpanded={false} onTap={onTap} />,
        );
        const toggle = screen.getByRole('button', { name: /^AA batteries/ });
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
        expect(toggle).not.toHaveAttribute('aria-controls');
        fireEvent.click(toggle);
        // Once, though the card under it listens for taps too.
        expect(onTap).toHaveBeenCalledTimes(1);

        rerender(
            <SwipeableInventoryCard item={item} units="metric" isExpanded onTap={onTap} onQuantityAdjust={vi.fn()} />,
        );
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        const detail = document.getElementById(toggle.getAttribute('aria-controls')!)!;
        expect(detail).toHaveTextContent('Electrical');
        for (const name of ['Decrease quantity', 'Increase quantity']) {
            const button = within(detail).getByRole('button', { name });
            expect(button.className).toContain('w-[44px]');
            expect(button.className).toContain('h-[44px]');
        }
    });

    it('a tap elsewhere on the card still opens it', () => {
        const onTap = vi.fn();
        render(<SwipeableInventoryCard item={item} units="metric" isExpanded={false} onTap={onTap} />);
        fireEvent.click(screen.getByText('12'));
        expect(onTap).toHaveBeenCalledTimes(1);
    });

    it('opens on the page from its button, and shows its count controls', async () => {
        render(<InventoryList onBack={vi.fn()} />);
        const toggle = await screen.findByRole('button', { name: /^AA batteries/ });
        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'true');
        expect(screen.getByRole('button', { name: 'Decrease quantity' })).toBeInTheDocument();
        fireEvent.click(toggle);
        expect(toggle).toHaveAttribute('aria-expanded', 'false');
    });
});

describe('the ⋮ is a menu (132-B20)', () => {
    it('is named with its state, puts the focus inside, and Escape closes it back to the ⋮', async () => {
        render(<InventoryList onBack={vi.fn()} />);
        await screen.findByText('AA batteries');
        const trigger = screen.getByRole('button', { name: 'Page actions' });
        expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
        expect(trigger).toHaveAttribute('aria-expanded', 'false');
        fireEvent.click(trigger);
        expect(trigger).toHaveAttribute('aria-expanded', 'true');
        const menu = screen.getByRole('menu', { name: 'Stores actions' });
        expect(trigger).toHaveAttribute('aria-controls', menu.id);
        expect(screen.getByRole('menuitem', { name: 'Share or save stores list' })).toHaveFocus();
        fireEvent.keyDown(menu, { key: 'Escape' });
        expect(screen.queryByRole('menu')).not.toBeInTheDocument();
        expect(trigger).toHaveFocus();
    });
});
