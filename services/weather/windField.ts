/**
 * WindField Service — Fetches and manages the U/V vector wind grid for GPU rendering.
 *
 * Pipeline:
 *   1. Fetch hourly wind_speed + wind_direction from Open-Meteo for visible bounds
 *   2. Convert to U (east-west) / V (north-south) velocity components
 *   3. Encode into a Float32 grid that the WebGL particle shaders can sample
 *   4. Support multi-hour forecasts for scrubber playback
 *
 * Grid is stored as [row][col] where row 0 = south, row N = north (bottom-up for GL textures).
 */

import { getOpenMeteoKey } from './keys';

const WIND_FIELD_HOURS = 48;
const MAX_SPEED = 60.0; // m/s — clamp range for texture encoding

export interface WindGrid {
    /** U component (m/s, +east) per hour: [hour][row][col] */
    u: Float32Array[];
    /** V component (m/s, +north) per hour: [hour][row][col] */
    v: Float32Array[];
    /** Scalar speed (m/s) per hour: [hour][row][col] */
    speed: Float32Array[];
    /** Grid coordinates */
    width: number;   // columns
    height: number;  // rows
    lats: number[];
    lons: number[];
    /** Bounds */
    north: number;
    south: number;
    west: number;
    east: number;
    totalHours: number;
}

/**
 * Fetch wind grid from Open-Meteo for the given bounds.
 *
 * Uses a sparse grid (~1° resolution for synoptic, ~0.5° for zoomed)
 * to keep the API request manageable while providing sufficient data
 * for GPU bilinear interpolation.
 */
export async function fetchWindGrid(
    north: number,
    south: number,
    west: number,
    east: number,
    zoom: number
): Promise<WindGrid | null> {
    try {
        const res = zoom > 6 ? 0.5 : 1.0;

        const lats: number[] = [];
        const lons: number[] = [];
        for (let lat = south; lat <= north; lat += res) lats.push(Math.round(lat * 100) / 100);
        for (let lon = west; lon <= east; lon += res) lons.push(Math.round(lon * 100) / 100);

        // Cap grid size
        if (lats.length * lons.length > 2500) {
            lats.length = 0;
            lons.length = 0;
            const bigRes = 2.0;
            for (let lat = south; lat <= north; lat += bigRes) lats.push(Math.round(lat * 100) / 100);
            for (let lon = west; lon <= east; lon += bigRes) lons.push(Math.round(lon * 100) / 100);
        }

        if (lats.length < 3 || lons.length < 3) return null;

        // Use sparse multi-point approach (same as isobars)
        const sparseLatStep = Math.max((north - south) / Math.min(lats.length, 20), 0.5);
        const sparseLonStep = Math.max((east - west) / Math.min(lons.length, 20), 0.5);

        const points: { lat: number; lon: number }[] = [];
        for (let lat = south; lat <= north + 0.01; lat += sparseLatStep) {
            for (let lon = west; lon <= east + 0.01; lon += sparseLonStep) {
                points.push({
                    lat: Math.round(Math.min(lat, north) * 100) / 100,
                    lon: Math.round(Math.min(lon, east) * 100) / 100,
                });
            }
        }

        const multiLats = points.map(p => p.lat).join(',');
        const multiLons = points.map(p => p.lon).join(',');

        // Use commercial API with key if available, fall back to free API
        const omKey = getOpenMeteoKey();
        const baseUrl = omKey ? 'https://customer-api.open-meteo.com/v1/forecast' : 'https://api.open-meteo.com/v1/forecast';
        const keyParam = omKey ? `&apikey=${omKey}` : '';
        const url = `${baseUrl}?latitude=${multiLats}&longitude=${multiLons}&hourly=wind_speed_10m,wind_direction_10m&forecast_hours=${WIND_FIELD_HOURS}&timezone=auto${keyParam}`;

        const response = await fetch(url);
        if (!response.ok) return null;

        const data = await response.json();
        const results = Array.isArray(data) ? data : [data];

        const uniqueLats = [...new Set(points.map(p => p.lat))].sort((a, b) => a - b);
        const uniqueLons = [...new Set(points.map(p => p.lon))].sort((a, b) => a - b);

        const rows = uniqueLats.length;
        const cols = uniqueLons.length;

        const sampleHourly = results[0]?.hourly?.wind_speed_10m;
        const totalHours = sampleHourly?.length ?? WIND_FIELD_HOURS;

        const uGrids: Float32Array[] = [];
        const vGrids: Float32Array[] = [];
        const speedGrids: Float32Array[] = [];

        for (let h = 0; h < totalHours; h++) {
            const uArr = new Float32Array(rows * cols);
            const vArr = new Float32Array(rows * cols);
            const sArr = new Float32Array(rows * cols);

            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const idx = r * cols + c;
                    const hourly = results[idx]?.hourly;

                    const speedKmh = hourly?.wind_speed_10m?.[h] ?? 0;
                    const dirDeg = hourly?.wind_direction_10m?.[h] ?? 0;

                    // km/h → m/s
                    const speedMs = speedKmh / 3.6;
                    const dirRad = dirDeg * Math.PI / 180;

                    // Meteorological: direction is where wind comes FROM
                    // U = eastward component, V = northward component (direction wind blows TO)
                    const u = -speedMs * Math.sin(dirRad);
                    const v = -speedMs * Math.cos(dirRad);

                    uArr[idx] = u;
                    vArr[idx] = v;
                    sArr[idx] = speedMs;
                }
            }

            uGrids.push(uArr);
            vGrids.push(vArr);
            speedGrids.push(sArr);
        }

        return {
            u: uGrids,
            v: vGrids,
            speed: speedGrids,
            width: cols,
            height: rows,
            lats: uniqueLats,
            lons: uniqueLons,
            north: uniqueLats[uniqueLats.length - 1],
            south: uniqueLats[0],
            west: uniqueLons[0],
            east: uniqueLons[uniqueLons.length - 1],
            totalHours,
        };
    } catch (e) {
        console.warn('[WindField] Failed to fetch wind grid:', e);
        return null;
    }
}

/**
 * Encode a single hour's U/V data into a Uint8Array suitable for a WebGL RGBA texture.
 *
 * Encoding:
 *   R = U component: (u + MAX_SPEED) / (2 * MAX_SPEED) * 255
 *   G = V component: (v + MAX_SPEED) / (2 * MAX_SPEED) * 255
 *   B = scalar speed: speed / MAX_SPEED * 255
 *   A = 255
 *
 * The shader decodes with:
 *   u = texel.r * 2.0 * MAX_SPEED - MAX_SPEED
 *   v = texel.g * 2.0 * MAX_SPEED - MAX_SPEED
 *   speed = texel.b * MAX_SPEED
 */
export function encodeWindTexture(grid: WindGrid, hour: number): Uint8Array {
    const h = Math.min(hour, grid.totalHours - 1);
    const uData = grid.u[h];
    const vData = grid.v[h];
    const sData = grid.speed[h];
    const size = grid.width * grid.height;
    const rgba = new Uint8Array(size * 4);

    for (let i = 0; i < size; i++) {
        const u = uData[i];
        const v = vData[i];
        const s = sData[i];

        rgba[i * 4 + 0] = Math.round(Math.max(0, Math.min(255, ((u + MAX_SPEED) / (2 * MAX_SPEED)) * 255)));
        rgba[i * 4 + 1] = Math.round(Math.max(0, Math.min(255, ((v + MAX_SPEED) / (2 * MAX_SPEED)) * 255)));
        rgba[i * 4 + 2] = Math.round(Math.max(0, Math.min(255, (s / MAX_SPEED) * 255)));
        rgba[i * 4 + 3] = 255;
    }

    return rgba;
}

// ── Global Wind Grid ──────────────────────────────────────────────

const GLOBAL_GRID_HOURS = 24;  // Fewer hours for global (keeps response small)
const GLOBAL_CACHE_TTL = 10 * 60 * 1000; // 10 minutes

let globalCache: { grid: WindGrid; fetchedAt: number } | null = null;
let globalFetchInProgress: Promise<WindGrid | null> | null = null;

/**
 * Fetch a global wind grid covering the entire Earth.
 *
 * Uses ~5° resolution (37 lat × 73 lon = 2,701 points).
 * Batches into chunks of 50 to stay within Open-Meteo free API limits.
 * Results are cached for 10 minutes.
 */
export async function fetchGlobalWindField(): Promise<WindGrid | null> {
    // Return cached if fresh
    if (globalCache && Date.now() - globalCache.fetchedAt < GLOBAL_CACHE_TTL) {
        console.log('[WindField] Returning cached global grid');
        return globalCache.grid;
    }

    // Deduplicate concurrent fetches
    if (globalFetchInProgress) return globalFetchInProgress;

    globalFetchInProgress = _doFetchGlobal();
    try {
        return await globalFetchInProgress;
    } finally {
        globalFetchInProgress = null;
    }
}

async function _doFetchGlobal(): Promise<WindGrid | null> {
    try {
        // Use the NOAA GRIB edge function for dense global coverage (1° grid)
        const supabaseUrl =
            (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) || '';
        const supabaseKey =
            (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_KEY) || '';

        if (!supabaseUrl) {
            console.warn('[WindField] No Supabase URL — falling back to Open-Meteo');
            return _doFetchGlobalOpenMeteo();
        }

        const url = `${supabaseUrl}/functions/v1/fetch-wind-grid`;
        const body = { north: 90, south: -90, east: 180, west: -180 };

        console.log('[WindField] Fetching global grid via NOAA GRIB edge function...');

        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(supabaseKey ? { Authorization: `Bearer ${supabaseKey}` } : {}),
            },
            body: JSON.stringify(body),
        });

        if (!resp.ok) {
            console.warn(`[WindField] GRIB edge function failed: ${resp.status}, falling back to Open-Meteo`);
            return _doFetchGlobalOpenMeteo();
        }

        const buffer = await resp.arrayBuffer();
        if (buffer.byteLength < 200) {
            console.warn('[WindField] GRIB response too small, falling back to Open-Meteo');
            return _doFetchGlobalOpenMeteo();
        }

        // Dynamically import the GRIB2 decoder
        const { decodeGrib2Wind } = await import('./decodeGrib2Wind');
        const grib = decodeGrib2Wind(buffer);

        // Convert decoded GRIB2 into WindGrid format (single timestep)
        const width = grib.width;
        const height = grib.height;
        const size = width * height;

        // Build lat/lon arrays from bounds
        const uniqueLats: number[] = [];
        const uniqueLons: number[] = [];
        const latStep = (grib.north - grib.south) / (height - 1);
        const lonStep = (grib.east - grib.west) / (width - 1);
        for (let r = 0; r < height; r++) uniqueLats.push(grib.south + r * latStep);
        for (let c = 0; c < width; c++) uniqueLons.push(grib.west + c * lonStep);

        // Compute speed from U/V
        const speedArr = new Float32Array(size);
        for (let i = 0; i < size; i++) {
            speedArr[i] = Math.sqrt(grib.u[i] * grib.u[i] + grib.v[i] * grib.v[i]);
        }

        const grid: WindGrid = {
            u: [grib.u],
            v: [grib.v],
            speed: [speedArr],
            width,
            height,
            lats: uniqueLats,
            lons: uniqueLons,
            north: grib.north,
            south: grib.south,
            west: grib.west,
            east: grib.east,
            totalHours: 1,
        };

        globalCache = { grid, fetchedAt: Date.now() };
        console.log(`[WindField] Global GRIB grid ready: ${width}×${height} (${buffer.byteLength} bytes)`);
        return grid;
    } catch (e) {
        console.warn('[WindField] Global GRIB fetch failed, falling back to Open-Meteo:', e);
        return _doFetchGlobalOpenMeteo();
    }
}

/** Fallback: Open-Meteo global fetch (5° resolution, 55 API calls). */
async function _doFetchGlobalOpenMeteo(): Promise<WindGrid | null> {
    try {
        const RES = 5;
        const LAT_MIN = -85;
        const LAT_MAX = 85;
        const LON_MIN = -180;
        const LON_MAX = 180;

        const uniqueLats: number[] = [];
        const uniqueLons: number[] = [];
        for (let lat = LAT_MIN; lat <= LAT_MAX; lat += RES) uniqueLats.push(lat);
        for (let lon = LON_MIN; lon <= LON_MAX; lon += RES) uniqueLons.push(lon);

        const rows = uniqueLats.length;
        const cols = uniqueLons.length;

        const allPoints: { lat: number; lon: number }[] = [];
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                allPoints.push({ lat: uniqueLats[r], lon: uniqueLons[c] });
            }
        }

        console.log(`[WindField] Fetching global grid via Open-Meteo: ${rows}×${cols} = ${allPoints.length} points`);

        const BATCH_SIZE = 50;
        const allResults: any[] = new Array(allPoints.length).fill(null);

        const omKey = getOpenMeteoKey();
        const baseUrl = omKey
            ? 'https://customer-api.open-meteo.com/v1/forecast'
            : 'https://api.open-meteo.com/v1/forecast';
        const keyParam = omKey ? `&apikey=${omKey}` : '';

        const batches: { start: number; end: number }[] = [];
        for (let i = 0; i < allPoints.length; i += BATCH_SIZE) {
            batches.push({ start: i, end: Math.min(i + BATCH_SIZE, allPoints.length) });
        }

        const CONCURRENCY = 4;
        for (let b = 0; b < batches.length; b += CONCURRENCY) {
            const chunk = batches.slice(b, b + CONCURRENCY);
            const promises = chunk.map(async ({ start, end }) => {
                const batchPoints = allPoints.slice(start, end);
                const latParam = batchPoints.map(p => p.lat).join(',');
                const lonParam = batchPoints.map(p => p.lon).join(',');

                const url = `${baseUrl}?latitude=${latParam}&longitude=${lonParam}&hourly=wind_speed_10m,wind_direction_10m&forecast_hours=${GLOBAL_GRID_HOURS}&timezone=auto${keyParam}`;

                const response = await fetch(url);
                if (!response.ok) {
                    console.warn(`[WindField] Global batch failed: HTTP ${response.status}`);
                    return;
                }

                const data = await response.json();
                const results = Array.isArray(data) ? data : [data];

                for (let i = 0; i < results.length; i++) {
                    allResults[start + i] = results[i];
                }
            });

            await Promise.all(promises);
        }

        const validCount = allResults.filter(r => r?.hourly).length;
        if (validCount < allPoints.length * 0.5) {
            console.warn(`[WindField] Global grid too sparse: ${validCount}/${allPoints.length} valid`);
            return null;
        }

        const firstValid = allResults.find(r => r?.hourly?.wind_speed_10m);
        const totalHours = firstValid?.hourly?.wind_speed_10m?.length ?? GLOBAL_GRID_HOURS;

        const uGrids: Float32Array[] = [];
        const vGrids: Float32Array[] = [];
        const speedGrids: Float32Array[] = [];

        for (let h = 0; h < totalHours; h++) {
            const uArr = new Float32Array(rows * cols);
            const vArr = new Float32Array(rows * cols);
            const sArr = new Float32Array(rows * cols);

            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const idx = r * cols + c;
                    const hourly = allResults[idx]?.hourly;

                    const speedKmh = hourly?.wind_speed_10m?.[h] ?? 0;
                    const dirDeg = hourly?.wind_direction_10m?.[h] ?? 0;

                    const speedMs = speedKmh / 3.6;
                    const dirRad = dirDeg * Math.PI / 180;

                    const u = -speedMs * Math.sin(dirRad);
                    const v = -speedMs * Math.cos(dirRad);

                    uArr[idx] = u;
                    vArr[idx] = v;
                    sArr[idx] = speedMs;
                }
            }

            uGrids.push(uArr);
            vGrids.push(vArr);
            speedGrids.push(sArr);
        }

        const grid: WindGrid = {
            u: uGrids,
            v: vGrids,
            speed: speedGrids,
            width: cols,
            height: rows,
            lats: uniqueLats,
            lons: uniqueLons,
            north: LAT_MAX,
            south: LAT_MIN,
            west: LON_MIN,
            east: LON_MAX,
            totalHours,
        };

        globalCache = { grid, fetchedAt: Date.now() };
        console.log(`[WindField] Global grid ready: ${cols}×${rows}, ${totalHours}h, ${validCount} valid points`);
        return grid;
    } catch (e) {
        console.warn('[WindField] Global Open-Meteo fetch failed:', e);
        return null;
    }
}

export { MAX_SPEED, WIND_FIELD_HOURS, GLOBAL_GRID_HOURS };
