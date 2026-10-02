/**
 * SyncService keeps binders live across devices (2026-10-02): a local write
 * pushes within seconds instead of at the five-minute cycle, and the app
 * catches up (deletes included) when it returns to the foreground.
 * No real accounts: 'user-1'.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface QueueItem {
    id: string;
    table_name: string;
    record_id: string;
    mutation_type: 'INSERT' | 'UPDATE' | 'DELETE' | 'DELTA';
    payload: string;
    created_at: string;
    status: 'pending' | 'syncing' | 'failed';
    retry_count: number;
    owner_user_id: string | null;
}

const WATERMARK = '2026-10-02T02:00:00.000Z';

const h = vi.hoisted(() => {
    const state = {
        queue: [] as QueueItem[],
        meta: {} as Record<string, string | null>,
        upserts: [] as { table: string; row: Record<string, unknown> }[],
        /** table → every id the server shows this account */
        serverIds: new Map<string, string[]>(),
        watermarkGate: null as Promise<void> | null,
        outboxListener: null as ((table: string) => void) | null,
        appStateListener: null as ((state: { isActive: boolean }) => void) | null,
        /** table → full rows the incremental pull returns */
        serverRows: new Map<string, Record<string, unknown>[]>(),
        platform: 'web',
        /** table → this device's clean rows, as the mock prune judges them */
        localIds: new Map<string, string[]>(),
        /** the Authorization each id listing page carried */
        listingAuth: [] as (string | null)[],
        /** the lower bound of each full-row pull: table → since */
        pullSince: [] as { table: string; since: string }[],
    };
    return {
        state,
        rpc: vi.fn(),
        getUser: vi.fn(),
        getSession: vi.fn(),
        prunePulledTable: vi.fn(async (_table: string, _ids: Set<string>, _options?: unknown) => 0),
        mergePulledRecords: vi.fn(async (_table: string, rows: unknown[], _options?: unknown) => rows.length),
        idListings: [] as string[],
        haptic: vi.fn(),
        startBackgroundTask: vi.fn(async () => 7),
        stopBackgroundTask: vi.fn(async (_taskId: number) => undefined),
    };
});

vi.mock('../utils/system', () => ({ triggerHaptic: h.haptic }));

vi.mock('@capacitor/core', async (importOriginal) => {
    const actual = await importOriginal<typeof import('@capacitor/core')>();
    return {
        ...actual,
        Capacitor: new Proxy(actual.Capacitor, {
            get: (target, property, receiver) =>
                property === 'getPlatform'
                    ? () => h.state.platform
                    : property === 'isNativePlatform'
                      ? () => h.state.platform !== 'web'
                      : Reflect.get(target, property, receiver),
        }),
    };
});

vi.mock('@transistorsoft/capacitor-background-geolocation', () => ({
    default: { startBackgroundTask: h.startBackgroundTask, stopBackgroundTask: h.stopBackgroundTask },
}));

vi.mock('@capacitor/app', () => ({
    App: {
        addListener: vi.fn(async (_event: string, listener: (state: { isActive: boolean }) => void) => {
            h.state.appStateListener = listener;
            return { remove: vi.fn() };
        }),
    },
}));

vi.mock('../services/vessel/sharedBinders', () => ({
    refreshSharedBinders: vi.fn(async () => ({ changed: false, fresh: true })),
    binderWriteGranted: () => true,
    anySkipperGrantsWrite: () => false,
    TABLE_REGISTER: {
        inventory_items: 'stores',
        equipment_register: 'equipment',
        maintenance_tasks: 'maintenance',
        maintenance_history: 'maintenance',
        ship_documents: 'documents',
    },
}));

function builder(table: string) {
    let columns = '*';
    let after: string | null = null;
    let authorization: string | null = null;
    const api = {
        select: vi.fn((selected: string) => {
            columns = selected;
            return api;
        }),
        setHeader: vi.fn((name: string, value: string) => {
            if (name === 'Authorization') authorization = value;
            return api;
        }),
        gt: vi.fn((column: string, value: string) => {
            if (column === 'id') after = value;
            if (column === 'updated_at') h.state.pullSince.push({ table, since: value });
            return api;
        }),
        lte: vi.fn(() => api),
        order: vi.fn(() => api),
        or: vi.fn(() => api),
        eq: vi.fn(() => api),
        limit: vi.fn(async (count: number) => {
            if (columns === 'id') {
                h.idListings.push(table);
                h.state.listingAuth.push(authorization);
                const ids = (h.state.serverIds.get(table) ?? []).filter((id) => after === null || id > after);
                return { data: ids.slice(0, count).map((id) => ({ id })), error: null };
            }
            return { data: (h.state.serverRows.get(table) ?? []).slice(0, count), error: null };
        }),
        upsert: vi.fn(async (row: Record<string, unknown>) => {
            h.state.upserts.push({ table, row });
            return { data: null, error: null };
        }),
    };
    return api;
}

vi.mock('../services/supabase', () => ({
    supabase: {
        from: (table: string) => builder(table),
        rpc: h.rpc,
        auth: { getUser: h.getUser, getSession: h.getSession },
    },
}));

vi.mock('../services/vessel/LocalDatabase', () => ({
    getFullQueue: () => h.state.queue.map((item) => ({ ...item })),
    markSyncing: vi.fn(async (ids: string[]) => {
        h.state.queue = h.state.queue.map((item) => (ids.includes(item.id) ? { ...item, status: 'syncing' } : item));
    }),
    removeSynced: vi.fn(async (ids: string[]) => {
        h.state.queue = h.state.queue.filter((item) => !ids.includes(item.id));
    }),
    markFailed: vi.fn(async () => undefined),
    retryFailed: vi.fn(async () => undefined),
    getSyncMeta: () => ({ ...h.state.meta }),
    updateSyncMeta: vi.fn(async (updates: Record<string, string | null>) => {
        Object.assign(h.state.meta, updates);
    }),
    mergePulledRecords: h.mergePulledRecords,
    prunePulledTable: h.prunePulledTable,
    getLocalDatabaseSession: () => ({ identity: 'user-1', generation: 1 }),
    isLocalDatabaseSessionCurrent: () => true,
    getById: () => null,
    bulkDelete: vi.fn(async () => undefined),
    rewriteQueuedInsert: vi.fn(async () => null),
    onOutboxAppended: (listener: (table: string) => void) => {
        h.state.outboxListener = listener;
        return () => {
            if (h.state.outboxListener === listener) h.state.outboxListener = null;
        };
    },
}));

type SyncModule = typeof import('../services/vessel/SyncService');
let sync: SyncModule;
let completions: Record<string, unknown>[];

let queueCounter = 0;
/** A durable local write: the outbox grows, then LocalDatabase signals it. */
function localWrite(recordId: string, table = 'inventory_items'): void {
    queueCounter += 1;
    h.state.queue.push({
        id: `op-${queueCounter}`,
        table_name: table,
        record_id: recordId,
        mutation_type: 'INSERT',
        payload: JSON.stringify({ id: recordId, user_id: 'user-1', item_name: recordId }),
        created_at: '2026-10-02T01:00:00.000Z',
        status: 'pending',
        retry_count: 0,
        owner_user_id: 'user-1',
    });
    h.state.outboxListener?.(table);
}

const pushedIds = () => h.state.upserts.map((upsert) => upsert.row.id);
const cycles = () => h.rpc.mock.calls.filter(([name]) => name === 'get_sync_watermark').length;

function setOnline(online: boolean): void {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: online });
}

async function startEngine(): Promise<void> {
    sync.startSyncEngine();
    // The boot cycle (2 s after start) runs on an empty outbox.
    await vi.advanceTimersByTimeAsync(2000);
    expect(cycles()).toBe(1);
}

beforeEach(async () => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    setOnline(true);
    h.state.queue = [];
    // Incremental by default: a full pull ran recently.
    h.state.meta = {
        lastPullTimestamp: '2026-10-02T01:59:00.000Z',
        lastFullPullTimestamp: '2026-10-02T01:59:00.000Z',
        lastPushTimestamp: null,
        deviceId: 'test-device',
        ownerUserId: 'user-1',
    };
    h.state.upserts = [];
    h.state.serverIds.clear();
    h.state.watermarkGate = null;
    h.state.outboxListener = null;
    h.state.appStateListener = null;
    h.state.serverRows.clear();
    h.state.platform = 'web';
    h.state.localIds.clear();
    h.state.listingAuth = [];
    h.state.pullSince = [];
    h.idListings.length = 0;
    h.startBackgroundTask.mockReset().mockResolvedValue(7);
    h.stopBackgroundTask.mockReset().mockResolvedValue(undefined);
    h.prunePulledTable.mockReset().mockResolvedValue(0);
    h.rpc.mockReset().mockImplementation(async (name: string) => {
        if (name === 'get_sync_watermark') {
            if (h.state.watermarkGate) await h.state.watermarkGate;
            return { data: WATERMARK, error: null };
        }
        return { data: null, error: null };
    });
    h.getUser.mockReset().mockResolvedValue({ data: { user: { id: 'user-1' } }, error: null });
    h.getSession.mockReset().mockResolvedValue({
        data: { session: { access_token: 'token-user-1', user: { id: 'user-1' } } },
        error: null,
    });
    sync = await import('../services/vessel/SyncService');
    completions = [];
    sync.onSyncComplete((result) => completions.push(result as unknown as Record<string, unknown>));
});

afterEach(() => {
    sync.stopSyncEngine();
    vi.useRealTimers();
    setOnline(true);
});

describe('a local edit reaches the other device in seconds', () => {
    it('pushes a second after the edit, not at the five-minute cycle', async () => {
        await startEngine();

        localWrite('stores-1');
        await vi.advanceTimersByTimeAsync(900);
        expect(pushedIds()).toEqual([]);

        await vi.advanceTimersByTimeAsync(200);
        expect(pushedIds()).toEqual(['stores-1']);
        expect(h.state.queue).toEqual([]);
        expect(cycles()).toBe(2);
    });

    it('a burst of edits is one cycle, and a steady stream still goes out within four seconds', async () => {
        await startEngine();

        // A tap every half second for six seconds (a run of quantity taps).
        for (let tap = 0; tap < 12; tap += 1) {
            localWrite(`tap-${tap}`);
            await vi.advanceTimersByTimeAsync(500);
            if (tap === 6) expect(cycles()).toBe(1); // 3.5 s in: still waiting
        }
        // The max wait fired once at 4 s; the rest went in one more cycle.
        await vi.advanceTimersByTimeAsync(1000);
        expect(cycles()).toBe(3);
        expect(pushedIds()).toHaveLength(12);
    });

    it('offline, the edit stays queued and goes out when the connection returns', async () => {
        await startEngine();
        setOnline(false);

        localWrite('stores-offline');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(pushedIds()).toEqual([]);
        expect(h.state.queue).toHaveLength(1);

        setOnline(true);
        window.dispatchEvent(new Event('online'));
        await vi.advanceTimersByTimeAsync(0);
        expect(pushedIds()).toEqual(['stores-offline']);
    });

    it('an edit made while a cycle is running gets a cycle of its own right after it', async () => {
        await startEngine();
        let release!: () => void;
        h.state.watermarkGate = new Promise<void>((resolve) => {
            release = resolve;
        });

        localWrite('first');
        await vi.advanceTimersByTimeAsync(1000);
        expect(pushedIds()).toEqual(['first']); // pushed; its pull is still running

        localWrite('second');
        await vi.advanceTimersByTimeAsync(1000);
        expect(pushedIds()).toEqual(['first']); // the running cycle already read the queue

        h.state.watermarkGate = null;
        release();
        await vi.advanceTimersByTimeAsync(0);
        expect(pushedIds()).toEqual(['first', 'second']);
    });

    it('a prompt push is silent: no haptic a second after every tap', async () => {
        // A change queued before start goes out in the boot cycle: that one buzzes, as before.
        localWrite('queued-before-start');
        sync.startSyncEngine();
        await vi.advanceTimersByTimeAsync(2000);
        expect(pushedIds()).toEqual(['queued-before-start']);
        expect(h.haptic).toHaveBeenCalledTimes(1);

        localWrite('tapped');
        await vi.advanceTimersByTimeAsync(1000);
        expect(pushedIds()).toEqual(['queued-before-start', 'tapped']);
        expect(h.haptic).toHaveBeenCalledTimes(1);
    });

    it('stops pushing on its own once the engine stops (account switch, sign-out)', async () => {
        await startEngine();
        sync.stopSyncEngine();

        localWrite('after-stop');
        await vi.advanceTimersByTimeAsync(10_000);
        expect(pushedIds()).toEqual([]);
    });
});

describe('the app catches up when it comes back', () => {
    function showPage(): void {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
    }

    it('returning to the foreground sweeps the binder tables for rows deleted on another device', async () => {
        await startEngine();
        expect(h.idListings).toEqual([]); // the boot cycle does not sweep
        h.state.serverIds.set('inventory_items', ['stores-kept']);
        h.prunePulledTable.mockImplementation(async (table: string) => (table === 'inventory_items' ? 2 : 0));

        showPage();
        await vi.advanceTimersByTimeAsync(1500);

        expect(cycles()).toBe(2);
        expect([...new Set(h.idListings)].sort()).toEqual(
            [
                'equipment_register',
                'inventory_items',
                'maintenance_history',
                'maintenance_tasks',
                'ship_documents',
            ].sort(),
        );
        expect(h.prunePulledTable).toHaveBeenCalledWith(
            'inventory_items',
            new Set(['stores-kept']),
            expect.objectContaining({ keepUpdatedAfter: WATERMARK }),
        );
        // Only the binder tables: the rest keep their six-hourly full pull.
        expect(h.prunePulledTable).not.toHaveBeenCalledWith('recipes', expect.anything(), expect.anything());
        // The open binders hear that rows went (useBinderSource reloads on it).
        expect(completions.at(-1)).toMatchObject({ pruned: 2 });
    });

    it('the native app-state event and visibilitychange together are one cycle', async () => {
        await startEngine();
        await vi.waitFor(() => expect(h.state.appStateListener).not.toBeNull());

        h.state.appStateListener!({ isActive: true });
        showPage();
        await vi.advanceTimersByTimeAsync(1500);
        expect(cycles()).toBe(2);

        await vi.advanceTimersByTimeAsync(30_000);
        expect(cycles()).toBe(2);
    });

    it('a realtime rejoin just after a foreground still gets its own catch-up, spaced, never dropped', async () => {
        await startEngine();

        sync.requestCatchUpSync(); // foreground
        await vi.advanceTimersByTimeAsync(1500);
        expect(cycles()).toBe(2);

        await vi.advanceTimersByTimeAsync(1500);
        sync.requestCatchUpSync(); // a channel rejoined 1.5 s after that cycle began
        await vi.advanceTimersByTimeAsync(8000);
        expect(cycles()).toBe(2); // no closer than 10 s after the last one began...

        await vi.advanceTimersByTimeAsync(600);
        expect(cycles()).toBe(3); // ...but it does run
        expect(h.idListings.filter((table) => table === 'inventory_items')).toHaveLength(2);
    });

    it('the five-minute cycle sweeps too: a delete never waits for the six-hourly full pull', async () => {
        // The iPad sits on the Nav Station with no binder channel open, and
        // never leaves the foreground: no catch-up event ever fires there.
        await startEngine();
        h.state.serverIds.set('inventory_items', ['stores-kept']);

        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);

        expect(cycles()).toBe(2);
        expect(h.idListings).toContain('inventory_items');
        expect(h.prunePulledTable).toHaveBeenCalledWith(
            'inventory_items',
            new Set(['stores-kept']),
            expect.objectContaining({ keepUpdatedAfter: WATERMARK }),
        );
    });

    it('an incremental pull hands the merge its upper bound, so a stale page cannot undo a newer realtime row', async () => {
        await startEngine();
        const row = { id: 'stores-1', item_name: 'Rice', updated_at: '2026-10-02T01:59:30.000Z' };
        h.state.serverRows.set('inventory_items', [row]);

        sync.requestCatchUpSync();
        await vi.advanceTimersByTimeAsync(1500);

        expect(h.mergePulledRecords).toHaveBeenCalledWith('inventory_items', [row], { until: WATERMARK });
    });

    it('a full reconciliation keeps rows that reached this device after its snapshot', async () => {
        h.state.meta.lastPullTimestamp = null; // first pull: a full snapshot
        await startEngine();

        expect(h.prunePulledTable).toHaveBeenCalledWith(
            'inventory_items',
            expect.any(Set),
            expect.objectContaining({ keepUpdatedAfter: WATERMARK }),
        );
        expect(h.idListings).toEqual([]); // the snapshot already pruned; no separate sweep
    });
});

describe('an edit made just before the phone is locked still goes out', () => {
    function hidePage(): void {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
    }

    afterEach(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    });

    it('going to the background pushes at once, not after the debounce', async () => {
        await startEngine();

        localWrite('edited-then-locked');
        hidePage();
        await vi.advanceTimersByTimeAsync(0);

        expect(pushedIds()).toEqual(['edited-then-locked']);
        // The debounce timer was cleared: no second cycle a second later.
        await vi.advanceTimersByTimeAsync(5000);
        expect(cycles()).toBe(2);
    });

    it('the native app-state event does the same (WKWebView may not fire visibilitychange)', async () => {
        await startEngine();
        await vi.waitFor(() => expect(h.state.appStateListener).not.toBeNull());

        localWrite('edited-then-home');
        h.state.appStateListener!({ isActive: false });
        await vi.advanceTimersByTimeAsync(0);

        expect(pushedIds()).toEqual(['edited-then-home']);
    });

    it('with nothing queued, going to the background runs no cycle', async () => {
        await startEngine();
        hidePage();
        await vi.advanceTimersByTimeAsync(5000);
        expect(cycles()).toBe(1);
        expect(h.startBackgroundTask).not.toHaveBeenCalled();
    });

    it('on iOS the push runs inside a native background task, ended once the push settles', async () => {
        h.state.platform = 'ios';
        await startEngine();
        let release!: () => void;
        h.state.watermarkGate = new Promise<void>((resolve) => {
            release = resolve;
        });

        localWrite('edited-then-locked');
        hidePage();
        await vi.advanceTimersByTimeAsync(0);
        await vi.waitFor(() => expect(h.startBackgroundTask).toHaveBeenCalledOnce());
        expect(pushedIds()).toEqual(['edited-then-locked']);
        expect(h.stopBackgroundTask).not.toHaveBeenCalled(); // its pull is still running

        h.state.watermarkGate = null;
        release();
        await vi.advanceTimersByTimeAsync(0);
        await vi.waitFor(() => expect(h.stopBackgroundTask).toHaveBeenCalledWith(7));
    });

    it('elsewhere (web), no background task is asked for', async () => {
        await startEngine();
        localWrite('edited-on-the-web');
        hidePage();
        await vi.advanceTimersByTimeAsync(0);
        expect(pushedIds()).toEqual(['edited-on-the-web']);
        expect(h.startBackgroundTask).not.toHaveBeenCalled();
    });
});

describe('the sweep reads as the signed-in user, and one reading never empties a binder', () => {
    /** The mock prune judges a listing against this device's clean rows, as LocalDatabase does. */
    function holdLocally(table: string, ids: string[]): void {
        h.state.localIds.set(table, ids);
    }

    beforeEach(() => {
        h.prunePulledTable.mockImplementation(async (table: string, visible: Set<string>, options?: unknown) => {
            const local = h.state.localIds.get(table) ?? [];
            const removing = local.filter((id) => !visible.has(id));
            const plan = { visible: visible.size, eligible: local.length, removing: removing.length };
            const allowPrune = (options as { allowPrune?: (p: typeof plan) => boolean } | undefined)?.allowPrune;
            if (allowPrune && !allowPrune(plan)) return 0;
            h.state.localIds.set(
                table,
                local.filter((id) => visible.has(id)),
            );
            return removing.length;
        });
    });

    const fullPulls = () => h.state.pullSince.filter((entry) => entry.since === '1970-01-01T00:00:00.000Z');

    it("every id listing carries the signed-in user's token, so it can never fall back to anon", async () => {
        await startEngine();
        sync.requestCatchUpSync();
        await vi.advanceTimersByTimeAsync(1500);

        expect(h.state.listingAuth).toHaveLength(5);
        expect(h.state.listingAuth.every((value) => value === 'Bearer token-user-1')).toBe(true);
    });

    it('with no session to pin (a refresh failing mid-cycle), nothing is listed or pruned, and the sweep stays owed', async () => {
        await startEngine();
        const pulledUpTo = '2026-10-02T01:59:30.000Z';
        h.state.meta.lastPullTimestamp = pulledUpTo;
        holdLocally('inventory_items', ['stores-1', 'stores-2']);
        h.getSession.mockResolvedValue({ data: { session: null }, error: null });

        sync.requestCatchUpSync();
        await vi.advanceTimersByTimeAsync(1500);
        expect(cycles()).toBe(2);
        expect(h.idListings).toEqual([]);
        expect(h.prunePulledTable).not.toHaveBeenCalled();
        expect(completions.at(-1)?.errors).not.toEqual([]);
        // The pull is replayed, not skipped past.
        expect(h.state.meta.lastPullTimestamp).toBe(pulledUpTo);

        // The next cycle with a session sweeps after all.
        h.getSession.mockResolvedValue({
            data: { session: { access_token: 'token-user-1', user: { id: 'user-1' } } },
            error: null,
        });
        h.state.serverIds.set('inventory_items', ['stores-1']);
        await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
        expect(h.idListings).toContain('inventory_items');
        expect(h.state.localIds.get('inventory_items')).toEqual(['stores-1']);
    });

    it("never pins another account's token", async () => {
        await startEngine();
        h.getSession.mockResolvedValue({
            data: { session: { access_token: 'token-user-2', user: { id: 'user-2' } } },
            error: null,
        });

        sync.requestCatchUpSync();
        await vi.advanceTimersByTimeAsync(1500);
        expect(h.idListings).toEqual([]);
        expect(h.prunePulledTable).not.toHaveBeenCalled();
    });

    it('an empty listing is held, not pruned, until a full reconciliation reads the same', async () => {
        await startEngine();
        holdLocally('inventory_items', ['stores-1', 'stores-2', 'stores-3']);
        // The server lists nothing, and its full pull has no rows either.

        sync.requestCatchUpSync();
        await vi.advanceTimersByTimeAsync(1500);

        // The catch-up held the prune and asked for a full reconciliation,
        // which ran straight after it and, reading the same, pruned.
        expect(cycles()).toBe(3);
        expect(completions[1]).toMatchObject({ pruned: 0 });
        expect(fullPulls().map((entry) => entry.table)).toContain('inventory_items');
        expect(completions[2]).toMatchObject({ pruned: 3 });
        expect(h.state.localIds.get('inventory_items')).toEqual([]);
        expect(sync.isFullReconciliationPending()).toBe(false);
    });

    it('a collapse read once and not again is forgotten, and never pruned', async () => {
        await startEngine();
        holdLocally('maintenance_tasks', ['task-1', 'task-2', 'task-3']);
        // The id listing comes back empty, but the full pull still has every row.
        h.state.serverRows.set(
            'maintenance_tasks',
            ['task-1', 'task-2', 'task-3'].map((id) => ({ id, updated_at: '2026-10-02T01:00:00.000Z' })),
        );

        sync.requestCatchUpSync();
        await vi.advanceTimersByTimeAsync(1500);
        expect(cycles()).toBe(3);
        expect(h.state.localIds.get('maintenance_tasks')).toEqual(['task-1', 'task-2', 'task-3']);

        // The next sweep reads it empty again: a new first reading, held again.
        await vi.advanceTimersByTimeAsync(10_000);
        sync.requestCatchUpSync();
        await vi.advanceTimersByTimeAsync(1500);
        expect(h.state.localIds.get('maintenance_tasks')).toEqual(['task-1', 'task-2', 'task-3']);
    });

    it('more than half of five or more rows is held; a smaller drop, or a small binder, prunes at once', async () => {
        await startEngine();
        const ten = Array.from({ length: 10 }, (_, index) => `stores-${index}`);
        holdLocally('inventory_items', ten);
        h.state.serverIds.set('inventory_items', ten.slice(0, 4)); // six of ten gone
        holdLocally(
            'equipment_register',
            ten.map((id) => id.replace('stores', 'equipment')),
        );
        h.state.serverIds.set(
            'equipment_register',
            ten.slice(0, 8).map((id) => id.replace('stores', 'equipment')),
        ); // two of ten gone
        holdLocally('ship_documents', ['doc-1', 'doc-2', 'doc-3']);
        h.state.serverIds.set('ship_documents', ['doc-1']); // two of three, under five rows
        // The full reconciliation the hold asks for lists the same as the sweep.
        h.state.serverRows.set(
            'inventory_items',
            ten.slice(0, 4).map((id) => ({ id, updated_at: '2026-10-02T01:00:00.000Z' })),
        );
        h.state.serverRows.set(
            'equipment_register',
            ten
                .slice(0, 8)
                .map((id) => ({ id: id.replace('stores', 'equipment'), updated_at: '2026-10-02T01:00:00.000Z' })),
        );
        h.state.serverRows.set('ship_documents', [{ id: 'doc-1', updated_at: '2026-10-02T01:00:00.000Z' }]);

        sync.requestCatchUpSync();
        await vi.advanceTimersByTimeAsync(1500);

        // The sweep pruned the two ordinary drops and held the collapse.
        expect(completions[1]).toMatchObject({ pruned: 4 });
        // The full reconciliation behind it read the same collapse: confirmed.
        expect(completions[2]).toMatchObject({ pruned: 6 });
        expect(h.state.localIds.get('inventory_items')).toEqual(ten.slice(0, 4));
        expect(h.state.localIds.get('equipment_register')).toHaveLength(8);
        expect(h.state.localIds.get('ship_documents')).toEqual(['doc-1']);
    });

    it('a full reconciliation that finds a binder emptied holds it once, and its follow-up confirms', async () => {
        h.state.meta.lastPullTimestamp = null; // the boot cycle is a full snapshot
        holdLocally('inventory_items', ['stores-1', 'stores-2']);
        sync.startSyncEngine();
        await vi.advanceTimersByTimeAsync(2000);

        expect(cycles()).toBe(2);
        expect(completions[0]).toMatchObject({ pruned: 0 });
        expect(completions[1]).toMatchObject({ pruned: 2 });
        expect(fullPulls().filter((entry) => entry.table === 'inventory_items')).toHaveLength(2);
    });
});
