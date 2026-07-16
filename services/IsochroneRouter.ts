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
import { type BathymetryGrid, isLand, isNearShore, getDepthFromCache } from './BathymetryCache';

// ── Re-export all public types and functions from sub-modules ────
export type {
    WindField,
    CurrentField,
    ExclusionField,
    WaveField,
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
import type {
    WindField,
    CurrentField,
    ExclusionField,
    WaveField,
    IsochroneNode,
    IsochroneConfig,
} from './isochrone/types';
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
    /**
     * Optional ocean current field. When provided, each candidate
     * position is advected by current * timeStep — converting boat
     * speed-through-water (STW) from the polar into speed-over-ground
     * (SOG). Major impact on routes through Gulf Stream, Agulhas,
     * Kuroshio, Antarctic Circumpolar.
     *
     * Pass null/undefined to route without current advection (the
     * engine treats absent current data as "0 kts everywhere").
     */
    currentField?: CurrentField | null,
    /**
     * Optional spatiotemporal exclusion field. When provided, candidate
     * positions falling inside an active no-go zone (typically tropical
     * cyclones with intensity-scaled safety radii) are dropped from the
     * wavefront. The route is forced to detour around the storm.
     *
     * Pass null/undefined to route without exclusion checks.
     */
    exclusionField?: ExclusionField | null,
    /**
     * Optional wave field. When provided, the polar's predicted boat
     * speed is multiplied by a sea-state factor (1 - slowdown) before
     * projection — head waves slow you down, beam waves slow you a
     * little, following waves are roughly neutral. Short period waves
     * (chop) are more punishing than long swells of the same height.
     *
     * Implements the "polar-with-waves" modelling that PredictWind /
     * Expedition use to make routes accurate in heavy weather.
     */
    waveField?: WaveField | null,
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
    let directionalSeederActive = false;
    let bestCandidateEver: { node: IsochroneNode; distToDest: number } | null = null;
    const STALL_THRESHOLD_STEPS = 10;
    const STALL_PROGRESS_NM = 5;
    const DIRECTIONAL_SEEDER_THRESHOLD = 30;
    const CLOSE_ENOUGH_THRESHOLD = 50;

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

            // ── Hoist: Wind, Current, Parent Trig, and Polar TWS Bracket ──
            const wind = windField.getWind(parent.lat, parent.lon, timeHours - cfg.timeStepHours);
            const hasWind = wind !== null && wind.speed >= 0;

            // Current at parent location, hoisted out of the bearing loop —
            // current is a function of (lat, lon, t) and changes slowly over
            // ~120 NM scales, so re-using one value across all bearing
            // candidates from this parent is well within OSCAR's resolution.
            //
            // We pre-compute the east/north components in knots so the
            // per-bearing loop only needs an addition, not a trig call.
            // Direction is "TO" (oceanographic): u = east component,
            // v = north component.
            let currU = 0;
            let currV = 0;
            if (currentField) {
                const current = currentField.getCurrent(parent.lat, parent.lon, timeHours - cfg.timeStepHours);
                if (current && current.speed > 0.05) {
                    const dirRad = toRad(current.direction);
                    currU = current.speed * Math.sin(dirRad);
                    currV = current.speed * Math.cos(dirRad);
                }
            }
            const hasCurrent = currU !== 0 || currV !== 0;

            // Wave conditions at parent location, hoisted similarly.
            // Direction is FROM (meteorological — same as wind).
            // Period in seconds, height in metres.
            const wave = waveField ? waveField.getWave(parent.lat, parent.lon, timeHours - cfg.timeStepHours) : null;

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

                        // ── Wind-angle preference filter ──
                        // User picks which sailing angle bands they're
                        // willing to accept. Candidates whose TWA falls
                        // outside the selected bands are dropped.
                        // Empty / undefined = no filter (all angles OK).
                        // TWA ranges per band (matches PreferredAngle type
                        // in types/settings.ts):
                        //   beating      0–50°
                        //   close_reach  50–80°
                        //   beam_reach   80–110°
                        //   broad_reach  110–150°
                        //   running      150–180°
                        if (cp.preferredAngles && cp.preferredAngles.length > 0 && cp.preferredAngles.length < 5) {
                            const absTwa = Math.abs(twa); // calcTWA may return negative
                            const inBand =
                                (cp.preferredAngles.includes('beating') && absTwa < 50) ||
                                (cp.preferredAngles.includes('close_reach') && absTwa >= 50 && absTwa < 80) ||
                                (cp.preferredAngles.includes('beam_reach') && absTwa >= 80 && absTwa < 110) ||
                                (cp.preferredAngles.includes('broad_reach') && absTwa >= 110 && absTwa < 150) ||
                                (cp.preferredAngles.includes('running') && absTwa >= 150);
                            if (!inBand) continue;
                        }
                    }
                }

                // ── Sea-state slowdown (polar-with-waves) ──
                // Significant wave height is the dominant factor — slowdown
                // scales with H². Relative angle modulates: head waves
                // (180° relative) hit hardest, beam (90°) half, following
                // (0°) is roughly neutral. Short-period chop is worse than
                // long swell at the same height; we use 8s as a reference
                // period (typical wind-driven sea).
                //
                // Cap total slowdown at 50% so the engine doesn't predict
                // the boat going to 0 speed in a 6m sea — even pounding
                // upwind in 6m the boat still makes some progress, and
                // capping prevents pathological infinite-time routes that
                // never reach destination.
                let effectiveBoatSpeed = boatSpeed;
                if (wave && wave.heightM > 0.5) {
                    let relAngle = absoluteBearing - wave.directionFromDeg;
                    while (relAngle > 180) relAngle -= 360;
                    while (relAngle < -180) relAngle += 360;
                    // 0..1: 0 = following (rel ~ 0°), 1 = head (rel ~ 180°)
                    const angleFactor = 0.5 - 0.5 * Math.cos((relAngle * Math.PI) / 180);
                    // Height factor: H²/3² capped at 1 (3m+ is fully painful)
                    const heightFactor = Math.min(1, (wave.heightM * wave.heightM) / 9);
                    // Period factor: 8s reference, shorter = worse, longer = mild
                    const periodFactor = Math.max(0.4, Math.min(1, 8 / Math.max(3, wave.periodS)));
                    const slowdown = Math.min(0.5, 0.6 * angleFactor * heightFactor * periodFactor);
                    effectiveBoatSpeed = boatSpeed * (1 - slowdown);
                }

                // ── Speed-over-ground & course-over-ground ──
                // effectiveBoatSpeed is wave-adjusted speed-through-water.
                // When current is present, the ground velocity is the
                // STW vector + current vector. SOG = |ground vector|,
                // COG = bearing of ground vector.
                //
                // node.bearing keeps the boat HEADING (absoluteBearing)
                // because that's the value the polar lookup is keyed off
                // for the next step's TWA computation. The projected
                // position uses COG so the wavefront expands to where
                // the boat actually ends up over ground.
                let projBearing = absoluteBearing;
                let projDistance = effectiveBoatSpeed * cfg.timeStepHours;
                if (hasCurrent) {
                    const headingRad = toRad(absoluteBearing);
                    const stwU = effectiveBoatSpeed * Math.sin(headingRad);
                    const stwV = effectiveBoatSpeed * Math.cos(headingRad);
                    const gU = stwU + currU;
                    const gV = stwV + currV;
                    const sog = Math.sqrt(gU * gU + gV * gV);
                    if (sog < 0.5) continue; // foul current overpowering: drop candidate
                    projBearing = ((Math.atan2(gU, gV) * 180) / Math.PI + 360) % 360;
                    projDistance = sog * cfg.timeStepHours;
                }

                // Inlined projectPosition (reusing sinLat1, cosLat1)
                const dRad = projDistance / R_NM;
                const brngRad = toRad(projBearing);
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
                    distance: parent.distance + projDistance,
                };

                // ── Exclusion check (cyclones, no-go zones) ──
                // Candidates inside an active exclusion zone at THIS node's
                // arrival time are dropped before they enter the wavefront.
                // This forces the optimal route to detour around tropical
                // cyclones along their NHC-forecast tracks.
                if (exclusionField && exclusionField.isExcluded(node.lat, node.lon, timeHours)) {
                    continue;
                }

                const distToDest = haversineNm(node.lat, node.lon, destination.lat, destination.lon);
                // Graded steer-away from unknown/shoal water (burn-down: the
                // depthCostPenalty was computed for DISPLAY but never read by
                // selection — the "prefer charted, comfortably-deep water"
                // nudge did not exist). Inflate the candidate's RANKING
                // distance only: sector pruning then naturally prefers deep /
                // known water when the choice is close, while the node's own
                // distToDest stays true so arrival acceptance is unaffected.
                // CAPPED at 1.5× so this can never hard-block a route to a
                // shallow anchorage — hard blocking stays with the land gate +
                // the validation passes. Draft uses the routing default
                // (2.5 m, matching HazardQueryService) — a graded preference,
                // not a precise depth model; the dominant case is the ×1.2
                // unknown-depth nudge.
                const candDepth = bathyGrid ? getDepthFromCache(bathyGrid, node.lat, node.lon) : null;
                const rankPenalty = bathyGrid ? Math.min(1.5, GebcoDepthService.depthCostPenalty(candDepth, 2.5)) : 1;
                candidates.push({ node: { ...node, distToDest }, distToDest: distToDest * rankPenalty });
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
        // Track best candidate ever seen (for close-enough acceptance)
        const bestThisStep = candidates.reduce<{ node: IsochroneNode; distToDest: number } | null>(
            (best, c) => (!best || c.distToDest < best.distToDest ? c : best),
            null,
        );
        if (bestThisStep && (!bestCandidateEver || bestThisStep.distToDest < bestCandidateEver.distToDest)) {
            bestCandidateEver = bestThisStep;
        }

        if (!depthFilterDisabled && stepsWithoutProgress >= STALL_THRESHOLD_STEPS) {
            depthFilterDisabled = true;
            log.info(
                `[Isochrone] Stall T1 at step ${step} — disabling reef filter (best: ${Math.round(bestDistanceSoFar)} NM)`,
            );
        }
        if (!directionalSeederActive && stepsWithoutProgress >= DIRECTIONAL_SEEDER_THRESHOLD) {
            directionalSeederActive = true;
            log.info(
                `[Isochrone] Stall T2 at step ${step} — activating directional seeder (best: ${Math.round(bestDistanceSoFar)} NM)`,
            );
        }
        // T3: Close-enough acceptance — use best candidate found so far
        if (stepsWithoutProgress >= CLOSE_ENOUGH_THRESHOLD && bestCandidateEver) {
            log.info(
                `[Isochrone] Stall T3 at step ${step} — close-enough acceptance at ${Math.round(bestCandidateEver.distToDest)} NM from dest`,
            );
            arrivalNode = { ...bestCandidateEver.node, lat: destination.lat, lon: destination.lon };
            arrivalIsochroneIdx = step;
            isochrones.push({ timeHours: step * cfg.timeStepHours, nodes: [arrivalNode] });
            break;
        }

        // ── Depth filtering ──
        let endpointValid = candidates;
        if (cfg.useDepthPenalty && bathyGrid) {
            endpointValid = candidates.filter(({ node }) => {
                if (isLand(bathyGrid, node.lat, node.lon)) return false;
                // Coastal safety buffer: reject nodes near shore to prevent
                // clipping headlands and peninsulas between grid cells.
                // Skip for the first 3 steps — the departure gate is inherently
                // near shore (50m depth), so applying this immediately causes
                // erratic early wavefront expansion (zigzag start).
                if (step > 3 && isNearShore(bathyGrid, node.lat, node.lon, 2)) return false;
                const depth = getDepthFromCache(bathyGrid, node.lat, node.lon);
                node.depth_m = depth;
                if (!depthFilterDisabled && depth !== null && depth > REEF_REJECTION_DEPTH_M) return false;
                return true;
            });
            if (endpointValid.length === 0) {
                // Fallback: if coastal buffer rejected everything, retry with land-only check
                endpointValid = candidates.filter(({ node }) => {
                    if (isLand(bathyGrid, node.lat, node.lon)) return false;
                    const depth = getDepthFromCache(bathyGrid, node.lat, node.lon);
                    node.depth_m = depth;
                    if (!depthFilterDisabled && depth !== null && depth > REEF_REJECTION_DEPTH_M) return false;
                    return true;
                });
            }
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
            false,
        );

        // ── Segment land checks with fallback ──
        const finalFront: IsochroneNode[] = [];
        if (cfg.useDepthPenalty && bathyGrid) {
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

        // ── Directional Seeder: inject safe-water seed nodes when stalled ──
        // When the wavefront is trapped (all sectors blocked by land), find
        // water positions by projecting from the best candidate in multiple
        // directions and seed the wavefront there.
        if (directionalSeederActive && bathyGrid && finalFront.length < cfg.bearingCount / 2) {
            const seedTarget = bestCandidateEver?.node ?? (finalFront.length > 0 ? finalFront[0] : null);
            if (seedTarget) {
                const destBearing = initialBearing(seedTarget.lat, seedTarget.lon, destination.lat, destination.lon);
                // Try 8 compass directions from the best candidate
                const seedBearings = [0, 45, 90, 135, 180, 225, 270, 315].map((off) => (destBearing + off) % 360);
                const seedDistances = [30, 60, 100, 150];
                let seeded = 0;
                for (const brg of seedBearings) {
                    for (const dist of seedDistances) {
                        const pt = projectPosition(seedTarget.lat, seedTarget.lon, brg, dist);
                        if (!isLand(bathyGrid, pt.lat, pt.lon)) {
                            const seedNode: IsochroneNode = {
                                lat: pt.lat,
                                lon: pt.lon,
                                timeHours: seedTarget.timeHours + cfg.timeStepHours,
                                bearing: brg,
                                speed: cfg.motoringSpeed,
                                tws: 0,
                                twa: 0,
                                parentIndex: finalFront.length > 0 ? 0 : null,
                                distance: seedTarget.distance + dist,
                            };
                            // Only seed if not duplicate sector
                            const isDuplicate = finalFront.some((n) => haversineNm(n.lat, n.lon, pt.lat, pt.lon) < 20);
                            if (!isDuplicate) {
                                finalFront.push(seedNode);
                                seeded++;
                            }
                            break; // Found water at this bearing, move to next bearing
                        }
                    }
                }
                if (seeded > 0) {
                    log.info(`[Isochrone] Directional seeder: injected ${seeded} safe-water seed nodes`);
                }
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
        smoothed = eliminateCrossings(smoothed, bathyGrid, destination);
        smoothed = nudgeWaypointsOffshore(smoothed, bathyGrid);

        // ── Final coast-clearance pass ──
        // After all other post-processing, do one more validation:
        // check every segment at 2 NM intervals and push any remaining
        // near-shore waypoints further offshore.
        let coastFixed = false;
        for (let coastPass = 0; coastPass < 3; coastPass++) {
            let needsFix = false;
            for (let i = 1; i < smoothed.length - 1; i++) {
                if (isNearShore(bathyGrid, smoothed[i].lat, smoothed[i].lon, 1)) {
                    // Push this waypoint further offshore
                    const prev = smoothed[i - 1];
                    const next = smoothed[i + 1];
                    const avgBearing = initialBearing(prev.lat, prev.lon, next.lat, next.lon);
                    const perpL = (avgBearing - 90 + 360) % 360;
                    const perpR = (avgBearing + 90) % 360;
                    for (const pushNM of [15, 25, 40, 60]) {
                        for (const brg of [perpL, perpR]) {
                            const pt = projectPosition(smoothed[i].lat, smoothed[i].lon, brg, pushNM);
                            if (!isLand(bathyGrid, pt.lat, pt.lon) && !isNearShore(bathyGrid, pt.lat, pt.lon, 1)) {
                                smoothed[i] = { ...smoothed[i], lat: pt.lat, lon: pt.lon };
                                needsFix = true;
                                break;
                            }
                        }
                        if (needsFix) break;
                    }
                }
            }
            if (!needsFix && !coastFixed) break;
            coastFixed = true;
            // Re-run pushRouteOffshore after nudging to fix any new land crossings
            smoothed = pushRouteOffshore(smoothed, bathyGrid);
        }
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
