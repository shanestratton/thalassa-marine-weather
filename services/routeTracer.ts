/**
 * Route Tracer — grade a hand-drawn route leg-by-leg against the SAME data
 * the live router uses (Shane 2026-07-08: "let people make their own routes
 * … with each pin we could check depth and markers between that pin and the
 * next pin, with warnings etc maybe yellow or red lines").
 *
 * The skipper taps pins on the chart; every consecutive pair becomes a LEG
 * that is validated for:
 *   • charted depth vs the vessel's keel (draft + 0.5 m owner margin at LAT)
 *     — thin water = caution, sub-keel = danger + a tide window ("clears
 *     HH:MM–HH:MM") for the shallowest spot;
 *   • land / charted-hazard / berth-row crossings (hard danger);
 *   • cardinal marks — the leg must pass on the SAFE quadrant side;
 *   • lateral gate pairs — the leg must THREAD between port and starboard,
 *     not pass outside either mark;
 *   • solo laterals — close approach gets a "verify the side" advisory;
 *   • leads/transits (RECTRC + navigation lines) — off-lead distance while
 *     riding one, plus a deeper-water nudge for thin legs.
 *
 * This is the HUMAN-IN-THE-LOOP router: the skipper owns the line, Thalassa
 * is the co-pilot watching the chart. A validated trace is also the curated-
 * fairway flywheel — see traceAsCuratedFairwaySnippet.
 *
 * Pure verdict logic lives in validateTraceLeg (sync, unit-testable); the
 * async edges are buildTracerContext (ENC + OSM + grid assembly, one per
 * trace session) and tideWindowLabelFor (WorldTides curve).
 */
import type { Feature, LineString } from 'geojson';
import { routeNameParts } from './routeNameParts';
export { reverseRouteName } from './routeNameParts';
import { buildNavGrid } from './engine/navGrid';
import { buildNavGridAsync } from './engine/navGridWorkerHost';
import { CAUTION, UNKNOWN_OPEN, M_PER_DEG_LAT } from './engine/constants';
import type { NavGrid } from './engine/types';
import { assembleTracerLayers } from './InshoreRouter';
import { curatedFairwayCanalFeatures } from './curatedFairways';
import { parseLateralMarks, distM, type LatLon, type LateralMark } from './fairlead';
import {
    CARDINAL_HALF_M,
    CARDINAL_REACH_M,
    cardinalWrongSideAt,
    parseCardinalDiscs,
    type CardinalDisc,
} from './tier3/cardinalClamp';
import {
    isChartNavLine,
    navLineLeads,
    parseLeadingLines,
    parseChartTrackLines,
    chartTrackOffsetForLeg,
    projectToLine,
    type LeadingLine,
    type ChartTrackLine,
} from './leadingLine';
import { computeTidalWindows, DEFAULT_TIDE_SAFETY_M } from './routing/tidalWindow';
import { navLinesOnWater } from './routing/leadLandClip';
import {
    chartClearanceBars,
    clearanceRefusalMessage,
    curatedClearanceBars,
    polylineCrossesClearanceBar,
    type ClearanceBar,
} from './routing/overheadClearance';
import { vesselAirDraftMetres } from './units';
import { tideFieldFromCurve } from './routing/env/EnvFields';
import { fetchTideCurve, TIDE_CURVE_MAX_DAYS } from './TideHeightService';
import type { VoyagePlan } from '../types/navigation';
import { createLogger } from '../utils/createLogger';
import { crumb } from '../utils/flightRecorder';
import { awaitHeapHeadroom, heapTag } from '../utils/heapGauge';
import { awaitMergeAbortCooldown } from './enc/mergeSettle';
import { createSerialQueue } from '../utils/serialQueue';
import {
    authScopedStorageKey,
    getAuthIdentityScope,
    isAuthIdentityScopeCurrent,
    type AuthIdentityScope,
} from './authIdentityScope';
import {
    normaliseTraceVerification,
    serialiseTraceVerificationNote,
    traceGeometryKey,
    traceVerificationSummary,
    type TraceVerification,
} from './traceVerification';
import { clearTraceCheckOutcome } from './traceCheckOutcomes';
import {
    normaliseAutoroutingProposalEvidence,
    type SavedAutoroutingProposalEvidence,
} from './autoroutingProposalEvidence';
import { chartFreeEvidence, chartFreeLegEntries, TRACE_LAND_CROSSING_MESSAGE } from './chartFacts';

const log = createLogger('routeTracer');

// ── Types ──────────────────────────────────────────────────────────────────

export interface TracePoint {
    lat: number;
    lon: number;
}

export type TraceGrade = 'clear' | 'caution' | 'danger';

export interface TraceIssue {
    /** 'info' = a GREEN confirmation, not a problem — it does NOT escalate the
     *  leg grade (stays 'clear'). Used to say "you're passing this mark on the
     *  correct side" so a right pass reads green, not amber (Shane 2026-07-16). */
    severity: 'info' | 'caution' | 'danger';
    /** Skipper-readable, ≤ ~60 chars — shown on the leg row in the panel. */
    message: string;
    at?: TracePoint;
    /** The physical mark this issue is about (cardinal/lateral/gate) — the
     *  panel flies here and pulses a halo so the skipper can SEE which mark
     *  (Shane 2026-07-11: "I cannot see which marker I am too close to"). */
    mark?: TracePoint;
    /** Review-only track advisory identity; never a clearance/steering order.
     * Allows the UI to group repeated advisories without hiding hazards. */
    chartTrack?: {
        id: string;
        label: string;
        kind: 'leading-line' | 'recommended-track';
        offsetM: number;
    };
}

export interface TraceLegVerdict {
    grade: TraceGrade;
    issues: TraceIssue[];
    /** Shallowest charted depth on the leg (m below LAT), null = none charted. */
    minDepthM: number | null;
    minAt: TracePoint | null;
    /** True when the leg needs tide over the keel — feed tideWindowLabelFor. */
    needsTide: boolean;
    /** P3 advisory: deeper-water nudge, e.g. "deeper water ~60 m to port". */
    nudge: string | null;
    /** The actual charted spot the nudge points at (deeper water abeam a thin
     *  leg) — lets the UI drop a draggable GHOST waypoint there to route the
     *  line through it (Shane 2026-07-16). null when there's no nudge. */
    nudgeTo: TracePoint | null;
    /** Set only by the two no-chart verdicts (traceGrading): nothing on this
     *  device could check the leg, so it is drawn as a grey "sketch, not
     *  checked" (127-DESKMAP C3). The grade stays 'caution' for every consumer. */
    unchecked?: true;
    /** A leg over licensed charts as the bank keeps it (127-C-b): its grade,
     *  needs-tide and the land words only. Display only: it never releases a
     *  route, and her tap, the Route report or Save checks it again. */
    stub?: true;
}

export interface GatePair {
    port: TracePoint;
    stbd: TracePoint;
}

export interface TracerContext {
    /** Depth grid — null on marks-only contexts (trace too long for the cell
     *  budget): depth/land checks are SKIPPED and every leg carries an honest
     *  "depth unchecked" caution instead of a guess. */
    grid: NavGrid | null;
    /** Real ENC lateral marks (CATLAM 1–4) NOT part of an accepted gate pair. */
    soloLaterals: LateralMark[];
    /** Positions of EVERY mark-inference disc the engine built (from
     *  merged.OBSTRN: lateral-marker-as-hazard + non-cardinal
     *  iala-oriented-hazard + direct-hazard), EXCLUDING cardinals (§2 owns
     *  those). The disc source is BROADER than soloLaterals — it includes OSM
     *  nav_markers and ENC laterals with no numbered OBJNAM, which
     *  parseLateralMarks drops. So when a leg enters a markzone disc, §1 reads
     *  the chart against the disc's OWN mark here, not the narrower
     *  soloLaterals list (Shane 2026-07-16: unnumbered red beacon nagged
     *  "danger side" because it had a disc but no soloLateral entry). */
    markHazards: MarkHazard[];
    cardinals: CardinalDisc[];
    gatePairs: GatePair[];
    /** CHART leads only: RECTRC and chart NAVLNE leading lines (CATNAV 3).
     *  They catch a fat-fingered tap (snapTraceTapToLead) and hold the lead's
     *  authority over a cardinal's side rule (ridingLeadAt). */
    leads: LeadingLine[];
    /** OSM seamark navigation lines that passed the lead gate. Lower trust than
     *  the chart: they catch a tap but never waive a cardinal's side rule, so a
     *  "wrong side of the cardinal" DANGER is never downgraded on OSM's word.
     *  Optional so hand-built contexts stay valid; absent = none. */
    osmLeads?: LeadingLine[];
    /** Typed review lines. Kept separate so revised warning relevance cannot
     * alter the legacy cardinal suppression, depth grid or manual pin snap. */
    chartTracks?: ChartTrackLine[];
    /** CANAL centrelines (curated fairways + OSM canal/fairway lines). A
     *  land-reading sample within the LANE half-width of one is lane water,
     *  not land: the carve means "navigable lane", and it is one cell wide —
     *  50 m on the engine's grid but only ~10 m on the tracer's fine grid, so
     *  without this a route riding the lane dead-centre-adjacent reads as
     *  crossing the chart's LNDARE bleed (router-consistency golden). */
    canalLanes: LeadingLine[];
    draftM: number;
    /** True when the vessel profile has no usable draft and verdicts were
     *  graded against the 2.5 m fallback — clear legs downgrade to caution. */
    draftAssumed: boolean;
    /** True when the regional-marker fetch for this window threw, so gatePairs
     *  is empty for a network reason rather than a charted one. Verdicts graded
     *  under it are NOT gate-checked and must never be durably cached. */
    gateChecksUnavailable: boolean;
    /** Additional marina/obstacle geometry failed to load; never a clean pass. */
    supplementalChecksUnavailable?: boolean;
    /** Grid coverage bbox [W,S,E,N] — pins outside need a context rebuild. */
    bbox: [number, number, number, number];
    resM: number;
    /**
     * Low-clearance bars for THIS context's air draft (airDraftM): every chart
     * bridge / overhead cable / overhead pipe and curated bridge the mast
     * cannot pass under — too low for air draft + 1 m, no or only an estimated
     * clearance, or no air draft set (services/routing/overheadClearance.ts,
     * the router's verdict). They are baked into `grid` (so "Fix this leg"
     * detours round them) and checked exactly on every leg. Optional so
     * hand-built contexts stay valid; absent = none (Phase 2a review,
     * 2026-09-30).
     */
    clearanceBars?: ClearanceBar[];
    /** The air draft the bars were computed for (null = not set). */
    airDraftM?: number | null;
    /**
     * Extents of the cells in this window whose chart data carries no bridge /
     * overhead-line layers (converted before schema 2 — every installed cell
     * today). A leg through one was checked against the curated bridge list
     * only, and says so (owner decision 8; fix-up, 2026-09-30 — the tracer
     * and the pins an auto-route drops never did). Absent = none.
     */
    structuresUnknownBboxes?: [number, number, number, number][];
}

/** buildTracerContext outcome — statuses drive the panel strip. */
export type TracerBuildResult =
    | { status: 'ready'; ctx: TracerContext }
    | { status: 'marksonly'; ctx: TracerContext }
    | { status: 'toolarge' }
    | { status: 'nochart' };

// ── Tunables ───────────────────────────────────────────────────────────────

/** Extra water beyond draft+safety before a leg reads fully green. */
const THIN_MARGIN_M = 1.0;
/** Cardinal relevance band + minimum safe-side clearance (m) — the router's
 *  own (tier3/cardinalClamp cardinalWrongSideAt reads both). */
const CARDINAL_BAND_M = CARDINAL_REACH_M;
const CARDINAL_CLEAR_M = CARDINAL_HALF_M;
/** A gate is checked when the leg comes this close to its midpoint (m). */
const GATE_BAND_M = 300;
/** Solo-lateral "verify the side" advisory distance (m). */
const SOLO_LATERAL_BAND_M = 60;
/** Two opposite-hand solo laterals this close form a gate a leg may thread (m). */
const SOLO_PAIR_MAX_M = 300;
const LEAD_MAX_ANGLE_DEG = 30;
const LEAD_OFF_CAUTION_M = 40;
/** Context bbox padding (deg ≈ 2.2 km) and rebuild margin near the edge. */
export const TRACER_BBOX_PAD_DEG = 0.02;
/** Grid cell budget — resolution adapts so width×height stays under this.
 *  Lowered 2M→1M (audit 2026-07-15, rank 7): buildNavGrid is a SYNCHRONOUS
 *  main-thread build with no yields, so cell count IS the freeze duration
 *  (~0.3-1.5 s at 2M on iPhone WebKit — the "lockup when tracing" a fresh
 *  window). Marina-scale windows are pinned at the 6 m floor and never
 *  approach this cap, so their berth-carve resolution is untouched; only
 *  bay-scale windows coarsen (28 m→40 m at the 40 km depth-grid ceiling —
 *  cosmetic for km-wide depth bands), halving the worst-case build. The
 *  structural fix (build off-thread) is deferred — inputs are bounded so a
 *  worker is safe, unlike the parked martinez glaze clip. */
const MAX_GRID_CELLS = 1_000_000;
/** Above this bbox span the depth grid is skipped (marks-only verdicts) —
 *  an unbounded grid over a long trace was an ~800 MB jetsam kill.
 *  EXPORTED because the grading hook's cluster loop must bound the padded span
 *  by the SAME number it is measured against here; when the two disagreed, a
 *  cluster that looked fine tight padded past this and lost its grid. */
export const MAX_DEPTH_GRID_SPAN_M = 40_000;
/** Above this we refuse the context outright — even feature loading (every
 *  intersecting ENC cell + the OSM overlay) is unbounded at that scale. */
const MAX_TRACE_SPAN_M = 80_000;
/** Half-width of a carved canal/fairway LANE. Matches the engine's effective
 *  corridor: one 50 m coarse cell around the centreline PLUS post-pass
 *  polyline simplification slop (the consistency golden measured the live
 *  engine 51 m off Shane's traced centreline at the Mooloolah entrance).
 *  Kept tight enough that a genuinely-over-the-spit line (the v1/v2 curated-
 *  fairway bugs ran 100+ m off) still reads as crossing land. */
const CANAL_LANE_HALF_WIDTH_M = 60;

// ── Context assembly ───────────────────────────────────────────────────────

/** Bbox [W,S,E,N] covering all points, padded for context reuse while tracing. */
export function traceBbox(
    points: readonly TracePoint[],
    padDeg = TRACER_BBOX_PAD_DEG,
): [number, number, number, number] {
    let w = Infinity,
        s = Infinity,
        e = -Infinity,
        n = -Infinity;
    for (const p of points) {
        w = Math.min(w, p.lon);
        s = Math.min(s, p.lat);
        e = Math.max(e, p.lon);
        n = Math.max(n, p.lat);
    }
    return [w - padDeg, s - padDeg, e + padDeg, n + padDeg];
}

export function pointInBbox(p: TracePoint, bbox: [number, number, number, number], marginDeg = 0.003): boolean {
    return (
        p.lon >= bbox[0] + marginDeg &&
        p.lat >= bbox[1] + marginDeg &&
        p.lon <= bbox[2] - marginDeg &&
        p.lat <= bbox[3] - marginDeg
    );
}

/** Larger bbox span in metres — MapHub's cluster budget check. */
export function bboxMaxSpanM(bbox: [number, number, number, number]): number {
    const { spanLonM, spanLatM } = bboxSpansM(bbox);
    return Math.max(spanLonM, spanLatM);
}

/** Bbox spans in metres (lon-span, lat-span) at the bbox mid-latitude. */
function bboxSpansM(bbox: [number, number, number, number]): { spanLonM: number; spanLatM: number } {
    const midLat = (bbox[1] + bbox[3]) / 2;
    return {
        spanLonM: (bbox[2] - bbox[0]) * 111_320 * Math.cos((midLat * Math.PI) / 180),
        spanLatM: (bbox[3] - bbox[1]) * M_PER_DEG_LAT,
    };
}

/**
 * Padded bbox for the pins with a SPAN-PROPORTIONAL pad (min 0.02°, up to
 * 25% of the larger span) — a fixed 2.2 km pad made coast-following traces
 * rebuild the whole context roughly every second pin (quadratic total cost).
 */
export function traceBboxPadded(points: readonly TracePoint[]): [number, number, number, number] {
    const tight = traceBbox(points, 0);
    const pad = Math.max(TRACER_BBOX_PAD_DEG, 0.25 * Math.max(tight[2] - tight[0], tight[3] - tight[1]));
    return [tight[0] - pad, tight[1] - pad, tight[2] + pad, tight[3] + pad];
}

/**
 * Hard ceiling on how many pieces one leg may be graded in. Eight sub-legs of
 * ~26 km covers a ~200 km leg — past that the honest answer is that the window
 * sweep costs more than the skipper will wait for.
 */
export const MAX_LEG_SUBDIVISIONS = 8;

/**
 * Will a window built around these points still get a depth grid?
 *
 * The grading hook packs pending legs into windows under a TIGHT-bbox cost
 * bound, but the window actually built is the PADDED one, and that is what
 * decides whether a depth grid exists at all. The two bounds disagree, because
 * traceBboxPadded pads by 25% of the larger DEGREE span while a degree of
 * longitude shrinks with cos(lat). Measured: an L of two 23 km arms reads
 * 23,000 m tight — comfortably inside the 24 km cost bound — and pads to
 * 40,891 m at 50°N and 46,000 m at 60°N, over the 40 km ceiling. The window
 * then silently returns marks-only and every leg in it is stamped
 * "depth unchecked" and cached that way.
 *
 * Exported so the hook and the test bind to the same predicate rather than two
 * hand-copied inequalities.
 */
export function clusterKeepsDepthGrid(points: readonly TracePoint[]): boolean {
    return bboxMaxSpanM(traceBboxPadded(points)) <= MAX_DEPTH_GRID_SPAN_M;
}

/**
 * Intermediate points that cut a→b into pieces each small enough to get a REAL
 * depth grid. Returns [] when the leg already fits (the common case) or when
 * even MAX_LEG_SUBDIVISIONS pieces cannot fit it.
 *
 * The count is derived by MEASURING the padded bbox of each candidate piece
 * rather than dividing by a constant distance, and that is the whole point.
 * traceBboxPadded's pad is 25% of the larger DEGREE span, and a degree of
 * longitude shrinks with cos(lat) — so a fixed "split at 11.5 km" rule holds at
 * Brisbane and silently fails in Tasmania, where ordinary geometry pads past
 * the 40 km ceiling and the sub-legs come back marks-only anyway. Measuring
 * makes the guarantee latitude-correct by construction: if this returns points,
 * every resulting piece provably fits, at any latitude and on any bearing.
 *
 * The pieces lie ON the a→b line, so the route's geometry is unchanged — this
 * buys verification of the line the skipper already drew, it does not move it.
 */
export function splitLegForDepthGrid(a: TracePoint, b: TracePoint): TracePoint[] {
    const fits = (pieces: number): boolean => {
        for (let i = 0; i < pieces; i++) {
            const p0 = lerpPoint(a, b, i / pieces);
            const p1 = lerpPoint(a, b, (i + 1) / pieces);
            if (bboxMaxSpanM(traceBboxPadded([p0, p1])) > MAX_DEPTH_GRID_SPAN_M) return false;
        }
        return true;
    };

    if (fits(1)) return []; // already gradable whole — no split needed
    for (let n = 2; n <= MAX_LEG_SUBDIVISIONS; n++) {
        if (!fits(n)) continue;
        const out: TracePoint[] = [];
        for (let i = 1; i < n; i++) out.push(lerpPoint(a, b, i / n));
        return out;
    }
    return []; // genuinely too long — caller keeps the honest "too long" verdict
}

function lerpPoint(a: TracePoint, b: TracePoint, t: number): TracePoint {
    return { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
}

/**
 * Fold the verdicts of a subdivided leg back into the ONE verdict its row
 * renders. Fail-safe on every axis: the worst grade wins, the shallowest sounding
 * wins, any piece needing tide makes the leg need tide, and every issue is kept.
 *
 * A null piece means that window never produced a verdict, so the leg has an
 * unchecked stretch and must not read clear — see the caller, which keeps such a
 * merge volatile rather than banking it.
 */
export function mergeSubLegVerdicts(parts: readonly (TraceLegVerdict | null)[]): TraceLegVerdict | null {
    if (parts.length === 0) return null;
    const good = parts.filter((p): p is TraceLegVerdict => p !== null);
    if (good.length === 0) return null;

    const issues: TraceIssue[] = good.flatMap((p) => p.issues);
    if (good.length !== parts.length) {
        issues.push({ severity: 'caution', message: 'part of this leg could not be checked' });
    }

    let minDepthM: number | null = null;
    let minAt: LatLon | null = null;
    for (const p of good) {
        if (p.minDepthM !== null && (minDepthM === null || p.minDepthM < minDepthM)) {
            minDepthM = p.minDepthM;
            minAt = p.minAt;
        }
    }

    // Mirrors validateTraceLeg: 'info' is a green confirmation and must not
    // escalate, so only a real caution does.
    const grade: TraceGrade = issues.some((i) => i.severity === 'danger')
        ? 'danger'
        : issues.some((i) => i.severity === 'caution')
          ? 'caution'
          : 'clear';

    const worst = good.find((p) => p.grade === grade) ?? good[0];
    return {
        grade,
        issues,
        minDepthM,
        minAt,
        needsTide: good.some((p) => p.needsTide),
        nudge: worst.nudge,
        nudgeTo: worst.nudgeTo,
        // A sketch only when no piece of it was checked.
        ...(good.length === parts.length && good.every((p) => p.unchecked) ? { unchecked: true as const } : {}),
    };
}

/** Grid resolution for a bbox: as fine as the cell budget allows, floor 6 m.
 *  NO coarseness ceiling — the old Math.min(60,…) INVERTED the budget (a
 *  300 NM bbox pinned at 60 m allocated ~42M cells ≈ 800 MB → jetsam kill).
 *  Span caps above bound how coarse this can get instead. Exported for tests. */
export function tracerResolutionM(bbox: [number, number, number, number]): number {
    const { spanLonM, spanLatM } = bboxSpansM(bbox);
    return Math.max(6, Math.ceil(Math.sqrt((spanLonM * spanLatM) / MAX_GRID_CELLS)));
}

/** The routing grid carves canals at an assumed navigable depth and prefers
 * fairways and leads. A trial CHECK must not use those routing hints as
 * soundings or preferences. Keep the original layers separately for mark/lead
 * parsing. The engine's pre-clip lead copy (NAVLINE_GRID, left by
 * routeInshore's entry clip) is a lead layer too, so it goes with NAVLINE.
 * DRGARE stays: a dredged area is charted depth — its own DRVAL1, finest
 * survey wins (navGrid Pass 1, Phase 2a review 2026-09-30) — not a hint. It
 * was stripped here while the grid still painted it a fabricated 5 m; kept,
 * a leg through a charted 1.3 m dredged area reads 1.3 m and needs tide
 * instead of "no charted depth" (round 2, 2026-09-30). */
export function chartOnlyTracerGridLayers(layers: import('./inshoreRouterEngine').InshoreLayers) {
    return {
        ...layers,
        CANAL: undefined,
        NAVLINE: undefined,
        NAVLINE_GRID: undefined,
        FAIRWY: undefined,
    };
}

/**
 * Pure context assembly from an already-merged layer blob — the testable
 * core of buildTracerContext, also used by the router-consistency golden
 * (grade the LIVE engine's route through the tracer on the SAME layers).
 */
export function tracerContextFromLayers(
    merged: import('./inshoreRouterEngine').InshoreLayers,
    gatePairs: GatePair[],
    bbox: [number, number, number, number],
    draftM: number,
    opts: {
        draftAssumed?: boolean;
        /** See TracerContext.gateChecksUnavailable — the marker fetch threw, so
         *  an empty gatePairs means "not checked", not "no gates here". */
        gateChecksUnavailable?: boolean;
        skipGrid?: boolean;
        /** Grid built off-thread by buildTracerContext (navGrid worker). When
         *  present it's used verbatim; absent = build synchronously here (the
         *  pure/testable path + the router-consistency golden). */
        prebuiltGrid?: NavGrid | null;
        /** See TracerContext.clearanceBars. A prebuilt grid must already
         *  carry them (tracerGridLayersWithBars). */
        clearanceBars?: ClearanceBar[];
        airDraftM?: number | null;
    } = {},
): TracerContext {
    const resM = tracerResolutionM(bbox);
    const clearanceBars = opts.clearanceBars ?? [];
    // Marina-scale traces (~3 km) land well under 20 m → navGrid's Pass 2c
    // berth carve is ACTIVE and legs over pontoon rows read blocked, exactly
    // like the fine routing grid. Bay-scale traces coarsen gracefully.
    const grid =
        'prebuiltGrid' in opts
            ? (opts.prebuiltGrid ?? null)
            : opts.skipGrid
              ? null
              : buildNavGrid(
                    tracerGridLayersWithBars(merged, clearanceBars),
                    bbox,
                    resM,
                    draftM,
                    DEFAULT_TIDE_SAFETY_M,
                    60,
                );

    // Marks: real ENC laterals; those inside an accepted pair are gate-checked,
    // the rest get the solo "verify the side" advisory.
    const laterals = parseLateralMarks([
        ...(merged.BCNLAT?.features ?? []),
        ...(merged.BOYLAT?.features ?? []),
    ] as never[]);
    const inPair = (m: LatLon): boolean => gatePairs.some((g) => distM(m, g.port) < 30 || distM(m, g.stbd) < 30);
    const soloLaterals = laterals.filter((m) => !inPair(m));
    const markHazards = parseMarkHazards((merged.OBSTRN?.features ?? []) as never[]);
    const cardinals = parseCardinalDiscs((merged.OBSTRN?.features ?? []) as never);
    // Leads snap taps and can override the cardinal-side rule (ridingLeadAt),
    // so only real leads count: a clearing or transit NAVLNE never does, nor
    // an OSM way that redraws one (navLineLeads on the mixed layer). Of those,
    // only CHART leads carry the cardinal override; OSM lines are tap-snap only.
    // And only their ON-WATER spans (navLinesOnWater, the lead compiler's
    // S-57 land rule — the router's entry clip, withNavLineLeadsOnly): a
    // leading line drawn on to its marks ashore, or a recommended track on a
    // coarse chart's land paint, must never snap a tap or excuse a cardinal
    // there. The grid above is built from the unclipped layers: it clips a
    // lead against its own land verdict (navGrid Pass 5b).
    const navLeads = navLinesOnWater(navLineLeads(merged.NAVLINE?.features ?? []), merged);
    const tracks = navLinesOnWater(merged.RECTRC?.features ?? [], merged);
    const leads = parseLeadingLines([...(tracks as never[]), ...navLeads.filter((feature) => isChartNavLine(feature))]);
    const osmLeads = parseLeadingLines(navLeads.filter((feature) => !isChartNavLine(feature)));
    const chartTracks = [
        ...parseChartTrackLines(tracks as never[], 'RECTRC'),
        ...parseChartTrackLines(navLeads, 'NAVLNE'),
    ];
    const canalLanes = parseLeadingLines((merged.CANAL?.features ?? []) as never[]);

    return {
        grid,
        soloLaterals,
        markHazards,
        cardinals,
        gatePairs,
        leads,
        osmLeads,
        chartTracks,
        canalLanes,
        draftM,
        draftAssumed: opts.draftAssumed ?? false,
        gateChecksUnavailable: opts.gateChecksUnavailable ?? false,
        bbox,
        resM,
        ...(clearanceBars.length > 0 ? { clearanceBars } : {}),
        ...(opts.airDraftM !== undefined ? { airDraftM: opts.airDraftM } : {}),
    };
}

/**
 * The tracer grid's layers with this vessel's low-clearance bars added to
 * OBSTRN — the engine hard-blocks `_class:'low-clearance'` bars and no rescue
 * pass reopens them, exactly as on the router's grid. A copy; never mutates.
 */
export function tracerGridLayersWithBars<T extends import('./inshoreRouterEngine').InshoreLayers>(
    layers: T,
    bars: readonly ClearanceBar[],
): T {
    if (bars.length === 0) return layers;
    return {
        ...layers,
        OBSTRN: { type: 'FeatureCollection', features: [...(layers.OBSTRN?.features ?? []), ...bars] },
    };
}

/** Positions of every NON-cardinal mark-inference disc in merged.OBSTRN — the
 *  engine's lateral-marker-as-hazard / direct-hazard points and its
 *  land-bearing iala-oriented-hazard half-discs (cardinals carry _cardinalDir
 *  and are excluded — §2 owns their safe-side check). Point features use their
 *  own coordinates; oriented polygons use the buoy point stashed in
 *  _markerLat/_markerLon (the polygon centroid is offset toward the hazard
 *  side). This is the SAME feature set that stamps markDiscBlocked, so §1 can
 *  chart-read against the exact mark that produced the disc it just entered —
 *  no dependency on the numbered-name soloLaterals filter. */
export interface MarkHazard extends TracePoint {
    /** IALA lateral hand, when the disc came from a lateral mark: 'port' (RED
     *  in region A) | 'starboard' (GREEN) | null (a direct point hazard, or a
     *  lateral with no colour). Lets §1 give the IALA rule when the chart alone
     *  can't call the side (Shane 2026-07-16: "we are IALA-A, so this IS the
     *  correct side?" — a red mark HAS a determinate keep-side given a heading). */
    hand: 'port' | 'starboard' | null;
}

export function parseMarkHazards(features: readonly unknown[]): MarkHazard[] {
    const out: MarkHazard[] = [];
    const handOf = (kind: unknown): 'port' | 'starboard' | null =>
        kind === 'port' ? 'port' : kind === 'starboard' ? 'starboard' : null;
    for (const f of features) {
        const feat = f as {
            properties?: {
                _class?: string;
                _cardinalDir?: string | null;
                _markerLat?: number;
                _markerLon?: number;
                _markerKind?: string;
                _origin?: { _markerKind?: string } | null;
            };
            geometry?: { type?: string; coordinates?: unknown };
        } | null;
        const p = feat?.properties;
        if (!p) continue;
        const cls = p._class;
        if (cls !== 'lateral-marker-as-hazard' && cls !== 'direct-hazard' && cls !== 'iala-oriented-hazard') continue;
        if (cls === 'iala-oriented-hazard' && p._cardinalDir != null) continue; // cardinal → §2
        // The lateral hand rides on the point (_markerKind) or, once the disc
        // was oriented, on its _origin (the raw lateral it was built from).
        const hand = handOf(p._markerKind ?? p._origin?._markerKind);
        if (typeof p._markerLat === 'number' && typeof p._markerLon === 'number') {
            out.push({ lat: p._markerLat, lon: p._markerLon, hand });
            continue;
        }
        // Fall back to the geometry point (raw hazard points) / first ring vertex.
        const g = feat?.geometry;
        if (g?.type === 'Point' && Array.isArray(g.coordinates)) {
            const [lon, lat] = g.coordinates as [number, number];
            if (typeof lon === 'number' && typeof lat === 'number') out.push({ lat, lon, hand });
        } else if (g?.type === 'Polygon' && Array.isArray(g.coordinates)) {
            const ring = (g.coordinates as number[][][])[0];
            if (ring && ring.length) {
                let sx = 0;
                let sy = 0;
                for (const [lon, lat] of ring) {
                    sx += lon;
                    sy += lat;
                }
                out.push({ lat: sy / ring.length, lon: sx / ring.length, hand });
            }
        }
    }
    return out;
}

/**
 * Build the validation context for a trace session: assemble the router's
 * layer blob for the bbox, build the depth grid, parse marks/gates/leads.
 * Span-capped for honesty AND survival: beyond ~40 km the depth grid is
 * skipped (marks-only, every leg carries "depth unchecked"); beyond ~80 km
 * we refuse outright — split the trace.
 */
// In-flight build coalescing (jank audit #2): rapid pin taps used to stack
// 2–4 FULL context builds — the callers' seq guards run only AFTER the await,
// so superseded builds ran to completion on the main thread. Identical
// (bbox, draft) requests now share one promise. Chart data is static within a
// session, so identical inputs ⇒ identical context; entries clear on settle.
const inflightBuilds = new Map<string, Promise<TracerBuildResult>>();

/** Measured typed-array weight of a context's depth grid, in bytes. */
export function tracerGridBytes(ctx: TracerContext): number {
    if (!ctx.grid) return 0;
    let total = 0;
    for (const v of Object.values(ctx.grid)) {
        if (ArrayBuffer.isView(v)) total += (v as ArrayBufferView).byteLength;
    }
    return total;
}

/**
 * The most grid bytes the tracer LRU may hold across all entries.
 *
 * The LRU was sized "3 entries (~5–13 MB each)" — and on 2026-08-10 a
 * session north of Fraser Island built grids the workers themselves
 * estimated at 37–39 MB EACH, so three held entries meant ~117 MB of typed
 * arrays on a surface with a documented jetsam history, invisible to the
 * cache census. 48 MB keeps the three-entry working set everywhere the
 * 5–13 MB assumption holds, and degrades to one held grid where the charts
 * are dense enough to break it.
 */
export const TRACER_LRU_BYTE_BUDGET = 48 * 1024 * 1024;

/** The land words that can never be acknowledged away; defined beside the
 *  chart-facts rules, which keep them on every stored record (127-C-b). */
export { TRACE_LAND_CROSSING_MESSAGE };

/**
 * Hold `ctx` at the front of the LRU, evicting from the tail — first past
 * three entries, then while the MEASURED grid bytes exceed the budget. The
 * newest entry always survives: refusing to hold the grid that is in use
 * would just rebuild it on the next edit. Pure; the caller owns the ref.
 */
export function holdTracerCtx(
    lru: TracerContext[],
    ctx: TracerContext,
    budgetBytes = TRACER_LRU_BYTE_BUDGET,
): TracerContext[] {
    const next = [ctx, ...lru.filter((c) => c !== ctx)].slice(0, 3);
    while (next.length > 1 && next.reduce((s, c) => s + tracerGridBytes(c), 0) > budgetBytes) next.pop();
    return next;
}

/** Context builds run ONE at a time (2026-08-10): the fatal trail showed two
 *  overlapping builds (ctx-start@19378 and @23242, both ready later) from
 *  different consumers — each ~19 MB of grid plus a full layer assembly, and
 *  the renderer died in exactly such an overlap window. Identical requests
 *  still coalesce via inflightBuilds before ever reaching the queue. */
const contextBuildQueue = createSerialQueue();

/**
 * Snap a tracer window to a coarse grid — mins floored, maxes ceiled — so
 * the window only ever GROWS and containment is preserved.
 *
 * Why (2026-08-10, kill #26, the first trail with real heap in it): the
 * fatal trail built 738×1338, then 739×1338, then 740×1338 — the same
 * Fraser-coast window THREE times, one pixel different each time. The
 * build key was the raw bbox to 4 decimal places, so a fraction-of-a-cell
 * wobble in the requested window (padding recomputed per grading round)
 * missed the in-flight map, missed the LRU, and paid the full ~200 MB
 * build transient again. Heap read h479 → h1135 across one such burst.
 * 0.02° (~2 km) quantisation makes those three requests ONE key; on a
 * 25-35 km window the growth is a few percent of area.
 */
export function snapTracerBbox(
    bbox: [number, number, number, number],
    snapDeg = 0.02,
): [number, number, number, number] {
    // The epsilon and the final rounding make this IDEMPOTENT: without
    // them, 153.36 / 0.02 = 7668.000000000001 and ceil grows an already-
    // snapped edge by a whole cell on every re-snap — a window that creeps
    // and a key that never stabilises (caught by the test suite before it
    // shipped).
    const grid = (v: number, dir: 'floor' | 'ceil') => {
        const idx = dir === 'floor' ? Math.floor(v / snapDeg + 1e-9) : Math.ceil(v / snapDeg - 1e-9);
        return Number((idx * snapDeg).toFixed(6));
    };
    return [grid(bbox[0], 'floor'), grid(bbox[1], 'floor'), grid(bbox[2], 'ceil'), grid(bbox[3], 'ceil')];
}

export async function buildTracerContext(
    bbox: [number, number, number, number],
    draftM: number,
    opts: {
        draftAssumed?: boolean;
        chartedDepthOnly?: boolean;
        /** The mast's air draft (m; null = not set). Omitted: the vessel
         *  profile's (vesselAirDraftMetres), as the router reads it. */
        airDraftM?: number | null;
    } = {},
): Promise<TracerBuildResult> {
    // The store is read LAZILY, and only when the caller did not say: every
    // production caller passes airDraftM (useTracerGrading, useTracerLegFixes),
    // and a module-scope import made loading this file evaluate the settings
    // store — which calls getSystemUnits() at load — so any test that mocks
    // utils/system without it failed at import (GalleyCard, Phase 2a round-2
    // review, 2026-09-30).
    const airDraftM =
        opts.airDraftM !== undefined
            ? opts.airDraftM
            : vesselAirDraftMetres(
                  (await import('../stores/settingsStore')).useSettingsStore.getState().settings.vessel,
              );
    // Snap BEFORE keying and BEFORE building: identical snapped windows
    // coalesce in flight, and the held context CONTAINS the next wobbled
    // request, so the LRU reuse check hits too.
    const snapped = snapTracerBbox(bbox);
    const key = `${snapped.map((v) => v.toFixed(4)).join(',')}|${draftM}|${opts.draftAssumed ? 1 : 0}|${opts.chartedDepthOnly ? 'charted' : 'legacy'}|air${airDraftM ?? 'unset'}`;
    const existing = inflightBuilds.get(key);
    if (existing) return existing;
    const p = contextBuildQueue(() => buildTracerContextInner(snapped, draftM, { ...opts, airDraftM })).finally(() => {
        inflightBuilds.delete(key);
    });
    inflightBuilds.set(key, p);
    return p;
}

async function buildTracerContextInner(
    bbox: [number, number, number, number],
    draftM: number,
    opts: { draftAssumed?: boolean; chartedDepthOnly?: boolean; airDraftM: number | null },
): Promise<TracerBuildResult> {
    const { spanLonM, spanLatM } = bboxSpansM(bbox);
    const spanM = Math.max(spanLonM, spanLatM);
    if (spanM > MAX_TRACE_SPAN_M) return { status: 'toolarge' };

    const t0 = Date.now();
    // Crumbed because the 2026-08-10 desktop death fell in a 29-second trail
    // gap AFTER the last merge crumb, while the census said 'plotting'. The
    // tracer builds ~40 MB grids in that gap and left no trace of it — a
    // blind spot with a body in it. Start and outcome, so a death mid-build
    // points here and not at whatever crumbed last.
    // Kill #26: a context build costs ~200 MB of transient; landing one on
    // an already-high heap is the measured death pattern. Wait for the GC
    // that reclaims it (h1135 → h388 in the fatal trail) before starting.
    await awaitHeapHeadroom();
    // Kill #30 (Mackay, 2026-08-25): the headroom brake is gauge-blind on
    // iOS, and this build was the last straw on a heap fattened by nine
    // aborted merge parses. Wait out the merge abort cooldown too —
    // discipline by construction where the gauge cannot see.
    await awaitMergeAbortCooldown();
    // heapTag: real JS heap MB in the crumb (2026-08-10, kill #23 — every
    // cache reading was healthy at death; only the process total can say
    // whether these builds ride a climbing heap).
    crumb('tracer:ctx-start', `${Math.round(spanM / 1000)}km${heapTag()}`);
    const bundle = opts.chartedDepthOnly
        ? await assembleTracerLayers(bbox, { chartedDepthOnly: true })
        : await assembleTracerLayers(bbox);
    if (!bundle) {
        crumb('tracer:ctx-nochart', `${Math.round(spanM / 1000)}km`);
        return { status: 'nochart' };
    }

    // Bridges and overhead lines this mast cannot pass under — the router's
    // verdict, from the chart's BRIDGE / CBLOHD / PIPOHD / CONVYR and the curated
    // bridge list (Phase 2a review, 2026-09-30: the tracer checked neither).
    const clearanceBars: ClearanceBar[] = [...chartClearanceBars(bundle.chartStructures ?? {}, opts.airDraftM)];
    try {
        const { loadLowBridges } = await import('./lowBridges');
        clearanceBars.push(...curatedClearanceBars(await loadLowBridges(), opts.airDraftM));
    } catch (err) {
        log.warn(
            `[tracer] curated bridge data unavailable (chart structures still checked): ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    const skipGrid = spanM > MAX_DEPTH_GRID_SPAN_M;
    // Build the depth grid OFF the main thread (2026-07-15 crash fix): the
    // synchronous build froze the WKWebView long enough for iOS to kill the
    // app. The worker keeps the UI alive; on any worker failure it falls back
    // to the sync build (navGridWorkerHost) so grading never stalls.
    const grid = skipGrid
        ? null
        : await buildNavGridAsync(
              tracerGridLayersWithBars(
                  opts.chartedDepthOnly ? chartOnlyTracerGridLayers(bundle.merged) : bundle.merged,
                  clearanceBars,
              ),
              bbox,
              tracerResolutionM(bbox),
              draftM,
              DEFAULT_TIDE_SAFETY_M,
              60,
          );
    const ctx = tracerContextFromLayers(bundle.merged, bundle.gatePairs, bbox, draftM, {
        draftAssumed: opts.draftAssumed,
        gateChecksUnavailable: bundle.gateChecksUnavailable,
        skipGrid,
        prebuiltGrid: grid,
        clearanceBars,
        airDraftM: opts.airDraftM,
    });
    ctx.supplementalChecksUnavailable = bundle.supplementalChecksUnavailable;
    if (bundle.structuresUnknownBboxes?.length) ctx.structuresUnknownBboxes = bundle.structuresUnknownBboxes;
    if (opts.chartedDepthOnly) ctx.canalLanes = [];
    log.warn(
        `context ready in ${Date.now() - t0}ms — res=${ctx.resM}m grid=${ctx.grid ? `${ctx.grid.width}×${ctx.grid.height}` : 'SKIPPED (marks-only)'} gates=${ctx.gatePairs.length}${ctx.gateChecksUnavailable ? ' (FETCH FAILED — not gate-checked)' : ''} solo=${ctx.soloLaterals.length} cardinals=${ctx.cardinals.length} leads=${ctx.leads.length}+osm${ctx.osmLeads?.length ?? 0}`,
    );
    crumb(
        'tracer:ctx-ready',
        ctx.grid
            ? `${ctx.grid.width}×${ctx.grid.height},${(tracerGridBytes(ctx) / 1024 / 1024).toFixed(0)}MB,${Date.now() - t0}ms${heapTag()}`
            : `marksonly,${Date.now() - t0}ms${heapTag()}`,
    );
    return { status: skipGrid ? 'marksonly' : 'ready', ctx };
}

// ── Geometry helpers (local equirectangular, channel scale) ────────────────

const mPerLon = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);

/** Closest point on segment ab to p, as {t, point, distM}. */
function closestOnLeg(p: TracePoint, a: TracePoint, b: TracePoint): { t: number; point: TracePoint; distM: number } {
    const kx = mPerLon(a.lat);
    const ax = a.lon * kx,
        ay = a.lat * M_PER_DEG_LAT;
    const bx = b.lon * kx,
        by = b.lat * M_PER_DEG_LAT;
    const px = p.lon * kx,
        py = p.lat * M_PER_DEG_LAT;
    const dx = bx - ax,
        dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / len2));
    const cx = ax + t * dx,
        cy = ay + t * dy;
    return {
        t,
        point: { lat: cy / M_PER_DEG_LAT, lon: cx / kx },
        distM: Math.hypot(px - cx, py - cy),
    };
}

/** Signed 2D cross product of (b−a)×(p−a) in metres² — side of line test. */
function crossSide(a: TracePoint, b: TracePoint, p: TracePoint): number {
    const kx = mPerLon(a.lat);
    return (
        (b.lon - a.lon) * kx * (p.lat - a.lat) * M_PER_DEG_LAT - (b.lat - a.lat) * M_PER_DEG_LAT * (p.lon - a.lon) * kx
    );
}

/** True when segments a1→a2 and b1→b2 properly intersect (incl. touching). */
function segmentsIntersect(a1: TracePoint, a2: TracePoint, b1: TracePoint, b2: TracePoint): boolean {
    const d1 = crossSide(b1, b2, a1);
    const d2 = crossSide(b1, b2, a2);
    const d3 = crossSide(a1, a2, b1);
    const d4 = crossSide(a1, a2, b2);
    return ((d1 >= 0 && d2 <= 0) || (d1 <= 0 && d2 >= 0)) && ((d3 >= 0 && d4 <= 0) || (d3 <= 0 && d4 >= 0));
}

const DIR_WORD: Record<CardinalDisc['dir'], string> = { n: 'north', e: 'east', s: 'south', w: 'west' };

/**
 * True when the leg, AT point p, is riding a charted lead: on the transit
 * (within LEAD_OFF_CAUTION_M — the grader's own "on the lead" threshold) and
 * roughly parallel to it. A transit that holds authority here overrules the
 * cardinal side rule (Shane 2026-08-25, Mackay southern approach: the leads
 * pass the "wrong" side of the east cardinal off Slade Island — the buoy
 * guards the island's dangers, not the lead line, and the side rule was a
 * false red on surveyed water). Preserve this legacy 40 m cardinal rule
 * separately from the typed track-review advisories below; changing warning
 * relevance must not silently change cardinal/depth/hazard treatment.
 *
 * Callers pass ctx.leads, which holds CHART leads only (RECTRC and NAVLNE
 * CATNAV 3). OSM lines (ctx.osmLeads) never hold this authority: a lead must
 * not override a hazard on lower-trust data, and the message calls it "the
 * charted lead".
 */
function ridingLeadAt(p: TracePoint, legBrgRad: number, leads: LeadingLine[]): boolean {
    for (const lead of leads) {
        if (lead.pts.length < 2) continue;
        const proj = projectToLine(p, lead.pts);
        if (proj.dist > LEAD_OFF_CAUTION_M) continue;
        let bestSeg = 1;
        let bestD = Infinity;
        for (let i = 1; i < lead.pts.length; i++) {
            const d = closestOnLeg(p, lead.pts[i - 1], lead.pts[i]).distM;
            if (d < bestD) {
                bestD = d;
                bestSeg = i;
            }
        }
        const p0 = lead.pts[bestSeg - 1];
        const p1 = lead.pts[bestSeg];
        const leadBrgRad = Math.atan2((p1.lon - p0.lon) * mPerLon(p0.lat), (p1.lat - p0.lat) * M_PER_DEG_LAT);
        let dDeg = Math.abs(((legBrgRad - leadBrgRad) * 180) / Math.PI) % 180;
        if (dDeg > 90) dDeg = 180 - dDeg;
        if (dDeg <= LEAD_MAX_ANGLE_DEG) return true;
    }
    return false;
}

/** The leg's points within CARDINAL_BAND_M of cardinal c — every ≤ 5 m, its
 *  ends inside the band, and its closest point (`near`) — for §2's read of
 *  every point (G2 review, 2026-10-04). */
function cardinalBandPoints(
    c: TracePoint,
    a: TracePoint,
    b: TracePoint,
    near: { t: number; point: TracePoint; distM: number },
): TracePoint[] {
    const out: TracePoint[] = [near.point];
    const legM = Math.hypot((b.lon - a.lon) * mPerLon(a.lat), (b.lat - a.lat) * M_PER_DEG_LAT);
    if (!(legM > 0)) return out;
    // A little beyond the band's chord, so its ends are read (the rule itself
    // stops at the band).
    const halfT = (Math.sqrt(Math.max(0, CARDINAL_BAND_M ** 2 - near.distM ** 2)) + 5) / legM;
    const t0 = Math.max(0, near.t - halfT);
    const t1 = Math.min(1, near.t + halfT);
    const n = Math.max(1, Math.ceil(((t1 - t0) * legM) / 5));
    for (let k = 0; k <= n; k++) {
        const t = t0 + ((t1 - t0) * k) / n;
        out.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
    }
    return out;
}

// ── Grid sampling ──────────────────────────────────────────────────────────

type CellRead =
    | { kind: 'blocked'; sub: 'land' | 'berth' | 'hazard' | 'markzone' | 'clearance' }
    | { kind: 'depth'; depthM: number }
    | { kind: 'caution-uncharted' }
    | { kind: 'uncharted' }
    | { kind: 'offgrid' };

function readCell(grid: NavGrid, p: TracePoint): CellRead {
    const x = Math.floor((p.lon - grid.minLon) / grid.dLon);
    const y = Math.floor((p.lat - grid.minLat) / grid.dLat);
    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return { kind: 'offgrid' };
    const idx = y * grid.width + x;
    const v = grid.cells[idx];
    if (Number.isNaN(v)) {
        if (grid.berthBlocked?.[idx]) return { kind: 'blocked', sub: 'berth' };
        if (grid.landBlocked?.[idx]) return { kind: 'blocked', sub: 'land' };
        // Mark-inference disc (solo lateral / cardinal avoidance zone) —
        // NOT a charted obstruction. The A* router treats it as blocked;
        // the tracer must tell the punter the truth: the chart may show
        // perfectly good water here, the block is IALA side-discipline.
        if (grid.markDiscBlocked?.[idx]) return { kind: 'blocked', sub: 'markzone' };
        // A low-clearance bar: water under a bridge / overhead line this mast
        // cannot pass. The leg check tests the structure's own line exactly
        // (TracerContext.clearanceBars), so the bar's cells say nothing of
        // their own — neither land, hazard nor shoal.
        if (grid.clearanceBarred?.[idx]) return { kind: 'blocked', sub: 'clearance' };
        return { kind: 'blocked', sub: 'hazard' };
    }
    if (v === CAUTION) {
        const d = grid.shallowDepthM?.[idx];
        return d !== undefined && Number.isFinite(d) ? { kind: 'depth', depthM: d } : { kind: 'caution-uncharted' };
    }
    if (v === UNKNOWN_OPEN) return { kind: 'uncharted' };
    return { kind: 'depth', depthM: v };
}

/** Any non-blocked cell within `cells` of the point? Distinguishes a sample
 *  ON the land/water boundary (chart bleed, tap imprecision, coarse-vs-fine
 *  grid disagreement — "hugs the bank", caution) from one deep inside charted
 *  land (a real crossing — danger). */
function waterNearby(grid: NavGrid, p: TracePoint, cells: number): boolean {
    const x0 = Math.floor((p.lon - grid.minLon) / grid.dLon);
    const y0 = Math.floor((p.lat - grid.minLat) / grid.dLat);
    for (let dy = -cells; dy <= cells; dy++) {
        for (let dx = -cells; dx <= cells; dx++) {
            if (dx === 0 && dy === 0) continue;
            const x = x0 + dx;
            const y = y0 + dy;
            if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
            if (!Number.isNaN(grid.cells[y * grid.width + x])) return true;
        }
    }
    return false;
}

/** What the chart says about ONE side of a lateral mark: probe the grid at
 *  12/24/36 m along the given unit direction and return the first definitive
 *  read. 'shoal' = blocked or sub-keel water; 'deep' = keel-safe water. */
type LateralSideRead = 'deep' | 'shoal' | 'unknown';
function lateralSideRead(grid: NavGrid, m: TracePoint, dirE: number, dirN: number, keelM: number): LateralSideRead {
    // Probe out to 150 m, not 36 m: the mark's OWN avoidance disc (markzone,
    // skipped below) commonly obscures the real chart within 80 m — the short
    // range returned 'unknown' exactly when a disc existed, defeating the read
    // on the marks that most need it (Shane 2026-07-16). The extra samples walk
    // PAST the disc to the real deep water / bank / land beyond it.
    for (const offM of [12, 24, 36, 55, 80, 110, 150]) {
        const p = {
            lat: m.lat + (offM * dirN) / M_PER_DEG_LAT,
            lon: m.lon + (offM * dirE) / mPerLon(m.lat),
        };
        const r = readCell(grid, p);
        if (r.kind === 'blocked') {
            // A mark-inference disc is OUR OWN synthesis around this very
            // mark — reading it as "shoal" would be circular evidence.
            // Skip it and keep probing for real chart data.
            if (r.sub === 'markzone' || r.sub === 'clearance') continue;
            return 'shoal';
        }
        if (r.kind === 'depth') return r.depthM < keelM ? 'shoal' : 'deep';
        // uncharted / caution-uncharted / offgrid — keep probing outward
    }
    return 'unknown';
}

/**
 * Direction-of-buoyage-free safe-side read for a SOLO lateral: the mark
 * guards a shoal, so the DEEP side is the passing side — derived from the
 * chart itself, no travel-direction guess (the honesty rule that kept this
 * check advisory-only). 'clean' = boat on keel-safe water with the shoal
 * confirmed on the far side of the mark (Shane 2026-07-11: a canal narrower
 * than 2× the advisory band had NO clean line — every possible trace nagged
 * "verify your side"). 'shoalside' = the boat's side of the mark reads
 * blocked/sub-keel. Anything ambiguous stays 'unknown' → the advisory holds.
 */
function lateralPassRead(
    grid: NavGrid,
    m: TracePoint,
    boatPt: TracePoint,
    keelM: number,
): 'clean' | 'shoalside' | 'unknown' {
    const kx = mPerLon(m.lat);
    let ex = (boatPt.lon - m.lon) * kx;
    let ny = (boatPt.lat - m.lat) * M_PER_DEG_LAT;
    const len = Math.hypot(ex, ny);
    if (len < 1) return 'unknown'; // trace passes essentially OVER the mark
    ex /= len;
    ny /= len;
    const boatSide = lateralSideRead(grid, m, ex, ny, keelM);
    const farSide = lateralSideRead(grid, m, -ex, -ny, keelM);
    // Shoal both sides (a channel itself charted shallower than the keel —
    // Newport's 0–2 m exit, G2 2026-10-04): the chart cannot say which side
    // the channel is, so there is no side to send the boat to.
    if (boatSide === 'shoal') return farSide === 'shoal' ? 'unknown' : 'shoalside';
    // A lateral guards a shoal on ONE side; the other side is the passing
    // water. So a CONFIRMED shoal on the FAR side means the boat is on the
    // passing side — clean — even when the boat side itself reads 'unknown'
    // because our own avoidance disc (markzone, skipped by lateralSideRead)
    // obscures the probe out to 36 m. Requiring boat-side 'deep' used to miss
    // exactly this: Shane 2026-07-16 passed a red mark on the 5 m side (2 m by
    // the land on the far side) and still got nagged. boatSide is 'deep' or
    // 'unknown' here (the 'shoal' case returned above), so far-side shoal alone
    // settles it.
    if (farSide === 'shoal') return 'clean';
    return 'unknown';
}

// ── The leg validator (pure, sync) ─────────────────────────────────────────

export function validateTraceLeg(
    a: TracePoint,
    b: TracePoint,
    ctx: TracerContext,
    /** pinStart / pinEnd: `a` / `b` is the route's departure / destination pin,
     *  so a pin in water shallower than the keel needs is named as such
     *  (Shane, 2026-10-03: Auto's shallow pins go direct, amber). */
    opts: { lastLeg?: boolean; pinStart?: boolean; pinEnd?: boolean } = {},
): TraceLegVerdict {
    const issues: TraceIssue[] = [];
    if (ctx.supplementalChecksUnavailable)
        issues.push({ severity: 'caution', message: 'marina/obstacle detail unavailable — inspect independently' });
    const legM = distM(a, b);
    const { grid, draftM } = ctx;
    const keelM = draftM + DEFAULT_TIDE_SAFETY_M;
    /** Solo-mark advisory OWNERSHIP: a mark closest to this leg near its FAR
     *  endpoint belongs to the NEXT leg (which starts there), so only one
     *  leg carries the advisory — mark "13" used to nag on both 5→6 and 6→7
     *  (Shane 2026-07-11). Distance-based, not t-based: a mark metres short
     *  of abeam of the shared pin projects at t≈0.99 and still double-
     *  flagged under a t cutoff. This leg owns the advisory only when its
     *  approach beats handing off at the far pin by >1 m; the last leg owns
     *  everything (no next leg to inherit). DANGER verdicts are exempt —
     *  a wrong-side read is positional truth on every leg it touches. */
    const ownsSoloApproach = (nearDistM: number, mark: TracePoint): boolean =>
        opts.lastLeg === true || nearDistM < distM(mark, b) - 1;

    // 1 — sample charted depth along the leg (skipped on marks-only contexts:
    // the trace outgrew the depth-grid budget, so say "unchecked", never guess).
    const stepM = Math.max(5, ctx.resM * 0.6);
    const steps = Math.max(1, Math.ceil(legM / stepM));
    let minDepthM: number | null = null;
    let minAt: TracePoint | null = null;
    let blockedAt: TracePoint | null = null;
    let blockedSub: 'land' | 'berth' | 'hazard' | null = null;
    // 0 — a bridge, overhead cable or pipe this mast cannot pass under (the
    // router's verdict and wording: too low for air draft + 1 m, no or an
    // estimated clearance, or no air draft set). Exact: the leg crosses the
    // structure's own line, never merely passes near it.
    const underBar = ctx.clearanceBars?.length
        ? polylineCrossesClearanceBar(
              [
                  [a.lon, a.lat],
                  [b.lon, b.lat],
              ],
              ctx.clearanceBars,
          )
        : null;
    if (underBar) issues.push({ severity: 'danger', message: clearanceRefusalMessage(underBar.properties, 'here') });
    // Mark-inference discs tracked SEPARATELY from hard blocks: a leg
    // crossing both a solo-mark disc and real land must still report the
    // land as danger — the disc caution must never mask it.
    let markZoneAt: TracePoint | null = null;
    let bankShaveAt: TracePoint | null = null;
    let uncharted = 0;
    let conflict = 0;
    const inCanalLane = (p: TracePoint): boolean =>
        ctx.canalLanes.some((l) => l.pts.length >= 2 && projectToLine(p, l.pts).dist <= CANAL_LANE_HALF_WIDTH_M);
    // Boundary tolerance ≈ 25 m (at least 2 cells) — the live engine's 50 m
    // grid legitimately puts a route within one coarse cell of the charted
    // bank; deep-inside-land stays a hard crossing.
    const edgeCells = Math.max(2, Math.ceil(25 / ctx.resM));
    if (grid) {
        for (let i = 0; i <= steps; i++) {
            const t = i / steps;
            const p = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
            const r = readCell(grid, p);
            if (r.kind === 'blocked' && r.sub === 'land' && inCanalLane(p)) {
                // Chart-LNDARE bleed inside a carved canal/fairway lane — the
                // lane is navigable (that's what the carve asserts), but it
                // carries no depth claim, so count it as uncharted.
                uncharted++;
            } else if (r.kind === 'blocked' && r.sub === 'land' && waterNearby(grid, p, edgeCells)) {
                // On the land/water boundary — bank hug, not a crossing.
                if (!bankShaveAt) bankShaveAt = p;
            } else if (r.kind === 'blocked' && r.sub === 'markzone') {
                if (!markZoneAt) markZoneAt = p;
            } else if (r.kind === 'blocked' && r.sub === 'clearance') {
                // Checked exactly below, against the structure's own line.
            } else if (r.kind === 'blocked' && r.sub !== 'markzone' && r.sub !== 'clearance' && !blockedAt) {
                blockedAt = p;
                blockedSub = r.sub;
            } else if (r.kind === 'depth') {
                if (minDepthM === null || r.depthM < minDepthM) {
                    minDepthM = r.depthM;
                    minAt = p;
                }
            } else if (r.kind === 'uncharted' || r.kind === 'offgrid') {
                uncharted++;
            } else if (r.kind === 'caution-uncharted') {
                conflict++;
            }
        }
    } else {
        // Marks-only context. Long legs are now cut into grid-sized pieces by
        // splitLegForDepthGrid before grading, so reaching here means the leg
        // outgrew even MAX_LEG_SUBDIVISIONS pieces — genuinely beyond what the
        // tracer can check, not merely "you should have dropped a pin". The
        // old copy told the skipper to do work the app now does itself.
        issues.push({ severity: 'caution', message: 'depth unchecked — leg too long to check' });
    }

    let needsTide = false;
    if (blockedAt && blockedSub) {
        const msg =
            blockedSub === 'land'
                ? TRACE_LAND_CROSSING_MESSAGE
                : blockedSub === 'berth'
                  ? 'cuts through marina berths'
                  : 'crosses a charted hazard';
        issues.push({ severity: 'danger', message: msg, at: blockedAt });
    } else if (markZoneAt) {
        const mz = markZoneAt;
        // A markzone disc is a ROUTING INFERENCE (a mark buffer / land-bearing
        // half-disc), NOT charted danger — real hazards took the branch above.
        // Its old "danger side" wording was a heuristic that misfired when the
        // shoal wasn't on the nearest-land side (Shane 2026-07-16: nagged
        // "danger side" while passing a red mark on the CORRECT/5 m side).
        // So READ THE CHART instead:
        //  • §2 (cardinals) and §4 (numbered solo laterals) are the
        //    authoritative per-mark checks — if one owns this disc, defer.
        //  • otherwise probe the grid on both sides of the disc's OWN mark
        //    (ctx.markHazards — the exact features that stamped the disc, so
        //    it covers OSM + unnumbered ENC marks that soloLaterals drops):
        //    SILENT on a clean pass (deep boat side, shoal/land on the far
        //    side), an honest "check which side" when the chart can't tell,
        //    and "bank side — favour the deeper side" on a confirmed shoal
        //    pass. Never the crude, over-confident "danger side" again.
        const cardinalOwns = ctx.cardinals.some((c) => closestOnLeg(c, a, b).distM < CARDINAL_BAND_M);
        const soloOwns = ctx.soloLaterals.some((m) => closestOnLeg(m, a, b).distM < SOLO_LATERAL_BAND_M);
        if (!cardinalOwns && !soloOwns) {
            let nearest: MarkHazard | null = null;
            let nd = Infinity;
            for (const mk of ctx.markHazards ?? []) {
                const d = distM(mk, mz);
                if (d < nd) {
                    nd = d;
                    nearest = mk;
                }
            }
            const read =
                grid && nearest ? lateralPassRead(grid, nearest, closestOnLeg(nearest, a, b).point, keelM) : 'unknown';
            if (read === 'shoalside') {
                // Chart puts the boat on the SHOAL side of the mark — a real
                // risk, keep the teeth.
                issues.push({
                    severity: 'caution',
                    message: 'bank side of a nearby mark — favour the deeper side',
                    at: mz,
                });
            } else if (nearest?.hand) {
                // A lateral mark with a known IALA hand. Which side of THIS
                // course does it sit on? (signed cross-product, cos-lat scaled).
                const kx = Math.cos((a.lat * Math.PI) / 180);
                const dx = (b.lon - a.lon) * kx;
                const dy = b.lat - a.lat;
                const px = (nearest.lon - a.lon) * kx;
                const py = nearest.lat - a.lat;
                // cross > 0 ⇒ mark is to the LEFT of the course = your port side.
                const courseSide = dx * py - dy * px > 0 ? 'port' : 'starboard';
                const isPort = nearest.hand === 'port';
                const colour = isPort ? 'Red port-hand' : 'Green starboard-hand';
                // Red-to-port / green-to-starboard is the config you're in
                // proceeding WITH the buoyage (inbound); the opposite is the
                // outbound-correct config. So the mark's side tells the skipper
                // which HEADING this is the correct side for.
                const keepInbound = (isPort && courseSide === 'port') || (!isPort && courseSide === 'starboard');
                // The SAFETY truth is the charted depth where the boat sails:
                // clean read, or a keel-safe least-depth on the leg. Deep water
                // ⇒ this is a safe pass ⇒ GREEN confirmation with the IALA
                // context, not an amber nag (Shane 2026-07-16: "can it be green
                // because I'm on the correct side?"). Sub-keel / unproven water
                // keeps the amber advisory (and the depth block flags the depth).
                const depthSafe = read === 'clean' || (minDepthM !== null && minDepthM >= keelM);
                if (depthSafe) {
                    issues.push({
                        severity: 'info',
                        message: `${colour} mark to your ${courseSide} — correct side heading ${keepInbound ? 'in' : 'out'} (IALA-A)`,
                        at: mz,
                    });
                } else {
                    issues.push({
                        severity: 'caution',
                        message: `${colour} mark on your ${courseSide} — IALA-A: keep ${isPort ? 'red to port' : 'green to starboard'} heading in`,
                        at: mz,
                    });
                }
            } else if (read !== 'clean') {
                // No IALA hand (a direct point-hazard inference) and the chart
                // can't confirm clean → honest verify.
                issues.push({ severity: 'caution', message: 'near a mark — check which side is safe', at: mz });
            }
            // read === 'clean' with no hand → silent (chart confirms the side).
        }
    } else if (bankShaveAt) {
        issues.push({ severity: 'caution', message: 'hugs the charted bank — verify the line', at: bankShaveAt });
    }
    // A pin in charted water shallower than the keel needs (the route's
    // departure or destination; Shane, 2026-10-03): the leg says so in its
    // own words — "starts in 1.2 m charted water — needs +1.7 m tide" — in
    // place of the shallowest-spot line when the pin's water is the shallowest.
    let pinNamesLeast = false;
    if (grid) {
        for (const [on, at, verb] of [
            [opts.pinStart, a, 'starts'],
            [opts.pinEnd, b, 'ends'],
        ] as const) {
            if (!on) continue;
            const r = readCell(grid, at);
            if (r.kind !== 'depth' || r.depthM >= keelM) continue;
            const water =
                r.depthM < 0
                    ? `on ground charted to dry ${Math.abs(r.depthM).toFixed(1)} m`
                    : r.depthM === 0
                      ? 'in water charted awash at low tide'
                      : `in ${r.depthM.toFixed(1)} m charted water`;
            needsTide = true;
            issues.push({
                severity: 'danger',
                message: `${verb} ${water} — needs +${(keelM - r.depthM).toFixed(1)} m tide`,
                at,
            });
            if (minDepthM === null || r.depthM <= minDepthM) pinNamesLeast = true;
        }
    }
    if (minDepthM !== null && minAt) {
        if (minDepthM < keelM && pinNamesLeast) {
            needsTide = true;
        } else if (minDepthM < keelM) {
            needsTide = true;
            const rise = keelM - minDepthM;
            // "0.0 m charted" read as "not charted at all" (Shane
            // 2026-07-11, Newport entrance — a properly-surveyed 0–2 m
            // band whose FLOOR we grade against). Zero and drying
            // depths now speak chart language instead of printing a
            // bare band floor.
            const depthWord =
                minDepthM < 0
                    ? `dries ${Math.abs(minDepthM).toFixed(1)} m at low tide`
                    : minDepthM === 0
                      ? 'charted awash at low tide'
                      : `${minDepthM.toFixed(1)} m charted`;
            issues.push({
                severity: 'danger',
                message: `${depthWord} — needs +${rise.toFixed(1)} m tide`,
                at: minAt,
            });
        } else if (minDepthM < keelM + THIN_MARGIN_M) {
            issues.push({
                severity: 'caution',
                message: `thin water — ${minDepthM.toFixed(1)} m charted at low tide (LAT)`,
                at: minAt,
            });
        }
    }
    if (conflict > 0) {
        issues.push({ severity: 'caution', message: 'depth data conflicts here — treat as unproven' });
    }
    if (uncharted / (steps + 1) > 0.3) {
        issues.push({ severity: 'caution', message: 'no charted depth for part of this leg' });
    }

    const legBrgRad = Math.atan2((b.lon - a.lon) * mPerLon(a.lat), (b.lat - a.lat) * M_PER_DEG_LAT);

    // 2 — cardinals: the leg must stay on the safe quadrant side.
    for (const c of ctx.cardinals) {
        const near = closestOnLeg(c, a, b);
        if (near.distM > CARDINAL_BAND_M) continue;
        // The wrong side (tier3/cardinalClamp cardinalWrongSideAt — the rule
        // the router's own red reads): close in (under CARDINAL_CLEAR_M), the
        // danger's whole half; beyond that, only its HAZARD quadrant (±45° of
        // the danger's direction), a centimetre's grace on either line. The
        // real-chart check (2026-10-03): read from the along-offset alone, a
        // leg whose nearest point lay 338 m SOUTH of an east cardinal, 24 m
        // west of its meridian, was "the wrong side" — and a leg passing
        // 390 m off "shaves" it. Fix-up review (that day): the quadrant rule
        // alone turned a pass 30 m SSW of an east cardinal from danger into a
        // caution Save does not stop for.
        //   Read at EVERY point of the leg inside the band, not only its
        // closest (G2 review, 2026-10-04): a leg whose closest point lay
        // 100 m north of an east cardinal, just east of its meridian, ran on
        // 290 m west into its hazard quadrant and was graded clear, while the
        // router drew the same line red and Save refused it. A wrong-side
        // point riding a charted lead is the lead's; the nearest one that is
        // not is the danger.
        let wrong: { at: TracePoint; m: number } | null = null;
        let onLead: { at: TracePoint; m: number } | null = null;
        for (const p of cardinalBandPoints(c, a, b, near)) {
            if (!cardinalWrongSideAt(c, p.lon, p.lat)) continue;
            const m = Math.hypot((p.lon - c.lon) * mPerLon(c.lat), (p.lat - c.lat) * M_PER_DEG_LAT);
            if (ridingLeadAt(p, legBrgRad, ctx.leads)) {
                if (!onLead || m < onLead.m) onLead = { at: p, m };
            } else if (!wrong || m < wrong.m) wrong = { at: p, m };
        }
        if (wrong) {
            issues.push({
                severity: 'danger',
                message: `wrong side of the ${DIR_WORD[c.dir]} cardinal — pass ${DIR_WORD[c.dir]} of it`,
                at: wrong.at,
                mark: { lat: c.lat, lon: c.lon },
            });
        } else if (onLead) {
            // Transit authority — same philosophy as the lateral rule's
            // "chart confirms the side → silent": the harbour authority
            // surveyed the lead PAST this buoy, so its side rule does not
            // apply to the lead line. Green info, not silence, so the
            // skipper sees the mark was considered, not missed.
            issues.push({
                severity: 'info',
                message: `on the charted lead — ${DIR_WORD[c.dir]} cardinal ${Math.round(onLead.m)} m off marks a danger the transit clears`,
                at: onLead.at,
                mark: { lat: c.lat, lon: c.lon },
            });
        } else if (near.distM < CARDINAL_CLEAR_M) {
            // Leads routinely run close past cardinals by design — on the
            // transit the shave is the surveyed geometry, and #5 already owns
            // off-lead drift. Skip, don't nag.
            if (ridingLeadAt(near.point, legBrgRad, ctx.leads)) continue;
            // NO ownership dedupe here (unlike solo laterals): the shave is
            // judged at each leg's own closest point, so the next leg's
            // check can land on a different, healthier spot — suppressing
            // this leg would lose a REAL 60 m pass on a dogleg. A duplicate
            // row beats a silent shave.
            issues.push({
                severity: 'caution',
                message: `shaves the ${DIR_WORD[c.dir]} cardinal — give it ${CARDINAL_CLEAR_M} m`,
                at: near.point,
                mark: { lat: c.lat, lon: c.lon },
            });
        }
    }

    // 3 — gate pairs: thread BETWEEN port and starboard, not outside.
    for (const g of ctx.gatePairs) {
        const mid = { lat: (g.port.lat + g.stbd.lat) / 2, lon: (g.port.lon + g.stbd.lon) / 2 };
        const near = closestOnLeg(mid, a, b);
        if (near.distM > GATE_BAND_M) continue;
        if (segmentsIntersect(a, b, g.port, g.stbd)) continue; // threaded — perfect
        // Does the leg cross the gate LINE beyond one of the marks? That's the
        // classic "went the wrong side of the red" — flag it. A leg that stops
        // short of the line (pin dropped mid-approach) is left alone; the next
        // leg gets the same check.
        const sA = crossSide(g.port, g.stbd, a);
        const sB = crossSide(g.port, g.stbd, b);
        if ((sA >= 0 && sB <= 0) || (sA <= 0 && sB >= 0)) {
            const halfM = distM(g.port, g.stbd) / 2;
            // Crossing point distance from gate midpoint along the gate line —
            // beyond ~2 gate half-widths is an unrelated channel arm, skip.
            // (Was Math.max(halfM*2, GATE_BAND_M), which defeated the cutoff
            // for every real pair narrower than 300 m half-width — false reds
            // 250 m outside a 60 m club channel in honest deep water.)
            const cross = closestOnLeg(mid, a, b).point;
            const offM = distM(mid, cross);
            if (offM <= Math.max(halfM * 2, 60)) {
                const outsidePort = distM(cross, g.port) < distM(cross, g.stbd);
                issues.push({
                    severity: 'danger',
                    message: `wrong side of the ${outsidePort ? 'red (port)' : 'green (starboard)'} mark — pass between the pair`,
                    at: cross,
                    mark: outsidePort ? g.port : g.stbd,
                });
            }
        }
    }

    // 4 — solo laterals: close approach → verify-the-side advisory. Without a
    // derived direction of buoyage we don't guess the safe side (honesty rule)
    // — the engine's full clamp does that on computed routes; here the skipper
    // drew the line, so we just make sure the mark is CONSIDERED.
    for (const m of ctx.soloLaterals) {
        const near = closestOnLeg(m, a, b);
        if (near.distM < SOLO_LATERAL_BAND_M && ownsSoloApproach(near.distM, m)) {
            // Chart-derived side check: when the grid CONFIRMS the boat is
            // on keel-safe water and the shoal sits on the far side of the
            // mark, the pass is correct — say nothing (a clean run through
            // a narrow canal is possible again). Only ambiguity keeps the
            // honest "verify your side"; a confirmed bank-side pass warns
            // with teeth.
            const read = grid ? lateralPassRead(grid, m, near.point, keelM) : 'unknown';
            if (read === 'clean') continue;
            // Between it and an opposite-hand mark, with the side unknown:
            // the leg threads the chart's own pair, a gate no regional file
            // paired (offline, G2 2026-10-04: Newport's exit legs through
            // each gate's midpoint, 27 m from each mark, were told "bank
            // side of port mark 8 — cross to the channel side"), so no
            // "verify your side". A CONFIRMED bank-side pass still warns (G2
            // review, 2026-10-04: solo laterals are the marks the pairing
            // declined to pair — two channels either side of a bank, a pair
            // over shoal — and the skip dropped a real bank-side pass's only
            // side warning).
            if (
                read === 'unknown' &&
                ctx.soloLaterals.some(
                    (o) =>
                        o.side !== m.side &&
                        distM(o, m) <= SOLO_PAIR_MAX_M &&
                        (segmentsIntersect(a, b, m, o) ||
                            closestOnLeg(a, m, o).distM < 1 ||
                            closestOnLeg(b, m, o).distM < 1),
                )
            )
                continue;
            const markName = `${m.side === 'port' ? 'port' : 'starboard'} mark${m.name ? ` ${m.name}` : ''}`;
            issues.push({
                severity: 'caution',
                message:
                    read === 'shoalside'
                        ? `bank side of ${markName} — cross to the channel side`
                        : `${Math.round(near.distM)} m off ${markName} — verify your side`,
                at: near.point,
                mark: { lat: m.lat, lon: m.lon },
            });
        }
    }

    // 5 — Review sustained alignment with relevant chart tracks. Crossing,
    // joining/leaving and finite line ends are not off-track errors. Untyped
    // bearings/clearing lines cannot become a sailing instruction.
    const alignment = chartTrackOffsetForLeg(a, b, ctx.chartTracks ?? [], () => {
        issues.push({ severity: 'caution', message: 'Chart-track alignment check incomplete — inspect the chart.' });
    });
    if (alignment)
        issues.push({
            severity: 'caution',
            message: `${Math.round(alignment.offsetM)} m from charted track — review alignment`,
            at: alignment.at,
            chartTrack: {
                id: alignment.track.id,
                label: alignment.track.label,
                kind: alignment.track.kind,
                offsetM: alignment.offsetM,
            },
        });

    // 6 — deeper-water nudge for thin/sub-keel legs (advisory only).
    let nudge: string | null = null;
    let nudgeTo: TracePoint | null = null;
    if (grid && minAt && minDepthM !== null && minDepthM < keelM + THIN_MARGIN_M) {
        // Perpendicular unit vector (east, north): leg dir is (sin brg, cos brg),
        // rotated 90° clockwise = starboard side of travel.
        const perpE = Math.cos(legBrgRad);
        const perpN = -Math.sin(legBrgRad);
        outer: for (const offM of [30, 60, 90, 120]) {
            for (const sign of [1, -1] as const) {
                const q = {
                    lat: minAt.lat + (sign * offM * perpN) / M_PER_DEG_LAT,
                    lon: minAt.lon + (sign * offM * perpE) / mPerLon(minAt.lat),
                };
                const r = readCell(grid, q);
                if (r.kind === 'depth' && r.depthM >= keelM + THIN_MARGIN_M) {
                    // sign +1 = right of travel = starboard.
                    nudge = `deeper water ~${offM} m to ${sign === 1 ? 'starboard' : 'port'}`;
                    nudgeTo = q; // the exact charted deeper spot → ghost waypoint
                    break outer;
                }
            }
        }
    }

    // Gate honesty: when the marker fetch threw, ctx.gatePairs is empty for a
    // NETWORK reason, so the threading check above silently found nothing to
    // check. That reads exactly like "this water has no gates" — and a leg that
    // could have been a wrong-side DANGER comes back clear. Say so.
    // Unconditional (not gated on issues.length): an already-cautioned leg can
    // still be hiding a wrong-side pass, and on a danger leg this is a no-op
    // because danger already wins the grade.
    if (ctx.gateChecksUnavailable) {
        issues.push({ severity: 'caution', message: 'channel marks unchecked — mark data did not load' });
    }

    // Overhead honesty (owner decision 8): a leg through a chart that carries
    // no bridge / overhead-line layers was checked against Thalassa's own
    // bridge list only. Said as an 'info' note, last, so it never changes the
    // grade nor displaces a leg's own confirmation (fix-up, 2026-09-30).
    const structuresUnchecked = (ctx.structuresUnknownBboxes ?? []).some(
        ([w, s, e, n]) =>
            Math.max(a.lon, b.lon) >= w &&
            Math.min(a.lon, b.lon) <= e &&
            Math.max(a.lat, b.lat) >= s &&
            Math.min(a.lat, b.lat) <= n,
    );

    // Draft honesty: a "clear" graded against the 2.5 m FALLBACK draft is not
    // a clear — downgrade with an explicit reason until a real draft exists.
    if (ctx.draftAssumed && issues.length === 0) {
        issues.push({ severity: 'caution', message: 'checked against a default 2.5 m draft — set your vessel' });
    }

    if (structuresUnchecked) {
        issues.push({
            severity: 'info',
            message: 'bridges and power lines not checked on this chart — known bridges are',
        });
    }

    // 'info' issues are GREEN confirmations — they must NOT escalate the grade
    // (a right mark-pass reads clear, not amber). Only a real caution does.
    const grade: TraceGrade = issues.some((i) => i.severity === 'danger')
        ? 'danger'
        : issues.some((i) => i.severity === 'caution')
          ? 'caution'
          : 'clear';
    return { grade, issues, minDepthM, minAt, needsTide, nudge, nudgeTo };
}

/** Grade every leg of a trace. verdicts[i] covers points[i]→points[i+1]. */
export function validateTrace(points: readonly TracePoint[], ctx: TracerContext): TraceLegVerdict[] {
    const out: TraceLegVerdict[] = [];
    for (let i = 1; i < points.length; i++)
        out.push(validateTraceLeg(points[i - 1], points[i], ctx, { lastLeg: i === points.length - 1 }));
    return out;
}

// ── Tide window label (async, per sub-keel leg) ────────────────────────────

const fmtHm = (ms: number): string =>
    new Date(ms).toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });

/** "today" / "tonight" / "tomorrow" for a window opening — a bare "08:45"
 *  read tonight was tomorrow's window to the punter (windows shift ~50 min/
 *  day, so acting on the wrong day is a real grounding vector). Beyond
 *  tomorrow (departure-time planning) the actual date is the only honest
 *  label: "Sat 19 Jul". */
function dayWord(ms: number): string {
    const now = new Date();
    const then = new Date(ms);
    if (then.getDate() === now.getDate() && then.getMonth() === now.getMonth()) {
        return then.getHours() >= 18 ? 'tonight' : 'today';
    }
    const tomorrow = new Date(now.getTime() + 24 * 3600_000);
    if (then.getDate() === tomorrow.getDate() && then.getMonth() === tomorrow.getMonth()) return 'tomorrow';
    return then.toLocaleDateString('en-AU', { weekday: 'short', day: 'numeric', month: 'short' });
}

/**
 * "clears 08:45–14:30 today" ("(approx)" from interpolated extremes) for a
 * shallow spot over the 24 h from `fromMs`, or "needs +X.X m — no tide
 * window in 24 h". Null when tide data is unavailable (offline) — the leg
 * stays red with its depth message; never guess a window.
 *
 * `fromMs` (default now) is the leg's ARRIVAL time when a departure date/
 * time is set (Shane 2026-07-16: "the tide crossings need to update with the
 * departure time") — the window question becomes "is there water when I'm
 * actually THERE", not "is there water right now".
 */
export async function tideWindowLabelFor(
    minDepthM: number,
    draftM: number,
    at: TracePoint,
    fromMs: number = Date.now(),
): Promise<string | null> {
    try {
        const untilMs = fromMs + 24 * 3600_000;
        // A whole-span curve at its 0.25° bucket centre: the charted shallow
        // spot itself never leaves the device (127-C-b).
        const curve = await fetchTideCurve(at.lat, at.lon, fromMs, untilMs, { days: TIDE_CURVE_MAX_DAYS });
        if (!curve) return null;
        const res = computeTidalWindows({ minDepthM, draftM, tide: tideFieldFromCurve(curve), fromMs, untilMs });
        // alwaysOpen with a real required rise = the tide never drops low
        // enough to matter — say so (the popup used to show "tide data
        // unavailable" for this, review minor 2026-07-11). Zero/negative
        // rise = nothing to say, as before.
        if (res.alwaysOpen) return res.requiredRiseM > 0 ? 'the tide covers this all day' : null;
        if (res.windows.length === 0) return `needs +${res.requiredRiseM.toFixed(1)} m — no tide window in 24 h`;
        const w = res.windows[0];
        // Window already open at the reference time: say so — the 17:34 bug
        // (Shane 2026-07-12: "+1 m of water... it always says this") was this
        // exact case pointed at the NEXT window instead. "NOW" only when the
        // reference time IS now; a future arrival says "on arrival".
        if (w.openMs <= fromMs) {
            const openWord = fromMs - Date.now() > 5 * 60_000 ? 'on arrival' : 'NOW';
            return `clears ${openWord} until ${fmtHm(w.closeMs)} ${dayWord(w.closeMs)}${w.approx ? ' (approx)' : ''}`;
        }
        return `clears ${fmtHm(w.openMs)}–${fmtHm(w.closeMs)} ${dayWord(w.openMs)}${w.approx ? ' (approx)' : ''}`;
    } catch (err) {
        log.warn(`tide window failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
}

// ── Pin helpers (P2 punter-proofing) ───────────────────────────────────────

/** Is this exact spot blocked in the tracer grid (and why)? Drives the
 *  pin-level diagnosis: "pin 4 is on charted land — drag it seaward".
 *  A mark-inference disc reads as NOT blocked here: a pin dropped in
 *  charted-good water beside a solo mark is a legitimate pin — the leg
 *  verdict carries the mark caution instead. */
export function tracePinBlocked(ctx: TracerContext, p: TracePoint): 'land' | 'berth' | 'hazard' | null {
    if (!ctx.grid) return null;
    const r = readCell(ctx.grid, p);
    return r.kind === 'blocked' && r.sub !== 'markzone' && r.sub !== 'clearance' ? r.sub : null;
}

/**
 * Snap a pin dropped NEAR a lead (RECTRC/NAVLNE transit) exactly ONTO it
 * (Shane 2026-07-17: "very hard to get it on top of the lead with my fat
 * fingers"). A lead IS the intended line — a pin within thumb-slop of one
 * almost certainly means "on the lead". Returns the projection onto the
 * nearest lead within `maxM`, or null (deliberate off-lead placement more
 * than maxM away stays exactly where the skipper put it).
 *
 * 120 m grab radius (Shane 2026-07-17: "make it a bit of a larger area") —
 * up from 50 m. Leads are sparse (a handful of charted transits per harbour,
 * far apart), so a wide catch almost never has to choose between two, and
 * intent is rarely ambiguous: near a lead you mean the lead.
 */
export function snapTraceTapToLead(ctx: TracerContext, p: TracePoint, maxM = 120): TracePoint | null {
    let best: { point: TracePoint; dist: number } | null = null;
    for (const lead of [...ctx.leads, ...(ctx.osmLeads ?? [])]) {
        if (lead.pts.length < 2) continue;
        const proj = projectToLine(p, lead.pts);
        if (proj.dist <= maxM && (!best || proj.dist < best.dist)) best = proj;
    }
    return best ? { lat: best.point.lat, lon: best.point.lon } : null;
}

/**
 * Snap a fat-fingered tap on the breakwater/bank to the nearest navigable
 * cell (spiral search, ≤ maxM). Returns null when the spot is fine as-is or
 * nothing navigable is close — the tap then lands verbatim and the pin-level
 * diagnosis explains it. Never snaps ACROSS more than maxM: a deliberate
 * inland tap stays where the skipper put it.
 */
export function snapTraceTapToWater(ctx: TracerContext, p: TracePoint, maxM = 60): TracePoint | null {
    const grid = ctx.grid;
    if (!grid) return null;
    if (tracePinBlocked(ctx, p) === null) return null; // already navigable
    const maxCells = Math.max(1, Math.ceil(maxM / ctx.resM));
    const x0 = Math.floor((p.lon - grid.minLon) / grid.dLon);
    const y0 = Math.floor((p.lat - grid.minLat) / grid.dLat);
    let best: { x: number; y: number; d2: number } | null = null;
    for (let dy = -maxCells; dy <= maxCells; dy++) {
        for (let dx = -maxCells; dx <= maxCells; dx++) {
            const x = x0 + dx;
            const y = y0 + dy;
            if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
            if (Number.isNaN(grid.cells[y * grid.width + x])) continue;
            const d2 = dx * dx + dy * dy;
            if (!best || d2 < best.d2) best = { x, y, d2 };
        }
    }
    if (!best) return null;
    return {
        lat: grid.minLat + (best.y + 0.5) * grid.dLat,
        lon: grid.minLon + (best.x + 0.5) * grid.dLon,
    };
}

// ── Route health summary ───────────────────────────────────────────────────

export interface TraceHealth {
    clear: number;
    caution: number;
    danger: number;
    /** Legs not graded yet (null slots — their window is still building). */
    pending: number;
    label: string;
    tone: TraceGrade;
}

export function traceHealth(verdicts: ReadonlyArray<TraceLegVerdict | null | undefined>): TraceHealth {
    let clear = 0,
        caution = 0,
        danger = 0;
    let pending = 0;
    for (const v of verdicts) {
        if (!v) {
            pending++; // slot still grading in its build window
            continue;
        }
        if (v.grade === 'danger') danger++;
        else if (v.grade === 'caution') caution++;
        else clear++;
    }
    // Pending legs must never read as green — a just-loaded 60 km trace is
    // ALL nulls for a few seconds, and "all clear" there is a lie. Confirmed
    // dangers still headline (they don't get less real while others grade).
    const graded = clear + caution + danger;
    const label =
        verdicts.length === 0
            ? 'drop pins to trace'
            : danger > 0
              ? `${danger} no-go leg${danger > 1 ? 's' : ''}`
              : pending > 0
                ? `checking ${graded}/${verdicts.length}…`
                : caution > 0
                  ? `${caution} caution${caution > 1 ? 's' : ''}`
                  : 'all clear';
    return {
        clear,
        caution,
        danger,
        pending,
        label,
        tone: danger > 0 ? 'danger' : caution > 0 || pending > 0 ? 'caution' : 'clear',
    };
}

// ── P4: save / load / flywheel / sail ──────────────────────────────────────

export interface SavedTrace {
    id: string;
    name: string;
    createdAt: string; // ISO
    /** Set on overwrite-saves — the cross-device merge keeps the newer copy. */
    updatedAt?: string;
    points: TracePoint[];
    // ── Multi-leg trip chain (Shane 2026-07-17: "we need to get our LEGS
    //    functioning") — legs of one trip share a tripId (= leg 1's own id);
    //    the chain is STRUCTURAL and is persisted through saved_routes. Names
    //    remain generated decoration plus a compatibility fallback for older
    //    rows created before the chain columns existed. ──
    /** Trip this leg belongs to — leg 1's id. Absent on standalone routes. */
    tripId?: string;
    /** 1-based position within the trip. */
    legOrdinal?: number;
    /** This leg's destination as the punter named it ("Woorim") — seeds the
     *  NEXT leg's name prefill without re-parsing the route name. */
    destName?: string;
    /** Exact planned-route mirror id in ship_logs. Unlike a route label this
     *  is safe to use for a delete cascade. */
    plannedRouteId?: string;
    /** Exact Passage Planning record backing this saved trace. */
    passageVoyageId?: string;
    /** Safety verdict for this exact geometry. Missing/invalid means the
     * route must be checked again before export, follow or Cast Off. */
    verification?: TraceVerification;
    /** Historical planned-only origin/check evidence, never navigation release. */
    proposalEvidence?: SavedAutoroutingProposalEvidence;
}

const TRACES_KEY = 'thalassa_traced_routes_v1';
const TRACE_TOMBSTONES_KEY = 'thalassa_traced_route_tombstones_v1';

/** A local deletion fence. Keeping this separately from saved_routes makes a
 * delete immediately authoritative even while the cloud tombstone is still
 * in flight; otherwise a simultaneous pull can put the old remote row back
 * into Plan before its delete reaches Supabase. */
export interface SavedTraceTombstone {
    deletedAt: string;
    plannedRouteId?: string;
    passageVoyageId?: string;
}

/**
 * The planner can intentionally return no Passage Planning row when a saved
 * trace is mirrored offline. Accept that nullable result at the tracer
 * boundary, while only persisting concrete ids into trace/tombstone storage.
 */
type TracePassageLinks = {
    plannedRouteId?: string;
    passageVoyageId?: string | null;
};

function tracesStorageKey(scope: AuthIdentityScope = getAuthIdentityScope()): string {
    return authScopedStorageKey(TRACES_KEY, scope);
}

function traceTombstonesStorageKey(scope: AuthIdentityScope = getAuthIdentityScope()): string {
    return authScopedStorageKey(TRACE_TOMBSTONES_KEY, scope);
}

function isFiniteIso(value: unknown): value is string {
    return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

/** Read only well-formed, account-scoped deletion fences. */
export function getSavedTraceTombstones(
    scope: AuthIdentityScope = getAuthIdentityScope(),
): Record<string, SavedTraceTombstone> {
    try {
        if (!isAuthIdentityScopeCurrent(scope)) return {};
        const raw = localStorage.getItem(traceTombstonesStorageKey(scope));
        if (!raw) return {};
        const parsed: unknown = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
        const tombstones: Record<string, SavedTraceTombstone> = {};
        for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!id || !value || typeof value !== 'object' || Array.isArray(value)) continue;
            const candidate = value as Partial<SavedTraceTombstone>;
            if (!isFiniteIso(candidate.deletedAt)) continue;
            tombstones[id] = {
                deletedAt: candidate.deletedAt,
                ...(typeof candidate.plannedRouteId === 'string' && candidate.plannedRouteId
                    ? { plannedRouteId: candidate.plannedRouteId }
                    : {}),
                ...(typeof candidate.passageVoyageId === 'string' && candidate.passageVoyageId
                    ? { passageVoyageId: candidate.passageVoyageId }
                    : {}),
            };
        }
        return tombstones;
    } catch {
        return {};
    }
}

function writeSavedTraceTombstones(
    tombstones: Record<string, SavedTraceTombstone>,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): void {
    if (!isAuthIdentityScopeCurrent(scope)) return;
    localStorage.setItem(traceTombstonesStorageKey(scope), JSON.stringify(tombstones));
}

/** Clear a locally-recorded delete only when a deliberate new save uses the
 * same id. Normal route saves mint a fresh id, so a tombstone cannot vanish
 * just because another route was written. */
export function clearSavedTraceTombstone(id: string, scope: AuthIdentityScope = getAuthIdentityScope()): void {
    const traceId = id.trim();
    if (!traceId || !isAuthIdentityScopeCurrent(scope)) return;
    const tombstones = getSavedTraceTombstones(scope);
    if (!Object.prototype.hasOwnProperty.call(tombstones, traceId)) return;
    delete tombstones[traceId];
    try {
        writeSavedTraceTombstones(tombstones, scope);
    } catch {
        /* A stale tombstone is safer than resurrecting a deleted route. */
    }
}

/**
 * A planned-route mirror can finish after its canonical trace was deleted.
 * Preserve those exact ids on the existing deletion fence before attempting
 * cleanup, so an offline/late cleanup is retried on the next account sync
 * instead of becoming a permanent Passage Planning orphan.
 */
export function attachSavedTraceTombstoneLinks(
    id: string,
    links: TracePassageLinks,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): boolean {
    const traceId = id.trim();
    if (!traceId || !isAuthIdentityScopeCurrent(scope)) return false;
    const tombstones = getSavedTraceTombstones(scope);
    const previous = tombstones[traceId];
    if (!previous) return false;
    const next: SavedTraceTombstone = {
        ...previous,
        ...(links.plannedRouteId ? { plannedRouteId: links.plannedRouteId } : {}),
        ...(links.passageVoyageId ? { passageVoyageId: links.passageVoyageId } : {}),
    };
    try {
        writeSavedTraceTombstones({ ...tombstones, [traceId]: next }, scope);
        return true;
    } catch {
        // The immediate cleanup still runs. A missing retry record is less
        // ideal, but never turn this best-effort metadata write into a route
        // resurrection or a false success.
        return false;
    }
}

/** Remove deletion fences the account has already acknowledged remotely. */
export function clearSyncedSavedTraceTombstones(
    ids: Iterable<string>,
    scope: AuthIdentityScope = getAuthIdentityScope(),
): void {
    if (!isAuthIdentityScopeCurrent(scope)) return;
    const tombstones = getSavedTraceTombstones(scope);
    let changed = false;
    for (const id of ids) {
        if (Object.prototype.hasOwnProperty.call(tombstones, id)) {
            delete tombstones[id];
            changed = true;
        }
    }
    if (!changed) return;
    try {
        writeSavedTraceTombstones(tombstones, scope);
    } catch {
        /* Keep the in-memory result; the next sync can compact again. */
    }
}

/** Shared notification for every Saved Routes surface. */
export function notifySavedRoutesChanged(scope: AuthIdentityScope = getAuthIdentityScope()): void {
    if (!isAuthIdentityScopeCurrent(scope) || typeof window === 'undefined') return;
    try {
        window.dispatchEvent(
            new CustomEvent('thalassa:saved-routes-changed', {
                detail: { scopeKey: scope.key, scopeGeneration: scope.generation },
            }),
        );
    } catch {
        /* non-critical */
    }
}

// ── Leg-verdict persistence (Shane 2026-07-17: "sometimes the app wants to
// check the entire route again, even though nothing changed") ─────────────
// The in-memory verdict cache dies with the MapHub instance — every reload,
// deploy, or tab-bounce remounted a COLD cache and a kept route re-graded
// from scratch. Verdicts are pure functions of (leg coords, draft, chart
// library), so they persist across mounts guarded by exactly those: a
// draft change or a chart install/update (registry version bump) drops the
// lot; otherwise a remount re-grades nothing.

/**
 * BUMP THIS WHENEVER GRADING SEMANTICS OR VERDICT COPY CHANGE.
 *
 * The stamp below guards draft and chart-registry changes, and nothing else —
 * so a code change that makes the SAME leg grade differently is invisible to it
 * and the old verdict is replayed forever. That is not hypothetical: after long
 * legs started subdividing, devices kept showing "leg too long, drop a pin
 * midway" from cache, on a build where that string no longer existed anywhere.
 *
 * v2 (2026-08-01): long-leg subdivision, the gate-checks-unavailable caution,
 * and the reworded too-long copy.
 * v3 (2026-09-13): typed finite track-alignment review; clearing bearings,
 * crossings and joins must not replay old "steer to the transit" verdicts.
 * v4 (2026-09-30): legs are graded against bridges and overhead lines for the
 * mast's air draft (TracerContext.clearanceBars), and the stamp carries that
 * air draft — a v3 verdict never checked a single bridge.
 * v5 (2026-10-10, 127-C-b): legs over licensed charts are banked as grade
 * stubs (services/chartFacts) — no charted depth, position or reason on the
 * disk — so a relaunch still grades nothing. Older banks are removed at
 * launch (purgeChartFactsOnDisk).
 */
export const LEG_VERDICTS_KEY = 'thalassa_leg_verdicts_v5';
/** A working route is tens of legs; 500 covers several routes' churn
 *  without letting localStorage bloat. Insertion order ≈ age — the tail
 *  (newest) survives the cap. */
const LEG_VERDICTS_CAP = 500;

interface PersistedLegVerdicts {
    draftM: number;
    draftAssumed: boolean;
    /** getRegistryFingerprint() — the STABLE cross-session chart-library
     *  identity. This used to be the in-memory registry version counter,
     *  which resets to 0 every boot and bumps on every putCell (the cloud
     *  manifest walk re-puts pending cells every ≥5 min), so hydration
     *  essentially never matched: every relaunch cold-regraded the whole
     *  passage — the 2026-08-04 Lady Musgrave regrade loop's cross-boot
     *  amplifier, and exactly the crash-loop the incremental banking below
     *  was built to break. */
    encFingerprint: string;
    /** The air draft (m; null = not set) the legs' overhead clearance was
     *  graded against. */
    airDraftM?: number | null;
    entries: Array<[string, TraceLegVerdict]>;
}

export function persistLegVerdicts(
    cache: ReadonlyMap<string, TraceLegVerdict>,
    draftM: number,
    draftAssumed: boolean,
    encFingerprint: string,
    airDraftM: number | null = null,
): void {
    try {
        const entries = chartFreeLegEntries(Array.from(cache.entries()).slice(-LEG_VERDICTS_CAP), encFingerprint);
        const payload: PersistedLegVerdicts = { draftM, draftAssumed, encFingerprint, airDraftM, entries };
        localStorage.setItem(authScopedStorageKey(LEG_VERDICTS_KEY), JSON.stringify(payload));
    } catch {
        /* quota/private mode — worst case is the old behaviour (re-grade) */
    }
}

/** Null unless the persisted set was graded against the SAME keel, the SAME
 *  mast and the SAME chart library — a stale verdict is worse than a re-grade. */
export function hydrateLegVerdicts(
    draftM: number,
    draftAssumed: boolean,
    encFingerprint: string,
    airDraftM: number | null = null,
): Map<string, TraceLegVerdict> | null {
    try {
        const raw = localStorage.getItem(authScopedStorageKey(LEG_VERDICTS_KEY));
        if (!raw) return null;
        const p = JSON.parse(raw) as PersistedLegVerdicts;
        if (
            !p ||
            p.draftM !== draftM ||
            p.draftAssumed !== draftAssumed ||
            p.encFingerprint !== encFingerprint ||
            (p.airDraftM ?? null) !== airDraftM
        )
            return null;
        if (!Array.isArray(p.entries)) return null;
        return new Map(p.entries.filter(([k, v]) => typeof k === 'string' && v && typeof v.grade === 'string'));
    } catch {
        return null;
    }
}

// ── Trip-chain helpers (pure; names are paint, tripId/legOrdinal are glue) ──

/** "(2nd Leg)"-style badge — matched/stripped by the helpers below. */
const LEG_BADGE_RE = /\s*\((\d+)(?:st|nd|rd|th) Leg\)\s*$/i;

/** 1 → "1st Leg", 2 → "2nd Leg", 11 → "11th Leg", 23 → "23rd Leg". */
export function ordinalLegLabel(n: number): string {
    const tens = n % 100;
    const suffix =
        tens >= 11 && tens <= 13 ? 'th' : n % 10 === 1 ? 'st' : n % 10 === 2 ? 'nd' : n % 10 === 3 ? 'rd' : 'th';
    return `${n}${suffix} Leg`;
}

/** Remove a trailing "(Nth Leg)" badge (idempotent). */
export function stripLegBadge(name: string): string {
    return name.replace(LEG_BADGE_RE, '').trim();
}

/** Append the leg badge, replacing any existing one — re-saving a badged
 *  name never stacks "(2nd Leg) (2nd Leg)". */
export function withLegBadge(name: string, ordinal: number): string {
    return `${stripLegBadge(name)} (${ordinalLegLabel(ordinal)})`;
}

/** Ordinal parsed from the name badge — the cross-device fallback for routes
 *  whose structural fields were dropped by the cloud round-trip. */
export function legBadgeOrdinal(name: string): number | null {
    const m = LEG_BADGE_RE.exec(name);
    return m ? Number(m[1]) : null;
}

/** Last port in a directional route name (dash, arrow or "to"), badge
 *  stripped. Unspaced hyphens in localities such as Kippa-Ring survive. */
export function destNameFromRouteName(name: string): string | null {
    return routeNameParts(stripLegBadge(name))?.places.at(-1) ?? null;
}

/** Everything the tracer needs to open "plot the next leg of this trip":
 *  the chain identity, the next ordinal, the name prefill, and the LOCKED
 *  first pin (the previous leg's exact final coordinates — legs chain by
 *  position, not by name). */
export interface NextLegSeed {
    tripId: string;
    ordinal: number;
    fromName: string;
    anchor: TracePoint;
}

export function nextLegSeed(t: SavedTrace): NextLegSeed | null {
    if (!Array.isArray(t.points) || t.points.length < 2) return null;
    const last = t.points[t.points.length - 1];
    return {
        tripId: t.tripId ?? t.id,
        ordinal: (t.legOrdinal ?? legBadgeOrdinal(t.name) ?? 1) + 1,
        fromName: t.destName ?? destNameFromRouteName(t.name) ?? stripLegBadge(t.name),
        anchor: { lat: last.lat, lon: last.lon },
    };
}

/** One trip in the picker's eyes: its legs (ordinal-sorted) + a summary
 *  label. Standalone routes are a one-leg trip. */
export interface TripGroup {
    key: string;
    label: string;
    legs: SavedTrace[];
}

/** Trips touched this recently are kept newest first over the cap, checked or
 *  not: the same 30 days a route check stays green (traceFollowStatus). */
const SAVED_TRACE_CAP_RECENT_MS = 30 * 24 * 3_600_000;

function traceStamp(trace: SavedTrace): number {
    const stamp = Date.parse(trace.updatedAt ?? trace.createdAt);
    return Number.isFinite(stamp) ? stamp : 0;
}

/**
 * Retain a complete trip when enforcing the local route-library cap. The old
 * row-by-row slice could evict leg 1 while keeping leg 2, which is precisely
 * how a healthy trip became a stranded "2nd Leg" after a busy season.
 *
 * Over the cap (125-07), in this order, each pass newest first: the newest
 * trip (the write in hand) always stays; a trip holding a `protectedIds` route
 * (the one being followed) is never evicted; then trips holding a `pendingIds`
 * route (one the account has not acknowledged yet — the sync's offline saves,
 * the only copy there is); then every trip touched in the last 30 days, the
 * same window a check stays green, whatever its check state (a route built on
 * the desktop yesterday arrives here unchecked and must get its chance); and
 * only among OLDER trips do checked ones fill before unchecked ones. It used
 * to be purely oldest-first, which dropped a passage under way and its checks
 * with it (Shane's yellow legs, 2026-10-08). Output order is unchanged.
 */
export function capSavedTracesPreservingTrips(
    traces: readonly SavedTrace[],
    cap = 50,
    protectedIds: ReadonlySet<string> = new Set(),
    opts: { pendingIds?: ReadonlySet<string>; nowMs?: number } = {},
): SavedTrace[] {
    if (cap <= 0 || traces.length === 0) return [];

    const grouped = new Map<string, SavedTrace[]>();
    const encounterOrder: string[] = [];
    for (const trace of traces) {
        const key = trace.tripId ?? trace.id;
        const group = grouped.get(key);
        if (group) group.push(trace);
        else {
            grouped.set(key, [trace]);
            encounterOrder.push(key);
        }
    }

    const newestGroups = encounterOrder
        .map((key) => {
            const members = grouped.get(key)!;
            return { key, traces: members, stamp: Math.max(...members.map(traceStamp)) };
        })
        .sort((left, right) => right.stamp - left.stamp);

    // A trip is indivisible. A pathological >cap trip is still safer to
    // retain whole than to leave it structurally corrupt.
    type Group = (typeof newestGroups)[number];
    const keep = new Set<string>([newestGroups[0].key]);
    let count = newestGroups[0].traces.length;
    const nowMs = opts.nowMs ?? Date.now();
    const holds = (ids: ReadonlySet<string> | undefined) => (group: Group) =>
        !!ids && group.traces.some((t) => ids.has(t.id));
    const followed = holds(protectedIds);
    const pending = holds(opts.pendingIds);
    const recent = (group: Group) => nowMs - group.stamp <= SAVED_TRACE_CAP_RECENT_MS;
    const checked = (group: Group) => group.traces.some((t) => t.verification);
    for (const pass of [followed, pending, recent, checked, () => true]) {
        for (const group of newestGroups) {
            if (keep.has(group.key) || !pass(group)) continue;
            if (pass !== followed && count + group.traces.length > cap) continue;
            keep.add(group.key);
            count += group.traces.length;
        }
    }
    return newestGroups.filter((group) => keep.has(group.key)).flatMap((group) => group.traces);
}

/** stores/followRouteStore's persisted follow. Read here, not imported, so the
 *  route library never loads the follow store (and its weather router). */
const FOLLOW_ROUTE_KEY = 'thalassa_follow_route';

/** Ids of every leg of the trip being followed right now — exempt from the
 *  cap. A follow steers the trace's own pins (tracedRouteFollowGeometry), so
 *  the geometry finds it even when the follow carries a Cast Off voyage id. */
function followedTripIds(traces: readonly SavedTrace[], scope: AuthIdentityScope): Set<string> {
    try {
        const follow = JSON.parse(localStorage.getItem(authScopedStorageKey(FOLLOW_ROUTE_KEY, scope)) ?? 'null') as {
            isFollowing?: unknown;
            voyageId?: unknown;
            routeCoords?: unknown;
        } | null;
        if (follow?.isFollowing !== true) return new Set();
        const voyageId = typeof follow.voyageId === 'string' ? follow.voyageId.trim() : '';
        const coords = Array.isArray(follow.routeCoords) ? (follow.routeCoords as TracePoint[]) : [];
        const byId = (t: SavedTrace) =>
            !!voyageId && (t.id === voyageId || t.passageVoyageId === voyageId || t.plannedRouteId === voyageId);
        const key = traces.some(byId) ? '' : traceGeometryKey(coords);
        const hit = traces.find((t) => byId(t) || (!!key && traceGeometryKey(t.points) === key));
        if (!hit) return new Set();
        const trip = hit.tripId ?? hit.id;
        return new Set(traces.filter((t) => (t.tripId ?? t.id) === trip).map((t) => t.id));
    } catch {
        return new Set();
    }
}

function sameTraceContent(left: SavedTrace, right: SavedTrace): boolean {
    return (
        left.id === right.id &&
        left.name === right.name &&
        left.createdAt === right.createdAt &&
        left.updatedAt === right.updatedAt &&
        left.tripId === right.tripId &&
        left.legOrdinal === right.legOrdinal &&
        left.destName === right.destName &&
        left.plannedRouteId === right.plannedRouteId &&
        left.passageVoyageId === right.passageVoyageId &&
        JSON.stringify(left.verification ?? null) === JSON.stringify(right.verification ?? null) &&
        left.points.length === right.points.length &&
        left.points.every(
            (point, index) => point.lat === right.points[index]?.lat && point.lon === right.points[index]?.lon,
        )
    );
}

function sortTripLegs(legs: readonly SavedTrace[]): SavedTrace[] {
    return [...legs].sort((a, b) => {
        const ordinalA = a.legOrdinal ?? legBadgeOrdinal(a.name) ?? 1;
        const ordinalB = b.legOrdinal ?? legBadgeOrdinal(b.name) ?? 1;
        if (ordinalA !== ordinalB) return ordinalA - ordinalB;
        return traceStamp(a) - traceStamp(b);
    });
}

/**
 * Stamp one continuous run as either a standalone route or a properly rooted
 * chain. Geometry and exact Passage/Log links stay untouched; only the
 * structural metadata and generated leg badge change.
 */
function normaliseTripRun(legs: readonly SavedTrace[], updatedAt: string): SavedTrace[] {
    const ordered = sortTripLegs(legs);
    if (ordered.length === 0) return [];
    if (ordered.length === 1) {
        const only = ordered[0];
        return [
            {
                ...only,
                name: stripLegBadge(only.name),
                ...(only.destName ? { destName: only.destName } : {}),
                updatedAt,
                tripId: undefined,
                legOrdinal: undefined,
            },
        ];
    }
    const rootId = ordered[0].id;
    return ordered.map((leg, index) => {
        const ordinal = index + 1;
        return {
            ...leg,
            name: withLegBadge(leg.name, ordinal),
            tripId: rootId,
            legOrdinal: ordinal,
            destName: leg.destName ?? destNameFromRouteName(leg.name) ?? undefined,
            updatedAt,
        };
    });
}

/**
 * Recover a historical chain whose root row has already disappeared. Older
 * builds could delete leg 1 while leaving leg 2+ with the old tripId, and a
 * storage cap could create the same shape. Promote the lowest surviving leg
 * to the new root (or a standalone route when it is the sole survivor), so
 * Plan never has a stranded “2nd Leg”.
 *
 * The repair is pure. `loadSavedTraces()` uses it for immediate truthful UI;
 * sync persists and publishes the returned `changed` records cross-device.
 */
export function repairOrphanedSavedTraceChains(
    traces: readonly SavedTrace[],
    updatedAt?: string,
): SavedTraceDeleteRebase {
    const ids = new Set(traces.map((trace) => trace.id));
    const orphanedByTripId = new Map<string, SavedTrace[]>();
    for (const trace of traces) {
        if (!trace.tripId || ids.has(trace.tripId)) continue;
        const group = orphanedByTripId.get(trace.tripId) ?? [];
        group.push(trace);
        orphanedByTripId.set(trace.tripId, group);
    }
    if (orphanedByTripId.size === 0) return { traces: [...traces], changed: [] };

    const replacementById = new Map<string, SavedTrace>();
    for (const group of orphanedByTripId.values()) {
        // One deterministic tick past the newest known row makes a repair
        // win a newest-version merge without generating a fresh timestamp on
        // every read before the repaired copy has been persisted.
        const newestStamp = Math.max(...group.map(traceStamp));
        const repairStamp =
            updatedAt ?? (newestStamp > 0 ? new Date(newestStamp + 1).toISOString() : new Date().toISOString());
        for (const repaired of normaliseTripRun(group, repairStamp)) {
            replacementById.set(repaired.id, repaired);
        }
    }

    const repairedTraces = traces.map((trace) => replacementById.get(trace.id) ?? trace);
    const changed = repairedTraces.filter((trace) => {
        const previous = traces.find((candidate) => candidate.id === trace.id);
        return Boolean(previous && !sameTraceContent(previous, trace));
    });
    return { traces: repairedTraces, changed };
}

export interface SavedTraceDeleteRebase {
    traces: SavedTrace[];
    changed: SavedTrace[];
}

/**
 * Delete one leg without leaving a dangling trip root. When the first leg is
 * removed, its successor becomes leg 1. Removing a middle leg deliberately
 * splits the tail into a new trip: pretending two discontinuous sea paths
 * are still joined would make the locked starting pin lie.
 */
export function rebaseSavedTraceChainAfterDelete(
    traces: readonly SavedTrace[],
    removedId: string,
    updatedAt = new Date().toISOString(),
): SavedTraceDeleteRebase {
    const target = traces.find((trace) => trace.id === removedId);
    if (!target) return { traces: [...traces], changed: [] };

    const tripKey = target.tripId ?? target.id;
    const chain = sortTripLegs(
        traces.filter((trace) => trace.id === tripKey || trace.id === target.id || trace.tripId === tripKey),
    );
    const removedIndex = chain.findIndex((trace) => trace.id === removedId);
    if (removedIndex < 0) return { traces: traces.filter((trace) => trace.id !== removedId), changed: [] };

    const before = chain.slice(0, removedIndex);
    const after = chain.slice(removedIndex + 1);
    const replacementById = new Map<string, SavedTrace>();
    // Keeping the prefix and tail separate after a middle delete preserves
    // positional truth. First-leg deletion naturally has an empty prefix, so
    // every successor is promoted in one clean reindex.
    for (const replacement of [...normaliseTripRun(before, updatedAt), ...normaliseTripRun(after, updatedAt)]) {
        replacementById.set(replacement.id, replacement);
    }

    const next = traces
        .filter((trace) => trace.id !== removedId)
        .map((trace) => replacementById.get(trace.id) ?? trace);
    const changed = next.filter((trace) => {
        const previous = traces.find((candidate) => candidate.id === trace.id);
        return !!previous && !sameTraceContent(previous, trace);
    });
    return { traces: next, changed };
}

/** Group saved traces into trips (SHARED by the PLAN-page Trip box and the
 *  tracer card's "open a saved route" list, so the two can never drift —
 *  2026-07-17). Legs of one trip share tripId (= leg 1's id); order is
 *  preserved from the input so the caller controls newest-first, etc. */
export function groupTracesByTrip(traces: readonly SavedTrace[]): TripGroup[] {
    const groups = new Map<string, SavedTrace[]>();
    const order: string[] = [];
    for (const t of traces) {
        const key = t.tripId ?? t.id;
        const g = groups.get(key);
        if (g) g.push(t);
        else {
            groups.set(key, [t]);
            order.push(key);
        }
    }
    return order.map((key) => {
        const legs = sortTripLegs(groups.get(key)!);
        const first = legs[0];
        if (legs.length === 1) return { key, legs, label: stripLegBadge(first.name) };
        // A trip reads first origin – FINAL destination, the same rule as the
        // passage rollup. Leg 1's name is only the first hop (Shane 2026-09-08:
        // a Newport → Whitsundays passage was headed "Newport - Mackay").
        const last = legs[legs.length - 1];
        const origin = originNameFromRouteName(first.name) ?? stripLegBadge(first.name);
        const dest = last.destName ?? destNameFromRouteName(last.name) ?? stripLegBadge(last.name);
        return { key, legs, label: `${origin} - ${dest} (${legs.length} legs)` };
    });
}

/** First port in the shared directional naming convention, badge stripped. */
export function originNameFromRouteName(name: string): string | null {
    return routeNameParts(stripLegBadge(name))?.places[0] ?? null;
}

/** Standardised list label (Shane 2026-08-04): trip legs render as
 *  "<name> (Leg N)" derived from the STRUCTURAL ordinal — the stored
 *  "(2nd Leg)" badge stays in the name for cross-device compat, but it is
 *  paint; this is what every list shows. Standalone routes pass through. */
export function displayRouteLabel(t: Pick<SavedTrace, 'name' | 'tripId' | 'legOrdinal'>): string {
    const ordinal = t.tripId ? (t.legOrdinal ?? legBadgeOrdinal(t.name)) : null;
    if (!ordinal) return stripLegBadge(t.name);
    return `${stripLegBadge(t.name)} (Leg ${ordinal})`;
}

export const TRIP_PASSAGE_ID_PREFIX = 'trip-passage:';

/** One derived "(Passage)" rollup per multi-leg trip. */
export interface TripPassageRollup {
    /** `trip-passage:<tripId>` — the prefix marks it derived/read-only. */
    id: string;
    tripId: string;
    /** "<origin> - <final destination> (Passage)" */
    name: string;
    /** First leg's departure place name. */
    originName: string;
    /** Last leg's destination place name. */
    destName: string;
    /** All legs stitched, duplicated joint pins dropped. */
    points: TracePoint[];
    legCount: number;
    legIds: string[];
}

/**
 * Build the derived "(Passage)" rollup rows (Shane-approved design
 * 2026-08-04). DERIVED ON PURPOSE: a stored fourth copy would go stale the
 * day a leg is re-traced around weather — this is computed from the legs at
 * read time, never persisted, never synced, and not individually deletable
 * (delete the legs and it evaporates).
 */
export function buildTripPassageRollups(traces: readonly SavedTrace[]): TripPassageRollup[] {
    return groupTracesByTrip(traces)
        .filter((group) => group.legs.length >= 2)
        .map((group) => {
            const points: TracePoint[] = [];
            for (const leg of group.legs) {
                for (const p of leg.points) {
                    const prev = points[points.length - 1];
                    // Legs chain by position (healTripChain) — drop the
                    // duplicated joint pin where leg N+1 starts on leg N's end.
                    if (prev && Math.abs(prev.lat - p.lat) < 1e-7 && Math.abs(prev.lon - p.lon) < 1e-7) continue;
                    points.push({ lat: p.lat, lon: p.lon });
                }
            }
            const first = group.legs[0];
            const last = group.legs[group.legs.length - 1];
            const origin = originNameFromRouteName(first.name) ?? stripLegBadge(first.name);
            const dest = last.destName ?? destNameFromRouteName(last.name) ?? stripLegBadge(last.name);
            return {
                id: `${TRIP_PASSAGE_ID_PREFIX}${group.key}`,
                tripId: group.key,
                name: `${origin} - ${dest} (Passage)`,
                originName: origin,
                destName: dest,
                points,
                legCount: group.legs.length,
                legIds: group.legs.map((leg) => leg.id),
            };
        });
}

/**
 * Planned destination for leg N of the trip this voyage's saved route
 * belongs to. Pre-seeds Cast Off's "Arrive at Port" box and the next leg's
 * destination instead of leaving a blank field (Shane-approved design
 * 2026-08-04). Null when the route isn't a trip member or the leg is
 * beyond the plan.
 */
/**
 * Trip ordinal of the saved route itself — the anchor's own position in its
 * trip (structural field first, name badge as the cross-device fallback, 1
 * when the route is not a chained leg). Cast Off's first in-voyage leg must
 * seed from THIS, not a literal 1: a voyage whose route is trip leg 2 was
 * being handed leg 1's planned destination (Shane 2026-08-27: Cast Off
 * "always shows the newport - coral sea 1st leg"). A passage rollup's
 * saved_route_id is the tripId, which doubles as leg 1's trace id, so the
 * passage case still resolves to 1 here by construction.
 */
export function tripLegAnchorOrdinal(savedRouteId: string | null | undefined): number {
    if (!savedRouteId) return 1;
    const anchor = loadSavedTraces().find((t) => t.id === savedRouteId);
    if (!anchor) return 1;
    return anchor.legOrdinal ?? legBadgeOrdinal(anchor.name) ?? 1;
}

export function tripLegPlannedDestination(savedRouteId: string | null | undefined, legNumber: number): string | null {
    if (!savedRouteId || !Number.isFinite(legNumber) || legNumber < 1) return null;
    const traces = loadSavedTraces();
    const anchor = traces.find((t) => t.id === savedRouteId);
    if (!anchor) return null;
    const tripId = anchor.tripId ?? anchor.id;
    const legs = sortTripLegs(traces.filter((t) => (t.tripId ?? t.id) === tripId));
    const leg = legs.find((l, i) => (l.legOrdinal ?? legBadgeOrdinal(l.name) ?? i + 1) === legNumber);
    if (!leg) return null;
    return leg.destName ?? destNameFromRouteName(leg.name) ?? null;
}

/** Retro-badge (Shane's call, 2026-07-17): leg 1 earns its "(1st Leg)" badge
 *  the moment leg 2 is born — day-sail routes never carry trip baggage.
 *  Finds the trip's first leg (its id IS the tripId), stamps the structural
 *  fields and renames in place (same id → the cloud upsert updates the same
 *  row). Returns the renamed trace, or null when there was nothing to do. */
export function retroBadgeFirstLeg(tripId: string): SavedTrace | null {
    const first = loadSavedTraces().find((t) => t.id === tripId || (t.tripId === tripId && t.legOrdinal === 1));
    if (!first) return null;
    const alreadyBadged = LEG_BADGE_RE.test(first.name);
    const alreadyStamped = first.tripId === tripId && first.legOrdinal === 1;
    if (alreadyBadged && alreadyStamped) return null;
    const { trace } = saveTrace(withLegBadge(first.name, 1), first.points, {
        overwriteId: first.id,
        tripId,
        legOrdinal: 1,
        destName: first.destName ?? destNameFromRouteName(first.name) ?? undefined,
    });
    return trace;
}

/** AUTO-HEAL (Shane's call, 2026-07-17): edits to a leg's endpoint ripple
 *  into the NEXT leg's locked start, so the chain never gaps. Called after
 *  every save; walks successors transitively (leg 1's new endpoint moves
 *  leg 2's start; if that changed leg 2's endpoint too — it didn't, only
 *  point 0 moves — the walk stops). Returns a human line for the toast, or
 *  null when nothing needed healing. */
export function healTripChain(saved: SavedTrace): string | null {
    return healTripChainDetailed(saved)?.message ?? null;
}

/** healTripChain plus WHICH leg it moved — that leg's check is void now, so
 *  the caller queues it for a background re-check (build 124). */
export function healTripChainDetailed(saved: SavedTrace): { message: string; healedId: string } | null {
    const tripId = saved.tripId ?? undefined;
    if (!tripId) return null;
    const ordinal = saved.legOrdinal ?? legBadgeOrdinal(saved.name);
    if (!ordinal) return null;
    const next = loadSavedTraces().find((t) => t.tripId === tripId && t.legOrdinal === ordinal + 1);
    if (!next || next.points.length < 2) return null;
    const want = saved.points[saved.points.length - 1];
    const have = next.points[0];
    if (Math.abs(have.lat - want.lat) < 1e-7 && Math.abs(have.lon - want.lon) < 1e-7) return null;
    saveTrace(next.name, [{ lat: want.lat, lon: want.lon }, ...next.points.slice(1)], {
        overwriteId: next.id,
        tripId: next.tripId,
        legOrdinal: next.legOrdinal,
        destName: next.destName,
    });
    return { message: `"${next.name}" start moved to match`, healedId: next.id };
}

export function loadSavedTraces(scope: AuthIdentityScope = getAuthIdentityScope()): SavedTrace[] {
    try {
        // Deliberately do not read the former unscoped key. Its rows carry no
        // trustworthy owner, so adopting them into whichever account happens
        // to sign in next would turn an offline cache into a privacy leak.
        const raw = localStorage.getItem(tracesStorageKey(scope));
        if (!raw) return [];
        const read = JSON.parse(raw) as SavedTrace[];
        if (!Array.isArray(read)) return [];
        // 127-C-b: an older copy's chart facts are stripped as it is read and
        // the library is written back once (purge on contact).
        let stripped = false;
        const arr = read.map((trace) => {
            try {
                const kept = trace?.proposalEvidence && chartFreeEvidence(trace.proposalEvidence);
                if (!kept || kept === trace.proposalEvidence) return trace;
                stripped = true;
                return { ...trace, proposalEvidence: kept };
            } catch {
                return trace; // malformed evidence is refused below
            }
        });
        if (stripped) {
            try {
                writeSavedTraces(arr, scope);
            } catch {
                /* storage refused: the stripped copy is still what is shown */
            }
        }
        const tombstones = getSavedTraceTombstones(scope);
        const visible = arr
            .filter(
                (t) =>
                    t &&
                    typeof t.id === 'string' &&
                    !Object.prototype.hasOwnProperty.call(tombstones, t.id) &&
                    Array.isArray(t.points) &&
                    t.points.length >= 2,
            )
            .map((trace) => {
                const verification = normaliseTraceVerification(trace.verification, trace.points);
                const proposalEvidence = normaliseAutoroutingProposalEvidence(trace.proposalEvidence, trace.points);
                // Never present a corrupted/mismatched provider proposal as an
                // ordinary route by silently dropping its warning provenance.
                if (trace.proposalEvidence !== undefined && !proposalEvidence) return null;
                if (verification) return { ...trace, verification, ...(proposalEvidence ? { proposalEvidence } : {}) };
                const { verification: _invalid, ...safe } = trace;
                return { ...safe, ...(proposalEvidence ? { proposalEvidence } : {}) };
            })
            .filter((trace): trace is SavedTrace => trace !== null);
        return repairOrphanedSavedTraceChains(visible).traces;
    } catch {
        return [];
    }
}

/**
 * The one writer of the route library: capped (a followed trip exempt), and a
 * refused write never drops the library (125-07). Storage is required to keep
 * the old value when it refuses a new one; this checks that it did, and puts
 * the library back if it did not — it is the only copy of an offline save.
 * Throws on refusal so every caller reports it.
 */
function writeSavedTraces(
    traces: readonly SavedTrace[],
    scope: AuthIdentityScope,
    pendingIds?: ReadonlySet<string>,
): void {
    if (!isAuthIdentityScopeCurrent(scope)) return;
    const key = tracesStorageKey(scope);
    const payload = JSON.stringify(
        capSavedTracesPreservingTrips(traces, 50, followedTripIds(traces, scope), { pendingIds }),
    );
    const previous = localStorage.getItem(key);
    try {
        localStorage.setItem(key, payload);
    } catch (error) {
        try {
            if (previous !== null && localStorage.getItem(key) !== previous) localStorage.setItem(key, previous);
        } catch {
            /* nothing left to try; the caller still reports the refusal */
        }
        throw error;
    }
}

/** writeSavedTraces for callers outside this file (the account sync): false
 *  when storage refused, and the library is then exactly as it was.
 *  `pendingIds`: routes the account has not acknowledged yet (kept over the
 *  cap ahead of everything but the newest and followed trips). */
export function persistSavedTraceLibrary(
    traces: readonly SavedTrace[],
    scope: AuthIdentityScope,
    pendingIds?: ReadonlySet<string>,
): boolean {
    try {
        writeSavedTraces(traces, scope, pendingIds);
        return true;
    } catch {
        return false;
    }
}

/**
 * Adopt a saved route from the account onto THIS device, keeping its id.
 *
 * The route library lives in localStorage, so a route traced on one phone is
 * invisible on the next one — and after a reinstall, invisible on the same
 * one. Everything downstream keys off the saved-route id (follow links, the
 * verification envelope, the Cast Off gate), so the id must survive the hop.
 *
 * saveTrace's `overwriteId` cannot do this: it looks the id up in the LOCAL
 * store first, finds nothing in exactly this case, and mints a fresh id —
 * silently detaching the copy from the voyage that pointed at it.
 *
 * No verification is carried across. The envelope is a claim about a specific
 * boat's draft against a specific chart library, and neither of those is
 * necessarily true on the device now holding it. The route arrives unchecked
 * and the tracer's own gate decides — which is the honest outcome.
 */
export function adoptServerRoute(
    id: string,
    name: string,
    points: readonly TracePoint[],
    scope: AuthIdentityScope = getAuthIdentityScope(),
    extras: {
        tripId?: string;
        legOrdinal?: number;
        destName?: string;
        plannedRouteId?: string;
        passageVoyageId?: string;
        updatedAt?: string;
    } = {},
): SavedTrace | null {
    if (!id.trim() || points.length < 2) return null;
    const now = new Date().toISOString();
    const existing = loadSavedTraces(scope);
    const prior = existing.find((t) => t.id === id);
    // Trip chain + mirror ride along (2026-09-08): an adopted leg used to
    // arrive bare, so the second device's follow sheet listed a passage's
    // legs as unrelated day sails and its publish could not find the mirror.
    const tripId = extras.tripId ?? prior?.tripId;
    const legOrdinal = extras.legOrdinal ?? prior?.legOrdinal;
    const destName = extras.destName ?? prior?.destName;
    const plannedRouteId = extras.plannedRouteId ?? prior?.plannedRouteId;
    const passageVoyageId = extras.passageVoyageId ?? prior?.passageVoyageId;
    const trace: SavedTrace = {
        id,
        name: name.trim() || 'Saved route',
        createdAt: prior?.createdAt ?? now,
        updatedAt: extras.updatedAt ?? now,
        points: points.map((p) => ({ ...p })),
        ...(tripId ? { tripId } : {}),
        ...(legOrdinal ? { legOrdinal } : {}),
        ...(destName ? { destName } : {}),
        ...(plannedRouteId ? { plannedRouteId } : {}),
        ...(passageVoyageId ? { passageVoyageId } : {}),
    };
    const next = [trace, ...existing.filter((t) => t.id !== id)];
    try {
        writeSavedTraces(next, scope);
    } catch {
        return null;
    }
    notifySavedRoutesChanged(scope);
    return trace;
}

const PASSAGE_VOYAGE_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Bank a finished route check against a saved trace — the ONE safe write for
 * every check that lands outside the tracer's Save (build 124: the Log's ack
 * report, the tracer's auto-bank, the background re-check, server recovery).
 *
 *  - re-reads the store, so a check never lands on pins that moved while it
 *    ran (the envelope must still prove the CURRENT points);
 *  - never replaces a newer check with an older one;
 *  - says when storage refused it, rather than letting the row stay amber
 *    after a "successful" check on a full phone;
 *  - clears an older could-not-check record, and refreshes the passage
 *    mirror's durable copy WITHOUT timing, so the planned departure stands.
 *
 * The route's own updatedAt is kept, and its pins are never pushed: a bank is
 * not an edit. Going through saveTrace bumped updatedAt and upserted this
 * device's pins, so an automatic bank on a phone that had not synced since
 * another device moved (or deleted) the route won last-writer-wins and
 * reverted it. Since 125-07 the CHECK alone goes to saved_routes.verification
 * (once that column exists), and only onto the row revision this device
 * holds; syncSavedRoutes catches up anything that could not go then.
 * `syncColumn: false` is for a check that came FROM the column.
 */
export function bankTraceVerification(
    traceId: string,
    value: TraceVerification,
    scope: AuthIdentityScope = getAuthIdentityScope(),
    opts: { refreshMirror?: boolean; syncColumn?: boolean } = {},
): { banked: boolean; reason?: 'scope' | 'gone' | 'moved' | 'older' | 'storage' } {
    if (!isAuthIdentityScopeCurrent(scope)) return { banked: false, reason: 'scope' };
    const all = loadSavedTraces(scope);
    const current = all.find((trace) => trace.id === traceId);
    if (!current) return { banked: false, reason: 'gone' };
    const verification = normaliseTraceVerification(value, current.points);
    if (!verification) return { banked: false, reason: 'moved' };
    if (current.verification && Date.parse(current.verification.checkedAt) >= Date.parse(verification.checkedAt)) {
        return { banked: false, reason: 'older' };
    }
    let persisted = false;
    try {
        writeSavedTraces(
            all.map((trace) => (trace.id === traceId ? { ...trace, verification } : trace)),
            scope,
        );
        const stored = loadSavedTraces(scope).find((trace) => trace.id === traceId);
        persisted =
            normaliseTraceVerification(stored?.verification, stored?.points)?.checkedAt === verification.checkedAt;
    } catch {
        /* quota — persisted stays false */
    }
    if (!persisted) return { banked: false, reason: 'storage' };
    clearTraceCheckOutcome(traceId, scope, verification.checkedAt);
    notifySavedRoutesChanged(scope);
    const voyageId = current.passageVoyageId?.trim();
    if (opts.refreshMirror !== false && voyageId && PASSAGE_VOYAGE_UUID.test(voyageId)) {
        const note = serialiseTraceVerificationNote(verification);
        void import('./VoyageService')
            .then(({ refreshSavedRouteVoyageVerification }) =>
                refreshSavedRouteVoyageVerification(voyageId, traceId, note),
            )
            .then((result) => {
                if (result?.error) log.warn(`check banked; passage mirror not refreshed (${result.error})`);
            })
            .catch((error) => log.warn('check banked; passage mirror refresh failed:', error));
    }
    const revision = current.updatedAt;
    if (opts.syncColumn !== false && scope.userId && revision) {
        void import('./savedRoutesSync')
            .then(({ pushSavedRouteVerification }) =>
                pushSavedRouteVerification(traceId, verification, revision, scope),
            )
            .catch((error) => log.warn('check banked; account copy not updated:', error));
    }
    return { banked: true };
}

/** persisted=false means storage refused (quota) — tell the skipper, don't
 *  flash "Saved ✓" over a trace that won't exist next session. `cloud`
 *  resolves with the account-push outcome so the UI can be equally honest
 *  about the desktop→phone hop ('signedout' = never left this browser). */
export function saveTrace(
    name: string,
    points: readonly TracePoint[],
    opts: {
        overwriteId?: string;
        tripId?: string;
        legOrdinal?: number;
        destName?: string;
        plannedRouteId?: string;
        passageVoyageId?: string;
        verification?: TraceVerification;
        proposalEvidence?: SavedAutoroutingProposalEvidence;
    } = {},
): { trace: SavedTrace; persisted: boolean; cloud: Promise<import('./savedRoutesSync').PushResult> } {
    const identity = getAuthIdentityScope();
    // Overwrite KEEPS the id: the local replace and the cloud upsert (also
    // keyed on id) then update the SAME route instead of minting a twin
    // (Shane 2026-07-15: "if I save it as the same name, it overwrites").
    const existing = opts.overwriteId ? loadSavedTraces(identity).find((t) => t.id === opts.overwriteId) : undefined;
    // Trip-chain fields: opts win, then the existing copy's — a plain
    // re-save of a chained leg must never shed its trip membership.
    const tripId = opts.tripId ?? existing?.tripId;
    const legOrdinal = opts.legOrdinal ?? existing?.legOrdinal;
    const destName = opts.destName ?? existing?.destName;
    const plannedRouteId = opts.plannedRouteId ?? existing?.plannedRouteId;
    const passageVoyageId = opts.passageVoyageId ?? existing?.passageVoyageId;
    // Preserve a prior check only while it still proves the exact geometry.
    // A moved waypoint silently drops it; MapHub supplies the freshly-earned
    // envelope after the replacement line has finished grading.
    const verification = normaliseTraceVerification(opts.verification ?? existing?.verification, points);
    const normalised = normaliseAutoroutingProposalEvidence(
        opts.proposalEvidence ?? existing?.proposalEvidence,
        points,
    );
    if (opts.proposalEvidence !== undefined && !normalised)
        throw new Error('Proposal evidence is incomplete or does not match these waypoints. Nothing was saved.');
    const proposalEvidence = normalised && chartFreeEvidence(normalised);
    const trace: SavedTrace = {
        // Random suffix: two saves in the same millisecond used to mint the
        // SAME id, and the by-id dedupe silently swallowed the first route
        // (surfaced by the trip-chain tests saving leg 1 + leg 2 back-to-back).
        id: existing?.id ?? `trace-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
        name: name.trim() || `Trace ${new Date().toLocaleDateString('en-AU')}`,
        createdAt: existing?.createdAt ?? new Date().toISOString(),
        ...(existing ? { updatedAt: new Date().toISOString() } : {}),
        points: points.map((p) => ({ lat: p.lat, lon: p.lon })),
        ...(tripId ? { tripId } : {}),
        ...(legOrdinal ? { legOrdinal } : {}),
        ...(destName ? { destName } : {}),
        ...(plannedRouteId ? { plannedRouteId } : {}),
        ...(passageVoyageId ? { passageVoyageId } : {}),
        ...(verification ? { verification } : {}),
        ...(proposalEvidence ? { proposalEvidence } : {}),
    };
    // writeSavedTraces applies the cap (with the followed-trip exemption).
    const all = [trace, ...loadSavedTraces(identity).filter((t) => t.id !== trace.id)];
    let persisted = false;
    try {
        writeSavedTraces(all, identity);
        // A deliberate save with the same id is the only operation allowed to
        // revive a local tombstone. Clear it only AFTER the new payload is
        // durable; a failed write must leave the safer delete fence intact.
        clearSavedTraceTombstone(trace.id, identity);
        // Same-id overwrite: the OLD copy would satisfy a bare id check even
        // after quota refused the write — match the freshness stamp too.
        persisted = loadSavedTraces(identity).some(
            (t) => t.id === trace.id && (t.updatedAt ?? t.createdAt) === (trace.updatedAt ?? trace.createdAt),
        );
    } catch {
        /* quota — persisted stays false */
    }
    // Account sync (Phase 5.3): best-effort push so the route follows the
    // punter across devices — build on the desktop, sail on the phone.
    // ONLY when the local write stuck: repair paths mint a fresh random id
    // per attempt, so a quota-refused local write that still uploaded minted
    // a duplicate cloud row per retry (2026-08-04 audit).
    const cloudSnapshot: SavedTrace = JSON.parse(JSON.stringify(trace));
    const cloud = persisted
        ? import('./savedRoutesSync')
              .then(({ pushSavedRoute }) => pushSavedRoute(cloudSnapshot, identity))
              .catch(() => 'error' as const)
        : Promise.resolve('error' as const);
    if (persisted) notifySavedRoutesChanged(identity);
    return { trace, persisted, cloud };
}

/** A new planned itinerary is indivisible on this device: validate all rows,
 * write once, then publish once and start best-effort account sync. Existing
 * rows are retained verbatim; capacity refusal never evicts an older trip. */
export function saveTraceTrip(
    inputs: readonly {
        name: string;
        points: readonly TracePoint[];
        destName?: string;
        proposalEvidence: SavedAutoroutingProposalEvidence;
    }[],
    expectedScope: AuthIdentityScope,
): { traces: SavedTrace[]; persisted: boolean; cloud: Promise<import('./savedRoutesSync').PushResult[]> } {
    const assertScope = () => {
        if (!expectedScope.userId || !isAuthIdentityScopeCurrent(expectedScope))
            throw new Error('Your account changed. Nothing was saved.');
    };
    assertScope();
    if (!Array.isArray(inputs as unknown) || inputs.length < 1 || inputs.length > 2)
        throw new Error('A day itinerary must contain one or two complete routes.');
    const createdAt = new Date().toISOString();
    const batchId = `trace-${crypto.randomUUID()}`;
    const traces: SavedTrace[] = inputs.map((input, index) => {
        const name = input.name.trim();
        if (!name || name.length > 120) throw new Error('Enter route names between 1 and 120 characters.');
        const points = input.points.map(({ lat, lon }) => ({ lat, lon }));
        const normalised = normaliseAutoroutingProposalEvidence(input.proposalEvidence, points);
        if (!normalised)
            throw new Error('Proposal evidence is incomplete or does not match these waypoints. Nothing was saved.');
        const proposalEvidence = chartFreeEvidence(normalised);
        const destName = input.destName?.trim();
        if (destName !== undefined && (!destName || destName.length > 120))
            throw new Error('The route destination label is invalid. Nothing was saved.');
        return {
            id: index === 0 ? batchId : `${batchId}-${index + 1}`,
            name,
            points,
            createdAt,
            ...(inputs.length > 1 ? { tripId: batchId, legOrdinal: index + 1 } : {}),
            ...(destName ? { destName } : {}),
            proposalEvidence,
        };
    });
    const key = tracesStorageKey(expectedScope);
    // Do not turn an unreadable library into an empty library and overwrite it.
    const previous = localStorage.getItem(key);
    let stored: unknown;
    try {
        stored = previous === null ? [] : JSON.parse(previous);
    } catch {
        throw new Error('Saved Routes could not be read. Nothing was saved.');
    }
    if (!Array.isArray(stored)) throw new Error('Saved Routes could not be read. Nothing was saved.');
    if (stored.length + traces.length > 50)
        throw new Error('Saved Routes is full. Free space before saving the complete itinerary.');
    const tombstones = getSavedTraceTombstones(expectedScope);
    if (traces.some((trace) => stored.some((row) => row?.id === trace.id) || tombstones[trace.id]))
        throw new Error('A route identity conflicted. Retry saving the itinerary.');
    const payload = JSON.stringify([...traces, ...stored]);
    const cloudSnapshots: SavedTrace[] = JSON.parse(JSON.stringify(traces));
    assertScope();
    let persisted = false;
    try {
        localStorage.setItem(key, payload);
        persisted = localStorage.getItem(key) === payload;
    } catch {
        /* Quota refusal is atomic in localStorage; no row is pushed remotely. */
    }
    assertScope();
    const cloud = persisted
        ? import('./savedRoutesSync')
              .then(({ pushSavedRoute }) =>
                  Promise.all(
                      cloudSnapshots.map((trace) =>
                          isAuthIdentityScopeCurrent(expectedScope)
                              ? pushSavedRoute(trace, expectedScope).catch(() => 'error' as const)
                              : Promise.resolve('stale' as const),
                      ),
                  ),
              )
              .catch(() => cloudSnapshots.map(() => 'error' as const))
        : Promise.resolve(cloudSnapshots.map(() => 'error' as const));
    if (persisted) notifySavedRoutesChanged(expectedScope);
    return { traces, persisted, cloud };
}

/**
 * Attach the exact records created by PassagePlanSave to an already-persisted
 * trace. It is intentionally a separate mutation: tracer geometry saves
 * first (offline-first), then the compatibility mirror returns its ids later.
 */
export function linkTraceToPassage(
    id: string,
    links: TracePassageLinks,
    expectedScope: AuthIdentityScope = getAuthIdentityScope(),
): SavedTrace | null {
    const traceId = id.trim();
    if (!traceId || !isAuthIdentityScopeCurrent(expectedScope)) return null;
    const tombstones = getSavedTraceTombstones(expectedScope);
    if (Object.prototype.hasOwnProperty.call(tombstones, traceId)) return null;
    const traces = loadSavedTraces(expectedScope);
    const previous = traces.find((trace) => trace.id === traceId);
    if (!previous) return null;
    const linked: SavedTrace = {
        ...previous,
        ...(links.plannedRouteId ? { plannedRouteId: links.plannedRouteId } : {}),
        ...(links.passageVoyageId ? { passageVoyageId: links.passageVoyageId } : {}),
        updatedAt: new Date().toISOString(),
    };
    try {
        writeSavedTraces(
            traces.map((trace) => (trace.id === traceId ? linked : trace)),
            expectedScope,
        );
    } catch {
        return null;
    }
    void import('./savedRoutesSync')
        .then(({ pushSavedRoute }) => pushSavedRoute(linked, expectedScope))
        .catch(() => {});
    notifySavedRoutesChanged(expectedScope);
    return linked;
}

/**
 * Remove one saved trace locally, then tombstone it for the signed-in account.
 *
 * Callers that started an async operation should pass their captured scope so
 * an account switch cannot turn a late delete into a mutation of the next
 * skipper's route library.
 */
export function deleteTrace(id: string, expectedScope: AuthIdentityScope = getAuthIdentityScope()): boolean {
    const traceId = id.trim();
    const identity = expectedScope;
    if (!traceId || !isAuthIdentityScopeCurrent(identity)) return false;
    const current = loadSavedTraces(identity);
    const target = current.find((trace) => trace.id === traceId);
    if (!target) return false;
    const deletedAt = new Date().toISOString();
    const rebased = rebaseSavedTraceChainAfterDelete(current, traceId, deletedAt);
    try {
        // Fence first: sync may be running on another task, and must never
        // win a race by writing the soon-to-be-deleted remote row back here.
        const tombstones = getSavedTraceTombstones(identity);
        tombstones[traceId] = {
            deletedAt,
            ...(target.plannedRouteId ? { plannedRouteId: target.plannedRouteId } : {}),
            ...(target.passageVoyageId ? { passageVoyageId: target.passageVoyageId } : {}),
        };
        writeSavedTraceTombstones(tombstones, identity);
        writeSavedTraces(rebased.traces, identity);
    } catch {
        return false;
    }
    notifySavedRoutesChanged(identity);
    // Tombstone the deleted row and immediately publish every promoted leg;
    // one remote pull therefore observes a complete, contiguous chain.
    void import('./savedRoutesSync')
        .then(({ pushSavedRoute, pushSavedRouteDelete }) => {
            for (const trace of rebased.changed) void pushSavedRoute(trace, identity);
            return pushSavedRouteDelete(traceId, identity, deletedAt);
        })
        .catch(() => {});
    // The chart trace, its planned Log mirror, and its Passage Planning row
    // are a graph. The graph cleanup is deliberately async so the UI can
    // remove the route instantly, but it uses immutable ids rather than a
    // label/date heuristic and is retried after a late mirror save.
    void import('./savedRouteGraph')
        .then(({ deleteSavedRoutePassageGraph }) =>
            deleteSavedRoutePassageGraph(
                traceId,
                {
                    plannedRouteId: target.plannedRouteId,
                    passageVoyageId: target.passageVoyageId,
                },
                identity,
            ),
        )
        .catch(() => {});
    return true;
}

/**
 * The curated-fairway flywheel: a skipper's validated trace, exported as a
 * paste-ready CuratedFairway snippet (services/curatedFairways.ts shape) —
 * exactly how Shane's 29 tapped Mooloolaba coords became the shipped lane.
 */
export function traceAsCuratedFairwaySnippet(name: string, points: readonly TracePoint[]): string {
    const [w, s, e, n] = traceBbox(points, 0.005);
    const id = (name.trim() || 'traced-fairway')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '');
    return JSON.stringify(
        {
            id,
            bbox: [Number(w.toFixed(4)), Number(s.toFixed(4)), Number(e.toFixed(4)), Number(n.toFixed(4))],
            line: points.map((p) => [Number(p.lon.toFixed(5)), Number(p.lat.toFixed(5))]),
        },
        null,
        4,
    );
}

/** Escape the five XML metacharacters for GPX text nodes. */
function escapeGpxXml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
}

/**
 * Serialise a trace to GPX 1.1 as a single <rte> of <rtept>s (Shane
 * 2026-07-17: "export it as a gpx file for importing into a chartplotter").
 * A route (not a track) is what OpenCPN / Garmin / B&G import as a plan you
 * can activate and steer. Each pin becomes a named waypoint (WP-01…) at 6-dp
 * precision. `nowIso` is passed in because the tracer runs where the
 * clock-free Date guard doesn't apply, but callers keep it injectable/testable.
 */
export function traceToGpx(
    name: string,
    points: readonly TracePoint[],
    nowIso: string = new Date().toISOString(),
    verification?: TraceVerification,
): string {
    const routeName = name.trim() || 'Thalassa route';
    const verified = normaliseTraceVerification(verification, points);
    const safetyDescription = verified
        ? traceVerificationSummary(verified)
        : 'UNVERIFIED ROUTE - CHECK AGAINST CURRENT OFFICIAL CHARTS BEFORE USE';
    const rtepts = points
        .map(
            (p, i) =>
                `    <rtept lat="${p.lat.toFixed(6)}" lon="${p.lon.toFixed(6)}">\n` +
                `      <name>WP-${String(i + 1).padStart(2, '0')}</name>\n` +
                `    </rtept>`,
        )
        .join('\n');
    return (
        `<?xml version="1.0" encoding="UTF-8"?>\n` +
        `<gpx version="1.1" creator="Thalassa Marine" xmlns="http://www.topografix.com/GPX/1/1" ` +
        `xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ` +
        `xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">\n` +
        `  <metadata>\n    <name>${escapeGpxXml(routeName)}</name>\n    <time>${nowIso}</time>\n  </metadata>\n` +
        `  <rte>\n    <name>${escapeGpxXml(routeName)}</name>\n` +
        `    <desc>${escapeGpxXml(safetyDescription)}</desc>\n${rtepts}\n  </rte>\n` +
        `</gpx>\n`
    );
}

/** Filesystem-safe .gpx filename from a route name. */
export function traceGpxFileName(name: string): string {
    const base =
        name
            .trim()
            .replace(/[^a-z0-9]+/gi, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 60) || 'thalassa-route';
    return `${base}.gpx`;
}

/** Minimal VoyagePlan so a trace can be followed like any planned passage. */
export function traceAsVoyagePlan(
    name: string,
    points: readonly TracePoint[],
    /** Per-leg grades (length = points-1) — carried on routeGeoJSON.properties
     *  so follow mode renders the validated colours, not a plain blue line. */
    legGrades?: readonly TraceGrade[],
    verification?: TraceVerification,
): VoyagePlan {
    let nm = 0;
    for (let i = 1; i < points.length; i++) nm += distM(points[i - 1], points[i]) / 1852;
    const hours = Math.max(0.25, nm / 5.5); // conservative 5.5 kn passage speed
    const verified = normaliseTraceVerification(verification, points);
    const geo: Feature<LineString> = {
        type: 'Feature',
        properties: {
            _source: 'route-tracer',
            ...(legGrades && legGrades.length === points.length - 1 ? { legGrades: [...legGrades] } : {}),
            ...(verified ? { traceVerification: verified } : {}),
        },
        geometry: { type: 'LineString', coordinates: points.map((p) => [p.lon, p.lat]) },
    };
    // Unnamed traces get a time-stamped label — the logbook duplicate check
    // keys on label + calendar day, so two unnamed traces on the same day
    // used to collide (the second silently lost its logbook entry).
    const stamp = new Date().toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });
    const label = name.trim() || `Traced route ${stamp} (${points.length} pins)`;
    // ROOT of the doubled-port bug (Shane 2026-08-04: "newport 2nd leg -
    // newport 2nd leg??????"): both endpoints used to be synthesised from the
    // whole route name as "<name> — start/— end", which then flowed into the
    // voyage's departure_port AND destination_port. Tracer names follow the
    // "from - to" convention, so use the real halves when they exist; only
    // unconventional names (loops, custom titles) keep the generated markers,
    // which downstream collapse helpers already know how to fold.
    const originHalf = originNameFromRouteName(label);
    const destHalf = destNameFromRouteName(label);
    return {
        origin: originHalf ?? `${label} — start`,
        destination: destHalf ?? `${label} — end`,
        departureDate: new Date(verified?.departureMs ?? Date.now()).toISOString(),
        originCoordinates: { lat: points[0].lat, lon: points[0].lon },
        destinationCoordinates: { lat: points[points.length - 1].lat, lon: points[points.length - 1].lon },
        distanceApprox: `${nm.toFixed(1)} NM`,
        // Fractional hours — every existing parser handles "0.5 hours";
        // "NN minutes" parsed to NULL and defaulted to a 12-hour spread.
        durationApprox: `${hours.toFixed(1)} hours`,
        overview: verified
            ? `Hand-traced route (${points.length} pins). ${traceVerificationSummary(verified)}.`
            : `Hand-traced route (${points.length} pins); Route Tracer verification was not recorded.`,
        // Interior pins only — origin/destinationCoordinates already carry the
        // endpoints; duplicating them made 32 log rows for 30 pins with two
        // zero-length legs.
        waypoints: points
            .slice(1, -1)
            .map((p, i) => ({ name: `Pin ${i + 2}`, coordinates: { lat: p.lat, lon: p.lon } })),
        routeGeoJSON: geo,
    };
}

// ── Guided Builder core (masterplan Phase 2) ───────────────────────────────

/**
 * Ramer–Douglas–Peucker on trace points (perpendicular tolerance in metres).
 * The "⚡ Auto to destination" chip runs the four-tier router and drops its
 * polyline back as PINS — a 60-vertex engine line would be marker soup, so
 * it decimates to the bends first. Also the track→trace path (Phase 4).
 */
export function rdpTracePoints(points: readonly TracePoint[], epsilonM: number): TracePoint[] {
    if (points.length <= 2) return [...points];
    const keep = new Uint8Array(points.length);
    keep[0] = 1;
    keep[points.length - 1] = 1;
    const stack: Array<[number, number]> = [[0, points.length - 1]];
    while (stack.length > 0) {
        const [s, e] = stack.pop()!;
        let maxD = 0;
        let maxI = -1;
        for (let i = s + 1; i < e; i++) {
            const d = closestOnLeg(points[i], points[s], points[e]).distM;
            if (d > maxD) {
                maxD = d;
                maxI = i;
            }
        }
        if (maxD > epsilonM && maxI > 0) {
            keep[maxI] = 1;
            stack.push([s, maxI], [maxI, e]);
        }
    }
    return points.filter((_, i) => keep[i] === 1);
}

/**
 * Insert straight intermediate points so NO segment of `points` exceeds
 * `maxM` metres. The engine behind ⚡ Auto route (Shane 2026-07-15: "the
 * autoroute should drop the pins for us — that is the job of autoroute"):
 * fixLegOnGrid is a short-leg tool (its A* corridor caps at 600k cells), so
 * a long leg can't be routed in one shot. Capping the span first turns it
 * into a chain of routable, depth-checkable sub-legs; it's also the cleanup
 * pass that re-subdivides any long straight run RDP left behind, so the
 * "too much water to check" banner can't come back. Endpoints are preserved
 * exactly; a leg already under maxM passes through untouched.
 */
export function capSegmentLength(points: readonly TracePoint[], maxM: number): TracePoint[] {
    if (points.length < 2 || !(maxM > 0)) return [...points];
    const out: TracePoint[] = [points[0]];
    for (let i = 1; i < points.length; i++) {
        const p = points[i - 1];
        const q = points[i];
        const d = distM(p, q);
        if (d > maxM) {
            const n = Math.ceil(d / maxM);
            for (let k = 1; k < n; k++) {
                const t = k / n;
                out.push({ lat: p.lat + (q.lat - p.lat) * t, lon: p.lon + (q.lon - p.lon) * t });
            }
        }
        out.push(q);
    }
    return out;
}

/** True bearing a→b in degrees [0, 360). */
export function bearingDegBetween(a: TracePoint, b: TracePoint): number {
    const brg = (Math.atan2((b.lon - a.lon) * mPerLon(a.lat), (b.lat - a.lat) * M_PER_DEG_LAT) * 180) / Math.PI;
    return (brg + 360) % 360;
}

/** Octant arrow for a course chip — "↘ head 168°". */
export function courseArrow(deg: number): string {
    const arrows = ['↑', '↗', '→', '↘', '↓', '↙', '←', '↖'] as const;
    return arrows[Math.round((((deg % 360) + 360) % 360) / 45) % 8];
}

/** A proven (curated) lane near the punter, offered as a tap-to-accept ghost. */
export interface GhostLane {
    id: string;
    points: TracePoint[];
}

/** Curated fairway lanes whose bbox overlaps the given area — rendered as a
 *  dotted ghost while tracing; accepting one splices its points as pins. */
export function curatedLanesNear(bbox: [number, number, number, number]): GhostLane[] {
    return curatedFairwayCanalFeatures(bbox)
        .filter((f) => f.geometry.type === 'LineString')
        .map((f) => ({
            id: String((f.properties as Record<string, unknown> | null)?._id ?? 'lane'),
            points: (f.geometry as LineString).coordinates.map(([lon, lat]) => ({ lat, lon })),
        }));
}

// ── Fix-this-leg (masterplan Phase 3.2) ────────────────────────────────────

/** A*-cell traversal cost. Mirrors the engine's pricing philosophy: clear
 *  water 1×, thin water 4×, sub-keel caution 40× (passable — the skipper may
 *  accept a tide gate — but strongly avoided), uncharted 6×. */
function cellCost(grid: NavGrid, idx: number, keelM: number): number | null {
    const v = grid.cells[idx];
    if (Number.isNaN(v)) return null; // blocked
    if (v === CAUTION) return 40;
    if (v === UNKNOWN_OPEN) return 6;
    if (v >= keelM + THIN_MARGIN_M) return 1;
    if (v >= keelM) return 4;
    return 40;
}

/**
 * One-tap "Fix this leg": A* between the leg's two pins on the ALREADY-BUILT
 * tracer grid, searched inside a corridor around the leg (bounded work — the
 * grid can be 2M cells but a fix is local). Returns the detour as sparse
 * pins (RDP 20 m) INCLUDING both endpoints, or null when no clean path
 * exists — the modal then offers Acknowledge instead. Never fabricates.
 */
export function fixLegOnGrid(ctx: TracerContext, a: TracePoint, b: TracePoint): TracePoint[] | null {
    const grid = ctx.grid;
    if (!grid) return null;
    const keelM = ctx.draftM + DEFAULT_TIDE_SAFETY_M;
    const legM = distM(a, b);
    // Corridor: the leg's bbox padded by max(400 m, half the leg) each side.
    const padM = Math.max(400, legM * 0.5);
    const padLat = padM / M_PER_DEG_LAT;
    const padLon = padM / mPerLon(a.lat);
    const minX = Math.max(0, Math.floor((Math.min(a.lon, b.lon) - padLon - grid.minLon) / grid.dLon));
    const maxX = Math.min(grid.width - 1, Math.floor((Math.max(a.lon, b.lon) + padLon - grid.minLon) / grid.dLon));
    const minY = Math.max(0, Math.floor((Math.min(a.lat, b.lat) - padLat - grid.minLat) / grid.dLat));
    const maxY = Math.min(grid.height - 1, Math.floor((Math.max(a.lat, b.lat) + padLat - grid.minLat) / grid.dLat));
    const W = maxX - minX + 1;
    const H = maxY - minY + 1;
    if (W <= 0 || H <= 0 || W * H > 600_000) return null; // corridor too big — don't freeze the UI

    const toLocal = (p: TracePoint): { x: number; y: number } | null => {
        const x = Math.floor((p.lon - grid.minLon) / grid.dLon) - minX;
        const y = Math.floor((p.lat - grid.minLat) / grid.dLat) - minY;
        return x >= 0 && y >= 0 && x < W && y < H ? { x, y } : null;
    };
    // Snap a blocked endpoint to its nearest navigable neighbour (a pin ON
    // the flagged shallow is common — the fix must still be findable).
    const snapLocal = (p: TracePoint): { x: number; y: number } | null => {
        const l = toLocal(p);
        if (!l) return null;
        if (cellCost(grid, (l.y + minY) * grid.width + (l.x + minX), keelM) !== null) return l;
        for (let r = 1; r <= 4; r++) {
            for (let dy = -r; dy <= r; dy++) {
                for (let dx = -r; dx <= r; dx++) {
                    const x = l.x + dx;
                    const y = l.y + dy;
                    if (x < 0 || y < 0 || x >= W || y >= H) continue;
                    if (cellCost(grid, (y + minY) * grid.width + (x + minX), keelM) !== null) return { x, y };
                }
            }
        }
        return null;
    };
    const start = snapLocal(a);
    const goal = snapLocal(b);
    if (!start || !goal) return null;

    const gScore = new Float64Array(W * H).fill(Infinity);
    const cameFrom = new Int32Array(W * H).fill(-1);
    const startIdx = start.y * W + start.x;
    const goalIdx = goal.y * W + goal.x;
    gScore[startIdx] = 0;
    // Binary heap of [f, idx].
    const heap: Array<[number, number]> = [[0, startIdx]];
    const pop = (): [number, number] | undefined => {
        if (heap.length === 0) return undefined;
        const top = heap[0];
        const last = heap.pop()!;
        if (heap.length > 0) {
            heap[0] = last;
            let i = 0;
            for (;;) {
                const l = 2 * i + 1;
                const r = l + 1;
                let m = i;
                if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
                if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
                if (m === i) break;
                [heap[i], heap[m]] = [heap[m], heap[i]];
                i = m;
            }
        }
        return top;
    };
    const push = (f: number, idx: number): void => {
        heap.push([f, idx]);
        let i = heap.length - 1;
        while (i > 0) {
            const p = (i - 1) >> 1;
            if (heap[p][0] <= heap[i][0]) break;
            [heap[i], heap[p]] = [heap[p], heap[i]];
            i = p;
        }
    };
    const h = (idx: number): number => {
        const x = idx % W;
        const y = (idx / W) | 0;
        return Math.hypot(x - goal.x, y - goal.y);
    };
    const DIRS = [
        [1, 0, 1],
        [-1, 0, 1],
        [0, 1, 1],
        [0, -1, 1],
        [1, 1, Math.SQRT2],
        [1, -1, Math.SQRT2],
        [-1, 1, Math.SQRT2],
        [-1, -1, Math.SQRT2],
    ] as const;
    let found = false;
    let expansions = 0;
    while (heap.length > 0 && expansions < 400_000) {
        const cur = pop()!;
        const idx = cur[1];
        if (idx === goalIdx) {
            found = true;
            break;
        }
        if (cur[0] > gScore[idx] + h(idx) + 1e-9) continue; // stale heap entry
        expansions++;
        const x = idx % W;
        const y = (idx / W) | 0;
        for (const [dx, dy, mul] of DIRS) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const nIdx = ny * W + nx;
            const cost = cellCost(grid, (ny + minY) * grid.width + (nx + minX), keelM);
            if (cost === null) continue;
            const g = gScore[idx] + cost * mul;
            if (g < gScore[nIdx]) {
                gScore[nIdx] = g;
                cameFrom[nIdx] = idx;
                push(g + h(nIdx), nIdx);
            }
        }
    }
    if (!found) return null;

    // Reconstruct → lat/lon → decimate to editable pins.
    const cells: TracePoint[] = [];
    for (let idx = goalIdx; idx !== -1; idx = cameFrom[idx]) {
        const x = (idx % W) + minX;
        const y = ((idx / W) | 0) + minY;
        cells.push({ lat: grid.minLat + (y + 0.5) * grid.dLat, lon: grid.minLon + (x + 0.5) * grid.dLon });
        if (idx === startIdx) break;
    }
    cells.reverse();
    const path = [a, ...cells.slice(1, -1), b];
    const pins = rdpTracePoints(path, Math.max(15, ctx.resM * 1.5));
    // The grid carries the low-clearance bars, but the pins are a decimated
    // line: never hand back a detour whose straightened legs pass under one.
    if (
        ctx.clearanceBars?.length &&
        polylineCrossesClearanceBar(
            pins.map((p) => [p.lon, p.lat] as [number, number]),
            ctx.clearanceBars,
        )
    )
        return null;
    return pins;
}

// ── THE departure window (masterplan Phase 3.4) ────────────────────────────

function intersectWindows(
    xs: Array<{ o: number; c: number }>,
    ys: Array<{ o: number; c: number }>,
): Array<{ o: number; c: number }> {
    const out: Array<{ o: number; c: number }> = [];
    for (const x of xs) {
        for (const y of ys) {
            const o = Math.max(x.o, y.o);
            const c = Math.min(x.c, y.c);
            if (c > o) out.push({ o, c });
        }
    }
    return out.sort((p, q) => p.o - q.o);
}

/**
 * The report-modal headline: intersect every tide-gated leg's windows into
 * ONE departure call — "leave 09:10–13:30 today and every tide gate clears".
 * Returns null when no leg needs tide (nothing to say) or tide data is
 * unavailable (never guess).
 *
 * `opts.departureMs` anchors the 24 h search at the chosen departure (Shane
 * 2026-07-16), default now. `opts.etaOffsetsMs[i]` is leg i's transit time
 * from departure: each gate's water windows are computed AT ITS ARRIVAL span
 * and shifted BACK by the transit time before intersecting — so the label is
 * a true DEPARTURE window ("leave inside this span and every gate has water
 * when you actually reach it"). Without offsets, v1's same-clock check.
 */
export async function commonDepartureWindowLabel(
    verdicts: ReadonlyArray<TraceLegVerdict | null | undefined>,
    draftM: number,
    opts: { departureMs?: number | null; etaOffsetsMs?: ReadonlyArray<number | undefined> } = {},
): Promise<string | null> {
    const gated = verdicts
        .map((v, i) => ({ v, i }))
        .filter(
            (x): x is { v: TraceLegVerdict; i: number } =>
                !!x.v && x.v.needsTide && x.v.minDepthM !== null && x.v.minAt !== null,
        );
    if (gated.length === 0) return null;
    const departMs = opts.departureMs ?? Date.now();
    const withTransit = !!opts.etaOffsetsMs;
    let common: Array<{ o: number; c: number }> | null = null;
    for (const { v, i } of gated) {
        const dt = opts.etaOffsetsMs?.[i] ?? 0;
        const fromMs = departMs + dt;
        const untilMs = fromMs + 24 * 3600_000;
        const curve = await fetchTideCurve(v.minAt!.lat, v.minAt!.lon, fromMs, untilMs, { days: TIDE_CURVE_MAX_DAYS });
        if (!curve) return null; // offline — the per-leg red rows still stand
        const res = computeTidalWindows({
            minDepthM: v.minDepthM!,
            draftM,
            tide: tideFieldFromCurve(curve),
            fromMs,
            untilMs,
        });
        if (res.alwaysOpen) continue;
        // Shift the gate's WATER windows back by its transit time → the
        // DEPARTURE windows that put the boat there while it's open.
        const wins = res.windows.map((w) => ({ o: w.openMs - dt, c: w.closeMs - dt }));
        if (wins.length === 0) return 'no tide window clears every gate in 24 h — wait or re-route';
        common = common === null ? wins : intersectWindows(common, wins);
        if (common.length === 0) return 'no COMMON departure window clears every gate in 24 h — split the passage';
    }
    if (!common || common.length === 0) return null;
    const w = common[0];
    const openLabel = w.o <= Date.now() ? 'now' : fmtHm(w.o);
    const method = withTransit ? 'transit times included' : "checked at today's tide";
    return `leave ${openLabel}–${fmtHm(w.c)} ${dayWord(Math.max(w.o, Date.now()))} and every tide gate clears (${method})`;
}
