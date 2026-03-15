/**
 * ComfortZoneEngine — Generates danger zone overlays from wind grid data.
 *
 * Takes a wind grid + user comfort parameters and produces:
 *   1. A GeoJSON FeatureCollection of polygon cells that breach thresholds
 *   2. A canvas-based heatmap image for radial gradient rendering on MapBox
 *
 * Used by usePassagePlanner to render the red glow overlay on the map.
 */

import type { ComfortParams } from '../types/settings';

/** Wind grid type (matches WindStore grid shape) */
interface WindGrid {
    u: Float32Array[];
    v: Float32Array[];
    speed: Float32Array[];
    width: number;
    height: number;
    lats: number[];
    lons: number[];
    north: number;
    south: number;
    west: number;
    east: number;
    totalHours: number;
}

export interface ComfortZoneResult {
    /** Data URL of the danger zone heatmap (red radial gradient, ~15-20% opacity) */
    imageDataUrl: string;
    /** Map bounds: [west, south, east, north] */
    bounds: [number, number, number, number];
    /** Percentage of grid cells that breach comfort limits */
    dangerPercent: number;
    /** Max wind speed found in breach zones */
    maxBreachWindKts: number;
}

/**
 * Check if comfort params have any active limits.
 * Returns false if all limits are undefined/disabled.
 */
export function hasActiveComfortLimits(params?: ComfortParams): boolean {
    if (!params) return false;
    return params.maxWindKts !== undefined || params.maxWaveM !== undefined || params.maxGustKts !== undefined;
}

/**
 * Check if a specific wind speed exceeds comfort limits.
 * Used by IsochroneRouter to treat cells as obstacles.
 */
export function exceedsComfortLimits(
    windSpeedKts: number,
    gustKts: number | null,
    waveHeightM: number | null,
    params: ComfortParams,
): boolean {
    if (params.maxWindKts !== undefined && windSpeedKts > params.maxWindKts) return true;
    if (params.maxGustKts !== undefined && gustKts !== null && gustKts > params.maxGustKts) return true;
    if (params.maxWaveM !== undefined && waveHeightM !== null && waveHeightM > params.maxWaveM) return true;
    return false;
}

/**
 * Generate a comfort zone danger heatmap from wind grid data.
 *
 * Creates a canvas with red radial gradients over grid cells that exceed
 * the user's comfort parameters. Edges are soft-feathered.
 *
 * @param grid - Wind grid data from WindStore
 * @param params - User comfort parameters
 * @param forecastHour - Which forecast hour to evaluate (default: 0 = current)
 * @returns ComfortZoneResult with data URL and bounds, or null if no breaches
 */
export function generateComfortZoneOverlay(
    grid: WindGrid,
    params: ComfortParams,
    forecastHour: number = 0,
): ComfortZoneResult | null {
    if (!hasActiveComfortLimits(params)) return null;

    const hourIdx = Math.min(forecastHour, grid.totalHours - 1);
    const speedData = grid.speed[hourIdx];
    if (!speedData) return null;

    // Scan grid for breach cells
    const M_PER_S_TO_KTS = 1.94384;
    let breachCount = 0;
    let maxBreachWindKts = 0;
    const totalCells = grid.width * grid.height;

    // Build a breach mask
    const breachMask = new Uint8Array(totalCells);
    for (let i = 0; i < totalCells; i++) {
        const windKts = speedData[i] * M_PER_S_TO_KTS;
        // Estimate gust as 1.4× sustained wind (standard meteorological factor)
        const gustKts = windKts * 1.4;

        // Wind-only check (no wave data in wind grid — wave check happens in router
        // via weather report data, which has separate waveHeight field)
        if (
            (params.maxWindKts !== undefined && windKts > params.maxWindKts) ||
            (params.maxGustKts !== undefined && gustKts > params.maxGustKts)
        ) {
            breachMask[i] = 1;
            breachCount++;
            if (windKts > maxBreachWindKts) maxBreachWindKts = windKts;
        }
    }

    if (breachCount === 0) return null;

    // Generate canvas heatmap
    // Resolution: 2px per grid cell for smooth gradients
    const SCALE = 2;
    const canvasW = grid.width * SCALE;
    const canvasH = grid.height * SCALE;
    const canvas = document.createElement('canvas');
    canvas.width = canvasW;
    canvas.height = canvasH;
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;

    // Clear with full transparency
    ctx.clearRect(0, 0, canvasW, canvasH);

    // Draw soft red radial gradients for breach cells
    for (let row = 0; row < grid.height; row++) {
        for (let col = 0; col < grid.width; col++) {
            const idx = row * grid.width + col;
            if (!breachMask[idx]) continue;

            const windKts = speedData[idx] * M_PER_S_TO_KTS;
            // Intensity: how far over the limit (0.3 = barely over, 0.6 = way over)
            const overageRatio = params.maxWindKts
                ? Math.min(1, (windKts - params.maxWindKts) / params.maxWindKts)
                : 0.5;
            const alpha = 0.12 + overageRatio * 0.08; // 12-20% opacity

            const cx = (col + 0.5) * SCALE;
            // Flip Y: lats[0] is southernmost in most grids
            const cy = (grid.height - row - 0.5) * SCALE;
            const radius = SCALE * 1.5; // Overlap for smooth feathering

            const gradient = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
            gradient.addColorStop(0, `rgba(239, 68, 68, ${alpha})`); // Red center
            gradient.addColorStop(0.6, `rgba(239, 68, 68, ${alpha * 0.6})`);
            gradient.addColorStop(1, 'rgba(239, 68, 68, 0)'); // Feathered edge

            ctx.fillStyle = gradient;
            ctx.fillRect(cx - radius, cy - radius, radius * 2, radius * 2);
        }
    }

    return {
        imageDataUrl: canvas.toDataURL('image/png'),
        bounds: [grid.west, grid.south, grid.east, grid.north],
        dangerPercent: Math.round((breachCount / totalCells) * 100),
        maxBreachWindKts: Math.round(maxBreachWindKts),
    };
}
