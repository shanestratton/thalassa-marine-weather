/**
 * SyncService — Background push/pull engine for Vessel Hub.
 *
 * Push (Up): Drains the sync_queue outbox → Supabase.
 * Pull (Down): Bounded keyset fetch by updated_at/id → local merge.
 * Conflict: Outstanding local outbox entries are fenced; otherwise the server
 * is authoritative.
 *
 * Network awareness: Listens for online/offline transitions.
 * When connectivity resumes, triggers a full sync cycle.
 */
import { supabase } from '../supabase';
import {
    getFullQueue,
    markSyncing,
    removeSynced,
    markFailed,
    retryFailed,
    getSyncMeta,
    updateSyncMeta,
    mergePulledRecords,
    prunePulledTable,
    getLocalDatabaseSession,
    isLocalDatabaseSessionCurrent,
    getById,
    bulkDelete,
    rewriteQueuedInsert,
    type LocalDatabaseSession,
    type SyncQueueItem,
} from './LocalDatabase';
import {
    anySkipperGrantsWrite,
    binderWriteGranted,
    refreshSharedBinders,
    TABLE_REGISTER,
    type BinderRegister,
} from './sharedBinders';

import { createLogger } from '../../utils/createLogger';
import { triggerHaptic } from '../../utils/system';

const log = createLogger('SyncService');

// ── Types ──────────────────────────────────────────────────────

interface SyncResult {
    pushed: number;
    pulled: number;
    errors: string[];
    /**
     * Queued changes to a skipper's binder rows dropped because a fresh share
     * snapshot shows the skipper no longer grants write (sharedBinders.ts).
     */
    discardedShared?: number;
    /**
     * Rows the sailor ADDED to such a binder that were kept by moving them
     * into the sailor's own binder instead (nobody else could take them).
     */
    rehomedShared?: number;
    /** The skippers whose binders those changes were meant for. */
    sharedOwnerIds?: string[];
}

type SyncListener = (result: SyncResult) => void;
type StatusListener = (status: SyncStatus) => void;

export type SyncStatus = 'idle' | 'syncing' | 'error' | 'offline';

// ── Supabase table config ──────────────────────────────────────

const SYNCABLE_TABLES = [
    'inventory_items',
    'maintenance_tasks',
    'maintenance_history',
    'equipment_register',
    'ship_documents',
    'recipes',
    'passage_provisions',
    'meal_plans',
    'shopping_list',
    'crew_profiles',
    'checklists',
    'checklist_runs',
] as const;
const PULL_PAGE_SIZE = 500;
const PULL_REPLAY_OVERLAP_MS = 5 * 60 * 1000;
const FULL_RECONCILIATION_INTERVAL_MS = 6 * 60 * 60 * 1000;

type SyncableTable = (typeof SYNCABLE_TABLES)[number];

/** Tables that have file URIs which need uploading before sync */
const FILE_URI_FIELDS: Partial<Record<SyncableTable, string>> = {
    equipment_register: 'manual_uri',
    ship_documents: 'file_uri',
};
const FILE_STORAGE_SUBFOLDERS: Partial<Record<SyncableTable, string>> = {
    equipment_register: 'equipment',
    ship_documents: 'documents',
};
const VESSEL_VAULT_BUCKET = 'vessel_vault';
const VESSEL_VAULT_URI_PREFIX = `supabase-storage://${VESSEL_VAULT_BUCKET}/`;
const STORAGE_LIST_PAGE_SIZE = 100;

// ── Singleton state ────────────────────────────────────────────

let currentStatus: SyncStatus = 'idle';
let activeSync: Promise<SyncResult> | null = null;
let syncInterval: ReturnType<typeof setInterval> | null = null;
let initialSyncTimeout: ReturnType<typeof setTimeout> | null = null;
let engineStarted = false;
let fullReconciliationRequestVersion = 0;
let fullReconciliationCompletedVersion = 0;
let fullReconciliationFollowup: Promise<SyncResult> | null = null;
let forcedPullInFlight = false;
const listeners: SyncListener[] = [];
const statusListeners: StatusListener[] = [];

// ── Status management ──────────────────────────────────────────

function setStatus(status: SyncStatus) {
    currentStatus = status;
    statusListeners.forEach((fn) => fn(status));
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
    if (engineStarted) return;
    engineStarted = true;

    // Listen for online/offline events
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);

    // Initial check
    if (navigator.onLine) {
        // Delay first sync slightly to let app boot finish
        initialSyncTimeout = setTimeout(() => {
            initialSyncTimeout = null;
            void syncNow();
        }, 2000);
    } else {
        setStatus('offline');
    }

    // Periodic sync every 5 minutes when online
    syncInterval = setInterval(
        () => {
            if (navigator.onLine && !activeSync) {
                syncNow();
            }
        },
        5 * 60 * 1000,
    );
}

/**
 * Stop the sync engine and remove listeners.
 */
export function stopSyncEngine(): void {
    engineStarted = false;
    window.removeEventListener('online', handleOnline);
    window.removeEventListener('offline', handleOffline);
    if (initialSyncTimeout) {
        clearTimeout(initialSyncTimeout);
        initialSyncTimeout = null;
    }
    if (syncInterval) {
        clearInterval(syncInterval);
        syncInterval = null;
    }
}

function handleOnline() {
    // Every cycle requeues transient failures before draining the outbox.
    void syncNow();
}

function handleOffline() {
    setStatus('offline');
}

// ── Main Sync Loop ─────────────────────────────────────────────

/**
 * Execute a full sync cycle: Push → Pull.
 * Concurrent callers share the same in-flight result.
 */
export function syncNow(): Promise<SyncResult> {
    if (activeSync) return activeSync;
    if (!navigator.onLine) {
        setStatus('offline');
        return Promise.resolve({ pushed: 0, pulled: 0, errors: ['offline'] });
    }

    if (!supabase) {
        return Promise.resolve({ pushed: 0, pulled: 0, errors: ['Supabase not configured'] });
    }
    try {
        if (!getLocalDatabaseSession().identity) {
            // Browse mode is intentionally local-only. Keep its durable
            // anonymous outbox for one-time adoption without presenting a
            // background sync failure to the signed-out user.
            setStatus('idle');
            return Promise.resolve({ pushed: 0, pulled: 0, errors: ['signed-out'] });
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : 'Local database unavailable';
        return Promise.resolve({ pushed: 0, pulled: 0, errors: [message] });
    }

    const cycle = runSyncCycle();
    const sharedCycle = cycle.finally(() => {
        activeSync = null;
    });
    activeSync = sharedCycle;
    return sharedCycle;
}

/**
 * Queue an authoritative visibility reconciliation. Calls made during an
 * active cycle coalesce into one follow-up cycle, so a burst of vessel_crew
 * realtime events cannot create an unbounded sync loop.
 */
export function requestFullReconciliation(): Promise<SyncResult> {
    fullReconciliationRequestVersion += 1;

    if (!activeSync) return syncNow();
    if (fullReconciliationFollowup) return fullReconciliationFollowup;

    fullReconciliationFollowup = activeSync
        .catch(() => ({ pushed: 0, pulled: 0, errors: ['Previous sync failed'] }))
        .then(() => {
            fullReconciliationFollowup = null;
            return fullReconciliationRequestVersion > fullReconciliationCompletedVersion
                ? syncNow()
                : { pushed: 0, pulled: 0, errors: [] };
        });
    return fullReconciliationFollowup;
}

/**
 * True while a requested full reconciliation has not completed yet, or one is
 * pulling right now. A shared binder that is still empty uses this to say
 * "Bringing in the skipper's binder…" rather than "nothing here".
 */
export function isFullReconciliationPending(): boolean {
    return forcedPullInFlight || fullReconciliationRequestVersion > fullReconciliationCompletedVersion;
}

async function runSyncCycle(): Promise<SyncResult> {
    setStatus('syncing');
    const result: SyncResult = {
        pushed: 0,
        pulled: 0,
        errors: [],
        discardedShared: 0,
        rehomedShared: 0,
        sharedOwnerIds: [],
    };
    let reconciliationVersionAtStart = fullReconciliationRequestVersion;

    try {
        const databaseSession = getLocalDatabaseSession();
        if (!databaseSession.identity) {
            throw new Error('Offline sync requires an authenticated identity scope');
        }
        const authenticatedUserId = await requireAuthenticatedIdentity(databaseSession.identity);
        assertDatabaseSession(databaseSession);

        // Whose binders this account sees (sharedBinders.ts), refreshed BEFORE
        // the push so the outbox is judged against the current shares. Any
        // change of owner, register, read, write or selection forces the full
        // reconciliation below: rows of a new share can be older than the
        // incremental watermark, and rows of an ended share must be pruned.
        // It is requested (not just forced) so a failed pull retries it. A
        // failed refresh keeps the cached snapshot: no forced pull, and no
        // queued change is discarded on its say-so.
        let binderSnapshotFresh = false;
        try {
            const binders = await refreshSharedBinders();
            binderSnapshotFresh = binders.fresh;
            if (binders.changed) {
                fullReconciliationRequestVersion += 1;
                reconciliationVersionAtStart = fullReconciliationRequestVersion;
            }
        } catch (error) {
            log.warn(
                '[SyncService] Shared binder refresh failed; keeping the cached snapshot:',
                error instanceof Error ? error.message : error,
            );
        }
        assertDatabaseSession(databaseSession);

        let forceFull = reconciliationVersionAtStart > fullReconciliationCompletedVersion;

        // Failed mutations must not wait for an offline→online edge. This also
        // retries requests that failed because a session was temporarily
        // unavailable while the device remained online.
        await retryFailed();
        assertDatabaseSession(databaseSession);

        // ── Phase 1: PUSH (drain outbox) ──
        const pushResult = await pushMutations(databaseSession, authenticatedUserId, binderSnapshotFresh);
        result.pushed = pushResult.count;
        result.discardedShared = pushResult.discarded;
        result.rehomedShared = pushResult.rehomed;
        result.sharedOwnerIds = pushResult.ownerIds;
        if (pushResult.errors.length > 0) {
            result.errors.push(...pushResult.errors);
        }
        assertDatabaseSession(databaseSession);
        // A dropped edit of a skipper's row left the local copy as the sailor
        // edited it. Pull every table in full now, so the server's copy comes
        // back (still readable) or the row is pruned (no longer shared).
        if (pushResult.restoreFromServer) {
            fullReconciliationRequestVersion += 1;
            reconciliationVersionAtStart = fullReconciliationRequestVersion;
            forceFull = true;
        }

        // ── Phase 2: PULL (incremental fetch) ──
        if (forceFull) forcedPullInFlight = true;
        const pullResult = await pullUpdates(forceFull, databaseSession).finally(() => {
            forcedPullInFlight = false;
        });
        result.pulled = pullResult.count;
        if (pullResult.errors.length > 0) {
            result.errors.push(...pullResult.errors);
        } else if (forceFull) {
            fullReconciliationCompletedVersion = Math.max(
                fullReconciliationCompletedVersion,
                reconciliationVersionAtStart,
            );
        }

        setStatus(result.errors.length > 0 ? 'error' : 'idle');
    } catch (e) {
        const msg = e instanceof Error ? e.message : 'Unknown sync error';
        result.errors.push(msg);
        setStatus('error');
        log.error('[SyncService] Sync failed:', msg);
    }

    // Notify listeners
    listeners.forEach((fn) => fn(result));

    // Haptic pulse on successful sync
    if (result.pushed > 0 || result.pulled > 0) {
        triggerHaptic('light');
    }

    return result;
}

function assertDatabaseSession(session: LocalDatabaseSession): void {
    if (!isLocalDatabaseSessionCurrent(session)) {
        throw new Error('Local database identity changed during sync');
    }
}

async function requireAuthenticatedIdentity(expectedUserId: string): Promise<string> {
    if (!supabase) throw new Error('Supabase not configured');
    const {
        data: { user },
        error,
    } = await supabase.auth.getUser();
    if (error) throw new Error(error.message);
    if (!user) throw new Error('Not authenticated');
    if (user.id !== expectedUserId) {
        throw new Error('Authenticated user does not match the local database identity');
    }
    return user.id;
}

// ── Phase 1: PUSH ──────────────────────────────────────────────

/**
 * A queued change to a SKIPPER'S binder row (by its local row, or for an
 * INSERT its payload user_id) whose register the fresh share snapshot no
 * longer lets this sailor write. Rows the sailor owns never qualify.
 */
function orphanedSharedMutation(
    item: SyncQueueItem,
    authenticatedUserId: string,
): { owner: string; register: BinderRegister } | null {
    const register = TABLE_REGISTER[item.table_name];
    if (!register) return null;
    let owner = '';
    const local = getById<{ user_id?: unknown }>(item.table_name, item.record_id);
    if (local) {
        owner = typeof local.user_id === 'string' ? local.user_id.trim() : '';
    } else if (item.mutation_type === 'INSERT') {
        try {
            const payload = JSON.parse(item.payload) as { user_id?: unknown };
            owner = typeof payload.user_id === 'string' ? payload.user_id.trim() : '';
        } catch {
            return null;
        }
    }
    if (!owner || owner === authenticatedUserId) return null;
    return binderWriteGranted(register, owner) ? null : { owner, register };
}

/**
 * What an orphaned INSERT (a row the sailor ADDED, which never reached the
 * server) should be re-stamped with to land in the sailor's own binder, or
 * null when it must be dropped instead:
 *  - while any skipper still grants write on the register, the database's
 *    crew_rewrite_user_id would move a self-stamped row into THAT skipper's
 *    binder, another boat's;
 *  - a service log entry only moves with its task (the task's INSERT comes
 *    first in the outbox, so a re-homed task is already the sailor's).
 * An attachment reference into someone else's vault folder is cleared; a
 * local file still uploads, now to the sailor's own folder.
 */
function rehomeChanges(
    item: SyncQueueItem,
    register: BinderRegister,
    authenticatedUserId: string,
): Record<string, unknown> | null {
    if (item.mutation_type !== 'INSERT' || anySkipperGrantsWrite(register)) return null;
    let payload: Record<string, unknown>;
    try {
        payload = JSON.parse(item.payload) as Record<string, unknown>;
    } catch {
        return null;
    }
    if (item.table_name === 'maintenance_history') {
        const taskId = typeof payload.task_id === 'string' ? payload.task_id : '';
        const task = taskId ? getById<{ user_id?: unknown }>('maintenance_tasks', taskId) : null;
        const taskOwner = typeof task?.user_id === 'string' ? task.user_id.trim() : '';
        if (taskOwner !== authenticatedUserId) return null;
    }
    const changes: Record<string, unknown> = { user_id: authenticatedUserId };
    const fileField = FILE_URI_FIELDS[item.table_name as SyncableTable];
    const fileUri = fileField ? payload[fileField] : null;
    if (
        fileField &&
        typeof fileUri === 'string' &&
        fileUri.startsWith(VESSEL_VAULT_URI_PREFIX) &&
        !fileUri.startsWith(`${VESSEL_VAULT_URI_PREFIX}${authenticatedUserId}/`)
    ) {
        changes[fileField] = null;
    }
    return changes;
}

async function pushMutations(
    databaseSession: LocalDatabaseSession,
    authenticatedUserId: string,
    binderSnapshotFresh = false,
): Promise<{
    count: number;
    errors: string[];
    discarded: number;
    rehomed: number;
    ownerIds: string[];
    restoreFromServer: boolean;
}> {
    const queue = getFullQueue();
    if (queue.length === 0) {
        return { count: 0, errors: [], discarded: 0, rehomed: 0, ownerIds: [], restoreFromServer: false };
    }

    let succeeded = 0;
    let discarded = 0;
    let rehomed = 0;
    let restoreFromServer = false;
    const errors: string[] = [];
    const blockedRecords = new Set<string>();
    const discardedRecords = new Set<string>();
    const orphanOwners = new Set<string>();

    // Process in persisted FIFO order. A failed predecessor fences every later
    // mutation for that same record, while unrelated records can continue.
    for (const queuedItem of queue) {
        let item = queuedItem;
        assertDatabaseSession(databaseSession);
        const recordKey = `${item.table_name}\u0000${item.record_id}`;
        if (item.status === 'failed') {
            if (!blockedRecords.has(recordKey)) {
                errors.push(
                    `${item.table_name}/${item.record_id}: ${
                        item.error_message || 'Earlier mutation is awaiting retry'
                    }`,
                );
            }
            blockedRecords.add(recordKey);
            continue;
        }
        if (blockedRecords.has(recordKey)) continue;

        // The skipper unshared (or the sailor left) while this change was
        // queued: RLS would refuse it forever and fence every later change to
        // the row. Only on a FRESH snapshot, and never for the sailor's own
        // rows. A row the sailor ADDED moves into their own binder when
        // nobody else can take it; otherwise the change is dropped. A dropped
        // add never reached the server, so its local row goes too; a dropped
        // edit keeps the row and a full pull restores (or prunes) it.
        // SyncResult carries the counts, so the app can say so.
        const orphan =
            binderSnapshotFresh && item.owner_user_id === authenticatedUserId && !discardedRecords.has(recordKey)
                ? orphanedSharedMutation(item, authenticatedUserId)
                : null;
        if (orphan) orphanOwners.add(orphan.owner);
        const rehome = orphan ? rehomeChanges(item, orphan.register, authenticatedUserId) : null;
        if (rehome) {
            assertDatabaseSession(databaseSession);
            try {
                const rewritten = await rewriteQueuedInsert(item.id, rehome);
                if (!rewritten) throw new Error('queued add not found');
                item = rewritten;
            } catch (e) {
                const msg = e instanceof Error ? e.message : 'could not move it';
                errors.push(`${item.table_name}/${item.record_id}: ${msg}`);
                blockedRecords.add(recordKey);
                continue;
            }
            rehomed += 1;
            log.warn(
                `[SyncService] Moved a queued add on ${item.table_name}/${item.record_id} into this account's own binder: the skipper no longer shares that binder with it`,
            );
            // Pushed below as the sailor's own row.
        } else if (orphan || (binderSnapshotFresh && discardedRecords.has(recordKey))) {
            assertDatabaseSession(databaseSession);
            await removeSynced([item.id]);
            if (!discardedRecords.has(recordKey)) {
                discardedRecords.add(recordKey);
                if (item.mutation_type === 'INSERT') await bulkDelete(item.table_name, [item.record_id]);
                else restoreFromServer = true;
            }
            discarded += 1;
            log.warn(
                `[SyncService] Dropped a queued ${item.mutation_type} on ${item.table_name}/${item.record_id}: the skipper no longer shares that binder with this account`,
            );
            continue;
        }

        try {
            if (item.owner_user_id !== databaseSession.identity || item.owner_user_id !== authenticatedUserId) {
                throw new Error('Outbox mutation belongs to a different authenticated identity');
            }
            await requireAuthenticatedIdentity(authenticatedUserId);
            assertDatabaseSession(databaseSession);

            // With one shared sync promise, a pre-existing "syncing" status
            // can only be an interrupted prior attempt. All mutation shapes
            // are retry-safe; DELTA is deduplicated by its RPC receipt.
            if (item.status === 'pending') {
                await markSyncing([item.id]);
            }
            await pushSingleMutation(item, authenticatedUserId);
            await requireAuthenticatedIdentity(authenticatedUserId);
            assertDatabaseSession(databaseSession);
            await removeSynced([item.id]);
            succeeded += 1;
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Push failed';
            errors.push(`${item.table_name}/${item.record_id}: ${msg}`);
            if (!isLocalDatabaseSessionCurrent(databaseSession)) {
                break;
            }
            await markFailed([item.id], msg);
            blockedRecords.add(recordKey);
        }
    }

    if (succeeded > 0) {
        await updateSyncMeta({ lastPushTimestamp: new Date().toISOString() });
    }

    return { count: succeeded, errors, discarded, rehomed, ownerIds: [...orphanOwners], restoreFromServer };
}

async function pushSingleMutation(item: SyncQueueItem, authenticatedUserId: string): Promise<void> {
    if (!supabase) throw new Error('Supabase not configured');

    const payload = JSON.parse(item.payload);
    if (!SYNCABLE_TABLES.includes(item.table_name as SyncableTable)) {
        throw new Error(`Unsupported sync table: ${item.table_name}`);
    }
    const table = item.table_name as SyncableTable;

    switch (item.mutation_type) {
        case 'INSERT': {
            const payloadOwner =
                typeof payload.user_id === 'string' && payload.user_id.trim()
                    ? payload.user_id.trim()
                    : authenticatedUserId;
            // Some shared-register rows are explicitly owned by the skipper
            // while a permitted crew member authors the offline mutation.
            // Preserve that authoritative owner; queue ownership separately
            // proves which authenticated actor is allowed to push it.
            const row = { ...payload, user_id: payloadOwner };
            delete row._local_only;
            // Synchronization timestamps belong to the database clock. A
            // skewed phone timestamp can otherwise put a new row behind
            // another device's cursor forever.
            delete row.created_at;
            delete row.updated_at;

            // Upload file if this table has a file URI field
            await uploadFileIfNeeded(table, row, authenticatedUserId, item.record_id);

            // A timeout can happen after PostgreSQL committed but before the
            // client received the response. Retrying must not overwrite that
            // row with the stale INSERT snapshot; dependent UPDATE/DELTA
            // records that follow in the outbox apply the later state.
            const { error } = await supabase.from(table).upsert(row, { onConflict: 'id', ignoreDuplicates: true });

            if (error) throw new Error(error.message);
            break;
        }

        case 'UPDATE': {
            const row = { ...payload };
            // Ownership and identity are established by INSERT/RLS, not by a
            // cached whole-row UPDATE. Locally-created records commonly carry
            // an empty user_id until their first push.
            delete row.id;
            delete row.user_id;
            delete row.created_at;
            delete row._local_only;

            // Upload file if this table has a file URI field
            await uploadFileIfNeeded(table, row, authenticatedUserId, item.record_id);

            const { data, error } = await supabase
                .from(table)
                .update(row)
                .eq('id', item.record_id)
                .select('id')
                .maybeSingle();

            if (error) throw new Error(error.message);
            if (!data) throw new Error('Record not found or update not authorized');

            // A changed attachment can use a different extension while keeping
            // the same record ID. Once the database points at the replacement,
            // remove every displaced deterministic variant. Cleanup failure
            // keeps the UPDATE queued; a retry is safe after the DB commit.
            // Only the row's owner has attachments to tidy: a crew edit of a
            // skipper's record must not list or clean the crew's own folder.
            const fileField = FILE_URI_FIELDS[table];
            const localRow = fileField ? getById<{ user_id?: unknown }>(table, item.record_id) : null;
            const rowOwner = typeof localRow?.user_id === 'string' ? localRow.user_id.trim() : '';
            if (
                fileField &&
                Object.prototype.hasOwnProperty.call(row, fileField) &&
                (!rowOwner || rowOwner === authenticatedUserId)
            ) {
                await reconcileVaultObjects(table, authenticatedUserId, item.record_id, row[fileField]);
            }
            break;
        }

        case 'DELETE': {
            const { data: visibleBefore, error: selectError } = await supabase
                .from(table)
                .select('id')
                .eq('id', item.record_id)
                .maybeSingle();
            if (selectError) throw new Error(selectError.message);

            if (visibleBefore) {
                const { data: deleted, error: deleteError } = await supabase
                    .from(table)
                    .delete()
                    .eq('id', item.record_id)
                    .select('id')
                    .maybeSingle();
                if (deleteError) throw new Error(deleteError.message);

                if (!deleted) {
                    // A concurrent delete is success; a still-visible row
                    // means SELECT is allowed but DELETE was denied by policy
                    // and must stay queued.
                    const { data: visibleAfter, error: verifyError } = await supabase
                        .from(table)
                        .select('id')
                        .eq('id', item.record_id)
                        .maybeSingle();
                    if (verifyError) throw new Error(verifyError.message);
                    if (visibleAfter) throw new Error('Record is visible but delete is not authorized');
                }
            }

            // The row may already be absent because a prior attempt committed
            // before its response was lost. Deterministic owner-prefixed paths
            // let that retry finish every extension variant without needing
            // the deleted row's payload.
            await reconcileVaultObjects(table, authenticatedUserId, item.record_id, null);
            break;
        }

        case 'DELTA': {
            const delta = JSON.parse(item.payload) as { id: string; field: string; delta: number };
            if (table !== 'inventory_items' || delta.field !== 'quantity' || !Number.isFinite(delta.delta)) {
                throw new Error('Unsupported DELTA mutation');
            }

            // The operation UUID is the outbox item ID. The database records
            // it transactionally with the increment, making a retry after a
            // timeout safe instead of double-applying stock consumption.
            const { error } = await supabase.rpc('apply_inventory_quantity_delta', {
                p_operation_id: item.id,
                p_inventory_item_id: item.record_id,
                p_delta: delta.delta,
            });
            if (error) throw new Error(error.message);
            break;
        }
        default:
            throw new Error(`Unsupported mutation type: ${String(item.mutation_type)}`);
    }
}

/**
 * If a row has a local file URI (e.g. capacitor://... or file://...),
 * upload it to the vessel_vault bucket and replace the field with the cloud URL.
 */
async function uploadFileIfNeeded(
    table: SyncableTable,
    row: Record<string, unknown>,
    userId: string,
    recordId: string,
): Promise<void> {
    const field = FILE_URI_FIELDS[table];
    if (!field) return;

    const localUri = row[field] as string | null;
    if (!localUri) return;

    // Skip if already cloud-backed. Private bucket references remain stable;
    // consumers resolve a short-lived signed URL only at point of use.
    if (
        localUri.startsWith('http://') ||
        localUri.startsWith('https://') ||
        localUri.startsWith('supabase-storage://')
    ) {
        return;
    }

    const subfolder = FILE_STORAGE_SUBFOLDERS[table];
    if (!subfolder) return;
    let bytes: Blob | Uint8Array;
    let contentType = 'application/octet-stream';
    let extension = '';

    if (localUri.startsWith('data:') || localUri.startsWith('blob:')) {
        const response = await fetch(localUri);
        if (!response.ok) throw new Error(`Could not read local attachment (${response.status})`);
        const blob = await response.blob();
        bytes = blob;
        contentType = blob.type || contentType;
        extension = extensionForContentType(contentType);
    } else {
        // Read native file URIs through Capacitor.
        const { Filesystem, Directory } = await import('@capacitor/filesystem');
        const base64Data = await Filesystem.readFile({
            path: localUri.replace('file://', ''),
            directory: Directory.Data,
        });

        const raw = typeof base64Data.data === 'string' ? base64Data.data : '';
        if (!raw) throw new Error('Local attachment was empty or unreadable');
        const binaryString = atob(raw);
        const nativeBytes = new Uint8Array(binaryString.length);
        for (let i = 0; i < binaryString.length; i++) {
            nativeBytes[i] = binaryString.charCodeAt(i);
        }
        bytes = nativeBytes;
        extension = extensionFromUri(localUri);
        contentType = contentTypeForExtension(extension);
    }

    const safeRecordId = storageSafeRecordId(recordId);
    const storagePath = `${userId}/${subfolder}/${safeRecordId}${extension ? `.${extension}` : ''}`;
    const { error: uploadError } = await supabase!.storage.from(VESSEL_VAULT_BUCKET).upload(storagePath, bytes, {
        contentType,
        upsert: true,
    });
    if (uploadError) throw new Error(`File upload failed: ${uploadError.message}`);
    row[field] = `${VESSEL_VAULT_URI_PREFIX}${storagePath}`;
}

/**
 * Reconcile every deterministic object for an attachment-bearing record.
 * Passing a stable URI keeps that object and removes only displaced extension
 * variants; passing null removes them all. List/remove errors are failures so
 * the durable outbox retries until Storage reaches the same end state as SQL.
 */
async function reconcileVaultObjects(
    table: SyncableTable,
    userId: string,
    recordId: string,
    keepUri: unknown,
): Promise<void> {
    const subfolder = FILE_STORAGE_SUBFOLDERS[table];
    if (!subfolder) return;

    const safeRecordId = storageSafeRecordId(recordId);
    const directory = `${userId}/${subfolder}`;
    const keepPath =
        typeof keepUri === 'string' && keepUri.startsWith(VESSEL_VAULT_URI_PREFIX)
            ? keepUri.slice(VESSEL_VAULT_URI_PREFIX.length)
            : null;
    const bucket = supabase!.storage.from(VESSEL_VAULT_BUCKET);
    const candidates: string[] = [];

    let offset = 0;
    for (;;) {
        const { data, error } = await bucket.list(directory, {
            limit: STORAGE_LIST_PAGE_SIZE,
            offset,
        });
        if (error) throw new Error(`Attachment cleanup list failed: ${error.message}`);

        const entries = data ?? [];
        for (const entry of entries) {
            if (entry.name === safeRecordId || entry.name.startsWith(`${safeRecordId}.`)) {
                const path = `${directory}/${entry.name}`;
                if (path !== keepPath) candidates.push(path);
            }
        }
        if (entries.length < STORAGE_LIST_PAGE_SIZE) break;
        offset += entries.length;
    }

    for (let start = 0; start < candidates.length; start += STORAGE_LIST_PAGE_SIZE) {
        const batch = candidates.slice(start, start + STORAGE_LIST_PAGE_SIZE);
        const { error } = await bucket.remove(batch);
        if (error) throw new Error(`Attachment cleanup failed: ${error.message}`);
    }
}

function storageSafeRecordId(recordId: string): string {
    return recordId.replace(/[^a-zA-Z0-9_-]/g, '_');
}

function extensionFromUri(uri: string): string {
    const withoutQuery = uri.split(/[?#]/, 1)[0] || '';
    const candidate = withoutQuery.split('/').pop()?.split('.').pop()?.toLowerCase() || '';
    return /^[a-z0-9]{1,8}$/.test(candidate) ? candidate : '';
}

function extensionForContentType(contentType: string): string {
    const extensions: Record<string, string> = {
        'application/pdf': 'pdf',
        'image/jpeg': 'jpg',
        'image/png': 'png',
        'image/heic': 'heic',
        'application/msword': 'doc',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
    };
    return extensions[contentType.toLowerCase()] || '';
}

function contentTypeForExtension(extension: string): string {
    const contentTypes: Record<string, string> = {
        pdf: 'application/pdf',
        jpg: 'image/jpeg',
        jpeg: 'image/jpeg',
        png: 'image/png',
        heic: 'image/heic',
        doc: 'application/msword',
        docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    };
    return contentTypes[extension] || 'application/octet-stream';
}

// ── Phase 2: PULL ──────────────────────────────────────────────

async function pullUpdates(
    forceFull: boolean,
    databaseSession: LocalDatabaseSession,
): Promise<{ count: number; errors: string[] }> {
    if (!supabase) return { count: 0, errors: ['Supabase not configured'] };

    const meta = getSyncMeta();
    assertDatabaseSession(databaseSession);
    const completedWatermark = await getServerWatermark();
    assertDatabaseSession(databaseSession);
    const serverNow = new Date(completedWatermark).getTime();
    const lastFullPull = meta.lastFullPullTimestamp ? new Date(meta.lastFullPullTimestamp).getTime() : 0;
    const periodicFullDue =
        !Number.isFinite(lastFullPull) ||
        lastFullPull > serverNow ||
        serverNow - lastFullPull >= FULL_RECONCILIATION_INTERVAL_MS;
    const reconcileSnapshot = forceFull || !meta.lastPullTimestamp || periodicFullDue;
    const since = reconcileSnapshot ? '1970-01-01T00:00:00Z' : replayOverlap(meta.lastPullTimestamp as string);
    let totalPulled = 0;
    const errors: string[] = [];

    for (const table of SYNCABLE_TABLES) {
        try {
            assertDatabaseSession(databaseSession);
            const pulled = await pullTable(table, since, completedWatermark, reconcileSnapshot, databaseSession);
            totalPulled += pulled;
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Pull failed';
            errors.push(`${table}: ${msg}`);
        }
    }

    // One shared watermark is valid only when every table completed. Partial
    // pulls are intentionally replayed on the next cycle.
    if (errors.length === 0) {
        assertDatabaseSession(databaseSession);
        await updateSyncMeta({
            lastPullTimestamp: completedWatermark,
            ...(reconcileSnapshot ? { lastFullPullTimestamp: completedWatermark } : {}),
        });
    }

    return { count: totalPulled, errors };
}

function replayOverlap(timestamp: string): string {
    const parsed = new Date(timestamp).getTime();
    if (!Number.isFinite(parsed)) return '1970-01-01T00:00:00.000Z';
    return new Date(Math.max(0, parsed - PULL_REPLAY_OVERLAP_MS)).toISOString();
}

async function getServerWatermark(): Promise<string> {
    if (!supabase) throw new Error('Supabase not configured');

    const { data, error } = await supabase.rpc('get_sync_watermark');
    if (error) throw new Error(error.message);

    const parsed = typeof data === 'string' ? new Date(data) : null;
    if (!parsed || !Number.isFinite(parsed.getTime())) {
        throw new Error('Sync server returned an invalid watermark');
    }
    return parsed.toISOString();
}

async function pullTable(
    table: SyncableTable,
    since: string,
    until: string,
    reconcileSnapshot: boolean,
    databaseSession: LocalDatabaseSession,
): Promise<number> {
    if (!supabase) return 0;

    // Normalize the timestamp to strict UTC ISO format (Z suffix).
    // PostgREST misinterprets '+' in timezone offsets like '+10:00' as a space.
    let normalizedSince = since;
    try {
        const d = new Date(since);
        if (!isNaN(d.getTime())) {
            normalizedSince = d.toISOString(); // Always ends with 'Z'
        }
    } catch (e) {
        log.warn('[Sync]', e);
        // Keep original if parsing fails (should not happen with valid ISO strings)
    }

    let cursor: { updatedAt: string; id: string } | null = null;
    let merged = 0;
    const visibleIds = reconcileSnapshot ? new Set<string>() : null;

    // PostgREST responses are capped, so page through the bounded server-time
    // window. Advancing the watermark after a single capped response would
    // silently strand every row beyond that response forever.
    for (;;) {
        assertDatabaseSession(databaseSession);
        let query = supabase
            .from(table)
            .select('*')
            .gt('updated_at', normalizedSince)
            .lte('updated_at', until)
            .order('updated_at', { ascending: true })
            .order('id', { ascending: true });
        if (cursor) {
            query = query.or(
                `updated_at.gt.${cursor.updatedAt},and(updated_at.eq.${cursor.updatedAt},id.gt.${cursor.id})`,
            );
        }
        const { data, error } = await query.limit(PULL_PAGE_SIZE);
        assertDatabaseSession(databaseSession);

        if (error) throw new Error(error.message);
        if (!data || data.length === 0) break;

        if (visibleIds) {
            for (const row of data) {
                if (typeof row.id !== 'string') throw new Error('Sync row is missing its record ID');
                visibleIds.add(row.id);
            }
        }
        merged += await mergePulledRecords(table, data as { id: string; updated_at?: string; created_at?: string }[]);
        if (data.length < PULL_PAGE_SIZE) break;
        const last = data[data.length - 1] as { id?: unknown; updated_at?: unknown };
        if (typeof last.id !== 'string' || typeof last.updated_at !== 'string') {
            throw new Error('Sync page is missing its keyset cursor');
        }
        cursor = { updatedAt: last.updated_at, id: last.id };
    }

    if (visibleIds) {
        assertDatabaseSession(databaseSession);
        await prunePulledTable(table, visibleIds);
    }
    return merged;
}

// ── Convenience: Force full refresh ────────────────────────────

/**
 * Force a full pull from server (ignores last sync timestamp).
 * Useful for initial app load or manual refresh.
 */
export async function forceFullPull(): Promise<number> {
    const result = await requestFullReconciliation();
    if (result.errors.length > 0) {
        throw new Error(result.errors.join('; '));
    }
    return result.pulled;
}
