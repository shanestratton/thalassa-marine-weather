/**
 * cycloneAvoidance.ts — Builds an ExclusionField from active tropical
 * cyclones for use by the isochrone routing engine.
 *
 * Active cyclones are loaded from CycloneTrackingService (ATCF + NOAA
 * NHC + IBTrACS, with synthetic forecasts for non-Atlantic basins).
 * Each cyclone carries a `currentPosition` and a `forecastTrack` of
 * NHC-issued positions out to 5 days. We interpolate that track at
 * query time to get the storm's expected position, then test whether
 * the candidate point lies within a safety radius of that position.
 *
 * Safety radii by intensity:
 *
 *   Stage    | Wind (kts) | Radius (NM)
 *   ---------+------------+-------------
 *   TD       | < 34       |  50
 *   TS       | 34-63      |  75
 *   Cat 1    | 64-82      | 100
 *   Cat 2    | 83-95      | 125
 *   Cat 3    | 96-113     | 150
 *   Cat 4    | 114-135    | 200
 *   Cat 5    | ≥ 137      | 250
 *
 * These match the avoidance radii commercial weather routers use for
 * trans-ocean passages. Coastal-only cruisers should use higher radii;
 * blue-water racers might accept tighter ones.
 *
 * Forward-only avoidance: a cyclone moving away from the route at
 * 25 kts and 36 hours behind is no threat. We only consider track
 * positions within ±24 hours of the candidate's arrival time at that
 * point. Beyond that the storm has likely dissipated (ATCF cuts off
 * forecasts after 120 h).
 */

import { createLogger } from '../utils/createLogger';
import type { ExclusionField } from './isochrone/types';
import { fetchActiveCyclones, type ActiveCyclone, type CyclonePosition } from './weather/CycloneTrackingService';

const log = createLogger('CycloneAvoid');

/** Earth radius in NM (matches IsochroneRouter's R_NM). */
const R_NM = 3440.065;

/** Maximum time delta between query time and cyclone forecast position to consider. */
const MAX_TIME_DELTA_MS = 24 * 3600 * 1000;

/**
 * Safety radius (NM) for a cyclone of given max wind speed.
 * Matches Saffir-Simpson + commercial maritime avoidance practice.
 */
function safetyRadiusNm(maxWindKts: number): number {
    if (maxWindKts >= 137) return 250; // Cat 5
    if (maxWindKts >= 114) return 200; // Cat 4
    if (maxWindKts >= 96) return 150; // Cat 3
    if (maxWindKts >= 83) return 125; // Cat 2
    if (maxWindKts >= 64) return 100; // Cat 1
    if (maxWindKts >= 34) return 75; // TS
    return 50; // TD
}

/**
 * Haversine distance in NM. Inlined here so the exclusion check doesn't
 * cross a module boundary on every isochrone candidate (millions of
 * calls per route compute).
 */
function distanceNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const dφ = ((lat2 - lat1) * Math.PI) / 180;
    const dλ = ((lon2 - lon1) * Math.PI) / 180;
    const a = Math.sin(dφ / 2) ** 2 + Math.cos(φ1) * Math.cos(φ2) * Math.sin(dλ / 2) ** 2;
    return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Build a sorted timestamped track for a single cyclone, combining its
 * current position with its NHC forecast positions.
 */
function buildTrack(c: ActiveCyclone): { timeMs: number; lat: number; lon: number; radius: number }[] {
    const radius = safetyRadiusNm(c.maxWindKts || 0);
    const points: { timeMs: number; lat: number; lon: number; radius: number }[] = [];

    const cur = c.currentPosition;
    const curMs = new Date(cur.time).getTime();
    if (!isNaN(curMs)) {
        points.push({ timeMs: curMs, lat: cur.lat, lon: cur.lon, radius });
    }

    for (const fp of c.forecastTrack || []) {
        const ms = new Date(fp.time).getTime();
        if (isNaN(ms)) continue;
        const r = safetyRadiusNm(fp.windKts ?? c.maxWindKts ?? 0);
        points.push({ timeMs: ms, lat: fp.lat, lon: fp.lon, radius: r });
    }

    points.sort((a, b) => a.timeMs - b.timeMs);
    return points;
}

/**
 * Interpolate a cyclone's position at a given time within its track.
 * Returns the interpolated radius too, since intensity changes across
 * the forecast (genesis → peak → dissipation).
 */
function interpolateTrack(
    track: { timeMs: number; lat: number; lon: number; radius: number }[],
    queryMs: number,
): { lat: number; lon: number; radius: number } | null {
    if (track.length === 0) return null;
    if (track.length === 1) {
        // Only have one point — use it if within MAX_TIME_DELTA_MS
        if (Math.abs(track[0].timeMs - queryMs) <= MAX_TIME_DELTA_MS) {
            return { lat: track[0].lat, lon: track[0].lon, radius: track[0].radius };
        }
        return null;
    }

    // Find bracket
    if (queryMs <= track[0].timeMs) {
        // Before track start — extrapolate by gap
        if (track[0].timeMs - queryMs > MAX_TIME_DELTA_MS) return null;
        return { lat: track[0].lat, lon: track[0].lon, radius: track[0].radius };
    }
    if (queryMs >= track[track.length - 1].timeMs) {
        // After track end — too far in the future, storm presumed dissipated
        if (queryMs - track[track.length - 1].timeMs > MAX_TIME_DELTA_MS) return null;
        const last = track[track.length - 1];
        return { lat: last.lat, lon: last.lon, radius: last.radius };
    }

    // Linear interpolation between bracketing points
    for (let i = 0; i < track.length - 1; i++) {
        const a = track[i];
        const b = track[i + 1];
        if (queryMs >= a.timeMs && queryMs <= b.timeMs) {
            const span = b.timeMs - a.timeMs;
            const t = span > 0 ? (queryMs - a.timeMs) / span : 0;
            return {
                lat: a.lat + t * (b.lat - a.lat),
                lon: a.lon + t * (b.lon - a.lon),
                radius: a.radius + t * (b.radius - a.radius),
            };
        }
    }

    return null;
}

/**
 * Build an ExclusionField from all currently active tropical cyclones.
 *
 * Returns null if no active cyclones (so the caller can skip the
 * isExcluded check entirely — the engine treats null as "no
 * exclusions").
 *
 * The `routeBbox` parameter is an optimisation: cyclones whose entire
 * track lies > 1000 NM from the route bbox can be skipped — they can't
 * possibly intercept us. For a Newport→Port Moselle route there's no
 * point evaluating a Gulf of Mexico hurricane.
 */
export async function buildCycloneExclusionField(
    departureTime: string,
    routeBbox?: { north: number; south: number; east: number; west: number },
): Promise<ExclusionField | null> {
    let cyclones: ActiveCyclone[];
    try {
        cyclones = await fetchActiveCyclones();
    } catch (e) {
        log.warn('cyclone fetch failed — routing without exclusion zones:', e);
        return null;
    }

    if (cyclones.length === 0) {
        log.info('no active cyclones — exclusion field empty');
        return null;
    }

    // Spatial pre-filter: drop cyclones nowhere near the route.
    let relevantCyclones = cyclones;
    if (routeBbox) {
        const bboxCheck = (p: CyclonePosition) => {
            const latPad = 15; // ~900 NM
            const lonPad = 15;
            return (
                p.lat <= routeBbox.north + latPad &&
                p.lat >= routeBbox.south - latPad &&
                p.lon <= routeBbox.east + lonPad &&
                p.lon >= routeBbox.west - lonPad
            );
        };
        relevantCyclones = cyclones.filter((c) => {
            if (bboxCheck(c.currentPosition)) return true;
            return (c.forecastTrack || []).some(bboxCheck);
        });
    }

    if (relevantCyclones.length === 0) {
        log.info(`${cyclones.length} active cyclone(s) but none near route — exclusion field empty`);
        return null;
    }

    // Pre-build tracks (sorted by time) so the per-candidate isExcluded
    // check is just bracket-find + interpolation + distance.
    const tracks = relevantCyclones.map((c) => ({
        name: c.name,
        category: c.categoryLabel,
        track: buildTrack(c),
    }));

    log.info(
        `built exclusion field with ${tracks.length} relevant cyclone(s): ${tracks
            .map((t) => `${t.name} (Cat ${t.category}, ${t.track.length} pts)`)
            .join(', ')}`,
    );

    const depMs = new Date(departureTime).getTime();

    return {
        isExcluded(lat: number, lon: number, timeOffsetHours: number): boolean {
            const queryMs = depMs + timeOffsetHours * 3600_000;
            for (const { track } of tracks) {
                const pos = interpolateTrack(track, queryMs);
                if (!pos) continue;
                const d = distanceNm(lat, lon, pos.lat, pos.lon);
                if (d < pos.radius) return true;
            }
            return false;
        },
    };
}
