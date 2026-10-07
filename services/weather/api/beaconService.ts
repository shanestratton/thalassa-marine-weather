import { CapacitorHttp } from '@capacitor/core';
import { BeaconObservation, BuoyStation } from '../../../types';
import type { BuoyObs } from '../buoys/types';
import { BUOY_MAX_AGE_MS } from '../buoys/qc';
import { MAJOR_BUOYS } from '../config';
import { piCache } from '../../PiCacheService';

import { createLogger } from '../../../utils/createLogger';
import { calculateDistance } from '../../../utils/navigationCalculations';

const _log = createLogger('beaconService');

// --- CONSTANTS ---
const NDBC_BASE_URL = 'https://www.ndbc.noaa.gov/data/realtime2';
const MAX_BEACON_DISTANCE_NM = 10; // nautical miles
/**
 * A MAJOR_BUOYS entry may stand for a buoy some miles off (Cape Byron reads
 * the Tweed Offshore buoy, 25 NM north), but never for one further than the
 * app calls "nearby" (the popup's 50 NM, W1-11). The M5 entry sits at Belmullet
 * while the live M5 buoy is ~200 NM away off Wexford.
 */
const MAX_STAND_IN_NM = 50;
/**
 * NDBC buoys alternate met-only rows with wave rows minutes apart (CDIP every
 * 30 min). A wave row further back than this belongs to an earlier sea, not to
 * the reading it would be stamped with.
 */
const NDBC_WAVE_ROW_WINDOW_MS = 60 * 60 * 1000;

// MAJOR_BUOYS ids → the Queensland wave feed's LIVE site names (checked
// against the feed 2026-10-07). 'Brisbane', 'Gold Coast' and 'Tweed River'
// no longer exist there (the Mk4 replacements carry new names), so those three
// never matched; and Double Island Point was mapped to Caloundra, 50 NM south,
// when the Wide Bay buoy sits 10 NM off the point.
const QLD_SITE_MAPPING: Record<string, string> = {
    Moreton: 'Brisbane Mk4',
    MB_Cent: 'North Moreton Bay',
    Spitfire: 'North Moreton Bay',
    Mooloolaba: 'Mooloolaba',
    GoldCoast: 'Gold Coast Mk4',
    Byron: 'Tweed Offshore',
    DoubleIsland: 'Wide Bay',
    // Unmapped until 2026-10-08, so these four read nothing although a live
    // site is a few miles off (the measured distance is what the app shows).
    Stradbroke: 'Brisbane Mk4',
    Townsville: 'Townsville',
    Cairns: 'Cairns Mk4',
    Gladstone: 'Gladstone',
};

// --- NDBC (NOAA) BUOY FETCHING ---

interface NDBCRawData {
    windSpeed?: number;
    windDirection?: number;
    windGust?: number;
    waveHeight?: number;
    dominantWavePeriod?: number;
    /** Direction the WAVES come from — never the wind's. */
    waveDirection?: number;
    waterTemp?: number;
    airTemp?: number;
    pressure?: number;
    timestamp?: string;
    /** The station that actually measured it, when it is not the MAJOR_BUOYS entry itself. */
    station?: { name: string; lat: number; lon: number };
}

/**
 * Fetch real-time observation data from NOAA NDBC buoy network
 *
 * NDBC (National Data Buoy Center) provides real-time observations from marine buoys
 * stationed throughout US coastal waters and open ocean. Data is served as space-delimited
 * text files with fixed column format.
 *
 * ## Data Format:
 * - Line 1: Column headers (e.g., "YY MM DD hh mm WSPD WDIR...")
 * - Line 2: Units (e.g., "yr mo dy hr mn m/s degT...")
 * - Line 3+: Data rows (most recent first)
 *
 * ## Available Metrics (when sensors present):
 * - Wind: Speed, direction, gusts
 * - Waves: Significant height, dominant period
 * - Temperature: Air, water
 * - Atmospheric: Pressure
 *
 * Missing data is marked as "MM" or "9999" in the source file.
 *
 * @param buoyId - NDBC station ID (e.g., "46086" for San Francisco)
 * @returns Parsed observation data, or null if fetch fails or data invalid
 *
 * @see https://www.ndbc.noaa.gov/measdes.shtml - NDBC measurement specifications
 *
 * @example
 * ```typescript
 * const data = await fetchNDBCBuoy("46086");
 * if (data) {
 *   log.info(`Wind: ${data.windSpeed} m/s from ${data.windDirection}°`);
 * }
 * ```
 */
async function fetchNDBCBuoy(buoyId: string): Promise<NDBCRawData | null> {
    try {
        const url = `${NDBC_BASE_URL}/${buoyId}.txt`;

        // Pi first (30 min TTL — buoys update every 30min), direct on null.
        // This used to be `url: piUrl || url`, which meant that whenever the
        // Pi was reachable this call ONLY went to the Pi — and the Pi's
        // self-signed cert makes that throw on iOS, so the outer catch turned
        // a healthy buoy into "no data". Pi failure must cost a hop, not the
        // reading (2026-08-22).
        let body = await piCache.passthroughText(url, 30 * 60 * 1000, 'ndbc-buoy');
        if (body === null) {
            const response = await CapacitorHttp.get({
                url,
                headers: { Accept: 'text/plain' },
            });
            if (response.status !== 200 || !response.data) {
                return null;
            }
            body = typeof response.data === 'string' ? response.data : String(response.data);
        }

        const lines = body.trim().split('\n');
        if (lines.length < 3) {
            return null;
        }

        // Line 1: Headers, Line 2: Units, Line 3+: Data, newest first. The
        // header's first column is '#YY' and the year has four digits; keying
        // on 'YY' meant no NDBC reading ever had a time (and "now" stood in).
        const headers = lines[0].replace(/^#/, '').trim().split(/\s+/);
        const rowAt = (index: number): Record<string, string> => {
            const cells = (lines[index] ?? '').trim().split(/\s+/);
            const row: Record<string, string> = {};
            headers.forEach((header: string, i: number) => {
                row[header] = cells[i];
            });
            return row;
        };
        const data = rowAt(2);
        const rowTime = (row: Record<string, string>): number | null => {
            if (!row.YY || !row.MM || !row.DD || !row.hh || !row.mm) return null;
            const year = row.YY.length === 2 ? 2000 + Number(row.YY) : Number(row.YY);
            const ms = Date.UTC(year, Number(row.MM) - 1, Number(row.DD), Number(row.hh), Number(row.mm));
            return Number.isFinite(ms) ? ms : null;
        };

        // A station that stops reporting keeps its last rows in the file for
        // days (41002 'South Hatteras' last reported 2026-10-03 and was still
        // served on 10-07). Older than 3 h, or untimed, is not a measurement
        // to merge as current.
        const newestAt = rowTime(data);
        if (newestAt === null || Date.now() - newestAt > BUOY_MAX_AGE_MS) {
            return null;
        }

        // Extract relevant metrics (handle missing data marked as "MM" or 9999)
        const parseValue = (val: string | undefined, missing: string = 'MM'): number | undefined => {
            if (!val || val === missing || val === '9999') return undefined;
            const parsed = parseFloat(val);
            return isNaN(parsed) ? undefined : parsed;
        };

        // NDBC's own buoys alternate met-only rows with wave rows, so the
        // waves come from the newest row that has them, but only within the
        // hour of the stamped reading: a sensor that has been down for hours
        // gives no waves rather than old ones under a new time.
        let waves: Record<string, string> = {};
        for (let i = 2; i < lines.length; i++) {
            const row = rowAt(i);
            const at = rowTime(row);
            if (at === null || newestAt - at > NDBC_WAVE_ROW_WINDOW_MS) break;
            if (parseValue(row.WVHT) !== undefined) {
                waves = row;
                break;
            }
        }

        return {
            windSpeed: parseValue(data.WSPD),
            windDirection: parseValue(data.WDIR),
            windGust: parseValue(data.GST),
            waveHeight: parseValue(waves.WVHT),
            dominantWavePeriod: parseValue(waves.DPD),
            waveDirection: parseValue(waves.MWD),
            waterTemp: parseValue(data.WTMP),
            airTemp: parseValue(data.ATMP),
            pressure: parseValue(data.PRES),
            timestamp: new Date(newestAt).toISOString(),
        };
    } catch (error) {
        return null;
    }
}

// --- BOM / QUEENSLAND GOVERNMENT BUOY FETCHING ---

/**
 * A reading from the shared buoy feed (services/weather/buoys), which owns the
 * parsing and QC: the height column under either name it goes by, sentinels,
 * 0,0 positions, the Seconds epoch, and nothing older than 3 h.
 */
function fromBuoyFeed(obs: BuoyObs): NDBCRawData {
    return {
        waveHeight: obs.hsM ?? undefined,
        // The peak period (Tp), never the mean zero-crossing Tz (W1-07).
        dominantWavePeriod: obs.periodS ?? undefined,
        waveDirection: obs.fromDeg ?? undefined,
        waterTemp: obs.sstC ?? undefined,
        timestamp: new Date(obs.time).toISOString(),
        station: { name: obs.owner ? `${obs.label} (${obs.owner})` : obs.label, lat: obs.lat, lon: obs.lon },
        // Wave buoys carry no anemometer here.
        windSpeed: undefined,
        windDirection: undefined,
        windGust: undefined,
        airTemp: undefined,
        pressure: undefined,
    };
}

/**
 * Real-time observation from a Queensland Government wave buoy, read from the
 * live wave feed (one cached request covers every site).
 */
async function fetchBOMBuoy(buoyId: string): Promise<NDBCRawData | null> {
    try {
        const siteName = QLD_SITE_MAPPING[buoyId];
        if (!siteName) {
            return null;
        }
        const { getFreshNetworkObs } = await import('../buoys/feed');
        const obs = (await getFreshNetworkObs('qld-des')).find((o) => o.label === siteName);
        return obs ? fromBuoyFeed(obs) : null;
    } catch (error) {
        return null;
    }
}

// --- BOM AUTOMATIC WEATHER STATION (AWS) FETCHING ---

/**
 * Fetch real-time wind observations from BOM Automatic Weather Station
 * Uses BOM JSON API for individual coastal stations with full wind sensors
 *
 * These stations provide ACTUAL OBSERVED wind data (not forecasts)
 * Unlike wave buoys, AWS have anemometers and provide wind speed, direction, gusts
 */
async function fetchBOMAWS(stationId: string): Promise<NDBCRawData | null> {
    try {
        // BOM JSON endpoint pattern for individual stations
        // HTTPS (2026-08-07). This was http, which iOS App Transport Security
        // blocks outright — the request never left the phone, so BOM station
        // observations silently never loaded on device. BOM 301-redirects
        // http->https anyway, so the plain URL had already stopped being the
        // real endpoint; ATS just made the staleness fatal rather than
        // invisible.
        const url = `https://www.bom.gov.au/fwo/IDQ60801/IDQ60801.${stationId}.json`;

        // Pi first, direct on null — see the NDBC note above; the old
        // `piUrl || url` form dropped the reading whenever the Pi answered.
        let data = await piCache.passthroughJson<unknown>(url, 15 * 60 * 1000, 'bom-aws');
        if (data === null) {
            const response = await CapacitorHttp.get({
                url,
                headers: { Accept: 'application/json' },
            });
            if (response.status !== 200 || !response.data) {
                return null;
            }
            data = response.data;
        }

        // BOM's observation records carry dozens of loosely-typed fields;
        // this was implicitly `any` before the transport change and retyping
        // it is a separate job. NOTE the disable must be the LINE DIRECTLY
        // above the code — the original had three lines of prose between
        // them, so the suppression landed on a comment and the error stood.
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const parsed = data as { observations?: { data?: Array<Record<string, any>> } };

        // BOM JSON structure: { observations: { data: [...] } }
        if (!parsed.observations?.data || parsed.observations.data.length === 0) {
            return null;
        }

        // Get most recent observation (first in array)
        const obs = parsed.observations.data[0];

        // Parse BOM AWS data
        // Fields: wind_dir, wind_spd_kmh, gust_kmh, air_temp, press, etc.
        // Convert km/h to m/s for consistency with NDBC (m/s * 1.944 = knots)
        const parseFloat = (val: unknown): number | undefined => {
            if (val === null || val === undefined || val === '-') return undefined;
            const parsed = Number(val);
            return isNaN(parsed) ? undefined : parsed;
        };

        const windSpeedKmh = parseFloat(obs.wind_spd_kmh);
        const gustKmh = parseFloat(obs.gust_kmh);

        // Convert km/h to m/s (divide by 3.6)
        const windSpeed = windSpeedKmh !== undefined ? windSpeedKmh / 3.6 : undefined;
        const windGust = gustKmh !== undefined ? gustKmh / 3.6 : undefined;

        // BOM AWS provides wind_dir (cardinal) and sometimes wind_dir_deg (degrees)
        // Priority: degrees > cardinal conversion
        const windDirDeg = parseFloat(obs.wind_dir_deg);
        const windDirCardinal = obs.wind_dir; // e.g., "E", "NE", "SSW"

        // CRITICAL FIX: Fall back to cardinal-to-degrees conversion if degrees unavailable
        // Import cardinalToDegrees inline to avoid circular dependencies
        const cardinalMap: Record<string, number> = {
            N: 0,
            NNE: 22.5,
            NE: 45,
            ENE: 67.5,
            E: 90,
            ESE: 112.5,
            SE: 135,
            SSE: 157.5,
            S: 180,
            SSW: 202.5,
            SW: 225,
            WSW: 247.5,
            W: 270,
            WNW: 292.5,
            NW: 315,
            NNW: 337.5,
        };
        const windDirection =
            windDirDeg !== undefined
                ? windDirDeg
                : windDirCardinal
                  ? cardinalMap[windDirCardinal.toUpperCase()]
                  : undefined;

        return {
            windSpeed,
            windGust,
            windDirection, // Now uses degrees OR cardinal fallback
            airTemp: parseFloat(obs.air_temp),
            pressure: parseFloat(obs.press),
            timestamp: obs.local_date_time_full || obs.aifstime_utc || new Date().toISOString(),
            // AWS typically don't have wave/water sensors
            waveHeight: undefined,
            dominantWavePeriod: undefined,
            waterTemp: undefined,
        };
    } catch (error) {
        return null;
    }
}

// --- HONG KONG OBSERVATORY (HKO) FETCHING ---

/**
 * Fetch real-time wind observations from Hong Kong Observatory
 * Uses DATA.GOV.HK API for regional weather stations
 *
 * HKO provides 10-minute mean wind data from stations including:
 * - Waglan Island (marine)
 * - Cheung Chau (island)
 * - Kai Tak (harbour)
 * - Various automatic weather stations
 */
async function fetchHKOStation(stationId: string): Promise<NDBCRawData | null> {
    try {
        // HKO Regional Weather API
        const url = 'https://data.weather.gov.hk/weatherAPI/opendata/weather.php?dataType=rhrread&lang=en';

        const response = await CapacitorHttp.get({
            url,
            headers: { Accept: 'application/json' },
        });

        if (response.status !== 200 || !response.data) {
            return null;
        }

        const data = response.data;

        // Find the specific station in the wind array
        const windData = data.wind?.data?.find(
            (s: { place?: string; mean?: number; max?: number; direction?: string }) =>
                s.place?.toLowerCase().includes(stationId.toLowerCase()),
        );

        if (!windData) {
            return null;
        }

        // Parse wind data
        // HKO provides: mean (km/h), max (km/h), direction
        const windSpeedKmh = parseFloat(windData.mean);
        const gustKmh = parseFloat(windData.max);

        // Convert cardinal direction to degrees
        const cardinalMap: Record<string, number> = {
            N: 0,
            NNE: 22.5,
            NE: 45,
            ENE: 67.5,
            E: 90,
            ESE: 112.5,
            SE: 135,
            SSE: 157.5,
            S: 180,
            SSW: 202.5,
            SW: 225,
            WSW: 247.5,
            W: 270,
            WNW: 292.5,
            NW: 315,
            NNW: 337.5,
        };
        const windDirection = windData.direction ? cardinalMap[windData.direction.toUpperCase()] : undefined;

        // Convert km/h to m/s (divide by 3.6)
        const windSpeed = !isNaN(windSpeedKmh) ? windSpeedKmh / 3.6 : undefined;
        const windGust = !isNaN(gustKmh) ? gustKmh / 3.6 : undefined;

        // Try to get temperature/humidity from other sections
        const tempData = data.temperature?.data?.find((s: { place?: string; value?: number }) =>
            s.place?.toLowerCase().includes(stationId.toLowerCase()),
        );
        const _humidityData = data.humidity?.data?.find((s: { place?: string; value?: number }) =>
            s.place?.toLowerCase().includes(stationId.toLowerCase()),
        );

        return {
            windSpeed,
            windGust,
            windDirection,
            airTemp: tempData?.value ? parseFloat(tempData.value) : undefined,
            pressure: undefined, // Not available in this API
            timestamp: data.updateTime || new Date().toISOString(),
            waveHeight: undefined,
            dominantWavePeriod: undefined,
            waterTemp: undefined,
        };
    } catch (error) {
        return null;
    }
}

// --- IRISH MARINE INSTITUTE (ERDDAP) FETCHING ---

/**
 * Irish Weather Buoy Network (M2–M6) via the Marine Institute's ERDDAP
 * dataset IWBNetwork. The old IMI-EATL-WAVE dataset answers 404 and the old
 * query was unencoded; the shared feed asks correctly, and THIS buoy's own
 * row is returned (the old reader handed back whichever row came first).
 */
async function fetchIrishBuoy(buoyId: string): Promise<NDBCRawData | null> {
    try {
        const { getFreshNetworkObs } = await import('../buoys/feed');
        const obs = (await getFreshNetworkObs('irish-mi')).find((o) => o.key === `irish-mi:${buoyId}`);
        return obs ? fromBuoyFeed(obs) : null;
    } catch (error) {
        return null;
    }
}

// --- GENERIC BUOY FETCHER ---

/**
 * Fetch buoy/station data based on type (NOAA, BOM, BOM AWS, or other)
 */
async function fetchBuoyData(buoy: BuoyStation): Promise<NDBCRawData | null> {
    switch (buoy.type) {
        case 'noaa':
            return fetchNDBCBuoy(buoy.id);
        case 'bom':
        case 'imos':
            // Use Queensland/BOM integration for wave buoys
            return fetchBOMBuoy(buoy.id);
        case 'bom-aws':
            // BOM Automatic Weather Stations with wind sensors
            if (!buoy.bomStationId) {
                return null;
            }
            return fetchBOMAWS(buoy.bomStationId);
        case 'hko':
            // Hong Kong Observatory regional weather stations
            return fetchHKOStation(buoy.id);
        case 'marine-ie':
            // Irish Marine Institute ERDDAP buoys
            return fetchIrishBuoy(buoy.id);
        case 'ukmo':
        case 'eurogoos':
        case 'jma':
        case 'other':
            // Placeholder - these networks need implementation
            return null;
        default:
            return null;
    }
}

// --- MAIN PUBLIC FUNCTION ---

/**
 * Find and fetch real-time data from the nearest weather beacon/buoy
 *
 * Searches the global buoy network (NOAA NDBC, BOM/Queensland, etc.) for the closest
 * beacon within the specified range and fetches its latest observation data.
 *
 * ## Search Strategy:
 * 1. Calculate distances to all known buoys
 * 2. Filter to those within `maxDistanceNM` (default 10nm)
 * 3. Sort by proximity
 * 4. Attempt to fetch data from each, stopping at first success
 *
 * ## Supported Networks:
 * - **NOAA NDBC**: US buoys with full atmospheric + marine sensors
 * - **BOM/Queensland**: Australian wave buoys (limited to marine metrics)
 * - **IMOS, UKMO, EUROGOOS, JMA**: Planned but not yet implemented
 *
 * ## Data Availability:
 * - **Always**: Wave height, swell period, water temperature
 * - **Sometimes**: Wind speed/direction (NDBC yes, Queensland wave buoys no)
 * - **Rarely**: Air pressure, air temperature, currents
 *
 * @param lat - Target latitude for search
 * @param lon - Target longitude for search
 * @param maxDistanceNM - Maximum search radius in nautical miles (default: 10nm)
 * @returns BeaconObservation with real-time data, or null if no beacon found/available
 *
 * @example
 * ```typescript
 * const beacon = await findAndFetchNearestBeacon(-27.3, 153.3, 10);
 * if (beacon) {
 *   log.info(`Found ${beacon.name} at ${beacon.distance}nm`);
 *   log.info(`Wave height: ${beacon.waveHeight}m`);
 * }
 * ```
 */
export async function findAndFetchNearestBeacon(
    lat: number,
    lon: number,
    maxDistanceNM: number = MAX_BEACON_DISTANCE_NM,
): Promise<BeaconObservation | null> {
    try {
        // Calculate distances and sort
        const buoysWithDistance = MAJOR_BUOYS.map((buoy) => ({
            buoy,
            distance: calculateDistance(lat, lon, buoy.lat, buoy.lon),
        })).sort((a, b) => a.distance - b.distance);

        // Filter within range
        const nearbyBuoys = buoysWithDistance.filter((b) => b.distance <= maxDistanceNM);

        if (nearbyBuoys.length === 0) {
            return null;
        }

        // Try each beacon until we get valid data
        for (const { buoy, distance } of nearbyBuoys) {
            const data = await fetchBuoyData(buoy);
            if (data) {
                // Convert to BeaconObservation
                // Name and place the station that actually measured it: a
                // MAJOR_BUOYS entry can stand for a buoy some miles away.
                const at = data.station;
                const measuredAt = at ? calculateDistance(lat, lon, at.lat, at.lon) : distance;
                if (measuredAt > MAX_STAND_IN_NM) continue;
                const observation: BeaconObservation = {
                    buoyId: buoy.id,
                    name: at?.name ?? buoy.name,
                    lat: at?.lat ?? buoy.lat,
                    lon: at?.lon ?? buoy.lon,
                    distance: measuredAt,
                    timestamp: data.timestamp || new Date().toISOString(),
                    windSpeed: data.windSpeed,
                    windDirection: data.windDirection,
                    windGust: data.windGust,
                    waveHeight: data.waveHeight,
                    swellPeriod: data.dominantWavePeriod,
                    swellDirection: data.waveDirection,
                    waterTemperature: data.waterTemp,
                    airTemperature: data.airTemp,
                    pressure: data.pressure,
                    currentSpeed: undefined, // Most buoys don't provide current data
                    currentDegree: undefined,
                };

                return observation;
            } else {
                /* best effort */
            }
        }

        return null;
    } catch (error) {
        return null;
    }
}
