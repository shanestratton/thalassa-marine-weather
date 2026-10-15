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
// The phone's binder opens before any count reads it (131-B12, BH-5).
const initLocalDatabase = vi.hoisted(() => vi.fn(async (_userId: string | null) => undefined));
const readDocs = vi.hoisted(() => vi.fn());

// A plain factory: the three counts import it at once, and an async one
// (importOriginal) handed the first two the real module. The engine-hours
// reading finds no open table, as before, and falls back to this device's.
vi.mock('../services/vessel/LocalDatabase', () => {
    const shut = () => {
        throw new Error('[LocalDB] Not initialized. Call initLocalDatabase() first.');
    };
    return { initLocalDatabase, getLocalDatabaseSession: shut, getSyncMeta: shut, getById: shut, query: shut };
});
vi.mock('../services/vessel/LocalMaintenanceService', () => ({
    LocalMaintenanceService: { getTasks: () => maintTasks },
}));
// The real calculateStatus: the badge counts what R&M shows red.
vi.mock('../services/MaintenanceService', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../services/MaintenanceService')>()),
    MaintenanceService: { getTasks: () => cloudGetTasks() },
}));
vi.mock('../services/vessel/LocalDocumentService', () => ({
    LocalDocumentService: { getAll: () => readDocs() },
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
        initLocalDatabase.mockReset();
        initLocalDatabase.mockImplementation(async () => undefined);
        readDocs.mockReset();
        readDocs.mockImplementation(() => docs);
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
            expiredDocsCount: 0,
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

    it('a never-serviced engine task still on its from-zero seed (100) is not overdue at 3,512 hours', async () => {
        // Seeded at an absolute 100 before 126-B1; the first real reading on an
        // older engine lit the badge "Overdue by 3412 hrs" (audit MAINT-03).
        maintTasks = [
            {
                id: 'h-seeded',
                is_active: true,
                next_due_date: null,
                updated_at: PAST,
                trigger_type: 'engine_hours',
                interval_value: 100,
                next_due_hours: 100,
            },
        ];
        cloudTasks = [...maintTasks];
        const key = authScopedStorageKey('thalassa_engine_hours', getAuthIdentityScope());
        localStorage.setItem(key, '3512');
        try {
            const { result } = renderHook(() => useVesselReadinessCounts());
            await waitFor(() => expect(cloudGetTasks).toHaveBeenCalled());
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(result.current.overdueCount).toBe(0);

            // A new engine at 150 hours is honestly 50 past its first service.
            localStorage.setItem(key, '150');
            act(() => dispatchDataChange(DATA_EVENTS.MAINTENANCE));
            await waitFor(() => expect(result.current.overdueCount).toBe(1));

            // And still at 201, more overdue: the badge never clears as it gets worse.
            localStorage.setItem(key, '201');
            const fetchesBefore = cloudGetTasks.mock.calls.length;
            act(() => dispatchDataChange(DATA_EVENTS.MAINTENANCE));
            await waitFor(() => expect(cloudGetTasks.mock.calls.length).toBeGreaterThan(fetchesBefore));
            await new Promise((resolve) => setTimeout(resolve, 20));
            expect(result.current.overdueCount).toBe(1);
        } finally {
            localStorage.removeItem(key);
        }
    });

    // ── 131-B12: the badges count only what is really due (binder audit
    // BH-1, EQ-3, BH-2, BH-3, BH-5) ──

    it('splits papers into expired and expiring, and counts only warranties ending in the next 30 days', async () => {
        const inDays = (days: number) => new Date(Date.now() + days * 86_400_000).toISOString();
        docs = [
            { id: 'd-lapsed', expiry_date: '2019-03-01' }, // years ago: still expired
            { id: 'd-soon', expiry_date: inDays(5) },
            { id: 'd-later', expiry_date: inDays(60) },
            { id: 'd-none', expiry_date: null },
        ];
        equip = [
            { id: 'e-2019', warranty_expiry: '2019-03-01' }, // ended years ago: no news
            { id: 'e-soon', warranty_expiry: inDays(5) },
            { id: 'e-later', warranty_expiry: inDays(45) },
            { id: 'e-none', warranty_expiry: null },
        ];
        const { result } = renderHook(() => useVesselReadinessCounts());
        await waitFor(() => {
            expect(result.current.expiredDocsCount).toBe(1);
            expect(result.current.expiringDocsCount).toBe(1);
            expect(result.current.expiringEquipCount).toBe(1);
        });
    });

    it('counts on the local day, as the cards do: a paper and a warranty on their last day are still in date', async () => {
        const was = process.env.TZ;
        process.env.TZ = 'America/Los_Angeles';
        vi.useFakeTimers({ toFake: ['Date'] });
        try {
            // 23:30 on 15 October, already the 16th in UTC.
            vi.setSystemTime(new Date(2026, 9, 15, 23, 30));
            docs = [
                { id: 'd-bare', expiry_date: '2026-10-15' },
                { id: 'd-synced', expiry_date: '2026-10-15T00:00:00+00:00' },
            ];
            equip = [{ id: 'e-synced', warranty_expiry: '2026-10-15T00:00:00+00:00' }];
            const { result } = renderHook(() => useVesselReadinessCounts());
            await waitFor(() => expect(result.current.expiringDocsCount).toBe(2));
            expect(result.current.expiredDocsCount).toBe(0);
            await waitFor(() => expect(result.current.expiringEquipCount).toBe(1));

            // Next morning both papers have expired, and the warranty is over.
            vi.setSystemTime(new Date(2026, 9, 16, 7, 0));
            act(() => {
                dispatchDataChange(DATA_EVENTS.DOCUMENTS);
                dispatchDataChange(DATA_EVENTS.EQUIPMENT);
            });
            await waitFor(() => {
                expect(result.current.expiredDocsCount).toBe(2);
                expect(result.current.expiringDocsCount).toBe(0);
                expect(result.current.expiringEquipCount).toBe(0);
            });
        } finally {
            vi.useRealTimers();
            if (was === undefined) delete process.env.TZ;
            else process.env.TZ = was;
        }
    });

    it('shows the overdue count from the phone straight away, and refines it when the cloud answers', async () => {
        let answer!: (tasks: typeof cloudTasks) => void;
        cloudGetTasks.mockImplementation(
            () =>
                new Promise((resolve) => {
                    answer = resolve;
                }),
        );
        const { result } = renderHook(() => useVesselReadinessCounts());
        // The cloud has not answered: the phone's own overdue task shows.
        await waitFor(() => expect(result.current.overdueCount).toBe(1));
        expect(cloudGetTasks).toHaveBeenCalledTimes(1);

        // It answers: the task was serviced on another device, after this phone's copy.
        await act(async () => answer([{ id: 't1', is_active: true, next_due_date: FUTURE, updated_at: FUTURE }]));
        await waitFor(() => expect(result.current.overdueCount).toBe(0));
    });

    it("keeps the phone's overdue count when the cloud can't be reached", async () => {
        cloudGetTasks.mockRejectedValue(new Error('offline'));
        const { result } = renderHook(() => useVesselReadinessCounts());
        await waitFor(() => expect(result.current.overdueCount).toBe(1));
        await waitFor(() => expect(cloudGetTasks).toHaveBeenCalled());
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(result.current.overdueCount).toBe(1);
    });

    it('waits for the binder on this phone to open before counting from it', async () => {
        let open!: () => void;
        const opened = new Promise<undefined>((resolve) => {
            open = () => resolve(undefined);
        });
        initLocalDatabase.mockImplementation(() => opened);
        cloudGetTasks.mockImplementation(() => new Promise(() => undefined)); // the cloud stays silent
        const { result } = renderHook(() => useVesselReadinessCounts());

        // Opened for this account, the file switch R&M and Stores join too.
        await waitFor(() => expect(initLocalDatabase).toHaveBeenCalledWith('readiness-a'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(readDocs).not.toHaveBeenCalled();
        expect(result.current.overdueCount).toBe(0);

        await act(async () => open());
        await waitFor(() => {
            expect(result.current.overdueCount).toBe(1);
            expect(result.current.expiringDocsCount).toBe(1);
            expect(result.current.expiringEquipCount).toBe(1);
        });
    });

    it("logs when the phone's binder can't be opened, and counts maintenance from the cloud alone", async () => {
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        initLocalDatabase.mockRejectedValue(new Error('[LocalDB] Failed to read'));
        maintTasks = []; // never read: the phone's binder is shut
        const { result } = renderHook(() => useVesselReadinessCounts());

        // The cloud still knows the overdue task.
        await waitFor(() => expect(result.current.overdueCount).toBe(1));
        await waitFor(() =>
            expect(warn).toHaveBeenCalledWith(
                '[VesselReadiness]',
                'Documents badge: the binder on this phone could not be opened',
                '[LocalDB] Failed to read',
            ),
        );
        expect(warn).toHaveBeenCalledWith(
            '[VesselReadiness]',
            'Equipment badge: the binder on this phone could not be opened',
            '[LocalDB] Failed to read',
        );
        expect(readDocs).not.toHaveBeenCalled();
        expect(result.current.expiringDocsCount).toBe(0);
        expect(result.current.expiringEquipCount).toBe(0);
    });

    it('never opens the binder again for an account that has signed out mid-count', async () => {
        const { result } = renderHook(() => useVesselReadinessCounts());
        await waitFor(() => {
            expect(result.current.overdueCount).toBe(1);
            expect(result.current.expiringDocsCount).toBe(1);
            expect(result.current.expiringEquipCount).toBe(1);
        });
        initLocalDatabase.mockClear();

        act(() => {
            // A signs out, and a change lands before the page has moved on:
            // A's listener still runs, and must not reopen A's binder.
            setAuthIdentityScope('readiness-b');
            dispatchDataChange(DATA_EVENTS.DOCUMENTS);
        });
        await waitFor(() => expect(initLocalDatabase).toHaveBeenCalledWith('readiness-b'));
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(initLocalDatabase).not.toHaveBeenCalledWith('readiness-a');
    });
});
