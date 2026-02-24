/**
 * useGhostShip — 4D Vessel Position Interpolation Hook
 *
 * Given the spatiotemporal track array and the current scrubber time,
 * computes the exact position, bearing, and interpolated weather
 * of the "ghost ship" on the map.
 *
 * Uses Turf.js for precise great-circle interpolation along the route.
 */

import { useMemo } from 'react';
import along from '@turf/along';
import length from '@turf/length';
import bearing from '@turf/bearing';
import { lineString, point } from '@turf/helpers';
import type { TrackPoint, GhostShipState, TrackConditions } from '../../types/spatiotemporal';

/**
 * Interpolate between two conditions based on progress (0-1).
 */
function lerpConditions(a: TrackConditions, b: TrackConditions, t: number): TrackConditions {
    return {
        depth_m: (a.depth_m != null && b.depth_m != null)
            ? a.depth_m + (b.depth_m - a.depth_m) * t
            : a.depth_m ?? b.depth_m,
        wind_spd_kts: a.wind_spd_kts + (b.wind_spd_kts - a.wind_spd_kts) * t,
        wind_dir_deg: lerpAngle(a.wind_dir_deg, b.wind_dir_deg, t),
        wave_ht_m: a.wave_ht_m + (b.wave_ht_m - a.wave_ht_m) * t,
        swell_period_s: (a.swell_period_s != null && b.swell_period_s != null)
            ? a.swell_period_s + (b.swell_period_s - a.swell_period_s) * t
            : a.swell_period_s ?? b.swell_period_s,
    };
}

/** Interpolate between two angles, handling 359° → 1° wrap */
function lerpAngle(a: number, b: number, t: number): number {
    let diff = b - a;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    return ((a + diff * t) + 360) % 360;
}

export function useGhostShip(
    track: TrackPoint[] | null | undefined,
    currentTimeHours: number,
): GhostShipState | null {
    return useMemo(() => {
        if (!track || track.length < 2) return null;

        // ── Edge Cases ──
        if (currentTimeHours <= 0) {
            const p1 = point(track[0].coordinates);
            const p2 = point(track[1].coordinates);
            return {
                position: track[0].coordinates,
                bearing: bearing(p1, p2),
                conditions: track[0].conditions,
                distanceNM: 0,
                segmentIndex: 0,
            };
        }

        const last = track[track.length - 1];
        if (currentTimeHours >= last.time_offset_hours) {
            const prev = point(track[track.length - 2].coordinates);
            const end = point(last.coordinates);
            return {
                position: last.coordinates,
                bearing: bearing(prev, end),
                conditions: last.conditions,
                distanceNM: last.distance_from_start_nm,
                segmentIndex: track.length - 2,
            };
        }

        // ── Find active segment ──
        let segIdx = 0;
        for (let i = 0; i < track.length - 1; i++) {
            if (currentTimeHours >= track[i].time_offset_hours &&
                currentTimeHours < track[i + 1].time_offset_hours) {
                segIdx = i;
                break;
            }
        }

        const wp1 = track[segIdx];
        const wp2 = track[segIdx + 1];

        // ── Progress along this segment (0.0 → 1.0) ──
        const timeDiff = wp2.time_offset_hours - wp1.time_offset_hours;
        const progress = timeDiff > 0
            ? (currentTimeHours - wp1.time_offset_hours) / timeDiff
            : 0;

        // ── Interpolated distance ──
        const distDiff = wp2.distance_from_start_nm - wp1.distance_from_start_nm;
        const currentDistNM = wp1.distance_from_start_nm + distDiff * progress;

        // ── Turf.js position along the full line ──
        const line = lineString(track.map(t => t.coordinates));
        const totalLen = length(line, { units: 'nauticalmiles' });

        // Clamp to line length
        const clampedDist = Math.min(currentDistNM, totalLen - 0.01);
        const posFeature = along(line, clampedDist, { units: 'nauticalmiles' });

        // Look 0.1 NM ahead for bearing
        const lookAhead = Math.min(clampedDist + 0.1, totalLen);
        const aheadFeature = along(line, lookAhead, { units: 'nauticalmiles' });
        const currentBearing = bearing(posFeature, aheadFeature);

        // ── Interpolated conditions for the HUD ──
        const conditions = lerpConditions(wp1.conditions, wp2.conditions, progress);

        return {
            position: posFeature.geometry.coordinates as [number, number],
            bearing: currentBearing,
            conditions,
            distanceNM: currentDistNM,
            segmentIndex: segIdx,
        };
    }, [track, currentTimeHours]);
}
