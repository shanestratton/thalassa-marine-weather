/**
 * Entry CRUD Operations
 *
 * Database read/write/delete operations for ship log entries.
 * Extracted from ShipLogService to isolate data access concerns.
 */

import { ShipLogEntry } from '../../types';
import { supabase } from '../supabase';
import { createLogger } from '../../utils/logger';
import { SHIP_LOGS_TABLE, toDbFormat, fromDbFormat } from './helpers';
import {
    deleteVoyageFromOfflineQueue,
    deleteEntryFromOfflineQueue,
} from './OfflineQueue';

const log = createLogger('EntryCrud');

/**
 * Fetch log entries for current user.
 */
export async function getLogEntries(limit: number = 50): Promise<ShipLogEntry[]> {
    if (!supabase) {
        return [];
    }

    try {
        // Check if user is authenticated
        const { data: { user } } = await supabase.auth.getUser();
        if (!user) {
            return [];
        }

        const { data, error } = await supabase
            .from(SHIP_LOGS_TABLE)
            .select('*')
            .order('timestamp', { ascending: false })
            .limit(limit);

        if (error) {
            return [];
        }

        return (data || []).map(row => fromDbFormat(row));
    } catch (error) {
        log.error('getLogEntries failed', error);
        return [];
    }
}

/**
 * Delete a voyage and all its entries (from both DB and offline queue).
 */
export async function deleteVoyage(voyageId: string): Promise<boolean> {

    // First, try to delete from offline queue (local storage)
    const offlineDeleted = await deleteVoyageFromOfflineQueue(voyageId);

    // If Supabase is available, also delete from there
    if (supabase) {
        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (user) {
                let query = supabase
                    .from(SHIP_LOGS_TABLE)
                    .delete()
                    .eq('user_id', user.id);

                // Handle 'default_voyage' - these are entries with null/empty voyageId
                if (voyageId === 'default_voyage') {
                    query = query.or('voyage_id.is.null,voyage_id.eq.');
                } else {
                    query = query.eq('voyage_id', voyageId);
                }

                const { error } = await query;
                if (error) {
                } else {
                }
            }
        } catch (error) {
            log.error('deleteVoyage: DB delete failed', error);
        }
    }

    // Return true if we deleted from offline queue (or if nothing was there)
    return true;
}

/**
 * Delete a single entry by ID (from both DB and offline queue).
 */
export async function deleteEntry(entryId: string): Promise<boolean> {

    // First, try to delete from offline queue (local storage)
    const offlineDeleted = await deleteEntryFromOfflineQueue(entryId);

    // If Supabase is available, also delete from there
    if (supabase) {
        try {
            const { data: { user } } = await supabase.auth.getUser();
            if (user) {
                const { error } = await supabase
                    .from(SHIP_LOGS_TABLE)
                    .delete()
                    .eq('id', entryId)
                    .eq('user_id', user.id);

                if (error) {
                } else {
                }
            }
        } catch (error) {
            log.error('deleteEntry: DB delete failed', error);
        }
    }

    return true;
}

/**
 * Import GPX entries as a new voyage in the database.
 * All entries are stamped with source: 'gpx_import' to prevent
 * them from being used as an official logbook record.
 */
export async function importGPXVoyage(entries: Partial<ShipLogEntry>[]): Promise<{ voyageId: string; savedCount: number }> {
    if (entries.length === 0) {
        throw new Error('No entries to import');
    }

    const voyageId = crypto.randomUUID();

    if (!supabase) {
        throw new Error('Database not available — connect to import tracks');
    }

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
        throw new Error('Login required to import tracks');
    }

    // Prepare all entries for batch insert
    const dbEntries = entries.map((entry, index) => {
        const fullEntry: Partial<ShipLogEntry> = {
            ...entry,
            id: crypto.randomUUID(),
            userId: user.id,
            voyageId,
            source: (entry as any).source || 'gpx_import',
            distanceNM: entry.distanceNM || 0,
            cumulativeDistanceNM: entry.cumulativeDistanceNM || 0,
            speedKts: entry.speedKts || 0,
        };
        return toDbFormat(fullEntry);
    });

    // Batch insert in chunks of 100 to avoid payload limits
    const CHUNK_SIZE = 100;
    let savedCount = 0;

    for (let i = 0; i < dbEntries.length; i += CHUNK_SIZE) {
        const chunk = dbEntries.slice(i, i + CHUNK_SIZE);
        const { error } = await supabase
            .from(SHIP_LOGS_TABLE)
            .insert(chunk);

        if (error) {
            throw new Error(`Import failed at entry ${i}: ${error.message}`);
        }
        savedCount += chunk.length;
    }

    return { voyageId, savedCount };
}
