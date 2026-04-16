import { MarineWeatherReport, WeatherModel } from '../../types';
import { parseLocation, reverseGeocode } from './api/geocoding';
import { fetchOpenMeteo } from './api/openmeteo';
import { fetchStormGlassWeather } from './api/stormglass';
import { fetchWeatherKitFull, buildReportFromWeatherKit } from './api/weatherkit';
import { fetchRealTides } from './api/tides';
import { saveToCache, getFromCache, getFromCacheOffline } from './cache';

import { createLogger } from '../../utils/createLogger';

const log = createLogger('index');

// --- RE-EXPORTS (Maintain API Compatibility) ---
export { MAJOR_BUOYS } from './config';
export { getApiKeySuffix, isStormglassKeyPresent, debugStormglassConnection, checkStormglassStatus } from './keys';
export { reverseGeocode, parseLocation } from './api/geocoding';
export { fetchOpenMeteo } from './api/openmeteo';
export { fetchActiveBuoys } from './api/buoys';
export { fetchWeatherKitRealtime, fetchWeatherKitFull, fetchMinutelyRain } from './api/weatherkit';

// Alias for compatibility
export const fetchStormglassData = fetchStormGlassWeather;

// ═══════════════════════════════════════════════════════════════
// MAIN ORCHESTRATOR — WeatherKit-Primary Architecture
// ═══════════════════════════════════════════════════════════════
//
// WeatherKit is THE source of truth for atmospheric data.
// StormGlass fills marine gaps. OpenMeteo is fallback only.
//
// | Source      | Role                                   | Data                              |
// |-------------|----------------------------------------|-----------------------------------|
// | WeatherKit  | PRIMARY — all atmospheric              | current, hourly, daily, rain      |
// | StormGlass  | MARINE ENRICHMENT                      | waves, swell, water temp, current |
// | OpenMeteo   | FALLBACK (if WeatherKit fails) + CAPE  | full atmospheric + CAPE for map   |
//
// All API calls fire in parallel via Promise.allSettled. No serial dependencies.
// ═══════════════════════════════════════════════════════════════

// ── Request Dedup ──
// If an identical fetch is already in-flight, piggyback on its Promise
// instead of firing 4 more concurrent API calls.
// Key granularity: ~1km (2 decimal places of lat/lon).
const _inflight = new Map<string, Promise<MarineWeatherReport>>();

export const fetchWeatherByStrategy = async (
    lat: number,
    lon: number,
    name: string,
    locationType?: 'inshore' | 'coastal' | 'offshore' | 'inland',
): Promise<MarineWeatherReport> => {
    const dedupKey = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const existing = _inflight.get(dedupKey);
    if (existing) return existing;

    const promise = _fetchWeatherByStrategyImpl(lat, lon, name, locationType);
    _inflight.set(dedupKey, promise);
    promise.finally(() => _inflight.delete(dedupKey));
    return promise;
};

const _fetchWeatherByStrategyImpl = async (
    lat: number,
    lon: number,
    name: string,
    locationType?: 'inshore' | 'coastal' | 'offshore' | 'inland',
): Promise<MarineWeatherReport> => {
    const isOffshore = locationType === 'offshore';
    const needsStormGlass = locationType !== 'inland';

    // --- PARALLEL API CALLS (all four simultaneously) ---
    const [wkResult, sgResult, omResult, tideResult] = await Promise.allSettled([
        // 1. WeatherKit: PRIMARY atmospheric source
        fetchWeatherKitFull(lat, lon).catch((e) => {
            log.warn('WeatherKit failed:', e?.message || e);
            return null;
        }),

        // 2. StormGlass: Marine data (waves, swell, water temp, currents)
        needsStormGlass
            ? fetchStormGlassWeather(lat, lon, name, locationType).catch((e) => {
                  log.warn('StormGlass failed:', e?.message || e);
                  return null;
              })
            : Promise.resolve(null),

        // 3. OpenMeteo: Fallback atmospheric + CAPE for wind field map
        fetchOpenMeteo(lat, lon, name, false, 'best_match').catch((e) => {
            log.warn('OpenMeteo failed:', e?.message || e);
            return null;
        }),

        // 4. WorldTides: Direct tide fetch (24h cached — always fires)
        fetchRealTides(lat, lon).catch((e) => {
            log.warn('Tides failed:', e?.message || e);
            return null;
        }),
    ]);

    // --- EXTRACT RESULTS ---
    const weatherKitFull = wkResult.status === 'fulfilled' ? wkResult.value : null;
    const stormGlassReport = sgResult.status === 'fulfilled' ? sgResult.value : null;
    const openMeteoReport = omResult.status === 'fulfilled' ? omResult.value : null;
    const tideData = tideResult.status === 'fulfilled' ? tideResult.value : null;

    // --- DIAGNOSTIC LOGGING ---

    // --- BUILD BASE REPORT ---
    // WeatherKit is base for ALL locations (model-based forecasts work globally).
    // For offshore, StormGlass overrides the current observation (marine-tuned GFS).
    let report: MarineWeatherReport;

    if (weatherKitFull) {
        // ✅ PRIMARY PATH: Build report from WeatherKit (works globally)
        report = buildReportFromWeatherKit(weatherKitFull, lat, lon, name);

        // OFFSHORE BLEND: WeatherKit's currentWeather observation is unreliable at sea
        // (sparse station data). Override current atmospheric fields with StormGlass.
        // WeatherKit hourly/daily forecasts are model-based and remain valid.
        if (isOffshore && stormGlassReport) {
            const sg = stormGlassReport.current;
            const current = { ...report.current };
            // StormGlass atmospheric override for current observation only
            if (sg.airTemperature != null) current.airTemperature = sg.airTemperature;
            if (sg.feelsLike != null) current.feelsLike = sg.feelsLike;
            if (sg.windSpeed != null) current.windSpeed = sg.windSpeed;
            if (sg.windGust != null) current.windGust = sg.windGust;
            if (sg.windDirection) current.windDirection = sg.windDirection;
            if (sg.windDegree != null) current.windDegree = sg.windDegree;
            if (sg.pressure != null) current.pressure = sg.pressure;
            if (sg.humidity != null) current.humidity = sg.humidity;
            if (sg.cloudCover != null) current.cloudCover = sg.cloudCover;
            if (sg.visibility != null) current.visibility = sg.visibility;
            if (sg.condition) current.condition = sg.condition;
            if (sg.description) current.description = sg.description;
            report.current = current;
        }
    } else if (stormGlassReport) {
        // WeatherKit failed — use StormGlass as full fallback
        report = stormGlassReport;
    } else if (openMeteoReport) {
        // Last resort — OpenMeteo only
        report = openMeteoReport;
    } else {
        // All APIs failed — try offline cache as last resort
        const offlineResult = getFromCacheOffline(name);
        if (offlineResult) {
            const staleReport = offlineResult.data;
            staleReport._stale = true;
            staleReport._staleAgeMinutes = offlineResult.ageMinutes;
            return staleReport;
        }
        throw new Error(`All weather APIs failed for ${name}`);
    }

    // --- DETERMINE LOCATION TYPE ---
    const computedLocationType =
        stormGlassReport?.locationType || locationType || openMeteoReport?.locationType || 'coastal';
    report.locationType = computedLocationType as 'inshore' | 'coastal' | 'offshore' | 'inland';

    // --- ENRICH WITH STORMGLASS MARINE DATA ---
    // WeatherKit doesn't provide wave, swell, water temp, or current data.
    // StormGlass fills these gaps for coastal/offshore.
    if (stormGlassReport && report.modelUsed !== 'stormglass') {
        const sg = stormGlassReport.current;
        const current = { ...report.current };
        const sources = current.sources || {};

        const sgSource = (val: number | string | null) => ({
            value: val,
            source: 'stormglass' as const,
            sourceColor: 'sky' as const,
            sourceName: 'StormGlass',
        });

        // Marine fields from StormGlass
        if (sg.waveHeight != null) {
            current.waveHeight = sg.waveHeight;
            sources['waveHeight'] = sgSource(sg.waveHeight);
        }
        if (sg.swellPeriod != null) {
            current.swellPeriod = sg.swellPeriod;
            sources['swellPeriod'] = sgSource(sg.swellPeriod);
        }
        if (sg.swellDirection != null) {
            current.swellDirection = sg.swellDirection;
        }
        if (sg.waterTemperature != null) {
            current.waterTemperature = sg.waterTemperature;
            sources['waterTemperature'] = sgSource(sg.waterTemperature);
        }
        if (sg.currentSpeed != null) {
            current.currentSpeed = sg.currentSpeed;
            sources['currentSpeed'] = sgSource(sg.currentSpeed);
        }
        if (sg.currentDirection != null) {
            current.currentDirection = sg.currentDirection;
        }
        // Secondary swell (offshore-only marine data)
        if (sg.secondarySwellHeight != null) {
            current.secondarySwellHeight = sg.secondarySwellHeight;
        }
        if (sg.secondarySwellPeriod != null) {
            current.secondarySwellPeriod = sg.secondarySwellPeriod;
        }

        current.sources = sources;
        report.current = current;

        // Merge StormGlass marine data into hourly forecasts
        // FIX: WeatherKit uses "2024-03-10T17:00:00Z" but StormGlass uses "2024-03-10T17:00:00.000Z"
        // Exact string match fails — normalize to epoch-hour for robust matching
        if (stormGlassReport.hourly?.length) {
            const toHourKey = (t: string) => Math.floor(new Date(t).getTime() / 3600000);
            const sgHourlyMap = new Map(stormGlassReport.hourly.map((h) => [toHourKey(h.time), h]));
            report.hourly = report.hourly.map((h) => {
                const sgH = sgHourlyMap.get(toHourKey(h.time));
                if (!sgH) return h;
                return {
                    ...h,
                    waveHeight: sgH.waveHeight ?? h.waveHeight,
                    swellPeriod: sgH.swellPeriod ?? h.swellPeriod,
                    waterTemperature: sgH.waterTemperature ?? h.waterTemperature,
                    currentSpeed: sgH.currentSpeed ?? h.currentSpeed,
                    currentDirection: sgH.currentDirection ?? h.currentDirection,

                    secondarySwellHeight: sgH.secondarySwellHeight ?? h.secondarySwellHeight,

                    secondarySwellPeriod: sgH.secondarySwellPeriod ?? h.secondarySwellPeriod,

                    cape: sgH.cape ?? h.cape,
                };
            });
        }

        // Merge StormGlass marine data into daily forecasts
        if (stormGlassReport.forecast?.length) {
            const sgDailyMap = new Map(stormGlassReport.forecast.map((d) => [d.isoDate || d.date, d]));
            report.forecast = report.forecast.map((d) => {
                const sgD = sgDailyMap.get(d.isoDate || d.date);
                if (!sgD) return d;
                return {
                    ...d,
                    waveHeight: sgD.waveHeight ?? d.waveHeight,
                    swellPeriod: sgD.swellPeriod ?? d.swellPeriod,
                    waterTemperature: sgD.waterTemperature ?? d.waterTemperature,
                    currentSpeed: sgD.currentSpeed ?? d.currentSpeed,
                    currentDirection: sgD.currentDirection ?? d.currentDirection,
                };
            });
        }

        // Inherit tides from StormGlass
        if (stormGlassReport.tides?.length) report.tides = stormGlassReport.tides;
        if (stormGlassReport.tideHourly?.length) report.tideHourly = stormGlassReport.tideHourly;
        if (stormGlassReport.tideGUIDetails) report.tideGUIDetails = stormGlassReport.tideGUIDetails;

        // Inherit location metadata from StormGlass (it does the coastline distance check)
        if (stormGlassReport.distToLandKm != null) report.distToLandKm = stormGlassReport.distToLandKm;
        if (stormGlassReport.isLandlocked != null) report.isLandlocked = stormGlassReport.isLandlocked;
    }

    // --- APPLY TIDES (WorldTides — direct, first-class) ---
    // Tides are fetched directly from WorldTides API, not as a side effect
    // of StormGlass or OpenMeteo. 24h cached — harmonic predictions are deterministic.
    if (tideData?.tides?.length) {
        report.tides = tideData.tides;
        if (tideData.guiDetails) report.tideGUIDetails = tideData.guiDetails;

        // Generate dense hourly tide data for the graph (cosine interpolation)
        const sorted = [...tideData.tides].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
        const interpolated: { time: string; height: number }[] = [];
        for (let i = 0; i < sorted.length - 1; i++) {
            const tStart = new Date(sorted[i].time).getTime();
            const tEnd = new Date(sorted[i + 1].time).getTime();
            const hStart = sorted[i].height;
            const hEnd = sorted[i + 1].height;
            for (let t = tStart; t < tEnd; t += 30 * 60 * 1000) {
                const ratio = (t - tStart) / (tEnd - tStart);
                const height = (hStart + hEnd) / 2 + ((hStart - hEnd) / 2) * Math.cos(ratio * Math.PI);
                interpolated.push({ time: new Date(t).toISOString(), height });
            }
        }
        if (interpolated.length > 0) {
            report.tideHourly = interpolated.map((p) => ({ time: p.time, height: p.height }));
        }
    } else if (stormGlassReport?.tides?.length) {
        // Fallback: StormGlass may have tides if WorldTides failed
        report.tides = stormGlassReport.tides;
        if (stormGlassReport.tideHourly?.length) report.tideHourly = stormGlassReport.tideHourly;
        if (stormGlassReport.tideGUIDetails) report.tideGUIDetails = stormGlassReport.tideGUIDetails;
    }

    // --- INHERIT LOCATION METADATA FROM OPENMETEO (if StormGlass didn't provide) ---
    if (report.distToLandKm == null && openMeteoReport?.distToLandKm != null) {
        report.distToLandKm = openMeteoReport.distToLandKm;
    }
    if (report.isLandlocked == null && openMeteoReport?.isLandlocked != null) {
        report.isLandlocked = openMeteoReport.isLandlocked;
    }

    // --- ENRICH WITH OPENMETEO CAPE (for wind field map) ---
    if (openMeteoReport?.current?.cape != null) {
        const current = { ...report.current };
        current.cape = openMeteoReport.current.cape;
        report.current = current;
    }

    // --- INHERIT TIMEZONE ---
    if (!report.timeZone) {
        report.timeZone = openMeteoReport?.timeZone || stormGlassReport?.timeZone;
    }
    if (report.utcOffset === undefined) {
        report.utcOffset = openMeteoReport?.utcOffset ?? stormGlassReport?.utcOffset;
    }

    // --- MODEL TAG ---
    const sourcesParts: string[] = [];
    if (weatherKitFull?.observation) sourcesParts.push('wk');
    if (stormGlassReport) sourcesParts.push('sg');
    if (openMeteoReport) sourcesParts.push('om');
    report.modelUsed = sourcesParts.join('+') || report.modelUsed;

    report.locationName = name;
    saveToCache(name, report);
    return report;
};

// ═══════════════════════════════════════════════════════════════
// LEGACY CONVENIENCE FUNCTIONS
// Used by RoutePlanner + VoyageForm (non-dashboard contexts)
// ═══════════════════════════════════════════════════════════════

/**
 * Fast Weather: Uses OpenMeteo only (no edge function latency).
 * Used by RoutePlanner and VoyageForm for quick departure/waypoint data.
 * NOT used for the main dashboard (dashboard uses fetchWeatherByStrategy).
 */
export const fetchFastWeather = async (
    location: string,
    coords?: { lat: number; lon: number },
    model: WeatherModel = 'best_match',
): Promise<MarineWeatherReport> => {
    // 1. Resolve Location
    let lat: number, lon: number, name: string;

    if (coords) {
        lat = coords.lat;
        lon = coords.lon;
        name = location;

        // Auto-resolve name if generic
        if (!name || name === 'Current Location' || name.includes('Lat:')) {
            try {
                const resolved = await reverseGeocode(lat, lon);
                if (resolved) name = resolved;
                else {
                    const latStr = Math.abs(lat).toFixed(2) + (lat >= 0 ? 'N' : 'S');
                    const lonStr = Math.abs(lon).toFixed(2) + (lon >= 0 ? 'E' : 'W');
                    name = `Ocean Point ${latStr} ${lonStr}`;
                }
            } catch (e) {
                log.warn('[index]', e);
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
        setTimeout(() => reject(new Error('Fast Fetch Timeout')), 15000),
    );

    try {
        const data = await Promise.race([fetchOpenMeteo(lat, lon, name, true, model), timeoutPromise]);
        saveToCache(name, data);
        return data;
    } catch (e: unknown) {
        throw e;
    }
};

/**
 * Precision Weather: Uses StormGlass (Paid/Accurate).
 * Kept as fallback path for the WeatherContext error handler.
 */
export const fetchPrecisionWeather = async (
    location: string,
    coords?: { lat: number; lon: number },
    forceRefresh = false,
    existingLocationType?: 'inshore' | 'coastal' | 'offshore' | 'inland',
): Promise<MarineWeatherReport> => {
    let lat: number, lon: number, name: string;

    if (coords) {
        lat = coords.lat;
        lon = coords.lon;
        name = location;

        if (
            !name ||
            name === 'Current Location' ||
            name.startsWith('WP ') ||
            /^-?\d/.test(name) ||
            /^\d+\.\d+°[NSEW]/.test(name)
        ) {
            const r = await reverseGeocode(lat, lon);
            if (r) name = r;
        }
    } else {
        const p = await parseLocation(location);
        lat = p.lat;
        lon = p.lon;
        name = p.name;
    }

    if (!forceRefresh) {
        const cached = getFromCache(name);
        if (cached && cached.modelUsed.includes('sg') && cached.utcOffset !== undefined) {
            return cached;
        }
    }

    try {
        const data = await fetchStormGlassWeather(lat, lon, name, existingLocationType);
        saveToCache(name, data);
        return data;
    } catch (e) {
        throw e;
    }
};
