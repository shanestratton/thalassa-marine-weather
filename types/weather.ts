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
    | 'gfs_global'
    // Model-domain ids shared by the self-hosted wx server and the public /
    // commercial Open-Meteo APIs (verified identical on both, 2026-07-20).
    // These are what the Glass model picker offers.
    | 'dwd_icon'
    | 'ecmwf_ifs025'
    | 'ecmwf_aifs025_single'
    | 'ukmo_global_deterministic_10km'
    | 'jma_gsm'
    | 'ncep_gfs025';

/**
 * Stormglass offshore model source parameter.
 * Controls which NWP model backs the Stormglass API when the vessel
 * crosses the 20 nm offshore boundary.
 *
 *  - `sg`   — Stormglass AI (blended ensemble, recommended)
 *  - `ecmwf` — ECMWF IFS (European standard, 9 km global)
 *  - `gfs`   — GFS / NOAA (American standard, 25 km global)
 *  - `icon`  — DWD ICON (German global hi-res, 13 km)
 */
export type OffshoreModel = 'sg' | 'ecmwf' | 'gfs' | 'icon';

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
    /** Null when no source supplied it. NO forecast model publishes UV (it's
     *  a CAMS product), so a pinned-model report has it only once gap-filled
     *  from WeatherKit. Was `number`, which forced callers to invent a 0. */
    uvIndex: number | null;
    /** SPITFIRE only: the spread across the blend's members for this hour —
     *  the band. Absent for single models, which have nothing to disagree
     *  with. See services/weather/spitfire.ts. */
    windSpeedMin?: number | null;
    windSpeedMax?: number | null;
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
    dawn?: string;
    dusk?: string;
    nauticalDawn?: string;
    nauticalDusk?: string;
    moonrise?: string;
    moonset?: string;
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
    precipChance?: number;
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
    windSpeed: number | null;
    /** Null where the model publishes no gust field at all (ECMWF AIFS, JMA
     *  GSM). Never substitute a multiple of windSpeed — see advisory.ts. */
    windGust?: number | null;
    /** Significant wave height. `null` when the marine API has no
     *  coverage for this day (inland points, beyond marine forecast
     *  horizon, etc.) — distinct from 0 which means "calm seas".
     *  UIs should render "—" for null, never coerce to 0. */
    waveHeight: number | null;
    condition: string;
    precipitation?: number;
    precipChance?: number;
    cloudCover?: number;
    pressure?: number;
    uvIndex?: number | null;
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
    windSpeed: number | null;
    windGust?: number | null;
    windDirection?: string;
    windDegree?: number;
    /** Significant wave height. `null` = no marine coverage for this
     *  hour (see ForecastDay.waveHeight comment). */
    waveHeight: number | null;
    swellPeriod?: number | null;
    temperature: number;
    condition: string;
    isEstimated?: boolean;
    feelsLike?: number;
    precipitation?: number | null;
    cloudCover?: number | null;
    tideHeight?: number | null;
    uvIndex?: number | null;
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
    /** SPITFIRE only — per-hour spread across the blend's members. */
    windSpeedMin?: number | null;
    windSpeedMax?: number | null;
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
    locationType?: 'inshore' | 'coastal' | 'offshore' | 'inland';
    distToLandKm?: number;
    synopticMap?: GridPoint[];
    /** Present only when the SPITFIRE consensus supplied the atmospherics —
     *  live member weights, measured MAE and the honest scope of what those
     *  weights were actually scored on. See services/weather/spitfire.ts. */
    spitfire?: {
        label: string;
        cadence: string;
        weights: Record<string, number>;
        maeKt: Record<string, number>;
        memberLabels: Record<string, string>;
        weightsStatus: string;
        weightsScope: string;
        locationName: string;
        generatedAt: string;
    };
    tideGUIDetails?: {
        stationName: string;
        isSecondary: boolean;
        referenceStation?: string;
        timeOffsetHigh?: number;
        timeOffsetLow?: number;
    };
    _stale?: boolean;
    _staleAgeMinutes?: number;
    /** True when wave heights were capped to local fetch because the point is
     *  in enclosed water and the global wave model was over-stating swell. */
    shelterAdjusted?: boolean;
    /** The fetch (km) used for the shelter cap, for UI annotation. */
    shelterFetchKm?: number;
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
