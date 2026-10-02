import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import { reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';
import { supabase } from '../services/supabase';
import type { MaintenanceTask } from '../types';

const events = vi.hoisted(() => ({
    dispatch: vi.fn(),
}));

vi.mock('../utils/dataChangeEvents', () => ({
    DATA_EVENTS: { MAINTENANCE: 'maintenance' },
    dispatchDataChange: events.dispatch,
}));

import { MaintenanceService } from '../services/MaintenanceService';

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

function queryFor<T>(result: T | Promise<T>) {
    const promise = Promise.resolve(result);
    const query: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const method of ['select', 'insert', 'update', 'delete', 'eq', 'contains', 'order', 'limit']) {
        query[method] = vi.fn().mockReturnValue(query);
    }
    query.single = vi.fn().mockReturnValue(promise);
    query.maybeSingle = vi.fn().mockReturnValue(promise);
    query.then = vi.fn((resolve, reject) => promise.then(resolve, reject));
    return query;
}

const authUser = (id: string) => ({
    data: { user: { id } },
    error: null,
});

const taskRow = (ownerId = 'account-a', id = 'task-1'): MaintenanceTask => ({
    id,
    user_id: ownerId,
    title: 'Oil change',
    description: null,
    category: 'Engine',
    trigger_type: 'monthly',
    interval_value: 30,
    next_due_date: null,
    next_due_hours: null,
    last_completed: null,
    is_active: true,
    created_at: '2026-01-01T00:00:00.000Z',
    updated_at: '2026-01-01T00:00:00.000Z',
});

const crewMembership = (ownerId: string) => ({
    owner_id: ownerId,
    crew_user_id: 'account-a',
    status: 'accepted',
    shared_registers: ['maintenance'],
});

describe('MaintenanceService identity and vessel ownership', () => {
    const getUser = supabase!.auth.getUser as ReturnType<typeof vi.fn>;
    const from = supabase!.from as ReturnType<typeof vi.fn>;
    const rpc = supabase!.rpc as ReturnType<typeof vi.fn>;

    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        getUser.mockReset().mockResolvedValue(authUser('account-a'));
        from.mockReset();
        rpc.mockReset().mockResolvedValue({ data: null, error: null });
    });

    it('owner-binds task reads and drops deferred account-A rows after switching to B', async () => {
        const ownerQuery = queryFor({ data: { owner_id: 'account-a' }, error: null });
        const tasksResult = deferred<{ data: MaintenanceTask[]; error: null }>();
        const tasksQuery = queryFor(tasksResult.promise);
        from.mockImplementation((table: string) => {
            if (table === 'vessel_identity') return ownerQuery;
            if (table === 'maintenance_tasks') return tasksQuery;
            throw new Error(`Unexpected table: ${table}`);
        });

        const pending = MaintenanceService.getTasks();
        await vi.waitFor(() => expect(tasksQuery.order).toHaveBeenCalled());
        expect(tasksQuery.eq).toHaveBeenCalledWith('user_id', 'account-a');

        setAuthIdentityScope('account-b');
        tasksResult.resolve({ data: [taskRow('account-a')], error: null });

        await expect(pending).resolves.toEqual([]);
        expect(events.dispatch).not.toHaveBeenCalled();
    });

    it('resolves exactly one maintenance-authorized crew vessel and filters foreign rows', async () => {
        const ownerQuery = queryFor({ data: null, error: null });
        const crewQuery = queryFor({ data: [crewMembership('captain-1')], error: null });
        const tasksQuery = queryFor({
            data: [taskRow('captain-1', 'crew-task'), taskRow('other-captain', 'foreign-task')],
            error: null,
        });
        from.mockImplementation((table: string) => {
            if (table === 'vessel_identity') return ownerQuery;
            if (table === 'vessel_crew') return crewQuery;
            if (table === 'maintenance_tasks') return tasksQuery;
            throw new Error(`Unexpected table: ${table}`);
        });

        const tasks = await MaintenanceService.getAllTasks();

        expect(tasks.map((task) => task.id)).toEqual(['crew-task']);
        expect(tasksQuery.eq).toHaveBeenCalledWith('user_id', 'captain-1');
        expect(crewQuery.contains).toHaveBeenCalledWith('shared_registers', ['maintenance']);
    });

    it('prefers the authenticated owner vessel without consulting crew memberships', async () => {
        const ownerQuery = queryFor({ data: { owner_id: 'account-a' }, error: null });
        const tasksQuery = queryFor({ data: [taskRow('account-a')], error: null });
        from.mockImplementation((table: string) => {
            if (table === 'vessel_identity') return ownerQuery;
            if (table === 'maintenance_tasks') return tasksQuery;
            if (table === 'vessel_crew') throw new Error('Owner resolution must win before crew lookup');
            throw new Error(`Unexpected table: ${table}`);
        });

        await expect(MaintenanceService.getTasks()).resolves.toHaveLength(1);
        expect(from).not.toHaveBeenCalledWith('vessel_crew');
    });

    it('fails closed when accepted maintenance memberships point at multiple owners', async () => {
        const ownerQuery = queryFor({ data: null, error: null });
        const crewQuery = queryFor({
            data: [crewMembership('captain-1'), crewMembership('captain-2')],
            error: null,
        });
        from.mockImplementation((table: string) => {
            if (table === 'vessel_identity') return ownerQuery;
            if (table === 'vessel_crew') return crewQuery;
            throw new Error('Ambiguous access continued into maintenance data');
        });

        await expect(MaintenanceService.getTasks()).resolves.toEqual([]);
        expect(from).toHaveBeenCalledTimes(2);
    });

    it('strips hostile identity/id updates, fences stale completion, and emits no A event under B', async () => {
        const ownerQuery = queryFor({ data: { owner_id: 'account-a' }, error: null });
        const updateResult = deferred<{ data: MaintenanceTask; error: null }>();
        const updateQuery = queryFor(updateResult.promise);
        from.mockImplementation((table: string) => {
            if (table === 'vessel_identity') return ownerQuery;
            if (table === 'maintenance_tasks') return updateQuery;
            throw new Error(`Unexpected table: ${table}`);
        });
        const hostileUpdates = {
            id: 'other-task',
            user_id: 'account-b',
            title: 'Safe title',
        } as Partial<MaintenanceTask>;

        const pending = MaintenanceService.updateTask('task-1', hostileUpdates);
        await vi.waitFor(() => expect(updateQuery.update).toHaveBeenCalledOnce());
        expect(updateQuery.update).toHaveBeenCalledWith({ title: 'Safe title' });
        expect(updateQuery.eq).toHaveBeenCalledWith('id', 'task-1');
        expect(updateQuery.eq).toHaveBeenCalledWith('user_id', 'account-a');

        setAuthIdentityScope('account-b');
        updateResult.resolve({ data: taskRow('account-a'), error: null });

        await expect(pending).rejects.toThrow('Account changed');
        expect(events.dispatch).not.toHaveBeenCalled();
    });

    it('creates crew tasks under the vessel owner and validates the returned owner', async () => {
        const ownerQuery = queryFor({ data: null, error: null });
        const crewQuery = queryFor({ data: [crewMembership('captain-1')], error: null });
        const createQuery = queryFor({ data: taskRow('captain-1', 'crew-created'), error: null });
        from.mockImplementation((table: string) => {
            if (table === 'vessel_identity') return ownerQuery;
            if (table === 'vessel_crew') return crewQuery;
            if (table === 'maintenance_tasks') return createQuery;
            throw new Error(`Unexpected table: ${table}`);
        });
        const input = {
            title: 'Crew-created task',
            description: null,
            category: 'Engine' as const,
            trigger_type: 'monthly' as const,
            interval_value: 30,
            next_due_date: null,
            next_due_hours: null,
            last_completed: null,
            is_active: true,
        };

        const created = await MaintenanceService.createTask(input);

        expect(created.user_id).toBe('captain-1');
        expect(createQuery.insert).toHaveBeenCalledWith(expect.objectContaining({ user_id: 'captain-1' }));
        expect(events.dispatch).toHaveBeenCalledWith('maintenance');
    });

    it('reports owner-only deletion honestly for accepted crew without issuing a delete', async () => {
        const ownerQuery = queryFor({ data: null, error: null });
        const crewQuery = queryFor({ data: [crewMembership('captain-1')], error: null });
        from.mockImplementation((table: string) => {
            if (table === 'vessel_identity') return ownerQuery;
            if (table === 'vessel_crew') return crewQuery;
            throw new Error('Crew delete reached the maintenance table');
        });

        await expect(MaintenanceService.deleteTask('task-1')).rejects.toThrow('Only the vessel owner');
        expect(from).toHaveBeenCalledTimes(2);
        expect(events.dispatch).not.toHaveBeenCalled();
    });

    it('verifies log-service task ownership before RPC and stops after a stale RPC completion', async () => {
        const ownerQuery = queryFor({ data: { owner_id: 'account-a' }, error: null });
        const verifyQuery = queryFor({ data: taskRow('account-a'), error: null });
        const rpcResult = deferred<{
            data: { history_id: string; next_due_date: null; next_due_hours: number };
            error: null;
        }>();
        let taskReads = 0;
        from.mockImplementation((table: string) => {
            if (table === 'vessel_identity') return ownerQuery;
            if (table === 'maintenance_tasks') {
                taskReads += 1;
                return verifyQuery;
            }
            throw new Error(`Unexpected table: ${table}`);
        });
        rpc.mockReturnValue(rpcResult.promise);

        const pending = MaintenanceService.logService('task-1', 100, 'A notes', 25);
        await vi.waitFor(() => expect(rpc).toHaveBeenCalledOnce());
        expect(verifyQuery.eq).toHaveBeenCalledWith('id', 'task-1');
        expect(verifyQuery.eq).toHaveBeenCalledWith('user_id', 'account-a');

        setAuthIdentityScope('account-b');
        rpcResult.resolve({
            data: { history_id: 'history-a', next_due_date: null, next_due_hours: 130 },
            error: null,
        });

        await expect(pending).rejects.toThrow('Account changed');
        expect(taskReads).toBe(1);
        expect(events.dispatch).not.toHaveBeenCalled();
    });

    it('validates task and history ownership after a successful log before dispatching', async () => {
        const ownerQuery = queryFor({ data: { owner_id: 'account-a' }, error: null });
        const verifyTaskQuery = queryFor({ data: taskRow('account-a'), error: null });
        const verifyHistoryQuery = queryFor({
            data: { id: 'history-1', user_id: 'account-a', task_id: 'task-1' },
            error: null,
        });
        let taskReads = 0;
        from.mockImplementation((table: string) => {
            if (table === 'vessel_identity') return ownerQuery;
            if (table === 'maintenance_tasks') {
                taskReads += 1;
                return verifyTaskQuery;
            }
            if (table === 'maintenance_history') return verifyHistoryQuery;
            throw new Error(`Unexpected table: ${table}`);
        });
        rpc.mockResolvedValue({
            data: { history_id: 'history-1', next_due_date: null, next_due_hours: 130 },
            error: null,
        });

        await expect(MaintenanceService.logService('task-1', 100, 'Done', 25)).resolves.toEqual({
            history_id: 'history-1',
            next_due_date: null,
            next_due_hours: 130,
        });

        expect(taskReads).toBe(2);
        expect(verifyHistoryQuery.eq).toHaveBeenCalledWith('id', 'history-1');
        expect(verifyHistoryQuery.eq).toHaveBeenCalledWith('task_id', 'task-1');
        expect(verifyHistoryQuery.eq).toHaveBeenCalledWith('user_id', 'account-a');
        expect(events.dispatch).toHaveBeenCalledWith('maintenance');
    });

    it('surfaces the legacy owner-only log_service failure honestly for crew', async () => {
        const ownerQuery = queryFor({ data: null, error: null });
        const crewQuery = queryFor({ data: [crewMembership('captain-1')], error: null });
        const verifyQuery = queryFor({ data: taskRow('captain-1'), error: null });
        from.mockImplementation((table: string) => {
            if (table === 'vessel_identity') return ownerQuery;
            if (table === 'vessel_crew') return crewQuery;
            if (table === 'maintenance_tasks') return verifyQuery;
            throw new Error(`Unexpected table: ${table}`);
        });
        rpc.mockResolvedValue({ data: null, error: { message: 'Task not found or access denied' } });

        await expect(MaintenanceService.logService('task-1', null, null, null)).rejects.toThrow(
            'Task not found or access denied',
        );
        expect(rpc).toHaveBeenCalledOnce();
        expect(events.dispatch).not.toHaveBeenCalled();
    });

    it('does not continue a stale stats chain into history', async () => {
        const ownerQuery = queryFor({ data: { owner_id: 'account-a' }, error: null });
        const tasksResult = deferred<{ data: MaintenanceTask[]; error: null }>();
        const tasksQuery = queryFor(tasksResult.promise);
        from.mockImplementation((table: string) => {
            if (table === 'vessel_identity') return ownerQuery;
            if (table === 'maintenance_tasks') return tasksQuery;
            if (table === 'maintenance_history') throw new Error('Stale stats reached history');
            throw new Error(`Unexpected table: ${table}`);
        });

        const pending = MaintenanceService.getStats(100);
        await vi.waitFor(() => expect(tasksQuery.order).toHaveBeenCalled());
        setAuthIdentityScope('account-b');
        tasksResult.resolve({ data: [taskRow('account-a')], error: null });

        await expect(pending).resolves.toEqual({
            totalTasks: 0,
            overdue: 0,
            dueSoon: 0,
            ok: 0,
            totalSpent: 0,
        });
        expect(from).toHaveBeenCalledTimes(2);
    });

    it("never seeds a crew member's defaults into the skipper's binder (2026-10-01 duplicates)", async () => {
        const ownerQuery = queryFor({ data: null, error: null });
        const crewQuery = queryFor({ data: [crewMembership('captain-1')], error: null });
        const insertQuery = queryFor({ error: null });
        from.mockImplementation((table: string) => {
            if (table === 'vessel_identity') return ownerQuery;
            if (table === 'vessel_crew') return crewQuery;
            if (table === 'maintenance_tasks') return insertQuery;
            throw new Error(`Unexpected table: ${table}`);
        });

        await expect(MaintenanceService.seedDefaults()).resolves.toBe(0);
        expect(insertQuery.insert).not.toHaveBeenCalled();
    });

    it('seeds own defaults under the owner and returns zero after stale insert completion', async () => {
        const ownerQuery = queryFor({ data: { owner_id: 'account-a' }, error: null });
        const insertResult = deferred<{ error: null }>();
        const insertQuery = queryFor(insertResult.promise);
        from.mockImplementation((table: string) => {
            if (table === 'vessel_identity') return ownerQuery;
            if (table === 'maintenance_tasks') return insertQuery;
            throw new Error(`Unexpected table: ${table}`);
        });

        const pending = MaintenanceService.seedDefaults();
        await vi.waitFor(() => expect(insertQuery.insert).toHaveBeenCalledOnce());
        const rows = insertQuery.insert.mock.calls[0][0] as { user_id: string }[];
        expect(rows.length).toBeGreaterThan(20);
        expect(new Set(rows.map((row) => row.user_id))).toEqual(new Set(['account-a']));

        setAuthIdentityScope('account-b');
        insertResult.resolve({ error: null });
        await expect(pending).resolves.toBe(0);
    });
});

// ── Shared binders (2026-10-02) ──────────────────────────────────────────
//
// A crew member who ALSO owns a vessel: while the R&M on show is the
// skipper's, the cloud reads follow it, so the Vessel-tile overdue badge and
// the PDF export count the same tasks as the list.

describe('MaintenanceService follows the shared R&M binder', () => {
    const getUser = supabase!.auth.getUser as ReturnType<typeof vi.fn>;
    const from = supabase!.from as ReturnType<typeof vi.fn>;
    const snapshotKey = 'thalassa_shared_binders_v1::user%3Aaccount-a';

    function shareMaintenanceFrom(ownerId: string) {
        localStorage.setItem(
            snapshotKey,
            JSON.stringify({
                version: 1,
                userId: 'account-a',
                confirmedAt: '2026-10-02T00:00:00.000Z',
                skippers: [
                    {
                        ownerId,
                        vesselName: 'Test Boat',
                        lastAcceptedAt: '2026-10-01T00:00:00.000Z',
                        registers: {
                            stores: { read: false, write: false },
                            equipment: { read: false, write: false },
                            maintenance: { read: true, write: true },
                            documents: { read: false, write: false },
                        },
                    },
                ],
            }),
        );
        reloadSharedBindersFromStorage();
    }

    beforeEach(() => {
        vi.clearAllMocks();
        setAuthIdentityScope(null);
        setAuthIdentityScope('account-a');
        getUser.mockReset().mockResolvedValue(authUser('account-a'));
        from.mockReset();
    });
    afterEach(() => {
        localStorage.removeItem(snapshotKey);
        reloadSharedBindersFromStorage();
    });

    it("reads the skipper's tasks (A15), though the crew member owns a vessel too", async () => {
        shareMaintenanceFrom('skipper-1');
        const crewQuery = queryFor({ data: [{ ...crewMembership('skipper-1') }], error: null });
        const ownerQuery = queryFor({ data: { owner_id: 'account-a' }, error: null });
        const taskQuery = queryFor({ data: [taskRow('skipper-1', 'task-s')], error: null });
        from.mockImplementation((table: string) => {
            if (table === 'vessel_crew') return crewQuery;
            if (table === 'vessel_identity') return ownerQuery;
            if (table === 'maintenance_tasks') return taskQuery;
            throw new Error(`Unexpected table: ${table}`);
        });

        const tasks = await MaintenanceService.getTasks();

        expect(tasks.map((task) => task.id)).toEqual(['task-s']);
        expect(taskQuery.eq).toHaveBeenCalledWith('user_id', 'skipper-1');
        expect(crewQuery.eq).toHaveBeenCalledWith('owner_id', 'skipper-1');
        expect(ownerQuery.select).not.toHaveBeenCalled();
    });

    it('falls back to the own vessel when the server no longer confirms the share', async () => {
        shareMaintenanceFrom('skipper-1');
        const crewQuery = queryFor({ data: [], error: null });
        const ownerQuery = queryFor({ data: { owner_id: 'account-a' }, error: null });
        const taskQuery = queryFor({ data: [taskRow('account-a', 'task-own')], error: null });
        from.mockImplementation((table: string) => {
            if (table === 'vessel_crew') return crewQuery;
            if (table === 'vessel_identity') return ownerQuery;
            if (table === 'maintenance_tasks') return taskQuery;
            throw new Error(`Unexpected table: ${table}`);
        });

        const tasks = await MaintenanceService.getTasks();

        expect(tasks.map((task) => task.id)).toEqual(['task-own']);
        expect(taskQuery.eq).toHaveBeenCalledWith('user_id', 'account-a');
    });
});
