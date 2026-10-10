/**
 * Deleting a task that has service records asks first, and offers Pause
 * instead (126-B7a, binder audit MAINT-02; Shane 2026-10-09: "check all of
 * the binders to make sure that they are at the same standard as the rest of
 * the app").
 *
 * The server's maintenance_history.task_id is ON DELETE CASCADE, so one swipe
 * took the task's whole service ledger with it, on every device, behind a
 * toast that said only '"X" deleted'. Now a task with records asks: Pause
 * instead (the prominent choice), Delete task and records, or Keep. A task
 * with no records still goes at once with its five-second Undo (126-B10a).
 *
 * BinderLiveSync.test.tsx's harness: the real LocalDatabase (Filesystem is
 * the global mock) under the real LocalMaintenanceService and the real page;
 * only the socket and the sync engine are fakes. The service's writes are
 * spied on, not replaced.
 *
 * Fictional boat 'Kestrel' out of Horta; tasks 'Raw-water impeller' (three
 * records), 'Antifouling' (none) and 'Rig inspection'.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MaintenanceHistory, MaintenanceTask } from '../types';

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
}));
// The swipe is a native touch gesture: every card here is swiped open, so its
// Delete is the named button VoiceOver reads.
vi.mock('../hooks/useSwipeable', () => ({
    useSwipeable: () => ({ swipeOffset: 100, isSwiping: false, resetSwipe: () => undefined, ref: () => undefined }),
}));
vi.mock('../services/MaintenancePdfService', () => ({ exportChecklist: vi.fn(), exportServiceHistory: vi.fn() }));
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
import { MaintenanceHub } from '../components/vessel/MaintenanceHub';
import { toast } from '../components/Toast';

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
        notes: null,
        cost: null,
        created_at: completedAt,
    };
}

async function openKestrelBinder(): Promise<void> {
    accountCounter += 1;
    me = `skipper-kestrel-${accountCounter}`;
    act(() => setAuthIdentityScope(me));
    await initLocalDatabase(me);
    // Seeded once already, so the empty-binder seeding stays out of it.
    localStorage.setItem(`thalassa_maintenance_seeded::user%3A${me}`, '1');
    await mergePulledRecords('maintenance_tasks', [
        task('t-impeller', 'Raw-water impeller'),
        task('t-antifoul', 'Antifouling', { category: 'Hull', trigger_type: 'annual', interval_value: 365 }),
        task('t-rig', 'Rig inspection', { category: 'Rigging' }),
    ]);
    await mergePulledRecords('maintenance_history', [
        record('h-1', 't-impeller', '2026-03-03T08:00:00.000Z'),
        record('h-2', 't-impeller', '2026-06-03T08:00:00.000Z'),
        record('h-3', 't-impeller', '2026-08-01T09:30:00.000Z'),
    ]);
}

const swipeDelete = (title: string) => fireEvent.click(screen.getByRole('button', { name: `Delete ${title}` }));
const taskDeletes = () =>
    getFullQueue().filter((item) => item.table_name === 'maintenance_tasks' && item.mutation_type === 'DELETE');

beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
    vi.mocked(Filesystem.readdir).mockResolvedValue({ files: [] });
    vi.mocked(Filesystem.writeFile).mockResolvedValue({ uri: 'mock://file' });
    vi.mocked(toast.success).mockClear();
});

afterEach(() => {
    vi.restoreAllMocks();
    act(() => setAuthIdentityScope(null));
    localStorage.clear();
});

describe('deleting a task with service records asks first', () => {
    it('names the records, offers Pause instead, and starts on Keep; nothing is deleted yet', async () => {
        await openKestrelBinder();
        const deleteTask = vi.spyOn(LocalMaintenanceService, 'deleteTask');
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Raw-water impeller');

        swipeDelete('Raw-water impeller');

        const dialog = await screen.findByRole('dialog', { name: 'Delete “Raw-water impeller”?' });
        expect(dialog).toHaveTextContent('Its 3 service records go with it, on every device.');
        expect(within(dialog).getByRole('button', { name: 'Pause instead' })).toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: 'Delete task and records' })).toBeInTheDocument();
        await waitFor(() => expect(within(dialog).getByRole('button', { name: 'Keep' })).toHaveFocus());
        expect(deleteTask).not.toHaveBeenCalled();
        expect(screen.getByText('Raw-water impeller')).toBeInTheDocument();

        fireEvent.click(within(dialog).getByRole('button', { name: 'Keep' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
        expect(screen.getByText('Raw-water impeller')).toBeInTheDocument();
        expect(taskDeletes()).toEqual([]);
    });

    it('Pause instead pauses it: no delete, and it waits under Paused (1)', async () => {
        await openKestrelBinder();
        const deactivate = vi.spyOn(LocalMaintenanceService, 'deactivateTask');
        const deleteTask = vi.spyOn(LocalMaintenanceService, 'deleteTask');
        const { unmount } = render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Raw-water impeller');

        swipeDelete('Raw-water impeller');
        const dialog = await screen.findByRole('dialog', { name: 'Delete “Raw-water impeller”?' });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Pause instead' }));

        await waitFor(() => expect(deactivate).toHaveBeenCalledWith('t-impeller'));
        expect(await screen.findByRole('button', { name: 'Paused (1)' })).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByText('Raw-water impeller')).not.toBeInTheDocument();
        expect(toast.success).toHaveBeenCalledWith("“Raw-water impeller” paused. It's under Paused.");
        expect(LocalMaintenanceService.getHistory('t-impeller')).toHaveLength(3);

        unmount();
        expect(deleteTask).not.toHaveBeenCalled();
        expect(taskDeletes()).toEqual([]);
    });

    it('Delete task and records takes the one undo slot: hidden at once, deleted after the window', async () => {
        await openKestrelBinder();
        const deleteTask = vi.spyOn(LocalMaintenanceService, 'deleteTask');
        const { unmount } = render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Raw-water impeller');

        swipeDelete('Raw-water impeller');
        const dialog = await screen.findByRole('dialog', { name: 'Delete “Raw-water impeller”?' });
        fireEvent.click(within(dialog).getByRole('button', { name: 'Delete task and records' }));

        await waitFor(() => expect(screen.queryByText('Raw-water impeller')).not.toBeInTheDocument());
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.getByText('"Raw-water impeller" deleted')).toBeInTheDocument();
        expect(deleteTask).not.toHaveBeenCalled();

        // Back inside the window: the delete still happens (126-B10a).
        unmount();
        await waitFor(() => expect(deleteTask).toHaveBeenCalledWith('t-impeller'));
        await waitFor(() => expect(taskDeletes().map((item) => item.record_id)).toEqual(['t-impeller']));
    });

    it('a task with no records goes at once, with its Undo, and no question', async () => {
        await openKestrelBinder();
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Antifouling');

        swipeDelete('Antifouling');

        await waitFor(() => expect(screen.queryByText('Antifouling')).not.toBeInTheDocument());
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.getByText('"Antifouling" deleted')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Undo delete action' })).toBeInTheDocument();
    });

    // A record removed from Service history waits out its five-second Undo
    // before its DELETE is queued: the question counts what will really go.
    it('a record just removed, still in its Undo, is not counted', async () => {
        await openKestrelBinder();
        await mergePulledRecords('maintenance_history', [record('h-rig', 't-rig', '2026-09-20T06:00:00.000Z')]);
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Raw-water impeller');

        const removeFromHistory = async (title: string, day: string) => {
            fireEvent.click(screen.getByRole('button', { name: `Options for ${title}` }));
            const sheet = await screen.findByRole('dialog', { name: title });
            fireEvent.click(within(sheet).getByRole('button', { name: 'History' }));
            const history = await screen.findByRole('dialog', { name: 'Service history' });
            fireEvent.click(within(history).getByRole('button', { name: `Remove the ${day} record` }));
            fireEvent.click(within(history).getByRole('button', { name: 'Close' }));
            await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Service history' })).toBeNull());
        };

        await removeFromHistory('Raw-water impeller', '3 Jun 2026');
        swipeDelete('Raw-water impeller');
        const dialog = await screen.findByRole('dialog', { name: 'Delete “Raw-water impeller”?' });
        expect(dialog).toHaveTextContent('Its 2 service records go with it, on every device.');
        fireEvent.click(within(dialog).getByRole('button', { name: 'Keep' }));
        await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

        // Its only record removed: nothing left to ask about, so it goes at once.
        await removeFromHistory('Rig inspection', '20 Sep 2026');
        swipeDelete('Rig inspection');
        await waitFor(() => expect(screen.queryByText('Rig inspection')).not.toBeInTheDocument());
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
        expect(screen.getByText('"Rig inspection" deleted')).toBeInTheDocument();
    });

    it('a paused task with records asks too, without offering to pause it again', async () => {
        await openKestrelBinder();
        await mergePulledRecords('maintenance_tasks', [
            task('t-impeller', 'Raw-water impeller', { is_active: false, updated_at: '2026-10-10T02:00:00.000Z' }),
        ]);
        render(<MaintenanceHub onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Paused (1)' }));

        swipeDelete('Raw-water impeller');

        const dialog = await screen.findByRole('dialog', { name: 'Delete “Raw-water impeller”?' });
        expect(within(dialog).queryByRole('button', { name: 'Pause instead' })).not.toBeInTheDocument();
        expect(within(dialog).getByRole('button', { name: 'Delete task and records' })).toBeInTheDocument();
    });
});
