
export type WeatherModel = 'best_match' | 'ecmwf_ifs04' | 'gfs_seamless' | 'icon_seamless' | 'bom_access_global' | 'gfs_global';
export type DisplayMode = 'high-contrast' | 'night' | 'auto' | 'standard';
export type WeatherConditionKey = 'rain' | 'storm' | 'fog' | 'cloudy' | 'night' | 'sunny' | 'default';

export type LengthUnit = 'ft' | 'm';
export type WeightUnit = 'lbs' | 'kg' | 'tonnes';
export type SpeedUnit = 'kts' | 'mph' | 'kmh' | 'mps';
export type TempUnit = 'C' | 'F';
export type DistanceUnit = 'nm' | 'mi' | 'km';
export type VisibilityUnit = 'nm' | 'mi' | 'km';
export type VolumeUnit = 'gal' | 'l';

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
    type: 'noaa' | 'bom' | 'other';
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
    riggingType?: 'Sloop' | 'Cutter' | 'Ketch' | 'Yawl' | 'Schooner' | 'Catboat' | 'Solent' | 'Other';
    length: number;
    beam: number;
    draft: number;
    displacement: number;
    maxWaveHeight: number;
    maxWindSpeed?: number;
    cruisingSpeed: number;
    fuelCapacity?: number;
    waterCapacity?: number;
    fuelBurn?: number;
    customIconUrl?: string;
    estimatedFields?: string[]; // Track which fields were auto-calculated
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
}

export interface WeatherMetrics {
    windSpeed: number | null;
    windGust?: number | null;
    windDirection: string;
    windDegree?: number;
    waveHeight: number | null;
    swellPeriod: number | null;
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
    current: WeatherMetrics;
    forecast: ForecastDay[];
    hourly: HourlyForecast[];
    tides: Tide[];
    tideHourly?: TidePoint[];
    boatingAdvice: string;
    alerts?: string[];
    observations?: ObservationStation[];
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

export interface DeepAnalysisReport {
    strategy: string;
    fuelTactics: string;
    watchSchedule: string;
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
