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
import { calculateStatus, sortByUrgency, type TaskWithStatus } from '../MaintenanceService';
import { LocalEngineHoursService } from './LocalEngineHoursService';
import { DATA_EVENTS, dispatchDataChange } from '../../utils/dataChangeEvents';
import type { MaintenanceTask, MaintenanceHistory, MaintenanceCategory } from '../../types';

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

    /** Get tasks by category */
    static getByCategory(category: MaintenanceCategory): MaintenanceTask[] {
        const inBinder = binderRowFilter(REGISTER);
        return query<MaintenanceTask>(TASKS_TABLE, (t) => inBinder(t) && t.category === category && t.is_active);
    }

    /** Get tasks with traffic light status, sorted by urgency */
    static getTasksWithStatus(engineHours: number): TaskWithStatus[] {
        const tasks = LocalMaintenanceService.getTasks();
        return sortByUrgency(tasks.map((t) => calculateStatus(t, engineHours)));
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

    /** Soft-delete (pause) a task */
    static async deactivateTask(id: string): Promise<void> {
        writableTask(id);
        await updateLocal<MaintenanceTask>(TASKS_TABLE, id, {
            is_active: false,
        } as Partial<MaintenanceTask>);
        dispatchDataChange(DATA_EVENTS.MAINTENANCE);
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
    ): Promise<{ historyId: string; nextDueDate: string | null; nextDueHours: number | null }> {
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
            nextDueDate,
            nextDueHours,
        };
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

    // ── HISTORY (READ) ──

    /** Get service history for a specific task */
    static getHistory(taskId: string): MaintenanceHistory[] {
        const inBinder = binderRowFilter(REGISTER);
        const items = query<MaintenanceHistory>(HISTORY_TABLE, (h) => inBinder(h) && h.task_id === taskId);
        return items.sort((a, b) => new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime());
    }

    /** Get all history (recent first) */
    static getAllHistory(limit: number = 50): MaintenanceHistory[] {
        return query<MaintenanceHistory>(HISTORY_TABLE, binderRowFilter(REGISTER))
            .sort((a, b) => new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime())
            .slice(0, limit);
    }

    // ── STATS ──

    /** Get maintenance overview stats */
    static getStats(engineHours: number): {
        totalTasks: number;
        overdue: number;
        dueSoon: number;
        ok: number;
        totalSpent: number;
    } {
        const statuses = LocalMaintenanceService.getTasksWithStatus(engineHours);
        const history = LocalMaintenanceService.getAllHistory(500);
        const totalSpent = history.reduce((sum, h) => sum + (h.cost || 0), 0);

        return {
            totalTasks: statuses.length,
            overdue: statuses.filter((t) => t.status === 'red').length,
            dueSoon: statuses.filter((t) => t.status === 'yellow').length,
            ok: statuses.filter((t) => t.status === 'green').length,
            totalSpent,
        };
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
