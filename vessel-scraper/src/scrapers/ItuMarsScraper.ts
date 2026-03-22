/**
 * ItuMarsScraper — Priority 4: Global / Asia / Caribbean fallback
 *
 * Targets ITU MARS (Maritime mobile Access and Retrieval System) — List V,
 * the international master directory of ship stations.
 *
 * For fishing vessels, integrates the Global Fishing Watch (GFW) API which
 * provides enriched vessel identity for fishing fleets worldwide.
 *
 * ITU MARS: https://www.itu.int/en/ITU-R/terrestrial/mars/Pages/default.aspx
 * GFW API: https://gateway.api.globalfishingwatch.org/v3/vessels
 */

import { VesselMetadataRow, upsertMetadata } from '../supabase';

const GFW_API_BASE = 'https://gateway.api.globalfishingwatch.org/v3';
const GFW_API_KEY = process.env.GFW_API_KEY || '';
const ITU_MARS_URL = process.env.ITU_MARS_URL || 'https://www.itu.int/mmsapp/ShipStation/list';
const REQUEST_DELAY_MS = 2000;

/**
 * Scrape vessel metadata using ITU MARS + Global Fishing Watch.
 * Global fallback for non-AU/US/EU vessels.
 */
export async function scrapeItuMars(mmsis: number[]): Promise<number> {
    console.log(`[ITU/GFW] Scraping ${mmsis.length} global vessels...`);
    const results: VesselMetadataRow[] = [];

    for (const mmsi of mmsis) {
        try {
            // Try Global Fishing Watch first (better for fishing vessels)
            let record = await queryGfw(mmsi);

            // Fallback to ITU MARS
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

// ── Global Fishing Watch query ──

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
            flag_emoji: null, // Will be set by MID decoder on client
            call_sign: registry?.callsign || selfReport?.callsign || null,
            imo_number: registry?.imoNumber ? parseInt(registry.imoNumber, 10) : null,
            loa: registry?.lengthM || null,
            data_source: 'GFW',
            is_verified: !!registry, // Registry data is verified
        };
    } catch (e) {
        console.warn(`[GFW] Query failed for ${mmsi}:`, e);
        return null;
    }
}

// ── ITU MARS query ──

async function queryItuMars(mmsi: number): Promise<VesselMetadataRow | null> {
    try {
        // ITU MARS List V — query the public ship station database
        const resp = await fetch(`${ITU_MARS_URL}?is498=true&MmsiNo=${mmsi}`, {
            headers: { 'User-Agent': 'Thalassa-VesselScraper/1.0' },
        });

        if (!resp.ok) return null;

        const html = await resp.text();

        // Parse the ITU response HTML for vessel details
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
            flag_emoji: null, // Set by client-side MID decoder
            call_sign: extract(/Call Sign[^<]*<[^>]*>([^<]+)/i) || null,
            data_source: 'ITU_MARS',
            is_verified: true,
        };
    } catch (e) {
        console.warn(`[ITU] Query failed for ${mmsi}:`, e);
        return null;
    }
}
