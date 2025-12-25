
export type WeatherModel = 'THALASSA_AI' | 'STORMGLASS';
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
    detailsWidgets?: string[];
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
    uvIndex: number;
    pressure?: number | null;
    pressureTrend?: 'rising' | 'falling' | 'steady';
    feelsLike?: number | null;
    dewPoint?: number | null;
    isEstimated?: boolean;
    day?: string;
    date?: string;
    sunrise?: string;
    sunset?: string;
    moonPhase?: string;
}

export interface CalibratedSensorData extends Partial<WeatherMetrics> {
    stationName?: string;
}

export interface ForecastDay {
    day: string;
    date: string;
    highTemp: number;
    lowTemp: number;
    windSpeed: number;
    windGust?: number;
    waveHeight: number;
    condition: string;
    precipitation?: number;
    cloudCover?: number;
    uvIndex?: number;
    sunrise?: string;
    sunset?: string;
    tideSummary?: string;
    swellPeriod?: number;
    isEstimated?: boolean;
}

export interface HourlyForecast {
    time: string;
    windSpeed: number;
    windGust?: number;
    windDirection?: string;
    windDegree?: number;
    waveHeight: number;
    swellPeriod?: number;
    temperature: number;
    condition: string;
    isEstimated?: boolean;
    feelsLike?: number;
    precipitation?: number;
    cloudCover?: number;
    tideHeight?: number;
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
    groundingSource?: string;
    groundingUrls?: GroundingSource[];
    debugInfo?: DebugInfo;
    timeZone?: string;
    utcOffset?: number;
    isLandlocked?: boolean;
    synopticMap?: GridPoint[];
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
