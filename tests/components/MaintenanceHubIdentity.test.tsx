import React from 'react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../../services/authIdentityScope';
import { reloadSharedBindersFromStorage } from '../../services/vessel/sharedBinders';
import type { MaintenanceHistory, MaintenanceTask } from '../../types';
import type { TaskWithStatus } from '../../services/MaintenanceService';

const mocks = vi.hoisted(() => ({
    getTasks: vi.fn(),
    seedDefaults: vi.fn(),
    logService: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    getHistory: vi.fn(),
    getAllHistory: vi.fn(),
    deleteTask: vi.fn(),
    initLocalDatabase: vi.fn(),
    exportChecklist: vi.fn(),
    exportHistory: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    toastInfo: vi.fn(),
    haptic: vi.fn(),
    flash: vi.fn(),
    undoProps: null as null | { onUndo: () => void; onDismiss: () => void },
}));

vi.mock('../../services/vessel/LocalMaintenanceService', () => ({
    LocalMaintenanceService: {
        getTasks: mocks.getTasks,
        // R&M loads paused tasks too (126-B7a): the same load.
        getAllTasks: mocks.getTasks,
        seedDefaults: mocks.seedDefaults,
        logService: mocks.logService,
        createTask: mocks.createTask,
        updateTask: mocks.updateTask,
        getHistory: mocks.getHistory,
        getAllHistory: mocks.getAllHistory,
        deleteTask: mocks.deleteTask,
    },
}));

vi.mock('../../services/vessel/LocalDatabase', () => ({
    initLocalDatabase: mocks.initLocalDatabase,
    // R&M seeds only after the account's first full pull on this device.
    getSyncMeta: () => ({ lastFullPullTimestamp: '2026-10-02T00:00:00.000Z' }),
}));

vi.mock('../../services/MaintenanceService', () => {
    const calculateStatus = (task: MaintenanceTask) => ({
        ...task,
        status: 'green',
        statusLabel: 'OK',
        daysRemaining: 30,
        hoursRemaining: null,
    });
    return { calculateStatus, statusWithReading: calculateStatus, isFixedRepair: () => false };
});

vi.mock('../../services/MaintenancePdfService', () => ({
    exportChecklist: mocks.exportChecklist,
    exportServiceHistory: mocks.exportHistory,
}));

vi.mock('../../hooks/useRealtimeSync', () => ({
    useRealtimeSyncMulti: vi.fn(),
}));

vi.mock('../../hooks/useSuccessFlash', () => ({
    useSuccessFlash: () => ({ ref: { current: null }, flash: mocks.flash }),
}));

vi.mock('../../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: { settings: { vessel: { name: string } } }) => unknown) =>
        selector({ settings: { vessel: { name: 'Account A Vessel' } } }),
}));

vi.mock('../../utils/system', () => ({ triggerHaptic: mocks.haptic }));
vi.mock('../../components/Toast', () => ({
    toast: { success: mocks.toastSuccess, error: mocks.toastError, info: mocks.toastInfo },
}));

vi.mock('../../components/ui/PageHeader', () => ({
    PageHeader: ({ title, action, status }: { title: string; action?: React.ReactNode; status?: React.ReactNode }) => (
        <header>
            <h1>{title}</h1>
            {status}
            {action}
        </header>
    ),
}));

vi.mock('../../components/ui/SlideToAction', () => ({
    SlideToAction: ({ label, onConfirm }: { label: string; onConfirm: () => void }) => (
        <button onClick={onConfirm}>{label}</button>
    ),
}));

vi.mock('../../components/ui/ModalSheet', () => ({
    // The sheet's pinned main button too (132-B19).
    ModalSheet: ({
        children,
        title,
        footer,
    }: {
        children: React.ReactNode;
        title: string;
        footer?: React.ReactNode;
    }) => (
        <section aria-label={title}>
            {children}
            {footer}
        </section>
    ),
}));

vi.mock('../../components/ui/UndoToast', () => ({
    UndoToast: (props: { isOpen: boolean; onUndo: () => void; onDismiss: () => void }) => {
        if (props.isOpen) mocks.undoProps = props;
        return null;
    },
}));

vi.mock('../../components/ui/EmptyState', () => ({
    EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}));

vi.mock('../../components/ui/ShimmerBlock', () => ({
    ShimmerBlock: () => <div>Loading maintenance</div>,
}));

vi.mock('../../components/ui/OfflineBadge', () => ({ OfflineBadge: () => null }));

vi.mock('../../components/vessel/maintenance/SwipeableTaskCard', async () => {
    const actual = await vi.importActual<typeof import('../../components/vessel/maintenance/SwipeableTaskCard')>(
        '../../components/vessel/maintenance/SwipeableTaskCard',
    );
    return {
        ...actual,
        SwipeableTaskCard: ({
            task,
            onTap,
            onDelete,
        }: {
            task: TaskWithStatus;
            onTap: () => void;
            onDelete: () => void;
        }) => (
            <article>
                <span>{task.title}</span>
                <button onClick={onTap}>Options {task.title}</button>
                <button onClick={onDelete}>Delete {task.title}</button>
            </article>
        ),
    };
});

vi.mock('../../components/vessel/maintenance/ServiceLogSheet', () => ({
    ServiceLogSheet: ({
        task,
        onLog,
        onHistory,
        onEdit,
    }: {
        task: TaskWithStatus;
        onLog: () => void;
        onHistory: () => void;
        onEdit: () => void;
    }) => (
        <section aria-label={`Service ${task.title}`}>
            <button onClick={onLog}>Log service</button>
            <button onClick={onHistory}>View history</button>
            <button onClick={onEdit}>Edit task</button>
        </section>
    ),
}));

vi.mock('../../components/vessel/maintenance/TaskFormModal', () => ({
    TaskFormModal: ({ mode }: { mode: string }) => <section aria-label={`${mode} task form`} />,
}));

import { MaintenanceHub } from '../../components/vessel/MaintenanceHub';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const task = (id: string, title: string): MaintenanceTask => ({
    id,
    user_id: id.startsWith('a') ? 'account-a' : 'account-b',
    title,
    description: null,
    category: 'Engine',
    trigger_type: 'monthly',
    interval_value: 30,
    next_due_date: '2027-01-01',
    next_due_hours: null,
    last_completed: null,
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
});

describe('MaintenanceHub identity isolation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        mocks.undoProps = null;
        localStorage.clear();
        setAuthIdentityScope(null);
        const accountA = setAuthIdentityScope('account-a');
        localStorage.setItem(authScopedStorageKey('thalassa_maintenance_seeded', accountA), '1');
        localStorage.setItem(authScopedStorageKey('thalassa_engine_hours', accountA), '111');
        mocks.getTasks.mockResolvedValue([task('a-task', 'Private A maintenance')]);
        mocks.seedDefaults.mockResolvedValue(40);
        mocks.logService.mockResolvedValue({});
        mocks.createTask.mockResolvedValue(task('a-new', 'A new task'));
        mocks.updateTask.mockResolvedValue(task('a-task', 'Updated A maintenance'));
        // Synchronous, as the local service is: the delete question counts it at once.
        mocks.getHistory.mockReturnValue([]);
        mocks.getAllHistory.mockReturnValue([]);
        mocks.deleteTask.mockResolvedValue(undefined);
        mocks.initLocalDatabase.mockResolvedValue(undefined);
        mocks.exportChecklist.mockResolvedValue('shared');
        mocks.exportHistory.mockResolvedValue('shared');
    });

    it('erases A tasks/sheets and restores B engine hours before B load resolves', async () => {
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Private A maintenance');
        expect(screen.getByText('111')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Options Private A maintenance' }));
        expect(screen.getByRole('region', { name: 'Service Private A maintenance' })).toBeInTheDocument();

        const accountBLoad = deferred<MaintenanceTask[]>();
        mocks.getTasks.mockReturnValueOnce(accountBLoad.promise);
        const accountB = {
            key: 'user:account-b',
            userId: 'account-b',
            generation: 999,
        };
        localStorage.setItem(authScopedStorageKey('thalassa_engine_hours', accountB), '222');
        localStorage.setItem(authScopedStorageKey('thalassa_maintenance_seeded', accountB), '1');

        act(() => setAuthIdentityScope('account-b'));

        expect(screen.queryByText('Private A maintenance')).not.toBeInTheDocument();
        expect(screen.queryByRole('region', { name: 'Service Private A maintenance' })).not.toBeInTheDocument();
        expect(screen.getByText('222')).toBeInTheDocument();

        accountBLoad.resolve([task('b-task', 'Private B maintenance')]);
        await screen.findByText('Private B maintenance');

        mocks.getTasks.mockResolvedValueOnce([task('a-task', 'Private A maintenance')]);
        act(() => setAuthIdentityScope('account-a'));
        expect(screen.getByText('111')).toBeInTheDocument();
        await screen.findByText('Private A maintenance');
        expect(screen.queryByText('Private B maintenance')).not.toBeInTheDocument();
    });

    it('drops a deferred A service-log completion after switching to B', async () => {
        const logged = deferred<unknown>();
        mocks.logService.mockReturnValue(logged.promise);
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Private A maintenance');
        fireEvent.click(screen.getByRole('button', { name: 'Options Private A maintenance' }));
        fireEvent.click(screen.getByRole('button', { name: 'Log service' }));
        await waitFor(() => expect(mocks.logService).toHaveBeenCalledWith('a-task', 111, null, null));

        const accountBLoad = deferred<MaintenanceTask[]>();
        mocks.getTasks.mockReturnValueOnce(accountBLoad.promise);
        act(() => setAuthIdentityScope('account-b'));
        logged.resolve({});
        await act(async () => logged.promise);

        // With or without its Undo action (126-B7a).
        expect(mocks.toastSuccess.mock.calls.map(([message]) => message)).not.toContain('Service logged');
        expect(mocks.flash).not.toHaveBeenCalled();
        expect(screen.queryByText('Private A maintenance')).not.toBeInTheDocument();

        accountBLoad.resolve([]);
        await act(async () => accountBLoad.promise);
    });

    it('rejects an old A delete timer callback after B becomes active', async () => {
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Private A maintenance');
        fireEvent.click(screen.getByRole('button', { name: 'Delete Private A maintenance' }));
        const staleDismiss = mocks.undoProps?.onDismiss;
        expect(staleDismiss).toBeTypeOf('function');

        const accountBLoad = deferred<MaintenanceTask[]>();
        mocks.getTasks.mockReturnValueOnce(accountBLoad.promise);
        act(() => setAuthIdentityScope('account-b'));
        await act(async () => staleDismiss?.());

        expect(mocks.deleteTask).not.toHaveBeenCalled();
        accountBLoad.resolve([]);
        await act(async () => accountBLoad.promise);
    });

    it("exports the account's own tasks with its engine hours and canonical vessel name", async () => {
        const exported = deferred<string>();
        mocks.exportChecklist.mockReturnValue(exported.promise);
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Private A maintenance');

        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
        // Named by its visible words (UX scorecard run 7: label in name).
        fireEvent.click(screen.getByRole('button', { name: 'Share or save blank checklist' }));
        await waitFor(() =>
            expect(mocks.exportChecklist).toHaveBeenCalledWith(
                [expect.objectContaining({ id: 'a-task' })],
                111,
                'Account A Vessel',
            ),
        );

        const accountBLoad = deferred<MaintenanceTask[]>();
        mocks.getTasks.mockReturnValueOnce(accountBLoad.promise);
        act(() => setAuthIdentityScope('account-b'));
        exported.resolve('downloaded');
        await act(async () => exported.promise);
        expect(screen.queryByText('Private A maintenance')).not.toBeInTheDocument();
        // A's PDF says nothing on B's screen.
        expect(mocks.toastSuccess).not.toHaveBeenCalledWith('PDF downloaded');
        accountBLoad.resolve([]);
        await act(async () => accountBLoad.promise);
    });

    it("closes A's PDF menu when B signs in", async () => {
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Private A maintenance');
        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
        const accountBLoad = deferred<MaintenanceTask[]>();
        mocks.getTasks.mockReturnValueOnce(accountBLoad.promise);
        act(() => setAuthIdentityScope('account-b'));
        expect(screen.queryByRole('button', { name: 'Share or save blank checklist' })).not.toBeInTheDocument();
        expect(mocks.exportChecklist).not.toHaveBeenCalled();
        accountBLoad.resolve([]);
        await act(async () => accountBLoad.promise);
    });

    it('seeds defaults independently for A and B', async () => {
        localStorage.clear();
        // Defaults seed only once the server has confirmed each account's crew
        // shares (shared binders, 2026-10-02): both are confirmed, no shares.
        for (const userId of ['account-a', 'account-b'])
            localStorage.setItem(
                `thalassa_shared_binders_v1::user%3A${userId}`,
                JSON.stringify({ version: 1, userId, confirmedAt: '2026-10-02T00:00:00.000Z', skippers: [] }),
            );
        reloadSharedBindersFromStorage();
        mocks.getTasks.mockResolvedValue([]);
        render(<MaintenanceHub onBack={vi.fn()} />);
        await waitFor(() => expect(mocks.seedDefaults).toHaveBeenCalledTimes(1));

        act(() => setAuthIdentityScope('account-b'));
        await waitFor(() => expect(mocks.seedDefaults).toHaveBeenCalledTimes(2));

        const accountA = {
            key: 'user:account-a',
            userId: 'account-a',
            generation: 0,
        };
        const accountB = {
            key: 'user:account-b',
            userId: 'account-b',
            generation: 0,
        };
        expect(localStorage.getItem(authScopedStorageKey('thalassa_maintenance_seeded', accountA))).toBe('1');
        expect(localStorage.getItem(authScopedStorageKey('thalassa_maintenance_seeded', accountB))).toBe('1');
    });

    it('does not read maintenance cache before the captured database scope is ready', async () => {
        const accountAReady = deferred<void>();
        mocks.initLocalDatabase.mockReturnValueOnce(accountAReady.promise);
        mocks.getTasks.mockResolvedValueOnce([]);
        render(<MaintenanceHub onBack={vi.fn()} />);
        await waitFor(() => expect(mocks.initLocalDatabase).toHaveBeenCalledWith('account-a'));
        expect(mocks.getTasks).not.toHaveBeenCalled();

        localStorage.setItem(
            authScopedStorageKey('thalassa_maintenance_seeded', {
                key: 'user:account-b',
                userId: 'account-b',
                generation: 0,
            }),
            '1',
        );
        act(() => setAuthIdentityScope('account-b'));
        await waitFor(() => expect(mocks.getTasks).toHaveBeenCalledTimes(1));
        accountAReady.resolve();
        await act(async () => accountAReady.promise);

        expect(mocks.getTasks).toHaveBeenCalledTimes(1);
        expect(screen.queryByText('Private A maintenance')).not.toBeInTheDocument();
    });
});

/**
 * Share or save, from the phone's own rows (130-B8; binder audit MAINT-01,
 * MAINT-13, MAINT-14): the PDFs fetched from the server, so offline at sea
 * they came out blank, and an unused Export PDF sheet sat in the page. Crew
 * on a skipper's shared R&M get his boat's name, not their own.
 */
describe('R&M: Share or save', () => {
    const record = (id: string, taskId: string): MaintenanceHistory => ({
        id,
        user_id: 'account-a',
        task_id: taskId,
        completed_at: '2026-09-01T00:00:00.000Z',
        engine_hours_at_service: 100,
        notes: null,
        cost: null,
        created_at: '2026-09-01T00:00:00.000Z',
    });

    beforeEach(() => {
        vi.clearAllMocks();
        mocks.undoProps = null;
        localStorage.clear();
        setAuthIdentityScope(null);
        const accountA = setAuthIdentityScope('account-a');
        localStorage.setItem(authScopedStorageKey('thalassa_maintenance_seeded', accountA), '1');
        localStorage.setItem(authScopedStorageKey('thalassa_engine_hours', accountA), '111');
        mocks.getTasks.mockResolvedValue([task('a-task', 'Private A maintenance'), task('a-two', 'Second A task')]);
        mocks.getHistory.mockReturnValue([]);
        mocks.getAllHistory.mockReturnValue([record('r1', 'a-task'), record('r2', 'a-two')]);
        mocks.initLocalDatabase.mockResolvedValue(undefined);
        mocks.exportChecklist.mockResolvedValue('shared');
        mocks.exportHistory.mockResolvedValue('shared');
    });

    async function openMenu() {
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Private A maintenance');
        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
    }

    /** This sailor is crew on a skipper's boat that shares R&M (shared binders, 2026-10-02). */
    function crewOnSharedMaintenance(vesselName: string | null): void {
        localStorage.setItem(
            authScopedStorageKey('thalassa_shared_binders_v1', getAuthIdentityScope()),
            JSON.stringify({
                version: 1,
                userId: 'account-a',
                confirmedAt: '2026-10-14T00:00:00.000Z',
                skippers: [
                    {
                        ownerId: 'skipper-b',
                        vesselName,
                        lastAcceptedAt: '2026-10-14T00:00:00.000Z',
                        registers: { maintenance: { read: true, write: true } },
                    },
                ],
            }),
        );
        reloadSharedBindersFromStorage();
    }

    it("prints the skipper's boat on his shared R&M, not the crew member's own", async () => {
        crewOnSharedMaintenance('Wind Dancer');
        await openMenu();
        expect(screen.getByText(/Shared from Wind Dancer/)).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Share or save blank checklist' }));
        await waitFor(() => expect(mocks.exportChecklist).toHaveBeenCalledTimes(1));
        expect(mocks.exportChecklist.mock.calls[0][2]).toBe('Wind Dancer');
        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
        fireEvent.click(screen.getByRole('button', { name: 'Share or save service history' }));
        await waitFor(() => expect(mocks.exportHistory).toHaveBeenCalledTimes(1));
        expect(mocks.exportHistory.mock.calls[0][2]).toBe('Wind Dancer');
    });

    it("prints no name when the skipper's boat has none, rather than the crew member's", async () => {
        crewOnSharedMaintenance(null);
        await openMenu();
        fireEvent.click(screen.getByRole('button', { name: 'Share or save blank checklist' }));
        await waitFor(() => expect(mocks.exportChecklist).toHaveBeenCalledTimes(1));
        expect(mocks.exportChecklist.mock.calls[0][2]).toBe('');
    });

    it('offers one row per PDF and no Export PDF sheet', async () => {
        await openMenu();
        expect(screen.getByRole('button', { name: 'Share or save blank checklist' })).toBeEnabled();
        expect(screen.getByRole('button', { name: 'Share or save service history' })).toBeEnabled();
        fireEvent.click(screen.getByRole('button', { name: 'Share or save blank checklist' }));
        await waitFor(() => expect(mocks.exportChecklist).toHaveBeenCalledTimes(1));
        expect(screen.queryByRole('region', { name: 'Export PDF' })).not.toBeInTheDocument();
        const source = readFileSync(join(process.cwd(), 'components/vessel/MaintenanceHub.tsx'), 'utf8');
        expect(source).not.toMatch(/showExportModal|EXPORT PDF MODAL|Choose a report format/);
    });

    it("prints the service history from the phone's records, leaving out a task waiting out its Undo", async () => {
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Second A task');
        fireEvent.click(screen.getByRole('button', { name: 'Delete Second A task' }));
        await waitFor(() => expect(screen.queryByText('Second A task')).not.toBeInTheDocument());
        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
        fireEvent.click(screen.getByRole('button', { name: 'Share or save service history' }));
        await waitFor(() => expect(mocks.exportHistory).toHaveBeenCalledTimes(1));
        const [records, titles, vessel] = mocks.exportHistory.mock.calls[0];
        expect(records.map((entry: MaintenanceHistory) => entry.id)).toEqual(['r1']);
        expect(titles.map((entry: MaintenanceTask) => entry.id)).toEqual(['a-task', 'a-two']);
        expect(vessel).toBe('Account A Vessel');
        // The checklist leaves it out too.
        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
        fireEvent.click(screen.getByRole('button', { name: 'Share or save blank checklist' }));
        await waitFor(() => expect(mocks.exportChecklist).toHaveBeenCalledTimes(1));
        expect(mocks.exportChecklist.mock.calls[0][0].map((entry: MaintenanceTask) => entry.id)).toEqual(['a-task']);
    });

    it('says so instead of sending a blank PDF', async () => {
        mocks.exportChecklist.mockResolvedValue('empty');
        mocks.exportHistory.mockResolvedValue('empty');
        await openMenu();
        fireEvent.click(screen.getByRole('button', { name: 'Share or save blank checklist' }));
        await waitFor(() => expect(mocks.toastInfo).toHaveBeenCalledWith('No active tasks to put on a checklist yet.'));
        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
        fireEvent.click(screen.getByRole('button', { name: 'Share or save service history' }));
        await waitFor(() =>
            expect(mocks.toastInfo).toHaveBeenCalledWith('No services logged yet, so there is no history to share.'),
        );
    });

    it('starts no second PDF while one is being made', async () => {
        const exported = deferred<string>();
        mocks.exportChecklist.mockReturnValue(exported.promise);
        await openMenu();
        fireEvent.click(screen.getByRole('button', { name: 'Share or save blank checklist' }));
        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
        expect(screen.getByRole('button', { name: 'Share or save blank checklist' })).toBeDisabled();
        expect(screen.getByRole('button', { name: 'Share or save service history' })).toBeDisabled();
        fireEvent.click(screen.getByRole('button', { name: 'Share or save service history' }));
        expect(mocks.exportChecklist).toHaveBeenCalledTimes(1);
        expect(mocks.exportHistory).not.toHaveBeenCalled();
        await act(async () => exported.resolve('shared'));
        expect(screen.getByRole('button', { name: 'Share or save service history' })).toBeEnabled();
    });

    it('says downloaded only on a download, and owns up to a failure', async () => {
        mocks.exportChecklist.mockResolvedValueOnce('downloaded').mockRejectedValueOnce(new Error('no canvas'));
        await openMenu();
        fireEvent.click(screen.getByRole('button', { name: 'Share or save blank checklist' }));
        await waitFor(() => expect(mocks.toastSuccess).toHaveBeenCalledWith('PDF downloaded'));
        fireEvent.click(screen.getByRole('button', { name: 'Page actions' }));
        fireEvent.click(screen.getByRole('button', { name: 'Share or save blank checklist' }));
        await waitFor(() => expect(mocks.toastError).toHaveBeenCalledWith('Could not make the PDF. Try again.'));
    });
});
