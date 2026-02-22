import { MarineWeatherReport, StormGlassHour, StormGlassTideData, BeaconObservation } from '../../../types';
import { getApiKey, checkStormglassStatus, getOpenMeteoKey } from '../keys';
import { fetchSG } from './base';
import { fetchRealTides } from './tides';

import { mapStormGlassToReport, AstroEntry } from '../transformers';
import { calculateDistance } from '../../../utils/math'; // Added
import { determineLocationType } from '../locationType'; // Added
import { mergeWeatherData } from './dataSourceMerger'; // Added for source tracking
import { findAndFetchNearestBeacon } from './beaconService'; // Added for buoy data

const fetchAstronomy = async (lat: number, lon: number, days: number, apiKey: string): Promise<AstroEntry[]> => {
    const end = new Date();
    end.setDate(end.getDate() + days);
    return fetchSG<{ data: AstroEntry[] }>('astronomy/point', {
        lat, lng: lon, end: end.toISOString()
    }, apiKey).then(r => r.data).catch(() => []);
};

// FIX: Generate dense hourly tide data from High/Low extremes using Cosine Interpolation.
// This restores the Tide Graph without needing the expensive SeaLevel API.
const interpolateTides = (tides: { time: string; height: number }[]): { time: string; sg: number }[] => {
    if (!tides || tides.length < 2) return [];

    const sorted = [...tides].sort((a, b) => new Date(a.time).getTime() - new Date(b.time).getTime());
    const interpolated: { time: string; sg: number }[] = [];

    for (let i = 0; i < sorted.length - 1; i++) {
        const start = sorted[i];
        const end = sorted[i + 1];

        const tStart = new Date(start.time).getTime();
        const tEnd = new Date(end.time).getTime();
        const hStart = start.height;
        const hEnd = end.height;

        // Step every 30 mins
        for (let t = tStart; t < tEnd; t += 30 * 60 * 1000) {
            // Ratio (0 to 1)
            const ratio = (t - tStart) / (tEnd - tStart);

            // Cosine Interpolation: y(t) = mu2 + (y1 - y2)/2 * cos(pi*t) ? 
            // Formula: y = (y1 + y2)/2 + (y1 - y2)/2 * cos(x * pi)
            // At x=0 (start), cos=1 => (y1+y2+y1-y2)/2 = y1. 
            // At x=1 (end), cos=-1 => (y1+y2-y1+y2)/2 = y2. Correct.
            const height = (hStart + hEnd) / 2 + (hStart - hEnd) / 2 * Math.cos(ratio * Math.PI);

            interpolated.push({
                time: new Date(t).toISOString(),
                sg: height // Use 'sg' field as carrier for 'height' in meters
            });
        }
    }
    return interpolated;
};

export const fetchStormGlassWeather = async (
    lat: number,
    lon: number,
    name: string,
    existingLocationType?: 'coastal' | 'offshore' | 'inland'
): Promise<MarineWeatherReport> => {

    // 1. Validate Key
    const apiKey = getApiKey();
    if (!apiKey) throw new Error("API Key Missing");

    // 2. Parallel Fetching (PERFORMANCE CRITICAL)
    // We launch all independent requests simultaneously.

    const start = new Date().toISOString();
    const end = new Date(Date.now() + 10 * 24 * 60 * 60 * 1000).toISOString(); // 10 Days

    const weatherParams = {
        lat, lng: lon,
        params: 'windSpeed,gust,windDirection,waveHeight,wavePeriod,waveDirection,airTemperature,dewPointTemperature,pressure,cloudCover,visibility,precipitation,swellPeriod,swellDirection,waterTemperature,currentSpeed,currentDirection,humidity',
        start, end,
        source: 'sg'
    };

    const fetchHybridContext = async () => {
        try {
            const omKey = getOpenMeteoKey();
            const baseUrl = omKey ? "https://customer-api.open-meteo.com/v1" : "https://api.open-meteo.com/v1";
            // FIXED: Commercial API serves marine data via the main 'forecast' endpoint, not 'marine'.
            const marineBaseUrl = omKey ? "https://customer-api.open-meteo.com/v1/forecast" : "https://marine-api.open-meteo.com/v1/marine";

            // FIX: Added hourly=uv_index to support Current Card UV display
            // FIX: Changed timezone=UTC to timezone=auto to get location's offset
            const weatherUrl = `${baseUrl}/forecast?latitude=${lat}&longitude=${lon}&daily=uv_index_max&hourly=uv_index,cape&timezone=auto${omKey ? `&apikey=${omKey}` : ''}`;

            // Fetch Marine (Waves) using Ring Search (Proximity)
            let distToWaterIdx = 9999;
            let marineData = null;
            try {
                const { checkMarineProximity } = await import('../marineProximity');
                const proxResult = await checkMarineProximity(lat, lon);

                if (proxResult.hasMarineData) {
                    marineData = proxResult.data;
                    distToWaterIdx = proxResult.nearestWaterDistanceKm;
                } else {

                }
            } catch (e) {
                // Silently ignored — non-critical failure

            }

            const [wRes] = await Promise.all([
                fetch(weatherUrl).then(r => r.json())
            ]);

            return {
                weather: wRes,
                marine: marineData,
                distToWaterIdx,
                elevation: wRes.elevation
            };
        } catch { return null; }
    };

    // 1. CRITICAL: Fetch Weather First (Fail fast if this breaks)

    let weatherRes: { hours: StormGlassHour[] };
    try {
        weatherRes = await fetchSG<{ hours: StormGlassHour[] }>('weather/point', weatherParams, apiKey);
    } catch (e: unknown) {
        throw e;
    }

    // 2. SECONDARY: Fetch supplements safely
    // If these fail, we log warning but continue with defaults


    const [tidesRes, astronomy, hybridData] = await Promise.all([
        fetchRealTides(lat, lon).catch(e => {
            return { tides: [], guiDetails: undefined };
        }),
        fetchAstronomy(lat, lon, 10, apiKey).catch(e => {
            return [];
        }),
        fetchHybridContext().catch(e => {
            return null;
        })
    ]);

    // INJECT HYBRID HOURLY UV INTO STORMGLASS HOURS
    // This polyfills the missing 'uvIndex' param we had to remove.
    if (hybridData?.weather?.hourly?.uv_index && weatherRes?.hours) {
        const omTimes = hybridData.weather.hourly.time as string[];
        const omValues = hybridData.weather.hourly.uv_index as number[];
        const omOffset = hybridData.weather.utc_offset_seconds || 0;

        weatherRes.hours.forEach(h => {
            // Match Times: SG is "2026-01-14T00:00:00+00:00" (UTC)
            // OM (Auto) is "2026-01-14T10:00" (Local).
            // Convert OM Local -> UTC to match SG.
            // Formula: Local - Offset = UTC.
            // Create Date from "T10:00" treated as UTC (Z), then subtract offset.

            const sgTime = new Date(h.time).getTime();

            // Find matching OM time
            // Because OM returns aligned hours, we can theoretically rely on index if start times matched. 
            // But robust way:
            const matchIdx = omTimes.findIndex(tStr => {
                // TStr: "2026-01-14T10:00"
                const localEp = new Date(tStr + "Z").getTime(); // Treat as UTC
                const utcEp = localEp - (omOffset * 1000);
                return Math.abs(utcEp - sgTime) < 100000; // Within tolerance
            });

            if (matchIdx !== -1) {
                // Inject as MultiSourceField so getVal can extract it
                h.uvIndex = { openmeteo: omValues[matchIdx] } as unknown as typeof h.uvIndex;
            }
        });
    }

    // INJECT HYBRID HOURLY CAPE INTO STORMGLASS HOURS
    // CAPE (Convective Available Potential Energy) only comes from Open-Meteo.
    if (hybridData?.weather?.hourly?.cape && weatherRes?.hours) {
        const omTimes = hybridData.weather.hourly.time as string[];
        const omCape = hybridData.weather.hourly.cape as number[];
        const omOffset = hybridData.weather.utc_offset_seconds || 0;

        weatherRes.hours.forEach(h => {
            const sgTime = new Date(h.time).getTime();
            const matchIdx = omTimes.findIndex(tStr => {
                const localEp = new Date(tStr + "Z").getTime();
                const utcEp = localEp - (omOffset * 1000);
                return Math.abs(utcEp - sgTime) < 100000;
            });
            if (matchIdx !== -1) {
                (h as any).cape = omCape[matchIdx];
            }
        });
    }

    // Normalize Tides
    let tides: import('../../../types').Tide[] = [];

    // With normalized return type, we can safely access .tides
    if (tidesRes) {
        tides = tidesRes.tides;
    } else {
        // Should not happen as fetchRealTides handles errors, but safety first
    }

    // 3. Transformation
    const report = mapStormGlassToReport(
        weatherRes.hours,
        lat,
        lon,
        name,
        hybridData?.weather?.daily, // Pass only the daily part to transformer
        tides,
        // seaLevels: Use interpolated tides if available to restore graph!
        tides.length > 0 ? interpolateTides(tides) : [],
        'sg',
        astronomy,
        existingLocationType,
        hybridData?.weather?.timezone, // Timezone String
        hybridData?.weather?.utc_offset_seconds ? (hybridData.weather.utc_offset_seconds / 3600) : undefined // UTC Offset (Hours)
    );

    // 4. Fetch Buoy Data and Merge with StormGlass
    // This adds source tracking metadata (emerald for Buoy, amber for StormGlass)
    let nearestBuoy: BeaconObservation | null = null;
    try {
        nearestBuoy = await findAndFetchNearestBeacon(lat, lon, 10); // 10nm radius
    } catch (e) {
        // Silently ignored — non-critical failure
    }

    // Merge buoy data with StormGlass report to add source tracking
    const mergedReport = mergeWeatherData(nearestBuoy, report, { lat, lon, name });

    // 5. Calculate Location Type (ALWAYS recompute — never trust stale cached values)
    // The existingLocationType from cache can become stale when a user moves between
    // coastal/offshore zones. We always recompute from fresh geocode + marine proximity.
    {
        try {
            // Calculate Distances
            // distToWaterIdx is set by Ring Search above (0 if found)
            const distToWaterIdx = hybridData?.distToWaterIdx ?? 9999;

            // We need land context to measure distance to land
            // We can re-use reverseGeocodeContext from geocoding service, or might need to import it.
            // Since we are inside fetchStormGlassWeather, let's try to get context if we don't have it.
            // However, doing a full geocode here might be slow.
            // OPTIMIZATION: Check if 'name' contains implicit context (unlikely to have coordinates).
            // Let's perform a lightweight geocode context lookup safely.

            const { reverseGeocodeContext } = await import('./geocoding');
            const landCtx = await reverseGeocodeContext(lat, lon);

            let distToLand = 9999;
            if (landCtx) {
                // FIX: Filter out Generic or STANDALONE Ocean/Sea names
                // NOTE: Only match full water body names ("Pacific Ocean", "South Sea"),
                // NOT place names containing these words ("Seaford", "Coral Sea Marina", "Reefton").
                const isGeneric = landCtx.name.startsWith("Location") ||
                    /^[+-]?\d/.test(landCtx.name) ||
                    /^(North|South|East|West|Central)?\s*(Pacific|Atlantic|Indian|Arctic|Southern)?\s*(Ocean|Sea)$/i.test(landCtx.name);

                if (!isGeneric) {
                    distToLand = calculateDistance(lat, lon, landCtx.lat, landCtx.lon);
                } else {

                    // Force landCtx null so determiner sees it as "Far from Land"
                    // (We can't set landCtx to null because it's const, but we can manage the call below)
                }

                // Effective Context for Determiner
                const effectiveCtx = isGeneric ? null : landCtx;

                mergedReport.locationType = determineLocationType(
                    effectiveCtx ? distToLand : null,
                    distToWaterIdx,
                    effectiveCtx?.name,
                    mergedReport.tides && mergedReport.tides.length > 0,
                    hybridData?.elevation
                );
            } else {
                // No land context at all
                mergedReport.locationType = determineLocationType(null, distToWaterIdx, undefined, mergedReport.tides && mergedReport.tides.length > 0, hybridData?.elevation);
            }

            mergedReport.isLandlocked = mergedReport.locationType === 'inland';
            // Store distToLand for ShipLogService adaptive logging zones
            if (distToLand < 9999) {
                mergedReport.distToLandKm = distToLand;
            }


        } catch (e) {
            // Silently ignored — non-critical failure
        }
    }

    // Attach Station Name - REMOVED per user request
    // if (tideStationName) { ... }

    // Attach Tide GUI Details (Source Provenance)
    if (tidesRes?.guiDetails) {
        mergedReport.tideGUIDetails = tidesRes.guiDetails;

    } else {
    }

    return mergedReport;
};
