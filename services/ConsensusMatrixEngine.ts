/**
 * ConsensusMatrixEngine — Real multi-model weather consensus along a route.
 *
 * Architecture:
 *   1. Samples route waypoints at 6-hour intervals
 *   2. Fetches wind data from Open-Meteo for ALL models in a single API call
 *      using the `&models=` parameter (GFS, ECMWF IFS, ICON, GEM)
 *   3. Falls back to WindStore grid sampling with perturbation if API fails
 *   4. Generates ConsensusRow objects with scatter data, outlier detection,
 *      confidence levels, and Comfort Zone integration
 *
 * Supported Models (via Open-Meteo):
 *   - GFS (NOAA) — 0.25° global, runs every 6h
 *   - ECMWF IFS — 0.1° global, runs every 6h
 *   - DWD ICON — 0.125° global, runs every 6h
 *   - GEM (Canada) — 0.25° global, runs every 12h
 */

import type { WindGrid } from '../services/weather/windField';
import type { ComfortParams } from '../types/settings';
import type { IsochroneResult } from '../services/IsochroneRouter';
import { getOpenMeteoKey } from '../services/weather/keys';
import { createLogger } from '../utils/createLogger';

const log = createLogger('ConsensusMatrix');

// ── Types ─────────────────────────────────────────────────────

export interface ModelPoint {
    model: string;
    color: string;
    windKts: number;
    directionDeg: number;
    gustKts: number;
    waveHeightM?: number;
    isOutlier?: boolean;
}

export interface ConsensusRow {
    timeLabel: string;
    timestamp: string;
    hoursFromDep: number;
    lat: number;
    lon: number;
    distanceNM: number;
    models: ModelPoint[];
    spreadKts: number;
    confidence: 'high' | 'medium' | 'low';
    exceedsComfort: boolean;
    worstCase: { model: string; windKts: number; gustKts: number };
}

export interface ConsensusMatrixData {
    rows: ConsensusRow[];
    routeCoords: [number, number][];
    modelsUsed: string[];
    dataSource: 'live' | 'grid-fallback';
    summary: {
        avgSpreadKts: number;
        maxSpreadKts: number;
        lowConfidenceCount: number;
        comfortBreachCount: number;
    };
}

// ── Model Definitions ─────────────────────────────────────────

const MODELS = [
    { id: 'gfs_seamless', label: 'GFS', color: '#38bdf8' },
    { id: 'ecmwf_ifs025', label: 'ECMWF', color: '#a78bfa' },
    { id: 'icon_seamless', label: 'ICON', color: '#34d399' },
    { id: 'gem_seamless', label: 'GEM', color: '#fb923c' },
];

const KMH_TO_KTS = 0.539957;

// ── Live Multi-Model Fetch ────────────────────────────────────

interface RoutePoint {
    lat: number;
    lon: number;
    hoursFromDep: number;
    distanceNM: number;
}

/**
 * Fetch real multi-model wind forecasts from Open-Meteo for route waypoints.
 * Uses the `models` parameter to get GFS, ECMWF, ICON, and GEM in one call per point.
 */
async function fetchMultiModelWind(
    points: RoutePoint[],
    departureTime: Date,
): Promise<Map<number, ModelPoint[]> | null> {
    const omKey = getOpenMeteoKey();
    if (!omKey) {
        log.warn('[ConsensusMatrix] No Open-Meteo API key — falling back to grid');
        return null;
    }

    try {
        const modelIds = MODELS.map((m) => m.id).join(',');
        const lats = points.map((p) => p.lat.toFixed(4)).join(',');
        const lons = points.map((p) => p.lon.toFixed(4)).join(',');

        const url =
            `https://customer-api.open-meteo.com/v1/forecast?` +
            `latitude=${lats}&longitude=${lons}` +
            `&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m` +
            `&models=${modelIds}` +
            `&forecast_days=7` +
            `&timezone=auto` +
            `&apikey=${omKey}`;

        log.info(`[ConsensusMatrix] Fetching ${points.length} points × ${MODELS.length} models`);
        const resp = await fetch(url);
        if (!resp.ok) {
            log.warn(`[ConsensusMatrix] API returned ${resp.status}`);
            return null;
        }

        const data = await resp.json();
        const results: Record<string, unknown>[] = Array.isArray(data) ? data : [data];

        const pointModels = new Map<number, ModelPoint[]>();

        for (let pi = 0; pi < points.length; pi++) {
            const point = points[pi];
            const result = results[pi];
            if (!(result as Record<string, unknown>)?.hourly) continue;

            // Find the hourly index closest to this point's ETA
            const pointEta = new Date(departureTime.getTime() + point.hoursFromDep * 3600000);
            const hourly = (result as Record<string, Record<string, unknown[]>>).hourly;
            const timestamps: string[] = (hourly.time as string[]) || [];
            let bestIdx = 0;
            let bestDiff = Infinity;
            for (let t = 0; t < timestamps.length; t++) {
                const diff = Math.abs(new Date(timestamps[t]).getTime() - pointEta.getTime());
                if (diff < bestDiff) {
                    bestDiff = diff;
                    bestIdx = t;
                }
            }

            const models: ModelPoint[] = [];

            for (const modelDef of MODELS) {
                // Open-Meteo returns model-prefixed keys like:
                //   wind_speed_10m_gfs_seamless, wind_speed_10m_ecmwf_ifs025, etc.
                const speedKey = `wind_speed_10m_${modelDef.id}`;
                const dirKey = `wind_direction_10m_${modelDef.id}`;
                const gustKey = `wind_gusts_10m_${modelDef.id}`;

                // Also try unprefixed (single-model response)
                const speedArr = hourly[speedKey] || hourly.wind_speed_10m;
                const dirArr = hourly[dirKey] || hourly.wind_direction_10m;
                const gustArr = hourly[gustKey] || hourly.wind_gusts_10m;

                if (!speedArr) continue;

                const speedKmh = Number(speedArr[bestIdx] ?? 0);
                const dirDeg = Number(dirArr?.[bestIdx] ?? 0);
                const gustKmh = Number(gustArr?.[bestIdx] ?? speedKmh * 1.4);

                models.push({
                    model: modelDef.label,
                    color: modelDef.color,
                    windKts: Math.round(speedKmh * KMH_TO_KTS * 10) / 10,
                    directionDeg: Math.round(dirDeg),
                    gustKts: Math.round(gustKmh * KMH_TO_KTS * 10) / 10,
                });
            }

            if (models.length > 0) {
                pointModels.set(pi, models);
            }
        }

        log.info(`[ConsensusMatrix] Got real data for ${pointModels.size}/${points.length} points`);
        return pointModels.size > 0 ? pointModels : null;
    } catch (err) {
        log.warn('[ConsensusMatrix] Multi-model fetch failed:', err);
        return null;
    }
}

// ── Grid Fallback: Sampling + Perturbation ────────────────────

const M_PER_S_TO_KTS = 1.94384;

function sampleWindGrid(
    grid: WindGrid,
    lat: number,
    lon: number,
    hour: number,
): { speedMs: number; dirDeg: number } | null {
    const h = Math.min(Math.max(0, Math.round(hour)), grid.totalHours - 1);
    const speedData = grid.speed[h];
    const uData = grid.u[h];
    const vData = grid.v[h];
    if (!speedData || !uData || !vData) return null;

    const latIdx = ((lat - grid.south) / (grid.north - grid.south)) * (grid.height - 1);
    const lonIdx = ((lon - grid.west) / (grid.east - grid.west)) * (grid.width - 1);
    if (latIdx < 0 || latIdx >= grid.height || lonIdx < 0 || lonIdx >= grid.width) return null;

    const r0 = Math.floor(latIdx),
        r1 = Math.min(r0 + 1, grid.height - 1);
    const c0 = Math.floor(lonIdx),
        c1 = Math.min(c0 + 1, grid.width - 1);
    const dr = latIdx - r0,
        dc = lonIdx - c0;

    const u =
        uData[r0 * grid.width + c0] * (1 - dr) * (1 - dc) +
        uData[r0 * grid.width + c1] * (1 - dr) * dc +
        uData[r1 * grid.width + c0] * dr * (1 - dc) +
        uData[r1 * grid.width + c1] * dr * dc;
    const v =
        vData[r0 * grid.width + c0] * (1 - dr) * (1 - dc) +
        vData[r0 * grid.width + c1] * (1 - dr) * dc +
        vData[r1 * grid.width + c0] * dr * (1 - dc) +
        vData[r1 * grid.width + c1] * dr * dc;

    return { speedMs: Math.sqrt(u * u + v * v), dirDeg: ((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360 };
}

function perturb(value: number, factor: number, lat: number, lon: number, hour: number): number {
    const seed = Math.sin(lat * 127.1 + lon * 269.5 + hour * 43.7) * 43758.5453;
    const noise = (seed - Math.floor(seed)) * 2 - 1;
    return value * (1 + noise * factor);
}

const FALLBACK_MODELS = [
    { label: 'GFS', color: '#38bdf8', gustFactor: 1.4, perturbation: 0 },
    { label: 'ECMWF', color: '#a78bfa', gustFactor: 1.35, perturbation: 0.12 },
    { label: 'ICON', color: '#34d399', gustFactor: 1.45, perturbation: 0.18 },
    { label: 'GEM', color: '#fb923c', gustFactor: 1.38, perturbation: 0.15 },
];

function generateFallbackModels(grid: WindGrid, lat: number, lon: number, hour: number): ModelPoint[] {
    const sample = sampleWindGrid(grid, lat, lon, hour);
    if (!sample) return [];

    return FALLBACK_MODELS.map((def) => {
        const speedMs =
            def.perturbation === 0
                ? sample.speedMs
                : Math.max(0, perturb(sample.speedMs, def.perturbation, lat, lon, hour));
        const windKts = speedMs * M_PER_S_TO_KTS;
        return {
            model: def.label,
            color: def.color,
            windKts: Math.round(windKts * 10) / 10,
            directionDeg: Math.round(sample.dirDeg),
            gustKts: Math.round(windKts * def.gustFactor * 10) / 10,
        };
    });
}

// ── Main Generator ────────────────────────────────────────────

/**
 * Generate consensus matrix data from isochrone result.
 *
 * Strategy:
 *   1. Try live multi-model fetch from Open-Meteo (real ECMWF, ICON, GEM data)
 *   2. Fall back to WindStore grid sampling with perturbation if API unavailable
 */
export async function generateConsensusMatrix(
    isoResult: IsochroneResult,
    windGrid: WindGrid,
    departureTime: string,
    comfortParams?: ComfortParams,
    timeStepHours: number = 6,
): Promise<ConsensusMatrixData> {
    const depTime = new Date(departureTime);
    const route = isoResult.route;
    const totalHours = isoResult.totalDurationHours;

    // Build sample points along route at timeStepHours intervals
    const samplePoints: RoutePoint[] = [];
    for (let h = 0; h <= totalHours; h += timeStepHours) {
        const progress = totalHours > 0 ? h / totalHours : 0;
        const nodeIdx = Math.min(Math.floor(progress * (route.length - 1)), route.length - 1);
        const node = route[nodeIdx];
        if (!node) continue;

        samplePoints.push({
            lat: node.lat,
            lon: node.lon,
            hoursFromDep: h,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            distanceNM: Math.round((node as any).distanceNM ?? progress * isoResult.totalDistanceNM),
        });
    }

    // Try live multi-model fetch
    const liveData = await fetchMultiModelWind(samplePoints, depTime);
    const dataSource = liveData ? 'live' : ('grid-fallback' as const);

    // Build rows
    const rows: ConsensusRow[] = [];

    for (let i = 0; i < samplePoints.length; i++) {
        const pt = samplePoints[i];
        const blockTime = new Date(depTime.getTime() + pt.hoursFromDep * 3600000);
        const timeLabel =
            blockTime.toLocaleDateString('en-AU', { weekday: 'short' }) +
            ' ' +
            blockTime.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });

        // Get models — live or fallback
        let models: ModelPoint[] = liveData?.get(i) ?? [];
        if (models.length === 0) {
            const gridHour = Math.min(pt.hoursFromDep, windGrid.totalHours - 1);
            models = generateFallbackModels(windGrid, pt.lat, pt.lon, gridHour);
        }
        if (models.length === 0) continue;

        // Find outlier
        const maxModel = models.reduce((max, m) => (m.windKts > max.windKts ? m : max), models[0]);
        maxModel.isOutlier = true;

        const winds = models.map((m) => m.windKts);
        const spreadKts = Math.round((Math.max(...winds) - Math.min(...winds)) * 10) / 10;
        const confidence: 'high' | 'medium' | 'low' = spreadKts < 5 ? 'high' : spreadKts < 12 ? 'medium' : 'low';

        let exceedsComfort = false;
        if (comfortParams) {
            exceedsComfort = models.some((m) => {
                if (comfortParams.maxWindKts !== undefined && m.windKts > comfortParams.maxWindKts) return true;
                if (comfortParams.maxGustKts !== undefined && m.gustKts > comfortParams.maxGustKts) return true;
                return false;
            });
        }

        rows.push({
            timeLabel,
            timestamp: blockTime.toISOString(),
            hoursFromDep: pt.hoursFromDep,
            lat: pt.lat,
            lon: pt.lon,
            distanceNM: pt.distanceNM,
            models,
            spreadKts,
            confidence,
            exceedsComfort,
            worstCase: { model: maxModel.model, windKts: maxModel.windKts, gustKts: maxModel.gustKts },
        });
    }

    const avgSpread = rows.length > 0 ? rows.reduce((s, r) => s + r.spreadKts, 0) / rows.length : 0;
    const modelsUsed = liveData
        ? [...new Set([...liveData.values()].flat().map((m) => m.model))]
        : FALLBACK_MODELS.map((m) => m.label);

    return {
        rows,
        routeCoords: isoResult.routeCoordinates,
        modelsUsed,
        dataSource,
        summary: {
            avgSpreadKts: Math.round(avgSpread * 10) / 10,
            maxSpreadKts: rows.length > 0 ? Math.round(Math.max(...rows.map((r) => r.spreadKts)) * 10) / 10 : 0,
            lowConfidenceCount: rows.filter((r) => r.confidence === 'low').length,
            comfortBreachCount: rows.filter((r) => r.exceedsComfort).length,
        },
    };
}
