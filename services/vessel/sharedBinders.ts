/**
 * sharedBinders — whose Boat Binder a sailor is looking at.
 *
 * Shane 2026-10-02: "the shared binders are not shared, so the invitee, still
 * has his own binders. they should really be replaced with the inviters
 * binders that are shared with the invitee". So while a sailor is accepted
 * crew on a skipper's boat, each binder register that skipper shares (Ship's
 * Stores, Equipment, R&M, Documents, and the Galley) shows the SKIPPER'S rows,
 * never a mix.
 *
 * The truth is a server snapshot of the sailor's ACCEPTED vessel_crew rows,
 * read once per sync cycle, that mirrors public.can_access_vessel_register
 * (20260723100000) exactly:
 *   - stores: read = can_view_stores OR can_edit_stores, write = can_edit_stores
 *     (the JSONB flags; shared_registers is NOT consulted);
 *   - equipment / maintenance / documents / galley: read = write = register
 *     in shared_registers (the database has no view-only form of these);
 *   - galley only once the server can share it (galleyLive below): until the
 *     galley policies are on the server a ticked Galley grants nothing there,
 *     so it grants nothing here either and the app behaves as before;
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
import type { CrewRole } from '../CrewService';

const log = createLogger('SharedBinders');

// ── Types ──────────────────────────────────────────────────────

export type BinderRegister = 'stores' | 'equipment' | 'maintenance' | 'documents' | 'galley';

export const BINDER_REGISTERS: readonly BinderRegister[] = [
    'stores',
    'equipment',
    'maintenance',
    'documents',
    'galley',
];

/** Every synced binder table and the register whose share governs it. */
export const TABLE_REGISTER: Readonly<Record<string, BinderRegister>> = Object.freeze({
    inventory_items: 'stores',
    equipment_register: 'equipment',
    maintenance_tasks: 'maintenance',
    maintenance_history: 'maintenance',
    // The skipper's engine-hours reading travels with his R&M.
    vessel_engine_hours: 'maintenance',
    ship_documents: 'documents',
    // Shane 2026-10-03: "can we share the galley as well with invitees". The
    // Galley's own rows: the recipe library, and the meal plans and grocery
    // list kept with no passage. A meal plan or grocery item that carries a
    // voyage_id belongs to that passage's Meal Planner share instead
    // (can_access_passage), whatever this says: see binderRegisterForRow.
    recipes: 'galley',
    meal_plans: 'galley',
    shopping_list: 'galley',
});

/** Tables whose rows with a voyage_id belong to a passage share, not the galley. */
const PASSAGE_SCOPED_TABLES: ReadonlySet<string> = new Set(['meal_plans', 'shopping_list']);

/**
 * The register whose share governs this row: TABLE_REGISTER, except that a
 * meal plan or grocery item for a passage (voyage_id set) is governed by the
 * passage's Meal Planner share, which this module does not track (null).
 */
export function binderRegisterForRow(table: string, row: unknown): BinderRegister | null {
    const register = TABLE_REGISTER[table];
    if (!register) return null;
    if (PASSAGE_SCOPED_TABLES.has(table)) {
        const voyageId = row && typeof row === 'object' ? (row as { voyage_id?: unknown }).voyage_id : undefined;
        if (typeof voyageId === 'string' && voyageId.trim()) return null;
    }
    return register;
}

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

/**
 * A boat the sailor is accepted crew on (the crewing view, Shane 2026-10-03:
 * "it should all pertain to the vessel that the punter has been invited on").
 * Every accepted owner, binder or not: a punter who shares only Crew Chat is
 * still crew, and has no entry in `skippers`.
 */
export interface CrewVessel {
    ownerId: string;
    /** vessel_identity.vessel_name; null when unknown. */
    vesselName: string | null;
    /** The most senior role across the sailor's rows for this owner; null in a snapshot stored before roles. */
    role: CrewRole | string | null;
    /** As SharedBinderSkipper.lastAcceptedAt: when the newest membership began. */
    lastAcceptedAt: string;
    /**
     * The skipper shares the Instrument Panel (permissions.can_view_instruments,
     * which the vessel_telemetry read policy checks). Absent in a snapshot
     * stored before 2026-10-05: not known.
     */
    instruments?: boolean;
}

export interface SharedBinderSnapshot {
    version: 1;
    userId: string;
    /** Last time the server confirmed this snapshot; null = never. */
    confirmedAt: string | null;
    skippers: SharedBinderSkipper[];
    /**
     * The server has the galley share (migration 20261003100000: its
     * galley_share_ready() answers). Until it does, no galley is shared here,
     * whatever was ticked. Once true it stays true.
     */
    galleyLive?: boolean;
    /** Every boat the sailor crews on. Absent in a snapshot stored before 2026-10-03. */
    vessels?: CrewVessel[];
}

/** The subset of a vessel_crew row this module reads. */
export interface BinderMembershipRow {
    owner_id?: unknown;
    crew_user_id?: unknown;
    status?: unknown;
    shared_registers?: unknown;
    permissions?: unknown;
    role?: unknown;
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
        galley: { read: false, write: false },
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
 * who grants nothing on any binder register is left out. The galley counts
 * only when `galleyLive` (the server has the galley policies).
 */
export function deriveBinderAccess(
    memberships: readonly BinderMembershipRow[],
    selfId?: string | null,
    options: { galleyLive?: boolean } = {},
): Omit<SharedBinderSkipper, 'vesselName'>[] {
    const shareable: readonly BinderRegister[] = options.galleyLive
        ? ['equipment', 'maintenance', 'documents', 'galley']
        : ['equipment', 'maintenance', 'documents'];
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
        for (const register of shareable) {
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
function byDefaultOrder(
    a: Pick<SharedBinderSkipper, 'ownerId' | 'lastAcceptedAt'>,
    b: Pick<SharedBinderSkipper, 'ownerId' | 'lastAcceptedAt'>,
): number {
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

// ── Crew vessels (the crewing view, 2026-10-03) ────────────────

const ROLE_SENIORITY: Readonly<Record<string, number>> = { 'co-skipper': 4, navigator: 3, deckhand: 2, punter: 1 };

function seniority(role: string | null): number {
    return role ? (ROLE_SENIORITY[role] ?? 0) : -1;
}

/**
 * Every owner the sailor is ACCEPTED crew for, binder or not. voyage_id is
 * ignored (vessel-level crew, as the binders read it); several rows for one
 * owner are one boat with the most senior role.
 */
export function deriveCrewVessels(
    memberships: readonly BinderMembershipRow[],
    selfId?: string | null,
): Omit<CrewVessel, 'vesselName'>[] {
    const byOwner = new Map<string, Omit<CrewVessel, 'vesselName'>>();
    for (const row of memberships) {
        if (!row || row.status !== 'accepted') continue;
        if (typeof row.owner_id !== 'string' || !row.owner_id.trim()) continue;
        const ownerId = row.owner_id.trim();
        if (selfId && ownerId === selfId) continue;
        if (selfId && typeof row.crew_user_id === 'string' && row.crew_user_id !== selfId) continue;
        const role = typeof row.role === 'string' && row.role.trim() ? row.role.trim() : null;
        const time = rowTime(row);
        const instruments = flag(row.permissions, 'can_view_instruments');
        const entry = byOwner.get(ownerId);
        if (!entry) {
            byOwner.set(ownerId, { ownerId, role, lastAcceptedAt: time, instruments });
            continue;
        }
        if (seniority(role) > seniority(entry.role)) entry.role = role;
        if (time > entry.lastAcceptedAt) entry.lastAcceptedAt = time;
        entry.instruments ||= instruments;
    }
    return [...byOwner.values()];
}

/** The snapshot's boats; a snapshot stored before the list existed reads its binder skippers. */
function snapshotVessels(snapshot: SharedBinderSnapshot): CrewVessel[] {
    return (
        snapshot.vessels ??
        snapshot.skippers.map((skipper) => ({
            ownerId: skipper.ownerId,
            vesselName: skipper.vesselName,
            role: null,
            lastAcceptedAt: skipper.lastAcceptedAt,
        }))
    );
}

/** What the crewing view shows; a change here is visible, never a binder change. */
function vesselsSignature(snapshot: SharedBinderSnapshot | null): string {
    if (!snapshot) return '';
    return snapshotVessels(snapshot)
        .map(
            (vessel) => `${vessel.ownerId}:${vessel.role ?? ''}:${vessel.vesselName ?? ''}:${vessel.instruments ?? ''}`,
        )
        .sort()
        .join('|');
}

function parseVessels(value: unknown): CrewVessel[] | undefined {
    if (!Array.isArray(value)) return undefined;
    const vessels: CrewVessel[] = [];
    for (const vessel of value as Partial<CrewVessel>[]) {
        if (!vessel || typeof vessel.ownerId !== 'string' || !vessel.ownerId) continue;
        vessels.push({
            ownerId: vessel.ownerId,
            vesselName: typeof vessel.vesselName === 'string' && vessel.vesselName ? vessel.vesselName : null,
            role: typeof vessel.role === 'string' && vessel.role ? vessel.role : null,
            lastAcceptedAt: typeof vessel.lastAcceptedAt === 'string' ? vessel.lastAcceptedAt : '',
            ...(typeof vessel.instruments === 'boolean' ? { instruments: vessel.instruments } : {}),
        });
    }
    return vessels;
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
        const galleyLive = value.galleyLive === true;
        const skippers: SharedBinderSkipper[] = [];
        for (const skipper of value.skippers) {
            if (!skipper || typeof skipper.ownerId !== 'string' || !skipper.ownerId) continue;
            const registers = emptyAccess();
            for (const register of BINDER_REGISTERS) {
                // A galley share the server cannot honour yet is no share.
                if (register === 'galley' && !galleyLive) continue;
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
        const snapshot: SharedBinderSnapshot = {
            version: 1,
            userId,
            confirmedAt: typeof value.confirmedAt === 'string' ? value.confirmedAt : null,
            skippers,
            ...(galleyLive ? { galleyLive: true } : {}),
        };
        const vessels = parseVessels(value.vessels);
        return vessels ? { ...snapshot, vessels } : snapshot;
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

/**
 * True once the server has the galley share (galley_share_ready answered).
 * Before then no galley is shared, the galley tables are not swept, and the
 * Galley pages open no realtime channel for recipes or meal plans: the app
 * behaves exactly as it did before the galley could be shared.
 */
export function isGalleyShareLive(): boolean {
    return currentSnapshot()?.galleyLive === true;
}

/**
 * The skipper whose galley this account sees and uses (recipes, and the meal
 * plans and grocery list kept with no passage), or null for its own galley.
 */
export function galleyShareOwner(): string | null {
    const source = getBinderSource('galley');
    return source.mode === 'shared' ? source.ownerId : null;
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

/** Every boat the sailor is crewing on, default order first. */
export function listCrewVessels(): CrewVessel[] {
    const snapshot = currentSnapshot();
    if (!snapshot) return [];
    return snapshotVessels(snapshot)
        .map((vessel) => ({ ...vessel }))
        .sort(byDefaultOrder);
}

/**
 * The boat this account is crewing on here: the selection when it is still a
 * crew boat, else the newest membership, else null (not crew). The binders,
 * the Crew & Float Plan page and Switch boat all read this one selection.
 */
export function getCrewingVessel(): CrewVessel | null {
    const vessels = listCrewVessels();
    if (vessels.length === 0) return null;
    const selection = current().selection;
    return vessels.find((vessel) => vessel.ownerId === selection) ?? vessels[0];
}

/** 'Switch boat': persist which boat this account is crewing on here. */
export function selectCrewVessel(ownerId: string): void {
    const scope = getAuthIdentityScope();
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return;
    const snapshot = currentSnapshot();
    if (
        !snapshot ||
        (!snapshotVessels(snapshot).some((vessel) => vessel.ownerId === ownerId) &&
            !snapshot.skippers.some((skipper) => skipper.ownerId === ownerId))
    ) {
        return;
    }
    writeStorage(authScopedStorageKey(SELECTION_KEY, scope), ownerId);
    const previous = current();
    state = Object.freeze({ ...previous, selection: ownerId, version: previous.version + 1 });
    notify();
}

/** The binders' name for the same one selection. */
export const selectBinderSkipper = selectCrewVessel;

// ── Refresh (once per sync cycle) ──────────────────────────────

/**
 * How often an account asks whether the server has the galley policies yet:
 * with no Galley ticked for it, once an hour (a skipper's own device wants it
 * for live updates from crew); with one ticked, every five minutes, and at
 * once when a tick first shows up. Not every cycle: every prompt push after
 * an edit runs one, and until the push each question is a 404. Once the
 * answer is yes it is kept and never asked again.
 */
const GALLEY_READY_RECHECK_MS = 60 * 60 * 1000;
const GALLEY_READY_TICKED_RECHECK_MS = 5 * 60 * 1000;
let galleyReadyCheckedAt = Number.NEGATIVE_INFINITY;
let galleyReadyCheckedFor: string | null = null;
let galleyReadyCheckedTicked = false;

/** PostgREST: the function is not in its schema cache (not pushed yet). */
function isMissingFunctionError(error: unknown): boolean {
    if (!error || typeof error !== 'object') return false;
    const { code, message } = error as { code?: unknown; message?: unknown };
    if (code === 'PGRST202') return true;
    return (
        (code === undefined || code === null) &&
        typeof message === 'string' &&
        /^Could not find the function public\.galley_share_ready/.test(message)
    );
}

/**
 * Does the server have the galley share? true / false, or null when the
 * question could not be answered (keep what was known). Never throws.
 */
async function askGalleyShareReady(client: { rpc?: unknown }): Promise<boolean | null> {
    try {
        if (typeof client.rpc !== 'function') return null;
        const { data, error } = await (
            client.rpc as (fn: string) => PromiseLike<{ data: unknown; error: unknown }>
        ).call(client, 'galley_share_ready');
        if (error) {
            if (isMissingFunctionError(error)) return false;
            log.warn('Could not ask whether the galley can be shared yet:', (error as { message?: unknown }).message);
            return null;
        }
        return data === true;
    } catch (error) {
        log.warn('Could not ask whether the galley can be shared yet:', error);
        return null;
    }
}

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
        .select('owner_id, crew_user_id, status, shared_registers, permissions, role, updated_at, created_at')
        .eq('crew_user_id', userId)
        .eq('status', 'accepted');
    fence();
    if (error) throw new Error(`Shared binder memberships could not be read: ${error.message}`);

    const memberships = (data ?? []) as BinderMembershipRow[];
    const crewVessels = deriveCrewVessels(memberships, userId);
    const previous = current();
    const previousSnapshotForUser = previous.snapshot?.userId === userId ? previous.snapshot : null;
    let galleyLive = previousSnapshotForUser?.galleyLive === true;
    if (!galleyLive) {
        const galleyTicked = memberships.some(
            (row) => row?.status === 'accepted' && registerList(row.shared_registers).includes('galley'),
        );
        const now = Date.now();
        const recheckMs = galleyTicked ? GALLEY_READY_TICKED_RECHECK_MS : GALLEY_READY_RECHECK_MS;
        if (
            galleyReadyCheckedFor !== userId ||
            (galleyTicked && !galleyReadyCheckedTicked) ||
            now - galleyReadyCheckedAt >= recheckMs
        ) {
            const ready = await askGalleyShareReady(supabase as unknown as { rpc?: unknown });
            fence();
            if (ready !== null) {
                galleyReadyCheckedAt = now;
                galleyReadyCheckedFor = userId;
                galleyReadyCheckedTicked = galleyTicked;
            }
            galleyLive = ready === true;
        }
    }

    const derived = deriveBinderAccess(memberships, userId, { galleyLive });
    const previousNames = new Map(
        (previous.snapshot?.userId === userId ? snapshotVessels(previous.snapshot) : []).map((vessel) => [
            vessel.ownerId,
            vessel.vesselName,
        ]),
    );
    const names = new Map<string, string | null>();
    // Every crew boat's name, binder or not (the crewing view names the boat).
    if (crewVessels.length > 0) {
        // DECIDED: the boat's name is decoration. A failed name read keeps the
        // last known name (or the "your skipper's boat" fallback) and never
        // fails the snapshot that decides which rows are shown.
        try {
            const { data: vessels, error: vesselError } = await supabase
                .from('vessel_identity')
                .select('owner_id, vessel_name')
                .in(
                    'owner_id',
                    crewVessels.map((vessel) => vessel.ownerId),
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

    const nameFor = (ownerId: string) =>
        names.has(ownerId) ? (names.get(ownerId) ?? null) : (previousNames.get(ownerId) ?? null);
    const next: SharedBinderSnapshot = {
        version: 1,
        userId,
        confirmedAt: new Date().toISOString(),
        skippers: derived.map((skipper) => ({ ...skipper, vesselName: nameFor(skipper.ownerId) })),
        vessels: crewVessels.map((vessel) => ({ ...vessel, vesselName: nameFor(vessel.ownerId) })),
        ...(galleyLive ? { galleyLive: true } : {}),
    };
    const previousSnapshot = previousSnapshotForUser;
    const changed = accessSignature(previousSnapshot, previous.selection) !== accessSignature(next, previous.selection);
    const visibleChange =
        changed ||
        !previousSnapshot?.confirmedAt ||
        (previousSnapshot.galleyLive === true) !== galleyLive ||
        next.skippers.some((skipper) => previousNames.get(skipper.ownerId) !== skipper.vesselName) ||
        next.skippers.length !== previousSnapshot.skippers.length ||
        vesselsSignature(previousSnapshot) !== vesselsSignature(next);

    writeStorage(authScopedStorageKey(SNAPSHOT_KEY, scope), JSON.stringify(next));
    state = Object.freeze({
        ...previous,
        snapshot: next,
        version: visibleChange ? previous.version + 1 : previous.version,
    });
    if (visibleChange) notify();
    return { changed, fresh: true };
}
