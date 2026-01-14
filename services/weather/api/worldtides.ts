import { CapacitorHttp } from '@capacitor/core';
import { getWorldTidesKey } from '../keys';
import { WorldTidesResponse } from '../../../types';

const BASE_URL = 'https://www.worldtides.info/api/v3';

export const fetchWorldTides = async (
    lat: number,
    lon: number,
    days: number = 2
): Promise<WorldTidesResponse | null> => {
    const key = getWorldTidesKey();
    if (!key) {
        console.warn("[WorldTides] No API Key Found");
        return null;
    }

    // Default to Yesterday Midnight to ensure we capture the tide event *before* today's start
    // This allows the graph interpolation to work correctly from 00:00.
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    today.setDate(today.getDate() - 1); // Go back 24h
    const start = Math.floor(today.getTime() / 1000); // Unix Timestamp (Seconds)

    // WorldTides V3 Request
    // datum=LAT (Chart Datum) is standard for nautical.
    // stations=true allows snapping to virtual/real stations if needed, but we used lat/lon here.
    // REMOVED 'heights' to save bandwidth/credits, we only map 'extremes' in tides.ts
    const url = `${BASE_URL}?extremes&lat=${lat}&lon=${lon}&days=${days}&datum=LAT&stationDistance=50&start=${start}&key=${key}`;

    try {
        console.log(`[WorldTides] Fetching 14-Day Extremes (Buffered from Yesterday). Start: ${new Date(start * 1000).toLocaleString()} (Lat: ${lat}, Lon: ${lon})`);
        const options = { url };
        const res = await CapacitorHttp.get(options);

        // console.log(`[WorldTides] Status: ${res.status}`, res.data);

        if (res.status === 200 && res.data) {
            // Check if response has station in body (WorldTides V3 often returns 'station' object or name field)
            const data = res.data as any;

            console.log("[WorldTides] Response Keys:", Object.keys(data));
            console.log("[WorldTides] Raw Station Field:", JSON.stringify(data.station));
            console.log("[WorldTides] Raw Atlas Lat/Lon:", data.atlasLatitude, data.atlasLongitude);

            let stationInfo;
            if (data.station) {
                // Handle case where station is string (name) or object
                const name = typeof data.station === 'string' ? data.station : data.station.name || "Unknown Station";
                stationInfo = { name: name, lat: data.atlasLatitude || lat, lon: data.atlasLongitude || lon };
            } else {
                // Fallback for when WorldTides returns data but no nearest station ref
                stationInfo = {
                    name: `WorldTides Virtual (${lat.toFixed(2)}, ${lon.toFixed(2)})`,
                    lat: data.atlasLatitude || lat,
                    lon: data.atlasLongitude || lon
                };
            }

            return {
                ...res.data,
                station: stationInfo
            } as WorldTidesResponse;
        } else {
            console.error(`[WorldTides] API Error ${res.status}:`, res.data);
            return null;
        }
    } catch (e) {
        console.error("[WorldTides] Network Error (CapacitorHttp):", e);
        try {
            // Fallback to native fetch (useful for web/localhost if Proxy is setup or CORS allows)
            console.warn("[WorldTides] Retrying with native fetch...");
            const nativeRes = await fetch(url);
            const nativeData = await nativeRes.json();
            if (nativeData && !nativeData.error) return nativeData as WorldTidesResponse;
        } catch (nativeErr) {
            console.error("[WorldTides] Native Fetch also failed", nativeErr);
        }
        return null;
    }
};
