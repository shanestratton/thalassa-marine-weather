/**
 * WeatherRoutingService — Optimal passage routing with weather awareness.
 *
 * Computes great-circle and rhumb-line routes between waypoints,
 * samples weather forecasts along the route at configurable intervals,
 * and provides ETA/distance/fuel estimates.
 *
 * Architecture:
 *   Route = ordered list of RouteWaypoints
 *   Each leg is subdivided into RouteSegments (~10nm each)
 *   Each segment gets weather data from the forecast grid
 *   Polar data (if available) adjusts speed predictions
 */

// ── Types ──────────────────────────────────────────────────────

export interface RouteWaypoint {
    id: string;
    lat: number;
    lon: number;
    name: string;
    isStart?: boolean;
    isEnd?: boolean;
    arrivalTime?: string; // ISO — estimated arrival
    distanceFromStart?: number; // nm
}

export interface RouteSegment {
    startLat: number;
    startLon: number;
    endLat: number;
    endLon: number;
    bearing: number; // degrees true
    distance: number; // nm
    cumulativeDistance: number;

    // Weather at segment midpoint (populated by forecast lookup)
    weather?: SegmentWeather;

    // Depth at segment midpoint (populated by GEBCO query)
    depth_m?: number | null;
    depthSafety?: 'safe' | 'caution' | 'danger' | 'land' | null;
    depthCostMultiplier?: number; // 1.0 = no penalty, higher = avoid
}

export interface SegmentWeather {
    windSpeed: number | null; // kts
    windDirection: number | null; // degrees true
    waveHeight: number | null; // meters
    swellPeriod: number | null; // seconds
    current?: number | null; // kts (if available)
    hasForecast: boolean;
}

export interface RouteAnalysis {
    waypoints: RouteWaypoint[];
    segments: RouteSegment[];
    totalDistance: number; // nm
    estimatedDuration: number; // hours
    departureTime: string; // ISO
    arrivalTime: string; // ISO
    averageSpeed: number; // kts (assumed or polar-derived)
    fuelEstimate: number | null; // liters (if engine hours available)

    // Weather summary along route
    maxWindSpeed: number | null;
    maxWaveHeight: number | null;
    headwindPercentage: number; // % of route with headwind
    favorablePercentage: number; // % with favorable conditions

    // Depth summary along route (populated by enhanceRouteWithDepth)
    minDepth: number | null; // shallowest point (negative = below sea level)
    shallowSegments: number; // count of segments with depth caution/danger

    // Coordinates for polyline rendering
    routeCoordinates: [number, number][];
}

export interface RoutingConfig {
    speed: number; // assumed average speed in kts
    departureTime: Date;
    segmentLength: number; // nm per segment (default: 10)
    fuelRate: number | null; // liters/hour (null = no fuel calc)
    avoidHeavyWeather: boolean;
    maxWindThreshold: number; // kts — threshold for "heavy weather"
    maxWaveThreshold: number; // meters
    vesselDraft: number; // meters — vessel draft for depth penalties
}

const DEFAULT_CONFIG: RoutingConfig = {
    speed: 6, // 6 kts cruising
    departureTime: new Date(),
    segmentLength: 10,
    fuelRate: null,
    avoidHeavyWeather: false,
    maxWindThreshold: 30,
    maxWaveThreshold: 3,
    vesselDraft: 2.5, // 2.5m default draft
};

// ── Route Computation ──────────────────────────────────────────

/**
 * Compute a complete route analysis between waypoints.
 */
export function computeRoute(waypoints: RouteWaypoint[], config: Partial<RoutingConfig> = {}): RouteAnalysis {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    if (waypoints.length < 2) {
        return emptyAnalysis(waypoints, cfg);
    }

    const segments: RouteSegment[] = [];
    let totalDistance = 0;

    // Generate segments between each pair of waypoints
    for (let i = 0; i < waypoints.length - 1; i++) {
        const from = waypoints[i];
        const to = waypoints[i + 1];
        const legSegments = subdivideGreatCircle(from.lat, from.lon, to.lat, to.lon, cfg.segmentLength);

        for (const seg of legSegments) {
            seg.cumulativeDistance = totalDistance + seg.distance;
            totalDistance += seg.distance;
            segments.push(seg);
        }

        // Tag waypoint with cumulative distance
        to.distanceFromStart = totalDistance;
    }

    // Calculate time estimates
    const estimatedDuration = totalDistance / cfg.speed;
    const departure = cfg.departureTime;
    const arrival = new Date(departure.getTime() + estimatedDuration * 3600000);

    // Tag waypoints with ETAs
    waypoints[0].isStart = true;
    waypoints[0].arrivalTime = departure.toISOString();
    waypoints[0].distanceFromStart = 0;
    waypoints[waypoints.length - 1].isEnd = true;
    waypoints[waypoints.length - 1].arrivalTime = arrival.toISOString();

    for (let i = 1; i < waypoints.length - 1; i++) {
        const dist = waypoints[i].distanceFromStart || 0;
        const hoursToWP = dist / cfg.speed;
        waypoints[i].arrivalTime = new Date(departure.getTime() + hoursToWP * 3600000).toISOString();
    }

    // Build route polyline coordinates
    const routeCoordinates: [number, number][] = [];
    if (segments.length > 0) {
        routeCoordinates.push([segments[0].startLat, segments[0].startLon]);
        for (const seg of segments) {
            routeCoordinates.push([seg.endLat, seg.endLon]);
        }
    }

    // Weather summary (populated after forecast lookup)
    const weatherSegments = segments.filter((s) => s.weather?.hasForecast);
    const maxWindSpeed =
        weatherSegments.length > 0 ? Math.max(...weatherSegments.map((s) => s.weather!.windSpeed || 0)) : null;
    const maxWaveHeight =
        weatherSegments.length > 0 ? Math.max(...weatherSegments.map((s) => s.weather!.waveHeight || 0)) : null;

    // Calculate headwind/favorable percentages based on bearing vs wind
    let headwindSegs = 0;
    let favorableSegs = 0;
    for (const seg of weatherSegments) {
        if (seg.weather?.windDirection != null) {
            const relAngle = Math.abs(angleDiff(seg.bearing, seg.weather.windDirection));
            if (relAngle < 60) headwindSegs++; // Wind coming from ahead
            if (relAngle > 120) favorableSegs++; // Wind from behind
        }
    }

    const headwindPercentage =
        weatherSegments.length > 0 ? Math.round((headwindSegs / weatherSegments.length) * 100) : 0;
    const favorablePercentage =
        weatherSegments.length > 0 ? Math.round((favorableSegs / weatherSegments.length) * 100) : 0;

    return {
        waypoints,
        segments,
        totalDistance: Math.round(totalDistance * 10) / 10,
        estimatedDuration: Math.round(estimatedDuration * 10) / 10,
        departureTime: departure.toISOString(),
        arrivalTime: arrival.toISOString(),
        averageSpeed: cfg.speed,
        fuelEstimate: cfg.fuelRate ? Math.round(estimatedDuration * cfg.fuelRate) : null,
        maxWindSpeed,
        maxWaveHeight,
        headwindPercentage,
        favorablePercentage,
        minDepth: null, // Populated by enhanceRouteWithDepth()
        shallowSegments: 0,
        routeCoordinates,
    };
}

// ── Depth Enhancement ──────────────────────────────────────────

/**
 * Enhance a RouteAnalysis with GEBCO depth data.
 *
 * Queries the GEBCO depth service for the midpoint of each segment,
 * then tags segments with depth_m, depthSafety, and depthCostMultiplier.
 *
 * Also updates minDepth and shallowSegments on the RouteAnalysis.
 *
 * Non-blocking — returns original analysis if depth query fails.
 */
export async function enhanceRouteWithDepth(
    analysis: RouteAnalysis,
    vesselDraft: number = 2.5,
): Promise<RouteAnalysis> {
    try {
        const { GebcoDepthService } = await import('./GebcoDepthService');

        // Build midpoints for each segment
        const midpoints = analysis.segments.map((seg) => ({
            lat: (seg.startLat + seg.endLat) / 2,
            lon: (seg.startLon + seg.endLon) / 2,
        }));

        const depthResults = await GebcoDepthService.queryRouteDepths(midpoints);

        // Tag each segment with depth data
        let minDepth: number | null = null;
        let shallowCount = 0;

        for (let i = 0; i < analysis.segments.length && i < depthResults.length; i++) {
            const depth = depthResults[i].depth_m;
            analysis.segments[i].depth_m = depth;
            analysis.segments[i].depthSafety = GebcoDepthService.classifyDepth(depth, vesselDraft);
            analysis.segments[i].depthCostMultiplier = GebcoDepthService.depthCostPenalty(depth, vesselDraft);

            if (depth !== null && depth < 0) {
                if (minDepth === null || depth > minDepth) {
                    minDepth = depth; // Less negative = shallower
                }
            }

            const safety = analysis.segments[i].depthSafety;
            if (safety === 'caution' || safety === 'danger') {
                shallowCount++;
            }
        }

        analysis.minDepth = minDepth;
        analysis.shallowSegments = shallowCount;

        return analysis;
    } catch (err) {
        console.warn('[WeatherRouting] Depth enhancement failed (non-critical):', err);
        return analysis;
    }
}

// ── Great Circle Subdivision ───────────────────────────────────

function subdivideGreatCircle(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
    maxSegmentNm: number,
): RouteSegment[] {
    const totalDist = haversineNm(lat1, lon1, lat2, lon2);
    const numSegments = Math.max(1, Math.ceil(totalDist / maxSegmentNm));
    const segments: RouteSegment[] = [];

    for (let i = 0; i < numSegments; i++) {
        const frac1 = i / numSegments;
        const frac2 = (i + 1) / numSegments;

        const p1 = interpolateGreatCircle(lat1, lon1, lat2, lon2, frac1);
        const p2 = interpolateGreatCircle(lat1, lon1, lat2, lon2, frac2);

        const segDist = haversineNm(p1.lat, p1.lon, p2.lat, p2.lon);
        const bearing = initialBearing(p1.lat, p1.lon, p2.lat, p2.lon);

        segments.push({
            startLat: p1.lat,
            startLon: p1.lon,
            endLat: p2.lat,
            endLon: p2.lon,
            bearing,
            distance: segDist,
            cumulativeDistance: 0, // Will be set by caller
        });
    }

    return segments;
}

// ── Geodesy Helpers ────────────────────────────────────────────

function toRad(deg: number): number {
    return deg * (Math.PI / 180);
}
function toDeg(rad: number): number {
    return rad * (180 / Math.PI);
}

function haversineNm(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 3440.065; // Earth radius in nautical miles
    const dLat = toRad(lat2 - lat1);
    const dLon = toRad(lon2 - lon1);
    const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
    return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function initialBearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLon = toRad(lon2 - lon1);
    const y = Math.sin(dLon) * Math.cos(toRad(lat2));
    const x =
        Math.cos(toRad(lat1)) * Math.sin(toRad(lat2)) - Math.sin(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.cos(dLon);
    return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

function interpolateGreatCircle(
    lat1: number,
    lon1: number,
    lat2: number,
    lon2: number,
    fraction: number,
): { lat: number; lon: number } {
    const phi1 = toRad(lat1),
        lam1 = toRad(lon1);
    const phi2 = toRad(lat2),
        lam2 = toRad(lon2);

    const d =
        2 *
        Math.asin(
            Math.sqrt(
                Math.sin((phi2 - phi1) / 2) ** 2 + Math.cos(phi1) * Math.cos(phi2) * Math.sin((lam2 - lam1) / 2) ** 2,
            ),
        );

    if (d < 1e-10) return { lat: lat1, lon: lon1 };

    const a = Math.sin((1 - fraction) * d) / Math.sin(d);
    const b = Math.sin(fraction * d) / Math.sin(d);

    const x = a * Math.cos(phi1) * Math.cos(lam1) + b * Math.cos(phi2) * Math.cos(lam2);
    const y = a * Math.cos(phi1) * Math.sin(lam1) + b * Math.cos(phi2) * Math.sin(lam2);
    const z = a * Math.sin(phi1) + b * Math.sin(phi2);

    return {
        lat: toDeg(Math.atan2(z, Math.sqrt(x * x + y * y))),
        lon: toDeg(Math.atan2(y, x)),
    };
}

function angleDiff(a: number, b: number): number {
    let diff = ((b - a + 180) % 360) - 180;
    if (diff < -180) diff += 360;
    return diff;
}

// ── Formatting Helpers ─────────────────────────────────────────

export function formatDistance(nm: number): string {
    if (nm < 1) return `${Math.round(nm * 1852)}m`;
    return `${nm.toFixed(1)} nm`;
}

export function formatDuration(hours: number): string {
    if (hours < 1) return `${Math.round(hours * 60)} min`;
    const h = Math.floor(hours);
    const m = Math.round((hours - h) * 60);
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
}

export function formatETA(isoStr: string): string {
    const d = new Date(isoStr);
    const now = new Date();
    const isToday = d.toDateString() === now.toDateString();
    const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return isToday ? `Today ${time}` : `${d.toLocaleDateString([], { weekday: 'short', day: 'numeric' })} ${time}`;
}

function emptyAnalysis(waypoints: RouteWaypoint[], cfg: RoutingConfig): RouteAnalysis {
    return {
        waypoints,
        segments: [],
        totalDistance: 0,
        estimatedDuration: 0,
        departureTime: cfg.departureTime.toISOString(),
        arrivalTime: cfg.departureTime.toISOString(),
        averageSpeed: cfg.speed,
        fuelEstimate: null,
        maxWindSpeed: null,
        maxWaveHeight: null,
        headwindPercentage: 0,
        favorablePercentage: 0,
        minDepth: null,
        shallowSegments: 0,
        routeCoordinates: [],
    };
}
