import { normaliseRouteConstraints, type RouteConstraintPoint } from './routeConstraintTypes';
/** Coordinates always describe the actual line. A side mark keeps its original
 * user position separately; derived shape/depth points are never new vias. */
export interface TraceRoutePoint {
    lat: number;
    lon: number;
    name?: string;
    shape?: true;
    auto?: true;
    constraint?: RouteConstraintPoint;
}
export function copyTraceRoutePoint(raw: unknown): TraceRoutePoint | null {
    if (!raw || typeof raw !== 'object') return null;
    const p = raw as TraceRoutePoint;
    if (
        (p.name !== undefined && (typeof p.name !== 'string' || p.name.length > 100)) ||
        !Number.isFinite(p.lat) ||
        Math.abs(p.lat) > 90 ||
        !Number.isFinite(p.lon) ||
        Math.abs(p.lon) > 180 ||
        (p.shape !== undefined && p.shape !== true) ||
        (p.auto !== undefined && p.auto !== true) ||
        (p.shape && p.auto) ||
        ((p.shape || p.auto) && p.constraint !== undefined)
    )
        return null;
    const result: TraceRoutePoint = { lat: p.lat, lon: p.lon, ...(p.name !== undefined ? { name: p.name } : {}) };
    if (p.shape) result.shape = true;
    if (p.auto) result.auto = true;
    if (p.constraint !== undefined) {
        const mark = normaliseRouteConstraints([p.constraint])?.[0];
        if (!mark?.leaveSide) return null;
        result.constraint = mark;
    }
    return result;
}
export function copyTraceRoutePoints(raw: unknown): TraceRoutePoint[] | null {
    if (!Array.isArray(raw) || raw.length > 10000) return null;
    const points: TraceRoutePoint[] = [];
    let sideMarks = 0;
    for (const value of raw) {
        const point = copyTraceRoutePoint(value);
        if (!point || (point.constraint && ++sideMarks > 256)) return null;
        points.push(point);
    }
    return points;
}
/** Existing pair layout remains compatible. Optional third item is a strict
 * versioned user/shape contract, never arbitrary feature properties. */
export function encodeTraceRoutePoint(point: TraceRoutePoint): unknown[] {
    const p = copyTraceRoutePoint(point);
    if (!p) throw Error('A route point or its user constraint is unreadable.');
    const meta =
        p.name !== undefined || p.constraint
            ? [
                  {
                      v: 1,
                      ...(p.name !== undefined ? { name: p.name } : {}),
                      ...(p.constraint ? { mark: p.constraint } : {}),
                      ...(p.shape ? { shape: true } : {}),
                      ...(p.auto ? { auto: true } : {}),
                  },
              ]
            : p.shape
              ? [1]
              : p.auto
                ? [2]
                : [];
    return [p.lat, p.lon, ...meta];
}
export function decodeTraceRoutePoints(raw: unknown): TraceRoutePoint[] | null {
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > 10000) return null;
    const points: TraceRoutePoint[] = [];
    for (const pair of raw) {
        if (!Array.isArray(pair) || pair.length < 2 || pair.length > 3) return null;
        const p: TraceRoutePoint = { lat: pair[0], lon: pair[1] };
        if (pair.length === 3) {
            const meta = pair[2];
            if (meta === 1) p.shape = true;
            else if (meta === 2) p.auto = true;
            else if (
                meta &&
                typeof meta === 'object' &&
                !Array.isArray(meta) &&
                meta.v === 1 &&
                Object.keys(meta).length > 1 &&
                Object.keys(meta).every((key) => ['v', 'mark', 'name', 'shape', 'auto'].includes(key))
            ) {
                if (meta.mark !== undefined) p.constraint = meta.mark;
                if (meta.name !== undefined) p.name = meta.name;
                if (meta.shape !== undefined) p.shape = meta.shape;
                if (meta.auto !== undefined) p.auto = meta.auto;
            } else return null;
        }
        points.push(p);
    }
    return copyTraceRoutePoints(points);
}
/** Reverse changes the named vessel side while preserving the same physical
 * passing point and forbidden half-line. It never carries verification. */
export function reverseTraceRoutePoints(points: readonly TraceRoutePoint[]): TraceRoutePoint[] {
    const clean = copyTraceRoutePoints(points);
    if (!clean) throw Error('The route constraints cannot be reversed.');
    return clean.reverse().map((p) =>
        p.constraint
            ? {
                  ...p,
                  constraint: {
                      ...p.constraint,
                      leaveSide: p.constraint.leaveSide === 'port' ? 'starboard' : 'port',
                      courseBearing: (p.constraint.courseBearing! + 180) % 360,
                  },
              }
            : p,
    );
}
