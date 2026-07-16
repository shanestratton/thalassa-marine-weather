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
import type { EncCatzoc, EncHazardResult, EncHazardType } from './enc/types';
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
    /**
     * Optional: when this point will be reached, in epoch ms.
     * Used by the per-point tide lookup. Caller computes from the
     * route's departure time + segment-time interpolation.
     */
    timeMs?: number;
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
    /**
     * S-57 CATZOC value at this point (1=A1 best, 6=U unassessed),
     * when the answering ENC cell ships M_QUAL data. Always null
     * for GEBCO results.
     */
    catzoc?: EncCatzoc | null;
}

// ── Hazard threshold ──────────────────────────────────────────────

/**
 * Default vessel draft used when the caller doesn't supply one.
 * 2.5 m matches the existing fallback used elsewhere in the
 * codebase (services/departureWindow.ts, services/isochroneEnhancer.ts).
 */
const DEFAULT_VESSEL_DRAFT_M = 2.5;

/**
 * Compute the routing hazard depth threshold (GEBCO convention,
 * negative metres) from a vessel's draft.
 *
 * Formula: -(draft × 1.5 + 0.5) m — keeps the "danger zone"
 * boundary used by the existing depth-classification logic
 * (GebcoDepthService comments: ≤1.5× draft = grounding risk),
 * with a 0.5 m safety margin for swell, sounding error and tide.
 *
 * Examples:
 *   2.0 m draft → -3.5  m   shallower-than threshold for hazard
 *   2.5 m draft → -4.25 m
 *   3.0 m draft → -5.0  m
 *
 * The previous codebase used a hard-coded -15 m globally, which
 * would falsely flag any 14 m channel for a 2 m sailboat.
 */
export function hazardDepthForDraft(draftM: number | null | undefined): number {
    const draft = typeof draftM === 'number' && Number.isFinite(draftM) && draftM > 0 ? draftM : DEFAULT_VESSEL_DRAFT_M;
    // Clamp draft to a sensible band so a typo doesn't produce
    // pathological thresholds. 0.5 m (kayak) → 5 m (large yacht).
    const clamped = Math.max(0.5, Math.min(5, draft));
    return -(clamped * 1.5 + 0.5);
}

function gebcoIsHazard(depth_m: number | null, hazardThresholdM: number): boolean {
    if (depth_m == null) return false; // No data → don't flag.
    return depth_m > hazardThresholdM;
}

// ── ENC → HazardResult adapter ─────────────────────────────────────

/**
 * Project an EncHazardResult onto our unified HazardResult shape.
 *
 * Depth conversion: ENC stores depth as positive S-57 metres; we
 * flip sign to match GEBCO convention.
 *
 * Hazard reconciliation: ENC marks a polygon as a hazard based on
 * its built-in threshold (`ENC_HAZARD_DEPTH_M = 15 m`). We re-
 * evaluate against the caller's draft-derived threshold so a
 * shallow-draft vessel doesn't get falsely blocked by a depth
 * polygon deeper than its grounding risk.
 *
 * Land/obstruction/wreck/rock hazards remain hazards regardless of
 * draft — you don't sail over them at any depth.
 */
export function encToHazardResult(
    point: HazardQueryPoint,
    enc: EncHazardResult,
    hazardThresholdM: number,
    tideOffsetM: number,
): HazardResult {
    // Flip S-57 depth (positive = below datum) to GEBCO convention
    // (negative = below sea level). Do NOT abs(): a DRYING DEPARE/DRGARE
    // carries a NEGATIVE DRVAL1 (drying HEIGHT above datum), which must map
    // to a POSITIVE above-surface value so the tide re-eval below (and the
    // isochrone land penalty) treat it as drying land, not shoal water.
    // The old -Math.abs() modelled a bank that dries 0.5 m ABOVE datum as
    // 0.5 m of water and cleared it at high tide — fail-dangerous over
    // Moreton Bay's drying sandbanks.
    const chartDepth = enc.minDepthM == null ? null : -enc.minDepthM;
    const effectiveDepth = applyTide(chartDepth, tideOffsetM);
    let isHazard = enc.hazard;

    // Re-evaluate `shallow` hazards against the caller's draft +
    // tide. Solid hazards (land/rock/wreck/obstruction with no
    // depth) stay hazards regardless of tide.
    if (enc.hazard && enc.hazardType === 'shallow' && effectiveDepth !== null) {
        isHazard = effectiveDepth > hazardThresholdM;
    }

    return {
        lat: point.lat,
        lon: point.lon,
        isHazard,
        depth_m: effectiveDepth,
        source: 'enc',
        cellId: enc.cellId,
        hazardType: enc.hazardType,
        catzoc: enc.catzoc ?? null,
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

/** Caller options for queryHazards. */
export interface HazardQueryOptions {
    /**
     * Vessel draft in metres. Used to compute the hazard depth
     * threshold (anything shallower than `-(draft * 1.5 + 0.5)` is
     * treated as a grounding risk). When omitted, defaults to 2.5 m
     * to match the existing fallback elsewhere in the codebase.
     */
    vesselDraftM?: number;
    /**
     * Static tide offset above chart datum in metres, applied to
     * every point. Use this when the caller has a single
     * representative value (or "0 = worst case"). When `tideAt` is
     * also supplied, that callback wins per point.
     *
     * Positive values mean "tide is above datum" (more water, less
     * grounding risk). Default 0 = worst case (chart datum, lowest
     * astronomical tide).
     */
    tideOffsetM?: number;
    /**
     * Optional per-point tide lookup. When supplied, queryHazards
     * calls this for every point that has a `timeMs` set, and uses
     * the returned value as the tide offset for that point. Falls
     * back to `tideOffsetM` when the callback returns null
     * (out-of-range time, no station data, etc.).
     *
     * Designed so the route validator can pre-fetch a TideCurve at
     * the route midpoint and pass `(p) => curve.heightAt(p.timeMs)`
     * — one network call covers the whole route.
     */
    tideAt?: (point: HazardQueryPoint) => number | null;
}

/**
 * Convert a GEBCO-convention depth (negative = below sea level) to
 * its tide-corrected equivalent.
 *
 * Rationale: a charted -2 m point at chart datum is -3 m below the
 * actual sea surface when tide is at +1 m. In GEBCO convention
 * this is `depth_m - tideOffsetM`.
 */
function applyTide(depth_m: number | null, tideOffsetM: number): number | null {
    if (depth_m == null) return null;
    if (!Number.isFinite(tideOffsetM) || tideOffsetM === 0) return depth_m;
    return depth_m - tideOffsetM;
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
export async function queryHazards(
    points: HazardQueryPoint[],
    options: HazardQueryOptions = {},
): Promise<HazardResult[]> {
    if (points.length === 0) return [];

    const hazardThresholdM = hazardDepthForDraft(options.vesselDraftM);
    const fallbackTideM = Number.isFinite(options.tideOffsetM) ? (options.tideOffsetM as number) : 0;

    /**
     * Resolve the tide offset for one point. Per-point callback
     * wins when it returns a finite number; otherwise the static
     * fallback applies.
     */
    const tideForPoint = (p: HazardQueryPoint): number => {
        if (options.tideAt) {
            const v = options.tideAt(p);
            if (typeof v === 'number' && Number.isFinite(v)) return v;
        }
        return fallbackTideM;
    };

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
            out[i] = encToHazardResult(points[i], enc, hazardThresholdM, tideForPoint(points[i]));
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
                const tidedDepth = applyTide(g.depth_m, tideForPoint(points[idx]));
                out[idx] = {
                    lat: points[idx].lat,
                    lon: points[idx].lon,
                    isHazard: gebcoIsHazard(tidedDepth, hazardThresholdM),
                    depth_m: tidedDepth,
                    source: tidedDepth == null ? 'none' : 'gebco',
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
        log.info(
            `queryHazards(${points.length}, draft=${options.vesselDraftM ?? DEFAULT_VESSEL_DRAFT_M}m, threshold=${hazardThresholdM.toFixed(2)}m, tide=${options.tideAt ? 'per-point' : `${fallbackTideM.toFixed(2)}m`}): enc=${encHits} gebco=${gebcoHits} none=${noData}`,
        );
    }

    return out;
}

/**
 * Segment-level hazard check: does each segment CROSS a charted ENC hazard
 * that the sampled point query would miss between its 231 m samples (an AREA
 * thinner than the spacing, or a point/line on a short terminal leg)? ENC-only
 * — GEBCO is a raster with no polygons, so the sampled point query stays its
 * backstop. Draft + tide are applied to the crossed feature exactly like the
 * point path via encToHazardResult (honouring the live `tideAt` curve at the
 * segment midpoint/ETA when supplied — else the static offset), so a dredged
 * channel deep enough for the vessel clears while land/too-shallow blocks.
 */
export async function querySegmentHazards(
    segments: {
        lat1: number;
        lon1: number;
        lat2: number;
        lon2: number;
        exemptStart?: boolean;
        exemptEnd?: boolean;
        /** Midpoint ETA (epoch ms) for the live tide-curve lookup. */
        timeMs?: number;
    }[],
    options: HazardQueryOptions = {},
): Promise<{ isHazard: boolean; hazardType?: EncHazardType; source: 'enc' | 'none' }[]> {
    if (segments.length === 0) return [];
    const encResults = await EncHazardService.querySegmentHazards(segments);
    const hazardThresholdM = hazardDepthForDraft(options.vesselDraftM);
    const fallbackTideM = Number.isFinite(options.tideOffsetM as number) ? (options.tideOffsetM as number) : 0;
    return encResults.map((enc, i) => {
        if (!enc.covered) return { isHazard: false, source: 'none' as const };
        const midLat = (segments[i].lat1 + segments[i].lat2) / 2;
        const midLon = (segments[i].lon1 + segments[i].lon2) / 2;
        // Honour the live per-point tide curve the validator passes
        // (queryOpts.tideAt) at the segment midpoint + ETA — else a shallow
        // crossing would be graded at the static offset (often chart datum)
        // even during a big tidal swing (audit: dropped tideAt). Fall back to
        // the static offset when no curve / out-of-range time.
        const tideM = options.tideAt
            ? (options.tideAt({ lat: midLat, lon: midLon, timeMs: segments[i].timeMs }) ?? fallbackTideM)
            : fallbackTideM;
        const r = encToHazardResult({ lat: midLat, lon: midLon }, enc, hazardThresholdM, tideM);
        return { isHazard: r.isHazard, hazardType: enc.hazardType, source: 'enc' as const };
    });
}

// ── Constants re-exported for backward compatibility ──────────────

/**
 * @deprecated The hazard threshold is now computed per-call from
 * vessel draft via `hazardDepthForDraft()`. This constant is kept
 * only for any external callers that imported it; new code should
 * pass `vesselDraftM` to `queryHazards`.
 */
export const HAZARD_DEPTH_M_GEBCO = -15;
export const HAZARD_DEPTH_M_ENC = ENC_HAZARD_DEPTH_M;
