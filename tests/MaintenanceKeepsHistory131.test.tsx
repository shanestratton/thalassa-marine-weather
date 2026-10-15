/**
 * Deleting a task keeps its service records once the server does (131-B7,
 * binder audit MAINT-02; the lasting half of 126-B7a).
 *
 * The server half is a HELD migration (task_title, and task_id ON DELETE SET
 * NULL) that waits for Shane's own push. Until R&M's column probe sees
 * task_title, everything is 126-B7a's: the question says the records go with
 * the task, on every device, and the phone leaves them to the sync. Once it
 * sees it, the question reads "Its 3 service records stay in your service
 * history", the phone keeps them under the task's name, and the service
 * history PDF lists them as "Raw-water impeller (task removed)".
 *
 * MaintenanceDeleteConfirm.test.tsx's harness: the real LocalDatabase
 * (Filesystem is the global mock) under the real LocalMaintenanceService and
 * the real page; only the socket, the sync engine and the PDF's share are
 * fakes. The probe is the real one, against a client that answers its read.
 *
 * Fictional boat 'Kestrel' out of Horta; tasks 'Raw-water impeller' (three
 * records), 'Rig inspection' (one) and 'Antifouling' (none).
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MaintenanceHistory, MaintenanceTask } from '../types';

/** What the server answers the probe's read of task_title: before or after the push. */
const probe = vi.hoisted(() => ({
    answer: { data: [] as unknown[], error: null as { code: string; message: string } | null },
}));
const BEFORE_PUSH = { code: '42703', message: 'column maintenance_history.task_title does not exist' };

vi.mock('../services/supabase', () => ({
    supabase: {
        channel: () => {
            const api = { on: () => api, subscribe: () => api };
            return api;
        },
        removeChannel: vi.fn(),
        from: (table: string) => {
            if (table !== 'maintenance_history') throw new Error(`unexpected read of ${table}`);
            return { select: () => ({ limit: async () => probe.answer }) };
        },
    },
}));
vi.mock('../services/vessel/SyncService', () => ({
    onSyncComplete: () => () => undefined,
    onStatusChange: () => () => undefined,
    isFullReconciliationPending: () => false,
    requestFullReconciliation: vi.fn().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] }),
    requestCatchUpSync: vi.fn(),
    syncNow: vi.fn().mockResolvedValue({ pushed: 0, pulled: 0, errors: [] }),
}));
// Every card is swiped open, so its Delete is the named button VoiceOver reads.
vi.mock('../hooks/useSwipeable', () => ({
    useSwipeable: () => ({ swipeOffset: 100, isSwiping: false, resetSwipe: () => undefined, ref: () => undefined }),
}));
// The real title rule; only the share is faked.
vi.mock('../services/MaintenancePdfService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/MaintenancePdfService')>()),
    exportChecklist: vi.fn(),
    exportServiceHistory: vi.fn().mockResolvedValue('shared'),
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

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { getFullQueue, initLocalDatabase, mergePulledRecords } from '../services/vessel/LocalDatabase';
import { LocalMaintenanceService } from '../services/vessel/LocalMaintenanceService';
import {
    __resetMaintenanceHistoryColumnForTests,
    maintenanceHistoryKeepsRecords,
} from '../services/vessel/maintenanceHistoryColumn';
import { exportServiceHistory, historyTaskTitle } from '../services/MaintenancePdfService';
import { MaintenanceHub } from '../components/vessel/MaintenanceHub';

const NOW = '2026-10-10T01:00:00.000Z';
let accountCounter = 0;
let me = '';

function task(id: string, title: string, patch: Partial<MaintenanceTask> = {}): MaintenanceTask {
    return {
        id,
        user_id: me,
        title,
        description: null,
        category: 'Engine',
        trigger_type: 'monthly',
        interval_value: 30,
        next_due_date: '2027-03-14',
        next_due_hours: null,
        last_completed: null,
        is_active: true,
        created_at: NOW,
        updated_at: NOW,
        ...patch,
    };
}

function record(id: string, taskId: string, completedAt: string): MaintenanceHistory {
    return {
        id,
        user_id: me,
        task_id: taskId,
        completed_at: completedAt,
        engine_hours_at_service: null,
        notes: 'Changed at the fuel dock, Horta',
        cost: null,
        created_at: completedAt,
    };
}

async function openKestrelBinder(): Promise<void> {
    accountCounter += 1;
    me = `skipper-kestrel-${accountCounter}`;
    act(() => setAuthIdentityScope(me));
    await initLocalDatabase(me);
    localStorage.setItem(`thalassa_maintenance_seeded::user%3A${me}`, '1');
    await mergePulledRecords('maintenance_tasks', [
        task('t-impeller', 'Raw-water impeller'),
        task('t-rig', 'Rig inspection', { category: 'Rigging' }),
        task('t-antifoul', 'Antifouling', { category: 'Hull', trigger_type: 'annual', interval_value: 365 }),
    ]);
    await mergePulledRecords('maintenance_history', [
        record('h-1', 't-impeller', '2026-03-03T08:00:00.000Z'),
        record('h-2', 't-impeller', '2026-06-03T08:00:00.000Z'),
        record('h-3', 't-impeller', '2026-08-01T09:30:00.000Z'),
        record('h-rig', 't-rig', '2026-09-20T06:00:00.000Z'),
    ]);
}

const swipeDelete = (title: string) => fireEvent.click(screen.getByRole('button', { name: `Delete ${title}` }));
const queuedFor = (table: string) =>
    getFullQueue()
        .filter((item) => item.table_name === table)
        .map((item) => `${item.mutation_type} ${item.record_id}`);
const impellerRecords = () =>
    LocalMaintenanceService.getAllHistory()
        .filter((h) => ['h-1', 'h-2', 'h-3'].includes(h.id))
        .map(({ id, task_id, task_title }) => ({ id, task_id, task_title }));

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    vi.mocked(exportServiceHistory).mockClear();
    __resetMaintenanceHistoryColumnForTests();
    probe.answer = { data: [], error: null };
});

afterEach(() => {
    vi.restoreAllMocks();
    act(() => setAuthIdentityScope(null));
    localStorage.clear();
});

describe('before the push: 126-B7a, unchanged', () => {
    it('says the records go with it, and the phone leaves them to the sync', async () => {
        probe.answer = { data: [], error: BEFORE_PUSH };
        await openKestrelBinder();
        const { unmount } = render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Raw-water impeller');

        swipeDelete('Raw-water impeller');
        const dialog = await screen.findByRole('dialog', { name: 'Delete “Raw-water impeller”?' });
        expect(dialog).toHaveTextContent('Its 3 service records go with it, on every device.');
        expect(within(dialog).getByRole('button', { name: 'Pause instead' })).toBeInTheDocument();
        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete task and records' }));
        await waitFor(() => expect(screen.queryByText('Raw-water impeller')).not.toBeInTheDocument());

        unmount();
        await waitFor(() => expect(queuedFor('maintenance_tasks')).toEqual(['DELETE t-impeller']));
        // Nothing here touches them; the server's cascade, then the sync, takes them.
        expect(impellerRecords()).toEqual([
            { id: 'h-3', task_id: 't-impeller', task_title: undefined },
            { id: 'h-2', task_id: 't-impeller', task_title: undefined },
            { id: 'h-1', task_id: 't-impeller', task_title: undefined },
        ]);
        expect(queuedFor('maintenance_history')).toEqual([]);
    });

    it("leaves the waiting task's records off the service history PDF, as they will go", async () => {
        probe.answer = { data: [], error: BEFORE_PUSH };
        await openKestrelBinder();
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Raw-water impeller');
        swipeDelete('Raw-water impeller');
        const dialog = await screen.findByRole('dialog', { name: 'Delete “Raw-water impeller”?' });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete task and records' }));
        await waitFor(() => expect(screen.queryByText('Raw-water impeller')).not.toBeInTheDocument());

        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
        fireEvent.click(screen.getByRole('button', { name: 'Share or save service history' }));
        await waitFor(() => expect(exportServiceHistory).toHaveBeenCalledTimes(1));
        const [records] = vi.mocked(exportServiceHistory).mock.calls[0];
        expect(records.map((h) => h.id)).toEqual(['h-rig']);
    });
});

describe('once the probe sees task_title: the records stay', () => {
    it('asks "Its 3 service records stay in your service history", Pause still first', async () => {
        await openKestrelBinder();
        const deleteTask = vi.spyOn(LocalMaintenanceService, 'deleteTask');
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Raw-water impeller');

        swipeDelete('Raw-water impeller');
        const dialog = await screen.findByRole('dialog', { name: 'Delete “Raw-water impeller”?' });
        await waitFor(() => expect(dialog).toHaveTextContent('Its 3 service records stay in your service history.'));
        expect(dialog).not.toHaveTextContent('every device');
        expect(within(dialog).getByRole('button', { name: 'Pause instead' })).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: 'Delete task' })).toBeInTheDocument();
        expect(within(dialog).queryByRole('button', { name: 'Delete task and records' })).toBeNull();
        await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Keep' })).toHaveFocus());
        expect(deleteTask).not.toHaveBeenCalled();
    });

    it('says "record stays" for one', async () => {
        await openKestrelBinder();
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Rig inspection');
        await waitFor(() => expect(screen.getByText('Rig inspection')).toBeInTheDocument());
        // The probe answers on mount; let it land before the swipe.
        await act(async () => undefined);
        swipeDelete('Rig inspection');
        const dialog = await screen.findByRole('dialog', { name: 'Delete “Rig inspection”?' });
        await waitFor(() => expect(dialog).toHaveTextContent('Its 1 service record stays in your service history.'));
    });

    it("the delete keeps them on the phone under the task's name, and queues only the task's DELETE", async () => {
        await openKestrelBinder();
        const { unmount } = render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Raw-water impeller');
        await act(async () => undefined);

        swipeDelete('Raw-water impeller');
        const dialog = await screen.findByRole('dialog', { name: 'Delete “Raw-water impeller”?' });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete task' }));
        await waitFor(() => expect(screen.queryByText('Raw-water impeller')).not.toBeInTheDocument());
        expect(screen.getByText('"Raw-water impeller" deleted')).toBeInTheDocument();

        unmount();
        await waitFor(() => expect(queuedFor('maintenance_tasks')).toEqual(['DELETE t-impeller']));
        await waitFor(() =>
            expect(impellerRecords()).toEqual([
                { id: 'h-3', task_id: null, task_title: 'Raw-water impeller' },
                { id: 'h-2', task_id: null, task_title: 'Raw-water impeller' },
                { id: 'h-1', task_id: null, task_title: 'Raw-water impeller' },
            ]),
        );
        // The server's trigger writes the same: nothing of the records is pushed.
        expect(queuedFor('maintenance_history')).toEqual([]);
        // Another task's record is left as it was.
        expect(LocalMaintenanceService.getHistory('t-rig').map((h) => h.id)).toEqual(['h-rig']);
    });

    it("the service history PDF lists them under the task's name, marked (task removed), Undo window and after", async () => {
        await openKestrelBinder();
        const { unmount } = render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Raw-water impeller');
        await act(async () => undefined);
        swipeDelete('Raw-water impeller');
        fireEvent.click(
            within(await screen.findByRole('dialog', { name: 'Delete “Raw-water impeller”?' })).getByRole('button', {
                name: 'Delete task',
            }),
        );
        await waitFor(() => expect(screen.queryByText('Raw-water impeller')).not.toBeInTheDocument());

        // Inside the Undo window: printed as they will be.
        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
        fireEvent.click(screen.getByRole('button', { name: 'Share or save service history' }));
        await waitFor(() => expect(exportServiceHistory).toHaveBeenCalledTimes(1));
        const titles = (call: number) => {
            const [records, tasks] = vi.mocked(exportServiceHistory).mock.calls[call];
            const byId = new Map(tasks.map((t) => [t.id, t]));
            return records.map((h) => [h.id, historyTaskTitle(h, h.task_id ? byId.get(h.task_id) : undefined)]);
        };
        expect(titles(0)).toEqual(
            expect.arrayContaining([
                ['h-1', 'Raw-water impeller (task removed)'],
                ['h-2', 'Raw-water impeller (task removed)'],
                ['h-3', 'Raw-water impeller (task removed)'],
                ['h-rig', 'Rig inspection'],
            ]),
        );

        // Committed: the same, from the records' own task_title.
        unmount();
        await waitFor(() => expect(impellerRecords()[0]?.task_id).toBeNull());
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Rig inspection');
        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
        fireEvent.click(screen.getByRole('button', { name: 'Share or save service history' }));
        await waitFor(() => expect(exportServiceHistory).toHaveBeenCalledTimes(2));
        expect(titles(1)).toHaveLength(4);
        expect(titles(1)).toEqual(expect.arrayContaining([['h-2', 'Raw-water impeller (task removed)']]));
    });
});

describe('LocalMaintenanceService.deleteTask on its own', () => {
    it('stamps nothing until the column has been seen this session, then keeps the records', async () => {
        await openKestrelBinder();
        await LocalMaintenanceService.deleteTask('t-rig');
        expect(LocalMaintenanceService.getAllHistory().find((h) => h.id === 'h-rig')).toMatchObject({
            task_id: 't-rig',
        });

        await maintenanceHistoryKeepsRecords({
            from: () => ({ select: () => ({ limit: async () => ({ data: [], error: null }) }) }),
        });
        await LocalMaintenanceService.deleteTask('t-impeller');
        expect(impellerRecords().map((h) => h.task_title)).toEqual([
            'Raw-water impeller',
            'Raw-water impeller',
            'Raw-water impeller',
        ]);
        expect(queuedFor('maintenance_tasks')).toEqual(['DELETE t-rig', 'DELETE t-impeller']);
        expect(queuedFor('maintenance_history')).toEqual([]);
    });
});
