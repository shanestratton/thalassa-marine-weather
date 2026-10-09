/**
 * Stores edits that don't undo the crew's counting (126-B9c; binder audit
 * 2026-10-09: STORES-04).
 *
 * The ± buttons and the Galley's deductions change a count as a DELTA, so
 * changes made at once add up (20260723102000_inventory_delta_outbox.sql).
 * The edit sheet used to send the count it opened on as an absolute value
 * with every other field: moving 'AA batteries' to another locker put back
 * the count from before the crew took four. Now the sheet sends only what
 * was changed, and a count edit as a delta against the count it opened on.
 *
 * The real LocalDatabase on the mocked (memory) filesystem, under the real
 * LocalInventoryService and the real page; only the socket and the sync
 * engine are fakes (BinderLiveSync.test.tsx's harness). The crew's change
 * comes either through this device's own delta path or from their phone as a
 * realtime row.
 *
 * Fictional stores only, on no particular coast.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { InventoryItem } from '../types';

const rt = vi.hoisted(() => ({
    /** table → the newest open channel's postgres_changes callback */
    bindings: new Map<string, (payload: unknown) => void>(),
}));

vi.mock('../services/supabase', () => ({
    supabase: {
        channel: () => {
            const api = {
                on: (_kind: string, filter: { table: string }, callback: (payload: unknown) => void) => {
                    rt.bindings.set(filter.table, callback);
                    return api;
                },
                subscribe: () => api,
            };
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
import {
    getFullQueue,
    initLocalDatabase,
    mergePulledRecords,
    prunePulledTable,
} from '../services/vessel/LocalDatabase';
import { LocalInventoryService } from '../services/vessel/LocalInventoryService';
import { toast } from '../components/Toast';
import { InventoryList } from '../components/vessel/InventoryList';

// The edit sheet's keyboard scroll calls window.scrollBy, which jsdom lacks.
window.scrollBy = () => undefined;

const NOW = '2026-10-09T01:00:00.000Z';
const REMOVED_NOTHING_SAVED = 'This item was removed on another device. Nothing was saved.';
let accountCounter = 0;

function batteries(owner: string, extra: Partial<InventoryItem> = {}): InventoryItem {
    return {
        id: 's-aa',
        user_id: owner,
        barcode: null,
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

async function signIn(userId: string): Promise<void> {
    act(() => setAuthIdentityScope(userId));
    await initLocalDatabase(userId);
}

/** The crew's change from their phone, as the socket delivers it. */
async function deliverUpdate(row: InventoryItem): Promise<void> {
    await waitFor(() => expect(rt.bindings.has('inventory_items')).toBe(true), { timeout: 5000 });
    const callback = rt.bindings.get('inventory_items')!;
    await act(async () => {
        callback({ eventType: 'UPDATE', new: { ...row, updated_at: new Date().toISOString() }, old: {} });
    });
}

/** Every message any toast showed, in order. */
function toasted(): string[] {
    return [
        ...vi.mocked(toast.success).mock.calls,
        ...vi.mocked(toast.error).mock.calls,
        ...vi.mocked(toast.info).mock.calls,
    ].map((call) => String(call[0]));
}

/** This item's outbox, oldest first: the mutation and its payload. */
function queued(): { type: string; payload: Record<string, unknown> }[] {
    return getFullQueue()
        .filter((item) => item.table_name === 'inventory_items' && item.record_id === 's-aa')
        .map((item) => ({ type: item.mutation_type, payload: JSON.parse(item.payload) }));
}

const stored = () => LocalInventoryService.getItem('s-aa');

async function openEditSheet(): Promise<void> {
    render(<InventoryList onBack={vi.fn()} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Edit AA batteries' }));
    await screen.findByRole('button', { name: 'Save inventory item changes' });
}

async function save(): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: 'Save inventory item changes' }));
    await waitFor(() =>
        expect(screen.queryByRole('button', { name: 'Save inventory item changes' })).not.toBeInTheDocument(),
    );
}

beforeEach(async () => {
    localStorage.clear();
    // The vessel files already live in Library (see LocalDatabaseOutbox.test.ts).
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    rt.bindings.clear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    vi.mocked(toast.info).mockClear();
    accountCounter += 1;
    const me = `skipper-${accountCounter}`;
    await signIn(me);
    // This account's stores were deduplicated long ago.
    localStorage.setItem(`thalassa_inventory_deduped::user%3A${me}`, '1');
    await mergePulledRecords('inventory_items', [batteries(me)]);
});

afterEach(() => {
    act(() => setAuthIdentityScope(null));
    localStorage.clear();
});

describe("a location edit keeps the crew's count", () => {
    it('crew −4 through the delta path while the sheet is open: the save sends the location only', async () => {
        await openEditSheet();
        // The crew take four, through the ± / Galley delta path.
        await act(async () => {
            await LocalInventoryService.adjustQuantity('s-aa', -4);
        });
        fireEvent.change(screen.getByLabelText('Zone'), { target: { value: 'Forward locker' } });
        await save();

        expect(queued()).toEqual([
            { type: 'DELTA', payload: expect.objectContaining({ field: 'quantity', delta: -4 }) },
            { type: 'UPDATE', payload: { location_zone: 'Forward locker', updated_at: expect.any(String) } },
        ]);
        expect(stored()).toMatchObject({ quantity: 8, location_zone: 'Forward locker' });
        expect(toasted()).toContain('Item updated');
    });

    it('crew −4 arriving from their phone: the save sends no count, so the server keeps theirs', async () => {
        await openEditSheet();
        await deliverUpdate(batteries(stored()!.user_id, { quantity: 8 }));
        fireEvent.change(screen.getByLabelText('Zone'), { target: { value: 'Forward locker' } });
        await save();

        expect(queued()).toEqual([
            { type: 'UPDATE', payload: { location_zone: 'Forward locker', updated_at: expect.any(String) } },
        ]);
        expect(stored()).toMatchObject({ quantity: 8, location_zone: 'Forward locker' });
    });
});

describe('a count edit is a change against the count the sheet opened on', () => {
    it('12 → 10 after the crew took 4 is "took 2": a DELTA −2, and the count is 6', async () => {
        await openEditSheet();
        await act(async () => {
            await LocalInventoryService.adjustQuantity('s-aa', -4);
        });
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '10' } });
        await save();

        expect(queued()).toEqual([
            { type: 'DELTA', payload: expect.objectContaining({ field: 'quantity', delta: -4 }) },
            { type: 'DELTA', payload: expect.objectContaining({ field: 'quantity', delta: -2 }) },
        ]);
        expect(stored()!.quantity).toBe(6);
    });

    it('the same edit after a realtime 8 from the crew is a DELTA −2 too', async () => {
        await openEditSheet();
        await deliverUpdate(batteries(stored()!.user_id, { quantity: 8 }));
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '10' } });
        await save();

        expect(queued()).toEqual([
            { type: 'DELTA', payload: expect.objectContaining({ field: 'quantity', delta: -2 }) },
        ]);
        expect(stored()!.quantity).toBe(6);
    });

    it('a count and a location edit together: one DELTA and one UPDATE with no quantity', async () => {
        await openEditSheet();
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '15' } });
        fireEvent.change(screen.getByLabelText('Specific'), { target: { value: 'Bottom drawer' } });
        await save();

        const types = queued().map((item) => item.type);
        expect(types.sort()).toEqual(['DELTA', 'UPDATE']);
        expect(queued().find((item) => item.type === 'DELTA')!.payload).toMatchObject({ delta: 3 });
        expect(queued().find((item) => item.type === 'UPDATE')!.payload).toEqual({
            location_specific: 'Bottom drawer',
            updated_at: expect.any(String),
        });
        expect(stored()).toMatchObject({ quantity: 15, location_specific: 'Bottom drawer' });
    });
});

describe('a count edit is taken once, however Save is pressed', () => {
    it('a double tap on Save for 12 → 10 queues one DELTA −2 and leaves 10', async () => {
        await openEditSheet();
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '10' } });
        const button = screen.getByRole('button', { name: 'Save inventory item changes' });
        // The second tap lands while the first Save is still writing, and
        // before React has re-rendered the button as disabled (one act scope).
        act(() => {
            fireEvent.click(button);
            fireEvent.click(button);
        });
        expect(button).toBeDisabled();
        await waitFor(() =>
            expect(screen.queryByRole('button', { name: 'Save inventory item changes' })).not.toBeInTheDocument(),
        );

        expect(queued()).toEqual([
            { type: 'DELTA', payload: expect.objectContaining({ field: 'quantity', delta: -2 }) },
        ]);
        expect(stored()!.quantity).toBe(10);
    });

    it('a retry after the other fields failed to save does not take the count again', async () => {
        const update = vi.spyOn(LocalInventoryService, 'update').mockRejectedValueOnce(new Error('Disk full'));
        try {
            await openEditSheet();
            fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '10' } });
            fireEvent.change(screen.getByLabelText('Zone'), { target: { value: 'Forward locker' } });
            fireEvent.click(screen.getByRole('button', { name: 'Save inventory item changes' }));
            await waitFor(() => expect(toasted()).toContain('Failed to update item'));
            // The count moved; the sheet stays open for a retry.
            expect(stored()!.quantity).toBe(10);
            expect(screen.getByRole('button', { name: 'Save inventory item changes' })).toBeEnabled();

            await save();

            expect(queued()).toEqual([
                { type: 'DELTA', payload: expect.objectContaining({ field: 'quantity', delta: -2 }) },
                { type: 'UPDATE', payload: { location_zone: 'Forward locker', updated_at: expect.any(String) } },
            ]);
            expect(stored()).toMatchObject({ quantity: 10, location_zone: 'Forward locker' });
            expect(toasted()).toContain('Item updated');
        } finally {
            update.mockRestore();
        }
    });
});

describe('Saves that change nothing, or land on a removed item', () => {
    it('a Save with nothing changed writes nothing and says nothing', async () => {
        await openEditSheet();
        await save();

        expect(queued()).toEqual([]);
        expect(toasted()).toEqual([]);
    });

    it('the row deleted before Save: the removed message, never "Item updated", and nothing queued', async () => {
        await openEditSheet();
        fireEvent.change(screen.getByLabelText('Zone'), { target: { value: 'Forward locker' } });
        fireEvent.change(screen.getByLabelText('Quantity'), { target: { value: '10' } });
        // A sync's deletion sweep removes it here before the page hears of it.
        await act(async () => {
            await prunePulledTable('inventory_items', new Set());
        });
        await save();

        expect(toasted()).toContain(REMOVED_NOTHING_SAVED);
        expect(toasted()).not.toContain('Item updated');
        expect(queued()).toEqual([]);
        await waitFor(() => expect(screen.queryByText('AA batteries')).not.toBeInTheDocument());
    });
});
