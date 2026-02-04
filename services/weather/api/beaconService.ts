
import { CapacitorHttp } from '@capacitor/core';
import { BeaconObservation, BuoyStation } from '../../../types';
import { MAJOR_BUOYS } from '../config';
import { degreesToCardinal } from '../../../utils/format';

// --- CONSTANTS ---
const NDBC_BASE_URL = 'https://www.ndbc.noaa.gov/data/realtime2';
const QLD_WAVE_API_BASE = 'https://www.data.qld.gov.au/api/3/action/datastore_search';
const MAX_BEACON_DISTANCE_NM = 10; // nautical miles

// Queensland wave buoy master resource ID (all sites in one dataset)
const QLD_WAVE_MASTER_RESOURCE = '2bbef99e-9974-49b9-a316-57402b00609c';

// Map buoy IDs to Queensland site names for filtering
const QLD_SITE_MAPPING: Record<string, string> = {
    'Moreton': 'Brisbane',
    'MB_Cent': 'North Moreton Bay',
    'Spitfire': 'North Moreton Bay',
    'Mooloolaba': 'Mooloolaba',
    'GoldCoast': 'Gold Coast',
    'Byron': 'Tweed River',
    'DoubleIsland': 'Caloundra'
};

// --- HELPER FUNCTIONS ---

/**
 * Calculate distance between two coordinates in nautical miles
 * Uses Haversine formula
 */
function calculateDistanceNM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 3440.065; // Earth's radius in nautical miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}



// --- NDBC (NOAA) BUOY FETCHING ---

interface NDBCRawData {
    windSpeed?: number;
    windDirection?: number;
    windGust?: number;
    waveHeight?: number;
    dominantWavePeriod?: number;
    waterTemp?: number;
    airTemp?: number;
    pressure?: number;
    timestamp?: string;
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
 *   console.log(`Wind: ${data.windSpeed} m/s from ${data.windDirection}°`);
 * }
 * ```
 */
async function fetchNDBCBuoy(buoyId: string): Promise<NDBCRawData | null> {
    try {
        const url = `${NDBC_BASE_URL}/${buoyId}.txt`;

        const response = await CapacitorHttp.get({
            url,
            headers: { 'Accept': 'text/plain' }
        });

        if (response.status !== 200 || !response.data) {
            console.warn(`[BeaconService] NDBC buoy ${buoyId} returned status ${response.status}`);
            return null;
        }

        const lines = response.data.trim().split('\n');
        if (lines.length < 3) {
            console.warn(`[BeaconService] NDBC buoy ${buoyId} has insufficient data`);
            return null;
        }

        // Line 1: Headers, Line 2: Units, Line 3+: Data
        const headers = lines[0].split(/\s+/);
        const dataLine = lines[2].split(/\s+/);

        // Parse into object
        const data: any = {};
        headers.forEach((header: string, i: number) => {
            data[header] = dataLine[i];
        });

        // Extract relevant metrics (handle missing data marked as "MM" or 9999)
        const parseValue = (val: string, missing: string = 'MM'): number | undefined => {
            if (!val || val === missing || val === '9999') return undefined;
            const parsed = parseFloat(val);
            return isNaN(parsed) ? undefined : parsed;
        };

        // Build timestamp from YYYY MM DD hh mm
        let timestamp: string | undefined;
        if (data.YY && data.MM && data.DD && data.hh && data.mm) {
            const year = `20${data.YY}`;
            const month = data.MM.padStart(2, '0');
            const day = data.DD.padStart(2, '0');
            const hour = data.hh.padStart(2, '0');
            const minute = data.mm.padStart(2, '0');
            timestamp = `${year}-${month}-${day}T${hour}:${minute}:00Z`;
        }

        return {
            windSpeed: parseValue(data.WSPD),
            windDirection: parseValue(data.WDIR),
            windGust: parseValue(data.GST),
            waveHeight: parseValue(data.WVHT),
            dominantWavePeriod: parseValue(data.DPD),
            waterTemp: parseValue(data.WTMP),
            airTemp: parseValue(data.ATMP),
            pressure: parseValue(data.PRES),
            timestamp
        };
    } catch (error) {
        console.error(`[BeaconService] Error fetching NDBC buoy ${buoyId}:`, error);
        return null;
    }
}

// --- BOM / QUEENSLAND GOVERNMENT BUOY FETCHING ---

/**
 * Fetch real-time observation from Queensland Government wave buoy
 * Uses data.qld.gov.au API with CKAN datastore
 */
async function fetchBOMBuoy(buoyId: string): Promise<NDBCRawData | null> {
    try {
        // Map buoy ID to Queensland site name
        const siteName = QLD_SITE_MAPPING[buoyId];
        if (!siteName) {
            console.warn(`[BeaconService] BOM/QLD buoy ${buoyId} not mapped to Queensland site`);
            return null;
        }

        // Queensland Government Open Data API with site filter
        const filters = encodeURIComponent(JSON.stringify({ "Site": siteName }));
        const url = `${QLD_WAVE_API_BASE}?resource_id=${QLD_WAVE_MASTER_RESOURCE}&filters=${filters}&limit=1&sort=DateTime%20desc`;



        const response = await CapacitorHttp.get({
            url,
            headers: { 'Accept': 'application/json' }
        });

        if (response.status !== 200 || !response.data) {
            console.warn(`[BeaconService] QLD API returned status ${response.status}`);
            return null;
        }

        const data = response.data;
        if (!data.success || !data.result || !data.result.records || data.result.records.length === 0) {
            console.warn(`[BeaconService] QLD buoy ${buoyId} has no recent data`);
            return null;
        }

        const record = data.result.records[0];

        // Parse Queensland wave data format
        // Fields: Hs (significant wave height), Hmax, Tz (period), Tp, Direction, SST (sea surface temp)
        return {
            waveHeight: parseFloat(record.Hs) || undefined,
            dominantWavePeriod: parseFloat(record.Tp) || parseFloat(record.Tz) || undefined,
            windDirection: parseFloat(record.Direction) || undefined,
            waterTemp: parseFloat(record.SST) || undefined,
            timestamp: record.DateTime || new Date().toISOString(),
            // Wind data not typically available from wave buoys
            windSpeed: undefined,
            windGust: undefined,
            airTemp: undefined,
            pressure: undefined
        };
    } catch (error) {
        console.error(`[BeaconService] Error fetching BOM/QLD buoy ${buoyId}:`, error);
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
        const url = `http://www.bom.gov.au/fwo/IDQ60801/IDQ60801.${stationId}.json`;



        const response = await CapacitorHttp.get({
            url,
            headers: { 'Accept': 'application/json' }
        });

        if (response.status !== 200 || !response.data) {
            console.warn(`[BeaconService] BOM AWS API returned status ${response.status}`);
            return null;
        }

        const data = response.data;

        // BOM JSON structure: { observations: { data: [...] } }
        if (!data.observations || !data.observations.data || data.observations.data.length === 0) {
            console.warn(`[BeaconService] BOM AWS ${stationId} has no observation data`);
            return null;
        }

        // Get most recent observation (first in array)
        const obs = data.observations.data[0];

        // Parse BOM AWS data
        // Fields: wind_dir, wind_spd_kmh, gust_kmh, air_temp, press, etc.
        // Convert km/h to m/s for consistency with NDBC (m/s * 1.944 = knots)
        const parseFloat = (val: any): number | undefined => {
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



        return {
            windSpeed,
            windGust,
            windDirection: windDirDeg, // Use degrees if available
            airTemp: parseFloat(obs.air_temp),
            pressure: parseFloat(obs.press),
            timestamp: obs.local_date_time_full || obs.aifstime_utc || new Date().toISOString(),
            // AWS typically don't have wave/water sensors
            waveHeight: undefined,
            dominantWavePeriod: undefined,
            waterTemp: undefined
        };
    } catch (error) {
        console.error(`[BeaconService] Error fetching BOM AWS ${stationId}:`, error);
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
                console.warn(`[BeaconService] BOM AWS ${buoy.id} missing bomStationId`);
                return null;
            }
            return fetchBOMAWS(buoy.bomStationId);
        case 'ukmo':
        case 'eurogoos':
        case 'jma':
        case 'other':
            // Placeholder - these networks need implementation
            console.warn(`[BeaconService] Buoy type '${buoy.type}' not yet implemented for ${buoy.id}`);
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
 *   console.log(`Found ${beacon.name} at ${beacon.distance}nm`);
 *   console.log(`Wave height: ${beacon.waveHeight}m`);
 * }
 * ```
 */
export async function findAndFetchNearestBeacon(
    lat: number,
    lon: number,
    maxDistanceNM: number = MAX_BEACON_DISTANCE_NM
): Promise<BeaconObservation | null> {
    try {


        // Calculate distances and sort
        const buoysWithDistance = MAJOR_BUOYS.map(buoy => ({
            buoy,
            distance: calculateDistanceNM(lat, lon, buoy.lat, buoy.lon)
        })).sort((a, b) => a.distance - b.distance);

        // Filter within range
        const nearbyBuoys = buoysWithDistance.filter(b => b.distance <= maxDistanceNM);

        if (nearbyBuoys.length === 0) {
            return null;
        }



        // Try each beacon until we get valid data
        for (const { buoy, distance } of nearbyBuoys) {


            const data = await fetchBuoyData(buoy);
            if (data) {


                // Convert to BeaconObservation
                const observation: BeaconObservation = {
                    buoyId: buoy.id,
                    name: buoy.name,
                    lat: buoy.lat,
                    lon: buoy.lon,
                    distance: distance,
                    timestamp: data.timestamp || new Date().toISOString(),
                    windSpeed: data.windSpeed,
                    windDirection: data.windDirection,
                    windGust: data.windGust,
                    waveHeight: data.waveHeight,
                    swellPeriod: data.dominantWavePeriod,
                    waterTemperature: data.waterTemp,
                    airTemperature: data.airTemp,
                    pressure: data.pressure,
                    currentSpeed: undefined, // Most buoys don't provide current data
                    currentDegree: undefined
                };

                return observation;
            } else {
                console.warn(`[BeaconService] ✗ Failed to fetch data from ${buoy.name}, trying next...`);
            }
        }

        console.warn(`[BeaconService] No beacons returned valid data`);
        return null;

    } catch (error) {
        console.error('[BeaconService] Error in findAndFetchNearestBeacon:', error);
        return null;
    }
}
