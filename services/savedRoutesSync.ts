/**
 * Saved-route account sync — build on the desktop, sail on the phone
 * (masterplan Phase 5.3, table `saved_routes`).
 *
 * localStorage stays the source of truth for the UI (offline-first, exactly
 * like the diary): saves and deletes land locally first and push to the
 * account best-effort; `syncSavedRoutes()` pull-merges the account set when
 * the tracer opens. Merge is by id with newest-stamp-wins per id — same-name
 * saves OVERWRITE in place since 2026-07-15 (same id, fresh updatedAt), so
 * an offline overwrite must beat the stale account copy, not revert to it.
 */
import { supabase, isSupabaseConfigured } from './supabase';
import {
    capSavedTracesPreservingTrips,
    clearSyncedSavedTraceTombstones,
    getSavedTraceTombstones,
    loadSavedTraces,
    notifySavedRoutesChanged,
    repairOrphanedSavedTraceChains,
    type SavedTrace,
    type TracePoint,
} from './routeTracer';
import { createLogger } from '../utils/createLogger';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from './authIdentityScope';
import { normaliseTraceVerification } from './traceVerification';
import { AUTOROUTING_PROPOSAL_MAX_POINTS, normaliseAutoroutingProposalEvidence } from './autoroutingProposalEvidence';

const log = createLogger('savedRoutesSync');

const TRACES_KEY = 'thalassa_traced_routes_v1';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** The optional column is deployed independently of this client. Keep the
 * wire boundary explicit; point/evidence contents are validated below. */
interface SavedRouteWireRow {
    id: string;
    name: string;
    points: unknown;
    created_at: string | null;
    updated_at?: string | null;
    deleted?: boolean;
    trip_id?: unknown;
    leg_ordinal?: unknown;
    dest_name?: unknown;
    planned_route_id?: unknown;
    passage_voyage_id?: unknown;
    proposal_evidence?: unknown;
}

/**
 * Graph-cleanup retries already settled this app session, keyed scope:id.
 * MODULE scope on purpose (a ref would die with a component instance): the
 * tombstone graph retry costs auth.getUser + several Supabase selects per
 * tombstone, and graph-linked tombstones are retained indefinitely — running
 * it on EVERY sync turned each planning-page reload into a probe storm (and,
 * before deleteSavedRoutePassageGraph gated its change events on real work,
 * a self-sustaining reload loop). Once per session is the retry ledger's
 * actual contract: cross-session persistence is what the tombstone is for.
 */
const settledGraphRetries = new Set<string>();

function validPassageVoyageId(value: unknown): value is string {
    return typeof value === 'string' && UUID_RE.test(value.trim());
}

function writeLocal(all: SavedTrace[], scope: AuthIdentityScope): void {
    if (!isAuthIdentityScopeCurrent(scope)) return;
    try {
        localStorage.setItem(
            authScopedStorageKey(TRACES_KEY, scope),
            JSON.stringify(capSavedTracesPreservingTrips(all)),
        );
    } catch {
        /* quota — local set unchanged */
    }
}

async function signedIn(scope: AuthIdentityScope): Promise<boolean> {
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope) || !isSupabaseConfigured() || !supabase) return false;
    try {
        const user = (await supabase.auth.getUser()).data.user;
        return isAuthIdentityScopeCurrent(scope) && user?.id === scope.userId;
    } catch {
        return false;
    }
}

/** Outcome of a push — surfaced in the tracer's save flash so a route
 *  that only landed on THIS device never silently poses as synced. */
export type PushResult = 'ok' | 'signedout' | 'toolarge' | 'error' | 'stale' | 'schema-pending';

function missingProposalEvidenceColumn(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const value = error as { code?: unknown; message?: unknown };
    return (
        ['42703', 'PGRST204'].includes(String(value.code)) &&
        typeof value.message === 'string' &&
        value.message.includes('proposal_evidence')
    );
}

/** The live evidence CHECK names only the old 'sevencs-trial' origin until
 * 20261001120000 is pushed (2026-10-01, Shane runs the db push). A Thalassa
 * Auto save rejected by it (Postgres 23514) stays on this device and says
 * "sync pending a server update", rather than reading as a failure. */
function proposalEvidenceOriginPending(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const value = error as { code?: unknown; message?: unknown; details?: unknown };
    const text = [value.message, value.details].filter((v): v is string => typeof v === 'string').join(' ');
    return String(value.code) === '23514' && text.includes('saved_routes_proposal_evidence_bounded');
}

/** Push one trace to the account. Fire-and-forget from saveTrace. */
export async function pushSavedRoute(
    trace: SavedTrace,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<PushResult> {
    // Freeze the write material before the asynchronous session lookup.
    const proposalEvidence = normaliseAutoroutingProposalEvidence(trace.proposalEvidence, trace.points);
    if (trace.proposalEvidence !== undefined && !proposalEvidence) return 'error';
    const snapshot = {
        ...trace,
        points: trace.points.map(({ lat, lon }) => ({ lat, lon })),
        ...(proposalEvidence ? { proposalEvidence } : {}),
    };
    if (!scope.userId) return 'signedout';
    if (!isAuthIdentityScopeCurrent(scope)) return 'stale';
    if (!(await signedIn(scope))) {
        return isAuthIdentityScopeCurrent(scope) ? 'signedout' : 'stale';
    }
    // The proposal-evidence migration supports the full trial limit. Older
    // backends may reject a long row: retain it locally, never simplify it.
    if (snapshot.points.length > AUTOROUTING_PROPOSAL_MAX_POINTS) {
        log.warn(`push skipped for ${snapshot.id}: route exceeds the point sync cap`);
        return 'toolarge';
    }
    const payload = {
        id: snapshot.id,
        // Explicit ownership makes a concurrent auth-token transition fail
        // RLS instead of silently defaulting the row to the next account.
        user_id: scope.userId,
        name: snapshot.name,
        points: snapshot.points.map((p) => [p.lat, p.lon]),
        created_at: snapshot.createdAt,
        updated_at: snapshot.updatedAt ?? new Date().toISOString(),
        trip_id: snapshot.tripId ?? null,
        leg_ordinal: snapshot.legOrdinal ?? null,
        dest_name: snapshot.destName ?? null,
        planned_route_id: snapshot.plannedRouteId ?? null,
        // The migration deliberately uses UUID for the actual voyages.id.
        // Older local caches may hold an arbitrary string, which must not
        // make the entire canonical route upsert fail.
        passage_voyage_id: validPassageVoyageId(snapshot.passageVoyageId) ? snapshot.passageVoyageId.trim() : null,
        proposal_evidence: proposalEvidence ?? null,
        deleted: false,
    };
    let { error } = await supabase!.from('saved_routes').upsert(payload);
    if (missingProposalEvidenceColumn(error)) {
        if (proposalEvidence) return isAuthIdentityScopeCurrent(scope) ? 'schema-pending' : 'stale';
        if (!isAuthIdentityScopeCurrent(scope)) return 'stale';
        // Legacy ordinary routes may use the old schema. A proposal with
        // evidence NEVER takes this metadata-dropping compatibility branch.
        const { proposal_evidence: _unsupported, ...legacy } = payload;
        ({ error } = await supabase!.from('saved_routes').upsert(legacy));
    }
    if (!isAuthIdentityScopeCurrent(scope)) return 'stale';
    if (proposalEvidence && proposalEvidenceOriginPending(error)) {
        log.warn(`push pending for ${trace.id}: the server does not accept this evidence origin yet`);
        return 'schema-pending';
    }
    if (error) {
        log.warn(`push failed for ${trace.id}: ${error.message}`);
        return 'error';
    }
    return 'ok';
}

/** Tombstone a deleted trace on the account. Fire-and-forget. */
export async function pushSavedRouteDelete(
    id: string,
    scope: AuthIdentityScope = getAuthIdentityScope(),
    deletedAt = new Date().toISOString(),
): Promise<void> {
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope) || !(await signedIn(scope))) return;
    const { error } = await supabase!.from('saved_routes').upsert({
        id,
        user_id: scope.userId,
        name: '(deleted)',
        points: [
            [0, 0],
            [0, 0],
        ],
        deleted: true,
        updated_at: deletedAt,
    });
    if (!isAuthIdentityScopeCurrent(scope)) return;
    if (error) log.warn(`delete push failed for ${id}: ${error.message}`);
}

/**
 * Pull the account set and merge into localStorage. Account tombstones
 * remove local copies; local-only traces push up (a device that saved
 * offline catches the account up). Returns the merged list.
 */
export async function syncSavedRoutes(): Promise<SavedTrace[]> {
    const scope = getAuthIdentityScope();
    const local = loadSavedTraces(scope);
    const localTombstones = getSavedTraceTombstones(scope);
    if (!scope.userId) return local;
    if (!(await signedIn(scope))) {
        return isAuthIdentityScopeCurrent(scope) ? local : loadSavedTraces();
    }
    try {
        const fields =
            'id, name, points, created_at, updated_at, deleted, trip_id, leg_ordinal, dest_name, planned_route_id, passage_voyage_id';
        const fetchRows = (withEvidence: boolean) =>
            supabase!
                .from('saved_routes')
                .select(`${fields}${withEvidence ? ', proposal_evidence' : ''}`)
                .order('updated_at', { ascending: false })
                .limit(100)
                .returns<SavedRouteWireRow[]>();
        let { data, error } = await fetchRows(true);
        if (missingProposalEvidenceColumn(error)) {
            if (!isAuthIdentityScopeCurrent(scope)) return loadSavedTraces();
            ({ data, error } = await fetchRows(false));
        }
        if (!isAuthIdentityScopeCurrent(scope)) return loadSavedTraces();
        if (error) throw new Error(error.message);
        const rows = data ?? [];
        const localById = new Map(local.map((trace) => [trace.id, trace]));
        const deletedIds = new Set(rows.filter((r) => r.deleted).map((r) => r.id as string));
        const allDeletedIds = new Set([...deletedIds, ...Object.keys(localTombstones)]);
        const remote: SavedTrace[] = rows
            .filter((r) => !r.deleted && !allDeletedIds.has(r.id as string) && Array.isArray(r.points))
            .map((r) => {
                const rawPoints = r.points as unknown[];
                if (
                    rawPoints.length < 2 ||
                    rawPoints.length > AUTOROUTING_PROPOSAL_MAX_POINTS ||
                    ![...rawPoints].every(
                        (p) =>
                            Array.isArray(p) &&
                            p.length === 2 &&
                            typeof p[0] === 'number' &&
                            typeof p[1] === 'number' &&
                            Number.isFinite(p[0]) &&
                            Number.isFinite(p[1]) &&
                            Math.abs(p[0]) <= 90 &&
                            Math.abs(p[1]) <= 180,
                    )
                )
                    return null;
                const points = (rawPoints as [number, number][]).map(([lat, lon]) => ({ lat, lon }) as TracePoint);
                const evidenceValue = r.proposal_evidence ?? localById.get(r.id as string)?.proposalEvidence;
                const proposalEvidence = normaliseAutoroutingProposalEvidence(evidenceValue, points);
                if (evidenceValue !== undefined && evidenceValue !== null && !proposalEvidence) return null;
                // saved_routes predates verification metadata. Keep a local
                // envelope across its own cloud round-trip only when it still
                // proves the returned coordinates. A different device safely
                // receives no envelope and re-checks before direct use; its
                // Passage Planning mirror carries the durable Cast Off proof.
                const verification = normaliseTraceVerification(localById.get(r.id as string)?.verification, points);
                return {
                    id: r.id as string,
                    name: r.name as string,
                    createdAt: (r.created_at as string) ?? new Date().toISOString(),
                    ...(r.updated_at ? { updatedAt: r.updated_at as string } : {}),
                    ...(typeof r.trip_id === 'string' && r.trip_id ? { tripId: r.trip_id } : {}),
                    ...(typeof r.leg_ordinal === 'number' && Number.isInteger(r.leg_ordinal) && r.leg_ordinal > 0
                        ? { legOrdinal: r.leg_ordinal }
                        : {}),
                    ...(typeof r.dest_name === 'string' && r.dest_name ? { destName: r.dest_name } : {}),
                    ...(typeof r.planned_route_id === 'string' && r.planned_route_id
                        ? { plannedRouteId: r.planned_route_id }
                        : {}),
                    ...(typeof r.passage_voyage_id === 'string' && r.passage_voyage_id
                        ? { passageVoyageId: r.passage_voyage_id }
                        : {}),
                    ...(verification ? { verification } : {}),
                    ...(proposalEvidence ? { proposalEvidence } : {}),
                    points,
                };
            })
            .filter((t): t is SavedTrace => t !== null);
        const remoteById = new Map(remote.map((t) => [t.id, t]));
        const stamp = (t: SavedTrace): number => new Date(t.updatedAt ?? t.createdAt).getTime();
        const localOnly = local.filter((t) => !remoteById.has(t.id) && !allDeletedIds.has(t.id));
        // Local overwrites that haven't reached the account yet (offline
        // save): same id, newer stamp — keep the local copy and push it up,
        // or this merge would silently revert the punter's edit.
        const localNewer = local.filter((t) => {
            const r = remoteById.get(t.id);
            return !!r && !allDeletedIds.has(t.id) && stamp(t) > stamp(r);
        });
        // Catch the account up with offline saves, best-effort.
        for (const t of [...localOnly, ...localNewer]) void pushSavedRoute(t, scope);
        // A local deletion must win over an in-flight older cloud save. Keep
        // retrying its tombstone until a later pull actually observes it.
        for (const [id, tombstone] of Object.entries(localTombstones)) {
            if (!deletedIds.has(id)) void pushSavedRouteDelete(id, scope, tombstone.deletedAt);
            // An offline delete may have been able to tombstone the canonical
            // trace before its Log/Passage mirrors were reachable. Retry the
            // exact graph cleanup when sync regains an authenticated
            // connection — but at most ONCE per app session per tombstone:
            // graph-linked tombstones are retained forever, and re-probing
            // them on every sync was a per-reload Supabase storm.
            const retryKey = `${scope.userId ?? 'anon'}:${id}`;
            if (settledGraphRetries.has(retryKey)) continue;
            void import('./savedRouteGraph')
                .then(({ deleteSavedRoutePassageGraph }) => deleteSavedRoutePassageGraph(id, tombstone, scope))
                .then(() => {
                    settledGraphRetries.add(retryKey);
                })
                .catch(() => {});
        }
        const localWins = new Set(localNewer.map((t) => t.id));
        const merged = [...localOnly, ...localNewer, ...remote.filter((t) => !localWins.has(t.id))].sort(
            (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        const repaired = repairOrphanedSavedTraceChains(merged, new Date().toISOString());
        // A repair is a real structural update, not merely a display label.
        // Publish every promoted leg so the next device cannot recreate the
        // old missing-root chain on its next pull.
        for (const trace of repaired.changed) void pushSavedRoute(trace, scope);
        writeLocal(repaired.traces, scope);
        // Server tombstones are durable acknowledgement of our local fence.
        // Do not clear fences merely because a live row disappeared from a
        // paged result — only an explicit deleted row is safe confirmation.
        // Tombstones carrying graph links stay as a tiny retry ledger until a
        // deliberate re-save replaces the id. Plain trace deletes can compact
        // as soon as Supabase has acknowledged their tombstone.
        clearSyncedSavedTraceTombstones(
            [...deletedIds].filter((id) => {
                const tombstone = localTombstones[id];
                return !tombstone?.plannedRouteId && !tombstone?.passageVoyageId;
            }),
            scope,
        );
        // ONLY announce a change when something actually changed.
        //
        // This fired unconditionally, and it drove a self-sustaining reload
        // loop that emptied the Passage Planning summary. notifySavedRoutesChanged
        // dispatches 'thalassa:saved-routes-changed' SYNCHRONOUSLY; CrewManagement
        // listens for it and calls reloadDropdown(), whose first statement bumps
        // dropdownReloadVersion. That bump lands before the in-flight reload's
        // `await Promise.all([... syncSavedRoutes() ...])` resumes, so its version
        // guard aborts it — after its early phases have already repainted the rows
        // as bare Voyage objects, and BEFORE the only phase that attaches geometry.
        //
        // Every reload therefore stripped departureCoords, routeCoordinates,
        // distanceNm and durationHours and then cancelled itself, forever. Hence
        // Duration "--", Distance "--" and "Forecast unavailable" (the max-conditions
        // fetch short-circuits on fewer than 2 route points). It only appeared to
        // self-heal when a sync threw, or when signed out — which is why it read as
        // intermittent rather than broken.
        //
        // Signature is order-insensitive and cheap: identity plus the two things a
        // meaningful change moves — the revision stamp and the point count.
        const signature = (traces: SavedTrace[]) =>
            traces
                .map(
                    (t) =>
                        `${t.id}:${t.updatedAt ?? t.createdAt}:${t.points.length}:${t.verification?.geometryKey ?? ''}:${t.proposalEvidence?.savedAt ?? ''}`,
                )
                .sort()
                .join('|');
        if (isAuthIdentityScopeCurrent(scope) && signature(local) !== signature(repaired.traces)) {
            notifySavedRoutesChanged(scope);
        }
        return isAuthIdentityScopeCurrent(scope) ? repaired.traces : loadSavedTraces();
    } catch (err) {
        log.warn(`sync failed: ${err instanceof Error ? err.message : String(err)}`);
        return isAuthIdentityScopeCurrent(scope) ? local : loadSavedTraces();
    }
}
