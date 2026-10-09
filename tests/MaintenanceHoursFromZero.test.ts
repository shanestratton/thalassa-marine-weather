/**
 * Hour-based maintenance is scheduled from the engine's real reading, never
 * from an invented zero (binder audit 2026-10-09, MAINT-03).
 *
 * The suggested 'Service Engine' task was seeded due at an absolute 100 hours,
 * and logging a service with no reading entered set 0 + interval. The moment a
 * skipper typed a real figure (3,512 on an older engine) the task turned red,
 * "Overdue by 3412 hrs", and lit the Boat Binder's overdue badge. Now:
 *   - a seed or a log with no reading leaves the hours due unset;
 *   - the first reading schedules what was waiting for it, or counted from zero;
 *   - an older row still on its from-zero due, more than five intervals past
 *     it, asks for the last service (amber), not "Overdue by 3412 hrs"; nearer
 *     than that it is judged as it stands, so a neglected new engine stays red.
 *
 * The real LocalDatabase over the in-memory filesystem, the real services and
 * the real engine-hours reading (this device's figure: the shared table is not
 * live in a test). Fictional boats 'Kestrel' and 'Albatross'; readings 3,512 and 20.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MaintenanceTask } from '../types';

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
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { getById, initLocalDatabase, insertLocal, query } from '../services/vessel/LocalDatabase';
import { reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';
import { LocalEngineHoursService } from '../services/vessel/LocalEngineHoursService';
import { LocalMaintenanceService } from '../services/vessel/LocalMaintenanceService';
import { MaintenanceService, calculateStatus } from '../services/MaintenanceService';
import { supabase } from '../services/supabase';

const ENGINE_SERVICE = 'Service Engine (Oil / Filters / Zincs)';
let boat = 0;
let me = '';

/** A signed-in skipper whose crew shares the server has confirmed: seeding may run. */
async function signIn(name: string) {
    boat += 1;
    me = `${name}-${boat}`;
    setAuthIdentityScope(me);
    localStorage.setItem(
        `thalassa_shared_binders_v1::user%3A${encodeURIComponent(me)}`,
        JSON.stringify({ version: 1, userId: me, confirmedAt: '2026-10-09T00:00:00.000Z', skippers: [] }),
    );
    reloadSharedBindersFromStorage();
    await initLocalDatabase(me);
}

function hourTask(id: string, patch: Partial<MaintenanceTask> = {}): MaintenanceTask {
    return {
        id,
        user_id: me,
        title: `Hours task ${id}`,
        description: null,
        category: 'Engine',
        trigger_type: 'engine_hours',
        interval_value: 100,
        next_due_date: null,
        next_due_hours: null,
        last_completed: null,
        is_active: true,
        created_at: '2026-10-01T00:00:00.000Z',
        updated_at: '2026-10-01T00:00:00.000Z',
        ...patch,
    };
}

const task = (id: string) => getById<MaintenanceTask>('maintenance_tasks', id)!;
const seededEngineService = () =>
    query<MaintenanceTask>('maintenance_tasks', (row) => row.title === ENGINE_SERVICE && row.user_id === me)[0];

beforeEach(() => {
    memoryFs.reset();
    localStorage.clear();
    // The database files already live in Library (LocalDatabaseOutbox.test.ts).
    localStorage.setItem('thalassa_localdb_moved_to_library', '1');
});

afterEach(() => {
    setAuthIdentityScope(null);
    localStorage.clear();
});

describe('seeding the suggested tasks', () => {
    it('with no reading yet, the engine service waits for one: no hours due', async () => {
        await signIn('kestrel');
        expect(await LocalMaintenanceService.seedDefaults()).toBeGreaterThan(20);
        const engine = seededEngineService();
        expect(engine.trigger_type).toBe('engine_hours');
        expect(engine.next_due_hours).toBeNull();
    });

    it('with a reading of 3,512, it is due at 3,612', async () => {
        await signIn('albatross');
        await LocalEngineHoursService.setReading(3512);
        await LocalMaintenanceService.seedDefaults();
        expect(seededEngineService().next_due_hours).toBe(3612);
    });

    it('the cloud twin seeds the same hours', async () => {
        await signIn('albatross');
        await LocalEngineHoursService.setReading(3512);
        const inserted: Record<string, unknown>[][] = [];
        // The signed-in skipper owns the vessel (read when asked: the test signs in twice).
        const chain: Record<string, unknown> = {};
        for (const method of ['select', 'eq', 'contains', 'order', 'limit']) chain[method] = () => chain;
        chain.maybeSingle = () => Promise.resolve({ data: { owner_id: me }, error: null });
        chain.insert = (rows: Record<string, unknown>[]) => {
            inserted.push(rows);
            return Promise.resolve({ error: null });
        };
        vi.mocked(supabase!.auth.getUser).mockImplementation(
            async () => ({ data: { user: { id: me } }, error: null }) as never,
        );
        vi.mocked(supabase!.from).mockImplementation(() => chain as never);

        // Given the R&M reading, as the local seed reads it.
        const reading = LocalEngineHoursService.getReading().hours;
        await expect(MaintenanceService.seedDefaults(reading)).resolves.toBeGreaterThan(20);
        const cloudEngine = inserted[0].find((row) => row.title === ENGINE_SERVICE)!;
        expect(cloudEngine.next_due_hours).toBe(3612);

        // And with no reading, unset, as the local seed.
        localStorage.clear();
        await signIn('kestrel');
        inserted.length = 0;
        await MaintenanceService.seedDefaults(LocalEngineHoursService.getReading().hours);
        expect(inserted[0].find((row) => row.title === ENGINE_SERVICE)!.next_due_hours).toBeNull();
        // Every other row is the same shape as before: no hours.
        expect(inserted[0].filter((row) => row.next_due_hours !== null)).toEqual([]);
    });
});

describe('logging a service', () => {
    it('with no engine hours entered, the next one waits for a reading, and the history says so', async () => {
        await signIn('kestrel');
        await insertLocal('maintenance_tasks', hourTask('t-oil', { next_due_hours: 100 }));
        const result = await LocalMaintenanceService.logService('t-oil', null, 'Oil and filters', null);
        expect(result.nextDueHours).toBeNull();
        expect(task('t-oil').next_due_hours).toBeNull();
        expect(task('t-oil').last_completed).toBeTruthy();
        const [entry] = LocalMaintenanceService.getHistory('t-oil');
        expect(entry.engine_hours_at_service).toBeNull();
        expect(entry.notes).toBe('Oil and filters');
    });

    it('at 3,512 hours it is next due at 3,612', async () => {
        await signIn('albatross');
        await insertLocal('maintenance_tasks', hourTask('t-oil', { next_due_hours: 3400 }));
        await LocalMaintenanceService.logService('t-oil', 3512, null, null);
        expect(task('t-oil').next_due_hours).toBe(3612);
    });

    it('a real reading of 0 is a reading: next due at the interval', async () => {
        await signIn('kestrel');
        await insertLocal('maintenance_tasks', hourTask('t-oil'));
        await LocalMaintenanceService.logService('t-oil', 0, null, null);
        expect(task('t-oil').next_due_hours).toBe(100);
    });
});

describe('the first engine-hours reading', () => {
    it('reschedules the seeded from-zero due (100) at 3,512 to 3,612', async () => {
        await signIn('albatross');
        await insertLocal('maintenance_tasks', hourTask('t-seeded', { next_due_hours: 100 }));
        expect(await LocalMaintenanceService.scheduleHourTasksFromFirstReading(3512)).toBe(1);
        expect(task('t-seeded').next_due_hours).toBe(3612);
    });

    it('a new engine at 20 hours keeps the seeded first service at 100', async () => {
        await signIn('kestrel');
        await insertLocal('maintenance_tasks', hourTask('t-seeded', { next_due_hours: 100 }));
        expect(await LocalMaintenanceService.scheduleHourTasksFromFirstReading(20)).toBe(0);
        expect(task('t-seeded').next_due_hours).toBe(100);
    });

    it('schedules a task waiting with no hours: 20 + 100 = 120', async () => {
        await signIn('kestrel');
        await insertLocal('maintenance_tasks', hourTask('t-waiting'));
        await LocalMaintenanceService.scheduleHourTasksFromFirstReading(20);
        expect(task('t-waiting').next_due_hours).toBe(120);
    });

    it('leaves a figure the skipper typed, a paused task and a date task alone', async () => {
        await signIn('albatross');
        await insertLocal('maintenance_tasks', hourTask('t-typed', { next_due_hours: 4000 }));
        await insertLocal('maintenance_tasks', hourTask('t-paused', { next_due_hours: 100, is_active: false }));
        await insertLocal(
            'maintenance_tasks',
            hourTask('t-monthly', { trigger_type: 'monthly', interval_value: 30, next_due_date: '2026-11-01' }),
        );
        expect(await LocalMaintenanceService.scheduleHourTasksFromFirstReading(3512)).toBe(0);
        expect(task('t-typed').next_due_hours).toBe(4000);
        expect(task('t-paused').next_due_hours).toBe(100);
        expect(task('t-monthly').next_due_hours).toBeNull();
    });

    it('a second reading never reschedules', async () => {
        await signIn('albatross');
        await insertLocal('maintenance_tasks', hourTask('t-seeded', { next_due_hours: 100 }));
        await LocalEngineHoursService.setReading(3512);
        await LocalMaintenanceService.scheduleHourTasksFromFirstReading(3512);
        expect(task('t-seeded').next_due_hours).toBe(3612);

        // Anchored now: a later figure (even one that reaches the scheduler) moves nothing.
        await LocalEngineHoursService.setReading(3700);
        expect(await LocalMaintenanceService.scheduleHourTasksFromFirstReading(3700)).toBe(0);
        expect(task('t-seeded').next_due_hours).toBe(3612);
        expect(LocalEngineHoursService.getReading(getAuthIdentityScope()).hours).toBe(3700);
    });

    it('only the binder on show: another account’s rows are not touched', async () => {
        await signIn('kestrel');
        await insertLocal('maintenance_tasks', hourTask('t-other', { user_id: 'someone-else', next_due_hours: 100 }));
        await LocalMaintenanceService.scheduleHourTasksFromFirstReading(3512);
        expect(task('t-other').next_due_hours).toBe(100);
    });
});

describe('calculateStatus: a row still on its from-zero seed', () => {
    const now = new Date(2026, 9, 9, 12, 0);
    const legacy = (patch: Partial<MaintenanceTask> = {}) =>
        hourTask('t-legacy', { title: ENGINE_SERVICE, next_due_hours: 100, ...patch });

    it('never serviced, due 100, interval 100, at 3,512: amber, "log your last one", no hours figure', () => {
        const status = calculateStatus(legacy(), 3512, now);
        expect(status.status).toBe('yellow');
        expect(status.statusLabel).toBe('No service logged yet — log your last one');
        expect(status.hoursUnanchored).toBe(true);
        expect(status.hoursRemaining).toBeNull();
    });

    it('the same at 150 hours is honestly overdue by 50', () => {
        const status = calculateStatus(legacy(), 150, now);
        expect(status.status).toBe('red');
        expect(status.statusLabel).toBe('Overdue by 50 hrs');
        expect(status.hoursUnanchored).toBe(false);
    });

    it('a new engine read at 0, never serviced, stays red at 201 and right through five intervals past', async () => {
        // Reading 0 is a real reading: the seed is due at 0 + 100 = 100, the
        // same figure as an old from-zero seed. Never logged, it is overdue,
        // and the warning must not go quiet as it gets worse.
        await signIn('kestrel');
        await LocalEngineHoursService.setReading(0);
        await LocalMaintenanceService.seedDefaults();
        const engine = seededEngineService();
        expect(engine.next_due_hours).toBe(100);

        const at201 = calculateStatus(engine, 201, now);
        expect(at201.status).toBe('red');
        expect(at201.statusLabel).toBe('Overdue by 101 hrs');
        expect(at201.hoursUnanchored).toBe(false);
        expect(calculateStatus(engine, 600, now).statusLabel).toBe('Overdue by 500 hrs');
        // Past five whole intervals with nothing logged, it asks for the last service instead: still amber, never grey.
        const at601 = calculateStatus(engine, 601, now);
        expect(at601.status).toBe('yellow');
        expect(at601.statusLabel).toBe('No service logged yet — log your last one');
    });

    it('a seeded 100 kept at a first reading of 20 is overdue by 160 at 260', async () => {
        await signIn('albatross');
        await insertLocal('maintenance_tasks', hourTask('t-seeded', { title: ENGINE_SERVICE, next_due_hours: 100 }));
        await LocalEngineHoursService.setReading(20);
        expect(await LocalMaintenanceService.scheduleHourTasksFromFirstReading(20)).toBe(0);
        const status = calculateStatus(task('t-seeded'), 260, now);
        expect(status.status).toBe('red');
        expect(status.statusLabel).toBe('Overdue by 160 hrs');
    });

    it('a figure typed to match its interval (impeller every 500, due 500) is overdue at 1,001', () => {
        const status = calculateStatus(hourTask('t-impeller', { interval_value: 500, next_due_hours: 500 }), 1001, now);
        expect(status.status).toBe('red');
        expect(status.statusLabel).toBe('Overdue by 501 hrs');
    });

    it('logged before any hours were entered (due 0 + 100), now at 3,512: amber, asks for hours', () => {
        // The old logService wrote next_due_hours = 0 + interval and set
        // last_completed; no first reading will ever reschedule it.
        const status = calculateStatus(legacy({ last_completed: '2026-03-01T00:00:00.000Z' }), 3512, now);
        expect(status.status).toBe('yellow');
        expect(status.statusLabel).toBe('Log your last service with engine hours');
        expect(status.hoursUnanchored).toBe(true);
        // Within five intervals it is judged as it stands.
        expect(calculateStatus(legacy({ last_completed: '2026-03-01T00:00:00.000Z' }), 550, now).status).toBe('red');
    });

    it('a paused one is still Paused', () => {
        expect(calculateStatus(legacy({ is_active: false }), 3512, now).statusLabel).toBe('Paused');
    });

    it('an hour task with no hours due, once a reading exists, says how it gets scheduled', () => {
        // Seeded with no reading and synced in after the first reading was typed elsewhere.
        const status = calculateStatus(hourTask('t-waiting'), 3512, now);
        expect(status.status).toBe('grey');
        expect(status.statusLabel).toBe('Log a service to schedule');
        // A date task with nothing set is still just unscheduled.
        const monthly = calculateStatus(
            hourTask('t-monthly', { trigger_type: 'monthly', interval_value: 30 }),
            3512,
            now,
        );
        expect(monthly.statusLabel).toBe('No schedule set');
    });
});

describe('the engine-room clipboard PDF', () => {
    const now = new Date(2026, 9, 9, 12, 0);

    it('prints no due figure for a task still on its from-zero due, and the real one otherwise', async () => {
        const { clipboardDueText } = await import('../services/MaintenancePdfService');
        const legacy = calculateStatus(hourTask('t-legacy', { next_due_hours: 100 }), 3512, now);
        expect(clipboardDueText(legacy)).toBe('—');
        const scheduled = calculateStatus(hourTask('t-oil', { next_due_hours: 3612 }), 3512, now);
        expect(clipboardDueText(scheduled)).toBe(`${(3612).toLocaleString()} hrs`);
        const waiting = calculateStatus(hourTask('t-waiting'), 3512, now);
        expect(clipboardDueText(waiting)).toBe('—');
    });
});
