/**
 * Supabase client + vessel_metadata helpers for the scraper edge function.
 *
 * Uses the service role key so writes bypass RLS. The client is created
 * once at module scope and reused across scraper modules.
 */
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL') ?? '';
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '';

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

/** Upsert vessel metadata rows keyed on mmsi, in chunks of 500. */
export async function upsertMetadata(rows: VesselMetadataRow[]): Promise<number> {
    if (rows.length === 0) return 0;

    const withTimestamp = rows.map((r) => ({
        ...r,
        last_scraped_at: new Date().toISOString(),
    }));

    let total = 0;
    for (let i = 0; i < withTimestamp.length; i += 500) {
        const chunk = withTimestamp.slice(i, i + 500);
        const { error } = await supabase.from('vessel_metadata').upsert(chunk, { onConflict: 'mmsi' });

        if (error) {
            console.error(`[Scraper] Upsert failed (batch ${i}):`, error.message);
        } else {
            total += chunk.length;
        }
    }

    return total;
}

/**
 * MMSIs from the vessels table that need metadata. Two-pass:
 *   1. Named vessels first (highest value — we can surface real ship names)
 *   2. Unnamed vessels (still get flag/country/type from the MID decoder)
 * Excludes rows whose metadata is fresher than `maxAgeDays`.
 */
export async function getStaleOrMissingMmsis(maxAgeDays = 7, limit = 500): Promise<number[]> {
    const cutoff = new Date(Date.now() - maxAgeDays * 86400000).toISOString();

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

    const { data: allVessels, error: vErr } = await supabase
        .from('vessels')
        .select('mmsi')
        .order('updated_at', { ascending: false })
        .limit(limit);

    if (vErr) {
        console.error('[Scraper] Failed to fetch vessels:', vErr.message);
    }

    const seenMmsis = new Set<number>();
    const orderedMmsis: number[] = [];

    for (const v of namedVessels || []) {
        if (!seenMmsis.has(v.mmsi)) {
            orderedMmsis.push(v.mmsi);
            seenMmsis.add(v.mmsi);
        }
    }

    for (const v of allVessels || []) {
        if (!seenMmsis.has(v.mmsi)) {
            orderedMmsis.push(v.mmsi);
            seenMmsis.add(v.mmsi);
        }
    }

    const combined = orderedMmsis.slice(0, limit);
    if (combined.length === 0) return [];

    const freshSet = new Set<number>();
    for (let i = 0; i < combined.length; i += 200) {
        const chunk = combined.slice(i, i + 200);
        const { data: existing } = await supabase
            .from('vessel_metadata')
            .select('mmsi')
            .in('mmsi', chunk)
            .gte('last_scraped_at', cutoff);

        for (const e of existing || []) {
            freshSet.add(e.mmsi);
        }
    }

    const stale = combined.filter((m: number) => !freshSet.has(m));
    console.log(`   📊 ${(namedVessels || []).length} named vessels found, ${stale.length} need seeding`);
    return stale;
}
