/**
 * Small spherical-geometry helpers for the Voyage Log renderer:
 *   • haversineNm  — great-circle distance in nautical miles
 *   • subSolarPoint — where the sun is directly overhead at a given UTC
 *   • nightPolygon  — GeoJSON polygon of the night hemisphere, for the
 *                     map's day/night terminator overlay
 *
 * All pure functions — no React, no SDK deps.
 */
import type { Feature, Polygon } from 'geojson';

const EARTH_RADIUS_NM = 3440.065;

/** Great-circle distance between two points, in nautical miles. */
export function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const toRad = Math.PI / 180;
    const phi1 = lat1 * toRad;
    const phi2 = lat2 * toRad;
    const dPhi = (lat2 - lat1) * toRad;
    const dLambda = (lon2 - lon1) * toRad;
    const a = Math.sin(dPhi / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin(dLambda / 2) ** 2;
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return EARTH_RADIUS_NM * c;
}

/**
 * Sub-solar point — the (lat, lon) on Earth where the sun is directly
 * overhead at the given UTC moment. Uses the standard NOAA formula
 * (good to a few arc-minutes, plenty for a visual overlay).
 */
export function subSolarPoint(date: Date): { lat: number; lon: number } {
    const toRad = Math.PI / 180;
    const toDeg = 180 / Math.PI;

    // Days since J2000.0
    const d = (date.getTime() - Date.UTC(2000, 0, 1, 12)) / 86400000;
    const g = (357.529 + 0.98560028 * d) * toRad; // mean anomaly
    const L = (280.459 + 0.98564736 * d) * toRad; // mean longitude
    const lambda = L + (1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * toRad; // ecliptic lon
    const epsilon = (23.439 - 0.00000036 * d) * toRad; // obliquity

    const dec = Math.asin(Math.sin(epsilon) * Math.sin(lambda)); // solar declination

    // Equation of time (minutes)
    const Ldeg = L * toDeg;
    const ra = Math.atan2(Math.cos(epsilon) * Math.sin(lambda), Math.cos(lambda)) * toDeg;
    const eot = 4 * (Ldeg - 0.0057183 - ra);

    const utcMinutes = date.getUTCHours() * 60 + date.getUTCMinutes() + date.getUTCSeconds() / 60;
    // Longitude where the sun is at local noon
    const subLon = -((utcMinutes + eot) / 4 - 180);
    // Normalize to -180..180
    const lon = ((((subLon + 180) % 360) + 360) % 360) - 180;

    return { lat: dec * toDeg, lon };
}

/**
 * GeoJSON polygon covering the night hemisphere at the given UTC moment.
 * Built by sampling the terminator (great circle 90° from the sub-solar
 * point) at every 2° of longitude, then closing the polygon down to the
 * dark pole. Returns null near the equinoxes (when sin(decl) ≈ 0 and the
 * formula degenerates) — drop the overlay rather than draw garbage.
 */
export function nightPolygon(date: Date): Feature<Polygon> | null {
    const sun = subSolarPoint(date);
    const slat = sun.lat;
    const slon = sun.lon;
    // Near-equinox: terminator approaches the meridian pair (slon±90); the
    // formula below blows up. The visual benefit at exact equinox is
    // small, so just skip those couple of days.
    if (Math.abs(slat) < 0.5) return null;

    const toRad = Math.PI / 180;
    const toDeg = 180 / Math.PI;
    const tanSlat = Math.tan(slat * toRad);

    const points: [number, number][] = [];
    for (let lon = -180; lon <= 180; lon += 2) {
        const dLon = (lon - slon) * toRad;
        const lat = Math.atan(-Math.cos(dLon) / tanSlat) * toDeg;
        points.push([lon, lat]);
    }

    // The dark pole — opposite sign from the sub-solar latitude.
    const darkPoleLat = slat > 0 ? -90 : 90;
    const firstLat = points[0][1];

    // Close: terminator line, drop to the dark pole, run along it, climb
    // back to the start of the terminator.
    const ring: [number, number][] = [...points, [180, darkPoleLat], [-180, darkPoleLat], [-180, firstLat]];

    return {
        type: 'Feature',
        properties: {},
        geometry: { type: 'Polygon', coordinates: [ring] },
    };
}
