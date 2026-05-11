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
        log.info(`route is ${distNM.toFixed(1)} NM — exceeds inshore-router cap of ${MAX_INSHORE_NM} NM, deferring`);
        return null;
    }

    if (!hasEncCoverageForRoute(origin, destination)) {
        log.info('No ENC coverage at one or both endpoints — skipping inshore router');
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
        log.info('No installed cells intersect the route bbox — skipping inshore router');
        return null;
    }

    log.info(
        `computing inshore route ${origin.lat.toFixed(4)},${origin.lon.toFixed(4)} → ${destination.lat.toFixed(4)},${destination.lon.toFixed(4)} (draft ${draftM} m) across ${candidateCells.length} cell(s)`,
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
    };
    const cellsUsed: string[] = [];
    for (const cell of candidateCells) {
        const blob = await loadCellGeoJSON(cell.id);
        if (!blob) {
            log.warn(`cell ${cell.id} listed but GeoJSON not on device — sync via Pi Cache first`);
            continue;
        }
        for (const layer of ['LNDARE', 'DEPARE', 'OBSTRN', 'WRECKS', 'UWTROC'] as const) {
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

    // safetyM=0.2 instead of the engine's 1.0 m default. Our public-data
    // DEPARE bands are 1 m wide (DRVAL1 ∈ {0,1,2,3,5,8,…}), so a 1 m
    // safety re-blocks the 2 m-depth band (depth 2-3 m) even though a
    // 1.8 m-draft boat clears it comfortably. 0.2 m keeps the 2 m band
    // open and acknowledges the discretisation noise without demanding
    // a full extra metre of clearance the chart can't express. Tide
    // planning is the skipper's job — chart datum is already lowest
    // astronomical tide.
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
