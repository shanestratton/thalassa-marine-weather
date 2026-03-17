/**
 * BathymetryCache — Preloads depth data for a route's bounding box.
 *
 * Instead of making individual HTTP calls for each isochrone node,
 * this downloads the ENTIRE route area in ONE request via the gebco-depth
 * edge function (which proxies to NOAA ETOPO ERDDAP server-side, avoiding CORS).
 *
 * Resolution: 0.1° (6 arcminutes, ~6 NM) — catches narrow islands and straits.
 * Typical payload: ~3000–8000 grid points for a continental route.
 */

const getSupabaseUrl = (): string =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_SUPABASE_URL) || '';
const getSupabaseKey = (): string =>
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (typeof import.meta !== 'undefined' && (import.meta as any).env?.VITE_SUPABASE_KEY) || '';

import { createLogger } from '../utils/createLogger';

const log = createLogger('BathymetryCache');

const GRID_STRIDE = 6; // 6 arcminutes = 0.1° per cell (catches narrow islands like Fraser)
const BASE_PADDING_DEG = 3; // Minimum padding around route bbox

export interface BathymetryGrid {
    south: number;
    north: number;
    west: number;
    east: number;
    latStep: number; // degrees per row
    lonStep: number; // degrees per col
    rows: number;
    cols: number;
    data: Float32Array; // depth values (negative = underwater)
}

/**
 * Preload bathymetry for a route bounding box via the gebco-depth edge function.
 */
export async function preloadBathymetry(
    origin: { lat: number; lon: number },
    destination: { lat: number; lon: number },
    strideOverride?: number,
): Promise<BathymetryGrid | null> {
    // Scale padding with route distance — ultra-long routes need room to navigate around coastlines
    const latSpan = Math.abs(origin.lat - destination.lat);
    const lonSpan = Math.abs(origin.lon - destination.lon);
    const routeSpanDeg = Math.max(latSpan, lonSpan);
    const paddingDeg = Math.min(10, BASE_PADDING_DEG + routeSpanDeg * 0.2);

    const south = Math.max(-90, Math.min(origin.lat, destination.lat) - paddingDeg);
    const north = Math.min(90, Math.max(origin.lat, destination.lat) + paddingDeg);
    const west = Math.min(origin.lon, destination.lon) - paddingDeg;
    const east = Math.max(origin.lon, destination.lon) + paddingDeg;

    console.info(
        `[BathyCache] Preloading ${south.toFixed(1)}–${north.toFixed(1)}°N, ${west.toFixed(1)}–${east.toFixed(1)}°E`,
    );
    const t0 = performance.now();

    try {
        const supabaseUrl = getSupabaseUrl();
        const supabaseKey = getSupabaseKey();
        const url = `${supabaseUrl}/functions/v1/gebco-depth`;

        const resp = await fetch(url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                ...(supabaseKey ? { Authorization: `Bearer ${supabaseKey}` } : {}),
            },
            body: JSON.stringify({
                bbox: {
                    south: parseFloat(south.toFixed(4)),
                    north: parseFloat(north.toFixed(4)),
                    west: parseFloat(west.toFixed(4)),
                    east: parseFloat(east.toFixed(4)),
                    stride: strideOverride ?? GRID_STRIDE,
                },
            }),
            signal: AbortSignal.timeout(30_000),
        });

        if (!resp.ok) {
            log.warn(`Edge function returned ${resp.status}`);
            return null;
        }

        const data = await resp.json();

        // The edge function returns: { grid: { table: { columnNames, rows } }, elapsed_ms }
        const table = data?.grid?.table;
        if (!table?.rows?.length) {
            log.warn('Empty response from edge function');
            return null;
        }

        // Parse the rows to build a grid
        const colNames = table.columnNames as string[];
        const latIdx = colNames.indexOf('latitude');
        const lonIdx = colNames.indexOf('longitude');
        const zIdx = colNames.indexOf('altitude');

        if (latIdx < 0 || lonIdx < 0 || zIdx < 0) {
            log.warn('Missing columns:', colNames);
            return null;
        }

        const rows = table.rows as (number | null)[][];

        // Extract unique lat/lon values to determine grid dimensions
        const lats = new Set<number>();
        const lons = new Set<number>();
        for (const row of rows) {
            if (row[latIdx] != null) lats.add(row[latIdx] as number);
            if (row[lonIdx] != null) lons.add(row[lonIdx] as number);
        }

        const sortedLats = [...lats].sort((a, b) => a - b);
        const sortedLons = [...lons].sort((a, b) => a - b);

        if (sortedLats.length < 2 || sortedLons.length < 2) {
            log.warn('Insufficient grid dimensions');
            return null;
        }

        const gridRows = sortedLats.length;
        const gridCols = sortedLons.length;
        const latStep = (sortedLats[sortedLats.length - 1] - sortedLats[0]) / (gridRows - 1);
        const lonStep = (sortedLons[sortedLons.length - 1] - sortedLons[0]) / (gridCols - 1);

        const gridData = new Float32Array(gridRows * gridCols);
        gridData.fill(NaN);

        // Map lat/lon to grid indices
        const latMap = new Map<number, number>();
        sortedLats.forEach((v, i) => latMap.set(v, i));
        const lonMap = new Map<number, number>();
        sortedLons.forEach((v, i) => lonMap.set(v, i));

        for (const row of rows) {
            const lat = row[latIdx] as number;
            const lon = row[lonIdx] as number;
            const z = row[zIdx];
            const ri = latMap.get(lat);
            const ci = lonMap.get(lon);
            if (ri != null && ci != null) {
                gridData[ri * gridCols + ci] = z != null ? z : NaN;
            }
        }

        const grid: BathymetryGrid = {
            south: sortedLats[0],
            north: sortedLats[sortedLats.length - 1],
            west: sortedLons[0],
            east: sortedLons[sortedLons.length - 1],
            latStep,
            lonStep,
            rows: gridRows,
            cols: gridCols,
            data: gridData,
        };

        const dt = Math.round(performance.now() - t0);
        log.info(`✓ Loaded ${gridRows}×${gridCols} grid (${rows.length} points) in ${dt}ms`);

        return grid;
    } catch (err) {
        log.warn('Failed to preload:', err);
        return null;
    }
}

/**
 * Fast local depth lookup from a preloaded bathymetry grid.
 * Returns depth in meters (negative = underwater, positive = land).
 */
export function getDepthFromCache(grid: BathymetryGrid, lat: number, lon: number): number | null {
    if (lat < grid.south || lat > grid.north || lon < grid.west || lon > grid.east) {
        return null;
    }

    const ri = Math.round((lat - grid.south) / grid.latStep);
    const ci = Math.round((lon - grid.west) / grid.lonStep);

    if (ri < 0 || ri >= grid.rows || ci < 0 || ci >= grid.cols) {
        return null;
    }

    const val = grid.data[ri * grid.cols + ci];
    return isNaN(val) ? null : val;
}

/**
 * Check if a point is on land using the cached bathymetry grid.
 *
 * CONSERVATIVE: checks the 2×2 grid cell neighbourhood around the point.
 * If ANY of the 4 surrounding cells is land (depth ≥ 0), reports land.
 * This catches narrow peninsulas, spits, and islands that fall between
 * grid cell centres — the main cause of routes clipping land.
 */
export function isLand(grid: BathymetryGrid, lat: number, lon: number): boolean {
    if (lat < grid.south || lat > grid.north || lon < grid.west || lon > grid.east) {
        return false; // Out of grid — assume water
    }

    // Fractional grid indices
    const fi = (lat - grid.south) / grid.latStep;
    const fj = (lon - grid.west) / grid.lonStep;

    // The 4 surrounding cell indices
    const i0 = Math.floor(fi);
    const j0 = Math.floor(fj);
    const i1 = Math.min(i0 + 1, grid.rows - 1);
    const j1 = Math.min(j0 + 1, grid.cols - 1);

    // If ANY surrounding cell is land, classify as land (conservative)
    for (const ri of [i0, i1]) {
        for (const ci of [j0, j1]) {
            if (ri < 0 || ri >= grid.rows || ci < 0 || ci >= grid.cols) continue;
            const val = grid.data[ri * grid.cols + ci];
            if (!isNaN(val) && val >= 0) return true;
        }
    }
    return false;
}
