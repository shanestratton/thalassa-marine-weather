/**
 * Whether the server's official warnings watcher answers (129-06). Settings →
 * Alerts shows "Official marine warnings at the boat" and "Small craft
 * advisories" only once it has: a build that ships before the watcher is
 * deployed never offers a switch nothing honours.
 *
 * official_alerts_watch_status() (held migration 20261014160000) returns when
 * the watcher last ran. Anything else (signed out, offline, the function not
 * there yet, no run yet) is null: not answered.
 */
import { supabase } from './supabase';
import { getAuthIdentityScope } from './authIdentityScope';

export async function fetchOfficialAlertsWatchStatus(): Promise<{ ranAt: string } | null> {
    // Signed out there is no account to report on, and the RPC is for signed-in users.
    if (!getAuthIdentityScope().userId) return null;
    try {
        const { data, error } = (await supabase?.rpc('official_alerts_watch_status')) ?? {};
        const row = (Array.isArray(data) ? data[0] : data) as { ran_at?: unknown } | null | undefined;
        return error || typeof row?.ran_at !== 'string' ? null : { ranAt: row.ran_at };
    } catch {
        return null;
    }
}
