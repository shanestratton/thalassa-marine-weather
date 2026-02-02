
import {
    BeaconObservation,
    DataSource,
    SourceColor,
    MetricSource,
    SourcedWeatherMetrics,
    WeatherMetrics,
    MarineWeatherReport
} from '../../../types';

// Import existing METAR observation type
type LocalObservation = any; // TODO: Import from MetarService when refactored

// --- CONSTANTS ---
const BEACON_THRESHOLD_NM = 10;
const AIRPORT_THRESHOLD_NM = 30;

// --- HELPER FUNCTIONS ---

/**
 * Get color indicator for a data source type
 * 
 * Maps data source types to visual color indicators for UI display:
 * - Beacon: Green (real-time measured data from marine buoys)
 * - Airport: Amber (observed atmospheric data from nearby weather stations)
 * - StormGlass: Red (modeled/computed predictions)
 * 
 * @param source - The data source type
 * @returns Color code for UI styling ('green' | 'amber' | 'red')
 * 
 * @example
 * ```typescript
 * const color = getSourceColor('beacon'); // Returns 'green'
 * ```
 */
function getSourceColor(source: DataSource): SourceColor {
    switch (source) {
        case 'beacon': return 'green';
        case 'airport': return 'amber';
        case 'stormglass': return 'red';
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
 * Create a MetricSource object with complete metadata
 * 
 * Constructs a standardized metric source object that includes:
 * - Raw metric value
 * - Source type identifier
 * - Human-readable source name
 * - Color indicator for UI
 * - Optional distance from location
 * 
 * This is the core building block for source transparency - every metric
 * tracked in the system includes its origin metadata.
 * 
 * @param value - The actual metric value (number, string, etc.)
 * @param source - Data source type ('beacon' | 'airport' | 'stormglass')
 * @param sourceName - Display name (e.g., "Moreton Bay Central", "Brisbane Airport")
 * @param distance - Optional distance in nautical miles from user location
 * @returns Complete MetricSource object with value and metadata
 * 
 * @example
 * ```typescript
 * const windSource = createMetricSource(
 *   15.5,
 *   'beacon',
 *   'Moreton Bay Central',
 *   5.2
 * );
 * // Returns: { value: 15.5, source: 'beacon', sourceName: 'Moreton Bay Central',
 * //            sourceColor: 'green', sourceDistance: '5.2nm' }
 * ```
 */
function createMetricSource(
    value: any,
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

/**
 * Convert wind direction from degrees to cardinal with degrees
 */
function formatWindDirection(degrees?: number | null, cardinal?: string): string {
    if (degrees !== null && degrees !== undefined) {
        return cardinal || degreesToCardinal(degrees);
    }
    return cardinal || 'N/A';
}

function degreesToCardinal(deg: number): string {
    const directions = ['N', 'NNE', 'NE', 'ENE', 'E', 'ESE', 'SE', 'SSE', 'S', 'SSW', 'SW', 'WSW', 'W', 'WNW', 'NW', 'NNW'];
    const index = Math.round(((deg % 360) / 22.5));
    return directions[index % 16];
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
 * Merge weather data from multiple sources with intelligent prioritization
 * 
 * This is the core function for Thalassa's multi-source transparency strategy.
 * It combines real-time beacon data, observed airport data, and modeled StormGlass
 * predictions, selecting the best source for each metric based on proximity and data quality.
 * 
 * ## Source Priority Logic:
 * 1. **Beacon (Green)** - Real-time measured data from marine buoys
 *    - Used if within 10nm of location
 *    - Prioritized for marine metrics: wind, waves, water temp, currents
 *    - Limited atmospheric sensors (no pressure, visibility, etc.)
 * 
 * 2. **Airport (Amber)** - Observed atmospheric data from METAR stations
 *    - Used if within 30nm of location  
 *    - Prioritized for atmospheric metrics: pressure, visibility, fog risk
 *    - No wave or current data
 * 
 * 3. **StormGlass (Red)** - Modeled/computed predictions (always available)
 *    - Provides complete global coverage
 *    - All metrics available, but computed not measured
 *    - UV Index exclusively from StormGlass
 * 
 * ## Metric Tagging:
 * Every selected metric includes a `MetricSource` object with:
 * - `value`: The actual metric value
 * - `source`: Data source type ('beacon' | 'airport' | 'stormglass')
 * - `sourceColor`: UI color indicator ('green' | 'amber' | 'red')
 * - `sourceName`: Human-readable source name
 * - `distance`: Distance from user location (if applicable)
 * 
 * This enables the UI to visually indicate data origin with color-coded metrics.
 * 
 * @param beacon - Real-time marine buoy observation (null if none within range)
 * @param airport - Nearest airport METAR observation (filtered by 30nm threshold)
 * @param stormglassReport - Complete StormGlass API response (global fallback)
 * @param location - User location with coordinates and name
 * @returns Complete MarineWeatherReport with source-tagged current metrics
 * 
 * @example
 * ```typescript
 * const mergedReport = mergeWeatherData(
 *   moretonBayBeacon,  // Within 10nm
 *   brisbaneAirport,   // Within 30nm
 *   stormglassData,
 *   { lat: -27.3, lon: 153.3, name: "Brisbane" }
 * );
 * 
 * // Result: Wind from beacon (green), pressure from airport (amber),
 * // UV from StormGlass (red), each tagged with source metadata
 * ```
 */
export function mergeWeatherData(
    beacon: BeaconObservation | null,
    airport: LocalObservation | null,
    stormglassReport: MarineWeatherReport,
    location: { lat: number, lon: number, name: string }
): MarineWeatherReport {

    console.log('[DataSourceMerger] === MERGING DATA FROM MULTIPLE SOURCES ===');
    console.log(`[DataSourceMerger] Location: ${location.name} (${location.lat.toFixed(4)}, ${location.lon.toFixed(4)})`);
    console.log(`[DataSourceMerger] Beacon: ${beacon ? `✓ ${beacon.name} (${beacon.distance.toFixed(1)}nm)` : '✗ None'}`);

    // Calculate airport distance and filter if too far
    let airportDistance: number | undefined;
    if (airport && airport.lat && airport.lon) {
        airportDistance = calculateDistanceNM(location.lat, location.lon, airport.lat, airport.lon);
        console.log(`[DataSourceMerger] Airport: ${airport.name || airport.stationId || 'Unknown'} (${airportDistance.toFixed(1)}nm)`);

        if (airportDistance > AIRPORT_THRESHOLD_NM) {
            console.log(`[DataSourceMerger] ⚠️ Airport beyond ${AIRPORT_THRESHOLD_NM}nm limit - ignoring`);
            airport = null; // Too far for marine relevance
        }
    } else if (airport) {
        console.log(`[DataSourceMerger] Airport: ${airport.name || airport.stationId || 'Unknown'} (no coords)`);
        airport = null; // No coords means we can't determine distance, so ignore it
        console.log(`[DataSourceMerger] Airport: ✗ None`);
    }
    console.log(`[DataSourceMerger] StormGlass: ✓ Available`);

    const stormglass = stormglassReport.current;
    const sources: SourcedWeatherMetrics['sources'] = {};

    // Helper to set metric with source tracking
    function setMetric<K extends keyof WeatherMetrics>(
        key: K,
        beaconVal: any,
        airportVal: any,
        stormglassVal: any
    ): WeatherMetrics[K] {
        // Priority: Beacon > Airport > StormGlass
        if (beaconVal !== undefined && beaconVal !== null && beacon && sources) {
            sources[key] = createMetricSource(beaconVal, 'beacon', beacon.name, beacon.distance);
            return beaconVal;
        } else if (airportVal !== undefined && airportVal !== null && airport && sources) {
            const airportName = `${airport.name || airport.stationId} Airport`;
            sources[key] = createMetricSource(airportVal, 'airport', airportName, airportDistance);
            return airportVal;
        } else if (sources) {
            sources[key] = createMetricSource(stormglassVal, 'stormglass', 'StormGlass Pro');
        }
        return stormglassVal;
    }

    // WIND SPEED: Beacon > Airport > StormGlass
    const windSpeed = setMetric('windSpeed',
        beacon?.windSpeed,
        airport?.windSpeed,
        stormglass.windSpeed
    );

    // WIND GUST: Beacon > Airport > StormGlass
    const windGust = setMetric('windGust',
        beacon?.windGust,
        airport?.windGust,
        stormglass.windGust
    );

    // WIND DIRECTION: Beacon > Airport > StormGlass (special handling for degree vs cardinal)
    let windDirection: string;
    let windDegree: number | undefined;

    if (beacon?.windDirection !== undefined && beacon?.windDirection !== null) {
        windDegree = beacon.windDirection;
        windDirection = degreesToCardinal(windDegree);
        sources['windDirection'] = createMetricSource(windDirection, 'beacon', beacon.name, beacon.distance);
        sources['windDegree'] = createMetricSource(windDegree, 'beacon', beacon.name, beacon.distance);
    } else if (airport?.windDirection !== undefined) {
        windDegree = airport.windDirection as number;
        windDirection = degreesToCardinal(windDegree);
        const airportName = `${airport.name || airport.stationId} Airport`;
        sources['windDirection'] = createMetricSource(windDirection, 'airport', airportName);
        sources['windDegree'] = createMetricSource(windDegree, 'airport', airportName);
    } else {
        windDirection = stormglass.windDirection;
        windDegree = stormglass.windDegree;
        sources['windDirection'] = createMetricSource(windDirection, 'stormglass', 'StormGlass Pro');
        if (windDegree) sources['windDegree'] = createMetricSource(windDegree, 'stormglass', 'StormGlass Pro');
    }

    // AIR TEMPERATURE: Beacon > StormGlass > Airport
    // For marine/coastal locations, StormGlass models are more accurate than inland airports
    // Beacon is still #1 priority if available (onsite measurement)
    let airTemperature: number | null;
    if (beacon?.airTemperature !== undefined && beacon?.airTemperature !== null) {
        airTemperature = beacon.airTemperature;
        sources['airTemperature'] = createMetricSource(airTemperature, 'beacon', beacon.name, beacon.distance);
    } else if (stormglass.airTemperature !== undefined && stormglass.airTemperature !== null) {
        // Prioritize StormGlass for coastal accuracy
        airTemperature = stormglass.airTemperature;
        sources['airTemperature'] = createMetricSource(airTemperature, 'stormglass', 'StormGlass Pro');
    } else if (airport?.temperature !== undefined && airport?.temperature !== null) {
        // Airport as fallback (often inland, may be less accurate for coastal)
        airTemperature = airport.temperature;
        const airportName = `${airport.name || airport.stationId} Airport`;
        sources['airTemperature'] = createMetricSource(airTemperature, 'airport', airportName);
    } else {
        airTemperature = null;
        sources['airTemperature'] = createMetricSource(null, 'stormglass', 'StormGlass Pro');
    }

    // WATER TEMPERATURE: Beacon > StormGlass (airports don't have this)
    const waterTemperature = setMetric('waterTemperature',
        beacon?.waterTemperature,
        undefined,
        stormglass.waterTemperature
    );

    // WAVE HEIGHT: Beacon > StormGlass (airports don't have this)
    const waveHeight = setMetric('waveHeight',
        beacon?.waveHeight,
        undefined,
        stormglass.waveHeight
    );

    // SWELL PERIOD: Beacon > StormGlass
    const swellPeriod = setMetric('swellPeriod',
        beacon?.swellPeriod,
        undefined,
        stormglass.swellPeriod
    );

    // PRESSURE: Beacon > Airport > StormGlass
    const pressure = setMetric('pressure',
        beacon?.pressure,
        airport?.pressure,
        stormglass.pressure
    );

    // VISIBILITY: Airport > StormGlass (airports have precision instruments)
    const visibility = setMetric('visibility',
        undefined,
        airport?.visibility,
        stormglass.visibility
    );

    // HUMIDITY: Airport > StormGlass
    const humidity = setMetric('humidity',
        undefined,
        airport?.dewpoint ? calculateRelativeHumidity(airport.temperature, airport.dewpoint) : undefined,
        stormglass.humidity
    );

    // DEW POINT: Airport > StormGlass
    const dewPoint = setMetric('dewPoint',
        undefined,
        airport?.dewpoint,
        stormglass.dewPoint
    );

    // CLOUD COVER: Airport > StormGlass
    const cloudCover = setMetric('cloudCover',
        undefined,
        airport?.cloudCover,
        stormglass.cloudCover
    );

    // PRECIPITATION: Airport > StormGlass
    const precipitation = setMetric('precipitation',
        undefined,
        airport?.precip,
        stormglass.precipitation
    );

    // CURRENTS: Beacon only (no other sources provide this)
    const currentSpeed = beacon?.currentSpeed || stormglass.currentSpeed;
    const currentDirection = beacon?.currentDegree ? degreesToCardinal(beacon.currentDegree) : stormglass.currentDirection;
    if (currentSpeed) {
        if (beacon?.currentSpeed) {
            sources['currentSpeed'] = createMetricSource(currentSpeed, 'beacon', beacon.name, beacon.distance);
        } else {
            sources['currentSpeed'] = createMetricSource(currentSpeed, 'stormglass', 'StormGlass Pro');
        }
    }
    if (currentDirection) {
        if (beacon?.currentDegree) {
            sources['currentDirection'] = createMetricSource(currentDirection, 'beacon', beacon.name, beacon.distance);
        } else {
            sources['currentDirection'] = createMetricSource(currentDirection, 'stormglass', 'StormGlass Pro');
        }
    }

    // UV INDEX: StormGlass only (neither beacons nor airports provide this)
    if (stormglass.uvIndex !== undefined && stormglass.uvIndex !== null) {
        sources['uvIndex'] = createMetricSource(stormglass.uvIndex, 'stormglass', 'StormGlass Pro');
    }

    // FOG RISK: Airport > StormGlass
    const fogRisk = airport?.fogRisk !== undefined ? airport.fogRisk : stormglass.fogRisk;

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
        pressure,
        visibility,
        humidity,
        dewPoint,
        cloudCover,
        precipitation,
        currentSpeed,
        currentDirection: currentDirection as any,
        fogRisk,

        // Add source tracking
        sources
    };

    // Build final report
    const mergedReport: MarineWeatherReport = {
        ...stormglassReport,
        current: mergedCurrent,
        beaconObservation: beacon || undefined,
        // Keep airport obs in observations array if exists
        observations: airport ? [
            {
                name: airport.name || airport.stationId,
                distance: '< 30nm',
                time: airport.timestamp || 'now',
                windSpeed: airport.windSpeed,
                windDirection: degreesToCardinal(airport.windDirection || 0),
                windGust: airport.windGust,
                swellHeight: undefined,
                pressure: airport.pressure,
                airTemperature: airport.temperature,
                condition: airport.weather,
                coordinates: airport.lat && airport.lon ? { lat: airport.lat, lon: airport.lon } : undefined
            }
        ] : []
    };

    console.log('[DataSourceMerger] === MERGE COMPLETE ===');
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
    const airportMetrics: string[] = [];
    const stormglassMetrics: string[] = [];

    // Group metrics by source
    Object.entries(current.sources).forEach(([key, metricSource]) => {
        if (!metricSource) return;

        const displayName = key.replace(/([A-Z])/g, ' $1').trim();
        const valueStr = formatMetricValue(key, metricSource.value);
        const line = `  ✓ ${displayName}: ${valueStr}`;

        switch (metricSource.source) {
            case 'beacon':
                beaconMetrics.push(line);
                break;
            case 'airport':
                airportMetrics.push(line);
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
        const beaconSource = Object.values(current.sources).find(s => s?.source === 'beacon');
        const beaconDist = beaconSource?.distance || 'N/A';
        lines.push('');
    }

    if (airportMetrics.length > 0) {
        const airportSource = Object.values(current.sources).find(s => s?.source === 'airport');
        lines.push('');
    }

    if (stormglassMetrics.length > 0) {
        lines.push(`🔴 STORMGLASS PRO: Forecast Model`);
        lines.push(...stormglassMetrics);
        lines.push('');
    }

    return lines.join('\n');
}

// Helper to format metric values for display
function formatMetricValue(key: string, value: any): string {
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
            return `${value}%`;
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
