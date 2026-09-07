import type { VoyageLogDestination } from './voyageLogApi';
import { haversineNm } from './geo';

const valid = (point: readonly number[]): boolean =>
    point.length === 2 &&
    Number.isFinite(point[0]) &&
    Math.abs(point[0]) <= 180 &&
    Number.isFinite(point[1]) &&
    Math.abs(point[1]) <= 85;

/** The selected route is authoritative; never label yesterday's endpoint with today's destination. */
export function publicMapDestination(line?: [number, number][] | null, destination?: VoyageLogDestination | null) {
    const end = line?.at(-1);
    const target =
        end && valid(end)
            ? end
            : !line?.length && destination && valid([destination.lon, destination.lat])
              ? ([destination.lon, destination.lat] as [number, number])
              : null;
    if (!target) return null;
    const nameMatches =
        destination &&
        valid([destination.lon, destination.lat]) &&
        haversineNm(target[1], target[0], destination.lat, destination.lon) < 2;
    return { center: target, name: nameMatches && destination.name?.trim() ? destination.name.trim() : 'Destination' };
}

/**
 * Include the coast around an offshore arrival, not just the endpoint.
 * Lady Musgrave's island is ~1.68 NM southwest of the current lagoon approach;
 * a tight point close-up would hide precisely the land visitors want to see.
 * Visitors can then pinch/zoom further into the photographic detail.
 */
export function destinationBounds(center: [number, number]): [[number, number], [number, number]] {
    const latSpan = 2.2 / 60;
    const lonSpan = latSpan / Math.max(0.1, Math.cos((center[1] * Math.PI) / 180));
    return [
        [center[0] - lonSpan, Math.max(-85, center[1] - latSpan)],
        [center[0] + lonSpan, Math.min(85, center[1] + latSpan)],
    ];
}
