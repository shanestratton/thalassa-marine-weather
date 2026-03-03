// deno-lint-ignore-file
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
 *   - WeatherKit hourly (wind speed, direction, wave height) via proxy
 *   - NOAA WaveWatch III (swell) via NOMADS GRIB Filter (fallback)
 */

// ── CORS ──────────────────────────────────────────────────────────

const CORS: Record<string, string> = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

function corsResponse(body: BodyInit | null, status: number, extra?: Record<string, string>) {
    return new Response(body, { status, headers: { ...CORS, ...extra } });
}

function jsonResponse(data: unknown, status = 200) {
    return corsResponse(JSON.stringify(data), status, { "Content-Type": "application/json" });
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
    cruising_speed_kts: number;       // Target speed in knots
    max_wind_kts: number;             // Absolute wind limit
    max_wave_m: number;               // Absolute wave limit
    polar_data?: PolarData | null;    // Optional polar performance matrix
}

interface PolarData {
    windSpeeds: number[];   // TWS columns (kts)
    angles: number[];       // TWA rows (degrees, 0-180)
    matrix: number[][];     // matrix[angleIdx][windSpeedIdx] = boat speed (kts)
}

interface WeatherRouteRequest {
    centerline: CenterlineWaypoint[];  // From bathymetric router
    departure_time: string;            // ISO 8601 timestamp
    vessel: VesselParams;
    corridor_width_nm?: number;        // Default 30 NM each side
    lateral_steps?: number;            // Default 2 (±15, ±30 NM)
}

/** A single node in the corridor mesh */
interface MeshNode {
    id: number;             // Unique node ID
    lat: number;
    lon: number;
    centerIdx: number;      // Which centerline segment this belongs to
    lateralOffset: number;  // -2, -1, 0, +1, +2 (port to starboard)
    depth_m?: number;
    isLand?: boolean;       // True if node is above sea level (GEBCO)
}

/** Weather sample at a point in spacetime */
interface WeatherSample {
    windSpeed: number;      // True wind speed (kts)
    windDir: number;        // True wind direction (degrees, FROM)
    waveHeight: number;     // Significant wave height (m)
    swellPeriod?: number;   // Swell period (s)
}

/** A* node in the priority queue */
interface AStarNode4D {
    nodeId: number;         // MeshNode id
    gCost: number;          // Accumulated cost (hours * penalty)
    gTime: number;          // Accumulated time (hours from departure)
    fCost: number;          // gCost + heuristic
}

// ══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ══════════════════════════════════════════════════════════════════════

const EARTH_RADIUS_NM = 3440.065;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

// Default corridor parameters
const DEFAULT_CORRIDOR_WIDTH_NM = 30;
const DEFAULT_LATERAL_STEPS = 2;   // ±15 NM, ±30 NM

// Penalty weights
const HEADWIND_PENALTY_POWER = 1.4;     // 40% slower in strong headwind (power)
const BEAM_WIND_BONUS_SAIL = 0.85;      // 15% faster on beam reach (sail)
const UPWIND_PENALTY_SAIL = 1.6;        // 60% slower going upwind (sail < 45°)
const LIGHT_AIR_PENALTY_SAIL = 1.5;     // 50% slower in < 5 kts (sail)
const GALE_PENALTY = 3.0;              // Massive penalty near limits
const IMPASSABLE = 999999;              // Effectively blocks the node

// Coastal pilotage corridor constants
const SEAMARK_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — chart data rarely changes
const CHANNEL_BUFFER_DEG = 0.00005;  // ~5.5m safety buffer for vessel beam
const CHANNEL_BBOX_RADIUS_NM = 5;   // How far from marina to search for seamarks
const OVERPASS_TIMEOUT = 25;         // Overpass API timeout in seconds

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
    type: string;        // seamark:type (e.g. 'beacon_lateral', 'buoy_lateral')
    category: string;    // 'port' | 'starboard' | 'cardinal' | 'safe_water' | 'unknown'
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
    polygon: [number, number][];  // [lon, lat][] ring (closed)
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
    const latDelta = radiusNM / 60;    // 1nm ≈ 1 minute of latitude
    const lonDelta = radiusNM / (60 * Math.cos(lat * DEG_TO_RAD));
    const bbox = `${(lat - latDelta).toFixed(4)},${(lon - lonDelta).toFixed(4)},${(lat + latDelta).toFixed(4)},${(lon + lonDelta).toFixed(4)}`;

    // Check cache
    const cacheKey = bbox;
    const cached = seamarkCache.get(cacheKey);
    if (cached && (Date.now() - cached.fetchedAt) < SEAMARK_CACHE_TTL_MS) {
        console.log(`[Pilotage] Seamark cache HIT: ${cached.data.length} elements`);
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
        console.log(`[Pilotage] Fetching seamarks for bbox ${bbox}...`);
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
        console.log(`[Pilotage] ✅ Fetched ${elements.length} seamark elements`);

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
        const category = tags['seamark:beacon_lateral:category']
            || tags['seamark:buoy_lateral:category']
            || '';

        if (category === 'port') return 'port';
        if (category === 'starboard') return 'starboard';

        // Fall back to colour + IALA region mapping
        const colour = tags['seamark:beacon_lateral:colour']
            || tags['seamark:buoy_lateral:colour']
            || tags['seamark:lateral:colour']
            || '';

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
        const shape = tags['seamark:beacon_lateral:shape']
            || tags['seamark:buoy_lateral:shape']
            || '';
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
    console.log(`[Pilotage] IALA Region: ${region} (${region === 'A' ? 'Red=Port' : 'Red=Starboard "RRR"'})`);

    const marks: NavMark[] = [];

    for (const el of elements) {
        const tags = el.tags || {};
        const seamarkType = tags['seamark:type'] || '';

        // Only process navigational marks (lateral, cardinal, safe_water)
        if (!seamarkType.includes('lateral') &&
            !seamarkType.includes('cardinal') &&
            !seamarkType.includes('safe_water')) continue;

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
function buildSafeWaterCorridor(
    marks: NavMark[],
    originLat: number,
    originLon: number,
): SafeWaterCorridor {
    const portMarks = marks.filter(m => m.category === 'port').sort((a, b) => a.distFromOrigin - b.distFromOrigin);
    const stbMarks = marks.filter(m => m.category === 'starboard').sort((a, b) => a.distFromOrigin - b.distFromOrigin);

    console.log(`[Pilotage] Port marks: ${portMarks.length}, Starboard marks: ${stbMarks.length}`);

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

    console.log(`[Pilotage] ✅ Channel polygon: ${polygonPoints.length} vertices, ${gates.length} gates`);
    console.log(`[Pilotage] Handshake point: ${handshakePoint.lat.toFixed(4)}, ${handshakePoint.lon.toFixed(4)} (${lastGate.distFromOrigin.toFixed(2)} nm from marina)`);

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
        const xi = polygon[i][0], yi = polygon[i][1];
        const xj = polygon[j][0], yj = polygon[j][1];
        if (((yi > lat) !== (yj > lat)) &&
            (lon < (xj - xi) * (lat - yi) / (yj - yi) + xi)) {
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
    console.log(`[Pilotage] Building ${label} corridor at ${lat.toFixed(4)}, ${lon.toFixed(4)}...`);

    const elements = await fetchSeamarks(lat, lon);
    const marks = parseNavMarks(elements, lat, lon);

    console.log(`[Pilotage] ${marks.length} navigational marks classified:`);
    const categoryCounts: Record<string, number> = {};
    for (const m of marks) {
        categoryCounts[m.category] = (categoryCounts[m.category] || 0) + 1;
    }
    for (const [cat, count] of Object.entries(categoryCounts)) {
        console.log(`  ${cat}: ${count}`);
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
        console.log(`[Stitcher] Departure leg: ${departureCorridor.centerline.length} waypoints`);
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
        console.log(`[Stitcher] Arrival leg: ${arrivalCorridor.centerline.length} waypoints`);
    }

    console.log(`[Stitcher] ✅ Stitched route: ${stitched.length} total waypoints (D:${departureEndIdx}/A:${arrivalStartIdx})`);

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
    const a = Math.sin(dLat / 2) ** 2 +
        Math.cos(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) *
        Math.sin(dLon / 2) ** 2;
    return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(a));
}

/** Initial bearing from point 1 to point 2 (degrees, clockwise from north) */
function bearing(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const dLon = (lon2 - lon1) * DEG_TO_RAD;
    const y = Math.sin(dLon) * Math.cos(lat2 * DEG_TO_RAD);
    const x = Math.cos(lat1 * DEG_TO_RAD) * Math.sin(lat2 * DEG_TO_RAD) -
        Math.sin(lat1 * DEG_TO_RAD) * Math.cos(lat2 * DEG_TO_RAD) * Math.cos(dLon);
    return ((Math.atan2(y, x) * RAD_TO_DEG) + 360) % 360;
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

    const lat2 = Math.asin(
        Math.sin(latR) * Math.cos(angDist) +
        Math.cos(latR) * Math.sin(angDist) * Math.cos(brng)
    );
    const lon2 = lonR + Math.atan2(
        Math.sin(brng) * Math.sin(angDist) * Math.cos(latR),
        Math.cos(angDist) - Math.sin(latR) * Math.sin(lat2)
    );

    return { lat: lat2 * RAD_TO_DEG, lon: ((lon2 * RAD_TO_DEG) + 540) % 360 - 180 };
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

    console.log(`[WeatherRouter] Generated corridor mesh: ${nodes.length} nodes (${centerline.length} rows × ${2 * lateralSteps + 1} cols)`);
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
    const coastalRows = perRowCorridorWidth.filter(w => w < DEFAULT_CORRIDOR_WIDTH_NM).length;
    console.log(`[WeatherRouter] Generated variable mesh: ${nodes.length} nodes (${centerline.length} rows × ${2 * lateralSteps + 1} cols, ${coastalRows} coastal rows)`);
    return nodes;
}

// ══════════════════════════════════════════════════════════════════════
// GEBCO LAND MASK — Elevation-based land detection
//
// Uses the same Cloud-Optimized GeoTIFF (GEBCO/ETOPO) that powers
// route-bathymetric. Each mesh node is checked against actual terrain
// elevation: if above sea level → isLand = true → A* skips it.
//
// This replaces the unreliable weather-based heuristic that guessed
// land from zero wind/waves (failed in calm conditions and near rivers).
// ══════════════════════════════════════════════════════════════════════

// @ts-ignore: Deno ESM import
import { fromUrl } from "https://esm.sh/geotiff@2.1.3?bundle-deps&target=deno";

const SUPABASE_URL_ENV = Deno.env.get("SUPABASE_URL") || "";
const LANDMASK_COG_URL = `${SUPABASE_URL_ENV}/storage/v1/object/public/gebco-tiles/thalassa_bathymetry_global.tif`;
const LANDMASK_MAX_GRID = 300;

/**
 * Fetch GEBCO elevation data for a bounding box.
 * Returns a grid of elevation values (negative = underwater, positive = land).
 *
 * Uses HTTP Range requests via the COG format — only downloads the
 * tiles covering the bounding box, not the entire global file.
 */
async function fetchElevationGrid(
    minLat: number, maxLat: number,
    minLon: number, maxLon: number,
): Promise<{ elevation: Int16Array; rows: number; cols: number; lats: number[]; lons: number[] } | null> {
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
                west = tp[3]; north = tp[4];
                east = tp[3] + ps[0] * imgWidth;
                south = tp[4] - ps[1] * imgHeight;
            } else {
                west = -180; south = -80; east = 180; north = 80;
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
        const elevation = new Int16Array(rawData.length);
        for (let i = 0; i < rawData.length; i++) elevation[i] = Math.round(rawData[i]);

        // Build coordinate arrays
        const globalPxLon = (east - west) / imgWidth;
        const globalPxLat = (north - south) / imgHeight;
        const winWest = west + x0 * globalPxLon;
        const winNorth = north - y0 * globalPxLat;
        const winEast = west + x1 * globalPxLon;
        const winSouth = north - y1 * globalPxLat;

        const pxLon = (winEast - winWest) / outCols;
        const pxLat = (winNorth - winSouth) / outRows;
        const lats = new Array(outRows);
        const lons = new Array(outCols);
        for (let r = 0; r < outRows; r++) lats[r] = winNorth - (r + 0.5) * pxLat;
        for (let c = 0; c < outCols; c++) lons[c] = winWest + (c + 0.5) * pxLon;

        console.log(`[LandMask] GEBCO grid ${outCols}×${outRows} (${ds}× ds) for [${minLat.toFixed(2)},${minLon.toFixed(2)}]→[${maxLat.toFixed(2)},${maxLon.toFixed(2)}]`);
        return { elevation, rows: outRows, cols: outCols, lats, lons };
    } catch (err) {
        console.warn(`[LandMask] Failed to fetch GEBCO elevation:`, err);
        return null;
    }
}

/**
 * Apply GEBCO land mask to corridor mesh nodes.
 *
 * For each mesh node, finds the nearest elevation grid cell.
 * If elevation > 0m (above sea level), marks the node as land.
 */
async function applyLandMask(nodes: MeshNode[]): Promise<number> {
    if (nodes.length === 0) return 0;

    // Compute bounding box of all mesh nodes
    let minLat = Infinity, maxLat = -Infinity;
    let minLon = Infinity, maxLon = -Infinity;
    for (const node of nodes) {
        if (node.lat < minLat) minLat = node.lat;
        if (node.lat > maxLat) maxLat = node.lat;
        if (node.lon < minLon) minLon = node.lon;
        if (node.lon > maxLon) maxLon = node.lon;
    }
    // Add 0.1° buffer (~11km) to ensure edge nodes are covered
    minLat -= 0.1; maxLat += 0.1;
    minLon -= 0.1; maxLon += 0.1;

    const grid = await fetchElevationGrid(minLat, maxLat, minLon, maxLon);
    if (!grid) {
        console.warn(`[LandMask] No elevation data — land detection disabled`);
        return 0;
    }

    // Cache the elevation grid for edge collision checking in A*
    _elevationCache = grid;

    const { elevation, rows, cols, lats, lons } = grid;
    let landCount = 0;

    for (const node of nodes) {
        // Find nearest grid cell (simple nearest-neighbor lookup)
        let bestRow = 0, bestRowDist = Infinity;
        for (let r = 0; r < rows; r++) {
            const d = Math.abs(lats[r] - node.lat);
            if (d < bestRowDist) { bestRow = r; bestRowDist = d; }
        }
        let bestCol = 0, bestColDist = Infinity;
        for (let c = 0; c < cols; c++) {
            const d = Math.abs(lons[c] - node.lon);
            if (d < bestColDist) { bestCol = c; bestColDist = d; }
        }

        const elev = elevation[bestRow * cols + bestCol];
        if (elev > 0) {
            node.isLand = true;
            landCount++;
        }
    }

    console.log(`[LandMask] ⛰️  ${landCount} land nodes blocked out of ${nodes.length} total (${(landCount / nodes.length * 100).toFixed(1)}%)`);
    return landCount;
}

// ── Elevation Grid Cache (for edge collision checking in A*) ──
let _elevationCache: {
    elevation: Int16Array;
    rows: number;
    cols: number;
    lats: number[];
    lons: number[];
} | null = null;

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
function segmentCrossesLand(
    lat1: number, lon1: number,
    lat2: number, lon2: number,
): boolean {
    if (!_elevationCache) return false;

    const { elevation, rows, cols, lats, lons } = _elevationCache;

    // Skip very short edges — node checks are sufficient
    const dLat = Math.abs(lat2 - lat1);
    const dLon = Math.abs(lon2 - lon1);
    if (dLat < 0.001 && dLon < 0.001) return false;  // < ~110m

    // Use grid bounds for O(1) index lookup instead of linear search
    const latMax = lats[0], latMin = lats[rows - 1];  // lats are N→S
    const lonMin = lons[0], lonMax = lons[cols - 1];
    const latRange = latMax - latMin;
    const lonRange = lonMax - lonMin;
    if (latRange <= 0 || lonRange <= 0) return false;

    // Sample at ~0.1 NM intervals, capped at 50 for performance
    const distDeg = Math.sqrt(dLat * dLat + dLon * dLon);
    const numSamples = Math.min(50, Math.max(3, Math.ceil(distDeg / 0.0015)));

    for (let s = 1; s < numSamples; s++) {
        const t = s / numSamples;
        const sLat = lat1 + (lat2 - lat1) * t;
        const sLon = lon1 + (lon2 - lon1) * t;

        // Direct index computation (O(1) instead of O(N))
        const ri = Math.round((latMax - sLat) / latRange * (rows - 1));
        const ci = Math.round((sLon - lonMin) / lonRange * (cols - 1));

        // Bounds check
        if (ri < 0 || ri >= rows || ci < 0 || ci >= cols) continue;

        if (elevation[ri * cols + ci] > 0) {
            return true;  // 🔴 Crosses land!
        }
    }
    return false;
}

/**
 * Densify a centerline by adding intermediate waypoints along long segments.
 *
 * Coastal legs (near departure/arrival) use ~0.1 NM (~185m) spacing
 * so the A* mesh can navigate winding rivers and tight passages.
 * Ocean legs use ~3 NM spacing (enough for corridor weather optimization).
 *
 * @param maxStepCoastalNM - Maximum spacing for coastal departures (~0.1 NM)
 * @param maxStepOceanNM   - Maximum spacing for ocean legs (~3 NM)
 * @param coastalRadiusNM  - Distance from origin/destination treated as coastal
 */
function densifyCenterline(
    centerline: CenterlineWaypoint[],
    originLat: number,
    originLon: number,
    destLat: number,
    destLon: number,
    maxStepCoastalNM: number = 0.15,
    maxStepOceanNM: number = 3.0,
    coastalRadiusNM: number = 15.0,
): CenterlineWaypoint[] {
    if (centerline.length < 2) return centerline;

    const dense: CenterlineWaypoint[] = [centerline[0]];

    for (let i = 1; i < centerline.length; i++) {
        const prev = centerline[i - 1];
        const cur = centerline[i];
        const segDist = haversineNM(prev.lat, prev.lon, cur.lat, cur.lon);

        // Determine if this segment is coastal or ocean
        const distFromOrigin = haversineNM(prev.lat, prev.lon, originLat, originLon);
        const distToDest = haversineNM(cur.lat, cur.lon, destLat, destLon);
        const isCoastal = distFromOrigin < coastalRadiusNM || distToDest < coastalRadiusNM;
        const maxStep = isCoastal ? maxStepCoastalNM : maxStepOceanNM;

        if (segDist > maxStep) {
            // Subdivide this segment
            const steps = Math.ceil(segDist / maxStep);
            for (let s = 1; s < steps; s++) {
                const t = s / steps;
                dense.push({
                    lat: prev.lat + (cur.lat - prev.lat) * t,
                    lon: prev.lon + (cur.lon - prev.lon) * t,
                    name: `auto-${i}-${s}`,
                });
            }
        }
        dense.push(cur);
    }

    if (dense.length !== centerline.length) {
        console.log(`[WeatherRouter] Densified centerline: ${centerline.length} → ${dense.length} waypoints`);
    }
    return dense;
}

/** Average two bearings, handling wrap-around */
function averageBearing(b1: number, b2: number): number {
    const x = Math.cos(b1 * DEG_TO_RAD) + Math.cos(b2 * DEG_TO_RAD);
    const y = Math.sin(b1 * DEG_TO_RAD) + Math.sin(b2 * DEG_TO_RAD);
    return ((Math.atan2(y, x) * RAD_TO_DEG) + 360) % 360;
}

/**
 * Get the adjacency list for the corridor mesh.
 *
 * Connectivity rules:
 *   - Each node in row `i` connects to ALL nodes in row `i+1`
 *     (this allows the A* to explore lateral moves between rows)
 *   - No backward edges (row i+1 → row i)
 *   - No edges within the same row (forces forward progress)
 *
 * This creates a DAG (Directed Acyclic Graph) which guarantees
 * the A* terminates and prevents cycling.
 */
function buildAdjacencyList(
    nodes: MeshNode[],
    nodesPerRow: number,
    numRows: number,
): Map<number, number[]> {
    const adj = new Map<number, number[]>();

    for (let row = 0; row < numRows - 1; row++) {
        const rowStart = row * nodesPerRow;
        const nextRowStart = (row + 1) * nodesPerRow;

        for (let col = 0; col < nodesPerRow; col++) {
            const fromId = rowStart + col;
            const neighbors: number[] = [];

            // Connect to ALL nodes in the next row
            for (let nc = 0; nc < nodesPerRow; nc++) {
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
    /** Bounding box */
    minLat: number; maxLat: number; minLon: number; maxLon: number;
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
async function fetchWeatherGrid(
    nodes: MeshNode[],
    departureTime: Date,
    _maxHours: number = 240,
): Promise<WeatherGrid> {
    // Compute bounding box of all mesh nodes
    let minLat = Infinity, maxLat = -Infinity;
    let minLon = Infinity, maxLon = -Infinity;
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
        hoursAvailable: 0,
        minLat, maxLat, minLon, maxLon,
    };

    // Generate grid sample points
    const samplePoints: { lat: number; lon: number }[] = [];
    for (let lat = Math.floor(minLat * 2) / 2; lat <= maxLat; lat += resolution) {
        for (let lon = Math.floor(minLon * 2) / 2; lon <= maxLon; lon += resolution) {
            samplePoints.push({ lat: Math.round(lat * 100) / 100, lon: Math.round(lon * 100) / 100 });
        }
    }

    console.log(`[WeatherRouter] Fetching weather for ${samplePoints.length} grid points (${(maxLat - minLat).toFixed(1)}° × ${(maxLon - minLon).toFixed(1)}°)`);

    // Fetch in parallel batches of 10
    const BATCH_SIZE = 10;
    const supabaseUrl = Deno.env.get("SUPABASE_URL") || "";

    for (let i = 0; i < samplePoints.length; i += BATCH_SIZE) {
        const batch = samplePoints.slice(i, i + BATCH_SIZE);

        const results = await Promise.allSettled(
            batch.map(async (pt) => {
                try {
                    // Call our own WeatherKit proxy edge function (POST with JSON body)
                    const url = `${supabaseUrl}/functions/v1/fetch-weatherkit`;
                    const resp = await fetch(url, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                            'Authorization': `Bearer ${Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || Deno.env.get("SUPABASE_ANON_KEY") || ""}`,
                        },
                        body: JSON.stringify({
                            lat: pt.lat,
                            lon: pt.lon,
                            dataSets: ['forecastHourly'],
                        }),
                        signal: AbortSignal.timeout(10000),
                    });

                    if (!resp.ok) return null;

                    const data = await resp.json();
                    const hourly = data?.forecastHourly?.hours || [];

                    const samples: WeatherSample[] = hourly.map((h: {
                        forecastStart: string;
                        windSpeed?: number;      // km/h from WeatherKit
                        windDirection?: number;   // degrees
                    }) => ({
                        windSpeed: ((h.windSpeed || 0) / 1.852), // km/h → kts
                        windDir: h.windDirection || 0,
                        waveHeight: 0, // Will be filled from Pierson-Moskowitz model
                        swellPeriod: undefined,
                    }));

                    return { key: `${pt.lat},${pt.lon}`, samples };
                } catch (e) {
                    console.warn('[index]', e);
                    return null;
                }
            })
        );

        for (const result of results) {
            if (result.status === 'fulfilled' && result.value) {
                grid.data.set(result.value.key, result.value.samples);
                grid.hoursAvailable = Math.max(grid.hoursAvailable, result.value.samples.length);
            }
        }
    }

    console.log(`[WeatherRouter] WeatherKit grid loaded: ${grid.data.size} points, ${grid.hoursAvailable}h forecast`);

    // ── NOMADS WaveWatch III — Swell data enrichment ──
    // Fetches significant wave height + peak swell period from NOAA
    // WaveWatch III global model at 0.5° resolution (3-hourly, 180h forecast)
    try {
        await enrichGridWithWaveData(grid);
    } catch (waveErr) {
        console.warn(`[WeatherRouter] WaveWatch III unavailable, using wind-only routing:`, waveErr);
    }

    return grid;
}

/**
 * Enrich the weather grid with NOAA WaveWatch III wave data.
 *
 * Uses the NOMADS GRIB Filter to request a subregion in JSON format,
 * avoiding the need for a GRIB2 decoder in the Edge Function.
 *
 * Endpoint: https://nomads.ncep.noaa.gov/cgi-bin/filter_wave_multi.cgi
 *
 * Variables:
 *   HTSGW — Significant Height of Combined Wind Waves and Swell (m)
 *   PERPW — Primary Wave Mean Period (s)
 *
 * We request the latest available cycle and extract data for our grid points.
 */
async function enrichGridWithWaveData(grid: WeatherGrid): Promise<void> {
    // Get the latest WaveWatch III cycle (runs at 00, 06, 12, 18 UTC)
    const now = new Date();
    const cycleHour = Math.floor(now.getUTCHours() / 6) * 6;
    const cycleDate = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
    const cycleStr = String(cycleHour).padStart(2, '0');

    // Request subregion matching our grid
    const { minLat, maxLat, minLon, maxLon } = grid;
    // WW3 longitude is 0-360, convert from -180/180
    const ww3LonMin = minLon < 0 ? minLon + 360 : minLon;
    const ww3LonMax = maxLon < 0 ? maxLon + 360 : maxLon;

    // Fetch multiple forecast hours (3-hourly steps)
    const forecastHours = [0, 3, 6, 12, 24, 48, 72, 96, 120, 144, 168];
    const waveData = new Map<string, { waveH: number[]; period: number[] }>();

    const NOMADS_BASE = 'https://nomads.ncep.noaa.gov/cgi-bin/filter_wave_multi_1.cgi';

    for (const fHour of forecastHours) {
        const fStr = String(fHour).padStart(3, '0');
        const file = `multi_1.glo_30m.t${cycleStr}z.f${fStr}.grib2`;
        const dir = `/multi_1.${cycleDate}/multi_1.${cycleDate}_${cycleStr}`;

        // Request specific variables and subregion
        const params = new URLSearchParams({
            'file': file,
            'var_HTSGW': 'on',
            'var_PERPW': 'on',
            'lev_surface': 'on',
            'subregion': '',
            'leftlon': String(Math.floor(ww3LonMin)),
            'rightlon': String(Math.ceil(ww3LonMax)),
            'toplat': String(Math.ceil(maxLat)),
            'bottomlat': String(Math.floor(minLat)),
            'dir': dir,
        });

        try {
            const url = `${NOMADS_BASE}?${params.toString()}`;
            const resp = await fetch(url, { signal: AbortSignal.timeout(6000) });

            if (!resp.ok) continue;

            // The GRIB filter returns raw GRIB2 — we need to parse it
            // For now, fall back to sampling known points via the JSON API
            // This is a placeholder for when we add a proper GRIB2 decoder
            const blob = await resp.arrayBuffer();
            if (blob.byteLength < 100) continue;

            // Simple estimation: use the average wave height for the region
            // A proper implementation would decode the GRIB2 binary
            console.log(`[WeatherRouter] WW3 f${fStr}: ${blob.byteLength} bytes received`);

        } catch (e) {
            console.warn('[index]', e);
            // Individual forecast hour failed — continue
        }
    }

    // Fallback: use a simple climatological wave estimation
    // based on latitude and wind speed from the existing grid
    console.log(`[WeatherRouter] Enriching wave data from wind-wave relationship model`);

    for (const [key, samples] of grid.data.entries()) {
        const [latStr] = key.split(',');
        const lat = parseFloat(latStr);
        const absLat = Math.abs(lat);

        for (let h = 0; h < samples.length; h++) {
            const ws = samples[h].windSpeed;

            // Pierson-Moskowitz wind-wave relationship:
            // H_s ≈ 0.0246 * U^2 (fully developed sea state)
            // We use a fraction since waves rarely fully develop
            const developmentFactor = 0.5; // 50% development typical for 12h fetch
            const windWaveH = 0.0246 * Math.pow(ws, 2) * developmentFactor;

            // Swell component (increases with latitude and season)
            const swellBase = absLat > 40 ? 2.5 : absLat > 20 ? 1.5 : 1.0;
            const totalWaveH = Math.sqrt(windWaveH ** 2 + swellBase ** 2); // RMS combination

            // Peak period estimation: T_p ≈ 0.729 * U (Pierson-Moskowitz)
            const period = Math.max(4, 0.729 * Math.sqrt(ws) * 2);

            samples[h].waveHeight = Math.round(totalWaveH * 10) / 10;
            samples[h].swellPeriod = Math.round(period * 10) / 10;
        }
    }

    console.log(`[WeatherRouter] Wave data enriched for ${grid.data.size} grid points`);
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
): WeatherSample {
    // Snap to grid
    const res = grid.resolution;
    const gLat0 = Math.floor(lat / res) * res;
    const gLon0 = Math.floor(lon / res) * res;
    const gLat1 = gLat0 + res;
    const gLon1 = gLon0 + res;

    // Fractional position within the grid cell
    const fLat = (lat - gLat0) / res;
    const fLon = (lon - gLon0) / res;

    // Hour index (clamp to available range)
    const h = Math.max(0, Math.min(hourFromDeparture, grid.hoursAvailable - 1));
    const h0 = Math.floor(h);
    const h1 = Math.min(h0 + 1, grid.hoursAvailable - 1);
    const fH = h - h0;

    // Get 4 corner samples (fall back to nearest if missing)
    const corners = [
        getSample(grid, gLat0, gLon0, h0, h1, fH),
        getSample(grid, gLat0, gLon1, h0, h1, fH),
        getSample(grid, gLat1, gLon0, h0, h1, fH),
        getSample(grid, gLat1, gLon1, h0, h1, fH),
    ];

    // Bilinear interpolation
    const top = lerpSample(corners[0], corners[1], fLon);
    const bot = lerpSample(corners[2], corners[3], fLon);
    return lerpSample(top, bot, fLat);
}

function getSample(
    grid: WeatherGrid,
    lat: number, lon: number,
    h0: number, h1: number, fH: number,
): WeatherSample {
    const key = `${Math.round(lat * 100) / 100},${Math.round(lon * 100) / 100}`;
    const samples = grid.data.get(key);

    if (!samples || samples.length === 0) {
        return { windSpeed: 10, windDir: 0, waveHeight: 1.0 }; // Calm default
    }

    const s0 = samples[Math.min(h0, samples.length - 1)];
    const s1 = samples[Math.min(h1, samples.length - 1)];
    return lerpSample(s0, s1, fH);
}

function lerpSample(a: WeatherSample, b: WeatherSample, t: number): WeatherSample {
    return {
        windSpeed: a.windSpeed + (b.windSpeed - a.windSpeed) * t,
        windDir: lerpAngle(a.windDir, b.windDir, t),
        waveHeight: a.waveHeight + (b.waveHeight - a.waveHeight) * t,
        swellPeriod: (a.swellPeriod && b.swellPeriod)
            ? a.swellPeriod + (b.swellPeriod - a.swellPeriod) * t
            : a.swellPeriod || b.swellPeriod,
    };
}

/** Interpolate between two angles, handling 359° → 1° wrap */
function lerpAngle(a: number, b: number, t: number): number {
    let diff = b - a;
    if (diff > 180) diff -= 360;
    if (diff < -180) diff += 360;
    return ((a + diff * t) + 360) % 360;
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

function estimateSpeed(
    vessel: VesselParams,
    weather: WeatherSample,
    courseBearing: number,
): number {
    const twa = trueWindAngle(courseBearing, weather.windDir);
    const tws = weather.windSpeed;
    const waveH = weather.waveHeight;

    // ── Absolute limits — IMPASSABLE ──
    if (tws > vessel.max_wind_kts) return 0;
    if (waveH > vessel.max_wave_m) return 0;

    let speed = vessel.cruising_speed_kts;

    if (vessel.type === 'sail') {
        // ── SAIL — Polar-First ──
        // Select polars: custom → Tayana 55 default
        const polars = vessel.polar_data || TAYANA55_POLARS;

        // NO-GO ZONE: Cannot sail within 35° of the wind.
        // Forces A* to pick a node with a better angle.
        if (twa < 35) return 0;

        // CLOSE-HAULED TACKING (35–50°)
        // Boat speed from polars, but effective VMG is cos(TWA) × boatSpeed
        if (twa < 50) {
            const polarSpeed = interpolatePolar(polars, twa, tws);
            const vmgFactor = Math.cos(twa * DEG_TO_RAD);
            speed = polarSpeed * vmgFactor;
            speed = Math.max(speed, 0.5);
        }
        // CLOSE REACH (50–70°)
        else if (twa < 70) {
            speed = interpolatePolar(polars, twa, tws);
            const vmgFactor = 0.8 + 0.2 * ((twa - 50) / 20);
            speed *= vmgFactor;
        }
        // BEAM REACH (70–120°) — optimal, full polar speed
        else if (twa <= 120) {
            speed = interpolatePolar(polars, twa, tws);
        }
        // BROAD REACH (120–150°)
        else if (twa <= 150) {
            speed = interpolatePolar(polars, twa, tws);
        }
        // DEAD RUN (150–180°)
        else {
            speed = interpolatePolar(polars, twa, tws);
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
            if (waveH > 1.5) {
                speed *= Math.max(0.6, 1 - (waveH - 1.5) * 0.15);
            }
        } else if (twa > 60 && twa < 120) {
            if (waveH > 2.0) {
                speed *= Math.max(0.7, 1 - (waveH - 2.0) * 0.1);
            }
        }

        if (waveH > 3.0) {
            speed *= Math.max(0.5, 1 - (waveH - 3.0) * 0.15);
        }
    }

    // Near-limits steep penalty
    if (tws > vessel.max_wind_kts * 0.7 || waveH > vessel.max_wave_m * 0.7) {
        const dangerFactor = Math.max(tws / vessel.max_wind_kts, waveH / vessel.max_wave_m);
        if (dangerFactor > 0.7) {
            speed *= Math.max(0.3, 1 - (dangerFactor - 0.7) * GALE_PENALTY);
        }
    }

    return Math.max(speed, 0.1);
}



/**
 * Bilinear interpolation of polar performance data.
 */
function interpolatePolar(polar: PolarData, twa: number, tws: number): number {
    const { angles, windSpeeds, matrix } = polar;

    // Clamp to polar range
    const clampedTWA = Math.max(angles[0], Math.min(angles[angles.length - 1], twa));
    const clampedTWS = Math.max(windSpeeds[0], Math.min(windSpeeds[windSpeeds.length - 1], tws));

    // Find bounding indices
    let ai = 0;
    for (let i = 0; i < angles.length - 1; i++) {
        if (angles[i + 1] >= clampedTWA) { ai = i; break; }
    }
    let wi = 0;
    for (let i = 0; i < windSpeeds.length - 1; i++) {
        if (windSpeeds[i + 1] >= clampedTWS) { wi = i; break; }
    }

    const ai2 = Math.min(ai + 1, angles.length - 1);
    const wi2 = Math.min(wi + 1, windSpeeds.length - 1);

    // Fractions
    const fA = (ai === ai2) ? 0 : (clampedTWA - angles[ai]) / (angles[ai2] - angles[ai]);
    const fW = (wi === wi2) ? 0 : (clampedTWS - windSpeeds[wi]) / (windSpeeds[wi2] - windSpeeds[wi]);

    // Bilinear
    const v00 = matrix[ai][wi];
    const v01 = matrix[ai][wi2];
    const v10 = matrix[ai2][wi];
    const v11 = matrix[ai2][wi2];

    const top = v00 + (v01 - v00) * fW;
    const bot = v10 + (v11 - v10) * fW;
    return top + (bot - top) * fA;
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
    startIds: number[],          // Usually just the first row's center node
    goalIds: Set<number>,        // All nodes in the last row
    vessel: VesselParams,
    weatherGrid: WeatherGrid,
    goalLat: number,
    goalLon: number,
    pilotageConstraints?: {
        departureCorridor: SafeWaterCorridor | null;
        arrivalCorridor: SafeWaterCorridor | null;
        legBoundaries: { departureEndIdx: number; arrivalStartIdx: number };
        nodesPerRow: number;
    },
): { path: MeshNode[]; totalTimeH: number; totalCost: number } | null {
    const N = nodes.length;

    // Best g-cost and g-time arrays
    const gCost = new Float64Array(N).fill(Infinity);
    const gTime = new Float64Array(N).fill(Infinity);
    const parent = new Int32Array(N).fill(-1);

    // Priority queue (sorted array — mesh is small enough)
    const heap: AStarNode4D[] = [];

    // Seed start nodes
    for (const sid of startIds) {
        gCost[sid] = 0;
        gTime[sid] = 0;
        const h = haversineNM(nodes[sid].lat, nodes[sid].lon, goalLat, goalLon) / vessel.cruising_speed_kts;
        heap.push({ nodeId: sid, gCost: 0, gTime: 0, fCost: h });
    }

    // Sort by fCost (ascending)
    heap.sort((a, b) => a.fCost - b.fCost);

    let expanded = 0;

    while (heap.length > 0) {
        const current = heap.shift()!;
        expanded++;

        // Skip if we've found a better path to this node
        if (current.gCost > gCost[current.nodeId] + 0.001) continue;

        // Check if we've reached a goal
        if (goalIds.has(current.nodeId)) {
            console.log(`[WeatherRouter] A* found path: ${expanded} expansions, ${current.gTime.toFixed(1)}h, cost=${current.gCost.toFixed(2)}`);
            return reconstructPath(nodes, parent, current.nodeId, current.gTime, current.gCost);
        }

        // Expand neighbors
        const neighbors = adjacency.get(current.nodeId) || [];
        for (const nid of neighbors) {
            const fromNode = nodes[current.nodeId];
            const toNode = nodes[nid];

            // ── PILOTAGE CHECK: Strict boundary enforcement ──
            // If this node is in a coastal leg with a channel polygon,
            // reject any node outside the safe-water corridor.
            if (pilotageConstraints) {
                const { departureCorridor, arrivalCorridor, legBoundaries, nodesPerRow } = pilotageConstraints;
                const nodeRow = Math.floor(nid / nodesPerRow);

                // Check if node is in departure leg
                if (nodeRow < legBoundaries.departureEndIdx && departureCorridor?.valid) {
                    if (!pointInPolygon(toNode.lon, toNode.lat, departureCorridor.polygon)) {
                        continue; // Outside channel — grounding risk — skip
                    }
                }

                // Check if node is in arrival leg
                if (nodeRow >= legBoundaries.arrivalStartIdx && arrivalCorridor?.valid) {
                    if (!pointInPolygon(toNode.lon, toNode.lat, arrivalCorridor.polygon)) {
                        continue; // Outside channel — grounding risk — skip
                    }
                }
            }

            // Distance between nodes
            const distNM = haversineNM(fromNode.lat, fromNode.lon, toNode.lat, toNode.lon);

            // Course bearing from current to neighbor
            const courseBrg = bearing(fromNode.lat, fromNode.lon, toNode.lat, toNode.lon);

            // Weather at the CURRENT node and time
            const weather = interpolateWeather(
                weatherGrid,
                fromNode.lat, fromNode.lon,
                current.gTime,
            );

            // ── LAND DETECTION: GEBCO elevation-based landmask ──
            // 1. Node check: is the destination node above sea level?
            if (toNode.isLand) {
                continue; // 🔴 Node is on land
            }

            // 2. Edge check: does the straight line between from→to cross land?
            //    Only check long edges (>1 NM) where teleportation is the risk.
            //    Short edges between nearby bathymetric waypoints can trust
            //    node-level checks — close water nodes likely have water between them.
            if (distNM > 1.0 && segmentCrossesLand(fromNode.lat, fromNode.lon, toNode.lat, toNode.lon)) {
                continue; // 🔴 Edge crosses land
            }

            // Estimate speed through this weather
            const speed = estimateSpeed(vessel, weather, courseBrg);

            if (speed <= 0) continue; // IMPASSABLE conditions

            // Time to traverse this edge
            const edgeTimeH = distNM / speed;

            // Cost = time × comfort penalty
            // (A pure time optimization would just use edgeTimeH)
            // We add a comfort factor that penalizes rough conditions
            const comfortPenalty = calculateComfortPenalty(weather, vessel);
            const edgeCost = edgeTimeH * comfortPenalty;

            const newGCost = current.gCost + edgeCost;
            const newGTime = current.gTime + edgeTimeH;

            if (newGCost < gCost[nid]) {
                gCost[nid] = newGCost;
                gTime[nid] = newGTime;
                parent[nid] = current.nodeId;

                // Heuristic: remaining distance / cruising speed
                const heuristic = haversineNM(toNode.lat, toNode.lon, goalLat, goalLon) / vessel.cruising_speed_kts;

                // Binary search insert (keep sorted)
                const fCost = newGCost + heuristic;
                const node4d: AStarNode4D = { nodeId: nid, gCost: newGCost, gTime: newGTime, fCost };

                let lo = 0, hi = heap.length;
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
function calculateComfortPenalty(weather: WeatherSample, vessel: VesselParams): number {
    let penalty = 1.0;

    // Wave discomfort (exponential above 2m)
    if (weather.waveHeight > 1.5) {
        penalty += Math.pow((weather.waveHeight - 1.5) / vessel.max_wave_m, 2) * 0.5;
    }

    // Wind approaching limits
    const windRatio = weather.windSpeed / vessel.max_wind_kts;
    if (windRatio > 0.5) {
        penalty += Math.pow(windRatio - 0.5, 2) * 1.5;
    }

    return penalty;
}

/** Reconstruct the path from parent array */
function reconstructPath(
    nodes: MeshNode[],
    parent: Int32Array,
    goalId: number,
    totalTimeH: number,
    totalCost: number,
): { path: MeshNode[]; totalTimeH: number; totalCost: number } {
    const path: MeshNode[] = [];
    let current = goalId;
    while (current !== -1) {
        path.unshift(nodes[current]);
        current = parent[current];
    }
    return { path, totalTimeH, totalCost };
}

// ══════════════════════════════════════════════════════════════════════
// ROUTE SIMPLIFICATION
// ══════════════════════════════════════════════════════════════════════

/**
 * Simplify the A* path using Ramer-Douglas-Peucker.
 *
 * The raw A* path through the mesh has a node at every centerline row,
 * which is too dense. RDP reduces to only the significant turns.
 */
function simplifyPath(path: MeshNode[], toleranceNM: number = 2.0): MeshNode[] {
    if (path.length <= 2) return path;

    // Find the point with maximum perpendicular distance
    let maxDist = 0;
    let maxIdx = 0;

    const start = path[0];
    const end = path[path.length - 1];

    for (let i = 1; i < path.length - 1; i++) {
        const dist = perpendicularDistanceNM(path[i], start, end);
        if (dist > maxDist) {
            maxDist = dist;
            maxIdx = i;
        }
    }

    if (maxDist > toleranceNM) {
        const left = simplifyPath(path.slice(0, maxIdx + 1), toleranceNM);
        const right = simplifyPath(path.slice(maxIdx), toleranceNM);
        return [...left.slice(0, -1), ...right];
    }

    return [path[0], path[path.length - 1]];
}

function perpendicularDistanceNM(point: MeshNode, lineStart: MeshNode, lineEnd: MeshNode): number {
    // Cross-track distance using spherical geometry
    const d13 = haversineNM(lineStart.lat, lineStart.lon, point.lat, point.lon);
    const brg13 = bearing(lineStart.lat, lineStart.lon, point.lat, point.lon) * DEG_TO_RAD;
    const brg12 = bearing(lineStart.lat, lineStart.lon, lineEnd.lat, lineEnd.lon) * DEG_TO_RAD;
    return Math.abs(Math.asin(Math.sin(d13 / EARTH_RADIUS_NM) * Math.sin(brg13 - brg12)) * EARTH_RADIUS_NM);
}

// ══════════════════════════════════════════════════════════════════════
// MAIN HANDLER
// ══════════════════════════════════════════════════════════════════════

Deno.serve(async (req: Request) => {
    if (req.method === "OPTIONS") return corsResponse(null, 204);
    if (req.method !== "POST") return jsonResponse({ error: "POST only" }, 405);

    try {
        const body: WeatherRouteRequest = await req.json();
        const { centerline, departure_time, vessel } = body;

        // ── Validate ──
        if (!centerline || centerline.length < 2) {
            return jsonResponse({ error: "centerline must have ≥ 2 waypoints" }, 400);
        }
        if (!departure_time) {
            return jsonResponse({ error: "departure_time (ISO 8601) required" }, 400);
        }
        if (!vessel || !vessel.type || !vessel.cruising_speed_kts) {
            return jsonResponse({ error: "vessel { type, cruising_speed_kts, max_wind_kts, max_wave_m } required" }, 400);
        }

        // Scale corridor width with passage distance for meaningful weather routing
        const roughDistNM = centerline.reduce((sum, wp, i) => {
            if (i === 0) return 0;
            return sum + haversineNM(centerline[i - 1].lat, centerline[i - 1].lon, wp.lat, wp.lon);
        }, 0);
        const dynamicCorridorWidth = Math.min(120, Math.max(30, roughDistNM * 0.15));
        const corridorWidth = body.corridor_width_nm || dynamicCorridorWidth;
        // More lateral steps for longer passages
        const dynamicLateralSteps = roughDistNM > 200 ? 3 : DEFAULT_LATERAL_STEPS;
        const lateralSteps = body.lateral_steps || dynamicLateralSteps;
        const nodesPerRow = 2 * lateralSteps + 1;
        const departureDate = new Date(departure_time);

        console.log(`[WeatherRouter] ── START ────────────────────────────────`);
        console.log(`[WeatherRouter] ${centerline.length} centerline WPs, ${vessel.type} @ ${vessel.cruising_speed_kts} kts`);
        console.log(`[WeatherRouter] Corridor: ±${corridorWidth} NM, ${lateralSteps} lateral steps`);
        console.log(`[WeatherRouter] Departure: ${departureDate.toISOString()}`);

        const t0 = Date.now();

        // ══════════════════════════════════════════════════════════════
        // STEP 0: TRIP SANDWICH — Project Deep Water Handshake Points
        //
        // Instead of Overpass API seamarks (unreliable), we project
        // a point 15 NM from each berth along the bearing to the
        // destination. The dotted exit/entry legs connect berth → 
        // handshake point. The A* only runs between the two
        // handshake points (the "ocean passage" filling).
        // ══════════════════════════════════════════════════════════════

        const HANDSHAKE_OFFSET_NM = 15; // Project 15 NM offshore
        const departureWp = centerline[0];
        const arrivalWp = centerline[centerline.length - 1];

        // Project departure handshake: 15 NM from berth toward destination
        const depToArrBearing = bearing(departureWp.lat, departureWp.lon, arrivalWp.lat, arrivalWp.lon);
        const depHandshakePt = projectPoint(departureWp.lat, departureWp.lon, depToArrBearing, HANDSHAKE_OFFSET_NM);

        // Project arrival handshake: 15 NM from destination back toward departure
        const arrToDepBearing = bearing(arrivalWp.lat, arrivalWp.lon, departureWp.lat, departureWp.lon);
        const arrHandshakePt = projectPoint(arrivalWp.lat, arrivalWp.lon, arrToDepBearing, HANDSHAKE_OFFSET_NM);

        console.log(`[WeatherRouter] ⏱ Step 0 (Handshakes): ${Date.now() - t0}ms`);
        console.log(`[WeatherRouter] Departure handshake: ${depHandshakePt.lat.toFixed(4)}, ${depHandshakePt.lon.toFixed(4)} (${HANDSHAKE_OFFSET_NM} NM from berth)`);
        console.log(`[WeatherRouter] Arrival handshake: ${arrHandshakePt.lat.toFixed(4)}, ${arrHandshakePt.lon.toFixed(4)} (${HANDSHAKE_OFFSET_NM} NM from destination)`);

        // ══════════════════════════════════════════════════════════════
        // STEP 1: Build Ocean-Only Centerline
        //
        // The A* mesh only covers handshake → handshake.
        // Any intermediate waypoints from the user are included.
        // ══════════════════════════════════════════════════════════════

        const routeCenterline: CenterlineWaypoint[] = [
            { lat: depHandshakePt.lat, lon: depHandshakePt.lon, name: 'Deep Water Start' },
            // Include intermediate waypoints from user (skip first/last = berth)
            ...centerline.slice(1, -1),
            { lat: arrHandshakePt.lat, lon: arrHandshakePt.lon, name: 'Deep Water End' },
        ];

        const routingMode = 'trip_sandwich';
        const stitched = {
            departureCorridor: null as SafeWaterCorridor | null,
            arrivalCorridor: null as SafeWaterCorridor | null,
            legBoundaries: { departureEndIdx: 0, arrivalStartIdx: routeCenterline.length },
        };

        console.log(`[WeatherRouter] Ocean centerline: ${routeCenterline.length} waypoints`);

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
        // Nodes above sea level are marked isLand = true and will be
        // skipped by A*. This prevents routing over land masses.
        // ══════════════════════════════════════════════════════════════

        const landNodeCount = await applyLandMask(meshNodes);
        console.log(`[WeatherRouter] ⏱ Step 2b (GEBCO): ${Date.now() - t0}ms — ${landNodeCount} land nodes`);
        if (landNodeCount > 0) {
            console.log(`[WeatherRouter] Land mask applied: ${landNodeCount} impassable nodes`);
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
        const maxHours = Math.min(240, Math.ceil(totalDistNM / vessel.cruising_speed_kts * 1.5));

        const weatherGrid = await fetchWeatherGrid(meshNodes, departureDate, maxHours);
        console.log(`[WeatherRouter] ⏱ Step 4 (Weather): ${Date.now() - t0}ms`);
        console.log(`[WeatherRouter] 🌤️ Weather grid: ${weatherGrid.data.size} points with data, ${weatherGrid.hoursAvailable}h forecast`);

        // ══════════════════════════════════════════════════════════════
        // STEP 5: Run 4D A* with Pilotage Constraints
        //
        // The A* now receives the channel polygons and leg boundaries.
        // Nodes in departure/arrival legs that fall outside their
        // respective channel polygons are treated as IMPASSABLE.
        // Ocean leg nodes are unconstrained (weather-optimized).
        // ══════════════════════════════════════════════════════════════

        const startCenter = lateralSteps;
        const startIds = [startCenter];

        const lastRowStart = (routeCenterline.length - 1) * nodesPerRow;
        const goalIds = new Set<number>();
        for (let c = 0; c < nodesPerRow; c++) {
            goalIds.add(lastRowStart + c);
        }

        const goalWp = routeCenterline[routeCenterline.length - 1];

        // ── Diagnostic logging ──
        const landNodes = meshNodes.filter(n => n.isLand).length;
        console.log(`[WeatherRouter] Mesh: ${meshNodes.length} nodes, ${landNodes} land (${(landNodes / meshNodes.length * 100).toFixed(1)}%), weather grid: ${weatherGrid.data.size} pts, ${weatherGrid.hoursAvailable}h`);

        // ── A* Attempt 1: Full pilotage constraints ──
        let result = corridorAStar(
            meshNodes,
            adjacency,
            startIds,
            goalIds,
            vessel,
            weatherGrid,
            goalWp.lat,
            goalWp.lon,
            // Pilotage constraints — only if we have channel data
            (stitched.departureCorridor || stitched.arrivalCorridor) ? {
                departureCorridor: stitched.departureCorridor,
                arrivalCorridor: stitched.arrivalCorridor,
                legBoundaries: stitched.legBoundaries,
                nodesPerRow,
            } : undefined,
        );

        // ── A* Attempt 2: Drop pilotage constraints ──
        if (!result && (stitched.departureCorridor || stitched.arrivalCorridor)) {
            console.warn(`[WeatherRouter] A* failed with pilotage — retrying ocean-only`);
            result = corridorAStar(
                meshNodes, adjacency, startIds, goalIds,
                vessel, weatherGrid, goalWp.lat, goalWp.lon,
            );
        }

        // ── A* Attempt 3: Disable land mask ──
        if (!result && landNodes > 0) {
            console.warn(`[WeatherRouter] A* failed with land mask — retrying with land disabled`);
            for (const node of meshNodes) node.isLand = false;
            result = corridorAStar(
                meshNodes, adjacency, startIds, goalIds,
                vessel, weatherGrid, goalWp.lat, goalWp.lon,
            );
        }

        // ── A* Attempt 4: Relax vessel limits ──
        if (!result) {
            console.warn(`[WeatherRouter] A* failed — retrying with relaxed vessel limits`);
            const relaxedVessel = {
                ...vessel,
                max_wind_kts: vessel.max_wind_kts * 2,
                max_wave_m: vessel.max_wave_m * 2,
            };
            result = corridorAStar(
                meshNodes, adjacency, startIds, goalIds,
                relaxedVessel, weatherGrid, goalWp.lat, goalWp.lon,
            );
        }

        const computeMs = Date.now() - t0;

        // ── Fallback: Use raw centerline if A* completely fails ──
        if (!result) {
            console.error(`[WeatherRouter] All A* attempts failed — using direct centerline`);
            const totalDistNM_fb = routeCenterline.reduce((sum, wp, i) => {
                if (i === 0) return 0;
                return sum + haversineNM(routeCenterline[i - 1].lat, routeCenterline[i - 1].lon, wp.lat, wp.lon);
            }, 0);
            const estTimeH = totalDistNM_fb / vessel.cruising_speed_kts;

            // Build synthetic path from centerline
            result = {
                path: routeCenterline.map((wp, i) => ({
                    ...meshNodes[i * nodesPerRow + lateralSteps] || {
                        lat: wp.lat, lon: wp.lon, row: i, col: lateralSteps,
                        lateralOffset: 0, isLand: false, depth_m: undefined,
                    },
                })),
                totalTimeH: estTimeH,
                totalCost: estTimeH,
            };
        }

        // ── Step 5: Simplify path ──
        const simplified = simplifyPath(result.path, 3.0);

        // ══════════════════════════════════════════════════════════════
        // TRIP SANDWICH: Build track as 3 explicit legs
        //
        // Leg 1 (exit):    berth → deep water start (dashed, ignores land)
        // Leg 2 (passage): deep water → deep water (solid, weather-routed)
        // Leg 3 (entry):   deep water end → berth (dotted, ignores land)
        // ══════════════════════════════════════════════════════════════

        const originBerth = centerline[0];
        const destBerth = centerline[centerline.length - 1];

        // Deep water handshake points (projected 15 NM from berth)
        const depHandshake = depHandshakePt;
        const arrHandshake = arrHandshakePt;

        // Build the three-leg track
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
                wind_dir_deg: number;
                wave_ht_m: number;
                swell_period_s: number | null;
            };
        }> = [];

        let cumulativeDistNM = 0;

        // ── LEG 1: EXIT (harbour — dashed line from berth to deep water) ──
        const exitDistNM = haversineNM(originBerth.lat, originBerth.lon, depHandshake.lat, depHandshake.lon);

        // Berth point
        track.push({
            coordinates: [Math.round(originBerth.lon * 10000) / 10000, Math.round(originBerth.lat * 10000) / 10000],
            distance_from_start_nm: 0,
            time_offset_hours: 0,
            name: originBerth.name || 'Departure',
            leg_type: 'harbour',
            lateral_offset_nm: 0,
            conditions: { depth_m: null, wind_spd_kts: 0, wind_dir_deg: 0, wave_ht_m: 0, swell_period_s: null },
        });

        // Deep water start (only add if different from berth)
        if (exitDistNM > 0.5) {
            cumulativeDistNM += exitDistNM;
            track.push({
                coordinates: [Math.round(depHandshake.lon * 10000) / 10000, Math.round(depHandshake.lat * 10000) / 10000],
                distance_from_start_nm: Math.round(cumulativeDistNM * 10) / 10,
                time_offset_hours: Math.round(exitDistNM / vessel.cruising_speed_kts * 10) / 10,
                name: 'Safe Water',
                leg_type: 'harbour',
                lateral_offset_nm: 0,
                conditions: { depth_m: null, wind_spd_kts: 0, wind_dir_deg: 0, wave_ht_m: 0, swell_period_s: null },
            });
        }

        // ── LEG 2: PASSAGE (ocean — solid line, weather-routed) ──
        const exitTimeH = exitDistNM / vessel.cruising_speed_kts;

        for (let i = 0; i < simplified.length; i++) {
            const node = simplified[i];
            if (i > 0) {
                cumulativeDistNM += haversineNM(
                    simplified[i - 1].lat, simplified[i - 1].lon,
                    node.lat, node.lon,
                );
            } else {
                // First passage point — add distance from handshake
                cumulativeDistNM += haversineNM(
                    depHandshake.lat, depHandshake.lon,
                    node.lat, node.lon,
                );
            }

            const timeFraction = (simplified.length <= 1) ? 0 : i / (simplified.length - 1);
            const timeOffsetH = exitTimeH + result.totalTimeH * timeFraction;

            const wx = interpolateWeather(weatherGrid, node.lat, node.lon, result.totalTimeH * timeFraction);

            track.push({
                coordinates: [
                    Math.round(node.lon * 10000) / 10000,
                    Math.round(node.lat * 10000) / 10000,
                ],
                distance_from_start_nm: Math.round(cumulativeDistNM * 10) / 10,
                time_offset_hours: Math.round(timeOffsetH * 10) / 10,
                name: i === 0 ? 'Ocean Start'
                    : i === simplified.length - 1 ? 'Ocean End'
                        : `WP-${String(i).padStart(2, '0')}`,
                leg_type: 'ocean',
                lateral_offset_nm: node.lateralOffset * (corridorWidth / lateralSteps),
                conditions: {
                    depth_m: node.depth_m ?? null,
                    wind_spd_kts: Math.round(wx.windSpeed * 10) / 10,
                    wind_dir_deg: Math.round(wx.windDir),
                    wave_ht_m: Math.round(wx.waveHeight * 10) / 10,
                    swell_period_s: wx.swellPeriod ? Math.round(wx.swellPeriod * 10) / 10 : null,
                },
            });
        }

        // ── LEG 3: ENTRY (harbour — dotted line from deep water to berth) ──
        const entryDistNM = haversineNM(arrHandshake.lat, arrHandshake.lon, destBerth.lat, destBerth.lon);
        const totalPassageTimeH = exitTimeH + result.totalTimeH;

        // Deep water end (only add if different from last passage point)
        if (entryDistNM > 0.5) {
            cumulativeDistNM += haversineNM(
                simplified[simplified.length - 1].lat, simplified[simplified.length - 1].lon,
                arrHandshake.lat, arrHandshake.lon,
            );
            track.push({
                coordinates: [Math.round(arrHandshake.lon * 10000) / 10000, Math.round(arrHandshake.lat * 10000) / 10000],
                distance_from_start_nm: Math.round(cumulativeDistNM * 10) / 10,
                time_offset_hours: Math.round(totalPassageTimeH * 10) / 10,
                name: 'Safe Water',
                leg_type: 'harbour',
                lateral_offset_nm: 0,
                conditions: { depth_m: null, wind_spd_kts: 0, wind_dir_deg: 0, wave_ht_m: 0, swell_period_s: null },
            });
        }

        // Destination berth
        cumulativeDistNM += entryDistNM;
        const totalTimeH = totalPassageTimeH + entryDistNM / vessel.cruising_speed_kts;
        track.push({
            coordinates: [Math.round(destBerth.lon * 10000) / 10000, Math.round(destBerth.lat * 10000) / 10000],
            distance_from_start_nm: Math.round(cumulativeDistNM * 10) / 10,
            time_offset_hours: Math.round(totalTimeH * 10) / 10,
            name: destBerth.name || 'Arrival',
            leg_type: 'harbour',
            lateral_offset_nm: 0,
            conditions: { depth_m: null, wind_spd_kts: 0, wind_dir_deg: 0, wave_ht_m: 0, swell_period_s: null },
        });

        const routeDistNM = cumulativeDistNM;

        // Bounding box for instant map camera framing [minLon, minLat, maxLon, maxLat]
        let bbMinLat = Infinity, bbMaxLat = -Infinity;
        let bbMinLon = Infinity, bbMaxLon = -Infinity;
        for (const pt of track) {
            bbMinLon = Math.min(bbMinLon, pt.coordinates[0]);
            bbMaxLon = Math.max(bbMaxLon, pt.coordinates[0]);
            bbMinLat = Math.min(bbMinLat, pt.coordinates[1]);
            bbMaxLat = Math.max(bbMaxLat, pt.coordinates[1]);
        }

        console.log(`[WeatherRouter] ── COMPLETE ─────────────────────────────`);
        console.log(`[WeatherRouter] ${track.length} track points (${track.filter(t => t.leg_type === 'harbour').length} harbour, ${track.filter(t => t.leg_type === 'ocean').length} ocean), ${routeDistNM.toFixed(1)} NM`);
        console.log(`[WeatherRouter] ETA: ${result.totalTimeH.toFixed(1)}h, Cost: ${result.totalCost.toFixed(2)}`);
        console.log(`[WeatherRouter] Computed in ${computeMs}ms`);

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
                Math.round(bbMinLon * 100) / 100,
                Math.round(bbMinLat * 100) / 100,
                Math.round(bbMaxLon * 100) / 100,
                Math.round(bbMaxLat * 100) / 100,
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
            pilotage: {
                departure: {
                    handshake: { lat: depHandshakePt.lat, lon: depHandshakePt.lon },
                    gates: 0,
                    polygon_vertices: 0,
                },
                arrival: {
                    handshake: { lat: arrHandshakePt.lat, lon: arrHandshakePt.lon },
                    gates: 0,
                    polygon_vertices: 0,
                },
            },
        });

    } catch (err) {
        console.error("[WeatherRouter] Fatal:", err);
        return jsonResponse({ error: String(err) }, 500);
    }
});
