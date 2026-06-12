/**
 * compileFromCells — viewport-scoped Seaway Graph compile over the
 * installed ENC cells (Phase 10 debug overlay's data path).
 *
 * Reads the version-cached merged vector data (EncHazardService — already
 * paid for by the ENC chart layer whenever a cell is imported), filters
 * the BOYLAT/BCNLAT points to the viewport (+ padding so channels
 * straddling the edge keep their gate ordering), splits them into the
 * compiler's two tiers via markSplit (shared with the Phase 12 shadow
 * router — markSplit is a leaf module precisely so the routing pipeline
 * never imports THIS file's EncHazardService dependency), and compiles.
 */

import { getMergedVectorData } from '../enc/EncHazardService';
import { compileSeawayGraph, type CompileResult } from './graphCompiler';
import { splitMarkFeatures, type PointFeatureLike } from './markSplit';
import { seawayOverlayGeoJSON, type SeawayOverlayGeoJSON } from './overlayGeoJSON';

export interface ViewportCompile extends CompileResult {
    overlay: SeawayOverlayGeoJSON;
    /** Marks considered (post-viewport-filter), for the debug summary. */
    markCount: number;
}

/** ~2.5 km padding keeps a channel's gate ordering intact when the
 *  viewport clips it mid-channel. */
const PAD_DEG = 0.025;

/**
 * Compile the Seaway Graph for a viewport bbox [minLon, minLat, maxLon,
 * maxLat]. Returns null when no cells are installed or no lateral marks
 * fall inside the (padded) viewport.
 */
export async function compileSeawayGraphForViewport(
    bbox: [number, number, number, number],
): Promise<ViewportCompile | null> {
    const merged = await getMergedVectorData();
    if (!merged) return null;

    const [minLon, minLat, maxLon, maxLat] = [
        bbox[0] - PAD_DEG,
        bbox[1] - PAD_DEG,
        bbox[2] + PAD_DEG,
        bbox[3] + PAD_DEG,
    ];

    const all = ([...merged.BOYLAT.features, ...merged.BCNLAT.features] as PointFeatureLike[]).filter((f) => {
        const g = f.geometry;
        if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) return false;
        const [lon, lat] = g.coordinates;
        return lon >= minLon && lon <= maxLon && lat >= minLat && lat <= maxLat;
    });
    const { chartFeatures, unnumberedMarks } = splitMarkFeatures(all);

    const markCount = chartFeatures.length + unnumberedMarks.length;
    if (markCount === 0) return null;

    const result = compileSeawayGraph({ chartFeatures, unnumberedMarks });
    return { ...result, overlay: seawayOverlayGeoJSON(result.graph, result.rejected), markCount };
}
