/**
 * CycloneTrackingService — Global tropical cyclone tracking.
 *
 * Primary source: KnackWx ATCF API (real-time, 15-min updates, global)
 *   → https://api.knackwx.com/atcf/v2
 *   → Free, CORS-enabled, JSON
 *
 * Fallback/track source: NOAA IBTrACS Active CSV (historical track paths)
 *   → Updates weekly, used for storm track lines only
 *
 * Saffir-Simpson category from max sustained wind (knots):
 *   TD: < 34 kts    TS: 34-63 kts    Cat 1: 64-82 kts
 *   Cat 2: 83-95    Cat 3: 96-113    Cat 4: 114-135    Cat 5: > 135
 */

// ── Types ──────────────────────────────────────────────────

export interface CyclonePosition {
    lat: number;
    lon: number;
    time: string;
    windKts: number | null;
    pressureMb: number | null;
}

export interface ActiveCyclone {
    sid: string;
    name: string;
    basin: string;
    category: number; // Saffir-Simpson 0-5 (0 = TS/TD)
    categoryLabel: string; // "TD", "TS", "1", "2", "3", "4", "5"
    currentPosition: CyclonePosition;
    track: CyclonePosition[];
    maxWindKts: number;
    minPressureMb: number | null;
    nature: string; // TY, TS, TD, DB, etc.
}

// ── Constants ──────────────────────────────────────────────

const ATCF_URL = 'https://api.knackwx.com/atcf/v2';
const IBTRACS_URL =
    'https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.ACTIVE.list.v04r01.csv';

const CACHE_TTL = 10 * 60 * 1000; // 10 minutes

// ── Cache ──────────────────────────────────────────────────

let cachedCyclones: { data: ActiveCyclone[]; fetchedAt: number } | null = null;

// ── Saffir-Simpson from wind speed (kts) ──────────────────

function windToCategory(kts: number): { category: number; label: string } {
    if (kts >= 137) return { category: 5, label: '5' };
    if (kts >= 113) return { category: 4, label: '4' };
    if (kts >= 96) return { category: 3, label: '3' };
    if (kts >= 83) return { category: 2, label: '2' };
    if (kts >= 64) return { category: 1, label: '1' };
    if (kts >= 34) return { category: 0, label: 'TS' };
    return { category: -1, label: 'TD' };
}

// ── ATCF JSON Response Type ───────────────────────────────

interface ATCFStorm {
    atcf_id: string;
    long_atcf_id: string;
    storm_name: string;
    analysis_time: string;
    latitude: number;
    longitude: number;
    cyclone_nature: string;
    winds: number;
    pressure: number;
    last_updated: string;
    origin_basin: string;
}

// ── IBTrACS CSV Parser (for track history) ────────────────

function parseIBTrACStracks(csv: string): Map<string, CyclonePosition[]> {
    const lines = csv.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length < 3) return new Map();

    const headers = lines[0].split(',').map((h) => h.trim());
    const iNAME = headers.indexOf('NAME');
    const iTIME = headers.indexOf('ISO_TIME');
    const iLAT = headers.indexOf('LAT');
    const iLON = headers.indexOf('LON');
    const iWIND = headers.indexOf('USA_WIND');
    const iPRES = headers.indexOf('USA_PRES');
    const iBOM_WIND = headers.indexOf('BOM_WIND');
    const iBOM_PRES = headers.indexOf('BOM_PRES');

    if (iLAT < 0 || iLON < 0) return new Map();

    // Group track positions by storm NAME (uppercase)
    const tracks = new Map<string, CyclonePosition[]>();

    for (let i = 2; i < lines.length; i++) {
        const cols = lines[i].split(',').map((c) => c.trim());
        const lat = parseFloat(cols[iLAT]);
        const lon = parseFloat(cols[iLON]);
        if (isNaN(lat) || isNaN(lon)) continue;

        const name = (iNAME >= 0 ? cols[iNAME] : '').toUpperCase();
        if (!name || name === 'UNNAMED') continue;

        let windKts: number | null = iWIND >= 0 ? parseFloat(cols[iWIND]) : NaN;
        if (isNaN(windKts as number)) windKts = iBOM_WIND >= 0 ? parseFloat(cols[iBOM_WIND]) : null;
        if (isNaN(windKts as number)) windKts = null;

        let presMb: number | null = iPRES >= 0 ? parseFloat(cols[iPRES]) : NaN;
        if (isNaN(presMb as number)) presMb = iBOM_PRES >= 0 ? parseFloat(cols[iBOM_PRES]) : null;
        if (isNaN(presMb as number)) presMb = null;

        const time = iTIME >= 0 ? cols[iTIME] : '';

        if (!tracks.has(name)) tracks.set(name, []);
        tracks.get(name)!.push({ lat, lon, time, windKts, pressureMb: presMb });
    }

    return tracks;
}

// ── Primary Fetch: ATCF API (real-time) ──────────────────

async function fetchATCF(): Promise<ATCFStorm[]> {
    console.info('[CYCLONE] Fetching real-time ATCF data...');
    const response = await fetch(ATCF_URL);
    if (!response.ok) {
        console.error(`[CYCLONE] ATCF fetch failed: HTTP ${response.status}`);
        return [];
    }
    const data: ATCFStorm[] = await response.json();
    console.info(`[CYCLONE] ATCF: ${data.length} systems returned`);
    return data;
}

// ── Secondary Fetch: IBTrACS (for track history) ─────────

async function fetchIBTrACStracks(): Promise<Map<string, CyclonePosition[]>> {
    try {
        const response = await fetch(IBTRACS_URL);
        if (!response.ok) return new Map();
        const csv = await response.text();
        return parseIBTrACStracks(csv);
    } catch {
        console.warn('[CYCLONE] IBTrACS track fetch failed (non-critical)');
        return new Map();
    }
}

// ── Public API ─────────────────────────────────────────────

/**
 * Fetch active tropical cyclones worldwide.
 * Uses real-time ATCF API for current positions + IBTrACS for track history.
 */
export async function fetchActiveCyclones(): Promise<ActiveCyclone[]> {
    // Check cache
    if (cachedCyclones && Date.now() - cachedCyclones.fetchedAt < CACHE_TTL) {
        console.info('[CYCLONE] Using cached data');
        return cachedCyclones.data;
    }

    try {
        // Fetch real-time positions + historical tracks in parallel
        const [atcfStorms, trackHistory] = await Promise.all([fetchATCF(), fetchIBTrACStracks()]);

        const cyclones: ActiveCyclone[] = [];

        for (const s of atcfStorms) {
            // Skip invests and weak disturbances (< TS strength)
            if (s.winds < 34 || s.storm_name === 'INVEST') continue;

            const cat = windToCategory(s.winds);

            // Get historical track from IBTrACS if available
            const name = s.storm_name.toUpperCase();
            const histTrack = trackHistory.get(name) ?? [];

            // Add current position to track
            const currentPos: CyclonePosition = {
                lat: s.latitude,
                lon: s.longitude,
                time: s.analysis_time,
                windKts: s.winds,
                pressureMb: s.pressure,
            };

            // Combine historical track + current position
            const fullTrack = [...histTrack, currentPos].sort(
                (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime(),
            );

            cyclones.push({
                sid: s.long_atcf_id || s.atcf_id,
                name: s.storm_name,
                basin: s.origin_basin,
                category: cat.category,
                categoryLabel: cat.label,
                currentPosition: currentPos,
                track: fullTrack,
                maxWindKts: s.winds,
                minPressureMb: s.pressure,
                nature: s.cyclone_nature,
            });
        }

        console.info(
            `[CYCLONE] 🌀 ${cyclones.length} active cyclone(s):`,
            cyclones
                .map((c) => `${c.name} Cat ${c.categoryLabel} (${c.maxWindKts} kts, ${c.minPressureMb} hPa)`)
                .join(', ') || 'none',
        );

        cachedCyclones = { data: cyclones, fetchedAt: Date.now() };
        return cyclones;
    } catch (e) {
        console.error('[CYCLONE] ❌ Fetch error:', e);
        return cachedCyclones?.data ?? [];
    }
}

/**
 * Find the closest active cyclone to a given position.
 */
export function findClosestCyclone(cyclones: ActiveCyclone[], lat: number, lon: number): ActiveCyclone | null {
    if (cyclones.length === 0) return null;

    let closest: ActiveCyclone | null = null;
    let minDist = Infinity;

    for (const c of cyclones) {
        const dLat = c.currentPosition.lat - lat;
        const dLon = c.currentPosition.lon - lon;
        const dist = dLat * dLat + dLon * dLon;
        if (dist < minDist) {
            minDist = dist;
            closest = c;
        }
    }

    return closest;
}
