
import {
    BeaconObservation,
    DataSource,
    SourceColor,
    MetricSource,
    SourcedWeatherMetrics,
    WeatherMetrics,
    MarineWeatherReport
} from '../../../types';
import { degreesToCardinal } from '../../../utils/format';

// --- CONSTANTS ---
const BUOY_THRESHOLD_NM = 10;  // Maximum distance to use buoy data

// --- HELPER FUNCTIONS ---

/**
 * Maps data source to UI color indicator
 * 
 * Marine-focused color scheme:
 * - Emerald: Buoy data (real ocean measurements)
 * - Sky: Tomorrow.io (station-blended observations)
 * - Amber: StormGlass (marine forecast models)
 * - White: Fallback/unknown
 */
function getSourceColor(source: DataSource): SourceColor {
    switch (source) {
        case 'buoy': return 'emerald';
        case 'tomorrow': return 'sky';
        case 'stormglass': return 'amber';
        default: return 'white';
    }
}

/**
 * Format nautical mile distance for user-friendly display
 * 
 * Converts numeric distance to formatted string with 1 decimal place
 * and 'nm' (nautical miles) suffix.
 * 
 * @param distanceNM - Distance in nautical miles
 * @returns Formatted distance string (e.g., "5.2nm")
 * 
 * @example
 * ```typescript
 * formatDistance(5.234); // Returns "5.2nm"
 * ```
 */
function formatDistance(distanceNM: number): string {
    return `${distanceNM.toFixed(1)}nm`;
}

/**
 * Create a MetricSource object with value and origin metadata
 * 
 * Core building block for source transparency - every metric includes
 * origin metadata for UI display.
 * 
 * @param value - Metric value (number, string, etc.)
 * @param source - Data source: 'buoy' | 'stormglass'
 * @param sourceName - Display name (e.g., "Moreton Bay Central", "StormGlass Pro")
 * @param distance - Optional distance in nm from user location
 * @returns Complete MetricSource with value and metadata
 * 
 * @example
 * ```typescript
 * const windSource = createMetricSource(15.5, 'buoy', 'Moreton Bay Central', 5.2);
 * // Returns: { value: 15.5, source: 'buoy', sourceName: 'Moreton Bay Central',
 * //            sourceColor: 'emerald', sourceDistance: '5.2nm' }
 * ```
 */
function createMetricSource(
    value: unknown,
    source: DataSource,
    sourceName: string,
    distance?: number
): MetricSource {
    return {
        value,
        source,
        sourceName,
        sourceColor: getSourceColor(source),
        distance: distance !== undefined ? formatDistance(distance) : undefined
    };
}

function formatWindDirection(degrees?: number | null, cardinal?: string): string {
    if (degrees !== null && degrees !== undefined) {
        return cardinal || degreesToCardinal(degrees);
    }
    return cardinal || 'N/A';
}

/**
 * Calculate distance between two coordinates in nautical miles
 */
function calculateDistanceNM(lat1: number, lon1: number, lat2: number, lon2: number): number {
    const R = 3440.065; // Earth's radius in nautical miles
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
        Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
        Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// --- MAIN MERGING LOGIC ---

/**
 * Merge weather data from BOM AWS, buoy, and StormGlass sources
 * 
 * Marine-focused data merging with intelligent prioritization:
 * BOM AWS (observed wind) > Buoy (marine observations) > StormGlass (forecast models)
 * 
 * ## Source Priority (3-Tier System):
 * 1. **BOM AWS (Emerald)** - OBSERVED wind from coastal weather stations
 *    - Real anemometer readings from stations like Inner Beacon, Hope Banks
 *    - Wind speed, direction, gusts are ACTUAL measurements (not forecasts!)
 *    - Used if station within 10nm
 * 
 * 2. **Buoy (Emerald)** - Real-time marine measurements
 *    - Wave buoys: wave height, period, water temp (NO wind sensors)
 *    - NDBC buoys: full suite including wind (if available)
 *    - Used if within 10nm and metric available
 * 
 * 3. **StormGlass (Amber)** - Marine forecast models
 *    - Global coverage fallback
 *    - Complete weather metrics when no observations available
 * 
 * ## Metric Tagging:
 * Every metric includes MetricSource metadata:
 * - `value`: Metric value
 * - `source`: 'buoy' | 'stormglass' (BOM AWS uses 'buoy' source designation)
 * - `sourceColor`: 'emerald' | 'amber' | 'white'
 * - `sourceName`: Human-readable name (e.g., "Inner Beacon (AWS)")
 * - `distance`: Distance in nm (for buoy/AWS only)
 * 
 * @param buoy - Real-time buoy/AWS observation (null if none within range)
 * @param stormglassReport - StormGlass API response (always available)
 * @param location - User location coordinates and name
 * @returns Complete MarineWeatherReport with source-tagged metrics
 * 
 * @example
 * ```typescript
 * const report = mergeWeatherData(
 *   innerBeaconAWS,  // BOM AWS with wind sensors
 *   stormglassData,
 *   { lat: -27.3, lon: 153.3, name: "Newport" }
 * );
 * // Wind from Inner Beacon AWS (emerald, OBSERVED)
 * // Waves from StormGlass (amber, forecast)
 * ```
 */
export function mergeWeatherData(
    buoy: BeaconObservation | null,
    stormglassReport: MarineWeatherReport,
    location: { lat: number, lon: number, name: string }
): MarineWeatherReport {

    const stormglass = stormglassReport.current;
    const sources: SourcedWeatherMetrics['sources'] = {};

    // Helper to set metric with source tracking
    function setMetric<K extends keyof WeatherMetrics>(
        key: K,
        buoyVal: WeatherMetrics[K] | null | undefined,
        stormglassVal: WeatherMetrics[K] | null | undefined
    ): WeatherMetrics[K] {
        // Priority: Buoy/AWS > StormGlass
        // Note: BOM AWS data comes through the 'buoy' param (BeaconObservation)
        if (buoyVal !== undefined && buoyVal !== null && buoy && sources) {
            sources[key] = createMetricSource(buoyVal, 'buoy', buoy.name, buoy.distance);
            return buoyVal;
        } else if (sources) {
            sources[key] = createMetricSource(stormglassVal, 'stormglass', 'StormGlass Pro');
        }
        return stormglassVal as WeatherMetrics[K];
    }

    // WIND SPEED: BOM AWS/Buoy > StormGlass (rounded to whole number)
    // BOM AWS has actual anemometer, wave buoys typically don't
    const windSpeed = setMetric('windSpeed',
        buoy?.windSpeed !== null && buoy?.windSpeed !== undefined ? Math.round(buoy.windSpeed) : null,
        stormglass.windSpeed !== null && stormglass.windSpeed !== undefined ? Math.round(stormglass.windSpeed) : null
    );

    // WIND GUST: BOM AWS/Buoy > StormGlass (rounded to whole number)
    const windGust = setMetric('windGust',
        buoy?.windGust !== null && buoy?.windGust !== undefined ? Math.round(buoy.windGust) : null,
        stormglass.windGust !== null && stormglass.windGust !== undefined ? Math.round(stormglass.windGust) : null
    );

    // WIND DIRECTION: Buoy > StormGlass (special handling for degree vs cardinal)
    let windDirection: string;
    let windDegree: number | undefined;

    if (buoy?.windDirection !== undefined && buoy?.windDirection !== null) {
        windDegree = buoy.windDirection;
        windDirection = degreesToCardinal(windDegree);
        sources['windDirection'] = createMetricSource(windDirection, 'buoy', buoy.name, buoy.distance);
        sources['windDegree'] = createMetricSource(windDegree, 'buoy', buoy.name, buoy.distance);
    } else {
        windDirection = stormglass.windDirection;
        windDegree = stormglass.windDegree;
        sources['windDirection'] = createMetricSource(windDirection, 'stormglass', 'StormGlass Pro');
        if (windDegree) sources['windDegree'] = createMetricSource(windDegree, 'stormglass', 'StormGlass Pro');
    }

    // AIR TEMPERATURE: Buoy > StormGlass
    let airTemperature: number | null;
    if (buoy?.airTemperature !== undefined && buoy?.airTemperature !== null) {
        airTemperature = buoy.airTemperature;
        sources['airTemperature'] = createMetricSource(airTemperature, 'buoy', buoy.name, buoy.distance);
    } else if (stormglass.airTemperature !== undefined && stormglass.airTemperature !== null) {
        airTemperature = stormglass.airTemperature;
        sources['airTemperature'] = createMetricSource(airTemperature, 'stormglass', 'StormGlass Pro');
    } else {
        airTemperature = null;
        sources['airTemperature'] = createMetricSource(null, 'stormglass', 'StormGlass Pro');
    }

    // WATER TEMPERATURE: Beacon > StormGlass (airports don't have this)
    const waterTemperature = setMetric('waterTemperature',
        buoy?.waterTemperature,
        stormglass.waterTemperature
    );

    // WAVE HEIGHT: Beacon > StormGlass (airports don't have this)
    const waveHeight = setMetric('waveHeight',
        buoy?.waveHeight,
        stormglass.waveHeight
    );

    // SWELL PERIOD: Beacon > StormGlass
    const swellPeriod = setMetric('swellPeriod',
        buoy?.swellPeriod,
        stormglass.swellPeriod
    );

    // PRESSURE: Buoy > StormGlass
    const pressure = setMetric('pressure',
        buoy?.pressure,
        stormglass.pressure
    );

    // VISIBILITY: StormGlass only
    const visibility = setMetric('visibility',
        null,
        stormglass.visibility
    );

    // HUMIDITY: StormGlass only
    const humidity = setMetric('humidity',
        null,
        stormglass.humidity
    );

    // DEW POINT: StormGlass only
    const dewPoint = setMetric('dewPoint',
        null,
        stormglass.dewPoint
    );

    // CLOUD COVER: StormGlass only
    const cloudCover = setMetric('cloudCover',
        null,
        stormglass.cloudCover
    );

    // PRECIPITATION: StormGlass only
    const precipitation = setMetric('precipitation',
        null,
        stormglass.precipitation
    );

    // CURRENTS: Beacon only (no other sources provide this)
    const currentSpeed = buoy?.currentSpeed || stormglass.currentSpeed;
    const currentDirection = buoy?.currentDegree ? degreesToCardinal(buoy.currentDegree) : stormglass.currentDirection;
    if (currentSpeed) {
        if (buoy?.currentSpeed) {
            sources['currentSpeed'] = createMetricSource(currentSpeed, 'buoy', buoy.name, buoy.distance);
        } else {
            sources['currentSpeed'] = createMetricSource(currentSpeed, 'stormglass', 'StormGlass Pro');
        }
    }
    if (currentDirection) {
        if (buoy?.currentDegree) {
            sources['currentDirection'] = createMetricSource(currentDirection, 'buoy', buoy.name, buoy.distance);
        } else {
            sources['currentDirection'] = createMetricSource(currentDirection, 'stormglass', 'StormGlass Pro');
        }
    }

    // UV INDEX: StormGlass only (neither beacons nor airports provide this)
    if (stormglass.uvIndex !== undefined && stormglass.uvIndex !== null) {
        sources['uvIndex'] = createMetricSource(stormglass.uvIndex, 'stormglass', 'StormGlass Pro');
    }

    // Build merged current metrics
    const mergedCurrent: SourcedWeatherMetrics = {
        ...stormglass, // Start with StormGlass as base (includes all required fields)

        // Override with merged values
        windSpeed,
        windGust,
        windDirection,
        windDegree,
        airTemperature,
        waterTemperature,
        waveHeight,
        swellPeriod,
        wavePeriod: swellPeriod,  // Alias for component compatibility
        pressure,
        visibility,
        humidity,
        dewPoint,
        cloudCover,
        precipitation,
        currentSpeed,
        currentDirection: currentDirection as string,
        uvIndex: stormglass.uvIndex,  // FIXED: UV index was missing!

        // Add source tracking
        sources
    };

    // Build final report
    const mergedReport: MarineWeatherReport = {
        ...stormglassReport,
        current: mergedCurrent,
        beaconObservation: buoy || undefined,
        observations: [] // Removed airport observations (v20.0 marine-only)
    };

    return mergedReport;
}

// Helper to calculate relative humidity from temperature and dew point
function calculateRelativeHumidity(temp: number, dewpoint: number): number {
    // Simplified Magnus formula
    const a = 17.27;
    const b = 237.7;
    const alpha = ((a * temp) / (b + temp)) + Math.log(100);
    const beta = ((a * dewpoint) / (b + dewpoint)) + Math.log(100);
    return Math.min(100, Math.max(0, 100 * Math.exp(beta - alpha)));
}

// --- SOURCE REPORT GENERATION ---

/**
 * Generate detailed logging report showing which metrics came from which sources
 */
export function generateSourceReport(current: SourcedWeatherMetrics): string {
    if (!current.sources) {
        return '[DataSourceMerger] No source tracking data available';
    }

    const beaconMetrics: string[] = [];
    const tomorrowMetrics: string[] = [];
    const stormglassMetrics: string[] = [];

    // Group metrics by source
    Object.entries(current.sources).forEach(([key, metricSource]) => {
        if (!metricSource) return;

        const displayName = key.replace(/([A-Z])/g, ' $1').trim();
        const valueStr = formatMetricValue(key, metricSource.value);
        const line = `  ✓ ${displayName}: ${valueStr}`;

        switch (metricSource.source) {
            case 'buoy':
                beaconMetrics.push(line);
                break;
            case 'tomorrow':
                tomorrowMetrics.push(line);
                break;
            case 'stormglass':
                stormglassMetrics.push(line);
                break;
        }
    });

    // Build report
    const lines: string[] = [];
    lines.push('\n=== DATA SOURCES ===\n');

    if (beaconMetrics.length > 0) {
        const beaconSource = Object.values(current.sources).find(s => s?.source === 'buoy');
        const beaconDist = beaconSource?.distance || 'N/A';
        lines.push(`🟢 BEACON: ${beaconDist}`);
        lines.push(...beaconMetrics);
        lines.push('');
    }

    if (tomorrowMetrics.length > 0) {
        lines.push(`🔵 TOMORROW.IO: Station-Blended Observation`);
        lines.push(...tomorrowMetrics);
        lines.push('');
    }

    if (stormglassMetrics.length > 0) {
        lines.push(`🟠 STORMGLASS PRO: Forecast Model`);
        lines.push(...stormglassMetrics);
        lines.push('');
    }

    return lines.join('\n');
}

// Helper to format metric values for display
function formatMetricValue(key: string, value: unknown): string {
    if (value === null || value === undefined) return 'N/A';

    switch (key) {
        case 'windSpeed':
        case 'windGust':
            return `${value} kts`;
        case 'airTemperature':
        case 'waterTemperature':
        case 'feelsLike':
        case 'dewPoint':
            return `${value}°F`;
        case 'waveHeight':
            return `${value} ft`;
        case 'pressure':
            return `${value} hPa`;
        case 'visibility':
            return `${value} nm`;
        case 'humidity':
        case 'cloudCover':
            return `${value} % `;
        case 'precipitation':
            return `${value} mm`;
        case 'currentSpeed':
            return `${value} kts`;
        case 'swellPeriod':
            return `${value}s`;
        default:
            return String(value);
    }
}
