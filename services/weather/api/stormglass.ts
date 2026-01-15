import { MarineWeatherReport, StormGlassHour, StormGlassTideData } from '../../../types';
import { getApiKey, checkStormglassStatus, getOpenMeteoKey } from '../keys';
import { fetchSG } from './base';
import { fetchRealTides } from './tides';
import { fetchNearestMetar } from '../../MetarService';
import { mapStormGlassToReport } from '../transformers';
import { calculateDistance } from '../../../utils/math'; // Added
import { determineLocationType } from '../locationType'; // Added

const fetchAstronomy = async (lat: number, lon: number, days: number, apiKey: string) => {
    const end = new Date();
    end.setDate(end.getDate() + days);
    return fetchSG<{ data: any[] }>('astronomy/point', {
        lat, lng: lon, end: end.toISOString()
    }, apiKey).then(r => r.data).catch(() => []);
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
        params: 'windSpeed,gust,windDirection,waveHeight,wavePeriod,waveDirection,airTemperature,pressure,cloudCover,visibility,precipitation,swellPeriod,swellDirection,waterTemperature,currentSpeed,currentDirection,humidity',
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
            // FIX: Added timezone=UTC to align with StormGlass ISO strings
            const weatherUrl = `${baseUrl}/forecast?latitude=${lat}&longitude=${lon}&daily=uv_index_max&hourly=uv_index&timezone=UTC${omKey ? `&apikey=${omKey}` : ''}`;

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
                    console.log("[StormGlass] Marine Ring Search found NO valid waves.");
                }
            } catch (e) {
                console.warn("[StormGlass] Marine Proximity Check Failed", e);
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
    console.log(`[StormGlass] Fetching weather for ${lat},${lon}...`);
    let weatherRes: { hours: StormGlassHour[] };
    try {
        weatherRes = await fetchSG<{ hours: StormGlassHour[] }>('weather/point', weatherParams, apiKey);
    } catch (e: any) {
        console.error(`[StormGlass] Critical Weather Fetch Failed: ${e.message}`, e);
        throw e;
    }

    // 2. SECONDARY: Fetch supplements safely
    // If these fail, we log warning but continue with defaults
    const [tidesRes, astronomy, metar, hybridData] = await Promise.all([
        fetchRealTides(lat, lon).catch(e => {
            console.warn("[SG] Tides (WT) Fetch Failed", e);
            return { tides: [], guiDetails: undefined };
        }),
        // fetchSeaLevels(lat, lon), // REMOVED SG TIDES
        fetchAstronomy(lat, lon, 10, apiKey).catch(e => {
            console.warn("[SG] Astro Fetch Failed", e);
            return [];
        }),
        fetchNearestMetar(lat, lon).catch(e => {
            console.warn("[SG] METAR Fetch Failed", e);
            return null;
        }),
        fetchHybridContext().catch(e => {
            console.warn("[SG] Hybrid Context Fetch Failed", e);
            return null;
        })
    ]);

    // INJECT HYBRID HOURLY UV INTO STORMGLASS HOURS
    // This polyfills the missing 'uvIndex' param we had to remove.
    if (hybridData?.weather?.hourly?.uv_index && weatherRes?.hours) {
        const omTimes = hybridData.weather.hourly.time as string[];
        const omValues = hybridData.weather.hourly.uv_index as number[];

        weatherRes.hours.forEach(h => {
            // Match Times: SG is "2026-01-14T00:00:00+00:00", OM (UTC) is "2026-01-14T00:00"
            const sgBrief = h.time.slice(0, 16);
            const idx = omTimes.indexOf(sgBrief);
            if (idx !== -1) {
                h.uvIndex = omValues[idx];
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
        console.warn("[StormGlass] TidesRes was null/undefined");
    }

    // 3. Transformation
    const report = mapStormGlassToReport(
        weatherRes.hours,
        lat,
        lon,
        name,
        hybridData?.weather?.daily, // Pass only the daily part to transformer
        tides,
        [], // seaLevels REMOVED
        'sg',
        astronomy,
        metar,
        existingLocationType
    );

    // 4. Calculate Location Type (if not forced)
    if (!existingLocationType) {
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
                distToLand = calculateDistance(lat, lon, landCtx.lat, landCtx.lon);
            }

            report.locationType = determineLocationType(
                landCtx ? distToLand : null,
                distToWaterIdx,
                landCtx?.name,
                report.tides && report.tides.length > 0,
                hybridData?.elevation // Pass elevation
            );

            report.isLandlocked = report.locationType === 'inland';
            console.log(`[StormGlass] Calculated LocationType: ${report.locationType}`);

        } catch (e) {
            console.warn("[StormGlass] Failed to calculate location type, using default:", e);
        }
    }

    // Attach Station Name - REMOVED per user request
    // if (tideStationName) { ... }

    // Attach Tide GUI Details (Source Provenance)
    if (tidesRes?.guiDetails) {
        report.tideGUIDetails = tidesRes.guiDetails;
        console.log("[StormGlass] Attached tideGUIDetails:", report.tideGUIDetails);
    } else {
        console.warn("[StormGlass] No tideGUIDetails found in tidesRes");
    }

    return report;
};
