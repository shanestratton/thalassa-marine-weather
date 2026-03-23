/**
 * Isochrone Router — Geodesy utilities.
 *
 * Pure math functions for spherical Earth calculations:
 * haversine distance, initial bearing, position projection, TWA.
 */

export const R_NM = 3440.065; // Earth radius in NM
export const toRad = (d: number) => (d * Math.PI) / 180;
export const toDeg = (r: number) => (r * 180) / Math.PI;

export function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R_NM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export function initialBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x =
        Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function projectPosition(
    lat: number,
    lon: number,
    bearingDeg: number,
    distanceNm: number,
): { lat: number; lon: number } {
    const d = distanceNm / R_NM; // angular distance
    const brng = toRad(bearingDeg);
    const lat1 = toRad(lat);
    const lon1 = toRad(lon);

    const lat2 = Math.asin(Math.sin(lat1) * Math.cos(d) + Math.cos(lat1) * Math.sin(d) * Math.cos(brng));
    const lon2 =
        lon1 + Math.atan2(Math.sin(brng) * Math.sin(d) * Math.cos(lat1), Math.cos(d) - Math.sin(lat1) * Math.sin(lat2));

    // Normalise longitude to [-180, 180] (Fix 7: antimeridian safety)
    let lonDeg = toDeg(lon2);
    while (lonDeg > 180) lonDeg -= 360;
    while (lonDeg < -180) lonDeg += 360;
    return { lat: toDeg(lat2), lon: lonDeg };
}

/**
 * Calculate True Wind Angle given boat heading and wind direction.
 * Wind direction is "from" (meteorological convention).
 * Returns 0–180 (symmetric).
 */
export function calcTWA(boatHeadingDeg: number, windFromDeg: number): number {
    let diff = windFromDeg - boatHeadingDeg;
    // Normalise to -180..180
    while (diff > 180) diff -= 360;
    while (diff < -180) diff += 360;
    return Math.abs(diff);
}

/** Simple bearing between two points (degrees true, 0-360) */
export function bearingBetween(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const φ1 = (lat1 * Math.PI) / 180;
    const φ2 = (lat2 * Math.PI) / 180;
    const Δλ = ((lon2 - lon1) * Math.PI) / 180;
    const y = Math.sin(Δλ) * Math.cos(φ2);
    const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
    return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}
