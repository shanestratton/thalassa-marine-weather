/**
 * Sea Buoy Finder — Projects harbour/marina waypoints offshore to deep safe water.
 *
 * The isochrone routing engine works best in open ocean. Rather than trying to
 * route through marinas, channels, and harbour approaches (which need specialist
 * pilotage routing), we find the nearest "sea buoy" point in deep water and
 * route between those.
 *
 * Algorithm:
 *   1. Calculate the RHUMB LINE bearing from harbour to destination
 *   2. Project 20 NM along that bearing — first depth check
 *   3. If depth ≥ -50m (too shallow), hop 5 NM further along the same bearing
 *   4. Repeat until -50m or deeper is found, or 55 NM max is reached
 *   5. The deep-water point becomes the "sea buoy" gate
 *
 * Parameters:
 *   INITIAL_OFFSET = 20 NM  — first depth check (clears reefs & coastal features)
 *   STEP_DISTANCE  = 5 NM   — hop distance if too shallow
 *   MIN_SAFE_DEPTH = 50 m   — "Happy Days" threshold (165 ft)
 *   MAX_SEARCH     = 55 NM  — give up limit
 *   REF_BEARING    = Rhumb line from Start → Destination
 */

import { GebcoDepthService } from './GebcoDepthService';

// ── Parameters ─────────────────────────────────────────────────

/** Minimum depth (metres, negative = underwater) to qualify as safe water */
const MIN_SAFE_DEPTH_M = -50;

/** First depth check distance from harbour */
const INITIAL_OFFSET_NM = 20;

/** How far to hop if the water is too shallow */
const STEP_DISTANCE_NM = 5;

/** Total distance limit before giving up */
const MAX_SEARCH_NM = 55;

// ── Types ──────────────────────────────────────────────────────

export interface SeaBuoyResult {
    /** The deep-water point (or original if search failed) */
    lat: number;
    lon: number;
    /** Depth at the sea buoy in metres (negative = underwater) */
    depth_m: number;
    /** Distance from the original waypoint in NM */
    offsetNM: number;
    /** True if the original point was already in deep water */
    alreadyDeep: boolean;
}

// ── Helpers ────────────────────────────────────────────────────

const NM_TO_DEG = 1 / 60; // 1 NM ≈ 1/60°

/**
 * Project a lat/lon by distance and bearing (simple equirectangular).
 */
function projectPoint(
    lat: number,
    lon: number,
    bearingDeg: number,
    distanceNM: number,
): { lat: number; lon: number } {
    const dLat = distanceNM * NM_TO_DEG * Math.cos(bearingDeg * Math.PI / 180);
    const dLon = distanceNM * NM_TO_DEG * Math.sin(bearingDeg * Math.PI / 180)
        / Math.cos(lat * Math.PI / 180);
    return { lat: lat + dLat, lon: lon + dLon };
}

/**
 * Calculate rhumb line bearing from point A to point B (degrees, 0=N, 90=E).
 */
function rhumbBearing(
    lat1: number, lon1: number,
    lat2: number, lon2: number,
): number {
    const φ1 = lat1 * Math.PI / 180;
    const φ2 = lat2 * Math.PI / 180;
    let Δλ = (lon2 - lon1) * Math.PI / 180;

    // Stretched latitude difference for Mercator
    const Δψ = Math.log(
        Math.tan(Math.PI / 4 + φ2 / 2) / Math.tan(Math.PI / 4 + φ1 / 2)
    );

    // Handle crossing the antimeridian
    if (Math.abs(Δλ) > Math.PI) {
        Δλ = Δλ > 0 ? -(2 * Math.PI - Δλ) : (2 * Math.PI + Δλ);
    }

    const bearing = Math.atan2(Δλ, Δψ) * 180 / Math.PI;
    return (bearing + 360) % 360;
}

// ── Main Function ──────────────────────────────────────────────

/**
 * Find the nearest deep-water "sea buoy" point for a given harbour position.
 *
 * Projects along the rhumb line bearing toward the destination, starting at
 * 20 NM, hopping 5 NM at a time until -50m depth is found or 55 NM max.
 *
 * @param lat       Latitude of the harbour waypoint
 * @param lon       Longitude of the harbour waypoint
 * @param destLat   Latitude of the destination (for rhumb line bearing)
 * @param destLon   Longitude of the destination (for rhumb line bearing)
 * @param minDepth  Minimum depth in metres (default -50m)
 * @returns SeaBuoyResult with the deep-water point coordinates
 */
export async function findSeaBuoy(
    lat: number,
    lon: number,
    destLat?: number,
    destLon?: number,
    minDepth: number = MIN_SAFE_DEPTH_M,
): Promise<SeaBuoyResult> {
    // Calculate bearing — use rhumb line to destination if provided
    const bearing = (destLat !== undefined && destLon !== undefined)
        ? rhumbBearing(lat, lon, destLat, destLon)
        : 180; // Default: head south (toward open water in southern hemisphere)

    console.info(`[SeaBuoy] Searching from [${lat.toFixed(3)}, ${lon.toFixed(3)}] bearing ${bearing.toFixed(0)}°`);

    // Step along the bearing: 20 NM, 25 NM, 30 NM, ... up to 55 NM
    for (let dist = INITIAL_OFFSET_NM; dist <= MAX_SEARCH_NM; dist += STEP_DISTANCE_NM) {
        const candidate = projectPoint(lat, lon, bearing, dist);
        const depth = await GebcoDepthService.queryDepth(candidate.lat, candidate.lon);

        console.info(
            `[SeaBuoy] ${dist}NM → [${candidate.lat.toFixed(3)}, ${candidate.lon.toFixed(3)}]: ${depth}m`
        );

        if (depth !== null && depth <= minDepth) {
            console.info(
                `[SeaBuoy] ✓ Found deep water at ${dist}NM: ${depth}m at [${candidate.lat.toFixed(3)}, ${candidate.lon.toFixed(3)}]`
            );
            return {
                lat: candidate.lat,
                lon: candidate.lon,
                depth_m: depth,
                offsetNM: dist,
                alreadyDeep: false,
            };
        }
    }

    // ── Fallback: fan out across multiple bearings ──
    // The rhumb line went over land (e.g. Townsville → Perth).
    // Try ±30°, ±60°, ±90°, ±120°, ±150°, 180° from the original bearing.
    const fanOffsets = [30, -30, 60, -60, 90, -90, 120, -120, 150, -150, 180];
    console.warn(
        `[SeaBuoy] ✗ Rhumb line (${bearing.toFixed(0)}°) failed — fanning out across ${fanOffsets.length} alternate bearings`
    );

    let bestResult: SeaBuoyResult | null = null;

    for (const offset of fanOffsets) {
        const altBearing = (bearing + offset + 360) % 360;

        for (let dist = INITIAL_OFFSET_NM; dist <= MAX_SEARCH_NM; dist += STEP_DISTANCE_NM) {
            const candidate = projectPoint(lat, lon, altBearing, dist);
            const depth = await GebcoDepthService.queryDepth(candidate.lat, candidate.lon);

            if (depth !== null && depth <= minDepth) {
                console.info(
                    `[SeaBuoy] ✓ Found deep water on bearing ${altBearing.toFixed(0)}° at ${dist}NM: ${depth}m`
                );
                bestResult = {
                    lat: candidate.lat,
                    lon: candidate.lon,
                    depth_m: depth,
                    offsetNM: dist,
                    alreadyDeep: false,
                };
                break; // Found deep water on this bearing — done
            }
        }

        // Exit immediately on first find — fan offsets are already closest-first
        if (bestResult) break;
    }

    if (bestResult) return bestResult;

    // Total failure — couldn't find deep water on any bearing
    console.warn(
        `[SeaBuoy] ✗ No deep water found on ANY bearing within ${MAX_SEARCH_NM}NM of [${lat.toFixed(3)}, ${lon.toFixed(3)}]. Manual intervention required.`
    );
    return {
        lat, lon,
        depth_m: 0,
        offsetNM: 0,
        alreadyDeep: false,
    };
}
