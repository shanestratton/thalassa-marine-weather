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
    clearSyncedSavedTraceTombstones,
    getSavedTraceTombstones,
    loadSavedTraces,
    notifySavedRoutesChanged,
    persistSavedTraceLibrary,
    repairOrphanedSavedTraceChains,
    type SavedTrace,
    type TracePoint,
} from './routeTracer';
import { createLogger } from '../utils/createLogger';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';
import {
    normaliseTraceVerification,
    traceCheckFromTheFuture,
    traceFollowStatus,
    type TraceFollowContext,
    type TraceVerification,
} from './traceVerification';
import { useSettingsStore } from '../stores/settingsStore';
import { vesselDraftIsAssumed, vesselDraftMetres } from './units';
import { AUTOROUTING_PROPOSAL_MAX_POINTS, normaliseAutoroutingProposalEvidence } from './autoroutingProposalEvidence';
import { chartFreeEvidence } from './chartFacts';

const log = createLogger('savedRoutesSync');

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
    verification?: unknown;
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

function writeLocal(all: SavedTrace[], scope: AuthIdentityScope, pendingIds: ReadonlySet<string>): void {
    // The library's one writer: capped (a followed trip exempt, and the routes
    // still on their way to the account kept), and a refused write leaves the
    // library exactly as it was.
    if (!persistSavedTraceLibrary(all, scope, pendingIds))
        log.warn('sync merge not stored: this phone refused the write');
}

// ── saved_routes.verification (125-07) ──────────────────────────────────────
//
// A route check used to live only on the phone that made it. The column
// carries it to a reinstall or a second phone. Its migration
// (20261009172000_saved_routes_verification.sql) waits for Shane's db push,
// and PostgREST refuses a whole row that names an unknown column — so the
// sync PROBES first, and nothing reads or writes the column until it has been
// SEEN. Present is remembered for the session; absent is asked again after an
// hour (the push may land while the app is open); a probe that failed or
// timed out is asked again on the next sync. Until then the app is exactly
// build 124: the passage-notes copy (traceCheckRecovery) is the fallback.

const VERIFICATION_PROBE_TIMEOUT_MS = 5_000;
const VERIFICATION_ABSENT_RECHECK_MS = 60 * 60_000;
/** Compact JSON. A 10,000-pin envelope is ~300 KB (the geometry key alone
 *  ~220 KB) and ~380 KB at worst (every leg a caution, every one acknowledged);
 *  jsonb's separator spaces add ~20 KB to that, still inside the server's
 *  512 KiB bound. So this only ever stops a corrupt one. */
const VERIFICATION_MAX_JSON = 400_000;
const tooLargeLogged = new Set<string>();

let verificationColumn: { present: true } | { present: false; at: number } | null = null;
let verificationProbe: Promise<boolean> | null = null;

function markVerificationColumnAbsent(): void {
    verificationColumn = { present: false, at: Date.now() };
}

/** Has the column been SEEN this session? A synchronous peek: everything but
 *  the sync's own probe uses this, so no other path spends a request on it. */
export function savedRoutesVerificationColumnKnownPresent(): boolean {
    return verificationColumn?.present === true;
}

/** Ask (or remember) whether saved_routes.verification exists. Never throws;
 *  false unless it was seen. */
export async function savedRoutesVerificationColumnPresent(now = Date.now()): Promise<boolean> {
    if (verificationColumn?.present) return true;
    if (verificationColumn && now - verificationColumn.at < VERIFICATION_ABSENT_RECHECK_MS) return false;
    if (verificationProbe) return verificationProbe;
    verificationProbe = (async () => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            if (!isSupabaseConfigured() || !supabase) return false;
            const probe = supabase.from('saved_routes').select('verification').limit(0);
            const result = await Promise.race([
                Promise.resolve(probe),
                new Promise<null>((resolve) => {
                    timer = setTimeout(() => resolve(null), VERIFICATION_PROBE_TIMEOUT_MS);
                }),
            ]);
            if (!result) return false; // timed out: unknown, ask next time
            if (!result.error) {
                verificationColumn = { present: true };
                log.warn('saved_routes.verification is present: route checks travel with the account');
                return true;
            }
            if (missingColumn(result.error, 'verification')) {
                if (verificationColumn === null) log.warn('saved_routes.verification is not there yet');
                verificationColumn = { present: false, at: now };
            }
            return false;
        } catch {
            return false; // offline or no client: unknown, ask next time
        } finally {
            if (timer) clearTimeout(timer);
            verificationProbe = null;
        }
    })();
    return verificationProbe;
}

/** The check as it may go on the wire: proving these pins, and sane in size. */
function wireVerification(value: unknown, points?: readonly TracePoint[]): TraceVerification | null {
    const verification = normaliseTraceVerification(value, points);
    if (!verification) return null;
    const size = JSON.stringify(verification).length;
    if (size <= VERIFICATION_MAX_JSON) return verification;
    if (!tooLargeLogged.has(verification.geometryKey)) {
        tooLargeLogged.add(verification.geometryKey);
        log.warn(`check kept on this device: ${size} characters is over the account's ${VERIFICATION_MAX_JSON}`);
    }
    return null;
}

/** This device's keel and clock: what a check has to be green against HERE. */
function deviceCheckContext(): TraceFollowContext {
    const vessel = useSettingsStore.getState().settings?.vessel;
    return { draftM: vesselDraftMetres(vessel), draftAssumed: vesselDraftIsAssumed(vessel), nowMs: Date.now() };
}

/**
 * Which of two checks for the same pins this device keeps (125-07). An
 * account check dated in the future (a skewed clock elsewhere) is absent. A
 * check that is green HERE — this keel, not assumed, in date — beats one that
 * is not, whatever their dates: a newer check made on an iPad still at
 * another draft, or a fresh install whose draft had not loaded, must not turn
 * this phone's good check amber. Otherwise the newer wins (a tie keeps
 * `local`). Both were re-proved against the same pins; nothing turns green
 * here that traceFollowStatus would not.
 */
function preferredVerification(
    local: TraceVerification | null,
    remote: TraceVerification | null,
    points: readonly TracePoint[],
    context: TraceFollowContext,
): TraceVerification | null {
    const account = remote && !traceCheckFromTheFuture(remote.checkedAt, context.nowMs) ? remote : null;
    if (!local || !account) return local ?? account;
    const greenHere = (check: TraceVerification) => traceFollowStatus(check, points, context).tone === 'checked';
    const localGreen = greenHere(local);
    if (localGreen !== greenHere(account)) return localGreen ? local : account;
    return Date.parse(account.checkedAt) > Date.parse(local.checkedAt) ? account : local;
}

/**
 * Put a check on the account copy of a route — the check ONLY, never the pins
 * or updated_at (a bank is not an edit), and only onto `revision`, the row
 * version the check was made for: if another device has moved the route since,
 * nothing changes. Writes nothing until the column has been seen.
 */
export async function pushSavedRouteVerification(
    traceId: string,
    value: TraceVerification,
    revision: string,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<PushResult> {
    const id = traceId.trim();
    const verification = wireVerification(value);
    if (!id || !revision || !verification) return 'error';
    if (!savedRoutesVerificationColumnKnownPresent()) return 'schema-pending';
    if (!scope.userId) return 'signedout';
    if (!isAuthIdentityScopeCurrent(scope)) return 'stale';
    if (!(await signedIn(scope))) return isAuthIdentityScopeCurrent(scope) ? 'signedout' : 'stale';
    const { data, error } = await supabase!
        .from('saved_routes')
        .update({ verification })
        .eq('id', id)
        .eq('user_id', scope.userId)
        .eq('deleted', false)
        .eq('updated_at', revision)
        .select('id');
    if (!isAuthIdentityScopeCurrent(scope)) return 'stale';
    if (missingColumn(error, 'verification')) {
        markVerificationColumnAbsent();
        return 'schema-pending';
    }
    if (error) {
        log.warn(`check not sent for ${id}: ${error.message}`);
        return 'error';
    }
    if (!Array.isArray(data) || data.length === 0) {
        log.warn(`check kept on this device for ${id}: the account copy has moved on`);
        return 'stale';
    }
    return 'ok';
}

/** The account's checks for these routes, raw (callers re-prove them against
 *  their own pins). Empty until the column has been seen; never throws. */
export async function pullSavedRouteVerifications(
    ids: readonly string[],
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<Map<string, unknown>> {
    const out = new Map<string, unknown>();
    try {
        if (ids.length === 0 || !scope.userId || !supabase || !savedRoutesVerificationColumnKnownPresent()) return out;
        const { data, error } = await supabase
            .from('saved_routes')
            .select('id, verification')
            .in('id', [...ids])
            .eq('user_id', scope.userId)
            .eq('deleted', false);
        if (!isAuthIdentityScopeCurrent(scope) || error || !Array.isArray(data)) return out;
        for (const row of data as Array<{ id: string; verification: unknown }>) {
            if (row.verification != null) out.set(row.id, row.verification);
        }
    } catch (error) {
        log.warn('account checks not read:', error);
    }
    return out;
}

/** Tests only. */
export function __resetSavedRoutesVerificationColumnForTests(): void {
    verificationColumn = null;
    verificationProbe = null;
    tooLargeLogged.clear();
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

/** 42703: undefined column (Postgres). PGRST204: not in PostgREST's schema cache. */
function missingColumn(error: unknown, column: 'proposal_evidence' | 'verification'): boolean {
    if (!error || typeof error !== 'object') return false;
    const value = error as { code?: unknown; message?: unknown };
    return (
        ['42703', 'PGRST204'].includes(String(value.code)) &&
        typeof value.message === 'string' &&
        value.message.includes(column)
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
    // Freeze the write material before the asynchronous session lookup. Chart
    // facts from licensed charts never reach the account (127-C-b).
    const normalised = normaliseAutoroutingProposalEvidence(trace.proposalEvidence, trace.points);
    if (trace.proposalEvidence !== undefined && !normalised) return 'error';
    const proposalEvidence = normalised && chartFreeEvidence(normalised);
    const snapshot = {
        ...trace,
        points: trace.points.map(({ lat, lon }) => ({ lat, lon })),
        ...(proposalEvidence ? { proposalEvidence } : {}),
    };
    const verification = wireVerification(trace.verification, snapshot.points);
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
        // Only once the column has been seen, and only a check that proves
        // these pins. A route without one leaves the account's copy alone:
        // every reader re-proves it against the row's own points.
        ...(verification && savedRoutesVerificationColumnKnownPresent() ? { verification } : {}),
    };
    let { error } = await supabase!.from('saved_routes').upsert(payload);
    if ('verification' in payload && missingColumn(error, 'verification')) {
        markVerificationColumnAbsent();
        if (!isAuthIdentityScopeCurrent(scope)) return 'stale';
        const { verification: _absent, ...withoutCheck } = payload;
        ({ error } = await supabase!.from('saved_routes').upsert(withoutCheck));
    }
    if (missingColumn(error, 'proposal_evidence')) {
        if (proposalEvidence) return isAuthIdentityScopeCurrent(scope) ? 'schema-pending' : 'stale';
        if (!isAuthIdentityScopeCurrent(scope)) return 'stale';
        // Legacy ordinary routes may use the old schema. A proposal with
        // evidence NEVER takes this metadata-dropping compatibility branch.
        const { proposal_evidence: _unsupported, verification: _check, ...legacy } = payload;
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
    if (!scope.userId) return local;
    if (!(await signedIn(scope))) {
        return isAuthIdentityScopeCurrent(scope) ? local : loadSavedTraces();
    }
    try {
        // 125-07: read the check column only once it has been seen.
        let withChecks = await savedRoutesVerificationColumnPresent();
        if (!isAuthIdentityScopeCurrent(scope)) return loadSavedTraces();
        const fields =
            'id, name, points, created_at, updated_at, deleted, trip_id, leg_ordinal, dest_name, planned_route_id, passage_voyage_id';
        const fetchRows = (withEvidence: boolean) =>
            supabase!
                .from('saved_routes')
                .select(`${fields}${withEvidence ? ', proposal_evidence' : ''}${withChecks ? ', verification' : ''}`)
                .order('updated_at', { ascending: false })
                .limit(100)
                .returns<SavedRouteWireRow[]>();
        let { data, error } = await fetchRows(true);
        if (withChecks && missingColumn(error, 'verification')) {
            markVerificationColumnAbsent();
            withChecks = false;
            if (!isAuthIdentityScopeCurrent(scope)) return loadSavedTraces();
            ({ data, error } = await fetchRows(true));
        }
        if (missingColumn(error, 'proposal_evidence')) {
            if (!isAuthIdentityScopeCurrent(scope)) return loadSavedTraces();
            ({ data, error } = await fetchRows(false));
        }
        if (!isAuthIdentityScopeCurrent(scope)) return loadSavedTraces();
        if (error) throw new Error(error.message);
        const rows = data ?? [];
        // Re-read AFTER the fetch (build 124). The pre-fetch snapshot is stale
        // by now: a route check banked while the request was in flight (the
        // Log's acknowledgement, the background re-check) would otherwise be
        // overwritten by writeLocal below. Everything from here to that write
        // is synchronous, so nothing can land in between.
        const fresh = loadSavedTraces(scope);
        const freshTombstones = getSavedTraceTombstones(scope);
        const localById = new Map(fresh.map((trace) => [trace.id, trace]));
        const deletedIds = new Set(rows.filter((r) => r.deleted).map((r) => r.id as string));
        const allDeletedIds = new Set([...deletedIds, ...Object.keys(freshTombstones)]);
        const checksToSend: Array<{ id: string; verification: TraceVerification; revision: string }> = [];
        /** Account rows whose evidence still carried chart facts: stripped here, sent back once. */
        const evidenceToStrip = new Set<string>();
        const context = deviceCheckContext();
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
                const normalised = normaliseAutoroutingProposalEvidence(evidenceValue, points);
                if (evidenceValue !== undefined && evidenceValue !== null && !normalised) return null;
                const proposalEvidence = normalised && chartFreeEvidence(normalised);
                if (r.proposal_evidence && proposalEvidence !== normalised) evidenceToStrip.add(r.id as string);
                // A check counts only while it proves the returned
                // coordinates — this device's copy across its own round-trip
                // (124), or the account's (125-07, once the column exists).
                // The newer wins; a newer local one goes back up below.
                const localCheck = normaliseTraceVerification(localById.get(r.id as string)?.verification, points);
                const accountCheck = withChecks ? normaliseTraceVerification(r.verification, points) : null;
                const verification = preferredVerification(localCheck, accountCheck, points, context);
                // Up only when this device's check is the NEWER one: kept over
                // a newer account copy (another keel), it stays here — writing
                // it back would flip the other device, and then this one.
                if (
                    withChecks &&
                    localCheck &&
                    verification === localCheck &&
                    (!accountCheck || Date.parse(localCheck.checkedAt) > Date.parse(accountCheck.checkedAt)) &&
                    typeof r.updated_at === 'string' &&
                    r.updated_at
                ) {
                    checksToSend.push({ id: r.id as string, verification: localCheck, revision: r.updated_at });
                }
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
        const localOnly = fresh.filter((t) => !remoteById.has(t.id) && !allDeletedIds.has(t.id));
        // Local overwrites that haven't reached the account yet (offline
        // save): same id, newer stamp — keep the local copy and push it up,
        // or this merge would silently revert the punter's edit.
        const localNewer = fresh.filter((t) => {
            const r = remoteById.get(t.id);
            return !!r && !allDeletedIds.has(t.id) && stamp(t) > stamp(r);
        });
        // Catch the account up with offline saves, best-effort.
        for (const t of [...localOnly, ...localNewer]) void pushSavedRoute(t, scope);
        // A local deletion must win over an in-flight older cloud save. Keep
        // retrying its tombstone until a later pull actually observes it.
        for (const [id, tombstone] of Object.entries(freshTombstones)) {
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
        // Catch the account's check column up where this device holds a newer
        // check for the very pins the account has (a check banked offline, or
        // before the column existed). A full re-push above already carries it.
        const fullyPushed = new Set([...localWins, ...repaired.changed.map((trace) => trace.id)]);
        // Purge on contact (127-C-b): the account's copy is replaced by the stripped one.
        for (const trace of repaired.traces) {
            if (evidenceToStrip.has(trace.id) && !fullyPushed.has(trace.id)) {
                fullyPushed.add(trace.id);
                void pushSavedRoute(trace, scope);
            }
        }
        for (const check of checksToSend) {
            if (!fullyPushed.has(check.id))
                void pushSavedRouteVerification(check.id, check.verification, check.revision, scope);
        }
        writeLocal(repaired.traces, scope, new Set([...localOnly, ...localNewer].map((t) => t.id)));
        // Server tombstones are durable acknowledgement of our local fence.
        // Do not clear fences merely because a live row disappeared from a
        // paged result — only an explicit deleted row is safe confirmation.
        // Tombstones carrying graph links stay as a tiny retry ledger until a
        // deliberate re-save replaces the id. Plain trace deletes can compact
        // as soon as Supabase has acknowledged their tombstone.
        clearSyncedSavedTraceTombstones(
            [...deletedIds].filter((id) => {
                const tombstone = freshTombstones[id];
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
                        `${t.id}:${t.updatedAt ?? t.createdAt}:${t.points.length}:${t.verification?.geometryKey ?? ''}:${t.verification?.checkedAt ?? ''}:${t.proposalEvidence?.savedAt ?? ''}`,
                )
                .sort()
                .join('|');
        if (isAuthIdentityScopeCurrent(scope) && signature(fresh) !== signature(repaired.traces)) {
            notifySavedRoutesChanged(scope);
        }
        return isAuthIdentityScopeCurrent(scope) ? repaired.traces : loadSavedTraces();
    } catch (err) {
        log.warn(`sync failed: ${err instanceof Error ? err.message : String(err)}`);
        return isAuthIdentityScopeCurrent(scope) ? local : loadSavedTraces();
    }
}
