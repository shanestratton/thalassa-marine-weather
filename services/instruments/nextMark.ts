import type { VoyagePlan } from '../../types/navigation';
import { progressAlongRoute, type RoutePoint } from '../routeProgress';
const valid = (p: RoutePoint | undefined | null): p is RoutePoint =>
    !!p && Number.isFinite(p.lat) && Number.isFinite(p.lon) && Math.abs(p.lat) <= 85 && Math.abs(p.lon) <= 180;
/** Only explicit followed marks. A nearby model/route polyline vertex is never invented as a mark. */
export function nextFollowedMark(
    route: readonly RoutePoint[],
    plan: VoyagePlan | null,
    boat: RoutePoint,
): { point: RoutePoint; name: string } | null {
    if (!plan || route.length < 2 || route.length > 20000 || !valid(boat)) return null;
    const progress = progressAlongRoute(route, boat);
    if (!progress || progress.offTrackNm > 0.25) return null;
    if (plan.waypoints && (!Array.isArray(plan.waypoints) || plan.waypoints.length > 32)) return null;
    const marks = [
        ...(plan.waypoints ?? []).map((mark) => ({ point: mark.coordinates, name: mark.name })),
        { point: plan.destinationCoordinates, name: plan.destination },
    ];
    let last = -1;
    const projected: Array<{ point: RoutePoint; name: string; along: number }> = [];
    for (const mark of marks) {
        if (!valid(mark.point)) continue;
        const at = progressAlongRoute(route, mark.point);
        if (!at || at.offTrackNm > 0.1 || at.alongNm < last - 0.02) return null;
        last = at.alongNm;
        projected.push({ point: mark.point, name: mark.name, along: at.alongNm });
    }
    const next = projected.find((mark) => mark.along > progress.alongNm + 0.02);
    return next ? { point: next.point, name: next.name } : null;
}
