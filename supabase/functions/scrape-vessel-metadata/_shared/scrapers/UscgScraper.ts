/**
 * UscgScraper — Priority 2: USA (MID 303/338/339/366-369).
 *
 * Queries the USCG CGMIX PSIX XML service by MMSI. Lightweight regex parse
 * pulls the key identity/dimension fields; US PSIX reports imperial units
 * so lengths/beams/drafts are converted feet → metres.
 */
import { VesselMetadataRow, upsertMetadata } from '../supabase.ts';
import { fetchWithTimeout, readResponseTextLimited } from '../../../_shared/http-security.ts';

const USCG_API_BASE = Deno.env.get('USCG_API_URL') ?? 'https://cgmix.uscg.mil/xml';
const REQUEST_DELAY_MS = 2000;

export async function scrapeUscg(mmsis: number[]): Promise<number> {
    console.log(`[USCG] Scraping ${mmsis.length} US vessels...`);
    const results: VesselMetadataRow[] = [];

    for (const mmsi of mmsis) {
        try {
            const url = `${USCG_API_BASE}/PSIXData.aspx?MMSI=${mmsi}`;
            const resp = await fetchWithTimeout(
                url,
                {
                    headers: { 'User-Agent': 'Thalassa-VesselScraper/1.0' },
                },
                6_000,
            );

            if (!resp.ok) {
                console.warn(`[USCG] HTTP ${resp.status} for MMSI ${mmsi}`);
                continue;
            }

            const text = await readResponseTextLimited(resp, 1_000_000);
            if (text === null) throw new Error('USCG response exceeded the byte limit');

            const extractField = (xml: string, tag: string): string | null => {
                const match = xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`, 'i'));
                return match ? match[1].trim() : null;
            };

            const vesselName = extractField(text, 'VesselName');
            if (!vesselName) continue;

            results.push({
                mmsi,
                vessel_name: vesselName,
                vessel_type: extractField(text, 'VesselTypeDesc') || null,
                flag_country: 'United States',
                flag_emoji: '🇺🇸',
                call_sign: extractField(text, 'CallSign') || null,
                imo_number: extractField(text, 'IMONumber') ? parseInt(extractField(text, 'IMONumber')!, 10) : null,
                loa: extractField(text, 'Length') ? parseFloat(extractField(text, 'Length')!) * 0.3048 : null,
                beam: extractField(text, 'Breadth') ? parseFloat(extractField(text, 'Breadth')!) * 0.3048 : null,
                draft: extractField(text, 'Depth') ? parseFloat(extractField(text, 'Depth')!) * 0.3048 : null,
                data_source: 'USCG',
                is_verified: true,
            });
        } catch (e) {
            console.warn(`[USCG] Error scraping MMSI ${mmsi}:`, e);
        } finally {
            await new Promise((resolve) => setTimeout(resolve, REQUEST_DELAY_MS));
        }
    }

    const upserted = await upsertMetadata(results);
    console.log(`[USCG] Upserted ${upserted} vessels`);
    return upserted;
}
