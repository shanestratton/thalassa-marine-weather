/**
 * R&M schedules that mean something, on the page (132-B15; binder audit
 * MAINT-04, MAINT-06, MAINT-10, MAINT-17).
 *
 *  - A repair is added as needing fixing, with no schedule asked for, counted
 *    "to fix". 'Mark fixed' takes it off the list to Fixed, its fix in the
 *    service history; Undo and Reopen put it back. It used to be a daily task
 *    due today, rolled on to tomorrow by every log, for ever.
 *  - A pre-trip check waits for a trip: in port it is never red, and never
 *    counted overdue.
 *  - A blank 'Next due (hours)' saves the reading plus the interval, in Add
 *    and Edit alike.
 *  - Add opens empty after an edit, saved or not.
 *
 * MaintenanceDeleteConfirm.test.tsx's harness: the real LocalDatabase
 * (Filesystem is the global mock) under the real LocalMaintenanceService and
 * the real page; only the socket, the sync engine and the PDFs are fakes.
 * Fictional boat 'Kestrel' out of Horta.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Filesystem } from '@capacitor/filesystem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MaintenanceTask } from '../types';

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

import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { getById, initLocalDatabase, mergePulledRecords } from '../services/vessel/LocalDatabase';
import { LocalMaintenanceService } from '../services/vessel/LocalMaintenanceService';
import { MaintenanceHub } from '../components/vessel/MaintenanceHub';
import { toast } from '../components/Toast';
import { toLocalDateString } from '../utils/localDate';
import { formatDisplayDate } from '../utils/displayDate';

// The edit sheets' keyboard scroll calls window.scrollBy, which jsdom lacks.
window.scrollBy = () => undefined;

const AT = '2026-10-01T01:00:00.000Z';
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
        next_due_date: '2099-03-14',
        next_due_hours: null,
        last_completed: null,
        is_active: true,
        created_at: AT,
        updated_at: AT,
        ...patch,
    };
}

/** A local 'YYYY-MM-DD', `days` from today. */
const dayFromToday = (days: number) => {
    const d = new Date();
    d.setDate(d.getDate() + days);
    return toLocalDateString(d);
};

async function openKestrel(tasks: MaintenanceTask[], engineHours: number | null = null): Promise<void> {
    accountCounter += 1;
    me = `skipper-kestrel-${accountCounter}`;
    act(() => setAuthIdentityScope(me));
    await initLocalDatabase(me);
    localStorage.setItem(`thalassa_maintenance_seeded::user%3A${me}`, '1');
    if (engineHours !== null) {
        localStorage.setItem(
            authScopedStorageKey('thalassa_engine_hours', getAuthIdentityScope()),
            String(engineHours),
        );
    }
    await mergePulledRecords(
        'maintenance_tasks',
        tasks.map((t) => ({ ...t, user_id: me })),
    );
    render(<MaintenanceHub onBack={vi.fn()} />);
    await waitFor(() => expect(screen.queryAllByTestId('shimmer')).toHaveLength(0));
}

const chips = () => screen.getByTestId('maintenance-status-chips').textContent ?? '';

async function openSheet(title: string): Promise<HTMLElement> {
    fireEvent.click(await screen.findByRole('button', { name: `Options for ${title}` }));
    return screen.findByRole('dialog', { name: title });
}

async function openAddSheet(): Promise<HTMLElement> {
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    return screen.findByRole('dialog', { name: 'New task' });
}

async function openEditSheet(title: string): Promise<HTMLElement> {
    const sheet = await openSheet(title);
    fireEvent.click(within(sheet).getByRole('button', { name: 'Edit task' }));
    return screen.findByRole('dialog', { name: 'Edit task' });
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

describe('repairs (MAINT-04, MAINT-05)', () => {
    it('Add task → Repair asks for no schedule and adds it as needing fixing, counted to fix', async () => {
        await openKestrel([task('t-impeller', 'Raw-water impeller')]);
        const createRepair = vi.spyOn(LocalMaintenanceService, 'createRepair');

        const add = await openAddSheet();
        fireEvent.click(within(add).getByRole('button', { name: 'Repair' }));
        expect(within(add).queryByText('Schedule')).toBeNull();
        expect(within(add).queryByLabelText('First due')).toBeNull();
        fireEvent.change(within(add).getByLabelText(/Task name/), { target: { value: 'Stern gland weeping' } });
        fireEvent.click(within(add).getByRole('button', { name: 'Create task' }));

        await waitFor(() => expect(createRepair).toHaveBeenCalledWith('Stern gland weeping', ''));
        expect(toast.success).toHaveBeenCalledWith('Repair added');
        const card = (await screen.findByText('Stern gland weeping')).closest('.relative') as HTMLElement;
        expect(within(card).getByText('Needs fixing')).toBeInTheDocument();
        expect(within(card).getByText(/^Added: /)).toBeInTheDocument();
        expect(chips()).toContain('1 to fix');
        expect(chips()).not.toContain('overdue');
        expect(screen.getByText(/^Tasks: 1 to fix, 1 not yet due\.$/)).toBeInTheDocument();
    });

    it('Mark fixed: no Pause, the fix in its history, off the list to Fixed; Undo puts it back', async () => {
        await openKestrel([task('t-bilge', 'Bilge pump float switch', { category: 'Repair', interval_value: null })]);
        const sheet = await openSheet('Bilge pump float switch');
        expect(within(sheet).queryByRole('button', { name: 'Pause' })).toBeNull();
        expect(within(sheet).queryByRole('button', { name: 'Log service' })).toBeNull();
        fireEvent.change(within(sheet).getByLabelText('Notes (optional)'), { target: { value: 'New float switch' } });
        fireEvent.click(within(sheet).getByRole('button', { name: 'Mark fixed' }));

        await waitFor(() =>
            expect(toast.success).toHaveBeenCalledWith(
                "“Bilge pump float switch” fixed. It's under Fixed.",
                expect.objectContaining({ label: 'Undo' }),
            ),
        );
        expect(LocalMaintenanceService.getHistory('t-bilge')).toMatchObject([{ notes: 'New float switch' }]);
        expect(getById<MaintenanceTask>('maintenance_tasks', 't-bilge')).toMatchObject({ is_active: false });
        await waitFor(() =>
            expect(screen.queryByRole('button', { name: 'Options for Bilge pump float switch' })).toBeNull(),
        );
        const fixed = screen.getByRole('button', { name: 'Fixed (1)' });
        expect(fixed).toHaveAttribute('aria-expanded', 'false');
        expect(screen.queryByRole('button', { name: /^Paused/ })).toBeNull();
        fireEvent.click(fixed);
        expect(await screen.findByText(/^Fixed: /)).toBeInTheDocument();

        // Undo, from the toast.
        const [, action] = vi.mocked(toast.success).mock.calls.find(([message]) => /fixed\./.test(String(message)))!;
        await act(async () => (action as { onClick: () => void }).onClick());
        await waitFor(() =>
            expect(getById<MaintenanceTask>('maintenance_tasks', 't-bilge')).toMatchObject({ is_active: true }),
        );
        expect(LocalMaintenanceService.getHistory('t-bilge')).toEqual([]);
        expect(toast.success).toHaveBeenCalledWith('Undone. It needs fixing again.');
        expect(await screen.findByText('Needs fixing')).toBeInTheDocument();
    });

    it('a fixed repair waits under Fixed, and reopens from there', async () => {
        await openKestrel([
            task('t-hatch', 'Forehatch seal', {
                category: 'Repair',
                is_active: false,
                last_completed: '2026-10-08T03:00:00.000Z',
            }),
        ]);
        fireEvent.click(screen.getByRole('button', { name: 'Fixed (1)' }));
        const sheet = await openSheet('Forehatch seal');
        expect(sheet).toHaveTextContent(
            `Fixed on ${formatDisplayDate('2026-10-08T03:00:00.000Z')}. Reopen it if it needs more work.`,
        );
        fireEvent.click(within(sheet).getByRole('button', { name: 'Reopen' }));

        await waitFor(() =>
            expect(toast.success).toHaveBeenCalledWith('“Forehatch seal” reopened: it needs fixing again'),
        );
        expect(await screen.findByText('Needs fixing')).toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Fixed (1)' })).toBeNull();
    });

    it('editing a repair asks for no schedule and leaves the one it has', async () => {
        await openKestrel([
            task('t-bilge', 'Bilge pump float switch', {
                category: 'Repair',
                interval_value: null,
                next_due_date: '2026-10-05',
            }),
        ]);
        const update = vi.spyOn(LocalMaintenanceService, 'updateTask');
        const edit = await openEditSheet('Bilge pump float switch');
        expect(within(edit).queryByText('Schedule')).toBeNull();
        expect(within(edit).queryByLabelText('Next due date')).toBeNull();
        fireEvent.change(within(edit).getByLabelText(/Task name/), {
            target: { value: 'Bilge pump float switch (aft)' },
        });
        fireEvent.click(within(edit).getByRole('button', { name: 'Save changes' }));

        await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
        expect(update.mock.calls[0][1]).toEqual({
            title: 'Bilge pump float switch (aft)',
            description: null,
            category: 'Repair',
        });
        expect(getById<MaintenanceTask>('maintenance_tasks', 't-bilge')).toMatchObject({ next_due_date: '2026-10-05' });
    });
});

describe('pre-trip checks wait for a trip (MAINT-06)', () => {
    it('a check last due a week ago reads "Due before your next trip", and nothing is overdue', async () => {
        await openKestrel([
            task('t-oil', 'Check Engine Oil & Coolant Levels', {
                trigger_type: 'daily',
                interval_value: 1,
                next_due_date: dayFromToday(-7),
                last_completed: new Date(Date.now() - 8 * 86_400_000).toISOString(),
            }),
        ]);
        const card = (await screen.findByText('Check Engine Oil & Coolant Levels')).closest('.relative') as HTMLElement;
        expect(within(card).getByText('Due before your next trip')).toBeInTheDocument();
        expect(within(card).getByTestId('task-due-detail')).toBeEmptyDOMElement();
        expect(chips()).not.toContain('overdue');
        expect(screen.getByText(/^Tasks: 1 up to date\.$/)).toBeInTheDocument();
    });

    it('adding one asks for no day, and saves none', async () => {
        await openKestrel([task('t-impeller', 'Raw-water impeller')]);
        const create = vi.spyOn(LocalMaintenanceService, 'createTask');
        const add = await openAddSheet();
        fireEvent.click(within(add).getByRole('button', { name: 'Pre-trip' }));
        expect(within(add).queryByLabelText('First due')).toBeNull();
        expect(within(add).getByText(/Due before each trip, not by date/)).toBeInTheDocument();
        fireEvent.change(within(add).getByLabelText(/Task name/), { target: { value: 'Check bilge is dry' } });
        fireEvent.click(within(add).getByRole('button', { name: 'Create task' }));

        await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
        expect(create.mock.calls[0][0]).toMatchObject({
            trigger_type: 'daily',
            interval_value: 1,
            next_due_date: null,
        });
        expect(await screen.findByText('Due before your next trip')).toBeInTheDocument();
    });
});

describe("a blank 'Next due (hours)' saves the reading plus the interval (MAINT-17)", () => {
    it('in Add', async () => {
        await openKestrel([task('t-impeller', 'Raw-water impeller')], 1250);
        const create = vi.spyOn(LocalMaintenanceService, 'createTask');
        const add = await openAddSheet();
        fireEvent.click(within(add).getByRole('button', { name: 'Engine hours' }));
        fireEvent.change(within(add).getByLabelText('Interval (hours)'), { target: { value: '250' } });
        // The placeholder shows what a blank saves.
        expect(within(add).getByLabelText('Next due (hours)')).toHaveAttribute('placeholder', '1500');
        fireEvent.change(within(add).getByLabelText(/Task name/), { target: { value: 'Change fuel filters' } });
        fireEvent.click(within(add).getByRole('button', { name: 'Create task' }));

        await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
        expect(create.mock.calls[0][0]).toMatchObject({
            trigger_type: 'engine_hours',
            interval_value: 250,
            next_due_hours: 1500,
            next_due_date: null,
        });
        expect(await screen.findByText('Due at 1500 hrs')).toBeInTheDocument();
    });

    it('in Edit, when the field is cleared', async () => {
        await openKestrel(
            [
                task('t-oil', 'Engine oil and filter', {
                    trigger_type: 'engine_hours',
                    interval_value: 200,
                    next_due_date: null,
                    next_due_hours: 1300,
                }),
            ],
            1250,
        );
        const update = vi.spyOn(LocalMaintenanceService, 'updateTask');
        const edit = await openEditSheet('Engine oil and filter');
        expect(within(edit).getByLabelText('Next due (hours)')).toHaveValue('1300');
        fireEvent.change(within(edit).getByLabelText('Next due (hours)'), { target: { value: '' } });
        fireEvent.click(within(edit).getByRole('button', { name: 'Save changes' }));

        await waitFor(() => expect(update).toHaveBeenCalledTimes(1));
        expect(update.mock.calls[0][1]).toMatchObject({ interval_value: 200, next_due_hours: 1450 });
    });
});

describe('Add opens empty after an edit (MAINT-10)', () => {
    it('after an edit closed without saving, too', async () => {
        await openKestrel([task('t-impeller', 'Raw-water impeller', { trigger_type: 'annual', interval_value: 365 })]);
        const edit = await openEditSheet('Raw-water impeller');
        expect(within(edit).getByLabelText(/Task name/)).toHaveValue('Raw-water impeller');
        fireEvent.click(within(edit).getByRole('button', { name: 'Close' }));
        await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit task' })).toBeNull());
        fireEvent.click(screen.getByRole('button', { name: 'Close service sheet' }));

        const add = await openAddSheet();
        expect(within(add).getByLabelText(/Task name/)).toHaveValue('');
        expect(within(add).getByLabelText('First due')).toHaveValue(toLocalDateString());
        expect(within(add).getByRole('button', { name: 'Monthly' })).toHaveAttribute('aria-pressed', 'true');
    });
});
