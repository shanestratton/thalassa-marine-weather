/**
 * MaintenanceService — CRUD + atomic "Log Service" for vessel maintenance tasks.
 *
 * Uses Supabase RPC `log_service` for atomic history insert + task update.
 * Traffic light status calculated client-side from current engine hours + dates.
 */
import { supabase } from './supabase';
import type { MaintenanceTask, MaintenanceHistory, MaintenanceCategory } from '../types';

const TASKS_TABLE = 'maintenance_tasks';
const HISTORY_TABLE = 'maintenance_history';

function getClient() {
    if (!supabase) throw new Error('Supabase not configured');
    return supabase;
}

// ── Traffic Light Status ──────────────────────────────────────────

export type TrafficLight = 'red' | 'yellow' | 'green' | 'grey';

export interface TaskWithStatus extends MaintenanceTask {
    status: TrafficLight;
    statusLabel: string;        // "Overdue by 14 days", "Due in 5 days", etc.
    daysRemaining: number | null;
    hoursRemaining: number | null;
}

/**
 * Calculate traffic light status for a task given current engine hours.
 */
export function calculateStatus(task: MaintenanceTask, currentEngineHours: number): TaskWithStatus {
    const now = Date.now();
    let status: TrafficLight = 'green';
    let statusLabel = 'OK';
    let daysRemaining: number | null = null;
    let hoursRemaining: number | null = null;

    // Date-based check
    if (task.next_due_date) {
        const dueMs = new Date(task.next_due_date).getTime();
        daysRemaining = Math.ceil((dueMs - now) / (1000 * 60 * 60 * 24));

        if (daysRemaining < 0) {
            status = 'red';
            statusLabel = `Overdue by ${Math.abs(daysRemaining)} day${Math.abs(daysRemaining) !== 1 ? 's' : ''}`;
        } else if (daysRemaining <= 14) {
            status = 'yellow';
            statusLabel = `Due in ${daysRemaining} day${daysRemaining !== 1 ? 's' : ''}`;
        } else {
            statusLabel = `Due in ${daysRemaining} day${daysRemaining !== 1 ? 's' : ''}`;
        }
    }

    // Engine-hours check (can override date status if MORE urgent)
    if (task.next_due_hours !== null && task.next_due_hours !== undefined) {
        hoursRemaining = task.next_due_hours - currentEngineHours;

        if (hoursRemaining < 0) {
            status = 'red';
            statusLabel = `Overdue by ${Math.abs(hoursRemaining)} hr${Math.abs(hoursRemaining) !== 1 ? 's' : ''}`;
        } else if (hoursRemaining <= 20 && status !== 'red') {
            status = 'yellow';
            statusLabel = `Due in ${hoursRemaining} hr${hoursRemaining !== 1 ? 's' : ''}`;
        } else if (status === 'green') {
            statusLabel = `Due at ${task.next_due_hours} hrs`;
        }
    }

    // No due date or hours → grey (unscheduled)
    if (!task.next_due_date && (task.next_due_hours === null || task.next_due_hours === undefined)) {
        status = 'grey';
        statusLabel = 'No schedule set';
    }

    if (!task.is_active) {
        status = 'grey';
        statusLabel = 'Paused';
    }

    return { ...task, status, statusLabel, daysRemaining, hoursRemaining };
}

/**
 * Sort tasks by urgency: red first, then yellow, then green, then grey.
 * Within same status, sort by nearest due.
 */
export function sortByUrgency(tasks: TaskWithStatus[]): TaskWithStatus[] {
    const priority: Record<TrafficLight, number> = { red: 0, yellow: 1, green: 2, grey: 3 };
    return [...tasks].sort((a, b) => {
        const pd = priority[a.status] - priority[b.status];
        if (pd !== 0) return pd;
        // Within same priority, sort by smallest remaining
        const aVal = a.hoursRemaining ?? a.daysRemaining ?? 9999;
        const bVal = b.hoursRemaining ?? b.daysRemaining ?? 9999;
        return aVal - bVal;
    });
}

// ── Service Class ─────────────────────────────────────────────────

export class MaintenanceService {
    // ── READ ──

    /** Fetch all active maintenance tasks */
    static async getTasks(): Promise<MaintenanceTask[]> {
        const { data, error } = await getClient()
            .from(TASKS_TABLE)
            .select('*')
            .eq('is_active', true)
            .order('category')
            .order('title');

        if (error) throw new Error(`Failed to load tasks: ${error.message}`);
        return (data || []) as MaintenanceTask[];
    }

    /** Fetch all tasks (including paused) */
    static async getAllTasks(): Promise<MaintenanceTask[]> {
        const { data, error } = await getClient()
            .from(TASKS_TABLE)
            .select('*')
            .order('category')
            .order('title');

        if (error) throw new Error(`Failed to load tasks: ${error.message}`);
        return (data || []) as MaintenanceTask[];
    }

    /** Fetch tasks by category */
    static async getByCategory(category: MaintenanceCategory): Promise<MaintenanceTask[]> {
        const { data, error } = await getClient()
            .from(TASKS_TABLE)
            .select('*')
            .eq('category', category)
            .eq('is_active', true)
            .order('title');

        if (error) throw new Error(`Failed to load category: ${error.message}`);
        return (data || []) as MaintenanceTask[];
    }

    // ── CREATE ──

    /** Create a new maintenance task */
    static async createTask(task: Omit<MaintenanceTask, 'id' | 'user_id' | 'created_at' | 'updated_at'>): Promise<MaintenanceTask> {
        const { data: { user } } = await getClient().auth.getUser();
        if (!user) throw new Error('Not authenticated');

        const { data, error } = await getClient()
            .from(TASKS_TABLE)
            .insert({ ...task, user_id: user.id })
            .select()
            .single();

        if (error) throw new Error(`Failed to create task: ${error.message}`);
        return data as MaintenanceTask;
    }

    // ── UPDATE ──

    /** Update a task */
    static async updateTask(id: string, updates: Partial<MaintenanceTask>): Promise<MaintenanceTask> {
        const { data, error } = await getClient()
            .from(TASKS_TABLE)
            .update(updates)
            .eq('id', id)
            .select()
            .single();

        if (error) throw new Error(`Failed to update task: ${error.message}`);
        return data as MaintenanceTask;
    }

    /** Soft-delete (pause) a task */
    static async deactivateTask(id: string): Promise<void> {
        const { error } = await getClient()
            .from(TASKS_TABLE)
            .update({ is_active: false })
            .eq('id', id);

        if (error) throw new Error(`Failed to deactivate task: ${error.message}`);
    }

    /** Hard-delete a task */
    static async deleteTask(id: string): Promise<void> {
        const { error } = await getClient()
            .from(TASKS_TABLE)
            .delete()
            .eq('id', id);

        if (error) throw new Error(`Failed to delete task: ${error.message}`);
    }

    // ── LOG SERVICE (The Reset Loop) ──

    /**
     * Atomic: Insert history + update task's next_due in one transaction.
     * Uses the `log_service` Supabase RPC function.
     */
    static async logService(
        taskId: string,
        engineHours: number | null,
        notes: string | null,
        cost: number | null
    ): Promise<{ history_id: string; next_due_date: string | null; next_due_hours: number | null }> {
        const { data, error } = await getClient()
            .rpc('log_service', {
                p_task_id: taskId,
                p_engine_hours: engineHours,
                p_notes: notes,
                p_cost: cost,
            });

        if (error) throw new Error(`Failed to log service: ${error.message}`);
        return data as { history_id: string; next_due_date: string | null; next_due_hours: number | null };
    }

    // ── HISTORY ──

    /** Get service history for a specific task */
    static async getHistory(taskId: string): Promise<MaintenanceHistory[]> {
        const { data, error } = await getClient()
            .from(HISTORY_TABLE)
            .select('*')
            .eq('task_id', taskId)
            .order('completed_at', { ascending: false });

        if (error) throw new Error(`Failed to load history: ${error.message}`);
        return (data || []) as MaintenanceHistory[];
    }

    /** Get all history (recent first) */
    static async getAllHistory(limit = 50): Promise<MaintenanceHistory[]> {
        const { data, error } = await getClient()
            .from(HISTORY_TABLE)
            .select('*')
            .order('completed_at', { ascending: false })
            .limit(limit);

        if (error) throw new Error(`Failed to load history: ${error.message}`);
        return (data || []) as MaintenanceHistory[];
    }

    // ── STATS ──

    /** Get maintenance overview stats */
    static async getStats(currentEngineHours: number): Promise<{
        totalTasks: number;
        overdue: number;
        dueSoon: number;
        ok: number;
        totalSpent: number;
    }> {
        const tasks = await MaintenanceService.getTasks();
        const statuses = tasks.map(t => calculateStatus(t, currentEngineHours));

        const history = await MaintenanceService.getAllHistory(500);
        const totalSpent = history.reduce((sum, h) => sum + (h.cost || 0), 0);

        return {
            totalTasks: tasks.length,
            overdue: statuses.filter(t => t.status === 'red').length,
            dueSoon: statuses.filter(t => t.status === 'yellow').length,
            ok: statuses.filter(t => t.status === 'green').length,
            totalSpent,
        };
    }
}
