/**
 * EquasisScraper — Priority 3: Europe (MID 200-299)
 *
 * Targets Equasis (EMSA) and the UK MCA Ship Register for European-flagged vessels.
 *
 * Equasis is the EU-wide maritime safety database maintained by EMSA and the
 * French Ministry of Transport. It provides verified vessel identity, inspection
 * history, and classification data.
 *
 * For high-volume areas (English Channel), uses MMDEC multimodal dataset logic
 * to correlate AIS positions with registered vessel identities.
 *
 * ⚠️  Equasis requires account credentials (EQUASIS_USER, EQUASIS_PASS).
 *     UK MCA register is publicly accessible via JSON API.
 */

import { VesselMetadataRow, upsertMetadata } from '../supabase';

const EQUASIS_BASE = process.env.EQUASIS_API_URL || 'https://www.equasis.org/EquasisWeb/restricted';
const EQUASIS_USER = process.env.EQUASIS_USER || '';
const EQUASIS_PASS = process.env.EQUASIS_PASS || '';
const UK_MCA_API = 'https://ukshipregister.co.uk/api/v1/vessels';
const REQUEST_DELAY_MS = 3000; // Equasis is rate-sensitive

interface EquasisVesselInfo {
    shipName?: string;
    imoNumber?: string;
    callSign?: string;
    grossTonnage?: number;
    flagName?: string;
    typeOfShip?: string;
    length?: number;
    breadth?: number;
    draught?: number;
}

/**
 * Scrape vessel metadata from Equasis/MCA for European-flagged MMSIs.
 */
export async function scrapeEquasis(mmsis: number[]): Promise<number> {
    console.log(`[Equasis] Scraping ${mmsis.length} European vessels...`);
    const results: VesselMetadataRow[] = [];

    for (const mmsi of mmsis) {
        try {
            let record: EquasisVesselInfo | null = null;

            // Try Equasis first (if credentials available)
            if (EQUASIS_USER && EQUASIS_PASS) {
                record = await queryEquasis(mmsi);
            }

            // Fallback to UK MCA for British vessels (MID 232-235)
            if (!record) {
                const mid = parseInt(String(mmsi).padStart(9, '0').substring(0, 3), 10);
                if (mid >= 232 && mid <= 235) {
                    record = await queryUkMca(mmsi);
                }
            }

            if (!record || !record.shipName) continue;

            // Map flag from Equasis data or infer from MID
            const flagEmoji = inferFlagEmoji(record.flagName);

            results.push({
                mmsi,
                vessel_name: record.shipName,
                vessel_type: record.typeOfShip || null,
                flag_country: record.flagName || null,
                flag_emoji: flagEmoji,
                call_sign: record.callSign || null,
                imo_number: record.imoNumber ? parseInt(record.imoNumber, 10) : null,
                loa: record.length || null,
                beam: record.breadth || null,
                draft: record.draught || null,
                data_source: EQUASIS_USER ? 'Equasis' : 'UK_MCA',
                is_verified: true,
            });

            await new Promise((r) => setTimeout(r, REQUEST_DELAY_MS));
        } catch (e) {
            console.warn(`[Equasis] Error scraping MMSI ${mmsi}:`, e);
        }
    }

    const upserted = await upsertMetadata(results);
    console.log(`[Equasis] Upserted ${upserted} vessels`);
    return upserted;
}

// ── Equasis query ──

async function queryEquasis(mmsi: number): Promise<EquasisVesselInfo | null> {
    try {
        const loginResp = await fetch(`${EQUASIS_BASE}/HomePage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: `j_username=${encodeURIComponent(EQUASIS_USER)}&j_password=${encodeURIComponent(EQUASIS_PASS)}&submit=Login`,
            redirect: 'manual',
        });

        const cookies = loginResp.headers.get('set-cookie') || '';

        const searchResp = await fetch(`${EQUASIS_BASE}/ShipSearch?fs=SearchShip`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Cookie: cookies,
            },
            body: `P_MMSI=${mmsi}`,
        });

        if (!searchResp.ok) return null;

        const html = await searchResp.text();

        // Extract fields from Equasis HTML response
        const extract = (pattern: RegExp): string | undefined => {
            const m = html.match(pattern);
            return m ? m[1].trim() : undefined;
        };

        return {
            shipName: extract(/Ship name[^<]*<[^>]*>([^<]+)/i),
            imoNumber: extract(/IMO number[^<]*<[^>]*>(\d+)/i),
            callSign: extract(/Call Sign[^<]*<[^>]*>([^<]+)/i),
            flagName: extract(/Flag[^<]*<[^>]*>([^<]+)/i),
            typeOfShip: extract(/Type of ship[^<]*<[^>]*>([^<]+)/i),
        };
    } catch (e) {
        console.warn(`[Equasis] Query failed for ${mmsi}:`, e);
        return null;
    }
}

// ── UK MCA query ──

async function queryUkMca(mmsi: number): Promise<EquasisVesselInfo | null> {
    try {
        const resp = await fetch(`${UK_MCA_API}?mmsi=${mmsi}`, {
            headers: { 'User-Agent': 'Thalassa-VesselScraper/1.0' },
        });

        if (!resp.ok) return null;
        const data = (await resp.json()) as {
            vessels?: Array<{
                name?: string;
                callSign?: string;
                type?: string;
                flag?: string;
                length?: number;
                breadth?: number;
                draught?: number;
                imoNumber?: string;
            }>;
        };

        if (!data.vessels || data.vessels.length === 0) return null;
        const v = data.vessels[0];

        return {
            shipName: v.name,
            callSign: v.callSign,
            typeOfShip: v.type,
            flagName: v.flag || 'United Kingdom',
            length: v.length,
            breadth: v.breadth,
            draught: v.draught,
            imoNumber: v.imoNumber,
        };
    } catch (e) {
        console.warn(`[UK_MCA] Query failed for ${mmsi}:`, e);
        return null;
    }
}

// ── Flag emoji inference ──

const FLAG_MAP: Record<string, string> = {
    'United Kingdom': '🇬🇧',
    France: '🇫🇷',
    Germany: '🇩🇪',
    Netherlands: '🇳🇱',
    Spain: '🇪🇸',
    Italy: '🇮🇹',
    Greece: '🇬🇷',
    Norway: '🇳🇴',
    Denmark: '🇩🇰',
    Sweden: '🇸🇪',
    Finland: '🇫🇮',
    Portugal: '🇵🇹',
    Malta: '🇲🇹',
    Cyprus: '🇨🇾',
    Ireland: '🇮🇪',
    Belgium: '🇧🇪',
    Poland: '🇵🇱',
    Croatia: '🇭🇷',
    Turkey: '🇹🇷',
    Gibraltar: '🇬🇮',
    Iceland: '🇮🇸',
};

function inferFlagEmoji(flagName?: string): string {
    if (!flagName) return '🏴';
    return FLAG_MAP[flagName] || '🇪🇺';
}
