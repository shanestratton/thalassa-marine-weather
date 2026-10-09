import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { getAllMock, logWarn, live } = vi.hoisted(() => ({
    getAllMock: vi.fn(),
    logWarn: vi.fn(),
    /** What the page subscribed to: its realtime tables and handler, its sync listeners, shimmer mounts. */
    live: {
        tables: null as string[] | null,
        onRealtime: null as (() => void) | null,
        syncListeners: [] as ((result: {
            pushed: number;
            pulled: number;
            pruned?: number;
            errors: string[];
        }) => void)[],
        shimmerMounts: 0,
    },
}));

vi.mock('../../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: logWarn, error: vi.fn() }),
}));

vi.mock('../../utils/system', () => ({ triggerHaptic: vi.fn() }));

vi.mock('../../hooks/useRealtimeSync', () => ({
    useRealtimeSync: vi.fn(),
    useRealtimeSyncMulti: (tables: string[], onSync: () => void) => {
        live.tables = tables;
        live.onRealtime = onSync;
    },
}));

vi.mock('../../services/vessel/SyncService', () => ({
    onSyncComplete: (listener: (typeof live.syncListeners)[number]) => {
        live.syncListeners.push(listener);
        return () => {
            live.syncListeners = live.syncListeners.filter((candidate) => candidate !== listener);
        };
    },
}));

vi.mock('../../components/ui/ShimmerBlock', () => ({
    ShimmerBlock: () => {
        React.useEffect(() => {
            live.shimmerMounts += 1;
        }, []);
        return <div data-testid="shimmer" />;
    },
}));

vi.mock('../../services/vessel/LocalChecklistService', () => ({
    LocalChecklistService: {
        getAll: getAllMock,
        create: vi.fn().mockResolvedValue({ id: 'new-entry' }),
        update: vi.fn().mockResolvedValue({}),
        delete: vi.fn().mockResolvedValue(undefined),
        saveRun: vi.fn().mockResolvedValue({}),
    },
}));

vi.mock('../../services/vessel/LocalMaintenanceService', () => ({
    LocalMaintenanceService: {
        createTask: vi.fn().mockResolvedValue({ id: 'maintenance-task' }),
    },
}));

vi.mock('../../services/vessel/LocalDatabase', () => ({
    generateUUID: vi.fn(() => 'run-1'),
}));

vi.mock('../../components/ui/SlideToAction', () => ({
    SlideToAction: ({ label, onConfirm }: { label: string; onConfirm: () => void }) => (
        <button type="button" onClick={onConfirm}>
            {label}
        </button>
    ),
}));

vi.mock('../../components/ui/PageHeader', () => ({
    PageHeader: ({ title, action }: { title: string; action?: React.ReactNode }) => (
        <header>
            <h1>{title}</h1>
            {action}
        </header>
    ),
}));

vi.mock('../../components/ui/EmptyState', () => ({
    EmptyState: () => <div data-testid="empty-state">No checklists</div>,
}));

vi.mock('../../components/Toast', () => ({
    toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

import { ChecklistsPage } from '../../components/vessel/ChecklistsPage';
import { LocalChecklistService } from '../../services/vessel/LocalChecklistService';
import { LocalMaintenanceService } from '../../services/vessel/LocalMaintenanceService';
import { SharedBinderReadOnlyError } from '../../services/vessel/sharedBinders';
import { toast } from '../../components/Toast';

const checklistEntries = [
    {
        id: 'heading-1',
        type: 'heading' as const,
        text: 'Before departure',
        heading_id: null,
        order: 1,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
    },
    {
        id: 'item-1',
        type: 'detail' as const,
        text: 'Check bilge pump',
        heading_id: 'heading-1',
        order: 2,
        created_at: '2026-01-01T00:00:00.000Z',
        updated_at: '2026-01-01T00:00:00.000Z',
    },
];

function openChecklistRun() {
    const pageActions = screen.getByRole('button', { name: 'Page actions' });
    fireEvent.click(pageActions);
    fireEvent.click(screen.getByRole('button', { name: 'Run checklist inspection' }));
    return pageActions;
}

describe('ChecklistsPage', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        getAllMock.mockReturnValue(checklistEntries);
    });

    it('renders the loaded checklist', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        expect(screen.getByText('Before departure')).toBeDefined();
        expect(screen.getByText('Check bilge pump')).toBeDefined();
    });

    it('opens run mode as a labelled modal with safe initial focus', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        openChecklistRun();

        const dialog = screen.getByRole('dialog', { name: 'Run checklist' });
        const exitButton = screen.getByRole('button', { name: 'Exit checklist run' });
        expect(dialog.getAttribute('aria-modal')).toBe('true');
        expect(document.activeElement).toBe(exitButton);
        expect(screen.getByRole('progressbar', { name: 'Checklist completion' }).getAttribute('aria-valuenow')).toBe(
            '0',
        );
    });

    it('makes status changes keyboard-operable with specific action names', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        openChecklistRun();

        fireEvent.click(
            screen.getByRole('button', {
                name: 'Check bilge pump: not checked. Change status to passed',
            }),
        );

        expect(
            screen.getByRole('button', {
                name: 'Check bilge pump: passed. Change status to failed',
            }),
        ).toBeDefined();
        expect(screen.getByRole('progressbar', { name: 'Checklist completion' }).getAttribute('aria-valuenow')).toBe(
            '1',
        );
    });

    it('exits on Escape and restores focus to the persistent page-actions control', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        const pageActions = openChecklistRun();
        const exitButton = screen.getByRole('button', { name: 'Exit checklist run' });

        fireEvent.keyDown(exitButton, { key: 'Escape' });

        expect(screen.queryByRole('dialog', { name: 'Run checklist' })).toBeNull();
        expect(document.activeElement).toBe(pageActions);
    });
});

/**
 * Completing a run tells the skipper how many repairs actually reached
 * Maintenance (binder audit 2026-10-09, CHK-02): the toast used to count the
 * flagged items, so a repair that failed to save still read as added. Fictional
 * lists: 'Pre-departure' and 'Heavy weather'.
 */
describe('ChecklistsPage: flagged repairs on Complete', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const twoLists = [
        {
            id: 'h-pre',
            type: 'heading' as const,
            text: 'Pre-departure',
            heading_id: null,
            order: 1,
            created_at: at,
            updated_at: at,
        },
        {
            id: 'i-bilge',
            type: 'detail' as const,
            text: 'Bilge pump test',
            heading_id: 'h-pre',
            order: 2,
            created_at: at,
            updated_at: at,
        },
        {
            id: 'h-heavy',
            type: 'heading' as const,
            text: 'Heavy weather',
            heading_id: null,
            order: 3,
            created_at: at,
            updated_at: at,
        },
        {
            id: 'i-jacklines',
            type: 'detail' as const,
            text: 'Jacklines rigged',
            heading_id: 'h-heavy',
            order: 4,
            created_at: at,
            updated_at: at,
        },
    ];
    const createTask = vi.mocked(LocalMaintenanceService.createTask);
    const saveRun = vi.mocked(LocalChecklistService.saveRun);

    beforeEach(() => {
        vi.clearAllMocks();
        getAllMock.mockReturnValue(twoLists);
        createTask.mockReset().mockResolvedValue({ id: 'maintenance-task' } as never);
        saveRun.mockReset().mockResolvedValue({} as never);
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    /** Fail an item (not checked -> passed -> failed) and flag it for a repair. */
    function failAndFlag(text: string) {
        fireEvent.click(screen.getByRole('button', { name: `${text}: not checked. Change status to passed` }));
        fireEvent.click(screen.getByRole('button', { name: `${text}: passed. Change status to failed` }));
        fireEvent.click(screen.getByRole('button', { name: `Flag ${text} for repair and maintenance` }));
    }

    function startRunWithBothFlagged() {
        render(<ChecklistsPage onBack={vi.fn()} />);
        openChecklistRun();
        failAndFlag('Bilge pump test');
        failAndFlag('Jacklines rigged');
    }

    it('counts only the repairs that were added, and says plainly which were not', async () => {
        createTask
            .mockResolvedValueOnce({ id: 'maintenance-task' } as never)
            .mockRejectedValueOnce(new Error('[LocalDB] Not initialized. Call initLocalDatabase() first.'));
        startRunWithBothFlagged();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Complete checklist run' }));
        });

        await waitFor(() => expect(createTask).toHaveBeenCalledTimes(2));
        expect(toast.info).toHaveBeenCalledTimes(1);
        expect(toast.info).toHaveBeenCalledWith('1 repair added to Maintenance');
        const failures = vi.mocked(toast.error).mock.calls.map(([message]) => String(message));
        // The run closes on Complete, so the toast names the one that failed and says where to add it.
        expect(failures).toContain("Couldn't add “Jacklines rigged” to Maintenance — add it there by hand");
        expect(failures.some((message) => /still flagged/.test(message))).toBe(false);
        expect(logWarn).toHaveBeenCalledWith(expect.stringMatching(/^checklists: repair-not-added \(local-db\)$/));
        // Logs carry reasons, never the item's name.
        expect(JSON.stringify(logWarn.mock.calls)).not.toContain('Jacklines');
    });

    it('says nothing was added when every repair failed, and names a view-only R&M', async () => {
        createTask.mockRejectedValue(new SharedBinderReadOnlyError('maintenance', 'R&M is view only on Kestrel'));
        startRunWithBothFlagged();

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Complete checklist run' }));
        });

        await waitFor(() => expect(createTask).toHaveBeenCalledTimes(2));
        expect(toast.info).not.toHaveBeenCalled();
        const failures = vi.mocked(toast.error).mock.calls.map(([message]) => String(message));
        expect(failures).toContain(
            "Couldn't add 2 repairs to Maintenance (Bilge pump test, Jacklines rigged) — add them there by hand",
        );
        expect(failures.some((message) => /added to Maintenance$/.test(message))).toBe(false);
        expect(logWarn).toHaveBeenCalledWith('checklists: repair-not-added (read-only)');
    });

    it('a double tap on Complete saves the run once and adds each repair once', async () => {
        let releaseSave!: () => void;
        saveRun.mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    releaseSave = () => resolve({} as never);
                }),
        );
        startRunWithBothFlagged();
        const complete = screen.getByRole('button', { name: 'Complete checklist run' });

        await act(async () => {
            fireEvent.click(complete);
            fireEvent.click(complete);
        });
        await act(async () => {
            releaseSave();
        });

        await waitFor(() => expect(toast.info).toHaveBeenCalledWith('2 repairs added to Maintenance'));
        expect(saveRun).toHaveBeenCalledTimes(1);
        expect(createTask).toHaveBeenCalledTimes(2);
    });

    it("a repair is due on the skipper's own calendar day, not the UTC one", async () => {
        const was = process.env.TZ;
        process.env.TZ = 'America/Los_Angeles';
        try {
            vi.useFakeTimers({ toFake: ['Date'] });
            // 18:00 on Fri 9 Oct in Los Angeles is already Sat 10 Oct in UTC.
            vi.setSystemTime(new Date(2026, 9, 9, 18, 0));
            render(<ChecklistsPage onBack={vi.fn()} />);
            openChecklistRun();
            failAndFlag('Bilge pump test');

            await act(async () => {
                fireEvent.click(screen.getByRole('button', { name: 'Complete checklist run' }));
            });

            await waitFor(() => expect(createTask).toHaveBeenCalledTimes(1));
            expect(createTask.mock.calls[0][0].next_due_date).toBe('2026-10-09');
        } finally {
            vi.useRealTimers();
            if (was === undefined) delete process.env.TZ;
            else process.env.TZ = was;
        }
    });
});

/**
 * Live across devices (126-B9a, CHK-01): a list changed on the phone shows on
 * the open page on the iPad, without the loading shimmer. Fictional lists.
 */
describe('ChecklistsPage: changes from another device', () => {
    const at = '2026-01-01T00:00:00.000Z';
    const preDeparture = [
        {
            id: 'h-pre',
            type: 'heading' as const,
            text: 'Pre-departure',
            heading_id: null,
            order: 1,
            created_at: at,
            updated_at: at,
        },
        {
            id: 'i-bilge',
            type: 'detail' as const,
            text: 'Check bilge pump',
            heading_id: 'h-pre',
            order: 2,
            created_at: at,
            updated_at: at,
        },
    ];
    const seacocks = {
        id: 'i-seacocks',
        type: 'detail' as const,
        text: 'Close seacocks',
        heading_id: 'h-pre',
        order: 3,
        created_at: at,
        updated_at: at,
    };

    beforeEach(() => {
        vi.clearAllMocks();
        live.tables = null;
        live.onRealtime = null;
        live.syncListeners = [];
        live.shimmerMounts = 0;
        getAllMock.mockReturnValue(preDeparture);
    });

    it('follows both checklist tables on one realtime channel', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        expect(live.tables).toEqual(['checklists', 'checklist_runs']);
    });

    it('a background reload shows the change without the loading shimmer', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        expect(screen.getByText('Check bilge pump')).toBeDefined();
        const shimmerAfterMount = live.shimmerMounts;

        getAllMock.mockReturnValue([...preDeparture, seacocks]);
        act(() => live.onRealtime?.());
        expect(screen.getByText('Close seacocks')).toBeDefined();
        expect(screen.queryByTestId('shimmer')).toBeNull();
        expect(live.shimmerMounts).toBe(shimmerAfterMount);
    });

    it('a failed background read keeps the list on screen: no error state, no toast', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        getAllMock.mockImplementation(() => {
            throw new Error('device database closed mid-switch');
        });

        act(() => live.onRealtime?.());
        act(() => live.syncListeners.forEach((listener) => listener({ pushed: 0, pulled: 1, errors: [] })));

        expect(screen.getByText('Check bilge pump')).toBeDefined();
        expect(screen.queryByTestId('empty-state')).toBeNull();
        expect(toast.error).not.toHaveBeenCalledWith('Failed to load checklists');
    });

    it('a Save onto an item already deleted on another device says nothing was saved', async () => {
        vi.mocked(LocalChecklistService.update).mockResolvedValueOnce(null);
        render(<ChecklistsPage onBack={vi.fn()} />);
        fireEvent.click(screen.getByRole('button', { name: 'Edit checklist item: Check bilge pump' }));
        fireEvent.change(screen.getByLabelText(/Check item/), { target: { value: 'Check both bilge pumps' } });

        await act(async () => {
            fireEvent.click(screen.getByRole('button', { name: 'Save changes' }));
        });

        expect(LocalChecklistService.update).toHaveBeenCalledWith('i-bilge', { text: 'Check both bilge pumps' });
        expect(toast.error).toHaveBeenCalledWith('This item was removed on another device. Nothing was saved.');
        expect(toast.success).not.toHaveBeenCalled();
        expect(screen.queryByRole('button', { name: 'Save changes' })).toBeNull();
    });

    it('re-reads after a sync that changed rows here, and not after one that changed nothing', () => {
        render(<ChecklistsPage onBack={vi.fn()} />);
        const readsAfterMount = getAllMock.mock.calls.length;

        act(() => live.syncListeners.forEach((listener) => listener({ pushed: 0, pulled: 0, errors: [] })));
        expect(getAllMock.mock.calls.length).toBe(readsAfterMount);

        getAllMock.mockReturnValue([preDeparture[0]]);
        act(() => live.syncListeners.forEach((listener) => listener({ pushed: 0, pulled: 0, pruned: 1, errors: [] })));
        expect(screen.queryByText('Check bilge pump')).toBeNull();
    });
});
