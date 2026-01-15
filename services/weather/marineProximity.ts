import { getOpenMeteoKey } from './keys';

export interface MarineProximityResult {
    hasMarineData: boolean;
    nearestWaterDistanceKm: number; // 0 if on water, otherwise approx distance
    data?: any; // The valid marine data found (if any)
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
    // Commercial: /v1/forecast
    // Free: /v1/marine
    const baseUrl = isCommercial
        ? "https://customer-api.open-meteo.com/v1/forecast"
        : "https://marine-api.open-meteo.com/v1/marine";

    const lats = points.map(p => p.lat.toFixed(4)).join(',');
    const lons = points.map(p => p.lon.toFixed(4)).join(',');

    const params = new URLSearchParams({
        latitude: lats,
        longitude: lons,
        daily: "wave_height_max", // Only need specific check
        timezone: "auto",
        forecast_days: "3" // Only check immediate forecast for validity
    });

    if (isCommercial) params.append("apikey", apiKey!);

    try {
        const res = await fetch(`${baseUrl}?${params.toString()}`);
        if (!res.ok) return { hasMarineData: false, nearestWaterDistanceKm: 9999 };

        const data = await res.json();

        // OpenMeteo returns array if multiple points
        const results = Array.isArray(data) ? data : [data];

        // 3. Check for ANY valid data
        for (const r of results) {
            // Check if ANY day in forecast has valid wave data
            const hasWaves = r.daily?.wave_height_max?.some((h: any) => h !== null && h > 0);
            if (hasWaves) {
                // Found valid water!
                console.log(`[MarineProximity] Found waves at point (${r.latitude}, ${r.longitude})`);

                // Return this valid data set
                return {
                    hasMarineData: true,
                    nearestWaterDistanceKm: 0, // Effectively on/near water
                    data: r
                };
            }
        }

        console.log("[MarineProximity] Ring search found NO valid waves.");
        return { hasMarineData: false, nearestWaterDistanceKm: 9999 };

    } catch (e) {
        console.warn("[MarineProximity] Fetch Failed", e);
        return { hasMarineData: false, nearestWaterDistanceKm: 9999 };
    }
};
