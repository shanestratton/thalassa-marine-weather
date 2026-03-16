/**
 * OpenMeteoWindFetcher — Fetch model-specific wind grids for isochrone routing.
 *
 * Takes a route bounding box and a model name (gfs, ecmwf, etc.) and returns
 * a WindGrid suitable for the isochrone engine. Uses Open-Meteo's multi-point
 * batch API (comma-separated lat/lon) with model selection.
 *
 * This bridges the MultiModelWeatherService (point forecasts for consensus matrix)
 * and the IsochroneRouter (which needs a full WindGrid/WindField for wavefront expansion).
 */

import { createLogger } from '../utils/createLogger';
import { getOpenMeteoKey } from './keys';
import type { WindGrid } from './windField';
import type { ModelSource } from './WindFieldAdapter';
import { AVAILABLE_MODELS, type WeatherModelId, recommendModels } from './MultiModelWeatherService';
const log = createLogger('OMWind');

const FORECAST_HOURS = 168; // 7 days for passage planning
const BATCH_SIZE = 50; // Open-Meteo max per request
const CONCURRENCY = 4; // Parallel API calls

/**
 * Fetch a WindGrid for a specific weather model covering the route bbox.
 *
 * Uses ~2° grid resolution for open-ocean passages, fine enough for
 * isochrone wavefront expansion while keeping API calls reasonable.
 */
export async function fetchModelWindGrid(
    modelId: WeatherModelId,
    bounds: { north: number; south: number; west: number; east: number },
    forecastHours: number = FORECAST_HOURS,
): Promise<WindGrid | null> {
    const omKey = getOpenMeteoKey();
    if (!omKey) {
        log.warn('No API key available');
        return null;
    }

    const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
    if (!model) {
        log.warn(`Unknown model: ${modelId}`);
        return null;
    }

    const t0 = performance.now();

    // Build grid points at ~2° resolution (ocean routing doesn't need finer)
    const RES = 2.0;
    const uniqueLats: number[] = [];
    const uniqueLons: number[] = [];
    for (let lat = bounds.south; lat <= bounds.north + 0.01; lat += RES) {
        uniqueLats.push(Math.round(Math.min(lat, bounds.north) * 100) / 100);
    }
    for (let lon = bounds.west; lon <= bounds.east + 0.01; lon += RES) {
        uniqueLons.push(Math.round(Math.min(lon, bounds.east) * 100) / 100);
    }

    // Ensure minimum grid size
    if (uniqueLats.length < 3) {
        const mid = (bounds.north + bounds.south) / 2;
        uniqueLats.length = 0;
        uniqueLats.push(bounds.south, mid, bounds.north);
    }
    if (uniqueLons.length < 3) {
        const mid = (bounds.west + bounds.east) / 2;
        uniqueLons.length = 0;
        uniqueLons.push(bounds.west, mid, bounds.east);
    }

    const rows = uniqueLats.length;
    const cols = uniqueLons.length;

    // Build all grid points
    const allPoints: { lat: number; lon: number }[] = [];
    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            allPoints.push({ lat: uniqueLats[r], lon: uniqueLons[c] });
        }
    }

    console.info(
        `[OpenMeteoFetcher] ${model.name}: ${rows}×${cols} grid (${allPoints.length} points), ${forecastHours}h`,
    );

    // Batch requests
    const allResults: unknown[] = new Array(allPoints.length).fill(null);
    const batches: { start: number; end: number }[] = [];
    for (let i = 0; i < allPoints.length; i += BATCH_SIZE) {
        batches.push({ start: i, end: Math.min(i + BATCH_SIZE, allPoints.length) });
    }

    const baseUrl = 'https://customer-api.open-meteo.com/v1/forecast';

    try {
        for (let b = 0; b < batches.length; b += CONCURRENCY) {
            const chunk = batches.slice(b, b + CONCURRENCY);
            await Promise.all(
                chunk.map(async ({ start, end }) => {
                    const batchPoints = allPoints.slice(start, end);
                    const latParam = batchPoints.map((p) => p.lat).join(',');
                    const lonParam = batchPoints.map((p) => p.lon).join(',');

                    const url =
                        `${baseUrl}?latitude=${latParam}&longitude=${lonParam}` +
                        `&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
                        `&forecast_hours=${forecastHours}` +
                        `&models=${model.openMeteoModel}` +
                        `&timezone=UTC` +
                        `&apikey=${omKey}`;

                    const resp = await fetch(url, { signal: AbortSignal.timeout(20_000) });
                    if (!resp.ok) {
                        log.warn(`${model.name} batch ${start}-${end} failed: ${resp.status}`);
                        return;
                    }

                    const data = await resp.json();
                    const results = Array.isArray(data) ? data : [data];
                    for (let i = 0; i < results.length; i++) {
                        allResults[start + i] = results[i];
                    }
                }),
            );
        }

        // Check we got enough data
        const validCount = allResults.filter((r) => (r as Record<string, unknown>)?.hourly).length;
        if (validCount < allPoints.length * 0.5) {
            log.warn(`${model.name}: only ${validCount}/${allPoints.length} points valid`);
            return null;
        }

        // Determine actual forecast length from response
        const firstValid = allResults.find((r) => (r as Record<string, unknown>)?.hourly) as
            | Record<string, Record<string, number[]>>
            | undefined;
        const totalHours = firstValid?.hourly?.wind_speed_10m?.length ?? forecastHours;

        // Convert Open-Meteo JSON → WindGrid (U/V Float32Arrays)
        const uGrids: Float32Array[] = [];
        const vGrids: Float32Array[] = [];
        const speedGrids: Float32Array[] = [];

        for (let h = 0; h < totalHours; h++) {
            const uArr = new Float32Array(rows * cols);
            const vArr = new Float32Array(rows * cols);
            const sArr = new Float32Array(rows * cols);

            for (let r = 0; r < rows; r++) {
                for (let c = 0; c < cols; c++) {
                    const idx = r * cols + c;
                    const hourly = (allResults[idx] as Record<string, Record<string, number[]>> | null)?.hourly;

                    const speedKmh = hourly?.wind_speed_10m?.[h] ?? 0;
                    const dirDeg = hourly?.wind_direction_10m?.[h] ?? 0;

                    // km/h → m/s
                    const speedMs = speedKmh / 3.6;
                    const dirRad = (dirDeg * Math.PI) / 180;

                    // Meteorological: direction is where wind comes FROM
                    // U = eastward, V = northward (direction wind blows TO)
                    const u = -speedMs * Math.sin(dirRad);
                    const v = -speedMs * Math.cos(dirRad);

                    uArr[idx] = u;
                    vArr[idx] = v;
                    sArr[idx] = speedMs;
                }
            }

            uGrids.push(uArr);
            vGrids.push(vArr);
            speedGrids.push(sArr);
        }

        const dt = Math.round(performance.now() - t0);
        log.info(`✓ ${model.name}: ${rows}×${cols}×${totalHours}h grid in ${dt}ms`);

        return {
            u: uGrids,
            v: vGrids,
            speed: speedGrids,
            width: cols,
            height: rows,
            lats: uniqueLats,
            lons: uniqueLons,
            north: uniqueLats[rows - 1],
            south: uniqueLats[0],
            west: uniqueLons[0],
            east: uniqueLons[cols - 1],
            totalHours,
        };
    } catch (err) {
        log.warn(`${model.name} failed:`, err);
        return null;
    }
}

/**
 * Fetch WindGrids for multiple models and return as ModelSource array
 * ready for createEnsembleWindField().
 *
 * Auto-selects regional models based on route position (ACCESS-G for Oz, ICON for Europe).
 */
export async function fetchMultiModelWindGrids(
    bounds: { north: number; south: number; west: number; east: number },
    modelIds?: WeatherModelId[],
    forecastHours: number = FORECAST_HOURS,
): Promise<ModelSource[]> {
    // Auto-select models based on route midpoint if not specified
    const midLat = (bounds.north + bounds.south) / 2;
    const midLon = (bounds.west + bounds.east) / 2;
    const models = modelIds ?? recommendModels(midLat, midLon);

    log.info(`Fetching multi-model grids: ${models.join(', ')}`);

    const results = await Promise.all(
        models.map(async (modelId): Promise<ModelSource | null> => {
            const grid = await fetchModelWindGrid(modelId, bounds, forecastHours);
            if (!grid) return null;
            const model = AVAILABLE_MODELS.find((m) => m.id === modelId);
            return {
                name: model?.name ?? modelId.toUpperCase(),
                grid,
                weight: 1.0,
            };
        }),
    );

    return results.filter(Boolean) as ModelSource[];
}
