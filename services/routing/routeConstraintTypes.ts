/** Private user-authored choices only. This persistence leaf has no runtime imports. */
export interface RouteConstraintPoint {
    lat: number;
    lon: number;
    name?: string;
    leaveSide?: 'port' | 'starboard';
    /** Explicit user offset, never a claim of charted clearance. */
    standOffM?: number;
    /** Fixed route reference: a re-plan cannot rotate an accepted side. */
    courseBearing?: number;
}
export const MAX_ROUTE_VIAS = 256;
export function normaliseRouteConstraints(value: unknown, fixedSides = true): RouteConstraintPoint[] | null {
    if (!Array.isArray(value) || value.length > MAX_ROUTE_VIAS) return null;
    const result: RouteConstraintPoint[] = [];
    for (const raw of value) {
        if (!raw || typeof raw !== 'object') return null;
        const p = raw as RouteConstraintPoint;
        if (
            !Number.isFinite(p.lat) ||
            Math.abs(p.lat) > 90 ||
            !Number.isFinite(p.lon) ||
            Math.abs(p.lon) > 180 ||
            (p.name !== undefined && (typeof p.name !== 'string' || p.name.length > 100))
        )
            return null;
        const point: RouteConstraintPoint = {
            lat: p.lat,
            lon: p.lon,
            ...(p.name !== undefined ? { name: p.name } : {}),
        };
        if (p.leaveSide === undefined) {
            if (p.standOffM !== undefined || p.courseBearing !== undefined) return null;
        } else {
            if (
                !['port', 'starboard'].includes(p.leaveSide) ||
                !Number.isFinite(p.standOffM) ||
                p.standOffM! < 5 ||
                p.standOffM! > 2000 ||
                (p.courseBearing === undefined
                    ? fixedSides
                    : !Number.isFinite(p.courseBearing) || p.courseBearing < 0 || p.courseBearing >= 360)
            )
                return null;
            point.leaveSide = p.leaveSide;
            point.standOffM = p.standOffM;
            if (p.courseBearing !== undefined) point.courseBearing = p.courseBearing;
        }
        result.push(point);
    }
    return result;
}
