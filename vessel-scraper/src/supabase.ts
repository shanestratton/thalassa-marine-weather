/**
 * Supabase client for the scraper — uses service_role key
 * to bypass RLS for vessel_metadata writes.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('[Scraper] SUPABASE_URL and SUPABASE_SERVICE_KEY must be set');
    process.exit(1);
}

export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY, {
    auth: { persistSession: false },
});

export interface VesselMetadataRow {
    mmsi: number;
    vessel_name?: string | null;
    vessel_type?: string | null;
    flag_country?: string | null;
    flag_emoji?: string | null;
    call_sign?: string | null;
    imo_number?: number | null;
    loa?: number | null;
    beam?: number | null;
    draft?: number | null;
    photo_url?: string | null;
    thumbnail_url?: string | null;
    data_source?: string | null;
    is_verified?: boolean;
    last_scraped_at?: string;
}

/**
 * Upsert vessel metadata rows.
 * Uses MMSI as the conflict key.
 */
export async function upsertMetadata(rows: VesselMetadataRow[]): Promise<number> {
    if (rows.length === 0) return 0;

    const withTimestamp = rows.map((r) => ({
        ...r,
        last_scraped_at: new Date().toISOString(),
    }));

    const { error } = await supabase
        .from('vessel_metadata')
        .upsert(withTimestamp, { onConflict: 'mmsi' });

    if (error) {
        console.error(`[Scraper] Upsert failed:`, error.message);
        return 0;
    }

    return rows.length;
}

/**
 * Get MMSIs from the live vessels table that are NOT yet in vessel_metadata,
 * or whose metadata is older than `maxAgeDays`.
 */
export async function getStaleOrMissingMmsis(maxAgeDays = 7, limit = 200): Promise<number[]> {
    const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();

    // All active vessels
    const { data: vessels, error: vErr } = await supabase
        .from('vessels')
        .select('mmsi')
        .order('updated_at', { ascending: false })
        .limit(limit);

    if (vErr || !vessels) {
        console.error('[Scraper] Failed to fetch vessels:', vErr?.message);
        return [];
    }

    const allMmsis = vessels.map((v: { mmsi: number }) => v.mmsi);

    // Find which ones already have fresh metadata
    const { data: existing } = await supabase
        .from('vessel_metadata')
        .select('mmsi')
        .in('mmsi', allMmsis)
        .gte('last_scraped_at', cutoff);

    const freshSet = new Set((existing || []).map((e: { mmsi: number }) => e.mmsi));
    return allMmsis.filter((m: number) => !freshSet.has(m));
}
