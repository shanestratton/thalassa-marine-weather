/**
 * ItuMarsScraper — Priority 4: Global / Asia / Caribbean fallback.
 *
 * Tries Global Fishing Watch first (strong fishing-fleet coverage, requires
 * GFW_API_KEY), then falls back to ITU MARS List V (public ship-station DB).
 * Handles everything not covered by AMSA/USCG/Equasis.
 */
import { VesselMetadataRow, upsertMetadata } from '../supabase.ts';

const GFW_API_BASE = 'https://gateway.api.globalfishingwatch.org/v3';
const GFW_API_KEY = Deno.env.get('GFW_API_KEY') ?? '';
const ITU_MARS_URL = Deno.env.get('ITU_MARS_URL') ?? 'https://www.itu.int/mmsapp/ShipStation/list';
const REQUEST_DELAY_MS = 2000;

export async function scrapeItuMars(mmsis: number[]): Promise<number> {
    console.log(`[ITU/GFW] Scraping ${mmsis.length} global vessels...`);
    const results: VesselMetadataRow[] = [];

    for (const mmsi of mmsis) {
        try {
            let record = await queryGfw(mmsi);
            if (!record) {
                record = await queryItuMars(mmsi);
            }
            if (record) {
                results.push(record);
            }
            await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
        } catch (e) {
            console.warn(`[ITU/GFW] Error scraping MMSI ${mmsi}:`, e);
        }
    }

    const upserted = await upsertMetadata(results);
    console.log(`[ITU/GFW] Upserted ${upserted} vessels`);
    return upserted;
}

async function queryGfw(mmsi: number): Promise<VesselMetadataRow | null> {
    if (!GFW_API_KEY) return null;

    try {
        const resp = await fetch(
            `${GFW_API_BASE}/vessels/search?query=${mmsi}&datasets[0]=public-global-vessel-identity:latest`,
            {
                headers: {
                    Authorization: `Bearer ${GFW_API_KEY}`,
                    'User-Agent': 'Thalassa-VesselScraper/1.0',
                },
            },
        );

        if (!resp.ok) return null;

        const data = (await resp.json()) as {
            entries?: Array<{
                selfReportedInfo?: Array<{
                    shipname?: string;
                    callsign?: string;
                    flag?: string;
                    geartype?: string;
                    imo?: string;
                    ssvid?: string;
                }>;
                registryInfo?: Array<{
                    shipname?: string;
                    callsign?: string;
                    flag?: string;
                    shiptype?: string;
                    imoNumber?: string;
                    lengthM?: number;
                    tonnageGt?: number;
                }>;
            }>;
        };

        if (!data.entries || data.entries.length === 0) return null;

        const entry = data.entries[0];
        const registry = entry.registryInfo?.[0];
        const selfReport = entry.selfReportedInfo?.[0];

        const name = registry?.shipname || selfReport?.shipname;
        if (!name) return null;

        return {
            mmsi,
            vessel_name: name,
            vessel_type: registry?.shiptype || selfReport?.geartype || 'Fishing Vessel',
            flag_country: registry?.flag || selfReport?.flag || null,
            flag_emoji: null,
            call_sign: registry?.callsign || selfReport?.callsign || null,
            imo_number: registry?.imoNumber ? parseInt(registry.imoNumber, 10) : null,
            loa: registry?.lengthM || null,
            data_source: 'GFW',
            is_verified: !!registry,
        };
    } catch (e) {
        console.warn(`[GFW] Query failed for ${mmsi}:`, e);
        return null;
    }
}

async function queryItuMars(mmsi: number): Promise<VesselMetadataRow | null> {
    try {
        const resp = await fetch(`${ITU_MARS_URL}?is498=true&MmsiNo=${mmsi}`, {
            headers: { 'User-Agent': 'Thalassa-VesselScraper/1.0' },
        });

        if (!resp.ok) return null;

        const html = await resp.text();

        const extract = (pattern: RegExp): string | undefined => {
            const m = html.match(pattern);
            return m ? m[1].trim() : undefined;
        };

        const shipName = extract(/Ship Name[^<]*<[^>]*>([^<]+)/i);
        if (!shipName) return null;

        return {
            mmsi,
            vessel_name: shipName,
            vessel_type: extract(/Ship Type[^<]*<[^>]*>([^<]+)/i) || null,
            flag_country: extract(/Flag[^<]*<[^>]*>([^<]+)/i) || null,
            flag_emoji: null,
            call_sign: extract(/Call Sign[^<]*<[^>]*>([^<]+)/i) || null,
            data_source: 'ITU_MARS',
            is_verified: true,
        };
    } catch (e) {
        console.warn(`[ITU] Query failed for ${mmsi}:`, e);
        return null;
    }
}
