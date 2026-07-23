import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, setAuthIdentityScope } from '../../services/authIdentityScope';
import type { MaintenanceTask } from '../../types';
import type { TaskWithStatus } from '../../services/MaintenanceService';

const mocks = vi.hoisted(() => ({
    getTasks: vi.fn(),
    seedDefaults: vi.fn(),
    logService: vi.fn(),
    createTask: vi.fn(),
    updateTask: vi.fn(),
    getHistory: vi.fn(),
    deleteTask: vi.fn(),
    initLocalDatabase: vi.fn(),
    exportChecklist: vi.fn(),
    exportHistory: vi.fn(),
    toastSuccess: vi.fn(),
    toastError: vi.fn(),
    haptic: vi.fn(),
    flash: vi.fn(),
    undoProps: null as null | { onUndo: () => void; onDismiss: () => void },
}));

vi.mock('../../services/vessel/LocalMaintenanceService', () => ({
    LocalMaintenanceService: {
        getTasks: mocks.getTasks,
        seedDefaults: mocks.seedDefaults,
        logService: mocks.logService,
        createTask: mocks.createTask,
        updateTask: mocks.updateTask,
        getHistory: mocks.getHistory,
        deleteTask: mocks.deleteTask,
    },
}));

vi.mock('../../services/vessel/LocalDatabase', () => ({
    initLocalDatabase: mocks.initLocalDatabase,
}));

vi.mock('../../services/MaintenanceService', () => ({
    calculateStatus: (task: MaintenanceTask) => ({
        ...task,
        status: 'green',
        statusLabel: 'OK',
        daysRemaining: 30,
        hoursRemaining: null,
    }),
}));

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
    toast: { success: mocks.toastSuccess, error: mocks.toastError },
}));

vi.mock('../../components/ui/PageHeader', () => ({
    PageHeader: ({ title, action }: { title: string; action?: React.ReactNode }) => (
        <header>
            <h1>{title}</h1>
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
    ModalSheet: ({ children, title }: { children: React.ReactNode; title: string }) => (
        <section aria-label={title}>{children}</section>
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
        mocks.getHistory.mockResolvedValue([]);
        mocks.deleteTask.mockResolvedValue(undefined);
        mocks.initLocalDatabase.mockResolvedValue(undefined);
        mocks.exportChecklist.mockResolvedValue(undefined);
        mocks.exportHistory.mockResolvedValue(undefined);
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

        expect(mocks.toastSuccess).not.toHaveBeenCalledWith('Service logged');
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

    it('exports with the account-scoped engine hours and canonical vessel name', async () => {
        const exported = deferred<void>();
        mocks.exportChecklist.mockReturnValue(exported.promise);
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Private A maintenance');

        fireEvent.click(screen.getByRole('button', { name: 'More options' }));
        fireEvent.click(screen.getAllByRole('button', { name: 'Export data' })[0]);
        await waitFor(() => expect(mocks.exportChecklist).toHaveBeenCalledWith(111, 'Account A Vessel'));

        const accountBLoad = deferred<MaintenanceTask[]>();
        mocks.getTasks.mockReturnValueOnce(accountBLoad.promise);
        act(() => setAuthIdentityScope('account-b'));
        exported.resolve();
        await act(async () => exported.promise);
        expect(screen.queryByText('Private A maintenance')).not.toBeInTheDocument();
        accountBLoad.resolve([]);
        await act(async () => accountBLoad.promise);
    });

    it('seeds defaults independently for A and B', async () => {
        localStorage.clear();
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
