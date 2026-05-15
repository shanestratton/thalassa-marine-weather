/**
 * VoyageLogService — the punter's side of the public Voyage Log.
 *
 * Owns the `voyage_log_configs` row: the per-vessel handle, publishable
 * API key, and master on/off switch that the public `voyage-log` edge
 * function reads. Diary entries themselves carry their own `is_public`
 * flag (see DiaryService) — this service only manages the config.
 */

import { createLogger } from '../utils/createLogger';
import { supabase, supabaseUrl } from './supabase';

const log = createLogger('VoyageLog');

export interface VoyageLogConfig {
    id: string;
    owner_id: string;
    boat_id: string | null;
    handle: string;
    api_key: string;
    enabled: boolean;
    scope: 'personal' | 'combined';
    track_days: number;
    created_at: string;
    updated_at: string;
}

/**
 * Public renderer URL — wildcard subdomain pattern. The renderer reads
 * the handle from window.location.hostname so we don't ship a key in
 * the URL anymore (was never a secret; dropped in commit 4a987e82 when
 * we moved to <handle>.thalassawx.app).
 */
export function voyageLogPublicUrl(handle: string, _apiKey?: string): string {
    void _apiKey; // legacy callers still pass the key; ignore it.
    return `https://${handle}.thalassawx.app`;
}

/** Raw API endpoint a punter's own front-end would call. No key — drop in any handle. */
export function voyageLogApiUrl(handle: string, _apiKey?: string): string {
    void _apiKey;
    const base = (supabaseUrl || '').replace(/\/$/, '');
    return `${base}/functions/v1/voyage-log?handle=${encodeURIComponent(handle)}`;
}

class VoyageLogServiceClass {
    /**
     * The owned boat's ID for the current user, or null if they don't own
     * a boat. Shared lookup used by every method below — the owner-facing
     * Voyage Log surface always operates against the user's owned boat.
     */
    private async getOwnedBoatId(userId: string): Promise<string | null> {
        if (!supabase) return null;
        const { data, error } = await supabase.from('boats').select('id').eq('owner_id', userId).maybeSingle();
        if (error) {
            log.warn('getOwnedBoatId failed:', error.message);
            return null;
        }
        return (data?.id as string) ?? null;
    }

    /**
     * The current user's voyage log config, or null if they've never set
     * one up. Returns the COMBINED-scope config for the user's owned boat
     * — that's the public face of the vessel (boat-wide, aggregates all
     * crew entries). Personal-scope configs (one per crew member per boat)
     * are managed by a different surface — VoyageLogTab's "Boats you're
     * crew on" section, which can also list the owner's own personal
     * config alongside the combined one.
     *
     * Why this needed re-scoping: after the multi-crew migration, a single
     * user can have multiple voyage_log_configs rows (personal + combined).
     * The pre-migration query (.eq('owner_id', userId).maybeSingle()) would
     * crash silently on the multi-row result, returning null and making the
     * settings tab show "Set up your Voyage Log" even though the user IS
     * set up.
     */
    async getConfig(): Promise<VoyageLogConfig | null> {
        if (!supabase) return null;
        const { data: userData } = await supabase.auth.getUser();
        const userId = userData.user?.id;
        if (!userId) return null;

        const boatId = await this.getOwnedBoatId(userId);
        if (!boatId) return null;

        const { data, error } = await supabase
            .from('voyage_log_configs')
            .select('*')
            .eq('boat_id', boatId)
            .eq('scope', 'combined')
            .maybeSingle();

        if (error) {
            log.warn('getConfig failed:', error.message);
            return null;
        }
        return (data as VoyageLogConfig) ?? null;
    }

    /**
     * Make sure the user has a combined-scope config row and that it's
     * enabled. Creates the row on first call (handle + key are filled
     * server-side by the voyage_log_set_handle trigger). Returns the live
     * config, or null if offline / unauthenticated / no owned boat.
     */
    async ensureEnabled(): Promise<VoyageLogConfig | null> {
        if (!supabase) return null;
        const { data: userData } = await supabase.auth.getUser();
        const userId = userData.user?.id;
        if (!userId) return null;

        const boatId = await this.getOwnedBoatId(userId);
        if (!boatId) {
            log.warn('ensureEnabled: user does not own a boat — onboarding incomplete?');
            return null;
        }

        const existing = await this.getConfig();
        if (existing) {
            if (existing.enabled) return existing;
            return this.setEnabled(true);
        }

        const { data, error } = await supabase
            .from('voyage_log_configs')
            .insert({ owner_id: userId, boat_id: boatId, scope: 'combined', enabled: true })
            .select()
            .single();

        if (error) {
            log.warn('ensureEnabled insert failed:', error.message);
            return null;
        }
        return data as VoyageLogConfig;
    }

    /** Flip the master switch on the combined config. Returns the updated config, or null on failure. */
    async setEnabled(enabled: boolean): Promise<VoyageLogConfig | null> {
        if (!supabase) return null;
        const { data: userData } = await supabase.auth.getUser();
        const userId = userData.user?.id;
        if (!userId) return null;

        const boatId = await this.getOwnedBoatId(userId);
        if (!boatId) return null;

        const { data, error } = await supabase
            .from('voyage_log_configs')
            .update({ enabled })
            .eq('boat_id', boatId)
            .eq('scope', 'combined')
            .select()
            .single();

        if (error) {
            log.warn('setEnabled failed:', error.message);
            return null;
        }
        return data as VoyageLogConfig;
    }
}

export const VoyageLogService = new VoyageLogServiceClass();
