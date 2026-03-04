/**
 * Isochrone Routing Engine — Time-optimal routing for sailing vessels.
 *
 * Computes the fastest route from A to B by expanding time-spaced wavefronts
 * from the departure point, using the vessel's polar performance data (VPP)
 * to calculate achievable speed at each True Wind Angle (TWA) and True Wind
 * Speed (TWS).
 *
 * Architecture:
 *   1. Start at departure, fan out in N bearings (typically 72 × 5°)
 *   2. For each bearing, compute boat speed from polar data given TWA/TWS
 *   3. Project position forward by (speed × time_step) along each bearing
 *   4. Prune dominated positions (ones behind the leading wavefront)
 *   5. Repeat until any position reaches the destination or max_hours exceeded
 *   6. Backtrack from the arrival node to reconstruct the optimal route
 *
 * Inputs:
 *   - Origin/Destination coordinates
 *   - Departure time
 *   - Vessel polar data (TWS vs TWA → boat speed)
 *   - Wind field (from GRIB or forecast data)
 *   - GEBCO depth data (optional — applies shallow water penalties)
 *
 * Output:
 *   - IsochroneResult: optimal route, ETA, isochrone wavefronts for viz
 */

import type { PolarData } from '../types';
import { GebcoDepthService } from './GebcoDepthService';
import { type BathymetryGrid, isLand, getDepthFromCache } from './BathymetryCache';

// ── Types ─────────────────────────────────────────────────────────

export interface WindField {
    /** Get wind at a position and time offset (hours from departure) */
    getWind(lat: number, lon: number, timeOffsetHours: number): {
        speed: number;   // kts
        direction: number; // degrees true (from which wind blows)
    } | null;
}

export interface IsochroneConfig {
    timeStepHours: number;      // time between wavefronts (default: 3)
    maxHours: number;           // maximum passage duration (default: 168 = 7 days)
    bearingCount: number;       // number of fan-out bearings (default: 72 → 5°)
    minBearingDeg: number;      // narrowest bearing to destination (default: -90)
    maxBearingDeg: number;      // widest bearing from destination (default: +90)
    vesselDraft: number;        // vessel draft in metres (for depth penalties)
    minDepthM: number | null;   // minimum safe depth in metres (draft+1m for coastal) — null = disabled
    minWindSpeed: number;       // kts — below this, use motoring speed
    motoringSpeed: number;      // kts — fallback when wind too light
    useDepthPenalty: boolean;   // query GEBCO for depth-aware routing
}

const DEFAULT_ISOCHRONE_CONFIG: IsochroneConfig = {
    timeStepHours: 6,          // 6h steps for speed (halves iterations vs 3h)
    maxHours: 720,             // 30 days (long passages e.g. Townsville→Perth)
    bearingCount: 36,          // 10° increments (good balance of speed vs resolution)
    minBearingDeg: -180,       // Full 360° fan — enables around-continent routing
    maxBearingDeg: 180,
    vesselDraft: 2.5,
    minDepthM: null,           // null = no shallow-water flagging (ocean passages)
    minWindSpeed: 4,
    motoringSpeed: 5,
    useDepthPenalty: true,     // Land avoidance enabled (instant with BathymetryCache)
};

export interface IsochroneNode {
    lat: number;
    lon: number;
    timeHours: number;          // hours from departure
    bearing: number;            // bearing taken to reach this node
    speed: number;              // kts achieved
    tws: number;                // true wind speed at this point
    twa: number;                // true wind angle at this point
    depth_m?: number | null;
    distToDest?: number;        // NM to destination (cached for pruning perf)
    parentIndex: number | null; // index in previous isochrone
    distance: number;           // cumulative NM from departure
}

export interface Isochrone {
    timeHours: number;
    nodes: IsochroneNode[];
}

export interface IsochroneResult {
    route: IsochroneNode[];          // optimal path (departure → arrival)
    isochrones: Isochrone[];         // all wavefronts (for visualisation)
    totalDistanceNM: number;
    totalDurationHours: number;
    arrivalTime: string;             // ISO
    routeCoordinates: [number, number][]; // [lon, lat] GeoJSON order
    shallowFlags: boolean[];         // parallel to routeCoordinates — true if depth < minDepthM
}

// ── Polar Interpolation ──────────────────────────────────────────

/**
 * Factory function to create a highly-optimised closure for boat speed lookup.
 *
 * It brackets the TWS (True Wind Speed) ONCE, avoiding 36x redundant array
 * scans per parent node, returning a function that only brackets the TWA.
 *
 * @returns A fast function taking `twa` and returning boat speed in knots.
 */
function createPolarSpeedLookup(polar: PolarData, tws: number): (twa: number) => number {
    const twsArr = polar.windSpeeds;
    const twaArr = polar.angles;
    const matrix = polar.matrix;

    if (!twsArr?.length || !twaArr?.length || !matrix?.length) {
        return () => 0;
    }

    // Bracket TWS once
    const clampedTws = Math.min(twsArr[twsArr.length - 1], Math.max(twsArr[0], tws));
    let twsI = 0;
    for (let i = 0; i < twsArr.length - 1; i++) {
        if (twsArr[i + 1] >= clampedTws) { twsI = i; break; }
    }
    const twsI2 = Math.min(twsI + 1, twsArr.length - 1);

    const twsFrac = twsArr[twsI] === twsArr[twsI2] ? 0
        : (clampedTws - twsArr[twsI]) / (twsArr[twsI2] - twsArr[twsI]);

    return function getSpeedForTwa(twa: number): number {
        const clampedTwa = Math.min(twaArr[twaArr.length - 1], Math.max(twaArr[0], Math.abs(twa)));

        let twaI = 0;
        for (let i = 0; i < twaArr.length - 1; i++) {
            if (twaArr[i + 1] >= clampedTwa) { twaI = i; break; }
        }
        const twaI2 = Math.min(twaI + 1, twaArr.length - 1);

        const twaFrac = twaArr[twaI] === twaArr[twaI2] ? 0
            : (clampedTwa - twaArr[twaI]) / (twaArr[twaI2] - twaArr[twaI]);

        const s00 = matrix[twaI]?.[twsI] ?? 0;
        const s10 = matrix[twaI]?.[twsI2] ?? 0;
        const s01 = matrix[twaI2]?.[twsI] ?? 0;
        const s11 = matrix[twaI2]?.[twsI2] ?? 0;

        const s0 = s00 + (s10 - s00) * twsFrac;
        const s1 = s01 + (s11 - s01) * twsFrac;

        return s0 + (s1 - s0) * twaFrac;
    };
}

// ── Geodesy ──────────────────────────────────────────────────────

const R_NM = 3440.065; // Earth radius in NM
const toRad = (d: number) => d * Math.PI / 180;
const toDeg = (r: number) => r * 180 / Math.PI;

function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function initialBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x = Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) -
        Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function projectPosition(lat: number, lon: number, bearingDeg: number, distanceNm: number): { lat: number; lon: number } {
    const d = distanceNm / R_NM; // angular distance
    const brng = toRad(bearingDeg);
    const lat1 = toRad(lat);
    const lon1 = toRad(lon);

    const lat2 = Math.asin(
        Math.sin(lat1) * Math.cos(d) +
        Math.cos(lat1) * Math.sin(d) * Math.cos(brng)
    );
    const lon2 = lon1 + Math.atan2(
        Math.sin(brng) * Math.sin(d) * Math.cos(lat1),
        Math.cos(d) - Math.sin(lat1) * Math.sin(lat2)
    );

    // Normalise longitude to [-180, 180] (Fix 7: antimeridian safety)
    let lonDeg = toDeg(lon2);
    while (lonDeg > 180) lonDeg -= 360;
    while (lonDeg < -180) lonDeg += 360;
    return { lat: toDeg(lat2), lon: lonDeg };
}

/**
 * Calculate True Wind Angle given boat heading and wind direction.
 * Wind direction is "from" (meteorological convention).
 * Returns 0–180 (symmetric).
 */
function calcTWA(boatHeadingDeg: number, windFromDeg: number): number {
    let diff = windFromDeg - boatHeadingDeg;
    // Normalise to -180..180
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    return Math.abs(diff);
}

// ── Hazard minimum depth: reefs, sandbanks, coral below this are rejected ──
const REEF_REJECTION_DEPTH_M = -10; // ETOPO: negative = underwater

// ── Isochrone Engine ─────────────────────────────────────────────

/**
 * Combined land + shallow hazard check for a segment.
 * Samples every ~4 NM in a single pass. Returns false if the segment
 * crosses land OR dangerously shallow water (reefs, sandbanks).
 *
 * @param stepDistanceNM  Known distance of this segment (avoids redundant haversine).
 *                        Pass 0 or undefined to auto-calculate via haversine.
 */
function isSegmentNavigable(
    grid: BathymetryGrid,
    lat1: number, lon1: number,
    lat2: number, lon2: number,
    stepDistanceNM?: number,
): boolean {
    const SAMPLE_SPACING_NM = 4;
    const segDist = stepDistanceNM && stepDistanceNM > 0
        ? stepDistanceNM
        : haversineNm(lat1, lon1, lat2, lon2);
    const numSamples = Math.floor(segDist / SAMPLE_SPACING_NM);
    if (numSamples < 1) return true; // Short segment — endpoint check is sufficient

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
            if (depth >= 0) return false;                       // Land
            if (depth > REEF_REJECTION_DEPTH_M) return false;   // Shallow hazard
        }
    }
    return true;
}

// Legacy wrappers (used by smoothRoute and arrival-segment checks)
function segmentCrossesLand(
    grid: BathymetryGrid,
    lat1: number, lon1: number,
    lat2: number, lon2: number,
): boolean {
    return !isSegmentNavigable(grid, lat1, lon1, lat2, lon2);
}

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
): Promise<IsochroneResult | null> {
    const cfg = { ...DEFAULT_ISOCHRONE_CONFIG, ...config };
    const depTime = new Date(departureTime);
    const wallClockStart = performance.now();
    const WALL_CLOCK_TIMEOUT_MS = 45_000; // 45 second hard timeout

    const totalDistNM = haversineNm(origin.lat, origin.lon, destination.lat, destination.lon);

    // Arrival threshold — scale with step size so we can't skip over it
    // At 6h steps × 5kt motoring = 30 NM per step; half that = 15 NM circle
    const ARRIVAL_THRESHOLD_NM = Math.max(2, cfg.timeStepHours * cfg.motoringSpeed * 0.5);

    const isochrones: Isochrone[] = [];

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

    const maxSteps = Math.ceil(cfg.maxHours / cfg.timeStepHours);

    // Expand wavefronts
    for (let step = 1; step <= maxSteps; step++) {
        const timeHours = step * cfg.timeStepHours;

        // ── Wall-clock timeout check ──
        if (performance.now() - wallClockStart > WALL_CLOCK_TIMEOUT_MS) {
            console.warn(`[Isochrone] Wall-clock timeout at step ${step} (${timeHours}h)`);
            break;
        }

        // ── Yield to main thread every 5 steps + emit progress ──
        if (step % 5 === 0) {
            let closestNM = totalDistNM;
            for (const n of currentFront) {
                const d = haversineNm(n.lat, n.lon, destination.lat, destination.lon);
                if (d < closestNM) closestNM = d;
            }
            try {
                window.dispatchEvent(new CustomEvent('thalassa:isochrone-progress', {
                    detail: { step, maxSteps, timeHours, closestNM: Math.round(closestNM), elapsed: Math.round(performance.now() - wallClockStart) },
                }));
            } catch (_) { /* SSR safety */ }
            await new Promise(r => setTimeout(r, 0));
        }

        // Collect ALL candidate nodes for this step, then batch depth-check
        const candidates: { node: IsochroneNode; distToDest: number }[] = [];

        for (let nodeIdx = 0; nodeIdx < currentFront.length; nodeIdx++) {
            const parent = currentFront[nodeIdx];

            // PERF FIX: Dynamic per-node bearing toward destination.
            // Each node fans out relative to ITS bearing to the destination,
            // not a single fixed origin→dest bearing. This lets the wavefront
            // "turn corners" (critical for Newport→Perth, coastal passages, etc.)
            const nodeToDest = initialBearing(parent.lat, parent.lon, destination.lat, destination.lon);

            // ── PHASE 2 HOISTING: Wind, Parent Trig, and Polar TWS Bracket ──
            // These do not change across the 36 bearings — doing them outside
            // the inner loop eliminates 36x redundant lookups and transcendental math!

            const wind = windField.getWind(parent.lat, parent.lon, timeHours - cfg.timeStepHours);
            if (!wind) continue; // If no wind data for this time/place, node dies

            // Parent trig constants for inlined projectPosition
            const lat1Rad = toRad(parent.lat);
            const lon1Rad = toRad(parent.lon);
            const sinLat1 = Math.sin(lat1Rad);
            const cosLat1 = Math.cos(lat1Rad);

            // Bracket TWS once and get a fast closure for TWA lookup
            const getSpeedForTwa = createPolarSpeedLookup(polar, wind.speed);

            // Fan out in multiple bearings relative to this node's destination bearing
            for (let b = cfg.minBearingDeg; b <= cfg.maxBearingDeg; b += (360 / cfg.bearingCount)) {
                const absoluteBearing = (nodeToDest + b + 360) % 360;

                const twa = calcTWA(absoluteBearing, wind.direction);
                let boatSpeed: number;

                if (wind.speed < cfg.minWindSpeed) {
                    boatSpeed = cfg.motoringSpeed;
                } else {
                    boatSpeed = getSpeedForTwa(twa);
                    if (boatSpeed < 0.5) continue; // Skip dead upwind
                }

                // Inlined projectPosition (reusing sinLat1, cosLat1)
                const distanceStep = boatSpeed * cfg.timeStepHours;
                const dRad = distanceStep / R_NM;
                const brngRad = toRad(absoluteBearing);
                const sinD = Math.sin(dRad);
                const cosD = Math.cos(dRad);

                const lat2Rad = Math.asin(
                    sinLat1 * cosD +
                    cosLat1 * sinD * Math.cos(brngRad)
                );
                let lon2Rad = lon1Rad + Math.atan2(
                    Math.sin(brngRad) * sinD * cosLat1,
                    cosD - sinLat1 * Math.sin(lat2Rad)
                );

                let lon2Deg = toDeg(lon2Rad);
                if (lon2Deg > 180) lon2Deg -= 360;
                else if (lon2Deg < -180) lon2Deg += 360;

                const node: IsochroneNode = {
                    lat: toDeg(lat2Rad),
                    lon: lon2Deg,
                    timeHours,
                    bearing: absoluteBearing,
                    speed: boatSpeed,
                    tws: wind.speed,
                    twa,
                    parentIndex: nodeIdx,
                    distance: parent.distance + distanceStep,
                };

                const distToDest = haversineNm(node.lat, node.lon, destination.lat, destination.lon);
                candidates.push({ node: { ...node, distToDest }, distToDest });
            }
        }

        if (candidates.length === 0) break;

        // ── OPTIMISED: Cheap endpoint filter → prune → expensive segment filter ──
        // Step A: Quick endpoint-only filter (no segment walks)
        let endpointValid = candidates;
        if (cfg.useDepthPenalty && bathyGrid) {
            endpointValid = candidates.filter(({ node }) => {
                if (isLand(bathyGrid, node.lat, node.lon)) return false;
                const depth = getDepthFromCache(bathyGrid, node.lat, node.lon);
                node.depth_m = depth;
                if (depth !== null && depth > REEF_REJECTION_DEPTH_M) return false;
                return true;
            });
            if (endpointValid.length === 0) endpointValid = candidates;
        } else if (cfg.useDepthPenalty && !bathyGrid) {
            // HTTP fallback — batch check only every 5 steps
            if (step % 5 === 1) {
                try {
                    const depthResults = await GebcoDepthService.queryDepths(
                        candidates.map(c => ({ lat: c.node.lat, lon: c.node.lon }))
                    );
                    endpointValid = candidates.filter((c, i) => {
                        const depth = depthResults[i]?.depth_m;
                        if (depth !== null && depth >= 0) return false;
                        c.node.depth_m = depth;
                        return true;
                    });
                    if (endpointValid.length === 0) endpointValid = candidates;
                } catch (depthErr) {
                    console.warn(`[Isochrone] Step ${step}: depth check failed, skipping land avoidance`);
                }
            }
        }

        // Check for arrival FIRST (before pruning)
        let arrivedThisStep = false;
        const nonArrivalCandidates: { node: IsochroneNode; distToDest: number }[] = [];
        for (const entry of endpointValid) {
            if (entry.distToDest <= ARRIVAL_THRESHOLD_NM) {
                // Check that the final approach segment doesn't cross land
                if (bathyGrid && entry.node.parentIndex !== null && entry.node.parentIndex < currentFront.length) {
                    const parent = currentFront[entry.node.parentIndex];
                    if (segmentCrossesLand(bathyGrid, parent.lat, parent.lon, destination.lat, destination.lon)) {
                        nonArrivalCandidates.push(entry); // clips land — keep searching
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

        if (arrivedThisStep) {
            isochrones.push({ timeHours, nodes: [arrivalNode!] });
            break;
        }

        if (nonArrivalCandidates.length === 0) break;

        // Step B: Prune into sectors FIRST (cheap — only uses endpoint coords)
        const prunedWithFallbacks = pruneWavefrontWithFallbacks(
            nonArrivalCandidates, origin, destination, cfg.bearingCount,
        );

        // Step C: For each sector winner, run the expensive segment check.
        // If the winner crosses land, try the 2nd best, then 3rd, etc.
        // GRACEFUL DEGRADATION: if ALL candidates in a sector cross land,
        // keep the best one anyway — prevents sector starvation over many steps.
        const finalFront: IsochroneNode[] = [];
        if (cfg.useDepthPenalty && bathyGrid) {
            for (const sectorCandidates of prunedWithFallbacks) {
                let found = false;
                for (const node of sectorCandidates) {
                    const parentIdx = node.parentIndex;
                    if (parentIdx !== null && parentIdx < currentFront.length) {
                        const parent = currentFront[parentIdx];
                        const stepDist = node.distance - parent.distance;
                        if (!isSegmentNavigable(bathyGrid, parent.lat, parent.lon, node.lat, node.lon, stepDist)) {
                            continue; // crosses land/shallow — try next candidate
                        }
                    }
                    finalFront.push(node);
                    found = true;
                    break;
                }
                // Graceful degradation: if ALL candidates crossed land, keep the best
                // one anyway. This prevents sectors from dying off over many steps,
                // which would eventually starve the entire wavefront.
                if (!found && sectorCandidates.length > 0) {
                    finalFront.push(sectorCandidates[0]);
                }
            }
        } else {
            // No bathymetry grid — just take the sector winner
            for (const sectorCandidates of prunedWithFallbacks) {
                if (sectorCandidates.length > 0) finalFront.push(sectorCandidates[0]);
            }
        }

        if (finalFront.length === 0) break;

        console.info(`[Isochrone] Step ${step}: ${timeHours}h, ${finalFront.length} nodes (${endpointValid.length}/${candidates.length} valid), closest ${Math.round(
            finalFront.reduce((min, n) => Math.min(min, n.distToDest ?? haversineNm(n.lat, n.lon, destination.lat, destination.lon)), Infinity)
        )} NM to dest`);

        isochrones.push({ timeHours, nodes: finalFront });
        currentFront = finalFront;
    }

    const elapsed = Math.round(performance.now() - wallClockStart);
    console.info(`[Isochrone] Completed in ${elapsed}ms, ${isochrones.length} steps`);

    // No route found
    if (!arrivalNode) {
        console.warn('[Isochrone] No route found within max hours');
        return null;
    }

    // Backtrack to reconstruct the optimal route
    const route = backtrack(isochrones, arrivalIsochroneIdx, arrivalNode);

    // ── Smooth the route: remove zig-zag waypoints ──
    const smoothed = smoothRoute(route, bathyGrid);

    const arrivalTimeMs = depTime.getTime() + arrivalNode.timeHours * 3600000;

    // Build shallow flags: true where depth is known and too shallow
    const minDepth = cfg.minDepthM;
    const shallowFlags = smoothed.map(n => {
        if (minDepth == null || n.depth_m == null) return false;
        return Math.abs(n.depth_m) < minDepth;
    });

    return {
        route: smoothed,
        isochrones,
        totalDistanceNM: Math.round(arrivalNode.distance * 10) / 10,
        totalDurationHours: Math.round(arrivalNode.timeHours * 10) / 10,
        arrivalTime: new Date(arrivalTimeMs).toISOString(),
        routeCoordinates: smoothed.map(n => [n.lon, n.lat] as [number, number]),
        shallowFlags,
    };
}

// ── Wavefront Pruning ────────────────────────────────────────────

// Precompute cosine for equirectangular bearing approximation
let _eqCosLat = 0;
let _eqCosLatCached = NaN;
function eqBearing(originLat: number, originLon: number, nodeLat: number, nodeLon: number): number {
    // Cache cos(originLat) — it's the same for every node in a step
    if (originLat !== _eqCosLatCached) {
        _eqCosLat = Math.cos(originLat * Math.PI / 180);
        _eqCosLatCached = originLat;
    }
    const dLon = (nodeLon - originLon) * _eqCosLat;
    const dLat = nodeLat - originLat;
    return (Math.atan2(dLon, dLat) * 180 / Math.PI + 360) % 360;
}

/**
 * Prune a wavefront, returning an array-of-arrays: one ranked list
 * per sector (best candidate first). This lets the caller try fallback
 * candidates when the sector winner crosses land.
 *
 * Uses equirectangular flat-earth bearing for sector assignment (fast).
 */
function pruneWavefrontWithFallbacks(
    entries: { node: IsochroneNode; distToDest: number }[],
    origin: { lat: number; lon: number },
    destination: { lat: number; lon: number },
    sectorCount: number,
): IsochroneNode[][] {
    const sectorSize = 360 / sectorCount;
    // Each sector holds up to 3 candidates, sorted by distance-to-dest
    const MAX_PER_SECTOR = 3;
    const sectors: { node: IsochroneNode; dist: number }[][] = new Array(sectorCount);
    for (let i = 0; i < sectorCount; i++) sectors[i] = [];

    for (const { node, distToDest } of entries) {
        const bearing = eqBearing(origin.lat, origin.lon, node.lat, node.lon);
        const sectorIdx = Math.floor(bearing / sectorSize) % sectorCount;
        const bucket = sectors[sectorIdx];

        if (bucket.length < MAX_PER_SECTOR) {
            bucket.push({ node, dist: distToDest });
            // Keep sorted (insertion sort — max 3 items)
            for (let j = bucket.length - 1; j > 0 && bucket[j].dist < bucket[j - 1].dist; j--) {
                [bucket[j], bucket[j - 1]] = [bucket[j - 1], bucket[j]];
            }
        } else if (distToDest < bucket[MAX_PER_SECTOR - 1].dist) {
            // Better than the worst in the bucket — replace it
            bucket[MAX_PER_SECTOR - 1] = { node, dist: distToDest };
            for (let j = MAX_PER_SECTOR - 1; j > 0 && bucket[j].dist < bucket[j - 1].dist; j--) {
                [bucket[j], bucket[j - 1]] = [bucket[j - 1], bucket[j]];
            }
        }
    }

    // Return non-empty sectors as ranked arrays of IsochroneNode[]
    return sectors
        .filter(b => b.length > 0)
        .map(b => b.map(e => e.node));
}

// ── Backtracking ─────────────────────────────────────────────────

/**
 * Reconstruct the optimal route by backtracking from the arrival node
 * through the isochrone chain.
 */
function backtrack(
    isochrones: Isochrone[],
    arrivalIdx: number,
    arrivalNode: IsochroneNode,
): IsochroneNode[] {
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

// ── Route Smoothing ──────────────────────────────────────────────

/**
 * Remove zig-zag waypoints from the backtracked route.
 *
 * For consecutive waypoints A → B → C, if the bearing change at B
 * is > 120° (sharp turn), remove B — UNLESS skipping B would create
 * a segment A→C that crosses land (this preserves capes/headlands).
 * Iterates until stable. Always preserves the first and last waypoints.
 */
function smoothRoute(route: IsochroneNode[], bathyGrid?: BathymetryGrid | null): IsochroneNode[] {
    if (route.length <= 3) return route;

    let changed = true;
    let result = [...route];

    while (changed) {
        changed = false;
        const smoothed: IsochroneNode[] = [result[0]];

        for (let i = 1; i < result.length - 1; i++) {
            const prev = smoothed[smoothed.length - 1];
            const curr = result[i];
            const next = result[i + 1];

            const bearingIn = initialBearing(prev.lat, prev.lon, curr.lat, curr.lon);
            const bearingOut = initialBearing(curr.lat, curr.lon, next.lat, next.lon);

            // Calculate turn angle (0 = straight, 180 = U-turn)
            let turnAngle = Math.abs(bearingOut - bearingIn);
            if (turnAngle > 180) turnAngle = 360 - turnAngle;

            // Remove waypoints with very sharp turns (> 120°)
            // BUT only if the resulting A→C segment doesn't cross land
            if (turnAngle > 120) {
                if (bathyGrid && segmentCrossesLand(bathyGrid, prev.lat, prev.lon, next.lat, next.lon)) {
                    // Skipping this waypoint would cut through land — keep it
                    smoothed.push(curr);
                } else {
                    changed = true;
                    continue; // Skip this waypoint
                }
            } else {
                smoothed.push(curr);
            }
        }

        smoothed.push(result[result.length - 1]);
        result = smoothed;
    }

    return result;
}

// ── Convenience: GeoJSON output for map rendering ────────────────

/**
 * Convert isochrone result to GeoJSON for Mapbox rendering.
 * Returns both the optimal route line and the isochrone wavefront polygons.
 */
export function isochroneToGeoJSON(result: IsochroneResult): {
    route: GeoJSON.Feature<GeoJSON.LineString>;
    wavefronts: GeoJSON.FeatureCollection;
} {
    // Optimal route as LineString
    const route: GeoJSON.Feature<GeoJSON.LineString> = {
        type: 'Feature',
        properties: {
            type: 'isochrone_route',
            totalNM: result.totalDistanceNM,
            durationHours: result.totalDurationHours,
        },
        geometry: {
            type: 'LineString',
            coordinates: result.routeCoordinates,
        },
    };

    // Wavefront polygons (connect nodes in each isochrone)
    const features: GeoJSON.Feature[] = result.isochrones
        .filter(iso => iso.nodes.length >= 3)
        .map(iso => {
            const coords = iso.nodes.map(n => [n.lon, n.lat] as [number, number]);
            // Close the polygon
            if (coords.length > 0) coords.push(coords[0]);

            return {
                type: 'Feature' as const,
                properties: {
                    type: 'isochrone_wavefront',
                    timeHours: iso.timeHours,
                    nodeCount: iso.nodes.length,
                },
                geometry: {
                    type: 'LineString' as const,
                    coordinates: coords,
                },
            };
        });

    return {
        route,
        wavefronts: {
            type: 'FeatureCollection',
            features,
        },
    };
}

// ── Turn Waypoint Detection ─────────────────────────────────────

export interface TurnWaypoint {
    id: string;           // "WP1", "WP2", etc.
    lat: number;
    lon: number;
    bearingChange: number; // degrees of course change
    bearing: number;       // new bearing after turn
    timeHours: number;     // hours from departure
    distanceNM: number;    // cumulative NM from departure
    speed: number;         // boat speed at this point
    tws: number;           // true wind speed
    twa: number;           // true wind angle
    eta: string;           // ISO timestamp
}

/**
 * Detect significant course changes in a route to produce turn-by-turn waypoints.
 *
 * Walks the IsochroneNode array looking for bearing deltas > threshold.
 * Includes departure and arrival as first/last waypoints.
 *
 * @param route          IsochroneNode[] from IsochroneResult.route
 * @param departureTime  ISO string for departure time
 * @param threshold      Minimum bearing change in degrees to register a waypoint (default: 15)
 */
export function detectTurnWaypoints(
    route: IsochroneNode[],
    departureTime: string,
    threshold: number = 15,
): TurnWaypoint[] {
    if (route.length < 2) return [];

    const depTime = new Date(departureTime).getTime();
    const waypoints: TurnWaypoint[] = [];
    let wpNumber = 0;

    // Always include departure as first waypoint
    const first = route[0];
    waypoints.push({
        id: 'DEP',
        lat: first.lat,
        lon: first.lon,
        bearingChange: 0,
        bearing: first.bearing,
        timeHours: 0,
        distanceNM: 0,
        speed: first.speed,
        tws: first.tws,
        twa: first.twa,
        eta: departureTime,
    });

    // Walk route looking for significant bearing changes
    for (let i = 1; i < route.length - 1; i++) {
        const prev = route[i - 1];
        const curr = route[i];
        const next = route[i + 1];

        // Compute bearing of segment before and after this point
        const bearingIn = bearingBetween(prev.lat, prev.lon, curr.lat, curr.lon);
        const bearingOut = bearingBetween(curr.lat, curr.lon, next.lat, next.lon);

        let delta = bearingOut - bearingIn;
        // Normalise to -180..180
        while (delta > 180) delta -= 360;
        while (delta < -180) delta += 360;

        if (Math.abs(delta) >= threshold) {
            wpNumber++;
            waypoints.push({
                id: `WP${wpNumber}`,
                lat: curr.lat,
                lon: curr.lon,
                bearingChange: Math.round(delta),
                bearing: Math.round(bearingOut),
                timeHours: curr.timeHours,
                distanceNM: Math.round(curr.distance * 10) / 10,
                speed: curr.speed,
                tws: curr.tws,
                twa: curr.twa,
                eta: new Date(depTime + curr.timeHours * 3600_000).toISOString(),
            });
        }
    }

    // Always include arrival as last waypoint
    const last = route[route.length - 1];
    waypoints.push({
        id: 'ARR',
        lat: last.lat,
        lon: last.lon,
        bearingChange: 0,
        bearing: last.bearing,
        timeHours: last.timeHours,
        distanceNM: Math.round(last.distance * 10) / 10,
        speed: last.speed,
        tws: last.tws,
        twa: last.twa,
        eta: new Date(depTime + last.timeHours * 3600_000).toISOString(),
    });

    return waypoints;
}

/** Simple bearing between two points (degrees true, 0-360) */
function bearingBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    const Δλ = (lon2 - lon1) * Math.PI / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}
