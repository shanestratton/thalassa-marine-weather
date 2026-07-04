/**
 * Wind field for the public map — a coarse grid of barbs around the boat.
 *
 * Source: Open-Meteo (free, no API key, and already allow-listed in the
 * logs page CSP). Fetched client-side from the viewer's browser, so it
 * costs us nothing server-side. One request covers the whole grid —
 * Open-Meteo accepts comma-separated latitude/longitude lists and returns
 * an array of forecasts aligned to them.
 */

export interface WindSample {
    lat: number;
    lon: number;
    speedKt: number;
    /** Direction the wind blows FROM, degrees true (meteorological). */
    dirDeg: number;
}

const GRID_N = 6; // GRID_N × GRID_N barbs
const SPAN_DEG = 3; // total lat/lon span of the grid (~180 nm)

export async function fetchWindGrid(centerLat: number, centerLon: number): Promise<WindSample[]> {
    const step = SPAN_DEG / (GRID_N - 1);
    const lats: number[] = [];
    const lons: number[] = [];
    for (let i = 0; i < GRID_N; i++) {
        for (let j = 0; j < GRID_N; j++) {
            lats.push(+(centerLat - SPAN_DEG / 2 + i * step).toFixed(4));
            lons.push(+(centerLon - SPAN_DEG / 2 + j * step).toFixed(4));
        }
    }
    const url =
        `https://api.open-meteo.com/v1/forecast?latitude=${lats.join(',')}` +
        `&longitude=${lons.join(',')}` +
        `&current=wind_speed_10m,wind_direction_10m&wind_speed_unit=kn`;

    const res = await fetch(url);
    if (!res.ok) throw new Error(`wind fetch failed: ${res.status}`);
    const data: unknown = await res.json();
    // Multi-location responses come back as an array; a single location
    // would be one object — normalise to an array either way.
    const arr = Array.isArray(data) ? data : [data];

    const out: WindSample[] = [];
    for (const f of arr as Record<string, unknown>[]) {
        const lat = f.latitude;
        const lon = f.longitude;
        const cur = f.current as Record<string, unknown> | undefined;
        const spd = cur?.wind_speed_10m;
        const dir = cur?.wind_direction_10m;
        if (typeof lat === 'number' && typeof lon === 'number' && typeof spd === 'number' && typeof dir === 'number') {
            out.push({ lat, lon, speedKt: spd, dirDeg: dir });
        }
    }
    return out;
}
