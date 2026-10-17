/**
 * Scanning finds what you already have (131-B13; binder audit STORES-09,
 * STORES-08, STORES-13).
 *
 * Shane's boxes (126-11) assume it: "New item here" on a box page, scan the
 * spare, and change its count. Before, a barcode already in Stores made a
 * second item. Now the sheet opens the item that has it, and its ± is the
 * page's own: a DELTA in the outbox, and the shopping list when it crosses
 * into Low, exactly as on the cards and the box page.
 *
 * The real Stores page over the real LocalDatabase (memory filesystem), the
 * real LocalInventoryService and the real shopping list (BoxSheet.test.tsx's
 * harness); only the socket, the sync engine and the camera are fakes.
 * Fictional and global: a raw-water impeller, a pump belt labelled in
 * Japanese, 'Lazarette bin B'.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryItem } from '../types';

const camera = vi.hoisted(() => ({ code: null as string | null, problem: null as string | null }));

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
        selector({ settings: { vessel: { name: 'Kestrel' } } }),
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));
// The camera reads whatever the test holds up to it.
vi.mock('../services/native/scanBarcode', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/native/scanBarcode')>()),
    scanBarcode: vi.fn(async () => (camera.code ? { code: camera.code } : { code: null, problem: camera.problem })),
}));

import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import {
    getFullQueue,
    initLocalDatabase,
    mergePulledRecords,
    query,
    updateSyncMeta,
} from '../services/vessel/LocalDatabase';
import { toast } from '../components/Toast';
import { InventoryList } from '../components/vessel/InventoryList';
import { SCAN_DENIED } from '../services/native/scanBarcode';

window.scrollBy = () => undefined;

const NOW = '2026-10-15T01:00:00.000Z';
const LAZARETTE = 'f1e2d3c4-0002-4a5b-8c6d-7e8f9a0b1c02';
const IMPELLER = 'c4d5e6f7-0001-4a5b-8c6d-7e8f9a0b1c01';
const BELT = 'c4d5e6f7-0003-4a5b-8c6d-7e8f9a0b1c03';
const IMPELLER_CODE = '4006381333931';
const BELT_CODE = '4901234567894';
let counter = 0;
let me = '';

function stores(id: string, name: string, quantity: number, min: number, barcode: string, box: string | null) {
    return {
        id,
        user_id: me,
        barcode,
        item_name: name,
        description: null,
        category: 'Engine',
        quantity,
        min_quantity: min,
        unit: 'whole',
        location_zone: box ? 'Lazarette' : 'Engine room',
        location_specific: box ? 'Lazarette bin B' : null,
        expiry_date: null,
        box_id: box,
        created_at: NOW,
        updated_at: NOW,
    } as InventoryItem;
}

async function seed(): Promise<void> {
    await mergePulledRecords('stores_boxes', [
        {
            id: LAZARETTE,
            user_id: me,
            name: 'Lazarette bin B',
            location_zone: 'Lazarette',
            notes: null,
            created_at: NOW,
            updated_at: NOW,
        },
    ]);
    await mergePulledRecords('inventory_items', [
        stores(IMPELLER, 'Raw-water impeller', 3, 2, IMPELLER_CODE, null),
        stores(BELT, '冷却水ポンプ ベルト', 2, 0, BELT_CODE, LAZARETTE),
    ]);
}

const rows = () => query<InventoryItem>('inventory_items', () => true);
const stored = (id: string) => rows().find((row) => row.id === id);
const deltas = (id: string) =>
    getFullQueue()
        .filter((item) => item.table_name === 'inventory_items' && item.record_id === id)
        .map((item) => ({ type: item.mutation_type, ...JSON.parse(item.payload) }));
const groceries = (name: string) =>
    query<{ ingredient_name: string; required_qty: number }>('shopping_list', (row) => row.ingredient_name === name);

beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    vi.mocked(toast.success).mockClear();
    camera.code = null;
    camera.problem = null;
    counter += 1;
    me = `7a8b9c0d-1e2f-4a3b-8c4d-${String(counter).padStart(12, '0')}`;
    act(() => setAuthIdentityScope(me));
    await initLocalDatabase(me);
    localStorage.setItem(authScopedStorageKey('thalassa_inventory_deduped', getAuthIdentityScope()), '1');
    await updateSyncMeta({ optionalTablesReadAt: { stores_boxes: NOW } });
});

afterEach(() => {
    act(() => setAuthIdentityScope(null));
    localStorage.clear();
});

describe('scanning something already in Stores', () => {
    it('New item here on a box page: the scan opens the belt, − takes one as a DELTA, and nothing is made', async () => {
        await seed();
        render(<InventoryList onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Boxes' }));
        fireEvent.click(
            within(await screen.findByRole('dialog', { name: 'Boxes' })).getByRole('button', {
                name: /^Lazarette bin B/,
            }),
        );
        fireEvent.click(
            within(await screen.findByRole('dialog', { name: 'Lazarette bin B' })).getByRole('button', {
                name: 'New item here',
            }),
        );
        const form = await screen.findByRole('dialog', { name: 'Add to Lazarette bin B' });
        camera.code = BELT_CODE;
        fireEvent.click(within(form).getByRole('button', { name: 'Scan barcode' }));

        const found = await screen.findByRole('dialog', { name: '冷却水ポンプ ベルト' });
        expect(found).toHaveTextContent("Already in Ship's Stores");
        fireEvent.click(within(found).getByRole('button', { name: 'Take one 冷却水ポンプ ベルト' }));
        await waitFor(() => expect(within(found).getByLabelText('冷却水ポンプ ベルト: 1')).toBeInTheDocument());

        expect(deltas(BELT)).toEqual([expect.objectContaining({ type: 'DELTA', field: 'quantity', delta: -1 })]);
        expect(stored(BELT)?.quantity).toBe(1);
        expect(rows()).toHaveLength(2);

        // Done: back on the box page, with the count the sheet left.
        fireEvent.click(within(found).getByRole('button', { name: 'Done' }));
        const page = await screen.findByRole('dialog', { name: 'Lazarette bin B' });
        expect(within(page).getByLabelText('冷却水ポンプ ベルト: 1')).toBeInTheDocument();
    });

    it("the page's Add item: − into Low puts it on the shopping list once, as on the cards", async () => {
        await seed();
        render(<InventoryList onBack={vi.fn()} />);
        await screen.findByText('Raw-water impeller');
        fireEvent.click(screen.getByRole('button', { name: /Add item/ }));
        const form = await screen.findByRole('dialog', { name: 'Add item' });
        camera.code = IMPELLER_CODE;
        fireEvent.click(within(form).getByRole('button', { name: 'Scan barcode' }));

        const found = await screen.findByRole('dialog', { name: 'Raw-water impeller' });
        fireEvent.click(within(found).getByRole('button', { name: 'Take one Raw-water impeller' }));
        await waitFor(() => expect(groceries('Raw-water impeller')).toHaveLength(1));
        expect(groceries('Raw-water impeller')[0]).toMatchObject({ required_qty: 1 });
        expect(toast.success).toHaveBeenCalledWith('Raw-water impeller added to the shopping list');
        await waitFor(() => expect(within(found).getByLabelText('Raw-water impeller: 2')).toBeInTheDocument());
        expect(found).toHaveTextContent('Low stock');

        fireEvent.click(within(found).getByRole('button', { name: 'Add one Raw-water impeller' }));
        await waitFor(() => expect(within(found).getByLabelText('Raw-water impeller: 3')).toBeInTheDocument());
        expect(deltas(IMPELLER).map((item) => item.delta)).toEqual([-1, 1]);
        expect(rows()).toHaveLength(2);
    });

    it('a code not in Stores fills the Barcode field, and Add item makes one item with it', async () => {
        await seed();
        render(<InventoryList onBack={vi.fn()} />);
        await screen.findByText('Raw-water impeller');
        fireEvent.click(screen.getByRole('button', { name: /Add item/ }));
        const form = await screen.findByRole('dialog', { name: 'Add item' });
        camera.code = '0012345678905';
        fireEvent.click(within(form).getByRole('button', { name: 'Scan barcode' }));
        await waitFor(() => expect(within(form).getByDisplayValue('0012345678905')).toBeInTheDocument());
        fireEvent.change(within(form).getByLabelText(/Item name/), { target: { value: 'Pencil zinc' } });
        fireEvent.click(within(form).getByRole('button', { name: 'Add item' }));
        await waitFor(() => expect(rows()).toHaveLength(3));
        expect(rows().find((row) => row.item_name === 'Pencil zinc')).toMatchObject({ barcode: '0012345678905' });
    });
});

describe("the Edit sheet's camera button: the same scanner", () => {
    async function openEdit(): Promise<HTMLElement> {
        render(<InventoryList onBack={vi.fn()} />);
        fireEvent.click(await screen.findByText('Raw-water impeller'));
        fireEvent.click(await screen.findByRole('button', { name: 'Edit Raw-water impeller' }));
        return screen.findByRole('dialog', { name: 'Edit item' });
    }

    it('fills the Barcode field', async () => {
        await seed();
        const sheet = await openEdit();
        camera.code = '4006381333948';
        fireEvent.click(within(sheet).getByRole('button', { name: 'Scan barcode with camera' }));
        await waitFor(() => expect(within(sheet).getByLabelText('Barcode')).toHaveValue('4006381333948'));
        expect(within(sheet).queryByRole('alert')).not.toBeInTheDocument();
    });

    it('says why when the camera is refused, instead of doing nothing', async () => {
        await seed();
        const sheet = await openEdit();
        camera.problem = SCAN_DENIED;
        fireEvent.click(within(sheet).getByRole('button', { name: 'Scan barcode with camera' }));
        expect(await within(sheet).findByRole('alert')).toHaveTextContent(SCAN_DENIED);
        expect(within(sheet).getByLabelText('Barcode')).toHaveValue(IMPELLER_CODE);
    });
});
