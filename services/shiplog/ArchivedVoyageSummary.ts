/**
 * Archive cards are a list of voyages, never the newest N track points.
 * The two existing owner-scoped rollups identify archived voyages without
 * downloading their GPS history. Only mixed-state/local-pending voyages need
 * row-level reconciliation. Every paginated read is complete or throws: a
 * failed page must not masquerade as a smaller, successfully loaded archive.
 */
import type { ShipLogEntry } from '../../types';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from '../authIdentityScope';
import { getCurrentUserId, supabase } from '../supabase';
import { SHIP_LOGS_TABLE, fromDbFormat } from './helpers';
import {
    applyVoyageArchiveIntentOverlay,
    filterEntryTombstonedRows,
    filterVoyageTombstonedEntries,
    getOfflineEntries,
    getVoyageArchiveIntentSnapshot,
    type VoyageArchiveIntentSnapshot,
} from './OfflineQueue';
import { fromRpcRow, mergeSummariesWithLive, summarizeEntries, type VoyageSummary } from './VoyageSummary';

const PAGE_SIZE = 500;
const DEFAULT_VOYAGE = 'default_voyage';
const PROJECTION =
    'id,user_id,voyage_id,timestamp,latitude,longitude,cumulative_distance_nm,speed_kts,entry_type,source,is_on_water,archived,client_operation_id';
const voyageKey = (id: unknown) => (typeof id === 'string' && id.length > 0 ? id : DEFAULT_VOYAGE);

class SummaryRpcUnavailable extends Error {}

function assertCurrent(scope: AuthIdentityScope): void {
    if (!scope.userId || !supabase || !isAuthIdentityScopeCurrent(scope)) {
        throw new Error('Archive unavailable: the signed-in account changed.');
    }
}

function validateCount(count: number | null, expected: number | null): number | null {
    if (count == null) return expected;
    if (!Number.isInteger(count) || count < 0 || (expected != null && count !== expected)) {
        throw new Error('Archive changed while loading. Please retry.');
    }
    return count;
}

/** Range the aggregate itself, so even >1,000 voyages cannot hit a REST cap. */
async function readRollup(scope: AuthIdentityScope, includeArchived: boolean): Promise<VoyageSummary[]> {
    assertCurrent(scope);
    const result: VoyageSummary[] = [];
    const seen = new Set<string>();
    let expected: number | null = null;
    for (;;) {
        assertCurrent(scope);
        const { data, error, count } = await supabase!
            .rpc('get_voyage_summaries', { p_include_archived: includeArchived }, { count: 'exact' })
            .order('voyage_id', { ascending: true })
            .range(result.length, result.length + PAGE_SIZE - 1);
        assertCurrent(scope);
        if (error) {
            if (error.code === 'PGRST202' || /function .* does not exist/i.test(error.message)) {
                throw new SummaryRpcUnavailable(error.message);
            }
            throw new Error('Could not load the complete voyage archive. Please retry.');
        }
        if (!Array.isArray(data) || data.length > PAGE_SIZE) throw new Error('Invalid archive summary response.');
        expected = validateCount(count, expected);
        for (const raw of data as Record<string, unknown>[]) {
            const summary = fromRpcRow(raw);
            if (seen.has(summary.voyageId) || !Number.isInteger(summary.entryCount) || summary.entryCount < 1) {
                throw new Error('Incomplete archive summary response. Please retry.');
            }
            seen.add(summary.voyageId);
            result.push(summary);
        }
        if (expected != null && result.length > expected) throw new Error('Archive changed while loading.');
        if (data.length === 0 || result.length === expected) {
            if (expected != null && result.length !== expected) throw new Error('Incomplete archive summary response.');
            return result;
        }
        // Do not interpret a short page as EOF: a server row cap may be lower
        // than our requested range. Continue from the actual returned count.
    }
}

async function readProjection(scope: AuthIdentityScope, targetVoyageId?: string): Promise<ShipLogEntry[]> {
    assertCurrent(scope);
    const rows: Array<Record<string, unknown> & { client_operation_id?: unknown }> = [];
    const seen = new Set<string>();
    let expected: number | null = null;
    for (;;) {
        assertCurrent(scope);
        let query = supabase!.from(SHIP_LOGS_TABLE).select(PROJECTION, { count: 'exact' }).eq('user_id', scope.userId!);
        if (targetVoyageId === DEFAULT_VOYAGE) {
            query = query.or('voyage_id.is.null,voyage_id.eq.,voyage_id.eq.default_voyage');
        } else if (targetVoyageId) query = query.eq('voyage_id', targetVoyageId);
        else query = query.eq('archived', true);
        const { data, error, count } = await query
            .order('timestamp', { ascending: false })
            .order('id', { ascending: false })
            .range(rows.length, rows.length + PAGE_SIZE - 1);
        assertCurrent(scope);
        if (error) throw new Error('Could not load the complete voyage archive. Please retry.');
        if (!Array.isArray(data) || data.length > PAGE_SIZE) throw new Error('Invalid archive detail response.');
        expected = validateCount(count, expected);
        for (const row of data as Record<string, unknown>[]) {
            if (
                row.user_id !== scope.userId ||
                typeof row.id !== 'string' ||
                seen.has(row.id) ||
                (targetVoyageId !== undefined && voyageKey(row.voyage_id) !== targetVoyageId)
            ) {
                throw new Error('Archive detail response was outside the requested voyage or account.');
            }
            seen.add(row.id);
            rows.push(row);
        }
        if (expected != null && rows.length > expected) throw new Error('Archive changed while loading.');
        if (data.length === 0 || rows.length === expected) {
            if (expected != null && rows.length !== expected) throw new Error('Incomplete archive detail response.');
            break;
        }
    }
    const visible = await filterEntryTombstonedRows(rows, scope);
    assertCurrent(scope);
    return visible.map((row) => ({
        ...fromDbFormat(row),
        voyageId: voyageKey(row.voyage_id),
        // Used only to reconcile a queued row whose cloud ACK was interrupted.
        archiveOperationId: row.client_operation_id,
    }));
}

type ReconciledEntry = ShipLogEntry & { queue_id?: string; archiveOperationId?: unknown };

function mergeQueuedEntries(cloud: ShipLogEntry[], local: ShipLogEntry[]): ShipLogEntry[] {
    const operations = new Set(
        cloud.map((entry) => (entry as ReconciledEntry).archiveOperationId).filter((id) => typeof id === 'string'),
    );
    const ids = new Set(cloud.map((entry) => entry.id));
    return [
        ...cloud,
        ...local.filter((entry) => {
            const operation = (entry as ReconciledEntry).queue_id;
            return !ids.has(entry.id) && !(operation && operations.has(operation));
        }),
    ];
}

async function archivedSummariesFromEntries(
    entries: ShipLogEntry[],
    scope: AuthIdentityScope,
): Promise<VoyageSummary[]> {
    const visible = await filterVoyageTombstonedEntries(entries, scope);
    assertCurrent(scope);
    const overlaid = await applyVoyageArchiveIntentOverlay(visible, scope);
    assertCurrent(scope);
    return summarizeEntries(overlaid.filter((entry) => entry.archived === true));
}

const intentKey = (intents: VoyageArchiveIntentSnapshot[]) =>
    JSON.stringify([...intents].sort((a, b) => a.voyageId.localeCompare(b.voyageId)));

/**
 * Aggregate before filtering archive state: a legacy voyage can contain both
 * active and archived rows. Neither partial card summary describes that trip.
 * Failures throw so the UI retains its last complete lifetime result. Ordinary
 * voyages never download their GPS histories for these totals.
 */
export async function getLifetimeVoyageSummaries(): Promise<VoyageSummary[]> {
    const scope = getAuthIdentityScope();
    assertCurrent(scope);
    const userId = await getCurrentUserId();
    assertCurrent(scope);
    if (userId !== scope.userId) throw new Error('Sign in again to load your lifetime voyage totals.');
    const all = await readRollup(scope, true);
    assertCurrent(scope);
    if (
        all.some(
            (summary) =>
                !Number.isFinite(Date.parse(summary.startedAt)) ||
                !Number.isFinite(Date.parse(summary.endedAt)) ||
                !Number.isFinite(summary.totalDistanceNM) ||
                summary.totalDistanceNM < 0 ||
                !Number.isFinite(summary.avgSpeedKts),
        )
    ) {
        throw new Error('Invalid lifetime voyage summary response. Please retry.');
    }
    const local = await getOfflineEntries({ expectedScope: scope });
    assertCurrent(scope);
    // Older RPC versions omit null voyage IDs. This targeted read also
    // respects the legacy bucket's time-bound durable deletion fence.
    const defaultCloud = await readProjection(scope, DEFAULT_VOYAGE);
    const defaultEntries = await filterVoyageTombstonedEntries(
        mergeQueuedEntries(
            defaultCloud,
            local.filter((entry) => voyageKey(entry.voyageId) === DEFAULT_VOYAGE),
        ),
        scope,
    );
    assertCurrent(scope);
    const complete = [
        ...all.filter((summary) => summary.voyageId !== DEFAULT_VOYAGE),
        ...summarizeEntries(defaultEntries),
    ];
    // An unsynced tail may extend the aggregate, but cannot replace the
    // cloud's departure, average, or full-history row count.
    const overlaid = mergeSummariesWithLive(
        complete,
        local.filter((entry) => voyageKey(entry.voyageId) !== DEFAULT_VOYAGE),
    );
    const visible = await filterVoyageTombstonedEntries(
        overlaid.map((summary) => ({ summary, voyageId: summary.voyageId, timestamp: summary.startedAt })),
        scope,
    );
    assertCurrent(scope);
    return visible.map(({ summary }) => summary).sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt));
}

/**
 * Complete archive list for the exact authenticated identity. Unlike legacy
 * getArchivedEntries(10000), unavailable/incomplete is an error, never [].
 */
export async function getArchivedVoyageSummaries(): Promise<VoyageSummary[]> {
    const scope = getAuthIdentityScope();
    assertCurrent(scope);
    const userId = await getCurrentUserId();
    assertCurrent(scope);
    if (userId !== scope.userId) throw new Error('Sign in again to load your voyage archive.');

    for (let attempt = 0; attempt < 2; attempt++) {
        const intents = await getVoyageArchiveIntentSnapshot(scope);
        assertCurrent(scope);
        const local = await getOfflineEntries({ expectedScope: scope });
        assertCurrent(scope);
        let all: VoyageSummary[] | null = null;
        let active: VoyageSummary[] = [];
        try {
            [all, active] = await Promise.all([readRollup(scope, true), readRollup(scope, false)]);
        } catch (error) {
            assertCurrent(scope);
            if (!(error instanceof SummaryRpcUnavailable)) throw error;
        }
        assertCurrent(scope);
        let summaries: VoyageSummary[];
        const reconcile = new Set<string>();
        if (all !== null) {
            const allById = new Map(all.map((summary) => [summary.voyageId, summary]));
            const activeById = new Map(active.map((summary) => [summary.voyageId, summary]));
            for (const summary of active) {
                if (!allById.has(summary.voyageId) || summary.entryCount > allById.get(summary.voyageId)!.entryCount) {
                    throw new Error('Archive changed while loading. Please retry.');
                }
            }
            summaries = all.filter((summary) => {
                const unarchived = activeById.get(summary.voyageId);
                if (!unarchived) return true;
                if (summary.entryCount > unarchived.entryCount) reconcile.add(summary.voyageId);
                return false;
            });
            // A sentinel bucket may straddle a local delete/archive boundary.
            if (allById.has(DEFAULT_VOYAGE)) reconcile.add(DEFAULT_VOYAGE);
        } else {
            summaries = await archivedSummariesFromEntries(await readProjection(scope), scope);
        }
        for (const intent of intents) {
            const voyageId = voyageKey(intent.voyageId);
            if (all === null || voyageId === DEFAULT_VOYAGE) {
                reconcile.add(voyageId);
                continue;
            }
            // A stable voyage archive/unarchive command applies to the whole
            // voyage. Its full aggregate is already exact, even before the
            // cloud has acknowledged the command: don't repull 40k points.
            reconcile.delete(voyageId);
            summaries = summaries.filter((summary) => summary.voyageId !== voyageId);
            const fullSummary = all.find((summary) => summary.voyageId === voyageId);
            if (intent.archived && fullSummary) summaries.push(fullSummary);
        }
        for (const entry of local) {
            const voyageId = voyageKey(entry.voyageId);
            const intent = intents.find((candidate) => voyageKey(candidate.voyageId) === voyageId);
            if (intent?.archived === false && voyageId !== DEFAULT_VOYAGE) continue;
            if (entry.archived || intent?.archived || summaries.some((summary) => summary.voyageId === voyageId)) {
                reconcile.add(voyageId);
            }
        }
        for (const voyageId of reconcile) {
            const cloud = await readProjection(scope, voyageId);
            const localVoyage = local.filter((entry) => voyageKey(entry.voyageId) === voyageId);
            const replacement = await archivedSummariesFromEntries(mergeQueuedEntries(cloud, localVoyage), scope);
            const membership = all?.find((summary) => summary.voyageId === voyageId)?.passageGroupId;
            summaries = [
                ...summaries.filter((summary) => summary.voyageId !== voyageId),
                ...replacement.map((summary) => ({
                    ...summary,
                    ...(membership ? { passageGroupId: membership } : {}),
                })),
            ];
        }
        const visible = await filterVoyageTombstonedEntries(
            summaries.map((summary) => ({ summary, voyageId: summary.voyageId, timestamp: summary.startedAt })),
            scope,
        );
        assertCurrent(scope);
        const latestIntents = await getVoyageArchiveIntentSnapshot(scope);
        assertCurrent(scope);
        if (intentKey(latestIntents) !== intentKey(intents)) continue;
        return visible.map(({ summary }) => summary).sort((a, b) => Date.parse(b.endedAt) - Date.parse(a.endedAt));
    }
    throw new Error('Archive changed while loading. Please retry.');
}
