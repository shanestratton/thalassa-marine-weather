import { Tide, StormGlassTideData } from '../../../types';
import { fetchWorldTides } from './worldtides';
import { apiCacheGet, apiCacheSet } from '../apiCache';
import { pruneMap } from '../../../utils/boundedMap';

const TIDE_NEGATIVE_TTL_MS = 5 * 60 * 1000;
const failedTideChainAt = new Map<string, number>();

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

    // Negative cache: a failed chain (Pi 502, proxy down) must not be
    // replayed by every consumer at trigger cadence — the 2026-08-04 device
    // log showed the full pi-cache→Supabase chain re-fired per trigger with
    // zero backoff for the whole session.
    const negKey = `${lat.toFixed(2)},${lon.toFixed(2)}`;
    const lastFail = failedTideChainAt.get(negKey);
    if (lastFail !== undefined && Date.now() - lastFail < TIDE_NEGATIVE_TTL_MS) {
        return { tides: [], guiDetails: undefined };
    }

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
            failedTideChainAt.delete(negKey);
            return result;
        }
    } catch (err) {
        log.warn(`[tides]`, err);
    }

    // FALLBACK: Network Failure / No Data
    // Return empty so transformers.ts correctly classifies as INLAND/OFFSHORE.
    failedTideChainAt.set(negKey, Date.now());
    pruneMap(failedTideChainAt, 32);
    return { tides: [], guiDetails: undefined };
};

export const fetchSeaLevels = async (_lat: number, _lon: number): Promise<Partial<StormGlassTideData>[]> => {
    return [];
};
