/**
 * Binders live across devices (Shane, 2026-10-02: "if i change something on
 * one machine, it is not reflected in the other").
 *
 * The real chain, end to end: a realtime payload from the socket goes into the
 * real LocalDatabase (Filesystem is mocked), through the real Local*Service
 * binder read (sharedBinders.ts rules), onto the open page. Only the socket
 * and the sync engine are fakes.
 * No real accounts or boats: 'user-1', 'crew-1', 'skipper-1', 'skipper-2'.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EquipmentItem, InventoryItem, MaintenanceHistory, MaintenanceTask, ShipDocument } from '../types';

type Payload = {
    eventType: 'INSERT' | 'UPDATE' | 'DELETE';
    new: Record<string, unknown>;
    old: Record<string, unknown>;
};

const rt = vi.hoisted(() => ({
    /** table → the newest open channel's postgres_changes callback */
    bindings: new Map<string, (payload: unknown) => void>(),
    channelNames: [] as string[],
    /** channel name → its subscribe status callback */
    statusCallbacks: new Map<string, (status: string) => void>(),
    removeChannel: vi.fn(),
}));

const sync = vi.hoisted(() => ({
    completeListeners: [] as ((result: Record<string, unknown>) => void)[],
    requestCatchUpSync: vi.fn(),
}));

const shimmer = vi.hoisted(() => ({ mounts: 0 }));

vi.mock('../services/supabase', () => ({
    supabase: {
        channel: (name: string) => {
            rt.channelNames.push(name);
            const api = {
                on: (_kind: string, filter: { table: string }, callback: (payload: unknown) => void) => {
                    rt.bindings.set(filter.table, callback);
                    return api;
                },
                subscribe: (onStatus?: (status: string) => void) => {
                    if (onStatus) rt.statusCallbacks.set(name, onStatus);
                    return api;
                },
            };
            return api;
        },
        removeChannel: rt.removeChannel,
    },
}));

vi.mock('../services/vessel/SyncService', () => ({
    onSyncComplete: (listener: (typeof sync.completeListeners)[number]) => {
        sync.completeListeners.push(listener);
        return () => {
            sync.completeListeners = sync.completeListeners.filter((candidate) => candidate !== listener);
        };
    },
    onStatusChange: () => () => undefined,
    isFullReconciliationPending: () => false,
    requestFullReconciliation: vi.fn().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] }),
    requestCatchUpSync: sync.requestCatchUpSync,
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
vi.mock('../components/ui/ShimmerBlock', () => ({
    ShimmerBlock: () => {
        React.useEffect(() => {
            shimmer.mounts += 1;
        }, []);
        return <div data-testid="shimmer" />;
    },
}));
vi.mock('../services/MaintenancePdfService', () => ({ exportChecklist: vi.fn(), exportServiceHistory: vi.fn() }));
vi.mock('../utils/equipmentPdfExport', () => ({ exportEquipmentPdf: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: { settings: { vessel: { name: string } } }) => unknown) =>
        selector({ settings: { vessel: { name: 'Own Boat' } } }),
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
    updateSyncMeta,
} from '../services/vessel/LocalDatabase';
import { reloadSharedBindersFromStorage, selectBinderSkipper } from '../services/vessel/sharedBinders';
import { InventoryList } from '../components/vessel/InventoryList';
import { EquipmentList } from '../components/vessel/EquipmentList';
import { MaintenanceHub } from '../components/vessel/MaintenanceHub';
import { DocumentsHub } from '../components/vessel/DocumentsHub';

const NOW = '2026-10-02T01:00:00.000Z';
let accountCounter = 0;

function stores(id: string, owner: string, name: string): InventoryItem {
    return {
        id,
        user_id: owner,
        barcode: null,
        item_name: name,
        description: null,
        category: 'Provisions',
        quantity: 2,
        min_quantity: 0,
        unit: 'kg',
        location_zone: 'Galley',
        location_specific: null,
        expiry_date: null,
        created_at: NOW,
        updated_at: NOW,
    } as InventoryItem;
}

function equipment(id: string, owner: string, name: string): EquipmentItem {
    return {
        id,
        user_id: owner,
        equipment_name: name,
        category: 'Electronics',
        make: 'Make',
        model: 'Model',
        serial_number: 'SN-TEST',
        installation_date: null,
        warranty_expiry: null,
        manual_uri: null,
        notes: null,
        created_at: NOW,
        updated_at: NOW,
    };
}

function task(id: string, owner: string, title: string): MaintenanceTask {
    return {
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
    };
}

function history(id: string, owner: string, taskId: string, notes: string): MaintenanceHistory {
    return {
        id,
        user_id: owner,
        task_id: taskId,
        completed_at: NOW,
        engine_hours_at_service: null,
        notes,
        cost: null,
        created_at: NOW,
    };
}

function shipDocument(id: string, owner: string, name: string): ShipDocument {
    return {
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
    };
}

/** A fresh, empty account per test: the mocked filesystem lists no files. */
async function signIn(userId: string): Promise<void> {
    act(() => setAuthIdentityScope(userId));
    await initLocalDatabase(userId);
}

async function channelFor(table: string): Promise<(payload: unknown) => void> {
    // The hook subscribes after a real 300 ms delay; CI runs this file in
    // parallel with coverage on small runners, so allow well past waitFor's 1 s.
    await waitFor(() => expect(rt.bindings.has(table)).toBe(true), { timeout: 5000 });
    return rt.bindings.get(table)!;
}

/** What the socket delivers: the row for INSERT/UPDATE, its id for DELETE. */
async function deliver(table: string, eventType: Payload['eventType'], row: { id: string }): Promise<void> {
    const callback = await channelFor(table);
    const payload: Payload =
        eventType === 'DELETE'
            ? { eventType, new: {}, old: { id: row.id } }
            : { eventType, new: { ...row, updated_at: new Date().toISOString() }, old: {} };
    await act(async () => {
        callback(payload);
    });
}

function share(
    skippers: {
        ownerId: string;
        registers: Partial<Record<'stores' | 'equipment' | 'maintenance' | 'documents', boolean>>;
    }[],
): void {
    const access = (on: boolean | undefined) => ({ read: !!on, write: !!on });
    act(() => {
        localStorage.setItem(
            'thalassa_shared_binders_v1::user%3Acrew-1',
            JSON.stringify({
                version: 1,
                userId: 'crew-1',
                confirmedAt: '2026-10-02T00:00:00.000Z',
                skippers: skippers.map((skipper, index) => ({
                    ownerId: skipper.ownerId,
                    vesselName: `Test Boat ${index + 1}`,
                    lastAcceptedAt: `2026-10-0${index + 1}T00:00:00.000Z`,
                    registers: {
                        stores: access(skipper.registers.stores),
                        equipment: access(skipper.registers.equipment),
                        maintenance: access(skipper.registers.maintenance),
                        documents: access(skipper.registers.documents),
                    },
                })),
            }),
        );
        reloadSharedBindersFromStorage();
    });
}

beforeEach(() => {
    localStorage.clear();
    // The vessel files already live in Library (see LocalDatabaseOutbox.test.ts).
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    rt.bindings.clear();
    rt.channelNames = [];
    rt.statusCallbacks.clear();
    rt.removeChannel.mockClear();
    sync.completeListeners = [];
    sync.requestCatchUpSync.mockClear();
    shimmer.mounts = 0;
    accountCounter += 1;
});

afterEach(() => {
    act(() => setAuthIdentityScope(null));
    localStorage.clear();
});

describe('an open binder follows changes made on another device', () => {
    it("Ship's Stores: INSERT appears, UPDATE changes it, DELETE removes it, with no shimmer", async () => {
        const me = `user-${accountCounter}`;
        await signIn(me);
        await mergePulledRecords('inventory_items', [stores('s-rice', me, 'Rice')]);
        render(<InventoryList onBack={vi.fn()} />);
        await screen.findByText('Rice');
        const shimmerMountsAfterFirstLoad = shimmer.mounts;

        await deliver('inventory_items', 'INSERT', stores('s-flour', me, 'Flour'));
        expect(await screen.findByText('Flour')).toBeInTheDocument();

        await deliver('inventory_items', 'UPDATE', stores('s-flour', me, 'Wholemeal flour'));
        expect(await screen.findByText('Wholemeal flour')).toBeInTheDocument();
        expect(screen.queryByText('Flour')).not.toBeInTheDocument();

        await deliver('inventory_items', 'DELETE', { id: 's-flour' });
        await waitFor(() => expect(screen.queryByText('Wholemeal flour')).not.toBeInTheDocument());

        // A live update never collapses the list into the loading shimmer
        // (that threw away the reader's scroll position on every change).
        expect(shimmer.mounts).toBe(shimmerMountsAfterFirstLoad);
        expect(screen.getByText('Rice')).toBeInTheDocument();
    });

    it('Equipment: INSERT appears, UPDATE changes it, DELETE removes it', async () => {
        const me = `user-${accountCounter}`;
        await signIn(me);
        render(<EquipmentList onBack={vi.fn()} />);

        await deliver('equipment_register', 'INSERT', equipment('e-vhf', me, 'VHF radio'));
        expect(await screen.findByText('VHF radio')).toBeInTheDocument();

        await deliver('equipment_register', 'UPDATE', equipment('e-vhf', me, 'DSC VHF radio'));
        expect(await screen.findByText('DSC VHF radio')).toBeInTheDocument();

        await deliver('equipment_register', 'DELETE', { id: 'e-vhf' });
        await waitFor(() => expect(screen.queryByText('DSC VHF radio')).not.toBeInTheDocument());
    });

    it('Documents: INSERT appears, UPDATE changes it, DELETE removes it', async () => {
        const me = `user-${accountCounter}`;
        await signIn(me);
        render(<DocumentsHub onBack={vi.fn()} />);

        await deliver('ship_documents', 'INSERT', shipDocument('d-ins', me, 'Hull insurance'));
        expect(await screen.findByText('Hull insurance')).toBeInTheDocument();

        await deliver('ship_documents', 'UPDATE', shipDocument('d-ins', me, 'Hull and liability insurance'));
        expect(await screen.findByText('Hull and liability insurance')).toBeInTheDocument();

        await deliver('ship_documents', 'DELETE', { id: 'd-ins' });
        await waitFor(() => expect(screen.queryByText('Hull and liability insurance')).not.toBeInTheDocument());
    });

    it('R&M tasks: INSERT appears, UPDATE changes it, DELETE removes it, with no shimmer', async () => {
        const me = `user-${accountCounter}`;
        await signIn(me);
        // Seeded once already, so the empty-binder seeding stays out of it.
        localStorage.setItem(`thalassa_maintenance_seeded::user%3A${me}`, '1');
        await mergePulledRecords('maintenance_tasks', [task('t-bilge', me, 'Bilge pump test')]);
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Bilge pump test');
        const shimmerMountsAfterFirstLoad = shimmer.mounts;

        await deliver('maintenance_tasks', 'INSERT', task('t-oil', me, 'Oil change'));
        expect(await screen.findByText('Oil change')).toBeInTheDocument();

        await deliver('maintenance_tasks', 'UPDATE', task('t-oil', me, 'Oil and filter change'));
        expect(await screen.findByText('Oil and filter change')).toBeInTheDocument();

        await deliver('maintenance_tasks', 'DELETE', { id: 't-oil' });
        await waitFor(() => expect(screen.queryByText('Oil and filter change')).not.toBeInTheDocument());

        expect(shimmer.mounts).toBe(shimmerMountsAfterFirstLoad);
    });

    it('R&M listens to tasks AND history on one channel, and an open Service history follows it', async () => {
        const me = `user-${accountCounter}`;
        await signIn(me);
        localStorage.setItem(`thalassa_maintenance_seeded::user%3A${me}`, '1');
        await mergePulledRecords('maintenance_tasks', [task('t-oil', me, 'Oil change')]);
        render(<MaintenanceHub onBack={vi.fn()} />);
        await channelFor('maintenance_history');
        expect(rt.channelNames).toHaveLength(1);
        expect(rt.bindings.has('maintenance_tasks')).toBe(true);

        fireEvent.click(await screen.findByText('Oil change'));
        fireEvent.click(await screen.findByRole('button', { name: /History/ }));
        await screen.findByText('Service history');

        // The service is logged on the other device: its history row arrives.
        await deliver('maintenance_history', 'INSERT', history('h-1', me, 't-oil', 'Changed oil and filter'));
        expect(await screen.findByText('Changed oil and filter')).toBeInTheDocument();

        await deliver('maintenance_history', 'DELETE', { id: 'h-1' });
        await waitFor(() => expect(screen.queryByText('Changed oil and filter')).not.toBeInTheDocument());
    });
});

describe("crew on a skipper's shared binder", () => {
    beforeEach(async () => {
        await signIn('crew-1');
    });

    it("sees the skipper's (and other crew's) changes; never another skipper's rows or the crew's own", async () => {
        share([
            { ownerId: 'skipper-1', registers: { stores: true, equipment: true, maintenance: true } },
            { ownerId: 'skipper-2', registers: { stores: true } },
        ]);
        act(() => selectBinderSkipper('skipper-1'));
        render(<InventoryList onBack={vi.fn()} />);
        await screen.findByText("Shared from Test Boat 1 — you're crew");

        // The skipper adds; another crew member renames it (it stays the skipper's row).
        await deliver('inventory_items', 'INSERT', stores('s1-rice', 'skipper-1', 'Rice'));
        expect(await screen.findByText('Rice')).toBeInTheDocument();
        await deliver('inventory_items', 'UPDATE', stores('s1-rice', 'skipper-1', 'Basmati rice'));
        expect(await screen.findByText('Basmati rice')).toBeInTheDocument();

        // A skipper not selected, and the crew's own (hidden) stores.
        await deliver('inventory_items', 'INSERT', stores('s2-oats', 'skipper-2', 'Oats from boat two'));
        await deliver('inventory_items', 'INSERT', stores('c-coffee', 'crew-1', 'My own coffee'));
        // A later skipper change proves those two were processed, and not shown.
        await deliver('inventory_items', 'INSERT', stores('s1-salt', 'skipper-1', 'Salt'));
        expect(await screen.findByText('Salt')).toBeInTheDocument();
        expect(screen.queryByText('Oats from boat two')).not.toBeInTheDocument();
        expect(screen.queryByText('My own coffee')).not.toBeInTheDocument();

        // The skipper deletes.
        await deliver('inventory_items', 'DELETE', { id: 's1-rice' });
        await waitFor(() => expect(screen.queryByText('Basmati rice')).not.toBeInTheDocument());
        expect(screen.getByText('Salt')).toBeInTheDocument();
    });

    it("a register the skipper does not share stays the crew's own: the skipper's rows never show", async () => {
        share([{ ownerId: 'skipper-1', registers: { stores: true, equipment: true, maintenance: true } }]);
        render(<DocumentsHub onBack={vi.fn()} />);

        await deliver('ship_documents', 'INSERT', shipDocument('s1-doc', 'skipper-1', "Skipper's insurance"));
        await deliver('ship_documents', 'INSERT', shipDocument('c-doc', 'crew-1', 'My own passport copy'));
        expect(await screen.findByText('My own passport copy')).toBeInTheDocument();
        expect(screen.queryByText("Skipper's insurance")).not.toBeInTheDocument();
    });

    it("Equipment and R&M follow the skipper's changes and ignore an unselected skipper", async () => {
        share([
            { ownerId: 'skipper-1', registers: { equipment: true, maintenance: true } },
            { ownerId: 'skipper-2', registers: { equipment: true, maintenance: true } },
        ]);
        act(() => selectBinderSkipper('skipper-1'));
        const equipmentPage = render(<EquipmentList onBack={vi.fn()} />);
        await deliver('equipment_register', 'INSERT', equipment('s2-radar', 'skipper-2', 'Radar on boat two'));
        await deliver('equipment_register', 'INSERT', equipment('s1-ais', 'skipper-1', 'AIS transponder'));
        expect(await screen.findByText('AIS transponder')).toBeInTheDocument();
        expect(screen.queryByText('Radar on boat two')).not.toBeInTheDocument();
        equipmentPage.unmount();

        rt.bindings.clear();
        render(<MaintenanceHub onBack={vi.fn()} />);
        await deliver('maintenance_tasks', 'INSERT', task('s2-sails', 'skipper-2', 'Sails on boat two'));
        await deliver('maintenance_tasks', 'INSERT', task('s1-rig', 'skipper-1', 'Rig check'));
        expect(await screen.findByText('Rig check')).toBeInTheDocument();
        expect(screen.queryByText('Sails on boat two')).not.toBeInTheDocument();
        await deliver('maintenance_tasks', 'DELETE', { id: 's1-rig' });
        await waitFor(() => expect(screen.queryByText('Rig check')).not.toBeInTheDocument());
    });
});

describe('an open binder catches up after a background sync, even with no realtime', () => {
    it('reloads when a sync pulled rows, and when it only pruned rows deleted elsewhere', async () => {
        const me = `user-${accountCounter}`;
        await signIn(me);
        await mergePulledRecords('equipment_register', [equipment('e-pump', me, 'Bilge pump')]);
        render(<EquipmentList onBack={vi.fn()} />);
        await screen.findByText('Bilge pump');

        // The socket was down: a pull brings the other device's add.
        await mergePulledRecords('equipment_register', [equipment('e-plotter', me, 'Chart plotter')]);
        act(() => sync.completeListeners.forEach((listener) => listener({ pushed: 0, pulled: 1, errors: [] })));
        expect(await screen.findByText('Chart plotter')).toBeInTheDocument();

        // ...and the sweep finds the pump was deleted there: nothing pulled.
        await prunePulledTable('equipment_register', new Set(['e-plotter']));
        act(() =>
            sync.completeListeners.forEach((listener) => listener({ pushed: 0, pulled: 0, pruned: 1, errors: [] })),
        );
        await waitFor(() => expect(screen.queryByText('Bilge pump')).not.toBeInTheDocument());
        expect(screen.getByText('Chart plotter')).toBeInTheDocument();
    });
});

describe('opening a binder fetches what changed while it was closed', () => {
    it("Ship's Stores asks the sync engine to catch up as soon as its channel has joined", async () => {
        const me = `user-${accountCounter}`;
        await signIn(me);
        render(<InventoryList onBack={vi.fn()} />);
        await channelFor('inventory_items');
        expect(sync.requestCatchUpSync).not.toHaveBeenCalled();

        // Subscribe, then fetch: nothing that lands after the join is missed,
        // and everything before it comes in with the catch-up.
        act(() => rt.statusCallbacks.get(rt.channelNames[0])?.('SUBSCRIBED'));
        await waitFor(() => expect(sync.requestCatchUpSync).toHaveBeenCalledOnce());
    });
});

describe('R&M never seeds 40 suggestions on a device that already had tasks', () => {
    function confirmNoShares(userId: string): void {
        act(() => {
            localStorage.setItem(
                `thalassa_shared_binders_v1::user%3A${userId}`,
                JSON.stringify({ version: 1, userId, confirmedAt: '2026-10-02T00:00:00.000Z', skippers: [] }),
            );
            reloadSharedBindersFromStorage();
        });
    }

    const queuedTaskInserts = () =>
        getFullQueue().filter((item) => item.table_name === 'maintenance_tasks' && item.mutation_type === 'INSERT');

    it('the last task deleted on another device (realtime, then a prune-only sync) seeds nothing', async () => {
        // Its tasks came by sync, so this device never seeded R&M itself.
        const me = `user-${accountCounter}`;
        await signIn(me);
        confirmNoShares(me);
        await mergePulledRecords('maintenance_tasks', [task('t-last', me, 'Last task')]);
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Last task');

        await deliver('maintenance_tasks', 'DELETE', { id: 't-last' });
        await waitFor(() => expect(screen.queryByText('Last task')).not.toBeInTheDocument());
        act(() =>
            sync.completeListeners.forEach((listener) => listener({ pushed: 0, pulled: 0, pruned: 1, errors: [] })),
        );
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });

        expect(queuedTaskInserts()).toEqual([]);
        expect(screen.queryByText(/suggested task/)).not.toBeInTheDocument();
    });

    it('nor when R&M is opened again after the tasks were deleted elsewhere', async () => {
        const me = `user-${accountCounter}`;
        await signIn(me);
        confirmNoShares(me);
        await mergePulledRecords('maintenance_tasks', [task('t-only', me, 'Only task')]);
        const first = render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Only task');
        first.unmount();

        // Deleted on the phone; this device's sweep pruned it while R&M was closed.
        await prunePulledTable('maintenance_tasks', new Set());
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('No maintenance tasks');
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });

        expect(queuedTaskInserts()).toEqual([]);
    });

    /** This account's first full pull has completed here (what SyncService records). */
    async function firstFullPullDone(): Promise<void> {
        await updateSyncMeta({
            lastPullTimestamp: '2026-10-02T01:00:00.000Z',
            lastFullPullTimestamp: '2026-10-02T01:00:00.000Z',
        });
    }

    const syncCompletes = (pulled: number) =>
        act(() => sync.completeListeners.forEach((listener) => listener({ pushed: 0, pulled, errors: [] })));

    it('an existing account on a new device seeds nothing while its first full pull is bringing the tasks in', async () => {
        // A reinstall, or a new iPad: no seed or had-tasks marker here, and
        // the account's tasks are still on the server.
        const me = `user-${accountCounter}`;
        await signIn(me);
        confirmNoShares(me);
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('No maintenance tasks');
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });
        expect(queuedTaskInserts()).toEqual([]);

        // The first full pull lands the account's own tasks.
        await mergePulledRecords('maintenance_tasks', [task('t-real', me, 'Impeller')]);
        await firstFullPullDone();
        syncCompletes(1);
        expect(await screen.findByText('Impeller')).toBeInTheDocument();
        await act(async () => {
            await new Promise((resolve) => setTimeout(resolve, 50));
        });
        expect(queuedTaskInserts()).toEqual([]);
        expect(screen.queryByText(/suggested task/)).not.toBeInTheDocument();
    });

    it('a first-time account that opened R&M before its first full pull is seeded once that pull completes', async () => {
        const me = `user-${accountCounter}`;
        await signIn(me);
        confirmNoShares(me);
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('No maintenance tasks');
        expect(queuedTaskInserts()).toEqual([]);

        // The pull finds nothing on the server (pulled 0, so no ordinary reload).
        await firstFullPullDone();
        syncCompletes(0);
        await waitFor(() => expect(queuedTaskInserts().length).toBeGreaterThan(20));
    });

    it('a first-time account on this device still gets the suggested tasks once', async () => {
        const me = `user-${accountCounter}`;
        await signIn(me);
        confirmNoShares(me);
        await firstFullPullDone();
        render(<MaintenanceHub onBack={vi.fn()} />);

        await waitFor(() => expect(queuedTaskInserts().length).toBeGreaterThan(20));
        const seeded = queuedTaskInserts().length;
        // A later live change from elsewhere never seeds a second batch.
        await deliver('maintenance_tasks', 'INSERT', task('t-elsewhere', me, 'Added on the phone'));
        expect(await screen.findByText('Added on the phone')).toBeInTheDocument();
        expect(queuedTaskInserts()).toHaveLength(seeded);
    });
});
