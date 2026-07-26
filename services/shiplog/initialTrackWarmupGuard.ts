/**
 * initialTrackWarmupGuard — non-destructive compatibility repair for old
 * voyage tracks recorded during GPS cold start.
 *
 * Some historical sessions contain this very specific sequence:
 *
 *   Voyage Start (S) → first raw fix (A) → corroborating raw fix (B)
 *
 * `Voyage Start` was stamped from B while retaining A. When A was a
 * settling/stale GPS reading, the rendered geometry became S → A → B even
 * though B was effectively back at S. This guard removes only A and only
 * when the full short-window rebound signature is present.
 *
 * It is deliberately NOT a general GPS smoothing or speed filter. A real
 * manoeuvre, a fast powerboat, an imported route, and all later voyage
 * geometry are left untouched.
 */

import type { ShipLogEntry } from '../../types';
import { calculateDistanceNM, isPlausibleTrackPoint, isTrackworthyEntry } from './helpers';

/** The captured raw fixes should arrive within a few 5-second samples. */
export const INITIAL_TRACK_WARMUP_WINDOW_MS = 45_000;
/** The first raw fix must land promptly after tapping Start. */
export const INITIAL_TRACK_WARMUP_FIRST_FIX_MAX_MS = 20_000;
/** A and B must be adjacent in the cold-start acquisition window. */
export const INITIAL_TRACK_WARMUP_REBOUND_MAX_GAP_MS = 15_000;
/** B must return to the Voyage Start position at berth-scale precision. */
export const INITIAL_TRACK_WARMUP_RETURN_DISTANCE_M = 25;
/** A must be materially away from both sides of the rebound. */
export const INITIAL_TRACK_WARMUP_OUTLIER_DISTANCE_M = 75;

const METRES_PER_NM = 1852;
const LIFECYCLE_WAYPOINT_NAMES = new Set(['Voyage Start', 'Voyage End']);

interface IndexedEntry {
    entry: ShipLogEntry;
    index: number;
    timestampMs: number;
}

function metresBetween(a: ShipLogEntry, b: ShipLogEntry): number {
    return calculateDistanceNM(a.latitude, a.longitude, b.latitude, b.longitude) * METRES_PER_NM;
}

function isVoyageStartMarker(entry: ShipLogEntry): boolean {
    return (
        entry.entryType === 'waypoint' &&
        entry.waypointName === 'Voyage Start' &&
        isPlausibleTrackPoint(entry.latitude, entry.longitude)
    );
}

/**
 * Real captured vertices eligible to be A/B. Lifecycle markers are deliberately
 * excluded: this guard needs the two actual fixes after Voyage Start, not a
 * duplicated marker or a manual/turn-pin position.
 */
function isRecordedTrackFix(entry: ShipLogEntry): boolean {
    return (
        isTrackworthyEntry(entry) &&
        !LIFECYCLE_WAYPOINT_NAMES.has(entry.waypointName ?? '') &&
        entry.source !== 'planned_route'
    );
}

/**
 * Remove the one early raw fix in a proven Voyage Start → outlier → return
 * rebound, independently for each voyage. The input array and its entry
 * objects are never mutated; output order remains identical to input order.
 *
 * This is intended for map/playback presentation of existing tracks. New
 * captures should be fixed at the GPS ingestion boundary as well.
 */
export function stripInitialTrackWarmupRebounds(entries: readonly ShipLogEntry[]): ShipLogEntry[] {
    if (entries.length < 3) return [...entries];

    const groups = new Map<string, IndexedEntry[]>();

    entries.forEach((entry, index) => {
        const timestampMs = Date.parse(entry.timestamp);
        if (!Number.isFinite(timestampMs)) return;

        const voyageKey = entry.voyageId || '__unscoped_voyage__';
        const group = groups.get(voyageKey);
        const indexed = { entry, index, timestampMs };
        if (group) group.push(indexed);
        else groups.set(voyageKey, [indexed]);
    });

    const removedIndexes = new Set<number>();

    for (const group of groups.values()) {
        if (group.length < 3) continue;
        const chronological = [...group].sort((a, b) => a.timestampMs - b.timestampMs || a.index - b.index);
        const startIndex = chronological.findIndex(({ entry }) => isVoyageStartMarker(entry));
        if (startIndex < 0) continue;

        const start = chronological[startIndex];
        const initialFixes = chronological
            .slice(startIndex + 1)
            .filter(
                ({ entry, timestampMs }) =>
                    isRecordedTrackFix(entry) &&
                    timestampMs >= start.timestampMs &&
                    timestampMs - start.timestampMs <= INITIAL_TRACK_WARMUP_WINDOW_MS,
            );
        if (initialFixes.length < 2) continue;

        const [outlier, returnFix] = initialFixes;
        const firstFixDelayMs = outlier.timestampMs - start.timestampMs;
        const reboundGapMs = returnFix.timestampMs - outlier.timestampMs;
        if (
            firstFixDelayMs < 0 ||
            firstFixDelayMs > INITIAL_TRACK_WARMUP_FIRST_FIX_MAX_MS ||
            reboundGapMs <= 0 ||
            reboundGapMs > INITIAL_TRACK_WARMUP_REBOUND_MAX_GAP_MS
        ) {
            continue;
        }

        const returnDistanceM = metresBetween(start.entry, returnFix.entry);
        const outboundDistanceM = metresBetween(start.entry, outlier.entry);
        const inboundDistanceM = metresBetween(outlier.entry, returnFix.entry);
        if (
            returnDistanceM <= INITIAL_TRACK_WARMUP_RETURN_DISTANCE_M &&
            outboundDistanceM >= INITIAL_TRACK_WARMUP_OUTLIER_DISTANCE_M &&
            inboundDistanceM >= INITIAL_TRACK_WARMUP_OUTLIER_DISTANCE_M
        ) {
            removedIndexes.add(outlier.index);
        }
    }

    return removedIndexes.size === 0 ? [...entries] : entries.filter((_entry, index) => !removedIndexes.has(index));
}
