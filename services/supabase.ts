import { createClient } from '@supabase/supabase-js';

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
            console.warn('[supabase] process.env may not exist in browser:', e);
        }
    }

    return url;
};

const getKey = () => {
    let key = '';

    if (typeof import.meta !== 'undefined' && import.meta.env && import.meta.env.VITE_SUPABASE_KEY) {
        key = import.meta.env.VITE_SUPABASE_KEY as string;
        logConfig('Found KEY in import.meta.env.VITE_SUPABASE_KEY');
    } else {
        logConfig('❌ Not found in import.meta.env.VITE_SUPABASE_KEY');
    }

    if (!key) {
        try {
            if (typeof process !== 'undefined' && process.env && process.env.SUPABASE_KEY) {
                key = process.env.SUPABASE_KEY;
                logConfig('Found KEY in process.env.SUPABASE_KEY');
            }
        } catch (e) {
            console.warn('[supabase] process.env may not exist in browser:', e);
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

// Only create client if keys are present
export const supabase =
    URL && KEY
        ? createClient(URL, KEY, {
              auth: {
                  persistSession: true,
                  storageKey: 'thalassa-auth-session', // stable key survives rebuilds
                  autoRefreshToken: true,
                  detectSessionInUrl: true,
              },
          })
        : null;

export const isSupabaseConfigured = () => !!supabase;

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
    if (!supabase) return null;
    const { data, error } = await supabase.from('profiles').select('*').eq('id', userId).single();
    if (error) return null;
    return data as UserProfile;
}

/**
 * Update fields on a user's profile.
 */
export async function updateUserProfile(
    userId: string,
    updates: Partial<Omit<UserProfile, 'id' | 'created_at'>>,
): Promise<boolean> {
    if (!supabase) return false;
    const { error } = await supabase
        .from('profiles')
        .update({ ...updates, updated_at: new Date().toISOString() })
        .eq('id', userId);
    return !error;
}

/**
 * Sync waypoints to the `waypoints` table (upsert by id).
 */
export async function syncWaypoints(userId: string, waypoints: Waypoint[]): Promise<boolean> {
    if (!supabase || waypoints.length === 0) return true;
    const rows = waypoints.map((wp) => ({ ...wp, user_id: userId }));
    const { error } = await supabase.from('waypoints').upsert(rows, { onConflict: 'id' });
    return !error;
}
