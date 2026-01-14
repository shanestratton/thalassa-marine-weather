
import { MarineWeatherReport, WeatherModel, BuoyStation } from '../../types';
import { parseLocation, reverseGeocode } from './api/geocoding';
import { fetchOpenMeteo } from './api/openmeteo';
import { fetchStormGlassWeather } from './api/stormglass';
import { saveToCache, getFromCache } from './cache';
import { fetchNearestMetar, getShortCondition, LocalObservation } from '../MetarService';
import { degreesToCardinal } from '../../utils';

// --- RE-EXPORTS (Maintain API Compatibility) ---
export { MAJOR_BUOYS } from './config';
export { getApiKeySuffix, isStormglassKeyPresent, debugStormglassConnection, checkStormglassStatus } from './keys';
export { reverseGeocode, parseLocation } from './api/geocoding';
export { fetchOpenMeteo } from './api/openmeteo';
export { fetchActiveBuoys } from './api/buoys';

// Legacy Stubs (Unused but exported in old service)
export const fetchBaseWeather = async (
    lat: number, lon: number, name: string
): Promise<MarineWeatherReport | null> => { return null; };

export const fetchAccurateMarineGrid = async (lat: number, lon: number): Promise<any[]> => { return []; };

// Alias for compatibility
export const fetchStormglassData = fetchStormGlassWeather;

// --- HELPER: METAR OVERRIDE ---
const applyMetarOverride = async (data: MarineWeatherReport): Promise<MarineWeatherReport> => {
    try {
        if (!data.coordinates) return data;
        const { lat, lon } = data.coordinates;
        // Fetch nearest METAR
        const obs = await fetchNearestMetar(lat, lon);

        if (obs) {
            // Calculate Approximation for Humidity if missing (100 - 5 * (T - Td))
            let humidity = 0;
            if (obs.temperature !== undefined && obs.dewpoint !== undefined) {
                humidity = Math.max(0, Math.min(100, 100 - 5 * (obs.temperature - obs.dewpoint)));
            }

            // Prepare log values
            const logValues = {
                Station: obs.stationId,
                Temp: obs.temperature,
                Dewpoint: obs.dewpoint,
                Humidity: humidity,
                Pressure: obs.pressure,
                Wind: `${obs.windSpeed}kts @ ${obs.windDirection}°`,
                Gust: obs.windGust || 0,
                Rain: obs.precip || 0,
                Vis: obs.visibility,
                Clouds: obs.cloudCover
            };

            console.log(`[METAR OVERRIDE] Applied Real Data from ${obs.stationId}:`, JSON.stringify(logValues, null, 2));

            // OVERRIDE CURRENT METRICS
            // Note: We deliberately overwrite the 'current' object with valid METAR data
            // We keep fields that METAR doesn't have (like Wave Height) from the original model data

            data.current = {
                ...data.current, // Keep waves/tides/astro

                // Air
                airTemperature: obs.temperature,
                feelsLike: obs.temperature, // METAR doesn't give Feels Like, use Temp or calc later? User said "Temp"
                humidity: humidity,
                pressure: obs.pressure,
                visibility: obs.visibility > 0 ? obs.visibility : data.current.visibility, // Only override if valid

                // Wind
                windSpeed: obs.windSpeed,
                windDirection: degreesToCardinal(obs.windDirection),
                windDegree: obs.windDirection,
                windGust: obs.windGust || 0, // Metar service returns undefined if no gusts

                // Sky
                cloudCover: obs.cloudCover || 0,
                precipitation: obs.precip || 0,
                condition: getShortCondition(obs),
                description: `(METAR ${obs.stationId}) ${getShortCondition(obs)}. Wind ${obs.windSpeed}kts.`,

                // Meta
                isEstimated: false // It's real obs
            };

            // Tag source
            data.groundingSource = `METAR (${obs.stationId})`;
        } else {
            console.log("[METAR OVERRIDE] No METAR data found. Retaining StormGlass/Model data.");
        }
    } catch (e) {
        console.warn("[METAR OVERRIDE] Failed to apply (Fallback to Model):", e);
    }
    return data;
};


// --- MAIN ORCHESTRATORS ---

/**
 * Fast Weather: Uses OpenMeteo (Free/Fast)
 * Prioritizes speed. Used for initial load.
 */
export const fetchFastWeather = async (
    location: string,
    coords?: { lat: number, lon: number },
    model: WeatherModel = 'best_match'
): Promise<MarineWeatherReport> => {

    // 1. Resolve Location
    let lat: number, lon: number, name: string;

    if (coords) {
        lat = coords.lat;
        lon = coords.lon;
        name = location;

        // Auto-resolve name if generic
        if (!name || name === "Current Location" || name.includes("Lat:")) {
            try {
                const resolved = await reverseGeocode(lat, lon);
                if (resolved) name = resolved;
                else {
                    const latStr = Math.abs(lat).toFixed(2) + (lat >= 0 ? 'N' : 'S');
                    const lonStr = Math.abs(lon).toFixed(2) + (lon >= 0 ? 'E' : 'W');
                    name = `Ocean Point ${latStr} ${lonStr}`;
                }
            } catch {
                name = `Location ${lat.toFixed(2)},${lon.toFixed(2)}`;
            }
        }
    } else {
        const parsed = await parseLocation(location);
        lat = parsed.lat;
        lon = parsed.lon;
        name = parsed.name;
    }

    // 2. Timeout Wrapper (15s)
    const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Fast Fetch Timeout")), 15000)
    );

    try {
        // 3. Race Fetch vs Timeout
        const data = await Promise.race([
            fetchOpenMeteo(lat, lon, name, true, model),
            timeoutPromise
        ]);

        // 4. Cache Result
        saveToCache(name, data);
        return data;
    } catch (e: any) {
        console.error("Fast Weather Failed:", e);
        throw e;
    }
};

/**
 * Precision Weather: Uses StormGlass (Paid/Accurate)
 * Prioritizes accuracy. Used for detailed view.
 * Falls back to OpenMeteo if StormGlass fails.
 */
export const fetchPrecisionWeather = async (
    location: string,
    coords?: { lat: number, lon: number },
    forceRefresh = false
): Promise<MarineWeatherReport> => {

    // 1. Resolve Location
    let lat: number, lon: number, name: string;

    if (coords) {
        lat = coords.lat;
        lon = coords.lon;
        name = location;
        if (!name || name === 'Current Location') {
            const r = await reverseGeocode(lat, lon);
            if (r) name = r;
        }
    } else {
        const p = await parseLocation(location);
        lat = p.lat;
        lon = p.lon;
        name = p.name;
    }

    // 2. Check Cache (if not forced)
    if (!forceRefresh) {
        const cached = getFromCache(name);
        // Only return if it's a StormGlass cached report (High Quality)
        // If we only have OpenMeteo cached, we might want to upgrade to SG now.
        if (cached && cached.modelUsed.includes('sg')) {
            console.log(`[Precision] Returning Cached SG Report for ${name}`);
            return cached;
        }
    }

    // 3. Fetch StormGlass
    try {
        console.log(`[Precision] Fetching StormGlass for ${name}...`);
        const data = await fetchStormGlassWeather(lat, lon, name);

        // APPLY METAR OVERRIDE
        const startMetar = Date.now();
        await applyMetarOverride(data);
        console.log(`[Precision] METAR Injection took ${Date.now() - startMetar}ms`);

        saveToCache(name, data);
        return data;
    } catch (e) {
        console.warn(`[Precision] StormGlass Failed for ${name}. Logic: Fallback to OpenMeteo.`, e);

        // Fallback
        const fallback = await fetchOpenMeteo(lat, lon, name, false);
        fallback.modelUsed = `OpenMeteo (Fallback)`;

        // Cache fallback so we don't hammer API if it's down
        saveToCache(name, fallback);
        return fallback;
    }
};
