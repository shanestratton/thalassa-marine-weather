import { createClient } from '@supabase/supabase-js';
import { Preferences } from '@capacitor/preferences';

import { createLogger } from '../utils/createLogger';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';
import {
    getSecureValue,
    removeSecureValue,
    SECURE_AUTH_STORAGE_KEYS,
    setSecureValue,
    usesNativeSecureStorage,
} from './auth/secureStorage';

const log = createLogger('supabase');

/**
 * Keychain-backed storage adapter for Supabase auth on iOS.
 *
 * Why: the default `window.localStorage` is evictable on iOS WKWebView
 * — under storage pressure, after ~7 days of app inactivity, or when
 * the user clears Safari data — which silently signs the user out.
 * The native plugin uses this-device-only Keychain storage. Legacy
 * Capacitor Preferences (UserDefaults) and localStorage copies are migrated
 * once, read-verified, and retired; an iOS Keychain failure never falls back
 * to a plaintext bearer-token store.
 *
 * Supabase calls these synchronously-styled but actually awaits the
 * returned promises internally. Returning a Promise from getItem /
 * setItem / removeItem is the correct shape per
 * @supabase/supabase-js's `SupportedStorage` interface.
 *
 * Web builds retain localStorage because no native Keychain exists there.
 */
let authStorageQueue: Promise<void> = Promise.resolve();
const authStorageCache = new Map<string, string | null>();
const SECURE_AUTH_INSTALL_MARKER_KEY = 'thalassa-secure-auth-install-v1';
const SECURE_AUTH_INSTALL_MARKER_VALUE = 'keychain-boundary-ready';
let secureAuthInstallBoundaryReady = false;

function enqueueAuthStorageMutation(operation: () => Promise<void>): Promise<void> {
    const result = authStorageQueue.then(operation, operation);
    authStorageQueue = result.catch(() => undefined);
    return result;
}

function removeLocalAuthShadowStrict(key: string): void {
    if (typeof localStorage === 'undefined') return;
    localStorage.removeItem(key);
    if (localStorage.getItem(key) !== null) {
        throw new Error('Could not clear the legacy local auth session');
    }
}

async function establishSecureAuthInstallBoundary(): Promise<void> {
    const { value: marker } = await Preferences.get({ key: SECURE_AUTH_INSTALL_MARKER_KEY });
    if (marker === SECURE_AUTH_INSTALL_MARKER_VALUE) {
        secureAuthInstallBoundaryReady = true;
        return;
    }

    // UserDefaults/localStorage disappear on a genuine reinstall while iOS
    // Keychain records can survive it. Existing installs upgrading into this
    // boundary still have a reviewed plaintext key and must be migrated; a
    // marker-less install with no legacy authority must purge any orphaned
    // bearer records before Supabase Auth can read them.
    let hasLegacyAuthority = false;
    for (const storageKey of SECURE_AUTH_STORAGE_KEYS) {
        const { value: legacyNative } = await Preferences.get({ key: storageKey });
        const local = typeof localStorage !== 'undefined' ? localStorage.getItem(storageKey) : null;
        if (legacyNative !== null || local !== null) hasLegacyAuthority = true;
    }

    if (!hasLegacyAuthority) {
        for (const storageKey of SECURE_AUTH_STORAGE_KEYS) {
            await removeSecureValue(storageKey);
            if ((await getSecureValue(storageKey)) !== null) {
                throw new Error('Could not retire an orphaned Keychain auth record');
            }
            authStorageCache.set(storageKey, null);
        }
    }

    await Preferences.set({
        key: SECURE_AUTH_INSTALL_MARKER_KEY,
        value: SECURE_AUTH_INSTALL_MARKER_VALUE,
    });
    const { value: verifiedMarker } = await Preferences.get({ key: SECURE_AUTH_INSTALL_MARKER_KEY });
    if (verifiedMarker !== SECURE_AUTH_INSTALL_MARKER_VALUE) {
        throw new Error('Could not establish the secure auth installation boundary');
    }
    secureAuthInstallBoundaryReady = true;
}

export const capacitorAuthStorage = {
    async getItem(key: string): Promise<string | null> {
        // A migration, refresh-token write, and logout must have a single
        // observable order. Otherwise a delayed legacy migration can restore
        // a session after sign-out has already removed it.
        await authStorageQueue;
        if (authStorageCache.has(key)) return authStorageCache.get(key) ?? null;
        if (usesNativeSecureStorage()) {
            if (!secureAuthInstallBoundaryReady) await establishSecureAuthInstallBoundary();
            const resolved = await getSecureValue(key);
            authStorageCache.set(key, resolved);
            return resolved;
        }
        try {
            const resolved = typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
            authStorageCache.set(key, resolved);
            return resolved;
        } catch {
            authStorageCache.set(key, null);
            return null;
        }
    },
    async setItem(key: string, value: string): Promise<void> {
        return enqueueAuthStorageMutation(async () => {
            if (usesNativeSecureStorage()) {
                if (!secureAuthInstallBoundaryReady) await establishSecureAuthInstallBoundary();
                await setSecureValue(key, value);
                // Retire legacy plaintext shadows only after Keychain commit.
                // Do not report persistence complete while a previous bearer
                // value remains in an unprotected fallback store.
                await Preferences.remove({ key });
                removeLocalAuthShadowStrict(key);
            } else {
                try {
                    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
                } catch {
                    throw new Error('Browser auth storage is unavailable');
                }
            }
            // Supabase can ask for the current session repeatedly during one
            // action. Keep the authoritative in-process value after the
            // serialized persistence attempt so those reads do not cross the
            // Capacitor bridge every time.
            authStorageCache.set(key, value);
        });
    },
    async removeItem(key: string): Promise<void> {
        return enqueueAuthStorageMutation(async () => {
            if (usesNativeSecureStorage()) {
                // Do not report logout complete while a Keychain bearer record
                // remains readable on the device.
                await removeSecureValue(key);
                // A surviving Preferences record could be migrated back into
                // Keychain on the next launch, resurrecting a logged-out
                // session. Treat its removal as part of the logout commit.
                await Preferences.remove({ key });
            }
            // Always delete both stores. Removing only the currently available
            // backend leaves a bearer session ready for the next fallback.
            removeLocalAuthShadowStrict(key);
            authStorageCache.set(key, null);
        });
    },
};

const logConfig = (_msg: string) => {};

const getUrl = () => {
    let url = '';

    // 1. Try Vite native
    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_SUPABASE_URL) {
        url = import.meta.env.VITE_SUPABASE_URL as string;
        logConfig('Found URL in import.meta.env.VITE_SUPABASE_URL');
    } else {
        logConfig('❌ Not found in import.meta.env.VITE_SUPABASE_URL');
    }

    // 2. Try Process Env (Direct access required for replacement)
    if (!url) {
        try {
            if (typeof process !== 'undefined' && process.env && process.env.SUPABASE_URL) {
                url = process.env.SUPABASE_URL;
                logConfig('Found URL in process.env.SUPABASE_URL');
            }
        } catch (e) {
            log.warn('[supabase] process.env may not exist in browser:', e);
        }
    }

    return url;
};

const getKey = () => {
    let key = '';

    if (typeof import.meta !== 'undefined' && import.meta.env) {
        key = (import.meta.env.VITE_SUPABASE_ANON_KEY || import.meta.env.VITE_SUPABASE_KEY || '') as string;
        if (key) logConfig('Found Supabase anon key in import.meta.env');
    } else {
        logConfig('❌ Not found in import.meta.env');
    }

    if (!key) {
        try {
            if (typeof process !== 'undefined' && process.env && process.env.SUPABASE_KEY) {
                key = process.env.SUPABASE_KEY;
                logConfig('Found KEY in process.env.SUPABASE_KEY');
            }
        } catch (e) {
            log.warn('[supabase] process.env may not exist in browser:', e);
        }
    }

    return key;
};

const URL = getUrl();
const KEY = getKey();

/** Supabase project URL — used by services to construct Edge Function URLs */
export const supabaseUrl = URL;
/** Supabase anon key — used by services for Edge Function auth */
export const supabaseAnonKey = KEY;

if (URL && KEY) {
    /* best effort */
} else {
    if (!URL) logConfig('MISSING: Supabase URL');
    if (!KEY) logConfig('MISSING: Supabase Anon Key');
}

/**
 * One-shot migration: copy any existing Supabase session from legacy native
 * Preferences/localStorage into the iOS Keychain. Plaintext copies are
 * removed only after an exact Keychain readback. The historical export name
 * is retained because tests and rolling code import it.
 */
export function migrateAuthSessionToCapacitor(): Promise<void> {
    return enqueueAuthStorageMutation(async () => {
        if (!usesNativeSecureStorage()) {
            for (const storageKey of SECURE_AUTH_STORAGE_KEYS) {
                const local = typeof localStorage !== 'undefined' ? localStorage.getItem(storageKey) : null;
                authStorageCache.set(storageKey, local);
            }
            return;
        }

        await establishSecureAuthInstallBoundary();

        let failedKeys = 0;
        for (const storageKey of SECURE_AUTH_STORAGE_KEYS) {
            try {
                const existing = await getSecureValue(storageKey);
                const { value: legacyNative } = await Preferences.get({ key: storageKey });
                const local = typeof localStorage !== 'undefined' ? localStorage.getItem(storageKey) : null;
                if (existing !== null) {
                    await Preferences.remove({ key: storageKey });
                    removeLocalAuthShadowStrict(storageKey);
                    authStorageCache.set(storageKey, existing);
                    continue;
                }

                const legacy = legacyNative ?? local;
                if (legacy === null) {
                    // Retire an empty legacy key as well; it must never become
                    // an alternate authority after the migration boundary.
                    await Preferences.remove({ key: storageKey });
                    removeLocalAuthShadowStrict(storageKey);
                    authStorageCache.set(storageKey, null);
                    continue;
                }

                await setSecureValue(storageKey, legacy);
                const verified = await getSecureValue(storageKey);
                if (verified !== legacy) throw new Error('Keychain readback did not match migrated auth state');
                await Preferences.remove({ key: storageKey });
                removeLocalAuthShadowStrict(storageKey);
                authStorageCache.set(storageKey, legacy);
            } catch (e) {
                // Do not copy auth material back to plaintext on failure. A
                // subsequent secure read remains authoritative and the caller
                // may need to restart sign-in if migration could not verify a
                // transient PKCE verifier.
                failedKeys += 1;
                authStorageCache.delete(storageKey);
                log.warn('secure auth-state migration failed', e);
            }
        }
        if (failedKeys === 0) {
            log.info('migrated reviewed Supabase auth state to this-device-only Keychain storage');
        } else {
            log.warn(`secure auth-state migration remains incomplete for ${failedKeys} reviewed key(s)`);
        }
    });
}
void migrateAuthSessionToCapacitor().catch((error) => {
    log.warn('secure auth installation boundary could not be established', error);
});

// Only create client if keys are present
export const supabase =
    URL && KEY
        ? createClient(URL, KEY, {
              auth: {
                  persistSession: true,
                  storageKey: 'thalassa-auth-session', // stable key survives rebuilds
                  autoRefreshToken: true,
                  detectSessionInUrl: true,
                  // Use this-device-only iOS Keychain storage. Web builds
                  // retain localStorage inside the adapter.
                  storage: capacitorAuthStorage,
              },
          })
        : null;

export const isSupabaseConfigured = () => !!supabase;

/**
 * Fast, LOCAL current-user-id resolver.
 *
 * `auth.getUser()` round-trips to the Supabase auth server to re-validate
 * the token — 1–3 s on a cold start or a flaky boat connection, and it
 * returns null while the session is still rehydrating from storage (the
 * cause of "the first action after opening the app does nothing").
 *
 * `auth.getSession()` returns the session straight from local storage
 * (Capacitor Preferences, configured above) — instant, offline-safe — and
 * the client's autoRefreshToken keeps the JWT fresh in the background. For
 * everything we do (RLS-scoped reads/writes that just need `user.id` for an
 * `.eq('user_id', …)` filter) the local session id is exactly right; RLS
 * still enforces ownership server-side regardless.
 *
 * Use this in hot paths instead of getUser(). Returns null if unauthenticated.
 */
export async function getCurrentUserId(scope: AuthIdentityScope = getAuthIdentityScope()): Promise<string | null> {
    if (!supabase || !scope.userId || !isAuthIdentityScopeCurrent(scope)) return null;
    try {
        const {
            data: { session },
        } = await supabase.auth.getSession();
        return isAuthIdentityScopeCurrent(scope) && session?.user?.id === scope.userId ? scope.userId : null;
    } catch {
        return null;
    }
}

/**
 * Same fast local resolver as getCurrentUserId, but returns a minimal
 * `{ id }` user object (or null) so call sites that previously did
 * `const { data: { user } } = await supabase.auth.getUser()` can swap to
 * `const user = await getCurrentUser()` with zero downstream changes.
 */
export async function getCurrentUser(
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Promise<{ id: string } | null> {
    const id = await getCurrentUserId(scope);
    return id ? { id } : null;
}

// --- TYPED PROFILE HELPERS ---

export interface UserProfile {
    id: string;
    email?: string;
    display_name?: string;
    avatar_url?: string;
    vessel_name?: string;
    subscription_status?: 'active' | 'trial' | 'expired' | 'free' | null;
    trial_start_date?: string | null;
    subscription_expiry?: string | null;
    created_at?: string;
    updated_at?: string;
}

export interface Waypoint {
    id: string;
    user_id: string;
    name: string;
    latitude: number;
    longitude: number;
    notes?: string;
    created_at?: string;
}

/**
 * Fetch the signed-in user's community-facing profile. Chat profiles are the
 * canonical deployed identity surface; the old generic `profiles` relation
 * was never part of the production schema.
 */
export async function getUserProfile(userId: string): Promise<UserProfile | null> {
    const scope = getAuthIdentityScope();
    if (!supabase || userId !== scope.userId || (await getCurrentUserId(scope)) !== userId) return null;
    const { data, error } = await supabase
        .from('chat_profiles')
        .select('user_id, display_name, avatar_url, vessel_name, created_at, updated_at')
        .eq('user_id', userId)
        .maybeSingle();
    if (error || !isAuthIdentityScopeCurrent(scope) || data?.user_id !== userId) return null;
    return {
        id: data.user_id,
        display_name: data.display_name ?? undefined,
        avatar_url: data.avatar_url ?? undefined,
        vessel_name: data.vessel_name ?? undefined,
        created_at: data.created_at,
        updated_at: data.updated_at,
    };
}

/**
 * Update fields on a user's profile.
 */
export type UserProfileUpdate = Pick<UserProfile, 'display_name' | 'avatar_url' | 'vessel_name'>;

export async function updateUserProfile(userId: string, updates: Partial<UserProfileUpdate>): Promise<boolean> {
    const scope = getAuthIdentityScope();
    if (!supabase || userId !== scope.userId || (await getCurrentUserId(scope)) !== userId) return false;
    const snapshot: Partial<UserProfileUpdate> = {};
    if (typeof updates.display_name === 'string') snapshot.display_name = updates.display_name;
    if (typeof updates.avatar_url === 'string') snapshot.avatar_url = updates.avatar_url;
    if (typeof updates.vessel_name === 'string') snapshot.vessel_name = updates.vessel_name;
    if (Object.keys(snapshot).length === 0) return false;
    const { error } = await supabase
        .from('chat_profiles')
        .upsert({ user_id: userId, ...snapshot, updated_at: new Date().toISOString() }, { onConflict: 'user_id' });
    return !error && isAuthIdentityScopeCurrent(scope);
}

/**
 * Sync waypoints to the `waypoints` table (upsert by id).
 */
export async function syncWaypoints(userId: string, waypoints: Waypoint[]): Promise<boolean> {
    if (waypoints.length === 0) return true;
    const scope = getAuthIdentityScope();
    if (!supabase || userId !== scope.userId || (await getCurrentUserId(scope)) !== userId) return false;
    const rows = waypoints
        .filter(
            (waypoint) =>
                typeof waypoint.id === 'string' &&
                waypoint.id.trim() &&
                typeof waypoint.name === 'string' &&
                Number.isFinite(waypoint.latitude) &&
                Number.isFinite(waypoint.longitude) &&
                Math.abs(waypoint.latitude) <= 90 &&
                Math.abs(waypoint.longitude) <= 180,
        )
        .map((waypoint) => ({
            id: waypoint.id,
            user_id: userId,
            name: waypoint.name,
            latitude: waypoint.latitude,
            longitude: waypoint.longitude,
            ...(typeof waypoint.notes === 'string' ? { notes: waypoint.notes } : {}),
            ...(typeof waypoint.created_at === 'string' ? { created_at: waypoint.created_at } : {}),
        }));
    if (rows.length !== waypoints.length) return false;
    const { error } = await supabase.from('waypoints').upsert(rows, { onConflict: 'id' });
    return !error && isAuthIdentityScopeCurrent(scope);
}
