/**
 * Offline Queue Manager
 *
 * Handles queueing, syncing, and managing ship log entries
 * when the device has no network connectivity.
 *
 * Extracted from ShipLogService to isolate offline-first concerns.
 */

import { Preferences } from '@capacitor/preferences';
import { ShipLogEntry } from '../../types';
import { supabase, getCurrentUser } from '../supabase';
import { createLogger } from '../../utils/createLogger';
import { SHIP_LOGS_TABLE, toDbFormat } from './helpers';

const log = createLogger('OfflineQueue');

const OFFLINE_QUEUE_KEY = 'ship_log_offline_queue';
const MAX_OFFLINE_QUEUE = 50_000;

// ── IN-MEMORY WRITE-THROUGH CACHE (2026-07-03) ──────────────────────
// The queue used to be re-read + re-serialised from Preferences on EVERY
// point — twice per auto point (append + rolling-waypoint demote). At the
// real iOS fix rate (~1 Hz underway; the "5 s cadence" is Android-only)
// an 8-hour passage builds a ~17 MB queue, so each new point cost two
// full multi-MB JSON parse+stringify cycles: O(n²) churn that stalls the
// flush loop behind GPS ingest until the 1200-slot ring buffer silently
// drops the OLDEST unflushed fixes — genuine track loss in the final
// hours of a long passage (adversarial audit 2026-07-03, finding #0).
//
// Now the queue lives in memory and persists on a debounce: at most one
// disk write per PERSIST_INTERVAL_MS (or every PERSIST_EVERY_N appends,
// whichever trips first), plus an awaited flush before any sync/delete
// snapshot. Trade-off, documented and accepted: a hard crash can lose up
// to ~10 s of points — versus the O(n²) cascade that lost HOURS.
// Append-only semantics and the sync prefix contract are unchanged; all
// readers/writers below go through the same in-memory queue.
const PERSIST_INTERVAL_MS = 10_000;
const PERSIST_EVERY_N = 25;

let memQueue: Partial<ShipLogEntry>[] | null = null;
let hydrating: Promise<Partial<ShipLogEntry>[]> | null = null;
let appendsSincePersist = 0;
let persistTimer: ReturnType<typeof setTimeout> | null = null;
let persisting: Promise<void> | null = null;

async function loadQueue(): Promise<Partial<ShipLogEntry>[]> {
    if (memQueue) return memQueue;
    if (hydrating) return hydrating;
    hydrating = (async () => {
        try {
            const { value } = await Preferences.get({ key: OFFLINE_QUEUE_KEY });
            memQueue = value ? (JSON.parse(value) as Partial<ShipLogEntry>[]) : [];
        } catch (e) {
            log.error('offline queue hydrate failed — starting empty (disk copy left untouched)', e);
            memQueue = [];
        }
        hydrating = null;
        return memQueue;
    })();
    return hydrating;
}

async function persistNow(): Promise<void> {
    // Serialise writes — overlapping Preferences.set with a multi-MB value
    // is exactly the churn this cache exists to avoid.
    if (persisting) await persisting;
    if (!memQueue) return;
    if (persistTimer) {
        clearTimeout(persistTimer);
        persistTimer = null;
    }
    appendsSincePersist = 0;
    const snapshot = memQueue;
    persisting = (async () => {
        try {
            if (snapshot.length === 0) {
                await Preferences.remove({ key: OFFLINE_QUEUE_KEY });
            } else {
                await Preferences.set({ key: OFFLINE_QUEUE_KEY, value: JSON.stringify(snapshot) });
            }
        } catch (e) {
            log.error('offline queue persist failed (entries remain in memory)', e);
        } finally {
            persisting = null;
        }
    })();
    await persisting;
}

function schedulePersist(): void {
    appendsSincePersist++;
    if (appendsSincePersist >= PERSIST_EVERY_N) {
        void persistNow();
        return;
    }
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
        persistTimer = null;
        void persistNow();
    }, PERSIST_INTERVAL_MS);
}

/** Awaited disk flush — for lifecycle hooks (app background, tracking stop). */
export async function flushOfflineQueueToDisk(): Promise<void> {
    await loadQueue();
    await persistNow();
}

// ── LOCAL-ONLY CAPTURE MODE ─────────────────────────────────────────
// While a voyage is actively recording, every captured point is written
// to the DEVICE only (this queue) — zero network on the capture path.
// The whole voyage uploads to Supabase in the background once tracking
// stops. State lives HERE (not EntrySave) because the queue is the
// thing being protected: syncOfflineQueue refuses to run while the
// queue is the live store for a recording voyage.
// EntrySave re-exports the accessors for its existing callers.
let captureLocalOnly = false;

export function setCaptureLocalOnly(enabled: boolean): void {
    captureLocalOnly = enabled;
}

export function isCaptureLocalOnly(): boolean {
    return captureLocalOnly;
}

/**
 * Queue entry for offline sync.
 * Caps queue at 50,000 entries — enough for weeks of offshore tracking
 * at 30-60s intervals without hitting the limit.
 */
export async function queueOfflineEntry(entry: Partial<ShipLogEntry>): Promise<void> {
    try {
        const queue = await loadQueue();
        queue.push(entry);

        // PERF: Cap queue size — drop oldest entries if we exceed the limit
        // In long voyages with poor connectivity, this prevents unbounded growth
        if (queue.length > MAX_OFFLINE_QUEUE) {
            queue.splice(0, queue.length - MAX_OFFLINE_QUEUE);
        }

        // Debounced — NOT a per-point multi-MB Preferences.set (see header).
        schedulePersist();
    } catch (error) {
        log.error('queueOfflineEntry failed', error);
    }
}

/**
 * Demote any queued 'Latest Position' auto-waypoints for a voyage back to
 * plain 'auto' entries — the in-queue twin of EntrySave's DB-side
 * demotePreviousAutoWaypoint, used while local-only capture is active
 * (during a recording voyage the previous rolling waypoint lives here,
 * not in Supabase).
 */
export async function demoteLatestPositionInQueue(voyageId: string): Promise<void> {
    if (!voyageId) return;
    try {
        const queue = await loadQueue();
        let changed = false;
        for (const e of queue) {
            if (e.voyageId === voyageId && e.entryType === 'waypoint' && e.waypointName === 'Latest Position') {
                e.entryType = 'auto';
                e.waypointName = undefined;
                changed = true;
            }
        }
        // In-memory mutation only — this used to be the SECOND full-queue
        // disk rewrite on every auto point. The debounced persist carries it.
        if (changed) schedulePersist();
    } catch (e) {
        log.warn('demoteLatestPositionInQueue failed', e);
    }
}

/**
 * Normalise rolling waypoints within a batch before upload: per voyage,
 * only the NEWEST 'Latest Position' survives — older ones (left behind by
 * crashes or missed demotions) become plain 'auto' entries. Pure; exported
 * for tests.
 */
export function normalizeLatestPositions(queue: Partial<ShipLogEntry>[]): Partial<ShipLogEntry>[] {
    const newestPerVoyage = new Map<string, number>(); // voyageId → index in queue
    queue.forEach((e, i) => {
        if (e.entryType !== 'waypoint' || e.waypointName !== 'Latest Position') return;
        const vid = e.voyageId || 'default_voyage';
        const prev = newestPerVoyage.get(vid);
        const prevTs = prev !== undefined ? new Date(queue[prev].timestamp || 0).getTime() : -1;
        if (new Date(e.timestamp || 0).getTime() >= prevTs) newestPerVoyage.set(vid, i);
    });
    const keep = new Set(newestPerVoyage.values());
    return queue.map((e, i) => {
        if (e.entryType === 'waypoint' && e.waypointName === 'Latest Position' && !keep.has(i)) {
            return { ...e, entryType: 'auto' as const, waypointName: undefined };
        }
        return e;
    });
}

// ── Voyage tombstones ────────────────────────────────────────────────
// deleteVoyage races the stop-tracking upload: syncOfflineQueue snapshots
// the queue BEFORE the empty-voyage auto-prune deletes it, then faithfully
// re-uploads the deleted entries — the "tidied away" voyage resurrects
// from the cloud on the next load (Shane 2026-07-03: "if you click on
// 'got it', it does not delete"). A deleted voyageId is tombstoned for
// TOMBSTONE_TTL_MS: sync purges tombstoned entries from the queue before
// snapshotting, and re-deletes any tombstoned voyage its in-flight
// snapshot managed to upload anyway.
const TOMBSTONE_KEY = 'ship_log_deleted_voyages';
const TOMBSTONE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let tombstones: Record<string, number> | null = null;

async function loadTombstones(): Promise<Record<string, number>> {
    if (tombstones) return tombstones;
    try {
        const { value } = await Preferences.get({ key: TOMBSTONE_KEY });
        const parsed = value ? (JSON.parse(value) as unknown) : {};
        tombstones =
            parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, number>) : {};
    } catch {
        tombstones = {};
    }
    // Expire old stones so the set can't grow forever.
    const cutoff = Date.now() - TOMBSTONE_TTL_MS;
    let changed = false;
    for (const [vid, ts] of Object.entries(tombstones)) {
        if (ts < cutoff) {
            delete tombstones[vid];
            changed = true;
        }
    }
    if (changed) void Preferences.set({ key: TOMBSTONE_KEY, value: JSON.stringify(tombstones) });
    return tombstones;
}

/** Mark a voyage as deleted — sync will never (re-)upload its entries. */
export async function addVoyageTombstone(voyageId: string): Promise<void> {
    if (!voyageId) return;
    const stones = await loadTombstones();
    stones[voyageId] = Date.now();
    try {
        await Preferences.set({ key: TOMBSTONE_KEY, value: JSON.stringify(stones) });
    } catch {
        /* in-memory stone still guards this session */
    }
}

function isTombstoned(stones: Record<string, number>, e: Partial<ShipLogEntry>): boolean {
    const vid = e.voyageId || 'default_voyage';
    return stones[vid] !== undefined;
}

/** Insert batch size — matches the GPX importer's chunking. */
const SYNC_CHUNK_SIZE = 500;

// In-flight latch — overlapping sync triggers (page mount, 2-min interval,
// stop-tracking flush, app resume) must not race each other. Without it,
// two concurrent runs each snapshot the queue, both upload, both rewrite
// the key → duplicated rows AND lost live-voyage points.
let isSyncing = false;

/**
 * Sync offline queue to Supabase — the upload half of local-first capture.
 *
 * Maps each queued entry to DB format (snake_case) with the user_id
 * stamped, normalises duplicate rolling waypoints, and inserts in chunks.
 * On a mid-batch failure the UNSYNCED remainder is written back to the
 * queue, so the next sync attempt (stop-tracking flush, 2-minute interval,
 * or app launch) picks up exactly where this one left off.
 *
 * CONCURRENCY: the queue is append-only between snapshot and rewrite, so
 * the uploaded snapshot is always a PREFIX of the live queue. After
 * uploading we RE-READ the queue and slice off only what was uploaded —
 * never wipe the whole key. Points a recording voyage appended while the
 * upload was in flight survive. The previous implementation's
 * unconditional `Preferences.remove()` destroyed them (start tracking
 * while the page-mount sync is uploading → first minutes of the new
 * track gone).
 *
 * NOTE: the original implementation inserted the raw camelCase objects
 * with no user_id — Postgres rejected every batch and the queue never
 * drained. If a long-queued backlog suddenly appears in your log after
 * this fix, that's it finally syncing.
 *
 * @returns Number of entries synced
 */
export async function syncOfflineQueue(): Promise<number> {
    if (!supabase) return 0;
    if (isSyncing) return 0; // another sync is already running
    // Mid-voyage the queue IS the live store — never upload (or rewrite)
    // it until the voyage stops and stopTracking flips this off.
    if (captureLocalOnly) return 0;

    isSyncing = true;
    try {
        // Purge tombstoned (deleted-voyage) entries from the live queue
        // BEFORE snapshotting — a voyage the user just binned must never
        // upload (see the tombstone header above).
        const stones = await loadTombstones();
        const live = await loadQueue();
        if (Object.keys(stones).length > 0) {
            const kept = live.filter((e) => !isTombstoned(stones, e));
            if (kept.length !== live.length) {
                log.warn(`syncOfflineQueue: purged ${live.length - kept.length} entries from deleted voyage(s)`);
                live.length = 0;
                live.push(...kept);
                await persistNow();
            }
        }
        // Snapshot the LIVE in-memory queue (hydrating from disk if this is a
        // fresh session). slice() pins the upload set; appends during the
        // upload land in memQueue and survive via commitProgress below.
        const queue = live.slice();
        if (queue.length === 0) return 0;

        const user = await getCurrentUser();
        if (!user) return 0; // signed out — keep queue intact for later

        const normalized = normalizeLatestPositions(queue);

        // Drop the synced prefix from the LIVE queue. The queue only ever
        // grows by appends, so entries [0, syncedCount) of the live queue are
        // exactly what we uploaded; everything after survives. Persisted
        // immediately — upload progress must never be replayable from disk.
        const commitProgress = async (syncedCount: number) => {
            const live = await loadQueue();
            live.splice(0, syncedCount);
            await persistNow();
        };

        let synced = 0;
        for (let i = 0; i < normalized.length; i += SYNC_CHUNK_SIZE) {
            const chunk = normalized.slice(i, i + SYNC_CHUNK_SIZE).map((e) => {
                const row = toDbFormat({ ...e, userId: user.id });
                delete row.id; // never ship synthetic/display ids — DB generates real ones
                return row;
            });

            const { error } = await supabase.from(SHIP_LOGS_TABLE).insert(chunk);
            if (error) {
                log.warn(`syncOfflineQueue: chunk failed after ${synced} synced — keeping remainder`, error.message);
                await commitProgress(synced);
                return synced;
            }
            synced += chunk.length;
        }

        await commitProgress(synced);
        // A voyage deleted WHILE this upload was in flight (its tombstone
        // landed after our snapshot) may have just been re-inserted — issue
        // the cloud delete again so the bin sticks.
        const stonesAfter = await loadTombstones();
        const resurrected = new Set(
            queue.filter((e) => isTombstoned(stonesAfter, e)).map((e) => e.voyageId || 'default_voyage'),
        );
        for (const vid of resurrected) {
            try {
                const del = supabase.from(SHIP_LOGS_TABLE).delete().eq('user_id', user.id);
                const { error } = await (vid === 'default_voyage'
                    ? del.or('voyage_id.is.null,voyage_id.eq.')
                    : del.eq('voyage_id', vid));
                if (!error) log.warn(`syncOfflineQueue: re-deleted mid-flight-binned voyage ${vid}`);
            } catch (e) {
                log.warn(`syncOfflineQueue: re-delete of ${vid} failed (next sync retries)`, e);
            }
        }
        if (synced > 0) log.warn(`syncOfflineQueue: uploaded ${synced} entries`);
        return synced;
    } catch (error) {
        log.error('syncOfflineQueue failed', error);
        return 0;
    } finally {
        isSyncing = false;
    }
}

/**
 * Get count of offline queue entries.
 */
export async function getOfflineQueueCount(): Promise<number> {
    try {
        return (await loadQueue()).length;
    } catch (e) {
        log.warn('[OfflineQueue]', e);
        /* read failure — 0 is safe default */
        return 0;
    }
}

/**
 * Get offline queued entries for display (when not connected to database).
 * Adds temporary IDs for rendering.
 */
export async function getOfflineEntries(): Promise<ShipLogEntry[]> {
    try {
        const queue = await loadQueue();

        // Add temporary IDs for display
        return queue.map(
            (entry, index) =>
                ({
                    id: `offline_${index}`,
                    ...entry,
                }) as ShipLogEntry,
        );
    } catch (error) {
        log.error('getOfflineEntries failed', error);
        return [];
    }
}

/**
 * Delete entries from offline queue by voyage ID.
 */
export async function deleteVoyageFromOfflineQueue(voyageId: string): Promise<boolean> {
    try {
        // Tombstone FIRST — even if nothing is queued locally, an in-flight
        // sync snapshot may still hold this voyage's entries.
        await addVoyageTombstone(voyageId);
        const queue = await loadQueue();
        const originalLength = queue.length;

        // Filter out entries matching voyageId (or null/empty for default_voyage)
        const filtered = queue.filter((entry) => {
            if (voyageId === 'default_voyage') {
                return entry.voyageId && entry.voyageId !== '';
            }
            return entry.voyageId !== voyageId;
        });

        if (filtered.length === originalLength) return false;

        queue.length = 0;
        queue.push(...filtered);
        await persistNow(); // destructive op — hit disk immediately
        return true;
    } catch (error) {
        return false;
    }
}

/**
 * Delete entry from offline queue by ID.
 */
export async function deleteEntryFromOfflineQueue(entryId: string): Promise<boolean> {
    try {
        const queue = await loadQueue();
        const originalLength = queue.length;

        const filtered = queue.filter((entry) => entry.id !== entryId);
        if (filtered.length === originalLength) return false;

        queue.length = 0;
        queue.push(...filtered);
        await persistNow(); // destructive op — hit disk immediately
        return true;
    } catch (error) {
        return false;
    }
}
