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

/**
 * Glaze-clip shadow ratio — MUCH lower than SCALE_SHADOW_RATIO, and the
 * two must stay separate (adversarial review 2026-07-14): overlapping
 * cells closer than 16x produced an EMPTY shadow list, so the coarser
 * cell's glaze shipped unclipped and its SAFE-white (fill-opacity keyed
 * on DRVAL1 ≥ safetyDepth) painted over water the finer survey charts
 * as under-keel — the fine band's opacity-0 glaze can't occlude
 * translucent white stacked beneath it. White means "verified safe for
 * YOUR keel"; that's a safety-optics gap, not a cosmetic one.
 *
 * Why the base drop keeps 16x but the glaze clip can run at 2x:
 * dropping a base feature DELETES chart data, so it demands "much
 * coarser"; the glaze clip only removes coarse SAFE-white where a finer
 * survey charts SHALLOW water (< GLAZE_CLIP_MAX_SAFE_M — deep fine
 * bands never clip, which is what keeps the corridor staircase dead),
 * and wherever that shallow fine band is still keel-safe the fine
 * cell's own glaze repaints white. Genuinely safe water can never go
 * dark; the worst case is the strip-quantisation whisker of bare
 * imagery — the conservative direction.
 *
 * Why 2 and not 1: mutual shadowing needs ratio² ≤ 1, so any ratio > 1
 * makes the clip one-directional, and the 2x margin keeps same-band
 * grid siblings (near-equal bbox areas, routinely overlapping at their
 * seams) from nibbling whisker halos into each other's glaze.
 */
export const GLAZE_SHADOW_RATIO = 2;

const bboxArea = (b: [number, number, number, number]): number => Math.max(0, b[2] - b[0]) * Math.max(0, b[3] - b[1]);

/**
 * Deterministic FINENESS RANK from a cell's bbox area (the same
 * smaller-is-finer heuristic shadowingCells trusts): higher = finer
 * survey. Whole-bbox shadowing above can only drop features fully
 * inside finer coverage — a huge coarse polygon that pokes outside
 * survives whole and then fights the fine survey cell-by-cell in the
 * nav grid, where shallowest-wins let a crude 1:90k "dries 2 m" flats
 * blob beat a 1:22k surveyed 2–5 m band (Newport approach, Shane
 * 2026-07-11: "my keel is only 2.4 m and it is 2 m deep at LAT??").
 * The grid resolves that with per-cell rank claims: finest survey
 * wins the cell, conservatism applies within a rank. Derived from the
 * bbox alone (not the candidate set) so stamping cached blob features
 * is idempotent and race-free across concurrent merges.
 */
export function cellScaleRank(bbox: [number, number, number, number]): number {
    const a = bboxArea(bbox);
    if (!Number.isFinite(a) || a <= 0) return 0;
    return Math.max(-32000, Math.min(32000, Math.round(-Math.log10(a) * 100)));
}

/** Stamp `_scaleRank` onto features (idempotent — same value every merge). */
export function stampScaleRank(features: readonly Feature[], bbox: [number, number, number, number]): void {
    const rank = cellScaleRank(bbox);
    for (const f of features) {
        const props = (f.properties ??= {}) as Record<string, unknown>;
        if (props._scaleRank !== rank) props._scaleRank = rank;
    }
}

/** The finer cells that shadow `cell` (empty = nothing to drop, fast path). */
export function shadowingCells(cell: CellExtent, all: readonly CellExtent[], ratio = SCALE_SHADOW_RATIO): CellExtent[] {
    const a = bboxArea(cell.bbox);
    if (!Number.isFinite(a) || a <= 0) return [];
    return all.filter((o) => o.id !== cell.id && bboxArea(o.bbox) > 0 && a >= ratio * bboxArea(o.bbox));
}

/** Memoized per feature. Feature objects come from the LRU-cached ENC blobs
 *  and are stable across merges, so this walk (recursive over every
 *  coordinate) runs ONCE per feature for the whole session instead of once
 *  per shadow test AND once per sub-pixel-cull test each merge (audit rank 6:
 *  featureDiagDeg + featureIsShadowed were two identical full-coord walks of
 *  the same feature, ~40-50% of tagAndPush's coordinate time). */
const featureBboxCache = new WeakMap<Feature, [number, number, number, number] | null>();

export function featureBboxCached(f: Feature): [number, number, number, number] | null {
    const hit = featureBboxCache.get(f);
    if (hit !== undefined) return hit;
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
    const out: [number, number, number, number] | null = Number.isFinite(minLon)
        ? [minLon, minLat, maxLon, maxLat]
        : null;
    featureBboxCache.set(f, out);
    return out;
}

function featureBbox(f: Feature): [number, number, number, number] | null {
    return featureBboxCached(f);
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
