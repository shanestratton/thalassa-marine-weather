import type { ShipLogEntry } from '../../types';
import { calculateDistanceNM, isPlausibleTrackPoint } from './helpers';

const STARTUP_WINDOW_MS = 60_000;

/** captureImmediate's exact no-fix Start marker is metadata, not a GPS measurement. */
function isAcquiringStart(entry: ShipLogEntry): boolean {
    return (
        entry.entryType === 'waypoint' &&
        entry.waypointName === 'Voyage Start' &&
        entry.source === 'device' &&
        entry.positionFormatted === 'Acquiring position...' &&
        entry.latitude === 0 &&
        entry.longitude === 0 &&
        entry.speedKts === 0 &&
        entry.distanceNM === 0 &&
        entry.cumulativeDistanceNM === 0 &&
        entry.courseDeg == null &&
        entry.isOnWater == null
    );
}

/**
 * Recognise only a complete, stationary casual recording. The caller must
 * separately prove that the history is complete and recording has ended;
 * this predicate cannot establish either from a partial array or summary.
 * Ambiguous data and anything containing user-authored content are retained.
 */
export function isUndepartedRecording(entries: readonly ShipLogEntry[], voyageId: string, ownerId: string): boolean {
    const casualVoyage = /^voyage_(\d{13})(?:_[a-z0-9]+)?$/.exec(voyageId);
    if (!casualVoyage || !ownerId.trim() || entries.length < 4) return false;

    const ids = new Set<string>();
    const times = new Set<number>();
    const ordered: Array<{ entry: ShipLogEntry; time: number }> = [];
    let starts = 0;
    let ends = 0;
    let rawFixes = 0;
    let minLat = Infinity;
    let maxLat = -Infinity;
    let minLon = Infinity;
    let maxLon = -Infinity;

    for (const entry of entries) {
        const time = Date.parse(entry.timestamp);
        const acquiringStart = isAcquiringStart(entry);
        if (
            entry.voyageId !== voyageId ||
            entry.userId !== ownerId ||
            !entry.id?.trim() ||
            ids.has(entry.id) ||
            !Number.isFinite(time) ||
            time <= 0 ||
            times.has(time) ||
            (!acquiringStart && !isPlausibleTrackPoint(entry.latitude, entry.longitude)) ||
            // Older/local automatic captures omit source; imports always set it.
            (entry.source !== undefined && entry.source !== 'device') ||
            entry.notes?.trim() ||
            entry.eventCategory != null ||
            entry.linkedPlanId ||
            entry.savedRouteId ||
            typeof entry.distanceNM !== 'number' ||
            !Number.isFinite(entry.distanceNM) ||
            entry.distanceNM < 0 ||
            entry.distanceNM > 0.01 ||
            typeof entry.cumulativeDistanceNM !== 'number' ||
            !Number.isFinite(entry.cumulativeDistanceNM) ||
            entry.cumulativeDistanceNM < 0 ||
            entry.cumulativeDistanceNM > 0.01
        ) {
            return false;
        }

        const name = entry.waypointName;
        if (entry.entryType === 'waypoint' && name === 'Voyage Start') starts += 1;
        else if (entry.entryType === 'waypoint' && name === 'Voyage End') ends += 1;
        else if (
            (entry.entryType === 'auto' && !name) ||
            (entry.entryType === 'waypoint' && name === 'Latest Position')
        ) {
            if (
                typeof entry.speedKts !== 'number' ||
                !Number.isFinite(entry.speedKts) ||
                entry.speedKts < 0 ||
                entry.speedKts >= 0.8
            ) {
                return false;
            }
            rawFixes += 1;
        } else {
            return false;
        }

        ids.add(entry.id);
        times.add(time);
        ordered.push({ entry, time });
        if (!acquiringStart) {
            minLat = Math.min(minLat, entry.latitude);
            maxLat = Math.max(maxLat, entry.latitude);
            minLon = Math.min(minLon, entry.longitude);
            maxLon = Math.max(maxLon, entry.longitude);
        }
    }

    if (starts !== 1 || ends !== 1 || rawFixes < 2) return false;
    ordered.sort((left, right) => left.time - right.time);
    if (ordered[ordered.length - 1].entry.waypointName !== 'Voyage End') return false;

    const start = ordered.find((row) => row.entry.waypointName === 'Voyage Start')!;
    if (ordered[0] !== start || isAcquiringStart(start.entry)) {
        // GPS subscriptions are live before captureImmediate launches Start.
        // Their first selected fix may legitimately precede that marker. A
        // cold start can also leave its exact no-fix placeholder in the local
        // queue. Neither may excuse an unobserved beginning of a real trip:
        // both the marker and first measured fix must lie in the first minute
        // after this casual voyage was created, with no pre-voyage samples.
        const createdAt = Number(casualVoyage[1]);
        const firstMeasured = ordered.find((row) => row !== start)!;
        if (
            ordered[0].time < createdAt ||
            start.time - createdAt > STARTUP_WINDOW_MS ||
            firstMeasured.time - createdAt > STARTUP_WINDOW_MS
        ) {
            return false;
        }
    }
    if (ordered.some((row, index) => index > 0 && row.time - ordered[index - 1].time > 20 * 60_000)) return false;

    // A wrapped bounding box cannot prove a small footprint; retain it.
    return maxLon - minLon <= 180 && calculateDistanceNM(minLat, minLon, maxLat, maxLon) * 1852 <= 30;
}
