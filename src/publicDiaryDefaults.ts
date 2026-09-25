import type { VoyageLogData, VoyageLogEntry } from './voyageLogApi';
import { publicTrackSegments } from './publicTrackSegments';

/** Use actual geometry, not a potentially stale shelf has_route flag. */
export function hasUsablePublicRoute(data: Pick<VoyageLogData, 'passage'>): boolean {
    const line = data.passage?.plan_line;
    if (!Array.isArray(line) || line.length < 2) return false;
    if (
        !line.every(
            (point) =>
                Array.isArray(point) &&
                point.length >= 2 &&
                Number.isFinite(point[0]) &&
                Number.isFinite(point[1]) &&
                Math.abs(point[0]) <= 180 &&
                Math.abs(point[1]) <= 90,
        )
    ) {
        return false;
    }
    return line.some((point) => point[0] !== line[0][0] || point[1] !== line[0][1]);
}

/** A recorded trip does not need a planned route to deserve the map. Only
 * use the server's selected, privacy-filtered geometry: a lone berth fix,
 * repeated stationary positions or another trip's shelf flag is not a track. */
export function hasUsablePublicTrack(data: Pick<VoyageLogData, 'track' | 'selected_trip'>): boolean {
    const points = data.track;
    if (!Array.isArray(points) || points.length < 2) return false;
    if (
        !points.every(
            (point) =>
                point != null &&
                Number.isFinite(point.lat) &&
                Number.isFinite(point.lon) &&
                Math.abs(point.lat) <= 90 &&
                Math.abs(point.lon) <= 180 &&
                !(point.lat === 0 && point.lon === 0),
        )
    ) {
        return false;
    }
    return publicTrackSegments(points).some((segment) =>
        segment.some((point) => point[0] !== segment[0][0] || point[1] !== segment[0][1]),
    );
}

export function hasUsablePublicTrip(data: VoyageLogData): boolean {
    return hasUsablePublicRoute(data) || hasUsablePublicTrack(data);
}

/** Older servers without the all-diary shelf retain their existing default.
 * If latest already returns every entry, keep that mode so the berth's live
 * instruments remain accessible without changing the current privacy rules. */
export function shouldDefaultToAllDiary(data: VoyageLogData): boolean {
    return (
        !hasUsablePublicTrip(data) &&
        data.selected_trip !== 'all-diary' &&
        data.trips?.some((trip) => trip.kind === 'all-diary') === true
    );
}

/** Stable newest-first presentation without mutating the server/map payload.
 * Unknown dates follow dated entries; equal timestamps use immutable ids. */
export function newestDiaryEntries(entries: readonly VoyageLogEntry[]): VoyageLogEntry[] {
    const timestamp = (entry: VoyageLogEntry): number => {
        const time = Date.parse(entry.created_at);
        return Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY;
    };
    return [...entries].sort((a, b) => {
        const aTime = timestamp(a);
        const bTime = timestamp(b);
        if (aTime !== bTime) return aTime > bTime ? -1 : 1;
        return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
}
