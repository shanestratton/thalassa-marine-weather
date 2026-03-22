/**
 * UscgScraper — Priority 2: USA (MID 338/366-369)
 *
 * Targets the USCG Authoritative Vessel Identification Service (AVIS).
 * Data source: Marine Cadastre / BOEM vessel dataset on Azure.
 *
 * The 2026 USCG AVIS provides accurate vessel registration data including
 * official vessel name, type, call sign, and dimensions for US-flagged vessels.
 *
 * Alternative: MarineCadastre.gov Parquet point data (Azure Blob Storage)
 * for bulk historical lookups.
 */

import { VesselMetadataRow, upsertMetadata } from '../supabase';

const USCG_API_BASE = process.env.USCG_API_URL || 'https://cgmix.uscg.mil/xml';
const REQUEST_DELAY_MS = 2000;

interface UscgVesselRecord {
    VesselName?: string;
    CallSign?: string;
    VesselTypeDesc?: string;
    GrossTonnage?: number;
    Length?: number;
    Breadth?: number;
    Depth?: number;
    IMONumber?: string;
}

/**
 * Scrape vessel metadata from USCG for a batch of US-flagged MMSIs.
 */
export async function scrapeUscg(mmsis: number[]): Promise<number> {
    console.log(`[USCG] Scraping ${mmsis.length} US vessels...`);
    const results: VesselMetadataRow[] = [];

    for (const mmsi of mmsis) {
        try {
            // USCG CGMIX API endpoint — query by MMSI
            const url = `${USCG_API_BASE}/PSIXData.aspx?MMSI=${mmsi}`;
            const resp = await fetch(url, {
                headers: { 'User-Agent': 'Thalassa-VesselScraper/1.0' },
            });

            if (!resp.ok) {
                console.warn(`[USCG] HTTP ${resp.status} for MMSI ${mmsi}`);
                continue;
            }

            const text = await resp.text();

            // Parse XML response (lightweight — extract key fields)
            const extractField = (xml: string, tag: string): string | null => {
                const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
                return match ? match[1].trim() : null;
            };

            const vesselName = extractField(text, 'VesselName');
            if (!vesselName) continue; // No match

            results.push({
                mmsi,
                vessel_name: vesselName,
                vessel_type: extractField(text, 'VesselTypeDesc') || null,
                flag_country: 'United States',
                flag_emoji: '🇺🇸',
                call_sign: extractField(text, 'CallSign') || null,
                imo_number: extractField(text, 'IMONumber') ? parseInt(extractField(text, 'IMONumber')!, 10) : null,
                loa: extractField(text, 'Length')
                    ? parseFloat(extractField(text, 'Length')!) * 0.3048 // feet → metres
                    : null,
                beam: extractField(text, 'Breadth') ? parseFloat(extractField(text, 'Breadth')!) * 0.3048 : null,
                draft: extractField(text, 'Depth') ? parseFloat(extractField(text, 'Depth')!) * 0.3048 : null,
                data_source: 'USCG',
                is_verified: true,
            });

            await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
        } catch (e) {
            console.warn(`[USCG] Error scraping MMSI ${mmsi}:`, e);
        }
    }

    const upserted = await upsertMetadata(results);
    console.log(`[USCG] Upserted ${upserted} vessels`);
    return upserted;
}
