/**
 * The route job (127-ROUTE-W): everything the router does once the charts,
 * the OSM water, the marks, the notices and the tides are in, as ONE pure
 * job — the engine (routeInshore), the lead-graph shadow, the Seaway shadow
 * and its promotion, the mask audit, the result, and the satellite land
 * check's chart verdicts.
 *
 * Shane, 2026-10-10: "yes for a short while it looked as though the app had
 * frozen". This block was that freeze: one long task on the main thread
 * (1.7-1.9 s for a synthetic 20 NM route in WebKit on a Mac; seconds more on
 * the phone). It now runs in the route worker (routeWorkerHost.ts), and on the
 * main thread only where a worker cannot start. Either way it is this same
 * function, so the route is the same, bit for bit (tests/routeJob.parity).
 *
 * In the production build this module's whole static import graph is ONE
 * chunk, `router-engine`, and that chunk IS the route worker's script: it is
 * started from its own URL (ROUTE_ENGINE_URL), and the guarded handler at the
 * bottom does nothing on the main thread (vite.config.ts routeEngineLogger,
 * scripts/route-job-closure.mjs). So this graph must be worker-safe and
 * hold no IO: no storage, network, DOM or plugin, and no logger error()
 * (tests/routeJobPurity.test.ts). The chart cells it is handed live in its
 * memory only and are never written anywhere (o-charts, 2026-10-10).
 *
 * The job never imports InshoreRouter.ts, not even for a type: InshoreRouter
 * imports the job and re-exports what moved here.
 */
import { routeInshore, type InshoreLayers } from '../inshoreRouterEngine';
import type {
    CautionNearShallow,
    ChartedShallowSpan,
    DepthBend,
    DryRun,
    NavGrid,
    PinOffWater,
    PinTail,
    RouteRequest,
    ShallowRunInfo,
    SurveyRunInfo,
    SurveyUncheckedCell,
    TideCeiling,
} from '../engine/types';
import {
    classifyNoTideRuns,
    collectDryRuns,
    NO_TIDE_CLIP_TOLERANCE_M,
    routeCrossesUncheckedShallow,
    tideCeilingLookup,
} from '../engine/tideCeiling';
import type { ChartWaterProbe } from '../engine/chartWaterEvidence';
import {
    auditUnvouchedHardLand,
    backstopChartWaterProbe,
    hardLandAwayFromPinEdges,
    hazardBufferSegments,
    MAX_UNVOUCHED_HARD_LAND_RUN_M,
    unvouchedAlong,
} from '../engine/safetyAudit';
import { UNCHARTED_MAX_RUN_M } from '../engine/constants';
import { collectShallowRuns, collectSurveyRuns } from '../engine/shallowRuns';
import { routeTierMasks } from '../engine/tierPipeline';
import { trimNavGridCache } from '../engine/navGrid';
import { cardinalWrongSideMask } from '../tier3/cardinalClamp';
import { polylineCrossesClearanceBar } from './overheadClearance';
import { samplePolyline, type BackstopChartVerdict, type LonLat } from './backstopSamples';
import type { LeadGraph } from './leadCompiler';
import { routeCachedGrid, shadowCompare, shadowSummary } from '../seaway/seawayRouter';
import { leadPromotionVerdict, leadShadowSummary, searchLeadGraph } from '../seaway/leadGraphSearch';
import { compileSeawayGraph } from '../seaway/graphCompiler';
import { splitMarkFeatures, type PointFeatureLike } from '../seaway/markSplit';
import type { RegionalPair } from '../seaway/gateExtractor';
import type { WaterPackUse } from '../waterPack/waterPackWords';
import { createLogger } from '../../utils/createLogger';

// The lines it logs are the router's, as they always were (the route worker
// forwards them to the main thread's console with the same text).
const log = createLogger('InshoreRouter');
const backstopLog = createLogger('landBackstop');

// Verbose diagnostics, compiled out (the same switch as InshoreRouter's).
const ROUTE_DEBUG = false;

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
    dryRuns?: readonly DryRun[];
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
    // Package 125-05: the engine route crosses dry water — red, each stretch
    // named — where there is no deeper way round; a graph route drawn by its
    // own connectors would carry none of that.
    if (result.dryRuns?.length) return 'engine route crosses dry water (red, named)';
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
        /** The tide ceilings the engine routed with (decision 11): a near
         *  stretch no tide clears is red (round-3 fix-up, 2026-10-03). */
        tideCeilings?: readonly TideCeiling[];
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
    // …and a cardinal's wrong side, as on the engine's route (G2, 2026-10-04).
    const cardinalMask = cardinalWrongSideMask(g.polyline, layers);
    const cautionMask = graphCaution?.map(
        (c, i) => c || unvouched?.segMask[i] === true || nearHazard[i] === true || cardinalMask[i],
    );
    const tiers = grid ? routeTierMasks(g.polyline, grid, layers, chanMask) : null;
    // Every segment's clearance from the shallow bands is measured here as on
    // an engine route (the real-chart check, 2026-10-03): the promoted
    // route's caution comes from the graph's cell samples, so a segment whose
    // cells read clean was never measured — Cid Harbour's connector leg 4.3 m
    // off South Molle's reef was drawn green.
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
                  cardinalMask,
                  ...(tiers ? { canalMask: tiers.canalMask } : {}),
                  ...(base.tideCeilings?.length ? { tideCeilings: base.tideCeilings } : {}),
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
        // Nor across DRY water (package 125-05 review fix-up, 2026-10-09):
        // drying ground no known tide lifts to the need — with no tide data,
        // any drying ground — which the engine names, red (collectDryRuns).
        // An engine route that names any is never replaced
        // (seawayPromotionBlockReason), so it crosses none: a graph route
        // that does would ship it unnamed and follow on one tap. The draft is
        // only words on a stretch, not read here.
        const dry = collectDryRuns(layers, polyline, lookup, noTide.needM, noTide.needM);
        if (dry.length > 0)
            return `crosses dry water (${dry.map((d) => d.place).join('; ')}) the engine route goes round`;
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

// ── The result ──────────────────────────────────────────────────────

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
    /** A pin in charted-shallow water: its depth, the tide it needs, and
     *  whether its tail runs direct — or why not (engine RouteResult.pinTail;
     *  Shane, 2026-10-03). The route notes say why when it does not. */
    pinTail?: { origin?: PinTail; destination?: PinTail };
    /** The route's turn off the straight line for deeper water (engine
     *  RouteResult.depthBend; Port of Airlie, 2026-10-04): the route notes say why. */
    depthBend?: DepthBend;
    /** The stretches over water no tide clears the route crosses, red, where
     *  there is no deeper way round (engine RouteResult.dryRuns; package
     *  125-05): the route notes name each one. */
    dryRuns?: DryRun[];
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
     * What this route's own charts say at every sample of the satellite land
     * check (services/routing/landBackstop, 2026-10-02; backstopSamples
     * samplePolyline of `polyline`) — the cells as merged for it (ranked) plus
     * the OSM water it was routed on: an ETOPO land sample counts only where
     * this is not 'water'. Every caller of the check passes it (Auto, the
     * passage planner, the voyage form). Worked out by the route job where it
     * routed (127-ROUTE-W: it was a probe function, which cannot come back
     * from the route worker); plain words, so it clones. Absent when the probe
     * could not be built (the check then counts every ETOPO land sample, as
     * before).
     */
    chartVerdicts?: BackstopChartVerdict[];
    distanceNM: number;
    cellsUsed: string[];
    elapsedMs: number;
}

export interface InshoreRouteFailure {
    error: string;
    code?: string;
    cellsUsed?: string[];
    /** As InshoreRouteResult.waterPack. With an end's water missing offline,
     *  `error` leads with that (owner decision 2); the code is the engine's. */
    waterPack?: WaterPackUse;
}

// ── The job ─────────────────────────────────────────────────────────

/** The router's request as tryInshoreRoute builds it (always strict in the app). */
export type RouteJobRequest = RouteRequest & {
    draftM: number;
    safetyM: number;
    obstructionBufferM: number;
    unchartedPolicy: 'permissive' | 'strict';
    surveyUncheckedCells: readonly SurveyUncheckedCell[];
};

/**
 * One route, as tryInshoreRoute posts it: plain data only, so it crosses to
 * the route worker as a structured clone (tests/routeJob.clone.test.ts).
 */
export interface RouteJob {
    /** The cells as merged for this route, with the OSM water, bridges, marks and notices. */
    layers: InshoreLayers;
    routeOpts: RouteJobRequest;
    origin: InshoreOrigin;
    destination: InshoreOrigin;
    airDraftM: number | null;
    cellsUsed: string[];
    /** Cells with no bridge / overhead layers, and each one's extent (as entries, not a Map). */
    structuresUnknownCells: string[];
    structuresUnknownBboxes: [string, [number, number, number, number]][];
    /** The regional marker file's accepted port/starboard pairs (the Seaway graph's tier 2). */
    regionalPairs: RegionalPair[];
    /** The chart overlay's compiled lead graph for the route's corridor, or null (telemetry only). */
    leadGraph: LeadGraph | null;
    tideCeilings: readonly TideCeiling[];
    /** The dormant cloud router's answer (CLOUD_ROUTER_ENABLED is false): the engine is not run again. */
    cloud?: { polyline: [number, number][]; distanceNM: number; elapsedMs: number };
}

/** What a job took, for the EXIT line: wall-clock ms, so they compare across threads. */
export interface RouteJobTimings {
    startedAt: number;
    engineMs: number;
    shadowMs: number;
    endedAt: number;
}

export interface RouteJobOutput {
    result: InshoreRouteResult | InshoreRouteFailure | null;
    timings: RouteJobTimings;
    /** The job threw a stack overflow (result null): the host routes it again on the main thread. */
    outOfStack?: true;
}

// ── The satellite land check's chart verdicts ───────────────────────

/**
 * The probe's verdict at every sample of the land check on `polyline`
 * (backstopSamples samplePolyline). A probe that throws vouches nothing there
 * ('unchecked', fail closed), with the one warn line the check has always
 * given (landBackstop.inshoreRouteCrossesLand).
 */
export function chartVerdictsAlong(
    probe: ChartWaterProbe,
    polyline: readonly [number, number][],
): BackstopChartVerdict[] {
    let failed = false;
    return samplePolyline(polyline as LonLat[]).map(([lon, lat]) => {
        try {
            return probe(lon, lat);
        } catch (e) {
            if (!failed) backstopLog.warn('[landBackstop] chart evidence failed — it vouches nothing there:', e);
            failed = true;
            return 'unchecked';
        }
    });
}

/**
 * The satellite land check's chart evidence for a finished route: the probe
 * over the route's own layers (safetyAudit.backstopChartWaterProbe), indexed
 * over the route's own bbox only, asked at every sample. Never throws: a
 * probe that cannot be built is left off, and the check then trusts no chart
 * (fail closed).
 */
export function routeChartVerdicts(
    layers: InshoreLayers,
    polyline: readonly [number, number][],
): { chartVerdicts?: BackstopChartVerdict[] } {
    let probe: ChartWaterProbe;
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
        probe = backstopChartWaterProbe(layers, [w - pad, sLat - pad, e + pad, n + pad]);
    } catch (err) {
        log.warn(`chart evidence for the land check unavailable: ${err instanceof Error ? err.message : String(err)}`);
        return {};
    }
    return { chartVerdicts: chartVerdictsAlong(probe, polyline) };
}

// ── The job itself ──────────────────────────────────────────────────

/**
 * Route one job: the engine, the shadows, the promotion and the result. Pure:
 * the same job gives the same route on any thread. A job that throws is
 * today's "local inshore route compute threw": no route (null), never run
 * again elsewhere, except a stack overflow. A worker's stack is far shallower
 * than the page's (Playwright WebKit, 2026-10-11: 3,145 frames of a trivial
 * recursion in a module worker, 39,923 on the main thread), so a job that
 * overflowed in the worker says so, and the host routes it on the main thread.
 */
export function runRouteJob(job: RouteJob): RouteJobOutput {
    const timings: RouteJobTimings = { startedAt: Date.now(), engineMs: 0, shadowMs: 0, endedAt: 0 };
    const output: RouteJobOutput = { result: null, timings };
    try {
        output.result = routeJobResult(job, timings);
    } catch (err) {
        log.warn(`local inshore route compute threw: ${err instanceof Error ? err.message : String(err)}`);
        if (err instanceof RangeError && /stack/i.test(err.message)) output.outOfStack = true;
    }
    timings.endedAt = Date.now();
    return output;
}

function routeJobResult(job: RouteJob, timings: RouteJobTimings): InshoreRouteResult | InshoreRouteFailure | null {
    const t0 = Date.now();
    const merged = job.layers;
    const routeOpts = job.routeOpts;
    const { origin, destination, cellsUsed, tideCeilings } = job;
    const surveyUncheckedCells = routeOpts.surveyUncheckedCells;
    const regionalPairsForShadow = job.regionalPairs;
    const routedOnCloud = !!job.cloud;
    // Each such cell's extent: the caveat counts only the cells the ROUTE
    // crosses, not every cell merged for its window (fix-up, 2026-09-30).
    const structuresUnknownBbox = new Map(job.structuresUnknownBboxes);
    const structuresUnknownOn = (polyline: readonly [number, number][]): string[] =>
        job.structuresUnknownCells.filter((id) => {
            const b = structuresUnknownBbox.get(id);
            return !b || polylineTouchesBbox(polyline, b);
        });
    /** The finished route crosses water a tide must clear where no tide was
     *  loaded (fix-up, 2026-10-01): offline, a bucket past the cap, a fetch
     *  that timed out. Only then the caveat — an all-deep route never needed
     *  a tide, and a partial load used to say nothing. */
    const tideUnchecked = (polyline: readonly [number, number][]): boolean =>
        routeCrossesUncheckedShallow(
            merged,
            polyline,
            tideCeilingLookup(tideCeilings),
            routeOpts.draftM + routeOpts.safetyM,
        );

    let result: ReturnType<typeof routeInshore>;
    if (job.cloud) {
        result = { polyline: job.cloud.polyline, distanceNM: job.cloud.distanceNM } as ReturnType<typeof routeInshore>;
    } else {
        // An engine throw is runRouteJob's: today's words, no route.
        result = routeInshore(merged, routeOpts);
    }
    const elapsedMs = job.cloud ? job.cloud.elapsedMs : Date.now() - t0;
    timings.engineMs = elapsedMs;
    const tShadows = Date.now();
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
    // charts (peekLeadGraphForView, asked on the main thread before the job)
    // — on a miss it logs 'no-graph' and stops.
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
            // Looked up on the main thread before the job, for the route's
            // corridor (the chart overlay's compiled-graph cache lives there).
            const leadGraph = grid ? job.leadGraph : null;
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
                        dryRuns: (result as { dryRuns?: DryRun[] }).dryRuns,
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
                            tideCeilings,
                        });
                        // The land it crosses, on its own geometry (2026-10-01
                        // review): a promoted route never reports a pin off the
                        // water (seawayPromotionBlockReason), so all of it counts.
                        const promotedLand =
                            routeOpts.unchartedPolicy === 'strict' ? auditUnvouchedHardLand(merged, g.polyline) : null;
                        const promotedAway = promotedLand
                            ? hardLandAwayFromPinEdges(promotedLand, { origin: false, destination: false })
                            : null;
                        timings.shadowMs = Date.now() - tShadows;
                        return {
                            ...promoted,
                            ...routeChartVerdicts(job.layers, g.polyline),
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

    timings.shadowMs = Date.now() - tShadows;

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
        ...((result as { pinTail?: InshoreRouteResult['pinTail'] }).pinTail
            ? { pinTail: (result as { pinTail?: InshoreRouteResult['pinTail'] }).pinTail }
            : {}),
        ...((result as { depthBend?: DepthBend }).depthBend
            ? { depthBend: (result as { depthBend?: DepthBend }).depthBend }
            : {}),
        // A pin's dry tail; when the boat floats over it (125-05b) is worked
        // out on the main thread from the tide curves (tryInshoreRouteInner).
        ...((result as { dryRuns?: DryRun[] }).dryRuns?.length
            ? { dryRuns: (result as { dryRuns?: DryRun[] }).dryRuns }
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
        ...routeChartVerdicts(job.layers, result.polyline),
        distanceNM: result.distanceNM,
        cellsUsed,
        elapsedMs,
    };
}

// ── The route worker ────────────────────────────────────────────────

/** This module's own URL: in the production build, the `router-engine` chunk's, the route worker's script. */
export const ROUTE_ENGINE_URL = import.meta.url;
/** What the host starts and runs: the chunk's URL, and the job on this thread (the fallback). */
export const ROUTE_ENGINE = { url: ROUTE_ENGINE_URL, run: runRouteJob };

export type RouteWorkerRequest = { type: 'job'; id: number; job: RouteJob } | { type: 'trim' };
export type RouteWorkerReply =
    | { type: 'ready' }
    | { type: 'init-error'; message: string }
    | { type: 'result'; id: number; output: RouteJobOutput }
    | { type: 'error'; id: number; message: string }
    | { type: 'console'; level: 'warn' | 'error'; text: string };

interface RouteWorkerScope {
    onmessage: ((ev: MessageEvent<RouteWorkerRequest>) => void) | null;
    postMessage(message: RouteWorkerReply): void;
}

const logText = (value: unknown): string =>
    value instanceof Error ? `${value.name}: ${value.message}` : String(value);

/**
 * Inside the route worker. Capacitor shows the main thread's console in
 * Xcode, not a worker's, and lines like "SEAWAY SHADOW", "LEAD SHADOW" and
 * "RENDERED ROUTE" are the Seaway programme's telemetry: each warn or error
 * line is posted to the main thread (text only) and printed there unchanged.
 * Nothing new is logged. A 'trim' (an iOS memory warning) drops the worker's
 * route grids.
 */
function startRouteWorker(scope: RouteWorkerScope): void {
    const post = (message: RouteWorkerReply): void => scope.postMessage(message);
    try {
        for (const level of ['warn', 'error'] as const)
            console[level] = (...args: unknown[]) =>
                post({ type: 'console', level, text: args.map(logText).join(' ') });
        scope.onmessage = (ev) => {
            const message = ev.data;
            if (message.type === 'trim') {
                trimNavGridCache(0);
                return;
            }
            try {
                post({ type: 'result', id: message.id, output: runRouteJob(message.job) });
            } catch (err) {
                post({ type: 'error', id: message.id, message: err instanceof Error ? err.message : String(err) });
            }
        };
        post({ type: 'ready' });
    } catch (err) {
        post({ type: 'init-error', message: err instanceof Error ? err.message : String(err) });
    }
}

// Only in a worker; on the main thread this module just exports.
const workerGlobal = globalThis as unknown as { WorkerGlobalScope?: abstract new () => unknown };
if (typeof workerGlobal.WorkerGlobalScope === 'function' && globalThis instanceof workerGlobal.WorkerGlobalScope)
    startRouteWorker(globalThis as unknown as RouteWorkerScope);
