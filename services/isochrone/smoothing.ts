/**
 * Isochrone Router — Route smoothing and backtracking.
 *
 * Douglas-Peucker simplification with land-aware constraints,
 * and backtracking from arrival node through isochrone chain.
 */

import type { BathymetryGrid } from '../BathymetryCache';
import type { IsochroneNode, Isochrone } from './types';
import { haversineNm } from './geodesy';
import { isSegmentNavigable } from './landAvoidance';

/**
 * Reconstruct the optimal route by backtracking from the arrival node
 * through the isochrone chain.
 */
export function backtrack(isochrones: Isochrone[], arrivalIdx: number, arrivalNode: IsochroneNode): IsochroneNode[] {
    const path: IsochroneNode[] = [arrivalNode];

    let currentNode = arrivalNode;
    for (let i = arrivalIdx; i > 0; i--) {
        if (currentNode.parentIndex === null) break;

        const prevIsochrone = isochrones[i - 1];
        if (!prevIsochrone || currentNode.parentIndex >= prevIsochrone.nodes.length) break;

        currentNode = prevIsochrone.nodes[currentNode.parentIndex];
        path.unshift(currentNode);
    }

    return path;
}

/**
 * Simplify the route using the Douglas-Peucker algorithm.
 *
 * LAND-AWARE: Never simplifies a segment that would cross land.
 * Removes waypoints that are within TOLERANCE_NM of the simplified line,
 * eliminating zigzag noise while preserving the overall route shape.
 * Always preserves the first and last waypoints.
 */
export function smoothRoute(route: IsochroneNode[], bathyGrid?: BathymetryGrid | null): IsochroneNode[] {
    if (route.length <= 3) return route;

    // Dynamic tolerance: scale with route length but cap conservatively
    const minTol = 15,
        maxTol = 80;
    const t = Math.min(1, Math.max(0, (route.length - 20) / 80));
    const TOLERANCE_NM = minTol + t * (maxTol - minTol);

    // Douglas-Peucker recursive simplification — LAND-AWARE
    function dpSimplify(points: IsochroneNode[], start: number, end: number, keep: boolean[]): void {
        if (end - start < 2) return;

        // LAND-AWARENESS: If the A→B shortcut crosses land, we MUST keep at least
        // one intermediate point. Find the DP pivot and force-keep it, then recurse.
        const crossesLand =
            bathyGrid &&
            !isSegmentNavigable(
                bathyGrid,
                points[start].lat,
                points[start].lon,
                points[end].lat,
                points[end].lon,
                0,
                true,
            );

        const A = points[start];
        const B = points[end];
        const abDist = haversineNm(A.lat, A.lon, B.lat, B.lon);

        let maxDist = 0;
        let maxIdx = start;

        for (let i = start + 1; i < end; i++) {
            const P = points[i];
            const apDist = haversineNm(A.lat, A.lon, P.lat, P.lon);
            const bpDist = haversineNm(B.lat, B.lon, P.lat, P.lon);
            let crossTrack: number;
            if (abDist < 0.01) {
                crossTrack = apDist;
            } else {
                const s = (abDist + apDist + bpDist) / 2;
                const areaSq = s * (s - abDist) * (s - apDist) * (s - bpDist);
                crossTrack = (2 * Math.sqrt(Math.max(0, areaSq))) / abDist;
            }
            if (crossTrack > maxDist) {
                maxDist = crossTrack;
                maxIdx = i;
            }
        }

        // When shortcut crosses land: ALWAYS keep the pivot and recurse
        // Normal mode: only keep if deviation exceeds tolerance
        if (crossesLand || maxDist > TOLERANCE_NM) {
            keep[maxIdx] = true;
            dpSimplify(points, start, maxIdx, keep);
            dpSimplify(points, maxIdx, end, keep);
        }
    }

    const keep = new Array(route.length).fill(false);
    keep[0] = true;
    keep[route.length - 1] = true;
    dpSimplify(route, 0, route.length - 1, keep);

    return route.filter((_, i) => keep[i]);
}
