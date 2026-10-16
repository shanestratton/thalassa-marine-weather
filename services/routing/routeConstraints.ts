import { haversineNm, initialBearing, projectPosition } from '../isochrone/geodesy';

/** User-authored points only. Never attach a chart feature or provider properties. */
export interface RouteConstraintPoint {
    lat: number;
    lon: number;
    name?: string;
    leaveSide?: 'port' | 'starboard';
    /** Explicit passing-point offset, not a claim of charted clearance. */
    standOffM?: number;
}
export interface RouteHalfLine {
    lat: number;
    lon: number;
    bearing: number;
}
export interface ResolvedRouteConstraints {
    points: RouteConstraintPoint[];
    halfLines: RouteHalfLine[];
}
export const MAX_ROUTE_VIAS = 256;
const finitePoint = (p: RouteConstraintPoint) =>
    p && Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180;

/** Refuse the whole request; an invalid or excessive mark is never dropped. */
export function resolveRouteConstraints(
    origin: RouteConstraintPoint,
    vias: readonly RouteConstraintPoint[],
    destination: RouteConstraintPoint,
): ResolvedRouteConstraints | null {
    if (
        !Array.isArray(vias) ||
        vias.length > MAX_ROUTE_VIAS ||
        ![origin, ...vias, destination].every(finitePoint) ||
        origin.leaveSide !== undefined ||
        origin.standOffM !== undefined ||
        destination.leaveSide !== undefined ||
        destination.standOffM !== undefined
    )
        return null;
    const chain = [origin, ...vias, destination],
        points = [{ lat: origin.lat, lon: origin.lon, name: origin.name }];
    const halfLines: RouteHalfLine[] = [];
    for (let i = 1; i < chain.length - 1; i++) {
        const p = chain[i];
        if (
            (p.name !== undefined && (typeof p.name !== 'string' || p.name.length > 100)) ||
            (p.leaveSide !== undefined && !['port', 'starboard'].includes(p.leaveSide))
        )
            return null;
        if (!p.leaveSide) {
            if (p.standOffM !== undefined) return null;
            points.push({ lat: p.lat, lon: p.lon, name: p.name });
            continue;
        }
        if (
            typeof p.standOffM !== 'number' ||
            !Number.isFinite(p.standOffM) ||
            p.standOffM < 5 ||
            p.standOffM > 2000 ||
            haversineNm(chain[i - 1].lat, chain[i - 1].lon, chain[i + 1].lat, chain[i + 1].lon) < 0.001
        )
            return null;
        const bearing = initialBearing(chain[i - 1].lat, chain[i - 1].lon, chain[i + 1].lat, chain[i + 1].lon);
        const forbidden = (bearing + (p.leaveSide === 'port' ? 270 : 90)) % 360;
        halfLines.push({ lat: p.lat, lon: p.lon, bearing: forbidden });
        const passing = projectPosition(p.lat, p.lon, (forbidden + 180) % 360, p.standOffM / 1852);
        points.push({ ...passing, name: p.name });
    }
    points.push({ lat: destination.lat, lon: destination.lon, name: destination.name });
    if (points.some((p, i) => i && haversineNm(points[i - 1].lat, points[i - 1].lon, p.lat, p.lon) < 0.0001))
        return null;
    return { points, halfLines };
}

type V = [number, number, number];
const dot = (a: V, b: V) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V, b: V): V => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (p: V) => Math.hypot(...p);
const scale = (p: V, k: number): V => [p[0] * k, p[1] * k, p[2] * k];
const radians = (n: number) => (n * Math.PI) / 180;
const vector = (p: RouteConstraintPoint): V => {
    const lat = radians(p.lat),
        lon = radians(p.lon);
    return [Math.cos(lat) * Math.cos(lon), Math.cos(lat) * Math.sin(lon), Math.sin(lat)];
};
const angle = (a: V, b: V) => Math.atan2(norm(cross(a, b)), dot(a, b));

/** Exact great-circle intersection with the chosen forward half-circle.
 * No longitude interpolation: short dateline and polar legs retain their side. */
export function routeSegmentAllowed(
    a: RouteConstraintPoint,
    b: RouteConstraintPoint,
    rays: readonly RouteHalfLine[],
): boolean {
    if (!finitePoint(a) || !finitePoint(b) || rays.length > MAX_ROUTE_VIAS) return false;
    const av = vector(a),
        bv = vector(b),
        arc = angle(av, bv),
        normal = cross(av, bv);
    if (arc > Math.PI - 1e-8) return false;
    for (const ray of rays) {
        if (!finitePoint(ray) || !Number.isFinite(ray.bearing) || ray.bearing < 0 || ray.bearing >= 360) return false;
        const m = vector(ray),
            lat = radians(ray.lat),
            lon = radians(ray.lon),
            bearing = radians(ray.bearing);
        const east: V = [-Math.sin(lon), Math.cos(lon), 0];
        const north: V = [-Math.sin(lat) * Math.cos(lon), -Math.sin(lat) * Math.sin(lon), Math.cos(lat)];
        const tangent: V = east.map((v, i) => v * Math.sin(bearing) + north[i] * Math.cos(bearing)) as V;
        const plane = cross(m, tangent),
            intersection = cross(normal, plane),
            magnitude = norm(intersection);
        const onRay = (p: V) => Math.abs(dot(p, plane)) < 1e-10 && dot(p, tangent) >= -1e-10;
        if (onRay(av) || onRay(bv)) return false;
        if (arc < 1e-12) continue;
        if (magnitude < 1e-12) continue; // Collinear backward half has no forbidden overlap.
        const hit = scale(intersection, 1 / magnitude);
        for (const p of [hit, scale(hit, -1)]) {
            if (dot(p, tangent) >= -1e-10 && angle(av, p) + angle(p, bv) <= arc + 1e-9) return false;
        }
    }
    return true;
}

/** Ordered exact vertices after every smoothing/chart pass, including terminal legs. */
export function routeRetainsConstraints(
    route: readonly RouteConstraintPoint[],
    constraints: ResolvedRouteConstraints,
): boolean {
    if (
        route.length < 2 ||
        route.length > 8192 ||
        !route.every(finitePoint) ||
        !Array.isArray(constraints.points) ||
        constraints.points.length < 2 ||
        constraints.points.length > MAX_ROUTE_VIAS + 2 ||
        !constraints.points.every(finitePoint) ||
        !Array.isArray(constraints.halfLines) ||
        constraints.halfLines.length > MAX_ROUTE_VIAS
    )
        return false;
    const endpoints = [constraints.points[0], constraints.points.at(-1)!];
    if (
        haversineNm(route[0].lat, route[0].lon, endpoints[0].lat, endpoints[0].lon) * 1852 > 1 ||
        haversineNm(route.at(-1)!.lat, route.at(-1)!.lon, endpoints[1].lat, endpoints[1].lon) * 1852 > 1
    )
        return false;
    let previous = -1;
    for (const point of constraints.points) {
        let found = -1;
        for (let i = previous + 1; i < route.length; i++) {
            if (haversineNm(point.lat, point.lon, route[i].lat, route[i].lon) * 1852 <= 1) {
                found = i;
                break;
            }
        }
        if (found < 0) return false;
        previous = found;
    }
    return route.every((p, i) => !i || routeSegmentAllowed(route[i - 1], p, constraints.halfLines));
}
