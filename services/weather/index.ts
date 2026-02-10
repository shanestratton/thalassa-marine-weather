
import { MarineWeatherReport, WeatherModel, BuoyStation } from '../../types';
import { parseLocation, reverseGeocode } from './api/geocoding';
import { fetchOpenMeteo } from './api/openmeteo';
import { fetchStormGlassWeather } from './api/stormglass';
import { saveToCache, getFromCache } from './cache';
import { degreesToCardinal } from '../../utils';

// --- RE-EXPORTS (Maintain API Compatibility) ---
export { MAJOR_BUOYS } from './config';
export { getApiKeySuffix, isStormglassKeyPresent, debugStormglassConnection, checkStormglassStatus } from './keys';
export { reverseGeocode, parseLocation } from './api/geocoding';
export { fetchOpenMeteo } from './api/openmeteo';
export { fetchActiveBuoys } from './api/buoys';


// Alias for compatibility
export const fetchStormglassData = fetchStormGlassWeather;

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
                /* Reverse geocode failed — fall back to coordinate-based name */
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
    } catch (e: unknown) {
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
    forceRefresh = false,
    existingLocationType?: 'coastal' | 'offshore' | 'inland'
): Promise<MarineWeatherReport> => {

    // 1. Resolve Location
    let lat: number, lon: number, name: string;

    if (coords) {
        lat = coords.lat;
        lon = coords.lon;
        name = location;

        // RETRY GEOCODING if name is generic (WP ...)
        // This gives us a second chance to find "Townsville" even if the Context sent us "WP -12, 145"
        if (!name || name === 'Current Location' || name.startsWith('WP ') || /^-?\d/.test(name)) {
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
        // FIX: Also check if utcOffset is present (ensure TZ fix is applied)
        if (cached && cached.modelUsed.includes('sg') && cached.utcOffset !== undefined) {

            return cached;
        }
    }

    // 3. Fetch StormGlass
    try {

        const data = await fetchStormGlassWeather(lat, lon, name, existingLocationType);

        // METAR removed - was skewing wind/temps too much

        saveToCache(name, data);
        return data;
    } catch (e) {
        throw e;
    }
};
