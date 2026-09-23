import type { VoyageLogData, VoyageLogEntry } from './voyageLogApi';

/** A sailed GPS track is not a loaded planned route. Use the route geometry,
 * not a potentially stale shelf has_route flag, for the initial diary view. */
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

/** Older servers without the all-diary shelf retain their existing default.
 * If latest already returns every entry, keep that mode so the berth's live
 * instruments remain accessible without changing the current privacy rules. */
export function shouldDefaultToAllDiary(data: VoyageLogData): boolean {
    return (
        !hasUsablePublicRoute(data) &&
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
