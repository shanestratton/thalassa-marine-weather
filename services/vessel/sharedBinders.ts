/**
 * sharedBinders — whose Boat Binder a sailor is looking at.
 *
 * Shane 2026-10-02: "the shared binders are not shared, so the invitee, still
 * has his own binders. they should really be replaced with the inviters
 * binders that are shared with the invitee". So while a sailor is accepted
 * crew on a skipper's boat, each binder register that skipper shares (Ship's
 * Stores, Equipment, R&M, Documents) shows the SKIPPER'S rows, never a mix.
 *
 * The truth is a server snapshot of the sailor's ACCEPTED vessel_crew rows,
 * read once per sync cycle, that mirrors public.can_access_vessel_register
 * (20260723100000) exactly:
 *   - stores: read = can_view_stores OR can_edit_stores, write = can_edit_stores
 *     (the JSONB flags; shared_registers is NOT consulted);
 *   - equipment / maintenance / documents: read = write = register in
 *     shared_registers (the database has no view-only form of these);
 *   - voyage_id is ignored, as the database ignores it, and several rows for
 *     the same skipper are unioned.
 * So a binder never claims a share the server refuses, or hides one it grants.
 *
 * The local mirror (LocalDatabase) keeps every RLS-visible row: the sailor's
 * own plus every sharing skipper's. The Local*Service read paths filter
 * through isRowInBinder, so the sailor's own rows stay on the device, hidden,
 * and come back by themselves when the share ends.
 *
 * Deliberately free of SyncService (SyncService imports this module), and
 * supabase/LocalDatabase are loaded lazily inside the refresh so the local
 * services that import this stay as light as they were.
 */
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../authIdentityScope';
import { createLogger } from '../../utils/createLogger';

const log = createLogger('SharedBinders');

// ── Types ──────────────────────────────────────────────────────

export type BinderRegister = 'stores' | 'equipment' | 'maintenance' | 'documents';

export const BINDER_REGISTERS: readonly BinderRegister[] = ['stores', 'equipment', 'maintenance', 'documents'];

/** Every synced binder table and the register whose share governs it. */
export const TABLE_REGISTER: Readonly<Record<string, BinderRegister>> = Object.freeze({
    inventory_items: 'stores',
    equipment_register: 'equipment',
    maintenance_tasks: 'maintenance',
    maintenance_history: 'maintenance',
    // The skipper's engine-hours reading travels with his R&M.
    vessel_engine_hours: 'maintenance',
    ship_documents: 'documents',
});

export interface BinderAccess {
    read: boolean;
    write: boolean;
}

export type BinderRegisterAccess = Record<BinderRegister, BinderAccess>;

export interface SharedBinderSkipper {
    ownerId: string;
    /** vessel_identity.vessel_name (crew may read it); null when unknown. */
    vesselName: string | null;
    /**
     * Newest created_at (else updated_at) of the skipper's accepted rows: when
     * the newest membership began. Roster edits do not move it.
     */
    lastAcceptedAt: string;
    registers: BinderRegisterAccess;
}

export interface SharedBinderSnapshot {
    version: 1;
    userId: string;
    /** Last time the server confirmed this snapshot; null = never. */
    confirmedAt: string | null;
    skippers: SharedBinderSkipper[];
}

/** The subset of a vessel_crew row this module reads. */
export interface BinderMembershipRow {
    owner_id?: unknown;
    crew_user_id?: unknown;
    status?: unknown;
    shared_registers?: unknown;
    permissions?: unknown;
    updated_at?: unknown;
    created_at?: unknown;
}

export type BinderSource =
    | { mode: 'own' }
    | {
          mode: 'shared';
          ownerId: string;
          vesselName: string | null;
          canWrite: boolean;
          canDelete: false;
          /** Skippers sharing THIS register with the sailor. */
          skipperCount: number;
      };

export interface SharedBindersState {
    readonly scopeKey: string;
    readonly generation: number;
    readonly snapshot: SharedBinderSnapshot | null;
    readonly selection: string | null;
    /** Bumped on every change a viewer could see. */
    readonly version: number;
}

/** A write or delete the sailor's share does not allow. Nothing was queued. */
export class SharedBinderReadOnlyError extends Error {
    readonly register: BinderRegister;
    constructor(register: BinderRegister, message: string) {
        super(message);
        this.name = 'SharedBinderReadOnlyError';
        this.register = register;
    }
}

const OWN_SOURCE: BinderSource = Object.freeze({ mode: 'own' as const });
const SNAPSHOT_KEY = 'thalassa_shared_binders_v1';
const SELECTION_KEY = 'thalassa_shared_binder_skipper_v1';

// ── Pure derivation (mirrors can_access_vessel_register) ───────

/** PostgreSQL's text→boolean cast, as `(permissions->>'flag')::boolean` reads it. */
function flag(permissions: unknown, name: string): boolean {
    if (!permissions || typeof permissions !== 'object') return false;
    const value = (permissions as Record<string, unknown>)[name];
    if (value === true) return true;
    if (typeof value === 'number') return value !== 0;
    if (typeof value !== 'string') return false;
    return ['t', 'true', 'y', 'yes', 'on', '1'].includes(value.trim().toLowerCase());
}

function registerList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === 'string') : [];
}

function emptyAccess(): BinderRegisterAccess {
    return {
        stores: { read: false, write: false },
        equipment: { read: false, write: false },
        maintenance: { read: false, write: false },
        documents: { read: false, write: false },
    };
}

/**
 * When the membership began: created_at, else updated_at. Not updated_at
 * first: every roster edit bumps it (updateCrewPermissions), and a sailor
 * crewing for two skippers would see the default binder change boats each
 * time either skipper ticked a box.
 */
function rowTime(row: BinderMembershipRow): string {
    for (const value of [row.created_at, row.updated_at]) {
        if (typeof value === 'string' && Number.isFinite(Date.parse(value))) return new Date(value).toISOString();
    }
    return new Date(0).toISOString();
}

/**
 * Per skipper, what each binder register grants, exactly as the database's
 * can_access_vessel_register decides it. Only accepted rows count; a skipper
 * who grants nothing on any binder register is left out.
 */
export function deriveBinderAccess(
    memberships: readonly BinderMembershipRow[],
    selfId?: string | null,
): Omit<SharedBinderSkipper, 'vesselName'>[] {
    const byOwner = new Map<string, Omit<SharedBinderSkipper, 'vesselName'>>();
    for (const row of memberships) {
        if (!row || row.status !== 'accepted') continue;
        if (typeof row.owner_id !== 'string' || !row.owner_id.trim()) continue;
        const ownerId = row.owner_id.trim();
        // can_access_vessel_register: p_owner_id = auth.uid() is the owner's
        // own binder, never a share.
        if (selfId && ownerId === selfId) continue;
        if (selfId && typeof row.crew_user_id === 'string' && row.crew_user_id !== selfId) continue;

        const entry = byOwner.get(ownerId) ?? { ownerId, lastAcceptedAt: rowTime(row), registers: emptyAccess() };
        const shared = registerList(row.shared_registers);
        const canEditStores = flag(row.permissions, 'can_edit_stores');
        const canViewStores = flag(row.permissions, 'can_view_stores') || canEditStores;
        entry.registers.stores.read ||= canViewStores;
        entry.registers.stores.write ||= canEditStores;
        for (const register of ['equipment', 'maintenance', 'documents'] as const) {
            if (shared.includes(register)) {
                entry.registers[register].read = true;
                entry.registers[register].write = true;
            }
        }
        const time = rowTime(row);
        if (time > entry.lastAcceptedAt) entry.lastAcceptedAt = time;
        byOwner.set(ownerId, entry);
    }
    return [...byOwner.values()].filter((entry) => BINDER_REGISTERS.some((r) => entry.registers[r].read));
}

/** Newest membership first; ties broken by owner id so every device agrees. */
function byDefaultOrder(a: SharedBinderSkipper, b: SharedBinderSkipper): number {
    if (a.lastAcceptedAt !== b.lastAcceptedAt) return a.lastAcceptedAt > b.lastAcceptedAt ? -1 : 1;
    return a.ownerId < b.ownerId ? -1 : a.ownerId > b.ownerId ? 1 : 0;
}

/**
 * The skipper whose binder this register shows: the selected skipper when
 * they share it, else the newest membership that shares it, else nobody (the
 * sailor's own binder).
 *
 * DECIDED (2026-10-02): the fallback to another sharing skipper, rather than
 * the sailor's own binder, is because crew_rewrite_user_id moves any crew
 * INSERT carrying the crew's own id into the one skipper who grants write on
 * that register. Showing the own binder there would hide where adds land.
 */
function effectiveSkipper(
    snapshot: SharedBinderSnapshot,
    selection: string | null,
    register: BinderRegister,
): SharedBinderSkipper | null {
    const candidates = snapshot.skippers.filter((skipper) => skipper.registers[register].read).sort(byDefaultOrder);
    if (candidates.length === 0) return null;
    return candidates.find((skipper) => skipper.ownerId === selection) ?? candidates[0];
}

/** What changes which rows a binder shows or which writes it allows. */
function accessSignature(snapshot: SharedBinderSnapshot | null, selection: string | null): string {
    // No snapshot yet reads as "no shares", so a first confirmation that
    // finds none is not a change (and forces no full reconciliation).
    if (!snapshot) return accessSignature({ version: 1, userId: '', confirmedAt: null, skippers: [] }, selection);
    const owners = [...snapshot.skippers]
        .sort((a, b) => (a.ownerId < b.ownerId ? -1 : 1))
        .map(
            (skipper) =>
                `${skipper.ownerId}:${BINDER_REGISTERS.map(
                    (register) =>
                        `${register}=${skipper.registers[register].read ? 'r' : '-'}${skipper.registers[register].write ? 'w' : '-'}`,
                ).join(',')}`,
        );
    const effective = BINDER_REGISTERS.map(
        (register) => `${register}>${effectiveSkipper(snapshot, selection, register)?.ownerId ?? 'own'}`,
    );
    return `${owners.join('|')}#${effective.join(',')}`;
}

// ── Persistence (per account, swept by account deletion) ──────

function readStorage(key: string): string | null {
    try {
        if (typeof localStorage === 'undefined') return null;
        return localStorage.getItem(key);
    } catch {
        return null;
    }
}

function writeStorage(key: string, value: string | null): void {
    try {
        if (typeof localStorage === 'undefined') return;
        if (value === null) localStorage.removeItem(key);
        else localStorage.setItem(key, value);
    } catch {
        /* storage unavailable: the in-memory state still serves this session */
    }
}

function parseSnapshot(raw: string | null, userId: string | null): SharedBinderSnapshot | null {
    if (!raw || !userId) return null;
    try {
        const value = JSON.parse(raw) as Partial<SharedBinderSnapshot>;
        if (value?.version !== 1 || value.userId !== userId || !Array.isArray(value.skippers)) return null;
        const skippers: SharedBinderSkipper[] = [];
        for (const skipper of value.skippers) {
            if (!skipper || typeof skipper.ownerId !== 'string' || !skipper.ownerId) continue;
            const registers = emptyAccess();
            for (const register of BINDER_REGISTERS) {
                const access = skipper.registers?.[register];
                registers[register] = { read: access?.read === true, write: access?.write === true };
            }
            skippers.push({
                ownerId: skipper.ownerId,
                vesselName: typeof skipper.vesselName === 'string' && skipper.vesselName ? skipper.vesselName : null,
                lastAcceptedAt: typeof skipper.lastAcceptedAt === 'string' ? skipper.lastAcceptedAt : '',
                registers,
            });
        }
        return {
            version: 1,
            userId,
            confirmedAt: typeof value.confirmedAt === 'string' ? value.confirmedAt : null,
            skippers,
        };
    } catch {
        return null;
    }
}

// ── Module state ───────────────────────────────────────────────

let state: SharedBindersState = Object.freeze({
    scopeKey: '',
    generation: -1,
    snapshot: null,
    selection: null,
    version: 0,
});
const listeners = new Set<() => void>();

function loadForScope(scope: AuthIdentityScope): SharedBindersState {
    const snapshot = parseSnapshot(readStorage(authScopedStorageKey(SNAPSHOT_KEY, scope)), scope.userId);
    const selectionRaw = scope.userId ? readStorage(authScopedStorageKey(SELECTION_KEY, scope)) : null;
    return Object.freeze({
        scopeKey: scope.key,
        generation: scope.generation,
        snapshot,
        selection: selectionRaw && selectionRaw.trim() ? selectionRaw.trim() : null,
        version: state.version + 1,
    });
}

function current(): SharedBindersState {
    const scope = getAuthIdentityScope();
    if (state.scopeKey !== scope.key || state.generation !== scope.generation) state = loadForScope(scope);
    return state;
}

function notify(): void {
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch (error) {
            log.warn('Shared binder listener failed:', error);
        }
    }
}

// An account switch must never show the previous account's snapshot.
subscribeAuthIdentityScope((next) => {
    state = loadForScope(next);
    notify();
});

/** Re-read the current account's snapshot and selection from storage. */
export function reloadSharedBindersFromStorage(): void {
    state = loadForScope(getAuthIdentityScope());
    notify();
}

/** Immutable state for useSyncExternalStore; a new object on every change. */
export function getSharedBindersState(): SharedBindersState {
    return current();
}

export function subscribeSharedBinders(listener: () => void): () => void {
    listeners.add(listener);
    return () => {
        listeners.delete(listener);
    };
}

// ── Read API ───────────────────────────────────────────────────

function currentSnapshot(): SharedBinderSnapshot | null {
    const scope = getAuthIdentityScope();
    const { snapshot } = current();
    return scope.userId && snapshot?.userId === scope.userId ? snapshot : null;
}

/** Whose binder this register shows right now. */
export function getBinderSource(register: BinderRegister): BinderSource {
    const snapshot = currentSnapshot();
    if (!snapshot) return OWN_SOURCE;
    const skipper = effectiveSkipper(snapshot, current().selection, register);
    if (!skipper) return OWN_SOURCE;
    return {
        mode: 'shared',
        ownerId: skipper.ownerId,
        vesselName: skipper.vesselName,
        canWrite: skipper.registers[register].write,
        canDelete: false,
        skipperCount: snapshot.skippers.filter((candidate) => candidate.registers[register].read).length,
    };
}

function selfId(): string | null {
    return getAuthIdentityScope().userId;
}

function rowOwner(row: unknown): string {
    const value = row && typeof row === 'object' ? (row as { user_id?: unknown }).user_id : undefined;
    return typeof value === 'string' ? value.trim() : '';
}

/** The sailor's own row: theirs, or not yet stamped. Anonymous: every row. */
export function isOwnBinderRow(row: unknown): boolean {
    const self = selfId();
    if (!self) return true;
    const owner = rowOwner(row);
    return !owner || owner === self;
}

/** One predicate for a whole list read: the source is resolved once. */
export function binderRowFilter(register: BinderRegister): (row: unknown) => boolean {
    const source = getBinderSource(register);
    if (source.mode === 'shared') return (row) => rowOwner(row) === source.ownerId;
    return isOwnBinderRow;
}

export function isRowInBinder(register: BinderRegister, row: unknown): boolean {
    return binderRowFilter(register)(row);
}

/**
 * The user_id a new row in this binder carries. Shared: the skipper, so the
 * outbox, the push and the server agree (and crew_rewrite_user_id never has
 * to guess between two skippers). Own: the sailor, or '' while signed out.
 * Throws when the shared binder is view-only.
 */
export function binderInsertOwner(register: BinderRegister): string {
    const source = getBinderSource(register);
    if (source.mode === 'shared') {
        if (!source.canWrite) {
            throw new SharedBinderReadOnlyError(register, "This binder is view only — it's shared from the skipper.");
        }
        return source.ownerId;
    }
    return selfId() ?? '';
}

/**
 * Does ANY skipper in the snapshot let the sailor write this register? While
 * one does, crew_rewrite_user_id moves an INSERT stamped with the sailor's own
 * id into that skipper's binder, so the sailor's own binder cannot take it.
 */
export function anySkipperGrantsWrite(register: BinderRegister): boolean {
    return currentSnapshot()?.skippers.some((skipper) => skipper.registers[register].write) ?? false;
}

/** The boat name the snapshot knows for this skipper, or null. */
export function binderVesselName(ownerId: string): string | null {
    return currentSnapshot()?.skippers.find((skipper) => skipper.ownerId === ownerId)?.vesselName ?? null;
}

/** Does the current snapshot let the sailor write this owner's register? */
export function binderWriteGranted(register: BinderRegister, ownerId: string): boolean {
    const self = selfId();
    if (!ownerId || !self || ownerId === self) return true;
    const skipper = currentSnapshot()?.skippers.find((candidate) => candidate.ownerId === ownerId);
    return skipper?.registers[register].write === true;
}

/** Refuse, before anything is queued, an edit the share does not allow. */
export function assertBinderWritable(register: BinderRegister, row: unknown): void {
    if (!row) return;
    const owner = rowOwner(row);
    if (binderWriteGranted(register, owner)) return;
    throw new SharedBinderReadOnlyError(register, "This binder is view only — it's shared from the skipper.");
}

/**
 * Deletes are owner-only in RLS, so a queued crew DELETE of a skipper's row
 * would fail forever. Refuse it here; nothing is queued.
 */
export function assertBinderDeletable(register: BinderRegister, row: unknown): void {
    if (!row || isOwnBinderRow(row)) return;
    throw new SharedBinderReadOnlyError(register, 'Only the skipper can delete from their binder.');
}

/**
 * Default R&M tasks are seeded into the sailor's OWN binder only, and only
 * once the server has confirmed the share snapshot for this account at least
 * once — a crew device that seeded before its skipper's rows arrived put 40
 * duplicate defaults into the skipper's binder (2026-10-01).
 */
export function canSeedOwnBinder(register: BinderRegister): boolean {
    const scope = getAuthIdentityScope();
    if (!scope.userId) return true; // signed out: nobody's crew
    if (getBinderSource(register).mode !== 'own') return false;
    const { snapshot } = current();
    return snapshot?.userId === scope.userId && !!snapshot.confirmedAt;
}

/** Skippers sharing a binder (this register, or any), default order first. */
export function listBinderSkippers(register?: BinderRegister): SharedBinderSkipper[] {
    const snapshot = currentSnapshot();
    if (!snapshot) return [];
    return snapshot.skippers
        .filter((skipper) => (register ? skipper.registers[register].read : true))
        .sort(byDefaultOrder)
        .map((skipper) => ({ ...skipper, registers: { ...skipper.registers } }));
}

/** 'Switch boat': persist which skipper this account is crewing for here. */
export function selectBinderSkipper(ownerId: string): void {
    const scope = getAuthIdentityScope();
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return;
    const snapshot = currentSnapshot();
    if (!snapshot?.skippers.some((skipper) => skipper.ownerId === ownerId)) return;
    writeStorage(authScopedStorageKey(SELECTION_KEY, scope), ownerId);
    const previous = current();
    state = Object.freeze({ ...previous, selection: ownerId, version: previous.version + 1 });
    notify();
}

// ── Refresh (once per sync cycle) ──────────────────────────────

interface LocalSessionFence {
    isCurrent: () => boolean;
}

async function captureLocalSession(scope: AuthIdentityScope): Promise<LocalSessionFence> {
    const { getLocalDatabaseSession, isLocalDatabaseSessionCurrent } = await import('./LocalDatabase');
    const session = getLocalDatabaseSession();
    if (session.identity !== scope.userId) {
        throw new Error('Local database identity does not match the signed-in account');
    }
    return { isCurrent: () => isLocalDatabaseSessionCurrent(session) };
}

/**
 * Fetch the sailor's accepted memberships and replace the snapshot. THROWS on
 * any query or fence failure, and never maps an error to "no memberships": the
 * caller keeps the cached snapshot. `changed` is true when any (owner,
 * register, read, write) or the effective selection differs.
 */
export async function refreshSharedBinders(): Promise<{ changed: boolean; fresh: boolean }> {
    const scope = getAuthIdentityScope();
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) {
        throw new Error('Shared binders need a signed-in account');
    }
    const userId = scope.userId;
    const localSession = await captureLocalSession(scope);
    const { supabase } = await import('../supabase');
    if (!supabase) throw new Error('Supabase not configured');
    const fence = () => {
        if (!isAuthIdentityScopeCurrent(scope) || !localSession.isCurrent()) {
            throw new Error('Account changed while reading shared binders');
        }
    };
    fence();

    const { data, error } = await supabase
        .from('vessel_crew')
        .select('owner_id, crew_user_id, status, shared_registers, permissions, updated_at, created_at')
        .eq('crew_user_id', userId)
        .eq('status', 'accepted');
    fence();
    if (error) throw new Error(`Shared binder memberships could not be read: ${error.message}`);

    const derived = deriveBinderAccess((data ?? []) as BinderMembershipRow[], userId);
    const previous = current();
    const previousNames = new Map(
        (previous.snapshot?.userId === userId ? previous.snapshot.skippers : []).map((skipper) => [
            skipper.ownerId,
            skipper.vesselName,
        ]),
    );
    const names = new Map<string, string | null>();
    if (derived.length > 0) {
        // DECIDED: the boat's name is decoration. A failed name read keeps the
        // last known name (or the "your skipper's boat" fallback) and never
        // fails the snapshot that decides which rows are shown.
        try {
            const { data: vessels, error: vesselError } = await supabase
                .from('vessel_identity')
                .select('owner_id, vessel_name')
                .in(
                    'owner_id',
                    derived.map((skipper) => skipper.ownerId),
                );
            fence();
            if (vesselError) throw new Error(vesselError.message);
            for (const vessel of (vessels ?? []) as { owner_id?: unknown; vessel_name?: unknown }[]) {
                if (typeof vessel.owner_id !== 'string' || names.has(vessel.owner_id)) continue;
                const name = typeof vessel.vessel_name === 'string' ? vessel.vessel_name.trim() : '';
                names.set(vessel.owner_id, name || null);
            }
        } catch (nameError) {
            fence();
            log.warn('Skipper boat names could not be read; keeping the last known names:', nameError);
        }
    }

    const next: SharedBinderSnapshot = {
        version: 1,
        userId,
        confirmedAt: new Date().toISOString(),
        skippers: derived.map((skipper) => ({
            ...skipper,
            vesselName: names.has(skipper.ownerId)
                ? (names.get(skipper.ownerId) ?? null)
                : (previousNames.get(skipper.ownerId) ?? null),
        })),
    };
    const previousSnapshot = previous.snapshot?.userId === userId ? previous.snapshot : null;
    const changed = accessSignature(previousSnapshot, previous.selection) !== accessSignature(next, previous.selection);
    const visibleChange =
        changed ||
        !previousSnapshot?.confirmedAt ||
        next.skippers.some((skipper) => previousNames.get(skipper.ownerId) !== skipper.vesselName) ||
        next.skippers.length !== previousSnapshot.skippers.length;

    writeStorage(authScopedStorageKey(SNAPSHOT_KEY, scope), JSON.stringify(next));
    state = Object.freeze({
        ...previous,
        snapshot: next,
        version: visibleChange ? previous.version + 1 : previous.version,
    });
    if (visibleChange) notify();
    return { changed, fresh: true };
}
