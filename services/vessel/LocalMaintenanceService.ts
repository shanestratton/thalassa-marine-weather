/**
 * LocalMaintenanceService — Offline-first CRUD for Maintenance Hub.
 *
 * All reads/writes go to local database. Mutations are queued
 * for background sync to Supabase. UI never touches the network.
 *
 * The "Log Service" action writes to BOTH local_maintenance_history
 * AND updates local_maintenance_tasks — then queues both mutations.
 */
import {
    getAll,
    getById,
    query,
    insertLocal,
    updateLocal,
    deleteLocal,
    generateUUID,
} from './LocalDatabase';
import {
    calculateStatus,
    sortByUrgency,
    type TaskWithStatus,
} from '../MaintenanceService';
import type {
    MaintenanceTask,
    MaintenanceHistory,
    MaintenanceCategory,
} from '../../types';

const TASKS_TABLE = 'maintenance_tasks';
const HISTORY_TABLE = 'maintenance_history';

export class LocalMaintenanceService {

    // ── TASKS (READ) ──

    /** Get all active tasks (from local cache) */
    static getTasks(): MaintenanceTask[] {
        return query<MaintenanceTask>(TASKS_TABLE, t => t.is_active);
    }

    /** Get all tasks including paused */
    static getAllTasks(): MaintenanceTask[] {
        return getAll<MaintenanceTask>(TASKS_TABLE);
    }

    /** Get tasks by category */
    static getByCategory(category: MaintenanceCategory): MaintenanceTask[] {
        return query<MaintenanceTask>(TASKS_TABLE, t =>
            t.category === category && t.is_active
        );
    }

    /** Get tasks with traffic light status, sorted by urgency */
    static getTasksWithStatus(engineHours: number): TaskWithStatus[] {
        const tasks = LocalMaintenanceService.getTasks();
        return sortByUrgency(tasks.map(t => calculateStatus(t, engineHours)));
    }

    // ── TASKS (WRITE) ──

    /** Create a new maintenance task */
    static async createTask(
        task: Omit<MaintenanceTask, 'id' | 'user_id' | 'created_at' | 'updated_at'>
    ): Promise<MaintenanceTask> {
        const now = new Date().toISOString();
        const record: MaintenanceTask = {
            ...task,
            id: generateUUID(),
            user_id: '',
            created_at: now,
            updated_at: now,
        };

        return await insertLocal<MaintenanceTask>(TASKS_TABLE, record);
    }

    /** Update a task */
    static async updateTask(
        id: string,
        updates: Partial<MaintenanceTask>
    ): Promise<MaintenanceTask | null> {
        return await updateLocal<MaintenanceTask>(TASKS_TABLE, id, updates);
    }

    /** Soft-delete (pause) a task */
    static async deactivateTask(id: string): Promise<void> {
        await updateLocal<MaintenanceTask>(TASKS_TABLE, id, {
            is_active: false,
        } as Partial<MaintenanceTask>);
    }

    /** Hard-delete a task */
    static async deleteTask(id: string): Promise<void> {
        await deleteLocal(TASKS_TABLE, id);
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

        const task = getById<MaintenanceTask>(TASKS_TABLE, taskId);
        if (!task) throw new Error('Task not found');

        const now = new Date().toISOString();

        // ── Calculate new due thresholds ──
        let nextDueDate = task.next_due_date;
        let nextDueHours = task.next_due_hours;

        switch (task.trigger_type) {
            case 'date': {
                const interval = task.interval_value || 365;
                const d = new Date();
                d.setDate(d.getDate() + interval);
                nextDueDate = d.toISOString();
                break;
            }
            case 'engine_hours': {
                const interval = task.interval_value || 200;
                nextDueHours = (engineHours || 0) + interval;
                break;
            }
            case 'recurring_days': {
                const interval = task.interval_value || 30;
                const d = new Date();
                d.setDate(d.getDate() + interval);
                nextDueDate = d.toISOString();
                break;
            }
        }

        // ── 1. INSERT history record ──
        const historyRecord: MaintenanceHistory = {
            id: generateUUID(),
            user_id: '',
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

        return {
            historyId: historyRecord.id,
            nextDueDate,
            nextDueHours,
        };
    }

    // ── HISTORY (READ) ──

    /** Get service history for a specific task */
    static getHistory(taskId: string): MaintenanceHistory[] {
        const items = query<MaintenanceHistory>(HISTORY_TABLE, h => h.task_id === taskId);
        return items.sort((a, b) =>
            new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime()
        );
    }

    /** Get all history (recent first) */
    static getAllHistory(limit: number = 50): MaintenanceHistory[] {
        return getAll<MaintenanceHistory>(HISTORY_TABLE)
            .sort((a, b) =>
                new Date(b.completed_at).getTime() - new Date(a.completed_at).getTime()
            )
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
            overdue: statuses.filter(t => t.status === 'red').length,
            dueSoon: statuses.filter(t => t.status === 'yellow').length,
            ok: statuses.filter(t => t.status === 'green').length,
            totalSpent,
        };
    }
}
