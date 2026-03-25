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

import { createLogger } from '../../utils/createLogger';
import type { WindGrid } from './windField';

const log = createLogger('CycloneTrackingService');
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
    forecastTrack: CyclonePosition[]; // NOAA NHC forecast positions (future)
    maxWindKts: number;
    minPressureMb: number | null;
    nature: string; // TY, TS, TD, DB, etc.
}

// ── Constants ──────────────────────────────────────────────

const ATCF_URL = 'https://api.knackwx.com/atcf/v2';
const IBTRACS_URL =
    'https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.ACTIVE.list.v04r01.csv';
const NOAA_FORECAST_URL =
    'https://services9.arcgis.com/RHVPKKiFTONKtxq3/ArcGIS/rest/services/Active_Hurricanes_v1/FeatureServer/0/query?where=1%3D1&outFields=*&f=geojson&resultRecordCount=500';
const NOAA_OBSERVED_URL =
    'https://services9.arcgis.com/RHVPKKiFTONKtxq3/ArcGIS/rest/services/Active_Hurricanes_v1/FeatureServer/1/query?where=1%3D1&outFields=*&f=geojson&resultRecordCount=500';

const CACHE_TTL = 10 * 60 * 1000; // 10 minutes
const CACHE_VERSION = 8; // v8: synthetic forecast for non-NHC basins

// ── Cache ──────────────────────────────────────────────────

let cachedCyclones: { data: ActiveCyclone[]; fetchedAt: number; version: number } | null = null;
let inflightFetch: Promise<ActiveCyclone[]> | null = null;

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

/**
 * Fuzzy lookup: ATCF truncates names (e.g. TWENTYEIGH vs TWENTYEIGHT).
 * Try exact match first, then startsWith in both directions.
 */
function fuzzyGet<T>(map: Map<string, T>, name: string): T | undefined {
    // Exact match
    if (map.has(name)) return map.get(name);
    // ATCF name is prefix of NOAA name, or vice versa
    for (const [key, val] of map) {
        if (key.startsWith(name) || name.startsWith(key)) return val;
    }
    return undefined;
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
    log.info('[CYCLONE] Fetching real-time ATCF data...');
    const response = await fetch(ATCF_URL);
    if (!response.ok) {
        log.error(`[CYCLONE] ATCF fetch failed: HTTP ${response.status}`);
        return [];
    }
    const data: ATCFStorm[] = await response.json();
    log.info(`[CYCLONE] ATCF: ${data.length} systems returned`);
    return data;
}

// ── Tertiary Fetch: NOAA ArcGIS Forecast Points ─────────

interface NOAAForecastFeature {
    geometry: { type: string; coordinates: [number, number] };
    properties: {
        STORMNAME: string;
        MAXWIND: number;
        MSLP: number;
        SSNUM: number;
        FLDATELBL: string;
        DATELBL: string;
        VALIDTIME: string;
        TCDVLP: string;
    };
}

async function fetchNOAAForecast(): Promise<Map<string, CyclonePosition[]>> {
    try {
        log.info('[CYCLONE] Fetching NOAA NHC forecast positions...');
        const response = await fetch(NOAA_FORECAST_URL);
        if (!response.ok) {
            log.warn(`[CYCLONE] NOAA forecast fetch HTTP ${response.status}`);
            return new Map();
        }
        const geojson: { features: NOAAForecastFeature[] } = await response.json();

        const forecasts = new Map<string, CyclonePosition[]>();

        for (const f of geojson.features) {
            const name = f.properties.STORMNAME?.toUpperCase();
            if (!name || !f.geometry?.coordinates) continue;

            const [lon, lat] = f.geometry.coordinates;

            // Parse time — try FLDATELBL first, manually convert AM/PM to 24h
            let time = '';
            if (f.properties.FLDATELBL) {
                const match = f.properties.FLDATELBL.match(/(\d{4})-(\d{2})-(\d{2})\s+(\d{1,2}):(\d{2})\s+(AM|PM)/i);
                if (match) {
                    let h = parseInt(match[4]);
                    const ampm = match[6].toUpperCase();
                    if (ampm === 'PM' && h !== 12) h += 12;
                    if (ampm === 'AM' && h === 12) h = 0;
                    const iso = `${match[1]}-${match[2]}-${match[3]}T${String(h).padStart(2, '0')}:${match[5]}:00Z`;
                    const d = new Date(iso);
                    if (!isNaN(d.getTime())) time = d.toISOString();
                }
            }
            // Fallback: use VALIDTIME if available (format: "DD/HHMM")
            if (!time && f.properties.VALIDTIME) {
                time = f.properties.VALIDTIME; // Store raw for label use
            }

            const windKts = f.properties.MAXWIND > 0 ? f.properties.MAXWIND : null;
            const pressureMb = f.properties.MSLP > 0 && f.properties.MSLP < 9999 ? f.properties.MSLP : null;

            if (!forecasts.has(name)) forecasts.set(name, []);
            forecasts.get(name)!.push({ lat, lon, time, windKts, pressureMb });
        }

        // Sort each storm's forecast by time
        for (const [, positions] of forecasts) {
            positions.sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
        }

        return forecasts;
    } catch (err) {
        log.warn('[CYCLONE] NOAA forecast fetch failed:', err);
        return new Map();
    }
}

// ── NOAA Observed Position (NHC satellite-derived) ──────

/**
 * Fetch NOAA NHC observed (advisory) positions.
 * These are satellite-verified and much more accurate than ATCF automated analyses.
 * Layer 1 of the Active Hurricanes service.
 */
async function fetchNOAAObserved(): Promise<Map<string, CyclonePosition[]>> {
    try {
        log.info('[CYCLONE] Fetching NOAA NHC observed positions...');
        const response = await fetch(NOAA_OBSERVED_URL);
        if (!response.ok) {
            log.warn(`[CYCLONE] NOAA observed fetch HTTP ${response.status}`);
            return new Map();
        }
        const geojson: { features: NOAAForecastFeature[] } = await response.json();

        const observed = new Map<string, CyclonePosition[]>();

        for (const f of geojson.features) {
            const name = f.properties.STORMNAME?.toUpperCase();
            if (!name || !f.geometry?.coordinates) continue;

            const [lon, lat] = f.geometry.coordinates;
            const windKts = f.properties.MAXWIND > 0 ? f.properties.MAXWIND : null;
            const pressureMb = f.properties.MSLP > 0 && f.properties.MSLP < 9999 ? f.properties.MSLP : null;

            // Parse time if available
            let time = '';
            if (f.properties.DATELBL) {
                time = f.properties.DATELBL;
            }

            if (!observed.has(name)) observed.set(name, []);
            observed.get(name)!.push({ lat, lon, time, windKts, pressureMb });
        }

        log.info(`[CYCLONE] NOAA observed: ${observed.size} storm(s) with track history`);
        return observed;
    } catch (err) {
        log.warn('[CYCLONE] NOAA observed fetch failed:', err);
        return new Map();
    }
}

async function fetchIBTrACStracks(): Promise<Map<string, CyclonePosition[]>> {
    try {
        const response = await fetch(IBTRACS_URL);
        if (!response.ok) return new Map();
        const csv = await response.text();
        return parseIBTrACStracks(csv);
    } catch {
        log.warn('[CYCLONE] IBTrACS track fetch failed (non-critical)');
        return new Map();
    }
}

// ── GRIB Feature Snapper ──────────────────────────────────
// Reads the SAME wind field the sailor sees on screen to find
// the actual eye (minimum wind vector). GRIB is the single source of truth.

export interface GribSyncResult {
    lat: number;
    lon: number;
    eyeSpeedMs: number;
    eyewallMaxKts: number;
}

/**
 * Sync a storm icon to the GRIB wind field.
 *
 * Two-pass approach matching the wind particle renderer:
 * 1. Coarse scan: find grid-point minimum in 2° box (establishes the eye region)
 * 2. Fine scan: bilinear interpolation at 0.1° steps in the same box
 *    (matches the sub-grid accuracy of the particle renderer)
 *
 * Returns null if no clear eye structure (gradient < 15 kts).
 */
export function syncStormToGrib(
    approxLat: number,
    approxLon: number,
    grid: WindGrid,
    hour: number,
): GribSyncResult | null {
    if (!grid || !grid.speed.length || !grid.lats?.length || !grid.lons?.length) return null;
    if (!grid.u?.length || !grid.v?.length) return null;

    const h = Math.min(Math.max(0, Math.floor(hour)), grid.totalHours - 1);
    const uData = grid.u[h];
    const vData = grid.v[h];
    const speedData = grid.speed[h];
    if (!uData || !vData || !speedData) return null;

    const { width, height, north, south, east, west } = grid;

    // ── Bilinear interpolation helpers ──
    function getRowCol(
        lat: number,
        lon: number,
    ): { r0: number; c0: number; r1: number; c1: number; dr: number; dc: number } {
        const rowF = ((lat - south) / (north - south)) * (height - 1);
        const colF = ((lon - west) / (east - west)) * (width - 1);
        const r0 = Math.max(0, Math.min(height - 2, Math.floor(rowF)));
        const c0 = Math.max(0, Math.min(width - 2, Math.floor(colF)));
        return { r0, c0, r1: r0 + 1, c1: c0 + 1, dr: rowF - r0, dc: colF - c0 };
    }

    function sampleSpeed(lat: number, lon: number): number {
        const { r0, c0, r1, c1, dr, dc } = getRowCol(lat, lon);
        return (
            speedData[r0 * width + c0] * (1 - dr) * (1 - dc) +
            speedData[r0 * width + c1] * (1 - dr) * dc +
            speedData[r1 * width + c0] * dr * (1 - dc) +
            speedData[r1 * width + c1] * dr * dc
        );
    }

    // ── HEATMAP PEAK EYE DETECTION ──
    // Instead of centroid (averages ALL calm pixels → drifts to random calm patches),
    // build a "heatmap" of calm density and find the PEAK.
    // For each grid point, score = sum of 1/(speed² + 0.1) within 1.0° neighborhood.
    // The point with the highest score = most concentrated cluster of calm pixels = the eye.
    const COARSE = 0.2; // Coarse grid for heatmap candidates
    const FINE = 0.1; // Fine grid for final refinement
    const KERNEL_R = 1.0; // Neighborhood radius for density scoring (wider = more smoothing)
    const BOX_RADIUS = 2.0;

    const latMin = Math.max(approxLat - BOX_RADIUS, south);
    const latMax = Math.min(approxLat + BOX_RADIUS, north);
    const lonMin = Math.max(approxLon - BOX_RADIUS, west);
    const lonMax = Math.min(approxLon + BOX_RADIUS, east);

    // Step 1: Build coarse heatmap — score each point by local calm density
    let bestScore = -1;
    let bestLat = approxLat;
    let bestLon = approxLon;
    let maxSpd = 0;

    for (let lat = latMin; lat <= latMax + 0.01; lat += COARSE) {
        for (let lon = lonMin; lon <= lonMax + 0.01; lon += COARSE) {
            // Compute local calm density within KERNEL_R
            let score = 0;
            for (let kLat = lat - KERNEL_R; kLat <= lat + KERNEL_R + 0.01; kLat += FINE) {
                for (let kLon = lon - KERNEL_R; kLon <= lon + KERNEL_R + 0.01; kLon += FINE) {
                    if (kLat < south || kLat > north || kLon < west || kLon > east) continue;
                    const dist = Math.sqrt((kLat - lat) ** 2 + (kLon - lon) ** 2);
                    if (dist > KERNEL_R) continue;
                    const speed = sampleSpeed(kLat, kLon);
                    score += 1.0 / (speed * speed + 0.1);
                    if (speed > maxSpd) maxSpd = speed;
                }
            }
            if (score > bestScore) {
                bestScore = score;
                bestLat = lat;
                bestLon = lon;
            }
        }
    }

    // Step 2: Fine-tune — refine around the best coarse point
    let fineScore = -1;
    let eyeLat = bestLat;
    let eyeLon = bestLon;

    for (let lat = bestLat - 0.5; lat <= bestLat + 0.5 + 0.01; lat += FINE) {
        for (let lon = bestLon - 0.5; lon <= bestLon + 0.5 + 0.01; lon += FINE) {
            if (lat < south || lat > north || lon < west || lon > east) continue;
            let score = 0;
            for (let kLat = lat - KERNEL_R; kLat <= lat + KERNEL_R + 0.01; kLat += FINE) {
                for (let kLon = lon - KERNEL_R; kLon <= lon + KERNEL_R + 0.01; kLon += FINE) {
                    if (kLat < south || kLat > north || kLon < west || kLon > east) continue;
                    const dist = Math.sqrt((kLat - lat) ** 2 + (kLon - lon) ** 2);
                    if (dist > KERNEL_R) continue;
                    const speed = sampleSpeed(kLat, kLon);
                    score += 1.0 / (speed * speed + 0.1);
                }
            }
            if (score > fineScore) {
                fineScore = score;
                eyeLat = lat;
                eyeLon = lon;
            }
        }
    }

    const eyeSpeed = sampleSpeed(eyeLat, eyeLon);
    const eyewallMaxKts = Math.round(maxSpd * 1.94384);

    log.info(
        `[CYCLONE] 👁️ Heatmap peak at (${eyeLat.toFixed(2)}, ${eyeLon.toFixed(2)}) ` +
            `eyeSpeed=${eyeSpeed.toFixed(1)} m/s, eyewall=${eyewallMaxKts} kts, ` +
            `confidence=${fineScore.toFixed(1)} ` +
            `[seed was (${approxLat.toFixed(2)}, ${approxLon.toFixed(2)}), ` +
            `Δ=${Math.sqrt((eyeLat - approxLat) ** 2 + (eyeLon - approxLon) ** 2).toFixed(2)}°]`,
    );

    return {
        lat: eyeLat,
        lon: eyeLon,
        eyeSpeedMs: eyeSpeed,
        eyewallMaxKts,
    };
}

// ── PRESSURE MINIMUM EYE DETECTION ──
// The gold standard: the cyclone eye IS the lowest pressure point.
// Uses the same GRIB2 source as wind, so it matches the spiral perfectly.

interface PressureEyeResult {
    lat: number;
    lon: number;
    pressureHpa: number;
}

/**
 * Fetch MSLP from the 0.25° GFS GRIB and find the absolute minimum
 * within ±2° of the approximate storm center.
 * At 0.25° resolution (~28km), this can resolve the eye structure.
 */
export async function fetchPressureEye(approxLat: number, approxLon: number): Promise<PressureEyeResult | null> {
    try {
        const BOX = 2.0;
        const north = approxLat + BOX;
        const south = approxLat - BOX;
        const east = approxLon + BOX;
        const west = approxLon - BOX;

        const supabaseUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';
        const supabaseKey = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) || '';
        if (!supabaseUrl) return null;

        const url = `${supabaseUrl}/functions/v1/fetch-pressure-grid`;
        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(supabaseKey ? { Authorization: `Bearer ${supabaseKey}` } : {}),
            },
            // Request 0.25° for cyclone eye precision
            body: JSON.stringify({ north, south, east, west, hours: [0], resolution: '0p25' }),
        });

        if (!resp.ok) {
            log.info(`[CYCLONE] 👁️ Pressure fetch failed: ${resp.status}`);
            return null;
        }

        const data = await resp.json();
        const frame = data.frames?.[0]; // First (and only) forecast hour
        const lats: number[] = data.lats;
        const lons: number[] = data.lons;

        if (!frame || !lats?.length || !lons?.length) return null;

        // frame is [row_S_to_N][col_W_to_E] in hPa
        let minP = Infinity;
        let eyeLat = approxLat;
        let eyeLon = approxLon;

        for (let r = 0; r < frame.length; r++) {
            for (let c = 0; c < frame[r].length; c++) {
                const p = frame[r][c];
                if (p > 0 && p < minP) {
                    minP = p;
                    eyeLat = lats[r];
                    eyeLon = lons[c];
                }
            }
        }

        if (minP > 1050) return null; // Sanity: no real low pressure found

        log.info(
            `[CYCLONE] 👁️ PRESSURE EYE at (${eyeLat.toFixed(2)}, ${eyeLon.toFixed(2)}) ` +
                `pressure=${minP.toFixed(1)} hPa ` +
                `[seed was (${approxLat.toFixed(2)}, ${approxLon.toFixed(2)}), ` +
                `Δ=${Math.sqrt((eyeLat - approxLat) ** 2 + (eyeLon - approxLon) ** 2).toFixed(2)}°]`,
        );

        return { lat: eyeLat, lon: eyeLon, pressureHpa: minP };
    } catch (err) {
        log.info(`[CYCLONE] 👁️ Pressure eye error: ${err}`);
        return null;
    }
}

/**
 * Fetch active tropical cyclones worldwide.
 * Uses real-time ATCF API for current positions + IBTrACS for track history.
 */
export async function fetchActiveCyclones(): Promise<ActiveCyclone[]> {
    // Check cache
    if (
        cachedCyclones &&
        cachedCyclones.version === CACHE_VERSION &&
        Date.now() - cachedCyclones.fetchedAt < CACHE_TTL
    ) {
        log.info('[CYCLONE] Using cached data');
        return cachedCyclones.data;
    }

    // Deduplicate: if a fetch is already in progress, reuse it
    if (inflightFetch) {
        log.info('[CYCLONE] Reusing inflight fetch');
        return inflightFetch;
    }

    inflightFetch = _fetchActiveCyclonesImpl();
    try {
        return await inflightFetch;
    } finally {
        inflightFetch = null;
    }
}

async function _fetchActiveCyclonesImpl(): Promise<ActiveCyclone[]> {
    try {
        // Fetch real-time positions + historical tracks + NOAA forecast + NOAA observed in parallel
        const [atcfStorms, trackHistory, forecastTracks, observedTracks] = await Promise.all([
            fetchATCF(),
            fetchIBTrACStracks(),
            fetchNOAAForecast(),
            fetchNOAAObserved(),
        ]);

        const cyclones: ActiveCyclone[] = [];

        for (const s of atcfStorms) {
            // Skip invests and weak disturbances (< TS strength)
            if (s.winds < 34 || s.storm_name === 'INVEST') continue;

            const cat = windToCategory(s.winds);

            // Get historical track from IBTrACS if available
            const name = s.storm_name.toUpperCase();
            const histTrack = fuzzyGet(trackHistory, name) ?? [];

            // Get NOAA forecast positions if available
            const forecast = fuzzyGet(forecastTracks, name) ?? [];

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
                forecastTrack: forecast,
                maxWindKts: s.winds,
                minPressureMb: s.pressure,
                nature: s.cyclone_nature,
            });
        }

        // ── Merge NOAA observed track history ──
        // NOAA Layer 1 has satellite-verified track points from NHC advisories.
        // Merge these into the storm's track for a richer history,
        // but ONLY override position if NOAA data is more recent than ATCF.
        for (const c of cyclones) {
            const observedPositions = fuzzyGet(observedTracks, c.name.toUpperCase());
            if (!observedPositions || observedPositions.length === 0) continue;

            // Merge observed track into existing track (adds density)
            if (observedPositions.length > c.track.length) {
                c.track = observedPositions;
            }

            // Only override current position if NOAA observation is newer
            const latestObserved = observedPositions[observedPositions.length - 1];
            const atcfTime = new Date(c.currentPosition.time).getTime();
            const noaaTime = latestObserved.time ? new Date(latestObserved.time).getTime() : 0;

            if (noaaTime > atcfTime && !isNaN(noaaTime)) {
                log.info(
                    `[CYCLONE] 📍 ${c.name}: NOAA observed is newer — using (${latestObserved.lat.toFixed(1)}, ${latestObserved.lon.toFixed(1)}) instead of ATCF (${c.currentPosition.lat.toFixed(1)}, ${c.currentPosition.lon.toFixed(1)})`,
                );
                c.currentPosition = {
                    lat: latestObserved.lat,
                    lon: latestObserved.lon,
                    time: latestObserved.time || c.currentPosition.time,
                    windKts: latestObserved.windKts ?? c.currentPosition.windKts,
                    pressureMb: latestObserved.pressureMb ?? c.currentPosition.pressureMb,
                };
            } else {
                log.info(
                    `[CYCLONE] 📍 ${c.name}: ATCF position is more recent — keeping (${c.currentPosition.lat.toFixed(1)}, ${c.currentPosition.lon.toFixed(1)})`,
                );
            }
        }

        // ── Interpolate current position along forecast track ──
        // The forecast has timestamped points (T+0, T+12, T+24 etc).
        // We interpolate to "now" for the best real-time position estimate.
        const now = Date.now();
        for (const c of cyclones) {
            const fcast = c.forecastTrack;
            if (!fcast || fcast.length < 2) continue;

            // Parse forecast times
            const timedPoints = fcast
                .map((p) => ({ ...p, ms: new Date(p.time).getTime() }))
                .filter((p) => !isNaN(p.ms))
                .sort((a, b) => a.ms - b.ms);

            if (timedPoints.length < 2) continue;

            // Find the two forecast points that bracket "now"
            let before = timedPoints[0];
            let after = timedPoints[1];

            for (let i = 0; i < timedPoints.length - 1; i++) {
                if (timedPoints[i].ms <= now && timedPoints[i + 1].ms >= now) {
                    before = timedPoints[i];
                    after = timedPoints[i + 1];
                    break;
                }
            }

            // If "now" is within the forecast window, interpolate
            const span = after.ms - before.ms;
            if (span > 0 && now >= before.ms && now <= after.ms) {
                const t = (now - before.ms) / span; // 0..1
                const interpLat = before.lat + (after.lat - before.lat) * t;
                const interpLon = before.lon + (after.lon - before.lon) * t;
                const interpWind =
                    before.windKts && after.windKts
                        ? Math.round(before.windKts + (after.windKts - before.windKts) * t)
                        : c.currentPosition.windKts;

                log.info(
                    `[CYCLONE] 📍 ${c.name}: Interpolated to NOW (t=${t.toFixed(2)}) → (${interpLat.toFixed(1)}, ${interpLon.toFixed(1)}) [between ${before.lat.toFixed(1)},${before.lon.toFixed(1)} and ${after.lat.toFixed(1)},${after.lon.toFixed(1)}]`,
                );

                c.currentPosition = {
                    lat: interpLat,
                    lon: interpLon,
                    time: new Date(now).toISOString(),
                    windKts: interpWind,
                    pressureMb: c.currentPosition.pressureMb,
                };
            } else if (now > timedPoints[timedPoints.length - 1].ms) {
                // Past all forecast points — use the last forecast position
                const last = timedPoints[timedPoints.length - 1];
                log.info(
                    `[CYCLONE] 📍 ${c.name}: Past forecast window — using last forecast (${last.lat.toFixed(1)}, ${last.lon.toFixed(1)})`,
                );
            }
        }

        // ── Local Track Accumulator ──
        // Stores each ATCF position to localStorage on every refresh (~10 min).
        // For storms without IBTrACS/NOAA history, this builds up a track over time.
        // Generic: works for ANY storm regardless of basin or data source availability.
        const TRACK_STORE_KEY = 'thalassa-cyclone-tracks';
        const TRACK_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days
        const MIN_GAP_MS = 10 * 60 * 1000; // 10 min — matches ATCF refresh cycle

        try {
            const raw = localStorage.getItem(TRACK_STORE_KEY);
            const store: Record<string, { positions: CyclonePosition[]; updatedAt: number }> = raw
                ? JSON.parse(raw)
                : {};

            const now = Date.now();

            // Clean up stale storms (older than 14 days)
            for (const sid of Object.keys(store)) {
                if (now - store[sid].updatedAt > TRACK_TTL_MS) {
                    delete store[sid];
                }
            }

            for (const c of cyclones) {
                const sid = c.sid;
                if (!store[sid]) {
                    store[sid] = { positions: [], updatedAt: now };
                }

                const accumulated = store[sid].positions;
                const lastTime =
                    accumulated.length > 0 ? new Date(accumulated[accumulated.length - 1].time).getTime() : 0;
                const currentTime = new Date(c.currentPosition.time).getTime();

                // Only add if enough time has passed since last stored position
                if (currentTime - lastTime >= MIN_GAP_MS && !isNaN(currentTime)) {
                    accumulated.push({
                        lat: c.currentPosition.lat,
                        lon: c.currentPosition.lon,
                        time: c.currentPosition.time,
                        windKts: c.currentPosition.windKts,
                        pressureMb: c.currentPosition.pressureMb,
                    });
                    store[sid].updatedAt = now;
                }

                // If the storm's track from IBTrACS/NOAA has fewer points than our
                // local accumulation, merge our local data into the track
                if (c.track.length < accumulated.length) {
                    // Merge: use accumulated as base, add any IBTrACS points not already covered
                    const mergedMap = new Map<string, CyclonePosition>();
                    for (const p of accumulated) {
                        const key = `${Math.round(new Date(p.time).getTime() / MIN_GAP_MS)}`;
                        mergedMap.set(key, p);
                    }
                    for (const p of c.track) {
                        const key = `${Math.round(new Date(p.time).getTime() / MIN_GAP_MS)}`;
                        mergedMap.set(key, p); // IBTrACS takes precedence
                    }
                    c.track = Array.from(mergedMap.values()).sort(
                        (a, b) => new Date(a.time).getTime() - new Date(b.time).getTime(),
                    );
                    log.info(
                        `[CYCLONE] 📦 ${c.name}: Local accumulator provided ${accumulated.length} points → merged track: ${c.track.length} points`,
                    );
                }
            }

            localStorage.setItem(TRACK_STORE_KEY, JSON.stringify(store));
        } catch (err) {
            log.warn('[CYCLONE] Track accumulator error:', err);
        }

        // ── Synthetic Forecast: extrapolate for storms without NHC forecast ──
        // NOAA NHC only covers Atlantic/Eastern Pacific. For South Pacific,
        // Indian Ocean, and Western Pacific storms, generate a synthetic
        // forecast by extrapolating from the last 2 track positions.
        // NOTE: Must run AFTER observed track merge so c.track has full history.
        for (const c of cyclones) {
            if (c.forecastTrack.length >= 2) continue; // Already has forecast
            if (c.track.length < 2) continue; // Need at least 2 points to extrapolate

            const t1 = c.track[c.track.length - 2];
            const t2 = c.track[c.track.length - 1];
            const dt = new Date(t2.time).getTime() - new Date(t1.time).getTime();
            if (dt <= 0 || isNaN(dt)) continue;

            // Calculate heading vector (degrees per hour)
            const dtHours = dt / 3600000;
            const dLatPerHour = (t2.lat - t1.lat) / dtHours;
            const dLonPerHour = (t2.lon - t1.lon) / dtHours;

            // Generate forecast points at 12h, 24h, 36h, 48h, 72h
            const forecastHours = [12, 24, 36, 48, 72];
            const baseTime = new Date(t2.time).getTime();
            const syntheticForecast: CyclonePosition[] = [];

            for (const h of forecastHours) {
                syntheticForecast.push({
                    lat: t2.lat + dLatPerHour * h,
                    lon: t2.lon + dLonPerHour * h,
                    time: new Date(baseTime + h * 3600000).toISOString(),
                    windKts: c.currentPosition.windKts,
                    pressureMb: c.currentPosition.pressureMb,
                });
            }

            c.forecastTrack = syntheticForecast;
            log.info(
                `[CYCLONE] 🔮 Synthesized ${syntheticForecast.length}-pt forecast for ${c.name} (extrapolated from track heading)`,
            );
        }

        log.info(
            `[CYCLONE] 🌀 ${cyclones.length} active cyclone(s):`,
            cyclones
                .map((c) => `${c.name} Cat ${c.categoryLabel} (${c.maxWindKts} kts, ${c.minPressureMb} hPa)`)
                .join(', ') || 'none',
        );

        cachedCyclones = { data: cyclones, fetchedAt: Date.now(), version: CACHE_VERSION };
        return cyclones;
    } catch (e) {
        log.error('[CYCLONE] ❌ Fetch error:', e);
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

// ── GFS Tracker (Dual-Truth) ──────────────────────────────

export interface GfsTrackerPosition {
    fhr: number;
    lat: number;
    lon: number;
    vmax: number;
    mslp: number;
}

interface GfsTrackerResponse {
    storms: Record<string, { name: string; positions: GfsTrackerPosition[] }>;
    gfsCycle: string;
    source: 'tcvitals' | 'adeck' | 'none';
}

let cachedGfsTracker: { data: Map<string, GfsTrackerPosition[]>; fetchedAt: number } | null = null;
let inflightGfsTracker: Promise<Map<string, GfsTrackerPosition[]>> | null = null;

/**
 * Fetch GFS vortex tracker positions for all active cyclones.
 * Returns a Map keyed by storm SID → per-forecast-hour positions.
 * Cached for 10 minutes. Deduplicates concurrent calls.
 */
export async function fetchGfsTrackerPositions(): Promise<Map<string, GfsTrackerPosition[]>> {
    // Return cache if fresh
    if (cachedGfsTracker && Date.now() - cachedGfsTracker.fetchedAt < CACHE_TTL) {
        return cachedGfsTracker.data;
    }

    // Deduplicate concurrent fetches
    if (inflightGfsTracker) return inflightGfsTracker;

    inflightGfsTracker = (async () => {
        try {
            const supabaseUrl = (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';
            if (!supabaseUrl) {
                log.warn('[CYCLONE] No SUPABASE_URL — cannot fetch GFS tracker');
                return new Map<string, GfsTrackerPosition[]>();
            }

            const url = `${supabaseUrl}/functions/v1/fetch-gfs-tracker`;
            log.info('[CYCLONE] 🎯 Fetching GFS tracker positions...');

            const resp = await fetch(url, { signal: AbortSignal.timeout(15_000) });
            if (!resp.ok) {
                log.warn(`[CYCLONE] GFS tracker: ${resp.status} ${resp.statusText}`);
                return cachedGfsTracker?.data ?? new Map<string, GfsTrackerPosition[]>();
            }

            const json: GfsTrackerResponse = await resp.json();
            const result = new Map<string, GfsTrackerPosition[]>();

            for (const [sid, storm] of Object.entries(json.storms)) {
                if (storm.positions.length > 0) {
                    result.set(sid, storm.positions);
                    log.info(
                        `[CYCLONE] 🎯 GFS tracker: ${storm.name} (${sid}) — ` +
                            `${storm.positions.length} positions, source=${json.source}`,
                    );
                }
            }

            cachedGfsTracker = { data: result, fetchedAt: Date.now() };
            return result;
        } catch (e) {
            log.error('[CYCLONE] GFS tracker fetch failed:', e);
            return cachedGfsTracker?.data ?? new Map<string, GfsTrackerPosition[]>();
        } finally {
            inflightGfsTracker = null;
        }
    })();

    return inflightGfsTracker;
}

/**
 * Interpolate a GFS tracker position for a given forecast hour.
 * Linearly interpolates lat/lon between the two bracketing forecast-hour entries.
 *
 * Matching strategy (waterfall):
 *   1. Exact SID match
 *   2. Storm name match (case-insensitive)
 *   3. Geographic proximity — closest tcvitals storm within 10°
 *
 * @param trackerMap  Map from fetchGfsTrackerPositions()
 * @param stormSid   Storm ID from ATCF API (e.g. "SP282026")
 * @param hour       Current forecast hour (float, from WindStore)
 * @param stormName  Storm name from API (e.g. "TWENTY-EIGHT")
 * @param stormLat   API-reported storm latitude (for proximity matching)
 * @param stormLon   API-reported storm longitude (for proximity matching)
 * @returns          Interpolated { lat, lon } or null if no data
 */
export function interpolateGfsTracker(
    trackerMap: Map<string, GfsTrackerPosition[]>,
    stormSid: string,
    hour: number,
    stormName?: string,
    stormLat?: number,
    stormLon?: number,
): { lat: number; lon: number } | null {
    // Strategy 1: Exact SID match
    let positions = trackerMap.get(stormSid);

    // Strategy 2: Name match (tcvitals stores names like "NARELLE", "TWENTY-EI")
    if (!positions && stormName) {
        const nameUpper = stormName.toUpperCase();
        for (const [_sid, pos] of trackerMap) {
            // fetchGfsTrackerPositions stores name in the response but we only have positions here
            // Fall through to geographic matching
            break;
        }
    }

    // Strategy 3: Geographic proximity — find closest within 10°
    if (!positions && stormLat !== undefined && stormLon !== undefined) {
        let bestDist = Infinity;
        for (const [_sid, pos] of trackerMap) {
            if (pos.length === 0) continue;
            const p0 = pos[0]; // T+0 position
            const dLat = p0.lat - stormLat;
            const dLon = p0.lon - stormLon;
            const dist = Math.sqrt(dLat * dLat + dLon * dLon);
            if (dist < 10.0 && dist < bestDist) {
                bestDist = dist;
                positions = pos;
            }
        }
        if (positions) {
            log.info(`[CYCLONE] 🎯 Matched tcvitals storm by proximity (${bestDist.toFixed(1)}° from API pos)`);
        }
    }

    if (!positions || positions.length === 0) return null;

    // If only one position (tcvitals T+0 only):
    // - For live mode (hour < 1): return the T+0 position
    // - For forecast (hour >= 1): return null → let GRIB scanner find the eye
    if (positions.length === 1) {
        if (hour < 1.0) {
            return { lat: positions[0].lat, lon: positions[0].lon };
        }
        return null; // Fall through to GRIB scanner for forecast hours
    }

    // Clamp hour to the available range
    const firstFhr = positions[0].fhr;
    const lastFhr = positions[positions.length - 1].fhr;
    const clampedHour = Math.max(firstFhr, Math.min(lastFhr, hour));

    // Find the bracketing entries
    let lo = 0;
    let hi = positions.length - 1;
    for (let i = 0; i < positions.length - 1; i++) {
        if (positions[i].fhr <= clampedHour && positions[i + 1].fhr >= clampedHour) {
            lo = i;
            hi = i + 1;
            break;
        }
    }

    const loPos = positions[lo];
    const hiPos = positions[hi];
    const range = hiPos.fhr - loPos.fhr;

    if (range === 0) {
        return { lat: loPos.lat, lon: loPos.lon };
    }

    const t = (clampedHour - loPos.fhr) / range;
    return {
        lat: loPos.lat + t * (hiPos.lat - loPos.lat),
        lon: loPos.lon + t * (hiPos.lon - loPos.lon),
    };
}
