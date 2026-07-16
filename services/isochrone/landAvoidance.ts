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
import * as HazardQueryService from '../HazardQueryService';
import type { HazardResult } from '../HazardQueryService';
import { createLogger } from '../../utils/createLogger';

const landLog = createLogger('LandAvoidance');

// ── Hazard minimum depth: reefs, sandbanks, coral below this are rejected ──
const REEF_REJECTION_DEPTH_M = -15; // ETOPO: negative = underwater

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
                if (isSegmentNavigable(grid, A.lat, A.lon, C.lat, C.lon)) {
                    toRemove.add(i);
                    continue;
                }
            }

            // Short-segment zigzag: if A→B is under 80NM and turn is >35°, remove
            const abDist = haversineNm(A.lat, A.lon, B.lat, B.lon);
            if (abDist < 80 && bearingChange > 35) {
                if (isSegmentNavigable(grid, A.lat, A.lon, C.lat, C.lon)) {
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
                    if (isSegmentNavigable(grid, A.lat, A.lon, C.lat, C.lon)) {
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

/** Spacing between GEBCO sample points along each segment (NM).
 *  GEBCO_2024 source is 15 arc-seconds ≈ 460m at the equator. By Nyquist,
 *  reliable detection of every pixel a route diagonally crosses requires
 *  sampling at 2× source resolution → 230m ≈ 0.125 NM. This costs ~4×
 *  the GEBCO calls vs. 0.5 NM but eliminates the aliasing failure mode
 *  where a route threads between adjacent samples and skips a hazard
 *  pixel. Reasonable cap: anything finer than 0.125 NM is genuinely
 *  redundant against this source. */
const FINE_SAMPLE_SPACING_NM = 0.125;

/** Maximum batch size for a single GEBCO edge function call */
const GEBCO_BATCH_SIZE = 400;

/** Maximum recursion depth when fixing an island-crossing segment.
 *  Bumped from 4 to 6 — coastal routes through archipelagos (Nouméa
 *  → Île des Pins style: Île Ouen + Récif de Sainte-Marie + reef
 *  belts around the destination) need more subdivision than a single
 *  island in open water. */
const MAX_FIX_DEPTH = 6;

/** Maximum passes over the full route to fix all island crossings.
 *  Bumped from 3 to 5 for the same reason — each pass clears one
 *  layer of crossings; complex multi-island geometry needs more. */
const MAX_VALIDATION_PASSES = 5;

/**
 * Generate sample points along a great-circle segment at FINE_SAMPLE_SPACING_NM intervals.
 * Returns array of {lat, lon, frac} where frac is 0..1 along the segment.
 *
 * Hazard threshold logic (was the local GEBCO_HAZARD_DEPTH_M = -15 constant)
 * now lives in HazardQueryService, which is the single source of truth for
 * "is this a hazard?" judgements across both ENC and GEBCO data.
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
 * Check if a segment crosses land or shallow hazards using the
 * unified HazardQueryService results (ENC where available, GEBCO
 * otherwise). Returns the index of the first hazardous sample, or
 * -1 if clear.
 *
 * Each result carries the canonical `isHazard` flag — ENC's
 * spatial-index judgement when an ENC cell covers the point, the
 * GEBCO depth threshold elsewhere — so we no longer have to apply
 * the threshold ourselves.
 */
function findHazardInResults(results: HazardResult[], startIdx: number, count: number): number {
    for (let i = 0; i < count; i++) {
        if (results[startIdx + i]?.isHazard) return i;
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
/**
 * Optional caller knobs for `validateRouteSegments`.
 */
export interface ValidateRouteOptions {
    /**
     * Vessel draft in metres. Drives the depth threshold used to
     * decide whether a sample point is too shallow. When omitted,
     * the HazardQueryService 2.5 m default is used.
     *
     * Wired through both the GEBCO threshold check and the ENC
     * `shallow` polygon re-evaluation, so a 1.5 m centreboarder
     * doesn't get blocked from anchorages a 3 m keelboat couldn't
     * touch — and vice versa.
     */
    vesselDraftM?: number;
    /**
     * Static tide offset above chart datum, metres. Used as a
     * fallback when `departureTimeMs` isn't provided (or when the
     * tide service can't reach a station). Default 0 = worst-case
     * (chart datum, lowest astronomical tide).
     */
    tideOffsetM?: number;
    /**
     * Departure time of the route as epoch ms. When supplied, the
     * validator fetches a real tide curve at the route midpoint
     * and applies per-waypoint tide correction during hazard
     * checks (each sample point gets its actual ETA tide, not a
     * uniform offset).
     *
     * Each route IsochroneNode carries a `timeHours` field; we
     * compute per-segment ETAs from that and the curve does
     * synchronous lookups during the hot validation loop.
     *
     * If the tide fetch fails (no Pi, no internet, no station
     * nearby), the validator silently degrades to `tideOffsetM`.
     */
    departureTimeMs?: number;
}

export async function validateRouteSegments(
    route: IsochroneNode[],
    options: ValidateRouteOptions = {},
): Promise<IsochroneNode[]> {
    if (route.length < 2) return route;

    let result = [...route];
    const queryOpts: {
        vesselDraftM?: number;
        tideOffsetM?: number;
        tideAt?: (p: { lat: number; lon: number; timeMs?: number }) => number | null;
    } = {
        vesselDraftM: options.vesselDraftM,
        tideOffsetM: options.tideOffsetM,
    };

    // Pre-warm any ENC spatial indexes covering the route bbox so the
    // first hot-path query doesn't pay the index-build cost.
    let bboxMinLon = Infinity;
    let bboxMinLat = Infinity;
    let bboxMaxLon = -Infinity;
    let bboxMaxLat = -Infinity;
    for (const node of route) {
        if (node.lon < bboxMinLon) bboxMinLon = node.lon;
        if (node.lat < bboxMinLat) bboxMinLat = node.lat;
        if (node.lon > bboxMaxLon) bboxMaxLon = node.lon;
        if (node.lat > bboxMaxLat) bboxMaxLat = node.lat;
    }
    if (
        Number.isFinite(bboxMinLon) &&
        HazardQueryService.hasEncCoverageFor([bboxMinLon, bboxMinLat, bboxMaxLon, bboxMaxLat])
    ) {
        try {
            await HazardQueryService.preloadEncForBBox([bboxMinLon, bboxMinLat, bboxMaxLon, bboxMaxLat]);
            landLog.info('[ValidateRoute] ENC coverage detected — preloaded spatial indexes');
        } catch (err) {
            landLog.warn('[ValidateRoute] ENC preload failed (continuing with GEBCO only)', err);
        }
    }

    // ── Per-waypoint tide curve ──────────────────────────────────
    // When the caller supplied a departure time, fetch a real tide
    // curve at the route midpoint covering the planned passage.
    // The curve gets passed into queryHazards as a per-point
    // callback so each sample's ETA gets its own tide correction.
    //
    // Failure modes (no Pi, no internet, no nearby station) just
    // fall through to the static `tideOffsetM` fallback — the
    // validator never blocks routing on tide availability.
    if (options.departureTimeMs && Number.isFinite(bboxMinLon)) {
        try {
            const lastNode = route[route.length - 1];
            const totalDurMs = Math.max(60_000, (lastNode.timeHours ?? 0) * 3600 * 1000);
            const startMs = options.departureTimeMs;
            const endMs = startMs + totalDurMs + 30 * 60 * 1000; // 30-min slack for arrival.
            const midLat = (bboxMinLat + bboxMaxLat) / 2;
            const midLon = (bboxMinLon + bboxMaxLon) / 2;
            const { fetchTideCurve } = await import('../TideHeightService');
            const curve = await fetchTideCurve(midLat, midLon, startMs, endMs);
            if (curve) {
                queryOpts.tideAt = (p) => (p.timeMs != null ? curve.heightAt(p.timeMs) : null);
                landLog.info(
                    `[ValidateRoute] tide curve loaded: ${curve.stationName ?? 'station unknown'} ` +
                        `(${curve.heights.length} heights)`,
                );
            } else {
                landLog.info('[ValidateRoute] no tide curve available — falling back to static tideOffsetM');
            }
        } catch (err) {
            landLog.warn('[ValidateRoute] tide curve fetch failed', err);
        }
    }

    // Route-wide "verify visually" advisories for a route that validates
    // CLEAN but carries caveats (low-confidence survey, no-depth-data
    // points). Populated in the clean-break below and ATTACHED to the
    // hazard report so the skipper actually sees them.
    let routeAdvisories: string[] = [];

    for (let pass = 0; pass < MAX_VALIDATION_PASSES; pass++) {
        // ── 1. Sample all segments ──
        // Each sample carries an optional timeMs computed from the
        // segment endpoints' timeHours + the route departure. The
        // tide callback reads this for per-waypoint correction.
        const allSamples: { lat: number; lon: number; timeMs?: number }[] = [];
        const segmentMeta: { startSampleIdx: number; sampleCount: number }[] = [];

        for (let i = 0; i < result.length - 1; i++) {
            const a = result[i];
            const b = result[i + 1];
            const startIdx = allSamples.length;
            const interior = sampleSegment(a.lat, a.lon, b.lat, b.lon);
            // sampleSegment excludes both endpoints and returns [] for legs
            // under FINE_SAMPLE_SPACING_NM (231 m), so a hazard sitting AT an
            // interior turn-point, or anywhere on a short marina/canal leg,
            // got ZERO ENC validation — and the 150 m point-hazard guard is
            // useless if the router never samples near the waypoint (audit #2).
            // Prepend the segment's START waypoint for INTERIOR segments only
            // (i >= 1). The route's own origin (i === 0's start) and
            // destination (last b) stay unchecked on purpose — they're the
            // user's chosen anchorage/berth, often intentionally in shoal
            // water, and must never trigger a detour AWAY from themselves.
            const samples = i >= 1 ? [{ lat: a.lat, lon: a.lon, frac: 0 }, ...interior] : interior;
            const aTimeMs =
                options.departureTimeMs != null && Number.isFinite(a.timeHours)
                    ? options.departureTimeMs + a.timeHours * 3_600_000
                    : undefined;
            const bTimeMs =
                options.departureTimeMs != null && Number.isFinite(b.timeHours)
                    ? options.departureTimeMs + b.timeHours * 3_600_000
                    : undefined;
            for (const s of samples) {
                let timeMs: number | undefined;
                if (aTimeMs != null && bTimeMs != null) {
                    timeMs = aTimeMs + s.frac * (bTimeMs - aTimeMs);
                }
                allSamples.push({ lat: s.lat, lon: s.lon, timeMs });
            }
            segmentMeta.push({ startSampleIdx: startIdx, sampleCount: samples.length });
        }

        if (allSamples.length === 0) break;

        // ── 2. Batch-query unified hazards (ENC where covered, GEBCO elsewhere) ──
        const allResults: HazardResult[] = [];
        try {
            // Batch size still applies to the GEBCO portion of any
            // query; HazardQueryService internally short-circuits
            // ENC-covered points so we don't waste edge-fn calls.
            for (let batchStart = 0; batchStart < allSamples.length; batchStart += GEBCO_BATCH_SIZE) {
                const batch = allSamples.slice(batchStart, batchStart + GEBCO_BATCH_SIZE);
                const batchResults = await HazardQueryService.queryHazards(batch, queryOpts);
                allResults.push(...batchResults);
            }
        } catch (err) {
            landLog.warn('[ValidateRoute] hazard query failed, skipping island validation:', err);
            return result;
        }

        // ── 3. Find segments that cross land ──
        const landSegments: number[] = [];
        for (let i = 0; i < segmentMeta.length; i++) {
            const { startSampleIdx, sampleCount } = segmentMeta[i];
            if (sampleCount === 0) continue;
            const hazardIdx = findHazardInResults(allResults, startSampleIdx, sampleCount);
            if (hazardIdx >= 0) {
                landSegments.push(i);
            }
        }

        // ── 3b. Segment-vs-polygon crossing (ENC only, audit #1) ──────
        // The per-sample scan above misses a charted shoal DEPARE / LNDARE
        // islet NARROWER than the 231 m sampling that sits BETWEEN two
        // samples. Test EVERY segment's polygon crossings directly — including
        // the terminal legs and a 2-waypoint direct route (the earlier
        // interior-only gate left those untested). The route's origin
        // (segment 0's start) and destination (last segment's end) are the
        // user's chosen berth, often intentionally in shoal water, so those
        // TERMINALS are berth-exempt: segmentHazard skips a polygon they sit
        // INSIDE (so we never detour a route away from its own start/finish),
        // while a thin islet the leg actually crosses still flags.
        {
            const lastSeg = segmentMeta.length - 1;
            const polySegs = [];
            for (let i = 0; i < segmentMeta.length; i++) {
                polySegs.push({
                    idx: i,
                    lat1: result[i].lat,
                    lon1: result[i].lon,
                    lat2: result[i + 1].lat,
                    lon2: result[i + 1].lon,
                    exemptStart: i === 0,
                    exemptEnd: i === lastSeg,
                });
            }
            try {
                const segResults = await HazardQueryService.querySegmentHazards(polySegs, queryOpts);
                for (let k = 0; k < polySegs.length; k++) {
                    if (segResults[k]?.isHazard && !landSegments.includes(polySegs[k].idx)) {
                        landSegments.push(polySegs[k].idx);
                    }
                }
            } catch (err) {
                landLog.warn('[ValidateRoute] segment-polygon check failed (continuing with sample scan):', err);
            }
        }

        if (landSegments.length === 0) {
            const encHits = allResults.filter((r) => r.source === 'enc').length;
            const gebcoHits = allResults.filter((r) => r.source === 'gebco').length;
            // Build "verify visually" advisories for a route that validated
            // CLEAN but carries caveats. These get ATTACHED to the hazard
            // report below so the skipper actually sees them, and are logged
            // at warn() level — createLogger silences info() in prod, which
            // is exactly why the old no-data note never reached anyone.
            routeAdvisories = [];
            // Flag any ENC point in a low-confidence (CATZOC C/D/U) zone.
            let worstCatzoc: number | null = null;
            for (const r of allResults) {
                if (typeof r.catzoc !== 'number') continue;
                if (worstCatzoc === null || r.catzoc > worstCatzoc) worstCatzoc = r.catzoc;
            }
            if (worstCatzoc !== null && worstCatzoc >= 4) {
                routeAdvisories.push(
                    `Low-confidence ENC survey along route (worst CATZOC ${worstCatzoc}) — verify visually`,
                );
            }
            // No-data points (uncharted + GEBCO unavailable, source:'none')
            // are treated as passable so a GEBCO outage can't block routing —
            // but they are NOT confirmed clear, so surface them rather than
            // let the false-clear stay silent (mission-audit hardening).
            const noDataHits = allResults.filter((r) => r.source === 'none').length;
            if (noDataHits > 0) {
                routeAdvisories.push(
                    `${noDataHits}/${allResults.length} route point(s) have NO depth data ` +
                        `(uncharted + GEBCO unavailable) — NOT confirmed safe, verify visually`,
                );
            }
            const clearMsg =
                `[ValidateRoute] Pass ${pass + 1}: all segments clear ✓ ` +
                `(${allSamples.length} samples — enc=${encHits} gebco=${gebcoHits})` +
                (routeAdvisories.length > 0 ? ` ⚠ ${routeAdvisories.join(' · ')}` : '');
            if (routeAdvisories.length > 0) landLog.warn(clearMsg);
            else landLog.info(clearMsg);
            break;
        }

        landLog.info(`[ValidateRoute] Pass ${pass + 1}: ${landSegments.length} segments cross land/reefs — fixing`);

        // ── 4. Fix each land-crossing segment by inserting detour waypoints ──
        const fixed: IsochroneNode[] = [result[0]];

        for (let i = 0; i < result.length - 1; i++) {
            if (landSegments.includes(i)) {
                const a = result[i];
                const b = result[i + 1];
                const detour = await findDetourAroundIsland(a, b, 0, queryOpts);
                if (detour.length > 0) {
                    fixed.push(...detour);
                }
            }
            fixed.push(result[i + 1]);
        }

        result = fixed;
    }

    // ── Phase 5: Hazard proximity report ─────────────────────────
    // After validation succeeds the route is guaranteed clear of
    // hazards. But the user still wants to know about charted
    // obstructions / wrecks / rocks NEAR the route — a wreck 0.4 NM
    // off the rhumbline is worth flagging even though we won't be
    // routing through it.
    //
    // We import dynamically so the hazard-report module isn't pulled
    // into routes that don't have any ENC coverage (it'd no-op
    // anyway, but avoiding the import keeps cold-start lean).
    if (HazardQueryService.hasEncCoverageFor([bboxMinLon, bboxMinLat, bboxMaxLon, bboxMaxLat])) {
        try {
            const { findHazardsAlongRoute, setLastReport } = await import('./../enc/EncHazardReportService');
            const report = await findHazardsAlongRoute(result.map((n) => ({ lat: n.lat, lon: n.lon })));
            setLastReport(routeAdvisories.length > 0 ? { ...report, advisories: routeAdvisories } : report);
            if (report.entries.length > 0) {
                landLog.info(
                    `[ValidateRoute] ${report.entries.length} hazards within ${report.bufferNm.toFixed(1)} NM of route`,
                );
            }
        } catch (err) {
            landLog.warn('[ValidateRoute] hazard report generation failed', err);
        }
    } else {
        // No ENC coverage → clear any stale report from a previous route so
        // the UI doesn't show outdated data. BUT if the clean route still
        // carries route-wide advisories (e.g. no-depth-data points during a
        // GEBCO outage over uncharted water), surface those as an entry-less
        // report rather than dropping them silently.
        try {
            const { setLastReport } = await import('./../enc/EncHazardReportService');
            setLastReport(
                routeAdvisories.length > 0
                    ? { cellsConsulted: 0, bufferNm: 1.0, entries: [], advisories: routeAdvisories }
                    : null,
            );
        } catch {
            /* best effort */
        }
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
async function findDetourAroundIsland(
    a: IsochroneNode,
    b: IsochroneNode,
    depth: number,
    queryOpts: { vesselDraftM?: number; tideOffsetM?: number },
): Promise<IsochroneNode[]> {
    if (depth >= MAX_FIX_DEPTH) return [];

    const midLat = (a.lat + b.lat) / 2;
    const midLon = (a.lon + b.lon) / 2;
    const segBearing = initialBearing(a.lat, a.lon, b.lat, b.lon);
    const leftBearing = (segBearing - 90 + 360) % 360;
    const rightBearing = (segBearing + 90) % 360;

    // Push distances bumped from [5, 10, 15, 20, 30] to include
    // longer reaches. For coastal routes through archipelagos (e.g.
    // Nouméa → Île des Pins via Île Ouen) a 30 NM perpendicular
    // push from the segment midpoint can land on another island or
    // reef belt; 50-70 NM gets you to deep water reliably. Smaller
    // pushes are still tried first so the algorithm keeps the
    // detour minimal when one is achievable.
    const PUSH_DISTANCES = [5, 10, 15, 20, 30, 45, 65];
    const BEARINGS = [leftBearing, rightBearing];

    // ── 1. Generate all candidate detour points ──
    const candidates: { pt: { lat: number; lon: number }; pushNM: number; bearing: number }[] = [];
    for (const pushNM of PUSH_DISTANCES) {
        for (const bearing of BEARINGS) {
            const pt = projectPosition(midLat, midLon, bearing, pushNM);
            candidates.push({ pt, pushNM, bearing });
        }
    }

    // ── 2. Batch-query all candidate points in ONE call (ENC + GEBCO unified) ──
    const candidateResults = await HazardQueryService.queryHazards(
        candidates.map((c) => ({ lat: c.pt.lat, lon: c.pt.lon })),
        queryOpts,
    );

    // ── 3. Find the first water-based candidate (smallest push first) ──
    for (let i = 0; i < candidates.length; i++) {
        if (candidateResults[i]?.isHazard) continue; // Land/reef/shoal/wreck/rock — skip

        const { pt, pushNM, bearing } = candidates[i];

        // Validate both sub-segments with a single batched call
        const samplesA = sampleSegment(a.lat, a.lon, pt.lat, pt.lon);
        const samplesB = sampleSegment(pt.lat, pt.lon, b.lat, b.lon);
        const allSubSamples = [...samplesA, ...samplesB];

        if (allSubSamples.length > 0) {
            const subResults = await HazardQueryService.queryHazards(
                allSubSamples.map((s) => ({ lat: s.lat, lon: s.lon })),
                queryOpts,
            );
            const hasHazard = subResults.some((r) => r.isHazard);
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

        const dataSource = candidateResults[i]?.source ?? 'gebco';
        landLog.info(
            `[ValidateRoute] Detour: pushed ${pushNM} NM ${bearing === leftBearing ? 'port' : 'starboard'} (source=${dataSource}, depth=${depth})`,
        );
        return [detourNode];
    }

    // ── 4. Simple push failed — try recursive subdivision ──
    // Find a water-based midpoint from the candidates we already queried
    for (let i = 0; i < candidates.length; i++) {
        if (candidateResults[i]?.isHazard) continue; // Land/reef/shoal

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

        const leftFixes = await findDetourAroundIsland(a, waterMid, depth + 1, queryOpts);
        const rightFixes = await findDetourAroundIsland(waterMid, b, depth + 1, queryOpts);
        return [...leftFixes, waterMid, ...rightFixes];
    }

    landLog.warn('[ValidateRoute] Could not find detour — segment remains as-is');
    return [];
}
