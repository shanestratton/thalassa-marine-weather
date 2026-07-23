/**
 * AmsaScraper — Priority 1: Australia (MID 503).
 *
 * Queries the AMSA Ship Register ArcGIS feature service by MMSI. Returns
 * verified vessel identity + dimensions straight from the Australian
 * Maritime Safety Authority.
 */
import { VesselMetadataRow, upsertMetadata } from '../supabase.ts';
import { fetchWithTimeout, readResponseTextLimited } from '../../../_shared/http-security.ts';

const AMSA_API_BASE = Deno.env.get('AMSA_API_URL') ?? 'https://services.amsa.gov.au/arcgis/rest/services';
const AMSA_LAYER = '/ShipRegister/MapServer/0/query';
const REQUEST_DELAY_MS = 2000;

interface AmsaVesselRecord {
    attributes: {
        MMSI_NUMBER?: number;
        VESSEL_NAME?: string;
        CALL_SIGN?: string;
        VESSEL_TYPE?: string;
        FLAG?: string;
        LENGTH_OVERALL?: number;
        BREADTH?: number;
        DEPTH_DRAUGHT?: number;
        IMO_NUMBER?: number;
    };
}

export async function scrapeAmsa(mmsis: number[]): Promise<number> {
    console.log(`[AMSA] Scraping ${mmsis.length} Australian vessels...`);
    const results: VesselMetadataRow[] = [];

    for (const mmsi of mmsis) {
        try {
            const url = new URL(`${AMSA_API_BASE}${AMSA_LAYER}`);
            url.searchParams.set('where', `MMSI_NUMBER=${mmsi}`);
            url.searchParams.set('outFields', '*');
            url.searchParams.set('f', 'json');
            url.searchParams.set('returnGeometry', 'false');

            const resp = await fetchWithTimeout(
                url.toString(),
                {
                    headers: { 'User-Agent': 'Thalassa-VesselScraper/1.0' },
                },
                6_000,
            );

            if (!resp.ok) {
                console.warn(`[AMSA] HTTP ${resp.status} for MMSI ${mmsi}`);
                continue;
            }

            const responseText = await readResponseTextLimited(resp, 1_000_000);
            if (responseText === null) throw new Error('AMSA response exceeded the byte limit');
            const data = JSON.parse(responseText) as { features?: AmsaVesselRecord[] };
            if (!data.features || data.features.length === 0) continue;

            const record = data.features[0].attributes;
            results.push({
                mmsi,
                vessel_name: record.VESSEL_NAME || null,
                vessel_type: record.VESSEL_TYPE || null,
                flag_country: 'Australia',
                flag_emoji: '🇦🇺',
                call_sign: record.CALL_SIGN || null,
                imo_number: record.IMO_NUMBER || null,
                loa: record.LENGTH_OVERALL || null,
                beam: record.BREADTH || null,
                draft: record.DEPTH_DRAUGHT || null,
                data_source: 'AMSA',
                is_verified: true,
            });
        } catch (e) {
            console.warn(`[AMSA] Error scraping MMSI ${mmsi}:`, e);
        } finally {
            await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
        }
    }

    const upserted = await upsertMetadata(results);
    console.log(`[AMSA] Upserted ${upserted} vessels`);
    return upserted;
}
