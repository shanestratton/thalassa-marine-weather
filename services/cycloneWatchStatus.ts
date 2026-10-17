/**
 * Whether the server's cyclone watcher answers (129-09). Settings → Alerts
 * shows "Cyclone warnings near the boat" only once it has: a build that ships
 * before the watcher is deployed never offers a switch nothing honours.
 *
 * cyclone_watch_status() (held migration 20261014120000_cyclone_watch) returns
 * when the watcher last ran and since when its feed has been unavailable.
 * Anything else (signed out, offline, the function not there yet, no run yet)
 * is null: not answered.
 */
import { supabase } from './supabase';
import { getAuthIdentityScope } from './authIdentityScope';

export interface CycloneWatchStatus {
    ranAt: string;
    unavailableSince: string | null;
}

export async function fetchCycloneWatchStatus(): Promise<CycloneWatchStatus | null> {
    // Signed out there is no account to report on, and the RPC is for signed-in users.
    if (!getAuthIdentityScope().userId) return null;
    try {
        const { data, error } = (await supabase?.rpc('cyclone_watch_status')) ?? {};
        const row = (Array.isArray(data) ? data[0] : data) as
            | { ran_at?: unknown; unavailable_since?: unknown }
            | null
            | undefined;
        if (error || typeof row?.ran_at !== 'string') return null;
        return {
            ranAt: row.ran_at,
            unavailableSince: typeof row.unavailable_since === 'string' ? row.unavailable_since : null,
        };
    } catch {
        return null;
    }
}
