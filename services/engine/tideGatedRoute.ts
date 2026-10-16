/** Pure worker path. Its output remains a candidate until the main-thread
 * source permit rereads the exact original intervals and current lifetimes. */
import type { InshoreLayers, NavGrid, RouteFailure, RouteRequest, RouteResult } from './types';
import { buildNavGrid } from './navGrid';
import { applyExclusionField, routeExclusionConflict, exclusionRefusal } from './exclusionField';
import { searchTideGatedCandidate, tideGatedBounds } from './tideGatedSearch';
import { mPerDegLon } from './geometry';
import { M_PER_DEG_LAT } from './constants';

/** Original point measurements can lower area minima; they never create area
 * coverage, lift a blocked cell, clear a hazard or give depth above a band. */
export function applyTideSoundingMinima(
    grid: NavGrid,
    points: readonly { lat: number; lon: number; depthM: number }[],
): void {
    if (points.length > 65536) throw Error('Original sounding set exceeds its vertex bound.');
    for (const point of points) {
        if (![point.lat, point.lon, point.depthM].every(Number.isFinite))
            throw Error('Original sounding depth is unknown.');
        const x = Math.floor((point.lon - grid.minLon) / grid.dLon),
            y = Math.floor((point.lat - grid.minLat) / grid.dLat);
        // Conservative one-cell halo: a point never supplies new positive
        // coverage, while its lower depth can invalidate a nearby bank cell.
        for (let dy = -1; dy <= 1; dy++)
            for (let dx = -1; dx <= 1; dx++) {
                const nx = x + dx,
                    ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
                const i = ny * grid.width + nx;
                if (!Number.isFinite(grid.cells[i]) || grid.exclusionBlocked?.[i]) continue;
                if (point.depthM <= 0) {
                    grid.cells[i] = NaN;
                    continue;
                }
                const previous = grid.shallowDepthM?.[i];
                const areaDepth = Number.isFinite(previous)
                    ? Math.min(previous!, grid.cells[i] > 0 ? grid.cells[i] : Infinity)
                    : grid.cells[i] > 0
                      ? grid.cells[i]
                      : NaN;
                if (!Number.isFinite(areaDepth) || areaDepth <= 0) continue;
                if (grid.shallowDepthM) grid.shallowDepthM[i] = Math.min(areaDepth, point.depthM);
                if (grid.cells[i] >= 0) grid.cells[i] = Math.min(grid.cells[i], point.depthM);
            }
    }
}

export function routeTideGatedCandidate(layers: InshoreLayers, req: RouteRequest): RouteResult | RouteFailure {
    const r = req._tideCandidate;
    const no = (error: string): RouteFailure => ({ error, code: 'tide-window-unavailable' });
    if (
        !r?.enabled ||
        r.from.lat !== req.fromLat ||
        r.from.lon !== req.fromLon ||
        r.to.lat !== req.toLat ||
        r.to.lon !== req.toLon ||
        r.requiredM !== req.draftM + (req.safetyM ?? 0.5) ||
        req.tideCeilings?.length ||
        req.tideBarriers?.length
    )
        return no('The exact tide candidate request does not match this strict chart route.');
    const bounds = tideGatedBounds(r.from, r.to);
    if (!bounds || !req._exclusionField) return no('Current complete chart bounds or exclusions are missing.');
    try {
        const widthM = (bounds[2] - bounds[0]) * mPerDegLon((bounds[1] + bounds[3]) / 2),
            heightM = (bounds[3] - bounds[1]) * M_PER_DEG_LAT;
        let resolution = Math.max(50, Math.ceil(Math.sqrt((widthM * heightM) / 2500000)));
        while (Math.ceil(widthM / resolution) * Math.ceil(heightM / resolution) > 2500000) resolution++;
        // No count-key cache, tide ceiling, canal/lead rescue, endpoint snap or
        // component carve participates in this independently qualified path.
        const base = buildNavGrid(
            layers,
            [...bounds],
            resolution,
            req.draftM,
            req.safetyM ?? 0.5,
            req.obstructionBufferM ?? 60,
            false,
            [],
            'safest',
            [],
            [],
        );
        const grid = applyExclusionField(base, req._exclusionField);
        applyTideSoundingMinima(grid, r.soundings ?? []);
        const candidate = searchTideGatedCandidate(grid, r);
        if (candidate.kind !== 'candidate')
            return no(candidate.kind === 'held' ? candidate.reason : 'Tide candidate is off.');
        if (candidate.path.points.length > 8192)
            return no('The complete tide route exceeds the existing final-line audit bound.');
        const conflict = routeExclusionConflict(candidate.path.points, req._exclusionField);
        if (conflict) return { error: exclusionRefusal(conflict), code: 'route-exclusion' };
        const tideCells = new Set(candidate.path.tideCells);
        const cautionMask = candidate.path.indices.slice(1).map((b, i) => {
            const a = candidate.path.indices[i];
            return (
                tideCells.has(a) ||
                tideCells.has(b) ||
                (a % grid.width !== b % grid.width &&
                    Math.floor(a / grid.width) !== Math.floor(b / grid.width) &&
                    (tideCells.has(Math.floor(a / grid.width) * grid.width + (b % grid.width)) ||
                        tideCells.has(Math.floor(b / grid.width) * grid.width + (a % grid.width))))
            );
        });
        return {
            polyline: candidate.path.points.map((p) => [p[0], p[1]]),
            distanceNM: candidate.path.distanceM / 1852,
            gridSize: { width: grid.width, height: grid.height },
            bbox: [...bounds],
            channelMask: candidate.path.points.slice(1).map(() => true),
            cautionMask,
            _tideCandidatePath: candidate.path,
        };
    } catch (error) {
        return no(error instanceof Error ? error.message : 'The full tide candidate grid is unavailable.');
    }
}
