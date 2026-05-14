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

const PUBLIC_BASE = 'https://thalassawx.app/logs';

export interface VoyageLogConfig {
    id: string;
    owner_id: string;
    handle: string;
    api_key: string;
    enabled: boolean;
    track_days: number;
    created_at: string;
    updated_at: string;
}

/** Public renderer URL for a vessel's voyage log — the shareable link, key included. */
export function voyageLogPublicUrl(handle: string, apiKey: string): string {
    return `${PUBLIC_BASE}/${encodeURIComponent(handle)}?k=${encodeURIComponent(apiKey)}`;
}

/** Raw API endpoint a punter's own front-end would call. */
export function voyageLogApiUrl(handle: string, apiKey: string): string {
    const base = (supabaseUrl || '').replace(/\/$/, '');
    return `${base}/functions/v1/voyage-log?handle=${encodeURIComponent(handle)}&key=${encodeURIComponent(apiKey)}`;
}

class VoyageLogServiceClass {
    /** The current user's voyage log config, or null if they've never set one up. */
    async getConfig(): Promise<VoyageLogConfig | null> {
        if (!supabase) return null;
        const { data: userData } = await supabase.auth.getUser();
        const userId = userData.user?.id;
        if (!userId) return null;

        const { data, error } = await supabase
            .from('voyage_log_configs')
            .select('*')
            .eq('owner_id', userId)
            .maybeSingle();

        if (error) {
            log.warn('getConfig failed:', error.message);
            return null;
        }
        return (data as VoyageLogConfig) ?? null;
    }

    /**
     * Make sure the user has a config row and that it's enabled.
     * Creates the row on first call (handle + key are filled server-side).
     * Returns the live config, or null if offline / unauthenticated.
     */
    async ensureEnabled(): Promise<VoyageLogConfig | null> {
        if (!supabase) return null;
        const { data: userData } = await supabase.auth.getUser();
        const userId = userData.user?.id;
        if (!userId) return null;

        const existing = await this.getConfig();
        if (existing) {
            if (existing.enabled) return existing;
            return this.setEnabled(true);
        }

        const { data, error } = await supabase
            .from('voyage_log_configs')
            .insert({ owner_id: userId, enabled: true })
            .select()
            .single();

        if (error) {
            log.warn('ensureEnabled insert failed:', error.message);
            return null;
        }
        return data as VoyageLogConfig;
    }

    /** Flip the master switch. Returns the updated config, or null on failure. */
    async setEnabled(enabled: boolean): Promise<VoyageLogConfig | null> {
        if (!supabase) return null;
        const { data: userData } = await supabase.auth.getUser();
        const userId = userData.user?.id;
        if (!userId) return null;

        const { data, error } = await supabase
            .from('voyage_log_configs')
            .update({ enabled })
            .eq('owner_id', userId)
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
