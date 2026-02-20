/**
 * SyncService — Background push/pull engine for Vessel Hub.
 *
 * Push (Up): Drains the sync_queue outbox → Supabase.
 * Pull (Down): Incremental fetch by updated_at → local upsert.
 * Conflict: Last-Write-Wins by updated_at timestamp.
 *
 * Network awareness: Listens for online/offline transitions.
 * When connectivity resumes, triggers a full sync cycle.
 */
import { supabase } from '../supabase';
import {
    getPendingQueue,
    markSyncing,
    removeSynced,
    markFailed,
    retryFailed,
    getSyncMeta,
    updateSyncMeta,
    bulkUpsert,
    getAll,
    type SyncQueueItem,
} from './LocalDatabase';

// ── Types ──────────────────────────────────────────────────────

interface SyncResult {
    pushed: number;
    pulled: number;
    errors: string[];
}

type SyncListener = (result: SyncResult) => void;
type StatusListener = (status: SyncStatus) => void;

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

// ── Supabase table config ──────────────────────────────────────

const SYNCABLE_TABLES = ['inventory_items', 'maintenance_tasks', 'maintenance_history'] as const;

type SyncableTable = typeof SYNCABLE_TABLES[number];

// ── Singleton state ────────────────────────────────────────────

let currentStatus: SyncStatus = 'idle';
let isSyncing = false;
let syncInterval: ReturnType<typeof setInterval> | null = null;
const listeners: SyncListener[] = [];
const statusListeners: StatusListener[] = [];

// ── Status management ──────────────────────────────────────────

function setStatus(status: SyncStatus) {
    currentStatus = status;
    statusListeners.forEach(fn => fn(status));
}

export function getSyncStatus(): SyncStatus {
    return currentStatus;
}

export function onSyncComplete(fn: SyncListener): () => void {
    listeners.push(fn);
    return () => {
        const idx = listeners.indexOf(fn);
        if (idx >= 0) listeners.splice(idx, 1);
    };
}

export function onStatusChange(fn: StatusListener): () => void {
    statusListeners.push(fn);
    return () => {
        const idx = statusListeners.indexOf(fn);
        if (idx >= 0) statusListeners.splice(idx, 1);
    };
}

// ── Network awareness ──────────────────────────────────────────

/**
 * Start the sync engine. Sets up network listeners and periodic sync.
 */
export function startSyncEngine(): void {
    // Listen for online/offline events
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Initial check
    if (navigator.onLine) {
        // Delay first sync slightly to let app boot finish
        setTimeout(() => syncNow(), 2000);
    } else {
        setStatus('offline');
    }

    // Periodic sync every 5 minutes when online
    syncInterval = setInterval(() => {
        if (navigator.onLine && !isSyncing) {
            syncNow();
        }
    }, 5 * 60 * 1000);

    console.log('[SyncService] Engine started');
}

/**
 * Stop the sync engine and remove listeners.
 */
export function stopSyncEngine(): void {
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
    if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
    }
    console.log('[SyncService] Engine stopped');
}

function handleOnline() {
    console.log('[SyncService] Network online — triggering sync');
    // Retry failed items when we come back online
    retryFailed().then(() => syncNow());
}

function handleOffline() {
    console.log('[SyncService] Network offline');
    setStatus('offline');
}

// ── Main Sync Loop ─────────────────────────────────────────────

/**
 * Execute a full sync cycle: Push → Pull.
 * Safe to call multiple times (debounced via isSyncing flag).
 */
export async function syncNow(): Promise<SyncResult> {
    if (isSyncing) {
        console.log('[SyncService] Sync already in progress, skipping');
        return { pushed: 0, pulled: 0, errors: [] };
    }

    if (!navigator.onLine) {
        setStatus('offline');
        return { pushed: 0, pulled: 0, errors: ['offline'] };
    }

    if (!supabase) {
        return { pushed: 0, pulled: 0, errors: ['Supabase not configured'] };
    }

    isSyncing = true;
    setStatus('syncing');

    const result: SyncResult = { pushed: 0, pulled: 0, errors: [] };

    try {
        // ── Phase 1: PUSH (drain outbox) ──
        const pushResult = await pushMutations();
        result.pushed = pushResult.count;
        if (pushResult.errors.length > 0) {
            result.errors.push(...pushResult.errors);
        }

        // ── Phase 2: PULL (incremental fetch) ──
        const pullResult = await pullUpdates();
        result.pulled = pullResult.count;
        if (pullResult.errors.length > 0) {
            result.errors.push(...pullResult.errors);
        }

        setStatus(result.errors.length > 0 ? 'error' : 'idle');
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown sync error';
        result.errors.push(msg);
        setStatus('error');
        console.error('[SyncService] Sync failed:', msg);
    } finally {
        isSyncing = false;
    }

    // Notify listeners
    listeners.forEach(fn => fn(result));

    if (result.pushed > 0 || result.pulled > 0) {
        console.log(`[SyncService] Sync complete — pushed: ${result.pushed}, pulled: ${result.pulled}`);
    }

    return result;
}

// ── Phase 1: PUSH ──────────────────────────────────────────────

async function pushMutations(): Promise<{ count: number; errors: string[] }> {
    const pending = getPendingQueue();
    if (pending.length === 0) return { count: 0, errors: [] };

    console.log(`[SyncService] Pushing ${pending.length} mutations...`);

    // Lock items
    const ids = pending.map(q => q.id);
    await markSyncing(ids);

    const succeeded: string[] = [];
    const errors: string[] = [];

    // Process mutations in order (FIFO)
    for (const item of pending) {
        try {
            await pushSingleMutation(item);
            succeeded.push(item.id);
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Push failed';
            errors.push(`${item.table_name}/${item.record_id}: ${msg}`);
            await markFailed([item.id], msg);
        }
    }

    // Remove successfully synced items
    if (succeeded.length > 0) {
        await removeSynced(succeeded);
        await updateSyncMeta({ lastPushTimestamp: new Date().toISOString() });
    }

    return { count: succeeded.length, errors };
}

async function pushSingleMutation(item: SyncQueueItem): Promise<void> {
    if (!supabase) throw new Error('Supabase not configured');

    const payload = JSON.parse(item.payload);
    const table = item.table_name as SyncableTable;

    switch (item.mutation_type) {
        case 'INSERT': {
            // Get current user for user_id
            const { data: { user } } = await supabase.auth.getUser();
            if (!user) throw new Error('Not authenticated');

            const row = { ...payload, user_id: user.id };
            // Remove local-only fields
            delete row._local_only;

            const { error } = await supabase
                .from(table)
                .upsert(row, { onConflict: 'id' });

            if (error) throw new Error(error.message);
            break;
        }

        case 'UPDATE': {
            const { error } = await supabase
                .from(table)
                .update(payload)
                .eq('id', item.record_id);

            if (error) throw new Error(error.message);
            break;
        }

        case 'DELETE': {
            const { error } = await supabase
                .from(table)
                .delete()
                .eq('id', item.record_id);

            if (error) throw new Error(error.message);
            break;
        }
    }
}

// ── Phase 2: PULL ──────────────────────────────────────────────

async function pullUpdates(): Promise<{ count: number; errors: string[] }> {
    if (!supabase) return { count: 0, errors: ['Supabase not configured'] };

    const meta = getSyncMeta();
    const since = meta.lastPullTimestamp || '1970-01-01T00:00:00Z';
    let totalPulled = 0;
    const errors: string[] = [];

    for (const table of SYNCABLE_TABLES) {
        try {
            const pulled = await pullTable(table, since);
            totalPulled += pulled;
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Pull failed';
            errors.push(`${table}: ${msg}`);
        }
    }

    if (totalPulled > 0 || errors.length === 0) {
        await updateSyncMeta({ lastPullTimestamp: new Date().toISOString() });
    }

    return { count: totalPulled, errors };
}

async function pullTable(table: SyncableTable, since: string): Promise<number> {
    if (!supabase) return 0;

    // Fetch records updated since last pull
    const { data, error } = await supabase
        .from(table)
        .select('*')
        .gt('updated_at', since)
        .order('updated_at', { ascending: true });

    if (error) throw new Error(error.message);
    if (!data || data.length === 0) return 0;

    // ── Conflict Resolution: Last Write Wins ──
    // Compare server updated_at vs local updated_at.
    // Server wins if its timestamp is newer.
    const localRecords = getAll<{ id: string; updated_at?: string }>(table);
    const localMap = new Map(localRecords.map(r => [r.id, r]));

    const toUpsert: unknown[] = [];

    for (const serverRecord of data) {
        const local = localMap.get(serverRecord.id);

        if (!local) {
            // New record from server — accept
            toUpsert.push(serverRecord);
        } else {
            // Both exist — compare timestamps (Last Write Wins)
            const serverTime = new Date(serverRecord.updated_at || serverRecord.created_at).getTime();
            const localTime = new Date(local.updated_at || '1970-01-01').getTime();

            if (serverTime >= localTime) {
                // Server is newer or same — accept server version
                toUpsert.push(serverRecord);
            }
            // else: local is newer — keep local (will be pushed next cycle)
        }
    }

    if (toUpsert.length > 0) {
        await bulkUpsert(table, toUpsert as { id: string }[]);
        console.log(`[SyncService] Pulled ${toUpsert.length} records for ${table}`);
    }

    return toUpsert.length;
}

// ── Convenience: Force full refresh ────────────────────────────

/**
 * Force a full pull from server (ignores last sync timestamp).
 * Useful for initial app load or manual refresh.
 */
export async function forceFullPull(): Promise<number> {
    if (!supabase) return 0;

    let total = 0;
    for (const table of SYNCABLE_TABLES) {
        total += await pullTable(table, '1970-01-01T00:00:00Z');
    }
    await updateSyncMeta({ lastPullTimestamp: new Date().toISOString() });
    return total;
}
