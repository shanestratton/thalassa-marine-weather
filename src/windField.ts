/**
 * Wind field for the public map — a grid the WebGL particle engine
 * (WindGLEngine, shared with the app's charts page) advects to draw the
 * flowing wind animation.
 *
 * Source: Open-Meteo's FREE endpoint (no key, already CSP-allowed on the
 * logs page). Fetched client-side from the viewer's browser, so it costs us
 * nothing server-side. Returns the exact WindGrid shape the engine expects
 * — same row order (south→north) and u/v convention as the app's own
 * services/weather/windField.ts, so the render matches the charts page.
 */

import type { WindGrid } from '../services/weather/windGridEncoding';

const MAX_AXIS = 18; // grid points per axis (GPU bilinear-interpolates between)
const MIN_STEP = 0.2; // degrees — don't oversample a tiny view

export async function fetchWindGridForBounds(
    north: number,
    south: number,
    west: number,
    east: number,
): Promise<WindGrid | null> {
    // Build a regular lat/lon grid over the view.
    const latSpan = Math.max(0.001, north - south);
    const lonSpan = Math.max(0.001, east - west);
    const latStep = Math.max(MIN_STEP, latSpan / (MAX_AXIS - 1));
    const lonStep = Math.max(MIN_STEP, lonSpan / (MAX_AXIS - 1));

    const lats: number[] = [];
    for (let lat = south; lat <= north + 1e-6; lat += latStep) lats.push(+lat.toFixed(3));
    const lons: number[] = [];
    for (let lon = west; lon <= east + 1e-6; lon += lonStep) lons.push(+lon.toFixed(3));
    if (lats.length < 3 || lons.length < 3) return null;

    const rows = lats.length;
    const cols = lons.length;

    // Row-major point list (row = lat south→north, col = lon west→east) so the
    // response array aligns to idx = r*cols + c.
    const ptLats: number[] = [];
    const ptLons: number[] = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            ptLats.push(lats[r]);
            ptLons.push(lons[c]);
        }
    }

    const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${ptLats.join(',')}` +
        `&longitude=${ptLons.join(',')}` +
        `&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=ms`;

    let results: Record<string, unknown>[];
    try {
        const res = await fetch(url);
        if (!res.ok) return null;
        const data: unknown = await res.json();
        results = (Array.isArray(data) ? data : [data]) as Record<string, unknown>[];
    } catch {
        return null;
    }

    const size = rows * cols;
    const uArr = new Float32Array(size);
    const vArr = new Float32Array(size);
    const sArr = new Float32Array(size);

    for (let i = 0; i < size; i++) {
        const cur = results[i]?.current as Record<string, unknown> | undefined;
        const speedMs = typeof cur?.wind_speed_10m === 'number' ? (cur.wind_speed_10m as number) : 0;
        const dirDeg = typeof cur?.wind_direction_10m === 'number' ? (cur.wind_direction_10m as number) : 0;
        const dirRad = (dirDeg * Math.PI) / 180;
        // Meteorological: direction is where wind blows FROM. u=+east, v=+north
        // of the vector the wind blows TO.
        uArr[i] = -speedMs * Math.sin(dirRad);
        vArr[i] = -speedMs * Math.cos(dirRad);
        sArr[i] = speedMs;
    }

    return {
        u: [uArr],
        v: [vArr],
        speed: [sArr],
        width: cols,
        height: rows,
        lats,
        lons,
        north: lats[rows - 1],
        south: lats[0],
        west: lons[0],
        east: lons[cols - 1],
        totalHours: 1,
    };
}
