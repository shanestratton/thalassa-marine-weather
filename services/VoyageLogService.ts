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
     * Last DB error from any mutating call, surfaced to the UI so a failed
     * Setup tap can show *why* (RLS, missing table, network) instead of
     * silently flashing the button back. Cleared at the start of each
     * ensureEnabled() / setEnabled() call.
     */
    public lastError: string | null = null;

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
            this.lastError = `Boat lookup failed: ${error.message}`;
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
     * Get-or-create the user's owned boat. For users who completed
     * onboarding before the multi-crew migration shipped, the migration
     * backfilled a boats row for them. Fresh users have a vessel_identity
     * row (from onboarding) but no boats row — nothing creates one
     * automatically. This builds it from vessel_identity and registers
     * the user as the owner boat_member at the same time so the
     * combined log (which queries by boat_member) finds them.
     */
    private async getOrCreateOwnedBoat(userId: string): Promise<string | null> {
        if (!supabase) return null;
        const existing = await this.getOwnedBoatId(userId);
        if (existing) return existing;

        // Pull vessel info from onboarding's canonical store. Falls
        // back to sensible defaults if vessel_identity is empty too
        // (shouldn't happen post-onboarding, but defensive).
        const { data: vessel } = await supabase
            .from('vessel_identity')
            .select('vessel_name, vessel_type, model')
            .eq('owner_id', userId)
            .maybeSingle();

        const name = (vessel?.vessel_name ?? '').trim() || 'My Boat';

        const { data: boat, error: boatErr } = await supabase
            .from('boats')
            .insert({
                owner_id: userId,
                name,
                vessel_type: vessel?.vessel_type ?? 'sail',
                model: vessel?.model ?? null,
            })
            .select('id')
            .single();
        if (boatErr || !boat?.id) {
            log.warn('getOrCreateOwnedBoat failed:', boatErr?.message);
            this.lastError = `Couldn't create your boat row: ${boatErr?.message ?? 'no id returned'}`;
            return null;
        }

        // Register the owner as the first boat_member so their entries
        // appear on the combined log with a byline. First name comes
        // from auth.users.raw_user_meta_data (onboarding writes it).
        const { data: authData } = await supabase.auth.getUser();
        const meta = authData.user?.user_metadata as
            | { first_name?: string; last_name?: string; prefix?: string; nickname?: string }
            | undefined;
        const { error: memberErr } = await supabase.from('boat_members').insert({
            boat_id: boat.id,
            user_id: userId,
            first_name: meta?.first_name ?? 'Crew',
            last_name: meta?.last_name ?? null,
            prefix: meta?.prefix ?? null,
            nickname: meta?.nickname ?? null,
            role: 'owner',
        });
        if (memberErr) {
            // PK conflict is fine — read path will pick up whatever's there.
            // Other errors (RLS, missing column) are worth surfacing.
            if (!/duplicate key|unique/i.test(memberErr.message)) {
                log.warn('boat_members insert failed:', memberErr.message);
                this.lastError = `Couldn't register you as crew: ${memberErr.message}`;
            }
        }
        // Ignore PK-conflict errors (boat_member already exists for some
        // reason) — the read path will pick up whatever's there.

        return boat.id as string;
    }

    /**
     * Make sure the user has a combined-scope config row and that it's
     * enabled. Creates the boat row if needed (fresh users), then the
     * config (handle + key filled server-side by voyage_log_set_handle
     * trigger). Returns the live config, or null if offline /
     * unauthenticated.
     */
    async ensureEnabled(): Promise<VoyageLogConfig | null> {
        this.lastError = null;
        if (!supabase) {
            this.lastError = 'Offline — Supabase client unavailable.';
            return null;
        }
        const { data: userData } = await supabase.auth.getUser();
        const userId = userData.user?.id;
        if (!userId) {
            this.lastError = 'You need to sign in before setting up Voyage Log.';
            return null;
        }

        const boatId = await this.getOrCreateOwnedBoat(userId);
        if (!boatId) {
            log.warn('ensureEnabled: could not get or create boat');
            if (!this.lastError) this.lastError = 'Could not get or create your boat record.';
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
            this.lastError = `Couldn't create Voyage Log config: ${error.message}`;
            return null;
        }
        return data as VoyageLogConfig;
    }

    /** Flip the master switch on the combined config. Returns the updated config, or null on failure. */
    async setEnabled(enabled: boolean): Promise<VoyageLogConfig | null> {
        this.lastError = null;
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
            this.lastError = `Couldn't update Voyage Log: ${error.message}`;
            return null;
        }
        return data as VoyageLogConfig;
    }

    // ── Per-voyage public visibility ───────────────────────────
    // The owner's exclusion list (voyage_log_hidden_voyages): hidden voyages
    // are filtered out of the public track + live tail by the edge function,
    // while the in-app log keeps them untouched. Keeps the public page from
    // turning into spaghetti when day-sails overlap.

    /** Voyage ids currently hidden from the public page. */
    async getHiddenVoyageIds(): Promise<Set<string>> {
        if (!supabase) return new Set();
        try {
            const { data, error } = await supabase.from('voyage_log_hidden_voyages').select('voyage_id');
            if (error) {
                log.warn('getHiddenVoyageIds failed:', error.message);
                return new Set();
            }
            return new Set((data ?? []).map((r) => r.voyage_id as string));
        } catch (e) {
            log.warn('getHiddenVoyageIds failed:', e);
            return new Set();
        }
    }

    /** Hide (true) or show (false) one voyage on the public page. */
    async setVoyageHidden(voyageId: string, hidden: boolean): Promise<boolean> {
        this.lastError = null;
        if (!supabase) {
            this.lastError = 'Offline — Supabase client unavailable.';
            return false;
        }
        try {
            const { data: userData } = await supabase.auth.getUser();
            const userId = userData.user?.id;
            if (!userId) {
                this.lastError = 'You need to sign in first.';
                return false;
            }
            const { error } = hidden
                ? await supabase
                      .from('voyage_log_hidden_voyages')
                      .upsert({ user_id: userId, voyage_id: voyageId }, { onConflict: 'user_id,voyage_id' })
                : await supabase
                      .from('voyage_log_hidden_voyages')
                      .delete()
                      .eq('user_id', userId)
                      .eq('voyage_id', voyageId);
            if (error) {
                log.warn('setVoyageHidden failed:', error.message);
                this.lastError = `Couldn't update track visibility: ${error.message}`;
                return false;
            }
            return true;
        } catch (e) {
            log.warn('setVoyageHidden failed:', e);
            this.lastError = 'Track visibility update failed — check signal.';
            return false;
        }
    }
}

export const VoyageLogService = new VoyageLogServiceClass();
