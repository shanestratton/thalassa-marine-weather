/** Passage-final private policy only. No chart/depth/permission authority. */
import type { CurrentRoutingExclusions } from './routingExclusions';
import type { OverlayRouteBounds } from '../userOverlays/model';
import { buildExclusionField, routeExclusionConflict } from '../engine/exclusionField';
import { ROUTING_AREA_CAVEATS } from './routeAreaWords';

export type RoutingExclusionCode = 'route-exclusion' | 'exclusion-unavailable';
export class RoutingExclusionFailure extends Error {
    constructor(
        public readonly code: RoutingExclusionCode,
        message: string,
    ) {
        super(message);
        this.name = 'RoutingExclusionFailure';
    }
}
/** Structural across lazy module boundaries, workers and independently bundled callers. */
export function isRoutingExclusionFailure(error: unknown): error is Error & { code: RoutingExclusionCode } {
    return (
        !!error &&
        typeof error === 'object' &&
        'code' in error &&
        (error.code === 'route-exclusion' || error.code === 'exclusion-unavailable')
    );
}
const unavailable = () =>
    new RoutingExclusionFailure(
        'exclusion-unavailable',
        'The current no-go areas for the finished passage could not be fully checked. Review the route again.',
    );
type Point = { lat: number; lon: number };
const wrap = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
function validPoints(route: readonly Point[]): void {
    if (
        route.length < 2 ||
        route.length > 8192 ||
        route.some(
            (p) => !Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 85 || Math.abs(p.lon) > 180,
        )
    )
        throw unavailable();
}
/** Original immutable cohort window, with a fixed two-degree latitude detour
 * margin (longitude adjusted for latitude). No later geometry expands a read. */
export function passageRoutingWindow(route: readonly Point[]): OverlayRouteBounds {
    validPoints(route);
    let previous = route[0].lon,
        west = previous,
        east = previous,
        south = route[0].lat,
        north = route[0].lat;
    for (const p of route.slice(1)) {
        previous += wrap(p.lon - previous);
        west = Math.min(west, previous);
        east = Math.max(east, previous);
        south = Math.min(south, p.lat);
        north = Math.max(north, p.lat);
    }
    const longitudeMargin = 2 / Math.cos((Math.max(Math.abs(south), Math.abs(north)) * Math.PI) / 180);
    west -= longitudeMargin;
    east += longitudeMargin;
    if (east - west >= 180) throw unavailable();
    return Object.freeze([
        wrap(west),
        Math.max(-85, south - 2),
        wrap(east),
        Math.min(85, north + 2),
    ]) as OverlayRouteBounds;
}
export function auditPassageRoutingAreas(
    route: readonly Point[],
    lease: CurrentRoutingExclusions,
    window: OverlayRouteBounds,
    check: () => void,
): readonly string[] {
    check();
    validPoints(route);
    const west = window[0],
        east = window[2] < west ? window[2] + 360 : window[2],
        middle = (west + east) / 2;
    for (const p of route) {
        const lon = p.lon + 360 * Math.round((middle - p.lon) / 360);
        if (lon < west || lon > east || p.lat < window[1] || p.lat > window[3]) throw unavailable();
    }
    try {
        const points = route.map((p): [number, number] => [p.lon, p.lat]);
        const field = buildExclusionField({ manual: lease.manual, marineParks: lease.marineParks });
        check();
        if (routeExclusionConflict(points, field, check))
            throw new RoutingExclusionFailure(
                'route-exclusion',
                'The finished passage crosses one of your enabled no-go polygons. Move the route or review that polygon.',
            );
        // Borrow the exact retained footprint classification for an intersection
        // caution only. It never becomes a hard transit prohibition.
        const parks = {
            areas: field.areas
                .filter((area) => area.kind === 'marine-park')
                .map((area) => ({ ...area, kind: 'manual-no-go' as const })),
        };
        const intersectsPark = routeExclusionConflict(points, parks, check) !== null;
        check();
        return Object.freeze([
            ...lease.advisories,
            ...(intersectsPark ? [ROUTING_AREA_CAVEATS[5]] : []),
            ROUTING_AREA_CAVEATS[6],
        ]);
    } catch (error) {
        check();
        if (isRoutingExclusionFailure(error)) throw error;
        throw unavailable();
    }
}
