
import { MarineWeatherReport, WeatherModel, BuoyStation } from '../../types';
import { parseLocation, reverseGeocode } from './api/geocoding';
import { fetchOpenMeteo } from './api/openmeteo';
import { fetchStormGlassWeather } from './api/stormglass';
import { fetchWeatherKitFull, WeatherKitFullResponse, buildReportFromWeatherKit } from './api/weatherkit';
import { fetchRealTides } from './api/tides';
import { saveToCache, getFromCache } from './cache';
import { degreesToCardinal } from '../../utils';

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

export const fetchWeatherByStrategy = async (
    lat: number,
    lon: number,
    name: string,
    locationType?: 'coastal' | 'offshore' | 'inland'
): Promise<MarineWeatherReport> => {

    const isOffshore = locationType === 'offshore';
    const needsStormGlass = locationType !== 'inland';

    // --- PARALLEL API CALLS (all four simultaneously) ---
    const [wkResult, sgResult, omResult, tideResult] = await Promise.allSettled([
        // 1. WeatherKit: PRIMARY atmospheric source
        fetchWeatherKitFull(lat, lon).catch((e) => {
            console.warn('[Strategy] WeatherKit failed:', e);
            return null;
        }),

        // 2. StormGlass: Marine data (waves, swell, water temp, currents)
        needsStormGlass
            ? fetchStormGlassWeather(lat, lon, name, locationType).catch((e) => {
                console.warn('[Strategy] StormGlass failed, continuing:', e);
                return null;
            })
            : Promise.resolve(null),

        // 3. OpenMeteo: Fallback atmospheric + CAPE for wind field map
        fetchOpenMeteo(lat, lon, name, false, 'best_match').catch((e) => {
            console.warn('[Strategy] OpenMeteo failed:', e);
            return null;
        }),

        // 4. WorldTides: Direct tide fetch (24h cached — always fires)
        fetchRealTides(lat, lon).catch((e) => {
            console.warn('[Strategy] WorldTides failed:', e);
            return null;
        }),
    ]);

    // --- EXTRACT RESULTS ---
    const weatherKitFull = wkResult.status === 'fulfilled' ? wkResult.value : null;
    const stormGlassReport = sgResult.status === 'fulfilled' ? sgResult.value : null;
    const openMeteoReport = omResult.status === 'fulfilled' ? omResult.value : null;
    const tideData = tideResult.status === 'fulfilled' ? tideResult.value : null;

    // --- DIAGNOSTIC LOGGING ---
    console.log(`[Strategy] API Results for "${name}" (type: ${locationType || 'auto'}):`);
    console.log(`  WeatherKit:  ${wkResult.status === 'fulfilled' ? (weatherKitFull ? `✅ obs=${!!weatherKitFull.observation} hourly=${weatherKitFull.hourly?.length || 0} daily=${weatherKitFull.daily?.length || 0}` : '⚠️ null') : '❌ ' + (wkResult as PromiseRejectedResult).reason}`);
    console.log(`  StormGlass:  ${!needsStormGlass ? '⏭️ skipped (inland)' : sgResult.status === 'fulfilled' ? (stormGlassReport ? '✅ OK' : '⚠️ null') : '❌ ' + (sgResult as PromiseRejectedResult).reason}`);
    console.log(`  OpenMeteo:   ${omResult.status === 'fulfilled' ? (openMeteoReport ? '✅ OK' : '⚠️ null') : '❌ ' + (omResult as PromiseRejectedResult).reason}`);

    // --- BUILD BASE REPORT ---
    // Priority: WeatherKit (primary) > StormGlass (offshore fallback) > OpenMeteo (last resort)
    let report: MarineWeatherReport;

    if (weatherKitFull && !isOffshore) {
        // ✅ PRIMARY PATH: Build report directly from WeatherKit
        report = buildReportFromWeatherKit(weatherKitFull, lat, lon, name);
        console.log(`[Strategy] Base: WeatherKit (${weatherKitFull.observation?.condition || 'no obs'})`);
    } else if (stormGlassReport) {
        // Offshore or WeatherKit failed — use StormGlass
        report = stormGlassReport;
        console.log('[Strategy] Base: StormGlass (WeatherKit unavailable or offshore)');
    } else if (openMeteoReport) {
        // Last resort — OpenMeteo only
        report = openMeteoReport;
        console.log('[Strategy] Base: OpenMeteo (all other sources failed)');
    } else {
        throw new Error(`All weather APIs failed for ${name}`);
    }

    // --- DETERMINE LOCATION TYPE ---
    const computedLocationType = stormGlassReport?.locationType || locationType || openMeteoReport?.locationType || 'coastal';
    report.locationType = computedLocationType as 'coastal' | 'offshore' | 'inland';

    // --- ENRICH WITH STORMGLASS MARINE DATA ---
    // WeatherKit doesn't provide wave, swell, water temp, or current data.
    // StormGlass fills these gaps for coastal/offshore.
    if (stormGlassReport && report.modelUsed !== 'stormglass') {
        const sg = stormGlassReport.current;
        const current = { ...report.current };
        const sources = (current as any).sources || {};

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

        (current as any).sources = sources;
        report.current = current;

        // Merge StormGlass marine data into hourly forecasts
        if (stormGlassReport.hourly?.length) {
            const sgHourlyMap = new Map(stormGlassReport.hourly.map(h => [h.time, h]));
            report.hourly = report.hourly.map(h => {
                const sgH = sgHourlyMap.get(h.time);
                if (!sgH) return h;
                return {
                    ...h,
                    waveHeight: sgH.waveHeight ?? h.waveHeight,
                    swellPeriod: sgH.swellPeriod ?? h.swellPeriod,
                    waterTemperature: sgH.waterTemperature ?? h.waterTemperature,
                    currentSpeed: sgH.currentSpeed ?? h.currentSpeed,
                    currentDirection: sgH.currentDirection ?? h.currentDirection,
                };
            });
        }

        // Merge StormGlass marine data into daily forecasts
        if (stormGlassReport.forecast?.length) {
            const sgDailyMap = new Map(stormGlassReport.forecast.map(d => [d.isoDate || d.date, d]));
            report.forecast = report.forecast.map(d => {
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
        const sorted = [...tideData.tides].sort((a, b) =>
            new Date(a.time).getTime() - new Date(b.time).getTime()
        );
        const interpolated: { time: string; height: number }[] = [];
        for (let i = 0; i < sorted.length - 1; i++) {
            const tStart = new Date(sorted[i].time).getTime();
            const tEnd = new Date(sorted[i + 1].time).getTime();
            const hStart = sorted[i].height;
            const hEnd = sorted[i + 1].height;
            for (let t = tStart; t < tEnd; t += 30 * 60 * 1000) {
                const ratio = (t - tStart) / (tEnd - tStart);
                const height = (hStart + hEnd) / 2 + (hStart - hEnd) / 2 * Math.cos(ratio * Math.PI);
                interpolated.push({ time: new Date(t).toISOString(), height });
            }
        }
        if (interpolated.length > 0) {
            report.tideHourly = interpolated.map(p => ({ time: p.time, height: p.height }));
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
        const data = await Promise.race([
            fetchOpenMeteo(lat, lon, name, true, model),
            timeoutPromise
        ]);
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
    coords?: { lat: number, lon: number },
    forceRefresh = false,
    existingLocationType?: 'coastal' | 'offshore' | 'inland'
): Promise<MarineWeatherReport> => {

    let lat: number, lon: number, name: string;

    if (coords) {
        lat = coords.lat;
        lon = coords.lon;
        name = location;

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
