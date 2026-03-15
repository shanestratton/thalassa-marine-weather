/**
 * Coordinate formatting utilities — handles both hemispheres correctly.
 *
 * Southern latitudes → S, Northern → N
 * Western longitudes → W, Eastern → E
 */

/** Format latitude with correct N/S hemisphere indicator */
export function fmtLat(lat: number | undefined | null, precision = 3): string {
    if (lat == null) return '--';
    const abs = Math.abs(lat).toFixed(precision);
    return `${abs}°${lat >= 0 ? 'N' : 'S'}`;
}

/** Format longitude with correct E/W hemisphere indicator */
export function fmtLon(lon: number | undefined | null, precision = 3): string {
    if (lon == null) return '--';
    const abs = Math.abs(lon).toFixed(precision);
    return `${abs}°${lon >= 0 ? 'E' : 'W'}`;
}

/** Format a lat/lon pair as a compact string, e.g. "27.217°S, 153.100°E" */
export function fmtCoord(lat: number | undefined | null, lon: number | undefined | null, precision = 3): string {
    return `${fmtLat(lat, precision)}, ${fmtLon(lon, precision)}`;
}
