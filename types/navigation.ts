/**
 * types/navigation.ts — Navigation & voyage domain types
 *
 * Ship's log entries, voyage plans, hazards, waypoints, polar data, NMEA.
 */

export interface VoyageHazard {
    name: string;
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    description: string;
}

export interface ShipLogEntry {
    id: string;
    userId: string;
    voyageId: string;
    timestamp: string;
    latitude: number;
    longitude: number;
    positionFormatted: string;
    distanceNM?: number;
    cumulativeDistanceNM?: number;
    speedKts?: number;
    courseDeg?: number;
    windSpeed?: number;
    windGust?: number;
    windDirection?: string;
    waveHeight?: number;
    pressure?: number;
    airTemp?: number;
    waterTemp?: number;
    visibility?: number;
    seaState?: number;
    beaufortScale?: number;
    watchPeriod?: 'middle' | 'morning' | 'forenoon' | 'afternoon' | 'firstDog' | 'secondDog' | 'first';
    entryType: 'auto' | 'manual' | 'waypoint';
    source?: 'device' | 'gpx_import' | 'community_download' | 'planned_route';
    eventCategory?:
        | 'navigation'
        | 'weather'
        | 'equipment'
        | 'crew'
        | 'arrival'
        | 'departure'
        | 'safety'
        | 'observation';
    engineStatus?: 'running' | 'stopped' | 'maneuvering';
    notes?: string;
    waypointName?: string;
    createdAt?: string;
    isOnWater?: boolean;
    archived?: boolean;
    linkedPlanId?: string;
    /** Passage leg number (1-indexed). Legs increment on each port departure. */
    legNumber?: number;
}

export interface Waypoint {
    name: string;
    coordinates?: { lat: number; lon: number };
    windSpeed?: number;
    waveHeight?: number;
    depth_m?: number;
}

export interface VoyagePlan {
    origin: string;
    destination: string;
    departureDate: string;
    originCoordinates?: { lat: number; lon: number };
    destinationCoordinates?: { lat: number; lon: number };
    distanceApprox: string;
    durationApprox: string;
    overview: string;
    waypoints: Waypoint[];
    hazards?: VoyageHazard[];
    suitability?: {
        status: 'SAFE' | 'CAUTION' | 'UNSAFE';
        reasoning: string;
        maxWindEncountered?: number;
        maxWaveEncountered?: number;
    };
    customs?: {
        required: boolean;
        departingCountry?: string;
        departureProcedures?: string;
        destinationCountry: string;
        procedures: string;
        contactPhone?: string;
    };
    bestDepartureWindow?: {
        dateTimeISO?: string;
        timeRange: string;
        reasoning: string;
    };
    safeHarbours?: {
        name: string;
        lat: number;
        lon: number;
        description: string;
    }[];
    routeReasoning?: string;
    /** Full bathymetric route as GeoJSON LineString (from bathymetric edge function) */
    routeGeoJSON?: GeoJSON.Feature<GeoJSON.LineString>;
    /** Traffic light segmented FeatureCollection (green/orange/red depth zones) */
    trafficGeoJSON?: GeoJSON.FeatureCollection<GeoJSON.LineString>;
    /** Per-segment safety summary from bathymetric router */
    safety?: { safe: number; caution: number; danger: number };
    /** Internal runtime annotations — populated by passage planner, not serialized */
    __depthSummary?: DepthSummary;
    __multiModelComparison?: import('../services/weather/MultiModelWeatherService').MultiModelResult;
    /** Spatiotemporal weather routing payload — stashed by enhanceVoyagePlanWithWeather */
    __spatiotemporalPayload?: import('../types/spatiotemporal').SpatiotemporalPayload;
}

/**
 * PassageLeg — A single leg of a multi-stop voyage.
 *
 * Every departure from a port creates a new leg. Example:
 *   Voyage: "Brisbane → Fiji"
 *   Leg 1: Brisbane → Nouméa (departure_port → arrival_port)
 *   Leg 2: Nouméa → Suva    (departure_port → arrival_port)
 *
 * Rule: Any port you leave from that is not your home port counts as a new leg.
 */
export interface PassageLeg {
    id: string;
    voyage_id: string;
    leg_number: number; // 1-indexed
    departure_port: string;
    arrival_port: string | null; // null while leg is active (at sea)
    departure_time: string; // ISO timestamp
    arrival_time: string | null; // null while leg is active
    distance_nm: number | null; // Calculated on leg close from cumulative ship log
    status: 'active' | 'completed';
    notes: string | null;
    created_at: string;
}

/** GEBCO depth analysis result — attached to VoyagePlan by the passage planner */
export interface DepthSegment {
    depth_m: number | null;
    safety: string;
    costMultiplier: number;
}

export interface DepthSummary {
    minDepth: number | null;
    shallowSegments: number;
    totalSegments: number;
    segments: DepthSegment[];
}

export interface DeepAnalysisReport {
    strategy: string;
    fuelTactics: string;
    watchSchedule: string;
    weatherSummary: string;
    hazards: string[];
}

export interface StopDetails {
    name: string;
    overview: string;
    navigationNotes: string;
    marinaFacilities: string[];
    fuelAvailable: boolean;
    imageKeyword: string;
}

/** Polar performance matrix — boat speed at each (wind angle × wind speed) */
export interface PolarData {
    windSpeeds: number[];
    angles: number[];
    matrix: number[][];
}

/** Raw NMEA instrument sample (emitted every 5s by NmeaListenerService) */
export interface NmeaSample {
    timestamp: number;
    tws: number | null;
    twa: number | null;
    stw: number | null;
    heading: number | null;
    rpm: number | null;
    voltage: number | null;
    depth: number | null;
    sog: number | null;
    cog: number | null;
    waterTemp: number | null;
    latitude: number | null;
    longitude: number | null;
    hdop: number | null;
    satellites: number | null;
    gpsFixQuality: number | null;
}

/** Single bucket in the Smart Polar grid */
export interface SmartPolarBucket {
    sumSTW: number;
    sumSTW2: number;
    count: number;
    minSTW: number;
    maxSTW: number;
    lastUpdated: number;
}

/** Full grid of Smart Polar buckets — serialized to Capacitor Filesystem */
export interface SmartPolarBucketGrid {
    version: number;
    twsBucketSize: number;
    twaBucketSize: number;
    twsMin: number;
    twsMax: number;
    twaMin: number;
    twaMax: number;
    buckets: Record<string, SmartPolarBucket>;
    totalSamples: number;
    createdAt: number;
}

/** Decoded AIS vessel target from NMEA !AIVDM / !AIVDO sentences */
export interface AisTarget {
    mmsi: number; // 9-digit Maritime Mobile Service Identity
    name: string; // Vessel name (from msg 5/24)
    lat: number; // Decimal degrees
    lon: number; // Decimal degrees
    cog: number; // Course over ground (°)
    sog: number; // Speed over ground (kts)
    heading: number; // True heading (°), 511 = unavailable
    navStatus: number; // Navigational status (0-15)
    shipType: number; // Ship/cargo type code
    callSign: string; // Radio call sign
    destination: string; // Reported destination
    lastUpdated: number; // Epoch ms
}
