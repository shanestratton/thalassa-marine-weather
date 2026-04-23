import { Tide, StormGlassTideData } from '../../../types';
import { fetchWorldTides } from './worldtides';
import { apiCacheGet, apiCacheSet } from '../apiCache';

import { createLogger } from '../../../utils/createLogger';

const log = createLogger('tides');

/** Tide station GUI metadata for source provenance display */
export interface TideGUIDetails {
    stationName: string;
    isSecondary: boolean;
    referenceStation?: string;
    timeOffsetHigh?: number;
    timeOffsetLow?: number;
}

/**
 * Fetch tide extremes directly from the WorldTides API.
 * CACHED for 24 hours — tide predictions are deterministic (harmonic constants).
 * Called from BOTH openmeteo.ts AND stormglass.ts, so caching here
 * prevents double-hitting WorldTides on every single weather refresh.
 */
export const fetchRealTides = async (
    lat: number,
    lon: number,
): Promise<{ tides: Tide[]; guiDetails?: TideGUIDetails }> => {
    // Check cache first (24h TTL — predictions don't change)
    const cached = apiCacheGet<{ tides: Tide[]; guiDetails?: TideGUIDetails }>('tides', lat, lon);
    if (cached) return cached;

    try {
        const wtData = await fetchWorldTides(lat, lon, 14);

        if (wtData && wtData.extremes) {
            // (Diagnostic log removed 2026-04-24 after confirming WorldTides
            // returns the full 14-day window — 54 extremes spanning ~329h
            // in the prod log. The day-2-and-beyond tide disappearance was
            // actually caused by WeatherKit's 48h hourly cap, not WT.)

            const mappedTides: Tide[] = wtData.extremes.map((e) => ({
                time: e.date,
                type: e.type,
                height: e.height,
            }));

            // Use the station name returned by the WorldTides API
            const stationName = wtData.station?.name || 'WorldTides Station';

            const guiDetails: TideGUIDetails = {
                stationName,
                isSecondary: false,
            };

            const result = { tides: mappedTides, guiDetails };
            apiCacheSet('tides', lat, lon, result);
            return result;
        }
    } catch (err) {
        log.warn(`[tides]`, err);
    }

    // FALLBACK: Network Failure / No Data
    // Return empty so transformers.ts correctly classifies as INLAND/OFFSHORE.
    return { tides: [], guiDetails: undefined };
};

export const fetchSeaLevels = async (_lat: number, _lon: number): Promise<Partial<StormGlassTideData>[]> => {
    return [];
};
