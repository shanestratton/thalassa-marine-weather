/**
 * MmsiDecoder — priority routing for vessel enrichment scrapers.
 *
 * Ported from vessel-scraper/src/MmsiDecoder.ts. Logic mirrors the
 * client-side utils/MmsiDecoder.ts; we duplicate here because the
 * edge function runs in its own Deno sandbox.
 */

const US_MIDS = new Set([303, 338, 339, 366, 367, 368, 369]);
const AU_MID = 503;

function extractMid(mmsi: number): number {
    const s = String(mmsi).padStart(9, '0');
    return parseInt(s.substring(0, 3), 10);
}

/**
 * Returns scrape priority:
 *   1 = Australia (AMSA)
 *   2 = USA (USCG)
 *   3 = Europe (Equasis)
 *   4 = Global (ITU MARS / GFW)
 */
export function getScrapePriority(mmsi: number): 1 | 2 | 3 | 4 {
    const mid = extractMid(mmsi);
    if (mid === AU_MID) return 1;
    if (US_MIDS.has(mid)) return 2;
    if (mid >= 200 && mid <= 299) return 3;
    return 4;
}

export function getMid(mmsi: number): number {
    return extractMid(mmsi);
}
