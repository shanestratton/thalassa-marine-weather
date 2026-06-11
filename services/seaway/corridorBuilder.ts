/**
 * corridorBuilder — channel edges from the corridor centreline (Phase 10).
 *
 * Wraps fairlead's seq-interpolated corridorCenterline and slices it at
 * gate stations: each channel edge connects CONSECUTIVE gates, its
 * polyline = the centreline span between them with the endpoints set to
 * the gate midpoints. GEOMETRY IS THE LAW (§4): the router never
 * re-smooths edge interiors, so what's compiled here is what's sailed.
 */

import { corridorCenterline, type LateralMark } from '../fairlead';
import { gateDistM } from './gateExtractor';
import { metres, type DepthSource, type GateNode, type SeawayEdge, type SeawayLatLon } from './types';

/** Optional charted-depth sampler: min DRVAL1 at a point, or null where
 *  no DEPARE covers it. Provided by the compiler caller when chart data
 *  is on hand; absent → edges are 'marks-vouched'. */
export type DepthSampler = (p: SeawayLatLon) => number | null;

function nearestIndex(line: SeawayLatLon[], p: SeawayLatLon): number {
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < line.length; i++) {
        const d = gateDistM(line[i], p);
        if (d < bestD) {
            bestD = d;
            best = i;
        }
    }
    return best;
}

function polylineLengthM(line: SeawayLatLon[]): number {
    let len = 0;
    for (let i = 0; i < line.length - 1; i++) len += gateDistM(line[i], line[i + 1]);
    return len;
}

/** Sample min depth along a polyline every ~stepM via the sampler. */
function controllingDepth(line: SeawayLatLon[], sample: DepthSampler, stepM = 25): number | null {
    let min: number | null = null;
    for (let i = 0; i < line.length - 1; i++) {
        const a = line[i];
        const b = line[i + 1];
        const n = Math.max(1, Math.ceil(gateDistM(a, b) / stepM));
        for (let k = 0; k <= n; k++) {
            const t = k / n;
            const d = sample({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t });
            if (d !== null && (min === null || d < min)) min = d;
        }
    }
    return min;
}

/**
 * Build the channel edges for one channel: gates must already be in
 * station order. Returns one edge per consecutive gate pair.
 */
export function buildChannelEdges(
    channelMarks: LateralMark[],
    gates: GateNode[],
    opts: { depthSampler?: DepthSampler } = {},
): SeawayEdge[] {
    if (gates.length < 2) return [];
    const centre = corridorCenterline(channelMarks);
    const edges: SeawayEdge[] = [];

    for (let i = 0; i < gates.length - 1; i++) {
        const from = gates[i];
        const to = gates[i + 1];
        let polyline: SeawayLatLon[];
        if (centre.length >= 2) {
            const a = nearestIndex(centre, from.mid);
            const b = nearestIndex(centre, to.mid);
            const span = a <= b ? centre.slice(a, b + 1) : centre.slice(b, a + 1).reverse();
            // The edge passes THROUGH the gate midpoints (§4).
            polyline = [from.mid, ...span.slice(1, -1), to.mid];
        } else {
            polyline = [from.mid, to.mid];
        }

        let controllingDepthM: number | null = null;
        let depthSource: DepthSource = 'marks-vouched';
        if (opts.depthSampler) {
            controllingDepthM = controllingDepth(polyline, opts.depthSampler);
            if (controllingDepthM !== null) depthSource = 'charted';
        }

        edges.push({
            id: `${from.id}→${to.id}`,
            kind: 'channel',
            fromGateId: from.id,
            toGateId: to.id,
            polyline,
            lengthM: metres(polylineLengthM(polyline)),
            controllingDepthM: controllingDepthM === null ? undefined : metres(controllingDepthM),
            depthSource,
        });
    }
    return edges;
}
