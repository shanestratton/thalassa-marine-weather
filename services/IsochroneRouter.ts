/**
 * Isochrone Routing Engine — Time-optimal routing for sailing vessels.
 *
 * Computes the fastest route from A to B by expanding time-spaced wavefronts
 * from the departure point, using the vessel's polar performance data (VPP)
 * to calculate achievable speed at each True Wind Angle (TWA) and True Wind
 * Speed (TWS).
 *
 * Architecture:
 *   1. Start at departure, fan out in N bearings (typically 36 × 10°)
 *   2. For each bearing, compute boat speed from polar data given TWA/TWS
 *   3. Project position forward by (speed × time_step) along each bearing
 *   4. Prune dominated positions (ones behind the leading wavefront)
 *   5. Repeat until any position reaches the destination or max_hours exceeded
 *   6. Backtrack from the arrival node to reconstruct the optimal route
 *
 * Sub-modules:
 *   - isochrone/types.ts        — Type definitions and config
 *   - isochrone/geodesy.ts      — Spherical earth geometry
 *   - isochrone/polar.ts        — Polar diagram interpolation
 *   - isochrone/pruning.ts      — Wavefront sector pruning
 *   - isochrone/landAvoidance.ts — Segment/point land checks
 *   - isochrone/smoothing.ts    — DP route simplification
 *   - isochrone/output.ts       — Turn detection and GeoJSON
 */

import { createLogger } from '../utils/createLogger';
import type { PolarData } from '../types';
import { GebcoDepthService } from './GebcoDepthService';
import { type BathymetryGrid, isLand, getDepthFromCache } from './BathymetryCache';

// ── Re-export all public types and functions from sub-modules ────
export type {
    WindField,
    IsochroneConfig,
    IsochroneNode,
    Isochrone,
    IsochroneResult,
    TurnWaypoint,
} from './isochrone/types';
export { DEFAULT_ISOCHRONE_CONFIG } from './isochrone/types';

// Re-export public functions
export { isochroneToGeoJSON, detectTurnWaypoints } from './isochrone/output';

// ── Import internal dependencies from sub-modules ────────────────
import type { WindField, IsochroneNode, IsochroneConfig } from './isochrone/types';
import { DEFAULT_ISOCHRONE_CONFIG } from './isochrone/types';
import { haversineNm, initialBearing, projectPosition, calcTWA, R_NM, toRad, toDeg } from './isochrone/geodesy';
import { createPolarSpeedLookup } from './isochrone/polar';
import { pruneWavefrontWithFallbacks } from './isochrone/pruning';
import {
    isSegmentNavigable,
    segmentCrossesLand,
    pushRouteOffshore,
    eliminateCrossings,
    nudgeWaypointsOffshore,
} from './isochrone/landAvoidance';
import { backtrack, smoothRoute } from './isochrone/smoothing';

const log = createLogger('IsoRoute');

// ── Hazard minimum depth: reefs, sandbanks, coral below this are rejected ──
const REEF_REJECTION_DEPTH_M = -10;

// ── Isochrone Engine ─────────────────────────────────────────────

/**
 * Compute isochrone routing between two points.
 *
 * @param origin - Departure coordinates
 * @param destination - Arrival coordinates
 * @param departureTime - ISO datetime string
 * @param polar - Vessel polar performance data
 * @param windField - Wind data provider
 * @param config - Engine configuration
 */
export async function computeIsochrones(
    origin: { lat: number; lon: number },
    destination: { lat: number; lon: number },
    departureTime: string,
    polar: PolarData,
    windField: WindField,
    config: Partial<IsochroneConfig> = {},
    bathyGrid?: BathymetryGrid | null,
): Promise<import('./isochrone/types').IsochroneResult | null> {
    const cfg = { ...DEFAULT_ISOCHRONE_CONFIG, ...config };
    const depTime = new Date(departureTime);
    const wallClockStart = performance.now();
    const WALL_CLOCK_TIMEOUT_MS = 45_000;

    const totalDistNM = haversineNm(origin.lat, origin.lon, destination.lat, destination.lon);

    // Dynamic maxHours: scale with distance so ultra-long routes have enough steps
    const minHoursForRoute = Math.ceil((totalDistNM / cfg.motoringSpeed) * 2.5);
    const effectiveMaxHours = Math.max(cfg.maxHours, Math.min(minHoursForRoute, 2160));

    // Arrival threshold — scale with step size
    const ARRIVAL_THRESHOLD_NM = Math.max(5, cfg.timeStepHours * cfg.motoringSpeed * 0.8);

    const isochrones: import('./isochrone/types').Isochrone[] = [];

    // Seed: departure node
    const initBearing = initialBearing(origin.lat, origin.lon, destination.lat, destination.lon);
    const startNode: IsochroneNode = {
        lat: origin.lat,
        lon: origin.lon,
        timeHours: 0,
        bearing: initBearing,
        speed: 0,
        tws: 0,
        twa: 0,
        parentIndex: null,
        distance: 0,
    };

    let currentFront: IsochroneNode[] = [startNode];
    isochrones.push({ timeHours: 0, nodes: [startNode] });

    let arrivalNode: IsochroneNode | null = null;
    let arrivalIsochroneIdx = -1;

    const maxSteps = Math.ceil(effectiveMaxHours / cfg.timeStepHours);

    // ── Stall detection ──
    let bestDistanceSoFar = totalDistNM;
    let stepsWithoutProgress = 0;
    let depthFilterDisabled = false;
    let allBathyDisabled = false;
    const STALL_THRESHOLD_STEPS = 10;
    const STALL_PROGRESS_NM = 5;

    // Expand wavefronts
    for (let step = 1; step <= maxSteps; step++) {
        const timeHours = step * cfg.timeStepHours;

        // ── Wall-clock timeout check ──
        if (performance.now() - wallClockStart > WALL_CLOCK_TIMEOUT_MS) {
            log.warn(`Wall-clock timeout at step ${step} (${timeHours}h)`);
            break;
        }

        // ── Yield to main thread every 2 steps + emit progress ──
        if (step % 2 === 0) {
            let closestNM = totalDistNM;
            for (const n of currentFront) {
                const d = haversineNm(n.lat, n.lon, destination.lat, destination.lon);
                if (d < closestNM) closestNM = d;
            }
            try {
                window.dispatchEvent(
                    new CustomEvent('thalassa:isochrone-progress', {
                        detail: {
                            step,
                            maxSteps,
                            timeHours,
                            closestNM: Math.round(closestNM),
                            totalDistNM: Math.round(totalDistNM),
                            frontSize: currentFront.length,
                            elapsed: Math.round(performance.now() - wallClockStart),
                        },
                    }),
                );
            } catch (_) {
                /* SSR safety */
            }
            await new Promise((r) => setTimeout(r, 0));
        }

        // Collect ALL candidate nodes for this step
        const candidates: { node: IsochroneNode; distToDest: number }[] = [];

        for (let nodeIdx = 0; nodeIdx < currentFront.length; nodeIdx++) {
            const parent = currentFront[nodeIdx];
            const nodeToDest = initialBearing(parent.lat, parent.lon, destination.lat, destination.lon);

            // ── Hoist: Wind, Parent Trig, and Polar TWS Bracket ──
            const wind = windField.getWind(parent.lat, parent.lon, timeHours - cfg.timeStepHours);
            const hasWind = wind !== null && wind.speed >= 0;

            const lat1Rad = toRad(parent.lat);
            const lon1Rad = toRad(parent.lon);
            const sinLat1 = Math.sin(lat1Rad);
            const cosLat1 = Math.cos(lat1Rad);

            const getSpeedForTwa = hasWind ? createPolarSpeedLookup(polar, wind!.speed) : null;

            for (let b = cfg.minBearingDeg; b <= cfg.maxBearingDeg; b += 360 / cfg.bearingCount) {
                const absoluteBearing = (nodeToDest + b + 360) % 360;

                let boatSpeed: number;
                let twa: number;
                let tws: number;

                if (!hasWind) {
                    boatSpeed = cfg.motoringSpeed;
                    twa = 0;
                    tws = 0;
                } else {
                    twa = calcTWA(absoluteBearing, wind!.direction);
                    tws = wind!.speed;

                    if (tws < cfg.minWindSpeed) {
                        boatSpeed = cfg.motoringSpeed;
                    } else {
                        boatSpeed = getSpeedForTwa!(twa);
                        if (boatSpeed < 0.5) continue;
                    }

                    if (cfg.comfortParams) {
                        const cp = cfg.comfortParams;
                        if (cp.maxWindKts !== undefined && tws > cp.maxWindKts) continue;
                        if (cp.maxGustKts !== undefined && tws * 1.4 > cp.maxGustKts) continue;
                    }
                }

                // Inlined projectPosition (reusing sinLat1, cosLat1)
                const distanceStep = boatSpeed * cfg.timeStepHours;
                const dRad = distanceStep / R_NM;
                const brngRad = toRad(absoluteBearing);
                const sinD = Math.sin(dRad);
                const cosD = Math.cos(dRad);

                const lat2Rad = Math.asin(sinLat1 * cosD + cosLat1 * sinD * Math.cos(brngRad));
                const lon2Rad =
                    lon1Rad + Math.atan2(Math.sin(brngRad) * sinD * cosLat1, cosD - sinLat1 * Math.sin(lat2Rad));

                let lon2Deg = toDeg(lon2Rad);
                if (lon2Deg > 180) lon2Deg -= 360;
                else if (lon2Deg < -180) lon2Deg += 360;

                const node: IsochroneNode = {
                    lat: toDeg(lat2Rad),
                    lon: lon2Deg,
                    timeHours,
                    bearing: absoluteBearing,
                    speed: boatSpeed,
                    tws,
                    twa,
                    parentIndex: nodeIdx,
                    distance: parent.distance + distanceStep,
                };

                const distToDest = haversineNm(node.lat, node.lon, destination.lat, destination.lon);
                candidates.push({ node: { ...node, distToDest }, distToDest });
            }
        }

        if (candidates.length === 0) break;

        // ── Stall detection ──
        const closestThisStep = candidates.reduce((min, c) => Math.min(min, c.distToDest), Infinity);
        if (closestThisStep < bestDistanceSoFar - STALL_PROGRESS_NM) {
            bestDistanceSoFar = closestThisStep;
            stepsWithoutProgress = 0;
        } else {
            stepsWithoutProgress++;
        }
        if (!depthFilterDisabled && stepsWithoutProgress >= STALL_THRESHOLD_STEPS) {
            depthFilterDisabled = true;
            log.info(
                `[Isochrone] Stall T1 at step ${step} — disabling reef filter (best: ${Math.round(bestDistanceSoFar)} NM)`,
            );
        }
        if (!allBathyDisabled && stepsWithoutProgress >= 30) {
            allBathyDisabled = true;
            log.info(
                `[Isochrone] Stall T2 at step ${step} — disabling ALL bathy checks (best: ${Math.round(bestDistanceSoFar)} NM)`,
            );
        }

        // ── Depth filtering ──
        let endpointValid = candidates;
        if (cfg.useDepthPenalty && bathyGrid && !allBathyDisabled) {
            endpointValid = candidates.filter(({ node }) => {
                if (isLand(bathyGrid, node.lat, node.lon)) return false;
                const depth = getDepthFromCache(bathyGrid, node.lat, node.lon);
                node.depth_m = depth;
                if (!depthFilterDisabled && depth !== null && depth > REEF_REJECTION_DEPTH_M) return false;
                return true;
            });
            if (endpointValid.length === 0) endpointValid = candidates;
        } else if (cfg.useDepthPenalty && !bathyGrid) {
            // HTTP fallback — batch check only every 5 steps
            if (step % 5 === 1) {
                try {
                    const depthResults = await GebcoDepthService.queryDepths(
                        candidates.map((c) => ({ lat: c.node.lat, lon: c.node.lon })),
                    );
                    endpointValid = candidates.filter((c, i) => {
                        const depth = depthResults[i]?.depth_m;
                        if (depth !== null && depth >= 0) return false;
                        c.node.depth_m = depth;
                        return true;
                    });
                    if (endpointValid.length === 0) endpointValid = candidates;
                } catch (_depthErr) {
                    log.warn(`Step ${step}: depth check failed, skipping land avoidance`);
                }
            }
        }

        // ── Arrival check ──
        let arrivedThisStep = false;
        const nonArrivalCandidates: { node: IsochroneNode; distToDest: number }[] = [];
        let closestArrivalCandidate: { node: IsochroneNode; distToDest: number } | null = null;
        for (const entry of endpointValid) {
            if (entry.distToDest <= ARRIVAL_THRESHOLD_NM) {
                if (bathyGrid) {
                    if (
                        segmentCrossesLand(bathyGrid, entry.node.lat, entry.node.lon, destination.lat, destination.lon)
                    ) {
                        if (!closestArrivalCandidate || entry.distToDest < closestArrivalCandidate.distToDest) {
                            closestArrivalCandidate = entry;
                        }
                        nonArrivalCandidates.push(entry);
                        continue;
                    }
                }
                arrivalNode = { ...entry.node, lat: destination.lat, lon: destination.lon };
                arrivalIsochroneIdx = step;
                arrivedThisStep = true;
                break;
            }
            nonArrivalCandidates.push(entry);
        }
        if (!arrivedThisStep && closestArrivalCandidate) {
            log.info(
                `[Isochrone] Arrival fallback: accepting candidate at ${closestArrivalCandidate.distToDest.toFixed(1)} NM`,
            );
            arrivalNode = { ...closestArrivalCandidate.node, lat: destination.lat, lon: destination.lon };
            arrivalIsochroneIdx = step;
            arrivedThisStep = true;
        }

        if (arrivedThisStep) {
            isochrones.push({ timeHours, nodes: [arrivalNode!] });
            break;
        }

        if (nonArrivalCandidates.length === 0) break;

        // ── Pruning ──
        const prunedWithFallbacks = pruneWavefrontWithFallbacks(
            nonArrivalCandidates,
            origin,
            destination,
            cfg.bearingCount,
            allBathyDisabled,
        );

        // ── Segment land checks with fallback ──
        const finalFront: IsochroneNode[] = [];
        if (cfg.useDepthPenalty && bathyGrid && !allBathyDisabled) {
            for (const sectorCandidates of prunedWithFallbacks) {
                let found = false;
                for (const node of sectorCandidates) {
                    const parentIdx = node.parentIndex;
                    if (parentIdx !== null && parentIdx < currentFront.length) {
                        const parent = currentFront[parentIdx];
                        const stepDist = node.distance - parent.distance;
                        if (
                            !isSegmentNavigable(
                                bathyGrid,
                                parent.lat,
                                parent.lon,
                                node.lat,
                                node.lon,
                                stepDist,
                                depthFilterDisabled,
                            )
                        ) {
                            continue;
                        }
                    }
                    finalFront.push(node);
                    found = true;
                    break;
                }
                if (!found && sectorCandidates.length > 0) {
                    const best = sectorCandidates[0];
                    const leftBrg = (best.bearing - 90 + 360) % 360;
                    const rightBrg = (best.bearing + 90) % 360;
                    let nudged = false;
                    for (const pushNM of [5, 10, 20, 30]) {
                        for (const brg of [leftBrg, rightBrg]) {
                            const pt = projectPosition(best.lat, best.lon, brg, pushNM);
                            if (!isLand(bathyGrid, pt.lat, pt.lon)) {
                                finalFront.push({ ...best, lat: pt.lat, lon: pt.lon });
                                nudged = true;
                                break;
                            }
                        }
                        if (nudged) break;
                    }
                    if (!nudged) finalFront.push(best);
                }
            }
        } else {
            for (const sectorCandidates of prunedWithFallbacks) {
                if (sectorCandidates.length > 0) finalFront.push(sectorCandidates[0]);
            }
        }

        if (finalFront.length === 0) break;

        log.info(
            `[Isochrone] Step ${step}: ${timeHours}h, ${finalFront.length} nodes (${endpointValid.length}/${candidates.length} valid), closest ${Math.round(
                finalFront.reduce(
                    (min, n) =>
                        Math.min(min, n.distToDest ?? haversineNm(n.lat, n.lon, destination.lat, destination.lon)),
                    Infinity,
                ),
            )} NM to dest`,
        );

        isochrones.push({ timeHours, nodes: finalFront });
        currentFront = finalFront;
    }

    const elapsed = Math.round(performance.now() - wallClockStart);
    log.info(`Completed in ${elapsed}ms, ${isochrones.length} steps`);

    // No route found
    if (!arrivalNode) {
        log.warn('No route found within max hours');
        return null;
    }

    // Backtrack to reconstruct the optimal route
    const route = backtrack(isochrones, arrivalIsochroneIdx, arrivalNode);

    // ── Smooth the route: remove zig-zag waypoints ──
    let smoothed = smoothRoute(route, bathyGrid);

    // ── Push land-clipped segments offshore ──
    if (bathyGrid) {
        smoothed = pushRouteOffshore(smoothed, bathyGrid);
        // Land-aware cleanup DP
        const CLEANUP_TOL_NM = 40;
        if (smoothed.length > 3) {
            const keep2 = new Array(smoothed.length).fill(false);
            keep2[0] = true;
            keep2[smoothed.length - 1] = true;
            const dpClean = (pts: IsochroneNode[], s: number, e: number): void => {
                if (e - s < 2) return;
                const A = pts[s],
                    B = pts[e],
                    ab = haversineNm(A.lat, A.lon, B.lat, B.lon);
                let mx = 0,
                    mi = s;
                for (let i = s + 1; i < e; i++) {
                    const P = pts[i],
                        ap = haversineNm(A.lat, A.lon, P.lat, P.lon),
                        bp = haversineNm(B.lat, B.lon, P.lat, P.lon);
                    const ss = (ab + ap + bp) / 2;
                    const ct =
                        ab > 0.01 ? (2 * Math.sqrt(Math.max(0, ss * (ss - ab) * (ss - ap) * (ss - bp)))) / ab : ap;
                    if (ct > mx) {
                        mx = ct;
                        mi = i;
                    }
                }
                if (mx > CLEANUP_TOL_NM) {
                    if (!isSegmentNavigable(bathyGrid, pts[s].lat, pts[s].lon, pts[e].lat, pts[e].lon, 0, true)) {
                        for (let i = s + 1; i < e; i++) keep2[i] = true;
                    } else {
                        keep2[mi] = true;
                    }
                    dpClean(pts, s, mi);
                    dpClean(pts, mi, e);
                }
            };
            dpClean(smoothed, 0, smoothed.length - 1);
            smoothed = smoothed.filter((_, i) => keep2[i]);
        }
        smoothed = pushRouteOffshore(smoothed, bathyGrid);
        smoothed = eliminateCrossings(smoothed, bathyGrid);
        smoothed = nudgeWaypointsOffshore(smoothed, bathyGrid);
    }

    const arrivalTimeMs = depTime.getTime() + arrivalNode.timeHours * 3600000;

    const minDepth = cfg.minDepthM;
    const shallowFlags = smoothed.map((n) => {
        if (minDepth == null || n.depth_m == null) return false;
        return Math.abs(n.depth_m) < minDepth;
    });

    return {
        route: smoothed,
        isochrones,
        totalDistanceNM: Math.round(arrivalNode.distance * 10) / 10,
        totalDurationHours: Math.round(arrivalNode.timeHours * 10) / 10,
        arrivalTime: new Date(arrivalTimeMs).toISOString(),
        routeCoordinates: smoothed.map((n) => [n.lon, n.lat] as [number, number]),
        shallowFlags,
    };
}

// ── Test helpers — export internal pure functions for unit testing ──
export const _testableInternals = {
    haversineNm,
    initialBearing,
    projectPosition,
    calcTWA,
    createPolarSpeedLookup,
};
