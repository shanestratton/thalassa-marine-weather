/**
 * Whether the background weather check looks ahead yet, and what it last saw
 * at this account's position (129-07). Settings → Alerts shows the look-ahead
 * choice, "Good window opens" and the status only once it has answered with
 * the look-ahead version: a build that ships before the deploy never offers a
 * choice nothing honours.
 *
 * weather_alert_status() (held migration 20261014190000) returns the last
 * run's version and time, and this account's lines (null basis: no row for
 * it yet). Anything else (signed out, offline, the function not there yet, no
 * run yet) is null: not answered.
 */
import { supabase } from './supabase';
import { getAuthIdentityScope } from './authIdentityScope';

export interface WeatherAlertStatus {
    version: number;
    ranAt: string;
    /** Which position the lines are for; null while the check has none for this account. */
    basis: 'saved' | 'last-known' | null;
    /** The check's own words, in the skipper's units: never a UKMO value. */
    lines: string[];
}

export async function fetchWeatherAlertStatus(): Promise<WeatherAlertStatus | null> {
    // Signed out there is no account to report on, and the RPC is for signed-in users.
    if (!getAuthIdentityScope().userId) return null;
    try {
        const { data, error } = (await supabase?.rpc('weather_alert_status')) ?? {};
        const row = (Array.isArray(data) ? data[0] : data) as Record<string, unknown> | null | undefined;
        if (error || typeof row?.version !== 'number' || typeof row.ran_at !== 'string') return null;
        const basis = row.basis === 'saved' || row.basis === 'last-known' ? row.basis : null;
        const lines = Array.isArray(row.lines) ? row.lines.filter((l): l is string => typeof l === 'string') : [];
        return { version: row.version, ranAt: row.ran_at, basis, lines: basis ? lines : [] };
    } catch {
        return null;
    }
}
