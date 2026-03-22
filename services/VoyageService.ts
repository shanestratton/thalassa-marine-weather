/**
 * VoyageService — Passage state management.
 *
 * Tracks active voyages. When a voyage is active:
 *  - Report Position UI is prioritised
 *  - Weather Master lock is enforced
 *  - P2P sync heartbeat runs
 */

import { supabase } from './supabase';

// ── Types ──────────────────────────────────────────────────────────────────

export type VoyageStatus = 'planning' | 'active' | 'completed' | 'aborted';

export interface Voyage {
    id: string;
    user_id: string;
    vessel_id: string | null;
    voyage_name: string;
    departure_port: string | null;
    destination_port: string | null;
    departure_time: string | null;
    eta: string | null;
    crew_count: number;
    status: VoyageStatus;
    weather_master_id: string | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
}

// ── Local state (for offline access) ──────────────────────────────────────

const ACTIVE_VOYAGE_KEY = 'thalassa_active_voyage';

function cacheVoyage(v: Voyage | null): void {
    try {
        if (v) localStorage.setItem(ACTIVE_VOYAGE_KEY, JSON.stringify(v));
        else localStorage.removeItem(ACTIVE_VOYAGE_KEY);
    } catch {
        /* full */
    }
}

/** Get cached active voyage (offline-safe) */
export function getCachedActiveVoyage(): Voyage | null {
    try {
        const raw = localStorage.getItem(ACTIVE_VOYAGE_KEY);
        return raw ? JSON.parse(raw) : null;
    } catch {
        return null;
    }
}

// ── CRUD ────────────────────────────────────────────────────────────────

/** Create a new voyage (starts in 'planning' status) */
export async function createVoyage(
    data: Pick<Voyage, 'voyage_name' | 'departure_port' | 'destination_port' | 'crew_count'> & { vessel_id?: string },
): Promise<Voyage | null> {
    if (!supabase) return null;

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return null;

    const { data: voyage, error } = await supabase
        .from('voyages')
        .insert({
            ...data,
            user_id: user.id,
            weather_master_id: user.id, // Skipper is default master
            status: 'planning',
        })
        .select()
        .single();

    if (error) return null;
    return voyage as Voyage;
}

/** Start a passage (set status to 'active') */
export async function startVoyage(voyageId: string): Promise<Voyage | null> {
    if (!supabase) return null;

    const { data, error } = await supabase
        .from('voyages')
        .update({
            status: 'active',
            departure_time: new Date().toISOString(),
        })
        .eq('id', voyageId)
        .select()
        .single();

    if (error) return null;
    const voyage = data as Voyage;
    cacheVoyage(voyage);
    return voyage;
}

/** End a passage */
export async function endVoyage(voyageId: string, status: 'completed' | 'aborted' = 'completed'): Promise<boolean> {
    if (!supabase) return false;

    const { error } = await supabase.from('voyages').update({ status }).eq('id', voyageId);

    if (!error) cacheVoyage(null);
    return !error;
}

/** Get the currently active voyage */
export async function getActiveVoyage(): Promise<Voyage | null> {
    if (!supabase) return getCachedActiveVoyage();

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return getCachedActiveVoyage();

    // Check as owner first
    let { data } = await supabase
        .from('voyages')
        .select('*')
        .eq('user_id', user.id)
        .eq('status', 'active')
        .limit(1)
        .maybeSingle();

    // If not owner, check as crew
    if (!data) {
        const { data: crewVoyage } = await supabase
            .from('voyages')
            .select('*')
            .eq('status', 'active')
            .limit(1)
            .maybeSingle();
        data = crewVoyage;
    }

    const voyage = data as Voyage | null;
    cacheVoyage(voyage);
    return voyage;
}

/** Set the weather master for a voyage (Iridium lock) */
export async function setWeatherMaster(voyageId: string, userId: string): Promise<boolean> {
    if (!supabase) return false;

    const { error } = await supabase.from('voyages').update({ weather_master_id: userId }).eq('id', voyageId);

    return !error;
}

/** Check if current user is the weather master */
export async function isWeatherMaster(): Promise<boolean> {
    if (!supabase) {
        const cached = getCachedActiveVoyage();
        if (!cached) return true; // No voyage = unrestricted
        const userId = localStorage.getItem('thalassa_user_id');
        return cached.weather_master_id === userId || cached.user_id === userId;
    }

    const {
        data: { user },
    } = await supabase.auth.getUser();
    if (!user) return true; // Offline — allow

    const voyage = await getActiveVoyage();
    if (!voyage) return true; // No active voyage — unrestricted

    return voyage.weather_master_id === user.id || voyage.user_id === user.id;
}
