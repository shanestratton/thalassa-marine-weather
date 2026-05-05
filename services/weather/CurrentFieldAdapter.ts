/**
 * CurrentFieldAdapter — Bridges sparse OSCAR current vectors to the
 * IsochroneRouter's CurrentField interface.
 *
 * OSCAR currents come as a sparse cloud of (lat, lon, u, v) vectors at
 * 1/3° resolution. The IsochroneRouter needs `getCurrent(lat, lon, t)`
 * for any (lat, lon) along the route. This adapter provides
 * inverse-distance-weighted (IDW) interpolation between the N nearest
 * vectors within a radius.
 *
 * Currents change slowly over space (large-scale features like the Gulf
 * Stream span 100+ NM laterally), so IDW with a 2° search radius is
 * accurate enough — and far cheaper than Kriging or a full bilinear
 * grid build for a single route compute.
 *
 * Time dimension: OSCAR climatology is steady-state monthly; OSCAR NRT
 * is a single snapshot 5 days behind. Either way the time offset is
 * ignored — we don't have hourly current data to interpolate over.
 * That's a limitation but matches what PredictWind does with monthly
 * climatology for most routes.
 */

import type { CurrentField } from '../isochrone/types';
import type { CurrentVector } from '../OceanCurrentService';

/**
 * IDW search radius in degrees. 2° at the equator ~ 120 NM — well
 * within the spatial autocorrelation length of major current systems.
 */
const SEARCH_RADIUS_DEG = 2.0;

/** Minimum number of neighbours for a confident interpolation. */
const MIN_NEIGHBOURS = 1;

/**
 * Build a CurrentField from sparse OSCAR vectors.
 *
 * Returns null when the vector cloud is empty (e.g. fetch failed) so
 * the caller can pass `null` to the isochrone engine and route without
 * current advection — the engine treats a null field as "no current
 * data, just use STW".
 */
export function createCurrentFieldFromVectors(vectors: CurrentVector[]): CurrentField | null {
    if (!vectors || vectors.length === 0) return null;

    return {
        getCurrent(lat: number, lon: number, _timeOffsetHours: number) {
            // Find vectors within search radius
            let weightSum = 0;
            let uSum = 0;
            let vSum = 0;
            let neighbours = 0;

            for (const vec of vectors) {
                const dLat = vec.lat - lat;
                const dLon = vec.lon - lon;
                if (Math.abs(dLat) > SEARCH_RADIUS_DEG || Math.abs(dLon) > SEARCH_RADIUS_DEG) continue;

                // True spherical distance not necessary here — the IDW
                // weighting cares about relative distances, not absolute
                // metric ones, and the search radius is small enough that
                // degree-space and arc-space agree to ~1%.
                const distSq = dLat * dLat + dLon * dLon;
                if (distSq > SEARCH_RADIUS_DEG * SEARCH_RADIUS_DEG) continue;

                // IDW weight: 1/d² with a small floor so coincident
                // vectors don't blow up. 0.001 ≈ 0.06 NM apart, well
                // below OSCAR's 1/3° resolution.
                const w = 1 / Math.max(0.001, distSq);
                uSum += vec.u * w;
                vSum += vec.v * w;
                weightSum += w;
                neighbours++;
            }

            if (neighbours < MIN_NEIGHBOURS || weightSum === 0) return null;

            const u = uSum / weightSum;
            const v = vSum / weightSum;

            // Convert m/s components → speed (kts) and direction (TO).
            // OSCAR u/v are already TO components (east, north).
            const speedMs = Math.sqrt(u * u + v * v);
            const speedKts = speedMs * 1.94384;

            // Direction current flows TO (oceanographic convention).
            // atan2(east, north) gives compass bearing.
            const dirRad = Math.atan2(u, v);
            const dirDeg = ((dirRad * 180) / Math.PI + 360) % 360;

            return {
                speed: Math.round(speedKts * 100) / 100,
                direction: Math.round(dirDeg),
            };
        },
    };
}
