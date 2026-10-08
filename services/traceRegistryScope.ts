/**
 * The bbox a route's chart-library fingerprint is scoped to: the route's
 * own extent plus a corridor pad. Writer (route check, Auto's review) and
 * checker (Cast Off, Auto's Save) MUST derive it from the same points with
 * the same pad, or the comparison is meaningless. [west, south, east, north].
 *
 * Its own module (package 125-06) so Auto's review hook can scope its
 * fingerprint without loading the route tracer; traceVerification re-exports it.
 */
export function traceRegistryScope(
    points: readonly { lat: number; lon: number }[] | undefined,
    padDeg = 0.5,
): [number, number, number, number] | undefined {
    if (!points || points.length === 0) return undefined;
    let west = Infinity;
    let south = Infinity;
    let east = -Infinity;
    let north = -Infinity;
    for (const point of points) {
        if (!Number.isFinite(point.lat) || !Number.isFinite(point.lon)) continue;
        west = Math.min(west, point.lon);
        east = Math.max(east, point.lon);
        south = Math.min(south, point.lat);
        north = Math.max(north, point.lat);
    }
    if (!Number.isFinite(west)) return undefined;
    return [west - padDeg, Math.max(-90, south - padDeg), east + padDeg, Math.min(90, north + padDeg)];
}
