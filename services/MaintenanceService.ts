/**
 * MaintenanceService — CRUD + atomic "Log Service" for vessel maintenance tasks.
 *
 * Uses Supabase RPC `log_service` for atomic history insert + task update.
 * Traffic light status calculated client-side from current engine hours + dates.
 */
import { supabase } from './supabase';
import type { MaintenanceTask, MaintenanceHistory, MaintenanceCategory } from '../types';
import { DATA_EVENTS, dispatchDataChange } from '../utils/dataChangeEvents';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';

const TASKS_TABLE = 'maintenance_tasks';
const HISTORY_TABLE = 'maintenance_history';
const VESSEL_IDENTITY_TABLE = 'vessel_identity';
const CREW_TABLE = 'vessel_crew';

interface MaintenanceContext {
    readonly scope: AuthIdentityScope;
    readonly authUserId: string;
    readonly ownerId: string;
}

function getClient() {
    if (!supabase) throw new Error('Supabase not configured');
    return supabase;
}

function contextIsCurrent(context: MaintenanceContext): boolean {
    return isAuthIdentityScopeCurrent(context.scope) && context.scope.userId === context.authUserId;
}

function normalizeId(id: string): string | null {
    if (typeof id !== 'string') return null;
    const normalized = id.trim();
    return normalized && normalized.length <= 128 ? normalized : null;
}

function cloneTask(task: MaintenanceTask): MaintenanceTask {
    return { ...task };
}

function cloneHistory(history: MaintenanceHistory): MaintenanceHistory {
    return { ...history };
}

const TASK_WRITE_KEYS = [
    'title',
    'description',
    'category',
    'trigger_type',
    'interval_value',
    'next_due_date',
    'next_due_hours',
    'last_completed',
    'is_active',
] as const;

function snapshotTaskWrite(input: Partial<MaintenanceTask>): Partial<MaintenanceTask> {
    const snapshot: Partial<MaintenanceTask> = {};
    for (const key of TASK_WRITE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(input, key)) {
            snapshot[key] = input[key] as never;
        }
    }
    return snapshot;
}

// ── Traffic Light Status ──────────────────────────────────────────

export type TrafficLight = 'red' | 'yellow' | 'green' | 'grey';

export interface TaskWithStatus extends MaintenanceTask {
    status: TrafficLight;
    statusLabel: string; // "Overdue by 14 days", "Due in 5 days", etc.
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
    private static async resolveContext(): Promise<MaintenanceContext | null> {
        const client = getClient();
        const scope = getAuthIdentityScope();
        if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return null;

        const {
            data: { user },
            error: authError,
        } = await client.auth.getUser();
        if (authError || !user || user.id !== scope.userId || !isAuthIdentityScopeCurrent(scope)) return null;
        const authUserId = scope.userId;

        // A user's own vessel always wins over crew memberships.
        const { data: ownedVessel, error: ownerError } = await client
            .from(VESSEL_IDENTITY_TABLE)
            .select('owner_id')
            .eq('owner_id', authUserId)
            .maybeSingle();
        if (!isAuthIdentityScopeCurrent(scope)) return null;
        if (ownerError) throw new Error(`Failed to resolve maintenance vessel: ${ownerError.message}`);
        if (ownedVessel) {
            if (ownedVessel.owner_id !== authUserId) return null;
            return Object.freeze({ scope, authUserId, ownerId: authUserId });
        }

        const { data: memberships, error: crewError } = await client
            .from(CREW_TABLE)
            .select('owner_id, crew_user_id, status, shared_registers')
            .eq('crew_user_id', authUserId)
            .eq('status', 'accepted')
            .contains('shared_registers', ['maintenance']);
        if (!isAuthIdentityScopeCurrent(scope)) return null;
        if (crewError) throw new Error(`Failed to resolve maintenance vessel: ${crewError.message}`);

        const ownerIds = new Set<string>();
        for (const row of memberships || []) {
            if (
                row.crew_user_id === authUserId &&
                row.status === 'accepted' &&
                Array.isArray(row.shared_registers) &&
                row.shared_registers.includes('maintenance') &&
                typeof row.owner_id === 'string' &&
                row.owner_id
            ) {
                ownerIds.add(row.owner_id);
            }
        }
        if (ownerIds.size !== 1) return null;
        return Object.freeze({ scope, authUserId, ownerId: [...ownerIds][0] });
    }

    private static requireContext(context: MaintenanceContext | null): MaintenanceContext {
        if (!context || !contextIsCurrent(context)) {
            throw new Error('No unambiguous maintenance vessel access');
        }
        return context;
    }

    private static dispatchMaintenance(context: MaintenanceContext): void {
        if (contextIsCurrent(context)) dispatchDataChange(DATA_EVENTS.MAINTENANCE);
    }

    private static async getTasksForContext(
        context: MaintenanceContext,
        activeOnly: boolean,
        category?: MaintenanceCategory,
    ): Promise<MaintenanceTask[]> {
        if (!contextIsCurrent(context)) return [];
        let query = getClient().from(TASKS_TABLE).select('*').eq('user_id', context.ownerId);
        if (activeOnly) query = query.eq('is_active', true);
        if (category) query = query.eq('category', category);
        query = query.order('category').order('title');

        const { data, error } = await query;
        if (!contextIsCurrent(context)) return [];
        if (error) throw new Error(`Failed to load tasks: ${error.message}`);
        return ((data || []) as MaintenanceTask[])
            .filter((task) => task.user_id === context.ownerId && typeof task.id === 'string')
            .map(cloneTask);
    }

    private static async getHistoryForContext(
        context: MaintenanceContext,
        limit: number | null,
        taskId?: string,
    ): Promise<MaintenanceHistory[]> {
        if (!contextIsCurrent(context)) return [];
        let query = getClient().from(HISTORY_TABLE).select('*').eq('user_id', context.ownerId);
        if (taskId) query = query.eq('task_id', taskId);
        query = query.order('completed_at', { ascending: false });
        if (limit !== null) query = query.limit(limit);

        const { data, error } = await query;
        if (!contextIsCurrent(context)) return [];
        if (error) throw new Error(`Failed to load history: ${error.message}`);
        return ((data || []) as MaintenanceHistory[])
            .filter(
                (history) =>
                    history.user_id === context.ownerId &&
                    typeof history.id === 'string' &&
                    (!taskId || history.task_id === taskId),
            )
            .map(cloneHistory);
    }

    private static async verifyTaskOwner(context: MaintenanceContext, taskId: string): Promise<MaintenanceTask | null> {
        if (!contextIsCurrent(context)) return null;
        const { data, error } = await getClient()
            .from(TASKS_TABLE)
            .select('*')
            .eq('id', taskId)
            .eq('user_id', context.ownerId)
            .maybeSingle();
        if (!contextIsCurrent(context)) return null;
        if (error) throw new Error(`Failed to verify maintenance task: ${error.message}`);
        if (!data || data.id !== taskId || data.user_id !== context.ownerId) return null;
        return cloneTask(data as MaintenanceTask);
    }

    private static async verifyHistoryOwner(
        context: MaintenanceContext,
        historyId: string,
        taskId: string,
    ): Promise<boolean> {
        if (!contextIsCurrent(context)) return false;
        const { data, error } = await getClient()
            .from(HISTORY_TABLE)
            .select('id, user_id, task_id')
            .eq('id', historyId)
            .eq('task_id', taskId)
            .eq('user_id', context.ownerId)
            .maybeSingle();
        if (!contextIsCurrent(context)) return false;
        if (error) throw new Error(`Failed to verify maintenance history: ${error.message}`);
        return data?.id === historyId && data.task_id === taskId && data.user_id === context.ownerId;
    }

    // ── READ ──

    /** Fetch all active maintenance tasks */
    static async getTasks(): Promise<MaintenanceTask[]> {
        const context = await MaintenanceService.resolveContext();
        if (!context) return [];
        return MaintenanceService.getTasksForContext(context, true);
    }

    /** Fetch all tasks (including paused) */
    static async getAllTasks(): Promise<MaintenanceTask[]> {
        const context = await MaintenanceService.resolveContext();
        if (!context) return [];
        return MaintenanceService.getTasksForContext(context, false);
    }

    /** Fetch tasks by category */
    static async getByCategory(category: MaintenanceCategory): Promise<MaintenanceTask[]> {
        const context = await MaintenanceService.resolveContext();
        if (!context) return [];
        return MaintenanceService.getTasksForContext(context, true, category);
    }

    // ── CREATE ──

    /** Create a new maintenance task */
    static async createTask(
        task: Omit<MaintenanceTask, 'id' | 'user_id' | 'created_at' | 'updated_at'>,
    ): Promise<MaintenanceTask> {
        const taskSnapshot = snapshotTaskWrite(task);
        const context = MaintenanceService.requireContext(await MaintenanceService.resolveContext());

        const { data, error } = await getClient()
            .from(TASKS_TABLE)
            .insert({ ...taskSnapshot, user_id: context.ownerId })
            .select('*')
            .single();

        if (!contextIsCurrent(context)) throw new Error('Account changed while creating maintenance task');
        if (error) throw new Error(`Failed to create task: ${error.message}`);
        if (!data || data.user_id !== context.ownerId || typeof data.id !== 'string') {
            throw new Error('Created maintenance task failed ownership validation');
        }
        MaintenanceService.dispatchMaintenance(context);
        return cloneTask(data as MaintenanceTask);
    }

    // ── UPDATE ──

    /** Update a task */
    static async updateTask(id: string, updates: Partial<MaintenanceTask>): Promise<MaintenanceTask> {
        const taskId = normalizeId(id);
        const updatesSnapshot = snapshotTaskWrite(updates);
        if (!taskId) throw new Error('Invalid maintenance task id');
        const context = MaintenanceService.requireContext(await MaintenanceService.resolveContext());
        const { data, error } = await getClient()
            .from(TASKS_TABLE)
            .update(updatesSnapshot)
            .eq('id', taskId)
            .eq('user_id', context.ownerId)
            .select('*')
            .single();

        if (!contextIsCurrent(context)) throw new Error('Account changed while updating maintenance task');
        if (error) throw new Error(`Failed to update task: ${error.message}`);
        if (!data || data.id !== taskId || data.user_id !== context.ownerId) {
            throw new Error('Updated maintenance task failed ownership validation');
        }
        MaintenanceService.dispatchMaintenance(context);
        return cloneTask(data as MaintenanceTask);
    }

    /** Soft-delete (pause) a task */
    static async deactivateTask(id: string): Promise<void> {
        const taskId = normalizeId(id);
        if (!taskId) throw new Error('Invalid maintenance task id');
        const context = MaintenanceService.requireContext(await MaintenanceService.resolveContext());
        const { data, error } = await getClient()
            .from(TASKS_TABLE)
            .update({ is_active: false })
            .eq('id', taskId)
            .eq('user_id', context.ownerId)
            .select('id, user_id')
            .maybeSingle();

        if (!contextIsCurrent(context)) throw new Error('Account changed while deactivating maintenance task');
        if (error) throw new Error(`Failed to deactivate task: ${error.message}`);
        if (!data || data.id !== taskId || data.user_id !== context.ownerId) {
            throw new Error('Maintenance task was not deactivated');
        }
        MaintenanceService.dispatchMaintenance(context);
    }

    /** Hard-delete a task */
    static async deleteTask(id: string): Promise<void> {
        const taskId = normalizeId(id);
        if (!taskId) throw new Error('Invalid maintenance task id');
        const context = MaintenanceService.requireContext(await MaintenanceService.resolveContext());
        if (context.ownerId !== context.authUserId) {
            throw new Error('Only the vessel owner can permanently delete maintenance tasks');
        }
        const { data, error } = await getClient()
            .from(TASKS_TABLE)
            .delete()
            .eq('id', taskId)
            .eq('user_id', context.ownerId)
            .select('id, user_id')
            .maybeSingle();

        if (!contextIsCurrent(context)) throw new Error('Account changed while deleting maintenance task');
        if (error) throw new Error(`Failed to delete task: ${error.message}`);
        if (!data || data.id !== taskId || data.user_id !== context.ownerId) {
            throw new Error('Maintenance task was not deleted');
        }
        MaintenanceService.dispatchMaintenance(context);
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
        cost: number | null,
    ): Promise<{ history_id: string; next_due_date: string | null; next_due_hours: number | null }> {
        const normalizedTaskId = normalizeId(taskId);
        if (!normalizedTaskId) throw new Error('Invalid maintenance task id');
        const args = {
            p_task_id: normalizedTaskId,
            p_engine_hours: engineHours,
            p_notes: notes,
            p_cost: cost,
        };
        const context = MaintenanceService.requireContext(await MaintenanceService.resolveContext());
        const taskBefore = await MaintenanceService.verifyTaskOwner(context, normalizedTaskId);
        if (!taskBefore || !contextIsCurrent(context)) {
            throw new Error('Maintenance task is not accessible for this vessel');
        }

        const { data, error } = await getClient().rpc('log_service', {
            ...args,
        });

        if (!contextIsCurrent(context)) throw new Error('Account changed while logging maintenance service');
        if (error) throw new Error(`Failed to log service: ${error.message}`);
        const taskAfter = await MaintenanceService.verifyTaskOwner(context, normalizedTaskId);
        if (!taskAfter || !contextIsCurrent(context)) {
            throw new Error('Maintenance task ownership changed while logging service');
        }
        if (!data || typeof data.history_id !== 'string') {
            throw new Error('Log service returned an invalid result');
        }
        const historyIsOwned = await MaintenanceService.verifyHistoryOwner(context, data.history_id, normalizedTaskId);
        if (!historyIsOwned || !contextIsCurrent(context)) {
            throw new Error('Maintenance history failed ownership validation');
        }
        // The "tick off" path — service logged, next_due reset on the
        // task. The Nav Station overdue badge needs to refresh; this
        // event is what makes that happen.
        MaintenanceService.dispatchMaintenance(context);
        return data as { history_id: string; next_due_date: string | null; next_due_hours: number | null };
    }

    // ── HISTORY ──

    /** Get service history for a specific task */
    static async getHistory(taskId: string): Promise<MaintenanceHistory[]> {
        const normalizedTaskId = normalizeId(taskId);
        if (!normalizedTaskId) return [];
        const context = await MaintenanceService.resolveContext();
        if (!context) return [];
        return MaintenanceService.getHistoryForContext(context, null, normalizedTaskId);
    }

    /** Get all history (recent first) */
    static async getAllHistory(limit = 50): Promise<MaintenanceHistory[]> {
        const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.min(500, Math.trunc(limit))) : 50;
        const context = await MaintenanceService.resolveContext();
        if (!context) return [];
        return MaintenanceService.getHistoryForContext(context, safeLimit);
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
        const engineHoursSnapshot = currentEngineHours;
        const context = await MaintenanceService.resolveContext();
        if (!context) {
            return { totalTasks: 0, overdue: 0, dueSoon: 0, ok: 0, totalSpent: 0 };
        }
        const tasks = await MaintenanceService.getTasksForContext(context, true);
        if (!contextIsCurrent(context)) {
            return { totalTasks: 0, overdue: 0, dueSoon: 0, ok: 0, totalSpent: 0 };
        }
        const statuses = tasks.map((t) => calculateStatus(t, engineHoursSnapshot));

        const history = await MaintenanceService.getHistoryForContext(context, 500);
        if (!contextIsCurrent(context)) {
            return { totalTasks: 0, overdue: 0, dueSoon: 0, ok: 0, totalSpent: 0 };
        }
        const totalSpent = history.reduce((sum, h) => sum + (h.cost || 0), 0);

        return {
            totalTasks: tasks.length,
            overdue: statuses.filter((t) => t.status === 'red').length,
            dueSoon: statuses.filter((t) => t.status === 'yellow').length,
            ok: statuses.filter((t) => t.status === 'green').length,
            totalSpent,
        };
    }

    // ── SEED DEFAULTS ──

    /**
     * Seed the 40 default maintenance tasks for a new user.
     * Only call when the user has zero tasks (first-time setup).
     */
    static async seedDefaults(): Promise<number> {
        const context = MaintenanceService.requireContext(await MaintenanceService.resolveContext());
        const { DEFAULT_MAINTENANCE_TASKS } = await import('../components/vessel/maintenance/defaultTasks');
        if (!contextIsCurrent(context)) return 0;

        const now = new Date();
        const rows = DEFAULT_MAINTENANCE_TASKS.map((t) => {
            const isEngineHours = t.trigger_type === 'engine_hours';
            const dueDate = isEngineHours
                ? null
                : new Date(now.getTime() + t.interval_value * 86_400_000).toISOString().split('T')[0];
            const dueHours = isEngineHours ? t.interval_value : null;

            return {
                user_id: context.ownerId,
                title: t.title,
                description: t.description,
                category: t.category,
                trigger_type: t.trigger_type,
                interval_value: t.interval_value,
                next_due_date: dueDate,
                next_due_hours: dueHours,
                last_completed: null,
                is_active: true,
            };
        });

        const { error } = await getClient().from(TASKS_TABLE).insert(rows);

        if (!contextIsCurrent(context)) return 0;
        if (error) throw new Error(`Failed to seed defaults: ${error.message}`);
        return rows.length;
    }
}
