import type { AutoroutingVesselProfile } from '../supabase/functions/_shared/autorouting-vessel';
import type { InshoreSegmentState } from '../components/map/inshoreRouteState';
import type {
    CautionNearShallow,
    ChartedShallowSpan,
    PinOffWater,
    ShallowRunInfo,
    SurveyRunInfo,
} from '../services/engine/types';
import type { BackstopChartVerdict } from '../services/routing/landBackstop';
export type { AutoroutingDimension, AutoroutingVesselProfile } from '../supabase/functions/_shared/autorouting-vessel';

/** Auto's request: two pins and the vessel, routed by Thalassa on this phone. */
export interface AutoroutingTrialRequest {
    departure: { lat: number; lon: number };
    destination: { lat: number; lon: number };
    draftM: number;
    speedKts: number;
    /** Omitted only by legacy callers; missing values never become zero dimensions. */
    vesselProfile?: AutoroutingVesselProfile;
}

/** Computed on the phone (2026-10-01): a signed-in identity and installed
 * navigation charts. No server call decides whether Auto is offered. */
export interface AutoroutingTrialStatus {
    enabled: boolean;
    ready: boolean;
    message?: string;
}

/**
 * What Thalassa's router said about this route (2026-10-01), held in memory
 * only — never saved, exported or shared. The planner's own Phase 2a
 * disclosure: per-segment masks, the shallow, survey and tide runs, the pins
 * and the land backstop. `stateMask` is inshoreSegmentStates() of the result;
 * null means the masks were missing or did not match the line, so the line is
 * unverified and cannot be saved.
 */
export interface ThalassaRouteDisclosure {
    stateMask: InshoreSegmentState[] | null;
    cautionMask?: boolean[];
    canalMask?: boolean[];
    channelMask?: boolean[];
    offshoreMask?: boolean[];
    chartedShallowMask?: boolean[];
    landPaintConflictMask?: boolean[];
    /** Why each caution segment is caution (engine CAUTION_WHY bits). */
    cautionWhy?: number[];
    /** The charted depth under each SHALLOW caution segment, else null. */
    cautionDepthM?: (number | null)[];
    /** The shallow band each NEAR_SHALLOW segment passes too close to, else null. */
    cautionNearShallow?: (CautionNearShallow | null)[];
    tideDepthM?: (number | null)[];
    tideNeedM?: number;
    shallowRuns?: ShallowRunInfo[];
    chartedShallowSpans?: ChartedShallowSpan[];
    surveyRuns?: SurveyRunInfo[];
    surveyUncheckedCells?: string[];
    structuresUnknownCells?: string[];
    pinOffWater?: { origin?: PinOffWater; destination?: PinOffWater };
    tideCheck?: 'not-loaded';
    destinationInlandTrimM?: number;
    cellsUsed: string[];
    distanceNM: number;
    elapsedMs: number;
    seaway?: { edgesUsed: string[]; gateCount: number; gateCompliance: number | null; detourRatio: number };
    /** The satellite land check: 'unavailable' when it could not finish —
     *  offline, or online and it failed (backstopReason says which). */
    backstop: 'verified' | 'unavailable';
    /** Why the check could not finish, in the skipper's words
     *  (landBackstopWords.backstopUnavailableWords; 2026-10-02). */
    backstopReason?: string;
    /** The charts' verdict at each satellite sample of this exact line, kept
     *  while the check is unavailable so Review's Retry re-runs the check
     *  alone (recheckThalassaBackstop), never the route. */
    backstopCharts?: BackstopChartVerdict[];
    /** Metres of charted land the route crosses away from a pin's own edge
     *  (InshoreRouteResult.hardLand; 2026-10-01 review). Auto refuses a route
     *  with any, so a proposal carries 0, or nothing when the audit did not run. */
    hardLandAwayM?: number;
    /** Tide ceilings were loaded before routing (owner decision 11). */
    tideCeilingsLoaded?: boolean;
}

/** A proposal only: receipt does not save, verify, follow or publish a route. */
export interface AutoroutingTrialRoute {
    id: string;
    /** Ordered GeoJSON convention: longitude first. Never silently simplified. */
    coordinates: [number, number][];
    warnings: string[];
    /** When the router produced it; never restamped for a cached proposal. */
    createdAt: string;
    provider: 'Thalassa';
    /** Exact accepted Thalassa snapshot, not a certification of measurements. */
    vesselProfile?: AutoroutingVesselProfile;
    /** The router's disclosure for this exact line. Dropped by a local edit:
     * an edited line was not routed by Thalassa. Memory only. */
    engine?: ThalassaRouteDisclosure;
    /** A local edit invalidates the router's checks for the whole line. Fresh
     * local chart checks do not constitute a fresh route. Memory only. */
    localEdit?: AutoroutingLocalEdit;
}

export interface AutoroutingLocalEdit {
    readonly revision: number;
    readonly checksInvalidated: 'engine';
    /** Full-path indices retained as display pins, shifted when a move inserts
     * a vertex. They are user edit anchors, not checked positions. */
    readonly waypointIndices: readonly number[];
    /** Deep-frozen, detached original proposal. Its warnings are historical,
     * never findings or clearance for the current edited geometry. */
    readonly originalProposal: Readonly<Omit<AutoroutingTrialRoute, 'localEdit'>>;
}

export const AUTOROUTING_TRIAL_MAX_POINTS = 10_000;
export const AUTOROUTING_TRIAL_MAX_WARNINGS = 100;
export const AUTOROUTING_TRIAL_MAX_WARNING_LENGTH = 2_000;
export const AUTOROUTING_TRIAL_MAX_DRAFT_M = 30;
export const AUTOROUTING_TRIAL_MAX_SPEED_KTS = 100;
