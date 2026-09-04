/**
 * VoyageService — Passage state management.
 *
 * Tracks active voyages. When a voyage is active:
 *  - Report Position UI is prioritised
 *  - Weather Master lock is enforced
 *  - P2P sync heartbeat runs
 */

import { supabase } from './supabase';
import { startLeg, closeLeg, getActiveLeg, deleteLegsForVoyage } from './VoyageLegService';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from './authIdentityScope';
import {
    parseTraceVerificationNote,
    traceCastOffBlockReason,
    TRACE_VERIFICATION_NOTES_PREFIX,
    traceRegistryScope,
} from './traceVerification';

// ── Types ──────────────────────────────────────────────────────────────────

export type VoyageStatus = 'planning' | 'active' | 'completed' | 'aborted';

export interface Voyage {
    id: string;
    user_id: string;
    vessel_id: string | null;
    /** Stable `boats.id` captured when this passage was planned. */
    boat_id?: string | null;
    voyage_name: string;
    departure_port: string | null;
    destination_port: string | null;
    departure_time: string | null;
    eta: string | null;
    crew_count: number;
    status: VoyageStatus;
    weather_master_id: string | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
    /** Server timestamp for the immutable Cast Off crew snapshot. */
    manifest_locked_at?: string | null;
    /** Canonical Route Tracer record that created this planning row. */
    saved_route_id?: string | null;
}

// ── Local state (for offline access) ──────────────────────────────────────

const ACTIVE_VOYAGE_KEY = 'thalassa_active_voyage';
const DRAFT_VOYAGES_KEY = 'thalassa_draft_voyages';

function activeVoyageStorageKey(scope: AuthIdentityScope = getAuthIdentityScope()): string {
    return authScopedStorageKey(ACTIVE_VOYAGE_KEY, scope);
}

function draftVoyagesStorageKey(scope: AuthIdentityScope = getAuthIdentityScope()): string {
    return authScopedStorageKey(DRAFT_VOYAGES_KEY, scope);
}

function identityStillOwns(scope: AuthIdentityScope, userId: string): boolean {
    return isAuthIdentityScopeCurrent(scope) && scope.userId === userId;
}

function isVoyageStatus(value: unknown): value is VoyageStatus {
    return value === 'planning' || value === 'active' || value === 'completed' || value === 'aborted';
}

function isNullableString(value: unknown): value is string | null {
    return value === null || typeof value === 'string';
}

function isVoyage(value: unknown): value is Voyage {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const voyage = value as Partial<Voyage>;
    return (
        typeof voyage.id === 'string' &&
        voyage.id.length > 0 &&
        typeof voyage.user_id === 'string' &&
        voyage.user_id.length > 0 &&
        isNullableString(voyage.vessel_id) &&
        (voyage.boat_id === undefined || isNullableString(voyage.boat_id)) &&
        typeof voyage.voyage_name === 'string' &&
        isNullableString(voyage.departure_port) &&
        isNullableString(voyage.destination_port) &&
        isNullableString(voyage.departure_time) &&
        isNullableString(voyage.eta) &&
        typeof voyage.crew_count === 'number' &&
        Number.isFinite(voyage.crew_count) &&
        isVoyageStatus(voyage.status) &&
        isNullableString(voyage.weather_master_id) &&
        isNullableString(voyage.notes) &&
        typeof voyage.created_at === 'string' &&
        typeof voyage.updated_at === 'string' &&
        (voyage.manifest_locked_at === undefined || isNullableString(voyage.manifest_locked_at)) &&
        (voyage.saved_route_id === undefined || isNullableString(voyage.saved_route_id))
    );
}

function isOwnedVoyage(
    value: unknown,
    ownerId: string,
    options: { id?: string; status?: VoyageStatus } = {},
): value is Voyage {
    return (
        isVoyage(value) &&
        value.user_id === ownerId &&
        (options.id === undefined || value.id === options.id) &&
        (options.status === undefined || value.status === options.status)
    );
}

function cloneVoyage(voyage: Voyage): Voyage {
    return { ...voyage };
}

async function revalidateAuth(scope: AuthIdentityScope, expectedUserId: string): Promise<boolean> {
    if (!supabase || !identityStillOwns(scope, expectedUserId)) return false;
    const {
        data: { user },
        error,
    } = await supabase.auth.getUser();
    return !error && !!user && user.id === expectedUserId && identityStillOwns(scope, expectedUserId);
}

function readDraftVoyageCache(scope: AuthIdentityScope = getAuthIdentityScope()): Voyage[] {
    try {
        if (!isAuthIdentityScopeCurrent(scope)) return [];
        const scoped = localStorage.getItem(draftVoyagesStorageKey(scope));
        if (scoped) {
            const parsed = JSON.parse(scoped) as unknown;
            const ownerId = scope.userId;
            if (!Array.isArray(parsed) || !ownerId) return [];
            return parsed
                .filter((voyage): voyage is Voyage => isOwnedVoyage(voyage, ownerId, { status: 'planning' }))
                .map(cloneVoyage);
        }

        // Legacy drafts were owner-only. Adopt only rows whose embedded owner
        // exactly matches the synchronously fenced account.
        const identity = scope.userId;
        if (!identity) return [];
        const legacy = localStorage.getItem(DRAFT_VOYAGES_KEY);
        if (!legacy) return [];
        const parsed = JSON.parse(legacy) as unknown;
        if (!Array.isArray(parsed)) return [];
        const owned = parsed
            .filter((voyage): voyage is Voyage => isOwnedVoyage(voyage, identity, { status: 'planning' }))
            .map(cloneVoyage);
        if (owned.length > 0) {
            localStorage.setItem(draftVoyagesStorageKey(scope), JSON.stringify(owned));
        }
        return owned;
    } catch {
        return [];
    }
}

/**
 * Return the locally cached saved routes for the current account.
 *
 * This is deliberately synchronous: operational surfaces such as Passage
 * Planning can paint the skipper's last-known routes immediately, then refresh
 * from Supabase in the background. The cache remains ownership- and
 * status-validated by `readDraftVoyageCache`, so it is safe to use only for
 * the account currently fenced by `authIdentityScope`.
 */
export function getCachedDraftVoyages(): Voyage[] {
    return readDraftVoyageCache();
}

/**
 * Remove an owned planning row from the local fast-path cache. Networked
 * graph deletion still removes the database row; this small helper stops an
 * offline delete from repainting a just-removed saved route in Passage
 * Planning while the durable retry catches up.
 */
export function removeCachedDraftVoyageById(
    voyageId: string,
    scope: AuthIdentityScope = getAuthIdentityScope(),
    expectedSavedRouteId?: string,
    options: { allowUnlinkedSavedRoute?: boolean } = {},
): boolean {
    const id = voyageId.trim();
    if (!id || !isAuthIdentityScopeCurrent(scope)) return false;
    const drafts = readDraftVoyageCache(scope);
    const expectedRouteId = expectedSavedRouteId?.trim();
    const ownsExpectedRoute = (voyage: Voyage): boolean => {
        if (!expectedRouteId) return true;
        if (voyage.saved_route_id === expectedRouteId) return true;
        // Pre-link builds created a real passage-voyage row before the
        // saved_route_id column/link was available. A caller may use this
        // narrow escape hatch only after it has independently proved the
        // voyage UUID is the exact mirror of the route it is deleting.
        return options.allowUnlinkedSavedRoute === true && !voyage.saved_route_id;
    };
    if (!drafts.some((voyage) => voyage.id === id && ownsExpectedRoute(voyage))) return false;
    try {
        writeDraftVoyageCache(
            drafts.filter((voyage) => voyage.id !== id || !ownsExpectedRoute(voyage)),
            scope,
        );
        return true;
    } catch {
        return false;
    }
}

function writeDraftVoyageCache(voyages: Voyage[], scope: AuthIdentityScope = getAuthIdentityScope()): void {
    const ownerId = scope.userId;
    if (!ownerId || !isAuthIdentityScopeCurrent(scope)) return;
    const ownedDrafts = voyages
        .filter((voyage) => isOwnedVoyage(voyage, ownerId, { status: 'planning' }))
        .map(cloneVoyage);
    localStorage.setItem(draftVoyagesStorageKey(scope), JSON.stringify(ownedDrafts));
}

function cacheVoyage(v: Voyage | null, scope: AuthIdentityScope = getAuthIdentityScope()): void {
    if (!isAuthIdentityScopeCurrent(scope)) return;
    const voyage = v && isVoyage(v) && v.status === 'active' ? cloneVoyage(v) : null;
    try {
        if (voyage) localStorage.setItem(activeVoyageStorageKey(scope), JSON.stringify(voyage));
        else localStorage.removeItem(activeVoyageStorageKey(scope));
    } catch {
        /* full */
    }
    // Notify any listening UI (SystemStatusButton, hero card, etc)
    // that the active voyage has changed. They subscribe synchronously
    // via getCachedActiveVoyage() — no network round-trip.
    try {
        if (typeof window !== 'undefined' && isAuthIdentityScopeCurrent(scope)) {
            window.dispatchEvent(new CustomEvent('thalassa:active-voyage-changed', { detail: { voyage } }));
        }
    } catch {
        /* SSR / older browser — non-critical */
    }
}

/** Get cached active voyage (offline-safe) */
export function getCachedActiveVoyage(): Voyage | null {
    const scope = getAuthIdentityScope();
    try {
        const scoped = localStorage.getItem(activeVoyageStorageKey(scope));
        if (scoped) {
            const parsed = JSON.parse(scoped) as unknown;
            return isAuthIdentityScopeCurrent(scope) && isVoyage(parsed) && parsed.status === 'active'
                ? cloneVoyage(parsed)
                : null;
        }

        // A legacy cache can only be attributed when its row says the current
        // account owns it. Shared-crew caches are intentionally not guessed.
        const identity = scope.userId;
        const legacy = localStorage.getItem(ACTIVE_VOYAGE_KEY);
        if (!identity || !legacy) return null;
        const parsed = JSON.parse(legacy) as unknown;
        if (!isOwnedVoyage(parsed, identity, { status: 'active' }) || !isAuthIdentityScopeCurrent(scope)) return null;
        localStorage.setItem(activeVoyageStorageKey(scope), JSON.stringify(parsed));
        return cloneVoyage(parsed);
    } catch {
        return null;
    }
}

interface VoyageCrewMembership {
    owner_id: string;
    crew_user_id: string;
    status: string;
    voyage_id: string | null;
    permissions: Record<string, unknown> | null;
}

async function canReadVoyageAsCrew(voyage: Voyage, scope: AuthIdentityScope, authUserId: string): Promise<boolean> {
    if (!supabase || !identityStillOwns(scope, authUserId)) return false;
    if (voyage.user_id === authUserId) return true;

    const { data, error } = await supabase
        .from('vessel_crew')
        .select('owner_id, crew_user_id, status, voyage_id, permissions')
        .eq('owner_id', voyage.user_id)
        .eq('crew_user_id', authUserId)
        .eq('status', 'accepted');
    if (error || !identityStillOwns(scope, authUserId) || !Array.isArray(data)) return false;

    return (data as VoyageCrewMembership[]).some(
        (membership) =>
            membership.owner_id === voyage.user_id &&
            membership.crew_user_id === authUserId &&
            membership.status === 'accepted' &&
            membership.permissions?.can_view_passage === true &&
            (membership.voyage_id === null || membership.voyage_id === voyage.id),
    );
}

async function validateVisibleVoyage(
    value: unknown,
    scope: AuthIdentityScope,
    authUserId: string,
    options: { id?: string; status?: VoyageStatus } = {},
): Promise<Voyage | null> {
    if (
        !isVoyage(value) ||
        (options.id !== undefined && value.id !== options.id) ||
        (options.status !== undefined && value.status !== options.status) ||
        !identityStillOwns(scope, authUserId)
    ) {
        return null;
    }
    if (!(await canReadVoyageAsCrew(value, scope, authUserId)) || !identityStillOwns(scope, authUserId)) return null;
    return cloneVoyage(value);
}

// ── CRUD ────────────────────────────────────────────────────────────────

/**
 * Create a new voyage (starts in 'planning' status).
 *
 * Optional departure_time / eta let the caller seed the dates at
 * creation — used by PassagePlanSave so a route saved with a typed
 * departureDate doesn't lose it when re-opened in Passage Planning.
 */
export async function createVoyage(
    data: Pick<Voyage, 'voyage_name' | 'departure_port' | 'destination_port' | 'crew_count'> & {
        vessel_id?: string;
        /** Exact fleet boat captured by the caller before any network await. */
        boat_id?: string | null;
        departure_time?: string | null;
        eta?: string | null;
        saved_route_id?: string | null;
        /** Machine trace verification and/or skipper notes captured at plan creation. */
        notes?: string | null;
    },
): Promise<{ voyage: Voyage | null; error?: string }> {
    if (!supabase) return { voyage: null, error: 'Offline — no Supabase connection' };
    const identity = getAuthIdentityScope();

    const {
        data: { user },
        error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user || !identityStillOwns(identity, user.id)) {
        return { voyage: null, error: 'Sign in required to create a voyage' };
    }

    const insert = {
        voyage_name: data.voyage_name,
        departure_port: data.departure_port,
        destination_port: data.destination_port,
        crew_count: data.crew_count,
        ...(data.vessel_id !== undefined ? { vessel_id: data.vessel_id } : {}),
        ...(data.boat_id !== undefined ? { boat_id: data.boat_id } : {}),
        ...(data.departure_time !== undefined ? { departure_time: data.departure_time } : {}),
        ...(data.eta !== undefined ? { eta: data.eta } : {}),
        ...(data.saved_route_id !== undefined ? { saved_route_id: data.saved_route_id } : {}),
        ...(data.notes !== undefined ? { notes: data.notes } : {}),
        user_id: user.id,
        weather_master_id: user.id,
        status: 'planning' as const,
    };
    const { data: voyage, error } = await supabase.from('voyages').insert(insert).select().single();

    if (error) {
        console.error('[VoyageService] createVoyage failed:', error.message, error.details, error.hint, error.code);
        return { voyage: null, error: error.message };
    }
    if (!isOwnedVoyage(voyage, user.id, { status: 'planning' }) || !(await revalidateAuth(identity, user.id))) {
        return { voyage: null, error: 'Account changed while creating the voyage' };
    }
    const created = cloneVoyage(voyage);
    // A newly saved route should be available to the next Passage Planning
    // render without waiting for a fresh auth + voyages-table round trip.
    // Keep the cache de-duplicated because a retry can legitimately return the
    // same row after an ambiguous network response.
    try {
        const cached = readDraftVoyageCache(identity);
        writeDraftVoyageCache([created, ...cached.filter((draft) => draft.id !== created.id)], identity);
    } catch {
        /* local storage unavailable — the cloud read remains authoritative */
    }
    return { voyage: created };
}

/** Editable fields on a draft voyage */
export type VoyageUpdate = Partial<
    Pick<
        Voyage,
        'voyage_name' | 'departure_port' | 'destination_port' | 'departure_time' | 'eta' | 'crew_count' | 'notes'
    >
>;

const VOYAGE_UPDATE_KEYS = [
    'voyage_name',
    'departure_port',
    'destination_port',
    'departure_time',
    'eta',
    'crew_count',
    'notes',
] as const;

function snapshotVoyageUpdate(data: VoyageUpdate): VoyageUpdate {
    const update: VoyageUpdate = {};
    for (const key of VOYAGE_UPDATE_KEYS) {
        if (Object.prototype.hasOwnProperty.call(data, key)) {
            update[key] = data[key] as never;
        }
    }
    return update;
}

/** Update a draft voyage (planning status only) */
export async function updateVoyage(
    voyageId: string,
    data: VoyageUpdate,
): Promise<{ voyage: Voyage | null; error?: string }> {
    if (!supabase) return { voyage: null, error: 'Offline — no Supabase connection' };
    const identity = getAuthIdentityScope();

    const {
        data: { user },
        error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user || !identityStillOwns(identity, user.id)) {
        return { voyage: null, error: 'Sign in required' };
    }

    const update = snapshotVoyageUpdate(data);
    const { data: voyage, error } = await supabase
        .from('voyages')
        .update({
            ...update,
            updated_at: new Date().toISOString(),
        })
        .eq('id', voyageId)
        .eq('user_id', user.id)
        .eq('status', 'planning')
        .select()
        .maybeSingle();

    if (error) {
        console.error('[VoyageService] updateVoyage failed:', error.message);
        return { voyage: null, error: error.message };
    }
    if (
        !isOwnedVoyage(voyage, user.id, { id: voyageId, status: 'planning' }) ||
        !(await revalidateAuth(identity, user.id))
    ) {
        return { voyage: null, error: 'Account changed while updating the voyage' };
    }

    const updated = cloneVoyage(voyage);
    const drafts = readDraftVoyageCache(identity);
    writeDraftVoyageCache([updated, ...drafts.filter((draft) => draft.id !== updated.id)], identity);
    return { voyage: updated };
}

/**
 * Narrow writer for the Cast Off panel's ACTIVE-voyage card: ports and crew
 * only. updateVoyage is deliberately planning-gated, which made the active
 * card's editable From/To silently discard every edit (Shane 2026-08-26 —
 * the blur handler ignored the error and the UI kept the typed text). This
 * writer accepts planning AND active rows but nothing else, and only these
 * three columns — status, timing, routes and verification stay untouchable
 * from a live passage.
 */
export async function updateActiveVoyageDetails(
    voyageId: string,
    data: { departure_port?: string | null; destination_port?: string | null; crew_count?: number },
): Promise<{ voyage: Voyage | null; error?: string }> {
    if (!supabase) return { voyage: null, error: 'Offline — no Supabase connection' };
    const identity = getAuthIdentityScope();

    const {
        data: { user },
        error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user || !identityStillOwns(identity, user.id)) {
        return { voyage: null, error: 'Sign in required' };
    }

    const update: Record<string, string | number | null> = {};
    if ('departure_port' in data) update.departure_port = data.departure_port ?? null;
    if ('destination_port' in data) update.destination_port = data.destination_port ?? null;
    if (typeof data.crew_count === 'number' && Number.isFinite(data.crew_count)) {
        update.crew_count = Math.max(1, Math.min(99, Math.round(data.crew_count)));
    }
    if (Object.keys(update).length === 0) return { voyage: null, error: 'Nothing to update' };

    const { data: voyage, error } = await supabase
        .from('voyages')
        .update({ ...update, updated_at: new Date().toISOString() })
        .eq('id', voyageId)
        .eq('user_id', user.id)
        .in('status', ['planning', 'active'])
        .select()
        .maybeSingle();

    if (error) {
        console.error('[VoyageService] updateActiveVoyageDetails failed:', error.message);
        return { voyage: null, error: error.message };
    }
    if (!isOwnedVoyage(voyage, user.id, { id: voyageId }) || !(await revalidateAuth(identity, user.id))) {
        return { voyage: null, error: 'Account changed while updating the voyage' };
    }
    if (voyage.status !== 'planning' && voyage.status !== 'active') {
        return { voyage: null, error: 'This voyage is no longer editable' };
    }

    const updated = cloneVoyage(voyage);
    if (updated.status === 'active') cacheVoyage(updated, identity);
    const drafts = readDraftVoyageCache(identity);
    writeDraftVoyageCache([updated, ...drafts.filter((draft) => draft.id !== updated.id)], identity);
    return { voyage: updated };
}

/**
 * Adopt a canonical saved-route link onto a planning row that has NONE.
 *
 * Narrow on purpose: `.is('saved_route_id', null)` means this can only fill
 * a hole, never repoint a linked row at a different route. Idempotent from
 * the caller's side — selecting an already-linked passage simply matches
 * zero rows. Exists because voyages materialised from standalone logbook
 * stubs were created without the link (Shane 2026-08-26: geometry, route
 * check, follow and the public publish all silently lost the route on
 * every re-pick).
 */
export async function adoptSavedRouteLink(voyageId: string, savedRouteId: string): Promise<Voyage | null> {
    const exactVoyageId = voyageId.trim();
    const exactRouteId = savedRouteId.trim();
    if (!supabase || !exactVoyageId || !exactRouteId) return null;
    const identity = getAuthIdentityScope();
    if (!identity.userId || !(await revalidateAuth(identity, identity.userId))) return null;
    const ownerId = identity.userId;
    const { data, error } = await supabase
        .from('voyages')
        .update({ saved_route_id: exactRouteId, updated_at: new Date().toISOString() })
        .eq('id', exactVoyageId)
        .eq('user_id', ownerId)
        .eq('status', 'planning')
        .is('saved_route_id', null)
        .select()
        .maybeSingle();
    if (error || !isOwnedVoyage(data, ownerId, { id: exactVoyageId, status: 'planning' })) return null;
    if (!(await revalidateAuth(identity, ownerId))) return null;
    const updated = cloneVoyage(data);
    const drafts = readDraftVoyageCache(identity);
    writeDraftVoyageCache([updated, ...drafts.filter((draft) => draft.id !== updated.id)], identity);
    return updated;
}

/**
 * Refresh the machine verification on the exact planning row owned by a
 * canonical saved route. This is intentionally narrower than updateVoyage:
 * a stale/corrupt local graph link can never stamp proof onto another one of
 * the skipper's drafts merely because its UUID exists.
 */
export async function refreshSavedRouteVoyageVerification(
    voyageId: string,
    savedRouteId: string,
    notes: string,
    timing: { departure_time?: string | null; eta?: string | null } = {},
): Promise<{ voyage: Voyage | null; error?: string }> {
    const exactVoyageId = voyageId.trim();
    const exactRouteId = savedRouteId.trim();
    if (!supabase || !exactVoyageId || !exactRouteId || !notes) {
        return { voyage: null, error: 'Missing saved-route verification link' };
    }
    const identity = getAuthIdentityScope();
    if (!identity.userId || !(await revalidateAuth(identity, identity.userId))) {
        return { voyage: null, error: 'Sign in required' };
    }
    const ownerId = identity.userId;
    const { data, error } = await supabase
        .from('voyages')
        .update({
            notes,
            ...(timing.departure_time !== undefined ? { departure_time: timing.departure_time } : {}),
            ...(timing.eta !== undefined ? { eta: timing.eta } : {}),
            updated_at: new Date().toISOString(),
        })
        .eq('id', exactVoyageId)
        .eq('user_id', ownerId)
        .eq('status', 'planning')
        .eq('saved_route_id', exactRouteId)
        .select()
        .maybeSingle();
    if (error) return { voyage: null, error: error.message };
    if (
        !isOwnedVoyage(data, ownerId, { id: exactVoyageId, status: 'planning' }) ||
        data.saved_route_id !== exactRouteId ||
        !(await revalidateAuth(identity, ownerId))
    ) {
        return { voyage: null, error: 'Saved-route planning link could not be verified' };
    }
    const updated = cloneVoyage(data);
    const drafts = readDraftVoyageCache(identity);
    writeDraftVoyageCache([updated, ...drafts.filter((draft) => draft.id !== updated.id)], identity);
    return { voyage: updated };
}

async function activateVoyage(
    voyageId: string,
    identity: AuthIdentityScope = getAuthIdentityScope(),
): Promise<{ voyage: Voyage | null; error?: string; caution?: string }> {
    if (!supabase) {
        return { voyage: null, error: 'Offline — Cast Off requires a server connection' };
    }
    if (!identity.userId) {
        return { voyage: null, error: 'Sign in required to Cast Off' };
    }
    const ownerId = identity.userId;
    if (!(await revalidateAuth(identity, ownerId))) {
        return { voyage: null, error: 'Sign in required to Cast Off' };
    }

    // Preflight the exact planning row before the destructive RPC. Manual
    // voyages remain unchanged. A Route Tracer voyage (linked or carrying a
    // trace envelope) must prove the current saved geometry, vessel draft,
    // chart library and departure context. The SQL RPC repeats the durable
    // geometry/envelope checks under its row lock.
    const preflight = await supabase
        .from('voyages')
        .select('id, user_id, status, saved_route_id, notes, departure_time, manifest_locked_at')
        .eq('id', voyageId)
        .eq('user_id', ownerId)
        .maybeSingle();
    if (preflight.error || !preflight.data || !identityStillOwns(identity, ownerId)) {
        return { voyage: null, error: preflight.error?.message || 'Cast Off passage could not be verified' };
    }
    const candidate = preflight.data as Pick<
        Voyage,
        'id' | 'user_id' | 'status' | 'saved_route_id' | 'notes' | 'departure_time' | 'manifest_locked_at'
    >;
    // Response-loss retry: the server has already made this voyage active and
    // immutable, so do not retroactively strand its recovery on a newer local
    // chart/profile state.
    //
    // ADVISORY, NOT A GATE (Shane 2026-08-26: "allow it through first, then
    // we will put the gates on"). This preflight used to refuse Cast Off with
    // an error, and a DB trigger repeated the refusal under the row lock —
    // three weeks of unwinnable loops at the dock. The trigger is dropped
    // (migration 20260826130000) and every reason computed here now rides
    // along as `caution` for CastOffPanel to show on the active passage.
    let caution: string | undefined;
    if (candidate.status !== 'active') {
        const savedRouteId = typeof candidate.saved_route_id === 'string' ? candidate.saved_route_id.trim() : '';
        const carriesTraceEnvelope =
            typeof candidate.notes === 'string' && candidate.notes.startsWith(TRACE_VERIFICATION_NOTES_PREFIX);
        if (savedRouteId || carriesTraceEnvelope) {
            let points: Array<{ lat: number; lon: number }> | undefined;
            let routeCaution: string | undefined;
            if (savedRouteId) {
                const routeResult = await supabase
                    .from('saved_routes')
                    .select('id, user_id, points, deleted')
                    .eq('id', savedRouteId)
                    .eq('user_id', ownerId)
                    .maybeSingle();
                if (routeResult.error || !routeResult.data || routeResult.data.deleted === true) {
                    routeCaution = 'The traced route linked to this passage is missing or deleted.';
                } else {
                    const rawPoints = routeResult.data.points;
                    const parsed = Array.isArray(rawPoints)
                        ? rawPoints
                              .filter(
                                  (point): point is [number, number] =>
                                      Array.isArray(point) &&
                                      point.length >= 2 &&
                                      typeof point[0] === 'number' &&
                                      Number.isFinite(point[0]) &&
                                      typeof point[1] === 'number' &&
                                      Number.isFinite(point[1]),
                              )
                              .map(([lat, lon]) => ({ lat, lon }))
                        : [];
                    if (!Array.isArray(rawPoints) || parsed.length !== rawPoints.length || parsed.length < 2) {
                        routeCaution = 'The traced route has invalid waypoints, so its check could not be confirmed.';
                    } else {
                        points = parsed;
                    }
                }
            }
            const verification = parseTraceVerificationNote(candidate.notes, points);
            const [{ useSettingsStore }, units, encMetadata] = await Promise.all([
                import('../stores/settingsStore'),
                import('./units'),
                import('./enc/EncCellMetadata'),
            ]);
            if (!identityStillOwns(identity, ownerId)) {
                return { voyage: null, error: 'Account changed while checking Cast Off' };
            }
            const vessel = useSettingsStore.getState().settings.vessel;
            caution =
                routeCaution ??
                traceCastOffBlockReason(verification, points, {
                    draftM: units.vesselDraftMetres(vessel),
                    draftAssumed: units.vesselDraftIsAssumed(vessel),
                    encRegistryFingerprint: encMetadata.getRegistryFingerprint(traceRegistryScope(points)),
                    voyageDepartureMs: candidate.departure_time ? Date.parse(candidate.departure_time) : null,
                    nowMs: Date.now(),
                }) ??
                undefined;
        }
    }

    const { data, error } = await supabase.rpc('cast_off_voyage', {
        p_voyage_id: voyageId,
    });
    if (error) {
        console.error('[VoyageService] cast_off_voyage failed:', error.message);
        return { voyage: null, error: error.message };
    }
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        return { voyage: null, error: 'Cast Off returned an invalid voyage' };
    }
    if (
        !isOwnedVoyage(data, ownerId, { id: voyageId, status: 'active' }) ||
        !(await revalidateAuth(identity, ownerId))
    ) {
        return { voyage: null, error: 'Account changed while casting off' };
    }

    const voyage = cloneVoyage(data);
    cacheVoyage(voyage, identity);
    return { voyage, caution };
}

/**
 * Start a passage through the same atomic, owner-only transaction as Cast Off.
 * Repeating this call after a lost response returns the already-active voyage
 * without changing its departure time or immutable manifest snapshot.
 */
export async function startVoyage(voyageId: string): Promise<Voyage | null> {
    const identity = getAuthIdentityScope();
    const result = await activateVoyage(voyageId, identity);
    return result.voyage;
}

// Earlier iterations of this file had a getDraftVoyagesWithLogbookEntries()
// fetcher that tried to filter or auto-heal the voyages-table to mirror the
// logbook. That created drift in both directions and caused the picker to
// flicker between empty and stale data. CrewManagement now uses this compact
// table as its first-paint saved-route index, then reconciles legacy logbook
// geometry in the background. The table is therefore an operational index,
// not a replacement for the historic logbook.
//
// `getDraftVoyages()` (below) is still used by other consumers
// (GalleyCard, ChannelList, CastOffPanel) that want the raw drafts list.

/**
 * Delete draft (planning) voyages whose `voyage_name` matches `name`
 * AND whose `created_at` falls on `dayKey` (YYYY-MM-DD).
 *
 * Day-level matching is intentional: a planned_* shiplog voyage and
 * its auto-created voyages-table row are spawned in the same critical
 * section in PassagePlanSave, so their timestamps differ by ms. We
 * compare at day granularity so edge-of-second drift / time-zone
 * conversions don't miss the link.
 *
 * Used by EntryCrud.deleteVoyage when a planned_* voyageId is wiped
 * from the logbook — keeps the active-passage dropdown clean of
 * orphaned voyage rows. Returns the count of voyages deleted.
 */
export async function deleteDraftVoyagesByNameAndDay(name: string, dayKey: string): Promise<number> {
    const norm = name.trim().toLowerCase();
    const identity = getAuthIdentityScope();
    if (!norm || !identity.userId) return 0;

    // Offline path — local-storage cache.
    if (!supabase) {
        try {
            const drafts = readDraftVoyageCache(identity);
            const remaining = drafts.filter((v) => {
                const sameName = v.voyage_name.trim().toLowerCase() === norm;
                if (!sameName) return true; // keep
                const vDay = new Date(v.created_at).toISOString().slice(0, 10);
                return vDay !== dayKey; // keep if different day
            });
            const removed = drafts.length - remaining.length;
            if (removed > 0) writeDraftVoyageCache(remaining, identity);
            return removed;
        } catch {
            return 0;
        }
    }

    // Online path — Supabase. Fetch candidates first so we can apply the
    // case-insensitive trim + day filter in JS (Supabase has limited
    // built-in support for "trim then lowercase").
    const {
        data: { user },
        error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user || !identityStillOwns(identity, user.id)) return 0;

    const { data: candidates, error: fetchErr } = await supabase
        .from('voyages')
        .select('id, user_id, voyage_name, created_at, status')
        .eq('user_id', user.id)
        .eq('status', 'planning');
    if (fetchErr || !candidates) return 0;
    if (!identityStillOwns(identity, user.id)) return 0;

    const ids = candidates
        .filter((v) => {
            if (
                !v ||
                typeof v !== 'object' ||
                v.user_id !== user.id ||
                v.status !== 'planning' ||
                typeof v.id !== 'string' ||
                typeof v.voyage_name !== 'string' ||
                typeof v.created_at !== 'string' ||
                v.voyage_name.trim().toLowerCase() !== norm
            ) {
                return false;
            }
            const timestamp = new Date(v.created_at);
            return Number.isFinite(timestamp.getTime()) && timestamp.toISOString().slice(0, 10) === dayKey;
        })
        .map((v) => v.id as string);
    if (ids.length === 0) return 0;
    if (!(await revalidateAuth(identity, user.id))) return 0;

    const { data: deleted, error: delErr } = await supabase
        .from('voyages')
        .delete()
        .in('id', ids)
        .eq('user_id', user.id)
        .eq('status', 'planning')
        .select('id, user_id, status');
    if (delErr || !Array.isArray(deleted) || !(await revalidateAuth(identity, user.id))) return 0;
    const deletedIds = deleted
        .filter(
            (row) =>
                row &&
                typeof row.id === 'string' &&
                ids.includes(row.id) &&
                row.user_id === user.id &&
                row.status === 'planning',
        )
        .map((row) => row.id as string);
    if (deletedIds.length === 0) return 0;

    // Drop the local cache so getDraftVoyages doesn't return the deleted
    // rows on its next call.
    try {
        const drafts = readDraftVoyageCache(identity);
        if (drafts.length > 0) {
            const remaining = drafts.filter((v) => !deletedIds.includes(v.id));
            writeDraftVoyageCache(remaining, identity);
        }
    } catch {
        /* full / unavailable */
    }

    return deletedIds.length;
}

/**
 * Remove exactly one *planning* voyage. This is the safe graph-delete path
 * for a saved trace: a route may have been Cast Off after it was saved, and
 * deleting its chart copy must never erase that active operational record.
 */
export interface DeleteDraftVoyageOptions {
    /**
     * Permit an exact, pre-link passage row whose saved_route_id is still
     * null. This is deliberately opt-in: callers must already possess the
     * immutable voyage UUID from the same saved-route graph.
     */
    allowUnlinkedSavedRoute?: boolean;
}

export async function deleteDraftVoyageById(
    voyageId: string,
    expectedSavedRouteId?: string,
    options: DeleteDraftVoyageOptions = {},
): Promise<boolean> {
    const id = voyageId.trim();
    if (!id || !supabase) return false;
    const identity = getAuthIdentityScope();
    if (!identity.userId || !(await revalidateAuth(identity, identity.userId))) return false;
    const ownerId = identity.userId;
    const expectedRouteId = expectedSavedRouteId?.trim();

    // Normally the canonical saved-route id is both the ownership guard and
    // the graph link. Old clients, however, could create the passage row and
    // linked_plan_id before the saved_route_id backfill landed. In that very
    // specific case the caller has the immutable voyage UUID, so allow a
    // null link — never a link to a different canonical route.
    let useNullLinkGuard = false;
    if (expectedRouteId) {
        const { data: existing, error: existingError } = await supabase
            .from('voyages')
            .select('id, user_id, status, saved_route_id')
            .eq('id', id)
            .eq('user_id', ownerId)
            .eq('status', 'planning')
            .maybeSingle();
        if (existingError || !identityStillOwns(identity, ownerId)) return false;
        // Absence is the idempotent success case. Do not run a broad delete
        // after it: a newly-created row with the same UUID is not ours.
        if (existing === null) {
            removeCachedDraftVoyageById(id, identity, expectedRouteId, options);
            return true;
        }
        const existingRouteId =
            typeof (existing as { saved_route_id?: unknown }).saved_route_id === 'string'
                ? (existing as { saved_route_id: string }).saved_route_id || null
                : null;
        if (existingRouteId && existingRouteId !== expectedRouteId) return false;
        if (!existingRouteId && !options.allowUnlinkedSavedRoute) return false;
        useNullLinkGuard = !existingRouteId;
    }

    let request = supabase.from('voyages').delete().eq('id', id).eq('user_id', ownerId).eq('status', 'planning');
    if (expectedRouteId) {
        request = useNullLinkGuard ? request.is('saved_route_id', null) : request.eq('saved_route_id', expectedRouteId);
    }
    const { data, error } = await request.select('id, user_id, status').maybeSingle();
    if (error || !identityStillOwns(identity, ownerId)) return false;
    if (data !== null && (!data || data.id !== id || data.user_id !== ownerId || data.status !== 'planning')) {
        return false;
    }
    removeCachedDraftVoyageById(id, identity, expectedRouteId, options);
    return true;
}

/** Get all draft (planning) voyages for the current user */
export async function getDraftVoyages(): Promise<Voyage[]> {
    const identity = getAuthIdentityScope();
    if (!supabase) {
        return readDraftVoyageCache(identity);
    }

    const {
        data: { user },
        error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user || !identityStillOwns(identity, user.id)) return [];

    const { data, error } = await supabase
        .from('voyages')
        .select('*')
        .eq('user_id', user.id)
        .eq('status', 'planning')
        .order('created_at', { ascending: false });

    if (error || !identityStillOwns(identity, user.id) || !Array.isArray(data)) return [];
    const drafts = data
        .filter((voyage): voyage is Voyage => isOwnedVoyage(voyage, user.id, { status: 'planning' }))
        .map(cloneVoyage);
    try {
        writeDraftVoyageCache(drafts, identity);
    } catch {
        /* full */
    }
    return drafts;
}

/**
 * Cast Off — Manual activation of a draft voyage.
 *
 * The server atomically enforces one active voyage and snapshots the accepted
 * manifest. Live vessel_crew memberships remain editable after departure; the
 * snapshot is the historical record of who was aboard at Cast Off.
 *
 * GPS logging is deliberately owned by CastOffPanel + ShipLogService, which
 * can report tracking failures to the skipper and attach a real position.
 */
export async function castOff(
    voyageId: string,
): Promise<{ ok: boolean; voyage?: Voyage; error?: string; caution?: string }> {
    const identity = getAuthIdentityScope();
    const { voyage, error, caution } = await activateVoyage(voyageId, identity);
    if (!voyage) {
        return { ok: false, error: error || 'Failed to activate voyage' };
    }
    if (!identity.userId || !isOwnedVoyage(voyage, identity.userId, { id: voyageId, status: 'active' })) {
        return { ok: false, error: 'Cast Off returned an unauthorized voyage' };
    }

    // A response-loss retry must not turn the initial leg into "Leg 2".
    const activeLeg = getActiveLeg(voyageId);
    if (!activeLeg && identityStillOwns(identity, voyage.user_id)) {
        // Seed the first in-voyage leg's planned destination from the trip's
        // saved legs so "Arrive at Port" opens pre-filled (Shane-approved
        // design 2026-08-04). The trip ordinal is the ROUTE'S OWN position,
        // not a literal 1 — casting off a leg-2 voyage used to fetch leg 1's
        // destination (Shane 2026-08-27). Lazy import: routeTracer must not
        // join this module's cold-start path.
        let plannedDestination: string | null = null;
        try {
            const { tripLegPlannedDestination, tripLegAnchorOrdinal } = await import('./routeTracer');
            plannedDestination = tripLegPlannedDestination(
                voyage.saved_route_id,
                tripLegAnchorOrdinal(voyage.saved_route_id),
            );
        } catch {
            /* best effort — a blank arrival box is the pre-existing behaviour */
        }
        startLeg(voyageId, voyage.departure_port || 'Unknown Port', plannedDestination);
    }

    return { ok: true, voyage, caution };
}

/** End a passage — closes active leg and archives the voyage */
export async function endVoyage(voyageId: string, status: 'completed' | 'aborted' = 'completed'): Promise<boolean> {
    // The voyage is over, so its pre-watch alarms are too. This is the RIGHT
    // owner for that: WatchScheduleCard used to cancel them when its screen
    // unmounted, which made a crew member's 0345 alarm depend on where they
    // last navigated. Fire-and-forget — a failed cancel must never stop a
    // voyage being ended, and the alarms are bounded by the passage anyway.
    void (async () => {
        try {
            const { WatchAlarmService } = await import('./WatchAlarmService');
            await WatchAlarmService.cancelForVoyage(voyageId);
        } catch {
            /* non-critical */
        }
    })();
    const identity = getAuthIdentityScope();
    if (!identity.userId) return false;
    if (!supabase) return false;
    const ownerId = identity.userId;
    if (!(await revalidateAuth(identity, ownerId))) return false;

    // Stop the trip log BEFORE the row is marked done. `stopTracking` had
    // exactly one call site in the whole tree — the Log page's stop button —
    // so ending a passage from the Vessel hub's "End Voyage & Archive" left
    // GPS running and the log still appending to a voyage that was over.
    //
    // Ordered ahead of the status update deliberately: stopTracking performs
    // a final buffer flush and captures the 'Voyage End' entry against this
    // voyage id, and that work belongs to a passage that is still open.
    try {
        const { ShipLogService } = await import('./ShipLogService');
        try {
            // Always cross the exact-voyage boundary. Cast Off can have activated
            // the remote row while its local GPS start is still pending (including
            // across a panel close/reopen), before getTrackingStatus() exposes an
            // owner. This joins that matching start, then verifies/cleans its lease
            // before the active row can be archived.
            await ShipLogService.stopTracking(voyageId);
        } catch (error) {
            // Name-based (not instanceof): test harnesses mock the ShipLog
            // module, and a second module instance must not defeat the match.
            if (error instanceof Error && error.name === 'DifferentVoyageTrackingError') {
                // The tracker belongs to ANOTHER voyage, so THIS one has no
                // GPS to tear down — archiving it is safe and is the only
                // exit from the zombie-active trap (Shane 2026-08-26: a
                // 26-July row blocked every Cast Off for a month because
                // this mismatch used to abort End Voyage).
                console.warn('[VoyageService] endVoyage: no tracking held by this voyage — archiving anyway:', error);
            } else {
                throw error;
            }
        }
    } catch (error) {
        // The shared GPS manager retains ownership when native teardown is not
        // verified. Archiving now would claim the passage ended while iOS is
        // still tracking it, so keep the row active and let the same action
        // retry ShipLogService's pending stop.
        console.warn('[VoyageService] endVoyage blocked by trip-log teardown:', error);
        return false;
    }
    if (!identityStillOwns(identity, ownerId)) return false;

    const { data, error } = await supabase
        .from('voyages')
        .update({ status })
        .eq('id', voyageId)
        .eq('user_id', ownerId)
        .eq('status', 'active')
        .select()
        .maybeSingle();

    if (
        error ||
        !isOwnedVoyage(data, ownerId, { id: voyageId, status }) ||
        !(await revalidateAuth(identity, ownerId))
    ) {
        return false;
    }
    if (!identityStillOwns(identity, ownerId)) return false;

    const cached = getCachedActiveVoyage();
    if (status === 'aborted') {
        deleteLegsForVoyage(voyageId);
    } else if (getActiveLeg(voyageId) && identityStillOwns(identity, ownerId)) {
        closeLeg(voyageId, data.destination_port || cached?.destination_port || 'Destination');
    }
    if (
        cached &&
        isOwnedVoyage(cached, ownerId, { id: voyageId, status: 'active' }) &&
        identityStillOwns(identity, ownerId)
    ) {
        cacheVoyage(null, identity);
    }

    // A passage can end from two doors: the Log page's stop (which runs
    // ShipLogService.stopTracking and tears following down there) and this
    // one, from the Vessel hub's End Voyage. Following is scoped to the
    // voyage, so it has to end at BOTH — otherwise ending a passage here
    // left the app still following a route for a voyage that was over.
    // Dynamic import keeps followRouteStore out of this module's graph.
    try {
        const { useFollowRouteStore } = await import('../stores/followRouteStore');
        const following = useFollowRouteStore.getState();
        // Scoped: never tear down following that belongs to a different
        // voyage than the one just ended.
        if (following.isFollowing && (!following.voyageId || following.voyageId === voyageId)) {
            following.stopFollowing();
        }
    } catch {
        // Following is local state; failing to clear it must never make an
        // otherwise-successful voyage end report failure.
    }

    return identityStillOwns(identity, ownerId);
}

/**
 * Hard-delete a voyage row by ID, regardless of status. Used by the
 * "Manage saved trips" cleanup sheet so the user can purge orphan or
 * test voyages that don't show up in the normal drafts/active flows.
 *
 * Also clears the cached active voyage if it matches the deleted ID
 * so the hero band / SystemStatusButton drop out of Active Voyage Mode
 * in the same tick.
 *
 * Does NOT cascade to shiplog entries — call ShipLogService.deleteVoyage
 * separately if you also need to remove a planned route's entries.
 * Returns true if a row was removed (or nothing to remove was found
 * locally either).
 */
export async function deleteVoyageById(voyageId: string): Promise<boolean> {
    if (!supabase) return false;
    const identity = getAuthIdentityScope();
    if (!identity.userId) return false;
    const ownerId = identity.userId;
    if (!(await revalidateAuth(identity, ownerId))) return false;

    const cached = getCachedActiveVoyage();
    const ownedCached = cached && isOwnedVoyage(cached, ownerId, { id: voyageId, status: 'active' }) ? cached : null;
    const drafts = readDraftVoyageCache(identity);
    const hadOwnedDraft = drafts.some((voyage) => voyage.id === voyageId);
    let deletedOwnedRow = false;

    try {
        const { data, error } = await supabase
            .from('voyages')
            .delete()
            .eq('id', voyageId)
            .eq('user_id', ownerId)
            .select('id, user_id')
            .maybeSingle();
        if (error) {
            console.warn('[VoyageService] deleteVoyageById failed:', error.message);
            return false;
        }
        if (
            (data !== null &&
                (!data || typeof data.id !== 'string' || data.id !== voyageId || data.user_id !== ownerId)) ||
            !(await revalidateAuth(identity, ownerId))
        ) {
            return false;
        }
        deletedOwnedRow = data !== null;
    } catch (e) {
        console.warn('[VoyageService] deleteVoyageById threw:', e);
        return false;
    }
    if (!identityStillOwns(identity, ownerId)) return false;

    if (deletedOwnedRow || ownedCached || hadOwnedDraft) {
        deleteLegsForVoyage(voyageId);
    }
    if (ownedCached) cacheVoyage(null, identity);

    // Drop the local drafts cache so getDraftVoyages() doesn't keep
    // resurrecting the deleted row from localStorage.
    try {
        if (drafts.length > 0) {
            const remaining = drafts.filter((v) => v.id !== voyageId);
            writeDraftVoyageCache(remaining, identity);
        }
    } catch {
        /* ignore */
    }

    return true;
}

/** List ALL voyages for the current user — any status. Used by the
 *  cleanup sheet to show even completed/aborted/orphan rows that the
 *  draft-only `getDraftVoyages()` filter would hide. */
export async function getAllVoyagesForUser(): Promise<Voyage[]> {
    if (!supabase) return [];
    const identity = getAuthIdentityScope();
    const {
        data: { user },
        error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user || !identityStillOwns(identity, user.id)) return [];
    const { data, error } = await supabase
        .from('voyages')
        .select('*')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
    if (error || !identityStillOwns(identity, user.id)) {
        if (error) console.warn('[VoyageService] getAllVoyagesForUser failed:', error.message);
        return [];
    }
    if (!Array.isArray(data)) return [];
    return data.filter((voyage): voyage is Voyage => isOwnedVoyage(voyage, user.id)).map(cloneVoyage);
}

/**
 * Cascade-end the cached active voyage if its name matches the given
 * normalised label. Called by EntryCrud.deleteVoyage when a saved
 * planned route is deleted from the logbook so Active Voyage Mode
 * doesn't get stuck when the underlying suggested track is gone.
 *
 * Match strategy: case-insensitive trimmed equality on voyage_name.
 * This is the same scheme PassagePlanSave uses to wire saved routes
 * to voyage records, so the inverse side correctly identifies the
 * voyage to end.
 *
 * Returns true if a matching active voyage was found AND ended.
 * Always clears the cached active-voyage state and dispatches the
 * `thalassa:active-voyage-changed` event so any UI listening
 * (SystemStatusButton, MapHub Active Voyage Mode auto-display, the
 * Cast Off pill on VesselHub) drops out of active-voyage state in
 * the same tick.
 */
export async function endActiveVoyageIfNameMatches(label: string): Promise<boolean> {
    const norm = label.trim().toLowerCase();
    if (!norm) return false;
    const identity = getAuthIdentityScope();
    if (!identity.userId) return false;
    const ownerId = identity.userId;

    const cached = getCachedActiveVoyage();
    if (!cached || !isOwnedVoyage(cached, ownerId, { status: 'active' })) return false;
    if (cached.voyage_name.trim().toLowerCase() !== norm) return false;

    // Online path — flip the DB status to 'aborted' so any other
    // client (web tab, second device) sees the voyage end too. Use
    // 'aborted' rather than 'completed' since the user deleted the
    // underlying route — they're not signalling a successful arrival.
    if (supabase) {
        try {
            const ok = await endVoyage(cached.id, 'aborted');
            if (ok) return true;
            // A failed native GPS release is represented as a paused,
            // retryable ShipLog stop. Never fall through to local-only
            // teardown in that state: clearing the voyage cache would claim
            // the passage had ended while iOS still owns background GPS.
            // The same guard covers an earlier stop failure that left the
            // service truthfully tracking. A later press retries endVoyage.
            const { ShipLogService } = await import('./ShipLogService');
            const trackingStatus = ShipLogService.getTrackingStatus();
            if (
                (trackingStatus.isTracking || trackingStatus.isPaused) &&
                ShipLogService.getCurrentVoyageId() === cached.id
            ) {
                return false;
            }
            // endVoyage returned false — fall through to local-only
            // teardown so the user still escapes Active Voyage Mode
            // even if the DB write failed.
        } catch (error) {
            // If the tracking boundary itself cannot be loaded or queried,
            // fail closed. An ordinary remote DB failure is handled by the
            // explicit inactive-state path above.
            console.warn('[VoyageService] active-voyage teardown could not verify GPS ownership:', error);
            return false;
        }
    }

    if (!identityStillOwns(identity, ownerId)) return false;

    // Offline / DB-write-failed path — the user pressed delete and
    // expects the active mode to clear immediately. Mirror what
    // endVoyage does locally: drop the cache + delete the legs so
    // the picker / hero card / system status button all reset.
    deleteLegsForVoyage(cached.id);
    cacheVoyage(null, identity);
    return true;
}

async function loadVerifiedActiveVoyage(
    identity: AuthIdentityScope,
    authUserId: string,
): Promise<{ verified: boolean; voyage: Voyage | null }> {
    if (!supabase || !identityStillOwns(identity, authUserId)) return { verified: false, voyage: null };
    // Check as owner first
    const { data: ownedData, error: ownerError } = await supabase
        .from('voyages')
        .select('*')
        .eq('user_id', authUserId)
        .eq('status', 'active')
        .limit(1)
        .maybeSingle();
    if (ownerError || !identityStillOwns(identity, authUserId)) return { verified: false, voyage: null };

    let voyage: Voyage | null = null;
    if (ownedData) {
        if (!isOwnedVoyage(ownedData, authUserId, { status: 'active' })) {
            return { verified: false, voyage: null };
        }
        voyage = cloneVoyage(ownedData);
    } else {
        // Crew-visible active voyages are still supported, but the returned
        // owner must match an accepted, passage-authorized membership.
        const { data: crewData, error: crewError } = await supabase
            .from('voyages')
            .select('*')
            .eq('status', 'active')
            .limit(1)
            .maybeSingle();
        if (crewError || !identityStillOwns(identity, authUserId)) return { verified: false, voyage: null };
        if (crewData) {
            voyage = await validateVisibleVoyage(crewData, identity, authUserId, { status: 'active' });
            if (!voyage) return { verified: false, voyage: null };
        }
    }

    if (!(await revalidateAuth(identity, authUserId))) return { verified: false, voyage: null };
    cacheVoyage(voyage, identity);
    return { verified: true, voyage };
}

/** Get the currently active voyage */
export async function getActiveVoyage(): Promise<Voyage | null> {
    const identity = getAuthIdentityScope();
    if (!supabase) return isAuthIdentityScopeCurrent(identity) ? getCachedActiveVoyage() : null;

    const {
        data: { user },
        error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user || !identityStillOwns(identity, user.id)) return null;

    return (await loadVerifiedActiveVoyage(identity, user.id)).voyage;
}

/** Fetch one exact RLS-visible voyage without changing the active-voyage cache. */
export async function getVoyageById(voyageId: string): Promise<Voyage | null> {
    if (!voyageId) return null;
    const identity = getAuthIdentityScope();

    if (!supabase) {
        if (!isAuthIdentityScopeCurrent(identity)) return null;
        const cached = getCachedActiveVoyage();
        if (cached?.id === voyageId) return cached;
        return readDraftVoyageCache(identity).find((voyage) => voyage.id === voyageId) ?? null;
    }

    const {
        data: { user },
        error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user || !identityStillOwns(identity, user.id)) return null;
    const { data, error } = await supabase.from('voyages').select('*').eq('id', voyageId).maybeSingle();
    if (error || !data || !identityStillOwns(identity, user.id)) return null;
    const voyage = await validateVisibleVoyage(data, identity, user.id, { id: voyageId });
    if (!voyage || !(await revalidateAuth(identity, user.id))) return null;
    return voyage;
}

/** Set the weather master for a voyage (Iridium lock) */
export async function setWeatherMaster(voyageId: string, userId: string): Promise<boolean> {
    if (!supabase) return false;
    const identity = getAuthIdentityScope();
    if (!identity.userId) return false;
    const ownerId = identity.userId;
    if (!(await revalidateAuth(identity, ownerId))) return false;

    const { data: voyage, error: voyageError } = await supabase
        .from('voyages')
        .select('*')
        .eq('id', voyageId)
        .eq('user_id', ownerId)
        .maybeSingle();
    if (voyageError || !isOwnedVoyage(voyage, ownerId, { id: voyageId })) return false;

    if (userId !== ownerId) {
        const { data: memberships, error: membershipError } = await supabase
            .from('vessel_crew')
            .select('owner_id, crew_user_id, status, voyage_id, permissions')
            .eq('owner_id', ownerId)
            .eq('crew_user_id', userId)
            .eq('status', 'accepted');
        if (
            membershipError ||
            !Array.isArray(memberships) ||
            !memberships.some(
                (membership) =>
                    membership.owner_id === ownerId &&
                    membership.crew_user_id === userId &&
                    membership.status === 'accepted' &&
                    membership.permissions?.can_view_passage === true &&
                    (membership.voyage_id === null || membership.voyage_id === voyageId),
            )
        ) {
            return false;
        }
    }
    if (!(await revalidateAuth(identity, ownerId))) return false;

    const { data: updated, error } = await supabase
        .from('voyages')
        .update({ weather_master_id: userId })
        .eq('id', voyageId)
        .eq('user_id', ownerId)
        .select()
        .maybeSingle();

    return (
        !error &&
        isOwnedVoyage(updated, ownerId, { id: voyageId }) &&
        updated.weather_master_id === userId &&
        (await revalidateAuth(identity, ownerId))
    );
}

/** Check if current user is the weather master */
export async function isWeatherMaster(): Promise<boolean> {
    const identity = getAuthIdentityScope();
    if (!supabase) {
        const cached = getCachedActiveVoyage();
        if (!cached) return true; // No voyage = unrestricted
        const userId = identity.userId;
        return cached.weather_master_id === userId || cached.user_id === userId;
    }

    const {
        data: { user },
        error: authError,
    } = await supabase.auth.getUser();
    if (authError || !user || !identityStillOwns(identity, user.id)) return false;

    const active = await loadVerifiedActiveVoyage(identity, user.id);
    if (!active.verified || !identityStillOwns(identity, user.id)) return false;
    if (!active.voyage) return true; // Verified no active voyage — unrestricted

    return active.voyage.weather_master_id === user.id || active.voyage.user_id === user.id;
}
