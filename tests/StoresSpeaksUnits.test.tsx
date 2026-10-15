/**
 * Ship's Stores speaks units and plain words (131-B14; binder audit STORES-06,
 * STORES-05, STORES-12).
 *
 * Before: a Grocery List buy of sugar showed '1000' and stepped a gram at a
 * time; the header added grams and tins into 'units' and counted every empty
 * row with no minimum as low; the row's notes read 'Added from Grocery List
 * purchase <uuid>', and renaming the row broke un-ticking it.
 *
 * The real Stores page over the real LocalDatabase (memory filesystem), the
 * real LocalInventoryService and the real Grocery List tick and un-tick
 * (BoxSheet.test.tsx's harness); only the socket and the sync engine are
 * fakes. Fictional stores: raw sugar, UHT milk, a spare shackle.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryItem } from '../types';

const prefs = vi.hoisted(() => ({ volume: 'l' as 'l' | 'gal' }));

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
    useSettingsStore: (
        selector: (state: { settings: { vessel: { name: string }; units: { volume: 'l' | 'gal' } } }) => unknown,
    ) => selector({ settings: { vessel: { name: 'Kestrel' }, units: { volume: prefs.volume } } }),
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import {
    getFullQueue,
    initLocalDatabase,
    mergePulledRecords,
    query,
    updateSyncMeta,
} from '../services/vessel/LocalDatabase';
import { addManualItem, markPurchased, unmarkPurchased } from '../services/ShoppingListService';
import { InventoryList } from '../components/vessel/InventoryList';

window.scrollBy = () => undefined;

const NOW = '2026-10-15T01:00:00.000Z';
const SUGAR = 'd1e2f3a4-0001-4b5c-8d6e-7f8091a2b3c1';
const MILK = 'd1e2f3a4-0002-4b5c-8d6e-7f8091a2b3c2';
const SHACKLE = 'd1e2f3a4-0003-4b5c-8d6e-7f8091a2b3c3';
const LOCKER = 'e2f3a4b5-0001-4c5d-8e6f-708192a3b4c5';
let counter = 0;
let me = '';

/** A number as the phone writes it. */
const n = (value: number) => value.toLocaleString(undefined, { maximumFractionDigits: 2 });

function stores(
    id: string,
    name: string,
    quantity: number,
    min: number,
    unit: string,
    extra: Partial<InventoryItem> = {},
) {
    return {
        id,
        user_id: me,
        barcode: null,
        item_name: name,
        description: null,
        category: 'Provisions',
        quantity,
        min_quantity: min,
        unit,
        location_zone: 'Galley',
        location_specific: null,
        expiry_date: null,
        box_id: null,
        created_at: NOW,
        updated_at: NOW,
        ...extra,
    } as InventoryItem;
}

async function seed(): Promise<void> {
    await mergePulledRecords('inventory_items', [
        stores(SUGAR, 'Raw sugar', 1000, 500, 'g'),
        stores(MILK, 'UHT milk', 1500, 0, 'ml'),
        // Empty, with no minimum set: not low.
        stores(SHACKLE, 'Spare shackle', 0, 0, 'whole', { category: 'Rigging' }),
    ]);
}

const rows = () => query<InventoryItem>('inventory_items', () => true);
const stored = (id: string) => rows().find((row) => row.id === id);
const queued = (id: string) =>
    getFullQueue()
        .filter((item) => item.table_name === 'inventory_items' && item.record_id === id)
        .map((item) => ({ type: item.mutation_type, ...JSON.parse(item.payload) }));

/** The card for an item: its name's card. */
const card = (name: string) => screen.getByText(name).closest('div.relative') as HTMLElement;

beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    prefs.volume = 'l';
    counter += 1;
    me = `8b9c0d1e-2f3a-4b4c-8d5e-${String(counter).padStart(12, '0')}`;
    act(() => setAuthIdentityScope(me));
    await initLocalDatabase(me);
    localStorage.setItem(authScopedStorageKey('thalassa_inventory_deduped', getAuthIdentityScope()), '1');
    await updateSyncMeta({ optionalTablesReadAt: { stores_boxes: NOW } });
});

afterEach(() => {
    act(() => setAuthIdentityScope(null));
    localStorage.clear();
});

describe('the Stores page in units', () => {
    it('shows 1 kg of sugar and 1.5 L of milk, and the header counts items, low by the one rule', async () => {
        await seed();
        render(<InventoryList onBack={vi.fn()} />);
        await screen.findByText('Raw sugar');
        expect(within(card('Raw sugar')).getByText('1 kg')).toBeInTheDocument();
        expect(within(card('UHT milk')).getByText(`${n(1.5)} L`)).toBeInTheDocument();
        expect(within(card('Spare shackle')).getByText('0')).toBeInTheDocument();
        expect(screen.queryByText('1000')).not.toBeInTheDocument();
        // Three items; nothing low (the empty shackle has no minimum).
        expect(screen.getByText('3 items')).toBeInTheDocument();
        expect(screen.queryByText(/\d low\b/)).not.toBeInTheDocument();
        expect(screen.queryByText(/\d units?\b/)).not.toBeInTheDocument();
    });

    it('− on 1 kg of sugar takes 100 g as a DELTA, and the card reads 900 g', async () => {
        await seed();
        render(<InventoryList onBack={vi.fn()} />);
        fireEvent.click(await screen.findByText('Raw sugar'));
        const sugar = card('Raw sugar');
        expect(sugar).toHaveTextContent('Steps of 100 g');
        fireEvent.click(within(sugar).getByRole('button', { name: 'Decrease quantity' }));
        await waitFor(() => expect(stored(SUGAR)?.quantity).toBe(900));
        expect(queued(SUGAR)).toEqual([expect.objectContaining({ type: 'DELTA', field: 'quantity', delta: -100 })]);
        await waitFor(() => expect(within(card('Raw sugar')).getAllByText('900 g').length).toBeGreaterThan(0));
    });

    it('follows US units from Settings: 2.2 lb of sugar, 50.7 fl oz of milk, a quarter pound a step', async () => {
        prefs.volume = 'gal';
        await seed();
        render(<InventoryList onBack={vi.fn()} />);
        fireEvent.click(await screen.findByText('Raw sugar'));
        expect(within(card('Raw sugar')).getAllByText(`${n(2.2)} lb`).length).toBeGreaterThan(0);
        expect(within(card('UHT milk')).getByText(`${(50.7).toLocaleString()} fl oz`)).toBeInTheDocument();
        expect(card('Raw sugar')).toHaveTextContent(`Steps of ${n(0.25)} lb`);
        fireEvent.click(within(card('Raw sugar')).getByRole('button', { name: 'Increase quantity' }));
        await waitFor(() => expect(stored(SUGAR)?.quantity).toBeCloseTo(1113.4, 1));
    });

    it('a weight on the box page steps 100 g too', async () => {
        await mergePulledRecords('stores_boxes', [
            {
                id: LOCKER,
                user_id: me,
                name: 'Galley locker',
                location_zone: 'Galley',
                notes: null,
                created_at: NOW,
                updated_at: NOW,
            },
        ]);
        await mergePulledRecords('inventory_items', [stores(SUGAR, 'Raw sugar', 1000, 500, 'g', { box_id: LOCKER })]);
        render(<InventoryList onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Boxes' }));
        fireEvent.click(
            within(await screen.findByRole('dialog', { name: 'Boxes' })).getByRole('button', {
                name: /^Galley locker/,
            }),
        );
        const page = await screen.findByRole('dialog', { name: 'Galley locker' });
        expect(within(page).getByLabelText('Raw sugar: 1 kg')).toBeInTheDocument();
        fireEvent.click(within(page).getByRole('button', { name: 'Take 100 g Raw sugar' }));
        await waitFor(() => expect(within(page).getByLabelText('Raw sugar: 900 g')).toBeInTheDocument());
        expect(queued(SUGAR)).toEqual([expect.objectContaining({ type: 'DELTA', delta: -100 })]);
    });
});

describe('the Edit sheet', () => {
    async function openEdit(name: string): Promise<HTMLElement> {
        render(<InventoryList onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: `Edit ${name}` }));
        return screen.findByRole('dialog', { name: 'Edit item' });
    }

    it('takes a decimal count as a DELTA: 1.5 L of milk to 0.75 L', async () => {
        await mergePulledRecords('inventory_items', [stores(MILK, 'UHT milk', 1.5, 0, 'L')]);
        const sheet = await openEdit('UHT milk');
        expect(within(sheet).getByRole('combobox', { name: 'Unit' })).toHaveValue('L');
        fireEvent.change(within(sheet).getByLabelText('Quantity'), { target: { value: '0.75' } });
        fireEvent.click(within(sheet).getByRole('button', { name: 'Save inventory item changes' }));
        await waitFor(() => expect(stored(MILK)?.quantity).toBe(0.75));
        expect(queued(MILK)).toEqual([expect.objectContaining({ type: 'DELTA', delta: -0.75 })]);
    });

    it('sets a count right as kilograms: the unit is written, the number kept', async () => {
        await mergePulledRecords('inventory_items', [stores(SUGAR, 'Raw sugar', 2, 0, 'whole')]);
        const sheet = await openEdit('Raw sugar');
        fireEvent.change(within(sheet).getByRole('combobox', { name: 'Unit' }), { target: { value: 'kg' } });
        expect(within(sheet).getByLabelText('Quantity')).toHaveValue(2);
        fireEvent.click(within(sheet).getByRole('button', { name: 'Save inventory item changes' }));
        await waitFor(() => expect(stored(SUGAR)).toMatchObject({ quantity: 2, unit: 'kg' }));
        expect(queued(SUGAR)).toEqual([{ type: 'UPDATE', unit: 'kg', updated_at: expect.any(String) }]);
    });

    it("opening and saving a row in 'each' writes nothing", async () => {
        await mergePulledRecords('inventory_items', [stores(SHACKLE, 'Spare shackle', 4, 1, 'each')]);
        const sheet = await openEdit('Spare shackle');
        expect(within(sheet).getByRole('combobox', { name: 'Unit' })).toHaveValue('each');
        fireEvent.click(within(sheet).getByRole('button', { name: 'Save inventory item changes' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit item' })).not.toBeInTheDocument());
        expect(queued(SHACKLE)).toEqual([]);
    });

    it('after two + on 1.5 kg of sugar, Edit says 1.7, not float dust, and Save adds no change', async () => {
        await mergePulledRecords('inventory_items', [stores(SUGAR, 'Raw sugar', 1.5, 0, 'kg')]);
        render(<InventoryList onBack={vi.fn()} />);
        fireEvent.click(await screen.findByText('Raw sugar'));
        // Two steps of 0.1 kg on the delta path: the row holds 1.5 + 0.1 + 0.1.
        fireEvent.click(within(card('Raw sugar')).getByRole('button', { name: 'Increase quantity' }));
        await waitFor(() => expect(stored(SUGAR)?.quantity).toBeCloseTo(1.6, 9));
        fireEvent.click(within(card('Raw sugar')).getByRole('button', { name: 'Increase quantity' }));
        await waitFor(() => expect(stored(SUGAR)?.quantity).toBeCloseTo(1.7, 9));

        fireEvent.click(screen.getByRole('button', { name: 'Edit Raw sugar' }));
        const sheet = await screen.findByRole('dialog', { name: 'Edit item' });
        expect((within(sheet).getByLabelText('Quantity') as HTMLInputElement).value).toBe('1.7');
        fireEvent.click(within(sheet).getByRole('button', { name: 'Save inventory item changes' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit item' })).not.toBeInTheDocument());
        // Only the two + went out, as DELTAs: the rounded field is not a change.
        const changes = queued(SUGAR);
        expect(changes.every((change) => change.type === 'DELTA' && change.delta > 0)).toBe(true);
        expect(changes.reduce((sum, change) => sum + change.delta, 0)).toBeCloseTo(0.2, 9);
    });

    // inventory_items.min_quantity is a whole number on the server: a 0.5 would
    // fail its push and hold up every later change to the row.
    it('keeps the minimum whole: a keypad with no point, and a typed 0.5 kg saves as 1 kg', async () => {
        await mergePulledRecords('inventory_items', [stores(SUGAR, 'Raw sugar', 2, 0, 'kg')]);
        const sheet = await openEdit('Raw sugar');
        const minimum = within(sheet).getByLabelText('Min qty');
        expect(minimum).toHaveAttribute('inputmode', 'numeric');
        fireEvent.change(minimum, { target: { value: '0.5' } });
        fireEvent.click(within(sheet).getByRole('button', { name: 'Save inventory item changes' }));
        await waitFor(() => expect(stored(SUGAR)?.min_quantity).toBe(1));
        expect(queued(SUGAR)).toEqual([{ type: 'UPDATE', min_quantity: 1, updated_at: expect.any(String) }]);
    });

    it('a 500 g minimum carried to kg is 1 kg on the row, never 0.5', async () => {
        await mergePulledRecords('inventory_items', [stores(SUGAR, 'Raw sugar', 1000, 500, 'g')]);
        const sheet = await openEdit('Raw sugar');
        fireEvent.change(within(sheet).getByRole('combobox', { name: 'Unit' }), { target: { value: 'kg' } });
        expect(within(sheet).getByLabelText('Quantity')).toHaveValue(1);
        expect(within(sheet).getByLabelText('Min qty')).toHaveValue(1);
        fireEvent.click(within(sheet).getByRole('button', { name: 'Save inventory item changes' }));
        await waitFor(() => expect(stored(SUGAR)).toMatchObject({ quantity: 1, min_quantity: 1, unit: 'kg' }));
        const minimums = queued(SUGAR).filter((change) => 'min_quantity' in change);
        expect(minimums).toEqual([expect.objectContaining({ type: 'UPDATE', min_quantity: 1 })]);
    });
});

describe('a Grocery List buy in Stores', () => {
    async function buySugar(): Promise<string> {
        const item = await addManualItem({ name: 'Raw sugar', qty: 1, unit: 'kg', voyageId: null, ownerUserId: me });
        await markPurchased(item.id, undefined, undefined, null, me);
        return item.id;
    }

    it('wears a small chip, never the purchase line with its id, and reads 1 kg', async () => {
        const bought = await buySugar();
        expect(stored(bought)).toMatchObject({ quantity: 1000, unit: 'g' });
        render(<InventoryList onBack={vi.fn()} />);
        fireEvent.click(await screen.findByText('Raw sugar'));
        const sugar = card('Raw sugar');
        expect(within(sugar).getByText('Bought on the Grocery List')).toBeInTheDocument();
        expect(within(sugar).getAllByText('1 kg').length).toBeGreaterThan(0);
        expect(document.body).not.toHaveTextContent(/Added from Grocery List purchase/);
        expect(document.body).not.toHaveTextContent(bought);
    });

    it('keeps its name, unit and notes in the Edit sheet, and un-ticking still takes it back out', async () => {
        const bought = await buySugar();
        render(<InventoryList onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Edit Raw sugar' }));
        const sheet = await screen.findByRole('dialog', { name: 'Edit item' });
        expect(within(sheet).getByLabelText(/Item name/)).toBeDisabled();
        expect(within(sheet).getByRole('combobox', { name: 'Unit' })).toBeDisabled();
        expect(within(sheet).queryByLabelText('Notes')).not.toBeInTheDocument();
        expect(sheet).toHaveTextContent('Bought on the Grocery List');
        expect(sheet).toHaveTextContent(/ticking or un-ticking it there still works/);

        // Moving it is fine: only the place is written.
        fireEvent.change(within(sheet).getByLabelText('Zone'), { target: { value: 'Forward locker' } });
        fireEvent.click(within(sheet).getByRole('button', { name: 'Save inventory item changes' }));
        await waitFor(() => expect(stored(bought)?.location_zone).toBe('Forward locker'));
        expect(queued(bought).filter((item) => item.type === 'UPDATE')).toEqual([
            { type: 'UPDATE', location_zone: 'Forward locker', updated_at: expect.any(String) },
        ]);

        await act(async () => {
            await unmarkPurchased(bought, null, me);
        });
        expect(stored(bought)).toBeUndefined();
    });
});
