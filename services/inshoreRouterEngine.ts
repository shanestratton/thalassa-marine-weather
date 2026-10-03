/**
 * Inshore Router Engine — A* pathfinding through ENC navigability grids.
 *
 * THIS IS A DEVICE-SIDE COPY of the pure-compute router that previously
 * lived only on the Pi at `pi-cache/src/services/inshoreRouter.ts`. The
 * two files are kept in sync by hand. Don't add Node-specific imports
 * here — this code runs in the iOS Capacitor web bundle.
 *
 * Why this lives on the phone now
 * ────────────────────────────────
 * The Pi-only version forced every inshore route through a 30-40 s
 * HTTP round-trip with a 60 s CapacitorHttp timeout. Multiple parallel
 * callers (useVoyageForm + usePassagePlanner) queued on the single
 * Node event loop and wedged the server. iPhone CPU is several times
 * faster than a Pi 5, the cell GeoJSON is already on the device after
 * the Pi-cache sync, and there's no network step — so we run the same
 * pure function locally and skip every shared failure mode.
 *
 * The Pi keeps `/api/enc/route` as an external/fallback endpoint, but
 * the iOS app no longer uses it on the hot path.
 *
 * What this does
 * ──────────────
 * Takes the converted ENC GeoJSON for one or more cells, rasterizes the
 * vector hazard layers (LNDARE, DEPARE, OBSTRN, WRECKS, UWTROC) into a
 * 2D navigability grid at meter-scale resolution (default 50m), then
 * runs A* with 8-neighbor moves to find the shortest channel-following
 * path between two points. Output is a simplified polyline.
 *
 * Algorithm
 * ─────────
 * 1. Compute route bbox = origin/dest envelope expanded by margin.
 * 2. Rasterize layers onto a [height x width] grid:
 *    - Default = navigable (depth unknown).
 *    - LNDARE polygon → cell blocked.
 *    - DEPARE polygon w/ DRVAL1 < draft+safety → cell blocked.
 *    - DEPARE polygon w/ DRVAL1 ≥ draft+safety → cell depth = DRVAL1.
 *    - OBSTRN/WRECKS/UWTROC point within buffer → cell blocked.
 * 3. Snap origin/destination to nearest navigable cell (BFS).
 * 4. A* with 8-neighbor moves, cost = step distance, h = great-circle.
 * 5. Reconstruct + Douglas-Peucker simplify.
 *
 * MVP notes
 * ─────────
 * Single-cell only. Multi-cell stitching is Phase 13.2.
 * Default permissive ("no data = open"); tide-aware draft is Phase 13.3.
 * No channel preference cost yet (would penalize leaving DEPARE >5m).
 */

// ── MODULE LAYOUT (carved 2026-06-24) ──────────────────────────────────
// This file is now the ORCHESTRATOR. The engine internals live under
// services/engine/*: constants, types, geometry, aStar, navGrid, pathShaping,
// tierPipeline. The full public surface is re-exported at the bottom (barrel),
// so every external importer of inshoreRouterEngine keeps resolving unchanged.
// NOTE: the pi-cache copy (pi-cache/src/services/inshoreRouter.ts) is still a
// single file — the hand-sync now maps this directory onto that one file.

import { engineLog, ENGINE_DEBUG, M_PER_DEG_LAT, UNKNOWN_OPEN, CAUTION, UNCHARTED_MAX_RUN_M } from './engine/constants';
import type {
    InshoreLayers,
    NavGrid,
    RouteRequest,
    RouteDebug,
    RouteResult,
    RouteFailure,
    RelaxZone,
    PinOffWater,
    PinTail,
    TideBarrier,
} from './engine/types';
import {
    mPerDegLon,
    haversineM,
    gridToLatLon,
    latLonToGrid,
    bresenhamCells,
    douglasPeucker,
    collapseStateRuns,
} from './engine/geometry';
import { aStar, chainCostM, MinHeap } from './engine/aStar';
import { buildNavGridCached, snapWithPredicate, snapToNavigable, labelConnectedComponents } from './engine/navGrid';
import {
    auditUnvouchedHardLand,
    hardLandAtPoint,
    hardLandAwayFromPinEdges,
    hazardBufferSegments,
    isUnvouchedCell,
    MAX_UNVOUCHED_HARD_LAND_RUN_M,
} from './engine/safetyAudit';
import {
    applyShallowClearanceRing,
    chartStateAlong,
    collectShallowRuns,
    collectSurveyRuns,
} from './engine/shallowRuns';
import { directTails } from './engine/directTail';
import {
    smoothPath,
    deStaggerCentred,
    collectFairingMidpoints,
    fairPath,
    tryMarinaCenterline,
} from './engine/pathShaping';
import {
    gridBridgePolyline,
    applyThreeTier,
    applyFairleadAtGrid,
    applyLeadingLineSnap,
    applyLeadingLineApproach,
    tupleDistM,
    tupleLineCrossesHardLand,
} from './engine/tierPipeline';
import { navLineLeads, parseLeadingLines } from './leadingLine';
import {
    chartMarkPoints,
    lateralMarkGates,
    leadVertexMask,
    lineExposureReader,
    LINE_STATE,
    pullTaut,
    threadGateCentres,
} from './engine/stringPull';
import { chartAreaIndexFor, chartedDepthAt, navLinesOnWater } from './routing/leadLandClip';
import { clearanceBarAt, clearanceRefusalMessage, polylineCrossesClearanceBar } from './routing/overheadClearance';
import {
    classifyNoTideRuns,
    NO_TIDE_CLIP_TOLERANCE_M,
    noTideBarriersAt,
    noTideClearsAt,
    noTideClearsRefusal,
    pointAlongM,
    tideCeilingLookup,
    type CeilingLookup,
    type NoTideRun,
    type NoTideSplice,
} from './engine/tideCeiling';

// ── Public API ──────────────────────────────────────────────────────

/**
 * The engine's single lead gate, applied once at routeInshore entry,
 * whatever assembled the layers (the device merge, a fixture, a test):
 *   1. LEADS ONLY — a clearing (CATNAV 1), transit (CATNAV 2) or
 *      uncategorised chart NAVLNE, and any OSM line that redraws one of those
 *      (withoutChartNonLeadTwins), is removed from NAVLINE.
 *   2. ON-WATER SPANS ONLY — every NAVLINE lead and every RECTRC is cut to
 *      the stretches over chart water (services/routing/leadLandClip
 *      navLinesOnWater: the lead compiler's S-57 land rule, owner decision 1
 *      included). A leading line is drawn on to its marks, usually ashore,
 *      and a recommended track can lie on a coarse chart's land paint (the
 *      Moreton corridor's RECTRC 2655, wholly on it): the lead snaps, the
 *      approach, the egress splice and the land audit read NAVLINE / RECTRC
 *      and so never ride a lead over land.
 * The grid is the exception: it clips a lead against its OWN land verdict
 * (navGrid Pass 5b), which also counts the OSM canal carve and OSM-vouched
 * water, so it reads the pre-clip leads from NAVLINE_GRID — cutting the
 * Newport entrance lead with the S-57 rule there refused the production
 * routes (Phase 1 review, 2026-09-29).
 * Returns the same object when nothing changes, so layer identity is kept.
 */
export function withNavLineLeadsOnly(layers: InshoreLayers): InshoreLayers {
    const features = layers.NAVLINE?.features ?? [];
    const leads = features.length > 0 ? navLineLeads(features) : features;
    const navOnWater = leads.length > 0 ? navLinesOnWater(leads, layers) : leads;
    const tracks = layers.RECTRC?.features ?? [];
    const tracksOnWater = tracks.length > 0 ? navLinesOnWater(tracks, layers) : tracks;
    if (navOnWater === features && tracksOnWater === tracks) return layers;
    const out: InshoreLayers = { ...layers };
    if (navOnWater !== features) {
        out.NAVLINE = { ...layers.NAVLINE!, features: navOnWater };
        // The grid's own clip needs the leads before the S-57 cut.
        if (navOnWater !== leads) out.NAVLINE_GRID = { ...layers.NAVLINE!, features: leads };
    }
    if (tracksOnWater !== tracks) out.RECTRC = { ...layers.RECTRC!, features: tracksOnWater };
    return out;
}

/**
 * Compute an inshore route through one or more ENC cells.
 *
 * The caller is responsible for unioning the layers — for an MVP we
 * accept a single merged set of FeatureCollections. Multi-cell routes
 * just need to concat features into a single InshoreLayers struct
 * before calling this.
 */
/** Grid overrides for the fine marina pass (two-tier routing). When set,
 *  force a specific cell size + a fixed padding (small bbox) instead of the
 *  defaults — used to resolve narrow canals the 50 m main grid can't. */
interface GridOverride {
    resolutionM: number;
    padDeg: number;
}

export function dropsProtectedCanalGateContract(
    protectedRoute: { canalMask?: readonly boolean[]; debug?: { threeTier?: string } },
    candidate: { canalMask?: readonly boolean[]; debug?: { threeTier?: string } },
): boolean {
    const protectedProv = protectedRoute.debug?.threeTier ?? '';
    const candidateProv = candidate.debug?.threeTier ?? '';
    if (protectedProv.includes('egress-channel') && !candidateProv.includes('egress-channel')) return true;
    if (protectedProv.includes('canalsnap') && !candidateProv.includes('canalsnap')) return true;
    if ((protectedRoute.canalMask?.some(Boolean) ?? false) && !(candidate.canalMask?.some(Boolean) ?? false))
        return true;
    return false;
}

/** An endpoint that snapped further than this from its pin is cut off from
 *  the routable water (routeInshoreMain's localized relax retry; decision 11
 *  reads it too). */
const FAR_SNAP_M = 500;

/**
 * Why a localized-relaxed route may not replace a strict refusal for water no
 * tide clears (2026-10-01), or null: it crosses charted land away from a
 * pin's own edge (debug.hardLandAwayM, the final audit's figure), or water no
 * tide clears beyond a clip (the engine's own rule, classifyNoTideRuns).
 */
function relaxedRescueFault(layers: InshoreLayers, req: RouteRequest, relaxed: RouteResult): string | null {
    const landM = relaxed.debug?.hardLandAwayM ?? 0;
    if (landM > 0) return `crosses ${Math.round(landM)} m of charted land`;
    const ceilings = tideCeilingLookup(req.tideCeilings);
    if (ceilings.size === 0) return null;
    const sorted = classifyNoTideRuns(layers, relaxed.polyline, ceilings, req.draftM + (req.safetyM ?? 1.0), {
        toleranceM: NO_TIDE_CLIP_TOLERANCE_M,
    });
    const across = [...sorted.crossings, ...sorted.splices];
    if (across.length > 0)
        return `crosses ${Math.round(across.reduce((m, c) => m + c.run.lengthM, 0))} m of water no tide clears`;
    return null;
}

function routeInshoreMain(
    layers: InshoreLayers,
    req: RouteRequest,
    gridOverride?: GridOverride,
): RouteResult | RouteFailure {
    // Try strict first — LNDARE blocks land. If chart topology says the
    // destination is disconnected, return an honest failure. The former
    // grid-wide LNDARE relaxation could manufacture a route through real
    // mainland whenever no water path existed; a red caution line is not an
    // acceptable substitute for a navigable route.
    const strict = routeInshoreOnce(layers, req, false, [], gridOverride);
    // A strict attempt refused for water no tide clears, whose pin snapped
    // far, may only have met that water on its way round to where it snapped
    // (decision 11 fix-up, 2026-10-01: the Newport origin is cut off at some
    // grid alignments, and the refusal named the canal estate's drying ground
    // as "the only way through"). The localized relax retry below is the
    // rescue for exactly that pin, so it runs first.
    const strictNoTideFar =
        'error' in strict &&
        strict.code === 'no-tide-clears' &&
        Math.max(strict.debug?.originSnap?.snapDistanceM ?? 0, strict.debug?.destinationSnap?.snapDistanceM ?? 0) >
            FAR_SNAP_M;
    if ('error' in strict && !strictNoTideFar) {
        return strict;
    }

    // Strict succeeded — but did it start/end where the user actually
    // tapped? When an endpoint sits in a pocket cut off from the routable
    // water body (Newport Marina's shallow canal estate, a drying inlet),
    // the shared-component snap silently drags that endpoint to the
    // nearest big-water cell — Newport snaps the origin ~2 km out into
    // Bramble Bay, so the visible route starts 2 km from the berth and
    // the impassable stretch is hidden in an invisible bridge segment.
    //
    // Honest fix (Shane's call 2026-05-20): if an endpoint snapped far,
    // retry with LNDARE relaxed to CAUTION — but ONLY inside a bounded
    // zone around that endpoint's tap, NOT grid-wide. The first cut at
    // this relaxed the whole grid; A* then found cheaper CAUTION (40×)
    // shortcuts straight across the mainland mid-route and the route
    // crossed land (verified 2026-05-20: "that went sideways. it crossed
    // land"). Confining relaxation to a circle around the problem
    // endpoint lets A* thread the local barrier — which the polyline
    // flags in cautionMask and the renderer draws RED as a "verify
    // pilotage / your draft won't clear this" warning — while every
    // mid-route mainland cell stays hard-blocked, so the route cannot
    // shortcut across land. No fake deep water is carved; the marginal
    // barrier is shown honestly in red.
    //
    // The zone radius scales with how far the endpoint snapped (the
    // barrier is at least that wide) plus margin, capped at 4 km so the
    // relaxed region never spans far enough to reach a competing water
    // body that would let A* shortcut. We only relax around an endpoint
    // that actually snapped far — a well-connected endpoint (Rivergate
    // dest snapped 3 m) gets no zone.
    const originSnapM = strict.debug?.originSnap?.snapDistanceM ?? 0;
    const destSnapM = strict.debug?.destinationSnap?.snapDistanceM ?? 0;
    const zoneRadiusFor = (snapM: number): number => Math.min(snapM * 1.5 + 500, 4000);
    const relaxZones: RelaxZone[] = [];
    if (originSnapM > FAR_SNAP_M) {
        relaxZones.push({ lat: req.fromLat, lon: req.fromLon, radiusM: zoneRadiusFor(originSnapM) });
    }
    if (destSnapM > FAR_SNAP_M) {
        relaxZones.push({ lat: req.toLat, lon: req.toLon, radiusM: zoneRadiusFor(destSnapM) });
    }
    if (relaxZones.length === 0) return strict;

    const strictWorstSnapM = Math.max(originSnapM, destSnapM);
    console.warn(
        `[inshoreEngine] endpoint snapped far (origin ${Math.round(originSnapM)}m / dest ${Math.round(destSnapM)}m) — retrying with ${relaxZones.length} localized relax zone(s) so the route starts at the real berth (barrier shown red, mainland stays blocked)`,
    );
    const relaxed = routeInshoreOnce(layers, req, false, relaxZones, gridOverride);
    if ('error' in relaxed) {
        // A bridge refusal from the relaxed pass is a VERDICT, not a rescue
        // failure: the pin sits behind a fixed bridge the vessel cannot pass.
        // Returning the strict route here would silently start the passage
        // 2 km away and hide the impassable structure.
        // So is a no-tide refusal (owner decision 11, 2026-10-01): the way to
        // the pin crosses water no tide clears for this boat. Returning the
        // strict route would draw a stub that ends kilometres short of it —
        // but only a relaxed route that REACHED the pins proves that (fix-up,
        // 2026-10-01: one that stopped 2.3 km short named a bay clip as "the
        // only way through").
        if (relaxed.code === 'air-draft-blocked' || relaxed.code === 'hard-land-crossing') return relaxed;
        if (relaxed.code === 'no-tide-clears' && relaxed.debug?.noTideCrossing?.reachedPins) return relaxed;
        return strict;
    }
    if ('error' in strict) {
        // The strict refusal was for water no tide clears from a far-snapped
        // pin: the relaxed route stands if it starts (or ends) nearer the pin.
        const relaxedSnapM = Math.max(
            relaxed.debug?.originSnap?.snapDistanceM ?? Infinity,
            relaxed.debug?.destinationSnap?.snapDistanceM ?? Infinity,
        );
        if (relaxedSnapM >= strictWorstSnapM - 200) return strict;
        // …and only if it is a way by WATER (2026-10-01 fix-up; review of the
        // Phase 3 Auto swap): the relax zone opens land up to 4 km from the
        // pin, and the hard-land veto only refuses a run over 500 m. Beside a
        // bank no tide clears, the relaxed route ran 400 m through the land
        // wall next to it, 19 m inside the edge — round the very water the
        // strict pass refused, over land instead (owner decision 11: the deep
        // way round, or no route and why). A relaxed rescue that crosses
        // charted land away from a pin's own edge, or water no tide clears,
        // is no rescue: the strict refusal stands.
        const fault = relaxedRescueFault(layers, req, relaxed);
        if (fault) {
            engineLog.warn(`[noTide] localized-relaxed rescue ${fault} — the strict refusal stands`);
            return strict;
        }
        return relaxed;
    }
    if (dropsProtectedCanalGateContract(strict, relaxed)) {
        console.warn(
            '[inshoreEngine] localized-relaxed route dropped the canal/gate tier contract — keeping strict tiered route',
        );
        return strict;
    }
    // With tides loaded (owner decision 11) the relaxed rescue is a way by
    // WATER or none (2026-10-01 review): beside a bar no tide clears, the
    // relax zone otherwise opens the land next to it and the route goes
    // round the bar over that land — under the 500 m veto. The strict route
    // stands, and routeInshore's verdict reads the gap to the pin.
    if (tideCeilingLookup(req.tideCeilings).size > 0) {
        const fault = relaxedRescueFault(layers, req, relaxed);
        if (fault) {
            engineLog.warn(`[noTide] localized-relaxed route ${fault} — keeping the strict route`);
            return strict;
        }
    }
    const relaxedWorstSnapM = Math.max(
        relaxed.debug?.originSnap?.snapDistanceM ?? Infinity,
        relaxed.debug?.destinationSnap?.snapDistanceM ?? Infinity,
    );
    // Require a meaningful improvement (≥200 m) before swapping, so we
    // don't trade an all-real-water route for a red-flagged one on a tie.
    if (relaxedWorstSnapM < strictWorstSnapM - 200) {
        console.warn(
            `[inshoreEngine] localized-relaxed route starts ${Math.round(relaxedWorstSnapM)}m from tap (vs ${Math.round(strictWorstSnapM)}m strict) — using relaxed, barrier flagged red`,
        );
        return relaxed;
    }
    return strict;
}

/**
 * Public inshore router — TWO-TIER.
 *
 * 1. MAIN pass: routeInshoreMain at the default 50 m grid + full padding.
 *    Carries all the tuned logic (strict/relax retries, far-snap zones, red
 *    caution-flagging) and is the GUARANTEED result / fallback.
 * 2. FINE pass (short routes only): re-route on a small fine-resolution grid
 *    (~10 m, tight padding) so narrow marina/canal channels — which a 50 m
 *    cell is too coarse to resolve — come out mid-channel and clean (the
 *    MarinerEE marina-centerline then fires inside it). Used ONLY if it
 *    VALIDATES against the main route (fineRefinementIsBetter): no endpoint
 *    snaps further (the disconnection/dead-end signature), no new caution,
 *    no wild detour. Otherwise we keep the main route.
 *
 * Worst case = the main 50 m route (today's 99/100). The fine pass can only
 * improve the canal detail, never break the route — the failure mode that
 * bit the earlier single-grid attempt (reverted 765046b3) is caught by the
 * validation and falls back here.
 */
/** Coarse pre-check resolution (reply 19 fix 3). */
const COARSE_PRECHECK_RES_M = 400;

/** The scaffold collapse's tolerance (round 4, 2026-09-30): the canal
 *  re-centre's own ≈2.5 m (tierPipeline recentreCanalRedOnEnc SIMPLIFY_DEG),
 *  a twentieth of a grid cell. */
const SCAFFOLD_TOLERANCE_DEG = 2.5 / 110_000;

/** How near a route must come to each pin to have REACHED it (decision 11
 *  fix-up, 2026-10-01) — routeInshoreMain's far-snap threshold. A pin off
 *  the water (on land, drying or in water no tide clears) is reached at its
 *  edge, as decision 7 has it. */
function reachesPins(r: RouteResult): boolean {
    const end = (which: 'origin' | 'destination'): boolean => {
        if (r.pinOffWater?.[which]) return true;
        const snap = which === 'origin' ? r.debug?.originSnap : r.debug?.destinationSnap;
        const gapM =
            (snap?.snapDistanceM ?? 0) +
            (which === 'destination' ? (r.destinationInlandTrimM ?? 0) + (r.debug?.destinationLandTailTrimM ?? 0) : 0);
        return gapM <= FAR_SNAP_M;
    };
    return end('origin') && end('destination');
}

/** The crossing an attempt was refused for (decision 11), or null. */
const noTideCrossingOf = (r: RouteResult | RouteFailure): NonNullable<RouteDebug['noTideCrossing']> | null =>
    'error' in r && r.code === 'no-tide-clears' ? (r.debug?.noTideCrossing ?? null) : null;

/** The most times routeInshore closes crossed bands and routes again. */
const NO_TIDE_RETRY_ROUNDS = 2;

export function routeInshore(rawLayers: InshoreLayers, req: RouteRequest): RouteResult | RouteFailure {
    const layers = withNavLineLeadsOnly(rawLayers);
    // Owner decision 11 (2026-10-01): with the highest tide known per place,
    // water no tide clears for this boat is impassable (the grid blocks it:
    // navGrid, services/engine/tideCeiling). The route goes the deep way
    // round; where that leaves no way through, there is no route and the
    // refusal names the spot.
    const ceilings = tideCeilingLookup(req.tideCeilings);
    if (ceilings.size === 0) return routeInshoreCore(layers, req);
    const needM = req.draftM + (req.safetyM ?? 1.0);
    // The route without the ceilings — today's — is read at most once, by
    // whichever check below needs it first (fix-up, 2026-10-01: the verdict
    // and the retry each built their own, up to four full routes a request).
    let withoutMemo: RouteResult | RouteFailure | null = null;
    const routeWithout = (): RouteResult | RouteFailure =>
        (withoutMemo ??= routeInshoreCore(layers, { ...req, tideCeilings: undefined, tideBarriers: undefined }));
    const first = routeInshoreCore(layers, req);
    const firstCrossing = noTideCrossingOf(first);
    if (!firstCrossing) return noTideClearsVerdict(layers, req, ceilings, first, routeWithout);
    // The finished route crossed water no tide clears with no local way
    // round it — a bar too thin for the grid to close, or one an off-grid
    // splice ran across (fix-up, 2026-10-01: 30–59 m bars were routed straight
    // over, the final check tolerating a cell of it and reading the bar
    // short). Close every band it crossed, wherever each is proved, and route
    // again: the deep way round. Twice at most, should the way round cross
    // another band.
    let barriers: TideBarrier[] = [...(req.tideBarriers ?? [])];
    let attempt: RouteResult | RouteFailure = first;
    for (let round = 0; round < NO_TIDE_RETRY_ROUNDS; round++) {
        const crossing = noTideCrossingOf(attempt);
        if (!crossing) break;
        const more = noTideBarriersAt(layers, ceilings, needM, crossing.spots).filter(
            (b) => !barriers.some((held) => held.geometry === b.geometry),
        );
        if (more.length === 0) break;
        barriers = [...barriers, ...more];
        attempt = routeInshoreCore(layers, { ...req, tideBarriers: barriers });
        engineLog.warn(
            `[noTide] crossed ${Math.round(crossing.lengthM)} m no tide clears near ${crossing.mid[1].toFixed(4)},${crossing.mid[0].toFixed(4)} — closed ${barriers.length} band(s) and routed again: ${
                'error' in attempt
                    ? `refused (${attempt.code ?? 'no code'})`
                    : `${attempt.distanceNM.toFixed(2)} NM${reachesPins(attempt) ? '' : ', short of a pin'}`
            }`,
        );
    }
    // A way round is a way by WATER (2026-10-01 review): with the crossed
    // band closed, the strict pass snapped a pin across a land wall and the
    // localized relax retry went through the wall beside the band — 400 m on
    // charted land, under the 500 m veto. That is no way round.
    const overLand = !('error' in attempt) && (attempt.debug?.hardLandAwayM ?? 0) > 0;
    if (overLand)
        engineLog.warn(
            `[noTide] the way round crosses ${Math.round((attempt as RouteResult).debug?.hardLandAwayM ?? 0)} m of charted land — no way round`,
        );
    if (!('error' in attempt) && reachesPins(attempt) && !overLand)
        return noTideClearsVerdict(layers, req, ceilings, attempt, routeWithout);
    // No way round. A first route that reached both pins through the crossing
    // proves it is the only way through, and its refusal names it.
    if (firstCrossing.reachedPins) return first;
    // It did not (the real Wynnum → Lytton Reach check, 2026-10-01: its pin
    // was trimmed 2.3 km overland): only today's route can show what is in the
    // way. Its own failure says why (there, 2.2 km of land); across water no
    // tide clears with no local way round, to both pins, that is the only way
    // through; over clips at most, it is the route.
    const without = routeWithout();
    if ('error' in without) return without;
    const sorted = classifyNoTideRuns(layers, without.polyline, ceilings, needM, {
        toleranceM: NO_TIDE_CLIP_TOLERANCE_M,
    });
    if (sorted.crossings.length > 0) {
        if (!reachesPins(without)) return first;
        const worst = sorted.crossings.reduce((a, b) => (b.run.lengthM > a.run.lengthM ? b : a));
        return noTideRefusalFor(layers, req, needM, worst.run, without.debug);
    }
    if (sorted.splices.length === 0) return without;
    // Never the way round over land (above), nor today's route through water
    // no tide clears: the refusal, the safe side.
    return overLand ? first : attempt;
}

/** Decision 11's refusal for a run: the error that names it. */
function noTideRefusalFor(
    layers: InshoreLayers,
    req: RouteRequest,
    needM: number,
    run: NoTideRun,
    debug: RouteDebug | undefined,
): RouteFailure {
    engineLog.warn(
        `[noTide] no way round: today's route crosses ${Math.round(run.lengthM)} m no tide clears near ${run.mid[1].toFixed(4)},${run.mid[0].toFixed(4)} (deepest ${run.deepestM} m + highest ${run.highestM} m < ${needM.toFixed(1)} m) — REFUSING`,
    );
    return {
        error: noTideClearsRefusal(layers, run, req.draftM, needM),
        code: 'no-tide-clears',
        ...(debug ? { debug } : {}),
    };
}

/**
 * Decision 11's verdict on a route built with tide ceilings (2026-10-01).
 * The grid only makes that water impassable; this says why a route stopped
 * short of, or never reached, a pin its way would have reached through such
 * water. When the ceiling-aware attempt failed, or ended (or started) far
 * from a pin with water no tide clears in the gap — and the pin itself is not
 * in such water, which gets a route to the edge of the water a tide clears,
 * nor on land, which explains the gap by itself — today's route (without the
 * ceilings) is read. If it reaches both pins, nearer than this one did,
 * through more than a clip of water no tide clears, there is no way round:
 * the refusal names the spot on it (noTideClearsRefusal). Otherwise the
 * ceiling-aware result stands.
 */
function noTideClearsVerdict(
    layers: InshoreLayers,
    req: RouteRequest,
    ceilings: CeilingLookup,
    routed: RouteResult | RouteFailure,
    routeWithout: () => RouteResult | RouteFailure,
): RouteResult | RouteFailure {
    const needM = req.draftM + (req.safetyM ?? 1.0);
    if ('error' in routed && (routed.code === 'no-tide-clears' || routed.code === 'air-draft-blocked')) return routed;
    const proofAt = noTideClearsAt(layers, ceilings, needM);
    const pinIn = {
        origin: proofAt(req.fromLon, req.fromLat) !== null,
        destination: proofAt(req.toLon, req.toLat) !== null,
    };
    /** Metres between a pin and where the route reached for it. */
    const gapM = (r: RouteResult, which: 'origin' | 'destination'): number =>
        (which === 'origin' ? r.debug?.originSnap?.snapDistanceM : r.debug?.destinationSnap?.snapDistanceM) ?? 0;
    /** Water no tide clears lies between the pin and where the route reached. */
    const gapCrossesNoTide = (r: RouteResult, which: 'origin' | 'destination'): boolean => {
        if (pinIn[which]) return false;
        // The route ran to the pin and was cut back at the water's edge: land
        // explains the gap by itself (fix-up, 2026-10-01: today's route was
        // rebuilt for such a pin, to say nothing).
        if (r.debug?.pinEdgeTrimM?.[which] !== undefined) return false;
        // So does a pin on land (the inland trim). A WATER pin whose relaxed
        // tail was cut back off a spit (destinationLandTailTrimM) is not
        // explained by it (review fix-up, 2026-10-01): the line from the pin
        // to where the route snapped is sampled like any other gap, so a bar
        // no tide clears between them is still found. Land samples on that
        // line read null (proofAt), so a causeway alone says nothing.
        if (which === 'destination' && (r.destinationInlandTrimM ?? 0) > 0) return false;
        const snap = which === 'origin' ? r.debug?.originSnap : r.debug?.destinationSnap;
        if (!snap || snap.snapDistanceM < 150) return false;
        const [pLat, pLon] = which === 'origin' ? [req.fromLat, req.fromLon] : [req.toLat, req.toLon];
        const steps = Math.max(1, Math.ceil(snap.snapDistanceM / 10));
        for (let k = 0; k <= steps; k++) {
            const t = k / steps;
            if (proofAt(pLon + (snap.snappedLon - pLon) * t, pLat + (snap.snappedLat - pLat) * t)) return true;
        }
        return false;
    };
    const suspect =
        'error' in routed ? true : gapCrossesNoTide(routed, 'origin') || gapCrossesNoTide(routed, 'destination');
    if (!suspect) return routed;
    const without = routeWithout();
    if ('error' in without) return routed;
    if (!('error' in routed)) {
        const closer = (which: 'origin' | 'destination'): boolean =>
            !pinIn[which] && gapM(without, which) + 100 < gapM(routed, which);
        if (!closer('origin') && !closer('destination')) return routed;
    }
    // Only a route that reaches the pins across it — no local way round it
    // there, however short (tideCeiling classifyNoTideRuns) — proves it
    // (fix-up, 2026-10-01: any 1-sample run used to refuse, named as "the
    // only way through" when the ceiling-aware attempt failed for another
    // reason).
    if (!reachesPins(without)) return routed;
    const crossings = classifyNoTideRuns(layers, without.polyline, ceilings, needM, {
        toleranceM: NO_TIDE_CLIP_TOLERANCE_M,
    }).crossings;
    if (crossings.length === 0) return routed;
    const worst = crossings.reduce((a, b) => (b.run.lengthM > a.run.lengthM ? b : a));
    return noTideRefusalFor(layers, req, needM, worst.run, routed.debug);
}

function routeInshoreCore(layers: InshoreLayers, req: RouteRequest): RouteResult | RouteFailure {
    const spanDeg = Math.max(Math.abs(req.toLat - req.fromLat), Math.abs(req.toLon - req.fromLon));

    // ── Strict coarse pre-check (field hang 2026-06-12, reply 19) ────
    // A strict 'uncharted-corridor' refusal used to pay the full fine
    // grid build + A* (20-47 s SYNCHRONOUS on device) before saying no —
    // with stale/missing cells, the commonest outcome froze the UI
    // longest. Run the same pipeline on a 400 m grid first (≈64× fewer
    // cells, sub-second). Conservative-correct direction: a coarse cell
    // is vouched if ANY evidence touches it, so coarse unvouched runs
    // are a subset of fine ones and a coarse refusal implies the fine
    // pass would refuse too. Pathological exception accepted: a charted
    // ribbon narrower than 400 m flanked by void can close at coarse
    // resolution — implying confidence through that is what honest-red
    // exists to prevent. Any OTHER coarse failure (no-path etc.) is
    // ignored: coarse topology is unreliable for success, only the
    // unvouched measure is trusted.
    if (req.unchartedPolicy === 'strict' && spanDeg > 0.02 && (req.resolutionM ?? 50) < COARSE_PRECHECK_RES_M) {
        // Without tide ceilings (decision 11, 2026-10-01): a 400 m cell classed
        // by its centre would close water a tide clears, and the detour could
        // read as uncharted. The fine passes below apply them.
        const coarse = routeInshoreMain(
            layers,
            { ...req, tideCeilings: undefined },
            {
                resolutionM: COARSE_PRECHECK_RES_M,
                padDeg: Math.max(spanDeg * 0.5, 0.08),
            },
        );
        if ('error' in coarse && coarse.code === 'uncharted-corridor') {
            coarse.debug = { ...(coarse.debug as RouteDebug), coarsePrecheck: true } as RouteDebug;
            return coarse;
        }
    }

    const main = routeInshoreMain(layers, req);
    if ('error' in main) return main;

    // Long routes already route fine at 50 m, and a fine grid over their
    // span would blow up the cell count — only short (marina/canal-scale)
    // routes get the fine pass. A caller that pinned resolutionM keeps it.
    if (spanDeg >= 0.06 || req.resolutionM) return main; // 0.06° ≈ 3.5 NM

    const fine = routeInshoreMain(layers, req, { resolutionM: 10, padDeg: 0.008 });
    if ('error' in fine) return main;

    if (fineRefinementIsBetter(fine, main, req)) {
        if (ENGINE_DEBUG)
            engineLog.warn(
                `two-tier: fine marina pass accepted (${fine.gridSize.width}x${fine.gridSize.height}, ${fine.polyline.length} pts) over main (${main.gridSize.width}x${main.gridSize.height}, ${main.polyline.length} pts)`,
            );
        fine.debug = { ...(fine.debug as RouteDebug), twoTierFine: true } as RouteDebug;
        return fine;
    }
    return main;
}

/** Accept the fine marina route only if it's at least as safe as the main
 *  route AND doesn't dead-end short of where the user tapped. Because both
 *  routes splice the input coords as their visible endpoints, truncation
 *  shows up as a larger SNAP distance (the real water ends far from the tap
 *  with a bridge segment), not in the polyline ends — so we gate on that. */
function fineRefinementIsBetter(fine: RouteResult, main: RouteResult, _req: RouteRequest): boolean {
    const SNAP_TOL_M = 200;
    const worseSnap = (f?: number, m?: number): boolean => (f ?? 0) > (m ?? 0) + SNAP_TOL_M;
    // 1. No endpoint snapped meaningfully FURTHER than main — the fine grid
    //    disconnecting a narrow canal snaps the endpoint deep into the
    //    estate (the truncation/dead-end signature). Reject that.
    if (worseSnap(fine.debug?.originSnap?.snapDistanceM, main.debug?.originSnap?.snapDistanceM)) return false;
    if (worseSnap(fine.debug?.destinationSnap?.snapDistanceM, main.debug?.destinationSnap?.snapDistanceM)) return false;
    // 2. No NEW caution — never trade an all-clean route for a red-flagged one.
    const fineCaution = (fine.cautionMask ?? []).filter(Boolean).length;
    const mainCaution = (main.cautionMask ?? []).filter(Boolean).length;
    if (fineCaution > mainCaution) return false;
    // 3. Not a wild detour — much longer than main means it wandered.
    if (fine.distanceNM > main.distanceNM * 1.5 + 0.1) return false;
    return true;
}

/**
 * One routing attempt. A pin in CHARTED caution water (owner decision 7,
 * 2026-09-30: "carry on, amber") is routed all the way to — the stretch past
 * the last deep-enough water a 'needs tide' tail. Should the finished route
 * reach such a pin any way but through its own charted water (the tail
 * validation in routeInshoreOnceEnds), the attempt is re-run with today's
 * endpoint rules, never shipped.
 */
function routeInshoreOnce(
    layers: InshoreLayers,
    req: RouteRequest,
    relaxedLndare: boolean,
    relaxZones: RelaxZone[] = [],
    gridOverride?: GridOverride,
): RouteResult | RouteFailure {
    const charted = routeInshoreOnceEnds(layers, req, relaxedLndare, relaxZones, gridOverride, true);
    if (!('error' in charted) || charted.code !== 'charted-end-rejected') return charted;
    engineLog.warn(`[chartedEnd] ${charted.error} — routing to the nearest deep water instead`);
    const today = routeInshoreOnceEnds(layers, req, relaxedLndare, relaxZones, gridOverride, false);
    // Say why the charted end was not used (debug.chartedEndRejected).
    today.debug = { ...(today.debug as RouteDebug), chartedEndRejected: charted.error } as RouteDebug;
    return today;
}

function routeInshoreOnceEnds(
    layers: InshoreLayers,
    req: RouteRequest,
    relaxedLndare: boolean,
    relaxZones: RelaxZone[] = [],
    gridOverride: GridOverride | undefined,
    chartedEnds: boolean,
): RouteResult | RouteFailure {
    const safetyM = req.safetyM ?? 1.0;
    let resolutionM = gridOverride?.resolutionM ?? req.resolutionM ?? 50;
    const obstructionBufferM = req.obstructionBufferM ?? 30;

    // Per-phase timing — we have no idea where the 25-65 s on iOS is going
    // without measuring. Once we have numbers we can stop guessing and
    // attack the actual bottleneck.
    const timings: Record<string, number> = {};
    const t0Total = Date.now();
    const mark = (label: string, start: number): number => {
        const now = Date.now();
        timings[label] = (timings[label] ?? 0) + (now - start);
        return now;
    };

    // Build a route bbox = origin/destination envelope expanded
    // generously. The padding has to be SYMMETRIC across both axes —
    // earlier versions padded each axis by its own span, which left a
    // mostly-N-S route with almost no E-W margin. Real-world example:
    // Newport→Brisbane port is 18 km N-S × 1 km E-W as the crow flies,
    // but the actual navigable channel through Moreton Bay sits 5-7 km
    // east of that line. With per-axis padding (~0.02°≈2 km min), the
    // bbox missed the deepwater channel entirely and the origin
    // snapped into a 5-cell marina basin.
    //
    // 2026-05-19: bumped multiplier 0.25→0.5 and floor 0.05→0.08. The
    // Newport→Pinkenba route was hitting the grid's east edge at exactly
    // Luggage Point (Brisbane River mouth, lon ~153.18). The corridor
    // east of Fisherman Islands that links north Moreton Bay to the
    // river fell outside the grid, leaving the bay and river as two
    // disconnected components (74,357 cells north / 4,592 cells south)
    // with origin reaching only the north and destination only the
    // south. The visible "route through the airport" was just the
    // post-snap bridge segment. With 0.5×, this Newport route gets
    // ~0.10° (~11 km) lateral padding — enough to include the corridor
    // east of Fisherman Islands so the components merge.
    //
    // Short routes (maxSpan ≤ 0.16°) still hit the 0.08° floor; not
    // dramatically larger than before but a touch more breathing room
    // for marina exits.
    const minLat = Math.min(req.fromLat, req.toLat);
    const maxLat = Math.max(req.fromLat, req.toLat);
    const minLon = Math.min(req.fromLon, req.toLon);
    const maxLon = Math.max(req.fromLon, req.toLon);
    const maxSpan = Math.max(maxLat - minLat, maxLon - minLon);
    // Fine marina pass forces a small fixed padding (tight bbox keeps the
    // fine-cell count bounded); otherwise the tuned generous padding.
    const padLat = gridOverride ? gridOverride.padDeg : Math.max(maxSpan * 0.5, 0.08);
    const padLon = gridOverride ? gridOverride.padDeg : Math.max(maxSpan * 0.5, 0.08);
    const bbox: [number, number, number, number] = [minLon - padLon, minLat - padLat, maxLon + padLon, maxLat + padLat];

    // CELL-COUNT CEILING (2026-07-15 crash audit): the route path had NO cap,
    // unlike the tracer (MAX_GRID_CELLS=1M since 2026-07-15). A near-50 NM
    // route at the fixed 50 m res crosses ~12M cells (~600 MB of typed arrays)
    // — the latent OOM kill on iOS. buildNavGrid is also O(features × cells),
    // so uncapped cells drive the 37.8 s freeze too. Coarsen the resolution
    // upward so width×height never exceeds the budget; only bites routes big
    // enough to be open water (where coarser is fine) — a marina/short route
    // stays at 50 m. The fine-marina gridOverride pass keeps its own tight
    // bbox so it never trips this. Mirrors tracerResolutionM.
    {
        const midLatCap = (minLat + maxLat) / 2;
        const mPerLonCap = 111_320 * Math.cos((midLatCap * Math.PI) / 180);
        const wM = (bbox[2] - bbox[0]) * mPerLonCap;
        const hM = (bbox[3] - bbox[1]) * M_PER_DEG_LAT;
        const cellsAt = (wM / resolutionM) * (hM / resolutionM);
        const MAX_ROUTE_CELLS = 2_500_000;
        if (cellsAt > MAX_ROUTE_CELLS) {
            const coarsened = Math.ceil(Math.sqrt((wM * hM) / MAX_ROUTE_CELLS));
            engineLog.warn(
                `route grid ${Math.round(cellsAt / 1e6)}M cells at ${resolutionM}m exceeds ${MAX_ROUTE_CELLS / 1e6}M — coarsening to ${coarsened}m`,
            );
            resolutionM = coarsened;
        }
    }

    let tPhase = Date.now();
    const { grid: cachedGrid, cacheHit: gridCacheHit } = buildNavGridCached(
        layers,
        bbox,
        resolutionM,
        req.draftM,
        safetyM,
        obstructionBufferM,
        relaxedLndare,
        relaxZones,
        req.routeProfile ?? 'safest',
        req.tideCeilings ?? [],
        req.tideBarriers ?? [],
    );
    tPhase = mark(gridCacheHit ? 'buildNavGridCacheHit' : 'buildNavGrid', tPhase);
    // The shallow bands' clearance ring, as a cost (the real-chart check,
    // 2026-10-03): once per cached grid, before this route's copy, so the
    // Seaway shadow's read of the same cached grid prices it too.
    applyShallowClearanceRing(cachedGrid, layers, req.draftM + safetyM);
    tPhase = mark('shallowRing', tPhase);
    // The endpoint carve and the component-bridge carve below write THIS
    // route's rescues into `cells` / `preferred`: a per-route copy, never the
    // cached grid (fix-up, 2026-09-30). Written into the cache, a re-route or
    // a reversed leg with the same key — and the Seaway shadow's read-only
    // lookup — read the last route's 60 m bubble and bridged land as real 5 m
    // water, and decision 7's tail could end early on a fake deep cell. Every
    // other array (and the centring field) is only read, and is shared.
    const grid: NavGrid = { ...cachedGrid, cells: cachedGrid.cells.slice(), preferred: cachedGrid.preferred.slice() };
    if (grid.width === 0 || grid.height === 0) {
        return { error: 'Empty grid', code: 'empty-grid' };
    }

    // Tally grid health for diagnostics — useful when the user
    // reports "no-path" and we need to know whether the grid was
    // mostly land (bad chart for this route) or mostly navigable
    // with a topology issue.

    // ── Endpoint carve ──────────────────────────────────────────────
    // When the user picks an origin/destination, they're asserting "this
    // is water". On ENC charts where LNDARE's GLU-tessellated TRIANGLE_FAN
    // primitives can bleed across narrow rivers (Brisbane River + Rivergate
    // marina is the verified case), the exact endpoint cell can end up
    // hard-blocked even though it's a real marina. Carve a small radius
    // around each endpoint as forced-navigable so the snap algorithm has
    // a target and A* can connect through.
    //
    // 60 m radius — narrow enough to fit any sane marina basin / river
    // bend without bleeding to the opposite shore on a 50 m grid; just
    // big enough that even a slight position error puts the carve in the
    // right water body.
    const mPerLonHere = mPerDegLon((grid.minLat + grid.minLat + grid.height * grid.dLat) / 2);
    const endpointCellIdx = (lat: number, lon: number): number => {
        const { x, y } = latLonToGrid(grid, lat, lon);
        if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return -1;
        return y * grid.width + x;
    };
    const destinationTapIdx = endpointCellIdx(req.toLat, req.toLon);
    const originTapIdx = endpointCellIdx(req.fromLat, req.fromLon);

    // ── Pins in CHARTED caution water (owner decision 7, 2026-09-30) ──
    // "Carry on, amber": a pin in charted-shallow water — a never-drying S-57
    // band shallower than draft + UKC, or decision-1 water (a finer
    // never-drying band under a coarser chart's land paint) — gets a route
    // ALL the way to it. The stretch between it and the last water deep
    // enough for the keel is the route's 'needs tide' tail: red caution in
    // cautionMask, an amber tide chip from shallowRuns with its charted depth,
    // saveable. It used to stop at the nearest deep-enough water instead: 429 m
    // short of the Tangalooma pin, which sits in decision-1 water.
    // Hard limits (grid.chartedShallow): never land, never a drying band,
    // never a hazard / berth buffer, never a structure bar, never uncharted
    // water (Phase 2b's local connector). And the pin's charted water must
    // itself reach deep-enough water (chartedWayToDeep): a tail is never a
    // shortcut through other shallows. A pin on land or a drying bank gets a
    // route that stops at the water's edge — never across the drying ground
    // (round 3, 2026-09-30, below) — and the result says so (pinOffWater).
    const deepFloorM = req.draftM + safetyM;
    // Water no tide clears (owner decision 11, 2026-10-01), against the
    // chart itself: never a pin's charted tail, never a carve, and the pins
    // in it — and the finished route — are held to it below. Null
    // everywhere without tide ceilings.
    const tideLookup = tideCeilingLookup(req.tideCeilings);
    const noTideAt = noTideClearsAt(layers, tideLookup, deepFloorM);
    const isNoTideCell = (idx: number): boolean => grid.noTideClears?.[idx] === 1;
    const isDeepEnough = (idx: number): boolean => {
        const d = grid.cells[idx];
        return !Number.isNaN(d) && d >= deepFloorM;
    };
    const isChartedCaution = (idx: number): boolean => grid.chartedShallow?.[idx] === 1 && grid.cells[idx] < 0;
    /** Step weight through a tail cell: 1 in deep water, and 1 + the metres
     * its charted depth falls short of the keel floor in charted-shallow water
     * — so the tail takes the deeper way to deep water when one is about as
     * short, not a 0 m bank beside a 2 m channel (fix-up, 2026-09-30).
     * Decision-1 water charts no shallow depth (its finest band is deep). */
    const tailStepWeight = (idx: number): number => {
        const s = grid.shallowDepthM?.[idx];
        return s === undefined || Number.isNaN(s) || isDeepEnough(idx) ? 1 : 1 + Math.max(0, deepFloorM - s);
    };
    const isBlockedIdx = (idx: number): boolean => Number.isNaN(grid.cells[idx]);
    /** Cells from the pin cell through its charted caution water to the
     * cheapest deep-enough cell to reach — by distance weighted by
     * shallowness (8-connected, diagonal steps √2, never squeezing
     * diagonally between two blocked cells: a bar's staircase or a land
     * corner), pin first, the deep cell last; null when its charted water
     * reaches none within the snap radius. */
    const chartedWayToDeep = (pinIdx: number): { x: number; y: number }[] | null => {
        const w = grid.width;
        const radius = Math.ceil(10_000 / resolutionM);
        const px = pinIdx % w;
        const py = Math.floor(pinIdx / w);
        const dist = new Map<number, number>([[pinIdx, 0]]);
        const parent = new Map<number, number>([[pinIdx, -1]]);
        const heap = new MinHeap();
        heap.push({ f: 0, idx: pinIdx });
        const wayTo = (idx: number): { x: number; y: number }[] => {
            const way: { x: number; y: number }[] = [];
            for (let c = idx; c !== -1; c = parent.get(c) as number) way.push({ x: c % w, y: Math.floor(c / w) });
            return way.reverse();
        };
        for (let e = heap.pop(); e; e = heap.pop()) {
            if (e.f > (dist.get(e.idx) ?? Infinity)) continue;
            // The first deep cell settled is the cheapest one to reach.
            if (e.idx !== pinIdx && isDeepEnough(e.idx)) return wayTo(e.idx);
            const x = e.idx % w;
            const y = Math.floor(e.idx / w);
            for (let dy = -1; dy <= 1; dy++) {
                for (let dx = -1; dx <= 1; dx++) {
                    if (dx === 0 && dy === 0) continue;
                    const nx = x + dx;
                    const ny = y + dy;
                    if (nx < 0 || ny < 0 || nx >= w || ny >= grid.height) continue;
                    if (Math.max(Math.abs(nx - px), Math.abs(ny - py)) > radius) continue;
                    const n = ny * w + nx;
                    if (!isDeepEnough(n) && !isChartedCaution(n)) continue;
                    // No corner squeeze: a diagonal step needs both of the
                    // cells it cuts between to be open.
                    if (dx !== 0 && dy !== 0 && (isBlockedIdx(y * w + nx) || isBlockedIdx(ny * w + x))) continue;
                    const d = e.f + (dx !== 0 && dy !== 0 ? Math.SQRT2 : 1) * tailStepWeight(n);
                    if (d >= (dist.get(n) ?? Infinity)) continue;
                    dist.set(n, d);
                    parent.set(n, e.idx);
                    // A deep cell is queued like any other; the first one
                    // settled ends the way (above), so no way walks on
                    // through deep water.
                    heap.push({ f: d, idx: n });
                }
            }
        }
        return null;
    };
    // The pin ITSELF, against the chart's own vectors (round-3 review,
    // 2026-09-30) — the same exact predicates the edge cut below uses. A 50 m
    // cell centre can fall in a drying band beside the never-drying band a
    // pin sits 3–22 m inside: the pin then read 'drying' (the route cut 3 m
    // short, and the notice said the pin dries) and got no decision-7 tail.
    const onHardLandPin = hardLandAtPoint(layers);
    const pinBands = chartAreaIndexFor(layers).depth;
    const pinDepthAt = (lat: number, lon: number): number | null =>
        pinBands.length > 0 ? chartedDepthAt(pinBands, lon, lat) : null;
    /** The shallowest depth the finest survey charts along a line (m), on the
     *  charted tail's 5 m walk (tailFault's); +Infinity where no band charts
     *  it — a direct tail's own, and the way it replaces (engine/directTail),
     *  and what a pin's tail needs (pinTail). */
    const leastChartedDepthAlong = (pts: readonly (readonly [number, number])[]): number => {
        let least = Infinity;
        if (pinBands.length === 0) return least;
        const read = (lon: number, lat: number): void => {
            const d = chartedDepthAt(pinBands, lon, lat);
            if (d !== null && d < least) least = d;
        };
        if (pts.length === 1) read(pts[0][0], pts[0][1]);
        for (let i = 0; i + 1 < pts.length; i++) {
            const [lonA, latA] = pts[i];
            const [lonB, latB] = pts[i + 1];
            const steps = Math.max(1, Math.ceil(haversineM(latA, lonA, latB, lonB) / 5));
            for (let k = 0; k <= steps; k++)
                read(lonA + ((lonB - lonA) * k) / steps, latA + ((latB - latA) * k) / steps);
        }
        return least;
    };
    /** The cell a pin's charted 'needs tide' tail starts from (decision 7):
     * its own cell when that is charted caution water; else, for a pin the
     * finest survey charts in a never-drying band shallower than the keel
     * needs (not land), the nearest neighbouring cell that is — the tail's
     * exact checks below still hold its geometry to the chart. -1: none. */
    const exactSpotPin = { origin: false, destination: false };
    const chartedPinCell = (lat: number, lon: number, idx: number, which: 'origin' | 'destination'): number => {
        if (idx < 0) return -1;
        // A pin in water no tide clears gets no 'needs tide' tail: the route
        // stops at the edge of the water a tide does (decision 11).
        if (noTideAt(lon, lat)) return -1;
        if (isChartedCaution(idx)) return idx;
        const d = pinDepthAt(lat, lon);
        if (d === null || d < 0 || d >= deepFloorM || onHardLandPin(lon, lat)) return -1;
        const w = grid.width;
        const px = idx % w;
        const py = Math.floor(idx / w);
        let best = -1;
        let bestM = Infinity;
        for (let dy = -1; dy <= 1; dy++) {
            for (let dx = -1; dx <= 1; dx++) {
                const nx = px + dx;
                const ny = py + dy;
                if ((dx === 0 && dy === 0) || nx < 0 || ny < 0 || nx >= w || ny >= grid.height) continue;
                const n = ny * w + nx;
                if (!isChartedCaution(n)) continue;
                const [cLon, cLat] = gridToLatLon(grid, nx, ny);
                const m = haversineM(lat, lon, cLat, cLon);
                if (m < bestM) {
                    bestM = m;
                    best = n;
                }
            }
        }
        if (best >= 0) exactSpotPin[which] = true;
        return best;
    };
    // Decided BEFORE the origin carve below writes its bubble into the grid.
    const originPinCell = chartedEnds ? chartedPinCell(req.fromLat, req.fromLon, originTapIdx, 'origin') : -1;
    const destinationPinCell = chartedEnds
        ? chartedPinCell(req.toLat, req.toLon, destinationTapIdx, 'destination')
        : -1;
    const originWay = originPinCell >= 0 ? chartedWayToDeep(originPinCell) : null;
    const destinationWay = destinationPinCell >= 0 ? chartedWayToDeep(destinationPinCell) : null;

    // On hard land by the audit's point rule (onHardLandPin), not "inside any
    // land paint" (2026-10-01). The raw test called the Rivergate pin — in a
    // 9.1 m dredged area of the 1:12,000 harbour chart, under the 1:90,000
    // and overview charts' coastline paint — "on charted land" whenever the
    // route could not reach it, and the inland trim then cut 2,660 m of river
    // off the route's end. Decision 1 makes that water, as the audit and the
    // pin notice already said.
    const destinationTapOnHardLand =
        !destinationWay &&
        (destinationTapIdx < 0 ||
            onHardLandPin(req.toLon, req.toLat) ||
            (grid.landBlocked
                ? grid.landBlocked[destinationTapIdx] === 1
                : Number.isNaN(grid.cells[destinationTapIdx])));
    // A pin that is not water a route can reach it through: on hard land (the
    // audit's rule for one point: decision-1 and OSM water are water), or on
    // a drying bank. Reported, and never given a charted 'needs tide' tail
    // (decision 7): the route runs to the nearest cell it snaps to, which for
    // a pin on a drying bank can be ON the bank — and is then cut back to the
    // edge of the water on the finished geometry (round 3, 2026-09-30: "A pin
    // off the water" below); the planner's route notice says which.
    const pinOffWater: { origin?: PinOffWater; destination?: PinOffWater } = {};
    {
        // Exactly at the pin (round-3 review, 2026-09-30): hard land by the
        // audit's point rule, drying by the finest survey's charted depth —
        // the edge cut's own predicates, so the notice never says a pin dries
        // (or is ashore) where the chart says it does not. The 50 m cell used
        // to decide it.
        const offWater = (lat: number, lon: number, idx: number): PinOffWater | undefined => {
            if (idx < 0) return undefined;
            if (onHardLandPin(lon, lat)) return 'land';
            const d = pinDepthAt(lat, lon);
            if (d !== null && d < 0) return 'drying';
            // Decision 11: water that never dries but no tide clears for
            // this boat — the route stops at the edge of the water one does.
            return noTideAt(lon, lat) ? 'no-tide' : undefined;
        };
        const o = originWay ? undefined : offWater(req.fromLat, req.fromLon, originTapIdx);
        const d = destinationWay ? undefined : offWater(req.toLat, req.toLon, destinationTapIdx);
        if (o) pinOffWater.origin = o;
        if (d) pinOffWater.destination = d;
    }

    /** A cell a CHARTED hazard's buffer or area blocks (not a mark disc). */
    const isChartedHazardCell = (idx: number): boolean =>
        grid.obstnBlocked?.[idx] === 1 && grid.markDiscBlocked?.[idx] !== 1;
    const carveEndpoint = (lat: number, lon: number, radiusM: number): void => {
        const dLatBuf = radiusM / M_PER_DEG_LAT;
        const dLonBuf = radiusM / mPerLonHere;
        const x0 = Math.max(0, Math.floor((lon - dLonBuf - grid.minLon) / grid.dLon));
        const x1 = Math.min(grid.width - 1, Math.ceil((lon + dLonBuf - grid.minLon) / grid.dLon));
        const y0 = Math.max(0, Math.floor((lat - dLatBuf - grid.minLat) / grid.dLat));
        const y1 = Math.min(grid.height - 1, Math.ceil((lat + dLatBuf - grid.minLat) / grid.dLat));
        const carveDepth = Math.max((req.draftM ?? 1.5) + 1.0, 5.0);
        for (let y = y0; y <= y1; y++) {
            const cellLat = grid.minLat + (y + 0.5) * grid.dLat;
            for (let x = x0; x <= x1; x++) {
                const cellLon = grid.minLon + (x + 0.5) * grid.dLon;
                if (haversineM(cellLat, cellLon, lat, lon) > radiusM) continue;
                const idx = y * grid.width + x;
                if (grid.clearanceBarred?.[idx] === 1) continue; // never carve through a low bridge
                // …nor through a charted hazard's buffer (round-3 review,
                // 2026-09-30: an origin 70 m from a wreck got a route 49 m
                // from it, all teal). A mark-inference disc is not a charted
                // hazard and may still be carved, as before.
                if (isChartedHazardCell(idx)) continue;
                // …nor over water no tide clears (decision 11, 2026-10-01).
                if (isNoTideCell(idx)) continue;
                grid.cells[idx] = carveDepth;
                grid.preferred[idx] = 1; // attract A* to enter via the bubble
            }
        }
    };
    // Not over a pin in charted caution water: the carve's 5 m bubble would
    // fake 60 m of deep water over the chart's own shallow band (decision 7).
    if (!originWay) carveEndpoint(req.fromLat, req.fromLon, 60);

    let blocked = 0;
    for (let i = 0; i < grid.cells.length; i++) {
        if (Number.isNaN(grid.cells[i])) blocked++;
    }
    const debug: RouteDebug = {
        gridSize: { width: grid.width, height: grid.height },
        cellsTotal: grid.cells.length,
        cellsNavigable: grid.cells.length - blocked,
        cellsBlocked: blocked,
        ...(relaxedLndare ? { relaxedLndare: true } : {}),
        ...(relaxZones.length > 0 ? { relaxZones } : {}),
        ...(grid.noTideClears ? { noTideClearsCells: grid.noTideClears.reduce((n, v) => n + v, 0) } : {}),
    };

    // ── Label connected components ──
    // One pass to bucket every navigable cell into its 8-connected
    // water body. Drives the shared-component snap below.
    let { labels, sizes } = labelConnectedComponents(grid);
    tPhase = mark('labelComponents', tPhase);
    // Set when the component bridge below finds that the ONLY gap between the
    // endpoints' water bodies is a low-clearance structure this vessel cannot
    // pass — the disconnected failure then names the bridge as the reason.
    let airDraftGapRefused = false;
    // …and the bar it hit (its properties name the structure and why it
    // blocks: services/routing/overheadClearance.ts).
    let airDraftGapBar: Record<string, unknown> | null = null;

    // ── Component bridge ────────────────────────────────────────────
    // Connect a small origin/destination component to the main routing
    // component across a THIN barrier. Marina canal estates (Newport)
    // sit a short distance from open water, separated by an entrance
    // cut / seawall that chart LNDARE over-represents as land and that
    // OSM canal LineStrings stop short of (they trace the residential
    // canals up to the seawall and end). If origin and destination snap
    // to different components but the shortest gap between them is short
    // — a thin cut, not a real landmass — carve a 1-cell corridor across
    // it so they merge into one navigable body.
    //
    // 2026-05-20: Newport Marina canal estate was a 361-cell isolated
    // component, origin tap snapping 2 km out to the bay. The estate's
    // entrance to open water is a sub-500 m cut that no data source
    // captured cleanly. Capped at 10 cells (500 m) so we never bridge a
    // genuine landmass — only an entrance-width barrier the boat really
    // does pass through.
    {
        // Two-tier bridge:
        //   • gap ≤ NAV cells (≤500 m): a real entrance cut the chart
        //     over-represents as land. Carve NAVIGABLE — the boat does
        //     pass through, it's just mischarted.
        //   • NAV < gap ≤ CAUTION cells (≤2.5 km): a wider barrier we
        //     can't confirm is passable from data (Newport canal estate
        //     → bay: the entrance is a sub-2 km cut no source maps as
        //     water). Carve CAUTION (red) — A* exits the islanded pocket
        //     at the SHORTEST gap (geometrically the marina entrance, not
        //     a goal-biased diagonal across the suburb), and the corridor
        //     renders red as a "verify pilotage, draft may not clear"
        //     warning. This replaces the localized relax-CIRCLE for the
        //     islanded-endpoint case: a circle let A* cut goal-ward across
        //     land (Shane 2026-05-20: "follow the canals until it runs out
        //     of room — it is going the wrong way"); a single narrow
        //     corridor at the shortest gap forces the correct exit.
        const MAX_BRIDGE_CELLS = 10; // 500 m navigable
        const MAX_CAUTION_BRIDGE_CELLS = 60; // 3 km red corridor
        // The CAUTION search is O(smallCells × window²). Only run the
        // wide (±50) window for genuinely small islanded pockets (marina
        // canal estates ≤ a few thousand cells); for big components fall
        // back to the cheap ±10 window so we never pay 100M+ iterations.
        const SMALL_FOR_CAUTION_BRIDGE = 3000;
        // Generous snap radius just to identify which component each
        // endpoint belongs to (same 10 km used by the shared-component
        // snap below).
        const bridgeSnapCells = Math.ceil(10_000 / resolutionM);
        const oCell = snapToNavigable(grid, req.fromLat, req.fromLon, bridgeSnapCells);
        const dCell = snapToNavigable(grid, req.toLat, req.toLon, bridgeSnapCells);
        const lo = oCell ? labels[oCell.y * grid.width + oCell.x] : 0;
        const ld = dCell ? labels[dCell.y * grid.width + dCell.x] : 0;
        if (lo > 0 && ld > 0 && lo !== ld) {
            // Bridge the smaller component to the larger one.
            const small = (sizes.get(lo) ?? 0) <= (sizes.get(ld) ?? 0) ? lo : ld;
            const large = small === lo ? ld : lo;
            const smallSize = sizes.get(small) ?? 0;
            const searchCap = smallSize <= SMALL_FOR_CAUTION_BRIDGE ? MAX_CAUTION_BRIDGE_CELLS : MAX_BRIDGE_CELLS;
            // Collect the small component's cells once, then probe each
            // for a large-component cell within searchCap.
            let bestGap = Infinity;
            let bestSmall: { x: number; y: number } | null = null;
            let bestLarge: { x: number; y: number } | null = null;
            for (let y = 0; y < grid.height; y++) {
                for (let x = 0; x < grid.width; x++) {
                    if (labels[y * grid.width + x] !== small) continue;
                    for (let dy = -searchCap; dy <= searchCap; dy++) {
                        for (let dx = -searchCap; dx <= searchCap; dx++) {
                            const nx = x + dx;
                            const ny = y + dy;
                            if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
                            if (labels[ny * grid.width + nx] !== large) continue;
                            const gap = Math.hypot(dx, dy);
                            if (gap < bestGap) {
                                bestGap = gap;
                                bestSmall = { x, y };
                                bestLarge = { x: nx, y: ny };
                            }
                        }
                    }
                }
            }
            if (bestSmall && bestLarge && bestGap <= searchCap) {
                // ≤ NAV gap → navigable (real entrance cut); wider →
                // CAUTION (red, verify-pilotage barrier).
                const asCaution = bestGap > MAX_BRIDGE_CELLS;
                const carveDepth = Math.max((req.draftM ?? 1.5) + 1.0, 5.0);
                const carveValue = asCaution ? CAUTION : carveDepth;
                // A gap that IS a low-clearance bar (a fixed bridge this
                // vessel can't make) must never be tunnelled — the carve was
                // built for thin land slivers, and a blocked bridge line is
                // exactly the "≤500 m gap" it would otherwise punch through.
                let crossesClearanceBar = false;
                // MATERIALISED — bresenhamCells is a generator; iterating it once
                // for the barred pre-scan would leave the fill loop empty.
                const carvePath = [...bresenhamCells(bestSmall.x, bestSmall.y, bestLarge.x, bestLarge.y)];
                if (grid.clearanceBarred) {
                    for (const c of carvePath) {
                        if (c.x < 0 || c.y < 0 || c.x >= grid.width || c.y >= grid.height) continue;
                        if (grid.clearanceBarred[c.y * grid.width + c.x] === 1) {
                            crossesClearanceBar = true;
                            const [barLon, barLat] = gridToLatLon(grid, c.x, c.y);
                            airDraftGapBar = clearanceBarAt(layers.OBSTRN?.features ?? [], barLon, barLat);
                            break;
                        }
                    }
                }
                // Nor water no tide clears (decision 11, 2026-10-01): the gap
                // stays shut, and if it was the only way through the verdict
                // names it (noTideClearsVerdict).
                const crossesNoTide =
                    !crossesClearanceBar &&
                    carvePath.some(
                        (c) =>
                            c.x >= 0 &&
                            c.y >= 0 &&
                            c.x < grid.width &&
                            c.y < grid.height &&
                            isNoTideCell(c.y * grid.width + c.x),
                    );
                if (crossesNoTide) {
                    engineLog.warn(
                        `[noTide] component carve REFUSED — the ${Math.round(bestGap * resolutionM)}m gap crosses water no tide clears for this boat`,
                    );
                } else if (crossesClearanceBar) {
                    engineLog.warn(
                        `[airDraft] component carve REFUSED — the ${Math.round(bestGap * resolutionM)}m gap is a low-clearance structure this vessel cannot pass`,
                    );
                    // No carve: the pocket stays its own component. If the
                    // endpoints then share no component, the failure below
                    // names the BRIDGE as the reason instead of a generic
                    // "disconnected water bodies".
                    airDraftGapRefused = true;
                } else {
                    for (const c of carvePath) {
                        if (c.x < 0 || c.y < 0 || c.x >= grid.width || c.y >= grid.height) continue;
                        const idx = c.y * grid.width + c.x;
                        // Never tunnel a charted hazard's buffer or a berth's
                        // pontoons (round-3 review, 2026-09-30) — the carve
                        // was built for thin land slivers.
                        if (isChartedHazardCell(idx) || grid.berthBlocked?.[idx] === 1) continue;
                        // Only fill blocked/unknown/caution cells — never
                        // downgrade real charted water along the corridor.
                        if (Number.isNaN(grid.cells[idx]) || grid.cells[idx] < 0 || grid.cells[idx] === UNKNOWN_OPEN) {
                            grid.cells[idx] = carveValue;
                        }
                    }
                    if (ENGINE_DEBUG)
                        engineLog.warn(
                            `BRIDGE: carved comp ${small}(${smallSize} cells) → ${large}(${sizes.get(large)} cells) across ${Math.round(bestGap * resolutionM)}m as ${asCaution ? 'CAUTION(red)' : 'navigable'}`,
                        );
                    const relabeled = labelConnectedComponents(grid);
                    labels = relabeled.labels;
                    sizes = relabeled.sizes;
                }
            } else {
                if (ENGINE_DEBUG)
                    engineLog.warn(
                        `BRIDGE: origin comp ${lo} / dest comp ${ld} — nearest gap ${Math.round(bestGap * resolutionM)}m > ${searchCap * resolutionM}m, not bridged`,
                    );
            }
        }
    }

    // ── Shared-component snap ──────────────────────────────────────
    // For each sizeable component, find its nearest cell to origin AND
    // to destination. Pick the component minimising combined snap
    // distance. This guarantees origin and destination land in the
    // SAME component (so A* succeeds), and at coarse bathymetry
    // resolutions it often produces a better route than greedy "snap
    // origin to nearest big water, hope destination fits".
    //
    // The earlier two-step approach (snap origin first, require
    // destination same-component) failed on routes like Newport →
    // Brisbane Port where each endpoint is closest to a different
    // component but a third — the main bay — is reachable from both.
    //
    // Snap radius is generous (10 km). Newport's nearest deep channel
    // sits 6-8 km east in main Moreton Bay; the old 5 km radius
    // couldn't reach it.
    const minComponentCells = req.minComponentCells ?? 25;
    const maxSnapCells = Math.ceil(10_000 / resolutionM);
    const MAX_DEST_DEEP_SNAP_M = 1500;

    // DEBUG 2026-05-19: dump the top 5 connected components by size,
    // each with bbox + can-origin-snap-here + can-dest-snap-here. Tells
    // us at a glance which component contains the river (vs the bay)
    // and how far each endpoint is from each component. The snap
    // algorithm below picks the component minimising combined snap
    // distance, so seeing all the candidates clarifies WHY it picks
    // what it picks.
    if (ENGINE_DEBUG) {
        const sortedComponents = [...sizes.entries()]
            .filter(([, size]) => size >= minComponentCells)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 5);
        engineLog.warn(`COMPONENTS top ${sortedComponents.length} (min size ${minComponentCells} cells):`);
        for (const [label, size] of sortedComponents) {
            let minX = Infinity;
            let maxX = -Infinity;
            let minY = Infinity;
            let maxY = -Infinity;
            for (let y = 0; y < grid.height; y++) {
                for (let x = 0; x < grid.width; x++) {
                    if (labels[y * grid.width + x] === label) {
                        if (x < minX) minX = x;
                        if (x > maxX) maxX = x;
                        if (y < minY) minY = y;
                        if (y > maxY) maxY = y;
                    }
                }
            }
            const [bboxWLon, bboxSLat] = gridToLatLon(grid, minX, minY);
            const [bboxELon, bboxNLat] = gridToLatLon(grid, maxX, maxY);
            const oSnap = snapWithPredicate(
                grid,
                req.fromLat,
                req.fromLon,
                maxSnapCells,
                (idx) => labels[idx] === label,
            );
            const dSnap = snapWithPredicate(grid, req.toLat, req.toLon, maxSnapCells, (idx) => labels[idx] === label);
            const oDistM = oSnap
                ? Math.round(
                      haversineM(
                          req.fromLat,
                          req.fromLon,
                          gridToLatLon(grid, oSnap.x, oSnap.y)[1],
                          gridToLatLon(grid, oSnap.x, oSnap.y)[0],
                      ),
                  )
                : null;
            const dDistM = dSnap
                ? Math.round(
                      haversineM(
                          req.toLat,
                          req.toLon,
                          gridToLatLon(grid, dSnap.x, dSnap.y)[1],
                          gridToLatLon(grid, dSnap.x, dSnap.y)[0],
                      ),
                  )
                : null;
            engineLog.warn(
                `  • label=${label} size=${size} bbox=[${bboxSLat.toFixed(3)},${bboxWLon.toFixed(3)} → ${bboxNLat.toFixed(3)},${bboxELon.toFixed(3)}]  origin-snap=${oDistM != null ? oDistM + 'm' : 'OUT-OF-RANGE'}  dest-snap=${dDistM != null ? dDistM + 'm' : 'OUT-OF-RANGE'}`,
            );
        }
    }

    let bestStart: { x: number; y: number } | null = null;
    let bestEnd: { x: number; y: number } | null = null;
    let bestLabel = -1;
    let bestCombinedM = Infinity;
    let bestComponentSize = 0;

    // Endpoint snaps PREFER honest water: a wet-chart-land-conflict cell
    // (grid.wetConflict — coarse land paint over a charted creek, kept as
    // 40× caution) is legal to CROSS but a terrible place to START — a
    // geocoded suburb pin snapping onto a conflict creek departed Shane's
    // route through the Mooloolaba canal-estate maze instead of the harbour
    // (device screenshot 2026-07-02). Fall back to any-cell only when the
    // honest-water snap finds nothing in range.
    const notConflict = (idx: number): boolean => grid.wetConflict?.[idx] !== 1;
    const snapPreferHonest = (lat: number, lon: number, pred: (idx: number) => boolean) =>
        snapWithPredicate(grid, lat, lon, maxSnapCells, (idx) => pred(idx) && notConflict(idx)) ??
        snapWithPredicate(grid, lat, lon, maxSnapCells, pred);

    // A pin in charted caution water (decision 7): A* runs to the deep-enough
    // cell its charted water reaches first (the way's last cell); the charted
    // tail from there to the pin is added after every splice (below), so no
    // smoother, tier router or lead snap can re-draw it through other water.
    const originDeep = originWay ? originWay[originWay.length - 1] : null;
    const destinationDeep = destinationWay ? destinationWay[destinationWay.length - 1] : null;
    const cellIdx = (c: { x: number; y: number }): number => c.y * grid.width + c.x;
    for (const [label, size] of sizes) {
        if (size < minComponentCells) continue;
        const startCandidate =
            originDeep && labels[cellIdx(originDeep)] === label
                ? originDeep
                : snapPreferHonest(req.fromLat, req.fromLon, (idx) => labels[idx] === label);
        if (!startCandidate) continue;
        const deepEndCandidate = snapWithPredicate(grid, req.toLat, req.toLon, maxSnapCells, (idx) => {
            const d = grid.cells[idx];
            return labels[idx] === label && !Number.isNaN(d) && d >= req.draftM + safetyM;
        });
        const deepEnd =
            deepEndCandidate &&
            (() => {
                const [lon, lat] = gridToLatLon(grid, deepEndCandidate.x, deepEndCandidate.y);
                return haversineM(req.toLat, req.toLon, lat, lon) <= MAX_DEST_DEEP_SNAP_M;
            })()
                ? deepEndCandidate
                : null;
        const endCandidate =
            destinationDeep && labels[cellIdx(destinationDeep)] === label
                ? destinationDeep
                : (deepEnd ?? snapPreferHonest(req.toLat, req.toLon, (idx) => labels[idx] === label));
        if (!endCandidate) continue;

        const [startLon, startLat] = gridToLatLon(grid, startCandidate.x, startCandidate.y);
        const [endLon, endLat] = gridToLatLon(grid, endCandidate.x, endCandidate.y);
        const combinedM =
            haversineM(req.fromLat, req.fromLon, startLat, startLon) + haversineM(req.toLat, req.toLon, endLat, endLon);

        if (combinedM < bestCombinedM) {
            bestCombinedM = combinedM;
            bestLabel = label;
            bestStart = startCandidate;
            bestEnd = endCandidate;
            bestComponentSize = size;
        }
    }

    if (!bestStart || !bestEnd) {
        // A bridge severed the only connection — say so, plainly, instead of
        // any generic disconnection message (Shane 2026-07-02: "just say
        // route not possible").
        if (airDraftGapRefused) {
            return {
                error: clearanceRefusalMessage(airDraftGapBar, 'channel'),
                code: 'air-draft-blocked',
                debug,
            };
        }
        // No sizeable component lies within snap radius of both endpoints.
        // Distinguish "origin on land" from "no shared water body".
        const originNav = snapToNavigable(grid, req.fromLat, req.fromLon, maxSnapCells);
        const destNav = snapToNavigable(grid, req.toLat, req.toLon, maxSnapCells);
        if (!originNav) {
            return {
                error: 'Origin point and surrounding area are not navigable for this draft',
                code: 'origin-on-land',
                debug,
            };
        }
        if (!destNav) {
            return {
                error: 'Destination point and surrounding area are not navigable for this draft',
                code: 'destination-on-land',
                debug,
            };
        }
        return {
            error: 'Origin and destination are in disconnected water bodies — no shared navigable channel reaches both within the route bbox',
            code: 'destination-disconnected',
            debug,
        };
    }

    const startCell = bestStart;
    const endCell = bestEnd;
    // A pin's charted water reached deep water in a component the route does
    // not use (too small, or not the one both pins share): the route would
    // start (or end) AT the pin with no charted tail and no carve bubble, a
    // straight line to a distant snap no tail check examines. Re-run with
    // today's endpoints instead (fix-up, 2026-09-30).
    if (originDeep && startCell !== originDeep) {
        return {
            error: "the origin's charted water reaches deep water the route does not use",
            code: 'charted-end-rejected',
            debug,
        };
    }
    if (destinationDeep && endCell !== destinationDeep) {
        return {
            error: "the destination's charted water reaches deep water the route does not use",
            code: 'charted-end-rejected',
            debug,
        };
    }
    debug.cellsReachableFromOrigin = bestComponentSize;
    {
        const [snapLon, snapLat] = gridToLatLon(grid, startCell.x, startCell.y);
        debug.originSnap =
            originDeep && startCell === originDeep
                ? // The route starts AT the pin (its charted tail, below).
                  {
                      x: originWay![0].x,
                      y: originWay![0].y,
                      snappedLat: req.fromLat,
                      snappedLon: req.fromLon,
                      snapDistanceM: 0,
                  }
                : {
                      x: startCell.x,
                      y: startCell.y,
                      snappedLat: snapLat,
                      snappedLon: snapLon,
                      snapDistanceM: haversineM(req.fromLat, req.fromLon, snapLat, snapLon),
                  };
    }
    // Silence the unused-variable warning while preserving the
    // diagnostic value of bestLabel in any future debug output.
    void bestLabel;
    {
        const [snapLon, snapLat] = gridToLatLon(grid, endCell.x, endCell.y);
        debug.destinationSnap = {
            x: endCell.x,
            y: endCell.y,
            snappedLat: snapLat,
            snappedLon: snapLon,
            snapDistanceM: haversineM(req.toLat, req.toLon, snapLat, snapLon),
        };
        // A charted pin is the route's own end — its tail runs to it — not a
        // snap to water near it.
        if (destinationDeep && endCell === destinationDeep) {
            debug.destinationChartedPin = true;
            debug.destinationSnap = {
                x: destinationWay![0].x,
                y: destinationWay![0].y,
                snappedLat: req.toLat,
                snappedLon: req.toLon,
                snapDistanceM: 0,
            };
        } else if (destinationTapOnHardLand || debug.destinationSnap.snapDistanceM > 1)
            debug.destinationWaterSnap = true;
    }
    if (originDeep && startCell === originDeep) debug.originChartedPin = true;

    tPhase = mark('componentSnap', tPhase);

    // DEBUG 2026-05-19: surface the snap distances so we can spot when
    // the destination got pulled far from where the user actually
    // tapped. A "12 km destination snap" is the smoking gun for the
    // destination cell being in a different connected component than
    // the origin (componentSnap then picks the largest component both
    // endpoints can reach, even if it means dragging the destination
    // across the map). The visible "bridge" segment from the route's
    // last cell to the user input is what looks like routing through
    // land but is actually post-snap fiction.
    if (ENGINE_DEBUG)
        engineLog.warn(
            `SNAP: origin ${haversineM(req.fromLat, req.fromLon, debug.originSnap?.snappedLat ?? 0, debug.originSnap?.snappedLon ?? 0).toFixed(0)}m  •  dest ${haversineM(req.toLat, req.toLon, debug.destinationSnap?.snappedLat ?? 0, debug.destinationSnap?.snappedLon ?? 0).toFixed(0)}m  •  componentSize=${bestComponentSize} cells`,
        );

    // A* must succeed because the destination cell is in the origin's
    // reachable component. Defensive: still handle null in case the
    // grid has a path-cost edge case I haven't anticipated.
    const aStarCells = aStar(grid, startCell, endCell);
    tPhase = mark('aStar', tPhase);
    if (!aStarCells) {
        return { error: 'A* failed despite reachability flood-fill — should be impossible', code: 'no-path', debug };
    }

    // ── No out-and-back (2026-10-01) ─────────────────────────────────
    // A route must never visit deep water only to come back through the same
    // shallows. A pin in charted-shallow water (decision 7) gets its tail from
    // the deep-enough water its own charted water reaches most cheaply — and
    // that water can lie beyond the pin: the Pinkenba repro's north-exit pin,
    // 113 m from Newport gate 1/2 in the charted 0–2 m band, got a route
    // 2.3 km out past it to 5 m water and a 2.4 km tail back (4.51 NM; 2.07 NM
    // on the old code). Where the grid path already passes nearer the pin
    // than that deep water, the pin's charted water (charted caution or deep
    // cells — never land, drying ground, a hazard, uncharted water or water
    // no tide clears) is searched from the pin, and the route leaves the path
    // at the cell that makes it shortest: the tail then runs straight through
    // that charted water to the pin — 'needs tide', amber with its chip —
    // unless the deep path is shorter or equal (within one cell). The origin
    // is symmetric. The tail keeps every check it had (tailPoints, the final
    // charted-tail walk up to where it joins the path).
    let cells = aStarCells;
    let originTailWay = originWay;
    let destinationTailWay = destinationWay;
    const outAndBackCutM: { origin?: number; destination?: number } = {};
    if ((originWay || destinationWay) && cells.length >= 3) {
        const w = grid.width;
        const stepLenM = (a: { x: number; y: number }, b: { x: number; y: number }): number =>
            Math.hypot(a.x - b.x, a.y - b.y) * resolutionM;
        const wayLenM = (way: readonly { x: number; y: number }[]): number => {
            let m = 0;
            for (let i = 1; i < way.length; i++) m += stepLenM(way[i - 1], way[i]);
            return m;
        };
        /** From the pin through its charted water (deep or charted caution),
         * weighted as chartedWayToDeep weights a tail, out to `limitM` of
         * water: each cell's metres back to the pin along the cheapest way,
         * and the next cell on it. */
        const chartedWaterFrom = (
            pinIdx: number,
            limitM: number,
        ): { geoM: Map<number, number>; toward: Map<number, number> } => {
            const cost = new Map<number, number>([[pinIdx, 0]]);
            const geoM = new Map<number, number>([[pinIdx, 0]]);
            const toward = new Map<number, number>([[pinIdx, -1]]);
            const heap = new MinHeap();
            heap.push({ f: 0, idx: pinIdx });
            for (let e = heap.pop(); e; e = heap.pop()) {
                if (e.f > (cost.get(e.idx) ?? Infinity)) continue;
                const x = e.idx % w;
                const y = Math.floor(e.idx / w);
                const g = geoM.get(e.idx) ?? 0;
                for (let dy = -1; dy <= 1; dy++) {
                    for (let dx = -1; dx <= 1; dx++) {
                        if (dx === 0 && dy === 0) continue;
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx < 0 || ny < 0 || nx >= w || ny >= grid.height) continue;
                        const n = ny * w + nx;
                        if (!isDeepEnough(n) && !isChartedCaution(n)) continue;
                        if (dx !== 0 && dy !== 0 && (isBlockedIdx(y * w + nx) || isBlockedIdx(ny * w + x))) continue;
                        const step = dx !== 0 && dy !== 0 ? Math.SQRT2 : 1;
                        const gn = g + step * resolutionM;
                        if (gn > limitM) continue;
                        const c = e.f + step * tailStepWeight(n);
                        if (c >= (cost.get(n) ?? Infinity)) continue;
                        cost.set(n, c);
                        geoM.set(n, gn);
                        toward.set(n, e.idx);
                        heap.push({ f: c, idx: n });
                    }
                }
            }
            return { geoM, toward };
        };
        /** The charted tail's exact check (tailFault below), on cell centres. */
        const tailLand = hardLandAtPoint(layers);
        const tailBands = chartAreaIndexFor(layers).depth;
        const exactTailFault = (pts: readonly [number, number][]): string | null => {
            for (let i = 0; i + 1 < pts.length; i++) {
                const [lonA, latA] = pts[i];
                const [lonB, latB] = pts[i + 1];
                const steps = Math.max(1, Math.ceil(haversineM(latA, lonA, latB, lonB) / 5));
                for (let k = 0; k <= steps; k++) {
                    const lon = lonA + ((lonB - lonA) * k) / steps;
                    const lat = latA + ((latB - latA) * k) / steps;
                    if (tailLand(lon, lat)) return 'charted land';
                    if (tailBands.length === 0) continue;
                    const d = chartedDepthAt(tailBands, lon, lat);
                    if (d === null) return 'water no chart covers';
                    if (d < 0) return 'a charted drying band';
                    if (noTideAt(lon, lat)) return 'water no tide clears';
                }
            }
            return polylineCrossesClearanceBar(pts, layers.OBSTRN?.features ?? []) ? 'a low structure' : null;
        };
        const cut = (which: 'origin' | 'destination'): void => {
            const way = which === 'origin' ? originTailWay : destinationTailWay;
            if (!way || way.length < 2 || cells.length < 3) return;
            const pin = way[0];
            const deep = way[way.length - 1];
            const tailM = wayLenM(way);
            // Only when the path comes nearer the pin than the tail's deep end.
            const deepGapM = stepLenM(deep, pin);
            if (!cells.some((c) => stepLenM(c, pin) < deepGapM - resolutionM)) return;
            const cum = [0];
            for (let i = 1; i < cells.length; i++) cum.push(cum[i - 1] + stepLenM(cells[i - 1], cells[i]));
            const pathM = cum[cum.length - 1];
            const field = chartedWaterFrom(pin.y * w + pin.x, tailM + 2 * resolutionM);
            // Must beat today's way by more than a cell (the grid's own noise).
            const todayM = pathM + tailM;
            const lo = which === 'destination' ? 1 : 0;
            const hi = which === 'destination' ? cells.length - 1 : cells.length - 2;
            const candidates: { i: number; total: number }[] = [];
            for (let i = lo; i <= hi; i++) {
                const g = field.geoM.get(cells[i].y * w + cells[i].x);
                if (g === undefined) continue;
                const total = which === 'destination' ? cum[i] + g : pathM - cum[i] + g;
                if (total < todayM - resolutionM) candidates.push({ i, total });
            }
            candidates.sort((a, b) => a.total - b.total);
            /** The new tail, pin first and the junction last (chartedWayToDeep's shape). */
            const tailTo = (i: number): { x: number; y: number }[] => {
                const back: { x: number; y: number }[] = [];
                for (let c = cells[i].y * w + cells[i].x; c !== -1; c = field.toward.get(c) as number)
                    back.push({ x: c % w, y: Math.floor(c / w) });
                return back.reverse();
            };
            // The shortest whose tail passes the tail's own exact check (the
            // chart itself every 5 m: never land, drying ground, water no band
            // charts or no tide clears) — at most a few tried.
            let chosen: { i: number; total: number; tail: { x: number; y: number }[] } | null = null;
            for (const c of candidates.slice(0, 6)) {
                const tail = tailTo(c.i);
                const pts = tail.map((t) => gridToLatLon(grid, t.x, t.y));
                pts[0] = which === 'destination' ? [req.toLon, req.toLat] : [req.fromLon, req.fromLat];
                if (exactTailFault(pts) === null) {
                    chosen = { ...c, tail };
                    break;
                }
            }
            if (!chosen) return;
            const best = chosen.i;
            const tail = chosen.tail;
            outAndBackCutM[which] = Math.round(todayM - chosen.total);
            if (which === 'destination') {
                cells = cells.slice(0, best + 1);
                destinationTailWay = tail;
            } else {
                cells = cells.slice(best);
                originTailWay = tail;
            }
            engineLog.warn(
                `[outAndBack] the ${which} pin's own charted water joins the route ${Math.round((which === 'destination' ? pathM - (cum[best] ?? 0) : (cum[best] ?? 0)) / 10) * 10} m before its deep end — ${outAndBackCutM[which]} m shorter, no out-and-back`,
            );
        };
        if (debug.destinationChartedPin) cut('destination');
        if (debug.originChartedPin) cut('origin');
        if (outAndBackCutM.origin !== undefined || outAndBackCutM.destination !== undefined)
            debug.outAndBackCutM = outAndBackCutM;
    }

    // Marina-centerline refinement: ride mid-channel with keel clearance as
    // straight legs through the marina/canal. The centerline pipeline owns the
    // CLEAN PREFIX of the route (the marina/canal) — scoped at the first
    // caution cell, so a downstream caution stretch (the bay channel, the
    // Brisbane bar) no longer switches the centerline OFF for the canal too.
    // The canal keeps its corner-respecting centerline; A* keeps the caution
    // remainder. A failed/disconnected centerline pass → keep the proven A*.
    let smoothedCells: { x: number; y: number }[];
    const firstCautionIdx = cells.findIndex((c) => grid.cells[c.y * grid.width + c.x] < 0);
    const cleanPrefixEnd = firstCautionIdx === -1 ? cells.length - 1 : firstCautionIdx - 1;
    // Need ≥2 clean cells (a real canal run) for the centerline to mean anything.
    let marinaCells = cleanPrefixEnd >= 1 ? tryMarinaCenterline(grid, cells[0], cells[cleanPrefixEnd]) : null;
    if (marinaCells && marinaCells.length >= 2) {
        // Cost-no-worse gate: the centerline pipeline routes on the WATER
        // MASK alone — preferred corridors, marker ribbons, wings and exit
        // penalties are invisible to it. In a canal that's fine (the
        // centerline IS the corridor, near-identical cost); on open clean
        // water it would replace A*'s gate-threading dog-leg with a straight
        // line, bulldozing the seamanship the cost model just paid for
        // (Claude A's "marinaCenterline=true on a straight line" note —
        // confirmed against the Phase 3 gate-shortcut fixture). Accept the
        // centerline only when its true-grid cost is within 5% of the A*
        // prefix it replaces. Landed per ROUTING_COLLAB reply 13.
        const centreChain: { x: number; y: number }[] = [];
        for (let k = 0; k < marinaCells.length - 1; k++) {
            for (const c of bresenhamCells(
                marinaCells[k].x,
                marinaCells[k].y,
                marinaCells[k + 1].x,
                marinaCells[k + 1].y,
            )) {
                const last = centreChain[centreChain.length - 1];
                if (!last || last.x !== c.x || last.y !== c.y) centreChain.push(c);
            }
        }
        const centreCost = chainCostM(grid, centreChain);
        const prefixCost = chainCostM(grid, cells.slice(0, cleanPrefixEnd + 1));
        if (centreCost > prefixCost * 1.05 + 1e-6) {
            if (ENGINE_DEBUG)
                engineLog.warn(
                    `marina-centerline: REJECTED by cost gate (centerline ${Math.round(centreCost)} m-eq vs A* prefix ${Math.round(prefixCost)}) — keeping the A* corridor`,
                );
            marinaCells = null;
        }
    }
    if (marinaCells && marinaCells.length >= 2) {
        debug.marinaCenterline = true;
        if (firstCautionIdx === -1) {
            // Entire route is clean → the centerline owns all of it.
            smoothedCells = marinaCells;
        } else {
            // Stitch: centerline canal prefix + string-pulled A* caution
            // suffix (they share the boundary cell cells[cleanPrefixEnd]).
            const suffix = smoothPath(grid, cells.slice(cleanPrefixEnd));
            smoothedCells = marinaCells.concat(suffix.slice(1));
        }
        if (ENGINE_DEBUG)
            engineLog.warn(
                `marina-centerline: clean prefix ${cleanPrefixEnd + 1}/${cells.length} A* cells → ${marinaCells.length} centerline legs${firstCautionIdx === -1 ? '' : ' + A* caution suffix'}`,
            );
    } else {
        // String-pull the A* output to remove stair-step artifacts.
        smoothedCells = smoothPath(grid, cells);
    }
    // De-stagger the centred mid-channel line (cost-blind DP, centred water only)
    // — the smoother's centring-aware cost gate can't straighten it, so a jagged
    // "drunk steering" wobble survives. Marked/open/caution water is factor 1 and
    // untouched, so the corpus stays byte-identical.
    smoothedCells = deStaggerCentred(grid, smoothedCells);
    tPhase = mark('smoothPath', tPhase);

    // Strict unchartedPolicy: a no-evidence cell reads as caution too —
    // "nothing says there is water here" renders red exactly like "our
    // bathymetry says too shallow". Paired with cells === UNKNOWN_OPEN so
    // post-build rescues (endpoint carve, bridges) clear it implicitly.
    const strictUncharted = req.unchartedPolicy === 'strict';
    // The rule itself is shared with a promoted Seaway route (safetyAudit
    // isUnvouchedCell; round-3 review, 2026-09-30).
    const isUnvouchedIdx = (idx: number): boolean => strictUncharted && isUnvouchedCell(grid, idx);

    // ── Fairing pass (field bug 2026-06-13: "stepping through the
    // markers", Pinkenba→Newport — ROUTING_COLLAB replies A-23/26) ────
    // Each Pass-5 channel_midpoint is a preferred 1.0× disc in 4× water
    // with EXIT_PENALTY stickiness: A*'s cost-optimal path maximises
    // in-disc distance, bending at every bead — straight legs disc-to-
    // disc, a kink per gate. smoothPath correctly refuses to fair it
    // (the straight chord loses the disc discounts — cost-no-worse).
    // fairPath is the DOCUMENTED carve-out: collapse a subpath to its
    // chord at a bounded cost give-back, but ONLY when the chord still
    // SERVES every gate the subpath served — within each gate's own
    // half-width (_pairDistanceM/2), the engine-side form of the
    // cross-line "may I cut this corner" test. A marked dog-leg around
    // a hazard can never be erased: its chord either crosses caution
    // (excluded), misses the gates (excluded), or costs ≥ ~3× — far
    // beyond the 1.25 give-back. Runs BEFORE the strict re-anchor so
    // boundary waypoints are re-inserted on the FINAL geometry.
    const fairingMids = collectFairingMidpoints(layers);
    if (fairingMids.length > 0 && smoothedCells.length >= 3) {
        smoothedCells = fairPath(grid, smoothedCells, fairingMids, isUnvouchedIdx);
        mark('fairing', tPhase);
    }

    // Re-anchor state boundaries the smoother legally erased: smoothPath
    // may collapse a COST-EQUAL chord across a caution/no-evidence patch
    // when the A* path through it was equally straight — the patch then
    // hides inside one waypoint segment, and endpoint-sampled cautionRaw
    // below can't see it. Walk each smoothed segment's Bresenham line and
    // re-insert a waypoint at every effective-state flip, so red runs
    // start and end at the real boundaries (and the clean parts of a long
    // chord stay clean instead of the whole leg flagging red). Inserted
    // points lie ON the chord — geometry and distance are unchanged.
    if (strictUncharted && smoothedCells.length >= 2) {
        const stateAt = (cx: number, cy: number): boolean => {
            const idx = cy * grid.width + cx;
            return grid.cells[idx] < 0 || isUnvouchedIdx(idx);
        };
        const rebuilt: { x: number; y: number }[] = [smoothedCells[0]];
        for (let i = 1; i < smoothedCells.length; i++) {
            const a = smoothedCells[i - 1];
            const b = smoothedCells[i];
            let prev = stateAt(a.x, a.y);
            for (const c of bresenhamCells(a.x, a.y, b.x, b.y)) {
                if (c.x === a.x && c.y === a.y) continue;
                const s = stateAt(c.x, c.y);
                if (s !== prev) {
                    const last = rebuilt[rebuilt.length - 1];
                    if (last.x !== c.x || last.y !== c.y) rebuilt.push({ x: c.x, y: c.y });
                    prev = s;
                }
            }
            const lastW = rebuilt[rebuilt.length - 1];
            if (lastW.x !== b.x || lastW.y !== b.y) rebuilt.push(b);
        }
        smoothedCells = rebuilt;
    }
    const totalMs = Date.now() - t0Total;
    const breakdown = Object.entries(timings)
        .map(([k, v]) => `${k}=${v}ms`)
        .join(' ');
    if (ENGINE_DEBUG) console.warn(`[inshoreEngine] routeInshore total=${totalMs}ms — ${breakdown}`);

    // DEBUG 2026-05-19: trace cell-state along the final smoothed polyline.
    // For each adjacent waypoint pair, sample up to 6 evenly-spaced cells
    // along the Bresenham line and log the cell's effective depth, the
    // preferred flag, and the lat/lon. Tells us *directly* whether the
    // OBSTRN-injected airport bbox is actually hard-blocking the cells
    // the route claims to thread, or whether FAIRWY rescue is letting
    // the route through (rescued cells have positive depth AND
    // preferred=1, blocked cells have NaN). Remove once Brisbane Airport
    // routing is sorted.
    if (ENGINE_DEBUG && smoothedCells.length >= 2) {
        const traceLines: string[] = [];
        for (let i = 0; i < smoothedCells.length - 1; i++) {
            const a = smoothedCells[i];
            const b = smoothedCells[i + 1];
            const cellsOnLine = Array.from(bresenhamCells(a.x, a.y, b.x, b.y));
            const sampleCount = Math.min(6, cellsOnLine.length);
            const step = Math.max(1, Math.floor(cellsOnLine.length / sampleCount));
            const samples: { x: number; y: number }[] = [];
            for (let s = 0; s < cellsOnLine.length; s += step) samples.push(cellsOnLine[s]);
            if (cellsOnLine.length > 0 && samples[samples.length - 1] !== cellsOnLine[cellsOnLine.length - 1]) {
                samples.push(cellsOnLine[cellsOnLine.length - 1]);
            }
            traceLines.push(`  seg ${i}→${i + 1} (${cellsOnLine.length} cells):`);
            for (const s of samples) {
                const idx = s.y * grid.width + s.x;
                const depth = grid.cells[idx];
                const pref = grid.preferred[idx];
                const [lon, lat] = gridToLatLon(grid, s.x, s.y);
                const depthStr = Number.isNaN(depth)
                    ? 'NaN(BLOCKED)'
                    : depth < 0
                      ? `CAUTION(${depth})`
                      : depth === 0
                        ? 'UNKNOWN(0)'
                        : `depth=${depth.toFixed(1)}m`;
                traceLines.push(`    @${lat.toFixed(4)},${lon.toFixed(4)} ${depthStr} preferred=${pref}`);
            }
        }
        engineLog.warn(`CELL TRACE along smoothed polyline (${smoothedCells.length - 1} segments):`);
        for (const line of traceLines) engineLog.warn(line);
    }

    // Convert grid path → polyline (cell centers). Keep each smoothed
    // cell's caution-state alongside so Douglas-Peucker can be run
    // per caution-run below — DP itself is not caution-aware, so
    // DP'ing the whole polyline re-merges a caution patch into an
    // adjacent deep run and the route draws a long mostly-deep leg
    // entirely red (the Brisbane "red but could go another way" bug).
    const polylineRaw: [number, number][] = smoothedCells.map((c) => gridToLatLon(grid, c.x, c.y));
    const cautionRaw: boolean[] = smoothedCells.map((c) => {
        const idx = c.y * grid.width + c.x;
        return grid.cells[idx] < 0 || isUnvouchedIdx(idx);
    });

    // Always splice the input origin as the visible start of the polyline.
    // For the destination, render at the snapped safe-water cell: an arrival at
    // "Pinkenba" means the nearest usable water off Pinkenba, not a final
    // land-bridge onto the shoreline/place label.
    //
    // Earlier versions tried various gates (150 m threshold, LNDARE-
    // crossing check) to hide endpoint bridges when they would visually cross
    // land — but that meant routes silently appeared to start/end somewhere
    // different from where the user tapped. For departures, the visible bridge
    // is still useful feedback; for arrivals, the snapped water endpoint is the
    // actionable seamanship point.
    //
    // User-visible behaviour now:
    //   - tap in open water → route visibly starts at the tap, bridge
    //     is short and over water, looks correct
    //   - tap in marina canal / on dock → bridge segment visibly
    //     crosses dock structures, signalling "your start tap wasn't in
    //     clean water — move the pin if you want a cleaner departure"
    //   - destination on shore / label on land → route ends at the nearest
    //     routeable water cell, with debug.destinationSnap telling the caller
    //     how far that arrival berth moved from the requested place label
    //
    // Visual feedback is the right primitive for this — we don't have
    // the routing constraints to know whether the user *meant* a
    // marina exit or a coastline tap.
    //   - a pin in charted-shallow water (decision 7) → the grid route runs
    //     to the last deep-enough cell before it, and the charted tail from
    //     there to the pin is added after every splice (below)
    if (polylineRaw.length > 0) {
        if (!debug.originChartedPin) polylineRaw[0] = [req.fromLon, req.fromLat];
        if (!debug.destinationChartedPin) {
            polylineRaw[polylineRaw.length - 1] = debug.destinationSnap
                ? [debug.destinationSnap.snappedLon, debug.destinationSnap.snappedLat]
                : [req.toLon, req.toLat];
        }
    }
    // DP tolerance ≈ 1/4 cell. Tighter than the original 1/2 cell —
    // keeps more turn detail in winding channels (Savannah River
    // bends look noticeably closer to the actual channel after this).
    const tolDeg = Math.min(grid.dLat, grid.dLon) * 0.25;

    // Land guard for the simplifier: true if the straight chord a→b crosses a
    // landBlocked cell. Stops Douglas-Peucker collapsing a canal bend into a
    // chord that slices across the bank (the Newport canal corner-clip).
    const dpStepM = Math.max(15, resolutionM / 3);
    const chordCrossesLand = (a: [number, number], b: [number, number]): boolean => {
        if (!grid.landBlocked) return false;
        const segM = haversineM(a[1], a[0], b[1], b[0]);
        const steps = Math.max(1, Math.ceil(segM / dpStepM));
        for (let s = 1; s < steps; s++) {
            const t = s / steps;
            const { x, y } = latLonToGrid(grid, a[1] + (b[1] - a[1]) * t, a[0] + (b[0] - a[0]) * t);
            if (x >= 0 && y >= 0 && x < grid.width && y < grid.height && grid.landBlocked[y * grid.width + x] === 1)
                return true;
        }
        return false;
    };

    // Build the final polyline + per-segment cautionMask together.
    // smoothPath already split the path at caution boundaries; we keep
    // DP from re-merging across them by splitting polylineRaw into
    // runs of constant caution-state, Douglas-Peucker'ing each run
    // independently, then concatenating (the boundary point is shared
    // between adjacent runs). A segment is "caution" if EITHER of its
    // endpoint cells is caution — the transition segment is flagged
    // red, conservatively.
    let polyline: [number, number][];
    const cautionMask: boolean[] = [];
    if (polylineRaw.length < 2) {
        polyline = polylineRaw.slice();
    } else {
        const segCaution: boolean[] = [];
        for (let i = 0; i < polylineRaw.length - 1; i++) {
            segCaution.push(cautionRaw[i] || cautionRaw[i + 1]);
        }
        polyline = [];
        let runStart = 0;
        for (let i = 0; i <= segCaution.length; i++) {
            const atEnd = i === segCaution.length;
            if (atEnd || segCaution[i] !== segCaution[runStart]) {
                // run = segments [runStart, i) → points [runStart, i]
                const simplified = douglasPeucker(polylineRaw.slice(runStart, i + 1), tolDeg, chordCrossesLand);
                const runCaution = segCaution[runStart];
                // skip the boundary point shared with the previous run
                const from = polyline.length === 0 ? 0 : 1;
                for (let k = from; k < simplified.length; k++) polyline.push(simplified[k]);
                for (let k = 0; k < simplified.length - 1; k++) cautionMask.push(runCaution);
                runStart = i;
            }
        }
    }

    // ── Four-tier contract path ───────────────────────────────────────
    // segmentRoute → per-span tier routers → glue, REPLACING the sequential
    // fairlead/leading splices below. A contract leg cannot silently mutate
    // across a tier seam (the implicit-splice bug class), and channel/canal
    // spans re-home onto their local followers WITHOUT the 0.59-near-frac skip
    // that left the Newport end stepped. On ANY refusal it returns null and we
    // run the EXACT proven monolith chain below — so the live route can never
    // get worse than today. Caution is recomputed here (not in the tier
    // routers) with the strict-uncharted rule, so red rendering is unchanged.
    let finalPolyline: [number, number][];
    let finalCaution: boolean[];
    // Per-segment canal mask — the charted canal centre-line stretch. Rendered the
    // SAME red as caution, but kept OUT of cautionMask so it never pollutes the
    // safety/quality metric (the canal is known water, not water-to-verify). Empty
    // on the monolith fallback (the canal snap only runs on the tier-contract path).
    let finalCanalMask: boolean[] = [];
    // Per-segment tier-2 marked-channel mask — rendered YELLOW. Empty on the
    // monolith fallback (the channel mask only exists on the contract path).
    let finalChannelMask: boolean[] = [];
    // Per-segment offshore (tier-4) mask — rendered DARK BLUE. Empty inshore/monolith.
    let finalOffshoreMask: boolean[] = [];
    // Monolith-path debug flags (set only on the fallback branch).
    let flFairlead: string | undefined;
    let llLeadingLines: number | undefined;
    let laLeadingApproach: number | undefined;
    const threeTier = applyThreeTier(
        polyline,
        grid,
        layers,
        req.draftM,
        safetyM,
        obstructionBufferM,
        relaxedLndare,
        relaxZones,
        req.tideCeilings ?? [],
        req.tideBarriers ?? [],
    );
    if (threeTier) {
        finalPolyline = threeTier.polyline;
        // SAFETY: caution is recomputed ALONG each segment, not just at its two
        // vertices. A tier leg can cross a bar / unvouched sliver BETWEEN two
        // clean-water vertices; per-vertex sampling drops that red flag — a
        // SILENT bar crossing (A's sweep bucket-1 regression). Sample every
        // stepM with the SAME rule as cautionRaw (charted-shallow <0 OR
        // strict-unvouched), reproducing the monolith's re-anchored semantics.
        const cautionStepM = Math.max(25, resolutionM / 2);
        const segCrossesCaution = (lonA: number, latA: number, lonB: number, latB: number): boolean => {
            const segM = haversineM(latA, lonA, latB, lonB);
            const steps = Math.max(1, Math.ceil(segM / cautionStepM));
            for (let s = 0; s <= steps; s++) {
                const t = s / steps;
                const { x, y } = latLonToGrid(grid, latA + (latB - latA) * t, lonA + (lonB - lonA) * t);
                if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
                const idx = y * grid.width + x;
                if (grid.cells[idx] < 0 || isUnvouchedIdx(idx)) return true;
            }
            return false;
        };
        // The canal stretch renders the SAME red as caution, but via a SEPARATE
        // per-segment mask — the grid calls carved canal cells navigable, so
        // segCrossesCaution leaves them green, and we must NOT fold the canal into
        // cautionMask (it's the known charted centre-line, not water-to-verify; the
        // scorecard/golden caution metric must stay pure). A segment is canal if
        // EITHER endpoint rides the centre-line (reddens the entry/exit seam too).
        const canalVtx = threeTier.canalMask;
        // Per-segment tier-2 mask (the marked-channel leg). Rendered YELLOW (NOT red,
        // NOT in cautionMask) — a buoyed channel with a recommended track is pilotage
        // water, distinct from the red canal/caution and green open water.
        const channelSeg = threeTier.channelMask;
        const offshoreVtx = threeTier.offshoreMask;
        finalCaution = [];
        finalCanalMask = [];
        finalChannelMask = [];
        finalOffshoreMask = [];
        for (let i = 0; i < finalPolyline.length - 1; i++) {
            const a = finalPolyline[i];
            const b = finalPolyline[i + 1];
            finalCaution.push(segCrossesCaution(a[0], a[1], b[0], b[1]));
            finalCanalMask.push(canalVtx[i] || canalVtx[i + 1]);
            finalChannelMask.push(channelSeg[i] ?? false);
            finalOffshoreMask.push(offshoreVtx[i] || offshoreVtx[i + 1]);
        }
        // ── Collapse the splices' densify scaffold (round 4, 2026-09-30) ──
        // The lateral-mark follower (fairlead: corridorCenterline sampled by
        // mark sequence, then an 11-point moving average) ships its centreline
        // at every sample: through the Brisbane River mouth the production-
        // shape Newport → Rivergate route carried 171 points, 138 of them a
        // 6.8 km stretch whose turns are 0.0–2.7° apiece, straight to within
        // 1 m inside one state (171 → 47 at 1 m, 40 at 2.5 m) — and every one
        // a caution segment the cap counted. Douglas-Peucker at the canal
        // re-centre's own 2.5 m, per run of one state: the run's per-segment
        // masks, the grid's caution verdict along the line, a charted
        // hazard's buffer and the chart's own depth facts (chartStateAlong).
        // A merged chord must read the same on all of them and cross no land
        // cell, so it never leaves charted water or changes state.
        {
            const tCollapse = Date.now();
            const needM = req.draftM + safetyM;
            const chartState = chartStateAlong({ layers, grid, draftM: req.draftM, safetyM });
            const lineKey = (a: [number, number], b: [number, number], nearHazard: boolean): string =>
                `${segCrossesCaution(a[0], a[1], b[0], b[1]) ? 'c' : ''}|${nearHazard ? 'h' : ''}|${chartState(a, b)}`;
            const maskKey = (i: number): string =>
                i < 0 || i >= finalCaution.length
                    ? ''
                    : `${finalCaution[i] ? 'C' : ''}${finalCanalMask[i] ? 'K' : ''}${finalChannelMask[i] ? 'Y' : ''}${
                          finalOffshoreMask[i] ? 'O' : ''
                      }`;
            const hazardAll = hazardBufferSegments(finalPolyline, layers, obstructionBufferM, needM);
            // A segment alone in its mask run cannot merge: its own key, unread.
            const segKeys = finalCaution.map((_, i) => {
                const m = maskKey(i);
                return maskKey(i - 1) !== m && maskKey(i + 1) !== m
                    ? `${m}#${i}`
                    : `${m}#${lineKey(finalPolyline[i], finalPolyline[i + 1], hazardAll[i])}`;
            });
            // A lateral-mark gate crossing is an anchor (round 5, 2026-10-01):
            // the line must visibly thread every gate it passes through, so the
            // vertex a follower put on a gate centre is pinned. Newport's gate
            // 5/6 centre sits 1.2 m off the 7/8 → 3/4 chord — inside 2.5 m, so
            // the unpinned collapse merged the channel into one chord and the
            // route drew no point in that gate (newportPinkenba VARIANT C).
            const collapsed = collapseStateRuns(
                finalPolyline,
                segKeys,
                SCAFFOLD_TOLERANCE_DEG,
                (a, b, key) =>
                    !chordCrossesLand(a, b) &&
                    key.slice(key.indexOf('#') + 1) ===
                        lineKey(a, b, hazardBufferSegments([a, b], layers, obstructionBufferM, needM)[0]),
                threeTier.gateMask,
            );
            const dropped = finalPolyline.length - collapsed.polyline.length;
            if (dropped > 0) {
                const from = collapsed.fromSeg;
                finalCaution = from.map((i) => finalCaution[i]);
                finalCanalMask = from.map((i) => finalCanalMask[i]);
                finalChannelMask = from.map((i) => finalChannelMask[i]);
                finalOffshoreMask = from.map((i) => finalOffshoreMask[i]);
                finalPolyline = collapsed.polyline;
                debug.scaffoldCollapsed = dropped;
            }
            mark('scaffoldCollapse', tCollapse);
        }
        // ── Any-angle string pull (field round 2, item a, 2026-10-03) ─────
        // The collapse above merges only what is collinear to 2.5 m, and the
        // grid smoothers before the tiers are cost-gated (smoothPath) or
        // collinear to a quarter cell (Douglas-Peucker), so a 50 m grid stair
        // the tier-2 search draws between marks survives all three — at
        // Newport's marks 3/4/5/7 it steps 71 m sideways and back (90°, 45°,
        // 45°, 42°, passing 12 m from mark 5). A chord replaces a run of
        // segments where it is at least as safe as they are, by the finished
        // route's own checks (engine/stringPull: the grid's cells, the chart's
        // depth and land, hazard buffers, a shallow band's clearance, survey,
        // structures, water no tide clears, a bank's clearance; no charted
        // mark between the stair and its chord, none passed closer). Gate
        // anchors and vertices on a charted lead are kept, and a canal
        // centre-line or marked-channel follower is left as it is. Before the
        // charted tails, which no smoother may re-draw.
        {
            const tPull = Date.now();
            const anchorKeys = new Set<string>();
            threeTier.polyline.forEach((p, i) => {
                if (threeTier.gateMask[i]) anchorKeys.add(`${p[0]},${p[1]}`);
            });
            const leads = [
                ...parseLeadingLines((layers.NAVLINE?.features ?? []) as Parameters<typeof parseLeadingLines>[0]),
                ...parseLeadingLines((layers.RECTRC?.features ?? []) as Parameters<typeof parseLeadingLines>[0]),
            ].map((l) => l.pts.map((q): [number, number] => [q.lon, q.lat]));
            const exposureOf = lineExposureReader({
                layers,
                grid,
                draftM: req.draftM,
                safetyM,
                obstructionBufferM,
                strictUncharted,
                tideCeilings: req.tideCeilings,
                surveyUncheckedCells: req.surveyUncheckedCells,
            });
            const marks = chartMarkPoints(layers);
            const corridorM = Math.SQRT2 * resolutionM;
            /** The pull's view of the route as it stands: anchors, kinds. */
            const shape = () => {
                const onLead = leadVertexMask(finalPolyline, leads);
                return {
                    pinned: finalPolyline.map((p, i) => onLead[i] || anchorKeys.has(`${p[0]},${p[1]}`)),
                    pullable: finalCaution.map((_, i) => !finalCanalMask[i] && !finalChannelMask[i]),
                    runKey: finalCaution.map(
                        (_, i) =>
                            `${finalCanalMask[i] ? 'K' : ''}${finalChannelMask[i] ? 'Y' : ''}${finalOffshoreMask[i] ? 'O' : ''}`,
                    ),
                };
            };
            /** Adopt a reshaped route: masks follow each new segment's
             *  original, caution is read afresh on every segment that changed
             *  — by the sampler, and by the exact cell walk the pull weighed it
             *  with (stage-B review, 2026-10-03: a chord clipping a caution cell
             *  for less than one 25 m step would otherwise draw green). */
            const adopt = (polyline: [number, number][], from: number[]): void => {
                const was = finalPolyline;
                const wasCaution = finalCaution;
                finalCaution = from.map((i, k) => {
                    const [a, b] = [polyline[k], polyline[k + 1]];
                    const same =
                        a[0] === was[i][0] && a[1] === was[i][1] && b[0] === was[i + 1][0] && b[1] === was[i + 1][1];
                    return same
                        ? wasCaution[i]
                        : segCrossesCaution(a[0], a[1], b[0], b[1]) ||
                              (exposureOf(a, b).state & LINE_STATE.GRID_CAUTION) !== 0;
                });
                finalCanalMask = from.map((i) => finalCanalMask[i]);
                finalChannelMask = from.map((i) => finalChannelMask[i]);
                finalOffshoreMask = from.map((i) => finalOffshoreMask[i]);
                finalPolyline = polyline;
            };
            let removed = 0;
            const pull = (extraPins?: readonly boolean[]): void => {
                const sh = shape();
                const pulled = pullTaut(finalPolyline, {
                    ...sh,
                    pinned: sh.pinned.map((p, i) => p || extraPins?.[i] === true),
                    exposureOf,
                    marks,
                    corridorM,
                });
                if (pulled.pulled === 0) return;
                removed += pulled.pulled;
                adopt(pulled.polyline, pulled.fromSeg);
            };
            pull();
            // A lateral gate the route crosses close by a mark is threaded
            // through its centre where that is at least as safe (Newport's
            // entrance: 12 m off mark 5 in a 54 m gate), and the route is
            // pulled again round the centres it now holds.
            const gates = lateralMarkGates(layers);
            if (gates.length > 0 && finalPolyline.length >= 2) {
                const sh = shape();
                const th = threadGateCentres(finalPolyline, { ...sh, exposureOf, marks, corridorM, gates });
                if (th.threaded > 0) {
                    adopt(th.polyline, th.fromSeg);
                    debug.gatesThreaded = th.threaded;
                    pull(th.onCentre);
                }
            }
            if (removed > 0) debug.stringPulled = removed;
            mark('stringPull', tPull);
        }
        debug.threeTier = threeTier.provenance;
        if (ENGINE_DEBUG)
            engineLog.warn(
                `[3tier] ${threeTier.spanCount} spans, ${polyline.length}→${finalPolyline.length} pts — ${threeTier.provenance}`,
            );
    } else {
        // Fallback — the proven monolith splice chain, byte-identical to before.
        // Fairlead: where the route transits a buoyed channel in OPEN water
        // (past the marina/canal MarinerEE owns), follow the lateral marks.
        const fl = applyFairleadAtGrid(polyline, cautionMask, grid, layers);
        // Leading-line snap: ride a charted navigation_line transit it follows.
        const ll = applyLeadingLineSnap(fl.polyline, fl.cautionMask, grid, layers);
        // Leading-line APPROACH: come into a charted-lead destination via the lead.
        const la = applyLeadingLineApproach(ll.polyline, ll.cautionMask, grid, layers);
        finalPolyline = la.polyline;
        finalCaution = la.cautionMask;
        flFairlead = fl.fairlead;
        llLeadingLines = ll.leadingLines;
        laLeadingApproach = la.leadingApproach;
    }

    // ── The charted tails (owner decision 7) ─────────────────────────
    // The route above runs to the last water deep enough for the keel; the
    // pin's own charted caution water carries it the rest of the way —
    // chartedWayToDeep's cells, simplified only along chords that stay in
    // that water (or deep water), ending AT the pin. Added after every
    // smoother, tier router and lead splice, so none of them can re-draw a
    // tail through a drying bank, uncharted water, a hazard or land. Every
    // tail segment is caution — red, 'needs tide' — and its shallow run below
    // carries the charted depth (endpointTail). Symmetric at the origin.
    let destinationTailStartSeg = -1;
    let originTailEndSeg = -1;
    if ((debug.originChartedPin || debug.destinationChartedPin) && finalPolyline.length >= 1) {
        const stepM = Math.max(10, resolutionM / 2);
        const chordInTailWater = (a: [number, number], b: [number, number]): boolean => {
            const steps = Math.max(1, Math.ceil(haversineM(a[1], a[0], b[1], b[0]) / stepM));
            for (let k = 0; k <= steps; k++) {
                const t = k / steps;
                const { x, y } = latLonToGrid(grid, a[1] + (b[1] - a[1]) * t, a[0] + (b[0] - a[0]) * t);
                if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return false;
                const idx = y * grid.width + x;
                if (!isChartedCaution(idx) && !isDeepEnough(idx)) return false;
            }
            return true;
        };
        // The tail against the CHART ITSELF, not the 50 m cells (fix-up,
        // 2026-09-30): decision 7's hard limits held only at cell
        // granularity — a 40 m drying strip between two cell centres walled
        // a pin off from deep water and the tail crossed it, and real tails
        // crossed 60–74 m of hard land the final audit's 500 m tolerance let
        // through. Every ≤5 m along the tail: never hard land (the audit's
        // own point rule — decision-1 and OSM water are water), never a band
        // the finest survey charts drying, never a spot no band charts at all
        // where the chart has bands (round-4 review, 2026-09-30: a gap
        // between two charted-caution cells passed; decision 7 says never
        // uncharted), never under a structure this mast cannot clear. Zero
        // tolerance.
        const onHardLand = hardLandAtPoint(layers);
        const depthBands = chartAreaIndexFor(layers).depth;
        const TAIL_CHECK_STEP_M = 5;
        const tailFault = (pts: readonly [number, number][]): string | null => {
            for (let i = 0; i + 1 < pts.length; i++) {
                const [lonA, latA] = pts[i];
                const [lonB, latB] = pts[i + 1];
                const steps = Math.max(1, Math.ceil(haversineM(latA, lonA, latB, lonB) / TAIL_CHECK_STEP_M));
                for (let k = 0; k <= steps; k++) {
                    const t = k / steps;
                    const lon = lonA + (lonB - lonA) * t;
                    const lat = latA + (latB - latA) * t;
                    if (onHardLand(lon, lat)) return 'charted land';
                    if (depthBands.length === 0) continue;
                    const d = chartedDepthAt(depthBands, lon, lat);
                    if (d === null) return 'water no chart covers';
                    if (d < 0) return 'a charted drying band';
                    // A 'needs tide' tail is water some tide clears (decision 11).
                    if (noTideAt(lon, lat)) return 'water no tide clears';
                }
            }
            return polylineCrossesClearanceBar(pts, layers.OBSTRN?.features ?? []) ? 'a low structure' : null;
        };
        /** The tail from the deep cell to the pin, as simplified points — or
         * the un-simplified cell path when only the simplification fails the
         * vector check — or why neither passes it. */
        const tailPoints = (
            way: readonly { x: number; y: number }[],
            pin: [number, number],
        ): [number, number][] | string => {
            const pts: [number, number][] = [...way].reverse().map((c) => gridToLatLon(grid, c.x, c.y));
            pts[pts.length - 1] = pin; // the pin lies in the way's first cell
            const simplified = douglasPeucker(pts, tolDeg, (a, b) => !chordInTailWater(a, b));
            if (tailFault(simplified) === null) return simplified;
            return tailFault(pts) ?? pts;
        };
        const noMask = (mask: boolean[], count: number, atStart: boolean): boolean[] =>
            mask.length === 0
                ? mask
                : atStart
                  ? [...new Array(count).fill(false), ...mask]
                  : [...mask, ...new Array(count).fill(false)];
        if (debug.destinationChartedPin && destinationTailWay) {
            const tail = tailPoints(destinationTailWay, [req.toLon, req.toLat]);
            if (typeof tail === 'string') {
                return {
                    error: `the destination's charted tail crosses ${tail}`,
                    code: 'charted-end-rejected',
                    debug,
                };
            }
            // tail[0] is the deep cell the route above ends on — unless a
            // splice moved that end, when the tail starts from it afresh.
            const from = tupleDistM(finalPolyline[finalPolyline.length - 1], tail[0]) > 1 ? 0 : 1;
            const added = tail.length - from;
            destinationTailStartSeg = finalPolyline.length - 1;
            finalPolyline = [...finalPolyline, ...tail.slice(from)];
            finalCaution = [...finalCaution, ...new Array(added).fill(true)];
            finalCanalMask = noMask(finalCanalMask, added, false);
            finalChannelMask = noMask(finalChannelMask, added, false);
            finalOffshoreMask = noMask(finalOffshoreMask, added, false);
        }
        if (debug.originChartedPin && originTailWay) {
            // Pin first, the deep cell (the route's first point) last.
            const headPts = tailPoints(originTailWay, [req.fromLon, req.fromLat]);
            if (typeof headPts === 'string') {
                return {
                    error: `the origin's charted head crosses ${headPts}`,
                    code: 'charted-end-rejected',
                    debug,
                };
            }
            const head = headPts.reverse();
            const to = tupleDistM(finalPolyline[0], head[head.length - 1]) > 1 ? head.length : head.length - 1;
            const added = to;
            finalPolyline = [...head.slice(0, to), ...finalPolyline];
            finalCaution = [...new Array(added).fill(true), ...finalCaution];
            finalCanalMask = noMask(finalCanalMask, added, true);
            finalChannelMask = noMask(finalChannelMask, added, true);
            finalOffshoreMask = noMask(finalOffshoreMask, added, true);
            originTailEndSeg = added - 1;
            if (destinationTailStartSeg >= 0) destinationTailStartSeg += added;
        }

        // ── Direct tails (Shane, 2026-10-03: "fix that") ──────────────
        // The tail above is the grid's way through the pin's charted water to
        // the cheapest deep water: a staircase, and — where the route does not
        // come back past the pin — out to deep water and back (two pins in one
        // shallow bay). It becomes one straight line from the pin to where it
        // joins the route most shortly, or straight to the other pin, amber
        // 'needs tide' to where it first reaches deep water (engine/directTail
        // has the rules). The line is held to the grid (every cell the pin's
        // charted water or deep enough), to the chart itself (tailFault) and
        // to every charted hazard's keep-out; where none passes the charted
        // way stays and the route says why (pinTail).
        if (finalPolyline.length >= 2) {
            const needM = req.draftM + safetyM;
            const cellAt = (lon: number, lat: number): number => {
                const { x, y } = latLonToGrid(grid, lat, lon);
                return x < 0 || y < 0 || x >= grid.width || y >= grid.height ? -1 : y * grid.width + x;
            };
            const pinCell = (idx: number): boolean =>
                (debug.originChartedPin === true && idx === originTapIdx) ||
                (debug.destinationChartedPin === true && idx === destinationTapIdx);
            /** Why a grid cell is not the pin's charted water nor deep enough, in the route's words. */
            const cellFault = (idx: number): string => {
                if (Number.isNaN(grid.cells[idx])) {
                    if (grid.landBlocked?.[idx] === 1) return 'charted land';
                    if (grid.markDiscBlocked?.[idx] === 1) return "a navigation mark's keep-out";
                    if (grid.obstnBlocked?.[idx] === 1) return "a charted hazard's keep-out";
                    if (grid.berthBlocked?.[idx] === 1) return 'a berth or pontoon';
                    if (grid.clearanceBarred?.[idx] === 1) return 'a low structure';
                    if (isNoTideCell(idx)) return 'water no tide clears';
                    return 'water the router keeps closed';
                }
                if ((grid.shallowDepthM?.[idx] ?? 0) < 0) return 'a charted drying band';
                if (grid.wingCaution?.[idx] === 1) return 'the wrong side of a channel mark';
                if (grid.cells[idx] === UNKNOWN_OPEN) return 'water no chart covers';
                return 'water outside its charted shallows';
            };
            const lineFault = (from: [number, number], to: [number, number]): string | null => {
                const steps = Math.max(1, Math.ceil(haversineM(from[1], from[0], to[1], to[0]) / 10));
                for (let k = 0; k <= steps; k++) {
                    const idx = cellAt(
                        from[0] + ((to[0] - from[0]) * k) / steps,
                        from[1] + ((to[1] - from[1]) * k) / steps,
                    );
                    if (idx < 0) return 'water off the chart grid';
                    if (isDeepEnough(idx) || isChartedCaution(idx)) continue;
                    // A pin admitted on its own spot: its own cell is the chart's call (above).
                    if (pinCell(idx) && (idx === originTapIdx ? exactSpotPin.origin : exactSpotPin.destination))
                        continue;
                    return cellFault(idx);
                }
                const exact = tailFault([from, to]);
                if (exact) return exact;
                return hazardBufferSegments([from, to], layers, obstructionBufferM, needM)[0]
                    ? "a charted hazard's keep-out"
                    : null;
            };
            const gateAnchors = new Set<string>();
            if (threeTier)
                threeTier.polyline.forEach((p, i) => {
                    if (threeTier.gateMask[i]) gateAnchors.add(`${p[0]},${p[1]}`);
                });
            const direct = directTails(
                {
                    polyline: finalPolyline,
                    caution: finalCaution,
                    canal: finalCanalMask,
                    channel: finalChannelMask,
                    offshore: finalOffshoreMask,
                    originTailEndSeg,
                    destinationTailStartSeg,
                    gateAnchors,
                    resolutionM,
                    lineFault,
                    isDeep: (lon, lat) => {
                        const idx = cellAt(lon, lat);
                        return idx >= 0 && isDeepEnough(idx);
                    },
                    inPinCell: (lon, lat) => pinCell(cellAt(lon, lat)),
                    leastDepthAlong: leastChartedDepthAlong,
                },
                { origin: debug.originChartedPin === true, destination: debug.destinationChartedPin === true },
            );
            if (direct.done.origin || direct.done.destination) {
                finalPolyline = direct.polyline;
                finalCaution = direct.caution;
                finalCanalMask = direct.canal;
                finalChannelMask = direct.channel;
                finalOffshoreMask = direct.offshore;
                originTailEndSeg = direct.originTailEndSeg;
                destinationTailStartSeg = direct.destinationTailStartSeg;
                debug.directTail = direct.done;
                engineLog.warn(
                    `[directTail] ${(['origin', 'destination'] as const)
                        .filter((e) => direct.done[e])
                        .map(
                            (e) =>
                                `${e}: ${direct.done[e]!.fromM} m of route → a ${direct.done[e]!.toM} m straight line`,
                        )
                        .join('; ')}`,
                );
            }
            if (direct.refused.origin || direct.refused.destination) debug.directTailRefused = direct.refused;
        }
    }

    const destinationNeedsLandBridgeRepair =
        destinationTapOnHardLand || (debug.destinationSnap?.snapDistanceM ?? 0) > 30;
    if (debug.destinationWaterSnap && destinationNeedsLandBridgeRepair && finalPolyline.length >= 2) {
        const tailScanM = Math.max(1500, (debug.destinationSnap?.snapDistanceM ?? 0) + 750);
        let segIdx = -1;
        let tailM = 0;
        for (let i = finalPolyline.length - 2; i >= 0; i--) {
            const a = finalPolyline[i];
            const b = finalPolyline[i + 1];
            tailM += tupleDistM(a, b);
            if (tailM > tailScanM) break;
            if (tupleLineCrossesHardLand(grid, a, b)) segIdx = i;
        }
        if (segIdx >= 0) {
            const a = finalPolyline[segIdx];
            const b = finalPolyline[finalPolyline.length - 1];
            const rawBridge = gridBridgePolyline(grid, { lat: a[1], lon: a[0] }, { lat: b[1], lon: b[0] });
            const bridge: [number, number][] = [];
            for (const p of rawBridge ?? []) {
                bridge.push(p);
            }
            if (bridge && bridge.length >= 2) {
                const bridgeCaution: boolean[] = [];
                const bridgeSegCrossesCaution = (p0: [number, number], p1: [number, number]): boolean => {
                    const stepM = Math.max(25, resolutionM / 2);
                    const segM = haversineM(p0[1], p0[0], p1[1], p1[0]);
                    const steps = Math.max(1, Math.ceil(segM / stepM));
                    for (let s = 0; s <= steps; s++) {
                        const t = s / steps;
                        const { x, y } = latLonToGrid(grid, p0[1] + (p1[1] - p0[1]) * t, p0[0] + (p1[0] - p0[0]) * t);
                        if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
                        const idx = y * grid.width + x;
                        const d = grid.cells[idx];
                        if (Number.isNaN(d) || d < 0 || isUnvouchedIdx(idx)) return true;
                    }
                    return false;
                };
                for (let i = 0; i < bridge.length - 1; i++) {
                    bridgeCaution.push(bridgeSegCrossesCaution(bridge[i], bridge[i + 1]));
                }

                const expandMask = (mask: boolean[]): boolean[] => {
                    if (mask.length === 0) return mask;
                    const suffixSegCount = finalPolyline.length - 1 - segIdx;
                    const fill = mask.slice(segIdx, segIdx + suffixSegCount).some(Boolean);
                    return [...mask.slice(0, segIdx), ...new Array(bridge.length - 1).fill(fill)];
                };

                finalPolyline = [
                    ...finalPolyline.slice(0, segIdx),
                    ...bridge.map(([lon, lat]) => [lon, lat] as [number, number]),
                ];
                finalCaution = [...finalCaution.slice(0, segIdx), ...bridgeCaution];
                finalCanalMask = expandMask(finalCanalMask);
                finalChannelMask = expandMask(finalChannelMask);
                finalOffshoreMask = expandMask(finalOffshoreMask);
                debug.destinationLandBridgeRepaired = true;
            }
        }
    }

    // ── Inland-tail trim: a route may never TERMINATE on charted dry land ──
    // The relax/carve machinery deliberately makes an inland pin (a suburb
    // centroid like "Pinkenba") reachable — LNDARE inside a relax zone becomes
    // 500×-cost CAUTION and drying foreshore rides as red — so the tail crawls
    // up the bank and the tide chips price a land crossing (+5.1 m, nonsense).
    // GATED on the destination TAP being on hard land (inside chart LNDARE /
    // land-blocked): a drying BERTH keeps its tail + tide window because its
    // pin sits on the drying grid, not on land. When gated in, walk back from
    // the end dropping every vertex that is not GENUINELY WET:
    //   wet = carved/injected canal-marina water | marked-channel preferred |
    //         real charted depth ≥ 0 | charted shallow WATER (DRVAL1 > 0).
    //   dry = relax-carved LNDARE, drying banks (DRVAL1 ≤ 0), no-evidence cells.
    // landBlocked can't be the key (relax-carved cells skip it); origin side is
    // deliberately untouched (berth-start departures ride a visible carve by
    // design). A trim that would eat >5 km is a data problem to surface, not
    // geometry to silently chop — left alone.
    //
    // Also gated in, since 2026-10-01, when the PIN is water but the route
    // ENDS on hard land (the audit's point rule): a pin it could not reach by
    // water — a dredged river behind a closure — whose relaxed tail snapped
    // onto the bank. That tail is cut back the same way, and the metres are
    // a gap to the pin (destinationLandTailTrimM), never "the destination is
    // inland": the pin is water.
    const routeEnd = finalPolyline[finalPolyline.length - 1];
    const routeEndsOnHardLand =
        !destinationTapOnHardLand && finalPolyline.length >= 2 && onHardLandPin(routeEnd[0], routeEnd[1]);
    if (destinationTapOnHardLand || routeEndsOnHardLand) {
        const sd = grid.shallowDepthM;
        const isWetVertex = (p: readonly [number, number]): boolean => {
            const { x, y } = latLonToGrid(grid, p[1], p[0]);
            if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return false;
            const idx = y * grid.width + x;
            if (grid.injectedCanal?.[idx] === 1) return true; // carved marina/canal water
            if (grid.preferred[idx] === 1) return true; // marked channel / fairway
            const d = grid.cells[idx];
            if (!Number.isNaN(d) && d >= 0) return true; // real charted depth
            const s = sd ? sd[idx] : NaN;
            if (!Number.isNaN(s) && s > 0) return true; // charted shallow WATER (not drying)
            return false;
        };
        let lastWet = finalPolyline.length - 1;
        while (lastWet > 1 && !isWetVertex(finalPolyline[lastWet])) lastWet--;
        const dropped = finalPolyline.length - 1 - lastWet;
        if (dropped > 0) {
            let trimmedM = 0;
            for (let i = lastWet; i < finalPolyline.length - 1; i++) {
                trimmedM += tupleDistM(finalPolyline[i], finalPolyline[i + 1]);
            }
            if (trimmedM < 5000) {
                finalPolyline = finalPolyline.slice(0, lastWet + 1);
                finalCaution = finalCaution.slice(0, lastWet);
                finalCanalMask = finalCanalMask.slice(0, lastWet);
                finalChannelMask = finalChannelMask.slice(0, lastWet);
                finalOffshoreMask = finalOffshoreMask.slice(0, lastWet);
                if (destinationTapOnHardLand) {
                    debug.destinationInlandTrimM = Math.round(trimmedM);
                    engineLog.warn(
                        `[inlandTrim] destination is on charted land — trimmed ${Math.round(trimmedM)} m overland tail (${dropped} vtx); route now ends at the water's edge`,
                    );
                } else {
                    debug.destinationLandTailTrimM = Math.round(trimmedM);
                    engineLog.warn(
                        `[inlandTrim] the destination pin is water the route could not reach — trimmed ${Math.round(trimmedM)} m tail off charted land (${dropped} vtx)`,
                    );
                }
            } else {
                engineLog.warn(
                    `[inlandTrim] SKIPPED — overland tail is ${Math.round(trimmedM)} m (>5 km); leaving geometry for diagnosis`,
                );
            }
        }
    }

    // ── A pin off the water: the route stops at its edge (decision 7) ───
    // Decision 7's limit is never drying (round 3, 2026-09-30). A pin on a
    // drying bank used to keep "today's ending": the nearest cell the route
    // could snap to, which is ON the bank — the route crossed hundreds of
    // metres of charted drying ground to end metres from the pin (~970 m to
    // ~30 m on a real bank). Now, for a pin on a drying bank or on charted
    // land, the route stops at the last water the chart paints neither
    // drying nor land, nearest the pin — the edge, cut to within a metre by
    // the chart itself (hard land by the audit's own point rule; drying by
    // the finest survey's charted depth) — and pinOffWater says so. The
    // origin is symmetric: the route starts at the edge.
    if ((pinOffWater.origin || pinOffWater.destination) && finalPolyline.length >= 2) {
        const onHardLand = hardLandAtPoint(layers);
        const depthBands = chartAreaIndexFor(layers).depth;
        const offWater = (p: readonly [number, number]): boolean => {
            if (onHardLand(p[0], p[1])) return true;
            const d = depthBands.length > 0 ? chartedDepthAt(depthBands, p[0], p[1]) : null;
            // …or water no tide clears (decision 11, 2026-10-01): the route
            // stops at the edge of the water a tide does.
            return (d !== null && d < 0) || noTideAt(p[0], p[1]) !== null;
        };
        const lerp = (a: readonly [number, number], b: readonly [number, number], t: number): [number, number] => [
            a[0] + (b[0] - a[0]) * t,
            a[1] + (b[1] - a[1]) * t,
        ];
        const EDGE_STEP_M = 5;
        /** Walking in from one end: the segment and point where the route
         * last leaves (at the destination) or first reaches (at the origin)
         * water, or null when that end is on water already, or no water is
         * reached at all. The point is refined between the samples either
         * side of the edge. */
        const edgeFrom = (fromEnd: boolean): { seg: number; point: [number, number] } | null => {
            const n = finalPolyline.length;
            if (!offWater(finalPolyline[fromEnd ? n - 1 : 0])) return null;
            for (let k = 0; k < n - 1; k++) {
                const seg = fromEnd ? n - 2 - k : k;
                // The pin's end of this segment first.
                const pinSide = finalPolyline[fromEnd ? seg + 1 : seg];
                const far = finalPolyline[fromEnd ? seg : seg + 1];
                const segM = tupleDistM(pinSide, far);
                const steps = Math.max(1, Math.ceil(segM / EDGE_STEP_M));
                for (let s = 1; s <= steps; s++) {
                    if (offWater(lerp(pinSide, far, s / steps))) continue;
                    // Water between (s-1)/steps (off) and s/steps (on).
                    let lo = (s - 1) / steps;
                    let hi = s / steps;
                    for (let it = 0; it < 6; it++) {
                        const mid = (lo + hi) / 2;
                        if (offWater(lerp(pinSide, far, mid))) lo = mid;
                        else hi = mid;
                    }
                    return { seg, point: lerp(pinSide, far, hi) };
                }
            }
            return null;
        };
        const trims: { origin?: number; destination?: number } = {};
        if (pinOffWater.destination) {
            const edge = edgeFrom(true);
            if (edge) {
                let cutM = tupleDistM(edge.point, finalPolyline[edge.seg + 1]);
                for (let i = edge.seg + 1; i < finalPolyline.length - 1; i++)
                    cutM += tupleDistM(finalPolyline[i], finalPolyline[i + 1]);
                const keep = edge.seg + 1; // segments 0..edge.seg
                finalPolyline = [...finalPolyline.slice(0, edge.seg + 1), edge.point];
                finalCaution = finalCaution.slice(0, keep);
                finalCanalMask = finalCanalMask.slice(0, keep);
                finalChannelMask = finalChannelMask.slice(0, keep);
                finalOffshoreMask = finalOffshoreMask.slice(0, keep);
                if (destinationTailStartSeg >= keep) destinationTailStartSeg = -1;
                trims.destination = Math.round(cutM);
            }
        }
        if (pinOffWater.origin) {
            const edge = edgeFrom(false);
            if (edge) {
                let cutM = tupleDistM(finalPolyline[edge.seg], edge.point);
                for (let i = 0; i < edge.seg; i++) cutM += tupleDistM(finalPolyline[i], finalPolyline[i + 1]);
                finalPolyline = [edge.point, ...finalPolyline.slice(edge.seg + 1)];
                finalCaution = finalCaution.slice(edge.seg);
                finalCanalMask = finalCanalMask.slice(edge.seg);
                finalChannelMask = finalChannelMask.slice(edge.seg);
                finalOffshoreMask = finalOffshoreMask.slice(edge.seg);
                if (destinationTailStartSeg >= 0) destinationTailStartSeg -= edge.seg;
                if (originTailEndSeg >= 0) originTailEndSeg = Math.max(-1, originTailEndSeg - edge.seg);
                trims.origin = Math.round(cutM);
            }
        }
        if (trims.origin !== undefined || trims.destination !== undefined) {
            debug.pinEdgeTrimM = trims;
            engineLog.warn(
                `[pinEdge] pin off the water — route cut back to the water's edge (origin ${trims.origin ?? 0} m, destination ${trims.destination ?? 0} m)`,
            );
        }
    }

    // ── Charted tails on the FINAL geometry (decision 7) ─────────────
    // The tails were built from the pins' own charted water after every
    // splice; this re-checks the finished geometry all the same. Walking in
    // from each charted pin, every sample up to the first deep-enough water
    // must be the pin's charted caution water; anything else (land, a drying
    // bank, uncharted water, a hazard) and this attempt is rejected —
    // routeInshoreOnce re-runs it with today's endpoints, so a tail can never
    // be the way a route cuts through other shallows.
    if ((debug.originChartedPin || debug.destinationChartedPin) && finalPolyline.length >= 2) {
        const stepM = Math.max(10, resolutionM / 2);
        const chartedTailClean = (fromEnd: boolean): boolean => {
            const n = finalPolyline.length;
            for (let k = 0; k < n - 1; k++) {
                // A tail cut short of the deep water (no out-and-back, above)
                // ends where it joins the path: the walk ends there too.
                const seg = fromEnd ? n - 2 - k : k;
                if (fromEnd && outAndBackCutM.destination !== undefined && seg < destinationTailStartSeg) return true;
                if (!fromEnd && outAndBackCutM.origin !== undefined && seg > originTailEndSeg) return true;
                const a = finalPolyline[fromEnd ? n - 1 - k : k];
                const b = finalPolyline[fromEnd ? n - 2 - k : k + 1];
                const steps = Math.max(1, Math.ceil(haversineM(a[1], a[0], b[1], b[0]) / stepM));
                for (let s = 0; s <= steps; s++) {
                    const t = s / steps;
                    const { x, y } = latLonToGrid(grid, a[1] + (b[1] - a[1]) * t, a[0] + (b[0] - a[0]) * t);
                    if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) return false;
                    const idx = y * grid.width + x;
                    if (isDeepEnough(idx)) return true;
                    // A pin admitted on its own spot (its cell's centre lies
                    // in another band): its own cell is the chart's call, and
                    // the tail's exact check above already held it to that.
                    const pinIdx = fromEnd ? destinationTapIdx : originTapIdx;
                    if (idx === pinIdx && exactSpotPin[fromEnd ? 'destination' : 'origin']) continue;
                    if (!isChartedCaution(idx)) return false;
                }
            }
            return true;
        };
        if (
            (debug.originChartedPin && !chartedTailClean(false)) ||
            (debug.destinationChartedPin && !chartedTailClean(true))
        ) {
            return {
                error: 'the finished route reaches a pin in charted-shallow water through other water',
                code: 'charted-end-rejected',
                debug,
            };
        }
    }

    // ── Water no tide clears on the FINAL geometry (decision 11) ───────
    // The grid blocks it for A*'s cells; the off-grid splices (a lead or
    // recommended-track snap, a canal egress) and the simplifier's chords do
    // not read the grid, a 50 m cell is classed by its centre, and a bar
    // thinner than a cell is left open. So the finished route is held to the
    // chart itself every 10 m (fix-up, 2026-10-01; tideCeiling
    // classifyNoTideRuns), and each stretch of such water on it is:
    //   • a clip — a chord over a band's corner with a local way round it,
    //     no more than NO_TIDE_CLIP_TOLERANCE_M (50 m, fixed: a coarsened
    //     grid's cell used to set it) out to the band edges: kept, drawn red
    //     with its chip (decision 10);
    //   • a creek — longer, with a local way through water a tide clears (a
    //     channel narrower than a cell through drying flats): that way, drawn
    //     on a 10 m raster, replaces it here;
    //   • a crossing — no local way round, however thin the bar (30–59 m bars
    //     were routed straight over by the old one-cell tolerance): refused
    //     below, after the land veto (a route that crosses land as well is
    //     refused for the land), and routeInshore routes again with the
    //     crossed band closed.
    // The straight bridge from a cut-off origin pin to where the route really
    // starts (a snap of more than FAR_SNAP_M) is not read: it is not water
    // the route takes, and reading it refused Newport routes at some grid
    // alignments for the canal estate's drying ground (fix-up, 2026-10-01).
    // routeInshoreMain's relax retry and the verdict own that gap.
    let noTideCrossings: { run: NoTideRun; spots: [number, number][] }[] = [];
    if (tideLookup.size > 0 && finalPolyline.length >= 2) {
        let skipM = 0;
        const oSnap = debug.originSnap;
        if (!debug.originChartedPin && oSnap && oSnap.snapDistanceM > FAR_SNAP_M) {
            // From the first point within a cell of where the route starts.
            let along = 0;
            outer: for (let i = 0; i + 1 < finalPolyline.length; i++) {
                const a = finalPolyline[i];
                const b = finalPolyline[i + 1];
                const segM = tupleDistM(a, b);
                const steps = Math.max(1, Math.ceil(segM / 10));
                for (let k = 0; k <= steps; k++) {
                    const lon = a[0] + ((b[0] - a[0]) * k) / steps;
                    const lat = a[1] + ((b[1] - a[1]) * k) / steps;
                    if (haversineM(lat, lon, oSnap.snappedLat, oSnap.snappedLon) <= resolutionM) {
                        skipM = along + (segM * k) / steps;
                        break outer;
                    }
                }
                along += segM;
            }
        }
        const classify = () =>
            classifyNoTideRuns(layers, finalPolyline, tideLookup, deepFloorM, {
                fromM: skipM,
                toleranceM: NO_TIDE_CLIP_TOLERANCE_M,
            });
        const sorted = classify();
        noTideCrossings = [...sorted.crossings];
        const cum = [0];
        for (let i = 1; i < finalPolyline.length; i++)
            cum.push(cum[i - 1] + tupleDistM(finalPolyline[i - 1], finalPolyline[i]));
        // A local way may stand in for its stretch only clear of the pins'
        // charted tails (decision 7 owns those), under no structure this mast
        // cannot clear, and no wild detour.
        const splices: NoTideSplice[] = [];
        for (const sp of sorted.splices) {
            const inSeg = pointAlongM(finalPolyline, cum, sp.fromM).seg;
            const outSeg = pointAlongM(finalPolyline, cum, sp.toM).seg;
            let wayM = 0;
            for (let k = 1; k < sp.points.length; k++) wayM += tupleDistM(sp.points[k - 1], sp.points[k]);
            const ok =
                (originTailEndSeg < 0 || inSeg > originTailEndSeg) &&
                (destinationTailStartSeg < 0 || outSeg < destinationTailStartSeg) &&
                wayM <= 2 * (sp.toM - sp.fromM) + 300 &&
                !polylineCrossesClearanceBar(sp.points, layers.OBSTRN?.features ?? []);
            if (ok) splices.push(sp);
            else noTideCrossings.push(sp);
        }
        if (splices.length > 0) {
            const bands = chartAreaIndexFor(layers).depth;
            /** A spliced segment is caution where the chart charts it shallower
             *  than the keel needs, or not at all (its 10 m samples). */
            const wayCaution = (a: [number, number], b: [number, number]): boolean => {
                if (bands.length === 0) return true;
                const steps = Math.max(1, Math.ceil(tupleDistM(a, b) / 10));
                for (let k = 0; k <= steps; k++) {
                    const d = chartedDepthAt(
                        bands,
                        a[0] + ((b[0] - a[0]) * k) / steps,
                        a[1] + ((b[1] - a[1]) * k) / steps,
                    );
                    if (d === null || d < deepFloorM) return true;
                }
                return false;
            };
            const pts: [number, number][] = [];
            /** Per new segment: the old segment it is part of, or -1 for a way's. */
            const src: number[] = [];
            const pushPoint = (p: [number, number], from: number): void => {
                if (pts.length > 0 && tupleDistM(pts[pts.length - 1], p) < 0.01) return;
                if (pts.length > 0) src.push(from);
                pts.push(p);
            };
            let next = 0;
            for (const sp of [...splices].sort((a, b) => a.fromM - b.fromM)) {
                const a = pointAlongM(finalPolyline, cum, sp.fromM);
                const b = pointAlongM(finalPolyline, cum, sp.toM);
                for (; next <= a.seg; next++) pushPoint(finalPolyline[next], next - 1);
                pushPoint(a.p, a.seg);
                for (let k = 1; k < sp.points.length; k++) pushPoint(sp.points[k], -1);
                next = b.seg + 1;
            }
            for (; next < finalPolyline.length; next++) pushPoint(finalPolyline[next], next - 1);
            const remap = (mask: boolean[], way: (k: number) => boolean): boolean[] =>
                mask.length === 0 ? mask : src.map((o, k) => (o >= 0 ? (mask[o] ?? false) : way(k)));
            finalCaution = remap(finalCaution, (k) => wayCaution(pts[k], pts[k + 1]));
            finalCanalMask = remap(finalCanalMask, () => false);
            finalChannelMask = remap(finalChannelMask, () => false);
            finalOffshoreMask = remap(finalOffshoreMask, () => false);
            if (originTailEndSeg >= 0) originTailEndSeg = src.lastIndexOf(originTailEndSeg);
            if (destinationTailStartSeg >= 0) destinationTailStartSeg = src.indexOf(destinationTailStartSeg);
            finalPolyline = pts;
            debug.noTideSplicedM = splices.map((sp) => Math.round(sp.run.lengthM));
            engineLog.warn(
                `[noTide] ${splices.length} stretch(es) over water no tide clears (${debug.noTideSplicedM.join(', ')} m) redrawn along a local way through water a tide clears`,
            );
            // The redrawn route is held to the chart again: whatever is left
            // that is not a clip is a crossing.
            const again = classify();
            noTideCrossings = [...noTideCrossings, ...again.crossings, ...again.splices];
        }
    }

    // Compute total length in NM along the final polyline.
    let distM = 0;
    for (let i = 1; i < finalPolyline.length; i++) {
        distM += haversineM(finalPolyline[i - 1][1], finalPolyline[i - 1][0], finalPolyline[i][1], finalPolyline[i][0]);
    }

    // ── Mast gate: never pass under a structure this vessel cannot clear ──
    // (Part B, 2026-09-30.) The grid hard-blocks every low-clearance bar, but
    // several splices ride their own lines OFF the grid (the RECTRC and
    // leading-line snaps, canal egress, the tap-to-water visible bridge at
    // each end) and the simplifier chords between vertices. Re-check the
    // FINAL geometry exactly against each blocking structure's own line: a
    // segment crossing it — or a vertex inside an area bridge — is the mast
    // passing under it, and the honest verdict is a refusal that names it.
    // A route that only runs NEAR a bridge is not under it.
    const underBar = polylineCrossesClearanceBar(finalPolyline, layers.OBSTRN?.features ?? []);
    if (underBar) {
        engineLog.warn(
            `[airDraft] final route passes under a ${String(underBar.properties._structure)} it cannot clear (${String(underBar.properties._block)}) — REFUSING`,
        );
        return {
            error: clearanceRefusalMessage(underBar.properties, 'here'),
            code: 'air-draft-blocked',
            debug,
        };
    }

    // ── Charted hazards on the FINAL geometry (round-3 review, 2026-09-30) ─
    // The grid's hazard buffers hold for A*'s cells; the carves (now barred
    // from charted hazard cells), smoothing chords and the off-grid splices
    // can still pass inside one. A segment within the obstruction buffer of a
    // charted hazard whose depth over it is unknown or too shallow is caution
    // — red outside a marked channel, like the lead overlay's 'charted hazard
    // near' — never shipped as clean water. Not a refusal: a lead is meant to
    // guide past the wreck it clears (safetyAudit hazardBufferSegments).
    // Kept for the shallow sampler too: a hazard's red is not the tide's to
    // lift (owner decision 10, RouteResult.tideDepthM).
    const nearHazard = hazardBufferSegments(finalPolyline, layers, obstructionBufferM, req.draftM + safetyM);
    {
        let flagged = 0;
        for (let i = 0; i < nearHazard.length && i < finalCaution.length; i++) {
            if (nearHazard[i] && !finalCaution[i]) {
                finalCaution[i] = true;
                flagged++;
            }
        }
        if (flagged > 0) {
            debug.hazardBufferSegs = flagged;
            engineLog.warn(`[hazard] ${flagged} segment(s) pass inside a charted hazard's buffer — flagged caution`);
        }
    }

    // ── Exact-vector hard-land veto ─────────────────────────────────
    // Grid rescues exist for small chart-alignment errors at marina mouths,
    // but no emitted route may turn those rescues into a sustained crossing
    // of source LNDARE. Re-check the FINAL post-splice geometry against the
    // original vectors, independently of every grid carve. Overlapping
    // DEPARE/DRGARE/FAIRWY means the sources disagree (caution, not an
    // unambiguous land verdict); a >500 m unvouched run is an honest refusal.
    // `permissive` is retained for deliberately partial synthetic/legacy
    // layer packs; the live orchestrator always requests `strict`, where both
    // missing-water and hard-land source verdicts are enforceable.
    const hardLandAudit = strictUncharted ? auditUnvouchedHardLand(layers, finalPolyline) : null;
    if (hardLandAudit && hardLandAudit.maxRunM > MAX_UNVOUCHED_HARD_LAND_RUN_M) {
        const hardLandDebug = {
            ...debug,
            hardLandMaxRunM: Math.round(hardLandAudit.maxRunM),
            hardLandTotalM: Math.round(hardLandAudit.totalM),
            ...(hardLandAudit.maxRunStart && hardLandAudit.maxRunEnd
                ? { hardLandRun: { start: hardLandAudit.maxRunStart, end: hardLandAudit.maxRunEnd } }
                : {}),
        } as RouteDebug;
        engineLog.warn(
            `[hardLand] final route crosses ${Math.round(hardLandAudit.maxRunM)} m continuously / ${Math.round(hardLandAudit.totalM)} m total of unvouched charted land${hardLandAudit.maxRunStart && hardLandAudit.maxRunEnd ? ` (${hardLandAudit.maxRunStart[1].toFixed(4)},${hardLandAudit.maxRunStart[0].toFixed(4)} → ${hardLandAudit.maxRunEnd[1].toFixed(4)},${hardLandAudit.maxRunEnd[0].toFixed(4)})` : ''} — REFUSING`,
        );
        return {
            error: `No safe chart-vouched route: the only candidate crosses ${(hardLandAudit.maxRunM / 1000).toFixed(1)} km of charted land`,
            code: 'hard-land-crossing',
            debug: hardLandDebug,
        };
    }
    // What the shipped route crosses, for a PROMOTED Seaway route to be held
    // to (InshoreRouter seawayGraphSafetyFault: never more land than this).
    // And how much of it lies away from a pin's own edge (2026-10-01): land
    // the route crosses rather than the ground a pin off the water sits on.
    // A relaxed rescue may not cross any (relaxedRescueFault), and Auto
    // refuses a route that does (services/autoroutingThalassa).
    if (hardLandAudit) {
        debug.hardLandTotalM = Math.round(hardLandAudit.totalM);
        const away = hardLandAwayFromPinEdges(hardLandAudit, {
            origin: !!pinOffWater.origin || debug.pinEdgeTrimM?.origin !== undefined,
            destination:
                !!pinOffWater.destination ||
                (debug.destinationInlandTrimM ?? 0) > 0 ||
                debug.pinEdgeTrimM?.destination !== undefined,
        });
        debug.hardLandAwayM = Math.round(away.metres);
        if (away.at) debug.hardLandAwayAt = away.at;
    }

    // ── A crossing of water no tide clears: refused (decision 11) ──────
    // After the land veto (a route that crosses land as well is refused for
    // the land). The refusal names the longest crossing; debug.noTideCrossing
    // says where every crossed band was read, and whether this attempt
    // reached both pins — only then does it prove the crossing is the only
    // way through (routeInshore).
    if (noTideCrossings.length > 0) {
        const worst = noTideCrossings.reduce((a, b) => (b.run.lengthM > a.run.lengthM ? b : a));
        const reached = (which: 'origin' | 'destination'): boolean =>
            !!pinOffWater[which] ||
            ((which === 'origin' ? debug.originSnap : debug.destinationSnap)?.snapDistanceM ?? 0) +
                (which === 'destination'
                    ? (debug.destinationInlandTrimM ?? 0) + (debug.destinationLandTailTrimM ?? 0)
                    : 0) <=
                FAR_SNAP_M;
        const totalM = noTideCrossings.reduce((m, c) => m + c.run.lengthM, 0);
        engineLog.warn(
            `[noTide] final route crosses ${Math.round(totalM)} m no tide clears with no local way round (worst ${Math.round(worst.run.lengthM)} m near ${worst.run.mid[1].toFixed(4)},${worst.run.mid[0].toFixed(4)})${(req.tideBarriers?.length ?? 0) > 0 ? ` with ${req.tideBarriers?.length} band(s) closed` : ''} — REFUSING`,
        );
        return {
            error: noTideClearsRefusal(layers, worst.run, req.draftM, deepFloorM),
            code: 'no-tide-clears',
            debug: {
                ...debug,
                noTideCrossing: {
                    mid: worst.run.mid,
                    lengthM: Math.round(totalM),
                    spots: noTideCrossings.flatMap((c) => c.spots),
                    reachedPins: reached('origin') && reached('destination'),
                },
            } as RouteDebug,
        };
    }

    // ── Engine-boundary water-vouched sweep (strict policy only) ─────
    // The FINAL polyline (post smoothing / fairlead / leading-line
    // splices) is geometry-sampled at half-cell steps against the
    // no-evidence mask. Runs accumulate ACROSS vertices — a coverage
    // hole doesn't reset at a turn. Longest run beyond UNCHARTED_MAX_
    // RUN_M ⇒ refuse: no source vouches there is water for >1 NM of
    // this route, and "no data" must never render as confident clean
    // water (Bribie field bug, reply 16). Short runs were already
    // caution-flagged red by cautionRaw above. Out-of-grid samples
    // can't occur for A*-derived geometry and are ignored if splices
    // produce one. The GEBCO caller-side backstop remains the third net.
    let unchartedMaxRunM = 0;
    if (strictUncharted && finalPolyline.length >= 2) {
        const tSweep = Date.now();
        const stepM = Math.max(25, resolutionM / 2);
        let runM = 0;
        for (let i = 1; i < finalPolyline.length; i++) {
            const [lonA, latA] = finalPolyline[i - 1];
            const [lonB, latB] = finalPolyline[i];
            const segM = haversineM(latA, lonA, latB, lonB);
            const steps = Math.max(1, Math.ceil(segM / stepM));
            for (let s = 1; s <= steps; s++) {
                const t = s / steps;
                const { x, y } = latLonToGrid(grid, latA + (latB - latA) * t, lonA + (lonB - lonA) * t);
                const inGrid = x >= 0 && y >= 0 && x < grid.width && y < grid.height;
                if (inGrid && isUnvouchedIdx(y * grid.width + x)) {
                    runM += segM / steps;
                    if (runM > unchartedMaxRunM) unchartedMaxRunM = runM;
                } else {
                    runM = 0;
                }
            }
        }
        mark('unchartedSweep', tSweep);
        if (unchartedMaxRunM > UNCHARTED_MAX_RUN_M) {
            return {
                error: `Route crosses ${(unchartedMaxRunM / 1852).toFixed(1)} NM of uncharted water — no installed chart covers that stretch`,
                code: 'uncharted-corridor',
                debug: { ...debug, unchartedMaxRunM: Math.round(unchartedMaxRunM) } as RouteDebug,
            };
        }
    }

    // CHARTED-shallow companion to the uncharted sweep above: the keel margin
    // (draft + safetyM) is preference-weighted in A* (40×) but never refused, so a
    // route squeezed through sub-margin water ships with only red shading. Name the
    // longest such run in the device log, AND collect per-run records — length,
    // midpoint, and the shallowest REAL charted depth along the run (from
    // grid.shallowDepthM, the DRVAL1 the CAUTION sentinel erased) — the substrate
    // for the Phase 7 tide-window annotation. minDepthM stays null when nothing
    // charted vouches a depth (uncharted/conflict caution): a window computed from
    // a null would be fabricated, so callers must skip those runs.
    // The finest survey's depth (fix-up, 2026-09-30): services/engine/shallowRuns.
    const {
        shallowRuns,
        chartedShallowMask,
        chartedShallowSpans,
        landPaintConflictMask,
        tideDepthM,
        shallowMaxM,
        cautionWhy,
        cautionDepthM,
        cautionNearShallow,
    } = collectShallowRuns({
        layers,
        grid,
        polyline: finalPolyline,
        caution: finalCaution,
        draftM: req.draftM,
        safetyM,
        destinationTailStartSeg,
        originTailEndSeg,
        hazardMask: nearHazard,
        canalMask: finalCanalMask,
    });
    // Survey quality on the route (owner decision 9, 2026-09-30): amber
    // stretches and the 'not checked' cells, from the finished geometry —
    // disclosure only, never a cost or a refusal (engine/shallowRuns).
    const survey = collectSurveyRuns({
        layers,
        polyline: finalPolyline,
        draftM: req.draftM,
        safetyM,
        uncheckedCells: req.surveyUncheckedCells,
        grid,
    });
    if (shallowMaxM > 500)
        engineLog.warn(
            `[keelMargin] longest sub-margin/caution run ${(shallowMaxM / 1852).toFixed(2)} NM — route ships red there (draft+${safetyM} m floor); runs≥200m=${shallowRuns.length} minDepths=[${shallowRuns
                .map((r) =>
                    r.minDepthM === null
                        ? '∅'
                        : `${r.minDepthM.toFixed(1)}@${r.minAtLat?.toFixed(4)},${r.minAtLon?.toFixed(4)}`,
                )
                .join(' ')}]`,
        );

    // ── Bridge-circumvention refusal (Shane 2026-07-02: "if there is a
    // bridge in the way, instead of going cross country like a fucken
    // runner, just say route not possible"). A localized endpoint relax
    // zone softens LNDARE to 500× caution so a route can start at a real
    // berth across a thin barrier — but when the barrier is a LOW-CLEARANCE
    // BRIDGE, the relax corridor lets A* hop the BANK BESIDE the bar and
    // carry on overland. A route that crosses relax-carved land within two
    // cells of a clearance bar is circumventing a bridge the vessel cannot
    // pass: the honest verdict is refusal, not a workaround.
    if (grid.relaxMask && grid.clearanceBarred) {
        const NEAR = 2;
        for (let i = 0; i + 1 < finalPolyline.length; i++) {
            const segM = haversineM(
                finalPolyline[i][1],
                finalPolyline[i][0],
                finalPolyline[i + 1][1],
                finalPolyline[i + 1][0],
            );
            const steps = Math.max(1, Math.ceil(segM / (resolutionM / 2)));
            for (let s = 0; s <= steps; s++) {
                const t = s / steps;
                const qLat = finalPolyline[i][1] + (finalPolyline[i + 1][1] - finalPolyline[i][1]) * t;
                const qLon = finalPolyline[i][0] + (finalPolyline[i + 1][0] - finalPolyline[i][0]) * t;
                const { x, y } = latLonToGrid(grid, qLat, qLon);
                if (x < 0 || y < 0 || x >= grid.width || y >= grid.height) continue;
                if (grid.relaxMask[y * grid.width + x] !== 1) continue;
                for (let dy = -NEAR; dy <= NEAR; dy++) {
                    for (let dx = -NEAR; dx <= NEAR; dx++) {
                        const nx = x + dx;
                        const ny = y + dy;
                        if (nx < 0 || ny < 0 || nx >= grid.width || ny >= grid.height) continue;
                        if (grid.clearanceBarred[ny * grid.width + nx] === 1) {
                            engineLog.warn(
                                `[airDraft] relaxed route circumvents a low-clearance bridge overland at ${qLat.toFixed(4)},${qLon.toFixed(4)} — REFUSING`,
                            );
                            const [barLon, barLat] = gridToLatLon(grid, nx, ny);
                            return {
                                error: clearanceRefusalMessage(
                                    clearanceBarAt(layers.OBSTRN?.features ?? [], barLon, barLat),
                                    'here',
                                ),
                                code: 'air-draft-blocked',
                                debug,
                            };
                        }
                    }
                }
            }
        }
    }

    return {
        polyline: finalPolyline,
        cautionMask: finalCaution,
        canalMask: finalCanalMask,
        channelMask: finalChannelMask,
        tier4Mask: finalChannelMask,
        offshoreMask: finalOffshoreMask,
        shallowRuns,
        chartedShallowMask,
        tideDepthM,
        tideNeedM: req.draftM + safetyM,
        ...(chartedShallowSpans.length > 0 ? { chartedShallowSpans } : {}),
        landPaintConflictMask,
        cautionWhy,
        cautionDepthM,
        cautionNearShallow,
        surveyRuns: survey.surveyRuns,
        ...(survey.uncheckedCells.length > 0 ? { surveyUncheckedCells: survey.uncheckedCells } : {}),
        ...(debug.destinationInlandTrimM ? { destinationInlandTrimM: debug.destinationInlandTrimM } : {}),
        ...(pinOffWater.origin || pinOffWater.destination ? { pinOffWater } : {}),
        ...(() => {
            // A pin in charted-shallow water: its depth, the tide it needs, and
            // whether its tail runs direct (Shane, 2026-10-03) — or why not.
            // The tide is the tail's own: worked from the shallowest water the
            // finest survey charts along it, which may lie off the pin (fix-up
            // review, 2026-10-03).
            const pinTail: { origin?: PinTail; destination?: PinTail } = {};
            for (const which of ['origin', 'destination'] as const) {
                if (!(which === 'origin' ? debug.originChartedPin : debug.destinationChartedPin)) continue;
                const d = which === 'origin' ? pinDepthAt(req.fromLat, req.fromLon) : pinDepthAt(req.toLat, req.toLon);
                if (d === null || d < 0 || d >= deepFloorM) continue;
                const tailPts =
                    which === 'origin'
                        ? originTailEndSeg >= 0
                            ? finalPolyline.slice(0, originTailEndSeg + 2)
                            : []
                        : destinationTailStartSeg >= 0
                          ? finalPolyline.slice(destinationTailStartSeg)
                          : [];
                const least = Math.min(d, leastChartedDepthAlong(tailPts));
                const why = debug.directTailRefused?.[which];
                pinTail[which] = {
                    depthM: d,
                    needsM: Math.round((deepFloorM - least) * 10) / 10,
                    ...(least < d - 0.05 ? { leastM: least } : {}),
                    direct: !why,
                    ...(why ? { why } : {}),
                };
            }
            return pinTail.origin || pinTail.destination ? { pinTail } : {};
        })(),
        distanceNM: distM / 1852,
        gridSize: { width: grid.width, height: grid.height },
        bbox,
        debug: {
            ...debug,
            ...(flFairlead ? { fairlead: flFairlead } : {}),
            ...(llLeadingLines ? { leadingLine: llLeadingLines } : {}),
            ...(laLeadingApproach ? { leadingApproach: laLeadingApproach } : {}),
            ...(strictUncharted ? { unchartedMaxRunM: Math.round(unchartedMaxRunM) } : {}),
        } as RouteDebug,
        phaseTimings: timings,
    };
}

// ── Public surface (barrel) ─────────────────────────────────────────────
// Re-export the full pre-split public API from the engine/* modules so every
// external importer of inshoreRouterEngine keeps resolving with ZERO changes.
// `export type` for interfaces (isolatedModules), `export` for values.
export type {
    InshoreLayers,
    RouteRequest,
    RouteDebug,
    RouteResult,
    RouteFailure,
    NavGrid,
    RelaxZone,
    FairingMidpoint,
    TideCeiling,
    PinOffWater,
    PinTail,
} from './engine/types';
export { UNCHARTED_MAX_RUN_M } from './engine/constants';
export { getCachedNavGrid } from './engine/navGrid';
export {
    MinHeap,
    EXIT_PENALTY_M,
    CENTRE_BIAS,
    CENTRE_HALF_WIDTH_CELLS,
    CENTRE_NORM_CELLS,
    cellCostMultiplier,
    computeCentreFactor,
    aStar,
    chainCostM,
    shallowRingFactor,
} from './engine/aStar';
export { douglasPeucker } from './engine/geometry';
export { fairPath } from './engine/pathShaping';
export { spliceCanalEgressChannel, spliceNtmBarTransit } from './engine/tierPipeline';
