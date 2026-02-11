import { Tide, StormGlassTideData } from '../../../types';
import { fetchWorldTides } from './worldtides';

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
 * The API handles station resolution, snapping, and data — we just display what it returns.
 */
export const fetchRealTides = async (lat: number, lon: number): Promise<{ tides: Tide[], guiDetails?: TideGUIDetails }> => {
    try {
        const wtData = await fetchWorldTides(lat, lon, 14);

        if (wtData && wtData.extremes) {
            const mappedTides: Tide[] = wtData.extremes.map(e => ({
                time: e.date,
                type: e.type,
                height: e.height
            }));

            // Use the station name returned by the WorldTides API
            const stationName = wtData.station?.name || 'WorldTides Station';

            const guiDetails: TideGUIDetails = {
                stationName,
                isSecondary: false,
            };

            return { tides: mappedTides, guiDetails };
        }
    } catch (err) {
        // Silently ignored — non-critical failure
    }

    // FALLBACK: Network Failure / No Data
    // Return empty so transformers.ts correctly classifies as INLAND/OFFSHORE.
    return { tides: [], guiDetails: undefined };
};

export const fetchSeaLevels = async (_lat: number, _lon: number): Promise<Partial<StormGlassTideData>[]> => {
    return [];
};
