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
import { createLogger } from '../../utils/logger';
import { SHIP_LOGS_TABLE, toDbFormat } from './helpers';

const log = createLogger('OfflineQueue');

const OFFLINE_QUEUE_KEY = 'ship_log_offline_queue';
const MAX_OFFLINE_QUEUE = 50_000;

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

/**
 * Sync offline queue to Supabase — the upload half of local-first capture.
 *
 * Maps each queued entry to DB format (snake_case) with the user_id
 * stamped, normalises duplicate rolling waypoints, and inserts in chunks.
 * On a mid-batch failure the UNSYNCED remainder is written back to the
 * queue, so the next sync attempt (stop-tracking flush, 2-minute interval,
 * or app launch) picks up exactly where this one left off.
 *
 * NOTE: the previous implementation inserted the raw camelCase objects
 * with no user_id — Postgres rejected every batch and the queue never
 * drained. If a long-queued backlog suddenly appears in your log after
 * this fix, that's it finally syncing.
 *
 * @returns Number of entries synced
 */
export async function syncOfflineQueue(): Promise<number> {
    if (!supabase) return 0;

    try {
        const { value } = await Preferences.get({ key: OFFLINE_QUEUE_KEY });
        if (!value) return 0;

        const queue: Partial<ShipLogEntry>[] = JSON.parse(value);
        if (queue.length === 0) return 0;

        const user = await getCurrentUser();
        if (!user) return 0; // signed out — keep queue intact for later

        const normalized = normalizeLatestPositions(queue);

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
                // Preserve everything not yet inserted (original objects, not mapped rows)
                const remainder = normalized.slice(i);
                await Preferences.set({ key: OFFLINE_QUEUE_KEY, value: JSON.stringify(remainder) });
                return synced;
            }
            synced += chunk.length;
        }

        // Everything inserted — clear the queue
        await Preferences.remove({ key: OFFLINE_QUEUE_KEY });
        if (synced > 0) log.warn(`syncOfflineQueue: uploaded ${synced} entries`);
        return synced;
    } catch (error) {
        log.error('syncOfflineQueue failed', error);
        return 0;
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
