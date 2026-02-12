/**
 * Sea Route Utility
 * 
 * Generates smooth great-circle arcs between waypoints for map display.
 * The AI voyage planner already provides intermediate waypoints that route
 * around land masses — this utility simply connects those points with
 * curved great-circle segments instead of flat straight lines.
 * 
 * Great circle arcs are the shortest path on a sphere and naturally curve
 * on Mercator/Web-Mercator map projections, giving a realistic look.
 */

interface Coord { lat: number; lon: number; }

/** Degrees → Radians */
const toRad = (d: number) => d * Math.PI / 180;
/** Radians → Degrees */
const toDeg = (r: number) => r * 180 / Math.PI;

/**
 * Interpolate points along the great circle between two coordinates.
 * Uses the spherical interpolation (slerp) formula.
 * 
 * @param from - Start coordinate
 * @param to   - End coordinate  
 * @param numPoints - Number of intermediate points (excluding start & end)
 */
function greatCircleArc(from: Coord, to: Coord, numPoints: number = 20): Coord[] {
    const lat1 = toRad(from.lat), lon1 = toRad(from.lon);
    const lat2 = toRad(to.lat), lon2 = toRad(to.lon);

    // Angular distance (central angle) between the two points
    const d = Math.acos(
        Math.sin(lat1) * Math.sin(lat2) +
        Math.cos(lat1) * Math.cos(lat2) * Math.cos(lon2 - lon1)
    );

    // If points are very close (< ~1km), just return direct line
    if (d < 0.0001 || isNaN(d)) {
        return [from, to];
    }

    const points: Coord[] = [];
    const totalSteps = numPoints + 1; // +1 for the endpoint

    for (let i = 0; i <= totalSteps; i++) {
        const f = i / totalSteps;
        const A = Math.sin((1 - f) * d) / Math.sin(d);
        const B = Math.sin(f * d) / Math.sin(d);

        const x = A * Math.cos(lat1) * Math.cos(lon1) + B * Math.cos(lat2) * Math.cos(lon2);
        const y = A * Math.cos(lat1) * Math.sin(lon1) + B * Math.cos(lat2) * Math.sin(lon2);
        const z = A * Math.sin(lat1) + B * Math.sin(lat2);

        points.push({
            lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
            lon: toDeg(Math.atan2(y, x))
        });
    }

    return points;
}

/**
 * Calculate the distance in nautical miles between two coordinates (Haversine).
 */
function distanceNM(from: Coord, to: Coord): number {
    const R = 3440.065; // Earth radius in NM
    const dLat = toRad(to.lat - from.lat);
    const dLon = toRad(to.lon - from.lon);
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(toRad(from.lat)) * Math.cos(toRad(to.lat)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Generate a smooth route through all waypoints using great circle arcs.
 * 
 * Adaptively chooses the number of intermediate points based on segment
 * distance — short hops get fewer points, long ocean crossings get more
 * for a smooth curve on the map.
 * 
 * @param waypoints - Ordered array of coordinates (origin, via-points, destination)
 * @returns Array of coordinates forming smooth great-circle arcs
 */
export function generateSeaRoute(waypoints: Coord[]): Coord[] {
    if (waypoints.length < 2) return waypoints;

    const fullRoute: Coord[] = [];

    for (let i = 0; i < waypoints.length - 1; i++) {
        const from = waypoints[i];
        const to = waypoints[i + 1];
        const dist = distanceNM(from, to);

        // Adaptive point density: more points for longer segments
        const numPoints = dist < 10 ? 2       // Short hop: minimal
            : dist < 50 ? 5                    // Coastal: light
                : dist < 200 ? 15                  // Medium passage
                    : dist < 500 ? 25                  // Long passage
                        : 40;                              // Ocean crossing

        const segment = greatCircleArc(from, to, numPoints);

        if (i === 0) {
            fullRoute.push(...segment);
        } else {
            // Skip first point to avoid duplication at segment joints
            fullRoute.push(...segment.slice(1));
        }
    }

    return fullRoute;
}
