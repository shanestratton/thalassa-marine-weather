/**
 * VesselFleetService
 *
 * A vessel is no longer just a field inside a user's generic settings blob.
 * This service treats `boats.id` as the durable vessel identity and keeps the
 * complete operating profile in the fleet API.  The settings store still
 * exposes the selected vessel as a compatibility snapshot while the rest of
 * the application moves over incrementally.
 *
 * Two details are deliberate:
 *
 *  - writes are field patches, not whole-settings upserts, so an edit on a
 *    second device cannot silently erase unrelated specifications;
 *  - failed updates live in an account-scoped Preferences outbox and are
 *    replayed in order after the next successful cloud contact.
 */

import { Preferences } from '@capacitor/preferences';
import type { ComfortParams } from '../types/settings';
import type { PolarData } from '../types/navigation';
import type { VesselDimensionUnits, VesselProfile } from '../types/vessel';
import { supabase } from './supabase';
import { vesselCruisingSpeedKts, vesselMaxWaveHeightFt } from './units';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from './authIdentityScope';
import { createLogger } from '../utils/createLogger';

const log = createLogger('VesselFleet');

/** A skipper can maintain a practical delivery fleet without turning this into a boat broker. */
export const MAX_OWNED_VESSELS = 5;

const OUTBOX_KEY = 'thalassa_vessel_fleet_outbox_v1';
const OUTBOX_VERSION = 1;
/**
 * The fleet cache is separate from the settings mirror. The settings mirror
 * deliberately exposes only one compatibility vessel, while this cache keeps
 * every owned profile available when a skipper opens the app below deck.
 */
const FLEET_CACHE_KEY = 'thalassa_owned_vessel_fleet_cache_v1';
const FLEET_CACHE_VERSION = 1;
/**
 * Profile edits and archival for one boat share a single mutation lane. An
 * archive can therefore never race an in-flight patch and leave an
 * undeletable stale patch at the head of the account outbox.
 */
const boatMutationTails = new Map<string, Promise<void>>();
/** Locally archived boats reject any patch that began after the archive. */
const retiredBoatKeys = new Set<string>();
/**
 * The durable queue is per account, not per boat. Keep its read/modify/write
 * operations serialised so an edit to vessel B cannot disappear while a
 * retry is removing a successfully delivered edit to vessel A.
 */
const outboxTails = new Map<string, Promise<void>>();
/** Keep cache read/modify/write updates ordered just like the patch outbox. */
const fleetCacheTails = new Map<string, Promise<void>>();

export interface OwnedVesselProfile {
    /** `boats.id`, the permanent identity carried by routes and tracks. */
    id: string;
    owner_id: string;
    profile: VesselProfile;
    vessel_units?: VesselDimensionUnits;
    polar_data?: PolarData | null;
    polar_boat_model?: string | null;
    polar_source_type?: 'database' | 'file_import' | 'manual' | null;
    comfort_params?: ComfortParams;
    revision: number;
    updated_at: string;
    archived_at?: string | null;
    is_active: boolean;
    /**
     * True when `boats.mmsi` holds the CLAIM for this hull (2026-09-08 vessel
     * claim decision). The profile keeps whatever MMSI the skipper typed for
     * VHF/DSC; a false here with a 9-digit profile MMSI means another active
     * Thalassa boat already carries it — advisory on edits, never a refusal.
     */
    /** null = the server did not say (a build ahead of migration 20260908170000, or an older cache) — never an advisory. */
    mmsiClaimed: boolean | null;
    /** Set by `release_owned_vessel`; the row is also archived. */
    releasedAt: string | null;
    releaseReason: ReleaseReason | null;
}

export interface VesselFleet {
    vessels: OwnedVesselProfile[];
    activeBoatId: string | null;
}

// ── Release (2026-09-08 decision: "a punter needs a way to release a vessel
// in case it has been sold, or they were just doing a delivery") ───────────

export type ReleaseReason = 'sold' | 'delivery_complete' | 'other';

/** Mirror of the `release_owned_vessel` jsonb reply, camel-cased. */
export interface ReleaseVesselResult {
    released: boolean;
    remainingActiveBoats: number;
    nextActiveBoatId: string | null;
    crewRemoved: number;
    invitesRevoked: number;
    relaysRemoved: number;
    relaysUnmatched: number;
    telemetryCleared: number;
    publicPagesDisabled: number;
}

export interface UndoReleaseResult {
    restored: boolean;
    /** The buyer claimed the MMSI meanwhile; the boat came back unclaimed. */
    claimLost: boolean;
}

export interface ReleasedVesselRow {
    boatId: string;
    name: string;
    releasedAt: string;
    releaseReason: ReleaseReason;
}

/**
 * Release is never queued in the fleet outbox: a destructive action replaying
 * later at sea is the wrong surprise. Same shore-side posture as Add vessel.
 * The store's `releaseBlockedReason()` shows this exact sentence.
 */
export const RELEASE_OFFLINE_MESSAGE =
    'Releasing needs a connection — it disconnects crew, the Pi and the public page in the cloud. Nothing has changed.';

/**
 * `MMSI_CLAIMED` from create/bootstrap: another ACTIVE boat holds this MMSI.
 * DETAIL names the claiming boat (name + MMSI are already broadcast on AIS;
 * the owner is never disclosed), HINT carries the MMSI.
 */
export class VesselClaimedError extends Error {
    readonly vesselName: string;
    readonly mmsi: string;

    constructor(vesselName: string, mmsi: string) {
        super(
            mmsi
                ? `${vesselName} (MMSI ${mmsi}) is already on Thalassa.`
                : `${vesselName} is already on Thalassa with this MMSI.`,
        );
        this.name = 'VesselClaimedError';
        this.vesselName = vesselName;
        this.mmsi = mmsi;
    }
}

/**
 * `VESSEL_RELEASED` from the automatic bootstrap: this account released a
 * hull matching the local profile, so the stale profile on a second phone
 * must not resurrect it. Terminal — 'Undo release' or Add vessel is the way
 * back. DETAIL = name, HINT = `<released_at ISO>|<reason>`.
 */
export class VesselReleasedError extends Error {
    readonly vesselName: string;
    readonly releasedAt: string | null;
    readonly reason: ReleaseReason | null;

    constructor(vesselName: string, releasedAt: string | null, reason: ReleaseReason | null) {
        super(`You released ${vesselName}. Use Undo release or Add vessel to bring her back.`);
        this.name = 'VesselReleasedError';
        this.vesselName = vesselName;
        this.releasedAt = releasedAt;
        this.reason = reason;
    }
}

function isReleaseReason(value: unknown): value is ReleaseReason {
    return value === 'sold' || value === 'delivery_complete' || value === 'other';
}

/**
 * JSON merge patches need an explicit deletion value. `undefined` disappears
 * during JSON serialisation, whereas `null` survives the trip to PostgREST
 * and lets the fleet RPC remove that persisted key.
 */
export type NullableFieldPatch<T extends object> = {
    [Key in keyof T]?: T[Key] | null;
};

/**
 * A sparse patch deliberately mirrors the database RPC. `set*` is required
 * for nullable polar fields so clearing a field is distinguishable from not
 * touching it.
 */
export interface VesselProfilePatch {
    profile?: Partial<VesselProfile>;
    vesselUnits?: Partial<VesselDimensionUnits>;
    comfortParams?: NullableFieldPatch<ComfortParams>;
    polarData?: PolarData | null;
    setPolarData?: boolean;
    polarBoatModel?: string | null;
    setPolarBoatModel?: boolean;
    polarSourceType?: 'database' | 'file_import' | 'manual' | null;
    setPolarSourceType?: boolean;
}

export interface QueueVesselPatchInput {
    boatId: string;
    patch: VesselProfilePatch;
    /** Last server revision seen by this device. Kept for diagnostics; field patches merge server-side. */
    revision?: number | null;
}

export interface QueuedVesselPatch extends QueueVesselPatchInput {
    id: string;
    ownerUserId: string;
    queuedAt: string;
}

interface OutboxEnvelope {
    version: typeof OUTBOX_VERSION;
    ownerUserId: string | null;
    entries: QueuedVesselPatch[];
    /** Lets a newer browser fallback win over a stale native snapshot. */
    savedAt?: string;
}

interface FleetCacheEnvelope {
    version: typeof FLEET_CACHE_VERSION;
    ownerUserId: string;
    savedAt: string;
    fleet: VesselFleet;
    /**
     * A vessel choice made offline is safe to use on this device immediately.
     * It is promoted to the account-wide active vessel on the next sync.
     */
    pendingActiveBoatId: string | null;
}

export interface CachedOwnedVesselFleet {
    fleet: VesselFleet;
    pendingActiveBoatId: string | null;
}

/** A persisted token lets a retry remove only the exact snapshot it sent. */
type QueueSnapshot = Pick<QueuedVesselPatch, 'id' | 'patch' | 'revision' | 'queuedAt'>;

export interface FleetMutationResult<T> {
    value: T | null;
    queued: boolean;
    error?: Error;
}

/**
 * Preserve an intentional `undefined` clear as JSON `null` for the server.
 * Comfort Zone's “OFF” sliders rely on this: omitting the key would merge as
 * a no-op and bring the old safety limit back on another device.
 */
export function normaliseVesselProfilePatchForCloud(patch: VesselProfilePatch): VesselProfilePatch {
    if (!patch.comfortParams) return patch;
    const comfortParams: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch.comfortParams)) {
        comfortParams[key] = value === undefined ? null : value;
    }
    return { ...patch, comfortParams: comfortParams as NullableFieldPatch<ComfortParams> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function finiteNumber(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function vesselType(value: unknown): VesselProfile['type'] {
    return value === 'power' || value === 'observer' || value === 'sail' ? value : 'sail';
}

function profileDefaults(raw: Record<string, unknown>): VesselProfile {
    // A legacy profile can be incomplete. Give the settings UI safe defaults
    // without throwing away any valid optional fields it already carries.
    const profile = { ...raw } as Partial<VesselProfile>;
    return {
        ...profile,
        name: stringValue(profile.name) ?? 'Unnamed Vessel',
        type: vesselType(profile.type),
        length: finiteNumber(profile.length, 0),
        beam: finiteNumber(profile.beam, 0),
        draft: finiteNumber(profile.draft, 0),
        displacement: finiteNumber(profile.displacement, 0),
        // `boat_profiles.profile` has no column for either of these — they are
        // derived from the hull. Defaulting them to 0 here (as the other
        // numbers do) is what made the settings panel read "0 kts / 0 ft" for
        // any profile restored from the fleet, and worse, zeroed the
        // survivability ceiling isochroneEnhancer gates on.
        maxWaveHeight: vesselMaxWaveHeightFt(profile),
        cruisingSpeed: vesselCruisingSpeedKts(profile),
    } as VesselProfile;
}

function normaliseUnits(value: unknown): VesselDimensionUnits | undefined {
    if (!isRecord(value)) return undefined;
    const length = value.length === 'm' || value.length === 'ft' ? value.length : undefined;
    const beam = value.beam === 'm' || value.beam === 'ft' ? value.beam : undefined;
    const draft = value.draft === 'm' || value.draft === 'ft' ? value.draft : undefined;
    const displacement =
        value.displacement === 'kg' || value.displacement === 'lbs' || value.displacement === 'tonnes'
            ? value.displacement
            : undefined;
    const volume = value.volume === 'l' || value.volume === 'gal' ? value.volume : undefined;
    // Existing profiles and individual settings controls can legitimately
    // persist only one unit (for example `volume: "l"`). Keep that valid
    // preference and materialise the app's established defaults for the
    // remaining dimensions instead of discarding the entire object.
    if (!length && !beam && !draft && !displacement && !volume) return undefined;
    return {
        length: length ?? 'ft',
        beam: beam ?? 'ft',
        draft: draft ?? 'ft',
        displacement: displacement ?? 'lbs',
        ...(volume ? { volume } : {}),
    } as VesselDimensionUnits;
}

function normaliseComfort(value: unknown): ComfortParams | undefined {
    if (!isRecord(value)) return undefined;
    const out: ComfortParams = {};
    if (typeof value.maxWindKts === 'number' && Number.isFinite(value.maxWindKts)) out.maxWindKts = value.maxWindKts;
    if (typeof value.maxWaveM === 'number' && Number.isFinite(value.maxWaveM)) out.maxWaveM = value.maxWaveM;
    if (typeof value.maxGustKts === 'number' && Number.isFinite(value.maxGustKts)) out.maxGustKts = value.maxGustKts;
    if (Array.isArray(value.preferredAngles)) {
        const allowed = new Set(['beating', 'close_reach', 'beam_reach', 'broad_reach', 'running']);
        out.preferredAngles = value.preferredAngles.filter(
            (angle): angle is NonNullable<ComfortParams['preferredAngles']>[number] =>
                typeof angle === 'string' && allowed.has(angle),
        );
    }
    return out;
}

function normalisePolar(value: unknown): PolarData | null | undefined {
    if (value === null) return null;
    if (
        !isRecord(value) ||
        !Array.isArray(value.windSpeeds) ||
        !Array.isArray(value.angles) ||
        !Array.isArray(value.matrix)
    ) {
        return undefined;
    }
    const numbers = (input: unknown[]) => input.every((entry) => typeof entry === 'number' && Number.isFinite(entry));
    if (
        !numbers(value.windSpeeds) ||
        !numbers(value.angles) ||
        !value.matrix.every((row) => Array.isArray(row) && numbers(row))
    ) {
        return undefined;
    }
    return value as unknown as PolarData;
}

function normaliseFleetRow(raw: unknown, ownerId: string): OwnedVesselProfile | null {
    if (!isRecord(raw)) return null;
    const id = stringValue(raw.id ?? raw.boat_id);
    const owner = stringValue(raw.owner_id);
    const profileRaw = raw.profile ?? raw.specification;
    if (!id || owner !== ownerId || !isRecord(profileRaw)) return null;
    const polarSource = raw.polar_source_type;
    const releaseReasonRaw = raw.release_reason ?? raw.releaseReason;
    return {
        id,
        owner_id: owner,
        profile: profileDefaults(profileRaw),
        ...(normaliseUnits(raw.vessel_units ?? raw.units)
            ? { vessel_units: normaliseUnits(raw.vessel_units ?? raw.units) }
            : {}),
        ...(normalisePolar(raw.polar_data) !== undefined ? { polar_data: normalisePolar(raw.polar_data) } : {}),
        ...(stringValue(raw.polar_boat_model) ? { polar_boat_model: stringValue(raw.polar_boat_model) } : {}),
        ...(polarSource === 'database' || polarSource === 'file_import' || polarSource === 'manual'
            ? { polar_source_type: polarSource }
            : {}),
        ...(normaliseComfort(raw.comfort_params) ? { comfort_params: normaliseComfort(raw.comfort_params) } : {}),
        revision: finiteNumber(raw.revision, 1),
        updated_at: typeof raw.updated_at === 'string' ? raw.updated_at : new Date(0).toISOString(),
        archived_at: typeof raw.archived_at === 'string' ? raw.archived_at : null,
        is_active: raw.is_active === true,
        // The RPC rows are snake_case; the fleet cache round-trips this
        // camel-cased object back through here. Read both spellings, and
        // treat absent columns as unclaimed/not released so a build shipped
        // ahead of the 20260908170000_vessel_claim_and_release migration
        // still loads its fleet.
        mmsiClaimed:
            typeof (raw.mmsi_claimed ?? raw.mmsiClaimed) === 'boolean'
                ? (raw.mmsi_claimed ?? raw.mmsiClaimed) === true
                : null,
        releasedAt: stringValue(raw.released_at ?? raw.releasedAt),
        releaseReason: isReleaseReason(releaseReasonRaw) ? releaseReasonRaw : null,
    };
}

/**
 * Defensive parser for the RPC payload. It is intentionally exported: the
 * client must never install a foreign/malformed row into the active profile
 * merely because an RPC shape changed.
 */
export function normalizeVesselFleetPayload(raw: unknown, ownerId: string): VesselFleet {
    const container = isRecord(raw) ? raw : null;
    const rows = Array.isArray(raw) ? raw : Array.isArray(container?.vessels) ? container.vessels : [];
    const byId = new Map<string, OwnedVesselProfile>();
    for (const row of rows) {
        const normalised = normaliseFleetRow(row, ownerId);
        if (!normalised || normalised.archived_at) continue;
        const existing = byId.get(normalised.id);
        if (!existing || Date.parse(normalised.updated_at) > Date.parse(existing.updated_at))
            byId.set(normalised.id, normalised);
    }
    const vessels = [...byId.values()].sort((left, right) => {
        const time = Date.parse(right.updated_at) - Date.parse(left.updated_at);
        return time || left.id.localeCompare(right.id);
    });
    const requested = stringValue(container?.active_boat_id ?? container?.activeBoatId);
    const activeBoatId =
        (requested && byId.has(requested) ? requested : null) ??
        vessels.find((vessel) => vessel.is_active)?.id ??
        vessels[0]?.id ??
        null;
    return {
        activeBoatId,
        vessels: vessels.map((vessel) => ({ ...vessel, is_active: vessel.id === activeBoatId })),
    };
}

export function canAddOwnedVessel(fleet: Pick<VesselFleet, 'vessels'> | OwnedVesselProfile[]): boolean {
    const vessels = Array.isArray(fleet) ? fleet : fleet.vessels;
    return vessels.filter((vessel) => !vessel.archived_at).length < MAX_OWNED_VESSELS;
}

/** A pure optimistic selector used by the store before the server reply arrives. */
export function selectActiveOwnedVessel(fleet: VesselFleet, boatId: string): VesselFleet {
    if (!fleet.vessels.some((vessel) => vessel.id === boatId && !vessel.archived_at)) return fleet;
    return {
        activeBoatId: boatId,
        vessels: fleet.vessels.map((vessel) => ({ ...vessel, is_active: vessel.id === boatId })),
    };
}

function outboxKey(scope: AuthIdentityScope): string {
    return authScopedStorageKey(OUTBOX_KEY, scope);
}

function boatMutationKey(scope: AuthIdentityScope, boatId: string): string {
    return `${scope.key}:${boatId}`;
}

function isRetiredBoat(scope: AuthIdentityScope, boatId: string): boolean {
    return retiredBoatKeys.has(boatMutationKey(scope, boatId));
}

function markRetiredBoat(scope: AuthIdentityScope, boatId: string): void {
    retiredBoatKeys.add(boatMutationKey(scope, boatId));
}

/** 'Undo release' brings a hull back; its edits must be accepted again. */
function unmarkRetiredBoat(scope: AuthIdentityScope, boatId: string): void {
    retiredBoatKeys.delete(boatMutationKey(scope, boatId));
}

async function serialiseBoatMutation<T>(scope: AuthIdentityScope, boatId: string, work: () => Promise<T>): Promise<T> {
    const key = boatMutationKey(scope, boatId);
    const prior = boatMutationTails.get(key) ?? Promise.resolve();
    const operation = prior.catch(() => undefined).then(work);
    boatMutationTails.set(
        key,
        operation.then(
            () => undefined,
            () => undefined,
        ),
    );
    return operation;
}

function fleetCacheKey(scope: AuthIdentityScope): string {
    return authScopedStorageKey(FLEET_CACHE_KEY, scope);
}

async function serialiseFleetCache<T>(scope: AuthIdentityScope, work: () => Promise<T>): Promise<T> {
    const prior = fleetCacheTails.get(scope.key) ?? Promise.resolve();
    const operation = prior.catch(() => undefined).then(work);
    fleetCacheTails.set(
        scope.key,
        operation.then(
            () => undefined,
            () => undefined,
        ),
    );
    return operation;
}

function normaliseFleetForCache(fleet: VesselFleet, ownerId: string): VesselFleet {
    return normalizeVesselFleetPayload(
        {
            vessels: fleet.vessels,
            active_boat_id: fleet.activeBoatId,
        },
        ownerId,
    );
}

/**
 * Restore an account-scoped fleet snapshot for offline use. It is never
 * trusted as authority: the next successful cloud sync validates it against
 * the account fleet. The owner check is still vital because devices may be
 * shared between skippers.
 */
export async function loadCachedOwnedVesselFleet(
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<CachedOwnedVesselFleet | null> {
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return null;
    try {
        const key = fleetCacheKey(scope);
        const values: string[] = [];
        try {
            const nativeValue = (await Preferences.get({ key })).value ?? null;
            if (nativeValue) values.push(nativeValue);
        } catch {
            // The browser mirror below remains a valid cache source.
        }
        try {
            const browserValue = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
            if (browserValue && !values.includes(browserValue)) values.push(browserValue);
        } catch {
            /* browser storage is optional */
        }
        if (!values.length || !isAuthIdentityScopeCurrent(scope)) return null;

        let newest: { savedAt: number; value: CachedOwnedVesselFleet } | null = null;
        for (const value of values) {
            try {
                const parsed = JSON.parse(value) as Partial<FleetCacheEnvelope>;
                if (
                    parsed.version !== FLEET_CACHE_VERSION ||
                    parsed.ownerUserId !== scope.userId ||
                    !isRecord(parsed.fleet)
                ) {
                    continue;
                }
                const fleet = normaliseFleetForCache(parsed.fleet as VesselFleet, scope.userId);
                const requestedPending = stringValue(parsed.pendingActiveBoatId);
                const pendingActiveBoatId =
                    requestedPending && fleet.vessels.some((vessel) => vessel.id === requestedPending)
                        ? requestedPending
                        : null;
                const savedAt = Date.parse(typeof parsed.savedAt === 'string' ? parsed.savedAt : '') || 0;
                if (!newest || savedAt >= newest.savedAt) {
                    newest = { savedAt, value: { fleet, pendingActiveBoatId } };
                }
            } catch {
                // A bad local mirror must not prevent a valid native cache
                // from restoring the skipper's fleet.
            }
        }
        return newest?.value ?? null;
    } catch {
        return null;
    }
}

/**
 * Persist the complete selected fleet, not just settings.vessel. Preferences
 * remains the durable source; localStorage is a small warm-path fallback for
 * web/PWA runs where the native bridge is temporarily unavailable.
 */
export async function persistCachedOwnedVesselFleet(
    fleet: VesselFleet,
    scope: AuthIdentityScope = getAuthIdentityScope(),
    pendingActiveBoatId?: string | null,
): Promise<void> {
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return;
    await serialiseFleetCache(scope, async () => {
        if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return;
        const normalised = normaliseFleetForCache(fleet, scope.userId);
        // `undefined` means a profile edit is preserving an in-flight offline
        // vessel selection. Explicit `null` is a successful reconciliation
        // that intentionally clears it.
        const requestedPending =
            pendingActiveBoatId === undefined
                ? ((await loadCachedOwnedVesselFleet(scope))?.pendingActiveBoatId ?? null)
                : pendingActiveBoatId;
        const pending =
            requestedPending && normalised.vessels.some((vessel) => vessel.id === requestedPending)
                ? requestedPending
                : null;
        const value = JSON.stringify({
            version: FLEET_CACHE_VERSION,
            ownerUserId: scope.userId,
            savedAt: new Date().toISOString(),
            fleet: normalised,
            pendingActiveBoatId: pending,
        } satisfies FleetCacheEnvelope);
        const key = fleetCacheKey(scope);

        try {
            await Preferences.set({ key, value });
        } catch (error) {
            log.warn('could not persist native fleet cache:', error);
        }
        try {
            if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
        } catch {
            // The durable native cache above is enough; caching must never make a
            // valid vessel edit fail just because a browser mirror is unavailable.
        }
    });
}

function newQueueId(): string {
    try {
        return crypto.randomUUID();
    } catch {
        return `vessel_patch_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
    }
}

async function serialiseOutbox<T>(scope: AuthIdentityScope, work: () => Promise<T>): Promise<T> {
    const prior = outboxTails.get(scope.key) ?? Promise.resolve();
    const operation = prior.catch(() => undefined).then(work);
    outboxTails.set(
        scope.key,
        operation.then(
            () => undefined,
            () => undefined,
        ),
    );
    return operation;
}

function mergePatch(left: VesselProfilePatch, right: VesselProfilePatch): VesselProfilePatch {
    return {
        ...(left.profile || right.profile ? { profile: { ...(left.profile ?? {}), ...(right.profile ?? {}) } } : {}),
        ...(left.vesselUnits || right.vesselUnits
            ? { vesselUnits: { ...(left.vesselUnits ?? {}), ...(right.vesselUnits ?? {}) } }
            : {}),
        ...(left.comfortParams || right.comfortParams
            ? { comfortParams: { ...(left.comfortParams ?? {}), ...(right.comfortParams ?? {}) } }
            : {}),
        ...(right.setPolarData || left.setPolarData
            ? { polarData: right.setPolarData ? right.polarData : left.polarData, setPolarData: true }
            : {}),
        ...(right.setPolarBoatModel || left.setPolarBoatModel
            ? {
                  polarBoatModel: right.setPolarBoatModel ? right.polarBoatModel : left.polarBoatModel,
                  setPolarBoatModel: true,
              }
            : {}),
        ...(right.setPolarSourceType || left.setPolarSourceType
            ? {
                  polarSourceType: right.setPolarSourceType ? right.polarSourceType : left.polarSourceType,
                  setPolarSourceType: true,
              }
            : {}),
    };
}

function parseOutboxSnapshot(
    value: string,
    scope: AuthIdentityScope,
): { entries: QueuedVesselPatch[]; savedAt: number } | null {
    try {
        const parsed = JSON.parse(value) as Partial<OutboxEnvelope>;
        if (
            parsed.version !== OUTBOX_VERSION ||
            parsed.ownerUserId !== scope.userId ||
            !Array.isArray(parsed.entries)
        ) {
            return null;
        }
        const entries = parsed.entries.filter(
            (item): item is QueuedVesselPatch =>
                isRecord(item) &&
                typeof item.id === 'string' &&
                typeof item.ownerUserId === 'string' &&
                item.ownerUserId === scope.userId &&
                typeof item.boatId === 'string' &&
                isRecord(item.patch),
        );
        return {
            entries,
            savedAt: Date.parse(typeof parsed.savedAt === 'string' ? parsed.savedAt : '') || 0,
        };
    } catch {
        return null;
    }
}

async function readOutbox(scope: AuthIdentityScope): Promise<QueuedVesselPatch[]> {
    if (!scope.userId) return [];
    try {
        const key = outboxKey(scope);
        const values: string[] = [];
        try {
            const nativeValue = (await Preferences.get({ key })).value ?? null;
            if (nativeValue) values.push(nativeValue);
        } catch {
            /* browser mirror may still be available */
        }
        try {
            const browserValue = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
            if (browserValue && !values.includes(browserValue)) values.push(browserValue);
        } catch {
            /* optional browser mirror */
        }
        if (!values.length || !isAuthIdentityScopeCurrent(scope)) return [];
        const newest = values
            .map((value) => parseOutboxSnapshot(value, scope))
            .filter((snapshot): snapshot is { entries: QueuedVesselPatch[]; savedAt: number } => snapshot !== null)
            .sort((left, right) => right.savedAt - left.savedAt)[0];
        return newest?.entries ?? [];
    } catch {
        return [];
    }
}

async function writeOutbox(scope: AuthIdentityScope, entries: QueuedVesselPatch[]): Promise<void> {
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return;
    const key = outboxKey(scope);
    const value = JSON.stringify({
        version: OUTBOX_VERSION,
        ownerUserId: scope.userId,
        entries,
        savedAt: new Date().toISOString(),
    } satisfies OutboxEnvelope);
    let nativeSaved = false;
    try {
        await Preferences.set({ key, value });
        nativeSaved = true;
    } catch {
        // Browser dev and a temporarily unavailable native bridge still get
        // a scoped durable queue. It is never shared between accounts.
    }
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
    } catch (error) {
        if (!nativeSaved) {
            throw new Error(`Could not persist vessel sync queue: ${rpcError(error, 'storage unavailable').message}`);
        }
    }
}

/**
 * Drop all unsent edits for a vessel that has just been archived. Historic
 * voyage data remains intact; only changes that can no longer be valid are
 * removed so they cannot block another vessel's FIFO sync forever.
 */
export async function discardQueuedVesselPatchesForBoat(
    boatId: string,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<number> {
    if (!scope.userId || !boatId.trim() || !isAuthIdentityScopeCurrent(scope)) return 0;
    return serialiseOutbox(scope, async () => {
        const entries = await readOutbox(scope);
        if (!isAuthIdentityScopeCurrent(scope)) return 0;
        const next = entries.filter((entry) => entry.boatId !== boatId);
        if (next.length !== entries.length) await writeOutbox(scope, next);
        return entries.length - next.length;
    });
}

/** Remove queued edits targeting vessels no longer present in the cloud fleet. */
export async function discardQueuedVesselPatchesExcept(
    activeBoatIds: Iterable<string>,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<number> {
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope)) return 0;
    const valid = new Set(activeBoatIds);
    return serialiseOutbox(scope, async () => {
        const entries = await readOutbox(scope);
        if (!isAuthIdentityScopeCurrent(scope)) return 0;
        const next = entries.filter((entry) => valid.has(entry.boatId));
        if (next.length !== entries.length) await writeOutbox(scope, next);
        return entries.length - next.length;
    });
}

/** Exposed to the store so a partial sync can keep its local profile projection. */
export async function getQueuedVesselPatches(
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<QueuedVesselPatch[]> {
    return serialiseOutbox(scope, () => readOutbox(scope));
}

/** Persist and coalesce an offline patch for this exact signed-in account. */
export async function queueVesselPatch(
    input: QueueVesselPatchInput,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<QueuedVesselPatch[]> {
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope) || !input.boatId.trim()) return [];
    if (isRetiredBoat(scope, input.boatId)) return readOutbox(scope);
    return serialiseOutbox(scope, async () => {
        const entries = await readOutbox(scope);
        if (!isAuthIdentityScopeCurrent(scope)) return entries;
        const normalisedInput: QueueVesselPatchInput = {
            ...input,
            patch: normaliseVesselProfilePatchForCloud(input.patch),
        };
        const current = entries.find((entry) => entry.boatId === normalisedInput.boatId);
        const merged: QueuedVesselPatch = {
            id: current?.id ?? newQueueId(),
            ownerUserId: scope.userId!,
            boatId: normalisedInput.boatId,
            patch: mergePatch(current?.patch ?? {}, normalisedInput.patch),
            revision: normalisedInput.revision ?? current?.revision ?? null,
            // Deliberately retain queuedAt as the FIFO position. The exact
            // snapshot comparison below uses the full entry, so a merge made
            // while an old delivery is in flight cannot be removed by it.
            queuedAt: current?.queuedAt ?? new Date().toISOString(),
        };
        const next = current
            ? entries.map((entry) => (entry.id === current.id ? merged : entry))
            : [...entries, merged];
        await writeOutbox(scope, next);
        return next;
    });
}

function sameQueuedSnapshot(current: QueuedVesselPatch, sent: QueueSnapshot): boolean {
    return (
        current.id === sent.id &&
        current.revision === sent.revision &&
        current.queuedAt === sent.queuedAt &&
        JSON.stringify(current.patch) === JSON.stringify(sent.patch)
    );
}

/**
 * Drain queue FIFO. A failed patch and every later patch stay durable: later
 * patches may depend on fields created by the earlier one and reordering
 * would make a multi-device conflict harder to reason about.
 */
export async function drainQueuedVesselPatches(
    push: (entry: QueuedVesselPatch) => Promise<unknown>,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<{ flushed: number; pending: number }> {
    const entries = await serialiseOutbox(scope, () => readOutbox(scope));
    let flushed = 0;
    for (const entry of entries) {
        if (!isAuthIdentityScopeCurrent(scope)) break;
        try {
            await push(entry);
            const removed = await serialiseOutbox(scope, async () => {
                const currentEntries = await readOutbox(scope);
                if (!isAuthIdentityScopeCurrent(scope)) return false;
                const current = currentEntries.find((candidate) => candidate.id === entry.id);
                // A new edit was coalesced into this queue item after the
                // network request began. Leave it intact; it will be retried
                // as the newer patch rather than being silently discarded.
                if (!current || !sameQueuedSnapshot(current, entry)) return false;
                await writeOutbox(
                    scope,
                    currentEntries.filter((candidate) => candidate.id !== entry.id),
                );
                return true;
            });
            if (removed) flushed += 1;
        } catch (error) {
            log.warn('fleet patch remains queued:', error);
            break;
        }
    }
    const pending = (await serialiseOutbox(scope, () => readOutbox(scope))).length;
    return { flushed, pending };
}

/**
 * The claim/release RPCs signal their two business refusals with
 * `RAISE EXCEPTION '<TOKEN>' USING ERRCODE = 'P0001', DETAIL, HINT`; PostgREST
 * surfaces those as `message` (starts with the token), `details` and `hint`.
 * Map them to typed errors BEFORE the generic Error pass-through — a
 * PostgrestError is itself an Error instance, and the store branches on the
 * class, never on message text.
 */
function typedRpcError(error: unknown): Error | null {
    if (!isRecord(error) || typeof error.message !== 'string') return null;
    const details = stringValue(error.details);
    const hint = stringValue(error.hint);
    if (error.message.startsWith('MMSI_CLAIMED')) {
        return new VesselClaimedError(details ?? 'Another Thalassa boat', hint ?? '');
    }
    if (error.message.startsWith('VESSEL_RELEASED')) {
        // Contract: DETAIL = name, HINT = `<released_at>|<reason>`. Tolerate
        // the earlier draft that packed all three into DETAIL.
        const detailParts = (details ?? '').split('|');
        const hintParts = (hint ?? '').split('|');
        const name = detailParts[0]?.trim() || 'your released vessel';
        const releasedAt = stringValue(hintParts[0]) ?? stringValue(detailParts[1]);
        const reasonRaw = stringValue(hintParts[1]) ?? stringValue(detailParts[2]);
        return new VesselReleasedError(name, releasedAt, isReleaseReason(reasonRaw) ? reasonRaw : null);
    }
    return null;
}

function rpcError(error: unknown, fallback: string): Error {
    const typed = typedRpcError(error);
    if (typed) return typed;
    if (error instanceof Error) return error;
    if (isRecord(error) && typeof error.message === 'string') return new Error(error.message);
    return new Error(fallback);
}

function rowFromRpc(raw: unknown, ownerId: string): OwnedVesselProfile | null {
    if (Array.isArray(raw)) return normaliseFleetRow(raw[0], ownerId);
    if (isRecord(raw) && Array.isArray(raw.vessels)) return normaliseFleetRow(raw.vessels[0], ownerId);
    return normaliseFleetRow(raw, ownerId);
}

export async function loadOwnedVesselFleet(scope: AuthIdentityScope = getAuthIdentityScope()): Promise<VesselFleet> {
    if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return { vessels: [], activeBoatId: null };
    const { data, error } = await supabase.rpc('get_owned_vessel_fleet');
    if (!isAuthIdentityScopeCurrent(scope)) return { vessels: [], activeBoatId: null };
    if (error) throw rpcError(error, 'Could not load vessel fleet');
    return normalizeVesselFleetPayload(data, scope.userId);
}

async function pushPatch(entry: QueueVesselPatchInput, scope: AuthIdentityScope): Promise<OwnedVesselProfile> {
    if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope))
        throw new Error('Cloud vessel sync is unavailable');
    const patch = normaliseVesselProfilePatchForCloud(entry.patch);
    const { data, error } = await supabase.rpc('patch_owned_vessel_profile', {
        p_boat_id: entry.boatId,
        p_profile_patch: patch.profile ?? {},
        p_vessel_units_patch: patch.vesselUnits ?? {},
        p_polar_data: patch.polarData ?? null,
        p_set_polar_data: patch.setPolarData === true,
        p_polar_boat_model: patch.polarBoatModel ?? null,
        p_set_polar_boat_model: patch.setPolarBoatModel === true,
        p_polar_source_type: patch.polarSourceType ?? null,
        p_set_polar_source_type: patch.setPolarSourceType === true,
        p_comfort_params_patch: patch.comfortParams ?? {},
        p_expected_revision: entry.revision ?? null,
    });
    if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Account changed during vessel sync');
    if (error) throw rpcError(error, 'Could not save vessel profile');
    const result = rowFromRpc(data, scope.userId);
    if (!result) throw new Error('The vessel server returned an invalid profile');
    return result;
}

/** Save a field patch now; retain it locally if there is no usable network. */
export async function patchOwnedVesselProfile(
    input: QueueVesselPatchInput,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<FleetMutationResult<OwnedVesselProfile>> {
    return serialiseBoatMutation(scope, input.boatId, async () => {
        if (isRetiredBoat(scope, input.boatId)) {
            return {
                value: null,
                queued: false,
                error: new Error('This vessel has been archived and can no longer be edited.'),
            } satisfies FleetMutationResult<OwnedVesselProfile>;
        }
        // Never send a newer edit ahead of an older queued edit for this
        // boat. Coalescing preserves the newest value for each field and
        // prevents an old offline draft from later overwriting it.
        const pending = await readOutbox(scope);
        if (pending.some((entry) => entry.boatId === input.boatId)) {
            await queueVesselPatch(input, scope);
            return { value: null, queued: true } satisfies FleetMutationResult<OwnedVesselProfile>;
        }
        try {
            const value = await pushPatch(input, scope);
            return { value, queued: false } satisfies FleetMutationResult<OwnedVesselProfile>;
        } catch (error) {
            // An archive that completed while this request was in flight is
            // terminal, not an offline edit to retry forever.
            if (isRetiredBoat(scope, input.boatId)) {
                return {
                    value: null,
                    queued: false,
                    error: new Error('This vessel was archived before its pending edit could be saved.'),
                } satisfies FleetMutationResult<OwnedVesselProfile>;
            }
            await queueVesselPatch(input, scope);
            return {
                value: null,
                queued: true,
                error: rpcError(error, 'Could not save vessel profile'),
            } satisfies FleetMutationResult<OwnedVesselProfile>;
        }
    });
}

export async function flushQueuedVesselPatches(
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<{ flushed: number; pending: number }> {
    return drainQueuedVesselPatches((entry) => pushPatch(entry, scope), scope);
}

function fleetCreateRpcArgs(profile: VesselProfile, extras: Omit<VesselProfilePatch, 'profile'>) {
    return {
        p_profile: profile,
        p_vessel_units: extras.vesselUnits ?? {},
        p_polar_data: extras.polarData ?? null,
        p_polar_boat_model: extras.polarBoatModel ?? null,
        p_polar_source_type: extras.polarSourceType ?? null,
        p_comfort_params: extras.comfortParams ?? {},
    };
}

function isMissingBootstrapRpc(error: unknown): boolean {
    if (!isRecord(error)) return false;
    const message = typeof error.message === 'string' ? error.message : '';
    const code = typeof error.code === 'string' ? error.code : '';
    return code === 'PGRST202' || /bootstrap_owned_vessel_profile|could not find the function/i.test(message);
}

/**
 * Idempotent first-cloud-connect bootstrap. The database holds the owner lock
 * so two fresh devices cannot manufacture two copies of the same first boat.
 */
export async function bootstrapOwnedVesselProfile(
    profile: VesselProfile,
    extras: Omit<VesselProfilePatch, 'profile'> = {},
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<OwnedVesselProfile> {
    if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) {
        throw new Error('Connect to the internet before setting up your vessel profile.');
    }
    const { data, error } = await supabase.rpc('bootstrap_owned_vessel_profile', fleetCreateRpcArgs(profile, extras));
    if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Account changed while setting up vessel profile');
    // Keeps staged clients usable if code is shipped shortly before the
    // migration. Once the migration is live, this path is never taken.
    if (error && isMissingBootstrapRpc(error)) return createOwnedVesselProfile(profile, extras, scope);
    if (error) throw rpcError(error, 'Could not set up vessel profile');
    const result = rowFromRpc(data, scope.userId);
    if (!result) throw new Error('The vessel server returned an invalid profile');
    return result;
}

export async function createOwnedVesselProfile(
    profile: VesselProfile,
    extras: Omit<VesselProfilePatch, 'profile'> = {},
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<OwnedVesselProfile> {
    if (!canAddOwnedVessel((await loadOwnedVesselFleet(scope)).vessels)) {
        throw new Error(`A skipper can keep up to ${MAX_OWNED_VESSELS} active vessels.`);
    }
    if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) {
        throw new Error('Connect to the internet before adding a new vessel. Existing vessels can still save offline.');
    }
    const { data, error } = await supabase.rpc('create_owned_vessel_profile', fleetCreateRpcArgs(profile, extras));
    if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Account changed while adding vessel');
    if (error) throw rpcError(error, 'Could not add vessel');
    const result = rowFromRpc(data, scope.userId);
    if (!result) throw new Error('The vessel server returned an invalid profile');
    return result;
}

export async function setActiveOwnedVessel(
    boatId: string,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<void> {
    if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope))
        throw new Error('Cloud vessel sync is unavailable');
    const { error } = await supabase.rpc('set_active_owned_vessel', { p_boat_id: boatId });
    if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Account changed while selecting vessel');
    if (error) throw rpcError(error, 'Could not select vessel');
}

export async function archiveOwnedVessel(
    boatId: string,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<void> {
    await serialiseBoatMutation(scope, boatId, async () => {
        if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) {
            throw new Error('Cloud vessel sync is unavailable');
        }
        const { error } = await supabase.rpc('archive_owned_vessel', { p_boat_id: boatId });
        if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Account changed while archiving vessel');
        if (error) throw rpcError(error, 'Could not archive vessel');

        // Mark before removing the durable queue so any patch call that was
        // waiting behind this archive returns terminally instead of creating
        // a fresh invalid retry entry.
        markRetiredBoat(scope, boatId);
        await discardQueuedVesselPatchesForBoat(boatId, scope);
    });
}

function normaliseReleaseResult(raw: unknown): ReleaseVesselResult {
    const record = isRecord(raw) ? raw : {};
    return {
        released: record.released !== false,
        remainingActiveBoats: finiteNumber(record.remaining_active_boats, 0),
        nextActiveBoatId: stringValue(record.next_active_boat_id),
        crewRemoved: finiteNumber(record.crew_removed, 0),
        invitesRevoked: finiteNumber(record.invites_revoked, 0),
        relaysRemoved: finiteNumber(record.relays_removed, 0),
        relaysUnmatched: finiteNumber(record.relays_unmatched, 0),
        telemetryCleared: finiteNumber(record.telemetry_cleared, 0),
        publicPagesDisabled: finiteNumber(record.public_pages_disabled, 0),
    };
}

function isOffline(): boolean {
    return typeof navigator !== 'undefined' && navigator.onLine === false;
}

/**
 * Release a hull (sold, delivery finished, or something else). Archives under
 * the same owner so every voyage/track/diary row keeps its `boat_id`; the
 * server removes crew, unpairs the hull's Pi relay, clears telemetry, darkens
 * the public page and frees the MMSI. Shares the archive mutation lane so it
 * can never race an in-flight patch, and is NEVER queued: offline it refuses
 * with a clear sentence and nothing changes (2026-09-08 decision, gate 2).
 */
export async function releaseOwnedVessel(
    boatId: string,
    reason: ReleaseReason,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<ReleaseVesselResult> {
    return serialiseBoatMutation(scope, boatId, async () => {
        if (isOffline() || !supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) {
            throw new Error(RELEASE_OFFLINE_MESSAGE);
        }
        const { data, error } = await supabase.rpc('release_owned_vessel', { p_boat_id: boatId, p_reason: reason });
        if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Account changed while releasing vessel');
        if (error) throw rpcError(error, 'Could not release vessel');

        // Same order as archive: retire first so a patch waiting behind this
        // release returns terminally rather than re-queueing for a hull that
        // may belong to someone else by the time it would replay.
        markRetiredBoat(scope, boatId);
        await discardQueuedVesselPatchesForBoat(boatId, scope);
        return normaliseReleaseResult(data);
    });
}

/**
 * The 'oops' path: un-archive a hull this account released within 30 days.
 * Crew, relay rows and the public page are NOT restored (the owner re-invites,
 * re-pairs and re-enables); `claimLost` reports that the buyer claimed the
 * MMSI meanwhile. Not queued either — undo is meaningful only online.
 */
export async function undoVesselRelease(
    boatId: string,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<UndoReleaseResult> {
    return serialiseBoatMutation(scope, boatId, async () => {
        if (isOffline() || !supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) {
            throw new Error('Undoing a release needs a connection. Nothing has changed.');
        }
        const { data, error } = await supabase.rpc('undo_vessel_release', { p_boat_id: boatId });
        if (!isAuthIdentityScopeCurrent(scope)) throw new Error('Account changed while restoring vessel');
        if (error) throw rpcError(error, 'Could not undo the release');
        const record = isRecord(data) ? data : {};
        const restored = record.restored !== false;
        if (restored) unmarkRetiredBoat(scope, boatId);
        return { restored, claimLost: record.claim_lost === true };
    });
}

/**
 * PostgREST's "no such function" reply (PGRST202) — a client shipped ahead of
 * the 20260908170000_vessel_claim_and_release migration. Deliberately NOT
 * "message mentions the function":
 * a permission error naming it must still surface.
 */
function isMissingRpc(error: unknown): boolean {
    if (!isRecord(error)) return false;
    const message = typeof error.message === 'string' ? error.message : '';
    const code = typeof error.code === 'string' ? error.code : '';
    return code === 'PGRST202' || /could not find the function/i.test(message);
}

/**
 * Hulls this account released in the last 30 days, newest first, for the
 * 'You released Serene Summer on 8 Sep (sold)' rows and their Undo button.
 * A client shipped ahead of the migration sees an empty list, not an error.
 */
export async function loadReleasedVessels(
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<ReleasedVesselRow[]> {
    if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return [];
    const { data, error } = await supabase.rpc('get_released_vessels');
    if (!isAuthIdentityScopeCurrent(scope)) return [];
    if (error && isMissingRpc(error)) return [];
    if (error) throw rpcError(error, 'Could not load released vessels');
    const rows = Array.isArray(data) ? data : isRecord(data) && Array.isArray(data.vessels) ? data.vessels : [];
    const ownerId = scope.userId;
    const released: ReleasedVesselRow[] = [];
    for (const raw of rows) {
        const row = normaliseFleetRow(raw, ownerId);
        if (!row || !row.releasedAt) continue;
        released.push({
            boatId: row.id,
            name: row.profile.name,
            releasedAt: row.releasedAt,
            releaseReason: row.releaseReason ?? 'other',
        });
    }
    return released.sort(
        (left, right) =>
            Date.parse(right.releasedAt) - Date.parse(left.releasedAt) || left.boatId.localeCompare(right.boatId),
    );
}

export function defaultVesselProfile(name = 'New Vessel'): VesselProfile {
    return {
        name,
        type: 'sail',
        length: 0,
        beam: 0,
        draft: 0,
        displacement: 0,
        maxWaveHeight: 0,
        cruisingSpeed: 0,
        fuelCapacity: 0,
        waterCapacity: 0,
    };
}
