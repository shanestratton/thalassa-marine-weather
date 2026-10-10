/**
 * LocalMaintenanceService — Offline-first CRUD for Maintenance Hub.
 *
 * All reads/writes go to local database. Mutations are queued
 * for background sync to Supabase. UI never touches the network.
 *
 * The "Log Service" action writes to BOTH local_maintenance_history
 * AND updates local_maintenance_tasks — then queues both mutations.
 */
import { getById, query, insertLocal, updateLocal, deleteLocal, generateUUID } from './LocalDatabase';
import {
    assertBinderDeletable,
    assertBinderWritable,
    binderInsertOwner,
    binderRowFilter,
    canSeedOwnBinder,
} from './sharedBinders';
import { getAuthIdentityScope } from '../authIdentityScope';
import { LocalEngineHoursService } from './LocalEngineHoursService';
import { DATA_EVENTS, dispatchDataChange } from '../../utils/dataChangeEvents';
import type { MaintenanceTask, MaintenanceHistory } from '../../types';

const TASKS_TABLE = 'maintenance_tasks';
const HISTORY_TABLE = 'maintenance_history';
// The skipper's R&M while the sailor is crew on a boat that shares it,
// otherwise the sailor's own (sharedBinders.ts). Tasks and history share it.
const REGISTER = 'maintenance' as const;

/** A real engine-hours figure (0 included); null means "not entered". */
function hasReading(hours: number | null | undefined): hours is number {
    return typeof hours === 'number' && Number.isFinite(hours) && hours >= 0;
}

/** The task to change, refusing (before anything is queued) an edit the share forbids. */
function writableTask(id: string): MaintenanceTask | null {
    const task = getById<MaintenanceTask>(TASKS_TABLE, id);
    assertBinderWritable(REGISTER, task);
    return task;
}

/**
 * What one logged service changed on its task, so its Undo can put it back
 * (126-B7a): the record it added, the three fields it wrote, and their values
 * before it.
 */
export interface LoggedService {
    historyId: string;
    taskId: string;
    nextDueDate: string | null;
    nextDueHours: number | null;
    /** last_completed as this log wrote it. */
    loggedAt: string;
    previous: Pick<MaintenanceTask, 'next_due_date' | 'next_due_hours' | 'last_completed'>;
}

/**
 * The same moment, or both unset. Once the log syncs, the server's copy
 * ("...+00:00", trailing zeros trimmed) replaces this device's "...Z" text.
 */
function sameInstant(a: string | null | undefined, b: string | null | undefined): boolean {
    return (a ?? null) === (b ?? null) || (!!a && !!b && Date.parse(a) === Date.parse(b));
}

/** Pause or resume, refusing (before anything is queued) a change the share forbids. */
async function setActive(id: string, isActive: boolean): Promise<void> {
    writableTask(id);
    await updateLocal<MaintenanceTask>(TASKS_TABLE, id, { is_active: isActive });
    dispatchDataChange(DATA_EVENTS.MAINTENANCE);
}

export class LocalMaintenanceService {
    // ── TASKS (READ) ──

    /** Get all active tasks (from local cache) */
    static getTasks(): MaintenanceTask[] {
        const inBinder = binderRowFilter(REGISTER);
        return query<MaintenanceTask>(TASKS_TABLE, (t) => inBinder(t) && t.is_active);
    }

    /** Get all tasks including paused */
    static getAllTasks(): MaintenanceTask[] {
        return query<MaintenanceTask>(TASKS_TABLE, binderRowFilter(REGISTER));
    }

    // ── TASKS (WRITE) ──

    /** Create a new maintenance task */
    static async createTask(
        task: Omit<MaintenanceTask, 'id' | 'user_id' | 'created_at' | 'updated_at'>,
    ): Promise<MaintenanceTask> {
        const owner = binderInsertOwner(REGISTER);
        const now = new Date().toISOString();
        const record: MaintenanceTask = {
            ...task,
            id: generateUUID(),
            user_id: owner,
            created_at: now,
            updated_at: now,
        };

        const inserted = await insertLocal<MaintenanceTask>(TASKS_TABLE, record);
        dispatchDataChange(DATA_EVENTS.MAINTENANCE);
        return inserted;
    }

    /** Update a task */
    static async updateTask(id: string, updates: Partial<MaintenanceTask>): Promise<MaintenanceTask | null> {
        writableTask(id);
        const updated = await updateLocal<MaintenanceTask>(TASKS_TABLE, id, updates);
        dispatchDataChange(DATA_EVENTS.MAINTENANCE);
        return updated;
    }

    /**
     * Pause a task: it leaves the list and every due count, and keeps its
     * service history. Crew on a writable share may pause and resume.
     */
    static deactivateTask(id: string): Promise<void> {
        return setActive(id, false);
    }

    /** Resume a paused task (126-B7a). */
    static resumeTask(id: string): Promise<void> {
        return setActive(id, true);
    }

    /** Hard-delete a task */
    static async deleteTask(id: string): Promise<void> {
        assertBinderDeletable(REGISTER, getById<MaintenanceTask>(TASKS_TABLE, id));
        await deleteLocal(TASKS_TABLE, id);
        dispatchDataChange(DATA_EVENTS.MAINTENANCE);
    }

    // ── LOG SERVICE (The Reset Loop — Offline) ──

    /**
     * Atomic local "Log Service": writes history + updates task next-due.
     * Both mutations are queued independently for sync.
     *
     * This replaces the server-side RPC `log_service` for local-first.
     * When synced, SyncService will push both mutations and the server
     * RPC is NOT called — the individual INSERT/UPDATE are sufficient.
     */
    static async logService(
        taskId: string,
        engineHours: number | null,
        notes: string | null,
        cost: number | null,
    ): Promise<LoggedService> {
        const task = writableTask(taskId);
        if (!task) throw new Error('Task not found');

        const now = new Date().toISOString();

        // ── Calculate new due thresholds ──
        let nextDueDate = task.next_due_date;
        let nextDueHours = task.next_due_hours;

        switch (task.trigger_type) {
            case 'engine_hours': {
                const interval = task.interval_value || 200;
                // From the real reading, never from an invented zero (126-B1,
                // audit MAINT-03): logged with no engine hours entered, the
                // next service waits for the first reading to schedule it.
                nextDueHours = hasReading(engineHours) ? engineHours + interval : null;
                break;
            }
            case 'daily':
            case 'quarterly':
            case 'monthly':
            case 'bi_annual':
            case 'annual':
            default: {
                const interval = task.interval_value || 30;
                const d = new Date();
                d.setDate(d.getDate() + interval);
                nextDueDate = d.toISOString();
                break;
            }
        }

        // ── 1. INSERT history record ──
        // History belongs to whoever owns the task: on a skipper's shared R&M
        // that is the skipper, so their binder keeps the record.
        const historyRecord: MaintenanceHistory = {
            id: generateUUID(),
            user_id: task.user_id || (getAuthIdentityScope().userId ?? ''),
            task_id: taskId,
            completed_at: now,
            engine_hours_at_service: engineHours,
            notes: notes,
            cost: cost,
            created_at: now,
        };

        await insertLocal<MaintenanceHistory>(HISTORY_TABLE, historyRecord);

        // ── 2. UPDATE task with new due thresholds ──
        await updateLocal<MaintenanceTask>(TASKS_TABLE, taskId, {
            next_due_date: nextDueDate,
            next_due_hours: nextDueHours,
            last_completed: now,
        } as Partial<MaintenanceTask>);

        // The "tick off" path. Without this dispatch, the Nav Station
        // overdue badge would keep showing the stale count until the
        // user backgrounds + foregrounds the app.
        dispatchDataChange(DATA_EVENTS.MAINTENANCE);

        return {
            historyId: historyRecord.id,
            taskId,
            nextDueDate,
            nextDueHours,
            loggedAt: now,
            previous: {
                next_due_date: task.next_due_date,
                next_due_hours: task.next_due_hours,
                last_completed: task.last_completed,
            },
        };
    }

    /**
     * Take back a logged service (126-B7a): its record goes, and the task's
     * next due and last serviced come back, but only while the task still
     * holds what that log wrote. A service logged since, here or on another
     * device, keeps its newer due and only this log's record goes. Deletes
     * are the binder owner's (RLS), so crew are refused before anything is
     * queued. `restored` says whether the task was put back.
     */
    static async undoLogService(logged: LoggedService): Promise<{ restored: boolean }> {
        const record = getById<MaintenanceHistory>(HISTORY_TABLE, logged.historyId);
        const task = getById<MaintenanceTask>(TASKS_TABLE, logged.taskId);
        assertBinderDeletable(REGISTER, record ?? task);
        const untouched =
            task &&
            sameInstant(task.next_due_date, logged.nextDueDate) &&
            (task.next_due_hours ?? null) === (logged.nextDueHours ?? null) &&
            sameInstant(task.last_completed, logged.loggedAt)
                ? task
                : null;
        if (untouched) writableTask(untouched.id);
        await deleteLocal(HISTORY_TABLE, logged.historyId);
        if (untouched) await updateLocal<MaintenanceTask>(TASKS_TABLE, untouched.id, logged.previous);
        dispatchDataChange(DATA_EVENTS.MAINTENANCE);
        return { restored: !!untouched };
    }

    /**
     * The first engine-hours reading schedules the hour tasks that waited for
     * one: every active hour task in the binder on show, that this sailor may
     * change, whose hours due are unset, or still the figure counted from zero
     * (exactly its interval, and below the reading). Each becomes reading +
     * interval. A figure the skipper typed, ahead of the reading or not the
     * seed's, is left alone, and so is a seeded 100 on a new engine at 20.
     * Called by R&M only when the reading goes from none to a number, so a
     * later reading never moves a due point; and an anchored task no longer
     * matches, so a stray second call moves nothing either. Returns how many.
     */
    static async scheduleHourTasksFromFirstReading(reading: number): Promise<number> {
        if (!hasReading(reading)) return 0;
        const inBinder = binderRowFilter(REGISTER);
        const waiting = query<MaintenanceTask>(
            TASKS_TABLE,
            (t) =>
                inBinder(t) &&
                t.is_active &&
                t.trigger_type === 'engine_hours' &&
                (t.next_due_hours === null ||
                    t.next_due_hours === undefined ||
                    (t.next_due_hours === t.interval_value && t.next_due_hours < reading)),
        );
        let scheduled = 0;
        for (const t of waiting) {
            try {
                writableTask(t.id);
            } catch {
                continue; // a share that forbids the edit: leave it as it is
            }
            await updateLocal<MaintenanceTask>(TASKS_TABLE, t.id, {
                next_due_hours: reading + (t.interval_value || 200),
            } as Partial<MaintenanceTask>);
            scheduled++;
        }
        if (scheduled > 0) dispatchDataChange(DATA_EVENTS.MAINTENANCE);
        return scheduled;
    }

    // ── HISTORY ──

    /** Get service history for a specific task */
    static getHistory(taskId: string): MaintenanceHistory[] {
        const inBinder = binderRowFilter(REGISTER);
        const items = query<MaintenanceHistory>(HISTORY_TABLE, (h) => inBinder(h) && h.task_id === taskId);
        return items.sort((a, b) => new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime());
    }

    /**
     * Remove one mistaken record (126-B7a). The task's next due is left as it
     * is. Owner only: crew are refused before anything is queued.
     */
    static async deleteHistory(id: string): Promise<void> {
        assertBinderDeletable(REGISTER, getById<MaintenanceHistory>(HISTORY_TABLE, id));
        await deleteLocal(HISTORY_TABLE, id);
        dispatchDataChange(DATA_EVENTS.MAINTENANCE);
    }

    // ── SEED DEFAULTS (Offline) ──

    /**
     * Seed the 40 default maintenance tasks for a new user — locally.
     * Matching the cloud MaintenanceService.seedDefaults() API.
     */
    static async seedDefaults(): Promise<number> {
        // Never into a skipper's shared R&M, and never before the server has
        // confirmed this account's crew memberships once: a crew device that
        // seeded first put 40 duplicate defaults in the skipper's binder.
        if (!canSeedOwnBinder(REGISTER)) return 0;
        const owner = binderInsertOwner(REGISTER);
        const { DEFAULT_MAINTENANCE_TASKS } = await import('../../components/vessel/maintenance/defaultTasks');
        // An hour task is due a whole interval after the engine's reading, or
        // unset until there is one: never counted from zero (126-B1).
        const reading = LocalEngineHoursService.getReading().hours;

        const now = new Date();
        for (const t of DEFAULT_MAINTENANCE_TASKS) {
            const isEngineHours = t.trigger_type === 'engine_hours';
            const dueDate = isEngineHours
                ? null
                : new Date(now.getTime() + t.interval_value * 86_400_000).toISOString().split('T')[0];
            const dueHours = isEngineHours && reading !== null ? reading + t.interval_value : null;

            const record: MaintenanceTask = {
                id: generateUUID(),
                user_id: owner,
                title: t.title,
                description: t.description,
                category: t.category,
                trigger_type: t.trigger_type,
                interval_value: t.interval_value,
                next_due_date: dueDate,
                next_due_hours: dueHours,
                last_completed: null,
                is_active: true,
                created_at: now.toISOString(),
                updated_at: now.toISOString(),
            };

            await insertLocal<MaintenanceTask>(TASKS_TABLE, record);
        }

        dispatchDataChange(DATA_EVENTS.MAINTENANCE);
        return DEFAULT_MAINTENANCE_TASKS.length;
    }
}
