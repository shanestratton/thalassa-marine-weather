/** Public relief queries only. No chart data, storage, authentication or network. */
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

/**
 * Check if a point is near shore — has ANY land cell within `radius` grid cells.
 *
 * This provides a safety buffer for routing: the wavefront should stay well
 * clear of coastlines to avoid clipping headlands and peninsulas that the
 * grid resolution can't fully resolve.
 *
 * At stride=10 (0.17° cells), radius=2 ≈ 20 NM buffer, radius=3 ≈ 30 NM.
 * At stride=6 (0.1° cells), radius=3 ≈ 18 NM buffer, radius=4 ≈ 24 NM.
 */
export function isNearShore(grid: BathymetryGrid, lat: number, lon: number, radius: number = 2): boolean {
    if (lat < grid.south || lat > grid.north || lon < grid.west || lon > grid.east) {
        return false; // Out of grid — assume open ocean
    }

    const fi = Math.round((lat - grid.south) / grid.latStep);
    const fj = Math.round((lon - grid.west) / grid.lonStep);

    for (let di = -radius; di <= radius; di++) {
        for (let dj = -radius; dj <= radius; dj++) {
            const ri = fi + di;
            const ci = fj + dj;
            if (ri < 0 || ri >= grid.rows || ci < 0 || ci >= grid.cols) continue;
            const val = grid.data[ri * grid.cols + ci];
            if (!isNaN(val) && val >= 0) return true;
        }
    }
    return false;
}

export function depthCostPenalty(depth: number | null, draft: number): number {
    if (depth === null) return 1.2;
    if (depth >= 0) return Infinity;
    const ratio = Math.abs(depth) / draft;
    return ratio > 3 ? 1 : ratio > 2 ? 1.5 : ratio > 1.5 ? 3 : 10;
}
