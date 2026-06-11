/**
 * graphCompiler — marks in, SeawayGraph out (Phase 10, §3).
 *
 * Pipeline: extract chart gates (tier 1) + geometric gates (tier 3) →
 * dedup (chart wins) → corridor edges per channel → confidence gating
 * (sub-0.6 gates form edges only with charted corroboration) → land
 * validation. Output feeds the DEBUG OVERLAY only in Phase 10 — zero
 * routing change; the live engine is untouched.
 */

import { parseLateralMarks, groupChannels, type LateralMark } from '../fairlead';
import { buildChannelEdges, type DepthSampler } from './corridorBuilder';
import {
    EDGE_CONFIDENCE_FLOOR,
    dedupGates,
    extractChartGates,
    extractGeometricGates,
    type GeometricGateOptions,
    type UnnumberedMark,
} from './gateExtractor';
import { validateGraph, type ValidateResult } from './graphValidate';
import type { GateNode, RejectedEdge, SeawayEdge, SeawayGraph, SeawayLatLon } from './types';

export interface CompileOptions extends GeometricGateOptions {
    /** Numbered chart laterals (BOYLAT/BCNLAT GeoJSON-ish features). */
    chartFeatures?: Parameters<typeof parseLateralMarks>[0];
    /** Unnumbered laterals (CATLAM only) for the geometric tier. */
    unnumberedMarks?: UnnumberedMark[];
    /** Hard land/hazard truth from the rasterised grid. Absent → land
     *  validation is skipped (pure-geometry compile, tests/overlay). */
    isHardBlocked?: (p: SeawayLatLon) => boolean;
    /** Charted-depth sampler for controllingDepthM. */
    depthSampler?: DepthSampler;
    /** Charted-water corroboration for sub-floor-confidence gates
     *  (DEPARE/DRGARE containment). Absent → sub-floor gates form NO
     *  edges (they still render as gates on the overlay). */
    corroborate?: (g: GateNode) => boolean;
}

export interface CompileResult extends ValidateResult {
    rejected: RejectedEdge[];
}

export function compileSeawayGraph(opts: CompileOptions): CompileResult {
    // ── Gates ────────────────────────────────────────────────────────
    const chart = opts.chartFeatures ? extractChartGates(opts.chartFeatures) : { gates: [], channels: new Map() };
    const geometric = opts.unnumberedMarks ? extractGeometricGates(opts.unnumberedMarks, opts) : [];
    const gates = dedupGates([...chart.gates, ...geometric]);
    const gateIds = new Set(gates.map((g) => g.id));

    // ── Channel edges (chart channels carry the corridor geometry) ───
    const edges: SeawayEdge[] = [];
    const lowConfidenceRejects: RejectedEdge[] = [];
    const channels: SeawayGraph['channels'] = [];

    if (opts.chartFeatures) {
        const marks = parseLateralMarks(opts.chartFeatures);
        const grouped = groupChannels(marks);
        let c = 0;
        for (const channelMarks of grouped) {
            const channelKey = `${channelMarks[0].key}#${c++}`;
            const channelGates = gates
                .filter((g) => g.channelKey === channelKey && gateIds.has(g.id))
                .sort((a, b) => a.station - b.station);
            if (channelGates.length === 0) continue;
            channels.push({ key: channelKey, gateIds: channelGates.map((g) => g.id) });
            for (const edge of buildChannelEdges(channelMarks as LateralMark[], channelGates, {
                depthSampler: opts.depthSampler,
            })) {
                const from = channelGates.find((g) => g.id === edge.fromGateId);
                const to = channelGates.find((g) => g.id === edge.toGateId);
                const subFloor =
                    (from && from.confidence < EDGE_CONFIDENCE_FLOOR) || (to && to.confidence < EDGE_CONFIDENCE_FLOOR);
                if (subFloor && !(opts.corroborate && from && to && opts.corroborate(from) && opts.corroborate(to))) {
                    lowConfidenceRejects.push({ edge, reason: 'low-confidence-uncorroborated' });
                    continue;
                }
                edges.push(edge);
            }
        }
    }

    // Geometric-only gates form no channel edges in Phase 10 (no station
    // ordering without a corridor) — they render on the overlay and feed
    // Phase 11's portal/connector synthesis.

    const graph: SeawayGraph = { gates, edges, channels };

    // ── Land validation ──────────────────────────────────────────────
    if (opts.isHardBlocked) {
        const v = validateGraph(graph, opts.isHardBlocked);
        return { graph: v.graph, rejected: [...lowConfidenceRejects, ...v.rejected] };
    }
    return { graph, rejected: lowConfidenceRejects };
}
