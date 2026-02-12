/**
 * Global Wind Data Service
 * 
 * Fetches real wind speed, wind direction, and mean sea level pressure (MSLP)
 * from the Open-Meteo API (free, no API key required).
 * 
 * Samples a grid of points across the visible map area to produce a global
 * wind heat map with isobar contour lines.
 */

export interface WindGridPoint {
    lat: number;
    lon: number;
    windSpeed: number;      // knots
    windDirection: number;  // degrees
    pressure: number;       // hPa (MSLP)
}

export interface WindGridData {
    points: WindGridPoint[];
    gridRows: number;
    gridCols: number;
    latMin: number;
    latMax: number;
    lonMin: number;
    lonMax: number;
    fetchedAt: number;      // epoch-ms
}

// Cache to avoid re-fetching on every pan/zoom
let cachedData: WindGridData | null = null;
let fetchInProgress: Promise<WindGridData | null> | null = null;

const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const GRID_SIZE = 12; // 12x12 grid = 144 API calls batched

/**
 * Fetch wind data for a grid of points covering the given bounds.
 * Uses Open-Meteo's free forecast API with current_weather parameter.
 * 
 * Open-Meteo supports batching multiple coordinates in a single request
 * using comma-separated latitude/longitude values.
 */
export async function fetchGlobalWindGrid(
    latMin: number, latMax: number,
    lonMin: number, lonMax: number
): Promise<WindGridData | null> {
    // Check cache
    if (cachedData && Date.now() - cachedData.fetchedAt < CACHE_TTL_MS) {
        // Check if cached bounds roughly cover the requested area
        const overlap = (
            cachedData.latMin <= latMin + 5 &&
            cachedData.latMax >= latMax - 5 &&
            cachedData.lonMin <= lonMin + 5 &&
            cachedData.lonMax >= lonMax - 5
        );
        if (overlap) return cachedData;
    }

    // Deduplicate concurrent fetches
    if (fetchInProgress) return fetchInProgress;

    fetchInProgress = _doFetch(latMin, latMax, lonMin, lonMax);
    try {
        const result = await fetchInProgress;
        return result;
    } finally {
        fetchInProgress = null;
    }
}

async function _doFetch(
    latMin: number, latMax: number,
    lonMin: number, lonMax: number
): Promise<WindGridData | null> {
    try {
        // Expand bounds slightly for smoother edges
        const pad = 3;
        const effLatMin = Math.max(-85, latMin - pad);
        const effLatMax = Math.min(85, latMax + pad);
        const effLonMin = Math.max(-180, lonMin - pad);
        const effLonMax = Math.min(180, lonMax + pad);

        // Generate grid points
        const latStep = (effLatMax - effLatMin) / (GRID_SIZE - 1);
        const lonStep = (effLonMax - effLonMin) / (GRID_SIZE - 1);

        const lats: number[] = [];
        const lons: number[] = [];

        for (let r = 0; r < GRID_SIZE; r++) {
            for (let c = 0; c < GRID_SIZE; c++) {
                lats.push(Math.round((effLatMin + r * latStep) * 100) / 100);
                lons.push(Math.round((effLonMin + c * lonStep) * 100) / 100);
            }
        }

        // Open-Meteo supports comma-separated coordinates for multi-location requests
        const latParam = lats.join(',');
        const lonParam = lons.join(',');

        const url = `https://api.open-meteo.com/v1/forecast?latitude=${latParam}&longitude=${lonParam}&current=wind_speed_10m,wind_direction_10m,surface_pressure&wind_speed_unit=kn&timezone=auto`;

        const response = await fetch(url);
        if (!response.ok) {
            console.warn('[GlobalWind] API returned', response.status);
            return null;
        }

        const json = await response.json();

        // Open-Meteo returns an array when multiple coordinates are provided
        const results = Array.isArray(json) ? json : [json];

        const points: WindGridPoint[] = [];
        for (let i = 0; i < results.length; i++) {
            const r = results[i];
            if (!r?.current) continue;

            points.push({
                lat: r.latitude ?? lats[i],
                lon: r.longitude ?? lons[i],
                windSpeed: r.current.wind_speed_10m ?? 0,
                windDirection: r.current.wind_direction_10m ?? 0,
                pressure: r.current.surface_pressure ?? 1013.25,
            });
        }

        if (points.length === 0) return null;

        const data: WindGridData = {
            points,
            gridRows: GRID_SIZE,
            gridCols: GRID_SIZE,
            latMin: effLatMin,
            latMax: effLatMax,
            lonMin: effLonMin,
            lonMax: effLonMax,
            fetchedAt: Date.now(),
        };

        cachedData = data;
        return data;
    } catch (err) {
        console.warn('[GlobalWind] Fetch failed:', err);
        return null;
    }
}

/**
 * Interpolate wind speed/direction/pressure at an arbitrary point
 * using inverse-distance weighting from the grid data.
 */
export function interpolateAtPoint(
    data: WindGridData,
    lat: number,
    lon: number
): { speed: number; direction: number; pressure: number } {
    let totalWeight = 0;
    let speedSum = 0;
    let sinDirSum = 0;
    let cosDirSum = 0;
    let pressureSum = 0;

    for (const p of data.points) {
        const dLat = lat - p.lat;
        const dLon = lon - p.lon;
        const distSq = dLat * dLat + dLon * dLon;

        // If extremely close to a data point, return it directly
        if (distSq < 0.001) {
            return { speed: p.windSpeed, direction: p.windDirection, pressure: p.pressure };
        }

        const w = 1 / (distSq + 0.01); // IDW with small epsilon
        totalWeight += w;
        speedSum += w * p.windSpeed;
        // Wind direction needs circular averaging
        sinDirSum += w * Math.sin(p.windDirection * Math.PI / 180);
        cosDirSum += w * Math.cos(p.windDirection * Math.PI / 180);
        pressureSum += w * p.pressure;
    }

    if (totalWeight === 0) return { speed: 0, direction: 0, pressure: 1013.25 };

    return {
        speed: speedSum / totalWeight,
        direction: ((Math.atan2(sinDirSum / totalWeight, cosDirSum / totalWeight) * 180 / Math.PI) + 360) % 360,
        pressure: pressureSum / totalWeight,
    };
}
