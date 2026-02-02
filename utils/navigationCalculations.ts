/**
 * Navigation Calculation Utilities
 * Core maritime calculations for distance, bearing, and position formatting
 */

/**
 * Calculate great circle distance between two points using Haversine formula
 * @param lat1 Starting latitude in decimal degrees
 * @param lon1 Starting longitude in decimal degrees
 * @param lat2 Ending latitude in decimal degrees
 * @param lon2 Ending longitude in decimal degrees
 * @returns Distance in nautical miles
 */
export function calculateDistance(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
): number {
    const R = 3440.065; // Earth radius in nautical miles
    const dLat = toRadians(lat2 - lat1);
    const dLon = toRadians(lon2 - lon1);

    const a =
        Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(toRadians(lat1)) *
        Math.cos(toRadians(lat2)) *
        Math.sin(dLon / 2) *
        Math.sin(dLon / 2);

    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

/**
 * Calculate initial bearing from point 1 to point 2
 * @param lat1 Starting latitude in decimal degrees
 * @param lon1 Starting longitude in decimal degrees
 * @param lat2 Ending latitude in decimal degrees
 * @param lon2 Ending longitude in decimal degrees
 * @returns Bearing in degrees (0-360)
 */
export function calculateBearing(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number
): number {
    const dLon = toRadians(lon2 - lon1);
    const lat1Rad = toRadians(lat1);
    const lat2Rad = toRadians(lat2);

    const y = Math.sin(dLon) * Math.cos(lat2Rad);
    const x =
        Math.cos(lat1Rad) * Math.sin(lat2Rad) -
        Math.sin(lat1Rad) * Math.cos(lat2Rad) * Math.cos(dLon);

    const bearing = Math.atan2(y, x);
    return (toDegrees(bearing) + 360) % 360;
}

/**
 * Format coordinates as Degrees, Minutes, Seconds (DMS)
 * @param lat Latitude in decimal degrees
 * @param lon Longitude in decimal degrees
 * @returns Formatted DMS string (e.g., "27°12.5'S 153°5.2'E")
 */
export function formatDMS(lat: number, lon: number): string {
    const latDeg = Math.abs(lat);
    const latMin = (latDeg % 1) * 60;
    const latDir = lat >= 0 ? 'N' : 'S';

    const lonDeg = Math.abs(lon);
    const lonMin = (lonDeg % 1) * 60;
    const lonDir = lon >= 0 ? 'E' : 'W';

    return `${Math.floor(latDeg)}°${latMin.toFixed(1)}'${latDir} ${Math.floor(lonDeg)}°${lonMin.toFixed(1)}'${lonDir}`;
}

/**
 * Convert decimal degrees to radians
 */
export function toRadians(degrees: number): number {
    return (degrees * Math.PI) / 180;
}

/**
 * Convert radians to decimal degrees
 */
export function toDegrees(radians: number): number {
    return (radians * 180) / Math.PI;
}

/**
 * Calculate speed in knots given distance and time
 * @param distanceNM Distance in nautical miles
 * @param timeHours Time in hours
 * @returns Speed in knots
 */
export function calculateSpeed(distanceNM: number, timeHours: number): number {
    if (timeHours === 0) return 0;
    return distanceNM / timeHours;
}

/**
 * Parse DMS string to decimal degrees
 * @param dms DMS string (e.g., "27°12.5'S" or "153°5.2'E")
 * @returns Decimal degrees
 */
export function parseDMS(dms: string): number {
    const regex = /(\d+)°(\d+(?:\.\d+)?)'([NSEW])/;
    const match = dms.match(regex);

    if (!match) {
        throw new Error(`Invalid DMS format: ${dms}`);
    }

    const degrees = parseInt(match[1], 10);
    const minutes = parseFloat(match[2]);
    const direction = match[3];

    let decimal = degrees + minutes / 60;

    if (direction === 'S' || direction === 'W') {
        decimal = -decimal;
    }

    return decimal;
}

/**
 * Validate latitude is within valid range
 */
export function isValidLatitude(lat: number): boolean {
    return lat >= -90 && lat <= 90;
}

/**
 * Validate longitude is within valid range
 */
export function isValidLongitude(lon: number): boolean {
    return lon >= -180 && lon <= 180;
}
