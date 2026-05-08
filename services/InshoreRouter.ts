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
import { piCache } from './PiCacheService';
import { cellsForBBox } from './enc/EncCellMetadata';
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
    if (!piCache.isAvailable()) {
        log.info('Pi not available — skipping inshore router');
        return null;
    }

    const distNM = straightLineNM(origin, destination);
    if (distNM > MAX_INSHORE_NM) {
        log.info(`route is ${distNM.toFixed(1)} NM — exceeds inshore-router cap of ${MAX_INSHORE_NM} NM, deferring`);
        return null;
    }

    if (!hasEncCoverageForRoute(origin, destination)) {
        log.info('No ENC coverage at one or both endpoints — skipping inshore router');
        return null;
    }

    const url = `${piCache.baseUrl}/api/enc/route`;
    const body = {
        fromLat: origin.lat,
        fromLon: origin.lon,
        toLat: destination.lat,
        toLon: destination.lon,
        draftM,
    };

    log.info(
        `requesting inshore route ${origin.lat.toFixed(4)},${origin.lon.toFixed(4)} → ${destination.lat.toFixed(4)},${destination.lon.toFixed(4)} (draft ${draftM} m)`,
    );

    let status = 0;
    let data: unknown = null;
    try {
        try {
            const res = await CapacitorHttp.post({
                url,
                headers: { 'Content-Type': 'application/json' },
                data: JSON.stringify(body),
                connectTimeout: 5_000,
                readTimeout: 60_000,
            });
            status = res.status;
            data = res.data;
        } catch {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
                signal: AbortSignal.timeout(60_000),
            });
            status = res.status;
            data = await res.json();
        }
    } catch (err) {
        log.warn(`Pi /api/enc/route failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
    }

    // 200 → success
    if (status === 200 && data && typeof data === 'object') {
        const r = data as Partial<InshoreRouteResult>;
        if (Array.isArray(r.polyline) && typeof r.distanceNM === 'number') {
            log.info(
                `inshore route ${r.distanceNM.toFixed(2)} NM (${r.polyline.length} pts, ${r.elapsedMs ?? '?'} ms, cells: ${r.cellsUsed?.join(',')})`,
            );
            return {
                polyline: r.polyline,
                distanceNM: r.distanceNM,
                cellsUsed: r.cellsUsed ?? [],
                elapsedMs: r.elapsedMs ?? 0,
            };
        }
        log.warn('Pi returned 200 but body shape was unexpected');
        return null;
    }

    // 422 → grid built but no path / endpoint on land
    if (status === 422 && data && typeof data === 'object') {
        const f = data as Partial<InshoreRouteFailure>;
        log.warn(`inshore router failed: ${f.error ?? '(no error)'} (${f.code ?? 'no code'})`);
        return {
            error: f.error ?? 'Inshore routing failed',
            code: f.code,
            cellsUsed: f.cellsUsed,
        };
    }

    // 4xx/5xx → unknown — fall through silently
    log.warn(`Pi returned status ${status}`);
    return null;
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
