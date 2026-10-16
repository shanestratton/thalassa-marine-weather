import { resolveRouteConstraints, routeRetainsConstraints, type RouteConstraintPoint } from './routeConstraints';
import { copyTraceRoutePoints, type TraceRoutePoint } from './traceRoutePoint';
/** Original marks stay separate from generated curve/depth vertices. Null
 * means this line cannot be offered for constrained re-routing. */
export function routeConstraintsForTrace(points: readonly TraceRoutePoint[]): RouteConstraintPoint[] | null {
    const clean = copyTraceRoutePoints(points);
    if (!clean || clean.length < 2 || clean[0].constraint || clean.at(-1)!.constraint) return null;
    const vias = clean
        .slice(1, -1)
        .filter((p) => !p.shape && !p.auto)
        .map((p, i) => p.constraint ?? { lat: p.lat, lon: p.lon, name: p.name ?? `Pin ${i + 2}` });
    const resolved = resolveRouteConstraints(clean[0], vias, clean.at(-1)!);
    return resolved && routeRetainsConstraints(clean, resolved) ? resolved.canonicalVias : null;
}
