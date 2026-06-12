/**
 * turnMarkers — DERIVED turn waypoints (2026-06-12 redesign).
 *
 * The old system STORED course-change pins as log entries, placed at
 * the geometric midpoint of the turn — off-route by construction,
 * timestamped wrong, synced forever, and impossible to retune for
 * voyages already recorded. This module replaces all of that with a
 * pure function over the track: markers are computed at RENDER time
 * from the recorded points, so they are
 *
 *   - guaranteed ON the route (each marker IS a track point),
 *   - retroactive (every historical voyage gets them immediately),
 *   - retunable for free (change a constant, all history improves),
 *   - zero storage / zero sync weight.
 *
 * Algorithm: walk the trackworthy points building legs of at least
 * MIN_LEG_M (point-to-point bearings at 5 s cadence are noise at low
 * speed); accumulate the SIGNED heading change between consecutive
 * legs; every time |accumulated| reaches TURN_THRESHOLD_DEG, emit a
 * marker at the current track point and reset. Signed accumulation
 * means ±jitter on a straight course cancels instead of summing, while
 * a genuine turn accumulates in one direction:
 *
 *   - straight leg            → no markers
 *   - sharp 90° corner        → exactly one marker
 *   - wide 180° sweep         → a marker every ~30° around the curve
 *
 * MIN_MARKER_SPACING_M stops a chaotic patch (close-quarters
 * manoeuvring) from stacking dots on top of each other.
 */
import type { ShipLogEntry } from '../../types';
import { degreesToCardinal16 } from './CourseChangeDetector';
import { haversineMeters } from './GpsTrackBuffer';
import { calculateBearing, isTrackworthyEntry } from './helpers';

/** Cumulative course change that earns a marker. */
export const TURN_THRESHOLD_DEG = 30;
/** Minimum leg length for a bearing sample — kills anchor/walking jitter. */
export const MIN_LEG_M = 25;
/** Minimum distance between consecutive markers. */
export const MIN_MARKER_SPACING_M = 30;

export interface TurnMarker {
    lat: number;
    lon: number;
    /** ISO timestamp of the track point the marker sits on. */
    timestamp: string;
    /** Course before the turn started (at the last marker/reset). */
    fromDeg: number;
    /** Course on the leg that crossed the threshold. */
    toDeg: number;
    /** 16-point cardinals for display ("ENE → E"). */
    fromCardinal: string;
    toCardinal: string;
}

/** Signed shortest-path heading delta, -180..180 (positive = starboard). */
function signedHeadingDelta(fromDeg: number, toDeg: number): number {
    return ((toDeg - fromDeg + 540) % 360) - 180;
}

/**
 * Derive turn markers from a voyage's entries. Filters to trackworthy
 * points and sorts by timestamp itself, so callers can pass raw entry
 * lists. Pure — safe to call on every render.
 */
export function deriveTurnMarkers(entries: ShipLogEntry[]): TurnMarker[] {
    const pts = entries
        .filter(isTrackworthyEntry)
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    if (pts.length < 3) return [];

    const markers: TurnMarker[] = [];
    let anchor = pts[0];
    let prevBearing: number | null = null;
    let headingAtReset = 0;
    let accumulated = 0;
    let lastMarker: { lat: number; lon: number } | null = null;

    for (let i = 1; i < pts.length; i++) {
        const p = pts[i];
        const legM = haversineMeters(anchor.latitude!, anchor.longitude!, p.latitude!, p.longitude!);
        if (legM < MIN_LEG_M) continue;

        const legBearing = calculateBearing(anchor.latitude!, anchor.longitude!, p.latitude!, p.longitude!);
        anchor = p;

        if (prevBearing === null) {
            prevBearing = legBearing;
            headingAtReset = legBearing;
            continue;
        }

        accumulated += signedHeadingDelta(prevBearing, legBearing);
        prevBearing = legBearing;

        if (Math.abs(accumulated) >= TURN_THRESHOLD_DEG) {
            const farEnough =
                !lastMarker ||
                haversineMeters(lastMarker.lat, lastMarker.lon, p.latitude!, p.longitude!) >= MIN_MARKER_SPACING_M;
            if (farEnough) {
                markers.push({
                    lat: p.latitude!,
                    lon: p.longitude!,
                    timestamp: p.timestamp,
                    fromDeg: headingAtReset,
                    toDeg: legBearing,
                    fromCardinal: degreesToCardinal16(headingAtReset),
                    toCardinal: degreesToCardinal16(legBearing),
                });
                lastMarker = { lat: p.latitude!, lon: p.longitude! };
            }
            // Reset regardless — a skipped (too-close) marker must not
            // leave the accumulator primed to fire on the next sample.
            accumulated = 0;
            headingAtReset = legBearing;
        }
    }

    return markers;
}
