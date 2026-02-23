import { CapacitorHttp } from '@capacitor/core';
import { getWorldTidesKey } from '../keys';
import { WorldTidesResponse } from '../../../types';

const BASE_URL = 'https://www.worldtides.info/api/v3';

// ── HARD RATE LIMITER ──────────────────────────────────────────
// Max 4 calls per hour, persisted across app restarts.
// This is the LAST line of defense against credit drain.
const WT_RATE_KEY = 'thalassa_wt_rate_v1';
const MAX_CALLS_PER_HOUR = 4;

function isRateLimited(): boolean {
    try {
        const raw = localStorage.getItem(WT_RATE_KEY);
        const timestamps: number[] = raw ? JSON.parse(raw) : [];
        const oneHourAgo = Date.now() - 3600_000;
        const recent = timestamps.filter(t => t > oneHourAgo);
        return recent.length >= MAX_CALLS_PER_HOUR;
    } catch { return false; }
}

function recordCall(): void {
    try {
        const raw = localStorage.getItem(WT_RATE_KEY);
        const timestamps: number[] = raw ? JSON.parse(raw) : [];
        const oneHourAgo = Date.now() - 3600_000;
        const recent = timestamps.filter(t => t > oneHourAgo);
        recent.push(Date.now());
        localStorage.setItem(WT_RATE_KEY, JSON.stringify(recent));
    } catch { /* localStorage full — proceed anyway */ }
}

export const fetchWorldTides = async (
    lat: number,
    lon: number,
    days: number = 2
): Promise<WorldTidesResponse | null> => {
    const key = getWorldTidesKey();
    if (!key) {
        return null;
    }

    // HARD LIMIT: Max 4 calls/hour — no exceptions
    if (isRateLimited()) {
        console.warn('[WorldTides] RATE LIMITED — max 4 calls/hour reached. Skipping API call.');
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
    const url = `${BASE_URL}?extremes&lat=${lat}&lon=${lon}&days=${days}&datum=LAT&stationDistance=100&start=${start}&key=${key}`;

    try {

        const options = { url };
        const res = await CapacitorHttp.get(options);

        // console.log(`[WorldTides] Status: ${res.status}`, res.data);

        if (res.status === 200 && res.data) {
            recordCall(); // Track this call for rate limiting
            // Check if response has station in body (WorldTides V3 often returns 'station' object or name field)
            const data = res.data as Record<string, unknown> & { station?: string | { name?: string }; atlasLatitude?: number; atlasLongitude?: number };





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
            return null;
        }
    } catch (e) {
        try {
            // Fallback to native fetch (useful for web/localhost if Proxy is setup or CORS allows)
            const nativeRes = await fetch(url);
            const nativeData = await nativeRes.json();
            if (nativeData && !nativeData.error) return nativeData as WorldTidesResponse;
        } catch (nativeErr) {
            // Silently ignored — non-critical failure
        }
        return null;
    }
};
