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
    RouteRequest,
    RouteDebug,
    RouteResult,
    RouteFailure,
    RelaxZone,
    ShallowRunInfo,
} from './engine/types';
import {
    mPerDegLon,
    haversineM,
    pointInGeometry,
    geometryBbox,
    gridToLatLon,
    latLonToGrid,
    bresenhamCells,
    douglasPeucker,
} from './engine/geometry';
import { aStar, chainCostM } from './engine/aStar';
import { buildNavGridCached, snapWithPredicate, snapToNavigable, labelConnectedComponents } from './engine/navGrid';
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

// ── Public API ──────────────────────────────────────────────────────

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

function routeInshoreMain(
    layers: InshoreLayers,
    req: RouteRequest,
    gridOverride?: GridOverride,
): RouteResult | RouteFailure {
    // Try strict first — LNDARE blocks land. With proper ring assembly
    // (Eulerian/linear-chain fix landed 2026-05-19) this gives accurate
    // results for most routes. But certain charts represent rivers as
    // "inside" a giant mainland LNDARE polygon with no inner-ring hole
    // (verified on AU OC-61-351824 rcid 4500: Brisbane mainland is one
    // 3503-vert polygon, no holes — the river course is inside it). For
    // destinations inside such polygons, retry with LNDARE relaxed to
    // CAUTION (cost 500× water). A* prefers actual water cells massively
    // over caution, so it won't cross real land masses — only the
    // chart-says-land-but-really-water river/harbour interior cells get
    // traversed, flagged red in the polyline so the user verifies.
    const strict = routeInshoreOnce(layers, req, false, [], gridOverride);
    if ('error' in strict) {
        if (strict.code !== 'destination-disconnected') return strict;
        // Last resort: strict found NO path because the destination is
        // inside a giant mainland LNDARE with no inner-ring hole. Relax
        // GRID-WIDE — A* still prefers real water (8×) over relaxed land
        // (40×), so it only crosses land where no water route exists at
        // all. This is the only place we relax globally; the far-snap
        // path below uses bounded zones instead.
        console.warn(
            '[inshoreEngine] strict pass failed destination-disconnected — retrying with LNDARE relaxed grid-wide to CAUTION (last resort)',
        );
        return routeInshoreOnce(layers, req, true, [], gridOverride);
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
    const FAR_SNAP_M = 500;
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
    if ('error' in relaxed) return strict;
    if (dropsProtectedCanalGateContract(strict, relaxed)) {
        console.warn(
            '[inshoreEngine] localized-relaxed route dropped the canal/gate tier contract — keeping strict tiered route',
        );
        return strict;
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

export function routeInshore(layers: InshoreLayers, req: RouteRequest): RouteResult | RouteFailure {
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
        const coarse = routeInshoreMain(layers, req, {
            resolutionM: COARSE_PRECHECK_RES_M,
            padDeg: Math.max(spanDeg * 0.5, 0.08),
        });
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

function routeInshoreOnce(
    layers: InshoreLayers,
    req: RouteRequest,
    relaxedLndare: boolean,
    relaxZones: RelaxZone[] = [],
    gridOverride?: GridOverride,
): RouteResult | RouteFailure {
    const safetyM = req.safetyM ?? 1.0;
    const resolutionM = gridOverride?.resolutionM ?? req.resolutionM ?? 50;
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

    let tPhase = Date.now();
    const { grid, cacheHit: gridCacheHit } = buildNavGridCached(
        layers,
        bbox,
        resolutionM,
        req.draftM,
        safetyM,
        obstructionBufferM,
        relaxedLndare,
        relaxZones,
        req.routeProfile ?? 'safest',
    );
    tPhase = mark(gridCacheHit ? 'buildNavGridCacheHit' : 'buildNavGrid', tPhase);
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
    const pointInsideLndare = (lat: number, lon: number): boolean => {
        for (const f of layers.LNDARE?.features ?? []) {
            const geom = f.geometry;
            if (!geom || (geom.type !== 'Polygon' && geom.type !== 'MultiPolygon')) continue;
            if (pointInGeometry(lon, lat, geom)) return true;
        }
        return false;
    };
    const destinationTapIdx = endpointCellIdx(req.toLat, req.toLon);
    const destinationTapOnHardLand =
        destinationTapIdx < 0 ||
        pointInsideLndare(req.toLat, req.toLon) ||
        (grid.landBlocked ? grid.landBlocked[destinationTapIdx] === 1 : Number.isNaN(grid.cells[destinationTapIdx]));

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
                grid.cells[idx] = carveDepth;
                grid.preferred[idx] = 1; // attract A* to enter via the bubble
            }
        }
    };
    carveEndpoint(req.fromLat, req.fromLon, 60);

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
    };

    // ── Label connected components ──
    // One pass to bucket every navigable cell into its 8-connected
    // water body. Drives the shared-component snap below.
    let { labels, sizes } = labelConnectedComponents(grid);
    tPhase = mark('labelComponents', tPhase);

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
                            break;
                        }
                    }
                }
                if (crossesClearanceBar) {
                    engineLog.warn(
                        `[airDraft] component carve REFUSED — the ${Math.round(bestGap * resolutionM)}m gap is a low-clearance structure this vessel cannot pass`,
                    );
                    // No carve: the pocket stays its own component and the
                    // shared-component snap resolves the route honestly.
                } else {
                    for (const c of carvePath) {
                        if (c.x < 0 || c.y < 0 || c.x >= grid.width || c.y >= grid.height) continue;
                        const idx = c.y * grid.width + c.x;
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

    for (const [label, size] of sizes) {
        if (size < minComponentCells) continue;
        const startCandidate = snapWithPredicate(
            grid,
            req.fromLat,
            req.fromLon,
            maxSnapCells,
            (idx) => labels[idx] === label,
        );
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
            deepEnd ?? snapWithPredicate(grid, req.toLat, req.toLon, maxSnapCells, (idx) => labels[idx] === label);
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
    debug.cellsReachableFromOrigin = bestComponentSize;
    {
        const [snapLon, snapLat] = gridToLatLon(grid, startCell.x, startCell.y);
        debug.originSnap = {
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
        if (destinationTapOnHardLand || debug.destinationSnap.snapDistanceM > 1) debug.destinationWaterSnap = true;
    }

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
    const cells = aStar(grid, startCell, endCell);
    tPhase = mark('aStar', tPhase);
    if (!cells) {
        return { error: 'A* failed despite reachability flood-fill — should be impossible', code: 'no-path', debug };
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
    let marinaCells = cleanPrefixEnd >= 1 ? tryMarinaCenterline(grid, startCell, cells[cleanPrefixEnd]) : null;
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
    const isUnvouchedIdx = (idx: number): boolean =>
        strictUncharted &&
        grid.unvouched !== undefined &&
        grid.unvouched[idx] === 1 &&
        grid.cells[idx] === UNKNOWN_OPEN &&
        grid.preferred[idx] === 0;

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
        tPhase = mark('fairing', tPhase);
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
    if (polylineRaw.length > 0) {
        polylineRaw[0] = [req.fromLon, req.fromLat];
        polylineRaw[polylineRaw.length - 1] = debug.destinationSnap
            ? [debug.destinationSnap.snappedLon, debug.destinationSnap.snappedLat]
            : [req.toLon, req.toLat];
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
    if (destinationTapOnHardLand) {
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
                debug.destinationInlandTrimM = Math.round(trimmedM);
                engineLog.warn(
                    `[inlandTrim] destination is on charted land — trimmed ${Math.round(trimmedM)} m overland tail (${dropped} vtx); route now ends at the water's edge`,
                );
            } else {
                engineLog.warn(
                    `[inlandTrim] SKIPPED — overland tail is ${Math.round(trimmedM)} m (>5 km); leaving geometry for diagnosis`,
                );
            }
        }
    }

    // Compute total length in NM along the final polyline.
    let distM = 0;
    for (let i = 1; i < finalPolyline.length; i++) {
        distM += haversineM(finalPolyline[i - 1][1], finalPolyline[i - 1][0], finalPolyline[i][1], finalPolyline[i][0]);
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
    const shallowRuns: ShallowRunInfo[] = [];
    {
        const sd = grid.shallowDepthM;
        const MIN_RUN_M = 200; // below this a chip is noise, not pilotage info
        const cautionFloorM = req.draftM + safetyM;
        // EXACT chart-depth sampler. The 50 m grid cell records the MIN DRVAL1 of
        // every band rasterized into it, so a cell merely GRAZED by a drying bank's
        // corner reads 0 m even where the route line itself stays inside the 2 m
        // band — and the chip then demands the full keel+margin rise (Shane's
        // Newport "+2.9 m" on water the chart carries at 2 m). Point-in-polygon
        // against the REAL chart S-57 DEPARE features has no such bleed (bands
        // don't overlap; synthetic injected water is excluded by the acronym
        // gate). Only depths BELOW the caution floor count toward the min — a
        // deep-band sample can never launder an uncharted run into "deep & safe",
        // so uncharted-only runs still ship minDepthM null. Grid cell = fallback.
        const chartDepare = (finalCaution.some(Boolean) ? (layers.DEPARE?.features ?? []) : [])
            .filter((f) => {
                const p = f.properties as Record<string, unknown> | null;
                const g = f.geometry;
                return (
                    typeof p?.acronym === 'string' &&
                    typeof p?.DRVAL1 === 'number' &&
                    !!g &&
                    (g.type === 'Polygon' || g.type === 'MultiPolygon')
                );
            })
            .map((f) => {
                const geom = f.geometry as GeoJSON.Polygon | GeoJSON.MultiPolygon;
                return {
                    geom,
                    bbox: geometryBbox(geom),
                    drval1: (f.properties as Record<string, unknown>).DRVAL1 as number,
                };
            });
        const chartShallowDepthAt = (lon: number, lat: number): number | null => {
            let best: number | null = null;
            for (const d of chartDepare) {
                if (d.drval1 >= cautionFloorM) continue; // deep band — not what reddened this run
                if (best !== null && d.drval1 >= best) continue; // can't improve the min
                if (lon < d.bbox[0] || lon > d.bbox[2] || lat < d.bbox[1] || lat > d.bbox[3]) continue;
                if (pointInGeometry(lon, lat, d.geom)) best = d.drval1;
            }
            return best;
        };
        let shallowMaxM = 0;
        let runStart = -1;
        let runM = 0;
        let runMin = Infinity;
        let runMinAt: [number, number] | null = null;
        const flush = (endSeg: number): void => {
            if (runStart < 0) return;
            if (runM > shallowMaxM) shallowMaxM = runM;
            if (runM >= MIN_RUN_M) {
                // Midpoint by along-track length — where the window chip anchors.
                let acc = 0;
                let mid = finalPolyline[runStart];
                for (let k = runStart; k <= endSeg; k++) {
                    const [lonA, latA] = finalPolyline[k];
                    const [lonB, latB] = finalPolyline[k + 1];
                    const segM = haversineM(latA, lonA, latB, lonB);
                    if (acc + segM >= runM / 2) {
                        const t = segM > 0 ? (runM / 2 - acc) / segM : 0;
                        mid = [lonA + (lonB - lonA) * t, latA + (latB - latA) * t];
                        break;
                    }
                    acc += segM;
                }
                shallowRuns.push({
                    startSeg: runStart,
                    endSeg,
                    lengthM: Math.round(runM),
                    minDepthM: Number.isFinite(runMin) ? runMin : null,
                    midLat: mid[1],
                    midLon: mid[0],
                    ...(runMinAt ? { minAtLat: runMinAt[1], minAtLon: runMinAt[0] } : {}),
                });
            }
            runStart = -1;
            runM = 0;
            runMin = Infinity;
            runMinAt = null;
        };
        for (let i = 0; i < finalCaution.length; i++) {
            if (!finalCaution[i]) {
                flush(i - 1);
                continue;
            }
            if (runStart < 0) runStart = i;
            const [lonA, latA] = finalPolyline[i];
            const [lonB, latB] = finalPolyline[i + 1];
            const segM = haversineM(latA, lonA, latB, lonB);
            runM += segM;
            const steps = Math.max(1, Math.ceil(segM / 25));
            for (let s = 0; s <= steps; s++) {
                const t = s / steps;
                const qLat = latA + (latB - latA) * t;
                const qLon = lonA + (lonB - lonA) * t;
                // Exact chart band when chart DEPARE exists; the bleed-prone grid
                // cell ONLY when it doesn't (fixtures / injected-water-only areas).
                // Falling back per-point would re-import the very graze the exact
                // sampler exists to reject: a run the chart says never crosses a
                // shallow band has NO sub-floor depth on the line — requiredRise
                // goes ≤0 and no chip appears, which is the honest outcome.
                let d: number | null = null;
                if (chartDepare.length > 0) {
                    d = chartShallowDepthAt(qLon, qLat);
                } else if (sd) {
                    const { x, y } = latLonToGrid(grid, qLat, qLon);
                    if (x >= 0 && y >= 0 && x < grid.width && y < grid.height) {
                        const g = sd[y * grid.width + x];
                        if (!Number.isNaN(g)) d = g;
                    }
                }
                if (d !== null && d < runMin) {
                    runMin = d;
                    runMinAt = [qLon, qLat];
                }
            }
        }
        flush(finalCaution.length - 1);
        if (shallowMaxM > 500)
            engineLog.warn(
                `[keelMargin] longest sub-margin/caution run ${(shallowMaxM / 1852).toFixed(2)} NM — route ships red there (draft+${safetyM} m floor); runs≥${MIN_RUN_M}m=${shallowRuns.length} minDepths=[${shallowRuns
                    .map((r) =>
                        r.minDepthM === null
                            ? '∅'
                            : `${r.minDepthM.toFixed(1)}@${r.minAtLat?.toFixed(4)},${r.minAtLon?.toFixed(4)}`,
                    )
                    .join(' ')}]`,
            );
    }

    return {
        polyline: finalPolyline,
        cautionMask: finalCaution,
        canalMask: finalCanalMask,
        channelMask: finalChannelMask,
        tier4Mask: finalChannelMask,
        offshoreMask: finalOffshoreMask,
        shallowRuns,
        ...(debug.destinationInlandTrimM ? { destinationInlandTrimM: debug.destinationInlandTrimM } : {}),
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
} from './engine/aStar';
export { douglasPeucker } from './engine/geometry';
export { fairPath } from './engine/pathShaping';
export { spliceCanalEgressChannel } from './engine/tierPipeline';
