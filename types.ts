
export type WeatherModel = 'best_match' | 'ecmwf_ifs04' | 'gfs_seamless' | 'icon_seamless' | 'bom_access_global' | 'gfs_global';
export type DisplayMode = 'high-contrast' | 'night' | 'auto' | 'standard';
export type DashboardMode = 'essential' | 'full';
export type WeatherConditionKey = 'rain' | 'storm' | 'fog' | 'cloudy' | 'night' | 'sunny' | 'default';

export type LengthUnit = 'ft' | 'm';
export type WeightUnit = 'lbs' | 'kg' | 'tonnes';
export type SpeedUnit = 'kts' | 'mph' | 'kmh' | 'mps';
export type TempUnit = 'C' | 'F';
export type DistanceUnit = 'nm' | 'mi' | 'km';
export type VisibilityUnit = 'nm' | 'mi' | 'km';
export type VolumeUnit = 'gal' | 'l';
export type ScreenOrientationType = 'auto' | 'portrait' | 'landscape';

export interface GridPoint {
    lat: number;
    lon: number;
    windSpeed: number;
    windDirection: string;
    windDegree: number;
    waveHeight: number;
}

export interface BuoyStation {
    id: string;
    name: string;
    lat: number;
    lon: number;
    type: 'noaa' | 'bom' | 'bom-aws' | 'imos' | 'hko' | 'marine-ie' | 'ukmo' | 'eurogoos' | 'jma' | 'other';
    bomStationId?: string; // BOM station ID for AWS (e.g., "94590" for Inner Beacon)
}

// --- MULTI-SOURCE DATA TRACKING ---

export interface BeaconObservation {
    buoyId: string;
    name: string;
    lat: number;
    lon: number;
    distance: number; // in nautical miles
    timestamp: string;
    windSpeed?: number | null;
    windDirection?: number | null;
    windGust?: number | null;
    waveHeight?: number | null;
    swellPeriod?: number | null;
    swellDirection?: number | null;
    waterTemperature?: number | null;
    airTemperature?: number | null;
    pressure?: number | null;
    currentSpeed?: number | null;
    currentDegree?: number | null;
}

export type DataSource = 'buoy' | 'stormglass' | 'tomorrow';
export type SourceColor = 'emerald' | 'amber' | 'sky' | 'white';

export interface MetricSource {
    value: any;
    source: DataSource;
    sourceColor: SourceColor;
    sourceName: string; // e.g., "Buoy 46086", "YBBN Airport", "StormGlass Pro"
    distance?: string;  // e.g., "5.2nm"
}

export interface SourcedWeatherMetrics extends WeatherMetrics {
    sources?: {
        [K in keyof WeatherMetrics]?: MetricSource;
    };
}


export interface VoyageHazard {
    name: string;
    severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
    description: string;
}

export interface NotificationPreferences {
    wind: { enabled: boolean, threshold: number };
    gusts: { enabled: boolean, threshold: number };
    waves: { enabled: boolean, threshold: number };
    swellPeriod: { enabled: boolean, threshold: number };
    visibility: { enabled: boolean, threshold: number };
    uv: { enabled: boolean, threshold: number };
    tempHigh: { enabled: boolean, threshold: number };
    tempLow: { enabled: boolean, threshold: number };
    precipitation: { enabled: boolean };
}

export interface UnitPreferences {
    speed: SpeedUnit;
    length: LengthUnit;
    waveHeight: LengthUnit; // NEW: Dedicated wave unit
    tideHeight?: LengthUnit;
    temp: TempUnit;
    distance: DistanceUnit;
    visibility?: VisibilityUnit;
    volume?: VolumeUnit;
}

export interface VesselDimensionUnits {
    length: LengthUnit;
    beam: LengthUnit;
    draft: LengthUnit;
    displacement: WeightUnit;
    volume?: VolumeUnit;
}

export interface VesselProfile {
    name: string;
    type: 'sail' | 'power' | 'observer';
    model?: string; // Make/Model (e.g. "Tayana 55")
    riggingType?: 'Sloop' | 'Cutter' | 'Ketch' | 'Yawl' | 'Schooner' | 'Catboat' | 'Solent' | 'Other';
    length: number;
    beam: number;
    draft: number;
    displacement: number;
    mastHeight?: number; // Mast height (for bridge clearance, routing)
    maxWaveHeight: number;
    maxWindSpeed?: number;
    cruisingSpeed: number;
    fuelCapacity?: number;
    waterCapacity?: number;
    fuelBurn?: number; // Fuel burn per hour at cruising speed (L/hr or gal/hr)
    hullColor?: string; // For Coast Guard float plan
    registration?: string; // Vessel registration number
    mmsi?: string; // Maritime Mobile Service Identity / Call Sign
    sailNumber?: string; // Racing sail number (e.g. AUS 1234)
    crewCount?: number; // Total crew including captain (default: 2)
    customIconUrl?: string;
    estimatedFields?: string[]; // Track which fields were auto-calculated
}

/** Polar performance matrix — boat speed at each (wind angle × wind speed) */
export interface PolarData {
    windSpeeds: number[];  // True wind speeds in knots (e.g. [6, 8, 10, 12, 15, 20, 25])
    angles: number[];      // True wind angles in degrees (e.g. [45, 60, 90, 120, 150, 180])
    matrix: number[][];    // matrix[angleIdx][windSpeedIdx] = boat speed in knots
}

/** Raw NMEA instrument sample (emitted every 5s by NmeaListenerService) */
export interface NmeaSample {
    timestamp: number;      // Unix ms
    tws: number | null;     // True Wind Speed (kts)
    twa: number | null;     // True Wind Angle (degrees, 0-180)
    stw: number | null;     // Speed Through Water (kts)
    heading: number | null; // Magnetic/True heading (degrees)
    rpm: number | null;     // Engine RPM (null if unavailable)
    voltage: number | null; // Battery/alternator voltage (null if unavailable)
    depth: number | null;   // Depth Below Transducer (meters)
    sog: number | null;     // Speed Over Ground (kts)
    cog: number | null;     // Course Over Ground (degrees)
    waterTemp: number | null; // Water temperature (°C)
}

/** Single bucket in the Smart Polar grid */
export interface SmartPolarBucket {
    sumSTW: number;         // Running sum of boat speeds
    sumSTW2: number;        // Running sum of STW² (for std-dev)
    count: number;          // Number of accepted samples
    minSTW: number;         // Min recorded speed
    maxSTW: number;         // Max recorded speed
    lastUpdated: number;    // Unix ms
}

/** Full grid of Smart Polar buckets — serialized to Capacitor Filesystem */
export interface SmartPolarBucketGrid {
    version: number;        // Schema version (1)
    twsBucketSize: number;  // 2 (kts)
    twaBucketSize: number;  // 5 (degrees)
    twsMin: number;         // 0
    twsMax: number;         // 30
    twaMin: number;         // 40
    twaMax: number;         // 180
    buckets: Record<string, SmartPolarBucket>; // Key: "tws_{bucket}_twa_{bucket}"
    totalSamples: number;
    createdAt: number;      // Unix ms
}

/** Bounding box for GRIB weather download area */
export interface GribBoundingBox {
    north: number;  // Top latitude (-90 to 90)
    south: number;  // Bottom latitude
    west: number;   // Left longitude (-180 to 180)
    east: number;   // Right longitude
}

/** Available GRIB weather parameters */
export type GribParameter = 'wind' | 'pressure' | 'waves' | 'precip' | 'cape' | 'sst';

/** GRIB download request configuration */
export interface GribRequest {
    bbox: GribBoundingBox;
    parameters: GribParameter[];
    resolution: 0.25 | 0.5 | 1.0;      // Grid resolution in degrees
    timeStep: 3 | 6 | 12;              // Forecast interval in hours
    forecastHours: 48 | 72 | 96 | 120; // Total forecast span
    model: 'GFS' | 'ECMWF';
}

/** Resumable GRIB download state (persisted for resume) */
export interface GribDownloadState {
    status: 'idle' | 'downloading' | 'paused' | 'complete' | 'error';
    totalBytes: number;
    downloadedBytes: number;
    resumeOffset: number;
    url: string;
    tempFilePath: string;
    startedAt: number;      // Epoch ms
    lastChunkAt: number;    // Epoch ms
    errorMessage?: string;
}

/** Inventory item categories */
export type InventoryCategory = 'Engine' | 'Plumbing' | 'Electrical' | 'Rigging' | 'Safety' | 'Provisions' | 'Medical';

/** Ship's inventory item */
export interface InventoryItem {
    id: string;              // UUID
    user_id: string;         // UUID → auth.users
    barcode: string | null;  // EAN/UPC barcode
    item_name: string;       // e.g. "Racor 2010PM-OR Fuel Filter"
    description: string | null;
    category: InventoryCategory;
    quantity: number;
    min_quantity: number;    // Alert threshold
    location_zone: string | null;     // "Saloon Port", "Engine Room"
    location_specific: string | null; // "Under the settee, green box"
    created_at: string;      // ISO timestamp
    updated_at: string;      // ISO timestamp
}

/** Maintenance task categories */
export type MaintenanceCategory = 'Engine' | 'Safety' | 'Hull' | 'Rigging' | 'Routine';

/** Maintenance trigger types */
export type MaintenanceTriggerType = 'engine_hours' | 'daily' | 'weekly' | 'monthly' | 'bi_annual' | 'annual';

/** Maintenance task (The Engine) */
export interface MaintenanceTask {
    id: string;
    user_id: string;
    title: string;
    description: string | null;
    category: MaintenanceCategory;
    trigger_type: MaintenanceTriggerType;
    interval_value: number | null;
    next_due_date: string | null;
    next_due_hours: number | null;
    last_completed: string | null;
    is_active: boolean;
    created_at: string;
    updated_at: string;
}

/** Maintenance history entry (The Logbook) */
export interface MaintenanceHistory {
    id: string;
    user_id: string;
    task_id: string;
    completed_at: string;
    engine_hours_at_service: number | null;
    notes: string | null;
    cost: number | null;
    created_at: string;
}

/** Equipment register categories */
export type EquipmentCategory = 'Propulsion' | 'Electronics' | 'HVAC' | 'Plumbing' | 'Rigging' | 'Galley';

/** Equipment register item — permanent installed hardware */
export interface EquipmentItem {
    id: string;
    user_id: string;
    equipment_name: string;
    category: EquipmentCategory;
    make: string;
    model: string;
    serial_number: string;
    installation_date: string | null;
    warranty_expiry: string | null;
    manual_uri: string | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
}

/** Ship's documents categories */
export type DocumentCategory = 'Registration' | 'Insurance' | 'Crew Visas/IDs' | 'Radio/MMSI' | 'Customs Clearances';

/** Ship's document — legal and clearance paperwork */
export interface ShipDocument {
    id: string;
    user_id: string;
    document_name: string;
    category: DocumentCategory;
    issue_date: string | null;
    expiry_date: string | null;
    file_uri: string | null;
    notes: string | null;
    created_at: string;
    updated_at: string;
}

export interface UserSettings {
    isPro: boolean;
    alwaysOn?: boolean;
    notifications: NotificationPreferences;
    units: UnitPreferences;
    defaultLocation?: string;
    savedLocations: string[];
    vessel?: VesselProfile;
    vesselUnits?: VesselDimensionUnits;
    timeDisplay: 'location' | 'device';
    displayMode: DisplayMode;
    preferredModel: WeatherModel;
    mapboxToken?: string;
    aiPersona?: number; // 0-100 Scale (0=Nice, 100=Psychotic)
    // New Layout Configs
    heroWidgets?: string[];
    topHeroWidget?: string; // New separate slot for widget opposite temperature
    detailsWidgets?: string[];
    rowOrder?: string[];
    dynamicHeaderMetrics?: boolean; // If true, header updates with scroll; if false, stays static
    dashboardMode?: DashboardMode; // 'essential' = simplified view, 'full' = all widgets (default)
    screenOrientation?: ScreenOrientationType; // 'auto' | 'portrait' | 'landscape' - in-app orientation lock
    autoTrackEnabled?: boolean; // Auto-start voyage tracking on app launch (user must opt in)
    backgroundLocationEnabled?: boolean; // Enable background GPS for 15-minute voyage logging (uses more battery)
    // Smart Polars & NMEA
    polarSource?: 'factory' | 'smart'; // Which polars the routing engine uses
    nmeaHost?: string;  // NMEA TCP/WS host (default: 192.168.1.1)
    nmeaPort?: number;  // NMEA TCP/WS port (default: 10110)
    smartPolarsEnabled?: boolean; // Enable background NMEA listening for polar learning
    // Offshore GRIB
    gribMode?: 'direct' | 'iridium'; // Direct HTTP download or Saildocs email fallback
    // Cloud sync preferences
    cloudSyncSettings?: boolean; // Sync settings (units, vessel, preferences) to Supabase
    cloudSyncVoyages?: boolean; // Sync voyage tracks, waypoints, GPX data to Supabase
    cloudSyncCommunity?: boolean; // Enable community track sharing via Supabase
}

export interface WeatherMetrics {
    windSpeed: number | null;
    windGust?: number | null;
    windDirection: string;
    windDegree?: number;
    waveHeight: number | null;
    swellPeriod: number | null;
    wavePeriod?: number | null; // Alias for component compatibility
    swellDirection?: string;
    airTemperature: number | null;
    waterTemperature?: number | null;
    description: string;
    condition: string;
    cloudCover?: number | null;
    precipitation?: number | null;
    visibility?: number | null;
    humidity?: number | null;
    moonPhase?: string;
    moonPhaseValue?: number; // 0-1 cycle
    moonIllumination?: number; // 0-1 fraction
    tideTrend?: 'rising' | 'falling' | 'steady';
    uvIndex: number;
    pressure?: number | null;
    pressureTrend?: 'rising' | 'falling' | 'steady';
    feelsLike?: number | null;
    isDay?: boolean;
    dewPoint?: number | null;
    isEstimated?: boolean;
    day?: string;
    date?: string;
    isoDate?: string; // Strict YYYY-MM-DD for UI logic
    sunrise?: string;
    sunset?: string;
    highTemp?: number;
    lowTemp?: number;
    currentSpeed?: number | null;
    currentDirection?: number | string;
    fogRisk?: boolean;
    precipDetail?: string; // e.g. "(-RA Light Rain)"
    debugNote?: string;    // e.g. "METAR_OK"
    stationId?: string;    // e.g. "YBSU"
    precipLabel?: string;  // e.g. "HEAVY RAIN"
    precipValue?: string;  // e.g. "55mm"
    cape?: number | null;  // Convective Available Potential Energy (J/kg) — thunderstorm instability
}

export interface CalibratedSensorData extends Partial<WeatherMetrics> {
    stationName?: string;
}

export interface ForecastDay {
    day: string;
    date: string;
    isoDate?: string; // e.g. "2024-01-08" (Local YYYY-MM-DD for precise filtering)
    highTemp: number;
    lowTemp: number;
    windSpeed: number;
    windGust?: number;
    waveHeight: number;
    condition: string;
    precipitation?: number;
    cloudCover?: number;
    pressure?: number; // Added for daily average
    uvIndex?: number;
    sunrise?: string;
    sunset?: string;
    tideSummary?: string;
    swellPeriod?: number;
    isEstimated?: boolean;
    humidity?: number;
    visibility?: number;
    currentSpeed?: number;
    currentDirection?: number | string;
    waterTemperature?: number;
    precipLabel?: string;
    precipValue?: string;
}

export interface HourlyForecast {
    time: string;
    windSpeed: number;
    windGust?: number | null;
    windDirection?: string;
    windDegree?: number;
    waveHeight: number;
    swellPeriod?: number | null;
    temperature: number;
    condition: string;
    isEstimated?: boolean;
    feelsLike?: number;
    precipitation?: number | null;
    cloudCover?: number | null;
    tideHeight?: number | null;
    uvIndex?: number;
    pressure?: number;
    humidity?: number | null;
    visibility?: number | null;
    currentSpeed?: number | null;
    currentDirection?: number | string;
    waterTemperature?: number | null;
}

export interface Tide {
    time: string;
    type: 'High' | 'Low';
    height: number;
}

export interface TidePoint {
    time: string;
    height: number;
}

export interface ObservationStation {
    name: string;
    distance: string;
    time: string;
    windSpeed: number | null;
    windDirection: string;
    windGust?: number | null;
    swellHeight?: number | null;
    pressure?: number | null;
    airTemperature: number | null;
    condition?: string;
    coordinates?: { lat: number, lon: number };
}

export interface DebugInfo {
    logs: string[];
    candidatesChecked: number;
    finalLocation: { lat: number, lon: number };
    rawCurrent?: any;
    attemptedLocations?: { label: string, lat: number, lon: number, status: string }[];
}

export interface GroundingSource {
    uri: string;
    title: string;
}

export interface MarineWeatherReport {
    locationName: string;
    coordinates?: { lat: number, lon: number };
    current: SourcedWeatherMetrics; // UPDATED: Now supports source tracking
    forecast: ForecastDay[];
    hourly: HourlyForecast[];
    tides: Tide[];
    tideHourly?: TidePoint[];
    boatingAdvice: string;
    alerts?: string[];
    observations?: ObservationStation[];
    beaconObservation?: BeaconObservation; // NEW: Weather beacon/buoy data
    generatedAt: string;
    aiGeneratedAt?: string;
    modelUsed: string;
    stationId?: string; // e.g. "YBBN"
    // tideStationName REMOVED
    groundingSource?: string;
    groundingUrls?: GroundingSource[];
    debugInfo?: DebugInfo;
    timeZone?: string;
    utcOffset?: number;
    isLandlocked?: boolean; // Deprecated but kept for compat
    locationType?: 'coastal' | 'offshore' | 'inland';
    distToLandKm?: number; // Distance to nearest land in km (for adaptive logging zones)
    synopticMap?: GridPoint[];
    tideGUIDetails?: {
        stationName: string;
        isSecondary: boolean;
        referenceStation?: string;
        timeOffsetHigh?: number;
        timeOffsetLow?: number;
    };
}

export interface Waypoint {
    name: string;
    coordinates?: { lat: number, lon: number };
    windSpeed?: number;
    waveHeight?: number;
}

export interface VoyagePlan {
    origin: string;
    destination: string;
    departureDate: string;
    originCoordinates?: { lat: number, lon: number };
    destinationCoordinates?: { lat: number, lon: number };
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
        timeRange: string;
        reasoning: string;
    };
}

// --- SHIP'S LOG (GPS-BASED TRACKING) ---

export interface ShipLogEntry {
    id: string;
    userId: string;
    voyageId: string; // Groups entries into voyages
    timestamp: string; // ISO 8601

    // Position
    latitude: number;
    longitude: number;
    positionFormatted: string; // "27°28.5'S 153°22.1'E"

    // Navigation (calculated from previous entry)
    distanceNM?: number; // Distance traveled since last entry
    cumulativeDistanceNM?: number; // Total voyage distance
    speedKts?: number; // Speed over ground
    courseDeg?: number; // 0-360 degrees True

    // Weather snapshot (at time of entry)
    windSpeed?: number; // Knots
    windGust?: number; // Knots
    windDirection?: string; // Cardinal or degrees
    waveHeight?: number; // Meters
    pressure?: number; // hPa (barometric)
    airTemp?: number;
    waterTemp?: number;

    // IMO-compliant fields
    visibility?: number; // Nautical miles
    seaState?: number; // Douglas scale 0-9
    beaufortScale?: number; // 0-12
    watchPeriod?: 'middle' | 'morning' | 'forenoon' | 'afternoon' | 'firstDog' | 'secondDog' | 'first';

    // Entry metadata
    entryType: 'auto' | 'manual' | 'waypoint'; // Auto = GPS tracking, Manual = user added, Waypoint = navigation mark
    source?: 'device' | 'gpx_import' | 'community_download'; // Track provenance: device = live GPS, gpx_import = imported file, community_download = DL'd from community
    eventCategory?: 'navigation' | 'weather' | 'equipment' | 'crew' | 'arrival' | 'departure' | 'safety' | 'observation';
    engineStatus?: 'running' | 'stopped' | 'maneuvering';
    notes?: string; // User notes
    waypointName?: string; // For waypoint entries

    // Tracking metadata
    createdAt?: string;
    isOnWater?: boolean; // True if GPS coordinates were on water at voyage start (ocean, river, lake)
    archived?: boolean;  // True if voyage has been auto-archived (>30 days old)
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

export interface ChartDataPoint {
    time: string;
    wind: number;
    gust: number;
    wave: number;
    tide?: number;
}

// --- WORLD TIDES API TYPES ---
export interface WorldTidesHeight {
    dt: number; // Usage epoch
    date: string;
    height: number;
}

export interface WorldTidesExtreme {
    dt: number;
    date: string;
    height: number;
    type: 'High' | 'Low';
}

export interface WorldTidesResponse {
    status: number;
    error?: string;
    heights?: WorldTidesHeight[];
    extremes?: WorldTidesExtreme[];
    callCount?: number;
    station?: { name: string, lat: number, lon: number };
}

// --- STORMGLASS API TYPES ---
export interface StormGlassValue {
    sg?: number;
    noaa?: number;
    icon?: number;
    dwd?: number;
    meteho?: number;
    [key: string]: number | undefined;
}

export interface StormGlassHour {
    time: string;
    // Allow dynamic access for the getValue helper, but mapped to known structure
    [key: string]: StormGlassValue | string | number | undefined;
}

export interface StormGlassResponse {
    hours: StormGlassHour[];
    meta: {
        cost: number;
        dailyQuota: number;
        end: string;
        lat: number;
        lng: number;
        params: string[];
        requestCount: number;
        source: string[];
        start: string;
    };
}

export interface StormGlassTideData {
    time: string;
    sg?: number;
    noaa?: number;
    [key: string]: number | string | undefined;
}

export interface LockerItem {
    name: string;
    icon: string;
    category: string;
}

export interface TideStation {
    id: string;
    name: string;
    coords: { lat: number; lon: number };
    timeOffsetMinutes: number;
    timeOffsetHigh?: number; // Override for High Water minutes
    timeOffsetLow?: number; // Override for Low Water minutes
    heightOffsetRatio: number;
    referenceStationId?: string; // If present, fetch data from this ID instead
    z0?: number;
}
