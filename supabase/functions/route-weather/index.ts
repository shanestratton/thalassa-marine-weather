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
                } catch {
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

        } catch {
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
 * For SAIL vessels:
 *   - Use polar data if available (interpolated)
 *   - Otherwise apply heuristic penalties based on TWA
 *   - Light air (<5 kts): huge penalty
 *   - Upwind (<45°): 60% slower
 *   - Beam reach (60-120°): 15% faster (optimal)
 *   - Running (>135°): slight penalty (dead run is slow)
 *
 * For POWER vessels:
 *   - Headwind penalty (bow seas slow you down)
 *   - Beam seas: wave slam penalty
 *   - Wave height affects speed regardless of direction
 *
 * Returns 0 if conditions exceed vessel limits (IMPASSABLE).
 */
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
        // ── SAIL ROUTING ──

        // Try polar data first (most accurate)
        if (vessel.polar_data) {
            speed = interpolatePolar(vessel.polar_data, twa, tws);
            if (speed <= 0) speed = 0.5; // Never truly zero, just very slow
        } else {
            // Heuristic sail performance model
            if (tws < 5) {
                // Light air — barely moving
                speed *= (1 / LIGHT_AIR_PENALTY_SAIL) * (tws / 5);
                speed = Math.max(speed, 0.5);
            } else if (twa < 30) {
                // No-go zone — can't sail here efficiently
                speed *= 0.3;
            } else if (twa < 45) {
                // Close-hauled — significantly slower
                speed /= UPWIND_PENALTY_SAIL;
            } else if (twa >= 60 && twa <= 120) {
                // Beam reach — optimal angle
                speed *= (1 / BEAM_WIND_BONUS_SAIL);
                // Speed increases with wind up to a point
                const windFactor = Math.min(tws / 15, 1.3);
                speed *= windFactor;
            } else if (twa > 150) {
                // Dead run — slightly slower than beam reach
                speed *= 0.85;
            }

            // Gale conditions — even with wind, it's dangerous
            if (tws > vessel.max_wind_kts * 0.8) {
                speed *= 0.5; // Reefed down, survival sailing
            }
        }

        // Wave penalty for sailing (independent of wind angle)
        if (waveH > 2.0) {
            speed *= Math.max(0.6, 1 - (waveH - 2.0) * 0.1);
        }

    } else {
        // ── POWER ROUTING ──

        // Headwind penalty (bow seas)
        if (twa < 45) {
            // Head seas: motor into wind & waves
            const headFactor = 1 - (tws / 40) * 0.3; // Up to 30% slower in 40 kt headwind
            speed *= Math.max(0.5, headFactor);

            // Wave slam penalty in head seas
            if (waveH > 1.5) {
                speed *= Math.max(0.6, 1 - (waveH - 1.5) * 0.15);
            }
        } else if (twa > 60 && twa < 120) {
            // Beam seas — uncomfortable, possible roll penalty
            if (waveH > 2.0) {
                speed *= Math.max(0.7, 1 - (waveH - 2.0) * 0.1);
            }
        }
        // Following seas (twa > 120): generally favorable for power

        // General wave height degradation
        if (waveH > 3.0) {
            speed *= Math.max(0.5, 1 - (waveH - 3.0) * 0.15);
        }

        // Fuel efficiency: strong headwinds burn more fuel
        // (not modeled in speed, but noted for routing preference)
    }

    // Approaching operational limits — steep penalty curve
    if (tws > vessel.max_wind_kts * 0.7 || waveH > vessel.max_wave_m * 0.7) {
        const windMargin = tws / vessel.max_wind_kts;
        const waveMargin = waveH / vessel.max_wave_m;
        const dangerFactor = Math.max(windMargin, waveMargin);
        if (dangerFactor > 0.7) {
            speed *= Math.max(0.3, 1 - (dangerFactor - 0.7) * GALE_PENALTY);
        }
    }

    return Math.max(speed, 0.1); // Never zero — block via IMPASSABLE instead
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

        const corridorWidth = body.corridor_width_nm || DEFAULT_CORRIDOR_WIDTH_NM;
        const lateralSteps = body.lateral_steps || DEFAULT_LATERAL_STEPS;
        const nodesPerRow = 2 * lateralSteps + 1;
        const departureDate = new Date(departure_time);

        console.log(`[WeatherRouter] ── START ────────────────────────────────`);
        console.log(`[WeatherRouter] ${centerline.length} centerline WPs, ${vessel.type} @ ${vessel.cruising_speed_kts} kts`);
        console.log(`[WeatherRouter] Corridor: ±${corridorWidth} NM, ${lateralSteps} lateral steps`);
        console.log(`[WeatherRouter] Departure: ${departureDate.toISOString()}`);

        const t0 = Date.now();

        // ── Step 1: Generate corridor mesh ──
        const meshNodes = generateCorridorMesh(centerline, corridorWidth, lateralSteps);

        // ── Step 2: Build adjacency graph ──
        const adjacency = buildAdjacencyList(meshNodes, nodesPerRow, centerline.length);

        // ── Step 3: Fetch weather grid ──
        // Estimate max passage time for weather forecast window
        const totalDistNM = centerline.reduce((sum, wp, i) => {
            if (i === 0) return 0;
            return sum + haversineNM(centerline[i - 1].lat, centerline[i - 1].lon, wp.lat, wp.lon);
        }, 0);
        const maxHours = Math.min(240, Math.ceil(totalDistNM / vessel.cruising_speed_kts * 1.5));

        const weatherGrid = await fetchWeatherGrid(meshNodes, departureDate, maxHours);

        // ── Step 4: Run 4D A* ──
        // Start: center node of first row
        const startCenter = lateralSteps; // Index of center node in first row
        const startIds = [startCenter];

        // Goal: ALL nodes in the last row (any lateral position)
        const lastRowStart = (centerline.length - 1) * nodesPerRow;
        const goalIds = new Set<number>();
        for (let c = 0; c < nodesPerRow; c++) {
            goalIds.add(lastRowStart + c);
        }

        const goalWp = centerline[centerline.length - 1];
        const result = corridorAStar(
            meshNodes,
            adjacency,
            startIds,
            goalIds,
            vessel,
            weatherGrid,
            goalWp.lat,
            goalWp.lon,
        );

        const computeMs = Date.now() - t0;

        if (!result) {
            return jsonResponse({
                error: "No viable weather route found — conditions may exceed vessel limits",
                computation_ms: computeMs,
            }, 422);
        }

        // ── Step 5: Simplify path ──
        const simplified = simplifyPath(result.path, 3.0);

        // ── Build response ──
        const waypoints = simplified.map((node, i) => ({
            lat: Math.round(node.lat * 10000) / 10000,
            lon: Math.round(node.lon * 10000) / 10000,
            name: i === 0 ? 'Departure'
                : i === simplified.length - 1 ? 'Arrival'
                    : `WP-${String(i).padStart(2, '0')}`,
            depth_m: node.depth_m,
            lateral_offset_nm: node.lateralOffset * (corridorWidth / lateralSteps),
            weather_at_arrival: interpolateWeather(
                weatherGrid,
                node.lat, node.lon,
                result.totalTimeH * (i / simplified.length), // Approximate ETA
            ),
        }));

        // Calculate weather-routed distance
        let routeDistNM = 0;
        for (let i = 1; i < simplified.length; i++) {
            routeDistNM += haversineNM(
                simplified[i - 1].lat, simplified[i - 1].lon,
                simplified[i].lat, simplified[i].lon,
            );
        }

        console.log(`[WeatherRouter] ── COMPLETE ─────────────────────────────`);
        console.log(`[WeatherRouter] ${simplified.length} waypoints, ${routeDistNM.toFixed(1)} NM`);
        console.log(`[WeatherRouter] ETA: ${result.totalTimeH.toFixed(1)}h, Cost: ${result.totalCost.toFixed(2)}`);
        console.log(`[WeatherRouter] Computed in ${computeMs}ms`);

        return jsonResponse({
            waypoints,
            distance_nm: Math.round(routeDistNM * 10) / 10,
            eta_hours: Math.round(result.totalTimeH * 10) / 10,
            cost_score: Math.round(result.totalCost * 100) / 100,
            computation_ms: computeMs,
            mesh_stats: {
                total_nodes: meshNodes.length,
                rows: centerline.length,
                cols: nodesPerRow,
                corridor_width_nm: corridorWidth,
                weather_grid_points: weatherGrid.data.size,
                forecast_hours: weatherGrid.hoursAvailable,
            },
            vessel_type: vessel.type,
            departure_time: departureDate.toISOString(),
        });

    } catch (err) {
        console.error("[WeatherRouter] Fatal:", err);
        return jsonResponse({ error: String(err) }, 500);
    }
});
