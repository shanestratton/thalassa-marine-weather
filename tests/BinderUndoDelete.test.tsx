/**
 * Deletes you can trust in Stores, Equipment, Maintenance and Documents
 * (126-B10a; binder audit 2026-10-09: STORES-03, MAINT-08, DOC-7, EQ-1).
 *
 * BinderLiveSync.test.tsx's harness: the real LocalDatabase (Filesystem is the
 * global mock) under the real Local*Service binder reads and the real pages;
 * only the socket and the sync engine are fakes. The services' deletes are
 * spied on, not replaced, so a committed delete really leaves the database.
 *
 * Fictional gear only, on no particular coast.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import type { EquipmentItem, InventoryItem, MaintenanceTask, ShipDocument } from '../types';

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
vi.mock('../services/vessel/DocumentSyncService', () => ({
    DocumentSyncService: {
        pullFromCloud: vi.fn().mockResolvedValue(0),
        getDownloadUrl: vi.fn(async (uri: string) => uri),
        openDownload: vi.fn().mockResolvedValue(undefined),
        markForSync: vi.fn(),
        markDeleted: vi.fn(),
        pendingCount: 0,
    },
}));
// The swipe is a native touch gesture: every card here is swiped open, so its
// Delete is the named button VoiceOver reads.
vi.mock('../hooks/useSwipeable', () => ({
    useSwipeable: () => ({ swipeOffset: 100, isSwiping: false, resetSwipe: () => undefined, ref: () => undefined }),
}));
vi.mock('../services/MaintenancePdfService', () => ({ exportChecklist: vi.fn(), exportServiceHistory: vi.fn() }));
vi.mock('../utils/equipmentPdfExport', () => ({ exportEquipmentPdf: vi.fn().mockResolvedValue(undefined) }));
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
import { getFullQueue, initLocalDatabase, mergePulledRecords, removeSynced } from '../services/vessel/LocalDatabase';
import { LocalInventoryService } from '../services/vessel/LocalInventoryService';
import { LocalEquipmentService } from '../services/vessel/LocalEquipmentService';
import { LocalMaintenanceService } from '../services/vessel/LocalMaintenanceService';
import { LocalDocumentService } from '../services/vessel/LocalDocumentService';
import { DocumentSyncService } from '../services/vessel/DocumentSyncService';
import { toast } from '../components/Toast';
import { InventoryList } from '../components/vessel/InventoryList';
import { EquipmentList } from '../components/vessel/EquipmentList';
import { MaintenanceHub } from '../components/vessel/MaintenanceHub';
import { DocumentsHub } from '../components/vessel/DocumentsHub';

const NOW = '2026-10-09T01:00:00.000Z';
let accountCounter = 0;

type Row = { id: string };

interface BinderCase {
    label: string;
    table: string;
    page: () => React.ReactElement;
    row: (id: string, owner: string, name: string) => Row;
    /** The three rows' names: A is the one deleted first, B the second. */
    names: [a: string, b: string, c: string];
    spy: () => MockInstance;
    stored: () => string[];
    restoredToast: string;
    /** Delete a row the way the skipper does on this page. */
    remove: (name: string) => void;
    prepare?: (me: string) => void;
}

const swipeDelete = (name: string) => fireEvent.click(screen.getByRole('button', { name: `Delete ${name}` }));

const CASES: BinderCase[] = [
    {
        label: "Ship's Stores",
        table: 'inventory_items',
        page: () => <InventoryList onBack={vi.fn()} />,
        row: (id, owner, name) =>
            ({
                id,
                user_id: owner,
                barcode: null,
                item_name: name,
                description: null,
                category: 'Provisions',
                quantity: 2,
                min_quantity: 0,
                unit: 'L',
                location_zone: 'Galley',
                location_specific: null,
                expiry_date: null,
                created_at: NOW,
                updated_at: NOW,
            }) as InventoryItem,
        names: ['UHT milk', 'Rice', 'Flour'],
        spy: () => vi.spyOn(LocalInventoryService, 'delete'),
        stored: () => LocalInventoryService.getAll().map((row) => row.item_name),
        restoredToast: 'Item restored',
        remove: swipeDelete,
    },
    {
        label: 'Equipment',
        table: 'equipment_register',
        page: () => <EquipmentList onBack={vi.fn()} />,
        row: (id, owner, name): EquipmentItem => ({
            id,
            user_id: owner,
            equipment_name: name,
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
        }),
        names: ['Watermaker', 'Windlass', 'Deck wash pump'],
        spy: () => vi.spyOn(LocalEquipmentService, 'delete'),
        stored: () => LocalEquipmentService.getAll().map((row) => row.equipment_name),
        restoredToast: 'Equipment restored',
        remove: (name) => {
            fireEvent.click(screen.getByRole('button', { name: `Options for ${name}` }));
            fireEvent.click(screen.getByRole('button', { name: `Delete ${name}` }));
        },
    },
    {
        label: 'Maintenance',
        table: 'maintenance_tasks',
        page: () => <MaintenanceHub onBack={vi.fn()} />,
        row: (id, owner, title): MaintenanceTask => ({
            id,
            user_id: owner,
            title,
            description: null,
            category: 'Engine',
            trigger_type: 'monthly',
            interval_value: 30,
            next_due_date: '2026-11-01',
            next_due_hours: null,
            last_completed: null,
            is_active: true,
            created_at: NOW,
            updated_at: NOW,
        }),
        names: ['Service Engine (Oil / Filters / Zincs)', 'Bilge pump test', 'Raw water strainer'],
        spy: () => vi.spyOn(LocalMaintenanceService, 'deleteTask'),
        stored: () => LocalMaintenanceService.getTasks().map((row) => row.title),
        restoredToast: 'Task restored',
        remove: swipeDelete,
        // Seeded once already, so the empty-binder seeding stays out of it.
        prepare: (me) => localStorage.setItem(`thalassa_maintenance_seeded::user%3A${me}`, '1'),
    },
    {
        label: 'Documents',
        table: 'ship_documents',
        page: () => <DocumentsHub onBack={vi.fn()} />,
        row: (id, owner, name): ShipDocument => ({
            id,
            user_id: owner,
            document_name: name,
            category: 'Insurance',
            issue_date: null,
            expiry_date: null,
            file_uri: null,
            notes: null,
            created_at: NOW,
            updated_at: NOW,
        }),
        names: ['Hull insurance', 'Liability cover', 'Tender insurance'],
        spy: () => vi.spyOn(LocalDocumentService, 'delete'),
        stored: () => LocalDocumentService.getAll().map((row) => row.document_name),
        restoredToast: 'Document restored',
        remove: swipeDelete,
    },
];

const idOf = (name: string) => `row-${name.toLowerCase().replace(/[^a-z]+/g, '-')}`;

/** Let the page's promises and zero-delay timers run (setTimeout is faked). */
async function settle(): Promise<void> {
    for (let i = 0; i < 5; i++) {
        await act(async () => {
            await vi.advanceTimersByTimeAsync(0);
        });
    }
}

async function advance(ms: number): Promise<void> {
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ms);
    });
    await settle();
}

/** Another device saves a row: the socket's UPDATE reloads the page's rows. */
async function otherDeviceSaves(c: BinderCase, me: string, name: string, newName: string): Promise<void> {
    const callback = rt.bindings.get(c.table)!;
    await act(async () => {
        callback({
            eventType: 'UPDATE',
            new: { ...c.row(idOf(name), me, newName), updated_at: new Date().toISOString() },
            old: {},
        });
    });
    await settle();
}

/** Another device adds a row: the socket's INSERT reloads the page's rows. */
async function otherDeviceAdds(c: BinderCase, me: string, id: string, name: string): Promise<void> {
    const callback = rt.bindings.get(c.table)!;
    await act(async () => {
        callback({
            eventType: 'INSERT',
            new: { ...c.row(id, me, name), updated_at: new Date().toISOString() },
            old: {},
        });
    });
    await settle();
}

/** The sync engine pushes this table's queued changes (the delete reaches the server). */
async function pushOutbox(c: BinderCase): Promise<void> {
    await act(async () => {
        await removeSynced(
            getFullQueue()
                .filter((item) => item.table_name === c.table)
                .map((item) => item.id),
        );
    });
}

/** Open the page on three rows, then fake the clock once the socket has joined. */
async function open(
    c: BinderCase,
    fake: ('setTimeout' | 'clearTimeout' | 'Date')[] = ['setTimeout', 'clearTimeout'],
): Promise<{ me: string; unmount: () => void; spy: MockInstance }> {
    const me = `skipper-${accountCounter}`;
    act(() => setAuthIdentityScope(me));
    await initLocalDatabase(me);
    c.prepare?.(me);
    await mergePulledRecords(
        c.table,
        c.names.map((name) => c.row(idOf(name), me, name)),
    );
    const spy = c.spy();
    const view = render(c.page());
    for (const name of c.names) await screen.findByText(name);
    // The hook subscribes after a real delay; join before the clock is faked.
    await waitFor(() => expect(rt.bindings.has(c.table)).toBe(true), { timeout: 5000 });
    vi.useFakeTimers({ toFake: fake });
    return { me, unmount: view.unmount, spy };
}

const deletedIds = (spy: MockInstance) => spy.mock.calls.map(([id]) => id);
const onScreen = (names: readonly string[]) =>
    screen
        .queryAllByText(
            (_, element) => !!element && names.includes(element.textContent ?? '') && !element.children.length,
        )
        .map((element) => element.textContent);

const clickUndo = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'Undo delete action' }));
    await settle();
};

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    vi.mocked(DocumentSyncService.markDeleted).mockClear();
    vi.mocked(toast.success).mockClear();
    vi.mocked(toast.error).mockClear();
    rt.bindings.clear();
    accountCounter += 1;
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    act(() => setAuthIdentityScope(null));
    localStorage.clear();
});

describe.each(CASES)('$label: a delete you can trust', (c) => {
    const [a, b, other] = c.names;

    it('a delete is not lost when the page closes inside the five seconds', async () => {
        const { unmount, spy } = await open(c);
        c.remove(a);
        await advance(2_000);
        expect(spy).not.toHaveBeenCalled();

        unmount();
        await settle();
        expect(deletedIds(spy)).toEqual([idOf(a)]);
        expect(c.stored()).not.toContain(a);
        if (c.table === 'ship_documents') {
            // The cloud copy is deleted too, though the page has gone.
            expect(DocumentSyncService.markDeleted).toHaveBeenCalledWith(idOf(a));
        }
    });

    it('a change saved on another device does not bring the deleted row back', async () => {
        const { me } = await open(c);
        c.remove(a);
        await settle();
        expect(onScreen([a])).toEqual([]);

        await otherDeviceSaves(c, me, b, `${b} (renamed)`);
        expect(screen.getByText(`${b} (renamed)`)).toBeInTheDocument();
        expect(onScreen([a])).toEqual([]);
        expect(screen.getByText(`"${a}" deleted`)).toBeInTheDocument();
    });

    it('Undo after a reload brings back exactly one row, in its place', async () => {
        const { me, spy } = await open(c);
        const before = onScreen(c.names);
        c.remove(a);
        await settle();
        await otherDeviceSaves(c, me, other, other);

        await clickUndo();
        expect(onScreen([a])).toEqual([a]);
        expect(onScreen(c.names)).toEqual(before);
        expect(toast.success).toHaveBeenCalledWith(c.restoredToast);

        await advance(10_000);
        expect(spy).not.toHaveBeenCalled();
        expect(c.stored()).toContain(a);
    });

    it('Undo, then another delete: only the second row is deleted', async () => {
        const { spy } = await open(c);
        c.remove(a);
        await settle();
        await clickUndo();
        expect(onScreen([a])).toEqual([a]);

        c.remove(b);
        await advance(6_000);
        expect(deletedIds(spy)).toEqual([idOf(b)]);
        expect(c.stored()).toContain(a);
        expect(c.stored()).not.toContain(b);
        expect(onScreen([a])).toEqual([a]);
        expect(onScreen([b])).toEqual([]);
    });

    it('a second delete commits the first at once and gets its own five seconds', async () => {
        const { spy } = await open(c);
        c.remove(a);
        await advance(3_000);
        expect(spy).not.toHaveBeenCalled();

        c.remove(b);
        await settle();
        expect(deletedIds(spy)).toEqual([idOf(a)]);
        expect(screen.getByText(`"${b}" deleted`)).toBeInTheDocument();

        // Five seconds after the FIRST delete: the second still has its undo.
        await advance(2_000);
        expect(deletedIds(spy)).toEqual([idOf(a)]);
        await advance(2_900);
        expect(deletedIds(spy)).toEqual([idOf(a)]);
        await advance(100);
        expect(deletedIds(spy)).toEqual([idOf(a), idOf(b)]);
        expect(onScreen([a, b])).toEqual([]);
    });
});

// After the commit (review, 2026-10-10): a committed row's id is let go once
// the page has reloaded without it. A Stores receipt row keeps its Grocery
// List purchase's id, so a purchase ticked again on another device comes back
// under the deleted row's id, and must show.
describe.each(CASES)('$label: after the delete is made', (c) => {
    const [a, b] = c.names;

    it("a row added again under the deleted row's id shows, after a reload without it", async () => {
        const { me } = await open(c);
        c.remove(a);
        await advance(5_000);
        await otherDeviceSaves(c, me, b, `${b} (renamed)`);
        expect(onScreen([a])).toEqual([]);

        await pushOutbox(c);
        await otherDeviceAdds(c, me, idOf(a), `${a} (again)`);
        expect(screen.getByText(`${a} (again)`)).toBeInTheDocument();
    });

    it("a row added again under the deleted row's id shows, with no other reload between", async () => {
        const { me } = await open(c);
        c.remove(a);
        await advance(5_000);
        expect(onScreen([a])).toEqual([]);

        await pushOutbox(c);
        await otherDeviceAdds(c, me, idOf(a), `${a} (again)`);
        expect(screen.getByText(`${a} (again)`)).toBeInTheDocument();
    });

    it('a catch-up pull that still has the deleted row does not bring it back', async () => {
        const { me } = await open(c);
        c.remove(a);
        await advance(5_000);
        // The delete is still queued here: the pull's copy is older news.
        await act(async () => {
            await mergePulledRecords(c.table, [c.row(idOf(a), me, a)]);
        });
        await otherDeviceSaves(c, me, b, `${b} (renamed)`);
        expect(onScreen([a])).toEqual([]);
        expect(c.stored()).not.toContain(a);
    });
});

describe("Ship's Stores header", () => {
    it('counts what is on screen: "2 items" while UHT milk waits to be deleted', async () => {
        await open(CASES[0]);
        expect(screen.getByText(/^3 items · 6 units/)).toBeInTheDocument();

        CASES[0].remove('UHT milk');
        await settle();
        expect(screen.getByText(/^2 items · 4 units/)).toBeInTheDocument();

        await clickUndo();
        expect(screen.getByText(/^3 items · 6 units/)).toBeInTheDocument();
    });
});

describe("Ship's Stores scanner", () => {
    it('Add item makes a delete waiting out its undo at once, so the scanner cannot restock it', async () => {
        // The scanner's form keeps its field above the keyboard; jsdom has no scrollBy.
        vi.spyOn(window, 'scrollBy').mockImplementation(() => undefined);
        const { spy } = await open(CASES[0]);
        CASES[0].remove('UHT milk');
        await settle();
        expect(spy).not.toHaveBeenCalled();

        fireEvent.click(screen.getByRole('button', { name: /Add item/ }));
        await settle();
        expect(deletedIds(spy)).toEqual([idOf('UHT milk')]);
        expect(CASES[0].stored()).not.toContain('UHT milk');
        await advance(10_000);
        expect(deletedIds(spy)).toEqual([idOf('UHT milk')]);
    });
});

describe('Equipment toast after the detail view', () => {
    it('comes back with the time that is left, not a fresh five seconds', async () => {
        await open(CASES[1], ['setTimeout', 'clearTimeout', 'Date']);
        CASES[1].remove('Watermaker');
        await advance(1_000);
        fireEvent.click(screen.getByRole('button', { name: 'Options for Windlass' }));
        fireEvent.click(screen.getByRole('button', { name: 'View details for Windlass' }));
        await settle();
        expect(screen.queryByText('"Watermaker" deleted')).not.toBeInTheDocument();

        await advance(3_000);
        fireEvent.click(screen.getByRole('button', { name: 'Back to equipment list' }));
        await settle();
        expect(screen.getByText('"Watermaker" deleted')).toBeInTheDocument();
        const bar = document.querySelector<HTMLElement>('[style*="undoProgress"]')!;
        expect(bar.style.animation).toContain('-4000ms');
    });
});

describe('Documents selection', () => {
    it('a deleted document leaves the selection', async () => {
        await open(CASES[3]);
        fireEvent.click(screen.getByRole('button', { name: 'Select Hull insurance' }));
        expect(screen.getByText(/1 selected/)).toBeInTheDocument();

        CASES[3].remove('Hull insurance');
        await settle();
        expect(screen.queryByText(/selected/)).not.toBeInTheDocument();
        expect(screen.getByText(/^2 items/)).toBeInTheDocument();
    });
});
