/**
 * Hazard Query Service — unified facade over ENC (vector) and
 * GEBCO (bathymetric raster) hazard data.
 *
 * This is the only service `landAvoidance.ts` should call for
 * "is there a hazard at these points?" questions. Internally it:
 *
 *   1. Asks EncHazardService for every point.
 *   2. For points an ENC cell covered authoritatively, returns
 *      that result (skipping GEBCO entirely — faster + more
 *      accurate).
 *   3. For points no ENC cell covers, falls back to a batched
 *      GebcoDepthService query and synthesises a HazardResult
 *      from the depth threshold.
 *
 * The returned `HazardResult` carries enough provenance for the
 * router to log/UI-surface "this leg was validated against ENC
 * cell AU530150 + GEBCO."
 *
 * Conventions:
 *  - `depth_m` follows GEBCO convention: negative = below sea
 *    level, positive = above. ENC depths (S-57 convention,
 *    positive = below) are negated on the way out.
 *  - `isHazard` is the canonical "should the router avoid this
 *    point" signal. It bakes in the depth threshold so callers
 *    don't have to.
 */

import { createLogger } from '../utils/createLogger';
import { GebcoDepthService } from './GebcoDepthService';
import * as EncHazardService from './enc/EncHazardService';
import type { EncHazardResult, EncHazardType } from './enc/types';
import { ENC_HAZARD_DEPTH_M } from './enc/types';

const log = createLogger('HazardQueryService');

// ── Types ──────────────────────────────────────────────────────────

/**
 * Source of a HazardResult. `'none'` means we have no data for the
 * point (e.g. GEBCO offline + no ENC coverage); the router should
 * be conservative.
 */
export type HazardSource = 'enc' | 'gebco' | 'none';

export interface HazardQueryPoint {
    lat: number;
    lon: number;
}

export interface HazardResult {
    lat: number;
    lon: number;
    /**
     * True if the router should avoid this point. Combines
     * land/reef/obstruction signals with depth-threshold logic.
     */
    isHazard: boolean;
    /**
     * Depth in metres, GEBCO convention (negative = below sea
     * level). Null if depth unknown (still may be a hazard via
     * `isHazard` if e.g. an ENC marked it as land).
     */
    depth_m: number | null;
    source: HazardSource;
    /** ENC cell ID if the answer came from ENC. */
    cellId?: string;
    /** ENC hazard category if applicable. */
    hazardType?: EncHazardType;
}

// ── GEBCO threshold ────────────────────────────────────────────────

/**
 * Below-this-depth = hazard, in GEBCO convention (negative metres).
 * Matches the `GEBCO_HAZARD_DEPTH_M = -15` constant in
 * landAvoidance.ts and the ENC threshold (`+15` in S-57 convention).
 */
const GEBCO_HAZARD_DEPTH_M = -15;

function gebcoIsHazard(depth_m: number | null): boolean {
    if (depth_m == null) return false; // No data → don't flag.
    return depth_m > GEBCO_HAZARD_DEPTH_M;
}

// ── ENC → HazardResult adapter ─────────────────────────────────────

/**
 * Project an EncHazardResult onto our unified HazardResult shape.
 *
 * Depth conversion: ENC stores depth as positive S-57 metres; we
 * flip sign to match GEBCO convention.
 */
function encToHazardResult(point: HazardQueryPoint, enc: EncHazardResult): HazardResult {
    const flippedDepth = enc.minDepthM == null ? null : -Math.abs(enc.minDepthM);
    return {
        lat: point.lat,
        lon: point.lon,
        isHazard: enc.hazard,
        depth_m: flippedDepth,
        source: 'enc',
        cellId: enc.cellId,
        hazardType: enc.hazardType,
    };
}

// ── Public API ────────────────────────────────────────────────────

/**
 * True if any ENC cells are imported. Used by callers (e.g. the
 * routing UI) to decide whether to surface "ENC-validated" badges.
 */
export function hasEncCoverage(): boolean {
    return EncHazardService.hasAnyCells();
}

/**
 * True if at least one imported ENC cell intersects `bbox`. Used
 * by the routing engine to decide whether to call
 * `preloadEncForBBox` before a long batch of queries.
 */
export function hasEncCoverageFor(bbox: [number, number, number, number]): boolean {
    return EncHazardService.hasCoverageFor(bbox);
}

/**
 * Pre-warm ENC spatial indexes for a bounding box. Optional but
 * recommended at the start of routing — moves the index-build
 * cost off the first hot-path query.
 */
export async function preloadEncForBBox(bbox: [number, number, number, number]): Promise<void> {
    return EncHazardService.preloadForBBox(bbox);
}

/**
 * Batch-query hazards for an array of points.
 *
 * Returned array is parallel to the input — same length, same
 * order. Each entry carries provenance (`source` field) so the
 * caller can log/UI-surface which data source answered.
 *
 * Performance:
 *  - ENC checks are in-memory + O(log n) per point.
 *  - GEBCO calls are batched to a single edge-function request
 *    per `GEBCO_BATCH_SIZE` chunk in landAvoidance (caller-owned).
 *  - When a route is fully ENC-covered, we make ZERO GEBCO calls.
 */
export async function queryHazards(points: HazardQueryPoint[]): Promise<HazardResult[]> {
    if (points.length === 0) return [];

    // ── Phase 1: ENC pass ─────────────────────────────────────────
    const encResults = await EncHazardService.queryHazards(points);

    // Collect points that were NOT covered by any ENC cell — these
    // need GEBCO.
    const gebcoNeeded: HazardQueryPoint[] = [];
    const gebcoIndexMap: number[] = []; // Maps gebcoNeeded[i] → original index.
    const out: HazardResult[] = new Array(points.length);

    for (let i = 0; i < points.length; i++) {
        const enc = encResults[i];
        if (enc.covered) {
            out[i] = encToHazardResult(points[i], enc);
        } else {
            gebcoNeeded.push(points[i]);
            gebcoIndexMap.push(i);
        }
    }

    // ── Phase 2: GEBCO fallback for uncovered points ──────────────
    if (gebcoNeeded.length > 0) {
        try {
            const gebcoResults = await GebcoDepthService.queryDepths(gebcoNeeded);
            for (let j = 0; j < gebcoResults.length; j++) {
                const idx = gebcoIndexMap[j];
                const g = gebcoResults[j];
                out[idx] = {
                    lat: points[idx].lat,
                    lon: points[idx].lon,
                    isHazard: gebcoIsHazard(g.depth_m),
                    depth_m: g.depth_m,
                    source: g.depth_m == null ? 'none' : 'gebco',
                };
            }
        } catch (err) {
            log.warn('GEBCO fallback failed; marking uncovered points as no-data', err);
            for (const idx of gebcoIndexMap) {
                out[idx] = {
                    lat: points[idx].lat,
                    lon: points[idx].lon,
                    isHazard: false, // Conservative: don't false-positive on offline GEBCO.
                    depth_m: null,
                    source: 'none',
                };
            }
        }
    }

    if (process.env.NODE_ENV !== 'production') {
        const encHits = out.filter((r) => r.source === 'enc').length;
        const gebcoHits = out.filter((r) => r.source === 'gebco').length;
        const noData = out.filter((r) => r.source === 'none').length;
        log.info(`queryHazards(${points.length}): enc=${encHits} gebco=${gebcoHits} none=${noData}`);
    }

    return out;
}

// ── Constants re-exported for backward compatibility ──────────────

/**
 * Re-exported so callers that previously imported from
 * landAvoidance.ts can keep using the same constant after the
 * refactor.
 */
export const HAZARD_DEPTH_M_GEBCO = GEBCO_HAZARD_DEPTH_M;
export const HAZARD_DEPTH_M_ENC = ENC_HAZARD_DEPTH_M;
