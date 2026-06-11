/**
 * compileFromCells — viewport-scoped Seaway Graph compile over the
 * installed ENC cells (Phase 10 debug overlay's data path).
 *
 * Reads the version-cached merged vector data (EncHazardService — already
 * paid for by the ENC chart layer whenever a cell is imported), filters
 * the BOYLAT/BCNLAT points to the viewport (+ padding so channels
 * straddling the edge keep their gate ordering), splits them into the
 * compiler's two tiers (numbered OBJNAM → chart tier; CATLAM-only →
 * geometric tier), and compiles. Pure & React-free: unit-testable, and
 * directly reusable when the graph feeds routing at Phase 12.
 */

import { getMergedVectorData } from '../enc/EncHazardService';
import { compileSeawayGraph, type CompileResult } from './graphCompiler';
import type { UnnumberedMark } from './gateExtractor';
import { seawayOverlayGeoJSON, type SeawayOverlayGeoJSON } from './overlayGeoJSON';

export interface ViewportCompile extends CompileResult {
    overlay: SeawayOverlayGeoJSON;
    /** Marks considered (post-viewport-filter), for the debug summary. */
    markCount: number;
}

/** ~2.5 km padding keeps a channel's gate ordering intact when the
 *  viewport clips it mid-channel. */
const PAD_DEG = 0.025;

interface PointFeatureLike {
    geometry?: { type?: string; coordinates?: number[] } | null;
    properties?: Record<string, unknown> | null;
}

const NUMBERED = /^[A-Za-z]*\d+/;

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

    const all = [...merged.BOYLAT.features, ...merged.BCNLAT.features] as PointFeatureLike[];
    const chartFeatures: PointFeatureLike[] = [];
    const unnumberedMarks: UnnumberedMark[] = [];

    for (const f of all) {
        const g = f.geometry;
        if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
        const [lon, lat] = g.coordinates;
        if (lon < minLon || lon > maxLon || lat < minLat || lat > maxLat) continue;
        const props = f.properties ?? {};
        const cat = props.CATLAM;
        if (cat !== 1 && cat !== 2) continue;
        const name = typeof props.OBJNAM === 'string' ? props.OBJNAM : '';
        if (NUMBERED.test(name)) {
            chartFeatures.push(f); // tier 1 — sequence-adjacency pairing
        } else {
            unnumberedMarks.push({ lat, lon, side: cat === 1 ? 'port' : 'stbd' }); // tier 3
        }
    }

    const markCount = chartFeatures.length + unnumberedMarks.length;
    if (markCount === 0) return null;

    const result = compileSeawayGraph({ chartFeatures, unnumberedMarks });
    return { ...result, overlay: seawayOverlayGeoJSON(result.graph, result.rejected), markCount };
}
