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
    /**
     * One or two Mapbox-safe image pieces. A passage grid can cross the Date
     * Line, whereas one Mapbox image source may not; callers render these
     * pieces instead of stretching a red glow across the whole world.
     */
    segments: ComfortZoneImageSegment[];
    /** Percentage of grid cells that breach comfort limits */
    dangerPercent: number;
    /** Max wind speed found in breach zones */
    maxBreachWindKts: number;
}

export interface ComfortZoneImageSegment {
    sourceSuffix: '' | '_r';
    imageDataUrl: string;
    bounds: [number, number, number, number];
}

export interface ComfortZoneSegmentGeometry {
    sourceSuffix: '' | '_r';
    startColumn: number;
    endColumn: number;
    bounds: [number, number, number, number];
}

function canonicalWest(longitude: number): number {
    const normalized = ((((longitude + 180) % 360) + 360) % 360) - 180;
    return normalized === -180 && longitude > 0 ? 180 : normalized;
}

function mapLongitude(longitude: number, edge: 'west' | 'east'): number {
    // Do not use canonicalWest here: it deliberately spells a positive 180°
    // as +180 for the first segment. The companion image needs the opposite
    // spelling (-180°) as its western edge or Mapbox treats it as wrapping
    // back across the entire world.
    const normalized = ((((longitude + 180) % 360) + 360) % 360) - 180;
    if (Math.abs(normalized + 180) < 1e-6) return edge === 'east' ? 180 : -180;
    return normalized;
}

/**
 * Split an image grid at the International Date Line when required. Kept
 * pure so the rendering path can be regression-tested without a canvas.
 */
export function buildComfortZoneSegmentGeometry(
    bounds: [number, number, number, number],
    columns: number,
): ComfortZoneSegmentGeometry[] {
    const [inputWest, south, inputEast, north] = bounds;
    if (!Number.isFinite(columns) || columns < 2) return [];
    let originalEast = inputEast;
    while (originalEast <= inputWest) originalEast += 360;
    const span = originalEast - inputWest;
    if (!Number.isFinite(span) || span <= 0) return [];

    const west = canonicalWest(inputWest);
    const east = west + span;
    const lastColumn = Math.floor(columns) - 1;
    const global = span >= 359;
    const crossesDateLine = !global && west < 180 && east > 180;
    if (!global && !crossesDateLine) {
        return [
            {
                sourceSuffix: '',
                startColumn: 0,
                endColumn: lastColumn,
                bounds: [mapLongitude(west, 'west'), south, mapLongitude(east, 'east'), north],
            },
        ];
    }

    const seam = global ? (west < 0 ? 0 : 180) : 180;
    const rawSplit = Math.round(((seam - west) / span) * lastColumn);
    const splitColumn = Math.max(1, Math.min(lastColumn - 1, rawSplit));
    return [
        {
            sourceSuffix: '',
            startColumn: 0,
            endColumn: splitColumn,
            bounds: [mapLongitude(west, 'west'), south, mapLongitude(seam, 'east'), north],
        },
        {
            sourceSuffix: '_r',
            startColumn: splitColumn,
            endColumn: lastColumn,
            bounds: [mapLongitude(seam, 'west'), south, mapLongitude(east, 'east'), north],
        },
    ];
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

    const bounds: [number, number, number, number] = [grid.west, grid.south, grid.east, grid.north];
    const imageDataUrl = canvas.toDataURL('image/png');
    const geometry = buildComfortZoneSegmentGeometry(bounds, grid.width);
    // Preserve the legacy single-image behaviour for a degenerate one-column
    // grid. Normal passage grids always take the tested geometry path above.
    const segmentsToRender =
        geometry.length > 0
            ? geometry
            : [
                  {
                      sourceSuffix: '' as const,
                      startColumn: 0,
                      endColumn: Math.max(0, grid.width - 1),
                      bounds,
                  },
              ];
    const segments: ComfortZoneImageSegment[] = [];

    for (const segment of segmentsToRender) {
        const isFullImage = segment.startColumn === 0 && segment.endColumn === grid.width - 1;
        let segmentImageDataUrl = imageDataUrl;
        if (!isFullImage) {
            const startX = segment.startColumn * SCALE;
            const segmentWidth = (segment.endColumn - segment.startColumn + 1) * SCALE;
            const slice = document.createElement('canvas');
            slice.width = segmentWidth;
            slice.height = canvasH;
            const sliceContext = slice.getContext('2d');
            if (!sliceContext) return null;
            // The seam column intentionally belongs to both images. That
            // avoids a transparent one-column crack at ±180°.
            sliceContext.drawImage(canvas, startX, 0, segmentWidth, canvasH, 0, 0, segmentWidth, canvasH);
            segmentImageDataUrl = slice.toDataURL('image/png');
        }
        segments.push({
            sourceSuffix: segment.sourceSuffix,
            imageDataUrl: segmentImageDataUrl,
            bounds: segment.bounds,
        });
    }

    return {
        imageDataUrl,
        bounds,
        segments,
        dangerPercent: Math.round((breachCount / totalCells) * 100),
        maxBreachWindKts: Math.round(maxBreachWindKts),
    };
}
