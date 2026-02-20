/**
 * LocalDatabase — Offline-first data layer for Vessel Hub.
 *
 * Mirrors Supabase tables locally using Capacitor Filesystem JSON storage.
 * Maintains a sync_queue (outbox) for mutations pending server push.
 *
 * Architecture:
 *   - Each table is a JSON file: `vessel_<table>.json`
 *   - Records stored as Record<string, Row> keyed by UUID
 *   - Sync queue stored as array of pending mutations
 *   - All reads/writes are instant (local filesystem)
 *   - SyncService handles push/pull asynchronously
 */
import { Filesystem, Directory, Encoding } from '@capacitor/filesystem';

// ── Types ──────────────────────────────────────────────────────

export type MutationType = 'INSERT' | 'UPDATE' | 'DELETE';

export interface SyncQueueItem {
    id: string;                    // UUID for the queue entry itself
    table_name: string;            // 'inventory_items' | 'maintenance_tasks' | 'maintenance_history'
    record_id: string;             // UUID of the actual record
    mutation_type: MutationType;
    payload: string;               // JSON-stringified row data
    created_at: string;            // ISO timestamp
    status: 'pending' | 'syncing' | 'failed';
    retry_count: number;
    error_message?: string;
}

export interface SyncMeta {
    lastPullTimestamp: string | null;   // ISO timestamp of last successful pull
    lastPushTimestamp: string | null;   // ISO timestamp of last successful push
    deviceId: string;                  // Unique device identifier
}

// ── File paths ─────────────────────────────────────────────────

const TABLE_FILES: Record<string, string> = {
    inventory_items: 'vessel_inventory_items.json',
    maintenance_tasks: 'vessel_maintenance_tasks.json',
    maintenance_history: 'vessel_maintenance_history.json',
    equipment_register: 'vessel_equipment_register.json',
};

const SYNC_QUEUE_FILE = 'vessel_sync_queue.json';
const SYNC_META_FILE = 'vessel_sync_meta.json';

// ── In-memory cache ────────────────────────────────────────────
// Hot cache for instant reads. Flushed to disk on writes.

const cache: Record<string, Record<string, unknown>> = {};
let syncQueueCache: SyncQueueItem[] | null = null;
let syncMetaCache: SyncMeta | null = null;
let initialized = false;

// ── Core I/O ───────────────────────────────────────────────────

async function readJsonFile<T>(filename: string, fallback: T): Promise<T> {
    try {
        const result = await Filesystem.readdir({
            path: '',
            directory: Directory.Documents,
        });

        const exists = result.files.some(f => {
            const name = typeof f === 'string' ? f : f.name;
            return name === filename;
        });

        if (!exists) return fallback;

        const contents = await Filesystem.readFile({
            path: filename,
            directory: Directory.Documents,
            encoding: Encoding.UTF8,
        });

        return JSON.parse(contents.data as string) as T;
    } catch {
        return fallback;
    }
}

async function writeJsonFile(filename: string, data: unknown): Promise<void> {
    try {
        await Filesystem.writeFile({
            path: filename,
            data: JSON.stringify(data),
            directory: Directory.Documents,
            encoding: Encoding.UTF8,
        });
    } catch (e) {
        console.error(`[LocalDB] Failed to write ${filename}:`, e);
    }
}

// ── Initialization ─────────────────────────────────────────────

/**
 * Initialize the local database. Loads all tables into memory.
 * Must be called once at app boot before any reads/writes.
 */
export async function initLocalDatabase(): Promise<void> {
    if (initialized) return;

    // Load all tables into cache
    for (const [table, file] of Object.entries(TABLE_FILES)) {
        cache[table] = await readJsonFile<Record<string, unknown>>(file, {});
    }

    // Load sync queue
    syncQueueCache = await readJsonFile<SyncQueueItem[]>(SYNC_QUEUE_FILE, []);

    // Load sync meta
    syncMetaCache = await readJsonFile<SyncMeta>(SYNC_META_FILE, {
        lastPullTimestamp: null,
        lastPushTimestamp: null,
        deviceId: generateDeviceId(),
    });

    initialized = true;
    console.log(`[LocalDB] Initialized — ${Object.keys(cache).map(t => `${t}: ${Object.keys(cache[t]).length}`).join(', ')}`);
}

function ensureInit() {
    if (!initialized) {
        throw new Error('[LocalDB] Not initialized. Call initLocalDatabase() first.');
    }
}

// ── Table Operations (CRUD) ────────────────────────────────────

/**
 * Get all records from a local table.
 */
export function getAll<T>(tableName: string): T[] {
    ensureInit();
    const table = cache[tableName] || {};
    return Object.values(table) as T[];
}

/**
 * Get a single record by ID.
 */
export function getById<T>(tableName: string, id: string): T | null {
    ensureInit();
    const record = cache[tableName]?.[id];
    return (record as T) || null;
}

/**
 * Query records with a filter function.
 */
export function query<T>(tableName: string, predicate: (item: T) => boolean): T[] {
    return getAll<T>(tableName).filter(predicate);
}

/**
 * Insert a record locally + queue for sync.
 */
export async function insertLocal<T extends { id: string }>(
    tableName: string,
    record: T,
): Promise<T> {
    ensureInit();
    if (!cache[tableName]) cache[tableName] = {};

    // Write to cache
    cache[tableName][record.id] = record;

    // Flush to disk
    await flushTable(tableName);

    // Queue for sync
    await enqueueSync(tableName, record.id, 'INSERT', record);

    return record;
}

/**
 * Update a record locally + queue for sync.
 */
export async function updateLocal<T extends { id: string; updated_at?: string }>(
    tableName: string,
    id: string,
    updates: Partial<T>,
): Promise<T | null> {
    ensureInit();
    const existing = cache[tableName]?.[id];
    if (!existing) return null;

    // Merge updates
    const updated = {
        ...(existing as T),
        ...updates,
        updated_at: new Date().toISOString(),
    };

    cache[tableName][id] = updated;
    await flushTable(tableName);
    await enqueueSync(tableName, id, 'UPDATE', updated);

    return updated as T;
}

/**
 * Delete a record locally + queue for sync.
 */
export async function deleteLocal(
    tableName: string,
    id: string,
): Promise<void> {
    ensureInit();
    if (!cache[tableName]?.[id]) return;

    delete cache[tableName][id];
    await flushTable(tableName);
    await enqueueSync(tableName, id, 'DELETE', { id });
}

/**
 * Bulk upsert records (used by sync pull — does NOT queue for push).
 */
export async function bulkUpsert<T extends { id: string }>(
    tableName: string,
    records: T[],
): Promise<void> {
    ensureInit();
    if (!cache[tableName]) cache[tableName] = {};

    for (const record of records) {
        cache[tableName][record.id] = record;
    }

    await flushTable(tableName);
}

/**
 * Bulk delete records by IDs (used by sync — does NOT queue).
 */
export async function bulkDelete(
    tableName: string,
    ids: string[],
): Promise<void> {
    ensureInit();
    for (const id of ids) {
        delete cache[tableName]?.[id];
    }
    await flushTable(tableName);
}

// ── Sync Queue ─────────────────────────────────────────────────

/**
 * Add a mutation to the sync outbox.
 */
async function enqueueSync(
    tableName: string,
    recordId: string,
    mutationType: MutationType,
    payload: unknown,
): Promise<void> {
    if (!syncQueueCache) syncQueueCache = [];

    // Deduplicate: if there's already a pending mutation for this record,
    // replace it (latest mutation wins within the queue)
    const existingIdx = syncQueueCache.findIndex(
        q => q.record_id === recordId && q.table_name === tableName && q.status === 'pending'
    );

    const item: SyncQueueItem = {
        id: generateUUID(),
        table_name: tableName,
        record_id: recordId,
        mutation_type: mutationType,
        payload: JSON.stringify(payload),
        created_at: new Date().toISOString(),
        status: 'pending',
        retry_count: 0,
    };

    if (existingIdx >= 0) {
        // If we had an INSERT and now DELETE, collapse to nothing
        if (syncQueueCache[existingIdx].mutation_type === 'INSERT' && mutationType === 'DELETE') {
            syncQueueCache.splice(existingIdx, 1);
        } else {
            // Replace with latest mutation
            syncQueueCache[existingIdx] = item;
        }
    } else {
        syncQueueCache.push(item);
    }

    await flushSyncQueue();
}

/**
 * Get all pending items from the sync queue.
 */
export function getPendingQueue(): SyncQueueItem[] {
    return (syncQueueCache || []).filter(q => q.status === 'pending');
}

/**
 * Get all items in the sync queue (including syncing/failed).
 */
export function getFullQueue(): SyncQueueItem[] {
    return syncQueueCache || [];
}

/**
 * Mark queue items as syncing (lock them before push).
 */
export async function markSyncing(ids: string[]): Promise<void> {
    if (!syncQueueCache) return;
    for (const item of syncQueueCache) {
        if (ids.includes(item.id)) {
            item.status = 'syncing';
        }
    }
    await flushSyncQueue();
}

/**
 * Remove successfully synced items from the queue.
 */
export async function removeSynced(ids: string[]): Promise<void> {
    if (!syncQueueCache) return;
    syncQueueCache = syncQueueCache.filter(q => !ids.includes(q.id));
    await flushSyncQueue();
}

/**
 * Mark items as failed with error messages.
 */
export async function markFailed(ids: string[], error: string): Promise<void> {
    if (!syncQueueCache) return;
    for (const item of syncQueueCache) {
        if (ids.includes(item.id)) {
            item.status = 'failed';
            item.retry_count += 1;
            item.error_message = error;
        }
    }
    await flushSyncQueue();
}

/**
 * Retry failed items (reset to pending).
 */
export async function retryFailed(): Promise<void> {
    if (!syncQueueCache) return;
    for (const item of syncQueueCache) {
        if (item.status === 'failed' && item.retry_count < 5) {
            item.status = 'pending';
        }
    }
    await flushSyncQueue();
}

/**
 * Get the number of pending mutations.
 */
export function getPendingCount(): number {
    return getPendingQueue().length;
}

// ── Sync Metadata ──────────────────────────────────────────────

export function getSyncMeta(): SyncMeta {
    return syncMetaCache || { lastPullTimestamp: null, lastPushTimestamp: null, deviceId: '' };
}

export async function updateSyncMeta(updates: Partial<SyncMeta>): Promise<void> {
    syncMetaCache = { ...getSyncMeta(), ...updates };
    await writeJsonFile(SYNC_META_FILE, syncMetaCache);
}

// ── Flush Helpers ──────────────────────────────────────────────

async function flushTable(tableName: string): Promise<void> {
    const file = TABLE_FILES[tableName];
    if (!file) return;
    await writeJsonFile(file, cache[tableName] || {});
}

async function flushSyncQueue(): Promise<void> {
    await writeJsonFile(SYNC_QUEUE_FILE, syncQueueCache || []);
}

// ── Utilities ──────────────────────────────────────────────────

function generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0;
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
    });
}

function generateDeviceId(): string {
    const stored = localStorage.getItem('thalassa_device_id');
    if (stored) return stored;
    const id = `device_${generateUUID().slice(0, 8)}`;
    localStorage.setItem('thalassa_device_id', id);
    return id;
}

/**
 * Export a UUID generator for services to use when creating new records.
 */
export { generateUUID };
