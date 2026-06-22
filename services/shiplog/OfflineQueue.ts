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
        const { value } = await Preferences.get({ key: OFFLINE_QUEUE_KEY });
        const queue: Partial<ShipLogEntry>[] = value ? JSON.parse(value) : [];

        queue.push(entry);

        // PERF: Cap queue size — drop oldest entries if we exceed the limit
        // In long voyages with poor connectivity, this prevents unbounded growth
        if (queue.length > MAX_OFFLINE_QUEUE) {
            queue.splice(0, queue.length - MAX_OFFLINE_QUEUE);
        }

        await Preferences.set({
            key: OFFLINE_QUEUE_KEY,
            value: JSON.stringify(queue),
        });
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
        const { value } = await Preferences.get({ key: OFFLINE_QUEUE_KEY });
        if (!value) return;
        const queue: Partial<ShipLogEntry>[] = JSON.parse(value);

        let changed = false;
        for (const e of queue) {
            if (e.voyageId === voyageId && e.entryType === 'waypoint' && e.waypointName === 'Latest Position') {
                e.entryType = 'auto';
                e.waypointName = undefined;
                changed = true;
            }
        }
        if (changed) {
            await Preferences.set({ key: OFFLINE_QUEUE_KEY, value: JSON.stringify(queue) });
        }
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
        const { value } = await Preferences.get({ key: OFFLINE_QUEUE_KEY });
        if (!value) return 0;

        const queue: Partial<ShipLogEntry>[] = JSON.parse(value);
        if (queue.length === 0) return 0;

        const user = await getCurrentUser();
        if (!user) return 0; // signed out — keep queue intact for later

        const normalized = normalizeLatestPositions(queue);

        // Rewrite the queue as (live queue) minus (synced prefix). The
        // queue only ever grows by appends, so entries [0, syncedCount)
        // of the re-read queue are exactly what we uploaded.
        const commitProgress = async (syncedCount: number) => {
            const { value: nowValue } = await Preferences.get({ key: OFFLINE_QUEUE_KEY });
            const liveQueue: Partial<ShipLogEntry>[] = nowValue ? JSON.parse(nowValue) : [];
            const remainder = liveQueue.slice(syncedCount);
            if (remainder.length === 0) {
                await Preferences.remove({ key: OFFLINE_QUEUE_KEY });
            } else {
                await Preferences.set({ key: OFFLINE_QUEUE_KEY, value: JSON.stringify(remainder) });
            }
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
        const { value } = await Preferences.get({ key: OFFLINE_QUEUE_KEY });
        if (!value) return 0;
        const queue: Partial<ShipLogEntry>[] = JSON.parse(value);
        return queue.length;
    } catch (e) {
        log.warn('[OfflineQueue]', e);
        /* Preferences read/parse failure — 0 is safe default */
        return 0;
    }
}

/**
 * Get offline queued entries for display (when not connected to database).
 * Adds temporary IDs for rendering.
 */
export async function getOfflineEntries(): Promise<ShipLogEntry[]> {
    try {
        const { value } = await Preferences.get({ key: OFFLINE_QUEUE_KEY });
        if (!value) return [];

        const queue: Partial<ShipLogEntry>[] = JSON.parse(value);

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
        const { value } = await Preferences.get({ key: OFFLINE_QUEUE_KEY });
        if (!value) return false;

        const queue: Partial<ShipLogEntry>[] = JSON.parse(value);
        const originalLength = queue.length;

        // Filter out entries matching voyageId (or null/empty for default_voyage)
        const filteredQueue = queue.filter((entry) => {
            if (voyageId === 'default_voyage') {
                return entry.voyageId && entry.voyageId !== '';
            }
            return entry.voyageId !== voyageId;
        });

        if (filteredQueue.length === originalLength) return false;

        await Preferences.set({
            key: OFFLINE_QUEUE_KEY,
            value: JSON.stringify(filteredQueue),
        });

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
        const { value } = await Preferences.get({ key: OFFLINE_QUEUE_KEY });
        if (!value) return false;

        const queue: Partial<ShipLogEntry>[] = JSON.parse(value);
        const originalLength = queue.length;

        const filteredQueue = queue.filter((entry) => entry.id !== entryId);

        if (filteredQueue.length === originalLength) return false;

        await Preferences.set({
            key: OFFLINE_QUEUE_KEY,
            value: JSON.stringify(filteredQueue),
        });

        return true;
    } catch (error) {
        return false;
    }
}
