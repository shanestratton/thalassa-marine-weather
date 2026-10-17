/** The full engine grid plus the lead-overlay envelope. A finished line may
 * not escape the area whose private negative constraints were actually read. */
export function routingAreaWindow(
    origin: { lat: number; lon: number },
    destination: { lat: number; lon: number },
): [number, number, number, number] {
    for (const p of [origin, destination])
        if (!Number.isFinite(p.lat) || !Number.isFinite(p.lon) || Math.abs(p.lat) > 85 || Math.abs(p.lon) > 180)
            throw Error('Route area bounds are unavailable for these coordinates.');
    const west = Math.min(origin.lon, destination.lon),
        east = Math.max(origin.lon, destination.lon);
    const south = Math.min(origin.lat, destination.lat),
        north = Math.max(origin.lat, destination.lat);
    if (east - west > 180) throw Error('Split the route at the dateline before checking route areas.');
    const pad = Math.max((east - west) * 0.5, (north - south) * 0.5, 0.1);
    return [
        Math.max(-180, west - pad),
        Math.max(-90, south - pad),
        Math.min(180, east + pad),
        Math.min(90, north + pad),
    ];
}

export function routeInsideAreaWindow(
    points: readonly (readonly [number, number])[],
    [west, south, east, north]: readonly [number, number, number, number],
): boolean {
    return (
        points.length >= 2 &&
        points.length <= 8192 &&
        points.every(
            (p, i) =>
                p.length === 2 &&
                p.every(Number.isFinite) &&
                p[0] >= west &&
                p[0] <= east &&
                p[1] >= south &&
                p[1] <= north &&
                (i === 0 || Math.abs(p[0] - points[i - 1][0]) <= 180),
        )
    );
}
