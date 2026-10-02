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
 *
 * Live across devices (Shane, 2026-10-02: "if i change something on one
 * machine, it is not reflected in the other"): a local write pushes within
 * seconds rather than at the five-minute cycle, and at once when the app
 * leaves the screen. The app catches up (with a sweep for rows deleted
 * elsewhere) when it returns to the foreground, reconnects, or a page's
 * realtime channel joins or rejoins; the five-minute cycle sweeps too.
 */
import { Capacitor } from '@capacitor/core';
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
    onOutboxAppended,
    type LocalDatabaseSession,
    type PrunePlan,
    type SyncQueueItem,
} from './LocalDatabase';
import {
    anySkipperGrantsWrite,
    binderRegisterForRow,
    binderWriteGranted,
    isGalleyShareLive,
    refreshSharedBinders,
    TABLE_REGISTER,
    type BinderRegister,
} from './sharedBinders';
import { LocalEngineHoursService } from './LocalEngineHoursService';

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
    /** Which of their registers (so the notice can say galley, not binder). */
    sharedRegisters?: BinderRegister[];
    /**
     * Local rows removed because the server no longer shows them (deleted on
     * another device, or no longer shared). `pulled` cannot count these.
     */
    pruned?: number;
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
    'vessel_engine_hours',
] as const;

/**
 * Tables the server may not have yet: an app build can reach a device before
 * the migration that creates the table is pushed (vessel_engine_hours,
 * 20261002190000). Until the server has one (PostgREST answers PGRST205),
 * its pull and sweep are skipped quietly: no error, no held watermark for the other tables, no prune, no
 * collapse guard. A device reads such a table in full the first time it finds
 * it, records that in SyncMeta.optionalTablesReadAt, and only then writes to
 * it (LocalEngineHoursService), so the outbox never holds a change the server
 * cannot take.
 */
const OPTIONAL_TABLES: ReadonlySet<string> = new Set(['vessel_engine_hours']);
const EPOCH = '1970-01-01T00:00:00Z';
const PULL_PAGE_SIZE = 500;
const PULL_REPLAY_OVERLAP_MS = 5 * 60 * 1000;
const FULL_RECONCILIATION_INTERVAL_MS = 6 * 60 * 60 * 1000;

/**
 * A local write pushes this long after the LAST write of a burst (a run of
 * quantity taps, a 40-task seed), but never later than the max wait after the
 * first, so a steady stream of edits still goes out every few seconds.
 */
const PROMPT_PUSH_DEBOUNCE_MS = 1000;
const PROMPT_PUSH_MAX_WAIT_MS = 4000;
/**
 * Catch-up requests (foreground, a realtime channel rejoining) settle for a
 * moment, so a foreground's burst of events is one cycle, and catch-up cycles
 * start no closer together than the spacing. A request is never dropped: one
 * inside the spacing runs at its end.
 */
const CATCH_UP_DEBOUNCE_MS = 1500;
const CATCH_UP_MIN_SPACING_MS = 10_000;
/**
 * The longest a push on the way to the background holds its native task. iOS
 * grants about 30 s; ending first keeps the app clear of the OS's own expiry.
 */
const BACKGROUND_HOLD_MAX_MS = 25_000;
/**
 * One reading never empties a table (review, 2026-10-02). A listing that
 * would remove every clean row this device holds for a table, or more than
 * half of at least this many, is held back: nothing goes, a full
 * reconciliation is asked for, and the rows go only when a LATER cycle (its
 * own getUser, its own pinned token) reads the same collapse within the
 * window. A real "cleared it on the phone", or a share that ended, waits one
 * more cycle (seconds); a wrong reading, for a reason nobody has thought of
 * yet, costs nothing.
 */
const COLLAPSE_MIN_ROWS = 5;
const COLLAPSE_CONFIRM_WINDOW_MS = 15 * 60 * 1000;

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
let promptPushTimer: ReturnType<typeof setTimeout> | null = null;
let promptPushFirstRequestAt = 0;
let catchUpTimer: ReturnType<typeof setTimeout> | null = null;
let lastCatchUpStartedAt = Number.NEGATIVE_INFINITY;
/** The next cycle also sweeps the binder tables for rows deleted elsewhere. */
let deletionSweepRequested = false;
/** One cycle is already queued behind the active one. */
let followupArmed = false;
/** That queued cycle is quiet only if every request behind it was. */
let followupQuiet = true;
/**
 * The cycle about to start skips the haptic pulse. Prompt pushes and
 * catch-ups run on their own after an edit or a foreground; a buzz a second
 * after every tap would read as a glitch, not as "synced".
 */
let quietNextCycle = false;
let stopOutboxSignal: (() => void) | null = null;
let stopForegroundWatch: (() => void) | null = null;
/** Counts cycles, so a held collapse is confirmed only by a later one. */
let syncCycleSerial = 0;
/** table → the first reading of a collapse, waiting for a second. */
const heldCollapses = new Map<string, { identity: string; cycle: number; at: number }>();
/** Optional tables the server last said it does not have (this session). */
const missingOptionalTables = new Set<string>();
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

    // Periodic sync every 5 minutes when online. It sweeps the binder tables
    // for rows deleted elsewhere too (ids only; the tables are small): a
    // device that never leaves the foreground, with no binder open, has no
    // other event that would ever catch a delete it missed before the
    // six-hourly full reconciliation.
    syncInterval = setInterval(
        () => {
            deletionSweepRequested = true;
            if (navigator.onLine && !activeSync) {
                syncNow();
            }
        },
        5 * 60 * 1000,
    );

    // A local write pushes within seconds, so another device (or crew on a
    // shared binder) sees it now, not at the next five-minute cycle.
    stopOutboxSignal = onOutboxAppended(() => schedulePromptPush());
    stopForegroundWatch = watchForeground();
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
    stopOutboxSignal?.();
    stopOutboxSignal = null;
    stopForegroundWatch?.();
    stopForegroundWatch = null;
    if (promptPushTimer) {
        clearTimeout(promptPushTimer);
        promptPushTimer = null;
    }
    if (catchUpTimer) {
        clearTimeout(catchUpTimer);
        catchUpTimer = null;
    }
    lastCatchUpStartedAt = Number.NEGATIVE_INFINITY;
    deletionSweepRequested = false;
    heldCollapses.clear();
    missingOptionalTables.clear();
}

// ── Server errors ──────────────────────────────────────────────

/** A PostgREST/Postgres error, keeping its code for the checks below. */
class ServerRequestError extends Error {
    readonly code: string | undefined;
    constructor(error: { message?: string; code?: string }) {
        super(error.message || 'Server request failed');
        this.name = 'ServerRequestError';
        this.code = typeof error.code === 'string' ? error.code : undefined;
    }
}

/**
 * The server does not have this table: PostgREST's PGRST205 ("Could not find
 * the table '...' in the schema cache"). PostgREST checks its schema cache
 * before a request reaches Postgres, so that is the only "no such table" a
 * missing table gives (measured on the live server, 2026-10-02). A Postgres
 * 42P01 ("relation ... does not exist") can then only come from INSIDE the
 * database, from a policy, trigger or fence reading a relation that drifted
 * away, and is a real error: treating it as "not pushed yet" would leave
 * every write waiting in silence.
 */
function isMissingTableError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (code === 'PGRST205') return true;
    return (
        (code === undefined || code === null) &&
        typeof message === 'string' &&
        /^Could not find the table '[\w.]+' in the schema cache$/.test(message)
    );
}

function handleOnline() {
    // Every cycle requeues transient failures before draining the outbox.
    // Realtime events were missed while offline, deletes included.
    deletionSweepRequested = true;
    syncNowOrAfterActive(false);
}

function handleOffline() {
    setStatus('offline');
}

// ── Prompt push & catch-up ─────────────────────────────────────

/** True while the outbox holds a change no cycle has picked up yet. */
function hasPendingOutbox(): boolean {
    try {
        return getFullQueue().some((item) => item.status === 'pending');
    } catch {
        // The database is switching accounts; the next cycle will see it.
        return false;
    }
}

/**
 * Run a cycle now, or exactly once after the active one. syncNow() alone
 * would hand back the active cycle, whose push already read the queue, so a
 * write made during it would wait for the next five-minute cycle.
 */
function syncNowOrAfterActive(quiet: boolean): void {
    if (!activeSync) {
        // runSyncCycle reads the flag before its first await; clear it at once
        // so a syncNow() that returned early (offline) cannot pass it on.
        quietNextCycle = quiet;
        try {
            void syncNow().catch((error) => log.warn('[SyncService] Sync failed:', error));
        } finally {
            quietNextCycle = false;
        }
        return;
    }
    followupQuiet = followupArmed ? followupQuiet && quiet : quiet;
    if (followupArmed) return;
    followupArmed = true;
    void activeSync
        .catch(() => undefined)
        .then(() => {
            followupArmed = false;
            if (!engineStarted || !navigator.onLine) return;
            if (hasPendingOutbox() || deletionSweepRequested) syncNowOrAfterActive(followupQuiet);
        });
}

/**
 * Push the outbox soon: called for every durable local write while the
 * engine runs. Debounced, so a burst of writes is one cycle. Offline, the
 * writes stay queued as before and the 'online' handler pushes them.
 */
function schedulePromptPush(): void {
    if (!engineStarted) return;
    const now = Date.now();
    if (promptPushTimer) clearTimeout(promptPushTimer);
    else promptPushFirstRequestAt = now;
    const wait = Math.max(
        0,
        Math.min(PROMPT_PUSH_DEBOUNCE_MS, promptPushFirstRequestAt + PROMPT_PUSH_MAX_WAIT_MS - now),
    );
    promptPushTimer = setTimeout(() => {
        promptPushTimer = null;
        if (!engineStarted || !navigator.onLine || !hasPendingOutbox()) return;
        syncNowOrAfterActive(true);
    }, wait);
}

/**
 * Catch up with changes this device may have missed: realtime only delivers
 * while its socket is open, so a phone that was asleep, offline, or whose
 * channel dropped has gaps, and so does a page that has only just opened its
 * channel. The cycle pulls as usual AND sweeps the binder tables for rows
 * deleted elsewhere, which a timestamp pull cannot see.
 */
export function requestCatchUpSync(): void {
    if (!engineStarted) return;
    deletionSweepRequested = true;
    if (catchUpTimer) return;
    const delay = Math.max(CATCH_UP_DEBOUNCE_MS, lastCatchUpStartedAt + CATCH_UP_MIN_SPACING_MS - Date.now());
    catchUpTimer = setTimeout(() => {
        catchUpTimer = null;
        // Offline: the flag stays set and the 'online' handler sweeps. A cycle
        // that started after the request already swept (and cleared it).
        if (!engineStarted || !navigator.onLine || !deletionSweepRequested) return;
        lastCatchUpStartedAt = Date.now();
        syncNowOrAfterActive(true);
    }, delay);
}

/**
 * Wait for the cycle running now, and the one queued behind it, to finish.
 * A follow-up starts in the same turn its predecessor settles, so a short
 * loop sees it.
 */
async function settleActiveCycles(): Promise<void> {
    for (let round = 0; round < 4; round += 1) {
        const running = activeSync;
        if (!running) {
            if (!followupArmed) return;
            await Promise.resolve();
            continue;
        }
        await running.catch(() => undefined);
        await Promise.resolve();
    }
}

/**
 * Ask iOS for time to finish `work` after the app leaves the screen
 * (UIApplication beginBackgroundTask, through the background geolocation
 * plugin the app already ships; it needs no tracking or ready()). Best
 * effort: on any other platform, or if the plugin is missing, the work just
 * runs for as long as the OS allows. Released when the work settles, and
 * never held past the cap.
 */
async function holdBackgroundTaskWhile(work: Promise<void>): Promise<void> {
    if (Capacitor.getPlatform() !== 'ios') return work;
    let plugin: {
        startBackgroundTask: () => Promise<number>;
        stopBackgroundTask: (taskId: number) => Promise<void>;
    };
    let taskId: number;
    try {
        plugin = (await import('@transistorsoft/capacitor-background-geolocation')).default;
        taskId = await plugin.startBackgroundTask();
    } catch (error) {
        log.warn('[SyncService] No background time for the push:', error);
        return work;
    }
    let capTimer: ReturnType<typeof setTimeout> | null = null;
    try {
        await Promise.race([
            work,
            new Promise<void>((resolve) => {
                capTimer = setTimeout(resolve, BACKGROUND_HOLD_MAX_MS);
            }),
        ]);
    } finally {
        if (capTimer) clearTimeout(capTimer);
        await plugin.stopBackgroundTask(taskId).catch((error: unknown) => {
            log.warn('[SyncService] Could not end the background task:', error);
        });
    }
}

let backgroundHold: Promise<void> | null = null;

/**
 * The app is leaving the screen: push what is queued NOW, not after the
 * debounce and the cycle prelude. iOS suspends the web view's JavaScript soon
 * after the app goes to the background, so an edit made just before the
 * phone was locked would otherwise sit in the outbox until it is next opened,
 * and the other device would never see it. On iOS the push runs inside a
 * native background task so the OS lets it finish.
 */
function flushBeforeSuspend(): void {
    if (!engineStarted || !navigator.onLine) return;
    const pending = hasPendingOutbox();
    if (!pending && !activeSync) return;
    if (pending) {
        if (promptPushTimer) {
            clearTimeout(promptPushTimer);
            promptPushTimer = null;
        }
        syncNowOrAfterActive(true);
    }
    if (backgroundHold) return;
    backgroundHold = holdBackgroundTaskWhile(settleActiveCycles())
        .catch((error) => log.warn('[SyncService] Background push failed:', error))
        .finally(() => {
            backgroundHold = null;
        });
}

/**
 * Catch up whenever the app comes back to the foreground, and push straight
 * away when it leaves.
 */
function watchForeground(): () => void {
    let stopped = false;
    let appListener: { remove: () => unknown } | null = null;
    const onVisibility = () => {
        if (document.visibilityState === 'visible') requestCatchUpSync();
        else if (document.visibilityState === 'hidden') flushBeforeSuspend();
    };
    document.addEventListener('visibilitychange', onVisibility);
    // WKWebView does not always fire visibilitychange on resume; the native
    // app-state event does. Both landing together is one debounced cycle (and
    // one push on the way out).
    void import('@capacitor/app')
        .then(({ App }) =>
            Promise.resolve(
                App.addListener('appStateChange', ({ isActive }) => {
                    if (isActive) requestCatchUpSync();
                    else flushBeforeSuspend();
                }),
            ),
        )
        .then((listener) => {
            if (stopped) void listener?.remove();
            else appListener = listener ?? null;
        })
        .catch(() => {
            /* plugin unavailable (pure web): visibilitychange covers it */
        });
    return () => {
        stopped = true;
        document.removeEventListener('visibilitychange', onVisibility);
        void appListener?.remove();
        appListener = null;
    };
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
    syncCycleSerial += 1;
    setStatus('syncing');
    const result: SyncResult = {
        pushed: 0,
        pulled: 0,
        errors: [],
        discardedShared: 0,
        rehomedShared: 0,
        sharedOwnerIds: [],
        pruned: 0,
    };
    let reconciliationVersionAtStart = fullReconciliationRequestVersion;
    // A request made from here on needs a cycle that starts after it.
    const sweepDeletions = deletionSweepRequested;
    deletionSweepRequested = false;
    const quiet = quietNextCycle;

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
        result.sharedRegisters = pushResult.registers;
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
        const pullResult = await pullUpdates(forceFull, databaseSession, sweepDeletions).finally(() => {
            forcedPullInFlight = false;
        });
        result.pulled = pullResult.count;
        result.pruned = pullResult.pruned;
        if (pullResult.sweepIncomplete) deletionSweepRequested = true;
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
        // The sweep did not finish; the next cycle owes it.
        if (sweepDeletions) deletionSweepRequested = true;
    }

    // Notify listeners
    listeners.forEach((fn) => fn(result));

    // Haptic pulse on successful sync (not for a prompt push or a catch-up)
    if (!quiet && (result.pushed > 0 || result.pulled > 0)) {
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
 * Binder tables whose queued changes are never judged here. A meal plan with
 * no passage is a galley row, but a passage Meal Planner share kept with no
 * voyage also lets crew write it (can_access_passage), and the share
 * snapshot does not track that: dropping such a change would lose a cook's
 * edit the server takes. The server decides, as it does for every non-binder
 * table.
 */
const ORPHAN_UNCHECKED_TABLES: ReadonlySet<string> = new Set(['meal_plans']);

/**
 * A queued change to a SKIPPER'S binder row (by its local row, or for an
 * INSERT its payload user_id) whose register the fresh share snapshot no
 * longer lets this sailor write. Rows the sailor owns never qualify.
 */
function orphanedSharedMutation(
    item: SyncQueueItem,
    authenticatedUserId: string,
): { owner: string; register: BinderRegister } | null {
    if (!TABLE_REGISTER[item.table_name] || ORPHAN_UNCHECKED_TABLES.has(item.table_name)) return null;
    let row: { user_id?: unknown; voyage_id?: unknown } | null = getById<{ user_id?: unknown }>(
        item.table_name,
        item.record_id,
    );
    if (!row && item.mutation_type === 'INSERT') {
        try {
            row = JSON.parse(item.payload) as { user_id?: unknown; voyage_id?: unknown };
        } catch {
            return null;
        }
    }
    if (!row) return null;
    const register = binderRegisterForRow(item.table_name, row);
    if (!register) return null;
    // Before the server can share a galley, it is the server's call, as it
    // always was: nothing here drops or moves a galley change.
    if (register === 'galley' && !isGalleyShareLive()) return null;
    const owner = typeof row.user_id === 'string' ? row.user_id.trim() : '';
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
 *  - an engine-hours reading is never moved: it is that skipper's boat's
 *    figure, and its row id is derived from his id (LocalEngineHoursService).
 * An attachment reference into someone else's vault folder is cleared; a
 * local file still uploads, now to the sailor's own folder.
 */
function rehomeChanges(
    item: SyncQueueItem,
    register: BinderRegister,
    authenticatedUserId: string,
): Record<string, unknown> | null {
    if (item.mutation_type !== 'INSERT' || anySkipperGrantsWrite(register)) return null;
    if (item.table_name === 'vessel_engine_hours') return null;
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
    registers: BinderRegister[];
    restoreFromServer: boolean;
}> {
    const queue = getFullQueue();
    if (queue.length === 0) {
        return {
            count: 0,
            errors: [],
            discarded: 0,
            rehomed: 0,
            ownerIds: [],
            registers: [],
            restoreFromServer: false,
        };
    }

    let succeeded = 0;
    let discarded = 0;
    let rehomed = 0;
    let restoreFromServer = false;
    const errors: string[] = [];
    const blockedRecords = new Set<string>();
    const discardedRecords = new Set<string>();
    const orphanOwners = new Set<string>();
    const orphanRegisters = new Set<BinderRegister>();

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
        if (orphan) {
            orphanOwners.add(orphan.owner);
            orphanRegisters.add(orphan.register);
        }
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
            if (OPTIONAL_TABLES.has(item.table_name) && isMissingTableError(e)) {
                // Not an error: the table is not on this server yet. The change
                // waits, unmarked, for a cycle that finds it.
                missingOptionalTables.add(item.table_name);
                blockedRecords.add(recordKey);
                if (!isLocalDatabaseSessionCurrent(databaseSession)) break;
                continue;
            }
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

    return {
        count: succeeded,
        errors,
        discarded,
        rehomed,
        ownerIds: [...orphanOwners],
        registers: [...orphanRegisters],
        restoreFromServer,
    };
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

            if (error) throw new ServerRequestError(error);
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

            if (error) throw new ServerRequestError(error);
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
            if (selectError) throw new ServerRequestError(selectError);

            if (visibleBefore) {
                const { data: deleted, error: deleteError } = await supabase
                    .from(table)
                    .delete()
                    .eq('id', item.record_id)
                    .select('id')
                    .maybeSingle();
                if (deleteError) throw new ServerRequestError(deleteError);

                if (!deleted) {
                    // A concurrent delete is success; a still-visible row
                    // means SELECT is allowed but DELETE was denied by policy
                    // and must stay queued.
                    const { data: visibleAfter, error: verifyError } = await supabase
                        .from(table)
                        .select('id')
                        .eq('id', item.record_id)
                        .maybeSingle();
                    if (verifyError) throw new ServerRequestError(verifyError);
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

/** No signed-in session to pin a pull to: this cycle reads nothing more. */
class NoPullSessionError extends Error {}

/**
 * The signed-in user's bearer, read just before a table is pulled or listed,
 * and set on every page of it. Left to itself, supabase-js sends the ANON key
 * on any request made while a token refresh fails with a retryable error (a
 * dropped link, a 502/503/504): auth-js then hands getSession() a null session
 * without signing out, and RLS answers anon with an empty list and HTTP 200.
 * An empty listing pruned every clean binder row on this device, and an empty
 * pull advanced the watermark past rows it never read. Pinned, a token that
 * expires mid-table is a 401: an error, and nothing pruned or skipped.
 * (fetchWithAuth fills Authorization only when the request has none.)
 */
async function pinnedBearer(databaseSession: LocalDatabaseSession): Promise<string> {
    if (!supabase) throw new Error('Supabase not configured');
    const { data, error } = await supabase.auth.getSession();
    assertDatabaseSession(databaseSession);
    const session = data?.session;
    if (error || !session?.access_token) {
        throw new NoPullSessionError(error?.message || 'No signed-in session to pull with');
    }
    if (session.user?.id !== databaseSession.identity) {
        throw new NoPullSessionError('The signed-in session does not match the local database identity');
    }
    return `Bearer ${session.access_token}`;
}

function looksLikeCollapse(plan: PrunePlan): boolean {
    if (plan.removing === 0) return false;
    if (plan.visible === 0) return true;
    return plan.eligible >= COLLAPSE_MIN_ROWS && plan.removing * 2 > plan.eligible;
}

/**
 * The veto a prune runs under (see COLLAPSE_MIN_ROWS). `held` reports whether
 * it held one back, so the caller asks for the second read.
 */
function collapseGuard(
    table: SyncableTable,
    databaseSession: LocalDatabaseSession,
): { allowPrune: (plan: PrunePlan) => boolean; held: () => boolean } {
    const cycle = syncCycleSerial;
    const identity = databaseSession.identity ?? '';
    let held = false;
    const allowPrune = (plan: PrunePlan): boolean => {
        const earlier = heldCollapses.get(table);
        if (!looksLikeCollapse(plan)) {
            heldCollapses.delete(table);
            return true;
        }
        if (
            earlier &&
            earlier.identity === identity &&
            earlier.cycle < cycle &&
            Date.now() - earlier.at <= COLLAPSE_CONFIRM_WINDOW_MS
        ) {
            heldCollapses.delete(table);
            log.warn(
                `[SyncService] ${table}: a second read agrees; removing ${plan.removing} of ${plan.eligible} rows`,
            );
            return true;
        }
        if (earlier?.cycle !== cycle) heldCollapses.set(table, { identity, cycle, at: Date.now() });
        held = true;
        log.warn(
            `[SyncService] ${table}: the server lists ${plan.visible} rows, missing ${plan.removing} of the ` +
                `${plan.eligible} here; keeping them until a second read agrees`,
        );
        return false;
    };
    return { allowPrune, held: () => held };
}

async function pullUpdates(
    forceFull: boolean,
    databaseSession: LocalDatabaseSession,
    sweepDeletions = false,
): Promise<{ count: number; errors: string[]; pruned: number; sweepIncomplete: boolean }> {
    if (!supabase) return { count: 0, errors: ['Supabase not configured'], pruned: 0, sweepIncomplete: sweepDeletions };

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
    let totalPruned = 0;
    let sweepIncomplete = false;
    let collapseHeld = false;
    const errors: string[] = [];
    // The optional tables this device has read in full, and what this cycle
    // learns about them (one found for the first time, or gone).
    const optionalReadAt: Record<string, string> = { ...(meta.optionalTablesReadAt ?? {}) };
    let optionalReadAtChanged = false;

    for (const table of SYNCABLE_TABLES) {
        const optional = OPTIONAL_TABLES.has(table);
        try {
            assertDatabaseSession(databaseSession);
            // A device's first read of an optional table is a full one: rows a
            // device with the new build wrote before this device's shared
            // watermark would otherwise never arrive here. No prune with it
            // unless the cycle is a full reconciliation anyway: nothing was
            // written to the table here before it was read.
            const { merged, pruned, held } = await pullTable(
                table,
                optional && !optionalReadAt[table] ? EPOCH : since,
                completedWatermark,
                reconcileSnapshot,
                databaseSession,
            );
            totalPulled += merged;
            totalPruned += pruned;
            collapseHeld ||= held;
            if (optional) {
                missingOptionalTables.delete(table);
                if (!optionalReadAt[table]) {
                    optionalReadAt[table] = completedWatermark;
                    optionalReadAtChanged = true;
                }
            }
        } catch (e) {
            // No session to pin: every other table would fail the same way
            // (after auth-js's own retries each time). Stop here, and replay.
            if (e instanceof NoPullSessionError) throw e;
            if (optional && isMissingTableError(e)) {
                // Not on this server yet (its migration is pushed separately).
                // Not an error: the other tables' watermark stands.
                missingOptionalTables.add(table);
                if (optionalReadAt[table]) {
                    delete optionalReadAt[table];
                    optionalReadAtChanged = true;
                }
                continue;
            }
            const msg = e instanceof Error ? e.message : 'Pull failed';
            errors.push(`${table}: ${msg}`);
        }
    }
    if (optionalReadAtChanged) {
        assertDatabaseSession(databaseSession);
        await updateSyncMeta({ optionalTablesReadAt: optionalReadAt });
    }

    // A full snapshot already pruned every table. Otherwise, when asked, list
    // just the ids of the binder tables and drop clean local rows the server
    // no longer has: a row deleted on another device while this one was not
    // listening. Best effort: a failure is retried by the next cycle and never
    // fails this one, whose incremental pull stands on its own.
    if (sweepDeletions && !reconcileSnapshot) {
        const galleyLive = isGalleyShareLive();
        for (const table of SYNCABLE_TABLES) {
            if (!TABLE_REGISTER[table] || missingOptionalTables.has(table)) continue;
            // The galley tables join the sweep once the server can share a
            // galley; before that this cycle reads exactly what it always did.
            if (TABLE_REGISTER[table] === 'galley' && !galleyLive) continue;
            try {
                assertDatabaseSession(databaseSession);
                const swept = await sweepDeletedRows(table, completedWatermark, databaseSession);
                totalPruned += swept.pruned;
                collapseHeld ||= swept.held;
            } catch (e) {
                if (!isLocalDatabaseSessionCurrent(databaseSession) || e instanceof NoPullSessionError) throw e;
                if (OPTIONAL_TABLES.has(table) && isMissingTableError(e)) {
                    missingOptionalTables.add(table);
                    continue;
                }
                sweepIncomplete = true;
                log.warn(
                    `[SyncService] Could not check ${table} for rows deleted elsewhere:`,
                    e instanceof Error ? e.message : e,
                );
            }
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

    // A held collapse is read again by a full reconciliation straight after
    // this cycle; the prune happens there if that read agrees.
    if (collapseHeld) {
        void requestFullReconciliation().catch((error) =>
            log.warn('[SyncService] Could not re-read a held collapse:', error),
        );
    }

    // The engine-hours table is live here: this device's figure from before
    // it existed goes up once, if the server has none or a lower one
    // (LocalEngineHoursService).
    if (optionalReadAt.vessel_engine_hours && !missingOptionalTables.has('vessel_engine_hours')) {
        await carryOverEngineHours(databaseSession);
    }

    return { count: totalPulled, errors, pruned: totalPruned, sweepIncomplete };
}

/** Best effort: a failed carry-over is retried next cycle and fails nothing. */
async function carryOverEngineHours(databaseSession: LocalDatabaseSession): Promise<void> {
    try {
        assertDatabaseSession(databaseSession);
        await LocalEngineHoursService.carryOverDeviceReading();
    } catch (error) {
        log.warn(
            "[SyncService] Could not carry this device's engine hours over:",
            error instanceof Error ? error.message : error,
        );
    }
}

/**
 * Every id of `table` this account can see, read in id order (ids only, so a
 * few kilobytes) with the user's own token, then prune the clean local rows
 * missing from it. Rows stamped after `watermark` arrived after the listing
 * began and are kept, and a listing that would empty the table is held.
 */
async function sweepDeletedRows(
    table: SyncableTable,
    watermark: string,
    databaseSession: LocalDatabaseSession,
): Promise<{ pruned: number; held: boolean }> {
    if (!supabase) return { pruned: 0, held: false };
    const authorization = await pinnedBearer(databaseSession);
    const visibleIds = new Set<string>();
    let after: string | null = null;
    for (;;) {
        assertDatabaseSession(databaseSession);
        let query = supabase
            .from(table)
            .select('id')
            .setHeader('Authorization', authorization)
            .order('id', { ascending: true });
        if (after !== null) query = query.gt('id', after);
        const { data, error } = await query.limit(PULL_PAGE_SIZE);
        assertDatabaseSession(databaseSession);
        if (error) throw new ServerRequestError(error);
        const rows = (data ?? []) as { id?: unknown }[];
        for (const row of rows) {
            if (typeof row.id !== 'string') throw new Error('Sync row is missing its record ID');
            visibleIds.add(row.id);
        }
        if (rows.length < PULL_PAGE_SIZE) break;
        after = rows[rows.length - 1].id as string;
    }
    assertDatabaseSession(databaseSession);
    const guard = collapseGuard(table, databaseSession);
    const pruned =
        (await prunePulledTable(table, visibleIds, { keepUpdatedAfter: watermark, allowPrune: guard.allowPrune })) ?? 0;
    return { pruned, held: guard.held() };
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
): Promise<{ merged: number; pruned: number; held: boolean }> {
    if (!supabase) return { merged: 0, pruned: 0, held: false };

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
    const authorization = await pinnedBearer(databaseSession);

    // PostgREST responses are capped, so page through the bounded server-time
    // window. Advancing the watermark after a single capped response would
    // silently strand every row beyond that response forever.
    for (;;) {
        assertDatabaseSession(databaseSession);
        let query = supabase
            .from(table)
            .select('*')
            .setHeader('Authorization', authorization)
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

        if (error) throw new ServerRequestError(error);
        if (!data || data.length === 0) break;

        if (visibleIds) {
            for (const row of data) {
                if (typeof row.id !== 'string') throw new Error('Sync row is missing its record ID');
                visibleIds.add(row.id);
            }
        }
        // `until` fences a page read before another device's change landed
        // here by realtime: that newer local row is not put back to the old one.
        merged += await mergePulledRecords(table, data as { id: string; updated_at?: string; created_at?: string }[], {
            until,
        });
        if (data.length < PULL_PAGE_SIZE) break;
        const last = data[data.length - 1] as { id?: unknown; updated_at?: unknown };
        if (typeof last.id !== 'string' || typeof last.updated_at !== 'string') {
            throw new Error('Sync page is missing its keyset cursor');
        }
        cursor = { updatedAt: last.updated_at, id: last.id };
    }

    let pruned = 0;
    let held = false;
    if (visibleIds) {
        assertDatabaseSession(databaseSession);
        // Rows stamped after the snapshot's upper bound reached this device
        // after the read began (realtime); missing from it is not deleted.
        // A snapshot that would empty the table is held for a second read.
        const guard = collapseGuard(table, databaseSession);
        pruned =
            (await prunePulledTable(table, visibleIds, { keepUpdatedAfter: until, allowPrune: guard.allowPrune })) ?? 0;
        held = guard.held();
    }
    return { merged, pruned, held };
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
