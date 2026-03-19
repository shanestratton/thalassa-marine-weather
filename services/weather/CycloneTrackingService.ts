/**
 * CycloneTrackingService — Global tropical cyclone tracking via NOAA IBTrACS.
 *
 * Data source: NOAA NCEI IBTrACS v04r01 "Active" CSV
 *   - Free, no API key, global coverage (all basins)
 *   - Contains storms active within the last 7 days
 *   - 3-hour interval positions with wind, pressure, category
 *
 * Saffir-Simpson category from max sustained wind (knots):
 *   TD: < 34 kts    TS: 34-63 kts    Cat 1: 64-82 kts
 *   Cat 2: 83-95    Cat 3: 96-113    Cat 4: 114-135    Cat 5: > 135
 */

import { createLogger } from '../../utils/createLogger';

const log = createLogger('CycloneTracking');

// ── Types ──────────────────────────────────────────────────

export interface CyclonePosition {
    lat: number;
    lon: number;
    time: string; // ISO
    windKts: number | null;
    pressureMb: number | null;
}

export interface ActiveCyclone {
    sid: string; // Storm ID (e.g. "2026076S12157")
    name: string; // Storm name (e.g. "NARELLE")
    basin: string; // Basin code (e.g. "SP", "WP", "NA")
    category: number; // Saffir-Simpson 0-5 (0 = TS/TD)
    categoryLabel: string; // "TD", "TS", "1", "2", "3", "4", "5"
    currentPosition: CyclonePosition;
    track: CyclonePosition[]; // All historical positions
    maxWindKts: number;
    minPressureMb: number | null;
}

// ── Constants ──────────────────────────────────────────────

const IBTRACS_URL =
    'https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.ACTIVE.list.v04r01.csv';

const CACHE_TTL = 30 * 60 * 1000; // 30 minutes

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

// ── CSV Parser ─────────────────────────────────────────────

function parseIBTrACScsv(csv: string): ActiveCyclone[] {
    const lines = csv.split('\n').filter((l) => l.trim().length > 0);
    if (lines.length < 3) return []; // Need header + units + data

    // First line is header, second is units — skip both
    const headers = lines[0].split(',').map((h) => h.trim());

    // Column indices
    const iSID = headers.indexOf('SID');
    const iNAME = headers.indexOf('NAME');
    const iBASIN = headers.indexOf('BASIN');
    const iTIME = headers.indexOf('ISO_TIME');
    const iLAT = headers.indexOf('LAT');
    const iLON = headers.indexOf('LON');
    const iWIND = headers.indexOf('USA_WIND');
    const iPRES = headers.indexOf('USA_PRES');
    // BOM fallbacks for southern hemisphere
    const iBOM_WIND = headers.indexOf('BOM_WIND');
    const iBOM_PRES = headers.indexOf('BOM_PRES');

    if (iSID < 0 || iLAT < 0 || iLON < 0) {
        log.error('IBTrACS CSV missing required columns');
        return [];
    }

    // Group rows by storm SID
    const stormMap = new Map<
        string,
        {
            name: string;
            basin: string;
            positions: CyclonePosition[];
            maxWind: number;
            minPres: number | null;
        }
    >();

    for (let i = 2; i < lines.length; i++) {
        const cols = lines[i].split(',').map((c) => c.trim());
        if (cols.length < Math.max(iSID, iLAT, iLON) + 1) continue;

        const sid = cols[iSID];
        const lat = parseFloat(cols[iLAT]);
        const lon = parseFloat(cols[iLON]);
        if (!sid || isNaN(lat) || isNaN(lon)) continue;

        // Try USA wind/pres first, fallback to BOM
        let windKts: number | null = iWIND >= 0 ? parseFloat(cols[iWIND]) : NaN;
        if (isNaN(windKts as number)) windKts = iBOM_WIND >= 0 ? parseFloat(cols[iBOM_WIND]) : null;
        if (isNaN(windKts as number)) windKts = null;

        let presMb: number | null = iPRES >= 0 ? parseFloat(cols[iPRES]) : NaN;
        if (isNaN(presMb as number)) presMb = iBOM_PRES >= 0 ? parseFloat(cols[iBOM_PRES]) : null;
        if (isNaN(presMb as number)) presMb = null;

        const name = iNAME >= 0 ? cols[iNAME] : 'UNNAMED';
        const basin = iBASIN >= 0 ? cols[iBASIN] : '??';
        const time = iTIME >= 0 ? cols[iTIME] : '';

        const pos: CyclonePosition = { lat, lon, time, windKts, pressureMb: presMb };

        if (!stormMap.has(sid)) {
            stormMap.set(sid, { name, basin, positions: [], maxWind: 0, minPres: null });
        }

        const storm = stormMap.get(sid)!;
        storm.positions.push(pos);
        if (windKts !== null && windKts > storm.maxWind) storm.maxWind = windKts;
        if (presMb !== null && (storm.minPres === null || presMb < storm.minPres)) storm.minPres = presMb;
    }

    // Build ActiveCyclone objects
    const result: ActiveCyclone[] = [];
    for (const [sid, storm] of stormMap) {
        if (storm.positions.length === 0) continue;

        // Skip tropical depressions (winds < 34 kts throughout)
        if (storm.maxWind < 34) continue;

        // Latest position = last row for this SID
        const sorted = storm.positions.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
        const latest = sorted[sorted.length - 1];

        // Category from the LATEST wind reading (current intensity)
        const latestWind = latest.windKts ?? storm.maxWind;
        const cat = windToCategory(latestWind);

        result.push({
            sid,
            name: storm.name === 'UNNAMED' ? `Storm ${sid.slice(-4)}` : storm.name,
            basin: storm.basin,
            category: cat.category,
            categoryLabel: cat.label,
            currentPosition: latest,
            track: sorted,
            maxWindKts: storm.maxWind,
            minPressureMb: storm.minPres,
        });
    }

    return result;
}

// ── Public API ─────────────────────────────────────────────

/**
 * Fetch active tropical cyclones worldwide from NOAA IBTrACS.
 * Results are cached for 30 minutes.
 */
export async function fetchActiveCyclones(): Promise<ActiveCyclone[]> {
    // Check cache
    if (cachedCyclones && Date.now() - cachedCyclones.fetchedAt < CACHE_TTL) {
        return cachedCyclones.data;
    }

    try {
        const response = await fetch(IBTRACS_URL);
        if (!response.ok) {
            log.error(`IBTrACS fetch failed: HTTP ${response.status}`);
            return cachedCyclones?.data ?? [];
        }

        const csv = await response.text();
        const cyclones = parseIBTrACScsv(csv);

        log.info(
            `🌀 ${cyclones.length} active cyclone(s):`,
            cyclones.map((c) => `${c.name} Cat ${c.categoryLabel} (${c.maxWindKts} kts)`).join(', '),
        );

        cachedCyclones = { data: cyclones, fetchedAt: Date.now() };
        return cyclones;
    } catch (e) {
        log.error('IBTrACS fetch error:', e);
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
