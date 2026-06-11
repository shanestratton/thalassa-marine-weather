/**
 * graphValidate — compile-time edge validation (Phase 10, §3).
 *
 * Every edge polyline is sampled at 25 m against the caller's
 * hard-blocked predicate (the rasterised grid's land/hazard truth):
 * ANY hard-blocked sample aborts the edge. A marks-vouched-but-charted-
 * shallow edge stays traversable-with-caution — depth never aborts here
 * (that's the Fairlead-v2 CAUTION-as-land flaw, dissolved at the graph
 * level per the masterplan); only LAND does.
 *
 * Rejections are returned, never silently dropped — the debug overlay
 * renders them so a missing edge is a visible fact.
 */

import { gateDistM } from './gateExtractor';
import type { RejectedEdge, SeawayEdge, SeawayGraph, SeawayLatLon } from './types';

export interface ValidateResult {
    graph: SeawayGraph;
    rejected: RejectedEdge[];
}

export function validateGraph(
    graph: SeawayGraph,
    isHardBlocked: (p: SeawayLatLon) => boolean,
    stepM = 25,
): ValidateResult {
    const kept: SeawayEdge[] = [];
    const rejected: RejectedEdge[] = [];

    for (const edge of graph.edges) {
        let bad: SeawayLatLon | null = null;
        outer: for (let i = 0; i < edge.polyline.length - 1; i++) {
            const a = edge.polyline[i];
            const b = edge.polyline[i + 1];
            const n = Math.max(1, Math.ceil(gateDistM(a, b) / stepM));
            for (let k = 0; k <= n; k++) {
                const t = k / n;
                const p = { lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t };
                if (isHardBlocked(p)) {
                    bad = p;
                    break outer;
                }
            }
        }
        if (bad) rejected.push({ edge, reason: 'crosses-hard-blocked', at: bad });
        else kept.push(edge);
    }

    return { graph: { ...graph, edges: kept }, rejected };
}
