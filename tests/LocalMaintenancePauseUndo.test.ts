/**
 * Pause, Resume and taking back a service log, in the R&M service (126-B7a;
 * binder audit MAINT-12 and MAINT-09; Shane 2026-10-09: "check all of the
 * binders to make sure that they are at the same standard as the rest of the
 * app").
 *
 * Before: deactivateTask existed and nothing could undo it; a service logged
 * by mistake (a daily check logged nine times on 2026-10-02) stayed in the
 * ledger for good, and its task's next-due stayed moved.
 *
 * The real LocalDatabase over the in-memory filesystem and the real services:
 * every assertion on the outbox is what the sync engine would push. Deletes
 * are owner-only in RLS ("Maintenance history owners delete"), so a crew
 * DELETE would fail forever in the outbox: crew are refused before anything
 * is queued.
 *
 * Fictional boats and sailors only: skipper 'skipper-kestrel' of 'Kestrel'
 * (out of Horta), crew 'crew-ana'; tasks 'Raw-water impeller', 'Antifouling'
 * and 'Rig inspection'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MaintenanceHistory, MaintenanceTask } from '../types';

// The in-memory filesystem, plus a listing of a folder's root (path ''), which
// the database reads to find its files and the shared helper does not answer.
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
import {
    applyRealtimeChange,
    getById,
    getFullQueue,
    initLocalDatabase,
    mergePulledRecords,
    removeSynced,
} from '../services/vessel/LocalDatabase';
import { reloadSharedBindersFromStorage, SharedBinderReadOnlyError } from '../services/vessel/sharedBinders';
import { LocalMaintenanceService } from '../services/vessel/LocalMaintenanceService';

// A fresh pair of accounts per test, so no outbox carries over.
let accounts = 0;
let SKIPPER = '';
let CREW = '';
const NOW = '2026-10-10T00:00:00.000Z';

function task(id: string, owner: string, title: string, patch: Partial<MaintenanceTask> = {}): MaintenanceTask {
    return {
        id,
        user_id: owner,
        title,
        description: null,
        category: 'Engine',
        trigger_type: 'monthly',
        interval_value: 30,
        next_due_date: '2026-10-05',
        next_due_hours: null,
        last_completed: '2026-09-05T07:00:00.000Z',
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
        notes: 'Changed at the fuel dock, Horta',
        cost: null,
        created_at: completedAt,
    };
}

/** The boat's R&M as the server holds it: three records for the impeller. */
async function skipperBinder(owner: string): Promise<void> {
    await mergePulledRecords('maintenance_tasks', [
        task('t-impeller', owner, 'Raw-water impeller', {
            trigger_type: 'engine_hours',
            interval_value: 100,
            next_due_date: null,
            next_due_hours: 1450,
            last_completed: '2026-08-01T09:30:00.000Z',
        }),
        task('t-antifoul', owner, 'Antifouling', { category: 'Hull', trigger_type: 'annual', interval_value: 365 }),
        task('t-rig', owner, 'Rig inspection', { category: 'Rigging' }),
    ]);
    await mergePulledRecords('maintenance_history', [
        record('h-1', owner, 't-impeller', '2026-03-03T08:00:00.000Z'),
        record('h-2', owner, 't-impeller', '2026-06-03T08:00:00.000Z'),
        record('h-3', owner, 't-impeller', '2026-08-01T09:30:00.000Z'),
    ]);
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

async function signInSkipper(): Promise<void> {
    setAuthIdentityScope(SKIPPER);
    snapshot(SKIPPER, null);
    await initLocalDatabase(SKIPPER);
    await skipperBinder(SKIPPER);
}

/** Crew on Kestrel's shared R&M (write granted): the skipper's rows are on this phone. */
async function signInCrew(write = true): Promise<void> {
    setAuthIdentityScope(CREW);
    snapshot(CREW, { read: true, write });
    await initLocalDatabase(CREW);
    await skipperBinder(SKIPPER);
}

/** The outbox for R&M, oldest first: what the sync engine would push. */
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
    // The database files already live in Library (LocalDatabaseOutbox.test.ts).
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
});

afterEach(async () => {
    vi.useRealTimers();
    setAuthIdentityScope(null);
    await initLocalDatabase(null);
    localStorage.clear();
});

describe('Pause and Resume', () => {
    it('round-trips is_active: a paused task leaves getTasks, stays in getAllTasks, and comes back', async () => {
        await signInSkipper();
        await LocalMaintenanceService.deactivateTask('t-rig');
        expect(stored('t-rig').is_active).toBe(false);
        expect(LocalMaintenanceService.getTasks().map((t) => t.id)).not.toContain('t-rig');
        expect(LocalMaintenanceService.getAllTasks().map((t) => t.id)).toContain('t-rig');

        await LocalMaintenanceService.resumeTask('t-rig');
        expect(stored('t-rig').is_active).toBe(true);
        expect(LocalMaintenanceService.getTasks().map((t) => t.id)).toContain('t-rig');
        expect(queued().map(({ type, id, payload }) => ({ type, id, is_active: payload.is_active }))).toEqual([
            { type: 'UPDATE', id: 't-rig', is_active: false },
            { type: 'UPDATE', id: 't-rig', is_active: true },
        ]);
    });

    it("crew on a writable share may pause and resume the skipper's task", async () => {
        await signInCrew(true);
        await LocalMaintenanceService.deactivateTask('t-antifoul');
        await LocalMaintenanceService.resumeTask('t-antifoul');
        expect(stored('t-antifoul')).toMatchObject({ user_id: SKIPPER, is_active: true });
        expect(queued().map(({ type, id }) => `${type} ${id}`)).toEqual(['UPDATE t-antifoul', 'UPDATE t-antifoul']);
    });

    it('a view-only share refuses both, and queues nothing', async () => {
        await signInCrew(false);
        await expect(LocalMaintenanceService.deactivateTask('t-antifoul')).rejects.toThrow(SharedBinderReadOnlyError);
        await expect(LocalMaintenanceService.resumeTask('t-antifoul')).rejects.toThrow(SharedBinderReadOnlyError);
        expect(queued()).toEqual([]);
    });
});

describe('Undo a logged service', () => {
    it('logService says what it moved; undo removes the record and puts all three fields back exactly', async () => {
        await signInSkipper();
        const before = stored('t-impeller');
        const logged = await LocalMaintenanceService.logService('t-impeller', 1460, 'Logged by mistake', null);
        expect(logged.previous).toEqual({
            next_due_date: null,
            next_due_hours: 1450,
            last_completed: '2026-08-01T09:30:00.000Z',
        });
        expect(stored('t-impeller').next_due_hours).toBe(1560);
        expect(LocalMaintenanceService.getHistory('t-impeller')).toHaveLength(4);

        await expect(LocalMaintenanceService.undoLogService(logged)).resolves.toEqual({ restored: true });

        expect(getById('maintenance_history', logged.historyId)).toBeNull();
        expect(LocalMaintenanceService.getHistory('t-impeller').map((h) => h.id)).toEqual(['h-3', 'h-2', 'h-1']);
        const after = stored('t-impeller');
        expect({
            next_due_date: after.next_due_date,
            next_due_hours: after.next_due_hours,
            last_completed: after.last_completed,
        }).toEqual({
            next_due_date: before.next_due_date,
            next_due_hours: before.next_due_hours,
            last_completed: before.last_completed,
        });
        // The log, then its undo: exactly what reaches the server, in order.
        expect(queued().map(({ table, type, id }) => `${type} ${table} ${id}`)).toEqual([
            `INSERT maintenance_history ${logged.historyId}`,
            'UPDATE maintenance_tasks t-impeller',
            `DELETE maintenance_history ${logged.historyId}`,
            'UPDATE maintenance_tasks t-impeller',
        ]);
        expect(queued()[3].payload).toMatchObject({
            next_due_date: null,
            next_due_hours: 1450,
            last_completed: '2026-08-01T09:30:00.000Z',
        });
    });

    it('a date task gets its date-only due back, not a timestamp', async () => {
        await signInSkipper();
        const logged = await LocalMaintenanceService.logService('t-rig', null, null, null);
        expect(stored('t-rig').next_due_date).not.toBe('2026-10-05');
        await LocalMaintenanceService.undoLogService(logged);
        expect(stored('t-rig')).toMatchObject({
            next_due_date: '2026-10-05',
            next_due_hours: null,
            last_completed: '2026-09-05T07:00:00.000Z',
        });
    });

    it('a service logged since keeps its newer due: the undo deletes only its own record', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-10T07:00:00.000Z'));
        await signInSkipper();
        const mistaken = await LocalMaintenanceService.logService('t-rig', null, 'Tapped twice', null);
        vi.setSystemTime(new Date('2026-10-10T07:05:00.000Z'));
        const real = await LocalMaintenanceService.logService('t-rig', null, 'Checked aloft', null);
        const newer = stored('t-rig');

        await expect(LocalMaintenanceService.undoLogService(mistaken)).resolves.toEqual({ restored: false });

        expect(getById('maintenance_history', mistaken.historyId)).toBeNull();
        expect(getById('maintenance_history', real.historyId)).not.toBeNull();
        expect(stored('t-rig')).toMatchObject({
            next_due_date: newer.next_due_date,
            next_due_hours: newer.next_due_hours,
            last_completed: newer.last_completed,
        });
        expect(queued().slice(-1)[0]).toMatchObject({ type: 'DELETE', id: mistaken.historyId });
    });

    // The push cycle's own pull and the realtime echo both put the server's
    // copy of the task back once its outbox entry is gone, with timestamptz
    // text ("...+00:00", trailing zeros trimmed), not this device's "...Z".
    // The same instants: undo must still see the task as untouched.
    const asServerStamp = (iso: string | null) =>
        iso &&
        iso
            .replace(/(\.\d*?)0+Z$/, '$1Z')
            .replace(/\.Z$/, 'Z')
            .replace(/Z$/, '+00:00');
    it.each([
        ['the push cycle pulls the task back', 'pull'],
        ['the realtime echo of the push arrives', 'realtime'],
    ])('undo still puts the task back once %s in the server form', async (_label, path) => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date('2026-10-10T00:17:38.110Z'));
        await signInSkipper();
        const before = stored('t-rig');
        const logged = await LocalMaintenanceService.logService('t-rig', null, 'Logged by mistake', null);
        await removeSynced(getFullQueue().map((item) => item.id));
        const local = stored('t-rig');
        const server = {
            ...local,
            next_due_date: asServerStamp(local.next_due_date),
            last_completed: asServerStamp(local.last_completed),
            updated_at: asServerStamp(local.updated_at)!,
        };
        expect(server.last_completed).toBe('2026-10-10T00:17:38.11+00:00');
        if (path === 'pull') await mergePulledRecords('maintenance_tasks', [server]);
        else await applyRealtimeChange('maintenance_tasks', 'UPDATE', server);
        expect(stored('t-rig').last_completed).toBe(server.last_completed);

        await expect(LocalMaintenanceService.undoLogService(logged)).resolves.toEqual({ restored: true });

        expect(getById('maintenance_history', logged.historyId)).toBeNull();
        expect(stored('t-rig')).toMatchObject({
            next_due_date: before.next_due_date,
            next_due_hours: before.next_due_hours,
            last_completed: before.last_completed,
        });
        expect(queued().map(({ table, type, id }) => `${type} ${table} ${id}`)).toEqual([
            `DELETE maintenance_history ${logged.historyId}`,
            'UPDATE maintenance_tasks t-rig',
        ]);
    });

    it("crew can't take back a log on the skipper's binder: refused, nothing queued", async () => {
        await signInCrew(true);
        const logged = await LocalMaintenanceService.logService('t-rig', null, null, null);
        const afterLog = queued();
        const task = stored('t-rig');

        await expect(LocalMaintenanceService.undoLogService(logged)).rejects.toThrow(SharedBinderReadOnlyError);

        expect(queued()).toEqual(afterLog);
        expect(getById('maintenance_history', logged.historyId)).not.toBeNull();
        expect(stored('t-rig')).toEqual(task);
    });
});

describe('Remove a mistaken record', () => {
    it('the skipper removes one record: one DELETE, the task untouched', async () => {
        await signInSkipper();
        const task = stored('t-impeller');
        await LocalMaintenanceService.deleteHistory('h-2');
        expect(LocalMaintenanceService.getHistory('t-impeller').map((h) => h.id)).toEqual(['h-3', 'h-1']);
        expect(queued().map(({ table, type, id }) => `${type} ${table} ${id}`)).toEqual([
            'DELETE maintenance_history h-2',
        ]);
        expect(stored('t-impeller')).toEqual(task);
    });

    it('crew are refused before anything is queued', async () => {
        await signInCrew(true);
        await expect(LocalMaintenanceService.deleteHistory('h-2')).rejects.toThrow(SharedBinderReadOnlyError);
        expect(queued()).toEqual([]);
        expect(LocalMaintenanceService.getHistory('t-impeller')).toHaveLength(3);
    });
});
