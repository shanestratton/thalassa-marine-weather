
import { MarineWeatherReport, WeatherModel, BuoyStation } from '../../types';
import { parseLocation, reverseGeocode } from './api/geocoding';
import { fetchOpenMeteo } from './api/openmeteo';
import { fetchStormGlassWeather } from './api/stormglass';
import { fetchTomorrowIoRealtime, TomorrowIoObservation } from './api/tomorrowio';
import { saveToCache, getFromCache } from './cache';
import { degreesToCardinal } from '../../utils';

// --- RE-EXPORTS (Maintain API Compatibility) ---
export { MAJOR_BUOYS } from './config';
export { getApiKeySuffix, isStormglassKeyPresent, debugStormglassConnection, checkStormglassStatus } from './keys';
export { reverseGeocode, parseLocation } from './api/geocoding';
export { fetchOpenMeteo } from './api/openmeteo';
export { fetchActiveBuoys } from './api/buoys';
export { fetchTomorrowIoRealtime } from './api/tomorrowio';

// Alias for compatibility
export const fetchStormglassData = fetchStormGlassWeather;

// --- MAIN ORCHESTRATORS ---

/**
 * Location-Type-Aware Weather Strategy
 * 
 * Routes API calls based on location type:
 * | Location | Live Source      | Forecast     | Marine Forecast | Minutely Rain |
 * |----------|-----------------|--------------|-----------------|---------------|
 * | Inland   | Tomorrow.io     | Open-Meteo   | —               | Tomorrow.io   |
 * | Coastal  | Tomorrow.io     | Open-Meteo   | StormGlass      | Tomorrow.io   |
 * | Offshore | StormGlass      | Open-Meteo   | StormGlass      | —             |
 * 
 * All API calls fired in parallel via Promise.allSettled for speed.
 */
export const fetchWeatherByStrategy = async (
    lat: number,
    lon: number,
    name: string,
    locationType?: 'coastal' | 'offshore' | 'inland'
): Promise<MarineWeatherReport> => {

    const needsTomorrowLive = locationType !== 'offshore';
    const needsStormGlass = locationType !== 'inland';

    // --- PARALLEL API CALLS ---
    const promises: [
        Promise<MarineWeatherReport>,                       // Open-Meteo (always)
        Promise<MarineWeatherReport | null>,                 // StormGlass (coastal/offshore)
        Promise<TomorrowIoObservation | null>,               // Tomorrow.io realtime (inland/coastal)
    ] = [
            // 1. Open-Meteo: Atmospheric forecast backbone (all locations)
            fetchOpenMeteo(lat, lon, name, false, 'best_match'),

            // 2. StormGlass: Marine forecast + offshore live (coastal/offshore only)
            needsStormGlass
                ? fetchStormGlassWeather(lat, lon, name, locationType).catch((e) => {
                    console.warn('[Strategy] StormGlass failed, continuing with OpenMeteo only:', e);
                    return null;
                })
                : Promise.resolve(null),

            // 3. Tomorrow.io: Live observations (inland/coastal)
            needsTomorrowLive
                ? fetchTomorrowIoRealtime(lat, lon).catch((e) => {
                    console.warn('[Strategy] Tomorrow.io realtime failed:', e);
                    return null;
                })
                : Promise.resolve(null),
        ];

    const [omResult, sgResult, tioResult] = await Promise.allSettled(promises);

    // --- EXTRACT RESULTS ---
    const openMeteoReport = omResult.status === 'fulfilled' ? omResult.value : null;
    const stormGlassReport = sgResult.status === 'fulfilled' ? sgResult.value : null;
    const tomorrowObs = tioResult.status === 'fulfilled' ? tioResult.value : null;

    // --- DETERMINE BASE REPORT ---
    // Priority: StormGlass (marine-rich) > OpenMeteo (atmospheric) 
    // For offshore: StormGlass is primary
    // For inland: OpenMeteo is primary
    // For coastal: StormGlass with OpenMeteo enrichment
    let baseReport: MarineWeatherReport;

    // Precedence: StormGlass (most accurate marine classification) > caller's known type
    // (from previous report) > OpenMeteo (atmospheric only, often wrong for deep ocean) > fallback
    const computedLocationType = stormGlassReport?.locationType || locationType || openMeteoReport?.locationType || 'coastal';

    if (computedLocationType === 'offshore' && stormGlassReport) {
        baseReport = stormGlassReport;
    } else if (computedLocationType === 'inland' && openMeteoReport) {
        baseReport = openMeteoReport;
    } else if (stormGlassReport) {
        baseReport = stormGlassReport;
    } else if (openMeteoReport) {
        baseReport = openMeteoReport;
    } else {
        throw new Error(`All weather APIs failed for ${name}`);
    }

    baseReport.locationType = computedLocationType as 'coastal' | 'offshore' | 'inland';

    // --- MERGE TOMORROW.IO LIVE DATA ---
    // Tomorrow.io provides station-blended observed data — more accurate than model data
    // for temperature, wind, humidity, pressure, conditions
    // IMPORTANT: Skip for offshore locations — Tomorrow.io has no station data offshore
    // and its modelled values are inferior to StormGlass marine-specific models.
    if (tomorrowObs && baseReport && computedLocationType !== 'offshore') {
        const current = { ...baseReport.current };
        const sources = (current as any).sources || {};

        // Temperature: Tomorrow.io observed > StormGlass modelled
        if (tomorrowObs.temperature !== null) {
            current.airTemperature = tomorrowObs.temperature;
            sources['airTemperature'] = {
                value: tomorrowObs.temperature,
                source: 'tomorrow',
                sourceColor: 'sky',
                sourceName: 'Tomorrow.io',
            };
        }

        // Feels-like temperature
        if (tomorrowObs.temperatureApparent !== null) {
            current.feelsLike = tomorrowObs.temperatureApparent;
            sources['feelsLike'] = {
                value: tomorrowObs.temperatureApparent,
                source: 'tomorrow',
                sourceColor: 'sky',
                sourceName: 'Tomorrow.io',
            };
        }

        // Humidity
        if (tomorrowObs.humidity !== null) {
            current.humidity = tomorrowObs.humidity;
            sources['humidity'] = {
                value: tomorrowObs.humidity,
                source: 'tomorrow',
                sourceColor: 'sky',
                sourceName: 'Tomorrow.io',
            };
        }

        // Dew Point
        if (tomorrowObs.dewPoint !== null) {
            current.dewPoint = tomorrowObs.dewPoint;
            sources['dewPoint'] = {
                value: tomorrowObs.dewPoint,
                source: 'tomorrow',
                sourceColor: 'sky',
                sourceName: 'Tomorrow.io',
            };
        }

        // Wind: Tomorrow.io observed > StormGlass modelled
        // BUT: Don't overwrite beacon wind data (beacons added later in enhanceWithBeaconData)
        if (tomorrowObs.windSpeed !== null) {
            current.windSpeed = Math.round(tomorrowObs.windSpeed);
            sources['windSpeed'] = {
                value: current.windSpeed,
                source: 'tomorrow',
                sourceColor: 'sky',
                sourceName: 'Tomorrow.io',
            };
        }
        if (tomorrowObs.windGust !== null) {
            current.windGust = Math.round(tomorrowObs.windGust);
            sources['windGust'] = {
                value: current.windGust,
                source: 'tomorrow',
                sourceColor: 'sky',
                sourceName: 'Tomorrow.io',
            };
        }
        if (tomorrowObs.windDirection !== null) {
            current.windDegree = tomorrowObs.windDirection;
            current.windDirection = degreesToCardinal(tomorrowObs.windDirection);
            sources['windDirection'] = {
                value: current.windDirection,
                source: 'tomorrow',
                sourceColor: 'sky',
                sourceName: 'Tomorrow.io',
            };
        }

        // Pressure
        if (tomorrowObs.pressure !== null) {
            current.pressure = tomorrowObs.pressure;
            sources['pressure'] = {
                value: tomorrowObs.pressure,
                source: 'tomorrow',
                sourceColor: 'sky',
                sourceName: 'Tomorrow.io',
            };
        }

        // Visibility (Tomorrow.io returns km, convert to nm for consistency if needed)
        if (tomorrowObs.visibility !== null) {
            current.visibility = tomorrowObs.visibility;
            sources['visibility'] = {
                value: tomorrowObs.visibility,
                source: 'tomorrow',
                sourceColor: 'sky',
                sourceName: 'Tomorrow.io',
            };
        }

        // Cloud Cover
        if (tomorrowObs.cloudCover !== null) {
            current.cloudCover = tomorrowObs.cloudCover;
            sources['cloudCover'] = {
                value: tomorrowObs.cloudCover,
                source: 'tomorrow',
                sourceColor: 'sky',
                sourceName: 'Tomorrow.io',
            };
        }

        // UV Index
        if (tomorrowObs.uvIndex !== null) {
            current.uvIndex = tomorrowObs.uvIndex;
            sources['uvIndex'] = {
                value: tomorrowObs.uvIndex,
                source: 'tomorrow',
                sourceColor: 'sky',
                sourceName: 'Tomorrow.io',
            };
        }

        // Condition text from Tomorrow.io
        if (tomorrowObs.condition && tomorrowObs.condition !== 'Unknown') {
            current.condition = tomorrowObs.condition;
        }

        // Precipitation intensity
        if (tomorrowObs.precipitationIntensity !== null) {
            current.precipitation = tomorrowObs.precipitationIntensity;
            sources['precipitation'] = {
                value: tomorrowObs.precipitationIntensity,
                source: 'tomorrow',
                sourceColor: 'sky',
                sourceName: 'Tomorrow.io',
            };
        }

        (current as any).sources = sources;
        baseReport = { ...baseReport, current };
    }

    // --- ENRICH WITH OPEN-METEO FORECAST DATA ---
    // If base is StormGlass but we have OpenMeteo, merge forecast/hourly data
    if (stormGlassReport && openMeteoReport && baseReport === stormGlassReport) {
        // StormGlass is the base — but Open-Meteo may have better hourly/daily forecast
        // Keep StormGlass marine forecast (swell, waves) but use OpenMeteo atmospheric forecast
        // The StormGlass report already fetches OpenMeteo hybrid context inline,
        // so hourly data should come through. No additional merge needed here.
    }

    // Update model description for logging
    const sourcesParts: string[] = [];
    if (tomorrowObs && computedLocationType !== 'offshore') sourcesParts.push('tio-live');
    if (stormGlassReport) sourcesParts.push('sg');
    if (openMeteoReport) sourcesParts.push('om');
    baseReport.modelUsed = sourcesParts.join('+') || baseReport.modelUsed;

    // Ensure location metadata is set
    // NOTE: locationType is already set on baseReport via computedLocationType (line 99)
    // Do NOT overwrite it with the raw argument which may be undefined
    baseReport.locationName = name;

    return baseReport;
};


/**
 * Fast Weather: Uses OpenMeteo (Fast)
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

        // RETRY GEOCODING if name is generic (WP ..., cardinal coords, raw digits)
        // This gives us a second chance to find "Townsville" even if the Context sent us coordinate-only name
        if (!name || name === 'Current Location' || name.startsWith('WP ') || /^-?\d/.test(name) || /^\d+\.\d+°[NSEW]/.test(name)) {
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
