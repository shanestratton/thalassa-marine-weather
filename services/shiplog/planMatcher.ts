/**
 * planMatcher — suggest the passage plan a departing voyage is probably
 * sailing, so the Log page can offer a one-tap link.
 *
 * DELIBERATELY a suggestion, never a silent link: date+direction heuristics
 * guess wrong in exactly the ways that erode trust on a public page
 * (same-day alternative plans, day-sails the week of a big plan, first
 * legs that head the "wrong" way out of a channel). The owner confirms.
 *
 * A plan qualifies when:
 *   - its departure date is within ±MAX_DATE_DELTA_DAYS of now, and
 *   - its first point is within MAX_START_DIST_NM of the boat's position.
 * Best = smallest date delta, ties broken by start-point distance.
 */

import type { RouteOrTrack } from './RoutesAndTracks';

const MAX_DATE_DELTA_DAYS = 7;
const MAX_START_DIST_NM = 10;

function havNM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 6_371_000;
    const dLat = ((lat2 - lat1) * Math.PI) / 180;
    const dLon = ((lon2 - lon1) * Math.PI) / 180;
    const a =
        Math.sin(dLat / 2) ** 2 +
        Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
    return (2 * R * Math.asin(Math.sqrt(a))) / 1852;
}

export function suggestPlanForDeparture(
    plans: RouteOrTrack[],
    nowMs: number,
    position: { lat: number; lon: number },
): RouteOrTrack | null {
    const dayMs = 86_400_000;
    let best: { plan: RouteOrTrack; dateDelta: number; startDist: number } | null = null;
    for (const plan of plans) {
        if (!plan.points || plan.points.length < 2) continue;
        const dateDelta = Math.abs(plan.timestamp - nowMs);
        if (dateDelta > MAX_DATE_DELTA_DAYS * dayMs) continue;
        const start = plan.points[0];
        const startDist = havNM(position.lat, position.lon, start.lat, start.lon);
        if (startDist > MAX_START_DIST_NM) continue;
        if (!best || dateDelta < best.dateDelta || (dateDelta === best.dateDelta && startDist < best.startDist)) {
            best = { plan, dateDelta, startDist };
        }
    }
    return best?.plan ?? null;
}
