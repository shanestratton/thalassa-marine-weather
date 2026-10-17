/** Explicit owner actions only. No module startup, capture switch or cached ON authority. */
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    subscribeAuthIdentityScope,
    type AuthIdentityScope,
} from '../authIdentityScope';
import { loadOwnedVesselFleet } from '../VesselFleetService';
import { supabase } from '../supabase';
import { CROWD_CONSENT_VERSION, parseCrowdCalibration, type CrowdCalibration } from './crowdPolicy';

export interface CrowdPermission {
    revision: string;
    mapEnabled: boolean;
    dcdbEnabled: boolean;
    mapEffectiveFrom: number | null;
    dcdbEffectiveFrom: number | null;
    calibration: CrowdCalibration | null;
}
export interface CrowdOwnedPermission {
    boatId: string;
    boatName: string;
    permission: CrowdPermission | null;
    pendingRevoke: boolean;
}
const lanes = new Map<string, Promise<unknown>>();
const pendingMemory = new Set<string>();
const uuid = (v: unknown): v is string =>
    typeof v === 'string' && /^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(v);
const fail = (): never => {
    throw new Error('Fresh owner sharing settings are unavailable. Nothing was enabled.');
};
const pendingKey = (boatId: string, scope: AuthIdentityScope) =>
    authScopedStorageKey(`seabed_public_revoke_v1:${boatId}`, scope);
const identity = (boatId: string, scope: AuthIdentityScope) => `${scope.key}:${boatId}`;
export function crowdRevokePending(boatId: string, scope = getAuthIdentityScope()): boolean {
    if (!uuid(boatId) || !scope.userId) return true;
    try {
        return pendingMemory.has(identity(boatId, scope)) || localStorage.getItem(pendingKey(boatId, scope)) !== null;
    } catch {
        return true;
    }
}
function markPending(boatId: string, scope: AuthIdentityScope): boolean {
    pendingMemory.add(identity(boatId, scope));
    try {
        const key = pendingKey(boatId, scope);
        localStorage.setItem(key, JSON.stringify({ schema: 1, boatId }));
        return localStorage.getItem(key) !== null;
    } catch {
        return false;
    }
}
function clearPending(boatId: string, scope: AuthIdentityScope) {
    if (!isAuthIdentityScopeCurrent(scope)) return fail();
    localStorage.removeItem(pendingKey(boatId, scope));
    pendingMemory.delete(identity(boatId, scope));
}
function parsePermission(value: unknown, boatId: string, scope: AuthIdentityScope): CrowdPermission {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
    const v = value as Record<string, unknown>;
    if (
        v.owner_id !== scope.userId ||
        v.boat_id !== boatId ||
        !uuid(v.revision) ||
        v.consent_version !== CROWD_CONSENT_VERSION ||
        typeof v.map_enabled !== 'boolean' ||
        typeof v.dcdb_enabled !== 'boolean'
    )
        return fail();
    const time = (raw: unknown, enabled: boolean): number | null => {
        if (!enabled) {
            if (raw !== null) return fail();
            return null;
        }
        const ms = typeof raw === 'string' ? Date.parse(raw) : NaN;
        if (!Number.isSafeInteger(ms) || ms < Date.UTC(2020, 0, 1) || ms > Date.now() + 60000) return fail();
        return ms;
    };
    let calibration: CrowdCalibration | null = null;
    if (v.calibration !== null) {
        try {
            calibration = parseCrowdCalibration(v.calibration, Date.now());
        } catch {
            if (v.map_enabled || v.dcdb_enabled) return fail();
        }
    }
    if ((v.map_enabled || v.dcdb_enabled) && !calibration) return fail();
    return {
        revision: v.revision,
        mapEnabled: v.map_enabled,
        dcdbEnabled: v.dcdb_enabled,
        mapEffectiveFrom: time(v.map_effective_from, v.map_enabled),
        dcdbEffectiveFrom: time(v.dcdb_effective_from, v.dcdb_enabled),
        calibration,
    };
}
async function bounded<T>(
    scope: AuthIdentityScope,
    signal: AbortSignal | undefined,
    work: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
    if (!scope.userId || !isAuthIdentityScopeCurrent(scope) || signal?.aborted) return fail();
    const abort = new AbortController();
    const retire = () => abort.abort();
    signal?.addEventListener('abort', retire, { once: true });
    const unsubscribe = subscribeAuthIdentityScope(retire),
        timer = setTimeout(retire, 10000);
    let listener: (() => void) | undefined;
    const cancelled = new Promise<never>((_, reject) => {
        listener = () => reject(new DOMException('Sharing settings retired', 'AbortError'));
        abort.signal.addEventListener('abort', listener, { once: true });
    });
    try {
        const value = await Promise.race([work(abort.signal), cancelled]);
        if (abort.signal.aborted || !isAuthIdentityScopeCurrent(scope)) return fail();
        return value;
    } finally {
        clearTimeout(timer);
        unsubscribe();
        signal?.removeEventListener('abort', retire);
        if (listener) abort.signal.removeEventListener('abort', listener);
        abort.abort();
    }
}
async function owned(boatId: string, scope: AuthIdentityScope) {
    if (!uuid(boatId)) return fail();
    const fleet = await loadOwnedVesselFleet(scope);
    const boat = fleet.vessels.find(
        (v) => v.id === boatId && v.owner_id === scope.userId && !v.archived_at && !v.releasedAt,
    );
    if (!boat || !isAuthIdentityScopeCurrent(scope)) return fail();
    return boat;
}
export async function readCrowdPermission(boatId: string, signal?: AbortSignal): Promise<CrowdOwnedPermission> {
    const scope = getAuthIdentityScope();
    return bounded(scope, signal, async (abort) => {
        const client = supabase;
        if (!client) return fail();
        const boat = await owned(boatId, scope);
        if (abort.aborted) return fail();
        const { data, error } = await client
            .from('seabed_publication_consents')
            .select('*')
            .eq('owner_id', scope.userId!)
            .eq('boat_id', boatId)
            .abortSignal(abort)
            .maybeSingle();
        if (error || abort.aborted || !isAuthIdentityScopeCurrent(scope)) return fail();
        return {
            boatId,
            boatName: boat.profile.name,
            permission: data === null ? null : parsePermission(data, boatId, scope),
            pendingRevoke: crowdRevokePending(boatId, scope),
        };
    });
}
async function serial<T>(boatId: string, scope: AuthIdentityScope, work: () => Promise<T>): Promise<T> {
    const key = identity(boatId, scope),
        before = lanes.get(key) ?? Promise.resolve();
    const next = before.catch(() => undefined).then(work);
    lanes.set(key, next);
    try {
        return await next;
    } finally {
        if (lanes.get(key) === next) lanes.delete(key);
    }
}
async function revoke(boatId: string, scope: AuthIdentityScope): Promise<CrowdPermission | null> {
    try {
        return await bounded(scope, undefined, async (abort) => {
            const client = supabase;
            if (!client) return null;
            const { data, error } = await client
                .rpc('set_seabed_publication', {
                    p_boat_id: boatId,
                    p_expected_revision: null,
                    p_map_enabled: false,
                    p_dcdb_enabled: false,
                    p_terms_version: null,
                    p_calibration: null,
                })
                .abortSignal(abort);
            if (error || abort.aborted || !isAuthIdentityScopeCurrent(scope)) return null;
            const value = parsePermission(data, boatId, scope);
            if (value.mapEnabled || value.dcdbEnabled) return null;
            clearPending(boatId, scope);
            return value;
        });
    } catch {
        return null;
    }
}
/** OFF is one action and remains queued only in this owner's boat namespace. */
export async function revokeCrowdPermission(boatId: string): Promise<'saved' | 'pending' | 'not-retained'> {
    const scope = getAuthIdentityScope();
    if (!scope.userId || !uuid(boatId)) return fail();
    const retained = markPending(boatId, scope);
    return serial(boatId, scope, async () =>
        (await revoke(boatId, scope)) ? 'saved' : retained ? 'pending' : 'not-retained',
    );
}
/** Called only by the open settings sheet/its online event, never by app boot. */
export async function flushCrowdRevoke(boatId: string): Promise<boolean> {
    const scope = getAuthIdentityScope();
    if (!crowdRevokePending(boatId, scope)) return true;
    return serial(boatId, scope, async () => !!(await revoke(boatId, scope)));
}
export async function saveCrowdPermission(
    input: {
        boatId: string;
        expectedRevision: string | null;
        mapEnabled: boolean;
        dcdbEnabled: boolean;
        calibration: CrowdCalibration;
    },
    signal?: AbortSignal,
): Promise<CrowdPermission> {
    const scope = getAuthIdentityScope();
    if (
        !uuid(input.boatId) ||
        (input.expectedRevision !== null && !uuid(input.expectedRevision)) ||
        typeof input.mapEnabled !== 'boolean' ||
        typeof input.dcdbEnabled !== 'boolean' ||
        !(input.mapEnabled || input.dcdbEnabled)
    )
        return fail();
    const calibration = parseCrowdCalibration(input.calibration, Date.now());
    return serial(input.boatId, scope, async () => {
        let expectedRevision = input.expectedRevision;
        if (crowdRevokePending(input.boatId, scope)) {
            const off = await revoke(input.boatId, scope);
            if (!off) throw new Error('The pending OFF request must reach the server before enabling sharing.');
            expectedRevision = off.revision;
        }
        return bounded(scope, signal, async (abort) => {
            const client = supabase;
            if (!client) return fail();
            await owned(input.boatId, scope);
            if (abort.aborted) return fail();
            const { data, error } = await client
                .rpc('set_seabed_publication', {
                    p_boat_id: input.boatId,
                    p_expected_revision: expectedRevision,
                    p_map_enabled: input.mapEnabled,
                    p_dcdb_enabled: input.dcdbEnabled,
                    p_terms_version: CROWD_CONSENT_VERSION,
                    p_calibration: calibration,
                })
                .abortSignal(abort);
            if (error || abort.aborted || !isAuthIdentityScopeCurrent(scope)) return fail();
            const value = parsePermission(data, input.boatId, scope);
            if (
                value.mapEnabled !== input.mapEnabled ||
                value.dcdbEnabled !== input.dcdbEnabled ||
                crowdRevokePending(input.boatId, scope)
            )
                return fail();
            return value;
        });
    });
}
