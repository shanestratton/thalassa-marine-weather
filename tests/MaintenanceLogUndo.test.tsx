/**
 * A mistaken service log can be taken back, and a mistaken record removed
 * (126-B7a, binder audit MAINT-09; Shane 2026-10-09: "check all of the binders
 * to make sure that they are at the same standard as the rest of the app").
 *
 * A daily check was logged nine times on 2026-10-02 and nothing could undo
 * one: 'Service logged' had no action, and the Service history rows were
 * plain text. Now the skipper gets 'Service logged · Undo' (the record goes,
 * and the task's next-due comes back), and a Remove on each history record,
 * with its own Undo. Crew on a shared R&M get neither: deletes are the
 * skipper's in RLS, and a crew DELETE would fail forever in the outbox.
 *
 * BinderLiveSync.test.tsx's harness: the real LocalDatabase (Filesystem is
 * the global mock) under the real LocalMaintenanceService and the real page.
 * Fictional boat 'Kestrel' out of Horta (skipper 'skipper-kestrel', crew
 * 'crew-ana'); tasks 'Raw-water impeller' and 'Rig inspection'.
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
import { getById, getFullQueue, initLocalDatabase, mergePulledRecords } from '../services/vessel/LocalDatabase';
import { reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';
import { LocalMaintenanceService } from '../services/vessel/LocalMaintenanceService';
import { MaintenanceHub } from '../components/vessel/MaintenanceHub';
import { clockTime } from '../components/vessel/maintenance/ServiceLogSheet';
import { formatDisplayDate } from '../utils/displayDate';
import { toast } from '../components/Toast';

const NOW = '2026-10-10T01:00:00.000Z';
const SKIPPER = 'skipper-kestrel';
let accountCounter = 0;

function task(id: string, owner: string, title: string, patch: Partial<MaintenanceTask> = {}): MaintenanceTask {
    return {
        id,
        user_id: owner,
        title,
        description: null,
        category: 'Rigging',
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

function record(id: string, owner: string, taskId: string, completedAt: string): MaintenanceHistory {
    return {
        id,
        user_id: owner,
        task_id: taskId,
        completed_at: completedAt,
        engine_hours_at_service: null,
        notes: `Checked ${id}`,
        cost: null,
        created_at: completedAt,
    };
}

async function binder(owner: string): Promise<void> {
    await mergePulledRecords('maintenance_tasks', [
        task('t-rig', owner, 'Rig inspection'),
        task('t-impeller', owner, 'Raw-water impeller', { category: 'Engine', next_due_date: '2026-12-01' }),
    ]);
    await mergePulledRecords('maintenance_history', [
        record('h-mar', owner, 't-impeller', '2026-03-03T08:00:00.000Z'),
        record('h-jun', owner, 't-impeller', '2026-06-03T08:00:00.000Z'),
    ]);
}

/** The skipper on their own phone. */
async function asSkipper(): Promise<string> {
    accountCounter += 1;
    const me = `${SKIPPER}-${accountCounter}`;
    act(() => setAuthIdentityScope(me));
    await initLocalDatabase(me);
    localStorage.setItem(`thalassa_maintenance_seeded::user%3A${me}`, '1');
    await binder(me);
    return me;
}

/** Crew on Kestrel's shared R&M, with write: the skipper's rows on the crew's phone. */
async function asCrew(): Promise<void> {
    accountCounter += 1;
    const me = `crew-ana-${accountCounter}`;
    act(() => setAuthIdentityScope(me));
    const none = { read: false, write: false };
    localStorage.setItem(
        `thalassa_shared_binders_v1::user%3A${me}`,
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
                        stores: none,
                        equipment: none,
                        maintenance: { read: true, write: true },
                        documents: none,
                    },
                },
            ],
        }),
    );
    act(() => reloadSharedBindersFromStorage());
    await initLocalDatabase(me);
    await binder(SKIPPER);
}

const card = (title: string) => screen.getByText(title).closest('div.relative') as HTMLElement;

async function logService(title: string): Promise<void> {
    fireEvent.click(screen.getByRole('button', { name: `Options for ${title}` }));
    const sheet = await screen.findByRole('dialog', { name: title });
    fireEvent.click(within(sheet).getByRole('button', { name: 'Log service' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: title })).not.toBeInTheDocument());
}

const lastSuccess = () => vi.mocked(toast.success).mock.calls.at(-1);

async function openHistory(title: string): Promise<HTMLElement> {
    fireEvent.click(screen.getByRole('button', { name: `Options for ${title}` }));
    const sheet = await screen.findByRole('dialog', { name: title });
    fireEvent.click(within(sheet).getByRole('button', { name: 'History' }));
    return screen.findByRole('dialog', { name: 'Service history' });
}

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

describe('Service logged · Undo', () => {
    it("the skipper's Undo removes the record and puts the card's next due back", async () => {
        await asSkipper();
        const undo = vi.spyOn(LocalMaintenanceService, 'undoLogService');
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Rig inspection');
        expect(within(card('Rig inspection')).getByText('Sun 14 Mar 2027')).toBeInTheDocument();

        await logService('Rig inspection');
        await waitFor(() => expect(lastSuccess()?.[0]).toBe('Service logged'));
        const action = lastSuccess()?.[1] as { label: string; onClick: () => void } | undefined;
        expect(action?.label).toBe('Undo');
        await waitFor(() =>
            expect(within(card('Rig inspection')).queryByText('Sun 14 Mar 2027')).not.toBeInTheDocument(),
        );
        expect(LocalMaintenanceService.getHistory('t-rig')).toHaveLength(1);

        await act(async () => action!.onClick());

        await waitFor(() => expect(undo).toHaveBeenCalledOnce());
        await waitFor(() => expect(within(card('Rig inspection')).getByText('Sun 14 Mar 2027')).toBeInTheDocument());
        expect(within(card('Rig inspection')).queryByText(/Last serviced/)).not.toBeInTheDocument();
        expect(LocalMaintenanceService.getHistory('t-rig')).toEqual([]);
        expect(getById<MaintenanceTask>('maintenance_tasks', 't-rig')).toMatchObject({
            next_due_date: '2027-03-14',
            last_completed: null,
        });
    });

    it('crew on the shared R&M get a plain "Service logged": no Undo to strand in the outbox', async () => {
        await asCrew();
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Rig inspection');

        await logService('Rig inspection');

        await waitFor(() => expect(lastSuccess()).toEqual(['Service logged']));
        expect(LocalMaintenanceService.getHistory('t-rig')).toHaveLength(1);
    });
});

describe('removing a mistaken record from Service history', () => {
    it('the skipper removes one, with Undo; the next due stays as it was', async () => {
        await asSkipper();
        const deleteHistory = vi.spyOn(LocalMaintenanceService, 'deleteHistory');
        const { unmount } = render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Raw-water impeller');

        const history = await openHistory('Raw-water impeller');
        expect(within(history).getByText("Removing a record doesn't change when the task is next due.")).toBeVisible();
        expect(within(history).getByRole('button', { name: 'Remove the 3 Mar 2026 record' })).toBeInTheDocument();

        fireEvent.click(within(history).getByRole('button', { name: 'Remove the 3 Jun 2026 record' }));
        await waitFor(() => expect(within(history).queryByText('Checked h-jun')).not.toBeInTheDocument());
        expect(within(history).getByText('Checked h-mar')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Undo delete action' }));
        expect(await within(history).findByText('Checked h-jun')).toBeInTheDocument();
        expect(deleteHistory).not.toHaveBeenCalled();
        expect(toast.success).toHaveBeenCalledWith('Record restored');

        fireEvent.click(within(history).getByRole('button', { name: 'Remove the 3 Jun 2026 record' }));
        await waitFor(() => expect(within(history).queryByText('Checked h-jun')).not.toBeInTheDocument());
        unmount();
        await waitFor(() => expect(deleteHistory).toHaveBeenCalledWith('h-jun'));
        expect(LocalMaintenanceService.getHistory('t-impeller').map((h) => h.id)).toEqual(['h-mar']);
        expect(getById<MaintenanceTask>('maintenance_tasks', 't-impeller')?.next_due_date).toBe('2026-12-01');
        expect(
            getFullQueue()
                .filter((item) => item.table_name.startsWith('maintenance_'))
                .map((item) => `${item.mutation_type} ${item.record_id}`),
        ).toEqual(['DELETE h-jun']);
    });

    it("two records on one day (a check logged twice) are told apart by the phone's clock", async () => {
        await asSkipper();
        const me = `${SKIPPER}-${accountCounter}`;
        await mergePulledRecords('maintenance_history', [
            record('h-twice-1', me, 't-rig', '2026-10-02T07:34:00.000Z'),
            record('h-twice-2', me, 't-rig', '2026-10-02T07:41:00.000Z'),
        ]);
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Rig inspection');

        const history = await openHistory('Rig inspection');
        for (const at of ['2026-10-02T07:34:00.000Z', '2026-10-02T07:41:00.000Z']) {
            const day = formatDisplayDate(at, { weekday: false });
            const clock = clockTime(at)!;
            expect(
                within(history).getByRole('button', { name: `Remove the ${day} ${clock} record` }),
            ).toBeInTheDocument();
        }
    });

    it('crew see the records but no Remove: deletes are the skipper’s', async () => {
        await asCrew();
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText('Raw-water impeller');

        const history = await openHistory('Raw-water impeller');
        expect(within(history).getByText('Checked h-jun')).toBeInTheDocument();
        expect(within(history).queryByRole('button', { name: /^Remove/ })).not.toBeInTheDocument();
        expect(within(history).queryByText(/Removing a record/)).not.toBeInTheDocument();
    });
});
