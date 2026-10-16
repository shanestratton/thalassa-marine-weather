import type { NavGrid } from './types';
import { bresenhamCells } from './geometry';
import { validTrackCoordinate, trackSegmentDistanceM, type TrackRoutePoint } from '../routing/trackRouteDraft';

export interface TrackRoutingPrior {
    source: 'own-track' | 'approved-community';
    approval?: 'approved';
    points: readonly TrackRoutePoint[];
}
export const TRACK_PRIOR_MIN_FACTOR = 0.9;
/** Cost hint only: never alter any cell's depth, preferred status, masks or reachability. */
export function applyTrackPriors(
    grid: NavGrid,
    priors: readonly TrackRoutingPrior[] | undefined,
    requiredM: number,
): void {
    delete grid.trackPrior;
    delete grid.trackPriorRequiredM;
    if (!Array.isArray(priors) || !priors.length || priors.length > 12 || !Number.isFinite(requiredM) || requiredM <= 0)
        return;
    if (
        priors.some(
            (p) =>
                !p ||
                !Array.isArray(p.points) ||
                p.points.length < 2 ||
                p.points.length > 512 ||
                !p.points.every(validTrackCoordinate),
        ) ||
        priors.reduce((n, p) => n + p.points.length, 0) > 4096
    )
        return;
    const w = grid.width,
        h = grid.height,
        cellM = Math.min(
            grid.dLat * 111_320,
            grid.dLon * 111_320 * Math.cos(((grid.minLat + (h * grid.dLat) / 2) * Math.PI) / 180),
        );
    if (!Number.isFinite(cellM) || cellM < 5 || w * h > 2_000_000) return;
    const mask = new Uint8Array(w * h),
        brush = Math.min(12, Math.ceil(60 / cellM) + 1);
    let operations = 0;
    for (const prior of priors) {
        const flag =
            prior.source === 'own-track'
                ? 2
                : prior.source === 'approved-community' && prior.approval === 'approved'
                  ? 1
                  : 0;
        if (!flag) continue;
        for (let i = 1; i < prior.points.length; i++) {
            const a = prior.points[i - 1],
                b = prior.points[i];
            if (
                Math.abs(a.lon - b.lon) > 180 ||
                Math.hypot(
                    (a.lon - b.lon) * 111_320 * Math.cos(((a.lat + b.lat) * Math.PI) / 360),
                    (a.lat - b.lat) * 111_320,
                ) >
                    5 * 1852
            )
                continue;
            const ax = Math.floor((a.lon - grid.minLon) / grid.dLon),
                ay = Math.floor((a.lat - grid.minLat) / grid.dLat),
                bx = Math.floor((b.lon - grid.minLon) / grid.dLon),
                by = Math.floor((b.lat - grid.minLat) / grid.dLat);
            if (
                Math.max(ax, bx) < -brush ||
                Math.min(ax, bx) >= w + brush ||
                Math.max(ay, by) < -brush ||
                Math.min(ay, by) >= h + brush ||
                Math.max(Math.abs(ax - bx), Math.abs(ay - by)) > 20_000
            )
                continue;
            for (const p of bresenhamCells(ax, ay, bx, by))
                for (let y = Math.max(0, p.y - brush); y <= Math.min(h - 1, p.y + brush); y++)
                    for (let x = Math.max(0, p.x - brush); x <= Math.min(w - 1, p.x + brush); x++) {
                        if (++operations > 2_000_000) return;
                        const idx = y * w + x,
                            depth = grid.cells[idx];
                        if (
                            mask[idx] >= flag ||
                            !Number.isFinite(depth) ||
                            depth < requiredM ||
                            depth <= 0 ||
                            grid.preferred[idx] ||
                            grid.landBlocked?.[idx] ||
                            grid.berthBlocked?.[idx]
                        )
                            continue;
                        if (
                            trackSegmentDistanceM(
                                { lat: grid.minLat + (y + 0.5) * grid.dLat, lon: grid.minLon + (x + 0.5) * grid.dLon },
                                a,
                                b,
                            ) <= 60
                        )
                            mask[idx] = flag;
                    }
        }
    }
    if (mask.some(Boolean)) {
        grid.trackPrior = mask;
        grid.trackPriorRequiredM = requiredM;
    }
}
/** Recheck hard admission when consumed; malformed factors cannot discount masked/unknown water. */
export function trackPriorFactor(grid: NavGrid, index: number): number {
    if (!grid.trackPrior) return 1;
    if (
        !(grid.cells[index] > 0) ||
        !Number.isFinite(grid.cells[index]) ||
        !Number.isFinite(grid.trackPriorRequiredM) ||
        grid.cells[index] < grid.trackPriorRequiredM! ||
        grid.preferred[index] ||
        grid.landBlocked?.[index] ||
        grid.berthBlocked?.[index]
    )
        return 1;
    return grid.trackPrior?.[index] === 2 ? TRACK_PRIOR_MIN_FACTOR : grid.trackPrior?.[index] === 1 ? 0.95 : 1;
}
