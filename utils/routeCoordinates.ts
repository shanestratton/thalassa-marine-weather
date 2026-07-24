export interface RouteCoordinate {
    lat: number;
    lon: number;
}

/**
 * Return a Leaflet-safe copy of route geometry.
 *
 * Follow state is restored from localStorage and may also come from imported
 * logbook data, so map renderers must not trust it blindly. Exact (0, 0) is a
 * known missing-fix sentinel in the log pipeline; real equator/prime-meridian
 * positions remain valid as long as both axes are not zero.
 */
export function sanitizeRouteCoordinates(
    coordinates: readonly RouteCoordinate[] | null | undefined,
): RouteCoordinate[] {
    if (!coordinates) return [];

    const sanitized: RouteCoordinate[] = [];
    for (const coordinate of coordinates) {
        const lat = coordinate?.lat;
        const lon = coordinate?.lon;
        if (!Number.isFinite(lat) || !Number.isFinite(lon)) continue;
        if (lat < -90 || lat > 90 || lon < -180 || lon > 180) continue;
        if (lat === 0 && lon === 0) continue;

        const previous = sanitized[sanitized.length - 1];
        if (previous?.lat === lat && previous.lon === lon) continue;
        sanitized.push({ lat, lon });
    }

    return sanitized;
}
