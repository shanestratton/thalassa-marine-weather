/**
 * Shared binders in the Boat Binder pages (2026-10-02). A crew member's
 * binders show the skipper's rows under one plain line, with no delete, and
 * a view-only Ship's Stores with no add or edit at all.
 * No real accounts: 'skipper-1', 'crew-1', 'Test Boat'.
 */
import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import type { InventoryItem, MaintenanceTask } from '../types';

const sync = vi.hoisted(() => ({
    completeListeners: [] as ((result: { pushed: number; pulled: number; errors: string[] }) => void)[],
    pending: vi.fn(() => false),
}));

vi.mock('../services/vessel/SyncService', () => ({
    onSyncComplete: (listener: (typeof sync.completeListeners)[number]) => {
        sync.completeListeners.push(listener);
        return () => {
            sync.completeListeners = sync.completeListeners.filter((candidate) => candidate !== listener);
        };
    },
    onStatusChange: () => () => undefined,
    isFullReconciliationPending: sync.pending,
}));

const inventory = vi.hoisted(() => ({
    rows: [] as InventoryItem[],
    getAll: vi.fn(),
}));
const maintenance = vi.hoisted(() => ({
    rows: [] as MaintenanceTask[],
    getTasks: vi.fn(),
    seedDefaults: vi.fn(),
}));

vi.mock('../services/vessel/LocalInventoryService', () => ({
    LocalInventoryService: {
        getAll: inventory.getAll,
        getStats: () => ({ totalItems: inventory.rows.length, totalQuantity: 2, lowStock: 0 }),
        deduplicateByName: vi.fn().mockResolvedValue(0),
        adjustQuantity: vi.fn(),
        update: vi.fn(),
        delete: vi.fn(),
    },
}));
vi.mock('../services/vessel/LocalMaintenanceService', () => ({
    LocalMaintenanceService: {
        getTasks: maintenance.getTasks,
        // R&M loads paused tasks too (126-B7a): the same load.
        getAllTasks: maintenance.getTasks,
        seedDefaults: maintenance.seedDefaults,
        getHistory: vi.fn().mockReturnValue([]),
        logService: vi.fn(),
        createTask: vi.fn(),
        updateTask: vi.fn(),
        deleteTask: vi.fn(),
    },
}));
vi.mock('../services/vessel/LocalDatabase', () => ({
    initLocalDatabase: vi.fn().mockResolvedValue(undefined),
    // R&M seeds only after the account's first full pull on this device.
    getSyncMeta: () => ({ lastFullPullTimestamp: '2026-10-02T00:00:00.000Z' }),
}));
vi.mock('../services/MaintenancePdfService', () => ({
    exportChecklist: vi.fn(),
    exportServiceHistory: vi.fn(),
}));
vi.mock('../hooks/useRealtimeSync', () => ({ useRealtimeSync: vi.fn(), useRealtimeSyncMulti: vi.fn() }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: { settings: { vessel: { name: string } } }) => unknown) =>
        selector({ settings: { vessel: { name: 'Own Boat' } } }),
}));
vi.mock('../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { InventoryList } from '../components/vessel/InventoryList';
import { MaintenanceHub } from '../components/vessel/MaintenanceHub';
import { SharedBinderLine, sharedBinderCopy } from '../components/vessel/SharedBinderLine';
import { getBinderSource, reloadSharedBindersFromStorage } from '../services/vessel/sharedBinders';

const SNAPSHOT_KEY = 'thalassa_shared_binders_v1::user%3Acrew-1';
const access = (read: boolean, write = read) => ({ read, write });

function skipper(ownerId: string, vesselName: string | null, stores = access(true), lastAcceptedAt = '2026-10-01') {
    return {
        ownerId,
        vesselName,
        lastAcceptedAt: `${lastAcceptedAt}T00:00:00.000Z`,
        registers: { stores, equipment: access(true), maintenance: access(true), documents: access(false) },
    };
}

function snapshot(skippers: ReturnType<typeof skipper>[]) {
    act(() => {
        localStorage.setItem(
            SNAPSHOT_KEY,
            JSON.stringify({ version: 1, userId: 'crew-1', confirmedAt: '2026-10-02T00:00:00.000Z', skippers }),
        );
        reloadSharedBindersFromStorage();
    });
}

function storesRow(id: string, owner: string): InventoryItem {
    return {
        id,
        user_id: owner,
        barcode: null,
        item_name: 'Rice',
        description: null,
        category: 'Provisions',
        quantity: 2,
        min_quantity: 0,
        unit: 'kg',
        location_zone: 'Galley',
        location_specific: null,
        expiry_date: null,
        created_at: '2026-09-01T00:00:00.000Z',
        updated_at: '2026-09-01T00:00:00.000Z',
    } as InventoryItem;
}

function taskRow(id: string, owner: string): MaintenanceTask {
    return {
        id,
        user_id: owner,
        title: 'Oil change',
        description: null,
        category: 'Engine',
        trigger_type: 'monthly',
        interval_value: 30,
        next_due_date: '2026-11-01',
        next_due_hours: null,
        last_completed: null,
        is_active: true,
        created_at: '2026-09-05T00:00:00.000Z',
        updated_at: '2026-09-05T00:00:00.000Z',
    };
}

beforeEach(() => {
    localStorage.clear();
    sync.completeListeners = [];
    sync.pending.mockReset().mockReturnValue(false);
    inventory.rows = [];
    inventory.getAll.mockReset().mockImplementation(() => inventory.rows);
    maintenance.rows = [];
    maintenance.getTasks.mockReset().mockImplementation(async () => maintenance.rows);
    maintenance.seedDefaults.mockReset().mockResolvedValue(40);
    setAuthIdentityScope(null);
    setAuthIdentityScope('crew-1');
    reloadSharedBindersFromStorage();
});
afterEach(() => {
    setAuthIdentityScope(null);
    localStorage.clear();
});

describe('the shared binder line (A2)', () => {
    it("names the skipper's boat, falls back without a name, and says view only", () => {
        expect(
            sharedBinderCopy({
                mode: 'shared',
                ownerId: 'skipper-1',
                vesselName: 'Test Boat',
                canWrite: true,
                canDelete: false,
                skipperCount: 1,
            }),
        ).toBe("Shared from Test Boat — you're crew");
        expect(
            sharedBinderCopy({
                mode: 'shared',
                ownerId: 'skipper-1',
                vesselName: null,
                canWrite: false,
                canDelete: false,
                skipperCount: 1,
            }),
        ).toBe("Shared from your skipper's boat — you're crew · view only");
        expect(sharedBinderCopy({ mode: 'own' })).toBeNull();
    });

    it("shows nothing on the owner's own binder", () => {
        const { container } = render(<SharedBinderLine register="stores" source={{ mode: 'own' }} />);
        expect(container).toBeEmptyDOMElement();
    });

    it('Switch boat lists the boats by name and switches the binder (A9)', () => {
        snapshot([skipper('skipper-1', 'Test Boat'), skipper('skipper-2', 'Other Boat', access(true), '2026-10-02')]);
        const source = getBinderSource('stores');
        expect(source).toMatchObject({ ownerId: 'skipper-2', skipperCount: 2 });
        render(<SharedBinderLine register="stores" source={source} />);

        fireEvent.click(screen.getByRole('button', { name: 'Switch boat' }));
        expect(screen.getByRole('button', { name: 'Other Boat' })).toHaveAttribute('aria-pressed', 'true');
        fireEvent.click(screen.getByRole('button', { name: 'Test Boat' }));

        expect(getBinderSource('stores')).toMatchObject({ ownerId: 'skipper-1' });
        expect(screen.queryByRole('button', { name: 'Test Boat' })).not.toBeInTheDocument();
    });

    it('offers no Switch boat with one skipper', () => {
        snapshot([skipper('skipper-1', 'Test Boat')]);
        render(<SharedBinderLine register="stores" source={getBinderSource('stores')} />);
        expect(screen.queryByRole('button', { name: 'Switch boat' })).not.toBeInTheDocument();
    });
});

describe("Ship's Stores shared from a skipper", () => {
    it('view only: the line says so, and there is no Add, Edit, quantity or delete (A2/A4)', async () => {
        snapshot([skipper('skipper-1', 'Test Boat', access(true, false))]);
        inventory.rows = [storesRow('s-rice', 'skipper-1')];
        render(<InventoryList onBack={vi.fn()} />);

        await screen.findByText('Rice');
        expect(screen.getByText("Shared from Test Boat — you're crew · view only")).toBeInTheDocument();
        expect(screen.queryByText('Add item')).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Edit Rice' })).not.toBeInTheDocument();
        fireEvent.click(screen.getByText('Rice'));
        expect(screen.queryByRole('button', { name: 'Increase quantity' })).not.toBeInTheDocument();
        expect(screen.queryByRole('button', { name: 'Decrease quantity' })).not.toBeInTheDocument();
        expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    });

    it('with edit: Add, Edit and quantity stay, but never delete (A5)', async () => {
        snapshot([skipper('skipper-1', 'Test Boat', access(true, true))]);
        inventory.rows = [storesRow('s-rice', 'skipper-1')];
        render(<InventoryList onBack={vi.fn()} />);

        await screen.findByText('Rice');
        expect(screen.getByText("Shared from Test Boat — you're crew")).toBeInTheDocument();
        expect(screen.getByText('Add item')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: 'Edit Rice' })).toBeInTheDocument();
        expect(screen.queryByText('Delete')).not.toBeInTheDocument();
    });

    it("the owner's own stores show no line and keep swipe-to-delete (A2/A10)", async () => {
        inventory.rows = [storesRow('c-rice', 'crew-1')];
        render(<InventoryList onBack={vi.fn()} />);

        await screen.findByText('Rice');
        expect(screen.queryByTestId('shared-binder-line')).not.toBeInTheDocument();
        expect(screen.getByText('Delete')).toBeInTheDocument();
    });

    it("says it is bringing the skipper's binder in while a full pull is pending, then lists it (A6)", async () => {
        snapshot([skipper('skipper-1', 'Test Boat')]);
        sync.pending.mockReturnValue(true);
        render(<InventoryList onBack={vi.fn()} />);

        expect(await screen.findByText("Bringing in Test Boat's binder…")).toBeInTheDocument();

        // The pull lands; the open page reloads without being remounted.
        inventory.rows = [storesRow('s-rice', 'skipper-1')];
        sync.pending.mockReturnValue(false);
        act(() => sync.completeListeners.forEach((listener) => listener({ pushed: 0, pulled: 1, errors: [] })));
        expect(await screen.findByText('Rice')).toBeInTheDocument();
        expect(screen.queryByText("Bringing in Test Boat's binder…")).not.toBeInTheDocument();
    });

    it('reloads when the binder changes hands, and the line goes when the share ends (A7)', async () => {
        snapshot([skipper('skipper-1', 'Test Boat')]);
        render(<InventoryList onBack={vi.fn()} />);
        await screen.findByText("Shared from Test Boat — you're crew");
        const loadsBefore = inventory.getAll.mock.calls.length;

        act(() => {
            localStorage.removeItem(SNAPSHOT_KEY);
            reloadSharedBindersFromStorage();
        });

        await waitFor(() => expect(inventory.getAll.mock.calls.length).toBeGreaterThan(loadsBefore));
        expect(screen.queryByTestId('shared-binder-line')).not.toBeInTheDocument();
    });
});

describe('R&M shared from a skipper', () => {
    it('lists the tasks with no delete, and never seeds defaults into it (A5/A12)', async () => {
        snapshot([skipper('skipper-1', 'Test Boat')]);
        maintenance.rows = [taskRow('s-oil', 'skipper-1')];
        render(<MaintenanceHub onBack={vi.fn()} />);

        await screen.findByText('Oil change');
        expect(screen.getByText("Shared from Test Boat — you're crew")).toBeInTheDocument();
        expect(screen.queryByText('Delete')).not.toBeInTheDocument();
        expect(screen.getByText('Add task')).toBeInTheDocument();
        expect(maintenance.seedDefaults).not.toHaveBeenCalled();
    });

    it('an empty shared R&M does not seed, and says it is bringing the binder in (A12)', async () => {
        snapshot([skipper('skipper-1', null)]);
        sync.pending.mockReturnValue(true);
        render(<MaintenanceHub onBack={vi.fn()} />);

        expect(await screen.findByText("Bringing in your skipper's binder…")).toBeInTheDocument();
        expect(maintenance.seedDefaults).not.toHaveBeenCalled();
        expect(localStorage.getItem('thalassa_maintenance_seeded::user%3Acrew-1')).toBeNull();
    });

    it('an unconfirmed account does not seed or mark itself seeded; once confirmed it seeds as today (A12)', async () => {
        render(<MaintenanceHub onBack={vi.fn()} />);
        await waitFor(() => expect(maintenance.getTasks).toHaveBeenCalled());
        expect(maintenance.seedDefaults).not.toHaveBeenCalled();
        expect(localStorage.getItem('thalassa_maintenance_seeded::user%3Acrew-1')).toBeNull();

        // The first confirmed snapshot (no shares) reloads the page, which seeds.
        snapshot([]);
        await waitFor(() => expect(maintenance.seedDefaults).toHaveBeenCalledTimes(1));
        await waitFor(() => expect(localStorage.getItem('thalassa_maintenance_seeded::user%3Acrew-1')).toBe('1'));
    });
});
