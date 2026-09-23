import type { VoyageLogWaypoint } from './voyageLogApi';

type ScopedWaypoint = VoyageLogWaypoint & { voyage_id?: string | null };

/** Keep one lifecycle start/end per known voyage without changing track data.
 * Current API waypoints omit voyage_id, so the selected trip supplies their
 * scope. Unscoped legacy responses may contain several voyages: leave those
 * markers intact rather than accidentally merging distinct departures. */
export function publicVoyageWaypoints<T extends ScopedWaypoint>(
    waypoints: readonly T[],
    selectedVoyageId?: string | null,
): T[] {
    const selected = selectedVoyageId?.trim();
    const lifecycleByVoyage = new Map<string, { start?: number; end?: number }>();
    const removed = new Set<number>();

    waypoints.forEach((waypoint, index) => {
        const role = waypoint.name === 'Voyage Start' ? 'start' : waypoint.name === 'Voyage End' ? 'end' : null;
        if (!role) return;
        const voyageId = waypoint.voyage_id?.trim() || selected;
        const timestamp = Date.parse(waypoint.timestamp);
        if (!voyageId || !Number.isFinite(timestamp)) return;

        const lifecycle = lifecycleByVoyage.get(voyageId) ?? {};
        const previousIndex = lifecycle[role];
        if (previousIndex === undefined) {
            lifecycle[role] = index;
        } else {
            const previousTimestamp = Date.parse(waypoints[previousIndex].timestamp);
            const replacesPrevious = role === 'start' ? timestamp < previousTimestamp : timestamp > previousTimestamp;
            if (replacesPrevious) {
                removed.add(previousIndex);
                lifecycle[role] = index;
            } else {
                removed.add(index);
            }
        }
        lifecycleByVoyage.set(voyageId, lifecycle);
    });

    return waypoints.filter((_, index) => !removed.has(index));
}
