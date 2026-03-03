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
}

// ── Polar Interpolation ──────────────────────────────────────────

/**
 * Look up boat speed from polar data given TWS and TWA.
 *
 * PolarData format: { windSpeeds: number[], angles: number[], matrix: number[][] }
 * matrix[angleIdx][windSpeedIdx] = boat speed in knots
 *
 * Uses bilinear interpolation between grid points.
 */
function polarSpeed(polar: PolarData, tws: number, twa: number): number {
    const twsArr = polar.windSpeeds;
    const twaArr = polar.angles;
    const matrix = polar.matrix;

    if (!twsArr?.length || !twaArr?.length || !matrix?.length) return 0;

    // Clamp to polar data bounds
    const absTwa = Math.abs(twa); // Polar data is symmetric
    const clampedTws = Math.min(twsArr[twsArr.length - 1], Math.max(twsArr[0], tws));
    const clampedTwa = Math.min(twaArr[twaArr.length - 1], Math.max(twaArr[0], absTwa));

    // Find bracketing indices for TWS
    let twsI = 0;
    for (let i = 0; i < twsArr.length - 1; i++) {
        if (twsArr[i + 1] >= clampedTws) { twsI = i; break; }
    }
    const twsI2 = Math.min(twsI + 1, twsArr.length - 1);

    // Find bracketing indices for TWA
    let twaI = 0;
    for (let i = 0; i < twaArr.length - 1; i++) {
        if (twaArr[i + 1] >= clampedTwa) { twaI = i; break; }
    }
    const twaI2 = Math.min(twaI + 1, twaArr.length - 1);

    // Bilinear interpolation
    // matrix layout: matrix[angleIdx][windSpeedIdx]
    const twsFrac = twsArr[twsI] === twsArr[twsI2] ? 0
        : (clampedTws - twsArr[twsI]) / (twsArr[twsI2] - twsArr[twsI]);
    const twaFrac = twaArr[twaI] === twaArr[twaI2] ? 0
        : (clampedTwa - twaArr[twaI]) / (twaArr[twaI2] - twaArr[twaI]);

    const s00 = matrix[twaI]?.[twsI] ?? 0;
    const s10 = matrix[twaI]?.[twsI2] ?? 0;
    const s01 = matrix[twaI2]?.[twsI] ?? 0;
    const s11 = matrix[twaI2]?.[twsI2] ?? 0;

    const s0 = s00 + (s10 - s00) * twsFrac;
    const s1 = s01 + (s11 - s01) * twsFrac;

    return s0 + (s1 - s0) * twaFrac;
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

    return { lat: toDeg(lat2), lon: toDeg(lon2) };
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
): Promise<IsochroneResult | null> {
    const cfg = { ...DEFAULT_ISOCHRONE_CONFIG, ...config };
    const depTime = new Date(departureTime);

    const destBearing = initialBearing(origin.lat, origin.lon, destination.lat, destination.lon);
    const totalDistNM = haversineNm(origin.lat, origin.lon, destination.lat, destination.lon);

    // Arrival threshold — within 2 NM of destination
    const ARRIVAL_THRESHOLD_NM = Math.min(2, totalDistNM * 0.05);

    const isochrones: Isochrone[] = [];

    // Seed: departure node
    const startNode: IsochroneNode = {
        lat: origin.lat,
        lon: origin.lon,
        timeHours: 0,
        bearing: destBearing,
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

    // Expand wavefronts
    for (let step = 1; step <= Math.ceil(cfg.maxHours / cfg.timeStepHours); step++) {
        const timeHours = step * cfg.timeStepHours;
        const nextFront: IsochroneNode[] = [];

        // Collect ALL candidate nodes for this step, then batch depth-check
        const candidates: { node: IsochroneNode; distToDest: number }[] = [];

        for (let nodeIdx = 0; nodeIdx < currentFront.length; nodeIdx++) {
            const parent = currentFront[nodeIdx];

            // Fan out in multiple bearings relative to destination bearing
            for (let b = cfg.minBearingDeg; b <= cfg.maxBearingDeg; b += (360 / cfg.bearingCount)) {
                const absoluteBearing = (destBearing + b + 360) % 360;

                // Get wind at parent position and current time
                const wind = windField.getWind(parent.lat, parent.lon, timeHours - cfg.timeStepHours);
                if (!wind) continue;

                const twa = calcTWA(absoluteBearing, wind.direction);
                let boatSpeed: number;

                if (wind.speed < cfg.minWindSpeed) {
                    boatSpeed = cfg.motoringSpeed;
                } else {
                    boatSpeed = polarSpeed(polar, wind.speed, twa);
                    // If the polar says you can't sail this angle (dead upwind),
                    // skip it entirely — do NOT fall back to motoring.
                    // The router will find the VMG-optimal tack angle instead.
                    if (boatSpeed < 0.5) continue;
                }

                // Project position
                const distanceStep = boatSpeed * cfg.timeStepHours;
                const projected = projectPosition(parent.lat, parent.lon, absoluteBearing, distanceStep);

                const node: IsochroneNode = {
                    lat: projected.lat,
                    lon: projected.lon,
                    timeHours,
                    bearing: absoluteBearing,
                    speed: boatSpeed,
                    tws: wind.speed,
                    twa,
                    parentIndex: nodeIdx,
                    distance: parent.distance + distanceStep,
                };

                const distToDest = haversineNm(projected.lat, projected.lon, destination.lat, destination.lon);
                candidates.push({ node, distToDest });
            }
        }

        if (candidates.length === 0) break;

        // Check for arrival FIRST (before pruning/depth check)
        for (const { node, distToDest } of candidates) {
            if (distToDest <= ARRIVAL_THRESHOLD_NM) {
                arrivalNode = { ...node, lat: destination.lat, lon: destination.lon };
                arrivalIsochroneIdx = step;
                break;
            }
            nextFront.push(node);
        }

        if (arrivalNode) {
            isochrones.push({ timeHours, nodes: [arrivalNode] });
            break;
        }

        if (nextFront.length === 0) break;

        // Prune FIRST (fast, in-memory) — reduces ~5000 candidates to ~72 leading nodes
        // Use origin for sector assignment to preserve exploration diversity
        let pruned = pruneWavefront(nextFront, origin, destination, cfg.bearingCount);

        // ── Land avoidance: instant local lookup from preloaded BathymetryCache ──
        if (cfg.useDepthPenalty && bathyGrid && pruned.length > 0) {
            const waterNodes: IsochroneNode[] = [];
            for (const node of pruned) {
                if (isLand(bathyGrid, node.lat, node.lon)) continue; // Reject land
                node.depth_m = getDepthFromCache(bathyGrid, node.lat, node.lon);
                waterNodes.push(node);
            }
            if (waterNodes.length > 0) {
                pruned = waterNodes;
            }
            // If ALL pruned nodes are on land, keep them anyway (graceful degradation)
        } else if (cfg.useDepthPenalty && !bathyGrid && pruned.length > 0) {
            // Fallback: HTTP-based depth check (slow but works without preloaded grid)
            try {
                const depthResults = await GebcoDepthService.queryDepths(
                    pruned.map(n => ({ lat: n.lat, lon: n.lon }))
                );
                const waterNodes: IsochroneNode[] = [];
                for (let i = 0; i < pruned.length; i++) {
                    const depth = depthResults[i]?.depth_m;
                    if (depth !== null && depth >= 0) continue;
                    pruned[i].depth_m = depth;
                    waterNodes.push(pruned[i]);
                }
                if (waterNodes.length > 0) {
                    pruned = waterNodes;
                }
            } catch (depthErr) {
                console.warn(`[Isochrone] Step ${step}: depth check failed, skipping land avoidance`);
            }
        }

        console.info(`[Isochrone] Step ${step}: ${timeHours}h, ${pruned.length} nodes, closest ${Math.round(
            Math.min(...pruned.map(n => haversineNm(n.lat, n.lon, destination.lat, destination.lon)))
        )} NM to dest`);

        isochrones.push({ timeHours, nodes: pruned });
        currentFront = pruned;
    }

    // No route found
    if (!arrivalNode) {
        console.warn('[Isochrone] No route found within max hours');
        return null;
    }

    // Backtrack to reconstruct the optimal route
    const route = backtrack(isochrones, arrivalIsochroneIdx, arrivalNode);

    // ── Smooth the route: remove zig-zag waypoints ──
    const smoothed = smoothRoute(route);

    const arrivalTimeMs = depTime.getTime() + arrivalNode.timeHours * 3600000;

    return {
        route: smoothed,
        isochrones,
        totalDistanceNM: Math.round(arrivalNode.distance * 10) / 10,
        totalDurationHours: Math.round(arrivalNode.timeHours * 10) / 10,
        arrivalTime: new Date(arrivalTimeMs).toISOString(),
        routeCoordinates: smoothed.map(n => [n.lon, n.lat] as [number, number]),
    };
}

// ── Wavefront Pruning ────────────────────────────────────────────

/**
 * Prune a wavefront to keep only the most advanced node in each
 * angular sector. Sectors are based on bearing FROM ORIGIN TO NODE
 * (exploration direction) to maintain diversity across the wavefront.
 */
function pruneWavefront(
    nodes: IsochroneNode[],
    origin: { lat: number; lon: number },
    destination: { lat: number; lon: number },
    sectorCount: number,
): IsochroneNode[] {
    const sectorSize = 360 / sectorCount;
    const sectors: (IsochroneNode | null)[] = new Array(sectorCount).fill(null);

    for (const node of nodes) {
        // Sector by bearing FROM origin TO node (exploration direction)
        const bearing = initialBearing(origin.lat, origin.lon, node.lat, node.lon);
        const sectorIdx = Math.floor(((bearing % 360) + 360) % 360 / sectorSize) % sectorCount;

        const existing = sectors[sectorIdx];
        if (!existing) {
            sectors[sectorIdx] = node;
        } else {
            // Keep the node closest to destination
            const existDist = haversineNm(existing.lat, existing.lon, destination.lat, destination.lon);
            const newDist = haversineNm(node.lat, node.lon, destination.lat, destination.lon);
            if (newDist < existDist) {
                sectors[sectorIdx] = node;
            }
        }
    }

    return sectors.filter(Boolean) as IsochroneNode[];
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
 * is > 90° (sharp turn), remove B. Iterates until stable.
 * Always preserves the first and last waypoints.
 */
function smoothRoute(route: IsochroneNode[]): IsochroneNode[] {
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

            // Remove waypoints with sharp turns (> 90°)
            if (turnAngle > 90) {
                changed = true;
                continue; // Skip this waypoint
            }

            smoothed.push(curr);
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
