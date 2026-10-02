/**
 * Integration test for useVesselReadinessCounts — the Boat Binder badge
 * counts (maintenance overdue / docs expiring / equipment warranty).
 *
 * This is the component-level proof for the propagation path behind the
 * "1 Overdue still showing after I ticked it off" bug: it renders the
 * REAL hook (real effect, real listeners, real merge), mutates the
 * mocked services, fires the data-change event, and asserts the count
 * actually updates. No reimplementation of the logic — the wiring
 * itself is under test.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import { DATA_EVENTS, dispatchDataChange } from '../utils/dataChangeEvents';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

// Mutable fixtures the mocked services read from — tests mutate these
// then fire the matching event to simulate a real mutation elsewhere.
const PAST = '2026-01-01T00:00:00.000Z';
const FUTURE = '2030-01-01T00:00:00.000Z';

let maintTasks: Array<{
    id: string;
    is_active: boolean;
    next_due_date: string | null;
    updated_at: string;
    trigger_type?: 'daily' | 'engine_hours';
    interval_value?: number | null;
    next_due_hours?: number | null;
}>;
let cloudTasks: typeof maintTasks;
let docs: Array<{ id: string; expiry_date: string | null }>;
let equip: Array<{ id: string; warranty_expiry: string | null }>;
const cloudGetTasks = vi.fn();

vi.mock('../services/vessel/LocalMaintenanceService', () => ({
    LocalMaintenanceService: { getTasks: () => maintTasks },
}));
// The real calculateStatus: the badge counts what R&M shows red.
vi.mock('../services/MaintenanceService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/MaintenanceService')>()),
    MaintenanceService: { getTasks: () => cloudGetTasks() },
}));
vi.mock('../services/vessel/LocalDocumentService', () => ({
    LocalDocumentService: { getAll: () => docs },
}));
vi.mock('../services/vessel/LocalEquipmentService', () => ({
    LocalEquipmentService: { getAll: () => equip },
}));

const syncListeners = vi.hoisted(
    () =>
        [] as ((result: {
            pushed: number;
            pulled: number;
            errors: string[];
            discardedShared?: number;
            pruned?: number;
        }) => void)[],
);
vi.mock('../services/vessel/SyncService', () => ({
    onSyncComplete: (listener: (typeof syncListeners)[number]) => {
        syncListeners.push(listener);
        return () => syncListeners.splice(syncListeners.indexOf(listener), 1);
    },
}));

import { useVesselReadinessCounts } from '../hooks/useVesselReadinessCounts';
import { reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';

describe('useVesselReadinessCounts', () => {
    beforeEach(() => {
        setAuthIdentityScope(null);
        setAuthIdentityScope('readiness-a');
        maintTasks = [{ id: 't1', is_active: true, next_due_date: PAST, updated_at: PAST }]; // overdue
        cloudTasks = [{ id: 't1', is_active: true, next_due_date: PAST, updated_at: PAST }];
        docs = [{ id: 'd1', expiry_date: new Date(Date.now() + 5 * 86_400_000).toISOString() }]; // within 30d
        equip = [{ id: 'e1', warranty_expiry: new Date(Date.now() + 5 * 86_400_000).toISOString() }];
        cloudGetTasks.mockReset();
        cloudGetTasks.mockImplementation(async () => cloudTasks);
    });

    afterEach(() => {
        vi.restoreAllMocks();
        setAuthIdentityScope(null);
    });

    it('computes the initial counts on mount', async () => {
        const { result } = renderHook(() => useVesselReadinessCounts());
        await waitFor(() => {
            expect(result.current.overdueCount).toBe(1);
            expect(result.current.expiringDocsCount).toBe(1);
            expect(result.current.expiringEquipCount).toBe(1);
        });
    });

    it('REGRESSION: ticking off the task locally clears the overdue badge on the next event', async () => {
        const { result } = renderHook(() => useVesselReadinessCounts());
        await waitFor(() => expect(result.current.overdueCount).toBe(1));

        // Simulate the user servicing the task: LOCAL store advances the
        // due date + bumps updated_at; CLOUD is still the stale overdue
        // row (hasn't synced up). The newest-wins merge must pick local.
        maintTasks = [{ id: 't1', is_active: true, next_due_date: FUTURE, updated_at: FUTURE }];
        // cloudTasks left stale on purpose.

        act(() => dispatchDataChange(DATA_EVENTS.MAINTENANCE));

        await waitFor(() => expect(result.current.overdueCount).toBe(0));
    });

    it('a documents-changed event refreshes only the docs count', async () => {
        const { result } = renderHook(() => useVesselReadinessCounts());
        await waitFor(() => expect(result.current.expiringDocsCount).toBe(1));

        docs = []; // doc deleted / expiry cleared elsewhere
        act(() => dispatchDataChange(DATA_EVENTS.DOCUMENTS));

        await waitFor(() => expect(result.current.expiringDocsCount).toBe(0));
        // Maintenance + equipment counts untouched by a docs event.
        expect(result.current.overdueCount).toBe(1);
        expect(result.current.expiringEquipCount).toBe(1);
    });

    it('an equipment-changed event refreshes the equipment count', async () => {
        const { result } = renderHook(() => useVesselReadinessCounts());
        await waitFor(() => expect(result.current.expiringEquipCount).toBe(1));

        equip = [
            { id: 'e1', warranty_expiry: new Date(Date.now() + 5 * 86_400_000).toISOString() },
            { id: 'e2', warranty_expiry: new Date(Date.now() + 10 * 86_400_000).toISOString() },
        ];
        act(() => dispatchDataChange(DATA_EVENTS.EQUIPMENT));

        await waitFor(() => expect(result.current.expiringEquipCount).toBe(2));
    });

    it('stops listening after unmount (no refetch on a late event)', async () => {
        const { result, unmount } = renderHook(() => useVesselReadinessCounts());
        await waitFor(() => expect(result.current.overdueCount).toBe(1));
        const last = result.current.overdueCount;
        unmount();
        // Mutate + fire after unmount — the count snapshot must not change.
        maintTasks = [];
        act(() => dispatchDataChange(DATA_EVENTS.MAINTENANCE));
        expect(result.current.overdueCount).toBe(last);
    });

    it('synchronously hides A badges and drops its deferred refresh after switching to B', async () => {
        const { result } = renderHook(() => useVesselReadinessCounts());
        await waitFor(() => expect(result.current.overdueCount).toBe(1));

        let resolveA!: (tasks: typeof cloudTasks) => void;
        cloudGetTasks.mockReturnValueOnce(
            new Promise((resolve) => {
                resolveA = resolve;
            }),
        );
        act(() => dispatchDataChange(DATA_EVENTS.MAINTENANCE));
        await waitFor(() => expect(cloudGetTasks).toHaveBeenCalledTimes(2));

        maintTasks = [];
        cloudTasks = [];
        docs = [];
        equip = [];
        act(() => {
            setAuthIdentityScope('readiness-b');
        });

        expect(result.current).toEqual({
            overdueCount: 0,
            expiringDocsCount: 0,
            expiringEquipCount: 0,
        });

        await act(async () => {
            resolveA([{ id: 'late-a', is_active: true, next_due_date: PAST, updated_at: PAST }]);
        });
        await waitFor(() => expect(result.current.overdueCount).toBe(0));
    });

    // ── Shared binders (2026-10-02): the badges count the binder on show ──

    it('refetches every count when the binders change hands', async () => {
        const { result } = renderHook(() => useVesselReadinessCounts());
        await waitFor(() => expect(result.current.overdueCount).toBe(1));

        // The skipper's binder takes over: none of its tasks are overdue.
        maintTasks = [{ id: 's1', is_active: true, next_due_date: FUTURE, updated_at: FUTURE }];
        cloudTasks = [...maintTasks];
        docs = [];
        equip = [];
        act(() => reloadSharedBindersFromStorage());

        await waitFor(() => {
            expect(result.current.overdueCount).toBe(0);
            expect(result.current.expiringDocsCount).toBe(0);
            expect(result.current.expiringEquipCount).toBe(0);
        });
    });

    it('refetches after a background sync pulls rows, and not after an empty one', async () => {
        const { result } = renderHook(() => useVesselReadinessCounts());
        await waitFor(() => expect(result.current.expiringDocsCount).toBe(1));
        await waitFor(() => expect(syncListeners.length).toBeGreaterThan(0));

        docs = [];
        act(() => syncListeners.forEach((listener) => listener({ pushed: 0, pulled: 0, errors: [] })));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(result.current.expiringDocsCount).toBe(1);

        act(() => syncListeners.forEach((listener) => listener({ pushed: 0, pulled: 3, errors: [] })));
        await waitFor(() => expect(result.current.expiringDocsCount).toBe(0));
    });

    it('refetches after a sync that only pruned rows: an overdue task deleted on another device', async () => {
        const { result } = renderHook(() => useVesselReadinessCounts());
        await waitFor(() => expect(result.current.overdueCount).toBe(1));
        await waitFor(() => expect(syncListeners.length).toBeGreaterThan(0));

        maintTasks = [];
        cloudTasks = [];
        act(() => syncListeners.forEach((listener) => listener({ pushed: 0, pulled: 0, pruned: 1, errors: [] })));
        await waitFor(() => expect(result.current.overdueCount).toBe(0));
    });

    // ── The badge counts exactly what R&M shows red (2026-10-02) ──

    it('counts by local calendar day, as R&M does: a daily task due earlier today is due, not overdue', async () => {
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(new Date(2026, 9, 2, 19, 34));
        try {
            const sevenAm = new Date(2026, 9, 2, 7, 0).toISOString();
            maintTasks = [
                {
                    id: 'd1',
                    is_active: true,
                    next_due_date: sevenAm,
                    updated_at: PAST,
                    trigger_type: 'daily',
                    interval_value: 1,
                },
            ];
            cloudTasks = [...maintTasks];
            const { result } = renderHook(() => useVesselReadinessCounts());
            await waitFor(() => expect(cloudGetTasks).toHaveBeenCalled());
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(result.current.overdueCount).toBe(0);

            const yesterday = new Date(2026, 9, 1, 7, 0).toISOString();
            maintTasks = [{ ...maintTasks[0], next_due_date: yesterday, updated_at: FUTURE }];
            act(() => dispatchDataChange(DATA_EVENTS.MAINTENANCE));
            await waitFor(() => expect(result.current.overdueCount).toBe(1));
        } finally {
            vi.useRealTimers();
        }
    });

    it('counts a task overdue by engine hours from the R&M reading, and judges it on its date with none', async () => {
        maintTasks = [
            {
                id: 'h1',
                is_active: true,
                next_due_date: null,
                updated_at: PAST,
                trigger_type: 'engine_hours',
                interval_value: 100,
                next_due_hours: 1200,
            },
        ];
        cloudTasks = [...maintTasks];
        const { result } = renderHook(() => useVesselReadinessCounts());
        await waitFor(() => expect(cloudGetTasks).toHaveBeenCalled());
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(result.current.overdueCount).toBe(0);

        localStorage.setItem(authScopedStorageKey('thalassa_engine_hours', getAuthIdentityScope()), '1250');
        act(() => dispatchDataChange(DATA_EVENTS.MAINTENANCE));
        await waitFor(() => expect(result.current.overdueCount).toBe(1));
        localStorage.removeItem(authScopedStorageKey('thalassa_engine_hours', getAuthIdentityScope()));
    });
});
