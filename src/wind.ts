/**
 * Wind grid for the Voyage Log map overlay.
 *
 * Pulls a coarse grid of current wind vectors from Open-Meteo (free, no
 * key, already in CSP) for a given bounding box. The WindParticleLayer
 * canvas overlay samples this grid via bilinear interpolation and drifts
 * its particles along the resulting field.
 */

export interface WindSample {
    lat: number;
    lon: number;
    /** Eastward wind component (m/s). */
    u: number;
    /** Northward wind component (m/s). */
    v: number;
    /** Wind speed (m/s). */
    speed: number;
}

export interface WindGrid {
    samples: WindSample[]; // row-major, length = rows * cols
    rows: number;
    cols: number;
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
}

interface Bounds {
    minLat: number;
    minLon: number;
    maxLat: number;
    maxLon: number;
}

/**
 * Fetch a `rows × cols` grid of wind vectors covering the given bounds.
 * Returns null if the request fails — the layer just disappears, the
 * rest of the page keeps working.
 */
export async function fetchWindGrid(bounds: Bounds, rows = 6, cols = 6): Promise<WindGrid | null> {
    const lats: number[] = [];
    const lons: number[] = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            const lat = bounds.minLat + (bounds.maxLat - bounds.minLat) * (r / Math.max(1, rows - 1));
            const lon = bounds.minLon + (bounds.maxLon - bounds.minLon) * (c / Math.max(1, cols - 1));
            lats.push(Number(lat.toFixed(4)));
            lons.push(Number(lon.toFixed(4)));
        }
    }

    const url =
        `https://api.open-meteo.com/v1/forecast` +
        `?latitude=${lats.join(',')}` +
        `&longitude=${lons.join(',')}` +
        `&current=wind_speed_10m,wind_direction_10m` +
        `&wind_speed_unit=ms`;

    let res: Response;
    try {
        res = await fetch(url);
    } catch {
        return null;
    }
    if (!res.ok) return null;

    let data: unknown;
    try {
        data = await res.json();
    } catch {
        return null;
    }
    // Open-Meteo returns an array when multiple lat/lon are passed, a
    // single object when only one. Normalise.
    const arr = Array.isArray(data) ? data : [data];
    if (arr.length !== lats.length) return null;

    const samples: WindSample[] = arr.map((d, i) => {
        const speed = Number((d as { current?: { wind_speed_10m?: number } }).current?.wind_speed_10m ?? 0);
        const dirDeg = Number((d as { current?: { wind_direction_10m?: number } }).current?.wind_direction_10m ?? 0);
        const dirRad = (dirDeg * Math.PI) / 180;
        // Wind direction is the heading the wind is COMING FROM. The
        // velocity vector points the opposite way.
        const u = -speed * Math.sin(dirRad);
        const v = -speed * Math.cos(dirRad);
        return { lat: lats[i], lon: lons[i], u, v, speed };
    });

    return { samples, rows, cols, ...bounds };
}

/**
 * Bilinear sample of the wind grid at an arbitrary (lat, lon). Returns
 * a zero vector when the point is outside the grid.
 */
export function sampleWind(grid: WindGrid, lat: number, lon: number): { u: number; v: number; speed: number } {
    const { rows, cols, minLat, maxLat, minLon, maxLon, samples } = grid;
    if (lat < minLat || lat > maxLat || lon < minLon || lon > maxLon) {
        return { u: 0, v: 0, speed: 0 };
    }
    const fLat = ((lat - minLat) / (maxLat - minLat)) * (rows - 1);
    const fLon = ((lon - minLon) / (maxLon - minLon)) * (cols - 1);
    const r0 = Math.floor(fLat);
    const r1 = Math.min(rows - 1, r0 + 1);
    const c0 = Math.floor(fLon);
    const c1 = Math.min(cols - 1, c0 + 1);
    const dr = fLat - r0;
    const dc = fLon - c0;
    const idx = (r: number, c: number): number => r * cols + c;
    const s00 = samples[idx(r0, c0)];
    const s01 = samples[idx(r0, c1)];
    const s10 = samples[idx(r1, c0)];
    const s11 = samples[idx(r1, c1)];
    const u = s00.u * (1 - dr) * (1 - dc) + s01.u * (1 - dr) * dc + s10.u * dr * (1 - dc) + s11.u * dr * dc;
    const v = s00.v * (1 - dr) * (1 - dc) + s01.v * (1 - dr) * dc + s10.v * dr * (1 - dc) + s11.v * dr * dc;
    return { u, v, speed: Math.hypot(u, v) };
}
