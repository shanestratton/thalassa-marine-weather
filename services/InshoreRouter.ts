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

import { CapacitorHttp } from '@capacitor/core';
import { DeadlineExceeded, withDeadline } from '../utils/deadline';
import { cellsForBBox, listCells } from './enc/EncCellMetadata';
import type { EncCell } from './enc/types';
import { loadCellGeoJSON } from './enc/EncCellStore';
import { routeInshore, type InshoreLayers } from './inshoreRouterEngine';
import { shadowCompare, shadowSummary } from './seaway/seawayRouter';
import { piCache } from './PiCacheService';
import { getOsmRouteOverlay, type OsmRouteOverlay } from './OsmRouteOverlayService';
import { pairWingFeatures } from './pairWings';
import { createLogger } from '../utils/createLogger';

const log = createLogger('InshoreRouter');

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
    distanceNM: number;
    cellsUsed: string[];
    elapsedMs: number;
}

export interface InshoreRouteFailure {
    error: string;
    code?: string;
    cellsUsed?: string[];
}

// ── Coverage check ──────────────────────────────────────────────────

/** Max straight-line distance for inshore routing (nautical miles). */
const MAX_INSHORE_NM = 50;

/** Margin around an endpoint when checking ENC coverage (degrees ≈ 5km). */
const COVERAGE_MARGIN_DEG = 0.05;

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
    const dedupeKey = `${origin.lat.toFixed(4)}_${origin.lon.toFixed(4)}_${destination.lat.toFixed(4)}_${destination.lon.toFixed(4)}_${draftM}`;
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
    const promise = withDeadline(
        tryInshoreRouteInner(origin, destination, draftM),
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
            error: `Inshore charts don't cover the full passage yet — coverage gap ~${corridorGap.atNM.toFixed(0)} NM along the route (near ${corridorGap.lat.toFixed(2)}, ${corridorGap.lon.toFixed(2)}). Sync the missing cells via Pi Cache.`,
            code: 'coverage-gap',
        };
    }

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
    };
    const cellsUsed: string[] = [];
    for (const cell of candidateCells) {
        const blob = await loadCellGeoJSON(cell.id);
        if (!blob) {
            log.warn(`cell ${cell.id} listed but GeoJSON not on device — sync via Pi Cache first`);
            continue;
        }
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
        ] as const) {
            const fc = blob.layers?.[layer];
            const target = merged[layer];
            if (fc?.features && Array.isArray(fc.features) && target) {
                (target.features as unknown[]).push(...fc.features);
            }
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
    const routeBbox: [number, number, number, number] = [
        Math.min(origin.lon, destination.lon) - 0.1,
        Math.min(origin.lat, destination.lat) - 0.1,
        Math.max(origin.lon, destination.lon) + 0.1,
        Math.max(origin.lat, destination.lat) + 0.1,
    ];
    let osmOverlay: OsmRouteOverlay | null = null;
    try {
        osmOverlay = await getOsmRouteOverlay(routeBbox);
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
            for (const f of osmOverlay.navLines.features) {
                (navline.features as unknown[]).push(f);
            }
            merged.NAVLINE = navline;
            if (ROUTE_DEBUG)
                log.warn(
                    `STAGE: injected ${osmOverlay.navLines.features.length} OSM navigation lines → NAVLINE (preferred channel)`,
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
    if (regionalMarkersUrl) {
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
            if (hazards.length > 0) {
                // IALA-A orientation: for each solo hazard marker, the
                // hazard sits between the marker and the nearest shore
                // (reef edge, isolated rock, shoal). Boats pass on the
                // SEAWARD side. We turn each Point hazard into a
                // half-circle Polygon facing land — engine blocks the
                // shore-side cells, leaving the seaward side open.
                // Symmetric full-circle buffering can't do this; it
                // blocks both sides equally and A* picks the shorter
                // side, which is often the wrong (shore) side.
                const lndareForOrientation = merged.LNDARE?.features ?? [];
                const orientedHazards = orientHazardsTowardLand(
                    hazards as { geometry: { type: 'Point'; coordinates: [number, number] }; properties?: unknown }[],
                    lndareForOrientation,
                );
                const obstrn = merged.OBSTRN ?? { type: 'FeatureCollection' as const, features: [] };
                (obstrn.features as unknown[]).push(...orientedHazards);
                merged.OBSTRN = obstrn;
            }
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

    // safetyM=0.2 instead of the engine's 1.0 m default. Our public-data
    // DEPARE bands are 1 m wide (DRVAL1 ∈ {0,1,2,3,5,8,…}), so a 1 m
    // safety re-blocks the 2 m-depth band (depth 2-3 m) even though a
    // 1.8 m-draft boat clears it comfortably. 0.2 m keeps the 2 m band
    // open and acknowledges the discretisation noise without demanding
    // a full extra metre of clearance the chart can't express. Tide
    // planning is the skipper's job — chart datum is already lowest
    // astronomical tide.
    if (ROUTE_DEBUG)
        log.warn(
            `STAGE: loaded ${cellsUsed.join(',')} — LNDARE=${merged.LNDARE?.features.length ?? 0} DEPARE=${merged.DEPARE?.features.length ?? 0} OBSTRN=${merged.OBSTRN?.features.length ?? 0} FAIRWY=${merged.FAIRWY?.features.length ?? 0} COASTLINE=${merged.COASTLINE?.features.length ?? 0}, calling routeInshore`,
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
        safetyM: 0.2,
        obstructionBufferM: 60,
        // LIVE routes never treat no-evidence space as clean water: cells
        // nothing vouches for flag red, and >1 NM unvouched runs refuse
        // with 'uncharted-corridor' (reply 16 structural fix; the engine
        // default stays permissive for fixtures/harbour-corridor callers).
        unchartedPolicy: 'strict',
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
            const res = await CapacitorHttp.post({
                url: `${piCache.baseUrl}/api/enc/route-prepped`,
                headers: { 'Content-Type': 'application/json' },
                data: { ...routeOpts, layers: merged },
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
            });
            const cloudMs = Date.now() - cloudT0;
            if (res.status >= 200 && res.status < 300 && res.data && typeof res.data === 'object') {
                const data = res.data as Record<string, unknown>;
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
            } else if (res.status === 422 && res.data && typeof res.data === 'object') {
                // Pi-cache rejected the route (e.g. origin-on-land). Use
                // the same shape as local so the caller surfaces it.
                result = res.data as ReturnType<typeof routeInshore>;
                routedOnCloud = true;
                log.warn(`cloud router rejected route (HTTP 422) — surfacing as failure`);
            } else {
                log.warn(`cloud router HTTP ${res.status} — falling back to local`);
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
            } else if (ROUTE_DEBUG) {
                log.warn('SEAWAY SHADOW: corridor has no lateral marks — nothing to shadow');
            }
        } catch (err) {
            // Shadow failures must never touch the live route.
            log.warn(`SEAWAY SHADOW: failed (route unaffected): ${err instanceof Error ? err.message : String(err)}`);
        }
    }

    return {
        polyline: result.polyline,
        cautionMask: (result as { cautionMask?: boolean[] }).cautionMask,
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
function orientHazardsTowardLand(
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
    const HAZARD_RADIUS_MIN_M = 80;
    const DIRECT_HAZARD_RADIUS_MAX_M = 300; // cardinals/dangers — compact
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
        if (shoreDistM > MAX_SHORE_DISTANCE_M) {
            // Offshore — keep as Point, engine buffers symmetrically.
            result.push(h);
            continue;
        }

        // Bearing from marker → nearest land (in metres-projected space).
        const midLat = (mLat + bestLat) / 2;
        const mPerLonAtMid = 111_320 * Math.cos((midLat * Math.PI) / 180);
        const landDxM = (bestLon - mLon) * mPerLonAtMid;
        const landDyM = (bestLat - mLat) * 111_320;
        const landLen = Math.sqrt(landDxM * landDxM + landDyM * landDyM);
        if (landLen < 1) {
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
        const hazardProps =
            (h.properties as { _class?: string; _osmClass?: string; _markerKind?: string } | null | undefined) ?? {};
        const hazardClass = hazardProps._class;
        const osmClass = hazardProps._osmClass;
        const isReefEdgeSoloLateral = hazardClass === 'lateral-marker-as-hazard' && shoreDistM <= LATERAL_REEF_GATE_M;
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
        const radiusM = Math.min(maxRadiusForClass, Math.max(HAZARD_RADIUS_MIN_M, shoreDistM + 30));

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
            const angle = landAngle - Math.PI / 2 + t * Math.PI;
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
                _source: 'land-bearing-inferred',
                _shoreDistanceM: Math.round(shoreDistM),
                _radiusM: Math.round(radiusM),
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
 * IALA-A buoyage (used in AU, EU, most of the world): red markers on
 * port (left), green on starboard (right) when entering harbour. The
 * channel itself is the corridor BETWEEN paired red+green markers —
 * never around either marker individually.
 */
type Marker = { lat: number; lon: number; kind: 'port' | 'starboard' };
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
    url: string,
    lndareFeatures: { geometry?: { type?: string; coordinates?: unknown } }[],
    osmWaterFeatures: { geometry?: { type?: string; coordinates?: unknown } }[] = [],
    chartedWaterFeatures: { geometry?: { type?: string; coordinates?: unknown } }[] = [],
): Promise<RegionalChannelData> {
    let dataPromise = rawMarkerFetchCache.get(url);
    if (!dataPromise) {
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
            if (rawMarkerFetchCache.get(url) === dataPromise) rawMarkerFetchCache.delete(url);
        });
    }
    const data = await dataPromise;
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
            // 'notice' deliberately omitted: IALA-A "special marks"
            // (yellow X-topmark) are informational — they mark
            // no-anchoring zones, fishing areas, water-ski zones,
            // cable crossings, etc. They are NOT navigational
            // hazards.
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
            else if (DIRECT_HAZARD_CLASSES.has(cls)) directHazards.push({ lat, lon, cls });
            else droppedByClass.set(cls || '<empty>', (droppedByClass.get(cls || '<empty>') ?? 0) + 1);
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
                // Isolated single marker — definitely a hazard.
                for (const idx of cluster) soloMarkers.push(markers[idx]);
                continue;
            }

            const clusterPorts: { lat: number; lon: number }[] = [];
            const clusterStbds: { lat: number; lon: number }[] = [];
            for (const idx of cluster) {
                const m = markers[idx];
                if (m.kind === 'port') clusterPorts.push({ lat: m.lat, lon: m.lon });
                else clusterStbds.push({ lat: m.lat, lon: m.lon });
            }
            if (clusterPorts.length === 0 || clusterStbds.length === 0) {
                // Single-colour cluster — hazard indicators, not
                // a channel edge. Common at reefs (e.g. Scarborough
                // Reef green marker).
                for (const idx of cluster) soloMarkers.push(markers[idx]);
                continue;
            }

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
            const allPts = [...clusterPorts, ...clusterStbds];
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
