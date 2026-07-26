/**
 * Keep longitude samples on the same continuous world copy as a WindGrid.
 *
 * Map and routing coordinates normally use -180…180, but a viewport grid
 * that crosses the International Date Line deliberately keeps an unwrapped
 * axis such as 179…181. Sampling -179 against that grid must therefore mean
 * 181, not a point far outside its western edge.
 */
export function continuousEastForLongitudeRange(west: number, east: number): number {
    let result = east;
    while (result < west) result += 360;
    return result;
}

export function continuousLongitudeInGrid(longitude: number, west: number, east: number): number {
    if (!Number.isFinite(longitude) || !Number.isFinite(west) || !Number.isFinite(east)) return longitude;

    const continuousEast = continuousEastForLongitudeRange(west, east);
    const center = (west + continuousEast) / 2;
    // Pick the congruent longitude closest to the grid's centre. This works
    // for both conventional grids (-180…180) and either adjacent world copy.
    return longitude + Math.round((center - longitude) / 360) * 360;
}
