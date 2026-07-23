import { createClient } from '@supabase/supabase-js';
import { Preferences } from '@capacitor/preferences';

import { createLogger } from '../utils/createLogger';
import { getAuthIdentityScope, isAuthIdentityScopeCurrent, type AuthIdentityScope } from './authIdentityScope';

const log = createLogger('supabase');

/**
 * Capacitor-Preferences-backed storage adapter for Supabase auth.
 *
 * Why: the default `window.localStorage` is evictable on iOS WKWebView
 * — under storage pressure, after ~7 days of app inactivity, or when
 * the user clears Safari data — which silently signs the user out.
 * Capacitor Preferences proxies to native iOS UserDefaults (and
 * Android SharedPreferences) which survive all of those.
 *
 * Supabase calls these synchronously-styled but actually awaits the
 * returned promises internally. Returning a Promise from getItem /
 * setItem / removeItem is the correct shape per
 * @supabase/supabase-js's `SupportedStorage` interface.
 *
 * Web fallback: when Preferences isn't installed (browser dev), we
 * fall back to localStorage transparently — same behaviour as before
 * the swap.
 */
let authStorageQueue: Promise<void> = Promise.resolve();

function enqueueAuthStorageMutation(operation: () => Promise<void>): Promise<void> {
    const result = authStorageQueue.then(operation, operation);
    authStorageQueue = result.catch(() => undefined);
    return result;
}

function removeLocalAuthShadow(key: string): void {
    try {
        if (typeof localStorage !== 'undefined') localStorage.removeItem(key);
    } catch {
        /* storage unavailable */
    }
}

export const capacitorAuthStorage = {
    async getItem(key: string): Promise<string | null> {
        // A migration, refresh-token write, and logout must have a single
        // observable order. Otherwise a delayed legacy migration can restore
        // a session after sign-out has already removed it.
        await authStorageQueue;
        try {
            const { value } = await Preferences.get({ key });
            return value ?? null;
        } catch {
            // Web / Preferences plugin missing — fall back to localStorage.
            try {
                return typeof localStorage !== 'undefined' ? localStorage.getItem(key) : null;
            } catch {
                return null;
            }
        }
    },
    async setItem(key: string, value: string): Promise<void> {
        return enqueueAuthStorageMutation(async () => {
            try {
                await Preferences.set({ key, value });
                // Retire any fallback/legacy copy after native persistence
                // succeeds. Leaving it behind can resurrect an old account.
                removeLocalAuthShadow(key);
            } catch {
                try {
                    if (typeof localStorage !== 'undefined') localStorage.setItem(key, value);
                } catch {
                    /* storage full or unavailable */
                }
            }
        });
    },
    async removeItem(key: string): Promise<void> {
        return enqueueAuthStorageMutation(async () => {
            try {
                await Preferences.remove({ key });
            } catch {
                /* browser/native bridge unavailable; still purge fallback */
            }
            // Always delete both stores. Removing only the currently available
            // backend leaves a bearer session ready for the next fallback.
            removeLocalAuthShadow(key);
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
 * One-shot migration: copy any existing Supabase session out of
 * localStorage into Capacitor Preferences so the user doesn't get
 * bumped out by the storage swap on this update. Idempotent — only
 * copies if Preferences doesn't already have a value, and nukes
 * the localStorage copy after to stop iOS evicting the auth token
 * from there. Best-effort: failure means one extra login, then
 * we're stable.
 */
export function migrateAuthSessionToCapacitor(): Promise<void> {
    if (typeof localStorage === 'undefined') return Promise.resolve();
    const SESSION_KEY = 'thalassa-auth-session';
    return enqueueAuthStorageMutation(async () => {
        try {
            const { value: existing } = await Preferences.get({ key: SESSION_KEY });
            const local = localStorage.getItem(SESSION_KEY);
            if (existing) {
                // A prior copy may have succeeded just before a crash. Native
                // storage is authoritative; purge the stale bearer duplicate.
                if (local) removeLocalAuthShadow(SESSION_KEY);
                return;
            }
            if (!local) return;
            await Preferences.set({ key: SESSION_KEY, value: local });
            removeLocalAuthShadow(SESSION_KEY);
            log.info('migrated auth session: localStorage → Capacitor Preferences');
        } catch (e) {
            log.warn('auth session migration failed (one-time)', e);
        }
    });
}
void migrateAuthSessionToCapacitor();

// Only create client if keys are present
export const supabase =
    URL && KEY
        ? createClient(URL, KEY, {
              auth: {
                  persistSession: true,
                  storageKey: 'thalassa-auth-session', // stable key survives rebuilds
                  autoRefreshToken: true,
                  detectSessionInUrl: true,
                  // Use native UserDefaults (via Capacitor Preferences)
                  // instead of localStorage so iOS can't evict the
                  // session under storage pressure or after long
                  // inactivity. Web falls back to localStorage inside
                  // the adapter.
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
 * Fetch a user's profile from the `profiles` table.
 */
export async function getUserProfile(userId: string): Promise<UserProfile | null> {
    const scope = getAuthIdentityScope();
    if (!supabase || userId !== scope.userId || (await getCurrentUserId(scope)) !== userId) return null;
    const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single();
    if (error || !isAuthIdentityScopeCurrent(scope) || data?.id !== userId) return null;
    return { ...(data as UserProfile) };
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
        .from('profiles')
        .update({ ...snapshot, updated_at: new Date().toISOString() })
        .eq('id', userId);
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
