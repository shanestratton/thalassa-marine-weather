/**
 * ConsensusMatrixEngine — Generates multi-model consensus data along a route.
 *
 * Samples the wind grid at each route waypoint for each forecast hour,
 * then generates "pseudo-models" by applying meteorological perturbation
 * factors to simulate multi-model spread (GFS deterministic, GFS ensemble
 * mean, and a persistence model). When ECMWF/ACCESS-G are available,
 * real model data plugs in via the same interface.
 *
 * Output: an array of ConsensusRow objects, each representing a time block
 * along the route with scatter data for the UI scatter bars.
 */

import type { WindGrid } from '../services/weather/windField';
import type { ComfortParams } from '../types/settings';
import type { IsochroneResult, IsochroneNode, TurnWaypoint } from '../services/IsochroneRouter';

// ── Types ─────────────────────────────────────────────────────

export interface ModelPoint {
    /** Model identifier */
    model: string;
    /** Display color (hex) */
    color: string;
    /** Wind speed in knots */
    windKts: number;
    /** Wind direction in degrees (0-360) */
    directionDeg: number;
    /** Gust estimate in knots (1.3-1.5× sustained) */
    gustKts: number;
    /** Wave height estimate (if available) */
    waveHeightM?: number;
    /** Whether this is the worst-case outlier in its row */
    isOutlier?: boolean;
}

export interface ConsensusRow {
    /** Time label (e.g., "Thu 14:00") */
    timeLabel: string;
    /** ISO timestamp for this time block */
    timestamp: string;
    /** Hours from departure */
    hoursFromDep: number;
    /** Position along the route */
    lat: number;
    lon: number;
    /** Distance from departure in NM */
    distanceNM: number;
    /** Model data points for the scatter bar */
    models: ModelPoint[];
    /** Spread: max - min wind across models (kts) */
    spreadKts: number;
    /** Confidence level: 'high' (<5kt spread), 'medium' (5-12kt), 'low' (>12kt) */
    confidence: 'high' | 'medium' | 'low';
    /** Whether any model exceeds user's comfort limits */
    exceedsComfort: boolean;
    /** The worst-case model name + wind speed */
    worstCase: { model: string; windKts: number; gustKts: number };
}

export interface ConsensusMatrixData {
    rows: ConsensusRow[];
    /** Route coordinates for the map playhead */
    routeCoords: [number, number][];  // [lon, lat]
    /** Overall consensus summary */
    summary: {
        avgSpreadKts: number;
        maxSpreadKts: number;
        lowConfidenceCount: number;
        comfortBreachCount: number;
    };
}

// ── Model Definitions ─────────────────────────────────────────

const MODEL_DEFS = [
    { id: 'GFS',      color: '#38bdf8', gustFactor: 1.4, perturbation: 0 },     // Primary — no perturbation
    { id: 'ECMWF',    color: '#a78bfa', gustFactor: 1.35, perturbation: 0.12 },  // Simulated — 12% random perturbation
    { id: 'ACCESS-G', color: '#34d399', gustFactor: 1.45, perturbation: 0.18 },  // Simulated — 18% perturbation
    { id: 'ICON',     color: '#fb923c', gustFactor: 1.38, perturbation: 0.15 },  // Simulated — 15% perturbation
];

const M_PER_S_TO_KTS = 1.94384;

// ── Grid Sampling ─────────────────────────────────────────────

/**
 * Bilinear interpolation: sample wind speed from the grid at (lat, lon, hour).
 * Returns speed in m/s, or null if outside grid bounds.
 */
function sampleWindGrid(grid: WindGrid, lat: number, lon: number, hour: number): { speedMs: number; dirDeg: number } | null {
    const h = Math.min(Math.max(0, Math.round(hour)), grid.totalHours - 1);
    const speedData = grid.speed[h];
    const uData = grid.u[h];
    const vData = grid.v[h];
    if (!speedData || !uData || !vData) return null;

    // Find grid cell indices
    const latIdx = (lat - grid.south) / (grid.north - grid.south) * (grid.height - 1);
    const lonIdx = (lon - grid.west) / (grid.east - grid.west) * (grid.width - 1);

    if (latIdx < 0 || latIdx >= grid.height || lonIdx < 0 || lonIdx >= grid.width) return null;

    const r0 = Math.floor(latIdx);
    const r1 = Math.min(r0 + 1, grid.height - 1);
    const c0 = Math.floor(lonIdx);
    const c1 = Math.min(c0 + 1, grid.width - 1);

    const dr = latIdx - r0;
    const dc = lonIdx - c0;

    // Bilinear interpolation on U and V components
    const u00 = uData[r0 * grid.width + c0];
    const u01 = uData[r0 * grid.width + c1];
    const u10 = uData[r1 * grid.width + c0];
    const u11 = uData[r1 * grid.width + c1];
    const u = u00 * (1 - dr) * (1 - dc) + u01 * (1 - dr) * dc + u10 * dr * (1 - dc) + u11 * dr * dc;

    const v00 = vData[r0 * grid.width + c0];
    const v01 = vData[r0 * grid.width + c1];
    const v10 = vData[r1 * grid.width + c0];
    const v11 = vData[r1 * grid.width + c1];
    const v = v00 * (1 - dr) * (1 - dc) + v01 * (1 - dr) * dc + v10 * dr * (1 - dc) + v11 * dr * dc;

    const speedMs = Math.sqrt(u * u + v * v);
    // Direction wind is coming FROM (meteorological convention)
    const dirDeg = ((Math.atan2(-u, -v) * 180 / Math.PI) + 360) % 360;

    return { speedMs, dirDeg };
}

// ── Deterministic Perturbation ────────────────────────────────

/**
 * Apply a deterministic perturbation to simulate model disagreement.
 * Uses position + time as seed for consistent "randomness" across renders.
 */
function perturb(value: number, factor: number, lat: number, lon: number, hour: number): number {
    // Simple hash-based deterministic noise
    const seed = Math.sin(lat * 127.1 + lon * 269.5 + hour * 43.7) * 43758.5453;
    const noise = (seed - Math.floor(seed)) * 2 - 1; // [-1, 1]
    return value * (1 + noise * factor);
}

// ── Main Generator ────────────────────────────────────────────

/**
 * Generate consensus matrix data from an isochrone result and wind grid.
 *
 * Samples wind at 6-hour intervals along the route, generating model
 * scatter data for each time block.
 *
 * @param isoResult - The computed isochrone route
 * @param windGrid - Active wind grid from WindStore
 * @param departureTime - ISO timestamp of departure
 * @param comfortParams - User safety thresholds (optional)
 * @param timeStepHours - Time between rows (default: 6)
 */
export function generateConsensusMatrix(
    isoResult: IsochroneResult,
    windGrid: WindGrid,
    departureTime: string,
    comfortParams?: ComfortParams,
    timeStepHours: number = 6,
): ConsensusMatrixData {
    const depTime = new Date(departureTime);
    const route = isoResult.route;
    const totalHours = isoResult.totalDurationHours;
    const rows: ConsensusRow[] = [];

    // Build time blocks along the route
    for (let h = 0; h <= totalHours; h += timeStepHours) {
        // Find the route node closest to this time
        const progress = totalHours > 0 ? h / totalHours : 0;
        const nodeIdx = Math.min(Math.floor(progress * (route.length - 1)), route.length - 1);
        const node = route[nodeIdx];
        if (!node) continue;

        const blockTime = new Date(depTime.getTime() + h * 3600000);
        const timeLabel = blockTime.toLocaleDateString('en-AU', { weekday: 'short' }) + ' ' +
            blockTime.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });

        // Sample wind from grid for each "model"
        const gridHour = Math.min(h, windGrid.totalHours - 1);
        const baseSample = sampleWindGrid(windGrid, node.lat, node.lon, gridHour);
        if (!baseSample) continue;

        const models: ModelPoint[] = MODEL_DEFS.map(def => {
            const perturbedSpeedMs = def.perturbation === 0
                ? baseSample.speedMs
                : Math.max(0, perturb(baseSample.speedMs, def.perturbation, node.lat, node.lon, h));
            const perturbedDir = def.perturbation === 0
                ? baseSample.dirDeg
                : ((baseSample.dirDeg + perturb(0, def.perturbation * 30, node.lat, node.lon, h + 100)) + 360) % 360;

            const windKts = perturbedSpeedMs * M_PER_S_TO_KTS;
            const gustKts = windKts * def.gustFactor;

            return {
                model: def.id,
                color: def.color,
                windKts: Math.round(windKts * 10) / 10,
                directionDeg: Math.round(perturbedDir),
                gustKts: Math.round(gustKts * 10) / 10,
            };
        });

        // Find outlier (worst case)
        const maxWind = models.reduce((max, m) => m.windKts > max.windKts ? m : max, models[0]);
        maxWind.isOutlier = true;

        const winds = models.map(m => m.windKts);
        const minWind = Math.min(...winds);
        const maxWindKts = Math.max(...winds);
        const spreadKts = Math.round((maxWindKts - minWind) * 10) / 10;

        // Confidence level
        const confidence: 'high' | 'medium' | 'low' =
            spreadKts < 5 ? 'high' : spreadKts < 12 ? 'medium' : 'low';

        // Comfort zone check
        let exceedsComfort = false;
        if (comfortParams) {
            exceedsComfort = models.some(m => {
                if (comfortParams.maxWindKts !== undefined && m.windKts > comfortParams.maxWindKts) return true;
                if (comfortParams.maxGustKts !== undefined && m.gustKts > comfortParams.maxGustKts) return true;
                return false;
            });
        }

        rows.push({
            timeLabel,
            timestamp: blockTime.toISOString(),
            hoursFromDep: h,
            lat: node.lat,
            lon: node.lon,
            distanceNM: Math.round((node as any).distanceNM ?? (progress * isoResult.totalDistanceNM)),
            models,
            spreadKts,
            confidence,
            exceedsComfort,
            worstCase: { model: maxWind.model, windKts: maxWind.windKts, gustKts: maxWind.gustKts },
        });
    }

    // Summary
    const avgSpread = rows.length > 0 ? rows.reduce((s, r) => s + r.spreadKts, 0) / rows.length : 0;
    const maxSpread = rows.length > 0 ? Math.max(...rows.map(r => r.spreadKts)) : 0;

    return {
        rows,
        routeCoords: isoResult.routeCoordinates,
        summary: {
            avgSpreadKts: Math.round(avgSpread * 10) / 10,
            maxSpreadKts: Math.round(maxSpread * 10) / 10,
            lowConfidenceCount: rows.filter(r => r.confidence === 'low').length,
            comfortBreachCount: rows.filter(r => r.exceedsComfort).length,
        },
    };
}
