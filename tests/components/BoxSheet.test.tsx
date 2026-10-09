/**
 * The box page in Ship's Stores (126-11a): everything in one box, and a −1
 * for the one you took.
 *
 * Shane, 2026-10-09: "it will show me everything that is in that box. if i
 * remove an item from the box, i should just be able to -1 to the item that i
 * took." And what he was told: "When you take the last spare filter, it goes
 * on your shopping list automatically".
 *
 * The real Stores page over the real LocalDatabase (memory filesystem), the
 * real LocalInventoryService and the real shopping list; only the socket and
 * the sync engine are fakes (StoresEditDelta.test.tsx's harness).
 *
 * Fictional and global: 'Engine room spares 3' (Engine room), 'Lazarette bin
 * B' (Lazarette), 'Coffre avant' (Pointe avant); a raw-water impeller (3, min
 * 2), a Racor filter (1, min 1), a pump belt labelled in Japanese (2, min 0).
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryItem } from '../../types';

vi.mock('../../services/supabase', () => ({
    supabase: {
        channel: () => {
            const api = { on: () => api, subscribe: () => api };
            return api;
        },
        removeChannel: vi.fn(),
    },
}));
vi.mock('../../services/vessel/SyncService', () => ({
    onSyncComplete: () => () => undefined,
    onStatusChange: () => () => undefined,
    isFullReconciliationPending: () => false,
    requestFullReconciliation: vi.fn().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] }),
    requestCatchUpSync: vi.fn(),
    syncNow: vi.fn().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] }),
    forceFullPull: vi.fn().mockResolvedValue(0),
}));
vi.mock('../../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: { settings: { vessel: { name: string } } }) => unknown) =>
        selector({ settings: { vessel: { name: 'Kestrel' } } }),
}));
vi.mock('../../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../../services/authIdentityScope';
import { initLocalDatabase, mergePulledRecords, query, updateSyncMeta } from '../../services/vessel/LocalDatabase';
import { reloadSharedBindersFromStorage } from '../../services/vessel/sharedBinders';
import { LocalInventoryService } from '../../services/vessel/LocalInventoryService';
import { toast } from '../../components/Toast';
import { InventoryList } from '../../components/vessel/InventoryList';
import { openBox } from '../../components/vessel/inventory/openBox';

window.scrollBy = () => undefined;

const NOW = '2026-10-10T01:00:00.000Z';
const ENGINE = 'e1e2e3e4-0001-4a5b-8c6d-7e8f9a0b1c01';
const LAZARETTE = 'e1e2e3e4-0002-4a5b-8c6d-7e8f9a0b1c02';
const BOW = 'e1e2e3e4-0003-4a5b-8c6d-7e8f9a0b1c03';
const IMPELLER = 'a1b2c3d4-0001-4a5b-8c6d-7e8f9a0b1c01';
const RACOR = 'a1b2c3d4-0002-4a5b-8c6d-7e8f9a0b1c02';
const BELT = 'a1b2c3d4-0003-4a5b-8c6d-7e8f9a0b1c03';
const SKIPPER = '9a8b7c6d-5e4f-4a3b-8c2d-1e0f9a8b7c6d';
let counter = 0;
let me = '';

function stores(id: string, owner: string, name: string, quantity: number, min: number, box: string | null) {
    return {
        id,
        user_id: owner,
        barcode: null,
        item_name: name,
        description: null,
        category: 'Engine',
        quantity,
        min_quantity: min,
        unit: 'whole',
        location_zone: null,
        location_specific: null,
        expiry_date: null,
        box_id: box,
        created_at: NOW,
        updated_at: NOW,
    } as InventoryItem;
}

const box = (id: string, owner: string, name: string, zone: string) => ({
    id,
    user_id: owner,
    name,
    location_zone: zone,
    notes: null,
    created_at: NOW,
    updated_at: NOW,
});

async function seed(owner: string): Promise<void> {
    await mergePulledRecords('stores_boxes', [
        box(ENGINE, owner, 'Engine room spares 3', 'Engine room'),
        box(LAZARETTE, owner, 'Lazarette bin B', 'Lazarette'),
        box(BOW, owner, 'Coffre avant', 'Pointe avant'),
    ]);
    await mergePulledRecords('inventory_items', [
        stores(IMPELLER, owner, 'Raw-water impeller', 3, 2, ENGINE),
        stores(RACOR, owner, 'Racor 2010PM filter', 1, 1, ENGINE),
        stores(BELT, owner, '冷却水ポンプ ベルト', 2, 0, LAZARETTE),
    ]);
}

function share(write: boolean): void {
    localStorage.setItem(
        authScopedStorageKey('thalassa_shared_binders_v1', getAuthIdentityScope()),
        JSON.stringify({
            version: 1,
            userId: me,
            confirmedAt: NOW,
            skippers: [
                {
                    ownerId: SKIPPER,
                    vesselName: 'Kestrel',
                    lastAcceptedAt: NOW,
                    registers: {
                        stores: { read: true, write },
                        equipment: { read: false, write: false },
                        maintenance: { read: false, write: false },
                        documents: { read: false, write: false },
                    },
                },
            ],
        }),
    );
    act(() => reloadSharedBindersFromStorage());
}

const groceries = (name: string) =>
    query<{ ingredient_name: string; required_qty: number; voyage_id: string | null }>(
        'shopping_list',
        (row) => row.ingredient_name === name,
    );

/** Every file write takes a while, as on a phone with a busy bridge: room for a second tap. */
function slowWrites(): void {
    vi.mocked(Filesystem.writeFile).mockImplementation(
        () => new Promise((resolve) => setTimeout(() => resolve({ uri: 'mock://file' }), 30)),
    );
}

/** Let every queued write (30 ms each, one at a time) land before asserting what did not happen. */
const settle = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 400)));

const listToasts = () =>
    vi.mocked(toast.success).mock.calls.filter(([line]) => /shopping list/.test(String(line))).length;

const boxRows = () => query<{ id: string; name: string }>('stores_boxes', () => true);
const itemRow = (id: string) => query<InventoryItem>('inventory_items', (row) => row.id === id)[0];

async function openBoxFromList(name: string): Promise<HTMLElement> {
    fireEvent.click(await screen.findByRole('button', { name: 'Boxes' }));
    const list = await screen.findByRole('dialog', { name: 'Boxes' });
    fireEvent.click(within(list).getByRole('button', { name: new RegExp(`^${name}`) }));
    return screen.findByRole('dialog', { name });
}

beforeEach(async () => {
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    counter += 1;
    me = `0c1d2e3f-4a5b-4c6d-8e7f-${String(counter).padStart(12, '0')}`;
    act(() => setAuthIdentityScope(me));
    await initLocalDatabase(me);
    localStorage.setItem(authScopedStorageKey('thalassa_inventory_deduped', getAuthIdentityScope()), '1');
    await updateSyncMeta({ optionalTablesReadAt: { stores_boxes: NOW } });
});

afterEach(() => {
    vi.restoreAllMocks();
    act(() => setAuthIdentityScope(null));
    localStorage.clear();
});

describe('the box page', () => {
    it('lists every box with its zone, item count and low count', async () => {
        await seed(me);
        render(<InventoryList onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Boxes' }));
        const list = await screen.findByRole('dialog', { name: 'Boxes' });
        const engine = within(list).getByRole('button', { name: /^Engine room spares 3/ });
        expect(engine).toHaveTextContent('Engine room · 2 items · 1 low');
        expect(within(list).getByRole('button', { name: /^Coffre avant/ })).toHaveTextContent('Pointe avant · 0 items');
    });

    it('− on the impeller at 3 (min 2) takes one, and puts it on the shopping list once, with a toast', async () => {
        await seed(me);
        const adjust = vi.spyOn(LocalInventoryService, 'adjustQuantity');
        render(<InventoryList onBack={vi.fn()} />);
        const page = await openBoxFromList('Engine room spares 3');
        expect(within(page).getByText('Raw-water impeller')).toBeInTheDocument();
        expect(within(page).getByText('Racor 2010PM filter')).toBeInTheDocument();
        expect(within(page).queryByText('冷却水ポンプ ベルト')).not.toBeInTheDocument();

        fireEvent.click(within(page).getByRole('button', { name: 'Take one Raw-water impeller' }));
        await waitFor(() => expect(groceries('Raw-water impeller')).toHaveLength(1));

        expect(adjust).toHaveBeenCalledTimes(1);
        expect(adjust).toHaveBeenCalledWith(IMPELLER, -1);
        expect(groceries('Raw-water impeller')[0]).toMatchObject({ required_qty: 1, voyage_id: null });
        expect(toast.success).toHaveBeenCalledWith('Raw-water impeller added to the shopping list');
        await waitFor(() => expect(within(page).getByLabelText('Raw-water impeller: 2')).toBeInTheDocument());
        expect(within(page).getAllByText('Low').length).toBe(2);

        // A second − takes another, and adds nothing.
        fireEvent.click(within(page).getByRole('button', { name: 'Take one Raw-water impeller' }));
        await waitFor(() => expect(adjust).toHaveBeenCalledTimes(2));
        await waitFor(() => expect(within(page).getByLabelText('Raw-water impeller: 1')).toBeInTheDocument());
        expect(groceries('Raw-water impeller')).toEqual([expect.objectContaining({ required_qty: 1 })]);
        expect(vi.mocked(toast.success).mock.calls.filter(([line]) => /shopping list/.test(String(line)))).toHaveLength(
            1,
        );
    });

    it('two quick − taps are taken one after the other: the second reads the count the first left', async () => {
        await seed(me);
        slowWrites();
        render(<InventoryList onBack={vi.fn()} />);
        const page = await openBoxFromList('Engine room spares 3');
        const take = within(page).getByRole('button', { name: 'Take one Raw-water impeller' });
        // No await between them: a double tap.
        fireEvent.click(take);
        fireEvent.click(take);
        await waitFor(() => expect(within(page).getByLabelText('Raw-water impeller: 1')).toBeInTheDocument());
        await waitFor(() => expect(groceries('Raw-water impeller')).toHaveLength(1));
        await settle();
        // 3 → 2 crossed into Low (1 on the list); 2 → 1 was already Low.
        expect(groceries('Raw-water impeller')).toHaveLength(1);
        expect(groceries('Raw-water impeller')[0]).toMatchObject({ required_qty: 1 });
        expect(listToasts()).toBe(1);
    });

    it('−, + and − again at the minimum leaves one impeller on the list, not two', async () => {
        await seed(me);
        render(<InventoryList onBack={vi.fn()} />);
        const page = await openBoxFromList('Engine room spares 3');
        const step = async (name: string, after: number) => {
            fireEvent.click(within(page).getByRole('button', { name }));
            await waitFor(() =>
                expect(within(page).getByLabelText(`Raw-water impeller: ${after}`)).toBeInTheDocument(),
            );
        };
        await step('Take one Raw-water impeller', 2);
        await waitFor(() => expect(groceries('Raw-water impeller')).toHaveLength(1));
        await step('Add one Raw-water impeller', 3);
        await step('Take one Raw-water impeller', 2);
        await waitFor(() => expect(listToasts()).toBe(1));
        expect(groceries('Raw-water impeller')).toEqual([expect.objectContaining({ required_qty: 1 })]);
    });

    it('taking the last impeller after the crossing tops the list up to 3, not 4', async () => {
        await seed(me);
        render(<InventoryList onBack={vi.fn()} />);
        const page = await openBoxFromList('Engine room spares 3');
        for (const after of [2, 1, 0]) {
            fireEvent.click(within(page).getByRole('button', { name: 'Take one Raw-water impeller' }));
            await waitFor(() =>
                expect(within(page).getByLabelText(`Raw-water impeller: ${after}`)).toBeInTheDocument(),
            );
        }
        await waitFor(() =>
            expect(groceries('Raw-water impeller')).toEqual([expect.objectContaining({ required_qty: 3 })]),
        );
    });

    it('taking the last spare filter puts it on the list', async () => {
        await seed(me);
        render(<InventoryList onBack={vi.fn()} />);
        const page = await openBoxFromList('Engine room spares 3');
        fireEvent.click(within(page).getByRole('button', { name: 'Take one Racor 2010PM filter' }));
        await waitFor(() =>
            expect(groceries('Racor 2010PM filter')).toEqual([expect.objectContaining({ required_qty: 2 })]),
        );
        expect(toast.success).toHaveBeenCalledWith('Racor 2010PM filter added to the shopping list');
        // Nothing left: − is off.
        await waitFor(() =>
            expect(within(page).getByRole('button', { name: 'Take one Racor 2010PM filter' })).toBeDisabled(),
        );
    });

    it('view-only crew see the boxes and counts but no − / +', async () => {
        share(false);
        await seed(SKIPPER);
        render(<InventoryList onBack={vi.fn()} />);
        const page = await openBoxFromList('Engine room spares 3');
        expect(within(page).getByLabelText('Raw-water impeller: 3')).toBeInTheDocument();
        expect(within(page).queryByRole('button', { name: /^Take one/ })).not.toBeInTheDocument();
        expect(within(page).queryByRole('button', { name: /^Add one/ })).not.toBeInTheDocument();
        expect(within(page).queryByRole('button', { name: 'Put items in this box' })).not.toBeInTheDocument();
        expect(within(page).queryByRole('button', { name: 'Edit box' })).not.toBeInTheDocument();
    });

    it('crew who may edit a shared Stores count down, but never fill the skipper’s shopping list', async () => {
        share(true);
        await seed(SKIPPER);
        render(<InventoryList onBack={vi.fn()} />);
        const page = await openBoxFromList('Engine room spares 3');
        fireEvent.click(within(page).getByRole('button', { name: 'Take one Raw-water impeller' }));
        await waitFor(() => expect(within(page).getByLabelText('Raw-water impeller: 2')).toBeInTheDocument());
        expect(groceries('Raw-water impeller')).toEqual([]);
        expect(toast.success).not.toHaveBeenCalledWith(expect.stringMatching(/shopping list/));
    });

    it('a box with nothing in it says so, and offers "Put items in this box"', async () => {
        await seed(me);
        render(<InventoryList onBack={vi.fn()} />);
        const page = await openBoxFromList('Coffre avant');
        expect(within(page).getByText('Nothing in this box yet.')).toBeInTheDocument();
        fireEvent.click(within(page).getByRole('button', { name: 'Put items in this box' }));
        const picker = await screen.findByRole('dialog', { name: 'Put items in Coffre avant' });
        fireEvent.click(within(picker).getByRole('button', { name: /冷却水ポンプ ベルト/ }));
        fireEvent.click(within(picker).getByRole('button', { name: 'Put 1 item in this box' }));
        const after = await screen.findByRole('dialog', { name: 'Coffre avant' });
        await waitFor(() => expect(within(after).getByText('冷却水ポンプ ベルト')).toBeInTheDocument());
        expect(query<InventoryItem>('inventory_items', (row) => row.id === BELT)[0]).toMatchObject({
            box_id: BOW,
            location_zone: 'Pointe avant',
            location_specific: 'Coffre avant',
        });
    });

    it('openBox with an unknown id says the box is not on this phone, and nothing else', async () => {
        await seed(me);
        render(<InventoryList onBack={vi.fn()} />);
        await screen.findByRole('button', { name: 'Boxes' });
        act(() => {
            openBox('f0e1d2c3-b4a5-4968-8776-5a4b3c2d1e0f');
        });
        const page = await screen.findByRole('dialog');
        expect(page).toHaveTextContent("This box isn't in Ship's Stores on this phone.");
        expect(
            within(page)
                .getAllByRole('button')
                .map((button) => button.getAttribute('aria-label')),
        ).toEqual(['Close']);
    });

    it('openBox with a known id opens that box straight away', async () => {
        await seed(me);
        render(<InventoryList onBack={vi.fn()} />);
        await screen.findByRole('button', { name: 'Boxes' });
        act(() => {
            openBox(LAZARETTE);
        });
        const page = await screen.findByRole('dialog', { name: 'Lazarette bin B' });
        expect(within(page).getByText('冷却水ポンプ ベルト')).toBeInTheDocument();
    });
});

describe('making, renaming and deleting a box', () => {
    it('Save box makes one box however fast it is tapped, and opens it straight away', async () => {
        await seed(me);
        slowWrites();
        render(<InventoryList onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Boxes' }));
        fireEvent.click(
            within(await screen.findByRole('dialog', { name: 'Boxes' })).getByRole('button', { name: 'New box' }),
        );
        const form = await screen.findByRole('dialog', { name: 'New box' });
        fireEvent.change(within(form).getByLabelText(/Box name/), { target: { value: 'Caja de popa' } });
        fireEvent.change(within(form).getByLabelText('Zone'), { target: { value: 'Popa' } });
        // The new box opens once the page has it: never a flash of "not on this phone".
        let notHere = false;
        const watch = new MutationObserver(() => {
            notHere ||= !!document.body.textContent?.includes("This box isn't in Ship's Stores on this phone");
        });
        watch.observe(document.body, { childList: true, subtree: true, characterData: true });
        // A page re-read that takes a moment, as on a phone.
        const getAll = LocalInventoryService.getAll.bind(LocalInventoryService);
        vi.spyOn(LocalInventoryService, 'getAll').mockImplementation(
            () => new Promise((resolve) => setTimeout(() => resolve(getAll()), 50)) as never,
        );
        const save = within(form).getByRole('button', { name: 'Save box' });
        fireEvent.click(save);
        fireEvent.click(save);
        const page = await screen.findByRole('dialog', { name: 'Caja de popa' });
        await settle();
        watch.disconnect();
        expect(page).toHaveTextContent('Popa · 0 items');
        expect(notHere).toBe(false);
        expect(boxRows().filter((row) => row.name === 'Caja de popa')).toHaveLength(1);
    });

    it('a rename writes the new name into the place of every item in the box', async () => {
        await seed(me);
        render(<InventoryList onBack={vi.fn()} />);
        const page = await openBoxFromList('Engine room spares 3');
        fireEvent.click(within(page).getByRole('button', { name: 'Edit box' }));
        const form = await screen.findByRole('dialog', { name: 'Edit box' });
        fireEvent.change(within(form).getByLabelText(/Box name/), { target: { value: 'Engine room spares 4' } });
        fireEvent.click(within(form).getByRole('button', { name: 'Save box' }));
        await screen.findByRole('dialog', { name: 'Engine room spares 4' });
        for (const id of [IMPELLER, RACOR]) {
            // Only the name changed, so only Specific is written.
            expect(itemRow(id)).toMatchObject({ box_id: ENGINE, location_specific: 'Engine room spares 4' });
        }
    });

    it('Delete box asks first; Cancel keeps it, and Delete keeps its items, out of the box', async () => {
        await seed(me);
        render(<InventoryList onBack={vi.fn()} />);
        const page = await openBoxFromList('Engine room spares 3');
        fireEvent.click(within(page).getByRole('button', { name: 'Edit box' }));
        const form = await screen.findByRole('dialog', { name: 'Edit box' });
        // One stray tap opens the question, and deletes nothing.
        fireEvent.click(within(form).getByRole('button', { name: 'Delete box (its items stay in Stores)' }));
        let ask = await screen.findByRole('dialog', { name: 'Delete Engine room spares 3?' });
        expect(ask).toHaveTextContent("Its items stay in Ship's Stores, not in a box.");
        expect(boxRows().map((row) => row.id)).toContain(ENGINE);
        fireEvent.click(within(ask).getByRole('button', { name: 'Cancel' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Delete Engine room spares 3?' })).toBeNull());
        expect(boxRows().map((row) => row.id)).toContain(ENGINE);

        fireEvent.click(within(form).getByRole('button', { name: 'Delete box (its items stay in Stores)' }));
        ask = await screen.findByRole('dialog', { name: 'Delete Engine room spares 3?' });
        fireEvent.click(within(ask).getByRole('button', { name: 'Delete box' }));
        const list = await screen.findByRole('dialog', { name: 'Boxes' });
        expect(within(list).queryByRole('button', { name: /^Engine room spares 3/ })).toBeNull();
        expect(boxRows().map((row) => row.id)).not.toContain(ENGINE);
        for (const id of [IMPELLER, RACOR]) expect(itemRow(id)).toMatchObject({ box_id: null });
    });
});

describe('items into and out of boxes', () => {
    it('New item here opens the Add form in the box, at its place, and makes one item however fast it is tapped', async () => {
        await seed(me);
        slowWrites();
        render(<InventoryList onBack={vi.fn()} />);
        const page = await openBoxFromList('Lazarette bin B');
        fireEvent.click(within(page).getByRole('button', { name: 'New item here' }));
        const form = await screen.findByRole('dialog', { name: 'Add to Lazarette bin B' });
        expect(within(form).getByLabelText('Zone')).toHaveValue('Lazarette');
        expect(within(form).getByLabelText('Exact spot')).toHaveValue('Lazarette bin B');
        fireEvent.change(within(form).getByLabelText(/Item name/), { target: { value: 'Hose clamp 40 mm' } });
        const add = within(form).getByRole('button', { name: 'Add item' });
        fireEvent.click(add);
        fireEvent.click(add);
        const back = await screen.findByRole('dialog', { name: 'Lazarette bin B' });
        await waitFor(() => expect(within(back).getByText('Hose clamp 40 mm')).toBeInTheDocument());
        const made = query<InventoryItem>('inventory_items', (row) => row.item_name === 'Hose clamp 40 mm');
        expect(made).toEqual([
            expect.objectContaining({
                box_id: LAZARETTE,
                location_zone: 'Lazarette',
                location_specific: 'Lazarette bin B',
            }),
        ]);
        // No currency or other regional default is invented for it.
        expect(made[0]).not.toHaveProperty('currency');
    });

    it('the Add item button on the page itself is not in a box', async () => {
        await seed(me);
        render(<InventoryList onBack={vi.fn()} />);
        const page = await openBoxFromList('Lazarette bin B');
        fireEvent.click(within(page).getByRole('button', { name: 'New item here' }));
        fireEvent.click(
            within(await screen.findByRole('dialog', { name: 'Add to Lazarette bin B' })).getByRole('button', {
                name: 'Cancel adding item',
            }),
        );
        // Back to the box, then back to the Boxes list, then closed.
        for (const name of ['Lazarette bin B', 'Boxes']) {
            fireEvent.click(within(await screen.findByRole('dialog', { name })).getByRole('button', { name: 'Close' }));
        }
        await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
        fireEvent.click(screen.getByRole('button', { name: /Add item/ }));
        const form = await screen.findByRole('dialog', { name: 'Add item' });
        expect(within(form).getByLabelText('Zone')).toHaveValue('');
    });

    it('the Edit sheet moves an item to another box; typing a new Zone takes it out of its box', async () => {
        await seed(me);
        render(<InventoryList onBack={vi.fn()} />);
        const openEdit = async () => {
            fireEvent.click(await screen.findByText('冷却水ポンプ ベルト'));
            fireEvent.click(await screen.findByRole('button', { name: 'Edit 冷却水ポンプ ベルト' }));
            return screen.findByRole('dialog', { name: 'Edit item' });
        };
        let sheet = await openEdit();
        const picker = within(sheet).getByRole('combobox', { name: 'Box' });
        expect(picker).toHaveValue(LAZARETTE);
        fireEvent.change(picker, { target: { value: BOW } });
        expect(within(sheet).getByLabelText('Zone')).toHaveValue('Pointe avant');
        fireEvent.click(within(sheet).getByRole('button', { name: 'Save inventory item changes' }));
        await waitFor(() =>
            expect(itemRow(BELT)).toMatchObject({
                box_id: BOW,
                location_zone: 'Pointe avant',
                location_specific: 'Coffre avant',
            }),
        );

        sheet = await openEdit();
        fireEvent.change(within(sheet).getByLabelText('Zone'), { target: { value: 'Cockpit locker' } });
        expect(within(sheet).getByRole('combobox', { name: 'Box' })).toHaveValue('');
        fireEvent.click(within(sheet).getByRole('button', { name: 'Save inventory item changes' }));
        await waitFor(() => expect(itemRow(BELT)).toMatchObject({ box_id: null, location_zone: 'Cockpit locker' }));
    });
});

describe('the Boxes button', () => {
    it('is there with nothing in Stores yet, so boxes can be set up first', async () => {
        render(<InventoryList onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Boxes' }));
        expect(await screen.findByRole('dialog', { name: 'Boxes' })).toHaveTextContent('No boxes yet.');
        expect(screen.queryByRole('textbox', { name: 'Search stores' })).toBeNull();
    });

    it('signed out, it says to sign in (no server update will change that)', async () => {
        act(() => setAuthIdentityScope(null));
        await initLocalDatabase(null);
        render(<InventoryList onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Boxes' }));
        const list = await screen.findByRole('dialog', { name: 'Boxes' });
        expect(list).toHaveTextContent('Sign in to use boxes.');
        expect(list).not.toHaveTextContent('next server update');
    });
});

describe('before the server has boxes', () => {
    it('the Boxes button says they arrive with the next server update, and writes nothing', async () => {
        await updateSyncMeta({ optionalTablesReadAt: {} });
        await mergePulledRecords('inventory_items', [stores(IMPELLER, me, 'Raw-water impeller', 3, 2, null)]);
        render(<InventoryList onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Boxes' }));
        const list = await screen.findByRole('dialog', { name: 'Boxes' });
        expect(list).toHaveTextContent('Boxes arrive with the next server update.');
        expect(within(list).queryByRole('button', { name: 'New box' })).not.toBeInTheDocument();
    });
});
