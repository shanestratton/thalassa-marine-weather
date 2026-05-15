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
import { cellsForBBox } from './enc/EncCellMetadata';
import { loadCellGeoJSON } from './enc/EncCellStore';
import { routeInshore, type InshoreLayers } from './inshoreRouterEngine';
import { piCache } from './PiCacheService';
import { createLogger } from '../utils/createLogger';

const log = createLogger('InshoreRouter');

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
    const promise = tryInshoreRouteInner(origin, destination, draftM).finally(() => {
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
        for (const layer of ['LNDARE', 'DEPARE', 'OBSTRN', 'WRECKS', 'UWTROC', 'FAIRWY', 'DRGARE'] as const) {
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
    if (regionalMarkersUrl) {
        try {
            const { midpoints, segments, hazards } = await fetchRegionalMarkers(
                regionalMarkersUrl,
                merged.LNDARE?.features ?? [],
            );
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
            log.warn(
                `STAGE: merged ${midpoints.length} midpoints + ${segments.length} FAIRWY segments + ${hazards.length} IALA-oriented hazards`,
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
    log.warn(
        `STAGE: loaded ${cellsUsed.join(',')} — LNDARE=${merged.LNDARE?.features.length ?? 0} DEPARE=${merged.DEPARE?.features.length ?? 0} OBSTRN=${merged.OBSTRN?.features.length ?? 0} FAIRWY=${merged.FAIRWY?.features.length ?? 0}, calling routeInshore`,
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
    if (piCache.isAvailable()) {
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
                    log.warn(`STAGE: cloud A* returned in ${cloudMs} ms (Pi-cache)`);
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
            log.warn(
                `cloud router request failed (${err instanceof Error ? err.message : String(err)}) — falling back to local`,
            );
        }
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

    // Warn-level temporarily so the success path is visible in
    // production builds during the on-device routing rollout. Drop
    // back to info() once we trust the path.
    log.warn(
        `SUCCESS inshore route ${result.distanceNM.toFixed(2)} NM (${result.polyline.length} pts, ${elapsedMs} ms ${computeWhere}, cells: ${cellsUsed.join(',')})`,
    );
    // DIAGNOSTIC (2026-05-14): dump every polyline vertex as lat,lon so
    // we can see exactly where the route runs without guessing from the
    // rendered map. Drop this once Newport channel-choice is settled.
    log.warn(`STAGE: polyline — ${result.polyline.map((p) => `${p[1].toFixed(4)},${p[0].toFixed(4)}`).join('  →  ')}`);
    // Per-phase timing breakdown from the engine (only for local
    // computes — cloud results don't pass timings through yet).
    const phaseTimings = (result as { phaseTimings?: Record<string, number> }).phaseTimings;
    if (phaseTimings && Object.keys(phaseTimings).length > 0) {
        const breakdown = Object.entries(phaseTimings)
            .map(([k, v]) => `${k}=${v}ms`)
            .join(' ');
        log.warn(`STAGE: engine phase timings — ${breakdown}`);
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
    // `isolated` markers are intentionally used to flag reef-edge
    // beacons that sit far offshore — Scarborough Reef beacon has
    // shoreDistM = 1942 m, with a reef strip extending all the way
    // back to shore. The disc needs to span that strip end-to-end
    // for A* to actually be pushed seaward. Cap at 2500 m is roomy
    // enough for any plausible Australian/coastal reef while still
    // bounded against a runaway shoreDistance reading.
    const ISOLATED_RADIUS_MAX_M = 2500;
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
    if (scarboroughDebug.length > 0) {
        log.warn(`STAGE: Scarborough-area hazards (${scarboroughDebug.length}):`);
        for (const line of scarboroughDebug) {
            log.warn(`  • ${line}`);
        }
    } else {
        log.warn(`STAGE: NO hazards processed in Scarborough bbox (-27.22..-27.17, 153.07..153.12)`);
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
interface RegionalChannelData {
    midpoints: unknown[];
    segments: unknown[];
    hazards: unknown[];
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
    // Tried trailing-window PCA on 2026-05-15 to track curving
    // channels better at Brisbane River. It regressed Newport — user
    // "that broke the newport end". Reverted to global PCA (fit to
    // the entire cluster's markers) which was the state when Newport
    // weave-through-the-markers worked ("bingo"). Brisbane curving-
    // channel coverage stays suboptimal as a known trade-off.
    for (let seed = 0; seed < n; seed++) {
        if (visited[seed]) continue;
        const cluster: number[] = [];
        const queue: number[] = [seed];
        visited[seed] = 1;
        while (queue.length) {
            const i = queue.shift()!;
            cluster.push(i);
            // Re-fit the cluster's principal axis once it has enough
            // markers for PCA to be meaningful. With <3 markers the
            // direction is undefined (single marker) or only one
            // perpendicular pair — we fall back to pure raw-distance.
            const fit = cluster.length >= 3 ? clusterFitLine(cluster, markers) : null;
            const mi = markers[i];
            for (let j = 0; j < n; j++) {
                if (visited[j]) continue;
                const mj = markers[j];
                if (haversineMetres(mi.lat, mi.lon, mj.lat, mj.lon) > CLUSTER_LINK_M) continue;
                if (fit && perpDistFromLineM(mj.lat, mj.lon, fit) > channelHalfWidthM) continue;
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
 * inside ANY ring of the polygon/multipolygon. Doesn't distinguish
 * outer rings from holes — for our use case (was this midpoint on
 * land?) we want any-ring containment.
 */
function pointInLandare(
    lon: number,
    lat: number,
    lndareFeatures: { geometry?: { type?: string; coordinates?: unknown } }[],
): boolean {
    for (const f of lndareFeatures) {
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

async function fetchRegionalMarkers(
    url: string,
    lndareFeatures: { geometry?: { type?: string; coordinates?: unknown } }[],
): Promise<RegionalChannelData> {
    let dataPromise = rawMarkerFetchCache.get(url);
    if (!dataPromise) {
        dataPromise = (async () => {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status} fetching nav_markers`);
            return (await res.json()) as {
                features?: {
                    properties?: { _class?: string };
                    geometry?: { type?: string; coordinates?: [number, number] };
                }[];
            };
        })();
        rawMarkerFetchCache.set(url, dataPromise);
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
        if (droppedByClass.size > 0) {
            const summary = [...droppedByClass.entries()]
                .sort((a, b) => b[1] - a[1])
                .map(([k, v]) => `${k}=${v}`)
                .join(' ');
            log.warn(`STAGE: marker classes NOT used as hazard or lateral: ${summary}`);
        }
        // Same breakdown for the markers we ARE treating as
        // hazards — so we can see whether one class dominates
        // the OBSTRN count and tune from there.
        if (directHazards.length > 0) {
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
        if (scarboroughRawMarkers.length > 0) {
            log.warn(`STAGE: Scarborough-area RAW markers (${scarboroughRawMarkers.length}):`);
            for (const line of scarboroughRawMarkers) {
                log.warn(`  • ${line}`);
            }
        } else {
            log.warn(`STAGE: NO raw markers in Scarborough bbox`);
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
        // (`pointInLandare` on each candidate midpoint) rejects any
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
        // (see `pointInLandare` check below). Pairs across land
        // can't form.
        const PAIR_MAX_DIST_M = 600;
        const pairDiag = {
            considered: 0,
            rejectedByLandare: 0,
            wideConsidered: 0, // pairs > 300 m apart (only possible with PAIR_MAX_DIST > 300)
            wideAccepted: 0,
            wideRejected: 0,
        };
        const midpointCoords: Midpoint[] = [];
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
            const allPts = [...clusterPorts, ...clusterStbds];
            const axis = principalAxis(allPts);
            let meanLat = 0;
            let meanLon = 0;
            for (const p of allPts) {
                meanLat += p.lat;
                meanLon += p.lon;
            }
            meanLat /= allPts.length;
            meanLon /= allPts.length;
            const projection = (p: { lat: number; lon: number }): number =>
                (p.lon - meanLon) * axis.lon + (p.lat - meanLat) * axis.lat;
            clusterPorts.sort((a, b) => projection(a) - projection(b));
            clusterStbds.sort((a, b) => projection(a) - projection(b));

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
                    const projDiff = Math.abs(projection(s) - pProj);
                    if (projDiff > 0.01) continue;
                    const d = haversineMetres(p.lat, p.lon, s.lat, s.lon);
                    if (d >= bestDist || d > PAIR_MAX_DIST_M) continue;
                    pairDiag.considered++;
                    if (d > 300) pairDiag.wideConsidered++;
                    // LNDARE-between-pair check: reject pair if the
                    // midpoint falls inside any land polygon. This is
                    // what lets us bump PAIR_MAX_DIST_M into shipping-
                    // channel territory without false pairs forming
                    // across canal complexes or land features.
                    const midLat = (p.lat + s.lat) / 2;
                    const midLon = (p.lon + s.lon) / 2;
                    if (pointInLandare(midLon, midLat, lndareFeatures)) {
                        pairDiag.rejectedByLandare++;
                        if (d > 300) pairDiag.wideRejected++;
                        continue;
                    }
                    if (d > 300) pairDiag.wideAccepted++;
                    bestDist = d;
                    bestS = s;
                }
                if (!bestS) continue;
                pairedPorts.add(p);
                pairedStbds.add(bestS);
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

        log.warn(
            `STAGE: pair-candidate diagnostics — considered=${pairDiag.considered} ` +
                `rejectedByLandare=${pairDiag.rejectedByLandare} ` +
                `wide(>300m): considered=${pairDiag.wideConsidered} accepted=${pairDiag.wideAccepted} rejected=${pairDiag.wideRejected}`,
        );

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

        // DEBUG — dump midpoint chain order for the Scarborough area
        // so we can see whether the chain is laying out N-S along the
        // channel (good) or zigzagging E-W across multiple channels
        // (bad — would make the FAIRWY ribbon useless).
        const scarbMidpts = midpointCoords
            .filter((m) => m.lat >= -27.2 && m.lat <= -27.17 && m.lon >= 153.08 && m.lon <= 153.11)
            .sort((a, b) => a.chainId - b.chainId || a.chainOrder - b.chainOrder);
        if (scarbMidpts.length > 0) {
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
        for (const arr of byChain.values()) {
            for (let i = 0; i < arr.length - 1; i++) {
                const a = arr[i];
                const b = arr[i + 1];
                const midLat = (a.lat + b.lat) / 2;
                const mPerLonAtMid = 111_320 * Math.cos((midLat * Math.PI) / 180);
                const dxM = (b.lon - a.lon) * mPerLonAtMid;
                const dyM = (b.lat - a.lat) * 111_320;
                const lenM = Math.sqrt(dxM * dxM + dyM * dyM);
                if (lenM < 1 || lenM > SEGMENT_MAX_M) continue;
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
            }
        }

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

        return { midpoints, segments, hazards };
    })();
}
