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

    // Batch upsert in chunks of 500 to avoid payload limits
    let total = 0;
    for (let i = 0; i < withTimestamp.length; i += 500) {
        const chunk = withTimestamp.slice(i, i + 500);
        const { error } = await supabase
            .from('vessel_metadata')
            .upsert(chunk, { onConflict: 'mmsi' });

        if (error) {
            console.error(`[Scraper] Upsert failed (batch ${i}):`, error.message);
        } else {
            total += chunk.length;
        }
    }

    return total;
}

/**
 * Get MMSIs from the vessels table that need metadata.
 *
 * Two-pass strategy:
 *   1. Vessels WITH names first (highest value — we can show real ship names)
 *   2. Vessels without names (still get flag, country, ship type from decoder)
 *
 * Returns at most `limit` MMSIs, prioritizing named vessels.
 */
export async function getStaleOrMissingMmsis(maxAgeDays = 7, limit = 500): Promise<number[]> {
    const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();

    // ── Pass 1: Vessels WITH names (highest value seed targets) ──
    const { data: namedVessels, error: nErr } = await supabase
        .from('vessels')
        .select('mmsi')
        .not('name', 'is', null)
        .neq('name', '')
        .order('updated_at', { ascending: false })
        .limit(limit);

    if (nErr) {
        console.error('[Scraper] Failed to fetch named vessels:', nErr.message);
    }

    // ── Pass 2: ALL vessels (for flag/country even without name) ──
    const { data: allVessels, error: vErr } = await supabase
        .from('vessels')
        .select('mmsi')
        .order('updated_at', { ascending: false })
        .limit(limit);

    if (vErr) {
        console.error('[Scraper] Failed to fetch vessels:', vErr.message);
    }

    // Merge: named first, then unnamed, deduped
    const seenMmsis = new Set<number>();
    const orderedMmsis: number[] = [];

    // Named vessels get priority
    for (const v of (namedVessels || [])) {
        if (!seenMmsis.has(v.mmsi)) {
            orderedMmsis.push(v.mmsi);
            seenMmsis.add(v.mmsi);
        }
    }

    // Then fill remaining slots with unnamed vessels
    for (const v of (allVessels || [])) {
        if (!seenMmsis.has(v.mmsi)) {
            orderedMmsis.push(v.mmsi);
            seenMmsis.add(v.mmsi);
        }
    }

    const combined = orderedMmsis.slice(0, limit);

    // Filter out those with fresh metadata already
    if (combined.length === 0) return [];

    // Check in batches of 200 (Supabase IN clause limit)
    const freshSet = new Set<number>();
    for (let i = 0; i < combined.length; i += 200) {
        const chunk = combined.slice(i, i + 200);
        const { data: existing } = await supabase
            .from('vessel_metadata')
            .select('mmsi')
            .in('mmsi', chunk)
            .gte('last_scraped_at', cutoff);

        for (const e of (existing || [])) {
            freshSet.add(e.mmsi);
        }
    }

    const stale = combined.filter((m: number) => !freshSet.has(m));
    console.log(`   📊 ${(namedVessels || []).length} named vessels found, ${stale.length} need seeding`);
    return stale;
}
