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

import { cellsForBBox } from './enc/EncCellMetadata';
import { loadCellGeoJSON } from './enc/EncCellStore';
import { routeInshore, type InshoreLayers } from './inshoreRouterEngine';
import { createLogger } from '../utils/createLogger';

const log = createLogger('InshoreRouter');

// ── Types ───────────────────────────────────────────────────────────

export interface InshoreOrigin {
    lat: number;
    lon: number;
}

export interface InshoreRouteResult {
    polyline: [number, number][]; // [lon, lat]
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
            const { midpoints, segments, hazards } = await fetchRegionalMarkers(regionalMarkersUrl);
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
                const obstrn = merged.OBSTRN ?? { type: 'FeatureCollection' as const, features: [] };
                (obstrn.features as unknown[]).push(...hazards);
                merged.OBSTRN = obstrn;
            }
            log.warn(
                `STAGE: merged ${midpoints.length} midpoints + ${segments.length} FAIRWY segments + ${hazards.length} solo-marker hazards`,
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
    const t0 = Date.now();
    let result;
    try {
        result = routeInshore(merged, {
            fromLat: origin.lat,
            fromLon: origin.lon,
            toLat: destination.lat,
            toLon: destination.lon,
            draftM,
            safetyM: 0.2,
            // 60 m hazard buffer instead of the engine's 30 m default.
            // Solo lateral / cardinal / danger markers all push to
            // OBSTRN now; with markers typically spaced 50-100 m
            // along a chain, a 30 m buffer leaves gaps wide enough
            // for A* to thread through. 60 m forces overlapping
            // bubbles → contiguous no-go strips around hazard chains.
            obstructionBufferM: 60,
        });
    } catch (err) {
        log.warn(`local inshore route compute threw: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }
    const elapsedMs = Date.now() - t0;

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
        `SUCCESS inshore route ${result.distanceNM.toFixed(2)} NM (${result.polyline.length} pts, ${elapsedMs} ms local, cells: ${cellsUsed.join(',')})`,
    );
    return {
        polyline: result.polyline,
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
const regionalMarkerCache = new Map<string, Promise<RegionalChannelData>>();

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
 * Flood-fill clustering: any two markers within CLUSTER_LINK_M of each
 * other are in the same cluster. The threshold is tuned so that:
 * - Markers along a single chain (typical spacing 100-300 m) link
 * - Markers in *different* channels stay in separate clusters
 *
 * Output: array of clusters, each cluster is an array of marker
 * indices into the input array.
 */
function clusterMarkers(markers: Marker[], CLUSTER_LINK_M: number): number[][] {
    const n = markers.length;
    const visited = new Uint8Array(n);
    const clusters: number[][] = [];
    for (let seed = 0; seed < n; seed++) {
        if (visited[seed]) continue;
        const cluster: number[] = [];
        const queue: number[] = [seed];
        visited[seed] = 1;
        while (queue.length) {
            const i = queue.shift()!;
            cluster.push(i);
            const mi = markers[i];
            for (let j = 0; j < n; j++) {
                if (visited[j]) continue;
                const mj = markers[j];
                if (haversineMetres(mi.lat, mi.lon, mj.lat, mj.lon) <= CLUSTER_LINK_M) {
                    visited[j] = 1;
                    queue.push(j);
                }
            }
        }
        clusters.push(cluster);
    }
    return clusters;
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

async function fetchRegionalMarkers(url: string): Promise<RegionalChannelData> {
    let cached = regionalMarkerCache.get(url);
    if (!cached) {
        cached = (async () => {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status} fetching nav_markers`);
            const data = (await res.json()) as {
                features?: {
                    properties?: { _class?: string };
                    geometry?: { type?: string; coordinates?: [number, number] };
                }[];
            };

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
                'notice',
                'pile',
                'lateral', // unsubclassed lateral — treat as hazard, not channel side
            ]);
            for (const f of data.features ?? []) {
                if (f?.geometry?.type !== 'Point' || !f.geometry.coordinates) continue;
                const [lon, lat] = f.geometry.coordinates;
                const cls = (f.properties?._class as string | undefined) ?? '';
                if (cls === 'port') markers.push({ lat, lon, kind: 'port' });
                else if (cls === 'starboard') markers.push({ lat, lon, kind: 'starboard' });
                else if (DIRECT_HAZARD_CLASSES.has(cls)) directHazards.push({ lat, lon, cls });
            }

            // ── Step 2: Cluster markers into channel chains ────────
            // CLUSTER_LINK_M = 150 m: tight enough that the flood-fill
            // can't bridge across a peninsula tip (~1 km wide) by
            // hopping through markers on the shoreline. 250 m turned
            // out to grow chains all the way around the Scarborough
            // peninsula, producing synthetic FAIRWY segments that ran
            // STRAIGHT OVER the land. 150 m breaks at the gap.
            //
            // Tradeoff: some legitimate channels with widely-spaced
            // markers (>150 m gap between successive markers) get
            // split into multiple sub-chains. Acceptable — A* can
            // bridge the gap via DEPARE deep-water cells. Better
            // false-split than false-join across land.
            const CLUSTER_LINK_M = 150;
            const clusters = clusterMarkers(markers, CLUSTER_LINK_M);

            // ── Step 3: Per-cluster, pair port↔starboard in chain order ─
            // Markers that don't end up in a mixed-colour cluster are
            // collected as `soloMarkers` and emitted as OBSTRN
            // features (Step 6 below). In IALA-A buoyage a lone
            // port/starboard marker almost always indicates a hazard
            // (reef edge, isolated shoal, dangerous rock) rather than
            // a channel side. The engine's Pass 3 then blocks cells
            // within ~30 m, forcing the route to detour around.
            const PAIR_MAX_DIST_M = 300; // max within-pair gap
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

                // Pair each port with the chain-nearest starboard:
                // walk both lists, advancing whichever projection is
                // behind. For each port, pick its nearest starboard
                // in projection space, requiring true distance ≤ PAIR_MAX_DIST_M.
                let chainOrder = 0;
                for (const p of clusterPorts) {
                    const pProj = projection(p);
                    let bestDist = Infinity;
                    let bestS: { lat: number; lon: number } | null = null;
                    for (const s of clusterStbds) {
                        const projDiff = Math.abs(projection(s) - pProj);
                        // Limit to starboards whose chain-order is near
                        // this port's, then check true distance.
                        if (projDiff > 0.01) continue; // ~1 km in projected lat/lon — coarse pre-filter
                        const d = haversineMetres(p.lat, p.lon, s.lat, s.lon);
                        if (d < bestDist && d <= PAIR_MAX_DIST_M) {
                            bestDist = d;
                            bestS = s;
                        }
                    }
                    if (!bestS) continue;
                    midpointCoords.push({
                        lat: (p.lat + bestS.lat) / 2,
                        lon: (p.lon + bestS.lon) / 2,
                        pairDistM: bestDist,
                        chainId,
                        chainOrder: chainOrder++,
                    });
                }
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

            // ── Step 5: Build ribbon polygons IN CHAIN ORDER ────────
            // Connect midpoint i with midpoint i+1 within the SAME
            // chain. Each segment is a thin rectangle (~20 m wide)
            // aligned with the connecting line. No cross-channel
            // artefacts because we only connect within a chain.
            const HALF_WIDTH_M = 10;
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

            // SEGMENT_MAX_M = 400: drop segments where consecutive
            // midpoints in a chain are >400 m apart. At public-data
            // marker densities a >400 m intra-chain gap almost always
            // means the chain has bridged across a feature (peninsula,
            // island, dredged-channel break) and the segment would
            // run over land. Better to leave a gap and let A* find a
            // deep-water path than draw a preferred ribbon across
            // dirt. 800 m → 400 m on the cap.
            const SEGMENT_MAX_M = 400;
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
        regionalMarkerCache.set(url, cached);
    }
    return cached;
}
