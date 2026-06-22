/**
 * Entry CRUD Operations
 *
 * Database read/write/delete operations for ship log entries.
 * Extracted from ShipLogService to isolate data access concerns.
 */

import { ShipLogEntry } from '../../types';
import { supabase, getCurrentUser } from '../supabase';
import { createLogger } from '../../utils/createLogger';
import { SHIP_LOGS_TABLE, toDbFormat, fromDbFormat } from './helpers';
import { deleteVoyageFromOfflineQueue, deleteEntryFromOfflineQueue } from './OfflineQueue';
import { invalidateRoutesAndTracks } from './RoutesAndTracks';

const log = createLogger('EntryCrud');

/**
 * Extract the embedded creation timestamp from a `planned_<ms>_<rand>`
 * voyageId. Returns null for non-planned voyageIds and malformed inputs.
 */
function plannedVoyageTimestamp(voyageId: string): number | null {
    const m = voyageId.match(/^planned_(\d+)_/);
    if (!m) return null;
    const t = parseInt(m[1], 10);
    return isFinite(t) ? t : null;
}

/**
 * Fetch active (non-archived) log entries for current user.
 */
export async function getLogEntries(limit: number = 50): Promise<ShipLogEntry[]> {
    if (!supabase) {
        return [];
    }

    try {
        // Check if user is authenticated
        const user = await getCurrentUser();
        if (!user) {
            return [];
        }

        // Supabase caps queries at 1000 rows by default.
        // Paginate to fetch all entries when limit is large.
        const PAGE_SIZE = 1000;
        const allEntries: ShipLogEntry[] = [];
        let offset = 0;
        const effectiveLimit = Math.min(limit, 10_000_000); // Safety cap

        while (allEntries.length < effectiveLimit) {
            const batchSize = Math.min(PAGE_SIZE, effectiveLimit - allEntries.length);
            const { data, error } = await supabase
                .from(SHIP_LOGS_TABLE)
                .select('*')
                .or('archived.is.null,archived.eq.false') // Exclude archived entries
                .order('timestamp', { ascending: false })
                .range(offset, offset + batchSize - 1);

            if (error) {
                break;
            }

            const rows = data || [];
            allEntries.push(...rows.map((row) => fromDbFormat(row)));

            // If we got fewer rows than requested, we've fetched everything
            if (rows.length < batchSize) break;
            offset += batchSize;
        }

        return allEntries;
    } catch (error) {
        log.error('getLogEntries failed', error);
        return [];
    }
}

/**
 * Fetch a voyage's entries recorded strictly AFTER `sinceIso`.
 *
 * A cheap incremental query for polling an IN-PROGRESS voyage's track so a
 * second device watching the recording device's voyage sees it grow
 * almost-live — without re-pulling the whole track each tick. Ordered
 * oldest → newest; empty on no-auth / error / no new points.
 *
 * This is a cloud read: it only surfaces points the recording device has
 * synced to Supabase. With no shared backend reachable (e.g. both devices
 * on an offline boat LAN) there is nothing to poll.
 */
export async function getVoyageEntriesSince(voyageId: string, sinceIso: string): Promise<ShipLogEntry[]> {
    if (!supabase || !voyageId || !sinceIso) return [];
    try {
        const user = await getCurrentUser();
        if (!user) return [];

        const { data, error } = await supabase
            .from(SHIP_LOGS_TABLE)
            .select('*')
            .eq('voyage_id', voyageId)
            .gt('timestamp', sinceIso)
            .or('archived.is.null,archived.eq.false')
            .order('timestamp', { ascending: true })
            .limit(1000);

        if (error) return [];
        return (data || []).map((row) => fromDbFormat(row));
    } catch (error) {
        log.warn('getVoyageEntriesSince failed', error);
        return [];
    }
}

/**
 * Fetch archived log entries for current user.
 */
export async function getArchivedEntries(limit: number = 10000): Promise<ShipLogEntry[]> {
    if (!supabase) return [];
    try {
        const user = await getCurrentUser();
        if (!user) return [];

        // Paginate to fetch all archived entries
        const PAGE_SIZE = 1000;
        const allEntries: ShipLogEntry[] = [];
        let offset = 0;

        while (allEntries.length < limit) {
            const batchSize = Math.min(PAGE_SIZE, limit - allEntries.length);
            const { data, error } = await supabase
                .from(SHIP_LOGS_TABLE)
                .select('*')
                .eq('archived', true)
                .order('timestamp', { ascending: false })
                .range(offset, offset + batchSize - 1);

            if (error) break;

            const rows = data || [];
            allEntries.push(...rows.map((row) => fromDbFormat(row)));

            if (rows.length < batchSize) break;
            offset += batchSize;
        }

        return allEntries;
    } catch (error) {
        log.error('getArchivedEntries failed', error);
        return [];
    }
}

/**
 * Fetch ALL entries (active + archived) for career totals calculation.
 * Only fetches device-source entries to reduce payload.
 */
export async function getAllEntriesForCareer(): Promise<ShipLogEntry[]> {
    if (!supabase) return [];
    try {
        const user = await getCurrentUser();
        if (!user) return [];

        const { data, error } = await supabase
            .from(SHIP_LOGS_TABLE)
            .select('voyage_id, timestamp, cumulative_distance_nm, is_on_water, source, archived')
            .or('source.is.null,source.eq.device') // Career = device-only
            .order('timestamp', { ascending: false })
            .limit(10000);

        if (error) return [];
        return (data || []).map((row) => fromDbFormat(row));
    } catch (error) {
        log.error('getAllEntriesForCareer failed', error);
        return [];
    }
}

/**
 * Archive a voyage — mark all entries as archived.
 */
export async function archiveVoyage(voyageId: string): Promise<boolean> {
    if (!supabase) return false;
    try {
        const user = await getCurrentUser();
        if (!user) return false;

        const { error } = await supabase
            .from(SHIP_LOGS_TABLE)
            .update({ archived: true })
            .eq('user_id', user.id)
            .eq('voyage_id', voyageId);

        if (error) {
            log.error('archiveVoyage failed', error);
            return false;
        }
        return true;
    } catch (error) {
        log.error('archiveVoyage failed', error);
        return false;
    }
}

/**
 * Unarchive a voyage — restore all entries to active.
 */
export async function unarchiveVoyage(voyageId: string): Promise<boolean> {
    if (!supabase) return false;
    try {
        const user = await getCurrentUser();
        if (!user) return false;

        const { error } = await supabase
            .from(SHIP_LOGS_TABLE)
            .update({ archived: false })
            .eq('user_id', user.id)
            .eq('voyage_id', voyageId);

        if (error) {
            log.error('unarchiveVoyage failed', error);
            return false;
        }
        return true;
    } catch (error) {
        log.error('unarchiveVoyage failed', error);
        return false;
    }
}

/**
 * Delete a voyage and all its entries (from both DB and offline queue).
 *
 * For planned_* voyages, this also cascade-deletes the orphan voyages-
 * table row that PassagePlanSave auto-creates on save. Without the
 * cascade, the active-passage dropdown in CrewManagement would keep
 * showing a draft for a route the user has explicitly removed from
 * their logbook. Match: same voyage_name on the same calendar day as
 * the planned_* voyageId's embedded creation timestamp.
 */
export async function deleteVoyage(voyageId: string): Promise<boolean> {
    // BEFORE deleting the entries, peek at the first/last waypointName
    // for planned_* voyages so we can derive the voyage_name to cascade-
    // delete from the voyages table afterward.
    let plannedRouteName: string | null = null;
    const planTs = plannedVoyageTimestamp(voyageId);
    const planDay = planTs !== null ? new Date(planTs).toISOString().slice(0, 10) : null;
    if (planDay !== null && supabase) {
        try {
            const user = await getCurrentUser();
            if (user) {
                const { data: rows } = await supabase
                    .from(SHIP_LOGS_TABLE)
                    .select('waypoint_name, timestamp')
                    .eq('user_id', user.id)
                    .eq('voyage_id', voyageId)
                    .order('timestamp', { ascending: true });
                if (rows && rows.length >= 2) {
                    const first = (rows[0] as { waypoint_name?: string }).waypoint_name;
                    const last = (rows[rows.length - 1] as { waypoint_name?: string }).waypoint_name;
                    if (first && last) {
                        plannedRouteName = `${first.trim()} → ${last.trim()}`;
                    }
                }
            }
        } catch (e) {
            // Non-fatal — just won't cascade-delete the voyages row.
            // The dropdown filter will hide the orphan from view anyway,
            // it just leaves dead data in the table.
            log.warn('deleteVoyage: pre-delete name lookup failed', e);
        }
    }

    // First, try to delete from offline queue (local storage)
    const _offlineDeleted = await deleteVoyageFromOfflineQueue(voyageId);

    // If Supabase is available, also delete from there
    if (supabase) {
        try {
            const user = await getCurrentUser();
            if (user) {
                let query = supabase.from(SHIP_LOGS_TABLE).delete().eq('user_id', user.id);

                // Handle 'default_voyage' - these are entries with null/empty voyageId
                if (voyageId === 'default_voyage') {
                    query = query.or('voyage_id.is.null,voyage_id.eq.');
                } else {
                    query = query.eq('voyage_id', voyageId);
                }

                const { error } = await query;
                if (error) {
                    log.warn('deleteVoyage: DB delete failed', error);
                }
            }
        } catch (error) {
            log.error('deleteVoyage: DB delete failed', error);
        }
    }

    // Cascade: remove the matching voyages-table row(s) for planned_*
    // voyages so the active-passage dropdown doesn't keep an orphan.
    if (plannedRouteName && planDay) {
        try {
            const { deleteDraftVoyagesByNameAndDay } = await import('../VoyageService');
            const removed = await deleteDraftVoyagesByNameAndDay(plannedRouteName, planDay);
            if (removed > 0) {
                log.info(
                    `deleteVoyage: cascade-removed ${removed} draft voyage(s) "${plannedRouteName}" from ${planDay}`,
                );
            }
        } catch (e) {
            log.warn('deleteVoyage: cascade-delete from voyages table failed', e);
        }

        // Cascade #2: end any ACTIVE voyage whose name matches the deleted
        // route. Without this, the user can delete the suggested track
        // out from under an active voyage and end up stuck in Active
        // Voyage Mode with no underlying route — the SystemStatusButton
        // + MapHub auto-display + Cast Off pill all keep showing
        // "Underway" because they key off voyages.status='active'.
        // deleteDraftVoyagesByNameAndDay only matches status='planning'
        // rows, so it can't do this — we need a separate call.
        try {
            const { endActiveVoyageIfNameMatches } = await import('../VoyageService');
            const ended = await endActiveVoyageIfNameMatches(plannedRouteName);
            if (ended) {
                log.info(
                    `deleteVoyage: cascade-ended active voyage "${plannedRouteName}" — Active Voyage Mode cleared`,
                );
            }
        } catch (e) {
            log.warn('deleteVoyage: cascade-end active voyage failed', e);
        }
    }

    // Drop the routes/tracks cache so the chart picker reflects this
    // deletion immediately on next open.
    invalidateRoutesAndTracks();

    // Return true if we deleted from offline queue (or if nothing was there)
    return true;
}

/**
 * Delete a single entry by ID (from both DB and offline queue).
 */
export async function deleteEntry(entryId: string): Promise<boolean> {
    // First, try to delete from offline queue (local storage)
    const _offlineDeleted = await deleteEntryFromOfflineQueue(entryId);

    // If Supabase is available, also delete from there
    if (supabase) {
        try {
            const user = await getCurrentUser();
            if (user) {
                const { error } = await supabase
                    .from(SHIP_LOGS_TABLE)
                    .delete()
                    .eq('id', entryId)
                    .eq('user_id', user.id);

                if (error) {
                    log.warn('deleteEntry: DB delete failed', error);
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
export async function importGPXVoyage(
    entries: Partial<ShipLogEntry>[],
): Promise<{ voyageId: string; savedCount: number }> {
    if (entries.length === 0) {
        throw new Error('No entries to import');
    }

    const voyageId = crypto.randomUUID();

    if (!supabase) {
        throw new Error('Database not available — connect to import tracks');
    }

    const user = await getCurrentUser();
    if (!user) {
        throw new Error('Login required to import tracks');
    }

    // Prepare all entries for batch insert
    const dbEntries = entries.map((entry, _index) => {
        const fullEntry: Partial<ShipLogEntry> = {
            ...entry,
            id: crypto.randomUUID(),
            userId: user.id,
            voyageId,
            source:
                ('source' in entry ? (entry as Partial<ShipLogEntry> & { source?: string }).source : undefined) ||
                'gpx_import',
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
        const { error } = await supabase.from(SHIP_LOGS_TABLE).insert(chunk);

        if (error) {
            throw new Error(`Import failed at entry ${i}: ${error.message}`);
        }
        savedCount += chunk.length;
    }

    return { voyageId, savedCount };
}
