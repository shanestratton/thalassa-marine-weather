/**
 * MultiModelWeatherService — Fetch and compare forecasts from multiple weather models.
 *
 * For offshore passage planning, serious sailors check multiple models to assess
 * forecast confidence. This service queries GFS, ECMWF, and optionally ICON/ACCESS-G
 * for the same set of route waypoints, then produces a comparison matrix.
 *
 * Uses Open-Meteo's multi-model endpoint (free tier) which provides access to:
 *   - GFS (NOAA) — 0.25° global
 *   - ECMWF IFS — 0.1° global (best model)
 *   - ICON (DWD) — 0.125° Europe, 0.25° global
 *   - BOM ACCESS-G — 0.15° Australia (best for Oz waters)
 *   - GEM (CMC) — 0.25° global (Canadian model)
 *
 * Architecture:
 *   Client calls queryMultiModel() with route waypoints + time range
 *   → Open-Meteo returns hourly forecasts for each model
 *   → Service produces per-waypoint model comparison
 *   → UI shows consensus/divergence for GO/NO-GO decision
 */

import { getOpenMeteoKey } from './keys';

// ── Types ─────────────────────────────────────────────────────────

export type WeatherModelId = 'gfs' | 'ecmwf' | 'icon' | 'access_g' | 'gem';

export interface WeatherModelInfo {
    id: WeatherModelId;
    name: string;
    provider: string;
    resolution: string;
    description: string;
    bestFor: string;
    openMeteoModel: string; // Open-Meteo model parameter value
}

export const AVAILABLE_MODELS: WeatherModelInfo[] = [
    {
        id: 'gfs',
        name: 'GFS',
        provider: 'NOAA',
        resolution: '0.25°',
        description: 'Global Forecast System — workhorse global model',
        bestFor: 'Global baseline, reliable 7-day forecasts',
        openMeteoModel: 'gfs_seamless',
    },
    {
        id: 'ecmwf',
        name: 'ECMWF IFS',
        provider: 'ECMWF',
        resolution: '0.1°',
        description: 'European Centre — highest resolution global model',
        bestFor: 'Best overall accuracy, particularly for fronts and low pressure',
        openMeteoModel: 'ecmwf_ifs025',
    },
    {
        id: 'icon',
        name: 'ICON',
        provider: 'DWD',
        resolution: '0.125°',
        description: 'Germany\'s Icosahedral model — strong for Atlantic/Med',
        bestFor: 'European waters, Mediterranean, North Atlantic',
        openMeteoModel: 'icon_seamless',
    },
    {
        id: 'access_g',
        name: 'ACCESS-G',
        provider: 'BOM',
        resolution: '0.15°',
        description: 'Bureau of Meteorology — best for Australian waters',
        bestFor: 'Coral Sea, Tasman, Southern Ocean, Pacific Islands',
        openMeteoModel: 'bom_access_global',
    },
    {
        id: 'gem',
        name: 'GEM',
        provider: 'CMC',
        resolution: '0.25°',
        description: 'Canadian Global Environmental Multiscale',
        bestFor: 'Pacific crossings, North Pacific, high latitude',
        openMeteoModel: 'gem_seamless',
    },
];

export interface ModelForecastPoint {
    time: string;           // ISO
    windSpeed: number;      // kts
    windDirection: number;  // degrees
    windGust: number;       // kts
    waveHeight: number;     // metres
    pressure: number;       // hPa
}

export interface ModelForecast {
    model: WeatherModelInfo;
    points: ModelForecastPoint[];
}

export interface WaypointComparison {
    lat: number;
    lon: number;
    name?: string;
    forecasts: ModelForecast[];
    consensus: {
        windSpeedMean: number;
        windSpeedSpread: number;    // max - min across models
        windDirectionMean: number;
        windDirectionSpread: number;
        waveHeightMean: number;
        waveHeightSpread: number;
        pressureMean: number;
        confidence: 'high' | 'medium' | 'low';
    };
}

export interface MultiModelResult {
    waypoints: WaypointComparison[];
    models: WeatherModelInfo[];
    forecastHours: number;
    queryTime: string;
    elapsed_ms: number;
}

// ── Service ──────────────────────────────────────────────────────

/**
 * Query multiple weather models for a set of route waypoints.
 *
 * @param waypoints - Route points to query (lat, lon, optional name)
 * @param modelIds - Which models to query (default: GFS + ECMWF + regional)
 * @param forecastHours - How many hours ahead to forecast (default: 120 = 5 days)
 */
export async function queryMultiModel(
    waypoints: { lat: number; lon: number; name?: string }[],
    modelIds: WeatherModelId[] = ['gfs', 'ecmwf'],
    forecastHours: number = 120,
): Promise<MultiModelResult | null> {
    const t0 = performance.now();
    const omKey = getOpenMeteoKey();

    if (waypoints.length === 0) return null;

    // Decimate waypoints if too many (max 20 for API sanity)
    let queryPoints = waypoints;
    if (waypoints.length > 20) {
        const step = (waypoints.length - 1) / 19;
        queryPoints = [];
        for (let i = 0; i < 20; i++) {
            queryPoints.push(waypoints[Math.round(i * step)]);
        }
    }

    const models = modelIds
        .map(id => AVAILABLE_MODELS.find(m => m.id === id))
        .filter(Boolean) as WeatherModelInfo[];

    if (models.length === 0) return null;

    // Build multi-point lat/lon strings
    const latStr = queryPoints.map(p => p.lat.toFixed(4)).join(',');
    const lonStr = queryPoints.map(p => p.lon.toFixed(4)).join(',');

    // Query each model in parallel
    const modelForecasts = await Promise.all(
        models.map(model => fetchModelForecast(model, latStr, lonStr, forecastHours, queryPoints.length, omKey))
    );

    // Build waypoint comparisons
    const waypointComparisons: WaypointComparison[] = queryPoints.map((wp, wpIdx) => {
        const forecasts: ModelForecast[] = [];

        for (let m = 0; m < models.length; m++) {
            const modelData = modelForecasts[m];
            if (modelData && modelData[wpIdx]) {
                forecasts.push({
                    model: models[m],
                    points: modelData[wpIdx],
                });
            }
        }

        // Calculate consensus metrics (using the first forecast hour as sample)
        const consensus = calculateConsensus(forecasts);

        return {
            lat: wp.lat,
            lon: wp.lon,
            name: wp.name,
            forecasts,
            consensus,
        };
    });

    return {
        waypoints: waypointComparisons,
        models,
        forecastHours,
        queryTime: new Date().toISOString(),
        elapsed_ms: Math.round(performance.now() - t0),
    };
}

/**
 * Detect the best models to query based on vessel position.
 * Returns optimal model set for the region.
 */
export function recommendModels(lat: number, lon: number): WeatherModelId[] {
    const models: WeatherModelId[] = ['gfs', 'ecmwf']; // Always include baseline pair

    // Australian waters — add ACCESS-G
    if (lat < 0 && lat > -60 && lon > 100 && lon < 180) {
        models.push('access_g');
    }

    // European / Mediterranean / North Atlantic — add ICON
    if (lat > 20 && lat < 75 && lon > -80 && lon < 50) {
        models.push('icon');
    }

    // Pacific — add GEM
    if (lon < -100 || lon > 150) {
        if (!models.includes('gem')) models.push('gem');
    }

    return models;
}

// ── Internal ─────────────────────────────────────────────────────

async function fetchModelForecast(
    model: WeatherModelInfo,
    latStr: string,
    lonStr: string,
    forecastHours: number,
    numPoints: number,
    omKey: string | null,
): Promise<ModelForecastPoint[][] | null> {
    try {
        const params = new URLSearchParams({
            latitude: latStr,
            longitude: lonStr,
            hourly: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m,pressure_msl',
            forecast_hours: String(forecastHours),
            models: model.openMeteoModel,
            timezone: 'UTC',
        });

        // Add wave height if available (not all models have it)
        // Open-Meteo marine endpoint provides waves
        const waveParams = new URLSearchParams({
            latitude: latStr,
            longitude: lonStr,
            hourly: 'wave_height',
            forecast_hours: String(forecastHours),
            models: 'best_match',
            timezone: 'UTC',
        });

        let baseUrl = 'https://api.open-meteo.com/v1/forecast';
        let waveUrl = 'https://marine-api.open-meteo.com/v1/marine';

        if (omKey) {
            baseUrl = 'https://customer-api.open-meteo.com/v1/forecast';
            waveUrl = 'https://customer-marine-api.open-meteo.com/v1/marine';
            params.set('apikey', omKey);
            waveParams.set('apikey', omKey);
        }

        // Fetch wind/pressure and waves in parallel
        const [windResp, waveResp] = await Promise.all([
            fetch(`${baseUrl}?${params}`, { signal: AbortSignal.timeout(15_000) }),
            fetch(`${waveUrl}?${waveParams}`, { signal: AbortSignal.timeout(15_000) }).catch(() => null),
        ]);

        if (!windResp.ok) {
            console.warn(`[MultiModel] ${model.name} fetch failed: ${windResp.status}`);
            return null;
        }

        const windData = await windResp.json();
        const waveData = waveResp?.ok ? await waveResp.json() : null;

        // Parse results — Open-Meteo returns array for multi-point queries
        const windResults = Array.isArray(windData) ? windData : [windData];
        const waveResults = waveData ? (Array.isArray(waveData) ? waveData : [waveData]) : [];

        const allPoints: ModelForecastPoint[][] = [];

        for (let i = 0; i < numPoints; i++) {
            const hourly = windResults[i]?.hourly;
            const waveHourly = waveResults[i]?.hourly;

            if (!hourly) {
                allPoints.push([]);
                continue;
            }

            const times: string[] = hourly.time || [];
            const points: ModelForecastPoint[] = times.map((time: string, h: number) => ({
                time,
                windSpeed: Math.round((hourly.wind_speed_10m?.[h] ?? 0) / 1.852 * 10) / 10, // km/h → kts
                windDirection: hourly.wind_direction_10m?.[h] ?? 0,
                windGust: Math.round((hourly.wind_gusts_10m?.[h] ?? 0) / 1.852 * 10) / 10,
                waveHeight: waveHourly?.wave_height?.[h] ?? 0,
                pressure: hourly.pressure_msl?.[h] ?? 1013,
            }));

            allPoints.push(points);
        }

        return allPoints;
    } catch (err) {
        console.warn(`[MultiModel] ${model.name} error:`, err);
        return null;
    }
}

function calculateConsensus(forecasts: ModelForecast[]): WaypointComparison['consensus'] {
    if (forecasts.length === 0 || forecasts.every(f => f.points.length === 0)) {
        return {
            windSpeedMean: 0,
            windSpeedSpread: 0,
            windDirectionMean: 0,
            windDirectionSpread: 0,
            waveHeightMean: 0,
            waveHeightSpread: 0,
            pressureMean: 1013,
            confidence: 'low',
        };
    }

    // Use the forecast at ~24h out as the representative sample
    // (close enough to be meaningful, far enough for models to diverge)
    const sampleIdx = Math.min(24, forecasts[0].points.length - 1);

    const windSpeeds: number[] = [];
    const windDirs: number[] = [];
    const waveHeights: number[] = [];
    const pressures: number[] = [];

    for (const f of forecasts) {
        const pt = f.points[sampleIdx];
        if (!pt) continue;
        windSpeeds.push(pt.windSpeed);
        windDirs.push(pt.windDirection);
        waveHeights.push(pt.waveHeight);
        pressures.push(pt.pressure);
    }

    const mean = (arr: number[]) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const spread = (arr: number[]) => arr.length ? Math.max(...arr) - Math.min(...arr) : 0;

    // Circular mean for direction
    let sumSin = 0, sumCos = 0;
    for (const d of windDirs) {
        sumSin += Math.sin(d * Math.PI / 180);
        sumCos += Math.cos(d * Math.PI / 180);
    }
    const meanDir = windDirs.length
        ? ((Math.atan2(sumSin / windDirs.length, sumCos / windDirs.length) * 180 / Math.PI) + 360) % 360
        : 0;

    // Direction spread
    let maxDirDiff = 0;
    for (let i = 0; i < windDirs.length; i++) {
        for (let j = i + 1; j < windDirs.length; j++) {
            let diff = Math.abs(windDirs[i] - windDirs[j]);
            if (diff > 180) diff = 360 - diff;
            maxDirDiff = Math.max(maxDirDiff, diff);
        }
    }

    const wSpread = spread(windSpeeds);
    const confidence: 'high' | 'medium' | 'low' =
        (wSpread > 15 || maxDirDiff > 60) ? 'low' :
            (wSpread > 8 || maxDirDiff > 30) ? 'medium' : 'high';

    return {
        windSpeedMean: Math.round(mean(windSpeeds) * 10) / 10,
        windSpeedSpread: Math.round(wSpread * 10) / 10,
        windDirectionMean: Math.round(meanDir),
        windDirectionSpread: Math.round(maxDirDiff),
        waveHeightMean: Math.round(mean(waveHeights) * 10) / 10,
        waveHeightSpread: Math.round(spread(waveHeights) * 10) / 10,
        pressureMean: Math.round(mean(pressures)),
        confidence,
    };
}

// ── Convenience: Get model info by ID ────────────────────────────

export function getModelById(id: WeatherModelId): WeatherModelInfo | undefined {
    return AVAILABLE_MODELS.find(m => m.id === id);
}
