/**
 * The binders show and edit a synced day as the day it was entered
 * (131-B11; binder audit STORES-07, EQ-2, MAINT-07, DOC-5).
 *
 * A day kept in a timestamp column comes back from the server as its UTC
 * midnight, '2026-11-01T00:00:00+00:00'. That is no value a date input takes,
 * so Equipment's edit sheet opened with its install and warranty dates blank
 * after a sync, and the cards showed 31 October in the Americas. A logged
 * service's due is a moment, and its UTC date in the edit sheet was a day
 * early in Queensland.
 *
 * BinderLiveSync.test.tsx's harness: the real LocalDatabase (Filesystem is
 * the global mock) under the real local services and the real pages; only the
 * socket, the sync engine and the file vault are fakes. The phone is in Los
 * Angeles unless a case says Brisbane. Fictional boat 'Kestrel'.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EquipmentItem, InventoryItem, MaintenanceTask, ShipDocument } from '../types';

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
vi.mock('../services/vessel/DocumentSyncService', () => ({
    DocumentSyncService: {
        getDownloadUrl: vi.fn(async (uri: string) => uri),
        openDownload: vi.fn().mockResolvedValue(undefined),
        uploadStates: () => ({}),
        onUploadsChanged: () => () => undefined,
        retryUploads: vi.fn().mockResolvedValue(undefined),
    },
}));
vi.mock('../services/MaintenancePdfService', () => ({ exportChecklist: vi.fn(), exportServiceHistory: vi.fn() }));
vi.mock('../utils/equipmentPdfExport', () => ({ exportEquipmentPdf: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: { settings: { vessel: { name: string } } }) => unknown) =>
        selector({ settings: { vessel: { name: 'Kestrel' } } }),
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() } }));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { getFullQueue, initLocalDatabase, mergePulledRecords } from '../services/vessel/LocalDatabase';
import { LocalEquipmentService } from '../services/vessel/LocalEquipmentService';
import { LocalMaintenanceService } from '../services/vessel/LocalMaintenanceService';
import { EquipmentList } from '../components/vessel/EquipmentList';
import { InventoryList } from '../components/vessel/InventoryList';
import { DocumentsHub } from '../components/vessel/DocumentsHub';
import { MaintenanceHub } from '../components/vessel/MaintenanceHub';

// The edit sheets' keyboard scroll calls window.scrollBy, which jsdom lacks.
window.scrollBy = () => undefined;

/** 1 November 2026 as the server hands back a day kept in a timestamp column. */
const SYNCED = '2026-11-01T00:00:00+00:00';
const AT = '2026-10-09T01:00:00.000Z';
let accountCounter = 0;
let me = '';
const was = process.env.TZ;

/** This phone's clock: a time zone, and a local moment in it. */
function phoneAt(zone: string, month: number, day: number, hour: number): void {
    process.env.TZ = zone;
    vi.setSystemTime(new Date(2026, month - 1, day, hour, 0));
}

async function signIn(): Promise<void> {
    accountCounter += 1;
    me = `skipper-kestrel-${accountCounter}`;
    act(() => setAuthIdentityScope(me));
    await initLocalDatabase(me);
}

const updatesTo = (table: string) =>
    getFullQueue().filter((item) => item.table_name === table && item.mutation_type === 'UPDATE');

beforeEach(() => {
    localStorage.clear();
    // The vessel files already live in Library (see LocalDatabaseOutbox.test.ts).
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    vi.useFakeTimers({ toFake: ['Date'] });
    // 18:00 on Friday 30 October in Los Angeles: already Saturday in UTC.
    phoneAt('America/Los_Angeles', 10, 30, 18);
});

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    act(() => setAuthIdentityScope(null));
    localStorage.clear();
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
});

describe('Equipment (EQ-2)', () => {
    const watermaker: () => EquipmentItem = () => ({
        id: 'e-wm',
        user_id: me,
        equipment_name: 'Watermaker',
        category: 'Plumbing',
        make: 'Fictional Pumps',
        model: 'WM-40',
        serial_number: 'WM-0001',
        installation_date: '2024-03-01T00:00:00+00:00',
        warranty_expiry: SYNCED,
        manual_uri: null,
        notes: null,
        created_at: AT,
        updated_at: AT,
    });

    async function openEditSheet(): Promise<void> {
        await signIn();
        await mergePulledRecords('equipment_register', [watermaker()]);
        render(<EquipmentList onBack={vi.fn()} />);
        fireEvent.click(await screen.findByText('Watermaker'));
        expect(await screen.findByText('1 Mar 2024')).toBeInTheDocument();
        expect(screen.getByText('Expires 1 Nov 2026')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Edit equipment' }));
    }

    it('the edit sheet opens on the synced install and warranty days, not blank', async () => {
        await openEditSheet();
        expect(screen.getByLabelText('Install date')).toHaveValue('2024-03-01');
        expect(screen.getByLabelText('Warranty expiry')).toHaveValue('2026-11-01');
    });

    it('a Save that leaves the dates alone writes nothing', async () => {
        const update = vi.spyOn(LocalEquipmentService, 'update');
        await openEditSheet();
        fireEvent.click(screen.getByRole('button', { name: 'Save equipment changes' }));
        await waitFor(() =>
            expect(screen.queryByRole('button', { name: 'Save equipment changes' })).not.toBeInTheDocument(),
        );
        expect(update).not.toHaveBeenCalled();
        expect(updatesTo('equipment_register')).toEqual([]);
    });

    it('a new warranty day is sent as that day, and nothing else', async () => {
        const update = vi.spyOn(LocalEquipmentService, 'update');
        await openEditSheet();
        fireEvent.change(screen.getByLabelText('Warranty expiry'), { target: { value: '2027-11-01' } });
        fireEvent.click(screen.getByRole('button', { name: 'Save equipment changes' }));
        await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
        expect(update).toHaveBeenCalledWith('e-wm', { warranty_expiry: '2027-11-01' });
    });
});

describe('Stores (STORES-07)', () => {
    /** An expiry an older Galley wrote as a moment: Galley leftovers made at 18:00 on 8 October, plus three days. */
    const chowder = (): InventoryItem =>
        ({
            id: 's-chowder',
            user_id: me,
            barcode: null,
            item_name: 'Chowder (Leftovers)',
            description: null,
            category: 'Fridge',
            quantity: 2,
            min_quantity: 0,
            unit: 'serves',
            location_zone: 'Galley',
            location_specific: 'Fridge',
            expiry_date: '2026-10-12T01:00:00.000Z',
            created_at: AT,
            updated_at: AT,
        }) as InventoryItem;

    it('the edit sheet opens on the local day, and a Save that leaves it alone writes nothing', async () => {
        await signIn();
        localStorage.setItem(`thalassa_inventory_deduped::user%3A${me}`, '1');
        await mergePulledRecords('inventory_items', [chowder()]);
        render(<InventoryList onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Edit Chowder (Leftovers)' }));

        expect(screen.getByLabelText('Expiry / service')).toHaveValue('2026-10-11');
        fireEvent.click(screen.getByRole('button', { name: 'Save inventory item changes' }));
        await waitFor(() =>
            expect(screen.queryByRole('button', { name: 'Save inventory item changes' })).not.toBeInTheDocument(),
        );
        expect(updatesTo('inventory_items')).toEqual([]);
    });
});

describe('Documents (DOC-5)', () => {
    const coastalLicence = (): ShipDocument => ({
        id: '3d2c1b0a-0000-4000-8000-000000000131',
        user_id: me,
        document_name: 'Coastal licence',
        category: 'Registration',
        issue_date: '2021-11-01T00:00:00+00:00',
        expiry_date: SYNCED,
        file_uri: null,
        notes: null,
        created_at: AT,
        updated_at: AT,
    });

    it('the card shows the synced expiry day, and the edit sheet opens on both days', async () => {
        await signIn();
        await mergePulledRecords('ship_documents', [coastalLicence()]);
        render(<DocumentsHub onBack={vi.fn()} />);

        expect(await screen.findByText('Exp 1 Nov 2026')).toBeInTheDocument();
        // Two days to go: expiring, not expired.
        expect(screen.getByText('Expiring soon')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Edit Coastal licence' }));
        const sheet = screen.getByRole('dialog', { name: 'Edit document' });
        expect(within(sheet).getByLabelText('Issue date')).toHaveValue('2021-11-01');
        expect(within(sheet).getByLabelText('Expiry date')).toHaveValue('2026-11-01');
    });
});

describe('Maintenance (MAINT-07)', () => {
    const impeller = (nextDue: string): MaintenanceTask => ({
        id: 't-impeller',
        user_id: me,
        title: 'Raw-water impeller',
        description: null,
        category: 'Engine',
        trigger_type: 'annual',
        interval_value: 365,
        next_due_date: nextDue,
        next_due_hours: null,
        last_completed: null,
        is_active: true,
        created_at: AT,
        updated_at: AT,
    });

    async function openBinder(nextDue: string): Promise<void> {
        await signIn();
        localStorage.setItem(`thalassa_maintenance_seeded::user%3A${me}`, '1');
        await mergePulledRecords('maintenance_tasks', [impeller(nextDue)]);
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Raw-water impeller');
    }

    async function openEditSheet(): Promise<HTMLElement> {
        fireEvent.click(screen.getByRole('button', { name: 'Options for Raw-water impeller' }));
        const sheet = await screen.findByRole('dialog', { name: 'Raw-water impeller' });
        fireEvent.click(within(sheet).getByRole('button', { name: 'Edit task' }));
        return screen.findByRole('dialog', { name: 'Edit task' });
    }

    it('a task due on the synced 1 November reads Sunday 1 November, two days out, here and in its edit sheet', async () => {
        await openBinder(SYNCED);
        expect(screen.getByText('Sun 1 Nov 2026')).toBeInTheDocument();
        expect(screen.getAllByText('Due in 2 days').length).toBeGreaterThan(0);
        const edit = await openEditSheet();
        expect(within(edit).getByLabelText('Next due date')).toHaveValue('2026-11-01');
    });

    it("a logged service's due opens on the day the card shows, not its UTC date, in Brisbane", async () => {
        // 08:00 Saturday 14 November in Brisbane is still the 13th in UTC.
        phoneAt('Australia/Brisbane', 10, 30, 18);
        await openBinder('2026-11-13T22:00:00.123456+00:00');
        expect(screen.getByText('Sat 14 Nov 2026')).toBeInTheDocument();
        const edit = await openEditSheet();
        expect(within(edit).getByLabelText('Next due date')).toHaveValue('2026-11-14');
    });

    async function openAddSheet(): Promise<HTMLElement> {
        fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
        return screen.findByRole('dialog', { name: 'New task' });
    }

    it("'First due' is today as Add opens on a page left open overnight, and the task is due today", async () => {
        // 21:00 Friday 9 October in Brisbane; the phone sleeps on the page.
        phoneAt('Australia/Brisbane', 10, 9, 21);
        await openBinder(SYNCED);
        // 07:00 Saturday, still Friday in UTC: the skipper taps Add.
        phoneAt('Australia/Brisbane', 10, 10, 7);
        const create = vi.spyOn(LocalMaintenanceService, 'createTask');
        const add = await openAddSheet();
        expect(within(add).getByLabelText('First due')).toHaveValue('2026-10-10');

        fireEvent.change(within(add).getByLabelText(/Task name/), { target: { value: 'Check bilge pump' } });
        fireEvent.click(within(add).getByRole('button', { name: 'Create task' }));
        await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
        expect(create.mock.calls[0][0]).toMatchObject({ title: 'Check bilge pump', next_due_date: '2026-10-10' });
    });

    it("Add opens clean after an edit, not on the edited task's name and due day", async () => {
        await openBinder(SYNCED);
        const edit = await openEditSheet();
        expect(within(edit).getByLabelText('Next due date')).toHaveValue('2026-11-01');
        fireEvent.click(within(edit).getByRole('button', { name: 'Save changes' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit task' })).not.toBeInTheDocument());

        const add = await openAddSheet();
        expect(within(add).getByLabelText(/Task name/)).toHaveValue('');
        // 18:00 Friday 30 October in Los Angeles.
        expect(within(add).getByLabelText('First due')).toHaveValue('2026-10-30');
    });
});
