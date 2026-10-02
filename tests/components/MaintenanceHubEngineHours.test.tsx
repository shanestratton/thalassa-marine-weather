/**
 * R&M shows and logs against the SHARED engine-hours reading (Shane,
 * 2026-10-02: "the engine hours are not going across to the invitee"). Crew
 * on a skipper's shared R&M see his figure, log services against it and,
 * where they may edit R&M, change it; a view-only share shows it with a quiet
 * note. Before the table is live on a device, the page works as it always did.
 * No real accounts: 'skipper-1', 'crew-1', 'Test Boat'.
 */
import React from 'react';
import { webcrypto } from 'node:crypto';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { authScopedStorageKey, setAuthIdentityScope } from '../../services/authIdentityScope';
import type { MaintenanceTask } from '../../types';

const db = vi.hoisted(() => {
    const tables = new Map<string, Map<string, Record<string, unknown>>>();
    const table = (name: string) => {
        if (!tables.has(name)) tables.set(name, new Map());
        return tables.get(name)!;
    };
    return { tables, table, meta: {} as Record<string, unknown>, identity: null as string | null };
});

const mocks = vi.hoisted(() => ({
    tasks: [] as MaintenanceTask[],
    logService: vi.fn(),
    updateLocal: vi.fn(),
    insertLocal: vi.fn(),
    syncListeners: [] as ((result: { pushed: number; pulled: number; errors: string[] }) => void)[],
    realtime: [] as { table: string; onSync: () => void; enabled: boolean }[],
}));

vi.mock('../../services/vessel/LocalDatabase', () => ({
    initLocalDatabase: vi.fn().mockResolvedValue(undefined),
    getLocalDatabaseSession: () => ({ identity: db.identity, generation: 1 }),
    getSyncMeta: () => ({ lastFullPullTimestamp: '2026-10-02T00:00:00.000Z', ...db.meta }),
    getById: (name: string, id: string) => db.table(name).get(id) ?? null,
    query: (name: string, predicate: (row: Record<string, unknown>) => boolean) =>
        [...db.table(name).values()].filter(predicate),
    insertLocal: mocks.insertLocal,
    updateLocal: mocks.updateLocal,
}));
vi.mock('../../services/vessel/LocalMaintenanceService', () => ({
    LocalMaintenanceService: {
        getTasks: vi.fn(async () => mocks.tasks),
        seedDefaults: vi.fn().mockResolvedValue(0),
        getHistory: vi.fn().mockResolvedValue([]),
        logService: mocks.logService,
        createTask: vi.fn(),
        updateTask: vi.fn(),
        deleteTask: vi.fn(),
    },
}));
vi.mock('../../services/vessel/SyncService', () => ({
    onSyncComplete: (listener: (typeof mocks.syncListeners)[number]) => {
        mocks.syncListeners.push(listener);
        return () => {
            mocks.syncListeners = mocks.syncListeners.filter((candidate) => candidate !== listener);
        };
    },
    onStatusChange: () => () => undefined,
    isFullReconciliationPending: () => false,
}));
// One call per channel: the page opens one for tasks and history, and one
// for the engine-hours reading.
vi.mock('../../hooks/useRealtimeSync', () => ({
    useRealtimeSync: vi.fn(),
    useRealtimeSyncMulti: (tables: string[], onSync: () => void, enabled = true) => {
        for (const table of tables) mocks.realtime.push({ table, onSync, enabled });
    },
}));
vi.mock('../../services/MaintenancePdfService', () => ({ exportChecklist: vi.fn(), exportServiceHistory: vi.fn() }));
vi.mock('../../stores/settingsStore', () => ({
    useSettingsStore: (selector: (state: { settings: { vessel: { name: string } } }) => unknown) =>
        selector({ settings: { vessel: { name: 'Own Boat' } } }),
}));
vi.mock('../../utils/system', async (importOriginal) => ({
    ...(await importOriginal<typeof import('../../utils/system')>()),
    triggerHaptic: vi.fn(),
}));
vi.mock('../../components/Toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import { MaintenanceHub } from '../../components/vessel/MaintenanceHub';
import { reloadSharedBindersFromStorage } from '../../services/vessel/sharedBinders';
import { ENGINE_HOURS_TABLE, engineHoursRowId } from '../../services/vessel/LocalEngineHoursService';

const LIVE = { optionalTablesReadAt: { [ENGINE_HOURS_TABLE]: '2026-10-02T09:00:00.000Z' } };

const engineService: MaintenanceTask = {
    id: 'task-hours',
    user_id: 'skipper-1',
    title: 'Service Engine (Oil / Filters / Zincs)',
    description: null,
    category: 'Engine',
    trigger_type: 'engine_hours',
    interval_value: 100,
    next_due_date: null,
    next_due_hours: 1300,
    last_completed: null,
    is_active: true,
    created_at: '2026-09-01T00:00:00.000Z',
    updated_at: '2026-09-01T00:00:00.000Z',
};

function signIn(userId: string) {
    const scope = setAuthIdentityScope(userId);
    db.identity = userId;
    return scope;
}

function crewOnSkipper(write: boolean) {
    act(() => {
        localStorage.setItem(
            'thalassa_shared_binders_v1::user%3Acrew-1',
            JSON.stringify({
                version: 1,
                userId: 'crew-1',
                confirmedAt: '2026-10-02T00:00:00.000Z',
                skippers: [
                    {
                        ownerId: 'skipper-1',
                        vesselName: 'Test Boat',
                        lastAcceptedAt: '2026-10-01T00:00:00.000Z',
                        registers: {
                            stores: { read: false, write: false },
                            equipment: { read: false, write: false },
                            maintenance: { read: true, write },
                            documents: { read: false, write: false },
                        },
                    },
                ],
            }),
        );
        reloadSharedBindersFromStorage();
    });
}

async function skipperReading(hours: number): Promise<string> {
    const id = await engineHoursRowId('skipper-1');
    db.table(ENGINE_HOURS_TABLE).set(id, {
        id,
        user_id: 'skipper-1',
        hours,
        created_at: '2026-10-02T08:00:00.000Z',
        updated_at: '2026-10-02T08:00:00.000Z',
    });
    return id;
}

const engineHoursChannel = () => mocks.realtime.filter((call) => call.table === ENGINE_HOURS_TABLE).at(-1);

beforeEach(() => {
    if (!globalThis.crypto?.subtle) vi.stubGlobal('crypto', webcrypto);
    localStorage.clear();
    db.tables.clear();
    db.meta = {};
    db.identity = null;
    mocks.tasks = [engineService];
    mocks.syncListeners = [];
    mocks.realtime = [];
    mocks.logService.mockReset().mockResolvedValue({ historyId: 'h-1', nextDueDate: null, nextDueHours: 1350 });
    mocks.updateLocal.mockReset().mockImplementation(async (name: string, id: string, updates: object) => {
        const next = { ...db.table(name).get(id), ...updates };
        db.table(name).set(id, next);
        return next;
    });
    mocks.insertLocal.mockReset().mockImplementation(async (name: string, record: { id: string }) => {
        db.table(name).set(record.id, record);
        return record;
    });
    setAuthIdentityScope(null);
});

afterEach(() => {
    setAuthIdentityScope(null);
    vi.unstubAllGlobals();
});

describe('crew on the skipper’s shared R&M, once the table is live', () => {
    it('shows HIS figure, not the crew member’s own, and logs the service against it', async () => {
        const crew = signIn('crew-1');
        db.meta = LIVE;
        crewOnSkipper(true);
        localStorage.setItem(authScopedStorageKey('thalassa_engine_hours', crew), '7');
        await skipperReading(1250);

        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText(engineService.title);
        expect(await screen.findByRole('button', { name: 'Edit engine hours, currently 1,250' })).toBeInTheDocument();
        expect(screen.queryByText('7')).not.toBeInTheDocument();

        fireEvent.click(screen.getByRole('button', { name: `Options for ${engineService.title}` }));
        expect(screen.getByText('1,250 hrs')).toBeInTheDocument();
        fireEvent.click(screen.getByRole('button', { name: 'Log service' }));
        await waitFor(() => expect(mocks.logService).toHaveBeenCalledWith('task-hours', 1250, null, null));
        // The page listens for changes to the reading.
        expect(engineHoursChannel()?.enabled).toBe(true);
    });

    it('a crew member who may edit R&M changes the skipper’s reading', async () => {
        signIn('crew-1');
        db.meta = LIVE;
        crewOnSkipper(true);
        const id = await skipperReading(1250);

        render(<MaintenanceHub onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Edit engine hours, currently 1,250' }));
        const field = screen.getByRole('textbox', { name: 'Current engine hours' });
        fireEvent.change(field, { target: { value: '1,300' } });
        fireEvent.keyDown(field, { key: 'Enter' });
        fireEvent.blur(field);

        await waitFor(() => expect(mocks.updateLocal).toHaveBeenCalledWith(ENGINE_HOURS_TABLE, id, { hours: 1300 }));
        expect(mocks.updateLocal).toHaveBeenCalledTimes(1);
        expect(await screen.findByRole('button', { name: 'Edit engine hours, currently 1,300' })).toBeInTheDocument();
    });

    it('a view-only share shows the figure with a quiet note and nothing to edit', async () => {
        signIn('crew-1');
        db.meta = LIVE;
        crewOnSkipper(false);
        await skipperReading(1250);

        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByText(engineService.title);
        const card = await screen.findByTestId('engine-hours-view-only');
        expect(card).toHaveTextContent('Engine hours · 1,250');
        expect(card).toHaveTextContent("Skipper's · view only");
        expect(screen.queryByRole('button', { name: /engine hours/i })).not.toBeInTheDocument();
    });

    it('a change from another device shows on a realtime event', async () => {
        signIn('crew-1');
        db.meta = LIVE;
        crewOnSkipper(true);
        await skipperReading(1250);

        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByRole('button', { name: 'Edit engine hours, currently 1,250' });

        await skipperReading(1262);
        act(() => engineHoursChannel()?.onSync());
        expect(await screen.findByRole('button', { name: 'Edit engine hours, currently 1,262' })).toBeInTheDocument();
    });
});

describe('before the table is live on this device', () => {
    it('keeps the device figure, saves to the device, and opens no channel for the table', async () => {
        const skipper = signIn('skipper-1');
        localStorage.setItem(authScopedStorageKey('thalassa_engine_hours', skipper), '1180');

        render(<MaintenanceHub onBack={vi.fn()} />);
        fireEvent.click(await screen.findByRole('button', { name: 'Edit engine hours, currently 1,180' }));
        expect(engineHoursChannel()?.enabled).toBe(false);
        const field = screen.getByRole('textbox', { name: 'Current engine hours' });
        fireEvent.change(field, { target: { value: '1200' } });
        fireEvent.keyDown(field, { key: 'Enter' });

        await screen.findByRole('button', { name: 'Edit engine hours, currently 1,200' });
        expect(localStorage.getItem(authScopedStorageKey('thalassa_engine_hours', skipper))).toBe('1200');
        expect(mocks.insertLocal).not.toHaveBeenCalled();
        expect(mocks.updateLocal).not.toHaveBeenCalled();
    });

    it('switches to the shared reading after the sync cycle that first finds the table', async () => {
        const skipper = signIn('skipper-1');
        localStorage.setItem(authScopedStorageKey('thalassa_engine_hours', skipper), '1180');
        render(<MaintenanceHub onBack={vi.fn()} />);
        await screen.findByRole('button', { name: 'Edit engine hours, currently 1,180' });

        // The cycle that first reads the table may pull nothing at all.
        db.meta = LIVE;
        await skipperReading(1250);
        act(() => mocks.syncListeners.forEach((listener) => listener({ pushed: 0, pulled: 0, errors: [] })));

        expect(await screen.findByRole('button', { name: 'Edit engine hours, currently 1,250' })).toBeInTheDocument();
        await waitFor(() => expect(engineHoursChannel()?.enabled).toBe(true));
    });
});
