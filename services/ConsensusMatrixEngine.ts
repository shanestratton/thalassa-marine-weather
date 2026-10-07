/**
 * ConsensusMatrixEngine — multi-model wind consensus along a route.
 *
 * Architecture:
 *   1. Samples route waypoints at 6-hour intervals
 *   2. Fetches wind from Open-Meteo for GFS, ECMWF IFS, ICON and GEM in one
 *      call per point, using the `&models=` parameter and a unix clock
 *   3. A model joins a row only if it gave a real value at that hour: a null
 *      is never a 0-knot calm, and a missing gust is never invented as wind
 *      × 1.4. Only model-suffixed keys are read, so a degraded unsuffixed
 *      reply cannot pose as four models agreeing.
 *   4. When no model answered at a row, the chart's ONE wind grid is shown as
 *      what it is — one grid at the hour the boat is there, no model name, no
 *      spread, no agreement grade. (Until build 123 it was multiplied by
 *      sin-noise into fake "ECMWF", "ICON" and "GEM" members.)
 *   5. Builds ConsensusRow objects with spread, confidence (two or more
 *      models only) and Comfort Zone checks.
 */

import type { WindGrid } from '../services/weather/windField';
import type { ComfortParams } from '../types/settings';
import type { IsochroneResult } from '../services/IsochroneRouter';
import { fetchOpenMeteoPoints } from '../services/weather/openMeteoProxy';
import { continuousEastForLongitudeRange, continuousLongitudeInGrid } from '../services/weather/windLongitude';
import { windForecastHoursForGrid, windFrameForForecastHour } from '../components/map/windTimeAxis';
import { createLogger } from '../utils/createLogger';

const log = createLogger('ConsensusMatrix');

// ── Types ─────────────────────────────────────────────────────

export interface ModelPoint {
    model: string;
    color: string;
    windKts: number;
    /** Null when the model gave no direction at that hour. */
    directionDeg: number | null;
    /** Null when the model publishes no gust there — never estimated. */
    gustKts: number | null;
    waveHeightM?: number;
    isOutlier?: boolean;
}

/** The chart's single wind grid at one point and hour — no model name. */
export interface GridSample {
    windKts: number;
    directionDeg: number;
    gustKts: number | null;
}

export interface ConsensusRow {
    timeLabel: string;
    timestamp: string;
    hoursFromDep: number;
    lat: number;
    lon: number;
    distanceNM: number;
    /** Models that gave a value at this hour; empty when only the grid did. */
    models: ModelPoint[];
    /** The one grid's value, when no model answered for this row. */
    grid?: GridSample;
    /** Max − min wind across models; null with fewer than two. */
    spreadKts: number | null;
    /** Null with fewer than two models: one source cannot agree or split. */
    confidence: 'high' | 'medium' | 'low' | null;
    exceedsComfort: boolean;
    worstCase: { model: string | null; windKts: number; gustKts: number | null };
}

export interface ConsensusMatrixData {
    rows: ConsensusRow[];
    routeCoords: [number, number][];
    /** Models that answered somewhere on the route; empty for a single grid. */
    modelsUsed: string[];
    dataSource: 'live' | 'single-grid';
    /**
     * Why there are no rows (null when there are some): the wind grid carries
     * no forecast time to place it on the passage (an offline .wind.bin, a
     * fallback fetch), or no forecast covers the route's places and times.
     */
    emptyReason: 'no-clock' | 'no-coverage' | null;
    summary: {
        avgSpreadKts: number | null;
        maxSpreadKts: number | null;
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
const HOUR_MS = 3_600_000;
/** A model hour further than this from the boat's ETA is not that hour's forecast. */
const MAX_HOUR_GAP_MS = 1.5 * HOUR_MS;

// ── Live Multi-Model Fetch ────────────────────────────────────

interface RoutePoint {
    lat: number;
    lon: number;
    hoursFromDep: number;
    distanceNM: number;
}

const finite = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const toKts = (kmh: number) => Math.round(kmh * KMH_TO_KTS * 10) / 10;

/**
 * Fetch real multi-model wind forecasts from Open-Meteo for route waypoints.
 * Uses the `models` parameter to get GFS, ECMWF, ICON, and GEM in one call per point.
 */
async function fetchMultiModelWind(
    points: RoutePoint[],
    departureTime: Date,
): Promise<Map<number, ModelPoint[]> | null> {
    try {
        const modelIds = MODELS.map((m) => m.id).join(',');

        log.info(`[ConsensusMatrix] Fetching ${points.length} points × ${MODELS.length} models`);
        const results = await fetchOpenMeteoPoints<Record<string, unknown>>('forecast', points, {
            hourly: 'wind_speed_10m,wind_direction_10m,wind_gusts_10m',
            models: modelIds,
            forecast_days: 7,
            // Unix seconds: an ISO string from timezone=auto carries no offset,
            // and parsing it on the phone shifted every ETA by the time zone.
            timeformat: 'unixtime',
            timezone: 'UTC',
        });

        const pointModels = new Map<number, ModelPoint[]>();

        for (let pi = 0; pi < points.length; pi++) {
            const point = points[pi];
            const hourly = (results[pi] as { hourly?: Record<string, unknown[]> } | undefined)?.hourly;
            if (!hourly) continue;

            // The hourly index closest to this point's ETA — and only if it is
            // within the hour: past the forecast's end there is no answer.
            const pointEta = departureTime.getTime() + point.hoursFromDep * HOUR_MS;
            const timestamps = Array.isArray(hourly.time) ? hourly.time : [];
            let bestIdx = -1;
            let bestDiff = Infinity;
            for (let t = 0; t < timestamps.length; t++) {
                const at = finite(timestamps[t]);
                if (at === null) continue;
                const diff = Math.abs(at * 1000 - pointEta);
                if (diff < bestDiff) {
                    bestDiff = diff;
                    bestIdx = t;
                }
            }
            if (bestIdx < 0 || bestDiff > MAX_HOUR_GAP_MS) continue;

            const models: ModelPoint[] = [];
            for (const modelDef of MODELS) {
                // Model-suffixed keys only (wind_speed_10m_gfs_seamless, …).
                const speedKmh = finite(hourly[`wind_speed_10m_${modelDef.id}`]?.[bestIdx]);
                if (speedKmh === null) continue; // this model sits this hour out
                const gustKmh = finite(hourly[`wind_gusts_10m_${modelDef.id}`]?.[bestIdx]);
                const dirDeg = finite(hourly[`wind_direction_10m_${modelDef.id}`]?.[bestIdx]);
                models.push({
                    model: modelDef.label,
                    color: modelDef.color,
                    windKts: toKts(speedKmh),
                    directionDeg: dirDeg === null ? null : Math.round(dirDeg),
                    gustKts: gustKmh === null ? null : toKts(gustKmh),
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

// ── The one chart grid, at the boat's real hour ────────────────

const M_PER_S_TO_KTS = 1.94384;

function bilinear(plane: Float32Array, grid: WindGrid, r: number, c: number): number {
    const r0 = Math.floor(r),
        r1 = Math.min(r0 + 1, grid.height - 1);
    const c0 = Math.floor(c),
        c1 = Math.min(c0 + 1, grid.width - 1);
    const dr = r - r0,
        dc = c - c0;
    return (
        plane[r0 * grid.width + c0] * (1 - dr) * (1 - dc) +
        plane[r0 * grid.width + c1] * (1 - dr) * dc +
        plane[r1 * grid.width + c0] * dr * (1 - dc) +
        plane[r1 * grid.width + c1] * dr * dc
    );
}

/**
 * The grid's wind at a point and absolute time, or null when the grid cannot
 * say: outside its box, before or past its forecast hours, or with no clock
 * (refTime) to place the time on its axis. Never the last hour stood in for a
 * later one.
 */
const gridClockMs = (grid: WindGrid): number => (grid.refTime ? Date.parse(grid.refTime) : NaN);

function sampleGridAt(grid: WindGrid, lat: number, lon: number, atMs: number): GridSample | null {
    const refMs = gridClockMs(grid);
    const axis = windForecastHoursForGrid(grid);
    if (!Number.isFinite(refMs) || axis.length === 0) return null;
    const target = windFrameForForecastHour(axis, (atMs - refMs) / HOUR_MS);
    if (!target || target.beyond) return null;
    const h = Math.round(target.frame);
    const uData = grid.u[h];
    const vData = grid.v[h];
    if (!uData || !vData) return null;

    const latIdx = ((lat - grid.south) / (grid.north - grid.south)) * (grid.height - 1);
    const gridEast = continuousEastForLongitudeRange(grid.west, grid.east);
    const gridLon = continuousLongitudeInGrid(lon, grid.west, grid.east);
    const lonIdx = ((gridLon - grid.west) / (gridEast - grid.west)) * (grid.width - 1);
    if (latIdx < 0 || latIdx >= grid.height || lonIdx < 0 || lonIdx >= grid.width) return null;

    const u = bilinear(uData, grid, latIdx, lonIdx);
    const v = bilinear(vData, grid, latIdx, lonIdx);
    const gustPlane = grid.gust?.[h];
    const gust = gustPlane ? bilinear(gustPlane, grid, latIdx, lonIdx) : NaN;
    const round = (ms: number) => Math.round(ms * M_PER_S_TO_KTS * 10) / 10;
    return {
        windKts: round(Math.sqrt(u * u + v * v)),
        directionDeg: Math.round(((Math.atan2(-u, -v) * 180) / Math.PI + 360) % 360),
        gustKts: Number.isFinite(gust) ? round(gust) : null,
    };
}

// ── Main Generator ────────────────────────────────────────────

/**
 * Generate consensus matrix data from isochrone result.
 *
 * Strategy:
 *   1. Try live multi-model fetch from Open-Meteo (real GFS, ECMWF, ICON, GEM data)
 *   2. A row no model answered shows the chart's one wind grid, labelled as such
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
            distanceNM: Math.round(
                Number.isFinite(node.distance) ? node.distance : progress * isoResult.totalDistanceNM,
            ),
        });
    }

    // Try live multi-model fetch
    const liveData = await fetchMultiModelWind(samplePoints, depTime);

    // Build rows
    const rows: ConsensusRow[] = [];

    for (let i = 0; i < samplePoints.length; i++) {
        const pt = samplePoints[i];
        const blockTime = new Date(depTime.getTime() + pt.hoursFromDep * HOUR_MS);
        const timeLabel =
            blockTime.toLocaleDateString('en-AU', { weekday: 'short' }) +
            ' ' +
            blockTime.toLocaleTimeString('en-AU', { hour: '2-digit', minute: '2-digit', hour12: false });

        const models: ModelPoint[] = liveData?.get(i) ?? [];
        const grid = models.length === 0 ? sampleGridAt(windGrid, pt.lat, pt.lon, blockTime.getTime()) : null;
        if (models.length === 0 && !grid) continue;

        let spreadKts: number | null = null;
        let confidence: ConsensusRow['confidence'] = null;
        let worstCase: ConsensusRow['worstCase'];
        if (models.length > 0) {
            // The strongest model is the worst case; with two or more it is
            // also flagged as the outlier on the scatter bar.
            const maxModel = models.reduce((max, m) => (m.windKts > max.windKts ? m : max), models[0]);
            worstCase = { model: maxModel.model, windKts: maxModel.windKts, gustKts: maxModel.gustKts };
            if (models.length >= 2) {
                maxModel.isOutlier = true;
                const winds = models.map((m) => m.windKts);
                spreadKts = Math.round((Math.max(...winds) - Math.min(...winds)) * 10) / 10;
                confidence = spreadKts < 5 ? 'high' : spreadKts < 12 ? 'medium' : 'low';
            }
        } else {
            worstCase = { model: null, windKts: grid!.windKts, gustKts: grid!.gustKts };
        }

        let exceedsComfort = false;
        if (comfortParams) {
            const readings = models.length > 0 ? models : [grid!];
            exceedsComfort = readings.some((m) => {
                if (comfortParams.maxWindKts !== undefined && m.windKts > comfortParams.maxWindKts) return true;
                if (
                    comfortParams.maxGustKts !== undefined &&
                    m.gustKts !== null &&
                    m.gustKts > comfortParams.maxGustKts
                )
                    return true;
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
            ...(grid ? { grid } : {}),
            spreadKts,
            confidence,
            exceedsComfort,
            worstCase,
        });
    }

    const spreads = rows.map((r) => r.spreadKts).filter((v): v is number => v !== null);
    const modelsUsed = MODELS.map((m) => m.label).filter((label) =>
        rows.some((r) => r.models.some((m) => m.model === label)),
    );

    return {
        rows,
        routeCoords: isoResult.routeCoordinates,
        modelsUsed,
        dataSource: liveData ? 'live' : 'single-grid',
        emptyReason: rows.length > 0 ? null : Number.isFinite(gridClockMs(windGrid)) ? 'no-coverage' : 'no-clock',
        summary: {
            avgSpreadKts: spreads.length
                ? Math.round((spreads.reduce((s, v) => s + v, 0) / spreads.length) * 10) / 10
                : null,
            maxSpreadKts: spreads.length ? Math.round(Math.max(...spreads) * 10) / 10 : null,
            lowConfidenceCount: rows.filter((r) => r.confidence === 'low').length,
            comfortBreachCount: rows.filter((r) => r.exceedsComfort).length,
        },
    };
}
