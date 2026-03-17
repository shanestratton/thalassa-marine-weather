/**
 * types/weather.ts — Weather domain types
 *
 * All weather metrics, forecasts, observations, and marine report types.
 */

export type WeatherModel =
    | 'best_match'
    | 'ecmwf_ifs04'
    | 'gfs_seamless'
    | 'icon_seamless'
    | 'bom_access_global'
    | 'gfs_global';
export type WeatherConditionKey = 'rain' | 'storm' | 'fog' | 'cloudy' | 'night' | 'sunny' | 'default';

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
    bomStationId?: string;
}

// --- MULTI-SOURCE DATA TRACKING ---

export interface BeaconObservation {
    buoyId: string;
    name: string;
    lat: number;
    lon: number;
    distance: number;
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

export type DataSource = 'buoy' | 'stormglass' | 'weatherkit';
export type SourceColor = 'emerald' | 'amber' | 'sky' | 'white';

export interface MetricSource {
    value: string | number | boolean | null | undefined;
    source: DataSource;
    sourceColor: SourceColor;
    sourceName: string;
    distance?: string;
}

export interface WeatherMetrics {
    windSpeed: number | null;
    windGust?: number | null;
    windDirection: string;
    windDegree?: number;
    waveHeight: number | null;
    swellPeriod: number | null;
    wavePeriod?: number | null;
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
    moonPhaseValue?: number;
    moonIllumination?: number;
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
    isoDate?: string;
    sunrise?: string;
    sunset?: string;
    highTemp?: number;
    lowTemp?: number;
    currentSpeed?: number | null;
    currentDirection?: number | string;
    fogRisk?: boolean;
    precipDetail?: string;
    debugNote?: string;
    stationId?: string;
    precipLabel?: string;
    precipValue?: string;
    cape?: number | null;
    secondarySwellHeight?: number | null;
    secondarySwellPeriod?: number | null;
}

export interface SourcedWeatherMetrics extends WeatherMetrics {
    sources?: {
        [K in keyof WeatherMetrics]?: MetricSource;
    };
}

export interface CalibratedSensorData extends Partial<WeatherMetrics> {
    stationName?: string;
}

export interface ForecastDay {
    day: string;
    date: string;
    isoDate?: string;
    highTemp: number;
    lowTemp: number;
    windSpeed: number;
    windGust?: number;
    waveHeight: number;
    condition: string;
    precipitation?: number;
    precipChance?: number;
    cloudCover?: number;
    pressure?: number;
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
    cape?: number | null;
    dewPoint?: number | null;
    precipChance?: number;
    secondarySwellHeight?: number | null;
    secondarySwellPeriod?: number | null;
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

export interface TideStation {
    id: string;
    name: string;
    coords: { lat: number; lon: number };
    timeOffsetMinutes: number;
    timeOffsetHigh?: number;
    timeOffsetLow?: number;
    heightOffsetRatio: number;
    referenceStationId?: string;
    z0?: number;
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
    coordinates?: { lat: number; lon: number };
}

export interface DebugInfo {
    logs: string[];
    candidatesChecked: number;
    finalLocation: { lat: number; lon: number };
    rawCurrent?: unknown;
    attemptedLocations?: { label: string; lat: number; lon: number; status: string }[];
}

export interface GroundingSource {
    uri: string;
    title: string;
}

export interface MarineWeatherReport {
    locationName: string;
    coordinates?: { lat: number; lon: number };
    current: SourcedWeatherMetrics;
    forecast: ForecastDay[];
    hourly: HourlyForecast[];
    tides: Tide[];
    tideHourly?: TidePoint[];
    boatingAdvice: string;
    alerts?: string[];
    observations?: ObservationStation[];
    beaconObservation?: BeaconObservation;
    generatedAt: string;
    aiGeneratedAt?: string;
    modelUsed: string;
    stationId?: string;
    groundingSource?: string;
    groundingUrls?: GroundingSource[];
    debugInfo?: DebugInfo;
    timeZone?: string;
    utcOffset?: number;
    isLandlocked?: boolean;
    locationType?: 'coastal' | 'offshore' | 'inland';
    distToLandKm?: number;
    synopticMap?: GridPoint[];
    tideGUIDetails?: {
        stationName: string;
        isSecondary: boolean;
        referenceStation?: string;
        timeOffsetHigh?: number;
        timeOffsetLow?: number;
    };
    _stale?: boolean;
    _staleAgeMinutes?: number;
}

export interface ChartDataPoint {
    time: string;
    wind: number;
    gust: number;
    wave: number;
    tide?: number;
}

export interface NotificationPreferences {
    wind: { enabled: boolean; threshold: number };
    gusts: { enabled: boolean; threshold: number };
    waves: { enabled: boolean; threshold: number };
    swellPeriod: { enabled: boolean; threshold: number };
    visibility: { enabled: boolean; threshold: number };
    uv: { enabled: boolean; threshold: number };
    tempHigh: { enabled: boolean; threshold: number };
    tempLow: { enabled: boolean; threshold: number };
    precipitation: { enabled: boolean };
}

/** Bounding box for GRIB weather download area */
export interface GribBoundingBox {
    north: number;
    south: number;
    west: number;
    east: number;
}

export type GribParameter = 'wind' | 'pressure' | 'waves' | 'precip' | 'cape' | 'sst';

export interface GribRequest {
    bbox: GribBoundingBox;
    parameters: GribParameter[];
    resolution: 0.25 | 0.5 | 1.0;
    timeStep: 3 | 6 | 12;
    forecastHours: 48 | 72 | 96 | 120;
    model: 'GFS' | 'ECMWF';
}

export interface GribDownloadState {
    status: 'idle' | 'downloading' | 'paused' | 'complete' | 'error';
    totalBytes: number;
    downloadedBytes: number;
    resumeOffset: number;
    url: string;
    tempFilePath: string;
    startedAt: number;
    lastChunkAt: number;
    errorMessage?: string;
}
