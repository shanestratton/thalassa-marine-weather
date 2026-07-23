/**
 * @filesize-justified Supabase Edge Function — separate deploy unit, not part of client bundle.
 */
// deno-lint-ignore-file
import {
    findWW3TemporalBracket,
    interpolateWaveConditions,
    requiredWW3ForecastHours,
    sampleWW3Shard,
    validateWW3Metadata,
    validateWW3Shard,
    WW3_METADATA_FILE,
    WW3ValidationError,
    type WW3Metadata,
    type WaveConditions,
} from '../_shared/ww3.ts';
import {
    alignWeatherKitHours,
    densifyCenterlineForMesh,
    MAX_CORRIDOR_WIDTH_NM,
    MAX_ROUTE_FORECAST_HOURS,
    MAX_ROUTE_MESH_NODES,
    MAX_ROUTE_REQUEST_BYTES,
    MAX_WEATHER_SAMPLE_POINTS,
    RouteWeatherSafetyError,
    validateWeatherRouteRequest,
} from '../_shared/route-weather-safety.ts';
import { requireAuthenticatedOrPublicQuota, withCors } from '../_shared/auth-rate-limit.ts';

declare const Deno: {
    serve: (handler: (req: Request) => Promise<Response> | Response) => void;
    env: { get(key: string): string | undefined };
};

/**
 * route-weather — 4D Corridor Weather Router
 *
 * Takes a bathymetric-safe centerline route and optimizes it through
 * a time-dependent weather corridor mesh. The A* cost function
 * evaluates wind/wave forecasts at each node's estimated arrival time.
 *
 * Architecture:
 *   1. Generate corridor mesh (lateral nodes ±15/30 NM of centerline)
 *   2. Fetch weather forecast for corridor bounding box
 *   3. Run time-stepped A* where g-time tracks hours from departure
 *   4. At each node expansion, interpolate weather for (lat, lon, time)
 *   5. Apply sail-vs-power penalty based on vessel profile
 *
 * Weather Sources:
 *   - WeatherKit hourly wind via proxy, aligned to the requested departure
 *   - Validated, pre-decoded NOAA WaveWatch III cache shards for waves
 *
 * There is intentionally no synthetic weather or unsafe route fallback.
 * Missing wind, wave, or land-mask coverage produces an explicit failure.
 */

// ── CORS ──────────────────────────────────────────────────────────

const CORS: Record<string, string> = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization, apikey',
};

function corsResponse(body: BodyInit | null, status: number, extra?: Record<string, string>) {
    return new Response(body, { status, headers: { ...CORS, ...extra } });
}

function jsonResponse(data: unknown, status = 200) {
    return corsResponse(JSON.stringify(data), status, {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
}

// ══════════════════════════════════════════════════════════════════════
// TYPES
// ══════════════════════════════════════════════════════════════════════

interface CenterlineWaypoint {
    lat: number;
    lon: number;
    depth_m?: number;
    name?: string;
}

interface VesselParams {
    type: 'sail' | 'power';
    cruising_speed_kts: number; // Target speed in knots
    max_wind_kts: number; // Absolute wind limit
    max_wave_m: number; // Absolute wave limit
    draft_m: number; // Hull draft below waterline
    polar_data?: PolarData | null; // Optional polar performance matrix
}

interface PolarData {
    windSpeeds: number[]; // TWS columns (kts)
    angles: number[]; // TWA rows (degrees, 0-180)
    matrix: number[][]; // matrix[angleIdx][windSpeedIdx] = boat speed (kts)
}

/** A single node in the corridor mesh */
interface MeshNode {
    id: number; // Unique node ID
    lat: number;
    lon: number;
    centerIdx: number; // Which centerline segment this belongs to
    lateralOffset: number; // -2, -1, 0, +1, +2 (port to starboard)
    depth_m?: number;
    isUnsafeDepth?: boolean; // True if GEBCO depth does not clear draft + margin
    arrivalTimeH?: number;
}

/** Weather sample at a point in spacetime */
interface WeatherSample {
    windSpeed: number; // True wind speed (kts)
    windGust: number; // Forecast gust speed (kts)
    windDir: number; // True wind direction (degrees, FROM)
    waveHeight: number; // Significant wave height (m)
    waveDirection: number; // Primary wave direction (degrees, FROM)
    swellPeriod?: number; // Swell period (s)
}

/** A* node in the priority queue */
interface AStarNode4D {
    nodeId: number; // MeshNode id
    gCost: number; // Accumulated cost (hours * penalty)
    gTime: number; // Accumulated time (hours from departure)
    fCost: number; // gCost + heuristic
}

// ══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════════════

const EARTH_RADIUS_NM = 3440.065;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

// Default corridor parameters
const DEFAULT_CORRIDOR_WIDTH_NM = 30;
const DEFAULT_LATERAL_STEPS = 2; // ±15 NM, ±30 NM

// Penalty weights
const GALE_PENALTY = 3.0; // Massive penalty near limits

// Coastal pilotage corridor constants
const SEAMARK_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — chart data rarely changes
const CHANNEL_BUFFER_DEG = 0.00005; // ~5.5m safety buffer for vessel beam
const CHANNEL_BBOX_RADIUS_NM = 5; // How far from marina to search for seamarks
const OVERPASS_TIMEOUT = 25; // Overpass API timeout in seconds

// ══════════════════════════════════════════════════════════════════════
// SAFE-WATER CORRIDOR — Maritime Pilotage (Law of the Sea)
//
// Architecture:
//   Phase 1: Dynamic seamark ingestion from OpenStreetMap (Overpass API)
//   Phase 2: IALA Region B polygon builder (port/starboard gate pairing)
//   Phase 3: A* cost function override (strict geometric boundary)
//
// This ensures the vessel follows marked channels when departing or
// arriving at a marina, before handing off to the open-ocean corridor.
// ══════════════════════════════════════════════════════════════════════

/** OSM seamark element from Overpass API */
interface SeamarkElement {
    type: 'node' | 'way' | 'relation';
    id: number;
    lat?: number;
    lon?: number;
    tags: Record<string, string>;
    bounds?: { minlat: number; minlon: number; maxlat: number; maxlon: number };
    geometry?: { lat: number; lon: number }[];
}

/** A navigational mark with position and IALA classification */
interface NavMark {
    lat: number;
    lon: number;
    type: string; // seamark:type (e.g. 'beacon_lateral', 'buoy_lateral')
    category: string; // 'port' | 'starboard' | 'cardinal' | 'safe_water' | 'unknown'
    name: string;
    distFromOrigin: number; // nm from marina — computed after ingestion
}

/** A gate formed by pairing port and starboard marks */
interface ChannelGate {
    port: NavMark;
    starboard: NavMark;
    centerLat: number;
    centerLon: number;
    widthNM: number;
    distFromOrigin: number;
}

/** The navigable polygon + ordered gates for A* constraint */
interface SafeWaterCorridor {
    polygon: [number, number][]; // [lon, lat][] ring (closed)
    gates: ChannelGate[];
    handshakePoint: { lat: number; lon: number }; // Where channel meets open water
    valid: boolean;
}

// Seamark cache (in-memory for the Edge Function lifecycle)
const seamarkCache = new Map<string, { data: SeamarkElement[]; fetchedAt: number }>();

// ── Phase 1: Dynamic Seamark Ingestion ─────────────────────────────

/**
 * Fetch navigational marks from Overpass API for a bounding box around a point.
 * Returns lateral beacons, buoys, cardinal marks, and safe water marks.
 * Cached for 24h — chart data rarely changes.
 */
async function fetchSeamarks(
    lat: number,
    lon: number,
    radiusNM: number = CHANNEL_BBOX_RADIUS_NM,
): Promise<SeamarkElement[]> {
    // Build bounding box (~5nm around the marina)
    const latDelta = radiusNM / 60; // 1nm ≈ 1 minute of latitude
    const lonDelta = radiusNM / (60 * Math.cos(lat * DEG_TO_RAD));
    const bbox = `${(lat - latDelta).toFixed(4)},${(lon - lonDelta).toFixed(4)},${(lat + latDelta).toFixed(4)},${(lon + lonDelta).toFixed(4)}`;

    // Check cache
    const cacheKey = bbox;
    const cached = seamarkCache.get(cacheKey);
    if (cached && Date.now() - cached.fetchedAt < SEAMARK_CACHE_TTL_MS) {
        console.info(`[Pilotage] Seamark cache HIT: ${cached.data.length} elements`);
        return cached.data;
    }

    const query = `
    [out:json][timeout:${OVERPASS_TIMEOUT}];
    (
      node["seamark:type"](${bbox});
      way["seamark:type"](${bbox});
      relation["seamark:type"](${bbox});
    );
    out geom;
    `;

    try {
        console.info(`[Pilotage] Fetching seamarks for bbox ${bbox}...`);
        const res = await fetch('https://overpass-api.de/api/interpreter', {
            method: 'POST',
            body: query,
        });

        if (!res.ok) {
            console.warn(`[Pilotage] Overpass API error: ${res.status}`);
            return [];
        }

        const data = await res.json();
        const elements: SeamarkElement[] = data.elements || [];
        console.info(`[Pilotage] ✅ Fetched ${elements.length} seamark elements`);

        // Cache it
        seamarkCache.set(cacheKey, { data: elements, fetchedAt: Date.now() });
        return elements;
    } catch (err) {
        console.warn(`[Pilotage] Overpass fetch failed:`, err);
        return [];
    }
}

// ── Phase 2: IALA Channel Polygon Builder ──────────────────────────

// ── IALA Region Detection ──────────────────────────────────────

type IALARegion = 'A' | 'B';

/**
 * Determine the IALA Maritime Buoyage Region for a given coordinate.
 *
 * IALA Region A (Red to Port):
 *   Europe, Africa, Australia/NZ, most of Asia, Middle East,
 *   India, Russia, South America (Pacific coast)
 *
 * IALA Region B (Red to Starboard — "Red Right Returning"):
 *   North America, Central America, Caribbean, South America (Atlantic coast),
 *   Japan, South Korea, Philippines
 *
 * The function uses bounding-box checks for Region B territories.
 * Everything else defaults to Region A.
 */
function determineIALARegion(lat: number, lon: number): IALARegion {
    // ── Region B territories ──

    // North America (continental US, Canada, Mexico)
    if (lat > 14 && lat < 72 && lon > -170 && lon < -50) return 'B';

    // Central America & Caribbean
    if (lat > 5 && lat <= 14 && lon > -110 && lon < -60) return 'B';

    // Caribbean islands (wider box)
    if (lat > 10 && lat < 28 && lon > -90 && lon < -59) return 'B';

    // South America — Atlantic coast (east of Andes, roughly lon > -60)
    // Brazil, Argentina, Uruguay, Venezuela, Guyana, Suriname
    if (lat > -56 && lat < 14 && lon > -60 && lon < -30) return 'B';

    // Japan
    if (lat > 24 && lat < 46 && lon > 122 && lon < 154) return 'B';

    // South Korea
    if (lat > 33 && lat < 39 && lon > 124 && lon < 132) return 'B';

    // Philippines
    if (lat > 4 && lat < 22 && lon > 116 && lon < 128) return 'B';

    // US Pacific territories (Hawaii, Guam, etc.)
    // Hawaii
    if (lat > 18 && lat < 23 && lon > -161 && lon < -154) return 'B';
    // Guam / Mariana Islands
    if (lat > 13 && lat < 21 && lon > 144 && lon < 146) return 'B';

    // Everything else: Region A
    return 'A';
}

/**
 * Classify an OSM seamark element into port/starboard/cardinal/safe_water.
 *
 * The classification depends on the IALA Maritime Buoyage Region:
 *
 *   Region A (Europe, Australia, Africa, most of Asia):
 *     Red = Port (left when entering from sea)
 *     Green = Starboard (right when entering from sea)
 *
 *   Region B (Americas, Japan, Korea, Philippines):
 *     Red = Starboard (right when entering — "Red Right Returning")
 *     Green = Port (left when entering)
 *
 * We detect colour from seamark:beacon_lateral:colour or
 * seamark:buoy_lateral:colour tags, then apply the region-specific mapping.
 */
function classifyMark(tags: Record<string, string>, region: IALARegion): string {
    const seamarkType = tags['seamark:type'] || '';

    // Cardinal marks — same in both regions
    if (seamarkType.includes('cardinal')) return 'cardinal';
    if (seamarkType.includes('safe_water')) return 'safe_water';

    // Lateral marks — colour depends on IALA region
    if (seamarkType.includes('lateral')) {
        // Check explicit category tags first (these are authoritative)
        const category = tags['seamark:beacon_lateral:category'] || tags['seamark:buoy_lateral:category'] || '';

        if (category === 'port') return 'port';
        if (category === 'starboard') return 'starboard';

        // Fall back to colour + IALA region mapping
        const colour =
            tags['seamark:beacon_lateral:colour'] ||
            tags['seamark:buoy_lateral:colour'] ||
            tags['seamark:lateral:colour'] ||
            '';

        if (colour) {
            if (region === 'A') {
                // Region A: Red = Port, Green = Starboard
                if (colour === 'red') return 'port';
                if (colour === 'green') return 'starboard';
            } else {
                // Region B: Red = Starboard, Green = Port
                if (colour === 'red') return 'starboard';
                if (colour === 'green') return 'port';
            }
        }

        // Fallback: detect from shape (same meaning in both regions)
        // Cylinder/Can = Port, Cone/Triangle = Starboard
        const shape = tags['seamark:beacon_lateral:shape'] || tags['seamark:buoy_lateral:shape'] || '';
        if (shape === 'cylinder' || shape === 'can') return 'port';
        if (shape === 'cone' || shape === 'conical') return 'starboard';
    }

    return 'unknown';
}

/**
 * Parse Overpass elements into classified NavMarks with distance from origin.
 * Automatically detects the IALA region from the origin coordinates.
 */
function parseNavMarks(elements: SeamarkElement[], originLat: number, originLon: number): NavMark[] {
    const region = determineIALARegion(originLat, originLon);
    console.info(`[Pilotage] IALA Region: ${region} (${region === 'A' ? 'Red=Port' : 'Red=Starboard "RRR"'})`);

    const marks: NavMark[] = [];

    for (const el of elements) {
        const tags = el.tags || {};
        const seamarkType = tags['seamark:type'] || '';

        // Only process navigational marks (lateral, cardinal, safe_water)
        if (
            !seamarkType.includes('lateral') &&
            !seamarkType.includes('cardinal') &&
            !seamarkType.includes('safe_water')
        )
            continue;

        // Get position
        let lat = el.lat;
        let lon = el.lon;
        if (!lat || !lon) {
            // Ways and relations may have bounds instead
            if (el.bounds) {
                lat = (el.bounds.minlat + el.bounds.maxlat) / 2;
                lon = (el.bounds.minlon + el.bounds.maxlon) / 2;
            } else if (el.geometry && el.geometry.length > 0) {
                lat = el.geometry[0].lat;
                lon = el.geometry[0].lon;
            } else continue;
        }

        marks.push({
            lat,
            lon,
            type: seamarkType,
            category: classifyMark(tags, region),
            name: tags['name'] || tags['seamark:name'] || `Mark ${el.id}`,
            distFromOrigin: haversineNM(originLat, originLon, lat, lon),
        });
    }

    return marks;
}

/**
 * Build a safe-water corridor polygon from paired port/starboard marks.
 *
 * Algorithm:
 *   1. Separate marks into port and starboard lists
 *   2. Sort both by distance from marina (ascending)
 *   3. Pair closest port/starboard marks into sequential gates
 *   4. Build polygon: port_1 → port_2 → ... → port_n → stb_n → ... → stb_1
 *   5. Close the polygon
 *
 * The polygon represents the navigable deep-water channel.
 * The "handshake point" is the center of the outermost gate —
 * where pilotage ends and open-ocean routing begins.
 */
function buildSafeWaterCorridor(marks: NavMark[], originLat: number, originLon: number): SafeWaterCorridor {
    const portMarks = marks.filter((m) => m.category === 'port').sort((a, b) => a.distFromOrigin - b.distFromOrigin);
    const stbMarks = marks
        .filter((m) => m.category === 'starboard')
        .sort((a, b) => a.distFromOrigin - b.distFromOrigin);

    console.info(`[Pilotage] Port marks: ${portMarks.length}, Starboard marks: ${stbMarks.length}`);

    // Need at least 2 pairs to form a meaningful channel
    if (portMarks.length < 2 || stbMarks.length < 2) {
        console.warn(`[Pilotage] Insufficient lateral marks for channel polygon`);
        return {
            polygon: [],
            gates: [],
            handshakePoint: { lat: originLat, lon: originLon },
            valid: false,
        };
    }

    // Pair port and starboard marks into gates
    // Use the shorter list length
    const numGates = Math.min(portMarks.length, stbMarks.length);
    const gates: ChannelGate[] = [];

    for (let i = 0; i < numGates; i++) {
        const p = portMarks[i];
        const s = stbMarks[i];
        gates.push({
            port: p,
            starboard: s,
            centerLat: (p.lat + s.lat) / 2,
            centerLon: (p.lon + s.lon) / 2,
            widthNM: haversineNM(p.lat, p.lon, s.lat, s.lon),
            distFromOrigin: (p.distFromOrigin + s.distFromOrigin) / 2,
        });
    }

    gates.sort((a, b) => a.distFromOrigin - b.distFromOrigin);

    // Build polygon: port side out, starboard side back
    // Include origin point to close the marina end
    const polygonPoints: [number, number][] = [];

    // Origin (marina) to first port mark
    polygonPoints.push([originLon, originLat]);

    // Port side outbound (increasing distance)
    for (const gate of gates) {
        polygonPoints.push([gate.port.lon, gate.port.lat]);
    }

    // Starboard side inbound (decreasing distance)
    for (let i = gates.length - 1; i >= 0; i--) {
        polygonPoints.push([gates[i].starboard.lon, gates[i].starboard.lat]);
    }

    // Close the polygon (back to origin)
    polygonPoints.push([originLon, originLat]);

    // Handshake point = center of the outermost gate
    const lastGate = gates[gates.length - 1];
    const handshakePoint = { lat: lastGate.centerLat, lon: lastGate.centerLon };

    console.info(`[Pilotage] ✅ Channel polygon: ${polygonPoints.length} vertices, ${gates.length} gates`);
    console.info(
        `[Pilotage] Handshake point: ${handshakePoint.lat.toFixed(4)}, ${handshakePoint.lon.toFixed(4)} (${lastGate.distFromOrigin.toFixed(2)} nm from marina)`,
    );

    return {
        polygon: polygonPoints,
        gates,
        handshakePoint,
        valid: true,
    };
}

// ── Phase 3: Point-in-Polygon & A* Constraint ─────────────────────

/**
 * Ray-casting point-in-polygon test.
 * Returns true if the point (lon, lat) is inside the polygon ring.
 *
 * Uses the crossing number algorithm: cast a ray from the point
 * eastward and count how many edges it crosses. Odd = inside.
 */
function pointInPolygon(lon: number, lat: number, polygon: [number, number][]): boolean {
    let inside = false;
    const n = polygon.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = polygon[i][0],
            yi = polygon[i][1];
        const xj = polygon[j][0],
            yj = polygon[j][1];
        if (yi > lat !== yj > lat && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) {
            inside = !inside;
        }
    }
    return inside;
}

/**
 * Generate a high-resolution corridor mesh inside the channel polygon.
 *
 * Unlike the ocean mesh (±30nm with 2 lateral steps), the channel mesh
 * follows the gate centerlines with tight lateral sampling bounded by
 * the polygon.
 *
 * Returns ordered waypoints through the channel: origin → gate centers → handshake.
 */
function generateChannelCenterline(
    corridor: SafeWaterCorridor,
    originLat: number,
    originLon: number,
): CenterlineWaypoint[] {
    if (!corridor.valid || corridor.gates.length === 0) return [];

    const waypoints: CenterlineWaypoint[] = [];

    // Start at origin (marina berth)
    waypoints.push({ lat: originLat, lon: originLon, name: 'Marina' });

    // Add gate centers as waypoints (ordered by distance)
    for (let i = 0; i < corridor.gates.length; i++) {
        const gate = corridor.gates[i];
        waypoints.push({
            lat: gate.centerLat,
            lon: gate.centerLon,
            name: `Gate ${i + 1} (${gate.widthNM.toFixed(3)} nm)`,
        });
    }

    // Add handshake point (transition to open ocean)
    waypoints.push({
        lat: corridor.handshakePoint.lat,
        lon: corridor.handshakePoint.lon,
        name: 'Channel Exit',
    });

    return waypoints;
}

/**
 * Build a complete departure or arrival corridor:
 *   1. Fetch seamarks from Overpass API
 *   2. Parse and classify marks (IALA Region B)
 *   3. Build channel polygon
 *   4. Generate channel centerline
 *
 * Returns the safe-water corridor and its centerline waypoints.
 */
async function buildCoastalCorridor(
    lat: number,
    lon: number,
    label: string = 'departure',
): Promise<{ corridor: SafeWaterCorridor; centerline: CenterlineWaypoint[]; marks: NavMark[] }> {
    console.info(`[Pilotage] Building ${label} corridor at ${lat.toFixed(4)}, ${lon.toFixed(4)}...`);

    const elements = await fetchSeamarks(lat, lon);
    const marks = parseNavMarks(elements, lat, lon);

    console.info(`[Pilotage] ${marks.length} navigational marks classified:`);
    const categoryCounts: Record<string, number> = {};
    for (const m of marks) {
        categoryCounts[m.category] = (categoryCounts[m.category] || 0) + 1;
    }
    for (const [cat, count] of Object.entries(categoryCounts)) {
        console.info(`  ${cat}: ${count}`);
    }

    const corridor = buildSafeWaterCorridor(marks, lat, lon);
    const centerline = generateChannelCenterline(corridor, lat, lon);

    return { corridor, centerline, marks };
}

/**
 * Stitch a 3-leg route:
 *   Leg 1: Departure channel (marina → handshake point)
 *   Leg 2: Open ocean (handshake → arrival handshake)
 *   Leg 3: Arrival channel (handshake point → destination marina)
 *
 * If no channel data is available for departure/arrival (e.g. offshore
 * anchorage), the corresponding leg is skipped and the ocean leg
 * extends to the origin/destination directly.
 */
function stitchThreeLegCenterline(
    departureCorridor: { corridor: SafeWaterCorridor; centerline: CenterlineWaypoint[] },
    oceanCenterline: CenterlineWaypoint[],
    arrivalCorridor: { corridor: SafeWaterCorridor; centerline: CenterlineWaypoint[] },
): {
    centerline: CenterlineWaypoint[];
    departureCorridor: SafeWaterCorridor | null;
    arrivalCorridor: SafeWaterCorridor | null;
    legBoundaries: { departureEndIdx: number; arrivalStartIdx: number };
} {
    const stitched: CenterlineWaypoint[] = [];

    // Leg 1: Departure channel
    const hasDeparture = departureCorridor.corridor.valid && departureCorridor.centerline.length > 1;
    if (hasDeparture) {
        for (const wp of departureCorridor.centerline) {
            stitched.push(wp);
        }
        console.info(`[Stitcher] Departure leg: ${departureCorridor.centerline.length} waypoints`);
    }

    const departureEndIdx = stitched.length;

    // Leg 2: Ocean (skip first/last if they duplicate the handshake points)
    const oceanStart = hasDeparture ? 1 : 0; // Skip first ocean WP if departure provides handshake
    const hasArrival = arrivalCorridor.corridor.valid && arrivalCorridor.centerline.length > 1;
    const oceanEnd = hasArrival ? oceanCenterline.length - 1 : oceanCenterline.length;

    for (let i = oceanStart; i < oceanEnd; i++) {
        stitched.push(oceanCenterline[i]);
    }

    const arrivalStartIdx = stitched.length;

    // Leg 3: Arrival channel (reversed — ocean to marina)
    if (hasArrival) {
        // Arrival centerline is origin→gates→exit, but we enter from exit→gates→origin
        const reversed = [...arrivalCorridor.centerline].reverse();
        for (const wp of reversed) {
            stitched.push(wp);
        }
        console.info(`[Stitcher] Arrival leg: ${arrivalCorridor.centerline.length} waypoints`);
    }

    console.info(
        `[Stitcher] ✅ Stitched route: ${stitched.length} total waypoints (D:${departureEndIdx}/A:${arrivalStartIdx})`,
    );

    return {
        centerline: stitched,
        departureCorridor: hasDeparture ? departureCorridor.corridor : null,
        arrivalCorridor: hasArrival ? arrivalCorridor.corridor : null,
        legBoundaries: { departureEndIdx, arrivalStartIdx },
    };
}

// ══════════════════════════════════════════════════════════════════════
// SPHERICAL GEOMETRY
// ══════════════════════════════════════════════════════════════════════

/** Haversine distance in nautical miles */
function haversineNM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLat = (lat2 - lat1) * DEG_TO_RAD;
    const dLon = (lon2 - lon1) * DEG_TO_RAD;
    const a =
        Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(a));
}

/** Initial bearing from point 1 to point 2 (degrees, clockwise from north) */
function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLon = (lon2 - lon1) * DEG_TO_RAD;
    const y = Math.sin(dLon) * Math.cos(lat2 * DEG_TO_RAD);
    const x =
        Math.cos(lat1 * DEG_TO_RAD) * Math.sin(lat2 * DEG_TO_RAD) -
        Math.sin(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.cos(dLon);
    return (Math.atan2(y, x) * RAD_TO_DEG + 360) % 360;
}

/**
 * Compute a destination point given start, bearing, and distance.
 * Uses the Vincenty direct formula (spherical approximation).
 */
function destinationPoint(lat: number, lon: number, bearingDeg: number, distNM: number): { lat: number; lon: number } {
    const angDist = distNM / EARTH_RADIUS_NM;
    const brng = bearingDeg * DEG_TO_RAD;
    const latR = lat * DEG_TO_RAD;
    const lonR = lon * DEG_TO_RAD;

    const lat2 = Math.asin(Math.sin(latR) * Math.cos(angDist) + Math.cos(latR) * Math.sin(angDist) * Math.cos(brng));
    const lon2 =
        lonR +
        Math.atan2(
            Math.sin(brng) * Math.sin(angDist) * Math.cos(latR),
            Math.cos(angDist) - Math.sin(latR) * Math.sin(lat2),
        );

    return { lat: lat2 * RAD_TO_DEG, lon: ((lon2 * RAD_TO_DEG + 540) % 360) - 180 };
}

/** Alias for Trip Sandwich handshake projection */
const projectPoint = destinationPoint;

// ══════════════════════════════════════════════════════════════════════
// CORRIDOR MESH GENERATION
// ══════════════════════════════════════════════════════════════════════

/**
 * Generate lateral nodes perpendicular to the route centerline.
 *
 * For each centerline waypoint, creates nodes at offsets:
 *   -N, ..., -1, 0, +1, ..., +N
 * where N = lateralSteps, spacing = corridorWidth / lateralSteps
 *
 * Negative = port side, Positive = starboard side
 *
 * The perpendicular bearing is calculated from the average heading
 * at each waypoint (average of bearing-to-next and bearing-from-prev).
 *
 * Example with lateralSteps=2, corridorWidth=30:
 *   -30 NM  -15 NM  [centerline]  +15 NM  +30 NM
 *     ●        ●         ●          ●        ●       ← one row
 *
 * Each row connects forward to the next row (5×5 = 25 edges per segment).
 *
 * @returns MeshNode[] — all nodes in the corridor mesh
 */
function generateCorridorMesh(
    centerline: CenterlineWaypoint[],
    corridorWidthNM: number = DEFAULT_CORRIDOR_WIDTH_NM,
    lateralSteps: number = DEFAULT_LATERAL_STEPS,
): MeshNode[] {
    const nodes: MeshNode[] = [];
    const stepNM = corridorWidthNM / lateralSteps;
    let nodeId = 0;

    for (let ci = 0; ci < centerline.length; ci++) {
        const wp = centerline[ci];

        // Calculate the perpendicular bearing at this waypoint
        let perpBearing: number;

        if (ci === 0) {
            // First point: use bearing to next
            const fwdBearing = bearing(wp.lat, wp.lon, centerline[ci + 1].lat, centerline[ci + 1].lon);
            perpBearing = (fwdBearing + 90) % 360;
        } else if (ci === centerline.length - 1) {
            // Last point: use bearing from previous
            const fwdBearing = bearing(centerline[ci - 1].lat, centerline[ci - 1].lon, wp.lat, wp.lon);
            perpBearing = (fwdBearing + 90) % 360;
        } else {
            // Middle point: average of bearings in/out
            const bIn = bearing(centerline[ci - 1].lat, centerline[ci - 1].lon, wp.lat, wp.lon);
            const bOut = bearing(wp.lat, wp.lon, centerline[ci + 1].lat, centerline[ci + 1].lon);
            // Average bearing handling wrap-around
            const avgBearing = averageBearing(bIn, bOut);
            perpBearing = (avgBearing + 90) % 360;
        }

        // Generate lateral offsets: -N ... 0 ... +N
        for (let offset = -lateralSteps; offset <= lateralSteps; offset++) {
            let lat: number, lon: number;

            if (offset === 0) {
                // Centerline node
                lat = wp.lat;
                lon = wp.lon;
            } else {
                // Lateral offset along perpendicular bearing
                const distNM = Math.abs(offset) * stepNM;
                const offsetBearing = offset > 0 ? perpBearing : (perpBearing + 180) % 360;
                const dest = destinationPoint(wp.lat, wp.lon, offsetBearing, distNM);
                lat = dest.lat;
                lon = dest.lon;
            }

            nodes.push({
                id: nodeId++,
                lat,
                lon,
                centerIdx: ci,
                lateralOffset: offset,
                depth_m: offset === 0 ? wp.depth_m : undefined,
            });
        }
    }

    console.info(
        `[WeatherRouter] Generated corridor mesh: ${nodes.length} nodes (${centerline.length} rows × ${2 * lateralSteps + 1} cols)`,
    );
    return nodes;
}

/**
 * Variable-width corridor mesh — same structure as generateCorridorMesh,
 * but each row uses its own corridor width. This allows tight corridors
 * near marinas (coastal legs) and wide corridors in open ocean.
 *
 * IMPORTANT: All rows still have the same number of columns (nodesPerRow)
 * so the adjacency graph structure is preserved.
 */
function generateCorridorMeshVariable(
    centerline: CenterlineWaypoint[],
    perRowCorridorWidth: number[],
    lateralSteps: number = DEFAULT_LATERAL_STEPS,
): MeshNode[] {
    const nodes: MeshNode[] = [];
    let nodeId = 0;

    for (let ci = 0; ci < centerline.length; ci++) {
        const wp = centerline[ci];
        const rowCorridorWidth = perRowCorridorWidth[ci] ?? DEFAULT_CORRIDOR_WIDTH_NM;
        const stepNM = rowCorridorWidth / lateralSteps;

        // Calculate the perpendicular bearing at this waypoint
        let perpBearing: number;

        if (ci === 0) {
            const fwdBearing = bearing(wp.lat, wp.lon, centerline[ci + 1].lat, centerline[ci + 1].lon);
            perpBearing = (fwdBearing + 90) % 360;
        } else if (ci === centerline.length - 1) {
            const fwdBearing = bearing(centerline[ci - 1].lat, centerline[ci - 1].lon, wp.lat, wp.lon);
            perpBearing = (fwdBearing + 90) % 360;
        } else {
            const bIn = bearing(centerline[ci - 1].lat, centerline[ci - 1].lon, wp.lat, wp.lon);
            const bOut = bearing(wp.lat, wp.lon, centerline[ci + 1].lat, centerline[ci + 1].lon);
            const avgBearing = averageBearing(bIn, bOut);
            perpBearing = (avgBearing + 90) % 360;
        }

        // Generate lateral offsets: -N ... 0 ... +N
        for (let offset = -lateralSteps; offset <= lateralSteps; offset++) {
            let lat: number, lon: number;

            if (offset === 0) {
                lat = wp.lat;
                lon = wp.lon;
            } else {
                const distNM = Math.abs(offset) * stepNM;
                const offsetBearing = offset > 0 ? perpBearing : (perpBearing + 180) % 360;
                const dest = destinationPoint(wp.lat, wp.lon, offsetBearing, distNM);
                lat = dest.lat;
                lon = dest.lon;
            }

            nodes.push({
                id: nodeId++,
                lat,
                lon,
                centerIdx: ci,
                lateralOffset: offset,
                depth_m: offset === 0 ? wp.depth_m : undefined,
            });
        }
    }

    // Log row widths for debugging
    const coastalRows = perRowCorridorWidth.filter((w) => w < DEFAULT_CORRIDOR_WIDTH_NM).length;
    console.info(
        `[WeatherRouter] Generated variable mesh: ${nodes.length} nodes (${centerline.length} rows × ${2 * lateralSteps + 1} cols, ${coastalRows} coastal rows)`,
    );
    return nodes;
}

// ══════════════════════════════════════════════════════════════════════
// GEBCO LAND MASK — Elevation-based land detection
//
// Uses the same Cloud-Optimized GeoTIFF (GEBCO/ETOPO) that powers
// route-bathymetric. Each mesh node is checked against actual terrain
// elevation: if shallower than draft + clearance → isUnsafeDepth → A* skips it.
//
// This replaces the unreliable weather-based heuristic that guessed
// land from zero wind/waves (failed in calm conditions and near rivers).
// ══════════════════════════════════════════════════════════════════════

// @ts-ignore: Deno ESM import
import { fromUrl } from 'https://esm.sh/geotiff@2.1.3?bundle-deps&target=deno';

const SUPABASE_URL_ENV = Deno.env.get('SUPABASE_URL') || '';
const LANDMASK_COG_URL = `${SUPABASE_URL_ENV}/storage/v1/object/public/gebco-tiles/thalassa_bathymetry_global.tif`;
const LANDMASK_MAX_GRID = 1200;
const LANDMASK_MAX_CELL_NM = 1.25;
const UNSAFE_ELEVATION_SENTINEL_M = 32767;

interface ElevationGrid {
    elevation: Int16Array;
    rows: number;
    cols: number;
    lats: number[];
    lons: number[];
    minimumSafeDepthM: number;
}

/**
 * Fetch GEBCO elevation data for a bounding box.
 * Returns a grid of elevation values (negative = underwater, positive = land).
 *
 * Uses HTTP Range requests via the COG format — only downloads the
 * tiles covering the bounding box, not the entire global file.
 */
async function fetchElevationGrid(
    minLat: number,
    maxLat: number,
    minLon: number,
    maxLon: number,
    minimumSafeDepthM: number,
): Promise<ElevationGrid | null> {
    if (!SUPABASE_URL_ENV) return null;
    try {
        const tiff = await fromUrl(LANDMASK_COG_URL);
        const image = await tiff.getImage(0);
        const imgWidth = image.getWidth();
        const imgHeight = image.getHeight();

        let west: number, south: number, east: number, north: number;
        try {
            [west, south, east, north] = image.getBoundingBox();
        } catch (e) {
            console.warn('[index]', e);
            const tp = image.fileDirectory.ModelTiepoint;
            const ps = image.fileDirectory.ModelPixelScale;
            if (tp && ps) {
                west = tp[3];
                north = tp[4];
                east = tp[3] + ps[0] * imgWidth;
                south = tp[4] - ps[1] * imgHeight;
            } else {
                return null;
            }
        }

        const xScale = imgWidth / (east - west);
        const yScale = imgHeight / (north - south);
        const clampLon = (v: number) => Math.max(west, Math.min(east, v));
        const clampLat = (v: number) => Math.max(south, Math.min(north, v));

        const x0 = Math.max(0, Math.floor((clampLon(minLon) - west) * xScale));
        const x1 = Math.min(imgWidth, Math.ceil((clampLon(maxLon) - west) * xScale));
        const y0 = Math.max(0, Math.floor((north - clampLat(maxLat)) * yScale));
        const y1 = Math.min(imgHeight, Math.ceil((north - clampLat(minLat)) * yScale));

        const baseCols = x1 - x0;
        const baseRows = y1 - y0;

        // Downsample for performance — we just need land/water, not precise depth
        const ds = Math.max(1, Math.ceil(Math.max(baseCols, baseRows) / LANDMASK_MAX_GRID));
        const outCols = Math.min(LANDMASK_MAX_GRID, Math.ceil(baseCols / ds));
        const outRows = Math.min(LANDMASK_MAX_GRID, Math.ceil(baseRows / ds));

        if (outCols < 2 || outRows < 2) return null;

        const rasters = await image.readRasters({
            window: [x0, y0, x1, y1],
            width: outCols,
            height: outRows,
        });

        const rawData = rasters[0] as Float32Array | Int16Array | Int32Array;
        const advertisedNoData = Number(image.getGDALNoData?.());
        const elevation = new Int16Array(rawData.length);
        for (let i = 0; i < rawData.length; i++) {
            const value = Number(rawData[i]);
            elevation[i] =
                !Number.isFinite(value) ||
                value < -12_000 ||
                value > 9_000 ||
                (Number.isFinite(advertisedNoData) && value === advertisedNoData)
                    ? UNSAFE_ELEVATION_SENTINEL_M
                    : Math.round(value);
        }

        // Build coordinate arrays
        const globalPxLon = (east - west) / imgWidth;
        const globalPxLat = (north - south) / imgHeight;
        const winWest = west + x0 * globalPxLon;
        const winNorth = north - y0 * globalPxLat;
        const winEast = west + x1 * globalPxLon;
        const winSouth = north - y1 * globalPxLat;

        const pxLon = (winEast - winWest) / outCols;
        const pxLat = (winNorth - winSouth) / outRows;
        const midLat = (winNorth + winSouth) / 2;
        const maxCellNM = Math.max(
            Math.abs(pxLat) * 60,
            Math.abs(pxLon) * 60 * Math.max(0.1, Math.cos(midLat * DEG_TO_RAD)),
        );
        if (!Number.isFinite(maxCellNM) || maxCellNM > LANDMASK_MAX_CELL_NM) {
            console.warn(
                `[LandMask] Requested area would produce ${maxCellNM.toFixed(2)} NM cells; maximum is ${LANDMASK_MAX_CELL_NM} NM`,
            );
            return null;
        }
        const lats = new Array(outRows);
        const lons = new Array(outCols);
        for (let r = 0; r < outRows; r++) lats[r] = winNorth - (r + 0.5) * pxLat;
        for (let c = 0; c < outCols; c++) lons[c] = winWest + (c + 0.5) * pxLon;

        console.info(`[LandMask] GEBCO grid ${outCols}×${outRows} (${ds}× ds) loaded for the request corridor`);
        return { elevation, rows: outRows, cols: outCols, lats, lons, minimumSafeDepthM };
    } catch (err) {
        console.warn(`[LandMask] Failed to fetch GEBCO elevation:`, err);
        return null;
    }
}

/**
 * Apply GEBCO land and minimum-depth gating to corridor mesh nodes.
 *
 * For each mesh node, finds the nearest elevation grid cell.
 * Any cell shallower than the vessel's draft plus clearance is impassable.
 */
async function applyLandMask(
    nodes: MeshNode[],
    requiredPoints: CenterlineWaypoint[] = [],
    minimumSafeDepthM = 0,
): Promise<{ blockedCount: number; grid: ElevationGrid }> {
    if (nodes.length === 0) {
        throw new RouteWeatherSafetyError('Cannot build a land mask for an empty mesh', 422, 'land_mask_unavailable');
    }

    // Compute bounding box of all mesh nodes
    let minLat = Infinity,
        maxLat = -Infinity;
    let minLon = Infinity,
        maxLon = -Infinity;
    for (const node of nodes) {
        if (node.lat < minLat) minLat = node.lat;
        if (node.lat > maxLat) maxLat = node.lat;
        if (node.lon < minLon) minLon = node.lon;
        if (node.lon > maxLon) maxLon = node.lon;
    }
    for (const point of requiredPoints) {
        if (point.lat < minLat) minLat = point.lat;
        if (point.lat > maxLat) maxLat = point.lat;
        if (point.lon < minLon) minLon = point.lon;
        if (point.lon > maxLon) maxLon = point.lon;
    }
    // Add 0.1° buffer (~11km) to ensure edge nodes are covered
    minLat -= 0.1;
    maxLat += 0.1;
    minLon -= 0.1;
    maxLon += 0.1;

    const grid = await fetchElevationGrid(minLat, maxLat, minLon, maxLon, minimumSafeDepthM);
    if (!grid) {
        throw new RouteWeatherSafetyError(
            'Verified GEBCO land-mask coverage is unavailable at a safe resolution',
            503,
            'land_mask_unavailable',
        );
    }

    const { elevation, rows, cols, lats, lons } = grid;
    let blockedCount = 0;

    for (const node of nodes) {
        // Find nearest grid cell (simple nearest-neighbor lookup)
        let bestRow = 0,
            bestRowDist = Infinity;
        for (let r = 0; r < rows; r++) {
            const d = Math.abs(lats[r] - node.lat);
            if (d < bestRowDist) {
                bestRow = r;
                bestRowDist = d;
            }
        }
        let bestCol = 0,
            bestColDist = Infinity;
        for (let c = 0; c < cols; c++) {
            const d = Math.abs(lons[c] - node.lon);
            if (d < bestColDist) {
                bestCol = c;
                bestColDist = d;
            }
        }

        const elev = elevation[bestRow * cols + bestCol];
        // Never echo caller-provided depth as verified route data. The route
        // output uses the same request-local GEBCO sample that drives safety
        // and preserves the public GEBCO convention (negative = below datum).
        node.depth_m = elev;
        node.isUnsafeDepth = elev > -minimumSafeDepthM;
        if (node.isUnsafeDepth) {
            blockedCount++;
        }
    }

    console.info(
        `[LandMask] ${blockedCount} land/shallow nodes blocked out of ${nodes.length} total (${((blockedCount / nodes.length) * 100).toFixed(1)}%)`,
    );
    return { blockedCount, grid };
}

/**
 * Check if a straight-line segment between two points crosses land.
 *
 * Samples the line at ~0.1 NM (~185m) intervals and checks each
 * sample point against the cached GEBCO elevation grid.
 * Returns true if ANY sample point is above sea level.
 *
 * This is the "line of sight" check that prevents A* from
 * connecting two water nodes via a path that crosses land.
 */
function segmentCrossesLand(grid: ElevationGrid, lat1: number, lon1: number, lat2: number, lon2: number): boolean {
    const { elevation, rows, cols, lats, lons, minimumSafeDepthM } = grid;

    const dLat = Math.abs(lat2 - lat1);
    const dLon = Math.abs(lon2 - lon1);
    if (dLat < 1e-8 && dLon < 1e-8) return false;

    // Use grid bounds for O(1) index lookup instead of linear search
    const latMax = lats[0],
        latMin = lats[rows - 1]; // lats are N→S
    const lonMin = lons[0],
        lonMax = lons[cols - 1];
    const latRange = latMax - latMin;
    const lonRange = lonMax - lonMin;
    if (latRange <= 0 || lonRange <= 0) return true;

    const latCellNM = (latRange / Math.max(1, rows - 1)) * 60;
    const meanLat = (lat1 + lat2) / 2;
    const lonCellNM = (lonRange / Math.max(1, cols - 1)) * 60 * Math.max(0.1, Math.cos(meanLat * DEG_TO_RAD));
    const sampleStepNM = Math.max(0.05, Math.min(0.5, latCellNM / 2, lonCellNM / 2));
    const numSamples = Math.max(2, Math.ceil(haversineNM(lat1, lon1, lat2, lon2) / sampleStepNM));
    if (numSamples > 5000) return true;

    for (let s = 0; s <= numSamples; s++) {
        const t = s / numSamples;
        const sLat = lat1 + (lat2 - lat1) * t;
        const sLon = lon1 + (lon2 - lon1) * t;

        // Direct index computation (O(1) instead of O(N))
        const ri = Math.round(((latMax - sLat) / latRange) * (rows - 1));
        const ci = Math.round(((sLon - lonMin) / lonRange) * (cols - 1));

        // Bounds check
        if (ri < 0 || ri >= rows || ci < 0 || ci >= cols) return true;

        if (elevation[ri * cols + ci] > -minimumSafeDepthM) {
            return true; // 🔴 Crosses land or water shallower than the vessel clearance!
        }
    }
    return false;
}

/** Average two bearings, handling wrap-around */
function averageBearing(b1: number, b2: number): number {
    const x = Math.cos(b1 * DEG_TO_RAD) + Math.cos(b2 * DEG_TO_RAD);
    const y = Math.sin(b1 * DEG_TO_RAD) + Math.sin(b2 * DEG_TO_RAD);
    return (Math.atan2(y, x) * RAD_TO_DEG + 360) % 360;
}

/**
 * Get the adjacency list for the corridor mesh.
 *
 * Connectivity rules:
 *   - Each node in row `i` connects to the same or adjacent lateral
 *     column in row `i+1`
 *   - No backward edges (row i+1 → row i)
 *   - No edges within the same row (forces forward progress)
 *
 * Limiting a row transition to one lateral step prevents physically
 * implausible 60+ NM side-jumps that would undersample changing weather.
 * The result remains a DAG, so the search terminates without cycles.
 */
function buildAdjacencyList(nodes: MeshNode[], nodesPerRow: number, numRows: number): Map<number, number[]> {
    const adj = new Map<number, number[]>();

    for (let row = 0; row < numRows - 1; row++) {
        const rowStart = row * nodesPerRow;
        const nextRowStart = (row + 1) * nodesPerRow;

        for (let col = 0; col < nodesPerRow; col++) {
            const fromId = rowStart + col;
            const neighbors: number[] = [];

            for (let nc = Math.max(0, col - 1); nc <= Math.min(nodesPerRow - 1, col + 1); nc++) {
                neighbors.push(nextRowStart + nc);
            }

            adj.set(fromId, neighbors);
        }
    }

    return adj;
}

// ══════════════════════════════════════════════════════════════════════
// WEATHER GRID — Fetch & Interpolation
// ══════════════════════════════════════════════════════════════════════

/**
 * The weather grid stores hourly forecasts on a lat/lon grid.
 * We pre-fetch the entire corridor's bounding box from WeatherKit
 * (via our Supabase proxy), then interpolate per-node.
 */
interface WeatherGrid {
    /** Hourly samples indexed by grid key "lat,lon" → hour index → sample */
    data: Map<string, WeatherSample[]>;
    /** Grid resolution in degrees */
    resolution: number;
    /** Start time (Unix ms) */
    startTime: number;
    /** Hours of forecast available */
    hoursAvailable: number;
    /** Validated WW3 model metadata used to populate every wave sample */
    waveMetadata?: WW3Metadata;
    /** Bounding box */
    minLat: number;
    maxLat: number;
    minLon: number;
    maxLon: number;
}

/**
 * Fetch weather forecast for the corridor bounding box.
 *
 * Strategy:
 *   1. Sample the corridor at ~0.5° resolution grid points
 *   2. For each grid point, fetch WeatherKit hourly (via our edge function proxy)
 *   3. Store in a Map for O(1) lookup during A* expansion
 *
 * For a 800 NM passage with 30 NM corridor width:
 *   ~20 lat steps × ~3 lon steps = ~60 grid points
 *   Each grid point = 1 WeatherKit API call (hourly, 240h forecast)
 *   Total: ~60 calls, parallelized in batches of 10
 */
function weatherGridKey(lat: number, lon: number): string {
    return `${Math.round(lat * 100) / 100},${Math.round(lon * 100) / 100}`;
}

async function readBoundedText(
    source: { headers: Headers; body: ReadableStream<Uint8Array> | null },
    maxBytes: number,
): Promise<string | null> {
    const advertisedSize = Number(source.headers.get('content-length') || '0');
    if (Number.isFinite(advertisedSize) && advertisedSize > maxBytes) return null;
    if (!source.body) return '';

    const reader = source.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) {
                await reader.cancel();
                return null;
            }
            chunks.push(value);
        }
    } finally {
        reader.releaseLock();
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
    }
    return new TextDecoder().decode(bytes);
}

async function readBoundedJsonResponse(
    response: Response,
    maxBytes: number,
    label: string,
    code: string,
): Promise<unknown> {
    const text = await readBoundedText(response, maxBytes);
    if (text === null) {
        throw new RouteWeatherSafetyError(`${label} payload exceeds the safe size limit`, 503, code);
    }
    try {
        return JSON.parse(text);
    } catch {
        throw new RouteWeatherSafetyError(`${label} returned invalid JSON`, 503, code);
    }
}

function buildWeatherSamplePoints(nodes: MeshNode[], resolution: number): { lat: number; lon: number }[] {
    const keys = new Set<string>();
    for (const node of nodes) {
        const lat0 = Math.floor(node.lat / resolution) * resolution;
        const lon0 = Math.floor(node.lon / resolution) * resolution;
        for (const lat of [lat0, lat0 + resolution]) {
            for (const lon of [lon0, lon0 + resolution]) {
                keys.add(weatherGridKey(lat, lon));
            }
        }
    }
    if (keys.size > MAX_WEATHER_SAMPLE_POINTS) {
        throw new RouteWeatherSafetyError(
            `Route requires ${keys.size} weather points; the safe processing limit is ${MAX_WEATHER_SAMPLE_POINTS}`,
            413,
            'weather_grid_too_large',
        );
    }
    return [...keys].map((key) => {
        const [lat, lon] = key.split(',').map(Number);
        return { lat, lon };
    });
}

async function fetchWeatherGrid(nodes: MeshNode[], departureTime: Date, maxHours: number): Promise<WeatherGrid> {
    if (!Number.isInteger(maxHours) || maxHours < 1 || maxHours > MAX_ROUTE_FORECAST_HOURS) {
        throw new RouteWeatherSafetyError(
            'Required route duration exceeds verified forecast coverage',
            422,
            'forecast_horizon_insufficient',
        );
    }
    // Compute bounding box of all mesh nodes
    let minLat = Infinity,
        maxLat = -Infinity;
    let minLon = Infinity,
        maxLon = -Infinity;
    for (const n of nodes) {
        minLat = Math.min(minLat, n.lat);
        maxLat = Math.max(maxLat, n.lat);
        minLon = Math.min(minLon, n.lon);
        maxLon = Math.max(maxLon, n.lon);
    }

    const resolution = 0.5; // ~30 NM grid spacing
    const grid: WeatherGrid = {
        data: new Map(),
        resolution,
        startTime: departureTime.getTime(),
        hoursAvailable: maxHours,
        minLat,
        maxLat,
        minLon,
        maxLon,
    };

    const samplePoints = buildWeatherSamplePoints(nodes, resolution);

    console.info(
        `[WeatherRouter] Fetching weather for ${samplePoints.length} grid points (${(maxLat - minLat).toFixed(1)}° × ${(maxLon - minLon).toFixed(1)}°)`,
    );

    // Fetch in parallel batches of 10
    const BATCH_SIZE = 10;
    const supabaseUrl = Deno.env.get('SUPABASE_URL') || '';
    const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') || '';
    if (!supabaseUrl || !serviceRoleKey) {
        throw new RouteWeatherSafetyError('Weather service is not configured', 503, 'wind_forecast_unavailable');
    }
    const hourlyStart = new Date(departureTime.getTime() - 2 * 60 * 60 * 1000).toISOString();
    const hourlyEnd = new Date(departureTime.getTime() + (maxHours + 2) * 60 * 60 * 1000).toISOString();

    for (let i = 0; i < samplePoints.length; i += BATCH_SIZE) {
        const batch = samplePoints.slice(i, i + BATCH_SIZE);

        const results = await Promise.all(
            batch.map(async (pt) => {
                const url = `${supabaseUrl}/functions/v1/fetch-weatherkit`;
                const resp = await fetch(url, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        Authorization: `Bearer ${serviceRoleKey}`,
                        apikey: serviceRoleKey,
                    },
                    body: JSON.stringify({
                        lat: pt.lat,
                        lon: pt.lon,
                        dataSets: ['forecastHourly'],
                        hourlyStart,
                        hourlyEnd,
                        timezone: 'UTC',
                    }),
                    signal: AbortSignal.timeout(12000),
                });

                if (!resp.ok) {
                    throw new RouteWeatherSafetyError(
                        'WeatherKit failed for a corridor sample',
                        503,
                        'wind_forecast_unavailable',
                    );
                }

                const data = (await readBoundedJsonResponse(
                    resp,
                    2 * 1024 * 1024,
                    'WeatherKit',
                    'wind_forecast_unavailable',
                )) as any;
                const aligned = alignWeatherKitHours(data?.forecastHourly?.hours, departureTime.getTime(), maxHours);
                const samples: WeatherSample[] = aligned.map((sample) => ({
                    ...sample,
                    waveHeight: Number.NaN,
                    waveDirection: Number.NaN,
                    swellPeriod: undefined,
                }));
                return { key: weatherGridKey(pt.lat, pt.lon), samples };
            }),
        );

        for (const result of results) {
            grid.data.set(result.key, result.samples);
        }
    }

    if (grid.data.size !== samplePoints.length) {
        throw new RouteWeatherSafetyError(
            'WeatherKit did not return complete corridor coverage',
            503,
            'wind_forecast_unavailable',
        );
    }

    console.info(`[WeatherRouter] WeatherKit grid loaded: ${grid.data.size} points, ${grid.hoursAvailable}h horizon`);
    await enrichGridWithWaveData(grid, supabaseUrl);
    return grid;
}

/**
 * Enrich every aligned hourly wind sample from validated, pre-decoded WW3
 * shards. Shards are fetched in a bounded batch of two and discarded after
 * sampling, so the Edge Function never accumulates global grids in memory.
 */
async function enrichGridWithWaveData(grid: WeatherGrid, supabaseUrl: string): Promise<void> {
    const storageBase = `${supabaseUrl}/storage/v1/object/public/ww3-cache`;
    const metadataResponse = await fetch(`${storageBase}/${WW3_METADATA_FILE}?v=${Date.now()}`, {
        cache: 'no-store',
        signal: AbortSignal.timeout(10000),
    });
    if (!metadataResponse.ok) {
        throw new RouteWeatherSafetyError('WW3 metadata is unavailable', 503, 'wave_forecast_unavailable');
    }
    const metadata = validateWW3Metadata(
        await readBoundedJsonResponse(metadataResponse, 64 * 1024, 'WW3 metadata', 'wave_forecast_unavailable'),
    );
    const requiredHours = requiredWW3ForecastHours(metadata, grid.startTime, grid.hoursAvailable);
    const sampledByForecastHour = new Map<number, Map<string, WaveConditions>>();
    const gridPoints = [...grid.data.keys()].map((key) => {
        const [lat, lon] = key.split(',').map(Number);
        return { key, lat, lon };
    });

    const fetchAndSample = async (forecastHour: number): Promise<[number, Map<string, WaveConditions>]> => {
        const filename = `ww3_${metadata.cycle}_f${String(forecastHour).padStart(3, '0')}.json`;
        const response = await fetch(`${storageBase}/${filename}`, { signal: AbortSignal.timeout(20000) });
        if (!response.ok) {
            throw new RouteWeatherSafetyError(
                `WW3 shard f${forecastHour} is unavailable`,
                503,
                'wave_forecast_unavailable',
            );
        }
        const parsed = await readBoundedJsonResponse(
            response,
            32 * 1024 * 1024,
            'WW3 shard',
            'wave_forecast_unavailable',
        );
        const shard = validateWW3Shard(parsed, metadata.cycle, forecastHour);
        const samples = new Map<string, WaveConditions>();
        for (const point of gridPoints) {
            const sample = sampleWW3Shard(shard, point.lat, point.lon);
            if (!sample) {
                throw new RouteWeatherSafetyError(
                    `WW3 has no verified wave value at a corridor sample for f${forecastHour}`,
                    503,
                    'wave_forecast_unavailable',
                );
            }
            samples.set(point.key, sample);
        }
        return [forecastHour, samples];
    };

    const SHARD_BATCH_SIZE = 2;
    for (let index = 0; index < requiredHours.length; index += SHARD_BATCH_SIZE) {
        const batch = requiredHours.slice(index, index + SHARD_BATCH_SIZE);
        const sampled = await Promise.all(batch.map(fetchAndSample));
        for (const [forecastHour, samples] of sampled) {
            sampledByForecastHour.set(forecastHour, samples);
        }
    }

    for (const [key, samples] of grid.data.entries()) {
        for (let hour = 0; hour <= grid.hoursAvailable; hour++) {
            const bracket = findWW3TemporalBracket(metadata, grid.startTime + hour * 60 * 60 * 1000);
            if (!bracket) {
                throw new RouteWeatherSafetyError(
                    'WW3 temporal coverage ended before the route horizon',
                    503,
                    'wave_forecast_unavailable',
                );
            }
            const lower = sampledByForecastHour.get(bracket.lowerHour)?.get(key);
            const upper = sampledByForecastHour.get(bracket.upperHour)?.get(key);
            if (!lower || !upper) {
                throw new RouteWeatherSafetyError(
                    'WW3 spatial coverage is incomplete',
                    503,
                    'wave_forecast_unavailable',
                );
            }
            const wave = interpolateWaveConditions(lower, upper, bracket.fraction);
            if (wave.wave_dir_deg === undefined) {
                throw new RouteWeatherSafetyError(
                    'WW3 wave direction coverage is incomplete',
                    503,
                    'wave_forecast_unavailable',
                );
            }
            samples[hour].waveHeight = wave.wave_ht_m;
            samples[hour].waveDirection = wave.wave_dir_deg;
            samples[hour].swellPeriod = wave.peak_period_s;
        }
    }

    grid.waveMetadata = metadata;
    console.info(
        `[WeatherRouter] WW3 ${metadata.cycle} enriched ${grid.data.size} points through +${grid.hoursAvailable}h`,
    );
}

/**
 * Interpolate weather at a specific (lat, lon, hourFromDeparture).
 *
 * Uses bilinear spatial interpolation between the 4 nearest grid points,
 * then linear temporal interpolation between the bounding hours.
 */
function interpolateWeather(
    grid: WeatherGrid,
    lat: number,
    lon: number,
    hourFromDeparture: number,
): WeatherSample | null {
    if (!Number.isFinite(hourFromDeparture) || hourFromDeparture < 0 || hourFromDeparture > grid.hoursAvailable) {
        return null;
    }
    // Snap to grid
    const res = grid.resolution;
    const gLat0 = Math.floor(lat / res) * res;
    const gLon0 = Math.floor(lon / res) * res;
    const gLat1 = gLat0 + res;
    const gLon1 = gLon0 + res;

    // Fractional position within the grid cell
    const fLat = (lat - gLat0) / res;
    const fLon = (lon - gLon0) / res;

    const h = hourFromDeparture;
    const h0 = Math.floor(h);
    const h1 = Math.min(h0 + 1, grid.hoursAvailable);
    const fH = h - h0;

    // Every corner and time bracket must be backed by verified model data.
    const corners = [
        getSample(grid, gLat0, gLon0, h0, h1, fH),
        getSample(grid, gLat0, gLon1, h0, h1, fH),
        getSample(grid, gLat1, gLon0, h0, h1, fH),
        getSample(grid, gLat1, gLon1, h0, h1, fH),
    ];
    if (corners.some((corner) => corner === null)) return null;
    const verifiedCorners = corners as WeatherSample[];

    // Bilinear interpolation
    const top = lerpSample(verifiedCorners[0], verifiedCorners[1], fLon);
    const bot = lerpSample(verifiedCorners[2], verifiedCorners[3], fLon);
    return lerpSample(top, bot, fLat);
}

function getSample(
    grid: WeatherGrid,
    lat: number,
    lon: number,
    h0: number,
    h1: number,
    fH: number,
): WeatherSample | null {
    const key = weatherGridKey(lat, lon);
    const samples = grid.data.get(key);

    if (!samples || h0 < 0 || h1 < 0 || h0 >= samples.length || h1 >= samples.length) return null;

    const s0 = samples[h0];
    const s1 = samples[h1];
    if (
        !s0 ||
        !s1 ||
        !Number.isFinite(s0.windSpeed) ||
        !Number.isFinite(s0.windGust) ||
        !Number.isFinite(s0.windDir) ||
        !Number.isFinite(s0.waveHeight) ||
        !Number.isFinite(s0.waveDirection) ||
        !Number.isFinite(s1.windSpeed) ||
        !Number.isFinite(s1.windGust) ||
        !Number.isFinite(s1.windDir) ||
        !Number.isFinite(s1.waveHeight) ||
        !Number.isFinite(s1.waveDirection)
    ) {
        return null;
    }
    return lerpSample(s0, s1, fH);
}

function lerpSample(a: WeatherSample, b: WeatherSample, t: number): WeatherSample {
    return {
        windSpeed: a.windSpeed + (b.windSpeed - a.windSpeed) * t,
        windGust: a.windGust + (b.windGust - a.windGust) * t,
        windDir: lerpAngle(a.windDir, b.windDir, t),
        waveHeight: a.waveHeight + (b.waveHeight - a.waveHeight) * t,
        waveDirection: lerpAngle(a.waveDirection, b.waveDirection, t),
        swellPeriod:
            a.swellPeriod && b.swellPeriod
                ? a.swellPeriod + (b.swellPeriod - a.swellPeriod) * t
                : a.swellPeriod || b.swellPeriod,
    };
}

/** Interpolate between two angles, handling 359° → 1° wrap */
function lerpAngle(a: number, b: number, t: number): number {
    let diff = b - a;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    return (a + diff * t + 360) % 360;
}

// ══════════════════════════════════════════════════════════════════════
// VESSEL PERFORMANCE & COST FUNCTION
// ══════════════════════════════════════════════════════════════════════

/**
 * Calculate the True Wind Angle (TWA) relative to the vessel's course.
 *
 * @param courseBearing - Vessel's course over ground (degrees)
 * @param windFromDir   - Direction wind is blowing FROM (degrees)
 * @returns TWA in degrees (0-180, 0 = dead upwind, 180 = dead downwind)
 */
function trueWindAngle(courseBearing: number, windFromDir: number): number {
    // Wind direction is "FROM", course is "TO"
    // TWA = |windFrom - course|, normalized to 0-180
    let angle = Math.abs(windFromDir - courseBearing);
    if (angle > 180) angle = 360 - angle;
    return angle;
}

/**
 * Estimate vessel speed given weather conditions and vessel profile.
 *
 * For SAIL vessels — Polar-First Architecture:
 *   - Use custom polar data if provided (bilinear interpolation)
 *   - Otherwise use built-in Tayana 55 default polars
 *   - No-go zone (TWA < 35°): IMPASSABLE — forces A* to find better angle
 *   - Close-hauled (35-50°): VMG penalty — progress toward dest is cos(TWA)
 *   - Beam reach (70-120°): Optimal — fastest point of sail
 *   - Dead run (150-180°): Moderate — polars drive the speed
 *
 * For POWER vessels:
 *   - Headwind/bow sea penalties
 *   - Beam sea roll penalty
 *   - Wave height degradation
 *
 * Returns 0 if conditions exceed vessel limits or in no-go zone (IMPASSABLE).
 */

// Default polar data for a ~55ft bluewater cruiser (Tayana 55 class)
// Speeds in knots indexed by [TWA][TWS]
// TWA row indices: 40°  60°   80°  100°  120°  140°  160°  180°
// TWS col indices:  6   10    15    20    25    30
const TAYANA55_POLARS: PolarData = {
    angles: [40, 60, 80, 100, 120, 140, 160, 180],
    windSpeeds: [6, 10, 15, 20, 25, 30],
    matrix: [
        [3.2, 4.8, 5.8, 6.2, 6.0, 5.5], // 40° close-hauled
        [4.0, 5.8, 7.0, 7.5, 7.2, 6.8], // 60° close reach
        [4.5, 6.5, 7.8, 8.2, 8.0, 7.5], // 80° beam reach
        [4.2, 6.2, 7.5, 8.0, 7.8, 7.3], // 100° broad beam
        [3.8, 5.8, 7.2, 7.8, 7.5, 7.0], // 120° broad reach
        [3.5, 5.2, 6.5, 7.2, 7.0, 6.5], // 140° deep broad
        [3.0, 4.5, 5.8, 6.5, 6.3, 5.8], // 160° deep run
        [2.5, 4.0, 5.2, 5.8, 5.5, 5.0], // 180° dead run
    ],
};
const TAYANA55_MAX_POLAR_SPEED_KTS = 8.2;

function estimateSpeed(vessel: VesselParams, weather: WeatherSample, courseBearing: number): number {
    const twa = trueWindAngle(courseBearing, weather.windDir);
    const waveAngle = trueWindAngle(courseBearing, weather.waveDirection);
    const tws = weather.windSpeed;
    const gust = weather.windGust;
    const waveH = weather.waveHeight;

    // ── Absolute limits — IMPASSABLE ──
    if (Math.max(tws, gust) > vessel.max_wind_kts) return 0;
    if (waveH > vessel.max_wave_m) return 0;

    let speed = vessel.cruising_speed_kts;

    if (vessel.type === 'sail') {
        // ── SAIL — Polar-First ──
        // Select polars: custom → Tayana 55 default
        const polars = vessel.polar_data || TAYANA55_POLARS;
        const polarSpeedAt = (angle: number) => interpolatePolar(polars, angle, tws, !vessel.polar_data);

        // NO-GO ZONE: Cannot sail within 35° of the wind.
        // Forces A* to pick a node with a better angle.
        if (twa < 35) return 0;

        // CLOSE-HAULED TACKING (35–50°)
        // Boat speed from polars, but effective VMG is cos(TWA) × boatSpeed
        if (twa < 50) {
            const polarSpeed = polarSpeedAt(twa);
            if (polarSpeed <= 0) return 0;
            const vmgFactor = Math.cos(twa * DEG_TO_RAD);
            speed = polarSpeed * vmgFactor;
        }
        // CLOSE REACH (50–70°)
        else if (twa < 70) {
            speed = polarSpeedAt(twa);
            const vmgFactor = 0.8 + 0.2 * ((twa - 50) / 20);
            speed *= vmgFactor;
        }
        // BEAM REACH (70–120°) — optimal, full polar speed
        else if (twa <= 120) {
            speed = polarSpeedAt(twa);
        }
        // BROAD REACH (120–150°)
        else if (twa <= 150) {
            speed = polarSpeedAt(twa);
        }
        // DEAD RUN (150–180°)
        else {
            speed = polarSpeedAt(twa);
        }

        // The bundled curve supplies only the *shape* of the fallback polar.
        // Scale it to the vessel's declared cruising performance instead of
        // silently routing every unprofiled yacht as a 55-foot Tayana.
        if (!vessel.polar_data) {
            speed *= vessel.cruising_speed_kts / TAYANA55_MAX_POLAR_SPEED_KTS;
        }

        // Light air — not enough to fill sails
        if (tws < 5) {
            speed *= Math.max(0.2, tws / 5);
        }

        // Wave degradation
        if (waveH > 2.0) {
            speed *= Math.max(0.5, 1 - (waveH - 2.0) * 0.12);
        }

        // Gale conditions — reefed down
        if (tws > vessel.max_wind_kts * 0.75) {
            const excess = (tws - vessel.max_wind_kts * 0.75) / (vessel.max_wind_kts * 0.25);
            speed *= Math.max(0.3, 1 - excess * 0.7);
        }
    } else {
        // ── POWER ROUTING ──

        if (twa < 45) {
            const headFactor = 1 - (tws / 40) * 0.3;
            speed *= Math.max(0.5, headFactor);
        }
        if (waveAngle < 45 && waveH > 1.5) {
            speed *= Math.max(0.6, 1 - (waveH - 1.5) * 0.15);
        } else if (waveAngle > 60 && waveAngle < 120 && waveH > 2.0) {
            speed *= Math.max(0.7, 1 - (waveH - 2.0) * 0.1);
        }

        if (waveH > 3.0) {
            speed *= Math.max(0.5, 1 - (waveH - 3.0) * 0.15);
        }
    }

    // Near-limits steep penalty
    if (gust > vessel.max_wind_kts * 0.7 || waveH > vessel.max_wave_m * 0.7) {
        const dangerFactor = Math.max(gust / vessel.max_wind_kts, waveH / vessel.max_wave_m);
        if (dangerFactor > 0.7) {
            speed *= Math.max(0.3, 1 - (dangerFactor - 0.7) * GALE_PENALTY);
        }
    }

    return Number.isFinite(speed) && speed >= 0.1 ? speed : 0;
}

/**
 * Bilinear interpolation of polar performance data.
 */
function interpolatePolar(polar: PolarData, twa: number, tws: number, clampOutsideRange = false): number {
    const { angles, windSpeeds, matrix } = polar;

    if (
        !clampOutsideRange &&
        (twa < angles[0] ||
            twa > angles[angles.length - 1] ||
            tws < windSpeeds[0] ||
            tws > windSpeeds[windSpeeds.length - 1])
    ) {
        return 0;
    }

    // Clamp to polar range
    const clampedTWA = Math.max(angles[0], Math.min(angles[angles.length - 1], twa));
    const clampedTWS = Math.max(windSpeeds[0], Math.min(windSpeeds[windSpeeds.length - 1], tws));

    // Find bounding indices
    let ai = 0;
    for (let i = 0; i < angles.length - 1; i++) {
        if (angles[i + 1] >= clampedTWA) {
            ai = i;
            break;
        }
    }
    let wi = 0;
    for (let i = 0; i < windSpeeds.length - 1; i++) {
        if (windSpeeds[i + 1] >= clampedTWS) {
            wi = i;
            break;
        }
    }

    const ai2 = Math.min(ai + 1, angles.length - 1);
    const wi2 = Math.min(wi + 1, windSpeeds.length - 1);

    // Fractions
    const fA = ai === ai2 ? 0 : (clampedTWA - angles[ai]) / (angles[ai2] - angles[ai]);
    const fW = wi === wi2 ? 0 : (clampedTWS - windSpeeds[wi]) / (windSpeeds[wi2] - windSpeeds[wi]);

    // Bilinear
    const v00 = matrix[ai][wi];
    const v01 = matrix[ai][wi2];
    const v10 = matrix[ai2][wi];
    const v11 = matrix[ai2][wi2];

    const top = v00 + (v01 - v00) * fW;
    const bot = v10 + (v11 - v10) * fW;
    return top + (bot - top) * fA;
}

function optimisticVesselSpeed(vessel: VesselParams): number {
    if (vessel.type !== 'sail') return vessel.cruising_speed_kts;
    if (!vessel.polar_data) return vessel.cruising_speed_kts;
    const polar = vessel.polar_data;
    let maximum = vessel.cruising_speed_kts;
    for (const row of polar.matrix) {
        for (const speed of row) maximum = Math.max(maximum, speed);
    }
    return maximum;
}

interface EdgeTraversal {
    edgeTimeH: number;
    edgeCost: number;
}

/**
 * Integrate one graph edge at no more than 2 NM / 30 minutes per slice.
 *
 * A single midpoint lookup can miss a short-lived limit crossing and can
 * assign the wrong arrival time when speed changes materially during a long
 * edge. Each slice therefore solves travel time against departure, midpoint,
 * and arrival weather using Simpson integration, then the edge is subdivided
 * again when any solved slice is longer than 30 minutes.
 */
function evaluateEdgeTraversal(
    fromNode: MeshNode,
    toNode: MeshNode,
    startTimeH: number,
    distNM: number,
    courseBrg: number,
    vessel: VesselParams,
    weatherGrid: WeatherGrid,
): EdgeTraversal | null {
    const initialWeather = interpolateWeather(weatherGrid, fromNode.lat, fromNode.lon, startTimeH);
    if (!initialWeather) return null;
    const initialSpeed = estimateSpeed(vessel, initialWeather, courseBrg);
    if (initialSpeed <= 0) return null;

    const MAX_SLICE_DISTANCE_NM = 2;
    const MAX_SLICE_DURATION_H = 0.5;
    const MAX_EDGE_SLICES = 512;
    let slices = Math.max(
        2,
        Math.ceil(distNM / MAX_SLICE_DISTANCE_NM),
        Math.ceil(distNM / initialSpeed / MAX_SLICE_DURATION_H),
    );

    const simulate = (sliceCount: number): { edgeTimeH: number; edgeCost: number; longestSliceH: number } | null => {
        const sliceDistanceNM = distNM / sliceCount;
        let currentTimeH = startTimeH;
        let edgeCost = 0;
        let longestSliceH = 0;

        for (let slice = 0; slice < sliceCount; slice++) {
            const startFraction = slice / sliceCount;
            const midpointFraction = (slice + 0.5) / sliceCount;
            const endFraction = (slice + 1) / sliceCount;
            const atFraction = (fraction: number) => ({
                lat: fromNode.lat + (toNode.lat - fromNode.lat) * fraction,
                lon: fromNode.lon + (toNode.lon - fromNode.lon) * fraction,
            });
            const startPoint = atFraction(startFraction);
            const midpoint = atFraction(midpointFraction);
            const endPoint = atFraction(endFraction);

            const departureWeather = interpolateWeather(weatherGrid, startPoint.lat, startPoint.lon, currentTimeH);
            if (!departureWeather) return null;
            const departureSpeed = estimateSpeed(vessel, departureWeather, courseBrg);
            if (departureSpeed <= 0) return null;

            let sliceTimeH = sliceDistanceNM / departureSpeed;
            let midpointWeather: WeatherSample | null = null;
            let arrivalWeather: WeatherSample | null = null;
            let converged = false;

            for (let iteration = 0; iteration < 12; iteration++) {
                if (
                    !Number.isFinite(sliceTimeH) ||
                    sliceTimeH <= 0 ||
                    currentTimeH + sliceTimeH > weatherGrid.hoursAvailable
                ) {
                    return null;
                }
                midpointWeather = interpolateWeather(
                    weatherGrid,
                    midpoint.lat,
                    midpoint.lon,
                    currentTimeH + sliceTimeH / 2,
                );
                arrivalWeather = interpolateWeather(weatherGrid, endPoint.lat, endPoint.lon, currentTimeH + sliceTimeH);
                if (!midpointWeather || !arrivalWeather) return null;
                const midpointSpeed = estimateSpeed(vessel, midpointWeather, courseBrg);
                const arrivalSpeed = estimateSpeed(vessel, arrivalWeather, courseBrg);
                if (midpointSpeed <= 0 || arrivalSpeed <= 0) return null;

                const refinedTimeH =
                    (sliceDistanceNM / 6) * (1 / departureSpeed + 4 / midpointSpeed + 1 / arrivalSpeed);
                if (!Number.isFinite(refinedTimeH) || refinedTimeH <= 0) return null;
                if (Math.abs(refinedTimeH - sliceTimeH) <= 0.001) {
                    sliceTimeH = refinedTimeH;
                    converged = true;
                    break;
                }
                sliceTimeH = refinedTimeH;
            }
            if (!converged || !midpointWeather || !arrivalWeather) return null;

            // Re-evaluate the converged instants before accepting the slice;
            // the final fixed-point update may have shifted both timestamps.
            midpointWeather = interpolateWeather(
                weatherGrid,
                midpoint.lat,
                midpoint.lon,
                currentTimeH + sliceTimeH / 2,
            );
            arrivalWeather = interpolateWeather(weatherGrid, endPoint.lat, endPoint.lon, currentTimeH + sliceTimeH);
            if (
                !midpointWeather ||
                !arrivalWeather ||
                estimateSpeed(vessel, midpointWeather, courseBrg) <= 0 ||
                estimateSpeed(vessel, arrivalWeather, courseBrg) <= 0
            ) {
                return null;
            }

            const comfortPenalty =
                (calculateComfortPenalty(departureWeather, vessel, courseBrg) +
                    4 * calculateComfortPenalty(midpointWeather, vessel, courseBrg) +
                    calculateComfortPenalty(arrivalWeather, vessel, courseBrg)) /
                6;
            edgeCost += sliceTimeH * comfortPenalty;
            currentTimeH += sliceTimeH;
            longestSliceH = Math.max(longestSliceH, sliceTimeH);
        }

        return { edgeTimeH: currentTimeH - startTimeH, edgeCost, longestSliceH };
    };

    for (let pass = 0; pass < 4; pass++) {
        if (!Number.isInteger(slices) || slices < 2 || slices > MAX_EDGE_SLICES) return null;
        const result = simulate(slices);
        if (!result) return null;
        if (result.longestSliceH <= MAX_SLICE_DURATION_H + 0.001) {
            return { edgeTimeH: result.edgeTimeH, edgeCost: result.edgeCost };
        }
        const multiplier = Math.ceil(result.longestSliceH / MAX_SLICE_DURATION_H);
        slices = Math.max(slices + 1, slices * multiplier);
    }
    return null;
}

// ══════════════════════════════════════════════════════════════════════
// 4D A* — TIME-DEPENDENT PATHFINDING
// ══════════════════════════════════════════════════════════════════════

/**
 * Run time-stepped A* through the corridor mesh.
 *
 * Key differences from standard A*:
 *   1. gTime: tracks accumulated hours from departure
 *   2. At each node expansion, the weather is looked up for (node.lat, node.lon, gTime)
 *   3. Edge cost = time_to_traverse + weather_penalty
 *   4. Speed is calculated based on weather at the CURRENT node's arrival time
 *   5. The heuristic uses direct distance / cruising speed (optimistic)
 *
 * The graph is a DAG (directed, acyclic) so we guarantee termination.
 */
function corridorAStar(
    nodes: MeshNode[],
    adjacency: Map<number, number[]>,
    startIds: number[], // Usually just the first row's center node
    goalIds: Set<number>, // All nodes in the last row
    vessel: VesselParams,
    weatherGrid: WeatherGrid,
    goalLat: number,
    goalLon: number,
    elevationGrid: ElevationGrid,
): { path: MeshNode[]; totalTimeH: number; totalCost: number } | null {
    const N = nodes.length;
    const heuristicSpeedKts = optimisticVesselSpeed(vessel);

    // Best g-cost and g-time arrays
    const gCost = new Float64Array(N).fill(Infinity);
    const gTime = new Float64Array(N).fill(Infinity);
    const parent = new Int32Array(N).fill(-1);

    // Priority queue (sorted array — mesh is small enough)
    const heap: AStarNode4D[] = [];

    // Seed start nodes
    for (const sid of startIds) {
        if (!nodes[sid] || nodes[sid].isUnsafeDepth) continue;
        gCost[sid] = 0;
        gTime[sid] = 0;
        const h = haversineNM(nodes[sid].lat, nodes[sid].lon, goalLat, goalLon) / heuristicSpeedKts;
        heap.push({ nodeId: sid, gCost: 0, gTime: 0, fCost: h });
    }

    // Sort by fCost (ascending)
    heap.sort((a, b) => a.fCost - b.fCost);

    let expanded = 0;

    while (heap.length > 0) {
        const current = heap.shift()!;
        expanded++;

        // Skip if we've found a better path to this node
        if (current.gCost > gCost[current.nodeId]) continue;

        // Check if we've reached a goal
        if (goalIds.has(current.nodeId) && current.gTime <= weatherGrid.hoursAvailable) {
            console.info(
                `[WeatherRouter] A* found path: ${expanded} expansions, ${current.gTime.toFixed(1)}h, cost=${current.gCost.toFixed(2)}`,
            );
            return reconstructPath(nodes, parent, gTime, current.nodeId, current.gTime, current.gCost);
        }

        // Expand neighbors
        const neighbors = adjacency.get(current.nodeId) || [];
        for (const nid of neighbors) {
            const fromNode = nodes[current.nodeId];
            const toNode = nodes[nid];

            // Distance between nodes
            const distNM = haversineNM(fromNode.lat, fromNode.lon, toNode.lat, toNode.lon);

            // Course bearing from current to neighbor
            const courseBrg = bearing(fromNode.lat, fromNode.lon, toNode.lat, toNode.lon);

            // ── LAND DETECTION: GEBCO elevation-based landmask ──
            // 1. Node check: does the destination clear draft + margin?
            if (toNode.isUnsafeDepth) {
                continue;
            }

            // 2. Edge check: does the straight line between from→to cross land?
            if (segmentCrossesLand(elevationGrid, fromNode.lat, fromNode.lon, toNode.lat, toNode.lon)) {
                continue; // 🔴 Edge crosses land
            }

            const traversal = evaluateEdgeTraversal(
                fromNode,
                toNode,
                current.gTime,
                distNM,
                courseBrg,
                vessel,
                weatherGrid,
            );
            if (!traversal) continue;
            const newGTime = current.gTime + traversal.edgeTimeH;
            if (!Number.isFinite(newGTime) || newGTime > weatherGrid.hoursAvailable) continue;
            const newGCost = current.gCost + traversal.edgeCost;

            if (newGCost < gCost[nid]) {
                gCost[nid] = newGCost;
                gTime[nid] = newGTime;
                parent[nid] = current.nodeId;

                // Heuristic: remaining distance / cruising speed
                const heuristic = haversineNM(toNode.lat, toNode.lon, goalLat, goalLon) / heuristicSpeedKts;

                // Binary search insert (keep sorted)
                const fCost = newGCost + heuristic;
                const node4d: AStarNode4D = { nodeId: nid, gCost: newGCost, gTime: newGTime, fCost };

                let lo = 0,
                    hi = heap.length;
                while (lo < hi) {
                    const mid = (lo + hi) >> 1;
                    if (heap[mid].fCost < fCost) lo = mid + 1;
                    else hi = mid;
                }
                heap.splice(lo, 0, node4d);
            }
        }
    }

    console.error(`[WeatherRouter] A* exhausted after ${expanded} expansions — no path found`);
    return null;
}

/**
 * Calculate a comfort penalty multiplier (>= 1.0).
 *
 * This makes the A* prefer routes through calmer weather,
 * even if they're slightly longer in distance.
 *
 * Factors:
 *   - Wave height (exponential discomfort above 2m)
 *   - Wind gusts near limits
 *   - Beam seas for power vessels
 */
function calculateComfortPenalty(weather: WeatherSample, vessel: VesselParams, courseBearing: number): number {
    let penalty = 1.0;

    // Wave discomfort (exponential above 2m)
    if (weather.waveHeight > 1.5) {
        penalty += Math.pow((weather.waveHeight - 1.5) / vessel.max_wave_m, 2) * 0.5;
    }
    const waveAngle = trueWindAngle(courseBearing, weather.waveDirection);
    if (vessel.type === 'power' && waveAngle >= 60 && waveAngle <= 120 && weather.waveHeight > 1) {
        penalty += Math.pow((weather.waveHeight - 1) / vessel.max_wave_m, 2) * 0.25;
    }

    // Wind approaching limits
    const windRatio = weather.windGust / vessel.max_wind_kts;
    if (windRatio > 0.5) {
        penalty += Math.pow(windRatio - 0.5, 2) * 1.5;
    }

    return penalty;
}

/** Reconstruct the path from parent array */
function reconstructPath(
    nodes: MeshNode[],
    parent: Int32Array,
    arrivalTimes: Float64Array,
    goalId: number,
    totalTimeH: number,
    totalCost: number,
): { path: MeshNode[]; totalTimeH: number; totalCost: number } {
    const path: MeshNode[] = [];
    let current = goalId;
    while (current !== -1) {
        path.unshift({ ...nodes[current], arrivalTimeH: arrivalTimes[current] });
        current = parent[current];
    }
    return { path, totalTimeH, totalCost };
}

// ══════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════════════

Deno.serve(async (req: Request) => {
    if (req.method === 'OPTIONS') return corsResponse(null, 204);
    if (req.method !== 'POST') return jsonResponse({ error: 'POST only' }, 405);

    try {
        const caller = await requireAuthenticatedOrPublicQuota(req, 'route_weather', 6, 2, 10 * 60);
        if (caller instanceof Response) return withCors(caller, CORS);

        const advertisedLength = Number(req.headers.get('content-length'));
        if (Number.isFinite(advertisedLength) && advertisedLength > MAX_ROUTE_REQUEST_BYTES) {
            return jsonResponse({ error: 'Request body is too large', code: 'request_too_large' }, 413);
        }
        const rawBody = await readBoundedText(req, MAX_ROUTE_REQUEST_BYTES);
        if (rawBody === null) {
            return jsonResponse({ error: 'Request body is too large', code: 'request_too_large' }, 413);
        }
        let parsedBody: unknown;
        try {
            parsedBody = JSON.parse(rawBody);
        } catch {
            return jsonResponse({ error: 'Request body must be valid JSON', code: 'invalid_json' }, 400);
        }
        const body = validateWeatherRouteRequest(parsedBody);
        const { centerline, departure_time, vessel } = body;

        // Scale corridor width with passage distance for meaningful weather routing
        const roughDistNM = centerline.reduce((sum, wp, i) => {
            if (i === 0) return 0;
            return sum + haversineNM(centerline[i - 1].lat, centerline[i - 1].lon, wp.lat, wp.lon);
        }, 0);
        const dynamicCorridorWidth = Math.min(MAX_CORRIDOR_WIDTH_NM, Math.max(30, roughDistNM * 0.15));
        const corridorWidth = body.corridor_width_nm ?? dynamicCorridorWidth;
        // More lateral steps for longer passages
        const dynamicLateralSteps = Math.min(4, Math.max(DEFAULT_LATERAL_STEPS, Math.ceil(corridorWidth / 30)));
        const lateralSteps = body.lateral_steps ?? dynamicLateralSteps;
        if (corridorWidth / lateralSteps > 30) {
            throw new RouteWeatherSafetyError(
                'Corridor width requires more lateral steps to keep route transitions physically bounded',
                400,
                'invalid_corridor_resolution',
            );
        }
        const nodesPerRow = 2 * lateralSteps + 1;
        const departureDate = new Date(departure_time);

        console.info(`[WeatherRouter] ── START ────────────────────────────────`);
        console.info(
            `[WeatherRouter] ${centerline.length} centerline WPs, ${vessel.type} @ ${vessel.cruising_speed_kts} kts`,
        );
        console.info(`[WeatherRouter] Corridor: ±${corridorWidth} NM, ${lateralSteps} lateral steps`);
        console.info(`[WeatherRouter] Departure: ${departureDate.toISOString()}`);

        const t0 = Date.now();

        // ══════════════════════════════════════════════════════════════
        // STEP 0: Preserve the supplied bathymetric-safe centerline.
        //
        // Earlier versions projected synthetic 15 NM harbour legs that could
        // cut across land. Weather routing now begins and ends at the supplied
        // endpoints, and every resulting segment is checked against GEBCO.
        // ══════════════════════════════════════════════════════════════

        const departureWp = centerline[0];
        const arrivalWp = centerline[centerline.length - 1];

        console.info(`[WeatherRouter] ⏱ Step 0 (safe centerline): ${Date.now() - t0}ms`);

        // ══════════════════════════════════════════════════════════════
        // STEP 1: Use the complete validated centerline
        // ══════════════════════════════════════════════════════════════

        const maxMeshRows = Math.floor(MAX_ROUTE_MESH_NODES / nodesPerRow);
        const routeCenterline: CenterlineWaypoint[] = densifyCenterlineForMesh(centerline, maxMeshRows);
        if (routeCenterline.length * nodesPerRow > MAX_ROUTE_MESH_NODES) {
            throw new RouteWeatherSafetyError(
                `Route mesh exceeds the ${MAX_ROUTE_MESH_NODES}-node processing limit`,
                413,
                'route_mesh_too_large',
            );
        }

        const routingMode = 'verified_weather_corridor';
        console.info(
            `[WeatherRouter] Forecast centerline: ${centerline.length} supplied → ${routeCenterline.length} evaluated waypoints`,
        );

        // ══════════════════════════════════════════════════════════════
        // STEP 2: Generate Corridor Mesh (ocean passage only)
        //
        // Full corridor width for the entire mesh — no coastal
        // constraints needed since exit/entry are simple direct lines.
        // ══════════════════════════════════════════════════════════════

        const perWpCorridorWidth: number[] = routeCenterline.map(() => corridorWidth);

        // Generate mesh with uniform corridor widths
        const meshNodes = generateCorridorMeshVariable(routeCenterline, perWpCorridorWidth, lateralSteps);

        // ══════════════════════════════════════════════════════════════
        // STEP 2b: Apply GEBCO Land Mask
        //
        // Check each mesh node against GEBCO elevation data.
        // Nodes that do not clear draft + 1 m are marked impassable and
        // skipped by A*. This prevents both land crossings and grounding.
        // ══════════════════════════════════════════════════════════════

        const minimumSafeDepthM = vessel.draft_m + 1;
        const { blockedCount: unsafeDepthNodeCount, grid: elevationGrid } = await applyLandMask(
            meshNodes,
            routeCenterline,
            minimumSafeDepthM,
        );
        console.info(
            `[WeatherRouter] ⏱ Step 2b (GEBCO): ${Date.now() - t0}ms — ${unsafeDepthNodeCount} land/shallow nodes`,
        );
        if (unsafeDepthNodeCount > 0) {
            console.info(`[WeatherRouter] Depth mask applied: ${unsafeDepthNodeCount} impassable nodes`);
        }

        // ══════════════════════════════════════════════════════════════
        // STEP 3: Build Adjacency Graph
        // ══════════════════════════════════════════════════════════════

        const adjacency = buildAdjacencyList(meshNodes, nodesPerRow, routeCenterline.length);

        // ══════════════════════════════════════════════════════════════
        // STEP 4: Fetch Weather Grid
        // ══════════════════════════════════════════════════════════════

        const totalDistNM = routeCenterline.reduce((sum, wp, i) => {
            if (i === 0) return 0;
            return sum + haversineNM(routeCenterline[i - 1].lat, routeCenterline[i - 1].lon, wp.lat, wp.lon);
        }, 0);
        const optimisticHours = totalDistNM / vessel.cruising_speed_kts;
        const maxHours = Math.ceil(optimisticHours * 1.75) + 2;
        if (maxHours > MAX_ROUTE_FORECAST_HOURS) {
            return jsonResponse(
                {
                    error: `Route needs at least ${maxHours} hours of forecast coverage; verified routing is limited to ${MAX_ROUTE_FORECAST_HOURS} hours`,
                    code: 'forecast_horizon_insufficient',
                },
                422,
            );
        }

        const weatherGrid = await fetchWeatherGrid(meshNodes, departureDate, maxHours);
        console.info(`[WeatherRouter] ⏱ Step 4 (Weather): ${Date.now() - t0}ms`);
        console.info(
            `[WeatherRouter] 🌤️ Weather grid: ${weatherGrid.data.size} points with data, ${weatherGrid.hoursAvailable}h forecast`,
        );

        // ══════════════════════════════════════════════════════════════
        // STEP 5: Run 4D A* through the verified weather/depth corridor.
        // ══════════════════════════════════════════════════════════════

        const startCenter = lateralSteps;
        const startIds = [startCenter];

        const lastRowStart = (routeCenterline.length - 1) * nodesPerRow;
        // The route must end at the supplied destination. Allowing any lateral
        // node here previously required an unchecked synthetic final leg.
        const goalIds = new Set<number>([lastRowStart + lateralSteps]);

        const goalWp = routeCenterline[routeCenterline.length - 1];

        // ── Diagnostic logging ──
        const unsafeDepthNodes = meshNodes.filter((n) => n.isUnsafeDepth).length;
        console.info(
            `[WeatherRouter] Mesh: ${meshNodes.length} nodes, ${unsafeDepthNodes} land/shallow (${((unsafeDepthNodes / meshNodes.length) * 100).toFixed(1)}%), weather grid: ${weatherGrid.data.size} pts, ${weatherGrid.hoursAvailable}h`,
        );

        const result = corridorAStar(
            meshNodes,
            adjacency,
            startIds,
            goalIds,
            vessel,
            weatherGrid,
            goalWp.lat,
            goalWp.lon,
            elevationGrid,
        );

        const computeMs = Date.now() - t0;

        if (!result) {
            return jsonResponse(
                {
                    error: 'No route satisfies the verified land, forecast-horizon, and vessel safety constraints',
                    code: 'no_safe_route',
                    computation_ms: computeMs,
                },
                422,
            );
        }

        // Publish the exact time-parameterized A* path. Geometric
        // simplification previously shortened the displayed route while
        // retaining arrival times and cost from the longer raw path, so its
        // positions, ETA, and sampled weather could describe different
        // voyages. The bounded mesh already caps this path at a safe payload
        // size, making lossless publication both safer and more truthful.
        const verifiedPath = result.path;

        // Build a single verified track. Every segment in this output came
        // directly from the depth- and weather-gated A* search.
        const track: Array<{
            coordinates: [number, number];
            distance_from_start_nm: number;
            time_offset_hours: number;
            name: string;
            leg_type: 'harbour' | 'ocean';
            lateral_offset_nm: number;
            conditions: {
                depth_m: number | null;
                wind_spd_kts: number;
                wind_gust_kts: number;
                wind_dir_deg: number;
                wave_ht_m: number;
                wave_dir_deg: number;
                swell_period_s: number | null;
            };
        }> = [];

        let cumulativeDistNM = 0;

        for (let i = 0; i < verifiedPath.length; i++) {
            const node = verifiedPath[i];
            if (i > 0) {
                cumulativeDistNM += haversineNM(verifiedPath[i - 1].lat, verifiedPath[i - 1].lon, node.lat, node.lon);
            }

            const timeOffsetH = node.arrivalTimeH;
            if (
                timeOffsetH === undefined ||
                !Number.isFinite(timeOffsetH) ||
                timeOffsetH < 0 ||
                timeOffsetH > weatherGrid.hoursAvailable
            ) {
                throw new RouteWeatherSafetyError(
                    'Route contains an arrival outside verified forecast coverage',
                    422,
                    'forecast_horizon_insufficient',
                );
            }
            const wx = interpolateWeather(weatherGrid, node.lat, node.lon, timeOffsetH);
            if (!wx) {
                throw new RouteWeatherSafetyError(
                    'Verified weather is unavailable at a routed waypoint',
                    503,
                    'weather_coverage_unavailable',
                );
            }

            track.push({
                coordinates: [Math.round(node.lon * 10000) / 10000, Math.round(node.lat * 10000) / 10000],
                distance_from_start_nm: Math.round(cumulativeDistNM * 10) / 10,
                time_offset_hours: Math.round(timeOffsetH * 10) / 10,
                name:
                    i === 0
                        ? departureWp.name || 'Departure'
                        : i === verifiedPath.length - 1
                          ? arrivalWp.name || 'Arrival'
                          : `WP-${String(i).padStart(2, '0')}`,
                leg_type: 'ocean',
                lateral_offset_nm: node.lateralOffset * (corridorWidth / lateralSteps),
                conditions: {
                    depth_m: node.depth_m ?? null,
                    wind_spd_kts: Math.round(wx.windSpeed * 10) / 10,
                    wind_gust_kts: Math.round(wx.windGust * 10) / 10,
                    wind_dir_deg: Math.round(wx.windDir),
                    wave_ht_m: Math.round(wx.waveHeight * 10) / 10,
                    wave_dir_deg: Math.round(wx.waveDirection),
                    swell_period_s: wx.swellPeriod ? Math.round(wx.swellPeriod * 10) / 10 : null,
                },
            });
        }

        const routeDistNM = cumulativeDistNM;

        // Bounding box for instant map camera framing [minLon, minLat, maxLon, maxLat]
        let bbMinLat = Infinity,
            bbMaxLat = -Infinity;
        let bbMinLon = Infinity,
            bbMaxLon = -Infinity;
        for (const pt of track) {
            bbMinLon = Math.min(bbMinLon, pt.coordinates[0]);
            bbMaxLon = Math.max(bbMaxLon, pt.coordinates[0]);
            bbMinLat = Math.min(bbMinLat, pt.coordinates[1]);
            bbMaxLat = Math.max(bbMaxLat, pt.coordinates[1]);
        }

        console.info(`[WeatherRouter] ── COMPLETE ─────────────────────────────`);
        console.info(
            `[WeatherRouter] ${track.length} track points (${track.filter((t) => t.leg_type === 'harbour').length} harbour, ${track.filter((t) => t.leg_type === 'ocean').length} ocean), ${routeDistNM.toFixed(1)} NM`,
        );
        console.info(`[WeatherRouter] ETA: ${result.totalTimeH.toFixed(1)}h, Cost: ${result.totalCost.toFixed(2)}`);
        console.info(`[WeatherRouter] Computed in ${computeMs}ms`);

        return jsonResponse({
            summary: {
                total_distance_nm: Math.round(routeDistNM * 10) / 10,
                total_duration_hours: Math.round(result.totalTimeH * 10) / 10,
                cost_score: Math.round(result.totalCost * 100) / 100,
                computation_ms: computeMs,
                routing_mode: routingMode,
                vessel_type: vessel.type,
                departure_time: departureDate.toISOString(),
            },
            bounding_box: [
                Math.floor(bbMinLon * 100) / 100,
                Math.floor(bbMinLat * 100) / 100,
                Math.ceil(bbMaxLon * 100) / 100,
                Math.ceil(bbMaxLat * 100) / 100,
            ],
            track,
            mesh_stats: {
                total_nodes: meshNodes.length,
                rows: routeCenterline.length,
                cols: nodesPerRow,
                corridor_width_nm: corridorWidth,
                weather_grid_points: weatherGrid.data.size,
                forecast_hours: weatherGrid.hoursAvailable,
            },
            weather_sources: {
                wind: {
                    model: 'Apple WeatherKit forecastHourly',
                    aligned_from: departureDate.toISOString(),
                    horizon_hours: weatherGrid.hoursAvailable,
                },
                waves: {
                    model: 'NOAA WaveWatch III',
                    cycle: weatherGrid.waveMetadata?.cycle,
                    valid_from: weatherGrid.waveMetadata?.valid_from,
                    valid_to: weatherGrid.waveMetadata?.valid_to,
                },
                land_mask: {
                    model: 'GEBCO',
                    max_cell_nm: LANDMASK_MAX_CELL_NM,
                    minimum_safe_depth_m: minimumSafeDepthM,
                },
            },
            pilotage: {
                departure: null,
                arrival: null,
            },
        });
    } catch (err) {
        console.error('[WeatherRouter] Fatal:', err);
        if (err instanceof RouteWeatherSafetyError) {
            return jsonResponse({ error: err.message, code: err.code }, err.status);
        }
        if (err instanceof WW3ValidationError) {
            return jsonResponse({ error: err.message, code: 'wave_forecast_unavailable' }, 503);
        }
        return jsonResponse(
            { error: 'Weather routing failed unexpectedly', code: 'route_weather_internal_error' },
            500,
        );
    }
});
