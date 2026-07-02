/**
 * scaleShadow — multi-scale ENC cell de-confliction ("the Tangalooma tan wall").
 *
 * ENC cells come in usage bands: a 30°×30° OVERVIEW cell (OC-61-051031 spans
 * the entire Coral Sea) charts Moreton Island as a crude blob that bulges
 * ~500 m over real water — over the Tangalooma anchorage and its wrecks —
 * while the 1°×1° DETAIL cell (OC-61-351824) carries the true coastline.
 * Rendering or routing the overview geometry where a detail cell covers the
 * same area paints land over water (Shane's "straight tan line") and feeds
 * the router fake LNDARE.
 *
 * Rule (standard ENC practice, bbox-approximated): a feature from a MUCH
 * coarser cell (bbox area ≥ RATIO× larger) is DROPPED when its own bbox lies
 * fully inside a finer cell's bbox — the finer cell owns that ground. Features
 * only partially inside are KEPT (no polygon clipping in v1): dropping them
 * would delete real land outside the detail coverage. Sibling cells of similar
 * scale never shadow each other (ratio guard), so tiled same-band cells are
 * untouched.
 */
import type { Feature } from 'geojson';

export interface CellExtent {
    id: string;
    bbox: [number, number, number, number]; // [minLon, minLat, maxLon, maxLat]
}

/** Coarse-to-fine bbox-area ratio before a cell is shadowed by a finer one. */
export const SCALE_SHADOW_RATIO = 16;

const bboxArea = (b: [number, number, number, number]): number => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

/** The finer cells that shadow `cell` (empty = nothing to drop, fast path). */
export function shadowingCells(cell: CellExtent, all: readonly CellExtent[], ratio = SCALE_SHADOW_RATIO): CellExtent[] {
    const a = bboxArea(cell.bbox);
    if (!Number.isFinite(a) || a <= 0) return [];
    return all.filter((o) => o.id !== cell.id && bboxArea(o.bbox) > 0 && a >= ratio * bboxArea(o.bbox));
}

function featureBbox(f: Feature): [number, number, number, number] | null {
    let minLon = Infinity;
    let minLat = Infinity;
    let maxLon = -Infinity;
    let maxLat = -Infinity;
    const visit = (coords: unknown): void => {
        if (!Array.isArray(coords)) return;
        if (coords.length >= 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number') {
            const lon = coords[0] as number;
            const lat = coords[1] as number;
            if (lon < minLon) minLon = lon;
            if (lat < minLat) minLat = lat;
            if (lon > maxLon) maxLon = lon;
            if (lat > maxLat) maxLat = lat;
            return;
        }
        for (const c of coords) visit(c);
    };
    const geom = f.geometry as { coordinates?: unknown } | null;
    visit(geom?.coordinates);
    if (!Number.isFinite(minLon)) return null;
    return [minLon, minLat, maxLon, maxLat];
}

const bboxInside = (inner: [number, number, number, number], outer: [number, number, number, number]): boolean =>
    inner[0] >= outer[0] && inner[1] >= outer[1] && inner[2] <= outer[2] && inner[3] <= outer[3];

/**
 * True when `feature` (from a coarse cell) should be dropped because it lies
 * fully inside one of the finer `shadows` bboxes.
 */
export function featureIsShadowed(feature: Feature, shadows: readonly CellExtent[]): boolean {
    if (shadows.length === 0) return false;
    const fb = featureBbox(feature);
    if (!fb) return false;
    return shadows.some((s) => bboxInside(fb, s.bbox));
}
