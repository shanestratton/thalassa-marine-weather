import { Tide, StormGlassTideData } from '../../../types';
// import { fetchSG } from './base'; // REMOVED
// import { getApiKey } from '../keys'; // REMOVED
import { getNavigationMode, applyTideOffsets, resolveTideFetchSource, ALL_STATIONS } from '../../TideService';

// --- HELPER: Fetch with Error Swallowing ---
// Removed SG Fetchers (fetchTidesSafe, fetchSeaLevelSafe) to ensure strict WorldTides usage.

// ... (imports remain)

// ... (imports remain)

import { fetchWorldTides } from './worldtides';

/** Tide station GUI metadata for source provenance display */
export interface TideGUIDetails {
    stationName: string;
    isSecondary: boolean;
    referenceStation?: string;
    timeOffsetHigh?: number;
    timeOffsetLow?: number;
}

export const fetchRealTides = async (lat: number, lon: number): Promise<{ tides: Tide[], guiDetails?: TideGUIDetails }> => {
    // 1. Check Navigation Mode
    const mode = getNavigationMode(lat, lon);
    if (mode.mode === 'OFFSHORE') return {
        tides: [],
        guiDetails: {
            stationName: "Offshore (Deep Water)",
            isSecondary: false,
            referenceStation: "",
            timeOffsetHigh: 0,
            timeOffsetLow: 0
        }
    };

    // 2. Resolve Source Coordinates (Secondary Port Logic)
    let fetchLat = lat;
    let fetchLon = lon;

    if (mode.station) {
        const source = resolveTideFetchSource(mode.station);
        fetchLat = source.lat;
        fetchLon = source.lon;
    }

    try {

        // Fetch 14 days of data (User requested 12, added buffer)
        const wtData = await fetchWorldTides(fetchLat, fetchLon, 14);

        if (wtData && wtData.extremes) {


            // Map WorldTides Extremes to App Tide Format
            let mappedTides: Tide[] = wtData.extremes.map(e => ({
                time: e.date, // ISO String
                type: e.type, // 'High' | 'Low' (Matches perfectly)
                height: e.height
            }));

            // 3. Apply Secondary Port Offsets (If Applicable)
            if (mode.station) {

                mappedTides = applyTideOffsets(mappedTides, mode.station);
            }

            if (mappedTides.length > 0) {

            }

            // 4. GUI Details (Source Provenance)
            // 4. GUI Details (Source Provenance)
            // Refinement: If we are in Generic Mode, prefer the Station Name returned by WorldTides API
            let displayStationName = mode.station?.name || "WorldTides Virtual";
            if (mode.isGeneric && wtData.station?.name) {
                displayStationName = wtData.station.name;
            }

            const guiDetails = {
                stationName: displayStationName,
                isSecondary: !!mode.station?.referenceStationId,
                referenceStation: mode.station?.referenceStationId ? ALL_STATIONS.find(s => s.id === mode.station?.referenceStationId)?.name : undefined,
                timeOffsetHigh: mode.station?.timeOffsetHigh ?? mode.station?.timeOffsetMinutes,
                timeOffsetLow: mode.station?.timeOffsetLow ?? mode.station?.timeOffsetMinutes
            };



            // 5. Return Data
            return {
                tides: mappedTides,
                guiDetails
            };
        } else {

        }
    } catch (err) {
        // Silently ignored — non-critical failure

    }

    // FALLBACK: Network Failure / No Data
    // We MUST return empty array so transformers.ts can correctly classify this as INLAND/OFFSHORE.
    // Returning Mock Tides forces 'Coastal' classification which breaks Alice Springs.

    return {
        tides: [],
        guiDetails: undefined
    };
};

const generateMockTides = (): Tide[] => {
    const now = Date.now();
    const start = now - 24 * 60 * 60 * 1000;
    const end = now + 48 * 60 * 60 * 1000;
    const tides: Tide[] = [];

    // Simple semidiurnal mock (every ~6h 12m)
    let t = start;
    let isHigh = true;

    while (t < end) {
        tides.push({
            time: new Date(t).toISOString(),
            type: isHigh ? 'High' : 'Low',
            height: isHigh ? 2.5 : 0.5 // Meters roughly
        });
        t += (6 * 60 * 60 * 1000) + (12 * 60 * 1000); // +6h 12m
        isHigh = !isHigh;
    }
    return tides;
};

export const fetchSeaLevels = async (lat: number, lon: number): Promise<Partial<StormGlassTideData>[]> => {
    // USER REQUEST: FORCE MOCK DATA (Bypass SG API)
    return [];

    /* API LOGIC DISABLED
    const mode = getNavigationMode(lat, lon);
    if (mode.mode === 'OFFSHORE') return [];

    // Fetch Chain (MLLW -> MSL)
    let data = await fetchSeaLevelSafe(lat, lon, 'MLLW');

    if (!data || !data.data) {
        data = await fetchSeaLevelSafe(lat, lon, 'MSL');
    }

    if (data && data.data) {
        return data.data.map((item: { time: string; sg: number }) => ({
            time: item.time,
            sg: item.sg
        }));
    }

    // Mock Sea Levels (optional but good for hourly consistency)
    return [];
    */
};
