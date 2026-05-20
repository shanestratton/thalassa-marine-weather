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

// Mutable fixtures the mocked services read from — tests mutate these
// then fire the matching event to simulate a real mutation elsewhere.
const PAST = '2026-01-01T00:00:00.000Z';
const FUTURE = '2030-01-01T00:00:00.000Z';

let maintTasks: Array<{ id: string; is_active: boolean; next_due_date: string | null; updated_at: string }>;
let cloudTasks: typeof maintTasks;
let docs: Array<{ id: string; expiry_date: string | null }>;
let equip: Array<{ id: string; warranty_expiry: string | null }>;

vi.mock('../services/vessel/LocalMaintenanceService', () => ({
    LocalMaintenanceService: { getTasks: () => maintTasks },
}));
vi.mock('../services/MaintenanceService', () => ({
    MaintenanceService: { getTasks: async () => cloudTasks },
}));
vi.mock('../services/vessel/LocalDocumentService', () => ({
    LocalDocumentService: { getAll: () => docs },
}));
vi.mock('../services/vessel/LocalEquipmentService', () => ({
    LocalEquipmentService: { getAll: () => equip },
}));

import { useVesselReadinessCounts } from '../hooks/useVesselReadinessCounts';

describe('useVesselReadinessCounts', () => {
    beforeEach(() => {
        maintTasks = [{ id: 't1', is_active: true, next_due_date: PAST, updated_at: PAST }]; // overdue
        cloudTasks = [{ id: 't1', is_active: true, next_due_date: PAST, updated_at: PAST }];
        docs = [{ id: 'd1', expiry_date: new Date(Date.now() + 5 * 86_400_000).toISOString() }]; // within 30d
        equip = [{ id: 'e1', warranty_expiry: new Date(Date.now() + 5 * 86_400_000).toISOString() }];
    });

    afterEach(() => {
        vi.restoreAllMocks();
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
});
