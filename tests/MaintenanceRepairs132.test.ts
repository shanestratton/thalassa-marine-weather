/**
 * Maintenance schedules that mean something (132-B15; binder audit MAINT-04,
 * MAINT-05, MAINT-06, MAINT-17, CHK-12): the rules under R&M.
 *
 *  - A repair is raised one way, from R&M, the log and Checklists alike
 *    (createRepair): 'Needs fixing' from the local day it was raised, with no
 *    schedule. It was daily and rolled on to tomorrow by every log, monthly
 *    from Checklists, and unscheduled from the log.
 *  - 'Mark fixed' (markFixed) puts the fix in the service history and takes
 *    the repair off the list; Undo puts it back.
 *  - A pre-trip check waits for a trip: never amber or red by date.
 *  - A blank field in the task form saves sensibly (scheduleFromForm).
 *
 * The real LocalDatabase over the in-memory filesystem and the real services,
 * as LocalMaintenancePauseUndo.test.ts: every outbox assertion is what the sync
 * engine would push. Fictional boat 'Kestrel' out of Horta, skipper
 * 'skipper-kestrel', crew 'crew-ana'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MaintenanceTask } from '../types';

vi.mock('@capacitor/filesystem', async () => {
    const { memoryFilesystemModule, memoryFs: fs } = await import('./helpers/memoryFilesystem');
    const module = memoryFilesystemModule();
    const readdir: typeof fs.readdir = async (options) => {
        if (options.path) return fs.readdir(options);
        const root = `${options.directory ?? 'DATA'}/`;
        const files = [...fs.files.entries()]
            .filter(([key]) => key.startsWith(root) && !key.slice(root.length).includes('/'))
            .map(([key, file]) => ({
                name: key.slice(root.length),
                type: 'file' as const,
                size: file.data.length,
                ctime: file.mtime,
                mtime: file.mtime,
                uri: `mem://${key}`,
            }));
        return { files };
    };
    return { ...module, Filesystem: { ...fs, readdir } };
});

import { memoryFs } from './helpers/memoryFilesystem';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { getById, getFullQueue, initLocalDatabase, mergePulledRecords } from '../services/vessel/LocalDatabase';
import { reloadSharedBindersFromStorage, SharedBinderReadOnlyError } from '../services/vessel/sharedBinders';
import { LocalMaintenanceService } from '../services/vessel/LocalMaintenanceService';
import { calculateStatus, isFixedRepair, statusWithReading } from '../services/MaintenanceService';
import { clipboardDueText } from '../services/MaintenancePdfService';
import { scheduleFromForm } from '../components/vessel/maintenance/taskSchedule';

let accounts = 0;
let SKIPPER = '';
let CREW = '';
const NOW = '2026-10-10T00:00:00.000Z';
const was = process.env.TZ;

function task(id: string, owner: string, title: string, patch: Partial<MaintenanceTask> = {}): MaintenanceTask {
    return {
        id,
        user_id: owner,
        title,
        description: null,
        category: 'Repair',
        trigger_type: 'monthly',
        interval_value: null,
        next_due_date: '2026-10-05',
        next_due_hours: null,
        last_completed: null,
        is_active: true,
        created_at: NOW,
        updated_at: NOW,
        ...patch,
    };
}

function snapshot(userId: string, maintenance: { read: boolean; write: boolean } | null): void {
    const none = { read: false, write: false };
    localStorage.setItem(
        `thalassa_shared_binders_v1::user%3A${encodeURIComponent(userId)}`,
        JSON.stringify({
            version: 1,
            userId,
            confirmedAt: NOW,
            skippers: maintenance
                ? [
                      {
                          ownerId: SKIPPER,
                          vesselName: 'Kestrel',
                          lastAcceptedAt: NOW,
                          registers: { stores: none, equipment: none, maintenance, documents: none },
                      },
                  ]
                : [],
        }),
    );
    reloadSharedBindersFromStorage();
}

/** Kestrel's R&M: an open bilge pump repair, and a raw-water impeller (not a repair). */
async function kestrelBinder(): Promise<void> {
    await mergePulledRecords('maintenance_tasks', [
        task('t-bilge', SKIPPER, 'Bilge pump float switch sticks'),
        task('t-impeller', SKIPPER, 'Raw-water impeller', { category: 'Engine', interval_value: 30 }),
    ]);
}

async function signInSkipper(): Promise<void> {
    setAuthIdentityScope(SKIPPER);
    snapshot(SKIPPER, null);
    await initLocalDatabase(SKIPPER);
    await kestrelBinder();
}

async function signInCrew(write: boolean): Promise<void> {
    setAuthIdentityScope(CREW);
    snapshot(CREW, { read: true, write });
    await initLocalDatabase(CREW);
    await kestrelBinder();
}

const queued = () =>
    getFullQueue()
        .filter((item) => item.table_name.startsWith('maintenance_'))
        .map((item) => ({
            table: item.table_name,
            type: item.mutation_type,
            id: item.record_id,
            payload: JSON.parse(item.payload) as Record<string, unknown>,
        }));
const stored = (id: string) => getById<MaintenanceTask>('maintenance_tasks', id)!;

beforeEach(() => {
    accounts += 1;
    SKIPPER = `skipper-kestrel-${accounts}`;
    CREW = `crew-ana-${accounts}`;
    memoryFs.reset();
    localStorage.clear();
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
});

afterEach(async () => {
    vi.useRealTimers();
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
    setAuthIdentityScope(null);
    await initLocalDatabase(null);
    localStorage.clear();
});

describe('createRepair: one repair, wherever it is raised', () => {
    it("needs fixing from the skipper's own day, with no schedule to roll on", async () => {
        process.env.TZ = 'America/Los_Angeles';
        vi.useFakeTimers({ toFake: ['Date'] });
        // 18:00 on Fri 9 Oct in Los Angeles is already Sat 10 Oct in UTC.
        vi.setSystemTime(new Date(2026, 9, 9, 18, 0));
        await signInSkipper();

        const repair = await LocalMaintenanceService.createRepair('  Stern gland weeping  ');
        expect(stored(repair.id)).toMatchObject({
            user_id: SKIPPER,
            title: 'Stern gland weeping',
            description: null,
            category: 'Repair',
            trigger_type: 'monthly',
            interval_value: null,
            next_due_date: '2026-10-09',
            next_due_hours: null,
            last_completed: null,
            is_active: true,
        });
        expect(queued().map(({ type, table }) => `${type} ${table}`)).toEqual(['INSERT maintenance_tasks']);
        expect(calculateStatus(stored(repair.id), 0)).toMatchObject({
            status: 'yellow',
            statusLabel: 'Needs fixing',
            toFix: true,
        });
    });

    it('names a long note at a word, under 80 characters, and keeps the whole of it and the notes', async () => {
        await signInSkipper();
        const words =
            'Port side lazy jack line chafed through where it rubs the spreader end, replace it with new line before the next blow';
        const repair = await LocalMaintenanceService.createRepair(words, 'Failed on the Pre-departure checklist.');
        expect(repair.title.length).toBeLessThanOrEqual(80);
        expect(repair.title).toBe('Port side lazy jack line chafed through where it rubs the spreader end, replace…');
        expect(repair.description).toBe(`${words}\n\nFailed on the Pre-departure checklist.`);

        const short = await LocalMaintenanceService.createRepair(
            'Bilge pump test',
            'Failed on the Pre-departure checklist.',
        );
        expect(short).toMatchObject({
            title: 'Bilge pump test',
            description: 'Failed on the Pre-departure checklist.',
        });

        await expect(LocalMaintenanceService.createRepair('   ')).rejects.toThrow('A repair needs a name');
    });

    it('a view-only share refuses it before anything is queued', async () => {
        await signInCrew(false);
        await expect(LocalMaintenanceService.createRepair('Jammed winch')).rejects.toThrow(SharedBinderReadOnlyError);
        expect(queued()).toEqual([]);
    });
});

describe('markFixed: the fix goes in the history, the repair leaves the list', () => {
    it('records the fix, takes it off the list, and Undo puts both back', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-12T03:00:00.000Z'));
        await signInSkipper();

        const fixed = await LocalMaintenanceService.markFixed('t-bilge', 'New float switch');
        expect(stored('t-bilge')).toMatchObject({ is_active: false, last_completed: '2026-10-12T03:00:00.000Z' });
        expect(isFixedRepair(stored('t-bilge'))).toBe(true);
        expect(calculateStatus(stored('t-bilge'), 0)).toMatchObject({ status: 'grey', statusLabel: 'Fixed' });
        expect(LocalMaintenanceService.getTasks().map((t) => t.id)).toEqual(['t-impeller']);
        expect(LocalMaintenanceService.getHistory('t-bilge')).toMatchObject([
            { id: fixed.historyId, notes: 'New float switch', engine_hours_at_service: null, cost: null },
        ]);
        expect(fixed.previous).toEqual({
            next_due_date: '2026-10-05',
            next_due_hours: null,
            last_completed: null,
            is_active: true,
        });
        expect(queued().map(({ type, table }) => `${type} ${table}`)).toEqual([
            'INSERT maintenance_history',
            'UPDATE maintenance_tasks',
        ]);
        expect(queued()[1].payload).toMatchObject({ is_active: false, last_completed: '2026-10-12T03:00:00.000Z' });

        await expect(LocalMaintenanceService.undoLogService(fixed)).resolves.toEqual({ restored: true });
        expect(stored('t-bilge')).toMatchObject({ is_active: true, last_completed: null, next_due_date: '2026-10-05' });
        expect(LocalMaintenanceService.getHistory('t-bilge')).toEqual([]);
        expect(calculateStatus(stored('t-bilge'), 0).statusLabel).toBe('Needs fixing');
    });

    it('crew on a writable share may mark a repair fixed; view-only crew may not', async () => {
        await signInCrew(true);
        await LocalMaintenanceService.markFixed('t-bilge', null);
        expect(stored('t-bilge')).toMatchObject({ user_id: SKIPPER, is_active: false });
        // The record is the skipper's, so his binder keeps it.
        expect(LocalMaintenanceService.getHistory('t-bilge')[0].user_id).toBe(SKIPPER);

        await signInCrew(false);
        await expect(LocalMaintenanceService.markFixed('t-bilge', null)).rejects.toThrow(SharedBinderReadOnlyError);
    });

    it('is for repairs only: a service is logged, not fixed', async () => {
        await signInSkipper();
        await expect(LocalMaintenanceService.markFixed('t-impeller', null)).rejects.toThrow(
            'Only a repair is marked fixed',
        );
        expect(queued()).toEqual([]);
    });
});

describe('the status rules', () => {
    /** 09:00 on Mon 12 Oct, made in the zone the case runs in. */
    let today: Date;
    beforeEach(() => {
        today = new Date(2026, 9, 12, 9, 0);
    });

    it("an old R&M repair (daily, rolled on, overdue) needs fixing: it is never 'Overdue by'", () => {
        const old = task('t-old', 'skipper-1', 'Leaking hatch seal', {
            trigger_type: 'daily',
            interval_value: 1,
            next_due_date: '2026-10-01',
            last_completed: '2026-09-30T07:00:00.000Z',
        });
        expect(calculateStatus(old, 0, today)).toMatchObject({ status: 'yellow', statusLabel: 'Needs fixing' });
        // A repair paused before 132, never logged, is still just paused.
        const paused = { ...old, is_active: false, last_completed: null };
        expect(isFixedRepair(paused)).toBe(false);
        expect(calculateStatus(paused, 0, today).statusLabel).toBe('Paused');
    });

    it('statusWithReading is R&M, the badge and the PDF in one: pre-trip and repairs are never red', () => {
        const preTrip = task('t-oil', 'skipper-1', 'Check engine oil', {
            category: 'Engine',
            trigger_type: 'daily',
            interval_value: 1,
            next_due_date: '2026-10-01',
        });
        const repair = task('t-hatch', 'skipper-1', 'Leaking hatch seal');
        for (const reading of [null, 1250]) {
            expect(statusWithReading(preTrip, reading, today)).toMatchObject({
                status: 'green',
                statusLabel: 'Due before your next trip',
            });
            expect(statusWithReading(repair, reading, today).status).toBe('yellow');
        }
        // Their checklist PDF row says when, as the card does.
        expect(clipboardDueText(statusWithReading(preTrip, null, today))).toBe('Before trip');
        expect(clipboardDueText(statusWithReading(repair, null, today))).toBe('To fix');

        // An hour task with no reading still asks for one; a calendar task still goes red.
        const hours = task('t-oil-change', 'skipper-1', 'Engine oil change', {
            category: 'Engine',
            trigger_type: 'engine_hours',
            interval_value: 200,
            next_due_date: null,
        });
        expect(statusWithReading(hours, null, today).statusLabel).toBe('Enter engine hours');
        const late = task('t-winch', 'skipper-1', 'Service the winches', {
            category: 'Rigging',
            interval_value: 30,
            next_due_date: '2026-10-01',
        });
        expect(statusWithReading(late, null, today)).toMatchObject({
            status: 'red',
            statusLabel: 'Overdue by 11 days',
        });
    });
});

describe('scheduleFromForm: blank fields save sensibly (MAINT-17)', () => {
    const hours = { trigger: 'engine_hours' as const, dueDate: '' };

    it("a blank 'Next due' hours is the reading plus the interval", () => {
        expect(scheduleFromForm({ ...hours, interval: '250', dueHours: '' }, 1250)).toEqual({
            trigger_type: 'engine_hours',
            interval_value: 250,
            next_due_date: null,
            next_due_hours: 1500,
        });
        // Typed, it is kept as typed, commas and all.
        expect(scheduleFromForm({ ...hours, interval: '250', dueHours: '1,600' }, 1250).next_due_hours).toBe(1600);
        // A blank or unreadable interval is the 200 the field shows.
        expect(scheduleFromForm({ ...hours, interval: '', dueHours: '' }, 1250)).toMatchObject({
            interval_value: 200,
            next_due_hours: 1450,
        });
        expect(scheduleFromForm({ ...hours, interval: 'abc', dueHours: 'soon' }, 1250)).toMatchObject({
            interval_value: 200,
            next_due_hours: 1450,
        });
    });

    it('with no reading yet, a blank hours due waits for the first one: never counted from zero', () => {
        expect(scheduleFromForm({ ...hours, interval: '100', dueHours: '' }, null)).toMatchObject({
            interval_value: 100,
            next_due_hours: null,
        });
        expect(scheduleFromForm({ ...hours, interval: '100', dueHours: '0' }, null).next_due_hours).toBe(0);
    });

    it("a calendar task's blank day is a whole period from the skipper's own today", () => {
        process.env.TZ = 'America/Los_Angeles';
        // 18:00 on Fri 9 Oct in Los Angeles: Saturday in UTC.
        const evening = new Date(2026, 9, 9, 18, 0);
        const form = { interval: '200', dueHours: '' };
        expect(scheduleFromForm({ ...form, trigger: 'monthly', dueDate: '' }, null, evening)).toEqual({
            trigger_type: 'monthly',
            interval_value: 30,
            next_due_date: '2026-11-08',
            next_due_hours: null,
        });
        expect(scheduleFromForm({ ...form, trigger: 'annual', dueDate: '2027-03-01' }, 1250, evening)).toMatchObject({
            interval_value: 365,
            next_due_date: '2027-03-01',
            next_due_hours: null,
        });
    });

    it('a pre-trip check saves no day: it waits for a trip', () => {
        expect(
            scheduleFromForm({ trigger: 'daily', interval: '200', dueDate: '2026-10-12', dueHours: '' }, 1250),
        ).toEqual({ trigger_type: 'daily', interval_value: 1, next_due_date: null, next_due_hours: null });
    });
});
