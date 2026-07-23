import { calculateDistance } from '../../utils/math';
import { fetchOpenMeteoPoints } from './openMeteoProxy';

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
    // 1. Calculate Ring Points (Center + 4 Cardinal Points at 5nm)
    // 5 NM = 9.26 km
    // Lat Offset: 9.26km / 111.32km = ~0.083 degrees
    const LAT_OFFSET = 0.083;
    // Lon Offset: 0.083 / cos(lat)
    const cosLat = Math.cos((lat * Math.PI) / 180);
    const LON_OFFSET = 0.083 / (Math.abs(cosLat) > 0.1 ? Math.abs(cosLat) : 1); // Avoid div by zero

    const points = [
        { lat: lat, lon: lon, label: 'Center' },
        { lat: lat + LAT_OFFSET, lon: lon, label: 'North' },
        { lat: lat - LAT_OFFSET, lon: lon, label: 'South' },
        { lat: lat, lon: lon + LON_OFFSET, label: 'East' },
        { lat: lat, lon: lon - LON_OFFSET, label: 'West' },
    ];

    // 2. Query the commercial service through the server-owned key boundary.
    const params = {
        // hourly = waves for the live hero card + per-hour passage
        // forecast; daily = max-wave summaries for the multi-day
        // pre-departure briefing. Without hourly here, the hourly
        // forecast in openmeteo.ts always falls back to 0. Without
        // a 16-day daily window, the pre-departure briefing's wave
        // column showed "0.0 m" for any day past the third (the
        // index-overrun bug — undefined values then coerced to 0
        // downstream).
        hourly: 'wave_height,wave_period,wave_direction',
        daily: 'wave_height_max',
        timezone: 'auto',
        forecast_days: 16,
    };

    try {
        const results = await fetchOpenMeteoPoints<{
            daily?: { wave_height_max?: (number | null)[] };
        }>('marine', points, params);

        // 3. Check for ANY valid data — track which point matched
        for (let idx = 0; idx < results.length; idx++) {
            const r = results[idx];
            // Check if ANY day in forecast has valid wave data
            const hasWaves = r.daily?.wave_height_max?.some((h: number | null) => h !== null && h > 0);
            if (hasWaves) {
                // Found valid water!
                // Calculate actual distance from user to the matching ring point
                const matchedPoint = points[idx];
                const distKm = matchedPoint ? calculateDistance(lat, lon, matchedPoint.lat, matchedPoint.lon) : 0;

                return {
                    hasMarineData: true,
                    nearestWaterDistanceKm: distKm,
                    data: r,
                };
            }
        }

        return { hasMarineData: false, nearestWaterDistanceKm: 9999 };
    } catch (e) {
        return { hasMarineData: false, nearestWaterDistanceKm: 9999 };
    }
};
