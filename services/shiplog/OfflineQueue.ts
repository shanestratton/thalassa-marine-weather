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
import { supabase } from '../supabase';
import { createLogger } from '../../utils/logger';
import { SHIP_LOGS_TABLE } from './helpers';

const log = createLogger('OfflineQueue');

const OFFLINE_QUEUE_KEY = 'ship_log_offline_queue';
const MAX_OFFLINE_QUEUE = 500;

/**
 * Queue entry for offline sync.
 * Caps queue at MAX_OFFLINE_QUEUE entries to prevent unbounded storage growth.
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
            value: JSON.stringify(queue)
        });

    } catch (error) {
        log.error('queueOfflineEntry failed', error);
    }
}

/**
 * Sync offline queue to Supabase when connection restored.
 * @returns Number of entries synced
 */
export async function syncOfflineQueue(): Promise<number> {
    if (!supabase) return 0;

    try {
        const { value } = await Preferences.get({ key: OFFLINE_QUEUE_KEY });
        if (!value) return 0;

        const queue: Partial<ShipLogEntry>[] = JSON.parse(value);
        if (queue.length === 0) return 0;

        // Try to insert all queued entries
        const { data, error } = await supabase
            .from(SHIP_LOGS_TABLE)
            .insert(queue)
            .select();

        if (error) {
            return 0;
        }

        // Success - clear queue
        await Preferences.remove({ key: OFFLINE_QUEUE_KEY });

        return data.length;
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
    } catch {
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
        return queue.map((entry, index) => ({
            id: `offline_${index}`,
            ...entry
        } as ShipLogEntry));
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
        const filteredQueue = queue.filter(entry => {
            if (voyageId === 'default_voyage') {
                return entry.voyageId && entry.voyageId !== '';
            }
            return entry.voyageId !== voyageId;
        });

        if (filteredQueue.length === originalLength) return false;

        await Preferences.set({
            key: OFFLINE_QUEUE_KEY,
            value: JSON.stringify(filteredQueue)
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

        const filteredQueue = queue.filter(entry => entry.id !== entryId);

        if (filteredQueue.length === originalLength) return false;

        await Preferences.set({
            key: OFFLINE_QUEUE_KEY,
            value: JSON.stringify(filteredQueue)
        });

        return true;
    } catch (error) {
        return false;
    }
}
