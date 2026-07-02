/**
 * markSplit — lateral-mark point features → the compiler's two tiers.
 * Leaf module (no storage/UI imports) so the Phase 12 shadow router can
 * share the split with the overlay's compileFromCells WITHOUT dragging
 * EncHazardService (localStorage, cell subscriptions) into the routing
 * pipeline's import graph.
 */

import type { UnnumberedMark } from './gateExtractor';

export interface PointFeatureLike {
    geometry?: { type?: string; coordinates?: number[] } | null;
    properties?: Record<string, unknown> | null;
}

const NUMBERED = /^[A-Za-z]*\d+/;

/**
 * Numbered OBJNAM → chart tier (sequence-adjacency pairing, 0.95);
 * CATLAM-only → geometric tier (mutual-best, 0.4).
 */
export function splitMarkFeatures(features: PointFeatureLike[]): {
    chartFeatures: PointFeatureLike[];
    unnumberedMarks: UnnumberedMark[];
} {
    const chartFeatures: PointFeatureLike[] = [];
    const unnumberedMarks: UnnumberedMark[] = [];
    for (const f of features) {
        const g = f.geometry;
        if (!g || g.type !== 'Point' || !Array.isArray(g.coordinates)) continue;
        const [lon, lat] = g.coordinates;
        const props = f.properties ?? {};
        const cat = props.CATLAM;
        // 1/2 = plain laterals; 3/4 = preferred-channel modified laterals, folded onto
        // their treat-as side (3 → port-hand, 4 → stbd-hand; identical in IALA A and B).
        if (cat !== 1 && cat !== 2 && cat !== 3 && cat !== 4) continue;
        const name = typeof props.OBJNAM === 'string' ? props.OBJNAM : '';
        if (NUMBERED.test(name)) {
            chartFeatures.push(f); // tier 1 — sequence-adjacency pairing
        } else {
            unnumberedMarks.push({ lat, lon, side: cat === 1 || cat === 3 ? 'port' : 'stbd' }); // tier 3
        }
    }
    return { chartFeatures, unnumberedMarks };
}
