/**
 * VesselIdentityService — Syncs vessel "DNA" between Supabase and local storage.
 *
 * The vessel identity (name, rego, MMSI, call sign, phonetic name) is stored in
 * Supabase and cached locally for offline use (RadioConsole, VHF reports, etc.).
 */

import { supabase } from './supabase';
import { createLogger } from '../utils/createLogger';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from './authIdentityScope';

const log = createLogger('VesselIdentity');
const LOCAL_KEY = 'thalassa_vessel_identity';
const CACHE_VERSION = 1;
const MAX_ID_LENGTH = 512;
const MAX_TEXT_LENGTH = 4096;
const MAX_TIMESTAMP_LENGTH = 128;
const MAX_CREW_MEMBERSHIP_ROWS = 256;
const IDENTITY_COLUMNS =
    'id,owner_id,vessel_name,reg_number,mmsi,call_sign,phonetic_name,vessel_type,hull_color,model,updated_at';

const TEXT_UPDATE_FIELDS = [
    'vessel_name',
    'reg_number',
    'mmsi',
    'call_sign',
    'phonetic_name',
    'hull_color',
    'model',
] as const;
const UPDATE_FIELDS = new Set<string>([...TEXT_UPDATE_FIELDS, 'vessel_type']);
const VESSEL_TYPES = new Set<VesselIdentity['vessel_type']>(['sail', 'power', 'observer']);

type CacheAccess = 'owner' | 'accepted_crew';

interface CachedIdentityRecord {
    version: typeof CACHE_VERSION;
    cached_for_user_id: string;
    access: CacheAccess;
    identity: VesselIdentity;
}

function storageKey(scope: AuthIdentityScope): string {
    return authScopedStorageKey(LOCAL_KEY, scope);
}

function identityStillOwns(scope: AuthIdentityScope, userId: string): boolean {
    return isAuthIdentityScopeCurrent(scope) && scope.userId === userId;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: PropertyKey): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
}

function ownDataValue(value: object, key: PropertyKey): unknown {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && 'value' in descriptor ? descriptor.value : undefined;
}

function nonEmptyString(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function validIdentifier(value: unknown): value is string {
    return nonEmptyString(value) && value.length <= MAX_ID_LENGTH;
}

function validText(value: unknown): value is string {
    return typeof value === 'string' && value.length <= MAX_TEXT_LENGTH;
}

// ── Types ──────────────────────────────────────────────────────

export interface VesselIdentity {
    id: string;
    owner_id: string;
    vessel_name: string;
    reg_number: string;
    mmsi: string;
    call_sign: string;
    phonetic_name: string;
    vessel_type: 'sail' | 'power' | 'observer';
    hull_color: string;
    model: string;
    updated_at: string;
}

/**
 * Validate untrusted database/cache input and copy only the public identity
 * fields. Nullable database text columns are normalised before being cached;
 * persisted cache records must already have the exact public shape.
 */
function parseIdentity(value: unknown, expectedOwnerId: string, allowDatabaseNulls: boolean): VesselIdentity | null {
    if (!isRecord(value)) return null;

    const id = ownDataValue(value, 'id');
    const ownerId = ownDataValue(value, 'owner_id');
    const vesselName = ownDataValue(value, 'vessel_name');
    const updatedAt = ownDataValue(value, 'updated_at');
    const vesselType = ownDataValue(value, 'vessel_type');
    if (!validIdentifier(id) || !validIdentifier(ownerId) || ownerId !== expectedOwnerId) return null;
    if (!validText(vesselName) || typeof updatedAt !== 'string' || updatedAt.length > MAX_TIMESTAMP_LENGTH) return null;
    if (!VESSEL_TYPES.has(vesselType as VesselIdentity['vessel_type'])) return null;

    const nullableText = (key: (typeof TEXT_UPDATE_FIELDS)[number]): string | null => {
        const field = ownDataValue(value, key);
        if (validText(field)) return field;
        return allowDatabaseNulls && field === null ? '' : null;
    };

    const regNumber = nullableText('reg_number');
    const mmsi = nullableText('mmsi');
    const callSign = nullableText('call_sign');
    const phoneticName = nullableText('phonetic_name');
    const hullColor = nullableText('hull_color');
    const model = nullableText('model');
    if (
        regNumber === null ||
        mmsi === null ||
        callSign === null ||
        phoneticName === null ||
        hullColor === null ||
        model === null
    ) {
        return null;
    }

    return {
        id,
        owner_id: expectedOwnerId,
        vessel_name: vesselName,
        reg_number: regNumber,
        mmsi,
        call_sign: callSign,
        phonetic_name: phoneticName,
        vessel_type: vesselType as VesselIdentity['vessel_type'],
        hull_color: hullColor,
        model,
        updated_at: updatedAt,
    };
}

function parseCacheRecord(value: unknown, scope: AuthIdentityScope): VesselIdentity | null {
    if (!scope.userId || !isRecord(value)) return null;
    const version = ownDataValue(value, 'version');
    const cachedForUserId = ownDataValue(value, 'cached_for_user_id');
    const access = ownDataValue(value, 'access');
    if (
        version !== CACHE_VERSION ||
        cachedForUserId !== scope.userId ||
        (access !== 'owner' && access !== 'accepted_crew')
    ) {
        return null;
    }

    const rawIdentity = ownDataValue(value, 'identity');
    if (!isRecord(rawIdentity)) return null;
    const ownerId = ownDataValue(rawIdentity, 'owner_id');
    if (!validIdentifier(ownerId)) return null;
    const identity = parseIdentity(rawIdentity, ownerId, false);
    if (!identity) return null;

    const provenanceMatches =
        access === 'owner' ? identity.owner_id === scope.userId : identity.owner_id !== scope.userId;
    return provenanceMatches ? identity : null;
}

function cacheAccessMatches(identity: VesselIdentity, userId: string, access: CacheAccess): boolean {
    return access === 'owner' ? identity.owner_id === userId : identity.owner_id !== userId;
}

// ── Local Cache ────────────────────────────────────────────────

function cacheIdentity(identity: VesselIdentity, scope: AuthIdentityScope, access: CacheAccess): boolean {
    const userId = scope.userId;
    if (!userId || !identityStillOwns(scope, userId) || !cacheAccessMatches(identity, userId, access)) {
        return false;
    }

    const record: CachedIdentityRecord = {
        version: CACHE_VERSION,
        cached_for_user_id: userId,
        access,
        identity,
    };

    try {
        const serialized = JSON.stringify(record);
        // JSON serialisation is normally inert because `identity` was copied by
        // parseIdentity. Keep the fence immediately adjacent to the write too.
        if (!identityStillOwns(scope, userId)) return false;
        localStorage.setItem(storageKey(scope), serialized);
        return identityStillOwns(scope, userId);
    } catch {
        return false;
    }
}

function clearCachedIdentity(scope: AuthIdentityScope, userId: string): void {
    if (!identityStillOwns(scope, userId)) return;
    try {
        localStorage.removeItem(storageKey(scope));
        if (!identityStillOwns(scope, userId)) return;

        // Remove an old unscoped owner cache only when it demonstrably belongs
        // to this account. Never delete another account's legacy data.
        const legacy = localStorage.getItem(LOCAL_KEY);
        if (!legacy || !identityStillOwns(scope, userId)) return;
        const legacyIdentity = parseIdentity(JSON.parse(legacy), userId, true);
        if (legacyIdentity && identityStillOwns(scope, userId)) {
            localStorage.removeItem(LOCAL_KEY);
        }
    } catch {
        /* storage unavailable — silently fail */
    }
}

function readCachedIdentity(scope: AuthIdentityScope): VesselIdentity | null {
    const userId = scope.userId;
    if (!userId || !identityStillOwns(scope, userId)) return null;

    try {
        const scoped = localStorage.getItem(storageKey(scope));
        if (!identityStillOwns(scope, userId)) return null;
        if (scoped) {
            const parsed: unknown = JSON.parse(scoped);
            if (!identityStillOwns(scope, userId)) return null;

            const recordIdentity = parseCacheRecord(parsed, scope);
            if (recordIdentity) return identityStillOwns(scope, userId) ? recordIdentity : null;

            // Early auth-scoping builds stored the raw identity at the scoped
            // key. Only an owner row has enough provenance to migrate safely.
            const scopedOwner = parseIdentity(parsed, userId, true);
            if (scopedOwner && identityStillOwns(scope, userId)) {
                cacheIdentity(scopedOwner, scope, 'owner');
                return identityStillOwns(scope, userId) ? scopedOwner : null;
            }
        }

        // The original unscoped cache is also safe to migrate only for its
        // owner. A crew cache cannot prove which signed-in member produced it.
        const legacy = localStorage.getItem(LOCAL_KEY);
        if (!legacy || !identityStillOwns(scope, userId)) return null;
        const legacyOwner = parseIdentity(JSON.parse(legacy), userId, true);
        if (!legacyOwner || !identityStillOwns(scope, userId)) return null;
        cacheIdentity(legacyOwner, scope, 'owner');
        return identityStillOwns(scope, userId) ? legacyOwner : null;
    } catch {
        return null;
    }
}

/** Get a strictly validated identity cached for the current signed-in account. */
export function getCachedIdentity(): VesselIdentity | null {
    return readCachedIdentity(getAuthIdentityScope());
}

function cachedFallback(scope: AuthIdentityScope, userId: string): VesselIdentity | null {
    return identityStillOwns(scope, userId) ? readCachedIdentity(scope) : null;
}

// ── Supabase Sync ──────────────────────────────────────────────

function errorMessage(error: unknown): string {
    if (!isRecord(error)) return 'Unknown error';
    const message = ownDataValue(error, 'message');
    return typeof message === 'string' ? message : 'Unknown error';
}

function resolveUniqueCrewOwner(value: unknown, userId: string): string | null {
    if (!Array.isArray(value) || value.length > MAX_CREW_MEMBERSHIP_ROWS) return null;

    const ownerIds = new Set<string>();
    for (const membership of value) {
        if (!isRecord(membership)) return null;
        const ownerId = ownDataValue(membership, 'owner_id');
        const crewUserId = ownDataValue(membership, 'crew_user_id');
        const status = ownDataValue(membership, 'status');
        if (!validIdentifier(ownerId) || crewUserId !== userId || status !== 'accepted' || ownerId === userId) {
            return null;
        }
        ownerIds.add(ownerId);
    }

    return ownerIds.size === 1 ? [...ownerIds][0] : null;
}

function buildSafeUpdates(value: unknown): Partial<Omit<VesselIdentity, 'id' | 'owner_id' | 'updated_at'>> | null {
    try {
        if (!isRecord(value)) return null;
        const keys = Reflect.ownKeys(value);
        if (keys.some((key) => typeof key !== 'string' || !UPDATE_FIELDS.has(key))) return null;

        const safe: Partial<Omit<VesselIdentity, 'id' | 'owner_id' | 'updated_at'>> = {};
        for (const field of TEXT_UPDATE_FIELDS) {
            if (!hasOwn(value, field)) continue;
            const descriptor = Object.getOwnPropertyDescriptor(value, field);
            if (!descriptor || !('value' in descriptor) || !validText(descriptor.value)) return null;
            safe[field] = descriptor.value;
        }

        if (hasOwn(value, 'vessel_type')) {
            const descriptor = Object.getOwnPropertyDescriptor(value, 'vessel_type');
            if (
                !descriptor ||
                !('value' in descriptor) ||
                !VESSEL_TYPES.has(descriptor.value as VesselIdentity['vessel_type'])
            ) {
                return null;
            }
            safe.vessel_type = descriptor.value as VesselIdentity['vessel_type'];
        }

        return safe;
    } catch {
        return null;
    }
}

/**
 * Pull vessel identity from Supabase and cache locally.
 * Called at app boot and after any update.
 */
export async function syncIdentity(): Promise<VesselIdentity | null> {
    if (!supabase) return getCachedIdentity();
    const identityScope = getAuthIdentityScope();

    try {
        const authResult = await supabase.auth.getUser();
        if (!isAuthIdentityScopeCurrent(identityScope)) return null;
        const userId = authResult?.data?.user?.id;
        if (!validIdentifier(userId) || !identityStillOwns(identityScope, userId)) return null;

        // Owner always wins. Both the request filter and returned row are
        // checked; RLS is defence in depth, not the client provenance check.
        const ownerResult = await supabase
            .from('vessel_identity')
            .select(IDENTITY_COLUMNS)
            .eq('owner_id', userId)
            .maybeSingle();
        if (!identityStillOwns(identityScope, userId)) return null;
        if (ownerResult.error) {
            log.warn('[VesselIdentity] Owner sync error:', errorMessage(ownerResult.error));
            return cachedFallback(identityScope, userId);
        }
        if (ownerResult.data !== null) {
            const ownerIdentity = parseIdentity(ownerResult.data, userId, true);
            if (!ownerIdentity) {
                clearCachedIdentity(identityScope, userId);
                return null;
            }
            cacheIdentity(ownerIdentity, identityScope, 'owner');
            return identityStillOwns(identityScope, userId) ? ownerIdentity : null;
        }

        // A user may be accepted on more than one vessel. Read all matching
        // memberships and resolve only when every row has exact provenance and
        // all rows point to one owner (duplicate per-voyage rows are harmless).
        const crewResult = await supabase
            .from('vessel_crew')
            .select('owner_id,crew_user_id,status')
            .eq('crew_user_id', userId)
            .eq('status', 'accepted')
            .limit(MAX_CREW_MEMBERSHIP_ROWS + 1);
        if (!identityStillOwns(identityScope, userId)) return null;
        if (crewResult.error) {
            log.warn('[VesselIdentity] Crew sync error:', errorMessage(crewResult.error));
            return cachedFallback(identityScope, userId);
        }

        const crewOwnerId = resolveUniqueCrewOwner(crewResult.data, userId);
        if (!crewOwnerId) {
            clearCachedIdentity(identityScope, userId);
            return null;
        }

        const crewVesselResult = await supabase
            .from('vessel_identity')
            .select(IDENTITY_COLUMNS)
            .eq('owner_id', crewOwnerId)
            .maybeSingle();
        if (!identityStillOwns(identityScope, userId)) return null;
        if (crewVesselResult.error) {
            log.warn('[VesselIdentity] Crew vessel sync error:', errorMessage(crewVesselResult.error));
            return cachedFallback(identityScope, userId);
        }

        const crewIdentity = parseIdentity(crewVesselResult.data, crewOwnerId, true);
        if (!crewIdentity) {
            clearCachedIdentity(identityScope, userId);
            return null;
        }
        cacheIdentity(crewIdentity, identityScope, 'accepted_crew');
        return identityStillOwns(identityScope, userId) ? crewIdentity : null;
    } catch (error) {
        log.warn('[VesselIdentity] Sync failed:', error);
        const userId = identityScope.userId;
        return userId ? cachedFallback(identityScope, userId) : null;
    }
}

/**
 * Save or update vessel identity (owner only).
 */
export async function saveIdentity(
    updates: Partial<Omit<VesselIdentity, 'id' | 'owner_id' | 'updated_at'>>,
): Promise<VesselIdentity | null> {
    if (!supabase) return null;
    const identityScope = getAuthIdentityScope();
    const safeUpdates = buildSafeUpdates(updates);
    if (!safeUpdates) return null;

    try {
        const authResult = await supabase.auth.getUser();
        if (!isAuthIdentityScopeCurrent(identityScope)) return null;
        const userId = authResult?.data?.user?.id;
        if (!validIdentifier(userId) || !identityStillOwns(identityScope, userId)) return null;

        // Only the explicit allow-list can reach this object. Authoritative
        // ownership/timestamp fields are assigned last and cannot be smuggled
        // through a runtime payload that bypassed the TypeScript signature.
        const payload = {
            ...safeUpdates,
            owner_id: userId,
            updated_at: new Date().toISOString(),
        };
        const saveResult = await supabase
            .from('vessel_identity')
            .upsert(payload, { onConflict: 'owner_id' })
            .select(IDENTITY_COLUMNS)
            .single();
        if (!identityStillOwns(identityScope, userId)) return null;
        if (saveResult.error) {
            log.error('[VesselIdentity] Save error:', errorMessage(saveResult.error));
            return null;
        }

        const identity = parseIdentity(saveResult.data, userId, true);
        if (!identity) return null;
        cacheIdentity(identity, identityScope, 'owner');
        return identityStillOwns(identityScope, userId) ? identity : null;
    } catch (error) {
        log.error('[VesselIdentity] Save failed:', error);
        return null;
    }
}
