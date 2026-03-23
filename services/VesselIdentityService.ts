/**
 * VesselIdentityService — Syncs vessel "DNA" between Supabase and local storage.
 *
 * The vessel identity (name, rego, MMSI, call sign, phonetic name) is stored in
 * Supabase and cached locally for offline use (RadioConsole, VHF reports, etc.).
 */

import { supabase } from './supabase';
import { createLogger } from '../utils/createLogger';

const log = createLogger('VesselIdentity');
const LOCAL_KEY = 'thalassa_vessel_identity';

// ── Types ──────────────────────────────────────────────────────

export interface VesselIdentity {
    id: string;
    owner_id: string;
    vessel_name: string;
    reg_number: string;
    mmsi: string;
    call_sign: string;
    phonetic_name: string;
    vessel_type: 'sail' | 'power' | 'observer';
    hull_color: string;
    model: string;
    updated_at: string;
}

// ── Local Cache ────────────────────────────────────────────────

/** Get cached vessel identity (always available offline) */
export function getCachedIdentity(): VesselIdentity | null {
    try {
        const raw = localStorage.getItem(LOCAL_KEY);
        return raw ? (JSON.parse(raw) as VesselIdentity) : null;
    } catch {
        return null;
    }
}

function cacheIdentity(identity: VesselIdentity): void {
    try {
        localStorage.setItem(LOCAL_KEY, JSON.stringify(identity));
    } catch {
        /* storage full — silently fail */
    }
}

// ── Supabase Sync ──────────────────────────────────────────────

/**
 * Pull vessel identity from Supabase and cache locally.
 * Called at app boot and after any update.
 */
export async function syncIdentity(): Promise<VesselIdentity | null> {
    if (!supabase) return getCachedIdentity();

    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user) return getCachedIdentity();

        // Try to load as owner first
        const result = await supabase.from('vessel_identity').select('*').eq('owner_id', user.id).maybeSingle();
        let data = result.data;
        const error = result.error;

        if (error) {
            log.warn('[VesselIdentity] Sync pull error:', error.message);
            return getCachedIdentity();
        }

        // If not owner, try to load as crew (RLS policy allows read via vessel_crew)
        if (!data) {
            const { data: crewData } = await supabase
                .from('vessel_crew')
                .select('owner_id')
                .eq('crew_user_id', user.id)
                .eq('status', 'accepted')
                .limit(1)
                .maybeSingle();

            if (crewData?.owner_id) {
                const { data: ownerVessel } = await supabase
                    .from('vessel_identity')
                    .select('*')
                    .eq('owner_id', crewData.owner_id)
                    .maybeSingle();

                data = ownerVessel;
            }
        }

        if (data) {
            const identity = data as VesselIdentity;
            cacheIdentity(identity);
            return identity;
        }

        return getCachedIdentity();
    } catch (e) {
        log.warn('[VesselIdentity] Sync failed:', e);
        return getCachedIdentity();
    }
}

/**
 * Save or update vessel identity (owner only).
 */
export async function saveIdentity(
    updates: Partial<Omit<VesselIdentity, 'id' | 'owner_id' | 'updated_at'>>,
): Promise<VesselIdentity | null> {
    if (!supabase) return null;

    try {
        const {
            data: { user },
        } = await supabase.auth.getUser();
        if (!user) return null;

        // Upsert — insert if first time, update if exists
        const { data, error } = await supabase
            .from('vessel_identity')
            .upsert(
                {
                    owner_id: user.id,
                    ...updates,
                    updated_at: new Date().toISOString(),
                },
                { onConflict: 'owner_id' },
            )
            .select()
            .single();

        if (error) {
            log.error('[VesselIdentity] Save error:', error.message);
            return null;
        }

        const identity = data as VesselIdentity;
        cacheIdentity(identity);
        return identity;
    } catch (e) {
        log.error('[VesselIdentity] Save failed:', e);
        return null;
    }
}
