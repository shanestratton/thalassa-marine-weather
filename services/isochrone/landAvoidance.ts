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
import type { RouteAdvisory } from '../enc/EncHazardReportService';
import type { EncCautionArea } from '../enc/EncSpatialIndex';
import { failedCellIds } from '../enc/encIndexCache';
import { GEBCO_MSL_TO_LAT_PESSIMISM_M } from '../HazardQueryService';
import { CATZOC_LABELS, type EncAreaGraze, type EncCatzoc } from '../enc/types';
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
    /**
     * Liveness probe for the SINGLETON hazard report (2026-07-17 audit):
     * an un-cancelled validator whose caller had moved on — the timeout
     * won the Promise.race, or a new plan superseded this one — used to
     * finish anyway and overwrite the live report with one computed for
     * a DISCARDED polyline. When this returns false at publish time,
     * phase 5 skips every setLastReport write. Route geometry is still
     * returned (the caller's own guards decide whether to use it).
     */
    stillCurrent?: () => boolean;
    /**
     * False for validators whose polyline is NOT the primary route (the
     * ECMWF model-comparison braid): they must never own the singleton
     * report the HazardReportPanel renders. Default true.
     */
    publishReport?: boolean;
}

/**
 * Build the route-wide "verify visually" advisories for a route that
 * validated CLEAN but carries caveats. Two SEVERITIES (mission audit: the
 * GEBCO-outage no-data path was a silent fail-open; route+warn is only
 * defensible if the warn is LOUD):
 *  - `caution` — NO-DEPTH-DATA points (uncharted AND GEBCO unavailable). The
 *    router still returns a line (availability), and the depth is UNVERIFIED.
 *    Selection applies a capped graded steer-away from unknown/shoal water
 *    (IsochroneRouter candidate ranking, burn-down 2026-07-16), but that is a
 *    preference, not verification — this loud advisory is still the warn
 *    that reaches the skipper. Ranked first.
 *  - `note` — charted but low-confidence CATZOC survey.
 * Pure + exported so the surfacing logic is unit-tested away from the validator.
 */
export function buildRouteAdvisories(
    results: HazardResult[],
    vesselDraftM?: number,
    failedCellIds?: readonly string[],
    segmentTideConstrained = 0,
): RouteAdvisory[] {
    const advisories: RouteAdvisory[] = [];
    // The depth-threshold model clamps draft to 5 m (hazardDepthForDraft) — a
    // deeper vessel silently got 5 m math. Say so (burn-down 2026-07-16).
    if (typeof vesselDraftM === 'number' && vesselDraftM > 5) {
        advisories.push({
            severity: 'caution',
            kind: 'draft-clamp',
            text:
                `Depth checks model a 5 m maximum draft — your ${vesselDraftM.toFixed(1)} m draft ` +
                `exceeds it, so clearances are TIGHTER than shown. Verify depths manually.`,
        });
    }
    // No-data first — it's the louder caution (unknown depth, not just
    // low-confidence). This is the route+warn signal the skipper must see.
    const noDataHits = results.filter((r) => r.source === 'none').length;
    if (noDataHits > 0) {
        advisories.push({
            severity: 'caution',
            kind: 'no-data',
            text:
                `${noDataHits}/${results.length} route point(s) have NO depth data ` +
                `(uncharted + GEBCO unavailable) — routed but NOT confirmed safe, verify visually`,
        });
    }
    // GEBCO-tier verification made visible (2026-07-17 audit finding #1: a
    // corrupt/unloadable ENC cell silently dropped its water to the ~460 m
    // GEBCO raster and the panel showed the same clean face — a route over
    // a charted rock "validated clean" against open-ocean bathymetry).
    // Loud caution when imported cells actually FAILED (that water was
    // supposed to be charted) or when GEBCO carries a large share; plain
    // note for the honest offshore case (genuinely uncharted water).
    const gebcoHits = results.filter((r) => r.source === 'gebco').length;
    if (gebcoHits > 0 && results.length > 0) {
        const pct = Math.round((gebcoHits / results.length) * 100);
        const failed = failedCellIds ?? [];
        const failedNote =
            failed.length > 0
                ? ` ${failed.length} imported chart cell(s) FAILED to load (${failed.slice(0, 3).join(', ')}${
                      failed.length > 3 ? ', …' : ''
                  }) — their water fell back to GEBCO; re-import may be needed.`
                : '';
        advisories.push({
            severity: failed.length > 0 || pct >= 30 ? 'caution' : 'note',
            kind: 'gebco-share',
            text:
                `${gebcoHits}/${results.length} depth check(s) (${pct}%) used ~460 m GEBCO ocean ` +
                `bathymetry, not charted ENC data — shoals smaller than the grid spacing are ` +
                `invisible to it.${failedNote}`,
        });
    }
    // Tide-constrained clearances (audit #4): points that pass the draft
    // check ONLY because of the predicted tide credit. At chart datum
    // that water is too shallow — a leg passable at HW only must not
    // read the same as unconditionally clear water.
    const tideGated = results.filter((r) => r.tideConstrained).length + segmentTideConstrained;
    if (tideGated > 0) {
        advisories.push({
            severity: 'caution',
            kind: 'tide-constrained',
            text:
                `${tideGated} depth check(s) clear ONLY with the predicted tide — at chart ` +
                `datum that water is too shallow for your draft. This leg is tide-constrained: ` +
                `sail it on schedule, and re-plan if your departure or speed slips.`,
        });
    }
    let worstCatzoc: number | null = null;
    for (const r of results) {
        if (typeof r.catzoc !== 'number') continue;
        if (worstCatzoc === null || r.catzoc > worstCatzoc) worstCatzoc = r.catzoc;
    }
    // Gate at ZOC-B (3), not C (4) (burn-down 2026-07-18 #1): ZOC-B carries
    // ±50 m horizontal positional uncertainty — enough that a route validated
    // "clean" against charted positions may in reality graze a drying bank or
    // shoal. B/C/D/U all warrant the "verify depths visually" note; only the
    // fully-systematic A1/A2 surveys (±5 m / ±20 m) are trusted without it.
    if (worstCatzoc !== null && worstCatzoc >= 3) {
        advisories.push({
            severity: 'note',
            kind: 'catzoc',
            // Decoded (closing audit: the advisory printed raw 'CATZOC 5'
            // while the panel rows decode it).
            text: `Low-confidence chart survey along route (ZOC ${CATZOC_LABELS[worstCatzoc as EncCatzoc] ?? worstCatzoc}) — verify depths visually`,
        });
    } else if (worstCatzoc === null && results.some((r) => r.source === 'enc')) {
        // ENC-verified but ZERO M_QUAL data anywhere along the route
        // (audit: quality-unknown coverage read exactly like a good survey).
        advisories.push({
            severity: 'note',
            kind: 'quality-unknown',
            text: 'Chart survey quality is UNASSESSED along this route (no CATZOC data) — treat charted depths with a margin',
        });
    }
    return advisories;
}

/**
 * Summarise the caution AREAS a route crosses into one "check restrictions"
 * advisory ("Route crosses restricted area (entry prohibited) · submarine
 * cable area — check restrictions"). Deduped by class + restriction. Returns
 * null when the route crosses none. Pure + exported for unit testing.
 */
export function describeCautionCrossings(areas: EncCautionArea[]): RouteAdvisory | null {
    if (areas.length === 0) return null;
    const CLS_LABEL: Record<string, string> = {
        RESARE: 'restricted area',
        CBLARE: 'submarine cable area',
        PIPARE: 'pipeline area',
        TSSLPT: 'traffic-separation lane',
    };
    const RESTRN_LABEL: Record<string, string> = {
        '1': 'anchoring prohibited',
        '2': 'anchoring restricted',
        '3': 'fishing prohibited',
        '4': 'fishing restricted',
        '5': 'trawling prohibited',
        '6': 'trawling restricted',
        '7': 'entry prohibited',
        '8': 'entry restricted',
        '14': 'no wake',
        '27': 'no anchoring / no fishing',
    };
    // Entry-prohibited/-restricted crossings outrank the informational
    // "check restrictions" note — transiting one can be an offence, not
    // just a caveat (burn-down: severity tiers).
    const ENTRY_CODES = new Set(['7', '8']);
    const seen = new Set<string>();
    const parts: string[] = [];
    let entryProhibited = false;
    for (const a of areas) {
        const label = CLS_LABEL[a.cls] ?? 'charted area';
        let detail = '';
        if (a.restrn) {
            const codes = a.restrn.split(',').map((r) => r.trim());
            if (codes.some((c) => ENTRY_CODES.has(c))) entryProhibited = true;
            // Unmapped codes must not vanish silently (burn-down: the raw
            // S-57 code is still look-up-able on a paper chart).
            const rs = codes.filter(Boolean).map((c) => RESTRN_LABEL[c] ?? `restriction code ${c}`);
            if (rs.length) detail = ` (${rs.join(', ')})`;
        }
        const key = label + detail;
        if (seen.has(key)) continue;
        seen.add(key);
        parts.push(label + detail);
    }
    return {
        severity: entryProhibited ? 'caution' : 'note',
        kind: 'caution-crossing',
        text: `Route crosses ${parts.join(' · ')} — check restrictions`,
    };
}

/**
 * Turn the worst lateral GRAZE along a route into one advisory (burn-down
 * 2026-07-18 #1). A graze is a leg that validated CLEAN but passes within the
 * chart's ZOC-scaled horizontal positional-uncertainty margin of a charted
 * AREA hazard boundary it does not cross — at that separation "clear" is an
 * assumption, not a promise. Land (drying bank / islet / coast) reads as the
 * louder `caution`; a shoal/obstruction near-miss is a `note`. Null when the
 * route grazes nothing. Pure + exported for unit testing.
 */
/** True when graze `a` is more significant than `b` for the route-wide
 *  advisory: land (drying bank / islet) before shoal/obstruction, then the
 *  closest clearance. Mirrors the cross-cell foldGraze ranking so the pass
 *  accumulator and the per-cell pick agree on which graze surfaces. */
function grazeOutranks(a: EncAreaGraze, b: EncAreaGraze): boolean {
    const aLand = a.type === 'land';
    const bLand = b.type === 'land';
    if (aLand !== bLand) return aLand;
    return a.clearanceM < b.clearanceM;
}

export function describeAreaGraze(graze: EncAreaGraze | null): RouteAdvisory | null {
    if (graze === null) return null;
    const what =
        graze.type === 'land'
            ? 'charted land / a drying bank'
            : graze.type === 'obstruction'
              ? 'a charted obstruction'
              : 'charted shallow water';
    const zoc = graze.catzoc != null ? ` (ZOC ${CATZOC_LABELS[graze.catzoc] ?? graze.catzoc})` : '';
    const clr = Math.round(graze.clearanceM);
    const margin = Math.round(graze.marginM);
    return {
        // Grazing solid ground within position error is the finding's scary
        // case — louder. A shoal near-miss is depth/tide-dependent — a note.
        severity: graze.type === 'land' ? 'caution' : 'note',
        kind: 'lateral-clearance',
        text:
            `Route passes ~${clr} m from ${what} — inside the chart's ±${margin} m ` +
            `positional uncertainty${zoc}. Give it wider berth or verify visually.`,
    };
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
        gebcoDatumDeltaM?: number;
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

    // Set at tide-curve load when ONE station's curve is being applied
    // across a long route (spatial tidal-range variation unmodelled) —
    // appended to the route advisories in both exit branches below.
    let singleStationTideNote: RouteAdvisory | null = null;

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
                // REGIONAL DATUM PESSIMISM (closing audit): scale the GEBCO
                // MSL→LAT delta from the live curve's range instead of the
                // fixed Moreton 1.3 m. Heights are LAT-referenced, so MSL sits
                // near mid-range: delta ≈ 0.6 × observed range (the 0.6 over
                // 0.5 leans pessimistic because a passage-window range
                // underestimates the astronomical extreme at neaps). Floored
                // at the Moreton constant — this can only get MORE cautious.
                const hs = curve.heights.map((h) => h.height).filter((v) => Number.isFinite(v));
                if (hs.length >= 2) {
                    const range = Math.max(...hs) - Math.min(...hs);
                    queryOpts.gebcoDatumDeltaM = Math.max(GEBCO_MSL_TO_LAT_PESSIMISM_M, 0.6 * range);
                }
                landLog.info(
                    `[ValidateRoute] tide curve loaded: ${curve.stationName ?? 'station unknown'} ` +
                        `(${curve.heights.length} heights)`,
                );
                // SPATIAL TIDE HONESTY (burn-down): ONE station's curve gets
                // applied to the whole route, but tidal range varies wildly
                // along the QLD coast (Broad Sound ~8 m vs Moreton ~2 m). On a
                // long route, crediting the midpoint station's tide at a
                // distant shallow can be wrong by metres — say so.
                let routeNm = 0;
                for (let i = 0; i < route.length - 1; i++) {
                    routeNm += haversineNm(route[i].lat, route[i].lon, route[i + 1].lat, route[i + 1].lon);
                }
                if (routeNm > 40) {
                    singleStationTideNote = {
                        severity: 'note',
                        kind: 'single-station-tide',
                        text:
                            `Tide corrections use ONE station near the route midpoint` +
                            `${curve.stationName ? ` (${curve.stationName})` : ''} — over ` +
                            `${Math.round(routeNm)} NM the tidal range varies; verify tides locally ` +
                            `at critical shallows.`,
                    };
                }
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
    let routeAdvisories: RouteAdvisory[] = [];
    // >0 → the loop hit MAX_VALIDATION_PASSES while still inserting detours:
    // the FINAL route revision was never re-verified (mission audit: this
    // exhaustion path used to fall through silently as if clean).
    let unresolvedAfterPasses = 0;
    // Tide-credit-cleared SEGMENT crossings from the latest pass (the
    // sampled-point results carry their own flags; these are the sub-231 m
    // polygon crossings the samples can't see).
    let segTideConstrained = 0;
    // Worst lateral GRAZE from the latest pass (a leg that validated clean but
    // passes within the chart's positional-error margin of an AREA hazard —
    // burn-down 2026-07-18 #1). Reset each pass, surfaced on the clean break.
    let worstGraze: EncAreaGraze | null = null;
    // Set when the segment-vs-polygon crossing check THREW this pass — the
    // sub-231 m thin-islet protection did not run, and a clean report would
    // otherwise hide that silently (burn-down 2026-07-18, the free one-liner).
    let segmentCheckFailed = false;
    // Last pass's sample results — kept so the EXHAUSTION path can still
    // build the no-data / CATZOC advisories (audit: they ran only in the
    // clean branch, dropping them from exactly the least-verified routes).
    let lastAllResults: HazardResult[] = [];

    // Caution-area crossings (restricted / cable / pipeline / TSS) → a
    // "check restrictions" note. NOT a reroute — you can transit most, but a
    // best-in-class ENC tells you. Shared by the clean break AND the
    // exhaustion path (audit: it ran only on clean routes).
    const appendCautionCrossings = async (): Promise<void> => {
        try {
            const cautionSegs = [];
            for (let i = 0; i < result.length - 1; i++) {
                cautionSegs.push({
                    lat1: result[i].lat,
                    lon1: result[i].lon,
                    lat2: result[i + 1].lat,
                    lon2: result[i + 1].lon,
                });
            }
            const perSeg = await HazardQueryService.querySegmentCautions(cautionSegs);
            const advisory = describeCautionCrossings(perSeg.flat());
            if (advisory) routeAdvisories.push(advisory);
        } catch (err) {
            landLog.warn('[ValidateRoute] caution-area crossing check failed', err);
        }
    };

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

        // Sub-231 m legs produce ZERO samples (a short two-waypoint harbour
        // hop). This used to `break` here — BEFORE the segment-vs-polygon
        // crossing test — leaving exactly the shortest routes with no ENC
        // validation at all (burn-down 2026-07-16). Fall through instead:
        // the batch query and sample scan no-op on empty, and the crossing
        // test below still checks the leg against charted polygons.

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
            lastAllResults = allResults; // for the exhaustion path's advisories
        } catch (err) {
            landLog.warn('[ValidateRoute] hazard query FAILED — route NOT validated:', err);
            // LOUD fail-open (audit: this path returned SILENTLY, leaving the
            // PREVIOUS route's hazard report on screen against a brand-new,
            // completely unvalidated line — the one path still violating the
            // repo's loud-warn policy). Clear the stale report and surface an
            // unmissable caution instead.
            try {
                const { setLastReport } = await import('./../enc/EncHazardReportService');
                setLastReport({
                    cellsConsulted: 0,
                    bufferNm: 1.0,
                    entries: [],
                    advisories: [
                        {
                            severity: 'caution',
                            text:
                                'Hazard data was unavailable — this route has NOT been validated ' +
                                'against charts or depths. Verify the entire line visually.',
                        },
                    ],
                });
            } catch {
                /* best effort — the warn log above still fires */
            }
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
                // Midpoint ETA so the segment crossing gets the SAME live tide
                // the sampled points do (querySegmentHazards evaluates tideAt
                // at this time) — else a crossing would grade at the static
                // offset during a swing (audit: dropped tideAt).
                const timeMs =
                    options.departureTimeMs != null &&
                    Number.isFinite(result[i].timeHours) &&
                    Number.isFinite(result[i + 1].timeHours)
                        ? options.departureTimeMs + ((result[i].timeHours + result[i + 1].timeHours) / 2) * 3_600_000
                        : undefined;
                polySegs.push({
                    idx: i,
                    lat1: result[i].lat,
                    lon1: result[i].lon,
                    lat2: result[i + 1].lat,
                    lon2: result[i + 1].lon,
                    exemptStart: i === 0,
                    exemptEnd: i === lastSeg,
                    timeMs,
                });
            }
            segmentCheckFailed = false;
            // Reset BEFORE the try so a thrown check leaves no STALE graze from
            // a prior pass to surface on the clean break (the throw is reported
            // by segmentCheckFailed instead).
            worstGraze = null;
            try {
                const segResults = await HazardQueryService.querySegmentHazards(polySegs, queryOpts);
                segTideConstrained = 0;
                for (let k = 0; k < polySegs.length; k++) {
                    if (segResults[k]?.isHazard && !landSegments.includes(polySegs[k].idx)) {
                        landSegments.push(polySegs[k].idx);
                    }
                    // Closing audit: a crossing cleared ONLY by tide credit
                    // was computed then discarded — count it so the
                    // tide-constrained advisory covers segment hits too.
                    if (segResults[k]?.tideConstrained) segTideConstrained++;
                    // Lateral near-miss of a clean leg to a charted AREA hazard
                    // within the chart's positional-error margin (burn-down #1).
                    const g = segResults[k]?.graze;
                    if (g && (worstGraze === null || grazeOutranks(g, worstGraze))) worstGraze = g;
                }
            } catch (err) {
                landLog.warn('[ValidateRoute] segment-polygon check failed (continuing with sample scan):', err);
                // Loud, not silent: the thin-islet crossing test did not run,
                // so a "clean" report would hide an unverified sub-231 m
                // crossing (closing-audit missed finding). Surface it on the
                // clean break, mirroring the point-path fail-open.
                segmentCheckFailed = true;
            }
        }

        if (landSegments.length === 0) {
            const encHits = allResults.filter((r) => r.source === 'enc').length;
            const gebcoHits = allResults.filter((r) => r.source === 'gebco').length;
            // "verify visually" advisories for a route that validated CLEAN
            // but carries caveats. ATTACHED to the hazard report below so the
            // skipper sees them, and logged at warn() — createLogger silences
            // info() in prod, which is why the old no-data note reached no one.
            routeAdvisories = buildRouteAdvisories(
                allResults,
                options.vesselDraftM,
                failedCellIds(),
                segTideConstrained,
            );
            if (singleStationTideNote) routeAdvisories.push(singleStationTideNote);
            // Lateral clearance: a clean leg that still grazes a charted AREA
            // hazard within the chart's positional-error margin (burn-down #1).
            const grazeAdvisory = describeAreaGraze(worstGraze);
            if (grazeAdvisory) routeAdvisories.push(grazeAdvisory);
            // The thin-islet crossing test threw this pass — say so, rather than
            // present a clean report over an unrun check (burn-down one-liner).
            if (segmentCheckFailed) {
                routeAdvisories.push({
                    severity: 'caution',
                    kind: 'segment-check-failed',
                    text:
                        'The thin-islet crossing check could not run on this route — a charted shoal ' +
                        'or islet narrower than the 231 m sampling may be unverified. Verify the line visually.',
                });
            }
            await appendCautionCrossings();
            const clearMsg =
                `[ValidateRoute] Pass ${pass + 1}: all segments clear ✓ ` +
                `(${allSamples.length} samples — enc=${encHits} gebco=${gebcoHits})` +
                (routeAdvisories.length > 0 ? ` ⚠ ${routeAdvisories.map((a) => a.text).join(' · ')}` : '');
            if (routeAdvisories.length > 0) landLog.warn(clearMsg);
            else landLog.info(clearMsg);
            unresolvedAfterPasses = 0; // clean exit — every segment verified
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
        // If this was the LAST allowed pass, the detours just inserted were
        // never re-verified — record it so the exhaustion caution below fires.
        unresolvedAfterPasses = landSegments.length;
    }

    // ── Exhaustion caution (mission audit: this path fell through SILENTLY,
    // and the old phase-5 comment claimed the route was "guaranteed clear").
    // Hitting the pass limit means the final revision was NOT re-verified and
    // may still cross charted land/shoal — say so, loudly, on the report.
    if (unresolvedAfterPasses > 0) {
        // Exhaustion caution LEADS, then the standard no-data/CATZOC
        // advisories from the last pass + the caution crossings — the
        // least-verified routes get MORE context, not less (audit: these
        // used to run only in the clean branch).
        routeAdvisories = [
            {
                severity: 'caution',
                kind: 'exhaustion',
                text:
                    `Route validation hit its ${MAX_VALIDATION_PASSES}-pass limit with ` +
                    `${unresolvedAfterPasses} segment(s) still being detoured — the final revision was ` +
                    `NOT re-verified and may still cross charted land or shoal. Verify the drawn line visually.`,
            },
            ...buildRouteAdvisories(lastAllResults, options.vesselDraftM, failedCellIds(), segTideConstrained),
        ];
        if (singleStationTideNote) routeAdvisories.push(singleStationTideNote);
        await appendCautionCrossings();
        landLog.warn(
            `[ValidateRoute] EXHAUSTED ${MAX_VALIDATION_PASSES} passes with ${unresolvedAfterPasses} ` +
                `segment(s) unresolved — route NOT verified clear`,
        );
    }

    // ── Phase 5: Hazard proximity report ─────────────────────────
    // After a CLEAN validation pass the route is clear of charted
    // hazards at the sampled + segment-crossing tests; on pass-limit
    // exhaustion it is NOT verified (the loud exhaustion caution above
    // owns that case — the old "guaranteed clear" claim here was false).
    // Either way the user still wants to know about charted
    // obstructions / wrecks / rocks NEAR the route — a wreck 0.4 NM
    // off the rhumbline is worth flagging even though we won't be
    // routing through it.
    //
    // We import dynamically so the hazard-report module isn't pulled
    // into routes that don't have any ENC coverage (it'd no-op
    // anyway, but avoiding the import keeps cold-start lean).
    // Publish gate (2026-07-17 audit): a superseded validator (timeout won
    // the caller's race, or a newer plan started) must not overwrite the
    // live report with one for a discarded polyline — and the ECMWF braid
    // never owns the report at all. Checked again AFTER the await below:
    // the report walk itself can take seconds, plenty of time to go stale.
    const mayPublish = (): boolean => (options.publishReport ?? true) && (options.stillCurrent?.() ?? true);
    if (!mayPublish()) {
        landLog.warn('[ValidateRoute] report publish skipped — superseded or non-primary polyline');
    } else if (HazardQueryService.hasEncCoverageFor([bboxMinLon, bboxMinLat, bboxMaxLon, bboxMaxLat])) {
        try {
            const { findHazardsAlongRoute, setLastReport } = await import('./../enc/EncHazardReportService');
            const report = await findHazardsAlongRoute(result.map((n) => ({ lat: n.lat, lon: n.lon })));
            if (!mayPublish()) {
                landLog.warn('[ValidateRoute] report publish skipped — went stale during hazard walk');
                return result;
            }
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
            if (mayPublish()) {
                setLastReport(
                    routeAdvisories.length > 0
                        ? { cellsConsulted: 0, bufferNm: 1.0, entries: [], advisories: routeAdvisories }
                        : null,
                );
            }
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
