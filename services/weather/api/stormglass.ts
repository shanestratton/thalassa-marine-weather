
import { MarineWeatherReport, StormGlassHour, StormGlassTideData } from '../../../types';
import { getApiKey, checkStormglassStatus } from '../keys';
import { fetchSG } from './base';
import { fetchRealTides } from './tides';
import { fetchNearestMetar } from '../../MetarService';
import { mapStormGlassToReport } from '../transformers';

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

    const fetchHybridUV = async () => {
        try {
            // FIX: Added hourly=uv_index to support Current Card UV display
            // FIX: Added timezone=UTC to align with StormGlass ISO strings
            const r = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lon}&daily=uv_index_max&hourly=uv_index&timezone=UTC`);
            const d = await r.json();
            return d; // Return WHOLE response (hourly + daily)
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
        fetchHybridUV().catch(e => {
            console.warn("[SG] Hybrid UV Fetch Failed", e);
            return null;
        })
    ]);

    // INJECT HYBRID HOURLY UV INTO STORMGLASS HOURS
    // This polyfills the missing 'uvIndex' param we had to remove.
    if (hybridData?.hourly?.uv_index && weatherRes?.hours) {
        const omTimes = hybridData.hourly.time as string[];
        const omValues = hybridData.hourly.uv_index as number[];

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
        hybridData?.daily, // Pass only the daily part to transformer
        tides,
        [], // seaLevels REMOVED
        'sg',
        astronomy,
        metar,
        existingLocationType
    );

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
