/**
 * Isochrone Router — Land avoidance and hazard detection.
 *
 * Functions for segment/endpoint navigability checks,
 * pushing routes offshore, and nudging waypoints away from land.
 */

import type { BathymetryGrid } from '../BathymetryCache';
import { isLand, isNearShore, getDepthFromCache } from '../BathymetryCache';
import type { IsochroneNode } from './types';
import { haversineNm, initialBearing, projectPosition } from './geodesy';
import { GebcoDepthService } from '../GebcoDepthService';
import { createLogger } from '../../utils/createLogger';

const landLog = createLogger('LandAvoidance');

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
    const MAX_PUSH_NM = 200;
    const MIN_PUSH_NM = 5;
    const MAX_PASSES = 10;
    const MAX_RECURSION = 8; // 2^8 = 256 sub-segments max
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

        // Escalate push distance: 50%, 100%, 150%, 200% of segment length
        for (const multiplier of [0.5, 1.0, 1.5, 2.0]) {
            const pushNM = Math.min(MAX_PUSH_NM, Math.max(MIN_PUSH_NM, segLen * multiplier));
            // Try perpendicular first, then angled bearings for irregular coastlines
            const bearingsToTry = [
                leftBearing,
                rightBearing,
                (segBearing - 45 + 360) % 360,
                (segBearing + 45) % 360,
                (segBearing - 60 + 360) % 360,
                (segBearing + 60) % 360,
                (segBearing - 30 + 360) % 360,
                (segBearing + 30) % 360,
            ];
            for (const bearing of bearingsToTry) {
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
        for (const mult of [0.3, 0.5, 0.8, 1.0, 1.5, 2.0]) {
            const pushDist = Math.min(MAX_PUSH_NM, Math.max(MIN_PUSH_NM, segLen * mult));
            // Multi-angle search: perpendicular first, then ±45°, ±30°, ±60°
            const bearingsToTry = [
                leftBearing,
                rightBearing,
                (segBearing - 45 + 360) % 360,
                (segBearing + 45) % 360,
                (segBearing - 60 + 360) % 360,
                (segBearing + 60) % 360,
                (segBearing - 30 + 360) % 360,
                (segBearing + 30) % 360,
            ];
            for (const brg of bearingsToTry) {
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
 *
 * Uses three heuristics:
 *   1. Sharp reversal (>55° bearing change) — classic backtracking zigzag
 *   2. Short-segment zigzag (<50 NM leg with >45° turn)
 *   3. Forward-progress violation — waypoint moves FURTHER from destination
 *      than the previous waypoint (backtracking), remove if shortcut is safe
 */
export function eliminateCrossings(
    route: IsochroneNode[],
    grid: BathymetryGrid,
    destination?: { lat: number; lon: number },
): IsochroneNode[] {
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

            // Sharp reversal (>40°) — likely a backtracking zigzag
            if (bearingChange > 40) {
                if (isSegmentNavigable(grid, A.lat, A.lon, C.lat, C.lon, 0, true)) {
                    toRemove.add(i);
                    continue;
                }
            }

            // Short-segment zigzag: if A→B is under 80NM and turn is >35°, remove
            const abDist = haversineNm(A.lat, A.lon, B.lat, B.lon);
            if (abDist < 80 && bearingChange > 35) {
                if (isSegmentNavigable(grid, A.lat, A.lon, C.lat, C.lon, 0, true)) {
                    toRemove.add(i);
                    continue;
                }
            }

            // Forward-progress violation: B is further from destination than A
            // (any backtracking at all). Remove B if A→C shortcut is navigable.
            if (destination) {
                const distA = haversineNm(A.lat, A.lon, destination.lat, destination.lon);
                const distB = haversineNm(B.lat, B.lon, destination.lat, destination.lon);
                if (distB > distA) {
                    if (isSegmentNavigable(grid, A.lat, A.lon, C.lat, C.lon, 0, true)) {
                        toRemove.add(i);
                    }
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
        // Use isNearShore for wider detection — catches waypoints near headlands
        // that hasAdjacentLand (1-cell radius) would miss
        const nearShore = !onLand && isNearShore(grid, node.lat, node.lon, 2);

        if (!onLand && !nearShore) continue;

        const prev = result[i - 1];
        const next = result[i + 1];
        const avgBearing = initialBearing(prev.lat, prev.lon, next.lat, next.lon);
        const leftBrg = (avgBearing - 90 + 360) % 360;
        const rightBrg = (avgBearing + 90) % 360;

        let nudged = false;
        for (const pushNM of [10, 20, 30, 50]) {
            for (const brg of [leftBrg, rightBrg]) {
                const pt = projectPosition(node.lat, node.lon, brg, pushNM);
                if (!isLand(grid, pt.lat, pt.lon) && !isNearShore(grid, pt.lat, pt.lon, 1)) {
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

// ══════════════════════════════════════════════════════════════════
// Fine-Grained Island Validation (GEBCO Full Resolution)
// ══════════════════════════════════════════════════════════════════

/** Spacing between GEBCO sample points along each segment (NM) */
const FINE_SAMPLE_SPACING_NM = 0.5;

/** Maximum batch size for a single GEBCO edge function call */
const GEBCO_BATCH_SIZE = 400;

/** Maximum recursion depth when fixing an island-crossing segment */
const MAX_FIX_DEPTH = 4;

/** Maximum passes over the full route to fix all island crossings */
const MAX_VALIDATION_PASSES = 3;

/**
 * Hazard depth threshold for GEBCO validation.
 * Any depth shallower than this is treated as a hazard (land, reef, shoal).
 * GEBCO uses negative values for ocean depth, so -10 means "shallower than 10m".
 */
const GEBCO_HAZARD_DEPTH_M = -10;

/**
 * Generate sample points along a great-circle segment at FINE_SAMPLE_SPACING_NM intervals.
 * Returns array of {lat, lon, frac} where frac is 0..1 along the segment.
 */
function sampleSegment(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
): { lat: number; lon: number; frac: number }[] {
    const dist = haversineNm(lat1, lon1, lat2, lon2);
    if (dist < FINE_SAMPLE_SPACING_NM) return [];

    const numSamples = Math.max(1, Math.floor(dist / FINE_SAMPLE_SPACING_NM));
    const samples: { lat: number; lon: number; frac: number }[] = [];

    // Normalise longitude delta for antimeridian crossings
    let dLon = lon2 - lon1;
    if (dLon > 180) dLon -= 360;
    if (dLon < -180) dLon += 360;

    for (let i = 1; i <= numSamples; i++) {
        const frac = i / (numSamples + 1);
        const lat = lat1 + frac * (lat2 - lat1);
        let lon = lon1 + frac * dLon;
        if (lon > 180) lon -= 360;
        else if (lon < -180) lon += 360;
        samples.push({ lat, lon, frac });
    }
    return samples;
}

/**
 * Check if a segment crosses land OR shallow hazards using GEBCO depth data.
 * Flags any point shallower than GEBCO_HAZARD_DEPTH_M (land, reefs, shoals).
 * Returns the index of the first hazardous sample, or -1 if clear.
 */
function findHazardInResults(depths: { depth_m: number | null }[], startIdx: number, count: number): number {
    for (let i = 0; i < count; i++) {
        const d = depths[startIdx + i]?.depth_m;
        if (d !== null && d !== undefined && d > GEBCO_HAZARD_DEPTH_M) return i;
    }
    return -1;
}

/**
 * Validate every segment of the final route using GEBCO full-resolution queries.
 * Detects small islands that the coarse 0.1° bathymetry grid missed, and inserts
 * perpendicular detour waypoints to route around them.
 *
 * This is designed as a POST-PROCESSING step — run once after all other smoothing
 * and land avoidance passes are complete.
 */
export async function validateRouteSegments(route: IsochroneNode[]): Promise<IsochroneNode[]> {
    if (route.length < 2) return route;

    let result = [...route];

    for (let pass = 0; pass < MAX_VALIDATION_PASSES; pass++) {
        // ── 1. Sample all segments ──
        const allSamples: { lat: number; lon: number }[] = [];
        const segmentMeta: { startSampleIdx: number; sampleCount: number }[] = [];

        for (let i = 0; i < result.length - 1; i++) {
            const a = result[i];
            const b = result[i + 1];
            const startIdx = allSamples.length;
            const samples = sampleSegment(a.lat, a.lon, b.lat, b.lon);
            for (const s of samples) {
                allSamples.push({ lat: s.lat, lon: s.lon });
            }
            segmentMeta.push({ startSampleIdx: startIdx, sampleCount: samples.length });
        }

        if (allSamples.length === 0) break;

        // ── 2. Batch-query GEBCO depths ──
        const allDepths: { depth_m: number | null }[] = [];
        try {
            // Split into batches to respect edge function limits
            for (let batchStart = 0; batchStart < allSamples.length; batchStart += GEBCO_BATCH_SIZE) {
                const batch = allSamples.slice(batchStart, batchStart + GEBCO_BATCH_SIZE);
                const results = await GebcoDepthService.queryDepths(batch);
                allDepths.push(...results);
            }
        } catch (err) {
            landLog.warn('[ValidateRoute] GEBCO query failed, skipping island validation:', err);
            return result;
        }

        // ── 3. Find segments that cross land ──
        const landSegments: number[] = [];
        for (let i = 0; i < segmentMeta.length; i++) {
            const { startSampleIdx, sampleCount } = segmentMeta[i];
            if (sampleCount === 0) continue;
            const hazardIdx = findHazardInResults(allDepths, startSampleIdx, sampleCount);
            if (hazardIdx >= 0) {
                landSegments.push(i);
            }
        }

        if (landSegments.length === 0) {
            landLog.info(`[ValidateRoute] Pass ${pass + 1}: all segments clear ✓ (${allSamples.length} samples)`);
            break;
        }

        landLog.info(`[ValidateRoute] Pass ${pass + 1}: ${landSegments.length} segments cross land/reefs — fixing`);

        // ── 4. Fix each land-crossing segment by inserting detour waypoints ──
        const fixed: IsochroneNode[] = [result[0]];

        for (let i = 0; i < result.length - 1; i++) {
            if (landSegments.includes(i)) {
                const a = result[i];
                const b = result[i + 1];
                const detour = await findDetourAroundIsland(a, b, 0);
                if (detour.length > 0) {
                    fixed.push(...detour);
                }
            }
            fixed.push(result[i + 1]);
        }

        result = fixed;
    }

    return result;
}

/**
 * Find a navigable detour around an island-crossing segment.
 *
 * OPTIMISED: Batch-queries ALL candidate detour points in a single GEBCO call
 * instead of making individual HTTP requests per candidate. This reduces
 * network calls from ~20+ per island down to 1-3.
 */
async function findDetourAroundIsland(a: IsochroneNode, b: IsochroneNode, depth: number): Promise<IsochroneNode[]> {
    if (depth >= MAX_FIX_DEPTH) return [];

    const midLat = (a.lat + b.lat) / 2;
    const midLon = (a.lon + b.lon) / 2;
    const segBearing = initialBearing(a.lat, a.lon, b.lat, b.lon);
    const leftBearing = (segBearing - 90 + 360) % 360;
    const rightBearing = (segBearing + 90) % 360;

    const PUSH_DISTANCES = [5, 10, 15, 20, 30];
    const BEARINGS = [leftBearing, rightBearing];

    // ── 1. Generate all candidate detour points ──
    const candidates: { pt: { lat: number; lon: number }; pushNM: number; bearing: number }[] = [];
    for (const pushNM of PUSH_DISTANCES) {
        for (const bearing of BEARINGS) {
            const pt = projectPosition(midLat, midLon, bearing, pushNM);
            candidates.push({ pt, pushNM, bearing });
        }
    }

    // ── 2. Batch-query all candidate points in ONE call ──
    const candidateDepths = await GebcoDepthService.queryDepths(
        candidates.map((c) => ({ lat: c.pt.lat, lon: c.pt.lon })),
    );

    // ── 3. Find the first water-based candidate (smallest push first) ──
    for (let i = 0; i < candidates.length; i++) {
        const d = candidateDepths[i]?.depth_m;
        if (d !== null && d !== undefined && d > GEBCO_HAZARD_DEPTH_M) continue; // Land/reef/shoal — skip

        const { pt, pushNM, bearing } = candidates[i];

        // Validate both sub-segments with a single batched call
        const samplesA = sampleSegment(a.lat, a.lon, pt.lat, pt.lon);
        const samplesB = sampleSegment(pt.lat, pt.lon, b.lat, b.lon);
        const allSubSamples = [...samplesA, ...samplesB];

        if (allSubSamples.length > 0) {
            const subDepths = await GebcoDepthService.queryDepths(
                allSubSamples.map((s) => ({ lat: s.lat, lon: s.lon })),
            );
            const hasHazard = subDepths.some(
                (sd) => sd.depth_m !== null && sd.depth_m !== undefined && sd.depth_m > GEBCO_HAZARD_DEPTH_M,
            );
            if (hasHazard) continue; // Sub-segments cross land/reef — try next candidate
        }

        // Both sub-segments are clear — insert detour point
        const detourNode: IsochroneNode = {
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

        landLog.info(
            `[ValidateRoute] Detour: pushed ${pushNM} NM ${bearing === leftBearing ? 'port' : 'starboard'} at depth ${depth}`,
        );
        return [detourNode];
    }

    // ── 4. Simple push failed — try recursive subdivision ──
    // Find a water-based midpoint from the candidates we already queried
    for (let i = 0; i < candidates.length; i++) {
        const d = candidateDepths[i]?.depth_m;
        if (d !== null && d !== undefined && d > GEBCO_HAZARD_DEPTH_M) continue; // Land/reef/shoal

        const { pt } = candidates[i];
        const waterMid: IsochroneNode = {
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

        const leftFixes = await findDetourAroundIsland(a, waterMid, depth + 1);
        const rightFixes = await findDetourAroundIsland(waterMid, b, depth + 1);
        return [...leftFixes, waterMid, ...rightFixes];
    }

    landLog.warn('[ValidateRoute] Could not find detour — segment remains as-is');
    return [];
}
