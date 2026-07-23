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
import {
    deleteVoyageFromOfflineQueue,
    deleteEntryFromOfflineQueue,
    attemptVoyageCloudDeletion,
    recreateVoyageWithFence,
    filterVoyageTombstonedEntries,
    filterEntryTombstonedRows,
    applyVoyageArchiveIntentOverlay,
    getVoyageArchiveIntentSnapshot,
    recordVoyageDeletionCascadeMetadata,
    runShipLogCloudTransaction,
    runVoyageCloudMutation,
    isVoyageArchiveIntentCurrent,
    markVoyageArchiveIntentCloudApplied,
    setVoyageArchivedInOfflineQueue,
} from './OfflineQueue';
import { invalidateRoutesAndTracks } from './RoutesAndTracks';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from '../authIdentityScope';

const log = createLogger('EntryCrud');

type AuthenticatedScope = AuthIdentityScope & { userId: string };

export interface ImportGPXOptions {
    /** Exact account/generation captured by the caller before any async work. */
    expectedScope?: AuthIdentityScope;
    /** Imported content must remain visibly non-device provenance. */
    source?: 'gpx_import' | 'community_download';
    /** Optional stable import id, used to make community imports idempotent. */
    voyageId?: string;
}

function isAuthenticatedScopeCurrent(scope: AuthIdentityScope): scope is AuthenticatedScope {
    return Boolean(scope.userId) && isAuthIdentityScopeCurrent(scope);
}

async function verifyCurrentUser(scope: AuthIdentityScope): Promise<AuthenticatedScope | null> {
    if (!isAuthenticatedScopeCurrent(scope)) return null;
    const user = await getCurrentUser(scope);
    return isAuthenticatedScopeCurrent(scope) && user?.id === scope.userId ? scope : null;
}

async function settleWithin<T>(
    operation: PromiseLike<T>,
    timeoutMs: number,
    onTimeout?: () => void,
): Promise<T | null> {
    return new Promise<T | null>((resolve, reject) => {
        const timer = setTimeout(() => {
            onTimeout?.();
            resolve(null);
        }, timeoutMs);
        Promise.resolve(operation).then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            (error) => {
                clearTimeout(timer);
                reject(error);
            },
        );
    });
}

/**
 * Extract the embedded creation timestamp from a `planned_<ms>_<rand>`
 * voyageId. Returns null for non-planned voyageIds and malformed inputs.
 */
function plannedVoyageTimestamp(voyageId: string): number | null {
    const m = voyageId.match(/^planned_(\d+)_/);
    if (!m) return null;
    const t = parseInt(m[1], 10);
    return Number.isFinite(t) && Number.isFinite(new Date(t).getTime()) ? t : null;
}

function stableImportOperationId(voyageId: string, index: number): string {
    // Two differently-seeded FNV-1a lanes give a compact deterministic
    // namespace without relying on async WebCrypto during large imports.
    let first = 0x811c9dc5;
    let second = 0x9e3779b9;
    for (let offset = 0; offset < voyageId.length; offset++) {
        const code = voyageId.charCodeAt(offset);
        first = Math.imul(first ^ code, 0x01000193) >>> 0;
        second = Math.imul(second ^ (code + offset), 0x85ebca6b) >>> 0;
    }
    return `import_${first.toString(16).padStart(8, '0')}${second.toString(16).padStart(8, '0')}_${index.toString(36)}`;
}

interface ArchiveIntentReadOptions {
    voyageId?: string;
    sinceIso?: string;
    ascending?: boolean;
}

/**
 * Normal reads retain their indexed archived-state predicate. Only a recent
 * local command that intentionally contradicts cloud state triggers an
 * opposite-state query, scoped to that exact voyage and bounded by the view's
 * requested limit.
 */
async function getArchiveIntentOppositeStateEntries(
    authenticated: AuthenticatedScope,
    desiredArchived: boolean,
    limit: number,
    options: ArchiveIntentReadOptions = {},
): Promise<ShipLogEntry[]> {
    if (!supabase || limit <= 0 || !isAuthenticatedScopeCurrent(authenticated)) return [];
    const intents = (await getVoyageArchiveIntentSnapshot(authenticated)).filter(
        (intent) =>
            intent.archived === desiredArchived &&
            (options.voyageId === undefined || intent.voyageId === options.voyageId),
    );
    const rawRows: Record<string, unknown>[] = [];
    const PAGE_SIZE = 1000;
    const stableVoyageIds = intents
        .filter((intent) => intent.voyageId !== 'default_voyage')
        .map((intent) => intent.voyageId);
    const defaultIntent = intents.find((intent) => intent.voyageId === 'default_voyage');
    const targets: Array<{ voyageIds?: string[]; defaultRequestedAt?: number }> = [];
    if (stableVoyageIds.length > 0) targets.push({ voyageIds: stableVoyageIds });
    if (defaultIntent) targets.push({ defaultRequestedAt: defaultIntent.requestedAt });

    for (const target of targets) {
        let offset = 0;
        let fetchedForTarget = 0;
        while (fetchedForTarget < limit && isAuthenticatedScopeCurrent(authenticated)) {
            const batchSize = Math.min(PAGE_SIZE, limit - fetchedForTarget);
            let query = supabase.from(SHIP_LOGS_TABLE).select('*').eq('user_id', authenticated.userId);
            query = target.voyageIds
                ? query.in('voyage_id', target.voyageIds)
                : query
                      .or('voyage_id.is.null,voyage_id.eq.')
                      .lte('timestamp', new Date(target.defaultRequestedAt as number).toISOString());
            query = desiredArchived ? query.or('archived.is.null,archived.eq.false') : query.eq('archived', true);
            if (options.sinceIso) query = query.gt('timestamp', options.sinceIso);
            const { data, error } = await query
                .order('timestamp', { ascending: options.ascending === true })
                .order('id', { ascending: options.ascending === true })
                .range(offset, offset + batchSize - 1);
            if (error || !isAuthenticatedScopeCurrent(authenticated)) break;
            const page = (data || []) as Record<string, unknown>[];
            rawRows.push(...page);
            fetchedForTarget += page.length;
            if (page.length < batchSize) break;
            offset += batchSize;
        }
    }

    if (!isAuthenticatedScopeCurrent(authenticated)) return [];
    const entryVisibleRows = await filterEntryTombstonedRows(rawRows, authenticated);
    const voyageVisible = await filterVoyageTombstonedEntries(
        entryVisibleRows.map((row) => fromDbFormat(row)),
        authenticated,
    );
    const overlaid = await applyVoyageArchiveIntentOverlay(voyageVisible, authenticated);
    return overlaid.filter((entry) => entry.archived === desiredArchived);
}

function mergeOrderedEntries(
    primary: ShipLogEntry[],
    additions: ShipLogEntry[],
    ascending: boolean,
    limit?: number,
): ShipLogEntry[] {
    const byId = new Map<string, ShipLogEntry>();
    for (const entry of [...primary, ...additions]) {
        const key =
            entry.id ??
            `${entry.voyageId ?? 'default_voyage'}:${entry.timestamp ?? ''}:${entry.latitude ?? ''}:${entry.longitude ?? ''}`;
        byId.set(key, entry);
    }
    const ordered = Array.from(byId.values()).sort((left, right) => {
        const leftTime = new Date(left.timestamp || 0).getTime();
        const rightTime = new Date(right.timestamp || 0).getTime();
        const timeOrder = leftTime - rightTime;
        if (timeOrder !== 0) return ascending ? timeOrder : -timeOrder;
        const idOrder = (left.id ?? '').localeCompare(right.id ?? '');
        return ascending ? idOrder : -idOrder;
    });
    return limit === undefined ? ordered : ordered.slice(0, limit);
}

/**
 * Fetch active (non-archived) log entries for current user.
 */
export async function getLogEntries(limit: number = 50): Promise<ShipLogEntry[]> {
    if (!supabase) return [];
    const scope = getAuthIdentityScope();

    try {
        const authenticated = await verifyCurrentUser(scope);
        if (!authenticated) return [];

        // Supabase caps queries at 1000 rows by default.
        // Paginate to fetch all entries when limit is large.
        const PAGE_SIZE = 1000;
        const allEntries: ShipLogEntry[] = [];
        let offset = 0;
        const effectiveLimit = Number.isFinite(limit) ? Math.max(0, Math.min(Math.floor(limit), 10_000_000)) : 0;

        while (allEntries.length < effectiveLimit && isAuthenticatedScopeCurrent(authenticated)) {
            const batchSize = Math.min(PAGE_SIZE, effectiveLimit - allEntries.length);
            const { data, error } = await supabase
                .from(SHIP_LOGS_TABLE)
                .select('*')
                .eq('user_id', authenticated.userId)
                .or('archived.is.null,archived.eq.false')
                .order('timestamp', { ascending: false })
                .order('id', { ascending: false })
                .range(offset, offset + batchSize - 1);

            if (!isAuthenticatedScopeCurrent(authenticated)) return [];
            if (error) break;

            const rows = data || [];
            const entryVisibleRows = await filterEntryTombstonedRows(rows, authenticated);
            const visible = await filterVoyageTombstonedEntries(
                entryVisibleRows.map((row) => fromDbFormat(row)),
                authenticated,
            );
            const overlaid = await applyVoyageArchiveIntentOverlay(visible, authenticated);
            if (!isAuthenticatedScopeCurrent(authenticated)) return [];
            allEntries.push(...overlaid.filter((entry) => entry.archived !== true));

            // If we got fewer rows than requested, we've fetched everything
            if (rows.length < batchSize) break;
            offset += batchSize;
        }

        if (!isAuthenticatedScopeCurrent(authenticated)) return [];
        const restored = await getArchiveIntentOppositeStateEntries(authenticated, false, effectiveLimit);
        return isAuthenticatedScopeCurrent(authenticated)
            ? mergeOrderedEntries(allEntries, restored, false, effectiveLimit)
            : [];
    } catch (error) {
        if (isAuthIdentityScopeCurrent(scope)) log.error('getLogEntries failed', error);
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
    const scope = getAuthIdentityScope();
    try {
        const authenticated = await verifyCurrentUser(scope);
        if (!authenticated) return [];

        const PAGE_SIZE = 1000;
        const rows: Record<string, unknown>[] = [];
        let offset = 0;
        while (isAuthenticatedScopeCurrent(authenticated)) {
            let query = supabase.from(SHIP_LOGS_TABLE).select('*').eq('user_id', authenticated.userId);
            query =
                voyageId === 'default_voyage'
                    ? query.or('voyage_id.is.null,voyage_id.eq.')
                    : query.eq('voyage_id', voyageId);
            const { data, error } = await query
                .gt('timestamp', sinceIso)
                .or('archived.is.null,archived.eq.false')
                .order('timestamp', { ascending: true })
                .order('id', { ascending: true })
                .range(offset, offset + PAGE_SIZE - 1);
            if (error || !isAuthenticatedScopeCurrent(authenticated)) return [];
            const page = data || [];
            rows.push(...page);
            if (page.length < PAGE_SIZE) break;
            offset += PAGE_SIZE;
        }

        const entryVisibleRows = await filterEntryTombstonedRows(rows, authenticated);
        const visible = await filterVoyageTombstonedEntries(
            entryVisibleRows.map((row) => fromDbFormat(row)),
            authenticated,
        );
        const overlaid = await applyVoyageArchiveIntentOverlay(visible, authenticated);
        const primary = overlaid.filter((entry) => entry.archived !== true);
        const restored = await getArchiveIntentOppositeStateEntries(authenticated, false, 10_000_000, {
            voyageId,
            sinceIso,
            ascending: true,
        });
        return mergeOrderedEntries(primary, restored, true);
    } catch (error) {
        if (isAuthIdentityScopeCurrent(scope)) log.warn('getVoyageEntriesSince failed', error);
        return [];
    }
}

/**
 * Fetch archived log entries for current user.
 */
export async function getArchivedEntries(limit: number = 10000): Promise<ShipLogEntry[]> {
    if (!supabase) return [];
    const scope = getAuthIdentityScope();
    try {
        const authenticated = await verifyCurrentUser(scope);
        if (!authenticated) return [];

        // Paginate to fetch all archived entries
        const PAGE_SIZE = 1000;
        const allEntries: ShipLogEntry[] = [];
        let offset = 0;
        const effectiveLimit = Number.isFinite(limit) ? Math.max(0, Math.min(Math.floor(limit), 10_000_000)) : 0;

        while (allEntries.length < effectiveLimit && isAuthenticatedScopeCurrent(authenticated)) {
            const batchSize = Math.min(PAGE_SIZE, effectiveLimit - allEntries.length);
            const { data, error } = await supabase
                .from(SHIP_LOGS_TABLE)
                .select('*')
                .eq('user_id', authenticated.userId)
                .eq('archived', true)
                .order('timestamp', { ascending: false })
                .order('id', { ascending: false })
                .range(offset, offset + batchSize - 1);

            if (!isAuthenticatedScopeCurrent(authenticated)) return [];
            if (error) break;

            const rows = data || [];
            const entryVisibleRows = await filterEntryTombstonedRows(rows, authenticated);
            const visible = await filterVoyageTombstonedEntries(
                entryVisibleRows.map((row) => fromDbFormat(row)),
                authenticated,
            );
            const overlaid = await applyVoyageArchiveIntentOverlay(visible, authenticated);
            if (!isAuthenticatedScopeCurrent(authenticated)) return [];
            allEntries.push(...overlaid.filter((entry) => entry.archived === true));

            if (rows.length < batchSize) break;
            offset += batchSize;
        }

        if (!isAuthenticatedScopeCurrent(authenticated)) return [];
        const newlyArchived = await getArchiveIntentOppositeStateEntries(authenticated, true, effectiveLimit);
        return isAuthenticatedScopeCurrent(authenticated)
            ? mergeOrderedEntries(allEntries, newlyArchived, false, effectiveLimit)
            : [];
    } catch (error) {
        if (isAuthIdentityScopeCurrent(scope)) log.error('getArchivedEntries failed', error);
        return [];
    }
}

/**
 * Fetch ALL entries (active + archived) for career totals calculation.
 * Only fetches device-source entries to reduce payload.
 */
export async function getAllEntriesForCareer(): Promise<ShipLogEntry[]> {
    if (!supabase) return [];
    const scope = getAuthIdentityScope();
    try {
        const authenticated = await verifyCurrentUser(scope);
        if (!authenticated) return [];

        const PAGE_SIZE = 1000;
        const allEntries: ShipLogEntry[] = [];
        let offset = 0;
        while (isAuthenticatedScopeCurrent(authenticated)) {
            const { data, error } = await supabase
                .from(SHIP_LOGS_TABLE)
                .select(
                    'id, voyage_id, timestamp, cumulative_distance_nm, is_on_water, source, archived, client_operation_id',
                )
                .eq('user_id', authenticated.userId)
                .or('source.is.null,source.eq.device') // Career = device-only
                .order('timestamp', { ascending: false })
                .order('id', { ascending: false })
                .range(offset, offset + PAGE_SIZE - 1);

            if (error || !isAuthenticatedScopeCurrent(authenticated)) return [];
            const rows = data || [];
            const entryVisibleRows = await filterEntryTombstonedRows(rows, authenticated);
            const visible = await filterVoyageTombstonedEntries(
                entryVisibleRows.map((row) => fromDbFormat(row)),
                authenticated,
            );
            if (!isAuthenticatedScopeCurrent(authenticated)) return [];
            allEntries.push(...visible);
            if (rows.length < PAGE_SIZE) break;
            offset += PAGE_SIZE;
        }
        return allEntries;
    } catch (error) {
        if (isAuthIdentityScopeCurrent(scope)) log.error('getAllEntriesForCareer failed', error);
        return [];
    }
}

/**
 * Durably accept archive state, then attempt it under the same voyage/cloud
 * FIFO as queue replay. A timeout is "pending", not a failed user command:
 * sync retries the owner-scoped outbox until cloud state verifies.
 * PostgREST's PATCH `limit` changes how many rows are mutated, so the update
 * uses an exact affected-row count and a separate GET verifies that no row
 * remains in the opposite state.
 */
async function setVoyageArchived(voyageId: string, archived: boolean): Promise<boolean> {
    if (!supabase || !voyageId) return false;
    const database = supabase;
    const scope = getAuthIdentityScope();
    try {
        const authenticated = await verifyCurrentUser(scope);
        if (!authenticated) return false;
        let receipt: Awaited<ReturnType<typeof setVoyageArchivedInOfflineQueue>>;
        try {
            receipt = await setVoyageArchivedInOfflineQueue(voyageId, archived, authenticated);
        } catch (error) {
            log.error(`${archived ? 'archiveVoyage' : 'unarchiveVoyage'} durable intent failed`, error);
            return false;
        }

        const succeeded = await runVoyageCloudMutation(
            voyageId,
            authenticated,
            8000,
            async (signal) => {
                if (!(await isVoyageArchiveIntentCurrent(receipt, authenticated))) {
                    return true; // a newer archive command superseded this one
                }
                let mutationQuery = database
                    .from(SHIP_LOGS_TABLE)
                    .update({ archived }, { count: 'exact' })
                    .eq('user_id', authenticated.userId);
                mutationQuery =
                    voyageId === 'default_voyage'
                        ? mutationQuery
                              .or('voyage_id.is.null,voyage_id.eq.')
                              .lte('timestamp', new Date(receipt.requestedAt).toISOString())
                        : mutationQuery.eq('voyage_id', voyageId);
                const mutation = await mutationQuery.abortSignal(signal);
                if (
                    mutation.error ||
                    typeof mutation.count !== 'number' ||
                    mutation.count < 1 ||
                    !isAuthenticatedScopeCurrent(authenticated)
                ) {
                    return false;
                }

                let verification = database.from(SHIP_LOGS_TABLE).select('id').eq('user_id', authenticated.userId);
                verification =
                    voyageId === 'default_voyage'
                        ? verification
                              .or('voyage_id.is.null,voyage_id.eq.')
                              .lte('timestamp', new Date(receipt.requestedAt).toISOString())
                        : verification.eq('voyage_id', voyageId);
                verification = archived
                    ? verification.or('archived.is.null,archived.eq.false')
                    : verification.eq('archived', true);
                const { data, error } = await verification.abortSignal(signal).limit(1);
                return !error && (data?.length ?? 0) === 0 && isAuthenticatedScopeCurrent(authenticated);
            },
            new Date(receipt.requestedAt).toISOString(),
        );

        if (!isAuthenticatedScopeCurrent(authenticated)) return false;
        if (succeeded === true) {
            try {
                await markVoyageArchiveIntentCloudApplied(receipt, authenticated);
            } catch (error) {
                // The durable desired state is still pending, so retrying the
                // idempotent cloud update is safer than reporting failure.
                log.warn(`${archived ? 'archiveVoyage' : 'unarchiveVoyage'} acknowledgement remains pending`, error);
            }
        } else {
            log.warn(`${archived ? 'archiveVoyage' : 'unarchiveVoyage'} cloud convergence remains pending`);
        }
        return true;
    } catch (error) {
        if (isAuthIdentityScopeCurrent(scope)) {
            log.error(`${archived ? 'archiveVoyage' : 'unarchiveVoyage'} failed`, error);
        }
        return false;
    }
}

/**
 * Archive a voyage — mark all entries as archived.
 */
export async function archiveVoyage(voyageId: string): Promise<boolean> {
    return setVoyageArchived(voyageId, true);
}

/**
 * Unarchive a voyage — restore all entries to active.
 */
export async function unarchiveVoyage(voyageId: string): Promise<boolean> {
    return setVoyageArchived(voyageId, false);
}

/**
 * Delete a voyage and all its entries (from both DB and offline queue).
 *
 * For planned_* voyages, an exactly linked voyages-table row is also queued
 * for cleanup. Name/day similarity is retained only as diagnostics: it is
 * never safe enough to delete or abort another row.
 */
export async function deleteVoyage(voyageId: string): Promise<boolean> {
    const scope = getAuthIdentityScope();
    if (!voyageId || !isAuthIdentityScopeCurrent(scope)) return false;
    // Persist the deletion intent before ANY cloud lookup. Planned-route
    // metadata is optional; a hung/offline lookup must never prevent the
    // durable tombstone and local removal.
    try {
        await deleteVoyageFromOfflineQueue(voyageId);
    } catch (error) {
        if (isAuthIdentityScopeCurrent(scope)) {
            log.error('deleteVoyage: could not persist local deletion intent', error);
        }
        return false;
    }
    if (!isAuthIdentityScopeCurrent(scope)) return false;

    // BEFORE deleting the entries, peek at the first/last waypointName
    // for planned_* voyages so we can derive the voyage_name to cascade-
    // delete from the voyages table afterward.
    let plannedRouteName: string | null = null;
    let plannedVoyageId: string | null = null;
    const planTs = plannedVoyageTimestamp(voyageId);
    const planDay = planTs !== null ? new Date(planTs).toISOString().slice(0, 10) : null;
    if (planDay !== null && supabase) {
        try {
            const authenticated = await verifyCurrentUser(scope);
            if (authenticated) {
                const controller = new AbortController();
                const lookup = await settleWithin(
                    supabase
                        .from(SHIP_LOGS_TABLE)
                        .select('waypoint_name, timestamp, linked_plan_id')
                        .eq('user_id', authenticated.userId)
                        .eq('voyage_id', voyageId)
                        .order('timestamp', { ascending: true })
                        .abortSignal(controller.signal),
                    4000,
                    () => controller.abort(),
                );
                if (!isAuthenticatedScopeCurrent(authenticated)) return false;
                if (!lookup) {
                    log.warn('deleteVoyage: planned-route name lookup timed out; continuing with durable delete');
                }
                const rows = lookup?.data;
                const linkedIds = new Set(
                    (rows || [])
                        .map((row) => (row as { linked_plan_id?: unknown }).linked_plan_id)
                        .filter(
                            (value): value is string =>
                                typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value),
                        ),
                );
                if (linkedIds.size === 1) plannedVoyageId = Array.from(linkedIds)[0];
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
            if (isAuthIdentityScopeCurrent(scope)) log.warn('deleteVoyage: pre-delete name lookup failed', e);
        }
    }

    let cascadeMetadataDurable = true;
    if ((plannedRouteName && planDay) || plannedVoyageId) {
        try {
            await recordVoyageDeletionCascadeMetadata(
                voyageId,
                plannedRouteName ?? '',
                planDay ?? '',
                scope,
                plannedVoyageId ?? undefined,
            );
        } catch (error) {
            cascadeMetadataDurable = false;
            if (isAuthIdentityScopeCurrent(scope)) {
                log.error('deleteVoyage: planned-route cascade could not be queued durably', error);
            }
        }
    }

    // The durable tombstone is the acceptance boundary. Cloud confirmation is
    // attempted immediately for responsiveness, but a network/RLS failure is
    // now a real queued retry rather than a fictional success or a false
    // "failed to delete" shown after the local voyage has already vanished.
    let cloudDeleteConfirmed = false;
    if (supabase) {
        try {
            const authenticated = await verifyCurrentUser(scope);
            if (authenticated) {
                cloudDeleteConfirmed = await attemptVoyageCloudDeletion(voyageId, authenticated);
                if (!isAuthenticatedScopeCurrent(authenticated)) return false;
                if (!cloudDeleteConfirmed) {
                    log.warn('deleteVoyage: cloud delete remains pending in the durable retry ledger');
                }
            }
        } catch (error) {
            if (isAuthIdentityScopeCurrent(scope)) log.error('deleteVoyage: DB delete failed', error);
        }
    }

    // Drop the routes/tracks cache so the chart picker reflects this
    // deletion immediately on next open.
    invalidateRoutesAndTracks(scope);

    return isAuthIdentityScopeCurrent(scope) && cascadeMetadataDurable;
}

/**
 * Delete a single entry by ID (from both DB and offline queue).
 */
export async function deleteEntry(entryId: string): Promise<boolean> {
    const scope = getAuthIdentityScope();
    if (!entryId || !isAuthIdentityScopeCurrent(scope)) return false;

    // Stable offline_<queue_id> display ids are local-only. Never send one
    // to a UUID database column and never claim success if it was not found.
    if (entryId.startsWith('offline_')) {
        try {
            return await deleteEntryFromOfflineQueue(entryId);
        } catch (error) {
            if (isAuthIdentityScopeCurrent(scope)) log.error('deleteEntry: local delete failed', error);
            return false;
        }
    }

    if (!supabase) {
        try {
            return await deleteEntryFromOfflineQueue(entryId);
        } catch (error) {
            if (isAuthIdentityScopeCurrent(scope)) log.error('deleteEntry: local delete failed', error);
            return false;
        }
    }
    const database = supabase;

    try {
        const authenticated = await verifyCurrentUser(scope);
        if (!authenticated) return false;

        const result = await runShipLogCloudTransaction(authenticated, async () => {
            // Resolve the immutable operation id before deleting the UUID row.
            // A direct request can commit and then fall back to the same queued
            // operation; the durable operation tombstone prevents that replay
            // from resurrecting a user-visible deletion.
            const lookupController = new AbortController();
            const lookup = await settleWithin(
                database
                    .from(SHIP_LOGS_TABLE)
                    .select('id, client_operation_id')
                    .eq('id', entryId)
                    .eq('user_id', authenticated.userId)
                    .abortSignal(lookupController.signal)
                    .limit(1),
                4000,
                () => lookupController.abort(),
            );
            if (!lookup || lookup.error || !isAuthenticatedScopeCurrent(authenticated)) {
                log.warn('deleteEntry: operation-id lookup failed or timed out', lookup?.error);
                return false;
            }

            const row = lookup.data?.[0] as { client_operation_id?: unknown } | undefined;
            const operationId =
                typeof row?.client_operation_id === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(row.client_operation_id)
                    ? row.client_operation_id
                    : null;
            let durableOperationDelete = false;
            try {
                durableOperationDelete = await deleteEntryFromOfflineQueue(
                    operationId ? `offline_${operationId}` : entryId,
                );
            } catch (error) {
                log.error('deleteEntry: durable local delete failed', error);
                return false;
            }
            if (!isAuthenticatedScopeCurrent(authenticated)) return false;
            const acceptedForRetry = operationId !== null && durableOperationDelete;

            // An owner-scoped empty lookup means the desired row is already
            // absent. The local operation fence above still makes this an
            // idempotent, durable success when an operation id was available.
            if (!row) return true;

            const deletionController = new AbortController();
            const deletion = await settleWithin(
                database
                    .from(SHIP_LOGS_TABLE)
                    .delete()
                    .eq('id', entryId)
                    .eq('user_id', authenticated.userId)
                    .abortSignal(deletionController.signal),
                8000,
                () => deletionController.abort(),
            );

            if (!isAuthenticatedScopeCurrent(authenticated)) return false;
            if (!deletion || deletion.error) {
                log.warn('deleteEntry: DB delete failed or timed out', deletion?.error);
                return acceptedForRetry;
            }
            const verificationController = new AbortController();
            const verification = await settleWithin(
                database
                    .from(SHIP_LOGS_TABLE)
                    .select('id')
                    .eq('id', entryId)
                    .eq('user_id', authenticated.userId)
                    .abortSignal(verificationController.signal)
                    .limit(1),
                4000,
                () => verificationController.abort(),
            );
            const confirmed =
                Boolean(verification) &&
                !verification?.error &&
                (verification?.data?.length ?? 0) === 0 &&
                isAuthenticatedScopeCurrent(authenticated);
            // A persisted operation tombstone is a durable accepted command:
            // reads hide it and sync retries cloud deletion. Returning false
            // here would make the UI resurrect a row already committed for
            // deletion.
            return confirmed || acceptedForRetry;
        });
        return result === true && isAuthenticatedScopeCurrent(authenticated);
    } catch (error) {
        if (isAuthIdentityScopeCurrent(scope)) log.error('deleteEntry: DB delete failed', error);
        return false;
    }
}

/**
 * Import GPX entries as a new voyage in the database.
 * All entries are stamped with source: 'gpx_import' to prevent
 * them from being used as an official logbook record.
 */
export async function importGPXVoyage(
    entries: Partial<ShipLogEntry>[],
    options: ImportGPXOptions = {},
): Promise<{ voyageId: string; savedCount: number }> {
    if (entries.length === 0) {
        throw new Error('No entries to import');
    }

    if (!supabase) {
        throw new Error('Database not available — connect to import tracks');
    }
    const database = supabase;

    const scope = options.expectedScope ?? getAuthIdentityScope();
    if (!isAuthIdentityScopeCurrent(scope)) {
        throw new Error('Account changed during import');
    }
    const authenticated = await verifyCurrentUser(scope);
    if (!authenticated) {
        if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Account changed during import');
        throw new Error('Login required to import tracks');
    }
    const requestedVoyageId = options.voyageId?.trim();
    if (
        requestedVoyageId &&
        (requestedVoyageId === 'default_voyage' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(requestedVoyageId))
    ) {
        throw new Error('Invalid import voyage id');
    }
    const voyageId = requestedVoyageId || crypto.randomUUID();
    // This boundary can be reached from JavaScript/plugin callers that do not
    // honour the TypeScript union. Clamp at runtime so imported history can
    // never be relabelled as official device telemetry.
    const source = options.source === 'community_download' ? 'community_download' : 'gpx_import';
    const entrySnapshots = entries.map((entry) => ({ ...entry }));

    // Prepare all entries for batch insert
    const dbEntries = entrySnapshots.map((entry, index) => {
        const fullEntry: Partial<ShipLogEntry> = {
            ...entry,
            id: crypto.randomUUID(),
            userId: authenticated.userId,
            voyageId,
            // Imported points must never masquerade as official device
            // telemetry. The caller chooses only between the two explicitly
            // non-device provenance values; hostile entry.source is ignored.
            source,
            distanceNM: entry.distanceNM || 0,
            cumulativeDistanceNM: entry.cumulativeDistanceNM || 0,
            speedKts: entry.speedKts || 0,
        };
        const row = toDbFormat(fullEntry);
        row.client_operation_id = stableImportOperationId(voyageId, index);
        return row;
    });

    const saveChunks = async (): Promise<{ voyageId: string; savedCount: number }> => {
        // Batch insert in chunks of 100 to avoid payload limits.
        const CHUNK_SIZE = 100;
        let savedCount = 0;

        for (let i = 0; i < dbEntries.length; i += CHUNK_SIZE) {
            if (!isAuthenticatedScopeCurrent(authenticated)) {
                throw new Error('Account changed during import');
            }
            const chunk = dbEntries.slice(i, i + CHUNK_SIZE);
            const controller = new AbortController();
            const response = await settleWithin(
                database
                    .from(SHIP_LOGS_TABLE)
                    .upsert(chunk, {
                        onConflict: 'user_id,client_operation_id',
                        ignoreDuplicates: true,
                    })
                    .abortSignal(controller.signal),
                15_000,
                () => controller.abort(),
            );

            if (!isAuthenticatedScopeCurrent(authenticated)) {
                throw new Error('Account changed during import');
            }
            if (!response) {
                throw new Error(`Import timed out at entry ${i}`);
            }
            if (response.error) {
                throw new Error(`Import failed at entry ${i}: ${response.error.message}`);
            }
            savedCount += chunk.length;
        }

        if (!isAuthenticatedScopeCurrent(authenticated)) throw new Error('Account changed during import');
        return { voyageId, savedCount };
    };

    return recreateVoyageWithFence(voyageId, authenticated, saveChunks);
}
