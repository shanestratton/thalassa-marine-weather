/**
 * InshoreRouter — device-side wrapper for the Pi's inshore A* router.
 *
 * Why this exists
 * ───────────────
 * The Thalassa routing pipeline (isochrone → corridor → bathymetric)
 * is built for ocean passages. None of those engines work for short
 * coastal/river/harbor passages where:
 *   - Both endpoints are inland (city centers, marinas, docks).
 *   - Distance is < 100 NM (isochrone bails — see isochroneEnhancer.ts).
 *   - Channel widths are < 500 m (GEBCO can't see the channel).
 *
 * For routes that fall in this zone, the Pi runs A* over a navigability
 * grid built from the user's imported ENC cells. The result is a
 * polyline that hugs the deep channel and stays clear of charted
 * land/shoals/obstructions.
 *
 * When this kicks in
 * ──────────────────
 * useVoyageForm calls tryInshoreRoute() *before* the existing pipeline.
 * If it returns a polyline, the caller stuffs it into routeGeoJSON and
 * the rest of the pipeline (depth enhancement, weather lookup) runs on
 * top. If it returns null, the existing pipeline runs unchanged.
 *
 * Coverage criteria
 * ─────────────────
 *   1. Both endpoints inside (or near) ENC cell coverage.
 *   2. Straight-line distance < 50 NM (longer routes go through the
 *      regular ocean pipeline; the grid would be too big).
 *
 * Failure modes
 * ─────────────
 * Failures are silent (return null) — the caller falls through to the
 * existing pipeline. The exception: a 422 from the Pi with a code
 * like 'origin-on-land' is surfaced via the `failure` field so the
 * caller can show a useful error to the user instead of mysteriously
 * producing nothing.
 */

import type { FeatureCollection } from 'geojson';
import { DeadlineExceeded, withDeadline } from '../utils/deadline';
import { cellsForBBox, listCells } from './enc/EncCellMetadata';
import type { EncCell } from './enc/types';
import { readS57 } from './enc/types';
import { loadCellGeoJSON } from './enc/EncCellStore';
import { routeInshore, type InshoreLayers } from './inshoreRouterEngine';
import type {
    CautionNearShallow,
    ChartedShallowSpan,
    NavGrid,
    PinOffWater,
    ShallowRunInfo,
    SurveyRunInfo,
    SurveyUncheckedCell,
    TideCeiling,
} from './engine/types';
import {
    classifyNoTideRuns,
    NO_TIDE_CLIP_TOLERANCE_M,
    routeCrossesUncheckedShallow,
    tideCeilingLookup,
} from './engine/tideCeiling';
import { routeAreaTideCeilings } from './routing/tideCeilings';
import {
    cellFinenessRank,
    shadowingCells,
    featureIsShadowed,
    stampScaleRank,
    type CellScaleFacts,
} from './enc/scaleShadow';
import { capCellsForMerge } from './enc/mergeCap';
import { crumb } from '../utils/flightRecorder';
import { routeCachedGrid, shadowCompare, shadowSummary } from './seaway/seawayRouter';
import { leadPromotionVerdict, leadShadowSummary, searchLeadGraph } from './seaway/leadGraphSearch';
import { peekLeadGraphForView } from './routing/leadOverlayData';
import { compileSeawayGraph } from './seaway/graphCompiler';
import { splitMarkFeatures, type PointFeatureLike } from './seaway/markSplit';
import { piCache } from './PiCacheService';
import { fetchVerifiedFromPi, routeRequestBinding } from './PiPairingService';
import { getOsmRouteOverlay, type OsmOverlayProvenance, type OsmRouteOverlay } from './OsmRouteOverlayService';
import { applyWaterPack, waterPackUseFor, type WaterPackUse } from './waterPack/waterPackWords';
import { curatedFairwayCanalFeatures } from './curatedFairways';
import { fetchMapboxWater } from './mapboxWater';
import { fetchSatelliteWater } from './satelliteWater';
import { pairWingFeatures } from './pairWings';
import { createLogger } from '../utils/createLogger';
import { navLineLeads, osmNavLineLeads, withChartTrackSource } from './leadingLine';
import {
    chartClearanceBars,
    curatedClearanceBars,
    CLEARANCE_STRUCTURE_LAYERS,
    polylineCrossesClearanceBar,
    type ClearanceBarProperties,
    type ClearanceStructureLayer,
} from './routing/overheadClearance';
import type { ChartWaterProbe } from './engine/chartWaterEvidence';
import {
    auditUnvouchedHardLand,
    backstopChartWaterProbe,
    hardLandAwayFromPinEdges,
    hazardBufferSegments,
    MAX_UNVOUCHED_HARD_LAND_RUN_M,
    unvouchedAlong,
} from './engine/safetyAudit';
import { UNCHARTED_MAX_RUN_M } from './engine/constants';
import { collectShallowRuns, collectSurveyRuns } from './engine/shallowRuns';
import { routeTierMasks } from './engine/tierPipeline';

const log = createLogger('InshoreRouter');

/**
 * The chart layers stamped with their cell's fineness rank (`_scaleRank`)
 * at merge time. DEPARE for the grid's finest-survey-wins depth; LNDARE and
 * DRGARE too since owner decision 1 (2026-09-30): a coarser chart's land
 * paint over a FINER survey's never-drying band is shallow water, and only
 * a strictly finer rank beats land — an unranked LNDARE always stands
 * (navGrid Pass 2, leadLandClip). Idempotent: the rank is the cell's own
 * scale (cellScaleFacts below).
 */
const SCALE_RANKED_LAYERS: ReadonlySet<string> = new Set(['LNDARE', 'DEPARE', 'DRGARE']);

/**
 * What a cell says about its own scale, for the `_scaleRank` stamp
 * (services/enc/scaleShadow.ts cellFinenessRank): the compilation scale its
 * blob carries (the SENC header's native scale; DSPM CSCL on the Pi's ogr2ogr
 * path), else the usage band in its S-57 name. Round 2 (2026-09-30): the rank
 * used to be the cell's bbox area, which made a same-scale sibling "finer".
 */
function cellScaleFacts(
    cell: { id: string; sourceCellId?: string },
    blob: { nativeScale?: unknown; sourceCellId?: unknown },
): CellScaleFacts {
    return { nativeScale: blob.nativeScale, sourceCellId: cell.sourceCellId ?? blob.sourceCellId, cellId: cell.id };
}

/**
 * Master switch for the Pi-cache cloud A* path.
 *
 * 2026-05-21 RE-ENABLED: the Pi-cache engine
 * (`pi-cache/src/services/inshoreRouter.ts`) has been re-synced
 * byte-for-byte with the iOS engine (`services/inshoreRouterEngine.ts`)
 * — relaxZones, the directed CAUTION component-bridge, NAVLINE Pass 5b,
 * and the `_promotePreferred` FAIRWY handling are all present. Verified
 * at parity against the real-cell corridor fixture
 * (`tests/fixtures/newport-rivergate.corridor.json.gz`): both engines
 * return the identical Newport→Rivergate route (connected, 20.46 NM,
 * 21 pts, 0 m snap both ends, 10 caution cells).
 *
 * Behaviour: cloud-first when the Pi probe succeeds (LAN), else the
 * device runs the same pure function locally. Off-LAN (TestFlight) the
 * probe fails fast and routing stays fully on-device.
 *
 * If the iOS engine changes again, re-sync the Pi copy (see the header
 * of pi-cache/src/services/inshoreRouter.ts) before trusting this path,
 * or set false until the Pi catches up.
 */
const CLOUD_ROUTER_ENABLED = false;

// Phase 12 shadow router (services/seaway/seawayRouter): logs a one-line
// graph-vs-direct comparison after every successful LOCAL route. Telemetry
// only — the user's route is untouched; flip off if the shadow ever shows
// up in route latency (it rides the grid cache, so it shouldn't).
const SEAWAY_SHADOW_ENABLED = true;

// Phase 3 (2026-10-01): the lead-graph SHADOW (services/seaway/leadGraphSearch)
// — would routing over the Phase 1 lead graph (recommended tracks, leading
// lines, hops between them) have done better? One 'LEAD SHADOW' warn line per
// LOCAL route, with its own timings. Telemetry only: it never returns and
// never alters the route; promotion is Phase 3b. Flip off if it shows up in
// route latency, as with the Seaway shadow.
const LEAD_GRAPH_SHADOW_ENABLED = true;

// Phase 13 — PROMOTE the Seaway Graph route (it threads dead-centre through the
// lateral-mark gates by construction) when it is side-correct AND stays within the
// PER-LEG detour cap. The engine route is computed first regardless and remains the
// PERMANENT fallback. A compile-time `const` (NOT env/remote) so the minifier
// dead-code-eliminates the whole promotion branch when off → the shipped binary is
// provably engine-only and byte-identical to today; flipping it is a one-line commit.
const SEAWAY_ROUTER_ENABLED = true;
// PER-LEG (not whole-route) detour cap — a long near-straight open-water connector leg
// must survive (the Newport→Rivergate direct-bay route).
const SEAWAY_DETOUR_CAP = 1.35;
// Effectively 100% gate side-correctness; 0.999 only absorbs float-equality.
const SEAWAY_GATE_COMPLIANCE_MIN = 0.999;

export function seawayPromotionBlockReason(result: {
    canalMask?: readonly boolean[];
    debug?: { threeTier?: string };
    shallowRuns?: readonly ShallowRunInfo[];
    pinOffWater?: { origin?: string; destination?: string };
}): string | null {
    const provenance = result.debug?.threeTier ?? '';
    if (result.canalMask?.some(Boolean)) return 'tier-1 canal/marina mask present';
    if (provenance.includes('egress-channel')) return 'engine egress-channel gate chain present';
    if (provenance.includes('canalsnap')) return 'engine canal centreline snap present';
    // The engine route runs to a pin in charted-shallow water through its own
    // 'needs tide' tail (decision 7), or says a pin is off the water: a graph
    // route is drawn by its own connectors, ends short of such a pin and
    // carries neither (fix-up, 2026-09-30 — measured 22.6 m short of a pin in
    // charted 1 m water, with no tail and no report).
    if (result.shallowRuns?.some((r) => r.endpointTail)) return 'engine route ends in a charted needs-tide tail';
    if (result.pinOffWater?.origin || result.pinOffWater?.destination)
        return 'engine route reports a pin off the water';
    return null;
}

/** Does the polyline enter the bbox ([minLon, minLat, maxLon, maxLat])? A
 * vertex inside, or a segment crossing it (Liang–Barsky clip). */
export function polylineTouchesBbox(
    polyline: readonly (readonly [number, number])[],
    [x0, y0, x1, y1]: readonly [number, number, number, number],
): boolean {
    for (let i = 0; i < polyline.length; i++) {
        const [ax, ay] = polyline[i];
        if (ax >= x0 && ax <= x1 && ay >= y0 && ay <= y1) return true;
        if (i === 0) continue;
        const [bx, by] = polyline[i - 1];
        const dx = ax - bx;
        const dy = ay - by;
        let t0 = 0;
        let t1 = 1;
        let inside = true;
        for (const [p, q] of [
            [-dx, bx - x0],
            [dx, x1 - bx],
            [-dy, by - y0],
            [dy, y1 - by],
        ] as const) {
            if (p === 0) {
                if (q < 0) inside = false;
            } else {
                const r = q / p;
                if (p < 0) t0 = Math.max(t0, r);
                else t1 = Math.min(t1, r);
            }
        }
        if (inside && t0 <= t1) return true;
    }
    return false;
}

/**
 * The route a PROMOTED Seaway Graph polyline ships as (Phase 13), with every
 * per-segment fact the planner reads off an engine route. Extracted so it is
 * testable (round 3, 2026-09-30).
 *   • Channel-edge segments render YELLOW; connector approach/exit legs stay
 *     TEAL; caution sampled against the grid so the promoted route sheds red
 *     honestly — the engine's recompute never sees this path. A mask that
 *     does not fit is NO channel, never all-channel: an all-true fallback
 *     painted the whole route yellow, over its red (fix-up, 2026-09-30).
 *   • Its 'needs tide' runs from the engine's own sampler, so the tide chips
 *     survive promotion (a promoted route shipped none; fix-up, 2026-09-30).
 *   • Its survey stretches from the engine's own sampler (owner decision 9).
 *   • Its canal and offshore masks by the engine's own rules
 *     (engine/tierPipeline routeTierMasks; round 3, 2026-09-30): without them
 *     the planner's verified-colour contract (inshoreSegmentStates) failed
 *     and every promoted route drew as unverified dashes that could not be
 *     saved, exported or shared.
 */
export function promotedSeawayRoute(
    g: {
        polyline: [number, number][];
        channelSegMask: readonly boolean[];
        cautionSegMask: readonly boolean[];
        lengthM: number;
        edgesUsed: string[];
        gateCount: number;
        gateCompliance: number | null;
        detourRatio: number;
    },
    grid: NavGrid | undefined,
    layers: InshoreLayers,
    opts: { draftM: number; safetyM: number; unchartedPolicy?: 'permissive' | 'strict'; obstructionBufferM?: number },
    base: {
        cellsUsed: string[];
        elapsedMs: number;
        surveyUncheckedCells?: readonly SurveyUncheckedCell[];
        structuresUnknownCells?: string[];
        /** It crosses water a tide must clear where no tide was loaded (decision 11). */
        tideCheck?: 'not-loaded';
    },
): InshoreRouteResult {
    const segCount = Math.max(0, g.polyline.length - 1);
    const chanMask = g.channelSegMask.length === segCount ? [...g.channelSegMask] : new Array(segCount).fill(false);
    const graphCaution = g.cautionSegMask.length === segCount ? [...g.cautionSegMask] : undefined;
    // Strict policy: water no source vouches for is caution on the graph route
    // exactly as on the engine's (round-3 review, 2026-09-30). The graph
    // sampler reads red only from land or charted-shallow cells, and a no-
    // evidence cell is UNKNOWN_OPEN (0) — so a promoted route drew a 400 m
    // uncharted strip teal, or yellow on a channel leg, and saved it verified.
    const unvouched = grid && opts.unchartedPolicy === 'strict' ? unvouchedAlong(grid, g.polyline) : null;
    // A charted hazard's buffer is caution on the graph route exactly as on
    // the engine's (its final hazard audit), at the engine's own default
    // buffer when the caller names none — and it keeps its red whatever the
    // tide (owner decision 10, 2026-09-30). Round-4 review (2026-09-30): the
    // mask only reached the tide depth, so a charted-shallow stretch beside a
    // drying rock went from red to needs-tide amber on a promoted route.
    const nearHazard = hazardBufferSegments(
        g.polyline,
        layers,
        opts.obstructionBufferM ?? 30,
        opts.draftM + opts.safetyM,
    );
    const cautionMask = graphCaution?.map((c, i) => c || unvouched?.segMask[i] === true || nearHazard[i] === true);
    const runs =
        grid && cautionMask
            ? collectShallowRuns({
                  layers,
                  grid,
                  polyline: g.polyline,
                  caution: cautionMask,
                  draftM: opts.draftM,
                  safetyM: opts.safetyM,
                  hazardMask: nearHazard,
              })
            : null;
    const survey = collectSurveyRuns({
        layers,
        polyline: g.polyline,
        draftM: opts.draftM,
        safetyM: opts.safetyM,
        uncheckedCells: base.surveyUncheckedCells,
        ...(grid ? { grid } : {}),
    });
    const tiers = grid ? routeTierMasks(g.polyline, grid, layers, chanMask) : null;
    return {
        polyline: g.polyline,
        channelMask: chanMask,
        tier4Mask: chanMask,
        cautionMask,
        ...(tiers ? { canalMask: tiers.canalMask, offshoreMask: tiers.offshoreMask } : {}),
        ...(runs
            ? {
                  shallowRuns: runs.shallowRuns,
                  chartedShallowMask: runs.chartedShallowMask,
                  tideDepthM: runs.tideDepthM,
                  tideNeedM: opts.draftM + opts.safetyM,
              }
            : {}),
        ...(runs && runs.chartedShallowSpans.length > 0 ? { chartedShallowSpans: runs.chartedShallowSpans } : {}),
        ...(runs
            ? {
                  landPaintConflictMask: runs.landPaintConflictMask,
                  cautionWhy: runs.cautionWhy,
                  cautionDepthM: runs.cautionDepthM,
                  cautionNearShallow: runs.cautionNearShallow,
              }
            : {}),
        surveyRuns: survey.surveyRuns,
        ...(survey.uncheckedCells.length > 0 ? { surveyUncheckedCells: survey.uncheckedCells } : {}),
        distanceNM: g.lengthM / 1852,
        cellsUsed: base.cellsUsed,
        elapsedMs: base.elapsedMs,
        ...(base.structuresUnknownCells?.length ? { structuresUnknownCells: base.structuresUnknownCells } : {}),
        ...(base.tideCheck ? { tideCheck: base.tideCheck } : {}),
        debug: {
            seaway: {
                edgesUsed: g.edgesUsed,
                gateCount: g.gateCount,
                gateCompliance: g.gateCompliance,
                detourRatio: g.detourRatio,
            },
        },
    };
}

/**
 * The engine's own final checks, on a Seaway graph polyline about to be
 * PROMOTED (fix-up, 2026-09-30). A promoted route skipped every one of them —
 * they run inside routeInshore on engine geometry — and a connector that
 * squeezed diagonally through a cable's bar staircase shipped under a 10 m
 * cable with an 18 m mast. Null when the graph route passes:
 *   • never under a structure this mast cannot clear (the exact mast gate);
 *   • never across more unvouched charted land than the engine route it
 *     would replace (the exact hard-land audit — the engine's own figure,
 *     debug.hardLandTotalM, when it ran), nor a run the engine would refuse.
 */
export function seawayGraphSafetyFault(
    polyline: readonly [number, number][],
    layers: InshoreLayers,
    engine: { polyline: readonly [number, number][]; debug?: { hardLandTotalM?: number } },
    strict?: { grid: NavGrid | undefined },
    /** Decision 11 (2026-10-01): the tide ceilings the engine routed with,
     *  and its draft + safety. */
    noTide?: { tideCeilings?: readonly TideCeiling[]; needM: number },
): string | null {
    const bar = polylineCrossesClearanceBar(polyline, layers.OBSTRN?.features ?? []);
    if (bar) return `passes under a ${String(bar.properties._structure)} this mast cannot clear`;
    // Never through water no tide clears (owner decision 11, 2026-10-01) —
    // the engine route cannot take it, and neither may a graph route. The
    // engine's own rule (fix-up, 2026-10-01; tideCeiling classifyNoTideRuns):
    // only a clip — a corner with a way round it right there, no more than
    // NO_TIDE_CLIP_TOLERANCE_M — is kept; the graph cannot redraw a creek,
    // and a crossing of any width declines it.
    if (noTide) {
        const lookup = tideCeilingLookup(noTide.tideCeilings);
        const sorted = classifyNoTideRuns(layers, polyline, lookup, noTide.needM, {
            toleranceM: NO_TIDE_CLIP_TOLERANCE_M,
        });
        const across = [...sorted.crossings, ...sorted.splices];
        if (across.length > 0)
            return `crosses ${Math.round(across.reduce((m, c) => m + c.run.lengthM, 0))} m of water no tide clears`;
    }
    const graph = auditUnvouchedHardLand(layers, polyline);
    const engineTotalM = engine.debug?.hardLandTotalM ?? auditUnvouchedHardLand(layers, engine.polyline).totalM;
    if (graph.maxRunM > MAX_UNVOUCHED_HARD_LAND_RUN_M || graph.totalM > engineTotalM + 1) {
        return `crosses ${Math.round(graph.totalM)} m of unvouched charted land (engine route ${Math.round(engineTotalM)} m)`;
    }
    // Strict policy: the engine's uncharted-water rules (round-3 review,
    // 2026-09-30) — never a run the engine would refuse ('uncharted-corridor',
    // over UNCHARTED_MAX_RUN_M), never more no-evidence water than the engine
    // route it would replace. Both ran only inside routeInshore.
    if (strict?.grid) {
        const g = unvouchedAlong(strict.grid, polyline);
        const e = unvouchedAlong(strict.grid, engine.polyline);
        if (g.maxRunM > UNCHARTED_MAX_RUN_M || g.totalM > e.totalM + 1) {
            return `crosses ${Math.round(g.totalM)} m of water no chart vouches for (engine route ${Math.round(e.totalM)} m)`;
        }
    }
    return null;
}

// Verbose orchestration diagnostics (OSM-coverage dumps, per-tag promotion,
// Scarborough/marker/midpoint traces, ribbon continuity, full polyline
// coordinate dumps, phase timings). Gated OFF for production — the minifier
// dead-code-eliminates `if (ROUTE_DEBUG)` so neither the logs nor their
// (sometimes O(features)) compute ship. Flip true locally to debug a route.
// Lifecycle (ENTRY/EXIT), GATE, cell-load, and cloud/error logs stay
// unconditional so field failures remain diagnosable.
const ROUTE_DEBUG = false;

// ── Types ───────────────────────────────────────────────────────────

export interface InshoreOrigin {
    lat: number;
    lon: number;
}

export interface InshoreRouteResult {
    polyline: [number, number][]; // [lon, lat]
    /**
     * Per-segment caution flag, length `polyline.length - 1`.
     * true = the segment crosses water that reads too shallow for this
     * vessel in our coarse public bathymetry (but is not land/hazard).
     * The map renderer draws these segments red. May be undefined on
     * cloud results that predate the field — treat undefined as "all
     * segments normal".
     */
    cautionMask?: boolean[];
    /**
     * Per-segment canal flag, length `polyline.length - 1`. true = the segment
     * rides a charted canal centre-line. The map renderer draws these the SAME
     * red as caution (a canal is careful, slow, narrow water), but it is kept
     * SEPARATE from cautionMask because the canal is known charted water, not
     * water-to-verify — so it never inflates the safety/scorecard caution metric.
     */
    canalMask?: boolean[];
    /**
     * Per-segment tier-2 flag, length `polyline.length - 1`. true = the segment rides
     * the MARKED-CHANNEL / lead-out leg (lateral marks / recommended track from a
     * canal-mouth out to bay water). The map renderer draws these YELLOW — pilotage
     * water — distinct from RED canal/caution, GREEN inshore bay, and DARK BLUE offshore.
     */
    channelMask?: boolean[];
    /**
     * Deprecated compatibility alias for channelMask. It used to mean "marked
     * channel" before tier 4 was reserved for offshore.
     */
    tier4Mask?: boolean[];
    /**
     * Per-segment offshore flag, length `polyline.length - 1`. true = the OFFSHORE leg
     * (engine TierId 4, off the ENC grid). The map renderer draws these DARK BLUE.
     * Empty/absent on a fully-inshore route.
     */
    offshoreMask?: boolean[];
    /** Phase 13: present ONLY on a PROMOTED Seaway Graph route (for UI / Bosun
     *  narration). Absent on every engine-fallback route. */
    debug?: { seaway?: { edgesUsed: string[]; gateCount: number; gateCompliance: number | null; detourRatio: number } };
    /**
     * Charted-shallow caution runs (≥200 m, or an endpoint tail of any
     * length) with the real charted min depth where the chart vouches one
     * (null = uncharted/conflict caution — never fabricate a tide window from
     * those). Substrate for the Phase 7 "clears HH:MM–HH:MM" chips. Absent on
     * cloud results; a promoted Seaway route carries its own
     * (promotedSeawayRoute, fix-up 2026-09-30).
     */
    shallowRuns?: ShallowRunInfo[];
    /** Per segment: caution over charted-shallow water (engine
     *  RouteResult.chartedShallowMask) — it beats a marked channel's yellow. */
    chartedShallowMask?: boolean[];
    /** Per segment: the charted depth a tide must lift (engine
     *  RouteResult.tideDepthM, owner decision 10) — amber where some tide
     *  gives draft + UKC over it, red where none does; null keeps the red. */
    tideDepthM?: (number | null)[];
    /** Draft + UKC the router judged tideDepthM against (engine
     *  RouteResult.tideNeedM; round-4 review, 2026-09-30). */
    tideNeedM?: number;
    /** The renderer's backstop (engine RouteResult.chartedShallowSpans,
     *  round-3 review, 2026-09-30): charted-shallow stretches of segments the
     *  grid did not flag caution — drawn red whatever else they are. */
    chartedShallowSpans?: ChartedShallowSpan[];
    /** Per segment: caution over decision-1 water (engine
     *  RouteResult.landPaintConflictMask) — it beats a marked channel's yellow. */
    landPaintConflictMask?: boolean[];
    /** Per segment: why a caution segment is caution, read exactly along its
     *  line (engine RouteResult.cautionWhy, CAUTION_WHY bits; round 2,
     *  2026-10-02) — GRID_ONLY is not drawn red; every other reason is named. */
    cautionWhy?: number[];
    /** Per segment: the charted depth under a SHALLOW caution segment
     *  (engine RouteResult.cautionDepthM), else null. */
    cautionDepthM?: (number | null)[];
    /** Per segment: the shallow band a NEAR_SHALLOW segment passes too close
     *  to (engine RouteResult.cautionNearShallow), else null. */
    cautionNearShallow?: (CautionNearShallow | null)[];
    /** Metres of overland tail trimmed off an inland destination pin —
     *  present only when the trim fired (route ends at the water's edge). */
    destinationInlandTrimM?: number;
    /** A pin on charted land or a drying bank (engine RouteResult.pinOffWater,
     *  owner decision 7): no charted 'needs tide' tail; the route stops at the
     *  edge of the bank or the land, never across the drying ground to the
     *  pin (round 3, 2026-09-30). The route notice says so. A pin in
     *  charted-shallow water gets the route all the way to it instead, its
     *  tail a 'needs tide' shallowRuns entry (endpointTail). */
    pinOffWater?: { origin?: PinOffWater; destination?: PinOffWater };
    /**
     * Owner decision 11 (2026-10-01): 'not-loaded' when the route crosses
     * water a tide must clear (a band charted no deeper than draft + UKC) in
     * a place no tide curve was loaded for before it was computed (offline,
     * no station, a non-LAT datum, past the per-route cap, a fetch that timed
     * out — fix-up, 2026-10-01: it used to mean "none loaded anywhere", said
     * of all-deep routes and never of a partial load). The router cannot
     * prove water no tide clears there: that stretch routed as before, and
     * the route says so in one plain caveat.
     */
    tideCheck?: 'not-loaded';
    /**
     * Cells this route used whose chart data carries no bridge / overhead
     * cable / overhead pipe layers (converted before schema 2 — "not
     * extracted", unlike an empty layer, which is "none charted"). The route
     * was NOT checked against charted overhead clearance there; only the
     * curated bridge list gated it. Absent when every cell carries them.
     * Shown next to the route (usePassagePlanner).
     */
    structuresUnknownCells?: string[];
    /**
     * The route's survey-quality stretches (owner decision 9, 2026-09-30:
     * "Yes, amber on the route"; engine RouteResult.surveyRuns) — amber where
     * the survey may be out by more than the keel margin, or is old or
     * ungraded. Disclosure only. Promoted Seaway routes carry them too.
     */
    surveyRuns?: SurveyRunInfo[];
    /** Cells with no M_QUAL layer that own some of the route: its survey
     * quality was not checked there (a caveat, never amber). */
    surveyUncheckedCells?: string[];
    /**
     * The charted land this route crosses (2026-10-01 review; engine
     * debug.hardLandTotalM / hardLandAwayM / hardLandAwayAt): all of it, and
     * the part away from a pin's own edge, with the middle of its longest
     * run. The engine refuses only a run over 500 m; Auto refuses any land
     * away from a pin's edge (services/autoroutingThalassa). Absent when the
     * audit did not run (a permissive or cloud route).
     */
    hardLand?: { totalM: number; awayM: number; awayAt?: [number, number] };
    /** The localized relax zones the route was built with (engine
     *  debug.relaxZones): circles round a far-snapped pin where charted land
     *  was opened as caution so the route could reach the berth. */
    relaxZones?: { lat: number; lon: number; radiusM: number }[];
    /** Tide ceilings (the highest tide per place) were loaded before routing
     *  (owner decision 11), so water no tide clears was ruled out where they
     *  reach. */
    tideCeilingsLoaded?: boolean;
    /** Where the route's canal and marina water came from (Phase 2b,
     *  2026-10-01): the phone's offline water pack, the Pi's stale copy, or
     *  none saved for an end — said next to the route (waterPackCaveats).
     *  Absent when the overlay carried no provenance (a mock). */
    waterPack?: WaterPackUse;
    /**
     * What this route's own charts say at a point — the cells as merged for
     * it (ranked) plus the OSM water it was routed on — for the satellite land
     * check (services/routing/landBackstop, 2026-10-02): an ETOPO land sample
     * counts only where this does not answer 'water'. Every caller of the
     * check passes it (Auto, the passage planner, the voyage form). In-memory
     * only — a function, never serialised or cloned; absent when it could not
     * be built (the check then counts every ETOPO land sample, as before).
     */
    chartWater?: ChartWaterProbe;
    distanceNM: number;
    cellsUsed: string[];
    elapsedMs: number;
}

/**
 * The satellite land check's chart evidence for a finished route
 * (safetyAudit.backstopChartWaterProbe), indexed over the route's own bbox
 * only. Never throws: a probe that cannot be built is left off, and the check
 * then trusts no chart (fail closed).
 */
function routeChartWater(
    layers: InshoreLayers,
    polyline: readonly [number, number][],
): { chartWater?: ChartWaterProbe } {
    try {
        let w = Infinity;
        let sLat = Infinity;
        let e = -Infinity;
        let n = -Infinity;
        for (const [lon, lat] of polyline) {
            w = Math.min(w, lon);
            e = Math.max(e, lon);
            sLat = Math.min(sLat, lat);
            n = Math.max(n, lat);
        }
        if (!Number.isFinite(w) || !Number.isFinite(sLat)) return {};
        // A hair of pad: the samples lie on the line, never off it.
        const pad = 1e-6;
        return { chartWater: backstopChartWaterProbe(layers, [w - pad, sLat - pad, e + pad, n + pad]) };
    } catch (err) {
        log.warn(`chart evidence for the land check unavailable: ${err instanceof Error ? err.message : String(err)}`);
        return {};
    }
}

export interface InshoreRouteFailure {
    error: string;
    code?: string;
    cellsUsed?: string[];
    /** As InshoreRouteResult.waterPack. With an end's water missing offline,
     *  `error` leads with that (owner decision 2); the code is the engine's. */
    waterPack?: WaterPackUse;
}

// ── Coverage check ──────────────────────────────────────────────────

/** Max straight-line distance for inshore routing (nautical miles). Exported
 *  2026-10-01 so Auto (services/autoroutingThalassa) can say why before it
 *  asks: this function answers a longer passage with a silent null. */
export const MAX_INSHORE_NM = 50;

/** Margin around an endpoint when checking ENC coverage (degrees ≈ 5km). */
const COVERAGE_MARGIN_DEG = 0.05;

/** Synthetic depth (m) stamped on injected Mapbox `water` polygons. Mapbox knows
 *  WHERE the water is, not how deep — so we use a moderate marina/river-realistic
 *  value: deep enough to be navigable (not CAUTION) for a typical yacht, shallow
 *  enough to be honest in the canal/marina crops where it's injected. Real charted
 *  DEPARE always wins on overlap (the engine keeps the shallower verified depth). */
const MAPBOX_WATER_DEPTH_M = 5.0;

function straightLineNM(a: InshoreOrigin, b: InshoreOrigin): number {
    const R_NM = 3440.065;
    const dLat = ((b.lat - a.lat) * Math.PI) / 180;
    const dLon = ((b.lon - a.lon) * Math.PI) / 180;
    const φ1 = (a.lat * Math.PI) / 180;
    const φ2 = (b.lat * Math.PI) / 180;
    const A = Math.sin(dLat / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dLon / 2) ** 2;
    return R_NM * 2 * Math.atan2(Math.sqrt(A), Math.sqrt(1 - A));
}

/**
 * True if both endpoints fall inside (or within COVERAGE_MARGIN_DEG of)
 * an installed ENC cell. We accept the margin because city-center
 * geocodes can land just outside a coastal cell's bbox even when the
 * actual departure dock is inside it.
 */
export function hasEncCoverageForRoute(origin: InshoreOrigin, destination: InshoreOrigin): boolean {
    const cellsForOrigin = cellsForBBox([
        origin.lon - COVERAGE_MARGIN_DEG,
        origin.lat - COVERAGE_MARGIN_DEG,
        origin.lon + COVERAGE_MARGIN_DEG,
        origin.lat + COVERAGE_MARGIN_DEG,
    ]);
    if (cellsForOrigin.length === 0) return false;
    const cellsForDest = cellsForBBox([
        destination.lon - COVERAGE_MARGIN_DEG,
        destination.lat - COVERAGE_MARGIN_DEG,
        destination.lon + COVERAGE_MARGIN_DEG,
        destination.lat + COVERAGE_MARGIN_DEG,
    ]);
    return cellsForDest.length > 0;
}

// ── Corridor coverage gate ──────────────────────────────────────────
// Field bug 2026-06-12 (Newport→Mooloolaba, ROUTING_COLLAB reply 16):
// the endpoint check above passed because BOTH ends had cells, while
// the corridor between them crossed a chart-coverage hole — and the
// engine's permissive UNKNOWN_OPEN default routed dead-straight over
// Bribie Island. This gate samples the DIRECT line between the
// endpoints and refuses inshore routing when any interior sample falls
// outside every routing-grade installed cell. Fails in milliseconds
// with an actionable message instead of after a 20 s grid build.

/** Along-corridor sampling interval. */
const CORRIDOR_SAMPLE_NM = 1.0;
/**
 * Cells sparser than this (features per square degree of bbox) don't
 * count as corridor coverage. An overview-class cell proves you OWN a
 * chart of the area, not that the area is charted to routing grade —
 * the 1°×1° cell 351724 carries 48 features total and Bribie Island is
 * not among them, so its bbox blanketing the corridor must not satisfy
 * this gate. Harbour/approach/ribbon cells run 10³–10⁶ features per
 * square degree; genuinely skeletal cells sit one to two orders of
 * magnitude below this floor.
 */
const ROUTING_GRADE_MIN_FEATURES_PER_SQDEG = 200;

export interface CorridorCoverageGap {
    lat: number;
    lon: number;
    /** Distance from the origin along the direct line, in NM. */
    atNM: number;
}

/**
 * First interior sample of the direct origin→destination line not
 * covered by any routing-grade installed cell, or null when the whole
 * corridor is covered. Endpoints are NOT tested here — they keep
 * hasEncCoverageForRoute's margin semantics (city-centre geocodes land
 * just outside coastal cell bboxes). Pure — pass listCells() live,
 * fixtures in tests.
 */
export function findCorridorCoverageGap(
    origin: InshoreOrigin,
    destination: InshoreOrigin,
    cells: EncCell[],
): CorridorCoverageGap | null {
    const grade = cells.filter((c) => {
        const [minLon, minLat, maxLon, maxLat] = c.bbox;
        const areaSqDeg = Math.max(1e-6, (maxLon - minLon) * (maxLat - minLat));
        return c.hazardCount / areaSqDeg >= ROUTING_GRADE_MIN_FEATURES_PER_SQDEG;
    });
    const totalNM = straightLineNM(origin, destination);
    const steps = Math.max(1, Math.ceil(totalNM / CORRIDOR_SAMPLE_NM));
    for (let s = 1; s < steps; s++) {
        const t = s / steps;
        const lat = origin.lat + (destination.lat - origin.lat) * t;
        const lon = origin.lon + (destination.lon - origin.lon) * t;
        const covered = grade.some((c) => lon >= c.bbox[0] && lon <= c.bbox[2] && lat >= c.bbox[1] && lat <= c.bbox[3]);
        if (!covered) return { lat, lon, atNM: totalNM * t };
    }
    return null;
}

/**
 * The bbox the router asks the OSM overlay for: the endpoints' envelope
 * padded by a flat 0.10° (≈11 km), a little more than the engine's grid pad
 * (max(maxSpan × 0.5, 0.08°), commit a42a2762), so the OSM water / coastline
 * / aeroway coverage never undershoots the grid's lateral margin. Exported
 * for the offline water-pack test (Phase 2b, 2026-10-01).
 */
export function inshoreOverlayBbox(
    origin: InshoreOrigin,
    destination: InshoreOrigin,
): [number, number, number, number] {
    return [
        Math.min(origin.lon, destination.lon) - 0.1,
        Math.min(origin.lat, destination.lat) - 0.1,
        Math.max(origin.lon, destination.lon) + 0.1,
        Math.max(origin.lat, destination.lat) + 0.1,
    ];
}

// ── Public API ──────────────────────────────────────────────────────

/**
 * Attempt to compute an inshore route via the Pi. Returns null when:
 *   - Pi is unreachable
 *   - Route is too long (> MAX_INSHORE_NM)
 *   - No ENC coverage at one or both endpoints
 *
 * Returns a `InshoreRouteFailure` (with a code) when the Pi successfully
 * built a grid but couldn't find a path — the caller should surface a
 * user-friendly message rather than silently fall through.
 */
// Deduplicate concurrent calls to tryInshoreRoute. Multiple upstream
// hooks (useVoyageForm + usePassagePlanner) fire the same route compute
// for the same origin/destination on each plan request. Without
// dedupe, the engine runs the 20 s buildNavGrid twice in parallel.
// Cache by a coarse origin+destination+draft signature; subsequent
// concurrent calls return the same Promise.
const inflightRouteRequests = new Map<string, Promise<InshoreRouteResult | InshoreRouteFailure | null>>();

export async function tryInshoreRoute(
    origin: InshoreOrigin,
    destination: InshoreOrigin,
    draftM: number,
    /** Vessel air draft (mast height) in METRES; null/omitted = NOT SET, and
     *  then every charted or curated bridge and overhead line blocks (owner
     *  decision 2026-09-30: its clearance cannot be checked). Callers convert
     *  via vesselAirDraftMetres() — vessel.airDraft is stored in FEET. */
    airDraftM: number | null = null,
    /** Route profile — 'tideAssist' is the EXPLICIT shortest-with-the-tide
     *  option (recoverable ≤1.8 m-rise caution at 10×, windows chipped);
     *  'tideDirect' is the auto-route profile (same mask at 1.5× so A* commits
     *  to the near-direct crossing over a modest deep detour); 'safest'
     *  (default) never lets tide change preference. */
    routeProfile: 'safest' | 'tideAssist' | 'tideDirect' = 'safest',
    /**
     * Owner decision 11 (2026-10-01): `departureMs` is the departure the tide
     * curves are loaded for (the chips' own window, so they share the cache;
     * default now). `tideCeilings` hands in the highest tide per place
     * instead of loading it — an empty list means none is known.
     */
    opts: { departureMs?: number; tideCeilings?: readonly TideCeiling[] } = {},
): Promise<InshoreRouteResult | InshoreRouteFailure | null> {
    // Loud entry log so we can tell from a noisy console whether this
    // function is even being called. createLogger silences info() in
    // production builds — use warn() so it actually emits on iOS.
    // Remove once on-device routing is stable on the surfaces that matter.
    log.warn(
        `ENTRY origin=${origin.lat.toFixed(4)},${origin.lon.toFixed(4)} dest=${destination.lat.toFixed(4)},${destination.lon.toFixed(4)} draft=${draftM}`,
    );

    // Dedupe check — quantise to 4 decimal places (~11 m precision)
    // so tiny float jitter between callers still hits the same key.
    // …and the tides it routes with (decision 11 fix-up, 2026-10-01): handed-in
    // ceilings by their quantised set, else the departure's hour — a promise
    // computed with other tides is never shared.
    const tideKey = opts.tideCeilings
        ? `tc${tideCeilingLookup(opts.tideCeilings).key}`
        : `dep${Math.floor((opts.departureMs ?? Date.now()) / 3_600_000)}`;
    const dedupeKey = `${origin.lat.toFixed(4)}_${origin.lon.toFixed(4)}_${destination.lat.toFixed(4)}_${destination.lon.toFixed(4)}_${draftM}_${airDraftM ?? 'na'}_${routeProfile}_${tideKey}`;
    const inflight = inflightRouteRequests.get(dedupeKey);
    if (inflight) {
        log.warn(`DEDUPE: another call for the same route is already running — returning its promise`);
        return inflight;
    }
    // Wall-clock watchdog (reply 19 fix 2): bounds every ASYNC await in
    // the pipeline (cell loads, OSM overlay, marker fetch — AbortSignal
    // is a no-op under the CapacitorHttp patch) so the .finally below
    // ALWAYS runs and the dedupe map can't wedge on a dead socket. It
    // cannot interrupt the synchronous engine compute (no JS timer fires
    // mid-A*; a Worker thread is the eventual fix) — 85 s sits under
    // Claude A's 90 s caller-side race so this one fires first and
    // returns a skipper-readable failure instead of an opaque throw.
    const INSHORE_WATCHDOG_MS = 85_000;
    // Where this route's OSM water came from (Phase 2b): one holder per call,
    // so two routes in flight never read each other's.
    const overlayUse: { overlay?: OsmOverlayProvenance } = {};
    const promise = withDeadline(
        tryInshoreRouteInner(origin, destination, draftM, airDraftM, routeProfile, opts, overlayUse),
        INSHORE_WATCHDOG_MS,
        'inshore route',
    )
        .catch((err) => {
            if (err instanceof DeadlineExceeded) {
                log.warn(
                    `WATCHDOG: inshore route exceeded ${INSHORE_WATCHDOG_MS}ms — failing so retries get a fresh run`,
                );
                return {
                    error: 'Inshore routing timed out — check signal and chart sync, then try again',
                    code: 'watchdog-timeout',
                } as InshoreRouteFailure;
            }
            throw err;
        })
        // Owner decision 2 (Phase 2b, 2026-10-01): the route says where its
        // canal water came from, and a refusal with an end's water missing
        // offline says that first. The code never changes.
        .then((res) => applyWaterPack(res, waterPackUseFor(overlayUse.overlay, origin, destination)))
        .then((res) => {
            // Loud paired exit log so every ENTRY has a visible
            // completion in the console. Three outcomes:
            //   • polyline → success (also logged by the STAGE: lines)
            //   • error/code → engine ran but couldn't route
            //   • null → gated out (distance / ENC coverage / no cells)
            // The latter two were previously near-silent at this layer.
            if (res && 'polyline' in res) {
                log.warn(`EXIT: success — ${res.polyline.length} polyline pts, ${res.distanceNM.toFixed(1)} NM`);
            } else if (res && 'error' in res) {
                log.warn(`EXIT: engine failure — ${res.error} (code=${res.code ?? 'none'})`);
            } else {
                log.warn(`EXIT: gated null — see prior GATE/STAGE logs for which check failed`);
            }
            return res;
        })
        .catch((err) => {
            log.warn(`EXIT: threw — ${err instanceof Error ? err.message : String(err)}`);
            throw err;
        })
        .finally(() => {
            inflightRouteRequests.delete(dedupeKey);
        });
    inflightRouteRequests.set(dedupeKey, promise);
    return promise;
}

async function tryInshoreRouteInner(
    origin: InshoreOrigin,
    destination: InshoreOrigin,
    draftM: number,
    airDraftM: number | null = null,
    routeProfile: 'safest' | 'tideAssist' | 'tideDirect' = 'safest',
    opts: { departureMs?: number; tideCeilings?: readonly TideCeiling[] } = {},
    overlayUse: { overlay?: OsmOverlayProvenance } = {},
): Promise<InshoreRouteResult | InshoreRouteFailure | null> {
    const distNM = straightLineNM(origin, destination);
    if (distNM > MAX_INSHORE_NM) {
        log.warn(
            `GATE: route is ${distNM.toFixed(1)} NM — exceeds inshore-router cap of ${MAX_INSHORE_NM} NM, deferring`,
        );
        return null;
    }

    if (!hasEncCoverageForRoute(origin, destination)) {
        log.warn('GATE: No ENC coverage at one or both endpoints — skipping inshore router');
        return null;
    }

    const corridorGap = findCorridorCoverageGap(origin, destination, listCells());
    if (corridorGap) {
        log.warn(
            `GATE: corridor coverage gap ${corridorGap.atNM.toFixed(1)} NM along the direct line, near ${corridorGap.lat.toFixed(3)},${corridorGap.lon.toFixed(3)} — refusing inshore (coverage-gap)`,
        );
        return {
            error: `Trusted inshore ENC coverage is incomplete — gap ~${corridorGap.atNM.toFixed(0)} NM along the route (near ${corridorGap.lat.toFixed(2)}, ${corridorGap.lon.toFixed(2)}). Unverified reference packs cannot clear this safety gate.`,
            code: 'coverage-gap',
        };
    }

    // ── The highest tide per place, BEFORE routing (owner decision 11) ──
    // Shane 2026-10-01: "ok avoid water no tide can clear". The router makes
    // water no tide the app knows clears for this boat impassable, so it needs
    // the tides first: one curve per 0.25° bucket of the route's area, the
    // same 14-day curves (and cache entries) the tide chips read afterwards.
    // Loaded alongside the cells, the OSM water and the marks (fix-up,
    // 2026-10-01: it waited for them, up to 8 s more before every route), and
    // awaited just before the engine runs. A place with no ceiling proves
    // nothing there; where the finished route crosses water a tide must clear
    // in such a place, it says so in one plain caveat (tideCheck).
    // With no network and no boat Pi there is nowhere to load a tide from
    // (the app bundles no tidal planes — searched 2026-10-01; WorldTides via
    // the Pi's cache or the Supabase proxy is the only source): skip the
    // fetches rather than wait out their timeouts before every offline route.
    const tideReachable = piCache.isAvailable() || typeof navigator === 'undefined' || navigator.onLine !== false;
    const tideCeilingsLoad: Promise<readonly TideCeiling[]> = opts.tideCeilings
        ? Promise.resolve(opts.tideCeilings)
        : tideReachable
          ? routeAreaTideCeilings(origin, destination, opts.departureMs ?? Date.now())
                .then((r) => r.ceilings)
                .catch(() => [] as TideCeiling[])
          : Promise.resolve([] as TideCeiling[]);

    // Find every installed cell whose bbox intersects the route's lat/lon
    // envelope. We load them all from device storage and concat features
    // per layer — the engine doesn't care which cell a feature came from.
    const minLat = Math.min(origin.lat, destination.lat);
    const maxLat = Math.max(origin.lat, destination.lat);
    const minLon = Math.min(origin.lon, destination.lon);
    const maxLon = Math.max(origin.lon, destination.lon);
    const candidateCells = cellsForBBox([minLon, minLat, maxLon, maxLat]);
    if (candidateCells.length === 0) {
        log.warn('GATE: No installed cells intersect the route bbox — skipping inshore router');
        return null;
    }

    if (ROUTE_DEBUG)
        log.warn(
            `STAGE: computing inshore route across ${candidateCells.length} cell(s): ${candidateCells.map((c) => c.id).join(',')}`,
        );

    // Merge candidate cells' layers. Pi-cache used to do this server-side;
    // we now do it on the device since iPhone CPU outpaces a Pi 5 several-
    // fold and the cell GeoJSON is already cached in the local Filesystem.
    const merged: InshoreLayers = {
        LNDARE: { type: 'FeatureCollection', features: [] },
        DEPARE: { type: 'FeatureCollection', features: [] },
        OBSTRN: { type: 'FeatureCollection', features: [] },
        WRECKS: { type: 'FeatureCollection', features: [] },
        UWTROC: { type: 'FeatureCollection', features: [] },
        FAIRWY: { type: 'FeatureCollection', features: [] },
        DRGARE: { type: 'FeatureCollection', features: [] },
        BOYLAT: { type: 'FeatureCollection', features: [] },
        BCNLAT: { type: 'FeatureCollection', features: [] },
        // RECTRC — the hydrographer's OFFICIAL recommended track. The engine
        // snaps the route onto it first (authoritative > derived buoy follow).
        RECTRC: { type: 'FeatureCollection', features: [] },
        // NAVLINE is the engine's internal leading-line layer. It receives chart
        // NAVLNE leading lines (CATNAV 3 only, via navLineLeads) and OSM seamark
        // navigation lines below (osmNavLineLeads: never an OSM redraw of a
        // chart clearing or transit line).
        NAVLINE: { type: 'FeatureCollection', features: [] },
        // Survey-quality zones (owner decision 9, 2026-09-30): ranked like the
        // depth bands, read only by the route's survey disclosure.
        M_QUAL: { type: 'FeatureCollection', features: [] },
        // Named sea areas (owner decision 11, 2026-10-01): only to name the
        // water no tide clears when it is the only way through.
        SEAARE: { type: 'FeatureCollection', features: [] },
    };
    const cellsUsed: string[] = [];
    // Cells whose data carries no M_QUAL layer at all ("not extracted"): the
    // route says its survey quality was not checked where one owns it
    // (RouteRequest.surveyUncheckedCells; decision 9, read like decision 8).
    const surveyUncheckedCells: SurveyUncheckedCell[] = [];
    // Cells whose data carries no bridge / overhead-clearance layers (below).
    const structuresUnknownCells: string[] = [];
    // Each such cell's extent: the caveat counts only the cells the ROUTE
    // crosses, not every cell merged for its window (fix-up, 2026-09-30).
    const structuresUnknownBbox = new Map<string, [number, number, number, number]>();
    const structuresUnknownOn = (polyline: readonly [number, number][]): string[] =>
        structuresUnknownCells.filter((id) => {
            const b = structuresUnknownBbox.get(id);
            return !b || polylineTouchesBbox(polyline, b);
        });
    // Chart bridges, overhead cables and overhead pipes (Part B): each one this
    // vessel's mast cannot clear — too low, no charted clearance, or no air
    // draft set — becomes a low-clearance bar below (overheadClearance.ts).
    const chartStructures: Record<ClearanceStructureLayer, GeoJSON.Feature[]> = {
        BRIDGE: [],
        CBLOHD: [],
        PIPOHD: [],
        CONVYR: [],
    };
    // Every chart NAVLNE, BEFORE the lead gate: the OSM merge below needs the
    // dropped clearing and transit lines to spot OSM ways that redraw them.
    const chartNavLines: GeoJSON.Feature[] = [];
    // ENC cardinal marks (BOYCAR/BCNCAR) ride the blob but the layer-merge below omits them,
    // so they're display-only and never reach routing — an East cardinal could end up on the
    // WRONG side of the track. Collect them here, then feed them (with CATCAM direction) into
    // the hazard-orientation path so each is avoided on its SAFE side.
    const encCardinalSrc: {
        geometry?: { type?: string; coordinates?: [number, number] } | null;
        properties?: Record<string, unknown> | null;
    }[] = [];
    // Scale-shadow de-confliction (the Tangalooma tan wall): a 30°×30° overview
    // cell's Moreton Island LNDARE bulges ~500 m over the anchorage the 1°×1°
    // detail cell charts correctly. Overview LNDARE/DEPARE features fully inside
    // a much-finer cell's bbox are dropped — the finer cell owns that ground —
    // so the router never ingests fake land / coarse depth where detail exists.
    const cellExtents = candidateCells.map((c) => ({ id: c.id, bbox: c.bbox }));
    for (const cell of candidateCells) {
        const blob = await loadCellGeoJSON(cell.id);
        if (!blob) {
            log.warn(`cell ${cell.id} listed but GeoJSON not on device — sync via Pi Cache first`);
            continue;
        }
        const shadows = shadowingCells({ id: cell.id, bbox: cell.bbox }, cellExtents);
        // The cell's own scale, for the `_scaleRank` stamp below.
        const scale = cellScaleFacts(cell, blob);
        let shadowDropped = 0;
        // BOYLAT/BCNLAT (lateral marks) feed the Fairlead pass — where the
        // route transits a buoyed channel in open water it follows the
        // red/green marks. Merged from the cells here.
        for (const layer of [
            'LNDARE',
            'DEPARE',
            'OBSTRN',
            'WRECKS',
            'UWTROC',
            'FAIRWY',
            'DRGARE',
            'BOYLAT',
            'BCNLAT',
            'RECTRC',
        ] as const) {
            const fc = blob.layers?.[layer];
            const target = merged[layer];
            if (fc?.features && Array.isArray(fc.features) && target) {
                if ((layer === 'LNDARE' || layer === 'DEPARE') && shadows.length > 0) {
                    const kept = (fc.features as GeoJSON.Feature[]).filter((f) => {
                        const drop = featureIsShadowed(f, shadows);
                        if (drop) shadowDropped++;
                        return !drop;
                    });
                    // Fineness rank for the nav grid's finest-survey-wins
                    // resolution — whole-bbox shadowing above can't drop a
                    // coarse polygon that pokes outside finer coverage.
                    // MIRRORED in assembleTracerLayers.
                    if (SCALE_RANKED_LAYERS.has(layer)) stampScaleRank(kept, scale);
                    (target.features as unknown[]).push(...kept);
                } else {
                    if (SCALE_RANKED_LAYERS.has(layer)) stampScaleRank(fc.features as GeoJSON.Feature[], scale);
                    (target.features as unknown[]).push(...fc.features);
                }
            }
        }
        if (shadowDropped > 0)
            log.warn(`[scaleShadow] ${cell.id}: dropped ${shadowDropped} overview feature(s) shadowed by finer cells`);
        const navlne = (blob.layers as Record<string, FeatureCollection | undefined> | undefined)?.NAVLNE;
        if (navlne?.features && Array.isArray(navlne.features)) {
            // Only CATNAV 3 leading lines may lead. Clearing lines (CATNAV 1)
            // mark the edge of a danger and transits (CATNAV 2) are bearings;
            // both used to be ridden as deep channels. MIRRORED in
            // assembleTracerLayers.
            chartNavLines.push(...navlne.features);
            const leads = navLineLeads(navlne.features, 'NAVLNE');
            (merged.NAVLINE!.features as unknown[]).push(...leads);
            if (ROUTE_DEBUG && leads.length < navlne.features.length)
                log.warn(
                    `STAGE: ${cell.id}: kept ${leads.length}/${navlne.features.length} NAVLNE as leads (clearing/transit/uncategorised lines excluded)`,
                );
        }
        for (const cl of ['BOYCAR', 'BCNCAR'] as const) {
            const fc = (blob.layers as Record<string, FeatureCollection | undefined> | undefined)?.[cl];
            if (fc?.features && Array.isArray(fc.features)) {
                encCardinalSrc.push(...(fc.features as unknown as typeof encCardinalSrc));
            }
        }
        let structuresExtracted = true;
        for (const layer of CLEARANCE_STRUCTURE_LAYERS) {
            const fc = (blob.layers as Record<string, FeatureCollection | undefined> | undefined)?.[layer];
            if (fc?.features && Array.isArray(fc.features)) chartStructures[layer].push(...fc.features);
            else structuresExtracted = false;
        }
        // A cell converted before schema 2 carries no BRIDGE / CBLOHD / PIPOHD / CONVYR
        // key at all ("not extracted" — an empty collection is "none
        // charted"): its bridges and overhead lines cannot gate this route,
        // only the curated bridge file can. Said next to the route
        // (InshoreRouteResult.structuresUnknownCells), never silently
        // (Phase 2a review, 2026-09-30).
        if (!structuresExtracted) {
            structuresUnknownCells.push(cell.id);
            structuresUnknownBbox.set(cell.id, cell.bbox);
        }
        // Survey quality (owner decision 9, 2026-09-30): the cell's M_QUAL
        // zones ranked as its depth bands are, or — no M_QUAL key at all —
        // the cell's extent and rank, so the route can tell "not checked"
        // from "ungraded".
        const mqual = (blob.layers as Record<string, FeatureCollection | undefined> | undefined)?.M_QUAL;
        if (mqual?.features && Array.isArray(mqual.features)) {
            stampScaleRank(mqual.features as GeoJSON.Feature[], scale);
            (merged.M_QUAL!.features as unknown[]).push(...mqual.features);
        } else {
            surveyUncheckedCells.push({ id: cell.id, bbox: cell.bbox, rank: cellFinenessRank(scale) });
        }
        // Named sea areas (decision 11): the refusal names the spot.
        const seaare = (blob.layers as Record<string, FeatureCollection | undefined> | undefined)?.SEAARE;
        if (seaare?.features && Array.isArray(seaare.features)) {
            (merged.SEAARE!.features as unknown[]).push(...seaare.features);
        }
        cellsUsed.push(cell.id);
    }
    if (cellsUsed.length === 0) {
        log.warn('No cells could be loaded from device storage — sync first via the Pi Cache button');
        return null;
    }

    // ── OSM route overlay (fetched BEFORE regional markers) ──
    // Order matters: the regional-marker pair-rejection step (Step 3 of
    // fetchRegionalMarkers) needs to know which polygons OSM calls water
    // even when the chart's LNDARE bleeds across them. Brisbane River is
    // the canonical case: the river is "inside" a coastal LNDARE polygon
    // on the AU SENC, so every legitimate port/starboard midpoint along
    // the shipping channel sits inside that LNDARE and gets rejected.
    // Wiring OSM water into the rejection gate turns those rejections
    // back into accepted pairs and resurrects the FAIRWY ribbon.
    //
    // Fill structural gaps in S-57 ENC data:
    //   - rivers inside coastal landmass (Brisbane River is INSIDE the
    //     mainland LNDARE polygon per the AU chart — OSM water=river makes
    //     the river navigable)
    //   - marina exit channels (chart doesn't tessellate Newport canals
    //     in detail — OSM water=canal + leisure=marina fills them)
    //   - reef extents (chart marks Scarborough Reef as a single UWTROC
    //     point — OSM natural=reef polygon describes the full shape)
    //   - breakwaters (block routing through marina breakwaters when chart
    //     omits them — OSM man_made=breakwater)
    //
    // Pi caches Overpass responses for 7 days per 0.01° bbox tile so most
    // route runs are sub-second. Pi unreachable / no OSM data → empty
    // overlay, router falls back to chart-only behaviour.
    // OSM fetch bbox — matches the engine's wider grid padding (commit
    // a42a2762 + the floor bump that goes with it). The engine pads by
    // max(maxSpan * 0.5, 0.08°); we use a slightly more generous flat
    // 0.10° (≈11 km) here so the OSM water/coastline/aeroway coverage
    // never undershoots the grid's lateral margin. Empty cells in
    // open-bay corridors fall back to chart-DEPARE cleanly anyway, but
    // matching the bbox keeps the diagnostic counts honest.
    const routeBbox = inshoreOverlayBbox(origin, destination);
    let osmOverlay: OsmRouteOverlay | null = null;
    try {
        osmOverlay = await getOsmRouteOverlay(routeBbox);
        overlayUse.overlay = osmOverlay?.provenance;
        // OSM water polygons → DEPARE with synthetic deep DRVAL1 so the
        // router treats them as authoritative navigable (the existing
        // isAuthoritativeDepare gate honours waterway=river/canal/dock
        // and natural=water as authoritative).
        //
        // For wide rivers/harbours, we ALSO push the polygon into FAIRWY
        // with `_promotePreferred: true` so the engine treats it like a
        // chart-authoritative dredged channel: 1.0× cost AND can rescue
        // hard-blocked LNDARE cells inside the polygon. This is what
        // attracts A* INTO the river instead of letting it cut across
        // Bramble Bay / Moreton Bay through generic deep bathymetry.
        const fairwy = merged.FAIRWY ?? { type: 'FeatureCollection' as const, features: [] };
        // DIAGNOSTIC (#19, 2026-05-20): the route cuts a red CAUTION
        // diagonal across Moreton Bay instead of riding the marked deep
        // shipping channel. Is that channel charted as FAIRWY (then the
        // fix is making A* use it) or absent from the chart (then we must
        // synthesise it)? Log the CHART fairways (acronym-bearing — OSM-
        // promoted/synthetic ones don't carry an acronym) whose centroid
        // sits in the Newport→river corridor, so we can see whether a
        // continuous fairway exists through the bay approach.
        if (ROUTE_DEBUG) {
            const corridor = { latMin: -27.43, latMax: -27.17, lonMin: 153.1, lonMax: 153.26 };
            const chartFairwyCentroids: string[] = [];
            let chartFairwyTotal = 0;
            for (const f of fairwy.features as Array<{
                geometry?: { type?: string; coordinates?: unknown };
                properties?: Record<string, unknown> | null;
            }>) {
                if (typeof f.properties?.acronym !== 'string') continue; // skip promoted/synthetic
                chartFairwyTotal++;
                const dim = featureBboxAndSizeM(f);
                if (!dim) continue;
                const cLat = (dim.bbox[1] + dim.bbox[3]) / 2;
                const cLon = (dim.bbox[0] + dim.bbox[2]) / 2;
                if (
                    cLat >= corridor.latMin &&
                    cLat <= corridor.latMax &&
                    cLon >= corridor.lonMin &&
                    cLon <= corridor.lonMax &&
                    chartFairwyCentroids.length < 30
                ) {
                    chartFairwyCentroids.push(
                        `${cLat.toFixed(3)},${cLon.toFixed(3)}(${Math.round(Math.max(dim.widthM, dim.heightM))}m)`,
                    );
                }
            }
            log.warn(
                `STAGE: chart FAIRWY total=${chartFairwyTotal}, in Newport→river corridor=${chartFairwyCentroids.length}: ${chartFairwyCentroids.join(' ') || '(none — bay channel not charted as fairway)'}`,
            );
        }
        // Per-tag promotion counters and the actual promoted features —
        // used by the OSM-promotion diagnostic line below to confirm
        // (a) which OSM tags are doing the work and which are silent,
        // (b) whether the Brisbane River main multipolygon is in the
        // promoted set (would show up as the largest by bbox area).
        const promotionTagCounts: Record<string, number> = {};
        const tagRejectedByWidth: Record<string, number> = {};
        const promotedFeatures: {
            geometry?: { type?: string; coordinates?: unknown };
        }[] = [];
        if (osmOverlay.water.features.length > 0) {
            const depare = merged.DEPARE ?? { type: 'FeatureCollection' as const, features: [] };
            for (const f of osmOverlay.water.features) {
                (depare.features as unknown[]).push({
                    ...f,
                    properties: {
                        ...(f.properties ?? {}),
                        DRVAL1: 10.0, // synthetic — OSM doesn't ship depth
                        DRVAL2: 10.0,
                    },
                });
                // Promote wide rivers/harbours to channel-preferred. The
                // width test rejects suburban stormwater ponds tagged
                // `natural=water` (those would otherwise hand A* a free
                // 1.0× shortcut through a backyard pond). 200 m at the
                // narrowest is the heuristic — comfortably wider than
                // any navigable creek, narrow enough that the Brisbane
                // River's tightest reach (the bend at Bulimba is ~230 m
                // bank-to-bank) still qualifies.
                const props = (f.properties ?? {}) as Record<string, unknown>;
                let tagKey: string | null = null;
                if (props['water'] === 'river') tagKey = 'water=river';
                else if (props['water'] === 'harbour') tagKey = 'water=harbour';
                else if (props['waterway'] === 'river') tagKey = 'waterway=river';
                else if (props['waterway'] === 'riverbank') tagKey = 'waterway=riverbank';
                else if (props['harbour'] === 'yes') tagKey = 'harbour=yes';
                if (tagKey) {
                    if (isPolygonWideEnough(f, 200)) {
                        promotionTagCounts[tagKey] = (promotionTagCounts[tagKey] ?? 0) + 1;
                        promotedFeatures.push(f);
                        (fairwy.features as unknown[]).push({
                            ...f,
                            properties: {
                                ...(f.properties ?? {}),
                                _promotePreferred: true,
                                _source: 'osm-water-promoted',
                            },
                        });
                    } else {
                        tagRejectedByWidth[tagKey] = (tagRejectedByWidth[tagKey] ?? 0) + 1;
                    }
                }
            }
            merged.DEPARE = depare;
        }
        // OSM marina polygons → DEPARE (basin counts as authoritative water).
        if (osmOverlay.marina.features.length > 0) {
            const depare = merged.DEPARE ?? { type: 'FeatureCollection' as const, features: [] };
            for (const f of osmOverlay.marina.features) {
                (depare.features as unknown[]).push({
                    ...f,
                    properties: {
                        ...(f.properties ?? {}),
                        DRVAL1: 5.0, // marinas typically maintained to 5 m
                        DRVAL2: 5.0,
                    },
                });
            }
            merged.DEPARE = depare;
        }
        // OSM marina berth rows (finger pontoons) → BERTH. The nav grid
        // hard-blocks these at FINE resolution only (overriding the
        // marina-authoritative water just injected above), so the marina leg
        // rides the fairway between berth rows instead of over the pens. No
        // buffer, coarse grid unaffected → no marina disconnection.
        if (osmOverlay.berths.features.length > 0) {
            merged.BERTH = osmOverlay.berths as unknown as FeatureCollection;
        }
        if (fairwy.features.length > 0) merged.FAIRWY = fairwy;
        // OSM reef polygons → OBSTRN. Pass 3 rasterises polygon OBSTRN as
        // BLOCKED cells over the whole polygon, so the boat detours the
        // reef's actual extent (not just a 400m point disc).
        if (osmOverlay.reef.features.length > 0) {
            const obstrn = merged.OBSTRN ?? { type: 'FeatureCollection' as const, features: [] };
            for (const f of osmOverlay.reef.features) {
                (obstrn.features as unknown[]).push({
                    ...f,
                    properties: {
                        ...(f.properties ?? {}),
                        _class: 'osm-reef',
                    },
                });
            }
            merged.OBSTRN = obstrn;
        }
        // OSM breakwaters → LNDARE. Same rasterisation as chart LNDARE so
        // A* can't plough through breakwaters when exiting marinas.
        // Polygon variants go into LNDARE (rasterized as area); LineString
        // variants go into COASTLINE (Bresenham-rasterized as a thin strip
        // by pass 2b in the engine).
        if (osmOverlay.breakwater.features.length > 0) {
            const lndare = merged.LNDARE ?? { type: 'FeatureCollection' as const, features: [] };
            const coast = merged.COASTLINE ?? { type: 'FeatureCollection' as const, features: [] };
            for (const f of osmOverlay.breakwater.features) {
                if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') {
                    (lndare.features as unknown[]).push(f);
                } else if (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString') {
                    (coast.features as unknown[]).push(f);
                }
            }
            merged.LNDARE = lndare;
            merged.COASTLINE = coast;
        }
        // OSM aeroway polygons → OBSTRN (NOT LNDARE). Brisbane Airport's
        // eastern runway is built on reclaimed land that postdates the AU
        // SENC charts. OBSTRN hard-blocks unconditionally (no
        // protectedCells check) so the stale chart depth doesn't silently
        // rescue the airport surface.
        //
        // 2026-05-19: I tried adding a full-bbox rectangle to OBSTRN
        // alongside each aerodrome polygon to close the fence-line
        // concavity that A* was threading. The cell trace showed it
        // worked TOO well — it broke connectivity between Moreton Bay
        // (origin component) and the Brisbane River (destination
        // component), because the bbox covered chart-DEPARE cells that
        // formed the only navigable corridor between the two bodies of
        // water (Pinkenba destination ended up 12 km from any cell in
        // the origin component; componentSnap moved it and the visible
        // "airport cut" was actually the post-snap bridge segment).
        //
        // Now just the actual aerodrome polygon plus the smaller runway/
        // taxiway/apron polygons. The fence-line strip A* threads
        // through is the wrong evil — better to thread the strip than
        // isolate the destination.
        //
        // aerodromeBboxFill stays in the log line at 0 so the field
        // remains for future use if we add a smarter fill that respects
        // chart-DEPARE corridors.
        const aerodromeBboxRectsAdded = 0;
        if (osmOverlay.aeroway.features.length > 0) {
            const obstrn = merged.OBSTRN ?? { type: 'FeatureCollection' as const, features: [] };
            for (const f of osmOverlay.aeroway.features) {
                if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') continue;
                (obstrn.features as unknown[]).push({
                    ...f,
                    properties: {
                        ...(f.properties ?? {}),
                        _class: 'osm-aeroway',
                    },
                });
            }
            merged.OBSTRN = obstrn;
        }
        // OSM coastline (natural=coastline) → COASTLINE layer. The engine's
        // pass 2b Bresenham-rasterises each segment as a thin LNDARE strip
        // so A* can't cut across the land/water boundary even where chart
        // LNDARE polygons have gaps (Newport canal estate 2026-05-19).
        if (osmOverlay.coastline.features.length > 0) {
            const coast = merged.COASTLINE ?? { type: 'FeatureCollection' as const, features: [] };
            for (const f of osmOverlay.coastline.features) {
                (coast.features as unknown[]).push(f);
            }
            merged.COASTLINE = coast;
        }
        // OSM canal LineStrings (waterway=canal/fairway/dock) → CANAL layer.
        // The engine Bresenham-rasterises each segment as a 1-cell NAVIGABLE
        // corridor (protected water) — the inverse of COASTLINE. This carves
        // marina exit channels into the grid so canal estates connect to open
        // water across chart LNDARE that tessellates the banks as land at
        // 50 m resolution (Newport Marina exit, 2026-05-20).
        if (osmOverlay.canalLines.features.length > 0) {
            const canal = merged.CANAL ?? { type: 'FeatureCollection' as const, features: [] };
            for (const f of osmOverlay.canalLines.features) {
                (canal.features as unknown[]).push(f);
            }
            merged.CANAL = canal;
        }
        // OSM navigation lines (seamark leading/transit) → NAVLINE layer.
        // The engine Bresenham-rasterises each segment into a PREFERRED
        // channel corridor (wider than CANAL) and rescues shallow-reading
        // cells to navigable — so A* rides the charted dredged channel
        // through bars/approaches the 30 m bathymetry reads as too shallow
        // (Brisbane River mouth bar, 2026-05-20). Unlike CANAL (which just
        // connects islanded water), NAVLINE actively ATTRACTS A* onto the
        // marked channel, weaving the markers like a real chartplotter.
        if (osmOverlay.navLines.features.length > 0) {
            const navline = merged.NAVLINE ?? { type: 'FeatureCollection' as const, features: [] };
            // The Pi and cloud overlay already drop clearing lines; a stray
            // one (an old disk copy) must still never lead. And where the
            // chart has drawn the same line, the chart's category decides: an
            // OSM "transit" lying on a chart CATNAV 2 is that bearing line
            // again, not a lead; only that stretch is cut. RECTRC counts as a
            // chart lead in that weighing. MIRRORED in assembleTracerLayers.
            const osmLeads = osmNavLineLeads(
                osmOverlay.navLines.features,
                chartNavLines,
                merged.RECTRC?.features ?? [],
            );
            for (const f of osmLeads) {
                (navline.features as unknown[]).push(f);
            }
            merged.NAVLINE = navline;
            if (ROUTE_DEBUG)
                log.warn(
                    `STAGE: injected ${osmLeads.length}/${osmOverlay.navLines.features.length} OSM navigation lines → NAVLINE (preferred channel)`,
                );
        }
        // NOTE (2026-05-20): a DRGARE dredged-area "channel connector" lived
        // here — it stitched the chart's dredged-area polygons into one
        // continuous preferred ribbon so A* would ride the dredged channel
        // through the river-mouth bar. It worked, but for a Newport→Pinkenba
        // YACHT it pulled the open-bay run into the big-ship-channel dogleg
        // and added visible wiggle (Shane wanted a straight bay run —
        // "punters will laugh"). Reverted to the straight direct-bay route +
        // RED bar warning, which both sessions agreed is the right call for a
        // yacht (it doesn't need the 10-14 m dredged cut across deep water,
        // and a RED "verify depth at the bar" defers the tide/pilotage call
        // to the skipper). The DRGARE polygons are still individually
        // preferred (engine Pass 4) — we just no longer stitch them into a
        // bay-spanning ribbon. The principled future polish is "lazy
        // corridor": form the channel ONLY where the direct line would
        // actually cross shallow/CAUTION (see docs/ROUTING_COLLAB.md).
        // DIAGNOSTIC — what OSM water/canal/marina features sit near the
        // ORIGIN (±0.025° ≈ 2.5 km). Newport Marina canal estate stays a
        // 349-cell isolated component despite canalLines=65 captured — the
        // carved canal cells are internal estate canals, not a continuous
        // channel bridging the estate to Hays Inlet/Bramble Bay. This dump
        // shows whether OSM even has the exit channel tagged, and as what.
        if (ROUTE_DEBUG) {
            const oLat = origin.lat;
            const oLon = origin.lon;
            const near = (lat: number, lon: number): boolean =>
                Math.abs(lat - oLat) <= 0.025 && Math.abs(lon - oLon) <= 0.025;
            const firstCoord = (f: {
                geometry?: { type?: string; coordinates?: unknown };
            }): [number, number] | null => {
                const g = f.geometry;
                if (!g) return null;
                if (g.type === 'LineString') {
                    const c = (g.coordinates as number[][])[0];
                    return c ? [c[1], c[0]] : null;
                }
                if (g.type === 'Polygon') {
                    const c = (g.coordinates as number[][][])[0]?.[0];
                    return c ? [c[1], c[0]] : null;
                }
                return null;
            };
            const canalNear = osmOverlay.canalLines.features.filter((f) => {
                const g = f.geometry;
                if (g?.type !== 'LineString') return false;
                return (g.coordinates as number[][]).some(([lon, lat]) => near(lat, lon));
            });
            const waterNear = osmOverlay.water.features.filter((f) => {
                const c = firstCoord(f);
                return c ? near(c[0], c[1]) : false;
            });
            const marinaNear = osmOverlay.marina.features.filter((f) => {
                const c = firstCoord(f);
                return c ? near(c[0], c[1]) : false;
            });
            log.warn(
                `STAGE: OSM near ORIGIN (${oLat.toFixed(4)},${oLon.toFixed(4)} ±2.5km) — canalLines=${canalNear.length} water=${waterNear.length} marina=${marinaNear.length}`,
            );
            // Endpoints on STAGE: lines (one canal per line, no leading
            // bullet) so they survive the indent/namespace log filter.
            // Longest canals first — the exit channel is usually a longer
            // run than the residential side-arms. We're hunting for one
            // whose endpoints span from the estate interior (lon ~153.085-
            // 0.10) out toward open water (Hays Inlet lon <153.08, or
            // Bramble Bay to the north/west).
            const canalSorted = [...canalNear].sort(
                (a, b) =>
                    (b.geometry as { coordinates: number[][] }).coordinates.length -
                    (a.geometry as { coordinates: number[][] }).coordinates.length,
            );
            for (let ci = 0; ci < Math.min(15, canalSorted.length); ci++) {
                const coords = (canalSorted[ci].geometry as { coordinates: number[][] }).coordinates;
                const a = coords[0];
                const b = coords[coords.length - 1];
                const props = (canalSorted[ci].properties ?? {}) as Record<string, unknown>;
                log.warn(
                    `STAGE: canal[${ci}] ${props['waterway'] ?? '?'} ${coords.length}pts ${a[1].toFixed(4)},${a[0].toFixed(4)} -> ${b[1].toFixed(4)},${b[0].toFixed(4)}`,
                );
            }
        }
        const promotedCount = fairwy.features.filter(
            (ff) => (ff.properties as Record<string, unknown> | null)?._promotePreferred === true,
        ).length;
        if (ROUTE_DEBUG)
            log.warn(
                `STAGE: OSM overlay merged — water=${osmOverlay.water.features.length} marina=${osmOverlay.marina.features.length} reef=${osmOverlay.reef.features.length} breakwater=${osmOverlay.breakwater.features.length} coastline=${osmOverlay.coastline.features.length} aeroway=${osmOverlay.aeroway.features.length} canalLines=${osmOverlay.canalLines.features.length} aerodromeBboxFill=${aerodromeBboxRectsAdded} promotedFairwy=${promotedCount}`,
            );
        // DIAGNOSTIC — per-tag promotion breakdown. Tells us which OSM
        // tags are doing the work and which are silent. If `water=river`
        // is missing/zero on a Brisbane route, the river is tagged some
        // other way (or the multipolygon isn't assembling) and that's
        // why A* doesn't see a preferred ribbon to follow.
        const tagSummary = Object.entries(promotionTagCounts)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
        const rejectSummary = Object.entries(tagRejectedByWidth)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ');
        if (ROUTE_DEBUG)
            log.warn(
                `STAGE: OSM promotion by tag — ${tagSummary || '(none)'} | rejected-by-width(<200m): ${rejectSummary || '(none)'}`,
            );
        // DIAGNOSTIC — top 3 promoted polygons by bbox area. Brisbane
        // River main multipolygon should be the biggest (~30 km long,
        // covering the whole tidal reach). If the biggest is just a
        // marina basin, the river isn't getting through.
        const promotedWithSize = promotedFeatures
            .map((f) => ({ f, dim: featureBboxAndSizeM(f) }))
            .filter((x): x is { f: typeof x.f; dim: NonNullable<typeof x.dim> } => x.dim != null)
            .sort((a, b) => b.dim.widthM * b.dim.heightM - a.dim.widthM * a.dim.heightM)
            .slice(0, 3);
        if (ROUTE_DEBUG && promotedWithSize.length > 0) {
            log.warn(`STAGE: top promoted polygons by bbox area:`);
            for (const { f, dim } of promotedWithSize) {
                const props = (f as { properties?: Record<string, unknown> }).properties ?? {};
                const name = props['name'] ?? props['water'] ?? props['waterway'] ?? 'unnamed';
                log.warn(
                    `  • ${name} — bbox [${dim.bbox[1].toFixed(3)},${dim.bbox[0].toFixed(3)} → ${dim.bbox[3].toFixed(3)},${dim.bbox[2].toFixed(3)}] ${(dim.widthM / 1000).toFixed(1)}×${(dim.heightM / 1000).toFixed(1)} km`,
                );
            }
        }
        // DIAGNOSTIC — full aeroway inventory with bbox + tag. We need to
        // know whether OSM has the airport's *aerodrome* boundary (one big
        // polygon covering the whole airport including reclaimed runway
        // peninsulas) or just the individual runways/taxiways (thin strips
        // that A* can route around). 2026-05-19: route still cuts the
        // Brisbane Airport peninsula despite aeroway=15 polygons being
        // injected — need to see what those 15 polygons actually cover.
        if (ROUTE_DEBUG && osmOverlay.aeroway.features.length > 0) {
            const aerowayWithSize = osmOverlay.aeroway.features
                .map((f) => ({ f, dim: featureBboxAndSizeM(f) }))
                .filter((x): x is { f: typeof x.f; dim: NonNullable<typeof x.dim> } => x.dim != null)
                .sort((a, b) => b.dim.widthM * b.dim.heightM - a.dim.widthM * a.dim.heightM);
            log.warn(`STAGE: aeroway inventory (${aerowayWithSize.length} polygons):`);
            for (const { f, dim } of aerowayWithSize.slice(0, 10)) {
                const props = (f as { properties?: Record<string, unknown> }).properties ?? {};
                const kind = props['aeroway'] ?? 'unknown';
                const name = props['name'] ?? props['ref'] ?? '(unnamed)';
                log.warn(
                    `  • ${kind} ${name} — bbox [${dim.bbox[1].toFixed(3)},${dim.bbox[0].toFixed(3)} → ${dim.bbox[3].toFixed(3)},${dim.bbox[2].toFixed(3)}] ${(dim.widthM / 1000).toFixed(2)}×${(dim.heightM / 1000).toFixed(2)} km`,
                );
            }
        }
        // DIAGNOSTIC — OSM coverage tight around the destination (±0.05°
        // ≈ 5 km box). If this comes back with low water/coastline/
        // breakwater counts, the destination area is an OSM data desert
        // and we'll need to widen the bbox or supplement.
        const destBbox: [number, number, number, number] = [
            destination.lon - 0.05,
            destination.lat - 0.05,
            destination.lon + 0.05,
            destination.lat + 0.05,
        ];
        const overlapsDest = (f: { geometry?: { type?: string; coordinates?: unknown } }): boolean => {
            const dim = featureBboxAndSizeM(f);
            if (!dim) return false;
            const [minLon, minLat, maxLon, maxLat] = dim.bbox;
            return minLon <= destBbox[2] && maxLon >= destBbox[0] && minLat <= destBbox[3] && maxLat >= destBbox[1];
        };
        // coastline features are LineStrings — bbox check via a
        // dedicated mini-helper since featureBboxAndSizeM only handles
        // polygons.
        const lineStringInDestBbox = (f: { geometry?: { type?: string; coordinates?: unknown } }): boolean => {
            const g = f.geometry;
            if (!g || (g.type !== 'LineString' && g.type !== 'MultiLineString')) return false;
            const lines: number[][][] =
                g.type === 'LineString' ? [g.coordinates as number[][]] : (g.coordinates as number[][][]);
            for (const line of lines) {
                for (const v of line) {
                    if (v[0] >= destBbox[0] && v[0] <= destBbox[2] && v[1] >= destBbox[1] && v[1] <= destBbox[3]) {
                        return true;
                    }
                }
            }
            return false;
        };
        const destOsmCounts = {
            water: osmOverlay.water.features.filter(overlapsDest).length,
            marina: osmOverlay.marina.features.filter(overlapsDest).length,
            reef: osmOverlay.reef.features.filter(overlapsDest).length,
            breakwater: osmOverlay.breakwater.features.filter((f) => overlapsDest(f) || lineStringInDestBbox(f)).length,
            coastline: osmOverlay.coastline.features.filter(lineStringInDestBbox).length,
        };
        if (ROUTE_DEBUG)
            log.warn(
                `STAGE: OSM coverage ±0.05° around dest (${destination.lat.toFixed(4)},${destination.lon.toFixed(4)}) — water=${destOsmCounts.water} marina=${destOsmCounts.marina} reef=${destOsmCounts.reef} breakwater=${destOsmCounts.breakwater} coastline=${destOsmCounts.coastline}`,
            );
    } catch (err) {
        log.warn(
            `OSM overlay fetch failed (continuing chart-only): ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    // ── Mapbox vector water — the canal/marina channels the ENC omits ──
    // The breakthrough (2026-06-18): the ENC charts marina lots as land and
    // never charts the navigable channels between them, so the router clipped
    // the lots (Newport's 427 m "barrier"). But Mapbox's `water` layer — which
    // we already render on every frame — has the full channel network (verified
    // 59% water over the Newport marina, the canal intact, a point the ENC calls
    // land sitting inside Mapbox water). Inject those polygons as authoritative
    // DEPARE water (natural=water ⇒ un-blocks the LNDARE bleed + protected +
    // navigable), so the fine canal tier routes the REAL channels — the data
    // Navionics sells, that we already load. Scoped to ~1.3 km crops around
    // origin+dest (marinas live at the route endpoints) to bound the z16 tile
    // count; the deep open bay in the route middle is never touched.
    try {
        const mapboxToken = (import.meta.env.VITE_MAPBOX_ACCESS_TOKEN as string | undefined) ?? '';
        if (mapboxToken) {
            // Nearshore corridor crop: a marina/canal exit follows the route OUT,
            // not a tight disc — so extend each endpoint's crop ~4 km TOWARD the
            // other endpoint (covering the winding channel), padded ~1.2 km
            // perpendicular. This reaches the canal without the tile count a big
            // square crop would cost, and the deep open bay in the middle is still
            // never fetched.
            const REACH_M = 4000;
            const PERP_DEG = 0.011; // ~1.2 km perpendicular margin
            const corridorCrop = (
                a: { lat: number; lon: number },
                b: { lat: number; lon: number },
            ): [number, number, number, number] => {
                const cosLat = Math.cos((a.lat * Math.PI) / 180) || 1;
                const dLat = b.lat - a.lat;
                const dLon = (b.lon - a.lon) * cosLat;
                const len = Math.hypot(dLat, dLon) || 1;
                const reachDeg = REACH_M / 111_320;
                const far = {
                    lat: a.lat + (dLat / len) * reachDeg,
                    lon: a.lon + ((dLon / len) * reachDeg) / cosLat,
                };
                return [
                    Math.min(a.lon, far.lon) - PERP_DEG,
                    Math.min(a.lat, far.lat) - PERP_DEG,
                    Math.max(a.lon, far.lon) + PERP_DEG,
                    Math.max(a.lat, far.lat) + PERP_DEG,
                ];
            };
            const endpointCrops: [number, number, number, number][] = [
                corridorCrop(origin, destination),
                corridorCrop(destination, origin),
            ];
            // Prefer SATELLITE-classified water (the TRUE canal shape) over the
            // coarse OSM vector `water` layer — the vector outline is what threw
            // routeMarina's centreline off. Satellite is tier-1 only (these
            // endpoint crops); the open bay is never fetched. Fall back to the
            // vector water per-crop on any satellite failure, so the canal is never
            // LESS routable than today.
            const waterFCs = await Promise.all(
                endpointCrops.map(async (b) => {
                    try {
                        const sat = await fetchSatelliteWater(b, mapboxToken);
                        if (sat.features.length > 0) {
                            log.warn(`SAT WATER: ${sat.features.length} water polygons from satellite (crop)`);
                            return sat;
                        }
                    } catch (e) {
                        log.warn(`SAT WATER failed, falling back to vector: ${e instanceof Error ? e.message : e}`);
                    }
                    return fetchMapboxWater(b, mapboxToken);
                }),
            );
            const mapboxWater = waterFCs.flatMap((fc) => fc.features);
            if (mapboxWater.length > 0) {
                const depare = merged.DEPARE ?? { type: 'FeatureCollection' as const, features: [] };
                for (const f of mapboxWater) {
                    (depare.features as unknown[]).push({
                        ...f,
                        properties: {
                            ...(f.properties ?? {}),
                            // → isAuthoritativeDepare: un-blocks LNDARE-bleed, sets
                            //   protected + osmVouched. Moderate synthetic depth
                            //   (marina/river realistic; the open bay isn't in crop).
                            natural: 'water',
                            _source: 'mapbox-water',
                            DRVAL1: MAPBOX_WATER_DEPTH_M,
                            DRVAL2: MAPBOX_WATER_DEPTH_M,
                        },
                    });
                }
                merged.DEPARE = depare;
                log.warn(`MAPBOX WATER: injected ${mapboxWater.length} water polygons → DEPARE (origin+dest crops)`);
            }
        }
    } catch (err) {
        log.warn(
            `Mapbox water fetch failed (continuing chart-only): ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    // ── Low-clearance structures (air-draft gating) ──
    // A bridge, overhead cable or overhead pipe this vessel's mast cannot
    // clear is LAND for this vessel (owner decisions 2026-09-29/30,
    // services/routing/overheadClearance.ts): clearance below air draft + 1 m,
    // no charted clearance, an opening bridge that does not clear closed, or
    // NO AIR DRAFT SET — then every one blocks, since nothing can be checked.
    // Two sources, one verdict: the chart's S-57 BRIDGE / CBLOHD / PIPOHD / CONVYR, and
    // the curated bridges-au.json (lowBridges), which stays an extra source.
    // Each becomes thin `_class:'low-clearance'` OBSTRN bars: the grid
    // hard-blocks them, no rescue/carve pass may tunnel them, the canal
    // centre-line network is severed across them (tierPipeline), and the
    // engine refuses any final route that still passes under one, naming it.
    {
        const bars: GeoJSON.Feature[] = [...chartClearanceBars(chartStructures, airDraftM)];
        try {
            const { loadLowBridges } = await import('./lowBridges');
            bars.push(...curatedClearanceBars(await loadLowBridges(), airDraftM));
        } catch (err) {
            log.warn(
                `[airDraft] curated bridge data unavailable (chart structures still gate): ${err instanceof Error ? err.message : String(err)}`,
            );
        }
        if (bars.length > 0) {
            const obstrn = merged.OBSTRN ?? { type: 'FeatureCollection' as const, features: [] };
            (obstrn.features as unknown[]).push(...bars);
            merged.OBSTRN = obstrn;
            const named = new Map<unknown, string>();
            for (const f of bars) {
                const p = f.properties as ClearanceBarProperties;
                if (!named.has(p._span))
                    named.set(
                        p._span,
                        `${p._name ?? p._structure} (${p._source}, ${p._block}${p._clearanceM !== null ? ` ${p._clearanceM.toFixed(1)} m` : ''})`,
                    );
            }
            log.warn(
                `[airDraft] ${named.size} structure(s) BLOCKED for air draft ${airDraftM !== null && airDraftM > 0 ? `${airDraftM.toFixed(1)} m` : 'NOT SET'}: ${[...named.values()].slice(0, 12).join(', ')}${named.size > 12 ? ', …' : ''}`,
            );
        }
    }

    // ── Regional nav-markers (lateral buoys/beacons) ──
    // The app already loads this file for chart display (useMapInit.ts).
    // For routing we re-fetch it and convert port/starboard markers to
    // BOYLAT features — the engine uses them to mark cells in a radius
    // as "preferred", so chains of markers naturally form a channel
    // corridor that A* follows.
    //
    // For now we only have one regional file (SE QLD). Future regions
    // will live at parallel URLs and the lookup table can grow.
    const regionalMarkersUrl = await pickRegionalMarkersUrl(origin, destination);
    // Step-3 accepted pairs, captured for the Seaway shadow's tier-2
    // gates (regionalGates, 0.7). Stays empty when the regional fetch is
    // skipped or fails — the shadow compiles chart + geometric tiers only.
    let regionalPairsForShadow: RegionalChannelData['acceptedPairs'] = [];
    // OSM regional solo/cardinal hazard markers (SE-QLD marker file) — empty outside
    // that file's bbox; the ENC cardinal fold below runs EITHER WAY.
    let osmRegionalHazards: { geometry?: { coordinates?: [number, number] } }[] = [];
    // ── ENC lateral fold — REGION-INDEPENDENT (like the cardinal fold below).
    // Chart BCNLAT/BOYLAT with CATLAM 1 (port) / 2 (starboard) enter the same
    // cluster/pair pipeline as the regional file's marks: the Mooloolah River
    // carries 15 ENC beacons and 2 OSM marks, so without this the route never
    // threaded the red/green pairs out of the channel (Shane, 2026-07-02).
    // CATLAM 3/4 (preferred-channel) stay out of the simple fold — they carry
    // side semantics the mixed-pair machinery handles from the file's classes.
    const encLaterals = encLateralsFromFeatures([
        ...(merged.BCNLAT?.features ?? []),
        ...(merged.BOYLAT?.features ?? []),
    ]);
    if (regionalMarkersUrl || encLaterals.length > 0) {
        try {
            // Combined OSM water+marina list. Used inside the pair loop
            // as a tie-breaker against LNDARE-bleed: if the midpoint of
            // a port/starboard pair falls inside an over-bleeding LNDARE
            // polygon BUT also inside an OSM water polygon (river /
            // marina basin), trust OSM and accept the pair.
            const osmWaterForPairing = osmOverlay ? [...osmOverlay.water.features, ...osmOverlay.marina.features] : [];
            const { midpoints, segments, hazards, wings, acceptedPairs } = await fetchRegionalMarkers(
                regionalMarkersUrl,
                merged.LNDARE?.features ?? [],
                osmWaterForPairing,
                // Charted water (DEPARE depth areas + DRGARE dredged areas) is
                // the chart's own "this is navigable water" — it overrides the
                // AU SENC's bleeding LNDARE so buoyed-channel pairs survive
                // OFFLINE, when the Pi's OSM-water overlay is absent. ENC truth
                // beats OSM. This is the Newport→Scarborough fix.
                [...(merged.DEPARE?.features ?? []), ...(merged.DRGARE?.features ?? [])],
                encLaterals,
            );
            regionalPairsForShadow = acceptedPairs;
            if (midpoints.length > 0) {
                const boylat = merged.BOYLAT ?? { type: 'FeatureCollection' as const, features: [] };
                (boylat.features as unknown[]).push(...midpoints);
                merged.BOYLAT = boylat;
            }
            if (segments.length > 0) {
                const fairwy = merged.FAIRWY ?? { type: 'FeatureCollection' as const, features: [] };
                (fairwy.features as unknown[]).push(...segments);
                merged.FAIRWY = fairwy;
            }
            osmRegionalHazards = hazards as { geometry?: { coordinates?: [number, number] } }[];
            if (wings.length > 0) {
                // Step 4.5 outboard CAUTION wings (masterplan Phase 3). They
                // travel in OBSTRN but the engine's Pass 3 skips them — only
                // Pass 5c rasterises them, to CAUTION + preferred=0.
                const obstrn = merged.OBSTRN ?? { type: 'FeatureCollection' as const, features: [] };
                (obstrn.features as unknown[]).push(...wings);
                merged.OBSTRN = obstrn;
            }
            if (ROUTE_DEBUG)
                log.warn(
                    `STAGE: merged ${midpoints.length} midpoints + ${segments.length} FAIRWY segments + ${hazards.length} IALA-oriented hazards + ${wings.length} pair-wings`,
                );
        } catch (err) {
            log.warn(
                `regional markers fetch failed (continuing without): ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    // Fold ENC cardinals (BOYCAR/BCNCAR) into the hazard set — REGION-INDEPENDENT.
    // (This used to live inside the regionalMarkersUrl gate above, which matches a single
    // SE-QLD bbox — so a route past a cardinal in Sydney, NZ or the US got NO cardinal
    // honouring even with full ENC cells installed. The ENC path needs nothing from the
    // OSM marker file; it only DEDUPES against its hazards when they exist.)
    // The ENC cardinal WINS over a co-located OSM marker (~11 m grid): the OSM seamark
    // feed often tags the same buoy as a directionLESS 'cardinal', which
    // orientHazardsTowardLand can only orient toward SHORE — wrong side. The ENC mark
    // carries CATCAM → _osmClass='cardinal_<nesw>', so it gets a true directional disc.
    try {
        const encCardinalHazards = encCardinalsToHazards(encCardinalSrc, new Set());
        const encCardinalKeys = new Set<string>(
            encCardinalHazards.map((h) => {
                const [lon, lat] = h.geometry.coordinates;
                return `${lat.toFixed(4)}|${lon.toFixed(4)}`;
            }),
        );
        const filteredOsmHazards = osmRegionalHazards.filter((hh) => {
            const c = hh.geometry?.coordinates;
            return c ? !encCardinalKeys.has(`${c[1].toFixed(4)}|${c[0].toFixed(4)}`) : true;
        });
        const allHazards = [...(filteredOsmHazards as unknown[]), ...encCardinalHazards];
        if (allHazards.length > 0) {
            // IALA orientation: for each solo hazard marker, the hazard sits between
            // the marker and the nearest shore (reef edge, isolated rock, shoal).
            // Boats pass on the SEAWARD side. We turn each Point hazard into a
            // half-circle Polygon facing land — engine blocks the shore-side cells,
            // leaving the seaward side open. Symmetric full-circle buffering can't do
            // this; it blocks both sides equally and A* picks the shorter side, which
            // is often the wrong (shore) side.
            const lndareForOrientation = merged.LNDARE?.features ?? [];
            const orientedHazards = orientHazardsTowardLand(
                allHazards as {
                    geometry: { type: 'Point'; coordinates: [number, number] };
                    properties?: unknown;
                }[],
                lndareForOrientation,
            );
            const obstrn = merged.OBSTRN ?? { type: 'FeatureCollection' as const, features: [] };
            (obstrn.features as unknown[]).push(...orientedHazards);
            merged.OBSTRN = obstrn;
        }
    } catch (err) {
        log.warn(`ENC cardinal fold failed (continuing without): ${err instanceof Error ? err.message : String(err)}`);
    }

    // ── Curated marina fairways ──────────────────────────────────────────
    // Hand-drawn navigable lanes (services/curatedFairways.ts) for marinas
    // whose exit fairway isn't charted — injected as waterway=fairway CANAL
    // lines so the wharf-start rides the lane between the pens instead of the
    // coarse A* slice over them. Bbox-gated: a no-op away from a curated marina.
    const curatedFairways = curatedFairwayCanalFeatures(routeBbox);
    if (curatedFairways.length > 0) {
        const canal = merged.CANAL ?? { type: 'FeatureCollection' as const, features: [] };
        (canal.features as unknown[]).push(...curatedFairways);
        merged.CANAL = canal;
        if (ROUTE_DEBUG) log.warn(`STAGE: injected ${curatedFairways.length} curated marina fairway line(s)`);
    }

    // ── NtM routing packs — surveyed-depth zones (ack- AND currency-gated) ──
    // Acknowledged, still-current notice surveys (services/ntmRouting.ts) join
    // the engine blob as NTMZONE; the navGrid NTM pass stamps their surveyed
    // least depths over the chart edition. Fail-quiet and fail-CLOSED: any
    // error, a superseded/unverified notice, or a missing acknowledgment means
    // NO injection — the notice stays an advisory icon. The pad keeps a bar
    // zone sitting just outside the endpoint lat/lon envelope in scope (the
    // Mooloolah entrance lies EAST of both the wharf and Newport).
    try {
        const { activeNtmZonesFor } = await import('./ntmRouting');
        // Pad with the ENGINE's OWN grid formula (inshoreRouterEngine bbox:
        // max(span·0.5, 0.08°)) — a fixed 0.02° pad silently dropped packs
        // that sat inside the grid but outside the endpoint envelope (an
        // upriver start whose only exit crosses the bar), while the popup
        // still claimed "applied". Adversarial-review finding #0.
        const ntmPad = Math.max(Math.max(maxLat - minLat, maxLon - minLon) * 0.5, 0.08);
        const ntm = await activeNtmZonesFor([minLon - ntmPad, minLat - ntmPad, maxLon + ntmPad, maxLat + ntmPad]);
        if (ntm.features.length > 0) {
            merged.NTMZONE = { type: 'FeatureCollection', features: ntm.features };
        }
        // NtM PROMULGATED BAR TRANSIT (task #26 — the origin-side splice).
        // The REF-mark alternative track goes into its OWN layer (NTMBAR),
        // NEVER into NAVLINE. That distinction is load-bearing: injected as a
        // global leadingLine on 2026-07-03 it perturbed tier ordering 40 NM
        // away (a 1.59 NM drying crossing replaced the clean Newport
        // approach) AND never achieved the REF ride anyway (nothing spliced
        // an origin-side transit). The tier pipeline now rides this layer as
        // a FINAL, origin-scoped post-pass (spliceNtmBarTransit): it can only
        // reshape the bar-crossing leg where the route actually starts/ends at
        // this bar, and is inert everywhere else. Depth honesty is untouched —
        // the NTMZONE pass above still stamps surveyed least depths, so a
        // sub-floor cell on the ridden transit stays CAUTION/red + tide-chip.
        if (ntm.tracklines.length > 0) {
            merged.NTMBAR = { type: 'FeatureCollection', features: ntm.tracklines };
        }
    } catch (err) {
        log.warn(
            `[ntmRouting] zone injection failed (continuing without): ${err instanceof Error ? err.message : String(err)}`,
        );
    }

    // safetyM=0.5 — the owner's keel margin ("always 1/2 m deeper than our keel",
    // Shane 2026-07-02, matching the confirmed tideSafetyM=0.5 bar margin). Water the
    // chart puts inside draft+0.5 m at LAT costs 40× and renders red. Was 0.2 (chosen
    // against 1 m-banded DEPARE discretisation noise: a 1 m safety re-blocked the 2 m
    // band for a 1.8 m draft); 0.5 accepts that a shallow-draft boat now sees the
    // NEXT 1 m band flagged when its draft sits within 0.5 m of a band edge — that is
    // the honest read of the owner's margin, not noise. Chart datum is LAT; tide
    // credit stays the departure-sweep's job, never geometry's.
    if (ROUTE_DEBUG)
        log.warn(
            `STAGE: loaded ${cellsUsed.join(',')} — LNDARE=${merged.LNDARE?.features.length ?? 0} DEPARE=${merged.DEPARE?.features.length ?? 0} OBSTRN=${merged.OBSTRN?.features.length ?? 0} FAIRWY=${merged.FAIRWY?.features.length ?? 0} COASTLINE=${merged.COASTLINE?.features.length ?? 0}, calling routeInshore`,
        );
    // The tides started loading with the cells (above).
    const tideCeilings = await tideCeilingsLoad;
    /** The finished route crosses water a tide must clear where no tide was
     *  loaded (fix-up, 2026-10-01): offline, a bucket past the cap, a fetch
     *  that timed out. Only then the caveat — an all-deep route never needed
     *  a tide, and a partial load used to say nothing. */
    const tideUnchecked = (polyline: readonly [number, number][]): boolean =>
        routeCrossesUncheckedShallow(merged, polyline, tideCeilingLookup(tideCeilings), draftM + routeOpts.safetyM);
    log.warn(
        `[noTide] ${tideCeilings.length} place(s) with a tide ceiling for this route${tideCeilings.length > 0 ? `: ${tideCeilings.map((c) => `${c.lat.toFixed(2)},${c.lon.toFixed(2)} top ${c.highestM.toFixed(2)} m / ${c.days} d`).join('; ')}` : ' — water no tide clears cannot be proved here'}`,
    );

    // 60 m hazard buffer (engine default 30 m).
    //
    // 100 m made things WORSE — at that radius, seaward hazards'
    // buffers overlapped into a giant offshore no-go blob, and
    // A* fell back to a shore-side path because that side had
    // fewer overlapping buffers (user 2026-05-12: "went back
    // closer to land again").
    //
    // 60 m is the empirical sweet spot — overlaps into
    // contiguous no-go strips along hazard chains, but doesn't
    // over-block the deep-water side.
    const routeOpts = {
        fromLat: origin.lat,
        fromLon: origin.lon,
        toLat: destination.lat,
        toLon: destination.lon,
        draftM,
        safetyM: 0.5,
        obstructionBufferM: 60,
        // LIVE routes never treat no-evidence space as clean water: cells
        // nothing vouches for flag red, and >1 NM unvouched runs refuse
        // with 'uncharted-corridor' (reply 16 structural fix; the engine
        // default stays permissive for fixtures/harbour-corridor callers).
        unchartedPolicy: 'strict',
        // 'tideAssist' = the user's EXPLICIT shortest option (PassageBanner
        // chip): recoverable caution (wet at LAT, rise ≤ 1.8 m) prices 10×
        // and ships with tide-window chips. Part of the grid cache key.
        routeProfile,
        // The cells with no M_QUAL layer (survey disclosure, decision 9).
        surveyUncheckedCells,
        // The highest tide per place (decision 11): water no tide clears is
        // impassable. Part of the grid cache key.
        ...(tideCeilings.length > 0 ? { tideCeilings } : {}),
    } as const;

    // ── Cloud-first: try Pi-cache before falling back to on-device ──
    // On-device A* on iPhone JS engine takes 20-36 s for a 15 NM route
    // (measured 2026-05-12). The same A* code mirrored to Pi-cache
    // runs maybe 5-10× faster on the Pi 5's V8 because it has more
    // RAM, faster JIT warmup, and no UI thread to share with.
    // We POST the iOS-prepped merged blob (cells + synthesised FAIRWY
    // ribbons + IALA-oriented hazards + paired-marker midpoints) and
    // let the Pi run A* over it. Falls through to the local compute
    // path if the Pi is unreachable, times out, or 5xx-errs.
    const t0 = Date.now();
    let result: ReturnType<typeof routeInshore> | null = null;
    let routedOnCloud = false;
    const piAvailable = piCache.isAvailable();
    if (ROUTE_DEBUG)
        log.warn(
            `STAGE: cloud router gate — CLOUD_ROUTER_ENABLED=${CLOUD_ROUTER_ENABLED} piCache.isAvailable()=${piAvailable} baseUrl=${piCache.baseUrl}`,
        );
    if (CLOUD_ROUTER_ENABLED && piAvailable) {
        try {
            const cloudT0 = Date.now();
            // Signature-verified with a request binding: this polyline is the
            // course the boat follows, and every route request shares one
            // path — without binding the from/to/draft tuple a genuine signed
            // route from another voyage could be replayed onto this one.
            const routeBody = { ...routeOpts, layers: merged };
            const binding = await routeRequestBinding(routeBody as unknown as Record<string, unknown>);
            const res = await fetchVerifiedFromPi<Record<string, unknown>>({
                url: `${piCache.baseUrl}/api/enc/route-prepped`,
                method: 'POST',
                data: routeBody,
                connectTimeout: 5000,
                // 90 s read timeout. The Pi 5's V8 is comparable to (not
                // dramatically faster than) the iPhone JS engine for
                // single-threaded A* over a 200×400 grid with 660+ hazard
                // polygons. Empirically iOS-local landed at 26-47 s, so a
                // 25 s cap was triggering before the Pi ever finished.
                // 90 s lets the Pi return its result; the user can still
                // get a local-fallback result by killing/reissuing the
                // request if the Pi is genuinely unresponsive.
                // 8 s read timeout. Was 90 s, which caused the UI to
                // hang for a full 90 seconds when Pi-cache was slow or
                // unresponsive (user reported "screen hangs with no
                // picture, pinch to unblock"). Pi-cache running the same
                // engine has the same grid-build cost on cold caches —
                // there's no scenario where it should beat a warm local
                // cache. If cloud doesn't respond in 8 s, the local
                // fallback (which now hits the grid cache for repeated
                // routes) will be faster anyway.
                readTimeout: 8000,
                requestBinding: binding,
            });
            const cloudMs = Date.now() - cloudT0;
            if (res && typeof res === 'object') {
                const data = res as Record<string, unknown>;
                if ('error' in data) {
                    log.warn(
                        `cloud router returned 200 with error payload — falling back to local: ${String(data.error)}`,
                    );
                } else if (Array.isArray(data.polyline) && typeof data.distanceNM === 'number') {
                    result = {
                        polyline: data.polyline as [number, number][],
                        distanceNM: data.distanceNM,
                    } as ReturnType<typeof routeInshore>;
                    routedOnCloud = true;
                    if (ROUTE_DEBUG) log.warn(`STAGE: cloud A* returned in ${cloudMs} ms (Pi-cache)`);
                }
            } else {
                log.warn('cloud router returned an unrecognised payload — falling back to local');
            }
        } catch (err) {
            // CapacitorHttp surfaces both "connect timeout" and "read
            // timeout" as the same generic "The request timed out."
            // string, which doesn't tell us whether the Pi is
            // unreachable or just slow. Heuristic from the configured
            // 5s connect / 8s read above:
            //   • elapsed ~5000 ms → connect timeout (Pi unreachable —
            //     check piCache.isAvailable() liveness probe)
            //   • elapsed ~8000 ms → read timeout (Pi reachable but
            //     A* compute is slower than the budget — the Pi-side
            //     buildNavGrid is probably hitting the same 37s wall
            //     we just instrumented locally)
            //   • elapsed < 1000 ms → DNS / network refused / no route
            const cloudElapsed = Date.now() - t0;
            const kind =
                cloudElapsed < 1000
                    ? 'network-refused'
                    : cloudElapsed < 6000
                      ? 'connect-timeout (Pi unreachable)'
                      : cloudElapsed < 9000
                        ? 'read-timeout (Pi reached but A* too slow)'
                        : 'other';
            log.warn(
                `cloud router request failed after ${cloudElapsed}ms — ${kind} — (${err instanceof Error ? err.message : String(err)}) — falling back to local`,
            );
        }
    } else if (!CLOUD_ROUTER_ENABLED) {
        if (ROUTE_DEBUG)
            log.warn(
                `STAGE: cloud router skipped — CLOUD_ROUTER_ENABLED=false (iOS local A* is the source of truth until pi-cache engine is synced)`,
            );
    } else {
        if (ROUTE_DEBUG)
            log.warn(`STAGE: cloud router skipped — piCache not available (probe failed or disabled in settings)`);
    }

    if (!result) {
        try {
            result = routeInshore(merged, routeOpts);
        } catch (err) {
            log.warn(`local inshore route compute threw: ${err instanceof Error ? err.message : String(err)}`);
            return null;
        }
    }
    const elapsedMs = Date.now() - t0;
    const computeWhere = routedOnCloud ? 'cloud' : 'local';

    if ('error' in result) {
        log.warn(`inshore router failed: ${result.error} (${result.code ?? 'no code'})`);
        return {
            error: result.error,
            code: result.code,
            cellsUsed,
        };
    }

    // Success telemetry at info-level (no-op'd in production builds; the
    // outer tryInshoreRoute wrapper logs a concise EXIT line at warn).
    log.info(
        `SUCCESS inshore route ${result.distanceNM.toFixed(2)} NM (${result.polyline.length} pts, ${elapsedMs} ms ${computeWhere}, cells: ${cellsUsed.join(',')})`,
    );
    // TEMP diag (2026-06-19): which segmentation actually RENDERED? The [tiers]
    // ENGAGED lines log every attempt (strict / relaxed / shadow); this is the
    // ONE that won — its provenance tells us whether the canal span rendered as
    // finegrid or fell back to a coarse tier-3 passthrough.
    log.warn(
        `RENDERED ROUTE prov="${(result as { debug?: { threeTier?: string } }).debug?.threeTier ?? 'n/a'}" (${result.distanceNM.toFixed(1)} NM, ${result.polyline.length} pts)`,
    );
    // Full polyline vertex dump (lat,lon) — see exactly where the route
    // runs without eyeballing the rendered map.
    if (ROUTE_DEBUG)
        log.warn(
            `STAGE: polyline — ${result.polyline.map((p) => `${p[1].toFixed(4)},${p[0].toFixed(4)}`).join('  →  ')}`,
        );
    // Per-phase timing breakdown from the engine (only for local
    // computes — cloud results don't pass timings through yet).
    if (ROUTE_DEBUG) {
        const phaseTimings = (result as { phaseTimings?: Record<string, number> }).phaseTimings;
        if (phaseTimings && Object.keys(phaseTimings).length > 0) {
            const breakdown = Object.entries(phaseTimings)
                .map(([k, v]) => `${k}=${v}ms`)
                .join(' ');
            log.warn(`STAGE: engine phase timings — ${breakdown}`);
        }
    }

    // What Auto must know of how the route was made (2026-10-01 review):
    // the relax zones it was built with, and whether tides were loaded.
    const relaxZonesUsed = result.debug?.relaxZones;
    const routeContext = {
        ...(relaxZonesUsed && relaxZonesUsed.length > 0
            ? { relaxZones: relaxZonesUsed.map((z) => ({ lat: z.lat, lon: z.lon, radiusM: z.radiusM })) }
            : {}),
        tideCeilingsLoaded: tideCeilings.length > 0,
    };

    // ── Lead-graph SHADOW (Phase 3, 2026-10-01) ──────────────────────
    // Placed BEFORE the Seaway block, not after it: a promoted Seaway route
    // returns early from that block, and the shadow must see every local
    // route. It reads the route's own cached grid (never builds one) and the
    // lead graph ONLY if the chart overlay has already compiled it for these
    // charts (peekLeadGraphForView) — on a miss it logs 'no-graph' and stops.
    // Review fix-up (2026-10-01): it used to compile the graph on a miss —
    // the normal case, the overlay is off by default — reading every cell
    // under the route again, inside the 85 s watchdog and beside the
    // engine's peak grid memory; and its await let an overdue watchdog fire
    // before a finished route was delivered. Synchronous now, no await.
    // try/catch: a shadow failure never reaches the route.
    if (LEAD_GRAPH_SHADOW_ENABLED && !routedOnCloud) {
        try {
            const tLead = Date.now();
            const grid = routeCachedGrid(merged, routeOpts, result);
            let w = Math.min(origin.lon, destination.lon);
            let sLat = Math.min(origin.lat, destination.lat);
            let e = Math.max(origin.lon, destination.lon);
            let n = Math.max(origin.lat, destination.lat);
            for (const [lon, lat] of result.polyline) {
                w = Math.min(w, lon);
                e = Math.max(e, lon);
                sLat = Math.min(sLat, lat);
                n = Math.max(n, lat);
            }
            const leadGraph = grid ? peekLeadGraphForView([w, sLat, e, n], routeOpts.draftM, false, airDraftM) : null;
            const tGraph = Date.now() - tLead;
            if (grid && !leadGraph) {
                log.warn(`LEAD SHADOW: no-graph — not compiled for these charts; skipped (lookup ${tGraph}ms)`);
            } else {
                const report = searchLeadGraph({ grid, graph: leadGraph, origin, destination, direct: result });
                const marks = [
                    ...(merged.BOYLAT?.features ?? []),
                    ...(merged.BCNLAT?.features ?? []),
                ] as PointFeatureLike[];
                const { chartFeatures, unnumberedMarks } = splitMarkFeatures(marks);
                const gates =
                    report.route && chartFeatures.length + unnumberedMarks.length > 0
                        ? compileSeawayGraph({ chartFeatures, unnumberedMarks }).graph.gates
                        : [];
                const verdict = leadPromotionVerdict(report, result, merged, {
                    checks: {
                        blockReason: (r: typeof result) =>
                            seawayPromotionBlockReason(r as Parameters<typeof seawayPromotionBlockReason>[0]),
                        safetyFault: (polyline, layers, r, strict, noTide) =>
                            seawayGraphSafetyFault(
                                polyline,
                                layers,
                                r as Parameters<typeof seawayGraphSafetyFault>[2],
                                strict,
                                noTide,
                            ),
                    },
                    needM: routeOpts.draftM + routeOpts.safetyM,
                    tideCeilings,
                    ...(grid ? { grid } : {}),
                    strict: routeOpts.unchartedPolicy === 'strict',
                    gates,
                });
                log.warn(
                    `LEAD SHADOW: ${leadShadowSummary(report, verdict)} graph=${tGraph}ms total=${Date.now() - tLead}ms`,
                );
            }
        } catch (err) {
            log.warn(`LEAD SHADOW: failed (route unaffected): ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // ── Seaway SHADOW (masterplan Phase 12) ──────────────────────────
    // Telemetry only: would the Seaway Graph have routed this passage
    // better? The user gets `result` regardless; the shadow rides the
    // grid cache (same bbox/params) so its cost is two connector
    // searches + a tiny graph Dijkstra. warn-level so the numbers show
    // up in the Xcode console on device — this log IS Phase 12's
    // deliverable until the scorecard arbitration promotes (Phase 13).
    // Local computes only (the prepped cloud path predates the seaway
    // modules; CLOUD_ROUTER_ENABLED is false until Phase 9 anyway).
    if (SEAWAY_SHADOW_ENABLED && !routedOnCloud) {
        try {
            const tShadow = Date.now();
            const report = shadowCompare(merged, routeOpts, result, { regionalPairs: regionalPairsForShadow });
            if (report) {
                log.warn(`SEAWAY SHADOW: ${shadowSummary(report, result.distanceNM)} (${Date.now() - tShadow} ms)`);
                // Phase 13 — PROMOTE the graph route when it threads the gates side-correctly
                // and every leg stays within the detour cap. Returns early with the graph
                // polyline (which passes through every gate midpoint, "geometry is the law"),
                // structurally skipping the engine post-hoc passes (they only run inside
                // routeInshore on engine geometry). Any reject falls through to the engine route.
                if (SEAWAY_ROUTER_ENABLED && report.graph) {
                    const g = report.graph;
                    const promotionBlockReason = seawayPromotionBlockReason({
                        canalMask: (result as { canalMask?: boolean[] }).canalMask,
                        debug: (result as { debug?: { threeTier?: string } }).debug,
                        shallowRuns: (result as { shallowRuns?: ShallowRunInfo[] }).shallowRuns,
                        pinOffWater: (result as { pinOffWater?: InshoreRouteResult['pinOffWater'] }).pinOffWater,
                    });
                    const promotable =
                        promotionBlockReason === null &&
                        g.crossLineViolations === 0 &&
                        g.gateCompliance !== null &&
                        g.gateCompliance >= SEAWAY_GATE_COMPLIANCE_MIN &&
                        g.maxLegDetour <= SEAWAY_DETOUR_CAP &&
                        g.polyline.length >= 2;
                    // The engine's final checks, on the graph's own geometry
                    // (fix-up, 2026-09-30) — only once it is otherwise promotable.
                    const safetyFault = promotable
                        ? seawayGraphSafetyFault(
                              g.polyline,
                              merged,
                              result as Parameters<typeof seawayGraphSafetyFault>[2],
                              routeOpts.unchartedPolicy === 'strict' ? { grid: report.grid } : undefined,
                              { tideCeilings, needM: routeOpts.draftM + routeOpts.safetyM },
                          )
                        : null;
                    if (promotionBlockReason) {
                        log.warn(
                            `SEAWAY ROUTER: graph route SHADOW-ONLY — ${promotionBlockReason}; engine tier route ships`,
                        );
                    } else if (safetyFault) {
                        log.warn(`SEAWAY ROUTER: graph route DECLINED — it ${safetyFault}; engine route ships`);
                    } else if (promotable) {
                        log.warn(
                            `SEAWAY ROUTER: PROMOTED graph route (${g.edgesUsed.length} edges, compliance ${g.gateCompliance}, maxLegDetour ${g.maxLegDetour.toFixed(2)})`,
                        );
                        const promoted = promotedSeawayRoute(g, report.grid, merged, routeOpts, {
                            cellsUsed,
                            elapsedMs,
                            surveyUncheckedCells,
                            structuresUnknownCells: structuresUnknownOn(g.polyline),
                            ...(tideUnchecked(g.polyline) ? { tideCheck: 'not-loaded' as const } : {}),
                        });
                        // The land it crosses, on its own geometry (2026-10-01
                        // review): a promoted route never reports a pin off the
                        // water (seawayPromotionBlockReason), so all of it counts.
                        const promotedLand =
                            routeOpts.unchartedPolicy === 'strict' ? auditUnvouchedHardLand(merged, g.polyline) : null;
                        const promotedAway = promotedLand
                            ? hardLandAwayFromPinEdges(promotedLand, { origin: false, destination: false })
                            : null;
                        return {
                            ...promoted,
                            ...routeChartWater(merged, g.polyline),
                            ...(promotedLand && promotedAway
                                ? {
                                      hardLand: {
                                          totalM: Math.round(promotedLand.totalM),
                                          awayM: Math.round(promotedAway.metres),
                                          ...(promotedAway.at ? { awayAt: promotedAway.at } : {}),
                                      },
                                  }
                                : {}),
                            ...routeContext,
                        };
                    }
                    log.warn(
                        `SEAWAY ROUTER: graph route DECLINED — violations=${g.crossLineViolations} ` +
                            `compliance=${g.gateCompliance} maxLegDetour=${g.maxLegDetour.toFixed(2)} (engine route ships)`,
                    );
                }
            } else if (ROUTE_DEBUG) {
                log.warn('SEAWAY SHADOW: corridor has no lateral marks — nothing to shadow-sm');
            }
        } catch (err) {
            // Shadow failures must never touch the live route.
            log.warn(`SEAWAY SHADOW: failed (route unaffected): ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    // Mask-desync guard: a mask whose length fits neither per-vertex (n) nor
    // per-segment (n-1) is silently ignored by the renderer — the whole route
    // paints single-colour teal with ZERO log output, indistinguishable from a
    // mask-less route. Name the desync here so it is a console line, not a
    // silent colour regression.
    {
        const n = result.polyline.length;
        const auditMask = (name: string, m: boolean[] | undefined): void => {
            if (m && m.length !== n && m.length !== n - 1)
                log.warn(`MASK DESYNC: ${name}.length=${m.length} vs polyline=${n} — renderer will ignore it`);
        };
        const r = result as {
            cautionMask?: boolean[];
            canalMask?: boolean[];
            channelMask?: boolean[];
            offshoreMask?: boolean[];
        };
        auditMask('cautionMask', r.cautionMask);
        auditMask('canalMask', r.canalMask);
        auditMask('channelMask', r.channelMask);
        auditMask('offshoreMask', r.offshoreMask);
    }

    return {
        polyline: result.polyline,
        cautionMask: (result as { cautionMask?: boolean[] }).cautionMask,
        canalMask: (result as { canalMask?: boolean[] }).canalMask,
        channelMask: (result as { channelMask?: boolean[] }).channelMask,
        tier4Mask: (result as { tier4Mask?: boolean[] }).tier4Mask,
        offshoreMask: (result as { offshoreMask?: boolean[] }).offshoreMask,
        shallowRuns: (result as { shallowRuns?: ShallowRunInfo[] }).shallowRuns,
        chartedShallowMask: (result as { chartedShallowMask?: boolean[] }).chartedShallowMask,
        ...((result as { tideDepthM?: (number | null)[] }).tideDepthM
            ? { tideDepthM: (result as { tideDepthM?: (number | null)[] }).tideDepthM }
            : {}),
        ...(typeof (result as { tideNeedM?: number }).tideNeedM === 'number'
            ? { tideNeedM: (result as { tideNeedM?: number }).tideNeedM }
            : {}),
        landPaintConflictMask: (result as { landPaintConflictMask?: boolean[] }).landPaintConflictMask,
        ...((result as { cautionWhy?: number[] }).cautionWhy
            ? { cautionWhy: (result as { cautionWhy?: number[] }).cautionWhy }
            : {}),
        ...((result as { cautionDepthM?: (number | null)[] }).cautionDepthM
            ? { cautionDepthM: (result as { cautionDepthM?: (number | null)[] }).cautionDepthM }
            : {}),
        ...((result as { cautionNearShallow?: (CautionNearShallow | null)[] }).cautionNearShallow
            ? {
                  cautionNearShallow: (result as { cautionNearShallow?: (CautionNearShallow | null)[] })
                      .cautionNearShallow,
              }
            : {}),
        ...((result as { chartedShallowSpans?: ChartedShallowSpan[] }).chartedShallowSpans
            ? { chartedShallowSpans: (result as { chartedShallowSpans?: ChartedShallowSpan[] }).chartedShallowSpans }
            : {}),
        destinationInlandTrimM: (result as { destinationInlandTrimM?: number }).destinationInlandTrimM,
        ...((result as { pinOffWater?: InshoreRouteResult['pinOffWater'] }).pinOffWater
            ? { pinOffWater: (result as { pinOffWater?: InshoreRouteResult['pinOffWater'] }).pinOffWater }
            : {}),
        ...(structuresUnknownOn(result.polyline).length > 0
            ? { structuresUnknownCells: structuresUnknownOn(result.polyline) }
            : {}),
        ...((result as { surveyRuns?: SurveyRunInfo[] }).surveyRuns
            ? { surveyRuns: (result as { surveyRuns?: SurveyRunInfo[] }).surveyRuns }
            : {}),
        ...((result as { surveyUncheckedCells?: string[] }).surveyUncheckedCells?.length
            ? { surveyUncheckedCells: (result as { surveyUncheckedCells?: string[] }).surveyUncheckedCells }
            : {}),
        ...(tideUnchecked(result.polyline) ? { tideCheck: 'not-loaded' as const } : {}),
        ...(typeof result.debug?.hardLandTotalM === 'number'
            ? {
                  hardLand: {
                      totalM: result.debug.hardLandTotalM,
                      awayM: result.debug.hardLandAwayM ?? result.debug.hardLandTotalM,
                      ...(result.debug.hardLandAwayAt ? { awayAt: result.debug.hardLandAwayAt } : {}),
                  },
              }
            : {}),
        ...routeContext,
        ...routeChartWater(merged, result.polyline),
        distanceNM: result.distanceNM,
        cellsUsed,
        elapsedMs,
    };
}

/**
 * Convert an inshore route result into a GeoJSON LineString feature
 * suitable for stuffing into VoyagePlan.routeGeoJSON.
 */
export function inshoreRouteToGeoJSON(
    result: InshoreRouteResult,
    origin: InshoreOrigin,
    destination: InshoreOrigin,
): GeoJSON.Feature<GeoJSON.LineString> {
    return {
        type: 'Feature',
        geometry: {
            type: 'LineString',
            coordinates: result.polyline as [number, number][],
        },
        properties: {
            source: 'inshore-router',
            distanceNM: result.distanceNM,
            cellsUsed: result.cellsUsed,
            // The browser departure planner is restored from this persisted
            // feature, unlike the native map path which still has the
            // in-memory result. Keep the charted shallow runs alongside the
            // geometry so both paths gate departures against the same real
            // depths rather than treating every web route as tide-clear.
            shallowRuns: result.shallowRuns ?? [],
            // What the route must say wherever it is shown again (owner
            // decision 8: bridges not checked on these charts; decision 7: a
            // pin off the water) — kept WITH the saved route, not only in a
            // transient banner (fix-up, 2026-09-30).
            ...(result.structuresUnknownCells?.length ? { structuresUnknownCells: result.structuresUnknownCells } : {}),
            ...(result.pinOffWater ? { pinOffWater: result.pinOffWater } : {}),
            // …and its survey stretches (owner decision 9, 2026-09-30).
            ...(result.surveyRuns?.length ? { surveyRuns: result.surveyRuns } : {}),
            ...(result.surveyUncheckedCells?.length ? { surveyUncheckedCells: result.surveyUncheckedCells } : {}),
            // …and that it was routed with no tide loaded (decision 11).
            ...(result.tideCheck ? { tideCheck: result.tideCheck } : {}),
            // …and where its canal water came from when that was not a live
            // download (Phase 2b, 2026-10-01): the saved plan says so again.
            ...(result.waterPack && result.waterPack.source !== 'online'
                ? {
                      waterPack: {
                          source: result.waterPack.source,
                          ...(typeof result.waterPack.dataAsOf === 'number'
                              ? { dataAsOf: result.waterPack.dataAsOf }
                              : {}),
                          missing: [...result.waterPack.missing],
                          // Offline or not decides the words (2026-10-02).
                          ...(result.waterPack.offline ? { offline: true } : {}),
                      },
                  }
                : {}),
            origin: { lat: origin.lat, lon: origin.lon },
            destination: { lat: destination.lat, lon: destination.lon },
        },
    };
}

// ── Regional nav-markers helpers ───────────────────────────────────

/**
 * Pre-built regional marker files in Supabase storage. Each file
 * covers a bbox of curated lateral / cardinal / lights / dangers
 * pulled from OSM seamarks, AHO data, and hand-edited fixes. The map
 * already fetches these for chart display (see useMapInit.ts); for
 * routing we re-use the SAME file rather than re-querying Overpass.
 *
 * Add more regions as they ship by extending the `regions` array.
 * URL resolution is by bbox-contains — keep entries non-overlapping.
 */
const REGIONAL_MARKER_FILES: { bbox: [number, number, number, number]; slug: string }[] = [
    // [minLon, minLat, maxLon, maxLat], slug
    { bbox: [152.0, -28.5, 154.5, -26.0], slug: 'australia_se_qld' },
];

/**
 * Cached marker fetches keyed by URL. The files are small (~1 MB
 * range) and the URL is stable per region — once loaded, keep them
 * for the session.
 */
// Old `regionalMarkerCache` removed — see `rawMarkerFetchCache` below
// (cache only the HTTP fetch, not the processed pairing result, because
// pairing decisions now depend on the cell pack's LNDARE polygons).

/**
 * ENC lateral marks (BCNLAT/BOYLAT, acronym-gated) with CATLAM 1/2 →
 * port/starboard pairing candidates. Shared by tryInshoreRoute and the
 * device-faithful test harnesses so both fold the same set. CATLAM 3/4
 * (preferred-channel) deliberately excluded — their side semantics belong
 * to the mixed-pair machinery. Pure + exported for tests.
 */
export function encLateralsFromFeatures(
    features: ReadonlyArray<{
        geometry?: { type?: string; coordinates?: unknown } | null;
        properties?: Record<string, unknown> | null;
    }>,
): { lat: number; lon: number; kind: 'port' | 'starboard' | 'special' }[] {
    const out: { lat: number; lon: number; kind: 'port' | 'starboard' | 'special' }[] = [];
    for (const f of features) {
        const p = f.properties;
        const g = f.geometry;
        if (!p || typeof p.acronym !== 'string' || g?.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
        const catlam = Number(p.CATLAM);
        if (catlam !== 1 && catlam !== 2) continue;
        const [lon, lat] = g.coordinates as [number, number];
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        out.push({ lat, lon, kind: catlam === 1 ? 'port' : 'starboard' });
    }
    return out;
}

async function pickRegionalMarkersUrl(origin: InshoreOrigin, destination: InshoreOrigin): Promise<string | null> {
    const supabaseBase =
        (typeof import.meta !== 'undefined' && import.meta.env?.VITE_SUPABASE_URL) ||
        'https://pcisdplnodrphauixcau.supabase.co';
    // Pick the first region whose bbox contains both endpoints. Most
    // inshore routes are short enough that this single-region match
    // is correct; cross-region routes can come later.
    for (const region of REGIONAL_MARKER_FILES) {
        const [w, s, e, n] = region.bbox;
        const insideOrigin = origin.lon >= w && origin.lon <= e && origin.lat >= s && origin.lat <= n;
        const insideDest = destination.lon >= w && destination.lon <= e && destination.lat >= s && destination.lat <= n;
        if (insideOrigin && insideDest) {
            return `${supabaseBase}/storage/v1/object/public/regions/${region.slug}/nav_markers.geojson`;
        }
    }
    return null;
}

/**
 * Convert ENC cardinal marks (BOYCAR/BCNCAR) into direction-tagged Point hazards for the
 * router's avoidance path. CATCAM (1=N, 2=E, 3=S, 4=W) → _osmClass='cardinal_<nesw>', which
 * orientHazardsTowardLand then uses to block the HAZARD side (an East cardinal ⇒ pass east).
 *
 * ENC cardinals are otherwise DISPLAY-ONLY — loaded on-device but never fed to routing — so
 * an East cardinal could end up on the WRONG side of the track (Shane, Moreton Bay: two East
 * cardinals on opposite sides). Guardrails: skip a feature whose CATCAM is missing/invalid
 * (NEVER default a direction — a wrong one blocks the wrong side), skip non-Point geometry,
 * and dedup against existing OSM hazard keys (~11 m grid) so a buoy in both feeds gets ONE
 * disc. Pure + exported for unit testing.
 */
export function encCardinalsToHazards(
    encFeatures: ReadonlyArray<{
        geometry?: { type?: string; coordinates?: [number, number] } | null;
        properties?: Record<string, unknown> | null;
    }>,
    osmHazardKeys: ReadonlySet<string>,
): {
    type: 'Feature';
    geometry: { type: 'Point'; coordinates: [number, number] };
    properties: Record<string, unknown>;
}[] {
    const DIR = ['n', 'e', 's', 'w'] as const;
    const out: {
        type: 'Feature';
        geometry: { type: 'Point'; coordinates: [number, number] };
        properties: Record<string, unknown>;
    }[] = [];
    const seen = new Set<string>(osmHazardKeys);
    for (const f of encFeatures) {
        if (f.geometry?.type !== 'Point' || !Array.isArray(f.geometry.coordinates)) continue;
        const [lon, lat] = f.geometry.coordinates;
        if (typeof lon !== 'number' || typeof lat !== 'number') continue;
        const raw = readS57(f.properties, 'CATCAM');
        const c = Math.round(Number(raw));
        if (!(c >= 1 && c <= 4)) continue; // missing/invalid CATCAM — skip, never guess a direction
        const key = `${lat.toFixed(4)}|${lon.toFixed(4)}`;
        if (seen.has(key)) continue; // dedup vs OSM hazards + other ENC cardinals (one buoy → one disc)
        seen.add(key);
        out.push({
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: { _class: 'direct-hazard', _osmClass: `cardinal_${DIR[c - 1]}`, _source: 'enc-cardinal' },
        });
    }
    return out;
}

/**
 * Turn each Point-hazard marker into a half-circle Polygon facing
 * the nearest shore.
 *
 * Why
 * ───
 * IALA-A (and IALA-B) buoyage: a solo lateral / cardinal / danger
 * marker indicates a hazard whose physical extent runs FROM THE
 * MARKER TOWARD SHORE. The boat passes on the seaward (away-from-
 * shore) side. A symmetric circular no-go zone treats both sides
 * equally and A* picks the shorter detour — which can be the WRONG
 * (shore) side at narrow reef-edge approaches like Scarborough Reef.
 *
 * By emitting a half-circle whose flat edge points seaward, we
 * block only the shore-side cells. A* is forced to detour around
 * the seaward side — the correct IALA behaviour regardless of
 * inbound/outbound direction.
 *
 * Algorithm
 * ─────────
 * 1. For each Point hazard, find the nearest vertex on any LNDARE
 *    polygon ring → that's the rough "shore direction".
 * 2. Build a half-circle Polygon at the marker, radius = bufferM,
 *    180° arc centred on the shore-bearing.
 * 3. Emit as OBSTRN Polygon. The engine's Pass 3 already handles
 *    polygon obstructions by blocking interior cells.
 *
 * Fallbacks
 * ─────────
 * - No LNDARE features available → return Points unchanged (engine
 *   uses symmetric `obstructionBufferM` buffer).
 * - Marker further than MAX_SHORE_DISTANCE_M (5 km) from any land
 *   vertex → can't reliably determine shore-side; return Point
 *   unchanged. These are typically far-offshore solo markers
 *   (deep-ocean obstructions) where symmetric buffering is fine.
 */
export function orientHazardsTowardLand(
    hazards: {
        geometry: { type: 'Point'; coordinates: [number, number] };
        properties?: unknown;
    }[],
    lndareFeatures: { geometry: { type: string; coordinates?: unknown } }[],
): unknown[] {
    if (lndareFeatures.length === 0) return hazards as unknown[];

    // Hazard radius is DYNAMIC: it scales with the distance to nearest
    // land. The half-circle's curved edge then reaches all the way to
    // the coastline, blocking every cell between the marker and shore.
    //
    // A fixed 100 m radius left a corridor BETWEEN the half-circle and
    // the actual coastline when the reef extended > 100 m offshore —
    // A* threaded the route through it (the user's exact complaint at
    // Scarborough Reef). With radius = shoreDistance, that corridor
    // disappears: the half-disc spans the full reef extent.
    // Class-aware + distance-gated radius policy.
    //
    // Three buckets:
    //
    //   • SOLO LATERAL near shore (`_class === 'lateral-marker-as-hazard'`
    //     AND shoreDistM ≤ LATERAL_REEF_GATE_M) — port/starboard marker
    //     that didn't pair AND is close to land. Most plausibly a reef-
    //     edge or isolated-shoal marker; the boat must pass seaward
    //     and the strip back to shore is no-go. EXTEND the disc to
    //     shoreDistM + 30, capped at LATERAL_RADIUS_MAX_M so the disc
    //     reaches the reef-edge it's marking (Scarborough Reef green
    //     ≈ 600 m offshore needs ≈ 630 m radius).
    //
    //   • SOLO LATERAL far from shore (shoreDistM > LATERAL_REEF_GATE_M)
    //     — port/starboard marker that didn't pair and is genuinely
    //     mid-bay. Almost certainly an unpaired channel marker, not a
    //     reef. Treat as compact (DIRECT_HAZARD_RADIUS_MAX_M cap). Two
    //     reasons: (a) extending these built walls that disconnected
    //     the river from the bay (454 unpaired laterals in the
    //     Brisbane bbox — if many get km-scale discs they overlap into
    //     barriers, user 2026-05-13: "Origin and destination are in
    //     disconnected water bodies"); (b) the marker class alone
    //     doesn't reliably distinguish reef from channel, so we need
    //     shore proximity as a second signal.
    //
    //   • DIRECT HAZARD (cardinals, dangers, isolated) — always
    //     compact at DIRECT_HAZARD_RADIUS_MAX_M. Point hazards
    //     marking a specific local obstruction.
    //
    // LATERAL_REEF_GATE_M = 800 m. Catches Scarborough (~600 m),
    // Mud I. fringing (~400 m), Peel I. fringing (~700 m). Excludes
    // mid-Moreton-Bay solo laterals (typically > 1 km from any land).
    //
    // 2026-10-01 — a SOLO LATERAL's keep-out never closes a charted
    // DREDGED CHANNEL or FAIRWAY deep enough for this vessel. On the real
    // Brisbane cells the shipping channel's marks reach this function
    // unpaired, and three solo starboards beside the dredged river mouth
    // (BC19, BC21, Koopa Channel 5) grew discs of 549–647 m toward the
    // nearest land — ACROSS the dredged channel — and closed the river:
    // the route refused at a 2.5 m tide top ("the only way through crosses
    // the West Banks") and, with no tide known, went over ~950 m of drying
    // bank and ~850 m of land instead. So the disc is tagged
    // _yieldsToChartedDeep, and the grid leaves open the cells inside it
    // that an S-57 DRGARE or FAIRWY covers and an S-57 depth area charts
    // deep enough, with no shallower S-57 band beside it (navGrid Pass 3).
    //
    // Review fix-up, same day: the first cut also capped every solo
    // lateral's disc at one cable (185 m) and opened ANY charted-deep
    // water. That undid the disc's job — the strip between a reef-edge mark
    // and the shore that the chart may not show: with the reef 150 m inside
    // a mark 600 m off the shore and 10 m charted between them (the
    // Scarborough pattern), the route passed 110 m INSIDE the mark, 40 m off
    // the drying reef, exactly as with no mark at all. The radii are back
    // to the policy above, and natural deep water within a CABLE (185 m, the
    // traditional good berth; _innerKeepOutM) of the mark on its inferred
    // side stays closed: there only a charted dredged channel or fairway is a
    // way through. Beyond a cable the chart speaks where it charts water that
    // never dries; water it does not chart (vouched only by OSM or Mapbox,
    // where an undrawn fringing reef would lie), drying and land stay closed
    // to the full reach. Measured on the real cells: the full-reach discs
    // closing charted water pushed the bay → Lytton route onto a drying clip.
    const SOLO_LATERAL_INNER_M = 185;
    const HAZARD_RADIUS_MIN_M = 80;
    const DIRECT_HAZARD_RADIUS_MAX_M = 300; // dangers/isolated — compact
    // A CARDINAL's safe side is intrinsic (from CATCAM), not shore-derived, so its avoidance
    // disc is ONE-SIDED — only the hazard side is blocked, the safe side is always open. That
    // makes a LARGE radius connectivity-safe (a half-disc can't wall off water the way a
    // symmetric buffer would) AND necessary: an open-water cardinal can sit 500 m+ off the
    // route, so the 300 m cap never reaches it (Shane's Brisbane River pair ended up on
    // opposite sides because the disc couldn't push the track across). Gated DOWN by shore
    // proximity so a near-shore cardinal can't pinch a narrow channel.
    const CARDINAL_RADIUS_MAX_M = 1000;
    const CARDINAL_RADIUS_MIN_M = 400;
    const LATERAL_RADIUS_MAX_M = 800; // solo laterals near shore — extend to reach reef
    const LATERAL_REEF_GATE_M = 800; // solo laterals further out → treat as compact
    // `isolated` markers flag reef-edge beacons. Originally the disc
    // tried to span the entire reef strip from beacon back to shore
    // — that broke for far-offshore beacons (Scarborough Reef sits
    // 1942 m out, which produced a ~1972 m radius half-disc and a
    // 3.9 km chord on the seaward side that pushed coastal routes
    // 9 NM out of their way). The bathymetry data (DEPARE/LNDARE)
    // already blocks the reef itself, so the marker disc only
    // needs to add a clearance buffer around the beacon's own
    // position — 400 m is a couple of cables, comfortable for a
    // 55 ft yacht passing seaward of the beacon. For close-in
    // reef-edge markers (< 400 m from shore) the formula's
    // shoreDistM + 30 still wins via Math.min, so they get the
    // tighter natural radius they need.
    const ISOLATED_RADIUS_MAX_M = 400;
    const MAX_SHORE_DISTANCE_M = 5000; // beyond this, orientation is unreliable; keep as Point
    const ARC_SEGMENTS = 18; // 18 segments × 10° = 180° half-circle

    // Flatten all LNDARE vertices into a single [lon, lat] list so the
    // inner loop is a single typed-array walk instead of nested geom
    // descent per marker. With one big multipolygon at GMRT resolution
    // this is a few thousand vertices.
    const landVertices: [number, number][] = [];
    const walk = (coords: unknown): void => {
        if (!Array.isArray(coords)) return;
        if (typeof coords[0] === 'number' && typeof coords[1] === 'number') {
            landVertices.push([coords[0] as number, coords[1] as number]);
            return;
        }
        for (const inner of coords) walk(inner);
    };
    for (const f of lndareFeatures) {
        walk(f.geometry?.coordinates);
    }
    if (landVertices.length === 0) return hazards as unknown[];

    const result: unknown[] = [];
    const scarboroughDebug: string[] = [];
    for (const h of hazards) {
        const [mLon, mLat] = h.geometry.coordinates;
        // Find nearest land vertex (approx — Euclidean in lat/lon is fine
        // at this scale for nearest-neighbour selection).
        let bestSqr = Infinity;
        let bestLon = mLon;
        let bestLat = mLat;
        for (let i = 0; i < landVertices.length; i++) {
            const lv = landVertices[i];
            const dLon = lv[0] - mLon;
            const dLat = lv[1] - mLat;
            const sqr = dLon * dLon + dLat * dLat;
            if (sqr < bestSqr) {
                bestSqr = sqr;
                bestLon = lv[0];
                bestLat = lv[1];
            }
        }

        const shoreDistM = haversineMetres(mLat, mLon, bestLat, bestLon);
        // Detect a CARDINAL up front: its _osmClass carries the safe-water direction, which is
        // intrinsic — so it must NOT be dropped to a Point when far from shore (that left
        // open-water cardinals with no directional disc at all) and its radius/arc come from
        // the direction below, not the shore bearing.
        const hazardProps =
            (h.properties as { _class?: string; _osmClass?: string; _markerKind?: string } | null | undefined) ?? {};
        const hazardClass = hazardProps._class;
        const osmClass = hazardProps._osmClass;
        const cardDirMatch = typeof osmClass === 'string' ? /^cardinal_([nesw])$/.exec(osmClass) : null;
        const cardDir = cardDirMatch ? cardDirMatch[1] : null;
        if (cardDir == null && shoreDistM > MAX_SHORE_DISTANCE_M) {
            // Offshore non-cardinal — keep as Point, engine buffers symmetrically.
            result.push(h);
            continue;
        }

        // Bearing from marker → nearest land (in metres-projected space).
        const midLat = (mLat + bestLat) / 2;
        const mPerLonAtMid = 111_320 * Math.cos((midLat * Math.PI) / 180);
        const landDxM = (bestLon - mLon) * mPerLonAtMid;
        const landDyM = (bestLat - mLat) * 111_320;
        const landLen = Math.sqrt(landDxM * landDxM + landDyM * landDyM);
        if (cardDir == null && landLen < 1) {
            result.push(h);
            continue;
        }
        // The half-circle is centred on the land bearing — its arc
        // faces the land (shore-side cells get blocked). Radius cap
        // is gated by class AND shore proximity (see the policy
        // comment at the top of the function): solo laterals near
        // shore get the extended LATERAL_RADIUS_MAX cap; everything
        // else (direct hazards, OR solo laterals further than the
        // reef-gate) stays compact at DIRECT_HAZARD_RADIUS_MAX.
        const landAngle = Math.atan2(landDyM, landDxM);
        // CARDINAL marks carry a safe-water DIRECTION (an East cardinal ⇒ safe water EAST,
        // hazard WEST ⇒ the boat passes to the EAST). The direction survives extraction as
        // `cardinal_<nesw>` in _osmClass (detected above). Orient the avoidance half-disc to
        // block the HAZARD side (opposite the safe quadrant) instead of the shore bearing, so
        // the route is guaranteed onto the cardinal's safe side (two same-direction cardinals
        // end up on the same side of the track — Shane's two East cardinals).
        // Convention: atan2(north, east) ⇒ east=0, north=+π/2, west=π, south=-π/2; the hazard
        // centre is the safe bearing + π. Bare 'cardinal' (no direction) and every non-cardinal
        // hazard keep the shore-bearing orientation.
        const SAFE_ANGLE: Record<string, number> = { e: 0, n: Math.PI / 2, w: Math.PI, s: -Math.PI / 2 };
        const arcCentre = cardDir != null ? SAFE_ANGLE[cardDir] + Math.PI : landAngle;
        const isSoloLateral = hazardClass === 'lateral-marker-as-hazard';
        const isReefEdgeSoloLateral = isSoloLateral && shoreDistM <= LATERAL_REEF_GATE_M;
        // `isolated` markers are intentionally tagged in nav_markers
        // .geojson to mark reef edges (Scarborough Reef beacon being
        // the canonical example). Their hazard strip can extend the
        // full distance back to shore; let the disc span it instead
        // of capping at DIRECT_HAZARD_RADIUS_MAX_M.
        const isIsolatedReefMarker = osmClass === 'isolated';
        let maxRadiusForClass: number;
        if (isReefEdgeSoloLateral) {
            maxRadiusForClass = LATERAL_RADIUS_MAX_M;
        } else if (isIsolatedReefMarker) {
            maxRadiusForClass = ISOLATED_RADIUS_MAX_M;
        } else {
            maxRadiusForClass = DIRECT_HAZARD_RADIUS_MAX_M;
        }
        // Cardinals use a one-sided directional disc, sized to REACH the route (large, gated
        // down only near shore). Non-cardinals keep the shore-tied formula that holds symmetric
        // discs compact.
        const radiusM =
            cardDir != null
                ? Math.min(CARDINAL_RADIUS_MAX_M, Math.max(CARDINAL_RADIUS_MIN_M, shoreDistM))
                : Math.min(maxRadiusForClass, Math.max(HAZARD_RADIUS_MIN_M, shoreDistM + 30));

        // DEBUG — log markers near Scarborough Reef so we can see whether
        // the gate is doing its job. Bbox matches the RAW-marker bbox so
        // the isolated Scarborough Reef beacon at ~153.133 is captured.
        if (mLat >= -27.22 && mLat <= -27.17 && mLon >= 153.07 && mLon <= 153.15) {
            scarboroughDebug.push(
                `marker @ ${mLat.toFixed(4)},${mLon.toFixed(4)} class=${hazardClass ?? '?'} osm=${osmClass ?? '?'} kind=${hazardProps._markerKind ?? '?'} shoreDist=${Math.round(shoreDistM)}m reef=${isReefEdgeSoloLateral} iso=${isIsolatedReefMarker} → radius=${Math.round(radiusM)}m`,
            );
        }

        const coords: [number, number][] = [];
        // Arc from (landAngle - π/2) sweeping counter-clockwise to
        // (landAngle + π/2). The chord closes back through the centre,
        // but a closed half-disk needs the marker centre included so
        // the polygon doesn't double-cover the diameter line.
        for (let i = 0; i <= ARC_SEGMENTS; i++) {
            const t = i / ARC_SEGMENTS;
            const angle = arcCentre - Math.PI / 2 + t * Math.PI;
            const dxM = radiusM * Math.cos(angle);
            const dyM = radiusM * Math.sin(angle);
            const lon = mLon + dxM / mPerLonAtMid;
            const lat = mLat + dyM / 111_320;
            coords.push([lon, lat]);
        }
        // Close polygon back to start (it's already a half-disk going
        // arc-end → arc-start via the diameter chord because GeoJSON
        // polygons close by repeating the first vertex).
        coords.push(coords[0]);

        result.push({
            type: 'Feature',
            properties: {
                _class: 'iala-oriented-hazard',
                _source: cardDir != null ? 'cardinal-direction' : 'land-bearing-inferred',
                _cardinalDir: cardDir,
                _cardinalOriented: cardDir != null,
                _shoreDistanceM: Math.round(shoreDistM),
                _radiusM: Math.round(radiusM),
                // A solo lateral's side is inferred from the shore bearing: its
                // keep-out never closes a charted dredged channel or fairway
                // deep enough for the vessel, and beyond a cable it leaves
                // S-57-charted water that never dries to the chart (navGrid
                // Pass 3; 2026-10-01).
                _yieldsToChartedDeep: cardDir == null && isSoloLateral,
                ...(cardDir == null && isSoloLateral ? { _innerKeepOutM: SOLO_LATERAL_INNER_M } : {}),
                // True marker position (the half-disc centroid is offset toward the hazard side,
                // so the cardinal clamp must read the buoy point, not the polygon centroid).
                _markerLat: mLat,
                _markerLon: mLon,
                // Keep the original Point's properties for debug
                _origin: h.properties,
            },
            geometry: {
                type: 'Polygon',
                coordinates: [coords],
            },
        });
    }
    if (ROUTE_DEBUG) {
        if (scarboroughDebug.length > 0) {
            log.warn(`STAGE: Scarborough-area hazards (${scarboroughDebug.length}):`);
            for (const line of scarboroughDebug) {
                log.warn(`  • ${line}`);
            }
        } else {
            log.warn(`STAGE: NO hazards processed in Scarborough bbox (-27.22..-27.17, 153.07..153.12)`);
        }
    }
    return result;
}

/**
 * Haversine distance between two lat/lon points in metres.
 * Local to the marker-pairing logic — the engine has its own copy.
 */
function haversineMetres(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6_371_000;
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const dφ = ((lat2 - lat1) * Math.PI) / 180;
    const dλ = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Result of regional marker processing.
 *
 * - `midpoints`: pair-centre Points (Pass 5 marker-radius)
 * - `segments`: synthetic channel-ribbon Polygons (Pass 4 FAIRWY)
 * - `hazards`: SOLO lateral markers — port/starboard buoys that
 *   couldn't be paired with an opposite-colour partner. In real-world
 *   IALA-A buoyage, these almost always mark a hazard (reef edge,
 *   shoal, isolated rock) rather than a channel side. We emit them
 *   as OBSTRN Point features so the engine's Pass 3 obstruction
 *   buffer blocks cells within ~30 m, forcing the route around the
 *   hazard regardless of which side our (often inaccurate) chart
 *   shows as deeper. Specifically catches the Scarborough Reef green
 *   marker case the user flagged 2026-05-12.
 */
export interface RegionalChannelData {
    midpoints: unknown[];
    segments: unknown[];
    hazards: unknown[];
    /** Step-3 accepted port↔stbd pairs — the Seaway Graph's TIER 2 input
     *  (gateExtractor regionalGates, confidence 0.7). Pre-validated by
     *  the pipeline: metre-space PCA clustering, the 500 m stagger gate,
     *  LNDARE-between rejection with OSM/DEPARE water rescue. */
    acceptedPairs: Array<{ port: { lat: number; lon: number }; stbd: { lat: number; lon: number } }>;
    /** Outboard CAUTION wing rectangles per accepted pair (Step 4.5,
     *  masterplan Phase 3) — merged into OBSTRN, rasterised by Pass 5c. */
    wings: unknown[];
    /** Pairing diagnostics (considered/rejected/rescued counters). Surfaced
     *  for the route-quality scorecard + pairing regression tests — the
     *  masterplan's "diff pairDiag before merging a pairing change" check. */
    diag?: {
        considered: number;
        rejectedByLandare: number;
        acceptedByOsmWater: number;
        acceptedByDepare: number;
        wideConsidered: number;
        wideAccepted: number;
        wideRejected: number;
    };
}

/**
 * Fetch + cache + transform the regional nav_markers.geojson into
 * SYNTHETIC channel features for routing.
 *
 * Two outputs are produced:
 *
 * 1. **Midpoint Points** — one per paired port+starboard marker. The
 *    engine's Pass 5 stamps a pair-distance-aware preferred radius
 *    around each. Useful as "wide spots" at each gate.
 *
 * 2. **Channel-segment Polygons** — thin rectangles (~20 m wide)
 *    connecting each midpoint to its nearest neighbour within 500 m.
 *    The engine's Pass 4 (FAIRWY) marks cells inside as preferred.
 *    Chains of segments form a continuous channel ribbon for A* to
 *    track. Without this layer, A* can wander on either side of the
 *    radial preferred-zones at each midpoint — the user observed
 *    the route going on the wrong side of a green marker at the
 *    Scarborough peninsula bend, and (after the radius-cap fix)
 *    moved even closer to shore. The segments enforce direction.
 *
 * Why midpoints and not raw markers
 * ─────────────────────────────────
 * IALA buoyage: port-hand marks one side, starboard-hand the other when
 * entering harbour (region A: port-hand = red; region B/USA: port-hand =
 * green — SIDE semantics are identical, only the paint flips, so never
 * hardcode a colour here). The channel itself is the corridor BETWEEN
 * paired port+starboard markers — never around either individually.
 */
type Marker = { lat: number; lon: number; kind: 'port' | 'starboard' | 'special' };
type Midpoint = { lat: number; lon: number; pairDistM: number; chainId: number; chainOrder: number };

/**
 * Group markers into channel-chain clusters by spatial proximity.
 *
 * Flood-fill clustering with an ORIENTATION GATE.
 *
 * Two markers within CLUSTER_LINK_M of each other join the same
 * cluster, BUT once the cluster has ≥3 markers we also require new
 * candidates to lie within `channelHalfWidthM` perpendicular distance
 * of the cluster's PCA-fitted principal axis. This stops two
 * perpendicular channels from being swept into one cluster just
 * because their markers happen to be within `CLUSTER_LINK_M` of each
 * other (Newport-Scarborough cross at the 720/880 m mark, 2026-05-15).
 *
 * Without orientation awareness, bumping CLUSTER_LINK_M to cover
 * sparser chains (Newport's 880 m gap) also linked perpendicular
 * channels — the PCA chain-ordering then produced a zigzag sequence
 * jumping between the two, FAIRWY segments got dropped by
 * SEGMENT_MAX_M, and the route got worse, not better.
 *
 * With this gate at channelHalfWidthM=100 m: Newport's 3 pairs (all
 * at lon ~153.093) form one chain even at CLUSTER_LINK_M=900 m,
 * while Scarborough's pairs ~1 km perpendicular off that line stay
 * a separate chain. Real channels are typically 20-50 m wide with
 * markers within 30 m of the centerline — 100 m is generous enough
 * for buoy-placement wobble and pair-width spread, narrow enough to
 * exclude the perpendicular neighbour.
 *
 * Output: array of clusters, each cluster is an array of marker
 * indices into the input array.
 */
function clusterMarkers(markers: Marker[], CLUSTER_LINK_M: number, channelHalfWidthM = 100): number[][] {
    const n = markers.length;
    const visited = new Uint8Array(n);
    const clusters: number[][] = [];
    // TWO PCA fits, OR semantics on the perp-distance gate.
    //
    // Why: a GLOBAL PCA fit on the whole cluster is correct for short
    // straight chains (Newport's 3 pairs, Scarborough's 5 pairs) and
    // rejects the perpendicular cross-channel from being swept in.
    // But on a long CURVING chain (Brisbane River shipping channel
    // bending 60°+ from bay to river mouth), the global fit averages
    // the curve into a diagonal — and markers at the curve's far ends
    // fall outside the perp gate, truncating the chain. A trailing-
    // window fit on the LAST 6 markers (the BFS edge) tracks the
    // channel's local direction and accepts curving extremes.
    //
    // Solo, each fit has a failure mode: global truncates curves,
    // trailing-window is locally noisy near chain extremes (a
    // boundary marker can flip in/out depending on the last 6
    // markers' PCA, even though globally it lies along the line).
    //
    // OR semantics — a candidate is accepted if it passes EITHER
    // gate — gives the best of both: straight chains pass both fits
    // (no change); curving chains pass via local where global fails;
    // perpendicular cross channels fail BOTH (the cross is far perp
    // of any line you fit through a single channel). Boundary noise
    // is dampened because the candidate only needs one of the two
    // fits to accept it.
    const FIT_WINDOW = 6;
    for (let seed = 0; seed < n; seed++) {
        if (visited[seed]) continue;
        const cluster: number[] = [];
        const queue: number[] = [seed];
        visited[seed] = 1;
        while (queue.length) {
            const i = queue.shift()!;
            cluster.push(i);
            // fitGlobal: kicks in at cluster size ≥3.
            // fitLocal: only kicks in once we have more markers than
            // the window size — for ≤ FIT_WINDOW, the trailing window
            // equals the full cluster, so it would duplicate fitGlobal.
            const fitGlobal = cluster.length >= 3 ? clusterFitLine(cluster, markers) : null;
            const fitLocal = cluster.length > FIT_WINDOW ? clusterFitLine(cluster.slice(-FIT_WINDOW), markers) : null;
            const mi = markers[i];
            for (let j = 0; j < n; j++) {
                if (visited[j]) continue;
                const mj = markers[j];
                if (haversineMetres(mi.lat, mi.lon, mj.lat, mj.lon) > CLUSTER_LINK_M) continue;
                if (fitGlobal) {
                    const perpG = perpDistFromLineM(mj.lat, mj.lon, fitGlobal);
                    const perpL = fitLocal ? perpDistFromLineM(mj.lat, mj.lon, fitLocal) : perpG;
                    // Reject only if BOTH gates reject. Either accepts → in.
                    if (perpG > channelHalfWidthM && perpL > channelHalfWidthM) continue;
                }
                visited[j] = 1;
                queue.push(j);
            }
        }
        clusters.push(cluster);
    }
    return clusters;
}

/**
 * 2D PCA on a cluster of markers. Returns the cluster's principal
 * axis as a unit vector in METER space relative to the centroid
 * latitude, plus the centroid itself. Used to gate cluster growth by
 * perpendicular distance to the fitted line — see clusterMarkers().
 *
 * Returns null when the cluster is degenerate (all markers stacked at
 * one point, or fewer than 2 markers).
 */
function clusterFitLine(
    indices: number[],
    markers: Marker[],
): { latC: number; lonC: number; mPerLon: number; dirLatM: number; dirLonM: number } | null {
    const n = indices.length;
    if (n < 2) return null;
    let latSum = 0;
    let lonSum = 0;
    for (const i of indices) {
        latSum += markers[i].lat;
        lonSum += markers[i].lon;
    }
    const latC = latSum / n;
    const lonC = lonSum / n;
    const mPerLat = 111_320;
    const mPerLon = 111_320 * Math.cos((latC * Math.PI) / 180);
    let Cxx = 0;
    let Cyy = 0;
    let Cxy = 0;
    for (const i of indices) {
        const dx = (markers[i].lon - lonC) * mPerLon;
        const dy = (markers[i].lat - latC) * mPerLat;
        Cxx += dx * dx;
        Cyy += dy * dy;
        Cxy += dx * dy;
    }
    Cxx /= n;
    Cyy /= n;
    Cxy /= n;
    const trace = Cxx + Cyy;
    const det = Cxx * Cyy - Cxy * Cxy;
    const disc = Math.max(0, (trace * trace) / 4 - det);
    const lambdaMax = trace / 2 + Math.sqrt(disc);
    let dirX: number;
    let dirY: number;
    if (Math.abs(Cxy) > 1e-12) {
        dirX = Cxy;
        dirY = lambdaMax - Cxx;
    } else if (Cxx >= Cyy) {
        dirX = 1;
        dirY = 0;
    } else {
        dirX = 0;
        dirY = 1;
    }
    const mag = Math.sqrt(dirX * dirX + dirY * dirY);
    if (mag < 1e-12) return null;
    return {
        latC,
        lonC,
        mPerLon,
        dirLatM: dirY / mag,
        dirLonM: dirX / mag,
    };
}

/**
 * Perpendicular distance in METERS from (lat, lon) to the fitted
 * line. Uses the 2D cross-product magnitude with the unit-vector
 * direction.
 */
function perpDistFromLineM(
    lat: number,
    lon: number,
    fit: { latC: number; lonC: number; mPerLon: number; dirLatM: number; dirLonM: number },
): number {
    const dx = (lon - fit.lonC) * fit.mPerLon;
    const dy = (lat - fit.latC) * 111_320;
    return Math.abs(dx * fit.dirLatM - dy * fit.dirLonM);
}

/**
 * Principal axis of a 2D point set via 2x2 PCA. Returns a unit vector
 * (in lat/lon units, anisotropic) along the direction of maximum
 * variance — i.e. the chain's "along-channel" axis.
 *
 * For chains that run mostly along a cardinal direction this is
 * trivially correct; for curved chains it gives the dominant
 * direction, which is good enough to sort markers in approximate
 * channel order for the synthetic-segment ribbon.
 */
/**
 * Ray-casting point-in-polygon test. Returns true if the point falls
 * inside ANY ring of any polygon/multipolygon in `features`. Doesn't
 * distinguish outer rings from holes — for our use cases (was this
 * midpoint on land? was it inside an OSM water polygon?) we want
 * any-ring containment.
 *
 * The function is feature-agnostic: pass it LNDARE polygons to ask
 * "is this point on charted land?", pass it OSM water+marina polygons
 * to ask "is this point inside OSM-tagged navigable water?". The pair-
 * rejection step (Step 3 of fetchRegionalMarkers) calls it twice with
 * different feature sets and uses the OSM check as a tie-breaker
 * against LNDARE-bleed across rivers (Brisbane River shipping channel
 * markers, whose midpoints sit inside the over-bleeding mainland
 * LNDARE polygon).
 */
function pointInAnyPolygon(
    lon: number,
    lat: number,
    features: { geometry?: { type?: string; coordinates?: unknown } }[],
): boolean {
    for (const f of features) {
        const g = f.geometry;
        if (!g) continue;
        const ringsList: number[][][][] =
            g.type === 'Polygon'
                ? [g.coordinates as number[][][]]
                : g.type === 'MultiPolygon'
                  ? (g.coordinates as number[][][][])
                  : [];
        for (const polygon of ringsList) {
            // Bbox prune — skip polygons that don't contain the point's bbox
            let minLon = Infinity;
            let maxLon = -Infinity;
            let minLat = Infinity;
            let maxLat = -Infinity;
            const outerRing = polygon[0];
            if (!outerRing) continue;
            for (const v of outerRing) {
                if (v[0] < minLon) minLon = v[0];
                if (v[0] > maxLon) maxLon = v[0];
                if (v[1] < minLat) minLat = v[1];
                if (v[1] > maxLat) maxLat = v[1];
            }
            if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
            // Ray cast against the outer ring
            let inside = false;
            const ring = outerRing;
            const n = ring.length;
            for (let i = 0, j = n - 1; i < n; j = i++) {
                const xi = ring[i][0];
                const yi = ring[i][1];
                const xj = ring[j][0];
                const yj = ring[j][1];
                const intersect = yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
                if (intersect) inside = !inside;
            }
            if (inside) return true;
        }
    }
    return false;
}

/**
 * Cheap "is this polygon wide enough to be a navigable channel?" test.
 * Uses the bounding-box short-side as a proxy for narrowest width.
 *
 * Why this exists: when we promote OSM water=river/water=harbour polygons
 * to channel-preferred status (1.0× cost), we must NOT promote suburban
 * stormwater ponds and drainage basins that happen to share the same
 * `natural=water` tag. A 100×100 m pond would otherwise give A* a free
 * 1.0× shortcut through a backyard.
 *
 * Bbox short-side is conservative: an L-shaped polygon (e.g. a river
 * bend) reports both sides as the bbox extent of the bend, so it'll
 * pass the test even if the river itself is narrow at the bend's
 * elbow. That's fine — we'd rather over-promote a real river than
 * under-promote it. False-promotions are filtered downstream by the
 * tag check (`water=river`/`harbour=yes`/etc.) which already excludes
 * lakes and isolated water bodies.
 */
/**
 * Returns the bbox + meter-dimensions of a polygon/multipolygon feature.
 * Returns null if the geometry isn't polygonal or has no vertices.
 * Used by isPolygonWideEnough and by the OSM-promotion diagnostics
 * (so we can log the size of the largest promoted polygon and confirm
 * the Brisbane River multipolygon is what we expect).
 */
function featureBboxAndSizeM(f: {
    geometry?: { type?: string; coordinates?: unknown };
}): { bbox: [number, number, number, number]; widthM: number; heightM: number } | null {
    const g = f.geometry;
    if (!g) return null;
    const outerRings: number[][][] =
        g.type === 'Polygon'
            ? [(g.coordinates as number[][][])[0]]
            : g.type === 'MultiPolygon'
              ? (g.coordinates as number[][][][]).map((poly) => poly[0])
              : [];
    if (outerRings.length === 0) return null;
    let minLon = Infinity;
    let maxLon = -Infinity;
    let minLat = Infinity;
    let maxLat = -Infinity;
    for (const ring of outerRings) {
        for (const v of ring) {
            if (v[0] < minLon) minLon = v[0];
            if (v[0] > maxLon) maxLon = v[0];
            if (v[1] < minLat) minLat = v[1];
            if (v[1] > maxLat) maxLat = v[1];
        }
    }
    if (!Number.isFinite(minLon)) return null;
    const midLat = (minLat + maxLat) / 2;
    const M_PER_DEG_LAT = 111_320;
    const mPerLon = M_PER_DEG_LAT * Math.cos((midLat * Math.PI) / 180);
    const widthM = (maxLon - minLon) * mPerLon;
    const heightM = (maxLat - minLat) * M_PER_DEG_LAT;
    return { bbox: [minLon, minLat, maxLon, maxLat], widthM, heightM };
}

function isPolygonWideEnough(f: { geometry?: { type?: string; coordinates?: unknown } }, minWidthM: number): boolean {
    const dim = featureBboxAndSizeM(f);
    if (!dim) return false;
    return Math.min(dim.widthM, dim.heightM) >= minWidthM;
}

function principalAxis(points: { lat: number; lon: number }[]): { lat: number; lon: number } {
    const n = points.length;
    if (n < 2) return { lat: 1, lon: 0 };
    let meanLat = 0;
    let meanLon = 0;
    for (const p of points) {
        meanLat += p.lat;
        meanLon += p.lon;
    }
    meanLat /= n;
    meanLon /= n;
    let cxx = 0;
    let cxy = 0;
    let cyy = 0;
    for (const p of points) {
        const dx = p.lon - meanLon;
        const dy = p.lat - meanLat;
        cxx += dx * dx;
        cxy += dx * dy;
        cyy += dy * dy;
    }
    const trace = cxx + cyy;
    const det = cxx * cyy - cxy * cxy;
    const disc = Math.max(0, trace * trace - 4 * det);
    const lambda = (trace + Math.sqrt(disc)) / 2;
    let vx: number;
    let vy: number;
    if (Math.abs(cxy) > 1e-14) {
        vx = cxy;
        vy = lambda - cxx;
    } else if (cxx >= cyy) {
        vx = 1;
        vy = 0;
    } else {
        vx = 0;
        vy = 1;
    }
    const len = Math.sqrt(vx * vx + vy * vy);
    return len > 0 ? { lat: vy / len, lon: vx / len } : { lat: 1, lon: 0 };
}

/**
 * Cached by URL. We do NOT cache the processed result because pair
 * validation (LNDARE-between-pair check) depends on the cell pack's
 * land polygons, which can differ. The 50ms or so spent on
 * clustering+pairing per route call is small.
 */
const rawMarkerFetchCache = new Map<
    string,
    Promise<{
        features?: { properties?: { _class?: string }; geometry?: { type?: string; coordinates?: [number, number] } }[];
    }>
>();

/**
 * Exported for the pairing regression/scorecard tests (read-only import —
 * see docs/ROUTING_COLLAB.md lanes). Production callers stay internal.
 */
/** JS-level bound on the ~1 MB nav_markers fetch. AbortSignal is a
 *  silent no-op under the CapacitorHttp fetch patch (utils/deadline.ts
 *  header) and the native default is 600 s — marine LTE is exactly where
 *  sockets stall (field hang 2026-06-12, ROUTING_COLLAB reply 19). On
 *  deadline the route continues without regional markers (the :867
 *  caller's existing catch) instead of hanging the whole plan. */
const MARKER_FETCH_DEADLINE_MS = 15_000;

export async function fetchRegionalMarkers(
    /** Regional OSM marker file, or null = chart-marks-only pairing (regions
     *  with no curated file still get ENC gates via extraLaterals). */
    url: string | null,
    lndareFeatures: { geometry?: { type?: string; coordinates?: unknown } }[],
    osmWaterFeatures: { geometry?: { type?: string; coordinates?: unknown } }[] = [],
    chartedWaterFeatures: { geometry?: { type?: string; coordinates?: unknown } }[] = [],
    /**
     * ENC lateral marks (BCNLAT/BOYLAT CATLAM 1/2 → port/starboard) folded
     * into the SAME cluster/pair pipeline as the OSM file's marks. The chart
     * is the AUTHORITATIVE mark source — the OSM file simply predates ENC
     * coverage in most of SE-QLD; where both know a buoy (~25 m) the OSM
     * copy wins the dedupe (its positions built the existing goldens).
     * Mooloolah River 2026-07-02: 15 ENC beacons, 2 OSM marks — the route
     * ignored every red/green pair until this fold.
     */
    extraLaterals: { lat: number; lon: number; kind: 'port' | 'starboard' | 'special' }[] = [],
): Promise<RegionalChannelData> {
    let dataPromise = url ? rawMarkerFetchCache.get(url) : null;
    if (url && !dataPromise) {
        dataPromise = (async () => {
            const res = await withDeadline(fetch(url), MARKER_FETCH_DEADLINE_MS, 'nav_markers fetch');
            if (!res.ok) throw new Error(`HTTP ${res.status} fetching nav_markers`);
            return (await res.json()) as {
                features?: {
                    properties?: { _class?: string };
                    geometry?: { type?: string; coordinates?: [number, number] };
                }[];
            };
        })();
        // Cache the in-flight promise so concurrent route calls share one
        // fetch — but EVICT on rejection. Caching the unsettled promise
        // with no eviction was the session-poisoning half of the field
        // hang: one stalled socket and every retry (including the
        // :233-281 in-flight dedupe's re-joins) awaited the same dead
        // promise until app restart.
        rawMarkerFetchCache.set(url, dataPromise);
        dataPromise.catch(() => {
            if (url && rawMarkerFetchCache.get(url) === dataPromise) rawMarkerFetchCache.delete(url);
        });
    }
    const data = dataPromise ? await dataPromise : { features: [] };
    return (async () => {
        // ── Step 1: Parse markers ───────────────────────────────
        // Two classes:
        //  - "lateral" channel-marker candidates (port/starboard):
        //    enter the cluster + pair-or-solo pipeline.
        //  - "direct hazard" markers (cardinal, danger, isolated,
        //    notice, pile): never define a channel, always indicate
        //    a hazard. Skip the pairing and emit straight to the
        //    soloHazards list in Step 6.
        //
        // Earlier iteration only filtered port/starboard, which
        // missed the green Scarborough Reef marker (user reported)
        // because it's tagged as a generic hazard, not a paired
        // channel side.
        const markers: Marker[] = [];
        const directHazards: { lat: number; lon: number; cls: string }[] = [];
        const DIRECT_HAZARD_CLASSES = new Set([
            'cardinal',
            'cardinal_n',
            'cardinal_s',
            'cardinal_e',
            'cardinal_w',
            'danger',
            'isolated',
            // 'notice' deliberately omitted from HAZARDS: IALA
            // "special marks" (yellow X-topmark) are informational —
            // no-anchoring zones, fishing areas, water-ski zones,
            // cable crossings. NOT hazards; but they DO enter the
            // cluster pipeline as kind:'special' so a red/yellow or
            // green/yellow MIXED pair can gate a channel edge
            // (Shane's spec: stay between, bias to the lateral).
            // 'pile' deliberately omitted (2026-05-12): mooring
            // piles around port terminals form regular arcs (~15+
            // piles around the SE corner of Fisherman Island
            // terminal). Each was getting a 250 m+ half-circle
            // that overlapped into a continuous wall blocking the
            // direct channel-to-terminal approach. Piles are
            // PHYSICAL but VERY LOCAL — a boat needs to not hit
            // one, but you don't avoid a 250 m radius around each.
            // For routing purposes treat them as not-a-hazard.
            'lateral', // unsubclassed lateral — treat as hazard, not channel side
        ]);
        const droppedByClass = new Map<string, number>();
        // DEBUG — Scarborough Reef area inventory. Tight bbox around
        // -27.190, 153.094 (the green marker user keeps flagging).
        // Remove once the pairing/classification puzzle is solved.
        const scarboroughRawMarkers: string[] = [];
        for (const f of data.features ?? []) {
            if (f?.geometry?.type !== 'Point' || !f.geometry.coordinates) continue;
            const [lon, lat] = f.geometry.coordinates;
            const cls = (f.properties?._class as string | undefined) ?? '';
            // Wider bbox: Navionics has the reef beacon at ~153.133,
            // so we extend the longitude window east to catch it.
            if (lat >= -27.2 && lat <= -27.17 && lon >= 153.08 && lon <= 153.15) {
                scarboroughRawMarkers.push(`${cls} @ ${lat.toFixed(4)},${lon.toFixed(4)}`);
            }
            if (cls === 'port') markers.push({ lat, lon, kind: 'port' });
            else if (cls === 'starboard') markers.push({ lat, lon, kind: 'starboard' });
            else if (cls === 'notice') markers.push({ lat, lon, kind: 'special' });
            else if (DIRECT_HAZARD_CLASSES.has(cls)) directHazards.push({ lat, lon, cls });
            else droppedByClass.set(cls || '<empty>', (droppedByClass.get(cls || '<empty>') ?? 0) + 1);
        }
        // ── Step 1b: ENC lateral fold ──────────────────────────────
        // Chart marks join the pipeline AFTER the file's marks so the
        // ~25 m dedupe below keeps the OSM copy of a shared buoy (the
        // golden-pinned positions) and adds only the chart-exclusive
        // marks (the whole Mooloolah River set).
        if (extraLaterals.length > 0) {
            const DEDUPE_M = 25;
            let folded = 0;
            for (const m of extraLaterals) {
                const mx = 111_320 * Math.cos((m.lat * Math.PI) / 180);
                const dup = markers.some((e) => Math.hypot((e.lon - m.lon) * mx, (e.lat - m.lat) * 110_540) < DEDUPE_M);
                if (dup) continue;
                markers.push({ lat: m.lat, lon: m.lon, kind: m.kind });
                folded++;
            }
            if (folded > 0)
                log.warn(`[encLaterals] folded ${folded}/${extraLaterals.length} chart lateral(s) into pairing`);
        }
        if (ROUTE_DEBUG && droppedByClass.size > 0) {
            const summary = [...droppedByClass.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => `${k}=${v}`)
                .join(' ');
            log.warn(`STAGE: marker classes NOT used as hazard or lateral: ${summary}`);
        }
        // Same breakdown for the markers we ARE treating as
        // hazards — so we can see whether one class dominates
        // the OBSTRN count and tune from there.
        if (ROUTE_DEBUG && directHazards.length > 0) {
            const byHazardClass = new Map<string, number>();
            for (const h of directHazards) {
                byHazardClass.set(h.cls, (byHazardClass.get(h.cls) ?? 0) + 1);
            }
            const summary = [...byHazardClass.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => `${k}=${v}`)
                .join(' ');
            log.warn(`STAGE: direct-hazard markers by class: ${summary}`);
        }

        // DEBUG — raw Scarborough-area markers as they come out of
        // nav_markers.geojson. Tells us whether the green Scarborough
        // Reef marker is even in the source data and what `_class`
        // it carries. Compare against what shows up post-pairing in
        // the Scarborough-area hazards block from orientHazardsTowardLand.
        if (ROUTE_DEBUG) {
            if (scarboroughRawMarkers.length > 0) {
                log.warn(`STAGE: Scarborough-area RAW markers (${scarboroughRawMarkers.length}):`);
                for (const line of scarboroughRawMarkers) {
                    log.warn(`  • ${line}`);
                }
            } else {
                log.warn(`STAGE: NO raw markers in Scarborough bbox`);
            }
        }

        // ── Step 2: Cluster markers into channel chains ────────
        // CLUSTER_LINK_M = 350 m: relaxed from 150 m now that the
        // IALA-oriented hazards + coastline-buffered LNDARE block
        // bridge-across-peninsula failures structurally. 150 m
        // was so tight that legitimate dredged-channel chains
        // (Brisbane River main shipping channel has markers
        // spaced 300-500 m apart) fragmented into single-marker
        // clusters with no pairing → no midpoints, no FAIRWY
        // ribbons, A* didn't see the channel as preferred.
        //
        // 350 m comfortably captures real channels while staying
        // tight enough that any cross-peninsula or cross-bay
        // false bridges produce segments > SEGMENT_MAX_M (400 m,
        // capped in Step 5 below) and get dropped automatically.
        // The hazard half-circles defend the peninsula approach
        // regardless of whether a bridging chain forms.
        // CLUSTER_LINK_M = 900 m. Generous enough to link sparser
        // channel pairs (Brisbane River ~500 m, Newport's northern
        // exit ~720-880 m), made SAFE by the orientation-aware
        // gate in clusterMarkers — perpendicular channels stay in
        // separate clusters because new candidates must lie within
        // 100 m of the cluster's PCA-fitted principal axis.
        //
        // History:
        //  • 350 m — too tight, missed Brisbane River pairs ~500 m
        //    apart. Channel pairs each became their own cluster
        //    with one midpoint and zero FAIRWY segments.
        //  • 700 m — fixed Brisbane River.
        //  • 900 m + raw-distance only (2026-05-15) — linked Newport
        //    but ALSO swept up the perpendicular Scarborough channel
        //    into the same cluster (a cross). The PCA chain ordering
        //    produced a zigzag sequence jumping between the two
        //    channels, SEGMENT_MAX_M dropped the long zigzag legs,
        //    and the route got worse. Reverted that day.
        //  • 900 m + orientation gate (today) — same generous link
        //    distance, but the orientation gate keeps perpendicular
        //    channels separate. Newport's 3 pairs at lon ~153.093
        //    link into one chain; Scarborough's pairs ~1 km east of
        //    the Newport line stay a separate chain.
        //
        // Safe also because the LNDARE-between-pair check
        // (`pointInAnyPolygon` on each candidate midpoint) rejects any
        // pair whose channel midpoint lands on solid ground, and
        // SEGMENT_MAX_M=1200 m caps any over-long FAIRWY segment.
        const CLUSTER_LINK_M = 900;
        const clusters = clusterMarkers(markers, CLUSTER_LINK_M);

        // ── Step 3: Per-cluster, pair port↔starboard in chain order ─
        // Markers that don't end up in a mixed-colour cluster are
        // collected as `soloMarkers` and emitted as OBSTRN
        // features (Step 6 below). In IALA-A buoyage a lone
        // port/starboard marker almost always indicates a hazard
        // (reef edge, isolated shoal, dangerous rock) rather than
        // a channel side. The engine's Pass 3 then blocks cells
        // within ~30 m, forcing the route to detour around.
        // Max distance between paired port + starboard markers
        // across a channel. 600 m catches the Brisbane River
        // shipping channel (300-500 m wide) and most other
        // commercial channels.
        //
        // History
        // ───────
        // Was 300 m, which missed wider channels (BR shipping
        // channel markers ended up as 454 solo hazards forming
        // walls along both banks).
        //
        // First 600 m attempt regressed at Newport — false pairs
        // formed across canal complexes (midpoint landed on land,
        // creating a fake channel through buildings/canals).
        //
        // Now safe because the pairing loop additionally rejects
        // any pair whose midpoint falls inside a LNDARE polygon
        // AND is NOT also inside an OSM water polygon (see the
        // dual `pointInAnyPolygon` check below). Pairs that straddle
        // a real river — where LNDARE bleeds across the water but
        // OSM correctly tags the river as `natural=water` — used
        // to be killed silently. Now they're kept, and the Brisbane
        // River shipping-channel midpoints survive into the FAIRWY
        // ribbon that A* follows.
        //
        // 2026-05-19: this was the root cause of "route ignores
        // Brisbane River entirely" — the log showed 562/629 pair
        // candidates rejected by LNDARE, 272 of those wide(>300m)
        // shipping-channel candidates. Most of those rejections
        // are actually in water per OSM.
        const PAIR_MAX_DIST_M = 600;
        // Minimum navigable gate width: two opposite-colour marks closer
        // than this are NOT a channel gate — they're a mark and its own
        // light, a pile/dolphin cluster, or a mis-pair across an adjacent
        // feature. Without this floor such pairs emit a phantom sub-grid
        // "gate" (the field's 16 m → half-width 8 m), which then chokes the
        // engine's fairing guard and pins the route into stepping (reply 30).
        // Conservative at 30 m: a real entrance gate is tens-to-hundreds of
        // metres wide, so the narrowest genuine channel survives; the lost
        // marks degrade to solo hazards via the unpaired path below — the
        // correct IALA-A semantics for a lone mark. The engine's fairing
        // floor (gridResM × 0.5) is the defence-in-depth backstop for any
        // legitimate-but-sub-grid gate that clears this.
        const PAIR_MIN_DIST_M = 30;
        // Max ALONG-CHANNEL station difference for a port+starboard to form a
        // gate. A real gate's two marks sit nearly abeam (station diff ~0);
        // this rejects diagonal pairings with the next gate up the channel,
        // whose midpoints sit BETWEEN gates and skew the ribbon.
        //
        // Replaces a unit-blind `projDiff > 0.01` DEGREE gate (masterplan §3
        // Phase 2). That old gate was effectively DEAD CODE: 0.01° ≈ 1.1 km,
        // but stagger ≤ pairDist ≤ PAIR_MAX_DIST_M (600 m) ≈ 0.006°, so it
        // could never fire — the distance cap was the only real constraint.
        // This metre gate is the first time stagger is actually enforced.
        //
        // Why 500 and not the plan's 250/400: measured end-to-end on the real
        // SE-QLD marker set + the Rivergate fixture (2026-06-11), tighter
        // gates DON'T fail on pairing quality — they fail on the solo-hazard
        // coupling: each killed pair's marks become 'lateral-marker-as-hazard'
        // half-discs, and two such discs at the river mouth detoured the
        // locked Newport→Rivergate route +2 NM (20.37→22.42, +1 caution) at
        // 250/400/450. Final config (500 + the 2-mark axis-flip guard below):
        // 268 → 263 accepted pairs (the 5 lost are all >500 m-stagger
        // diagonals in ≥3-mark clusters), Scarborough 7→7, corridor 44→43,
        // Rivergate polyline byte-IDENTICAL to baseline. RETIGHTEN toward
        // 250 once Phase 3 pair-wings / Phase 5 no-solo-hazard semantics land
        // (an unpaired channel mark should degrade to caution, not a wall) —
        // and when retightening, gate on the local inter-pair bearing, not
        // the cluster-global PCA axis (bent reaches flip true-gate stagger).
        const PAIR_PROJ_MAX_M = 500;
        const pairDiag = {
            considered: 0,
            rejectedByLandare: 0,
            acceptedByOsmWater: 0, // would have been LNDARE-rejected, saved by OSM water tie-break
            acceptedByDepare: 0, // LNDARE-rejected, saved by charted DEPARE/DRGARE (offline tie-break)
            wideConsidered: 0, // pairs > 300 m apart (only possible with PAIR_MAX_DIST > 300)
            wideAccepted: 0,
            wideRejected: 0,
        };
        // DIAGNOSTIC samples — coordinates of pair midpoints in two
        // categories, capped per-category to keep log volume sane:
        //   • osmSaved: midpoints rescued by the OSM-water tie-break.
        //     Cluster pattern tells us where the OSM water polygons
        //     are doing useful work (expected: Brisbane River).
        //   • wideRejected: midpoints of wide (>300m) pairs that were
        //     killed by LNDARE even with OSM in scope. Cluster pattern
        //     tells us WHERE the OSM water coverage is missing — if
        //     these cluster around the river mouth / airport peninsula,
        //     the OSM Brisbane River polygon doesn't extend far enough
        //     downstream and that's why A* doesn't follow the channel.
        const osmSavedSamples: Array<{ lat: number; lon: number; distM: number }> = [];
        const wideRejectedSamples: Array<{ lat: number; lon: number; distM: number }> = [];
        const SAMPLE_CAP = 15;
        const midpointCoords: Midpoint[] = [];
        // Accepted pair endpoints — Step 4.5 emits outboard CAUTION wings
        // from these (masterplan Phase 3; geometry in services/pairWings.ts).
        const acceptedPairs: Array<{ port: { lat: number; lon: number }; stbd: { lat: number; lon: number } }> = [];
        const soloMarkers: Marker[] = [];

        for (let chainId = 0; chainId < clusters.length; chainId++) {
            const cluster = clusters[chainId];
            if (cluster.length < 2) {
                // Isolated single marker — definitely a hazard (a lone SPECIAL is
                // informational, never a hazard — drop it).
                for (const idx of cluster) if (markers[idx].kind !== 'special') soloMarkers.push(markers[idx]);
                continue;
            }

            const clusterPorts: { lat: number; lon: number }[] = [];
            const clusterStbds: { lat: number; lon: number }[] = [];
            const clusterSpecials: { lat: number; lon: number }[] = [];
            for (const idx of cluster) {
                const m = markers[idx];
                if (m.kind === 'port') clusterPorts.push({ lat: m.lat, lon: m.lon });
                else if (m.kind === 'starboard') clusterStbds.push({ lat: m.lat, lon: m.lon });
                else clusterSpecials.push({ lat: m.lat, lon: m.lon });
            }
            if ((clusterPorts.length === 0 || clusterStbds.length === 0) && clusterSpecials.length === 0) {
                // Single-colour cluster with no specials — hazard indicators, not
                // a channel edge. Common at reefs (e.g. Scarborough Reef green
                // marker).
                for (const idx of cluster) if (markers[idx].kind !== 'special') soloMarkers.push(markers[idx]);
                continue;
            }
            if (clusterPorts.length === 0 && clusterStbds.length === 0) continue; // specials only — nothing to gate

            // Sort each list along the cluster's principal axis so
            // index i corresponds to chain-position i.
            //
            // PCA + projections in LOCAL PLANAR METRES. The old version ran
            // both in raw degree space, which (a) mixed anisotropic units
            // (at -27° one degree of lon ≈ 98.9 km vs lat ≈ 110.5 km, so the
            // fitted axis was rotated vs the true metre-space axis) and
            // (b) gated the along-axis pairing at a unit-blind 0.01° ≈ 1.1 km
            // — wide enough to pair a port mark with a starboard mark a full
            // gate ahead (diagonal pairs → midpoints between gates, skewed
            // ribbon). Masterplan §3 Phase 2.
            const allPts = [...clusterPorts, ...clusterStbds, ...clusterSpecials];
            let meanLat = 0;
            let meanLon = 0;
            for (const p of allPts) {
                meanLat += p.lat;
                meanLon += p.lon;
            }
            meanLat /= allPts.length;
            meanLon /= allPts.length;
            const mPerLat = 110_540;
            const mPerLon = 111_320 * Math.cos((meanLat * Math.PI) / 180);
            const toMetres = (p: { lat: number; lon: number }): { lat: number; lon: number } => ({
                lat: (p.lat - meanLat) * mPerLat,
                lon: (p.lon - meanLon) * mPerLon,
            });
            const axis = principalAxis(allPts.map(toMetres));
            const projection = (p: { lat: number; lon: number }): number => {
                const m = toMetres(p);
                return m.lon * axis.lon + m.lat * axis.lat;
            };
            clusterPorts.sort((a, b) => projection(a) - projection(b));
            clusterStbds.sort((a, b) => projection(a) - projection(b));
            // Axis-flip guard: a lone 2-mark cluster (1 port + 1 stbd — an
            // isolated entrance gate) has its PCA axis EQUAL to the
            // cross-channel mark→mark line, so the "along-channel stagger"
            // projection reads the full gate width and would reject the one
            // legitimate pair (whose marks would then become blocking
            // half-disc hazards). With only 2 points no along-channel axis is
            // estimable — skip the stagger gate; the distance + land checks
            // still apply. (Adversarial-review finding, 2026-06-11.)
            const staggerGateActive = allPts.length > 2;

            // Pair each port with the chain-nearest starboard.
            // Track which ports and starboards actually got into a
            // pair — UNPAIRED markers in a mixed-colour cluster are
            // emitted as hazards in Step 6 (they're chain orphans —
            // usually reef edges or isolated marks that should
            // never be passed within the buffer distance).
            let chainOrder = 0;
            const clusterMidStart = midpointCoords.length;
            const pairedPorts = new Set<{ lat: number; lon: number }>();
            const pairedStbds = new Set<{ lat: number; lon: number }>();
            for (const p of clusterPorts) {
                const pProj = projection(p);
                let bestDist = Infinity;
                let bestS: { lat: number; lon: number } | null = null;
                for (const s of clusterStbds) {
                    const projDiff = Math.abs(projection(s) - pProj); // metres along the channel axis
                    if (staggerGateActive && projDiff > PAIR_PROJ_MAX_M) continue;
                    const d = haversineMetres(p.lat, p.lon, s.lat, s.lon);
                    if (d < PAIR_MIN_DIST_M || d >= bestDist || d > PAIR_MAX_DIST_M) continue;
                    pairDiag.considered++;
                    if (d > 300) pairDiag.wideConsidered++;
                    // LNDARE-between-pair check: reject pair if the
                    // midpoint falls inside any land polygon. This is
                    // what lets us bump PAIR_MAX_DIST_M into shipping-
                    // channel territory without false pairs forming
                    // across canal complexes or land features.
                    //
                    // EXCEPTION (2026-05-19): if the midpoint is also
                    // inside an OSM water polygon (river, harbour,
                    // marina), trust OSM. Chart LNDARE polygons in AU
                    // SENC data bleed across river concavities — the
                    // entire Brisbane River sits "inside" a coastal
                    // LNDARE per the chart, so every legitimate
                    // shipping-channel pair midpoint flunks the LNDARE
                    // test. OSM water tags the river correctly, so
                    // using OSM as a tie-breaker rescues those pairs.
                    const midLat = (p.lat + s.lat) / 2;
                    const midLon = (p.lon + s.lon) / 2;
                    if (pointInAnyPolygon(midLon, midLat, lndareFeatures)) {
                        const inOsmWater = pointInAnyPolygon(midLon, midLat, osmWaterFeatures);
                        // DEPARE/DRGARE rescue: a charted depth or dredged area
                        // IS water — the chart's own bathymetry overrides its
                        // own bleeding LNDARE polygon. Unlike the OSM-water
                        // tie-break (which needs the Pi's overlay), this works
                        // OFFLINE because DEPARE ships in the cell pack. Safe
                        // against the canal-complex false pairs the LNDARE check
                        // guards against: a midpoint on a building/spit is not
                        // inside any DEPARE. This is what keeps the Newport bay-
                        // channel gates alive with the Pi switched off.
                        const inChartedWater = !inOsmWater && pointInAnyPolygon(midLon, midLat, chartedWaterFeatures);
                        if (inOsmWater || inChartedWater) {
                            if (inOsmWater) pairDiag.acceptedByOsmWater++;
                            else pairDiag.acceptedByDepare++;
                            if (osmSavedSamples.length < SAMPLE_CAP) {
                                osmSavedSamples.push({ lat: midLat, lon: midLon, distM: d });
                            }
                            // fall through to accept
                        } else {
                            pairDiag.rejectedByLandare++;
                            if (d > 300) {
                                pairDiag.wideRejected++;
                                if (wideRejectedSamples.length < SAMPLE_CAP) {
                                    wideRejectedSamples.push({
                                        lat: midLat,
                                        lon: midLon,
                                        distM: d,
                                    });
                                }
                            }
                            continue;
                        }
                    }
                    if (d > 300) pairDiag.wideAccepted++;
                    bestDist = d;
                    bestS = s;
                }
                if (!bestS) continue;
                pairedPorts.add(p);
                pairedStbds.add(bestS);
                acceptedPairs.push({ port: p, stbd: bestS });
                midpointCoords.push({
                    lat: (p.lat + bestS.lat) / 2,
                    lon: (p.lon + bestS.lon) / 2,
                    pairDistM: bestDist,
                    chainId,
                    chainOrder: chainOrder++,
                });
            }
            // ── Mixed pairs: red/yellow + green/yellow (owner spec 2026-07-02) ──
            // A lateral that found no opposite lateral may gate against a SPECIAL
            // (yellow) mark instead: the boat stays BETWEEN them but the gate
            // point is BIASED toward the lateral (60/40 split) — the yellow only
            // bounds the fairway (works area, spoil ground, cable), while the
            // lateral carries the channel side. Same stagger/width/land guards as
            // the real pairing; a special anchors at most one mixed gate. Real
            // red/green pairs always win (this pass sees only leftovers).
            let mixedAdded = 0;
            if (clusterSpecials.length > 0) {
                const pairedSpecials = new Set<{ lat: number; lon: number }>();
                const tryMixed = (lm: { lat: number; lon: number }, isPort: boolean): void => {
                    const lmProj = projection(lm);
                    let bestDist = Infinity;
                    let bestY: { lat: number; lon: number } | null = null;
                    for (const y of clusterSpecials) {
                        if (pairedSpecials.has(y)) continue;
                        const projDiff = Math.abs(projection(y) - lmProj);
                        if (staggerGateActive && projDiff > PAIR_PROJ_MAX_M) continue;
                        const d = haversineMetres(lm.lat, lm.lon, y.lat, y.lon);
                        if (d < PAIR_MIN_DIST_M || d >= bestDist || d > PAIR_MAX_DIST_M) continue;
                        // Same midpoint-on-water discipline as the real pairing, applied
                        // at the BIASED point the route will actually be asked to sail.
                        const gLat = lm.lat * 0.6 + y.lat * 0.4;
                        const gLon = lm.lon * 0.6 + y.lon * 0.4;
                        if (pointInAnyPolygon(gLon, gLat, lndareFeatures)) {
                            const wet =
                                pointInAnyPolygon(gLon, gLat, osmWaterFeatures) ||
                                pointInAnyPolygon(gLon, gLat, chartedWaterFeatures);
                            if (!wet) continue;
                        }
                        bestDist = d;
                        bestY = y;
                    }
                    if (!bestY) return;
                    pairedSpecials.add(bestY);
                    if (isPort) pairedPorts.add(lm);
                    else pairedStbds.add(lm);
                    // The special stands in on the lateral's EMPTY side, so the pair's
                    // cross-line / wings / shadow-gate semantics stay port-vs-stbd
                    // coherent — and Step 3.5's acceptedPairs↔midpointCoords index
                    // parity (it suppresses both arrays by one index) is preserved.
                    acceptedPairs.push(isPort ? { port: lm, stbd: bestY } : { port: bestY, stbd: lm });
                    midpointCoords.push({
                        lat: lm.lat * 0.6 + bestY.lat * 0.4,
                        lon: lm.lon * 0.6 + bestY.lon * 0.4,
                        pairDistM: bestDist,
                        chainId,
                        chainOrder: chainOrder++,
                    });
                    mixedAdded++;
                };
                for (const p of clusterPorts) if (!pairedPorts.has(p)) tryMixed(p, true);
                for (const s of clusterStbds) if (!pairedStbds.has(s)) tryMixed(s, false);
            }
            // Mixed gates land mid-chain by position, not by insertion order — re-rank
            // this cluster's slice of BOTH parallel arrays along the channel axis so the
            // chain assembler threads them in sailing order (and Step 3.5's index parity
            // survives). Skipped when no mixed gate formed (byte-identical baselines).
            if (mixedAdded > 0) {
                const mids = midpointCoords.slice(clusterMidStart);
                const pairs = acceptedPairs.slice(clusterMidStart);
                const order = mids.map((_, i) => i).sort((a, b) => projection(mids[a]) - projection(mids[b]));
                order.forEach((src, dst) => {
                    midpointCoords[clusterMidStart + dst] = mids[src];
                    acceptedPairs[clusterMidStart + dst] = pairs[src];
                });
                for (let i = 0; i < order.length; i++) midpointCoords[clusterMidStart + i].chainOrder = i;
            }

            for (const p of clusterPorts) {
                if (!pairedPorts.has(p)) soloMarkers.push({ lat: p.lat, lon: p.lon, kind: 'port' });
            }
            for (const s of clusterStbds) {
                if (!pairedStbds.has(s)) soloMarkers.push({ lat: s.lat, lon: s.lon, kind: 'starboard' });
            }
        }

        if (ROUTE_DEBUG)
            log.warn(
                `STAGE: pair-candidate diagnostics — considered=${pairDiag.considered} ` +
                    `rejectedByLandare=${pairDiag.rejectedByLandare} ` +
                    `acceptedByOsmWater=${pairDiag.acceptedByOsmWater} ` +
                    `acceptedByDepare=${pairDiag.acceptedByDepare} ` +
                    `wide(>300m): considered=${pairDiag.wideConsidered} accepted=${pairDiag.wideAccepted} rejected=${pairDiag.wideRejected}`,
            );
        if (ROUTE_DEBUG && osmSavedSamples.length > 0) {
            log.warn(`STAGE: sample midpoints saved by OSM water (${osmSavedSamples.length}):`);
            for (const s of osmSavedSamples) {
                log.warn(`  • ${s.lat.toFixed(4)},${s.lon.toFixed(4)} pairDist=${Math.round(s.distM)}m`);
            }
        }
        if (ROUTE_DEBUG && wideRejectedSamples.length > 0) {
            log.warn(
                `STAGE: sample wide(>300m) midpoints STILL rejected by LNDARE — these are channel pairs OSM water didn't rescue (${wideRejectedSamples.length}):`,
            );
            for (const s of wideRejectedSamples) {
                log.warn(`  • ${s.lat.toFixed(4)},${s.lon.toFixed(4)} pairDist=${Math.round(s.distM)}m`);
            }
        }

        // ── Step 3.5: Collapse the over-pairing fan ─────────────
        // The pairing loop above has no consumed-starboard exclusion, so
        // several ports can each claim the SAME starboard. One physical gate
        // then emits a cloud of near-coincident midpoints — the field's 283
        // gates over a 23 NM corridor (~1 per 150 m, ~6× real channel
        // marking). That dense cloud chokes the engine's fairing gate-serving
        // guard (every served midpoint must stay within tolerance of the
        // faired chord), so the route can't straighten and STEPS. Collapse
        // each fan to its single WIDEST pair.
        //
        // SAFETY — only midpoints that SHARE a starboard mark are ever merged.
        // Two genuinely-distinct gates use four distinct marks and so can
        // never share one: this can NOT drop a real gate, BY CONSTRUCTION
        // (a structural invariant, not a distance threshold). MIDPOINT_DEDUP_M
        // is a secondary cap so a distant mis-pair to a shared starboard can't
        // become the representative. The kept point is a real (port+stbd)/2
        // mark-to-mark centre — never an average, so no centre moves and no
        // route is wrong-sided; keeping the WIDEST keeps the loosest fairing
        // tolerance + widest preferred disc (relax-only). The hard no-go side
        // is the chordClear raster + outboard CAUTION wings (Step 4.5),
        // untouched here — a dropped fan midpoint never guarded a hazard, it
        // only added a redundant SOFT fairing constraint.
        const MIDPOINT_DEDUP_M = 60;
        const suppressed = new Set<number>();
        const byStbd = new Map<{ lat: number; lon: number }, number[]>();
        for (let i = 0; i < acceptedPairs.length; i++) {
            const s = acceptedPairs[i].stbd;
            const arr = byStbd.get(s);
            if (arr) arr.push(i);
            else byStbd.set(s, [i]);
        }
        for (const idxs of byStbd.values()) {
            if (idxs.length < 2) continue; // unique starboard → no fan
            // Widest gate first; stable index tiebreak for deterministic CI.
            idxs.sort((a, b) => midpointCoords[b].pairDistM - midpointCoords[a].pairDistM || a - b);
            for (let a = 0; a < idxs.length; a++) {
                const keep = idxs[a];
                if (suppressed.has(keep)) continue;
                const mk = midpointCoords[keep];
                for (let b = a + 1; b < idxs.length; b++) {
                    const other = idxs[b];
                    if (suppressed.has(other)) continue;
                    const mo = midpointCoords[other];
                    if (haversineMetres(mk.lat, mk.lon, mo.lat, mo.lon) < MIDPOINT_DEDUP_M) {
                        suppressed.add(other);
                    }
                }
            }
        }
        if (suppressed.size > 0) {
            const keptMid = midpointCoords.filter((_, i) => !suppressed.has(i));
            const keptPairs = acceptedPairs.filter((_, i) => !suppressed.has(i));
            // Re-number chainOrder per chain (ascending) so Step 5's byChain
            // walk stays dense + monotonic after the prune.
            const perChain = new Map<number, number>();
            for (const m of keptMid) {
                const n = perChain.get(m.chainId) ?? 0;
                m.chainOrder = n;
                perChain.set(m.chainId, n + 1);
            }
            midpointCoords.length = 0;
            midpointCoords.push(...keptMid);
            acceptedPairs.length = 0;
            acceptedPairs.push(...keptPairs);
            if (ROUTE_DEBUG)
                log.warn(
                    `STAGE: midpoint dedup — suppressed ${suppressed.size} over-paired fan duplicates, ${keptMid.length} gates remain`,
                );
        }

        // ── Step 4: Build midpoint Point features ───────────────
        const midpoints: unknown[] = midpointCoords.map((m) => ({
            type: 'Feature',
            properties: {
                _class: 'channel_midpoint',
                _source: 'pair-inferred-chain-ordered',
                _pairDistanceM: Math.round(m.pairDistM),
                _chainId: m.chainId,
                _chainOrder: m.chainOrder,
            },
            geometry: { type: 'Point', coordinates: [m.lon, m.lat] },
        }));

        // ── Step 4.5: Outboard CAUTION wings per accepted pair ───
        // Masterplan §3 Phase 3: the water outboard of each mark is the
        // side you must not pass on. Engine Pass 5c rasterises these to
        // CAUTION + preferred=0 (never hardBlocked); Pass 3 skips them.
        const wings: unknown[] = acceptedPairs.flatMap((pr) => pairWingFeatures(pr.port, pr.stbd));

        // DEBUG — dump midpoint chain order for the Scarborough area
        // so we can see whether the chain is laying out N-S along the
        // channel (good) or zigzagging E-W across multiple channels
        // (bad — would make the FAIRWY ribbon useless).
        const scarbMidpts = midpointCoords
            .filter((m) => m.lat >= -27.2 && m.lat <= -27.17 && m.lon >= 153.08 && m.lon <= 153.11)
            .sort((a, b) => a.chainId - b.chainId || a.chainOrder - b.chainOrder);
        if (ROUTE_DEBUG && scarbMidpts.length > 0) {
            log.warn(`STAGE: Scarborough-area midpoints (${scarbMidpts.length}) by chain:`);
            let lastChain = -1;
            for (const m of scarbMidpts) {
                if (m.chainId !== lastChain) {
                    log.warn(`  chain ${m.chainId}:`);
                    lastChain = m.chainId;
                }
                log.warn(
                    `    [${m.chainOrder}] @ ${m.lat.toFixed(4)},${m.lon.toFixed(4)} pairDist=${Math.round(m.pairDistM)}m`,
                );
            }
        }

        // ── Step 5: Build ribbon polygons IN CHAIN ORDER ────────
        // Connect midpoint i with midpoint i+1 within the SAME
        // chain. Each segment is a thin rectangle (~20 m wide)
        // aligned with the connecting line. No cross-channel
        // artefacts because we only connect within a chain.
        // FAIRWY ribbon half-width: 30 m (60 m total) means each
        // ribbon covers at least 1 cell at our 50 m grid even at
        // the narrowest, and 2+ cells through the middle. A 10 m
        // half-width (20 m total) left ribbons narrower than a
        // single grid cell — A* could dodge around them by ½ cell
        // and the channel preference didn't bite. The user
        // observed exactly this on the Brisbane River shipping
        // channel approach.
        // FAIRWY ribbon half-width. Was 30 m (60 m total). At the
        // engine's 50 m grid resolution, a 60 m ribbon only covers
        // 1 cell column reliably — and only when the ribbon
        // happens to straddle two cell centres. When the cell
        // centre falls outside the ribbon (the diagonal case),
        // NO cells get flagged as preferred and A* loses the
        // channel hint entirely. Bumping to 100 m (200 m total)
        // guarantees 3-4 cell-wide coverage regardless of
        // orientation, so the preferred strip is contiguous and
        // wide enough for A* to follow without threading a needle.
        // 200 m is still narrower than a typical shipping channel
        // (the Brisbane River dredged channel is ~150-300 m wide)
        // so we don't bleed preference into hazard-side cells.
        const HALF_WIDTH_M = 100;
        // Re-group midpoints by chain to walk them in order
        const byChain = new Map<number, Midpoint[]>();
        for (const mp of midpointCoords) {
            const arr = byChain.get(mp.chainId) ?? [];
            arr.push(mp);
            byChain.set(mp.chainId, arr);
        }
        for (const arr of byChain.values()) {
            arr.sort((a, b) => a.chainOrder - b.chainOrder);
        }

        // SEGMENT_MAX_M = 600: drop segments where consecutive
        // chain-midpoints sit more than 600 m apart. Bumped from
        // 400 m so the Brisbane River shipping channel — markers
        // routinely 400-500 m apart on the long straight stretches
        // — stays connected as a continuous ribbon instead of
        // fragmenting at every wide gap. The IALA-oriented
        // hazards + coastline-buffered LNDARE + cross-bay false
        // bridges being uncommon at chain-clusters that span 600 m
        // mean we don't pay the over-block tax we'd have paid at
        // the old 150 m CLUSTER_LINK_M.
        // Max gap between consecutive chain-ordered midpoints. Was
        // 600 m. The Brisbane River shipping channel has marker
        // pairs at the *bends* spaced 800-1000 m apart on the long
        // straight stretches between curves, which at 600 m left
        // ribbon gaps right where A* needs to commit. Bumped to
        // 1200 m to bridge those gaps. False bridges (across-
        // peninsula chains) at 1200 m are still rare because the
        // CLUSTER_LINK_M=350 m clustering won't link markers
        // 1200 m apart in the first place — only WITHIN a cluster
        // do we draw segments, and a cluster spans ≤350 m hops.
        const SEGMENT_MAX_M = 1200;
        const segments: unknown[] = [];
        // Ribbon-continuity diagnostic (#19, 2026-05-20). Per multi-pair
        // chain: where it is (centroid — lets us ID the Brisbane River
        // chain near the destination), how many segments connect it, and
        // how many consecutive-midpoint gaps got dropped for being
        // >SEGMENT_MAX_M. A dropped gap = a hole in the channel ribbon
        // where A* free-routes (and can cut to the shallow side). Tells
        // us whether the "route crosses the markers to the far side"
        // symptom is a ribbon GAP (fill it) vs a continuous-but-too-weak
        // ribbon flattened by the OSM-water 1.0× promotion (re-tier cost).
        const chainRibbonDiag: string[] = [];
        for (const [cid, arr] of byChain.entries()) {
            let emitted = 0;
            let droppedGap = 0;
            let maxGapM = 0;
            for (let i = 0; i < arr.length - 1; i++) {
                const a = arr[i];
                const b = arr[i + 1];
                const midLat = (a.lat + b.lat) / 2;
                const mPerLonAtMid = 111_320 * Math.cos((midLat * Math.PI) / 180);
                const dxM = (b.lon - a.lon) * mPerLonAtMid;
                const dyM = (b.lat - a.lat) * 111_320;
                const lenM = Math.sqrt(dxM * dxM + dyM * dyM);
                if (lenM > maxGapM) maxGapM = lenM;
                if (lenM < 1 || lenM > SEGMENT_MAX_M) {
                    if (lenM > SEGMENT_MAX_M) droppedGap++;
                    continue;
                }
                const perpDxM = (-dyM / lenM) * HALF_WIDTH_M;
                const perpDyM = (dxM / lenM) * HALF_WIDTH_M;
                const perpDLon = perpDxM / mPerLonAtMid;
                const perpDLat = perpDyM / 111_320;
                segments.push({
                    type: 'Feature',
                    properties: {
                        _layer: 'FAIRWY',
                        _class: 'synthetic-channel-segment',
                        _source: 'chain-ordered',
                        _chainId: a.chainId,
                        _lengthM: Math.round(lenM),
                    },
                    geometry: {
                        type: 'Polygon',
                        coordinates: [
                            [
                                [a.lon + perpDLon, a.lat + perpDLat],
                                [a.lon - perpDLon, a.lat - perpDLat],
                                [b.lon - perpDLon, b.lat - perpDLat],
                                [b.lon + perpDLon, b.lat + perpDLat],
                                [a.lon + perpDLon, a.lat + perpDLat],
                            ],
                        ],
                    },
                });
                emitted++;
            }
            if (ROUTE_DEBUG && arr.length >= 2) {
                let cLat = 0;
                let cLon = 0;
                for (const m of arr) {
                    cLat += m.lat;
                    cLon += m.lon;
                }
                cLat /= arr.length;
                cLon /= arr.length;
                chainRibbonDiag.push(
                    `chain ${cid}: ${arr.length}mp @ ${cLat.toFixed(3)},${cLon.toFixed(3)} → ${emitted}seg ${droppedGap}gap-dropped maxGap=${Math.round(maxGapM)}m`,
                );
            }
        }
        if (ROUTE_DEBUG)
            log.warn(
                `STAGE: ribbon continuity (${chainRibbonDiag.length} multi-pair chains): ${chainRibbonDiag.join(' || ')}`,
            );

        // ── Step 6: Solo + direct-hazard markers → OBSTRN points ─
        // Solo lateral markers (unpaired in their cluster) join
        // the directHazards collected in Step 1 (cardinals, dangers,
        // notices, piles, generic lateral). All emitted as OBSTRN
        // Point features for the engine's Pass 3 buffer.
        const hazards: unknown[] = [
            ...soloMarkers.map((m) => ({
                type: 'Feature' as const,
                properties: {
                    _class: 'lateral-marker-as-hazard',
                    _source: 'solo-lateral-inferred',
                    _markerKind: m.kind,
                },
                geometry: { type: 'Point' as const, coordinates: [m.lon, m.lat] },
            })),
            ...directHazards.map((h) => ({
                type: 'Feature' as const,
                properties: {
                    _class: 'direct-hazard',
                    _source: 'osm-class',
                    _osmClass: h.cls,
                },
                geometry: { type: 'Point' as const, coordinates: [h.lon, h.lat] },
            })),
        ];

        return { midpoints, segments, hazards, wings, acceptedPairs, diag: pairDiag };
    })();
}

// ═══════════════════════════════════════════════════════════════════════════
// Route-Tracer layer assembly (2026-07-08, Shane's "trace your own route")
// ═══════════════════════════════════════════════════════════════════════════

/** Everything the Route Tracer needs to grade a hand-drawn leg. */
export interface TracerLayerBundle {
    merged: InshoreLayers;
    cellsUsed: string[];
    /** Accepted port/stbd gate pairs (regional file + folded ENC laterals) —
     *  the tracer checks each traced leg THREADS these, not passes outside. */
    gatePairs: Array<{ port: { lat: number; lon: number }; stbd: { lat: number; lon: number } }>;
    /**
     * True when this window EXPECTED gate pairs but the marker fetch threw, so
     * `gatePairs` is empty for a reason that has nothing to do with the water.
     *
     * Without this the failure is indistinguishable from "no gates here": a leg
     * that was never gate-checked graded CLEAR and was banked to localStorage
     * as though it had been checked, so a reload showed a clean strip. An empty
     * `gatePairs` is only trustworthy when this is false.
     */
    gateChecksUnavailable: boolean;
    supplementalChecksUnavailable?: boolean;
    /** The cells' chart bridges, overhead cables and overhead pipes — the
     * tracer turns the ones this mast cannot pass under into low-clearance
     * bars (routeTracer, overheadClearance.chartClearanceBars), as the router
     * does. MIRROR of the engine merge's chartStructures. */
    chartStructures?: Record<ClearanceStructureLayer, GeoJSON.Feature[]>;
    /** Extents of the window's cells that carry no bridge / overhead-line
     * layers (converted before schema 2): the tracer's legs through them say
     * the chart's overhead clearance was not checked (owner decision 8). The
     * MIRROR of the engine merge's structuresUnknownCells (fix-up, 2026-09-30). */
    structuresUnknownBboxes?: [number, number, number, number][];
}

/**
 * Assemble the SAME layer blob the live router feeds the engine, for an
 * arbitrary bbox — so the Route Tracer's per-leg verdicts (depth, land,
 * berths, cardinals, NtM surveyed depths) agree with what a real route
 * through the same water would say.
 *
 * DELIBERATELY a parallel implementation of the assembly inside
 * tryInshoreRouteInner (cells → scale-shadow → OSM overlay → regional
 * markers → ENC cardinal fold → curated fairways → NtM), NOT a refactor of
 * it: the live path is device-critical and on-water-verified, so the tracer
 * takes the duplication risk instead of the regression risk. If you change
 * an injection recipe there, mirror it here (both sites are marked).
 * Differences by design:
 *   • no regional MIDPOINT/FAIRWY-segment/pair-wing injection — those bias
 *     A* toward channels; the tracer grades the skipper's own line instead
 *     (wings would double-flag legs its explicit gate check already grades).
 *   • gate pairs are RETURNED for the explicit thread-the-gate check.
 * Returns null when no installed ENC cells intersect the bbox.
 */
export async function assembleTracerLayers(
    bbox: [number, number, number, number],
    opts: { chartedDepthOnly?: boolean } = {},
): Promise<TracerLayerBundle | null> {
    const [minLon, minLat, maxLon, maxLat] = bbox;
    // Same count+byte bound the map merge has had since kill #23. This path
    // never got it: cellsForBBox is an uncapped intersection filter, so a
    // large padded window on the dense AU coast (kill #32: 27 km, the same
    // shore where the map path trimmed 65→14 cells) loaded EVERY blob into
    // one merged bundle, then structured-cloned the lot into the navGrid
    // worker — an unbounded transient landing exactly where the trail went
    // blind. Coverage-ranked capping drops window-corner slivers first, and
    // anything a dropped cell leaves unprobed reads 'uncharted' → the leg
    // carries "no charted depth for part of this leg", never a false green.
    const allCandidates = cellsForBBox(bbox);
    const candidateCells = capCellsForMerge(allCandidates, bbox);
    if (candidateCells.length < allCandidates.length) {
        crumb('tracer:cells-trim', `${allCandidates.length}→${candidateCells.length}cells`);
    }
    if (candidateCells.length === 0) return null;

    const merged: InshoreLayers = {
        LNDARE: { type: 'FeatureCollection', features: [] },
        DEPARE: { type: 'FeatureCollection', features: [] },
        OBSTRN: { type: 'FeatureCollection', features: [] },
        WRECKS: { type: 'FeatureCollection', features: [] },
        UWTROC: { type: 'FeatureCollection', features: [] },
        FAIRWY: { type: 'FeatureCollection', features: [] },
        DRGARE: { type: 'FeatureCollection', features: [] },
        BOYLAT: { type: 'FeatureCollection', features: [] },
        BCNLAT: { type: 'FeatureCollection', features: [] },
        RECTRC: { type: 'FeatureCollection', features: [] },
        NAVLINE: { type: 'FeatureCollection', features: [] },
    };
    const cellsUsed: string[] = [];
    // MIRROR of the engine merge: chart bridges and overhead lines.
    const chartStructures: Record<ClearanceStructureLayer, GeoJSON.Feature[]> = {
        BRIDGE: [],
        CBLOHD: [],
        PIPOHD: [],
        CONVYR: [],
    };
    const structuresUnknownBboxes: [number, number, number, number][] = [];
    // MIRROR of the engine merge: every chart NAVLNE before the lead gate.
    const chartNavLines: GeoJSON.Feature[] = [];
    const encCardinalSrc: {
        geometry?: { type?: string; coordinates?: [number, number] } | null;
        properties?: Record<string, unknown> | null;
    }[] = [];
    const cellExtents = candidateCells.map((c) => ({ id: c.id, bbox: c.bbox }));
    for (const cell of candidateCells) {
        const blob = await loadCellGeoJSON(cell.id);
        if (!blob) continue;
        const shadows = shadowingCells({ id: cell.id, bbox: cell.bbox }, cellExtents);
        // MIRROR of the engine merge: the cell's own scale for `_scaleRank`.
        const scale = cellScaleFacts(cell, blob);
        for (const layer of [
            'LNDARE',
            'DEPARE',
            'OBSTRN',
            'WRECKS',
            'UWTROC',
            'FAIRWY',
            'DRGARE',
            'BOYLAT',
            'BCNLAT',
            'RECTRC',
        ] as const) {
            const fc = blob.layers?.[layer];
            const target = merged[layer];
            if (fc?.features && Array.isArray(fc.features) && target) {
                if ((layer === 'LNDARE' || layer === 'DEPARE') && shadows.length > 0) {
                    const kept = (fc.features as GeoJSON.Feature[]).filter((f) => !featureIsShadowed(f, shadows));
                    // Fineness rank for finest-survey-wins in the grid —
                    // MIRROR of the engine merge above (tryInshoreRouteInner).
                    if (SCALE_RANKED_LAYERS.has(layer)) stampScaleRank(kept, scale);
                    (target.features as unknown[]).push(...kept);
                } else {
                    if (SCALE_RANKED_LAYERS.has(layer)) stampScaleRank(fc.features as GeoJSON.Feature[], scale);
                    (target.features as unknown[]).push(
                        ...(layer === 'RECTRC'
                            ? fc.features.map((feature) => withChartTrackSource(feature, cell.id))
                            : fc.features),
                    );
                }
            }
        }
        const navlne = (blob.layers as Record<string, FeatureCollection | undefined> | undefined)?.NAVLNE;
        if (navlne?.features && Array.isArray(navlne.features)) {
            // MIRROR of the engine merge: only CATNAV 3 leading lines lead.
            chartNavLines.push(...navlne.features);
            (merged.NAVLINE!.features as unknown[]).push(
                ...navLineLeads(navlne.features, 'NAVLNE').map((feature) => withChartTrackSource(feature, cell.id)),
            );
        }
        for (const cl of ['BOYCAR', 'BCNCAR'] as const) {
            const fc = (blob.layers as Record<string, FeatureCollection | undefined> | undefined)?.[cl];
            if (fc?.features && Array.isArray(fc.features)) {
                encCardinalSrc.push(...(fc.features as unknown as typeof encCardinalSrc));
            }
        }
        let structuresExtracted = true;
        for (const layer of CLEARANCE_STRUCTURE_LAYERS) {
            const fc = (blob.layers as Record<string, FeatureCollection | undefined> | undefined)?.[layer];
            if (fc?.features && Array.isArray(fc.features)) chartStructures[layer].push(...fc.features);
            else structuresExtracted = false;
        }
        // MIRROR of the engine merge's structuresUnknownCells.
        if (!structuresExtracted) structuresUnknownBboxes.push(cell.bbox);
        cellsUsed.push(cell.id);
    }
    if (cellsUsed.length === 0) return null;

    // ── OSM overlay → same injection recipe as the live router ──
    let supplementalChecksUnavailable = false;
    let osmOverlay: OsmRouteOverlay | null = null;
    try {
        osmOverlay = await getOsmRouteOverlay([minLon - 0.05, minLat - 0.05, maxLon + 0.05, maxLat + 0.05]);
        // The overlay never throws: after a failure it is EMPTY, which read
        // as "no berths or breakwaters here" and passed the Auto chart review
        // clean. Its provenance tells the two apart (Phase 2b, 2026-10-01):
        // none saved, or only part of the window, is an incomplete check.
        // Disclosure only — it never blocks a planned-only save.
        const coverage = osmOverlay?.provenance?.coverage;
        if (opts.chartedDepthOnly && (coverage === 'none' || coverage === 'partial'))
            supplementalChecksUnavailable = true;
        const fairwy = merged.FAIRWY ?? { type: 'FeatureCollection' as const, features: [] };
        if (!opts.chartedDepthOnly && osmOverlay.water.features.length > 0) {
            const depare = merged.DEPARE ?? { type: 'FeatureCollection' as const, features: [] };
            for (const f of osmOverlay.water.features) {
                (depare.features as unknown[]).push({
                    ...f,
                    properties: { ...(f.properties ?? {}), DRVAL1: 10.0, DRVAL2: 10.0 },
                });
                const props = (f.properties ?? {}) as Record<string, unknown>;
                const promoted =
                    props['water'] === 'river' ||
                    props['water'] === 'harbour' ||
                    props['waterway'] === 'river' ||
                    props['waterway'] === 'riverbank' ||
                    props['harbour'] === 'yes';
                if (promoted && isPolygonWideEnough(f, 200)) {
                    (fairwy.features as unknown[]).push({
                        ...f,
                        properties: { ...(f.properties ?? {}), _promotePreferred: true, _source: 'osm-water-promoted' },
                    });
                }
            }
            merged.DEPARE = depare;
        }
        if (!opts.chartedDepthOnly && osmOverlay.marina.features.length > 0) {
            const depare = merged.DEPARE ?? { type: 'FeatureCollection' as const, features: [] };
            for (const f of osmOverlay.marina.features) {
                (depare.features as unknown[]).push({
                    ...f,
                    properties: { ...(f.properties ?? {}), DRVAL1: 5.0, DRVAL2: 5.0 },
                });
            }
            merged.DEPARE = depare;
        }
        if (osmOverlay.berths.features.length > 0) {
            merged.BERTH = osmOverlay.berths as unknown as FeatureCollection;
        }
        if (fairwy.features.length > 0) merged.FAIRWY = fairwy;
        if (osmOverlay.reef.features.length > 0) {
            const obstrn = merged.OBSTRN ?? { type: 'FeatureCollection' as const, features: [] };
            for (const f of osmOverlay.reef.features) {
                (obstrn.features as unknown[]).push({
                    ...f,
                    properties: { ...(f.properties ?? {}), _class: 'osm-reef' },
                });
            }
            merged.OBSTRN = obstrn;
        }
        if (osmOverlay.breakwater.features.length > 0) {
            const lndare = merged.LNDARE ?? { type: 'FeatureCollection' as const, features: [] };
            const coast = merged.COASTLINE ?? { type: 'FeatureCollection' as const, features: [] };
            for (const f of osmOverlay.breakwater.features) {
                if (f.geometry.type === 'Polygon' || f.geometry.type === 'MultiPolygon') {
                    (lndare.features as unknown[]).push(f);
                } else if (f.geometry.type === 'LineString' || f.geometry.type === 'MultiLineString') {
                    (coast.features as unknown[]).push(f);
                }
            }
            merged.LNDARE = lndare;
            merged.COASTLINE = coast;
        }
        if (osmOverlay.aeroway.features.length > 0) {
            const obstrn = merged.OBSTRN ?? { type: 'FeatureCollection' as const, features: [] };
            for (const f of osmOverlay.aeroway.features) {
                if (f.geometry.type !== 'Polygon' && f.geometry.type !== 'MultiPolygon') continue;
                (obstrn.features as unknown[]).push({
                    ...f,
                    properties: { ...(f.properties ?? {}), _class: 'osm-aeroway' },
                });
            }
            merged.OBSTRN = obstrn;
        }
        if (osmOverlay.coastline.features.length > 0) {
            const coast = merged.COASTLINE ?? { type: 'FeatureCollection' as const, features: [] };
            for (const f of osmOverlay.coastline.features) (coast.features as unknown[]).push(f);
            merged.COASTLINE = coast;
        }
        if (osmOverlay.canalLines.features.length > 0) {
            const canal = merged.CANAL ?? { type: 'FeatureCollection' as const, features: [] };
            for (const f of osmOverlay.canalLines.features) (canal.features as unknown[]).push(f);
            merged.CANAL = canal;
        }
        if (osmOverlay.navLines.features.length > 0) {
            const navline = merged.NAVLINE ?? { type: 'FeatureCollection' as const, features: [] };
            // MIRROR of the engine merge: the chart's category decides twins.
            for (const f of osmNavLineLeads(osmOverlay.navLines.features, chartNavLines, merged.RECTRC?.features ?? []))
                (navline.features as unknown[]).push(f);
            merged.NAVLINE = navline;
        }
    } catch (err) {
        log.warn(
            `[tracer] OSM overlay failed (chart-only verdicts): ${err instanceof Error ? err.message : String(err)}`,
        );
        supplementalChecksUnavailable = !!opts.chartedDepthOnly;
    }

    // ── Regional markers + folded ENC laterals → gate pairs (returned, not injected) ──
    let gatePairs: TracerLayerBundle['gatePairs'] = [];
    let gateChecksUnavailable = false;
    const swCorner = { lat: minLat, lon: minLon };
    const neCorner = { lat: maxLat, lon: maxLon };
    const regionalMarkersUrl = await pickRegionalMarkersUrl(swCorner, neCorner);
    const encLaterals = encLateralsFromFeatures([
        ...(merged.BCNLAT?.features ?? []),
        ...(merged.BOYLAT?.features ?? []),
    ]);
    let osmRegionalHazards: { geometry?: { coordinates?: [number, number] } }[] = [];
    if (regionalMarkersUrl || encLaterals.length > 0) {
        try {
            const osmWaterForPairing = osmOverlay ? [...osmOverlay.water.features, ...osmOverlay.marina.features] : [];
            const { hazards, acceptedPairs } = await fetchRegionalMarkers(
                regionalMarkersUrl,
                merged.LNDARE?.features ?? [],
                osmWaterForPairing,
                [...(merged.DEPARE?.features ?? []), ...(merged.DRGARE?.features ?? [])],
                encLaterals,
            );
            gatePairs = acceptedPairs;
            osmRegionalHazards = hazards as { geometry?: { coordinates?: [number, number] } }[];
        } catch (err) {
            // NOT recoverable-by-silence. Every leg in this window is about to
            // be graded with zero gate pairs, which reads identically to "this
            // water has no gates" — so the verdict must be marked untrustworthy
            // rather than banked. See TracerLayerBundle.gateChecksUnavailable.
            gateChecksUnavailable = true;
            log.warn(
                `[tracer] regional markers failed (no gate checks): ${err instanceof Error ? err.message : String(err)}`,
            );
        }
    }

    // ── ENC cardinal fold → oriented half-disc hazards (mirror of the live path) ──
    try {
        const encCardinalHazards = encCardinalsToHazards(encCardinalSrc, new Set());
        const encCardinalKeys = new Set<string>(
            encCardinalHazards.map((h) => {
                const [lon, lat] = h.geometry.coordinates;
                return `${lat.toFixed(4)}|${lon.toFixed(4)}`;
            }),
        );
        const filteredOsmHazards = osmRegionalHazards.filter((hh) => {
            const c = hh.geometry?.coordinates;
            return c ? !encCardinalKeys.has(`${c[1].toFixed(4)}|${c[0].toFixed(4)}`) : true;
        });
        const allHazards = [...(filteredOsmHazards as unknown[]), ...encCardinalHazards];
        if (allHazards.length > 0) {
            const orientedHazards = orientHazardsTowardLand(
                allHazards as { geometry: { type: 'Point'; coordinates: [number, number] }; properties?: unknown }[],
                merged.LNDARE?.features ?? [],
            );
            const obstrn = merged.OBSTRN ?? { type: 'FeatureCollection' as const, features: [] };
            (obstrn.features as unknown[]).push(...orientedHazards);
            merged.OBSTRN = obstrn;
        }
    } catch (err) {
        log.warn(`[tracer] ENC cardinal fold failed: ${err instanceof Error ? err.message : String(err)}`);
        supplementalChecksUnavailable = !!opts.chartedDepthOnly;
    }

    // ── Curated fairways + NtM surveyed-depth zones (same gates as live) ──
    const curatedFairways = curatedFairwayCanalFeatures(bbox);
    if (curatedFairways.length > 0) {
        const canal = merged.CANAL ?? { type: 'FeatureCollection' as const, features: [] };
        (canal.features as unknown[]).push(...curatedFairways);
        merged.CANAL = canal;
    }
    try {
        const { activeNtmZonesFor } = await import('./ntmRouting');
        const ntmPad = Math.max(Math.max(maxLat - minLat, maxLon - minLon) * 0.5, 0.08);
        const ntm = await activeNtmZonesFor([minLon - ntmPad, minLat - ntmPad, maxLon + ntmPad, maxLat + ntmPad]);
        if (ntm.features.length > 0) merged.NTMZONE = { type: 'FeatureCollection', features: ntm.features };
        if (ntm.tracklines.length > 0) merged.NTMBAR = { type: 'FeatureCollection', features: ntm.tracklines };
    } catch (err) {
        log.warn(`[tracer] NtM zone injection failed: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
        merged,
        cellsUsed,
        gatePairs,
        gateChecksUnavailable,
        supplementalChecksUnavailable,
        chartStructures,
        ...(structuresUnknownBboxes.length > 0 ? { structuresUnknownBboxes } : {}),
    };
}
