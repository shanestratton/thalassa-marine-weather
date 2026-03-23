/**
 * Isochrone Router — Land avoidance and hazard detection.
 *
 * Functions for segment/endpoint navigability checks,
 * pushing routes offshore, and nudging waypoints away from land.
 */

import type { BathymetryGrid } from '../BathymetryCache';
import { isLand, getDepthFromCache } from '../BathymetryCache';
import type { IsochroneNode } from './types';
import { haversineNm, initialBearing, projectPosition } from './geodesy';

// ── Hazard minimum depth: reefs, sandbanks, coral below this are rejected ──
const REEF_REJECTION_DEPTH_M = -10; // ETOPO: negative = underwater

/**
 * Combined land + shallow hazard check for a segment.
 * Samples every ~1 NM in a single pass. Returns false if the segment
 * crosses land OR dangerously shallow water (reefs, sandbanks).
 *
 * @param stepDistanceNM  Known distance of this segment (avoids redundant haversine).
 *                        Pass 0 or undefined to auto-calculate via haversine.
 * @param landOnly        If true, only checks for land (not shallow water).
 */
export function isSegmentNavigable(
    grid: BathymetryGrid,
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
    stepDistanceNM?: number,
    landOnly?: boolean,
): boolean {
    // Tighter sampling catches narrow straits and island chains that 2NM missed
    const SAMPLE_SPACING_NM = 1;
    const segDist = stepDistanceNM && stepDistanceNM > 0 ? stepDistanceNM : haversineNm(lat1, lon1, lat2, lon2);

    // Fix 4: Also check destination endpoint (catches narrow spits the interior misses)
    const depthEnd = getDepthFromCache(grid, lat2, lon2);
    if (depthEnd !== null) {
        if (depthEnd >= 0) return false;
        if (!landOnly && depthEnd > REEF_REJECTION_DEPTH_M) return false;
    }

    // Check start point too — a segment originating on land is never navigable
    const depthStart = getDepthFromCache(grid, lat1, lon1);
    if (depthStart !== null) {
        if (depthStart >= 0) return false;
        if (!landOnly && depthStart > REEF_REJECTION_DEPTH_M) return false;
    }

    const numSamples = Math.max(1, Math.floor(segDist / SAMPLE_SPACING_NM));

    // Normalise longitude delta for antimeridian crossings
    let dLon = lon2 - lon1;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;

    for (let i = 1; i <= numSamples; i++) {
        const frac = i / (numSamples + 1);
        const midLat = lat1 + frac * (lat2 - lat1);
        let midLon = lon1 + frac * dLon;
        if (midLon > 180) midLon -= 360;
        else if (midLon < -180) midLon += 360;

        const depth = getDepthFromCache(grid, midLat, midLon);
        if (depth !== null) {
            if (depth >= 0) return false; // Land
            if (!landOnly && depth > REEF_REJECTION_DEPTH_M) return false; // Shallow hazard
        }
    }
    return true;
}

/** Legacy wrapper: returns true if segment crosses land/shallow water */
export function segmentCrossesLand(
    grid: BathymetryGrid,
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
): boolean {
    return !isSegmentNavigable(grid, lat1, lon1, lat2, lon2);
}

/**
 * Check if a point has any land in its immediate neighbourhood (8 adjacent grid cells).
 * Used to detect near-shore positions that should be pushed further offshore.
 */
function hasAdjacentLand(grid: BathymetryGrid, lat: number, lon: number): boolean {
    const step = Math.max(grid.latStep, grid.lonStep);
    for (const dLat of [-step, 0, step]) {
        for (const dLon of [-step, 0, step]) {
            if (dLat === 0 && dLon === 0) continue;
            if (isLand(grid, lat + dLat, lon + dLon)) return true;
        }
    }
    return false;
}

/**
 * Post-process: push segments that clip land offshore.
 *
 * For each segment A→B, if it crosses land, insert intermediate waypoints
 * pushed perpendicular to the segment bearing (towards open water).
 *
 * RECURSIVE SUBDIVISION: For long segments (>100NM) that can't be fixed with
 * a single push, recursively subdivide and push each sub-segment independently.
 *
 * Iterates up to 10 passes over the full route.
 */
export function pushRouteOffshore(route: IsochroneNode[], grid: BathymetryGrid): IsochroneNode[] {
    const MAX_PUSH_NM = 60;
    const MIN_PUSH_NM = 5;
    const MAX_PASSES = 10;
    const MAX_RECURSION = 6; // 2^6 = 64 sub-segments max
    let result = [...route];

    /**
     * Try to fix a single land-crossing segment by pushing a midpoint offshore.
     * Returns the offshore node if successful, null otherwise.
     */
    function tryPushMidpoint(a: IsochroneNode, b: IsochroneNode): IsochroneNode | null {
        const midLat = (a.lat + b.lat) / 2;
        const midLon = (a.lon + b.lon) / 2;
        const segBearing = initialBearing(a.lat, a.lon, b.lat, b.lon);
        const segLen = haversineNm(a.lat, a.lon, b.lat, b.lon);
        const leftBearing = (segBearing - 90 + 360) % 360;
        const rightBearing = (segBearing + 90) % 360;

        // Escalate push distance: 50%, 100%, 150% of segment length
        for (const multiplier of [0.5, 1.0, 1.5]) {
            const pushNM = Math.min(MAX_PUSH_NM, Math.max(MIN_PUSH_NM, segLen * multiplier));
            for (const bearing of [leftBearing, rightBearing]) {
                const pt = projectPosition(midLat, midLon, bearing, pushNM);
                if (
                    !isLand(grid, pt.lat, pt.lon) &&
                    isSegmentNavigable(grid, a.lat, a.lon, pt.lat, pt.lon, 0, true) &&
                    isSegmentNavigable(grid, pt.lat, pt.lon, b.lat, b.lon, 0, true)
                ) {
                    return {
                        lat: pt.lat,
                        lon: pt.lon,
                        timeHours: (a.timeHours + b.timeHours) / 2,
                        bearing: segBearing,
                        speed: (a.speed + b.speed) / 2,
                        tws: (a.tws + b.tws) / 2,
                        twa: (a.twa + b.twa) / 2,
                        parentIndex: null,
                        distance: a.distance + haversineNm(a.lat, a.lon, pt.lat, pt.lon),
                    };
                }
            }
        }
        return null;
    }

    /**
     * Recursively subdivide a land-crossing segment and push each half offshore.
     * Returns an array of intermediate waypoints (excluding a and b themselves).
     */
    function subdivideAndPush(a: IsochroneNode, b: IsochroneNode, depth: number): IsochroneNode[] {
        if (depth >= MAX_RECURSION) return [];
        if (isSegmentNavigable(grid, a.lat, a.lon, b.lat, b.lon, 0, true)) return [];

        // Try a direct push first
        const pushed = tryPushMidpoint(a, b);
        if (pushed) return [pushed];

        // Direct push failed — subdivide at the midpoint
        const midLat = (a.lat + b.lat) / 2;
        const midLon = (a.lon + b.lon) / 2;
        const segBearing = initialBearing(a.lat, a.lon, b.lat, b.lon);
        const leftBearing = (segBearing - 90 + 360) % 360;
        const rightBearing = (segBearing + 90) % 360;
        const segLen = haversineNm(a.lat, a.lon, b.lat, b.lon);

        let midNode: IsochroneNode | null = null;
        for (const mult of [0.3, 0.5, 0.8, 1.0, 1.5]) {
            const pushDist = Math.min(MAX_PUSH_NM, Math.max(MIN_PUSH_NM, segLen * mult));
            for (const brg of [leftBearing, rightBearing]) {
                const pt = projectPosition(midLat, midLon, brg, pushDist);
                if (!isLand(grid, pt.lat, pt.lon)) {
                    midNode = {
                        lat: pt.lat,
                        lon: pt.lon,
                        timeHours: (a.timeHours + b.timeHours) / 2,
                        bearing: segBearing,
                        speed: (a.speed + b.speed) / 2,
                        tws: (a.tws + b.tws) / 2,
                        twa: (a.twa + b.twa) / 2,
                        parentIndex: null,
                        distance: a.distance + haversineNm(a.lat, a.lon, pt.lat, pt.lon),
                    };
                    break;
                }
            }
            if (midNode) break;
        }

        if (!midNode) return []; // Can't find water — give up

        // Recurse on both halves
        const leftFixes = subdivideAndPush(a, midNode, depth + 1);
        const rightFixes = subdivideAndPush(midNode, b, depth + 1);
        return [...leftFixes, midNode, ...rightFixes];
    }

    for (let pass = 0; pass < MAX_PASSES; pass++) {
        const fixed: IsochroneNode[] = [result[0]];
        let didFix = false;

        for (let i = 0; i < result.length - 1; i++) {
            const a = result[i];
            const b = result[i + 1];

            if (!isSegmentNavigable(grid, a.lat, a.lon, b.lat, b.lon, 0, true)) {
                const intermediates = subdivideAndPush(a, b, 0);
                if (intermediates.length > 0) {
                    fixed.push(...intermediates);
                    didFix = true;
                }
            }
            fixed.push(b);
        }

        result = fixed;
        if (!didFix) break;
    }

    return result;
}

/**
 * Eliminate crossing segments caused by sharp U-turns in the backtracked route.
 */
export function eliminateCrossings(route: IsochroneNode[], grid: BathymetryGrid): IsochroneNode[] {
    const MAX_PASSES = 5;
    let result = [...route];

    for (let pass = 0; pass < MAX_PASSES; pass++) {
        if (result.length <= 3) break;
        const toRemove = new Set<number>();

        for (let i = 1; i < result.length - 1; i++) {
            if (toRemove.has(i)) continue;
            const A = result[i - 1];
            const B = result[i];
            const C = result[i + 1];

            const bearingAB = initialBearing(A.lat, A.lon, B.lat, B.lon);
            const bearingBC = initialBearing(B.lat, B.lon, C.lat, C.lon);
            let bearingChange = Math.abs(bearingBC - bearingAB);
            if (bearingChange > 180) bearingChange = 360 - bearingChange;

            // Sharp reversal (>70°) — likely a backtracking zigzag
            if (bearingChange > 70) {
                if (isSegmentNavigable(grid, A.lat, A.lon, C.lat, C.lon, 0, true)) {
                    toRemove.add(i);
                }
            }

            // Short-segment zigzag: if A→B is under 30NM and turn is >50°, remove
            const abDist = haversineNm(A.lat, A.lon, B.lat, B.lon);
            if (abDist < 30 && bearingChange > 50) {
                if (isSegmentNavigable(grid, A.lat, A.lon, C.lat, C.lon, 0, true)) {
                    toRemove.add(i);
                }
            }
        }

        if (toRemove.size === 0) break;
        result = result.filter((_, i) => !toRemove.has(i));
    }

    return result;
}

/**
 * Post-process: nudge individual waypoints that are on or near land further offshore.
 */
export function nudgeWaypointsOffshore(route: IsochroneNode[], grid: BathymetryGrid): IsochroneNode[] {
    if (route.length <= 2) return route;
    const result = [...route];

    for (let i = 1; i < result.length - 1; i++) {
        const node = result[i];
        const onLand = isLand(grid, node.lat, node.lon);
        const nearShore = !onLand && hasAdjacentLand(grid, node.lat, node.lon);

        if (!onLand && !nearShore) continue;

        const prev = result[i - 1];
        const next = result[i + 1];
        const avgBearing = initialBearing(prev.lat, prev.lon, next.lat, next.lon);
        const leftBrg = (avgBearing - 90 + 360) % 360;
        const rightBrg = (avgBearing + 90) % 360;

        let nudged = false;
        for (const pushNM of [5, 10, 15, 20, 30]) {
            for (const brg of [leftBrg, rightBrg]) {
                const pt = projectPosition(node.lat, node.lon, brg, pushNM);
                if (!isLand(grid, pt.lat, pt.lon) && !hasAdjacentLand(grid, pt.lat, pt.lon)) {
                    result[i] = { ...node, lat: pt.lat, lon: pt.lon };
                    nudged = true;
                    break;
                }
            }
            if (nudged) break;
        }
    }

    return result;
}
