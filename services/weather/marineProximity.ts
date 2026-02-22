import { CapacitorHttp } from '@capacitor/core';
import { getOpenMeteoKey } from './keys';
import { calculateDistance } from '../../utils/math';

export interface MarineProximityResult {
    hasMarineData: boolean;
    nearestWaterDistanceKm: number; // 0 if on water, otherwise approx distance
    data?: unknown; // The valid marine data found (if any)
}

/**
 * Checks for marine data (waves) in a 5nm ring around the location.
 * This handles cases where the exact location is on a "land mask" (null data),
 * but valid water is nearby (e.g. Canal estates, coastal inlets).
 * 
 * @param lat Center Latitude
 * @param lon Center Longitude
 */
export const checkMarineProximity = async (lat: number, lon: number): Promise<MarineProximityResult> => {
    const apiKey = getOpenMeteoKey();
    const isCommercial = !!apiKey && apiKey.length > 5;

    // 1. Calculate Ring Points (Center + 4 Cardinal Points at 5nm)
    // 5 NM = 9.26 km
    // Lat Offset: 9.26km / 111.32km = ~0.083 degrees
    const LAT_OFFSET = 0.083;
    // Lon Offset: 0.083 / cos(lat)
    const cosLat = Math.cos(lat * Math.PI / 180);
    const LON_OFFSET = 0.083 / (Math.abs(cosLat) > 0.1 ? Math.abs(cosLat) : 1); // Avoid div by zero

    const points = [
        { lat: lat, lon: lon, label: 'Center' },
        { lat: lat + LAT_OFFSET, lon: lon, label: 'North' },
        { lat: lat - LAT_OFFSET, lon: lon, label: 'South' },
        { lat: lat, lon: lon + LON_OFFSET, label: 'East' },
        { lat: lat, lon: lon - LON_OFFSET, label: 'West' }
    ];

    // 2. Construct API URL
    // ALWAYS use the Marine API for "Proximity Checks" because we specifically need the GFS Wave model 
    // which is best accessed via the marine endpoint to avoid model-domain mismatch errors.
    const baseUrl = "https://marine-api.open-meteo.com/v1/marine";

    const lats = points.map(p => p.lat.toFixed(4)).join(',');
    const lons = points.map(p => p.lon.toFixed(4)).join(',');

    const params = new URLSearchParams({
        latitude: lats,
        longitude: lons,
        daily: "wave_height_max",
        timezone: "auto",
        forecast_days: "3",
        // models: "gfs_wave" // REMOVED: Caused 400 Error. Let API use default (best_match).
    });

    // if (isCommercial) params.append("apikey", apiKey!); // Disable API Key for Marine Endpoint check to avoid complexity

    try {
        const res = await CapacitorHttp.get({
            url: `${baseUrl}?${params.toString()}`,
            headers: { 'Accept': 'application/json' }
        });
        if (res.status !== 200) {
            return { hasMarineData: false, nearestWaterDistanceKm: 9999 };
        }

        let data = res.data;
        if (typeof data === 'string') {
            try { data = JSON.parse(data); } catch (e) { /* Parse failed, data remains string */ }
        }

        // OpenMeteo returns array if multiple points
        const results = Array.isArray(data) ? data : [data];

        // 3. Check for ANY valid data — track which point matched
        for (let idx = 0; idx < results.length; idx++) {
            const r = results[idx];
            // Check if ANY day in forecast has valid wave data
            const hasWaves = r.daily?.wave_height_max?.some((h: number | null) => h !== null && h > 0);
            if (hasWaves) {
                // Found valid water!
                // Calculate actual distance from user to the matching ring point
                const matchedPoint = points[idx];
                const distKm = matchedPoint
                    ? calculateDistance(lat, lon, matchedPoint.lat, matchedPoint.lon)
                    : 0;

                return {
                    hasMarineData: true,
                    nearestWaterDistanceKm: distKm,
                    data: r
                };
            }
        }


        return { hasMarineData: false, nearestWaterDistanceKm: 9999 };

    } catch (e) {

        return { hasMarineData: false, nearestWaterDistanceKm: 9999 };
    }
};
