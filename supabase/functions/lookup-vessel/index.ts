/**
 * lookup-vessel — Supabase Edge Function
 *
 * On-demand vessel enrichment: when a user taps a vessel not in our database,
 * this function queries external sources, caches the result in vessel_metadata,
 * and returns it. Next lookup is instant.
 *
 * Query params:
 *   mmsi — 9-digit MMSI number (required)
 *
 * Lookup waterfall:
 *   1. vessel_metadata table (already cached?)
 *   2. amsa_register table (Australian vessels by name)
 *   3. VesselFinder public page scraping (no API key needed)
 *   4. ITU MARS database lookup (name, call sign, flag)
 *
 * Returns: VesselMetadata JSON or { found: false }
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

interface VesselResult {
    mmsi: number;
    vessel_name: string | null;
    vessel_type: string | null;
    flag_country: string | null;
    flag_emoji: string | null;
    call_sign: string | null;
    imo_number: number | null;
    loa: number | null;
    beam: number | null;
    draft: number | null;
    data_source: string;
}

// ── MMSI MID → Country/Flag mapping ──
const MID_MAP: Record<string, [string, string]> = {
    '201': ['Albania', '🇦🇱'],
    '205': ['Belgium', '🇧🇪'],
    '209': ['Cyprus', '🇨🇾'],
    '210': ['Cyprus', '🇨🇾'],
    '211': ['Germany', '🇩🇪'],
    '212': ['Cyprus', '🇨🇾'],
    '215': ['Malta', '🇲🇹'],
    '218': ['Germany', '🇩🇪'],
    '219': ['Denmark', '🇩🇰'],
    '220': ['Denmark', '🇩🇰'],
    '224': ['Spain', '🇪🇸'],
    '225': ['Spain', '🇪🇸'],
    '226': ['France', '🇫🇷'],
    '227': ['France', '🇫🇷'],
    '228': ['France', '🇫🇷'],
    '229': ['Malta', '🇲🇹'],
    '230': ['Finland', '🇫🇮'],
    '231': ['Faroe Islands', '🇫🇴'],
    '232': ['United Kingdom', '🇬🇧'],
    '233': ['United Kingdom', '🇬🇧'],
    '234': ['United Kingdom', '🇬🇧'],
    '235': ['United Kingdom', '🇬🇧'],
    '236': ['Gibraltar', '🇬🇮'],
    '237': ['Greece', '🇬🇷'],
    '238': ['Croatia', '🇭🇷'],
    '239': ['Greece', '🇬🇷'],
    '240': ['Greece', '🇬🇷'],
    '241': ['Greece', '🇬🇷'],
    '244': ['Netherlands', '🇳🇱'],
    '245': ['Netherlands', '🇳🇱'],
    '246': ['Netherlands', '🇳🇱'],
    '247': ['Italy', '🇮🇹'],
    '248': ['Malta', '🇲🇹'],
    '249': ['Malta', '🇲🇹'],
    '250': ['Ireland', '🇮🇪'],
    '251': ['Iceland', '🇮🇸'],
    '255': ['Portugal', '🇵🇹'],
    '256': ['Malta', '🇲🇹'],
    '257': ['Norway', '🇳🇴'],
    '258': ['Norway', '🇳🇴'],
    '259': ['Norway', '🇳🇴'],
    '261': ['Poland', '🇵🇱'],
    '263': ['Portugal', '🇵🇹'],
    '264': ['Romania', '🇷🇴'],
    '265': ['Sweden', '🇸🇪'],
    '266': ['Sweden', '🇸🇪'],
    '269': ['Switzerland', '🇨🇭'],
    '271': ['Turkey', '🇹🇷'],
    '272': ['Ukraine', '🇺🇦'],
    '273': ['Russia', '🇷🇺'],
    '303': ['United States', '🇺🇸'],
    '338': ['United States', '🇺🇸'],
    '366': ['United States', '🇺🇸'],
    '367': ['United States', '🇺🇸'],
    '368': ['United States', '🇺🇸'],
    '369': ['United States', '🇺🇸'],
    '403': ['Saudi Arabia', '🇸🇦'],
    '405': ['Bangladesh', '🇧🇩'],
    '408': ['Bahrain', '🇧🇭'],
    '412': ['China', '🇨🇳'],
    '413': ['China', '🇨🇳'],
    '414': ['China', '🇨🇳'],
    '416': ['Taiwan', '🇹🇼'],
    '419': ['India', '🇮🇳'],
    '422': ['Iran', '🇮🇷'],
    '428': ['Israel', '🇮🇱'],
    '431': ['Japan', '🇯🇵'],
    '432': ['Japan', '🇯🇵'],
    '440': ['South Korea', '🇰🇷'],
    '441': ['South Korea', '🇰🇷'],
    '447': ['Kuwait', '🇰🇼'],
    '450': ['Lebanon', '🇱🇧'],
    '461': ['Oman', '🇴🇲'],
    '463': ['Pakistan', '🇵🇰'],
    '466': ['Qatar', '🇶🇦'],
    '470': ['UAE', '🇦🇪'],
    '471': ['UAE', '🇦🇪'],
    '473': ['Yemen', '🇾🇪'],
    '501': ['Antarctica', '🇦🇶'],
    '503': ['Australia', '🇦🇺'],
    '512': ['New Zealand', '🇳🇿'],
    '525': ['Indonesia', '🇮🇩'],
    '533': ['Malaysia', '🇲🇾'],
    '538': ['Marshall Islands', '🇲🇭'],
    '548': ['Philippines', '🇵🇭'],
    '563': ['Singapore', '🇸🇬'],
    '564': ['Singapore', '🇸🇬'],
    '565': ['Singapore', '🇸🇬'],
    '566': ['Singapore', '🇸🇬'],
    '567': ['Thailand', '🇹🇭'],
    '574': ['Vietnam', '🇻🇳'],
};

function decodeMmsiFlag(mmsi: number): [string, string] {
    const s = String(mmsi);
    const mid = s.substring(0, 3);
    return MID_MAP[mid] || ['Unknown', '🏳️'];
}

// ── Source 1: VesselFinder public page ──
async function lookupVesselFinder(mmsi: number): Promise<Partial<VesselResult> | null> {
    try {
        const url = `https://www.vesselfinder.com/vessels/details/${mmsi}`;
        const resp = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; ThalassaBot/1.0)',
                Accept: 'text/html',
            },
            signal: AbortSignal.timeout(8000),
        });

        if (!resp.ok) return null;
        const html = await resp.text();

        // Parse vessel details from HTML
        const getName = (h: string) => {
            const m = h.match(/<h1[^>]*class="[^"]*title[^"]*"[^>]*>([^<]+)/i) || h.match(/<title>([^-|<]+)/i);
            if (m) {
                let name = m[1].trim();
                // Remove "Ship" suffix from title
                name = name.replace(/\s*[-–]\s*Vessel\s*details.*$/i, '').trim();
                name = name.replace(/\s*Ship\s*$/i, '').trim();
                return name || null;
            }
            return null;
        };

        const getField = (h: string, label: string): string | null => {
            // Look for table row: <td>Label</td><td>Value</td>
            const patterns = [
                new RegExp(`>${label}</(?:td|th)>\\s*<(?:td|th)[^>]*>([^<]+)`, 'i'),
                new RegExp(`"${label}"[^>]*>[^<]*</[^>]+>\\s*<[^>]+>([^<]+)`, 'i'),
            ];
            for (const p of patterns) {
                const m = h.match(p);
                if (m) return m[1].trim();
            }
            return null;
        };

        const name = getName(html);
        if (!name || name.length < 2) return null;

        const callSign = getField(html, 'Call Sign') || getField(html, 'Callsign');
        const imoStr = getField(html, 'IMO');
        const typeStr = getField(html, 'Type');
        const lengthStr = getField(html, 'Length');
        const beamStr = getField(html, 'Beam') || getField(html, 'Width');
        const draftStr = getField(html, 'Draft') || getField(html, 'Draught');
        const flagStr = getField(html, 'Flag');

        const [country, emoji] = decodeMmsiFlag(mmsi);

        return {
            mmsi,
            vessel_name: name.toUpperCase(),
            vessel_type: typeStr || null,
            flag_country: flagStr || country,
            flag_emoji: emoji,
            call_sign: callSign || null,
            imo_number: imoStr ? parseInt(imoStr.replace(/\D/g, ''), 10) || null : null,
            loa: lengthStr ? parseFloat(lengthStr) || null : null,
            beam: beamStr ? parseFloat(beamStr) || null : null,
            draft: draftStr ? parseFloat(draftStr) || null : null,
            data_source: 'vesselfinder',
        };
    } catch (e) {
        console.warn('[VesselFinder] lookup failed:', e);
        return null;
    }
}

// ── Source 2: ITU MARS database ──
async function lookupItuMars(mmsi: number): Promise<Partial<VesselResult> | null> {
    try {
        const url = `https://www.itu.int/mmsapp/ShipStation/list?is498498498=true&ShipMmsi=${mmsi}`;
        const resp = await fetch(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; ThalassaBot/1.0)',
                Accept: 'text/html',
            },
            signal: AbortSignal.timeout(8000),
        });

        if (!resp.ok) return null;
        const html = await resp.text();

        // ITU MARS returns a table with: Name, Call Sign, MMSI, ...
        const nameMatch = html.match(/ShipStation\/Ships\/Detail[^>]+>([^<]+)/i);
        const callSignMatch = html.match(/<td[^>]*>\s*([A-Z0-9]{4,8})\s*<\/td>/i);

        if (!nameMatch) return null;

        const name = nameMatch[1].trim();
        if (!name || name.length < 2) return null;

        const [country, emoji] = decodeMmsiFlag(mmsi);

        return {
            mmsi,
            vessel_name: name.toUpperCase(),
            vessel_type: null,
            flag_country: country,
            flag_emoji: emoji,
            call_sign: callSignMatch ? callSignMatch[1].trim() : null,
            imo_number: null,
            loa: null,
            beam: null,
            draft: null,
            data_source: 'itu_mars',
        };
    } catch (e) {
        console.warn('[ITU MARS] lookup failed:', e);
        return null;
    }
}

Deno.serve(async (req: Request) => {
    // Handle CORS preflight
    if (req.method === 'OPTIONS') {
        return new Response('ok', { headers: corsHeaders });
    }

    try {
        const url = new URL(req.url);
        const mmsiStr = url.searchParams.get('mmsi');

        if (!mmsiStr || !/^\d{9}$/.test(mmsiStr)) {
            return new Response(JSON.stringify({ error: 'mmsi must be a 9-digit number' }), {
                status: 400,
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        const mmsi = parseInt(mmsiStr, 10);

        const supabase = createClient(
            Deno.env.get('SUPABASE_URL') ?? '',
            Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
        );

        // ── 1. Check vessel_metadata cache ──
        const { data: cached } = await supabase.from('vessel_metadata').select('*').eq('mmsi', mmsi).maybeSingle();

        if (cached && cached.vessel_name) {
            console.log(`[CACHE HIT] ${mmsi} = ${cached.vessel_name}`);
            return new Response(JSON.stringify({ ...cached, found: true, source: 'cache' }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // Check if we previously searched and found nothing — cooldown 24 hours
        if (cached && cached.data_source === 'not_found') {
            const scrapedAt = new Date(cached.last_scraped_at).getTime();
            const hoursSince = (Date.now() - scrapedAt) / 3600000;
            if (hoursSince < 24) {
                console.log(`[NEG CACHE] ${mmsi} — searched ${hoursSince.toFixed(1)}h ago, skipping re-lookup`);
                const [country, emoji] = decodeMmsiFlag(mmsi);
                return new Response(
                    JSON.stringify({
                        mmsi,
                        vessel_name: null,
                        flag_country: cached.flag_country || country,
                        flag_emoji: cached.flag_emoji || emoji,
                        found: false,
                        source: 'negative_cache',
                    }),
                    {
                        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                    },
                );
            }
            console.log(`[NEG CACHE EXPIRED] ${mmsi} — re-trying after ${hoursSince.toFixed(0)}h`);
        }

        // ── 2. Check amsa_register for Australian vessels ──
        if (mmsiStr.startsWith('503')) {
            // Check if we have a name from the vessels table to match against
            const { data: aisVessel } = await supabase.from('vessels').select('name').eq('mmsi', mmsi).maybeSingle();

            if (aisVessel?.name) {
                const { data: amsa } = await supabase
                    .from('amsa_register')
                    .select('*')
                    .eq('ship_name_upper', aisVessel.name.toUpperCase())
                    .maybeSingle();

                if (amsa) {
                    const result: VesselResult = {
                        mmsi,
                        vessel_name: aisVessel.name,
                        vessel_type: amsa.vessel_type,
                        flag_country: 'Australia',
                        flag_emoji: '🇦🇺',
                        call_sign: null,
                        imo_number: amsa.imo_number ? parseInt(amsa.imo_number, 10) : null,
                        loa: amsa.length_m,
                        beam: null,
                        draft: null,
                        data_source: 'amsa_register',
                    };

                    // Upsert into vessel_metadata
                    await supabase.from('vessel_metadata').upsert(
                        {
                            mmsi,
                            vessel_name: result.vessel_name,
                            vessel_type: result.vessel_type,
                            flag_country: result.flag_country,
                            flag_emoji: result.flag_emoji,
                            imo_number: result.imo_number,
                            loa: result.loa,
                            data_source: 'amsa_register',
                            last_scraped_at: new Date().toISOString(),
                        },
                        { onConflict: 'mmsi' },
                    );

                    console.log(`[AMSA] ${mmsi} = ${result.vessel_name}`);
                    return new Response(JSON.stringify({ ...result, found: true, source: 'amsa_register' }), {
                        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
                    });
                }
            }
        }

        // ── 3. External API waterfall ──
        console.log(`[LOOKUP] ${mmsi} — querying external sources...`);

        let result: Partial<VesselResult> | null = null;

        // Try VesselFinder first
        result = await lookupVesselFinder(mmsi);

        // Fallback to ITU MARS
        if (!result) {
            result = await lookupItuMars(mmsi);
        }

        // ── 4. If found, upsert and return ──
        if (result && result.vessel_name) {
            const [country, emoji] = decodeMmsiFlag(mmsi);

            const record = {
                mmsi,
                vessel_name: result.vessel_name || null,
                vessel_type: result.vessel_type || null,
                flag_country: result.flag_country || country,
                flag_emoji: result.flag_emoji || emoji,
                call_sign: result.call_sign || null,
                imo_number: result.imo_number || null,
                loa: result.loa || null,
                beam: result.beam || null,
                draft: result.draft || null,
                data_source: result.data_source || 'external',
                last_scraped_at: new Date().toISOString(),
            };

            await supabase.from('vessel_metadata').upsert(record, { onConflict: 'mmsi' });

            console.log(`[FOUND] ${mmsi} = ${result.vessel_name} via ${result.data_source}`);
            return new Response(JSON.stringify({ ...record, found: true, source: result.data_source }), {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            });
        }

        // ── 5. Not found anywhere — save negative result to prevent repeat lookups ──
        const [country, emoji] = decodeMmsiFlag(mmsi);
        console.log(`[NOT FOUND] ${mmsi} — saving negative result to prevent repeat lookups`);

        // Save a "searched but not found" record so other users don't repeat the search
        // The last_scraped_at timestamp allows re-trying after 24 hours
        await supabase.from('vessel_metadata').upsert(
            {
                mmsi,
                vessel_name: null,
                flag_country: country,
                flag_emoji: emoji,
                data_source: 'not_found',
                last_scraped_at: new Date().toISOString(),
            },
            { onConflict: 'mmsi' },
        );

        return new Response(
            JSON.stringify({
                mmsi,
                vessel_name: null,
                flag_country: country,
                flag_emoji: emoji,
                found: false,
                source: 'mmsi_decode',
            }),
            {
                headers: { ...corsHeaders, 'Content-Type': 'application/json' },
            },
        );
    } catch (e) {
        console.error('lookup-vessel error:', e);
        return new Response(JSON.stringify({ error: 'Internal server error' }), {
            status: 500,
            headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        });
    }
});
