
import { MarineWeatherReport, WeatherModel, BuoyStation } from '../../types';
import { parseLocation, reverseGeocode } from './api/geocoding';
import { fetchOpenMeteo } from './api/openmeteo';
import { fetchStormGlassWeather } from './api/stormglass';
import { fetchWeatherKitFull, WeatherKitFullResponse } from './api/weatherkit';
import { saveToCache, getFromCache } from './cache';
import { degreesToCardinal } from '../../utils';

// ── Condition Severity Ranking ────────────────────────────────
// Used to pick the "worst" condition between observation and hourly forecast.
// Higher number = more severe weather. When the observation says "Partly Cloudy"
// but the hourly forecast says "Rain", we show "Rain" because it's more likely
// to be what the user is actually experiencing.
const CONDITION_SEVERITY: Record<string, number> = {
    'Clear': 0, 'Mostly Clear': 1, 'Partly Cloudy': 2,
    'Mostly Cloudy': 3, 'Cloudy': 4, 'Overcast': 4,
    'Haze': 5, 'Fog': 6, 'Breezy': 6, 'Windy': 7,
    'Drizzle': 8, 'Light Rain': 9, 'Rain': 10, 'Showers': 10,
    'Heavy Rain': 11, 'Freezing Drizzle': 11, 'Freezing Rain': 12,
    'Sleet': 12, 'Snow': 12, 'Heavy Snow': 13, 'Blizzard': 14,
    'Thunderstorm': 15, 'Isolated Thunderstorms': 14, 'Scattered Thunderstorms': 15,
    'Severe Storms': 16, 'Tropical Storm': 17, 'Hurricane': 18,
};

function pickWorstCondition(a: string, b: string): string {
    const sevA = CONDITION_SEVERITY[a] ?? 2;
    const sevB = CONDITION_SEVERITY[b] ?? 2;
    return sevB > sevA ? b : a;
}

// --- RE-EXPORTS (Maintain API Compatibility) ---
export { MAJOR_BUOYS } from './config';
export { getApiKeySuffix, isStormglassKeyPresent, debugStormglassConnection, checkStormglassStatus } from './keys';
export { reverseGeocode, parseLocation } from './api/geocoding';
export { fetchOpenMeteo } from './api/openmeteo';
export { fetchActiveBuoys } from './api/buoys';
export { fetchWeatherKitRealtime, fetchWeatherKitFull, fetchMinutelyRain } from './api/weatherkit';

// Alias for compatibility
export const fetchStormglassData = fetchStormGlassWeather;

// --- MAIN ORCHESTRATORS ---

/**
 * 3-Tier Weather Data Architecture
 * 
 * Routes API calls based on distance to shore:
 * | Tier | Distance  | Atmospheric       | Marine/Ocean       |
 * |------|-----------|-------------------|--------------------|
 * | 1    | Any       | Open-Meteo → WebGL| (separate flow)    |
 * | 2    | ≤ 20nm    | Apple WeatherKit  | StormGlass (waves) |
 * | 3    | > 20nm    | StormGlass 100%   | StormGlass 100%    |
 * 
 * All API calls fired in parallel via Promise.allSettled for speed.
 */
export const fetchWeatherByStrategy = async (
    lat: number,
    lon: number,
    name: string,
    locationType?: 'coastal' | 'offshore' | 'inland'
): Promise<MarineWeatherReport> => {

    const isOffshore = locationType === 'offshore';
    const needsWeatherKit = !isOffshore; // Tier 2: WeatherKit for coastal/inland
    const needsStormGlass = locationType !== 'inland';

    // --- PARALLEL API CALLS ---
    const promises: [
        Promise<MarineWeatherReport>,                       // Open-Meteo (always — forecast backbone)
        Promise<MarineWeatherReport | null>,                 // StormGlass (coastal/offshore)
        Promise<WeatherKitFullResponse | null>,             // WeatherKit full (Tier 2: coastal/inland)
    ] = [
            // 1. Open-Meteo: Atmospheric forecast backbone (all locations)
            fetchOpenMeteo(lat, lon, name, false, 'best_match'),

            // 2. StormGlass: Marine forecast + offshore live (coastal/offshore only)
            needsStormGlass
                ? fetchStormGlassWeather(lat, lon, name, locationType).catch((e) => {
                    console.warn('[Strategy] StormGlass failed, continuing with other sources:', e);
                    return null;
                })
                : Promise.resolve(null),

            // 3. WeatherKit: Full atmospheric payload (Tier 2: coastal/inland)
            //    Requests: currentWeather + forecastHourly + forecastDaily + forecastNextHour
            needsWeatherKit
                ? fetchWeatherKitFull(lat, lon).catch((e) => {
                    console.warn('[Strategy] WeatherKit failed:', e);
                    return null;
                })
                : Promise.resolve(null),
        ];

    const [omResult, sgResult, wkResult] = await Promise.allSettled(promises);

    // --- EXTRACT RESULTS ---
    const openMeteoReport = omResult.status === 'fulfilled' ? omResult.value : null;
    const stormGlassReport = sgResult.status === 'fulfilled' ? sgResult.value : null;
    const weatherKitFull = wkResult.status === 'fulfilled' ? wkResult.value : null;
    const weatherKitObs = weatherKitFull?.observation ?? null;

    // --- DIAGNOSTIC LOGGING ---
    console.log(`[Strategy] API Results for "${name}" (type: ${locationType || 'auto'}):`);
    console.log(`  OpenMeteo:   ${omResult.status === 'fulfilled' ? (openMeteoReport ? '✅ OK' : '⚠️ null') : '❌ ' + (omResult as PromiseRejectedResult).reason}`);
    console.log(`  StormGlass:  ${!needsStormGlass ? '⏭️ skipped' : sgResult.status === 'fulfilled' ? (stormGlassReport ? '✅ OK' : '⚠️ null') : '❌ ' + (sgResult as PromiseRejectedResult).reason}`);
    console.log(`  WeatherKit:  ${!needsWeatherKit ? '⏭️ skipped (offshore)' : wkResult.status === 'fulfilled' ? (weatherKitFull ? `✅ obs=${!!weatherKitObs} hourly=${weatherKitFull.hourly?.length || 0} daily=${weatherKitFull.daily?.length || 0}` : '⚠️ returned null (edge function failed?)') : '❌ ' + (wkResult as PromiseRejectedResult).reason}`);

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

    // --- MERGE WEATHERKIT LIVE DATA (Tier 2) ---
    // WeatherKit provides premium station-blended observations — more accurate than model data
    // for temperature, wind, humidity, pressure, conditions.
    // IMPORTANT: Skip for offshore (Tier 3) — WeatherKit has no ocean station data.
    if (weatherKitObs && baseReport && computedLocationType !== 'offshore') {
        const current = { ...baseReport.current };
        const sources = (current as any).sources || {};

        // Temperature: WeatherKit observed > StormGlass modelled
        if (weatherKitObs.temperature !== null) {
            current.airTemperature = weatherKitObs.temperature;
            sources['airTemperature'] = {
                value: weatherKitObs.temperature,
                source: 'weatherkit',
                sourceColor: 'emerald',
                sourceName: 'Apple Weather',
            };
        }

        // Feels-like temperature
        if (weatherKitObs.temperatureApparent !== null) {
            current.feelsLike = weatherKitObs.temperatureApparent;
            sources['feelsLike'] = {
                value: weatherKitObs.temperatureApparent,
                source: 'weatherkit',
                sourceColor: 'emerald',
                sourceName: 'Apple Weather',
            };
        }

        // Humidity
        if (weatherKitObs.humidity !== null) {
            current.humidity = weatherKitObs.humidity;
            sources['humidity'] = {
                value: weatherKitObs.humidity,
                source: 'weatherkit',
                sourceColor: 'emerald',
                sourceName: 'Apple Weather',
            };
        }

        // Dew Point
        if (weatherKitObs.dewPoint !== null) {
            current.dewPoint = weatherKitObs.dewPoint;
            sources['dewPoint'] = {
                value: weatherKitObs.dewPoint,
                source: 'weatherkit',
                sourceColor: 'emerald',
                sourceName: 'Apple Weather',
            };
        }

        // Wind: WeatherKit observed > StormGlass modelled
        if (weatherKitObs.windSpeed !== null) {
            current.windSpeed = Math.round(weatherKitObs.windSpeed);
            sources['windSpeed'] = {
                value: current.windSpeed,
                source: 'weatherkit',
                sourceColor: 'emerald',
                sourceName: 'Apple Weather',
            };
        }
        if (weatherKitObs.windGust !== null) {
            current.windGust = Math.round(weatherKitObs.windGust);
            sources['windGust'] = {
                value: current.windGust,
                source: 'weatherkit',
                sourceColor: 'emerald',
                sourceName: 'Apple Weather',
            };
        }
        if (weatherKitObs.windDirection !== null) {
            current.windDegree = weatherKitObs.windDirection;
            current.windDirection = degreesToCardinal(weatherKitObs.windDirection);
            sources['windDirection'] = {
                value: current.windDirection,
                source: 'weatherkit',
                sourceColor: 'emerald',
                sourceName: 'Apple Weather',
            };
        }

        // Pressure
        if (weatherKitObs.pressure !== null) {
            current.pressure = weatherKitObs.pressure;
            sources['pressure'] = {
                value: weatherKitObs.pressure,
                source: 'weatherkit',
                sourceColor: 'emerald',
                sourceName: 'Apple Weather',
            };
        }

        // Visibility
        if (weatherKitObs.visibility !== null) {
            current.visibility = weatherKitObs.visibility;
            sources['visibility'] = {
                value: weatherKitObs.visibility,
                source: 'weatherkit',
                sourceColor: 'emerald',
                sourceName: 'Apple Weather',
            };
        }

        // Cloud Cover
        if (weatherKitObs.cloudCover !== null) {
            current.cloudCover = weatherKitObs.cloudCover;
            sources['cloudCover'] = {
                value: weatherKitObs.cloudCover,
                source: 'weatherkit',
                sourceColor: 'emerald',
                sourceName: 'Apple Weather',
            };
        }

        // UV Index
        if (weatherKitObs.uvIndex !== null) {
            current.uvIndex = weatherKitObs.uvIndex;
            sources['uvIndex'] = {
                value: weatherKitObs.uvIndex,
                source: 'weatherkit',
                sourceColor: 'emerald',
                sourceName: 'Apple Weather',
            };
        }

        // Condition text from WeatherKit
        // Strategy: Use the "worst" condition between obs and hourly forecast for the current hour.
        // WeatherKit's currentWeather observation can lag reality by 5-15 min,
        // but the hourly forecast for the current hour often correctly identifies precipitation.
        if (weatherKitObs.condition && weatherKitObs.condition !== 'Unknown') {
            let bestCondition = weatherKitObs.condition;

            // Cross-reference with WeatherKit hourly forecast for current hour
            if (weatherKitFull?.hourly?.length) {
                const now = new Date();
                const currentHourStr = now.toISOString().slice(0, 13); // "2026-02-25T05"
                const currentHourly = weatherKitFull.hourly.find(h =>
                    h.time && h.time.startsWith(currentHourStr)
                );
                if (currentHourly?.condition) {
                    // Use whichever condition is "worse" (rain > cloudy > clear)
                    bestCondition = pickWorstCondition(bestCondition, currentHourly.condition);
                }
            }

            current.condition = bestCondition;
            // Regenerate description from updated condition so the whole card is consistent
            current.description = `${bestCondition}. Wind ${current.windSpeed ?? '--'} kts ${current.windDirection || ''}`;
        }

        // Precipitation intensity
        if (weatherKitObs.precipitationIntensity !== null) {
            current.precipitation = weatherKitObs.precipitationIntensity;
            sources['precipitation'] = {
                value: weatherKitObs.precipitationIntensity,
                source: 'weatherkit',
                sourceColor: 'emerald',
                sourceName: 'Apple Weather',
            };
        }

        (current as any).sources = sources;
        baseReport = { ...baseReport, current };
    }

    // --- ENRICH WITH WEATHERKIT FORECAST DATA (Tier 2) ---
    // For coastal/inland, WeatherKit provides the 10-day atmospheric outlook.
    // Merge WeatherKit hourly/daily over the base, preserving StormGlass marine fields.
    if (weatherKitFull && baseReport && computedLocationType !== 'offshore') {
        // Hourly: Overlay WeatherKit atmospheric data, keeping StormGlass wave/swell columns
        if (weatherKitFull.hourly.length > 0) {
            const wkHourlyMap = new Map(weatherKitFull.hourly.map(h => [h.time, h]));
            baseReport.hourly = baseReport.hourly.map(baseH => {
                const wkH = wkHourlyMap.get(baseH.time);
                if (!wkH) return baseH;
                return {
                    ...baseH,
                    // Atmospheric from WeatherKit (more accurate)
                    temperature: wkH.temperature,
                    condition: wkH.condition,
                    windSpeed: wkH.windSpeed,
                    windGust: wkH.windGust ?? baseH.windGust,
                    windDirection: wkH.windDirection ?? baseH.windDirection,
                    windDegree: wkH.windDegree ?? baseH.windDegree,
                    feelsLike: wkH.feelsLike ?? baseH.feelsLike,
                    precipitation: wkH.precipitation ?? baseH.precipitation,
                    cloudCover: wkH.cloudCover ?? baseH.cloudCover,
                    uvIndex: wkH.uvIndex ?? baseH.uvIndex,
                    pressure: wkH.pressure ?? baseH.pressure,
                    humidity: wkH.humidity ?? baseH.humidity,
                    visibility: wkH.visibility ?? baseH.visibility,
                    dewPoint: wkH.dewPoint ?? baseH.dewPoint,
                    // Marine from StormGlass (preserved — WeatherKit doesn't provide waves)
                    waveHeight: baseH.waveHeight,
                    swellPeriod: baseH.swellPeriod,
                    waterTemperature: baseH.waterTemperature,
                    currentSpeed: baseH.currentSpeed,
                    currentDirection: baseH.currentDirection,
                };
            });

            // If WeatherKit has MORE hours than base, append them
            if (weatherKitFull.hourly.length > baseReport.hourly.length) {
                const baseTimeSet = new Set(baseReport.hourly.map(h => h.time));
                const extra = weatherKitFull.hourly.filter(h => !baseTimeSet.has(h.time));
                baseReport.hourly.push(...extra);
            }
        }

        // Daily: Overlay WeatherKit atmospheric data, keeping StormGlass wave data
        if (weatherKitFull.daily.length > 0) {
            const wkDailyMap = new Map(weatherKitFull.daily.map(d => [d.isoDate || d.date, d]));
            baseReport.forecast = baseReport.forecast.map(baseD => {
                const wkD = wkDailyMap.get(baseD.isoDate || baseD.date);
                if (!wkD) return baseD;
                return {
                    ...baseD,
                    // Atmospheric from WeatherKit
                    highTemp: wkD.highTemp,
                    lowTemp: wkD.lowTemp,
                    condition: wkD.condition,
                    windSpeed: wkD.windSpeed,
                    windGust: wkD.windGust ?? baseD.windGust,
                    precipitation: wkD.precipitation ?? baseD.precipitation,
                    cloudCover: wkD.cloudCover ?? baseD.cloudCover,
                    uvIndex: wkD.uvIndex ?? baseD.uvIndex,
                    sunrise: wkD.sunrise ?? baseD.sunrise,
                    sunset: wkD.sunset ?? baseD.sunset,
                    humidity: wkD.humidity ?? baseD.humidity,
                    // Marine from StormGlass (preserved)
                    waveHeight: baseD.waveHeight,
                    swellPeriod: baseD.swellPeriod,
                    waterTemperature: baseD.waterTemperature,
                    currentSpeed: baseD.currentSpeed,
                    currentDirection: baseD.currentDirection,
                };
            });

            // If WeatherKit has MORE days than base, append them
            if (weatherKitFull.daily.length > baseReport.forecast.length) {
                const baseDateSet = new Set(baseReport.forecast.map(d => d.isoDate || d.date));
                const extra = weatherKitFull.daily.filter(d => !baseDateSet.has(d.isoDate || d.date));
                baseReport.forecast.push(...extra);
            }
        }
    }

    // Update model description for logging
    const sourcesParts: string[] = [];
    if (weatherKitObs && computedLocationType !== 'offshore') sourcesParts.push('wk-live');
    if (weatherKitFull?.hourly?.length) sourcesParts.push('wk-fcst');
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
