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

import { createLogger } from '../../utils/createLogger';

const log = createLogger('LocalDatabase');

// ── Types ──────────────────────────────────────────────────────

export type MutationType = 'INSERT' | 'UPDATE' | 'DELETE' | 'DELTA';

export interface SyncQueueItem {
    id: string; // UUID for the queue entry itself
    table_name: string; // 'inventory_items' | 'maintenance_tasks' | 'maintenance_history'
    record_id: string; // UUID of the actual record
    mutation_type: MutationType;
    payload: string; // JSON-stringified row data
    created_at: string; // ISO timestamp
    status: 'pending' | 'syncing' | 'failed';
    retry_count: number;
    error_message?: string;
    /**
     * Auth identity that created this mutation. The sync engine refuses to
     * drain an item under any other session.
     */
    owner_user_id: string | null;
}

export interface SyncMeta {
    lastPullTimestamp: string | null; // ISO timestamp of last successful pull
    lastPushTimestamp: string | null; // ISO timestamp of last successful push
    lastFullPullTimestamp?: string | null; // ISO timestamp of last authoritative snapshot
    deviceId: string; // Unique device identifier
    ownerUserId: string | null; // Scope integrity check for cursor/cache files
}

/**
 * Synchronous transaction view used by workflows whose local mirror and
 * outbox mutations must commit as one durable unit. The callback is
 * deliberately synchronous: awaiting arbitrary work while holding the global
 * mutation lock could deadlock another LocalDatabase operation.
 */
export interface LocalTransaction {
    getById<T>(tableName: string, id: string): T | null;
    getAll<T>(tableName: string): T[];
    query<T>(tableName: string, predicate: (item: T) => boolean): T[];
    insert<T extends { id: string }>(tableName: string, record: T): T;
    update<T extends { id: string; updated_at?: string }>(tableName: string, id: string, updates: Partial<T>): T | null;
    delta<T extends { id: string; updated_at?: string }>(
        tableName: string,
        id: string,
        field: string,
        delta: number,
    ): T | null;
    delete(tableName: string, id: string): boolean;
}

interface AtomicTransactionJournal {
    version: 1;
    transactionId: string;
    ownerUserId: string | null;
    createdAt: string;
    queue: SyncQueueItem[];
    tables: Record<string, Record<string, unknown>>;
}

// ── File paths ─────────────────────────────────────────────────

const TABLE_FILES: Record<string, string> = {
    inventory_items: 'vessel_inventory_items.json',
    maintenance_tasks: 'vessel_maintenance_tasks.json',
    maintenance_history: 'vessel_maintenance_history.json',
    equipment_register: 'vessel_equipment_register.json',
    ship_documents: 'vessel_ship_documents.json',
    checklists: 'vessel_checklists.json',
    checklist_runs: 'vessel_checklist_runs.json',
    recipes: 'vessel_recipes.json',
    passage_provisions: 'vessel_passage_provisions.json',
    meal_plans: 'vessel_meal_plans.json',
    shopping_list: 'vessel_shopping_list.json',
    crew_profiles: 'vessel_crew_profiles.json',
};

const LEGACY_SYNC_QUEUE_FILE = 'vessel_sync_queue.json';
const LEGACY_SYNC_META_FILE = 'vessel_sync_meta.json';
const LEGACY_CLAIM_FILE = 'vessel_legacy_scope_claim.json';
const ANONYMOUS_CLAIM_FILE = 'vessel_anonymous_scope_claim.json';
const LOCAL_TRANSACTION_FILE = 'vessel_local_transaction.json';

interface LegacyScopeClaim {
    state: 'claimed' | 'quarantined';
    ownerUserId: string | null;
    claimedAt: string;
    completed?: boolean;
    reason?: string;
}

interface AnonymousScopeClaim {
    ownerUserId: string;
    claimedAt: string;
    completed?: boolean;
}

// ── In-memory cache ────────────────────────────────────────────
// Hot cache for instant reads. Flushed to disk on writes.

const cache: Record<string, Record<string, unknown>> = {};
let syncQueueCache: SyncQueueItem[] | null = null;
let syncMetaCache: SyncMeta | null = null;
let initialized = false;
let initPromise: Promise<void> | null = null;
let initPromiseIdentity: string | null | undefined;
let initPromiseRequestId = 0;
let mutationTail: Promise<void> = Promise.resolve();
let activeIdentity: string | null | undefined;
let identityGeneration = 0;
let identityTransitioning = false;
let identityTransitionRequest = 0;
let pendingAtomicJournal: AtomicTransactionJournal | null = null;

// ── Core I/O ───────────────────────────────────────────────────

function normalizeIdentity(userId: string | null | undefined): string | null {
    const normalized = typeof userId === 'string' ? userId.trim() : '';
    return normalized || null;
}

/**
 * Hex encoding is reversible and collision-free for UTF-8 identities while
 * remaining safe in native filesystem paths.
 */
function identityFileToken(identity: string | null): string {
    if (!identity) return 'anonymous';
    const bytes = new TextEncoder().encode(identity);
    return `user_${Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

function scopedFilename(legacyFilename: string, identity: string | null): string {
    const suffix = legacyFilename.startsWith('vessel_') ? legacyFilename.slice('vessel_'.length) : legacyFilename;
    return `vessel_${identityFileToken(identity)}_${suffix}`;
}

function tableFilename(tableName: string, identity = activeIdentity): string {
    const legacy = TABLE_FILES[tableName];
    if (!legacy) throw new Error(`[LocalDB] Unsupported table: ${tableName}`);
    if (identity === undefined) throw new Error('[LocalDB] No active identity scope');
    return scopedFilename(legacy, identity);
}

function queueFilename(identity = activeIdentity): string {
    if (identity === undefined) throw new Error('[LocalDB] No active identity scope');
    return scopedFilename(LEGACY_SYNC_QUEUE_FILE, identity);
}

function metaFilename(identity = activeIdentity): string {
    if (identity === undefined) throw new Error('[LocalDB] No active identity scope');
    return scopedFilename(LEGACY_SYNC_META_FILE, identity);
}

function transactionFilename(identity = activeIdentity): string {
    if (identity === undefined) throw new Error('[LocalDB] No active identity scope');
    return scopedFilename(LOCAL_TRANSACTION_FILE, identity);
}

async function listDocumentFiles(): Promise<Set<string>> {
    const result = await Filesystem.readdir({
        path: '',
        directory: Directory.Documents,
    });
    return new Set(result.files.map((file) => (typeof file === 'string' ? file : file.name)));
}

async function readJsonFile<T>(filename: string, fallback: T): Promise<T> {
    try {
        const files = await listDocumentFiles();
        const candidates = [filename, `${filename}.tmp`, `${filename}.bak`].filter((candidate) => files.has(candidate));
        if (candidates.length === 0) return fallback;

        let lastError: unknown;
        for (const candidate of candidates) {
            try {
                const contents = await Filesystem.readFile({
                    path: candidate,
                    directory: Directory.Documents,
                    encoding: Encoding.UTF8,
                });
                const parsed = JSON.parse(contents.data as string) as T;

                if (candidate !== filename && !files.has(filename)) {
                    // Complete an interrupted atomic swap when possible. The
                    // parsed value is already safe to use even if native
                    // recovery itself fails.
                    await Filesystem.rename({
                        from: candidate,
                        to: filename,
                        directory: Directory.Documents,
                        toDirectory: Directory.Documents,
                    }).catch((error) => log.warn(`[LocalDB] Could not promote recovered ${candidate}:`, error));
                }
                return parsed;
            } catch (error) {
                lastError = error;
                log.warn(`[LocalDB] Ignoring unreadable recovery candidate ${candidate}:`, error);
            }
        }
        throw lastError instanceof Error ? lastError : new Error(`[LocalDB] No valid copy of ${filename}`);
    } catch (e) {
        log.error(`[LocalDB] Failed to read ${filename}:`, e);
        throw e instanceof Error ? e : new Error(`[LocalDB] Failed to read ${filename}`);
    }
}

async function writeJsonFile(filename: string, data: unknown): Promise<void> {
    const temporary = `${filename}.tmp`;
    const backup = `${filename}.bak`;
    try {
        await deleteFileIfPresent(temporary);
        await Filesystem.writeFile({
            path: temporary,
            data: JSON.stringify(data),
            directory: Directory.Documents,
            encoding: Encoding.UTF8,
        });

        const files = await listDocumentFiles();
        const hadCurrent = files.has(filename);
        if (hadCurrent) {
            await deleteFileIfPresent(backup);
            await Filesystem.rename({
                from: filename,
                to: backup,
                directory: Directory.Documents,
                toDirectory: Directory.Documents,
            });
        }

        try {
            await Filesystem.rename({
                from: temporary,
                to: filename,
                directory: Directory.Documents,
                toDirectory: Directory.Documents,
            });
        } catch (error) {
            if (hadCurrent) {
                const recoveryFiles = await listDocumentFiles().catch(() => new Set<string>());
                if (!recoveryFiles.has(filename) && recoveryFiles.has(backup)) {
                    await Filesystem.rename({
                        from: backup,
                        to: filename,
                        directory: Directory.Documents,
                        toDirectory: Directory.Documents,
                    }).catch(() => {});
                }
            }
            throw error;
        }

        await deleteFileIfPresent(backup).catch((error) => {
            // The new target is already committed. A stale backup is harmless
            // and must not turn a successful durable write into an API failure.
            log.warn(`[LocalDB] Could not remove stale backup ${backup}:`, error);
        });
    } catch (e) {
        log.error(`[LocalDB] Failed to write ${filename}:`, e);
        throw e instanceof Error ? e : new Error(`[LocalDB] Failed to write ${filename}`);
    }
}

async function deleteFileIfPresent(filename: string): Promise<void> {
    const files = await listDocumentFiles();
    if (!files.has(filename)) return;
    await Filesystem.deleteFile({
        path: filename,
        directory: Directory.Documents,
    });
}

async function deleteJsonFile(filename: string): Promise<void> {
    // Delete recovery copies first and the committed target last. If the
    // process dies mid-delete, the target still acts as the tombstone boundary;
    // once it is gone there is no fallback copy left to resurrect state.
    for (const candidate of [`${filename}.tmp`, `${filename}.bak`, filename]) {
        try {
            await deleteFileIfPresent(candidate);
        } catch (error) {
            log.error(`[LocalDB] Failed to delete ${candidate}:`, error);
            throw error;
        }
    }
}

/**
 * Filesystem JSON writes are read/modify/write operations. Keep every cache,
 * table, queue, and metadata mutation on one chain so overlapping callers
 * cannot persist stale snapshots over one another.
 */
function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const guardedOperation = async () => {
        if (pendingAtomicJournal) {
            await finishAtomicJournal(pendingAtomicJournal, pendingAtomicJournal.ownerUserId);
        }
        return operation();
    };
    const run = mutationTail.then(guardedOperation, guardedOperation);
    mutationTail = run.then(
        () => undefined,
        () => undefined,
    );
    return run;
}

// ── Initialization ─────────────────────────────────────────────

/**
 * Initialize (or switch) the local database for one authenticated identity.
 *
 * Calling this function starts an identity transition synchronously: reads
 * from the previous scope are blocked immediately, then all prior mutations
 * finish before the new scope is loaded. This prevents a React render or
 * background sync from observing another account's cache during sign-out or
 * account switching.
 */
export function initLocalDatabase(userId: string | null = null): Promise<void> {
    const targetIdentity = normalizeIdentity(userId);
    if (initialized && !identityTransitioning && activeIdentity === targetIdentity && !pendingAtomicJournal) {
        return Promise.resolve();
    }
    if (initPromise && initPromiseIdentity === targetIdentity) return initPromise;

    identityTransitioning = true;
    const requestId = ++identityTransitionRequest;
    const run = serializeMutation(async () => {
        if (initialized && activeIdentity === targetIdentity) {
            if (requestId === identityTransitionRequest) identityTransitioning = false;
            return;
        }

        initialized = false;
        clearInMemoryState();
        activeIdentity = targetIdentity;
        identityGeneration += 1;

        // Complete the commit record before any migration or cache load can
        // observe a mixture of pre- and post-transaction files. A signed-in
        // initialization may adopt anonymous work, so repair that scope first.
        if (targetIdentity) {
            await recoverAtomicJournal(null);
        }
        await recoverAtomicJournal(targetIdentity);

        await migrateAnonymousScope(targetIdentity);
        await migrateLegacyScopeIfSafe(targetIdentity);

        const loadedTables: Record<string, Record<string, unknown>> = {};
        for (const table of Object.keys(TABLE_FILES)) {
            loadedTables[table] = await readJsonFile<Record<string, unknown>>(tableFilename(table, targetIdentity), {});
        }

        const loadedQueue = await readJsonFile<SyncQueueItem[]>(queueFilename(targetIdentity), []);
        const queueWithOwners = loadedQueue.map((item) => ({
            ...item,
            // A queue stored inside an identity-scoped file is safely bound to
            // that identity even when upgrading from a short-lived build that
            // did not yet serialize owner_user_id.
            owner_user_id:
                typeof item.owner_user_id === 'string' || item.owner_user_id === null
                    ? item.owner_user_id
                    : targetIdentity,
        }));
        if (queueWithOwners.some((item) => item.owner_user_id !== targetIdentity)) {
            throw new Error('[LocalDB] Sync queue ownership does not match its filesystem scope');
        }
        // A process can be killed after an item is persisted as "syncing".
        // There is no live request after restart, so make those entries
        // eligible again. Every remotely non-idempotent mutation has its own
        // idempotency key before this queue is drained.
        const recoveredQueue = queueWithOwners.map((item) =>
            item.status === 'syncing' ? { ...item, status: 'pending' as const } : item,
        );
        if (
            recoveredQueue.some(
                (item, index) =>
                    item !== queueWithOwners[index] || item.owner_user_id !== loadedQueue[index]?.owner_user_id,
            )
        ) {
            await writeJsonFile(queueFilename(targetIdentity), recoveredQueue);
        }

        // Mutations persist the outbox before their table file. If the process
        // dies between those two writes, replaying the durable queue repairs
        // the local mirror. DELTAs carry their resulting local value so this
        // replay is idempotent even when the table write did complete.
        const replayedTables = replayOutbox(loadedTables, recoveredQueue);
        for (const table of replayedTables) {
            await writeTableState(table, loadedTables[table], targetIdentity);
        }

        const loadedMeta = await readJsonFile<SyncMeta>(metaFilename(targetIdentity), {
            lastPullTimestamp: null,
            lastPushTimestamp: null,
            lastFullPullTimestamp: null,
            deviceId: generateDeviceId(),
            ownerUserId: targetIdentity,
        });
        if (
            Object.prototype.hasOwnProperty.call(loadedMeta, 'ownerUserId') &&
            loadedMeta.ownerUserId !== targetIdentity
        ) {
            throw new Error('[LocalDB] Identity metadata does not match its filesystem scope');
        }
        const normalizedMeta: SyncMeta = {
            ...loadedMeta,
            lastFullPullTimestamp: loadedMeta.lastFullPullTimestamp ?? null,
            ownerUserId: targetIdentity,
        };
        if (loadedMeta.ownerUserId !== normalizedMeta.ownerUserId || loadedMeta.lastFullPullTimestamp === undefined) {
            await writeJsonFile(metaFilename(targetIdentity), normalizedMeta);
        }

        for (const [table, records] of Object.entries(loadedTables)) {
            cache[table] = records;
        }
        syncQueueCache = recoveredQueue;
        syncMetaCache = normalizedMeta;
        initialized = true;
        if (requestId === identityTransitionRequest) identityTransitioning = false;
    }).catch((error) => {
        initialized = false;
        clearInMemoryState();
        if (requestId === identityTransitionRequest) identityTransitioning = false;
        throw error;
    });

    initPromiseIdentity = targetIdentity;
    const readyRun = run.then(async () => {
        try {
            const shoppingService = await import('../ShoppingListService');
            if (typeof shoppingService.reconcileGroceryInventoryMirror === 'function') {
                await shoppingService.reconcileGroceryInventoryMirror();
            }
        } catch (error) {
            // Mirror repair is best effort; its canonical shopping mutation
            // remains durable and the sync engine must still be allowed to run.
            log.warn('[LocalDB] Grocery inventory mirror reconciliation failed:', error);
        }
    });
    const wrappedRun = readyRun.finally(() => {
        if (initPromiseRequestId === requestId) {
            initPromise = null;
            initPromiseIdentity = undefined;
        }
    });
    initPromiseRequestId = requestId;
    initPromise = wrappedRun;
    return wrappedRun;
}

function ensureInit() {
    if (!initialized || identityTransitioning) {
        throw new Error('[LocalDB] Not initialized. Call initLocalDatabase() first.');
    }
}

function clearInMemoryState(): void {
    for (const table of Object.keys(cache)) {
        delete cache[table];
    }
    syncQueueCache = null;
    syncMetaCache = null;
}

export function getLocalDatabaseIdentity(): string | null {
    ensureInit();
    return activeIdentity ?? null;
}

export interface LocalDatabaseSession {
    identity: string | null;
    generation: number;
}

export function getLocalDatabaseSession(): LocalDatabaseSession {
    ensureInit();
    return {
        identity: activeIdentity ?? null,
        generation: identityGeneration,
    };
}

export function isLocalDatabaseSessionCurrent(session: LocalDatabaseSession): boolean {
    return (
        initialized &&
        !identityTransitioning &&
        session.identity === activeIdentity &&
        session.generation === identityGeneration
    );
}

/**
 * Browse mode has its own anonymous scope. Its records are adopted once by the
 * next signed-in account, then the anonymous scope is reset before browse mode
 * is exposed again. This preserves pre-sign-in work without ever mixing two
 * authenticated accounts.
 */
async function migrateAnonymousScope(identity: string | null): Promise<void> {
    const marker = await readJsonFile<AnonymousScopeClaim | null>(ANONYMOUS_CLAIM_FILE, null);

    if (!identity) {
        if (!marker) return;
        for (const table of Object.keys(TABLE_FILES)) {
            await writeJsonFile(tableFilename(table, null), {});
        }
        await writeJsonFile(queueFilename(null), []);
        await writeJsonFile(metaFilename(null), {
            lastPullTimestamp: null,
            lastPushTimestamp: null,
            lastFullPullTimestamp: null,
            deviceId: generateDeviceId(),
            ownerUserId: null,
        } satisfies SyncMeta);
        await deleteJsonFile(ANONYMOUS_CLAIM_FILE);
        return;
    }

    if (marker && marker.ownerUserId !== identity) return;
    if (marker?.completed) return;

    const anonymousTables: Record<string, Record<string, unknown>> = {};
    for (const table of Object.keys(TABLE_FILES)) {
        anonymousTables[table] = await readJsonFile<Record<string, unknown>>(tableFilename(table, null), {});
    }
    const anonymousQueue = await readJsonFile<SyncQueueItem[]>(queueFilename(null), []);
    const hasAnonymousData =
        anonymousQueue.length > 0 || Object.values(anonymousTables).some((records) => Object.keys(records).length > 0);
    if (!hasAnonymousData) return;

    if (!marker) {
        // Bind the handoff before copying. Only this identity can resume a
        // partially completed adoption after a crash.
        await writeJsonFile(ANONYMOUS_CLAIM_FILE, {
            ownerUserId: identity,
            claimedAt: new Date().toISOString(),
            completed: false,
        } satisfies AnonymousScopeClaim);
    }

    for (const [table, anonymousRecords] of Object.entries(anonymousTables)) {
        const destination = tableFilename(table, identity);
        const existing = await readJsonFile<Record<string, unknown>>(destination, {});
        await writeJsonFile(destination, {
            ...anonymousRecords,
            ...existing,
        });
    }

    const destinationQueue = queueFilename(identity);
    const existingQueue = await readJsonFile<SyncQueueItem[]>(destinationQueue, []);
    const existingIds = new Set(existingQueue.map((item) => item.id));
    await writeJsonFile(destinationQueue, [
        ...existingQueue,
        ...anonymousQueue
            .filter((item) => !existingIds.has(item.id))
            .map((item) => ({ ...item, owner_user_id: identity })),
    ]);

    const destinationMeta = metaFilename(identity);
    const existingMeta = await readJsonFile<SyncMeta | null>(destinationMeta, null);
    if (!existingMeta) {
        await writeJsonFile(destinationMeta, {
            lastPullTimestamp: null,
            lastPushTimestamp: null,
            lastFullPullTimestamp: null,
            deviceId: generateDeviceId(),
            ownerUserId: identity,
        } satisfies SyncMeta);
    }
    await writeJsonFile(ANONYMOUS_CLAIM_FILE, {
        ownerUserId: identity,
        claimedAt: marker?.claimedAt ?? new Date().toISOString(),
        completed: true,
    } satisfies AnonymousScopeClaim);
}

/**
 * Older releases stored one global mirror. Import it only when the persisted
 * rows contain a single, explicit owner matching the active account. Ambiguous
 * legacy data is quarantined permanently instead of guessing and exposing it
 * to whichever account happens to sign in first.
 */
async function migrateLegacyScopeIfSafe(identity: string | null): Promise<void> {
    if (!identity) return;

    const files = await listDocumentFiles();
    const marker = await readJsonFile<LegacyScopeClaim | null>(LEGACY_CLAIM_FILE, null);

    if (marker?.state === 'quarantined' || (marker?.state === 'claimed' && marker.ownerUserId !== identity)) {
        return;
    }
    if (marker?.state === 'claimed' && marker.completed) return;

    const legacyTables: Record<string, Record<string, unknown>> = {};
    for (const [table, filename] of Object.entries(TABLE_FILES)) {
        legacyTables[table] = await readJsonFile<Record<string, unknown>>(filename, {});
    }
    const legacyQueue = await readJsonFile<SyncQueueItem[]>(LEGACY_SYNC_QUEUE_FILE, []);
    const legacyMeta = await readJsonFile<Partial<SyncMeta> | null>(LEGACY_SYNC_META_FILE, null);
    const hasLegacyData =
        legacyQueue.length > 0 || Object.values(legacyTables).some((records) => Object.keys(records).length > 0);
    if (!hasLegacyData) return;

    if (!marker) {
        const owners = collectLegacyOwners(legacyTables, legacyQueue, legacyMeta);
        if (owners.size !== 1 || !owners.has(identity)) {
            await writeJsonFile(LEGACY_CLAIM_FILE, {
                state: 'quarantined',
                ownerUserId: null,
                claimedAt: new Date().toISOString(),
                reason: owners.size === 0 ? 'missing-owner-evidence' : 'ambiguous-owner-evidence',
            } satisfies LegacyScopeClaim);
            log.warn('[LocalDB] Quarantined ambiguous legacy offline data instead of assigning it to an account');
            return;
        }

        // Claim first. A crash can leave a partial copy, but only this same
        // identity is permitted to resume it on the next launch.
        await writeJsonFile(LEGACY_CLAIM_FILE, {
            state: 'claimed',
            ownerUserId: identity,
            claimedAt: new Date().toISOString(),
            completed: false,
        } satisfies LegacyScopeClaim);
    }

    for (const [table, records] of Object.entries(legacyTables)) {
        const destination = tableFilename(table, identity);
        const existing = await readJsonFile<Record<string, unknown>>(destination, {});
        await writeJsonFile(destination, {
            ...records,
            ...existing,
        });
    }

    const scopedQueue = legacyQueue.map((item) => ({
        ...item,
        owner_user_id: identity,
    }));
    const destinationQueue = queueFilename(identity);
    const existingQueue = await readJsonFile<SyncQueueItem[]>(destinationQueue, []);
    const existingQueueIds = new Set(existingQueue.map((item) => item.id));
    await writeJsonFile(destinationQueue, [
        ...existingQueue,
        ...scopedQueue.filter((item) => !existingQueueIds.has(item.id)),
    ]);

    const destinationMeta = metaFilename(identity);
    if (!files.has(destinationMeta)) {
        await writeJsonFile(destinationMeta, {
            lastPullTimestamp: legacyMeta?.lastPullTimestamp ?? null,
            lastPushTimestamp: legacyMeta?.lastPushTimestamp ?? null,
            lastFullPullTimestamp: null,
            deviceId: legacyMeta?.deviceId || generateDeviceId(),
            ownerUserId: identity,
        } satisfies SyncMeta);
    }
    await writeJsonFile(LEGACY_CLAIM_FILE, {
        state: 'claimed',
        ownerUserId: identity,
        claimedAt: marker?.claimedAt ?? new Date().toISOString(),
        completed: true,
    } satisfies LegacyScopeClaim);
}

function collectLegacyOwners(
    tables: Record<string, Record<string, unknown>>,
    queue: SyncQueueItem[],
    meta: Partial<SyncMeta> | null,
): Set<string> {
    const owners = new Set<string>();
    const addOwner = (value: unknown) => {
        if (typeof value === 'string' && value.trim()) owners.add(value.trim());
    };

    addOwner(meta?.ownerUserId);
    for (const records of Object.values(tables)) {
        for (const record of Object.values(records)) {
            if (record && typeof record === 'object') {
                addOwner((record as Record<string, unknown>).user_id);
            }
        }
    }
    for (const item of queue) {
        addOwner(item.owner_user_id);
        try {
            const payload = JSON.parse(item.payload) as Record<string, unknown>;
            addOwner(payload.user_id);
        } catch {
            // Malformed payloads remain quarantined unless other explicit
            // evidence can bind the complete legacy dataset safely.
        }
    }
    return owners;
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
 * Commit several table changes and their complete outbox history under one
 * durable write-ahead journal.
 *
 * Once the journal is on disk, the transaction is committed. If the process
 * stops while the queue or any table file is being replaced, initialization
 * deterministically finishes those exact snapshots. Queue operation UUIDs are
 * therefore never regenerated on retry or restart.
 */
export async function atomicLocalTransaction<T>(operation: (transaction: LocalTransaction) => T): Promise<T> {
    ensureInit();
    const expectedIdentity = activeIdentity ?? null;
    const expectedGeneration = identityGeneration;

    return serializeMutation(async () => {
        if (activeIdentity !== expectedIdentity || identityGeneration !== expectedGeneration) {
            throw new Error('[LocalDB] Identity changed before the local transaction could start');
        }

        const changedTables = new Map<string, Record<string, unknown>>();
        let nextQueue = syncQueueCache || [];

        const readTable = (tableName: string): Record<string, unknown> => {
            if (!TABLE_FILES[tableName]) {
                throw new Error(`[LocalDB] Unsupported table: ${tableName}`);
            }
            return changedTables.get(tableName) || cache[tableName] || {};
        };
        const mutableTable = (tableName: string): Record<string, unknown> => {
            const staged = changedTables.get(tableName);
            if (staged) return staged;
            const draft = { ...readTable(tableName) };
            changedTables.set(tableName, draft);
            return draft;
        };

        const transaction: LocalTransaction = {
            getById<Row>(tableName: string, id: string): Row | null {
                return (readTable(tableName)[id] as Row) || null;
            },
            getAll<Row>(tableName: string): Row[] {
                return Object.values(readTable(tableName)) as Row[];
            },
            query<Row>(tableName: string, predicate: (item: Row) => boolean): Row[] {
                return (Object.values(readTable(tableName)) as Row[]).filter(predicate);
            },
            insert<Row extends { id: string }>(tableName: string, record: Row): Row {
                mutableTable(tableName)[record.id] = record;
                nextQueue = appendSync(nextQueue, tableName, record.id, 'INSERT', record);
                return record;
            },
            update<Row extends { id: string; updated_at?: string }>(
                tableName: string,
                id: string,
                updates: Partial<Row>,
            ): Row | null {
                const table = readTable(tableName);
                const existing = table[id] as Row | undefined;
                if (!existing) return null;

                const updated = {
                    ...existing,
                    ...updates,
                    updated_at: new Date().toISOString(),
                } as Row;
                mutableTable(tableName)[id] = updated;
                nextQueue = appendSync(nextQueue, tableName, id, 'UPDATE', {
                    ...updates,
                    updated_at: updated.updated_at,
                });
                return updated;
            },
            delta<Row extends { id: string; updated_at?: string }>(
                tableName: string,
                id: string,
                field: string,
                delta: number,
            ): Row | null {
                if (!Number.isFinite(delta)) {
                    throw new RangeError('Delta must be a finite number.');
                }
                const table = readTable(tableName);
                const existing = table[id] as Row | undefined;
                if (!existing) return null;

                const rawCurrent = (existing as Record<string, unknown>)[field];
                const current = typeof rawCurrent === 'number' && Number.isFinite(rawCurrent) ? rawCurrent : 0;
                const updated = {
                    ...existing,
                    [field]: Math.max(0, current + delta),
                    updated_at: new Date().toISOString(),
                } as Row;
                mutableTable(tableName)[id] = updated;
                nextQueue = appendSync(nextQueue, tableName, id, 'DELTA', {
                    id,
                    field,
                    delta,
                    local_value: (updated as Record<string, unknown>)[field],
                    updated_at: updated.updated_at,
                });
                return updated;
            },
            delete(tableName: string, id: string): boolean {
                if (!readTable(tableName)[id]) return false;
                delete mutableTable(tableName)[id];
                nextQueue = appendSync(nextQueue, tableName, id, 'DELETE', { id });
                return true;
            },
        };

        const result = operation(transaction);
        if (
            result !== null &&
            (typeof result === 'object' || typeof result === 'function') &&
            typeof (result as { then?: unknown }).then === 'function'
        ) {
            throw new TypeError('[LocalDB] atomicLocalTransaction callback must be synchronous');
        }
        if (changedTables.size === 0) return result;

        const journal: AtomicTransactionJournal = {
            version: 1,
            transactionId: generateUUID(),
            ownerUserId: expectedIdentity,
            createdAt: new Date().toISOString(),
            queue: nextQueue,
            tables: Object.fromEntries(changedTables),
        };

        // This is the commit point. Cache state changes only after the exact
        // outbox IDs and table snapshots are durably recoverable.
        await writeJsonFile(transactionFilename(expectedIdentity), journal);
        pendingAtomicJournal = journal;
        for (const [tableName, table] of changedTables) {
            cache[tableName] = table;
        }
        syncQueueCache = nextQueue;

        await finishAtomicJournal(journal, expectedIdentity);
        return result;
    });
}

/**
 * Insert a record locally + queue for sync.
 */
export async function insertLocal<T extends { id: string }>(tableName: string, record: T): Promise<T> {
    ensureInit();
    return serializeMutation(async () => {
        const previousTable = cache[tableName] || {};
        const previousQueue = syncQueueCache || [];
        const nextTable = { ...previousTable, [record.id]: record };
        const nextQueue = appendSync(previousQueue, tableName, record.id, 'INSERT', record);

        await persistTableAndQueue(tableName, nextTable, nextQueue, previousTable, previousQueue);
        cache[tableName] = nextTable;
        syncQueueCache = nextQueue;
        return record;
    });
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
    return serializeMutation(async () => {
        const previousTable = cache[tableName] || {};
        const existing = previousTable[id];
        if (!existing) return null;

        const updated = {
            ...(existing as T),
            ...updates,
            updated_at: new Date().toISOString(),
        };
        const remoteUpdates = {
            ...updates,
            updated_at: updated.updated_at,
        };
        const previousQueue = syncQueueCache || [];
        const nextTable = { ...previousTable, [id]: updated };
        const nextQueue = appendSync(previousQueue, tableName, id, 'UPDATE', remoteUpdates);

        await persistTableAndQueue(tableName, nextTable, nextQueue, previousTable, previousQueue);
        cache[tableName] = nextTable;
        syncQueueCache = nextQueue;
        return updated as T;
    });
}

/**
 * Delete a record locally + queue for sync.
 */
export async function deleteLocal(tableName: string, id: string): Promise<void> {
    ensureInit();
    await serializeMutation(async () => {
        const previousTable = cache[tableName] || {};
        if (!previousTable[id]) return;

        const previousQueue = syncQueueCache || [];
        const nextTable = { ...previousTable };
        delete nextTable[id];
        const nextQueue = appendSync(previousQueue, tableName, id, 'DELETE', { id });

        await persistTableAndQueue(tableName, nextTable, nextQueue, previousTable, previousQueue);
        cache[tableName] = nextTable;
        syncQueueCache = nextQueue;
    });
}

/**
 * Apply a DELTA mutation to a numeric field.
 * Instead of storing the absolute value, stores only the change (+1, -3, etc.).
 * This prevents data loss when multiple crew members adjust quantities offline.
 */
export async function deltaLocal<T extends { id: string; updated_at?: string }>(
    tableName: string,
    id: string,
    field: string,
    delta: number,
): Promise<T | null> {
    ensureInit();
    if (!Number.isFinite(delta)) {
        throw new RangeError('Delta must be a finite number.');
    }

    return serializeMutation(async () => {
        const previousTable = cache[tableName] || {};
        const existing = previousTable[id] as T | undefined;
        if (!existing) return null;

        const rawCurrent = (existing as Record<string, unknown>)[field];
        const current = typeof rawCurrent === 'number' && Number.isFinite(rawCurrent) ? rawCurrent : 0;
        const updated = {
            ...existing,
            [field]: Math.max(0, current + delta),
            updated_at: new Date().toISOString(),
        };
        const previousQueue = syncQueueCache || [];
        const nextTable = { ...previousTable, [id]: updated };
        const nextQueue = appendSync(previousQueue, tableName, id, 'DELTA', {
            id,
            field,
            delta,
            local_value: (updated as Record<string, unknown>)[field],
            updated_at: (updated as Record<string, unknown>).updated_at,
        });

        await persistTableAndQueue(tableName, nextTable, nextQueue, previousTable, previousQueue);
        cache[tableName] = nextTable;
        syncQueueCache = nextQueue;
        return updated as T;
    });
}

/**
 * Bulk upsert records (used by sync pull — does NOT queue for push).
 */
export async function bulkUpsert<T extends { id: string }>(tableName: string, records: T[]): Promise<void> {
    ensureInit();
    await serializeMutation(async () => {
        const nextTable = { ...(cache[tableName] || {}) };
        for (const record of records) {
            nextTable[record.id] = record;
        }
        await writeTableState(tableName, nextTable);
        cache[tableName] = nextTable;
    });
}

/**
 * Merge server rows while atomically fencing every record that still has an
 * outbox entry. The dirty check and cache write share the mutation lock, so a
 * local edit cannot slip between conflict detection and persistence.
 */
export async function mergePulledRecords<T extends { id: string; updated_at?: string; created_at?: string }>(
    tableName: string,
    records: T[],
): Promise<number> {
    ensureInit();
    return serializeMutation(async () => {
        const dirtyIds = new Set(
            (syncQueueCache || []).filter((item) => item.table_name === tableName).map((item) => item.record_id),
        );
        const previousTable = cache[tableName] || {};
        const nextTable = { ...previousTable };
        let merged = 0;

        for (const serverRecord of records) {
            if (dirtyIds.has(serverRecord.id)) continue;
            // Once no outbox entry exists, the remote row is authoritative.
            // Device-clock comparisons can permanently preserve a clock-ahead
            // cache row after the shared cursor has already advanced.
            nextTable[serverRecord.id] = serverRecord;
            merged += 1;
        }

        if (merged > 0) {
            await writeTableState(tableName, nextTable);
            cache[tableName] = nextTable;
        }
        return merged;
    });
}

/**
 * Finish an authoritative full-table reconciliation by removing clean rows
 * that are no longer visible to this identity. Dirty rows are retained until
 * their bound outbox operation succeeds or surfaces an authorization error.
 */
export async function prunePulledTable(tableName: string, visibleIds: ReadonlySet<string>): Promise<number> {
    ensureInit();
    return serializeMutation(async () => {
        const dirtyIds = new Set(
            (syncQueueCache || []).filter((item) => item.table_name === tableName).map((item) => item.record_id),
        );
        const previousTable = cache[tableName] || {};
        const nextTable = { ...previousTable };
        let removed = 0;

        for (const id of Object.keys(previousTable)) {
            if (!visibleIds.has(id) && !dirtyIds.has(id)) {
                delete nextTable[id];
                removed += 1;
            }
        }

        if (removed > 0) {
            await writeTableState(tableName, nextTable);
            cache[tableName] = nextTable;
        }
        return removed;
    });
}

/**
 * Apply one Supabase Realtime change to the local mirror.
 *
 * The dirty-record fence is the same one used by incremental pulls: an
 * outstanding local mutation always wins until its outbox chain is resolved.
 * DELETE events are applied directly because a timestamp-only pull cannot
 * discover rows that no longer exist.
 */
export async function applyRealtimeChange(
    tableName: string,
    eventType: 'INSERT' | 'UPDATE' | 'DELETE',
    record: {
        id: string;
        updated_at?: string;
        created_at?: string;
        [field: string]: unknown;
    },
    expectedSession?: LocalDatabaseSession,
): Promise<boolean> {
    ensureInit();
    const operationSession = expectedSession ?? getLocalDatabaseSession();
    if (!isLocalDatabaseSessionCurrent(operationSession)) return false;

    return serializeMutation(async () => {
        // A realtime callback can sit behind an earlier filesystem mutation
        // while auth switches accounts. Never apply that delayed row to the
        // database which happens to be active when its turn arrives.
        if (!isLocalDatabaseSessionCurrent(operationSession)) return false;
        if (!TABLE_FILES[tableName]) {
            throw new Error(`[LocalDB] Unsupported table: ${tableName}`);
        }
        if (!record?.id) {
            throw new Error('[LocalDB] Realtime change is missing a record ID');
        }

        const dirty = (syncQueueCache || []).some(
            (item) => item.table_name === tableName && item.record_id === record.id,
        );
        if (dirty) return false;

        const previousTable = cache[tableName] || {};
        const nextTable = { ...previousTable };

        if (eventType === 'DELETE') {
            if (!previousTable[record.id]) return false;
            delete nextTable[record.id];
        } else {
            nextTable[record.id] = record;
        }

        await writeTableState(tableName, nextTable);
        cache[tableName] = nextTable;
        return true;
    });
}

/**
 * Bulk delete records by IDs (used by sync — does NOT queue).
 */
export async function bulkDelete(tableName: string, ids: string[]): Promise<void> {
    ensureInit();
    await serializeMutation(async () => {
        const nextTable = { ...(cache[tableName] || {}) };
        for (const id of ids) {
            delete nextTable[id];
        }
        await writeTableState(tableName, nextTable);
        cache[tableName] = nextTable;
    });
}

// ── Sync Queue ─────────────────────────────────────────────────

/**
 * Add a mutation to the sync outbox.
 */
function appendSync(
    queue: SyncQueueItem[],
    tableName: string,
    recordId: string,
    mutationType: MutationType,
    payload: unknown,
): SyncQueueItem[] {
    const item: SyncQueueItem = {
        id: generateUUID(),
        table_name: tableName,
        record_id: recordId,
        mutation_type: mutationType,
        payload: JSON.stringify(payload),
        created_at: new Date().toISOString(),
        status: 'pending',
        retry_count: 0,
        owner_user_id: activeIdentity ?? null,
    };
    // Preserve the full per-record history. In particular, replacing INSERT
    // with UPDATE/DELTA loses the remote creation, and replacing DELTAs loses
    // stock changes from offline crew.
    return [...queue, item];
}

/**
 * Get all pending items from the sync queue.
 */
export function getPendingQueue(): SyncQueueItem[] {
    ensureInit();
    return (syncQueueCache || []).filter((q) => q.status === 'pending').map((item) => ({ ...item }));
}

/**
 * Get all items in the sync queue (including syncing/failed).
 */
export function getFullQueue(): SyncQueueItem[] {
    ensureInit();
    return (syncQueueCache || []).map((item) => ({ ...item }));
}

/**
 * Mark queue items as syncing (lock them before push).
 */
export async function markSyncing(ids: string[]): Promise<void> {
    await mutateQueue(ids, (item) => ({ ...item, status: 'syncing' }));
}

/**
 * Remove successfully synced items from the queue.
 */
export async function removeSynced(ids: string[]): Promise<void> {
    ensureInit();
    await serializeMutation(async () => {
        const idSet = new Set(ids);
        const nextQueue = (syncQueueCache || []).filter((item) => !idSet.has(item.id));
        await writeJsonFile(queueFilename(), nextQueue);
        syncQueueCache = nextQueue;
    });
}

/**
 * Mark items as failed with error messages.
 */
export async function markFailed(ids: string[], error: string): Promise<void> {
    await mutateQueue(ids, (item) => ({
        ...item,
        status: 'failed',
        retry_count: item.retry_count + 1,
        error_message: error,
    }));
}

/**
 * Retry failed items (reset to pending).
 */
export async function retryFailed(): Promise<void> {
    ensureInit();
    await serializeMutation(async () => {
        const nextQueue = (syncQueueCache || []).map((item) =>
            item.status === 'failed' ? { ...item, status: 'pending' as const, error_message: undefined } : item,
        );
        await writeJsonFile(queueFilename(), nextQueue);
        syncQueueCache = nextQueue;
    });
}

/**
 * Get the number of pending mutations.
 */
export function getPendingCount(): number {
    return getPendingQueue().length;
}

export function getFailedCount(): number {
    ensureInit();
    return (syncQueueCache || []).filter((item) => item.status === 'failed').length;
}

// ── Sync Metadata ──────────────────────────────────────────────

export function getSyncMeta(): SyncMeta {
    ensureInit();
    return {
        ...(syncMetaCache || {
            lastPullTimestamp: null,
            lastPushTimestamp: null,
            lastFullPullTimestamp: null,
            deviceId: '',
            ownerUserId: activeIdentity ?? null,
        }),
    };
}

export async function updateSyncMeta(updates: Partial<SyncMeta>): Promise<void> {
    ensureInit();
    await serializeMutation(async () => {
        const nextMeta = { ...getSyncMeta(), ...updates };
        if (nextMeta.ownerUserId !== activeIdentity) {
            throw new Error('[LocalDB] Cannot change sync metadata ownership');
        }
        await writeJsonFile(metaFilename(), nextMeta);
        syncMetaCache = nextMeta;
    });
}

// ── Flush Helpers ──────────────────────────────────────────────

function validateAtomicJournal(journal: AtomicTransactionJournal, identity: string | null): AtomicTransactionJournal {
    if (
        !journal ||
        journal.version !== 1 ||
        typeof journal.transactionId !== 'string' ||
        journal.ownerUserId !== identity ||
        !Array.isArray(journal.queue) ||
        !journal.tables ||
        typeof journal.tables !== 'object'
    ) {
        throw new Error('[LocalDB] Invalid or cross-account local transaction journal');
    }
    if (journal.queue.some((item) => item.owner_user_id !== identity)) {
        throw new Error('[LocalDB] Local transaction queue ownership does not match its filesystem scope');
    }
    for (const [tableName, table] of Object.entries(journal.tables)) {
        if (!TABLE_FILES[tableName] || !table || typeof table !== 'object' || Array.isArray(table)) {
            throw new Error(`[LocalDB] Invalid transaction table snapshot: ${tableName}`);
        }
    }
    return journal;
}

async function finishAtomicJournal(journal: AtomicTransactionJournal, identity: string | null): Promise<void> {
    const validated = validateAtomicJournal(journal, identity);
    await writeJsonFile(queueFilename(identity), validated.queue);
    for (const [tableName, table] of Object.entries(validated.tables)) {
        await writeTableState(tableName, table, identity);
    }
    await deleteJsonFile(transactionFilename(identity));
    if (pendingAtomicJournal?.transactionId === validated.transactionId) {
        pendingAtomicJournal = null;
    }
}

async function recoverAtomicJournal(identity: string | null): Promise<void> {
    const journal = await readJsonFile<AtomicTransactionJournal | null>(transactionFilename(identity), null);
    if (!journal) return;
    await finishAtomicJournal(journal, identity);
}

async function writeTableState(
    tableName: string,
    table: Record<string, unknown>,
    identity = activeIdentity,
): Promise<void> {
    await writeJsonFile(tableFilename(tableName, identity), table);
}

async function persistTableAndQueue(
    tableName: string,
    nextTable: Record<string, unknown>,
    nextQueue: SyncQueueItem[],
    previousTable: Record<string, unknown>,
    previousQueue: SyncQueueItem[],
): Promise<void> {
    // Outbox first: a crash between files leaves a replayable operation rather
    // than an untracked local mutation.
    await writeJsonFile(queueFilename(), nextQueue);
    try {
        await writeTableState(tableName, nextTable);
    } catch (error) {
        // Best-effort restoration. The caller still receives the original
        // failure even when a native filesystem plugin fails repeatedly.
        const restored = await Promise.allSettled([
            writeJsonFile(queueFilename(), previousQueue),
            writeTableState(tableName, previousTable),
        ]);
        if (restored.some((result) => result.status === 'rejected')) {
            log.error('[LocalDB] Failed to restore a partially persisted local mutation');
        }
        throw error;
    }
}

async function mutateQueue(ids: string[], transform: (item: SyncQueueItem) => SyncQueueItem): Promise<void> {
    ensureInit();
    await serializeMutation(async () => {
        const idSet = new Set(ids);
        const nextQueue = (syncQueueCache || []).map((item) => (idSet.has(item.id) ? transform(item) : item));
        await writeJsonFile(queueFilename(), nextQueue);
        syncQueueCache = nextQueue;
    });
}

function replayOutbox(tables: Record<string, Record<string, unknown>>, queue: SyncQueueItem[]): Set<string> {
    const changedTables = new Set<string>();

    for (const item of queue) {
        if (!TABLE_FILES[item.table_name]) continue;

        try {
            const payload = JSON.parse(item.payload) as Record<string, unknown>;
            const table = tables[item.table_name] || (tables[item.table_name] = {});

            switch (item.mutation_type) {
                case 'INSERT':
                    table[item.record_id] = { ...payload, id: item.record_id };
                    changedTables.add(item.table_name);
                    break;
                case 'UPDATE':
                    if (table[item.record_id]) {
                        table[item.record_id] = {
                            ...(table[item.record_id] as Record<string, unknown>),
                            ...payload,
                            id: item.record_id,
                        };
                        changedTables.add(item.table_name);
                    }
                    break;
                case 'DELTA': {
                    const field = payload.field;
                    const localValue = payload.local_value;
                    if (
                        table[item.record_id] &&
                        typeof field === 'string' &&
                        typeof localValue === 'number' &&
                        Number.isFinite(localValue)
                    ) {
                        table[item.record_id] = {
                            ...(table[item.record_id] as Record<string, unknown>),
                            [field]: localValue,
                            ...(typeof payload.updated_at === 'string' ? { updated_at: payload.updated_at } : {}),
                        };
                        changedTables.add(item.table_name);
                    }
                    break;
                }
                case 'DELETE':
                    delete table[item.record_id];
                    changedTables.add(item.table_name);
                    break;
                default:
                    throw new Error(`Unsupported outbox mutation type: ${String(item.mutation_type)}`);
            }
        } catch (error) {
            // Leave a malformed entry in the queue so SyncService can surface
            // and quarantine it instead of silently discarding user intent.
            log.error(`[LocalDB] Could not replay outbox item ${item.id}:`, error);
        }
    }

    return changedTables;
}

// ── Utilities ──────────────────────────────────────────────────

function generateUUID(): string {
    if (globalThis.crypto?.randomUUID) {
        return globalThis.crypto.randomUUID();
    }
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
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
