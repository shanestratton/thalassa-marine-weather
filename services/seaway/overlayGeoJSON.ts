/**
 * overlayGeoJSON — SeawayGraph → map-ready GeoJSON (Phase 10 debug overlay).
 *
 * Pure converter, render-agnostic: gates become Point features (side,
 * width, confidence, half-gate flag in properties — style by these),
 * channel edges become LineStrings, rejected edges become LineStrings
 * with the rejection reason so a missing edge is a VISIBLE fact on the
 * debug map, never a silent drop.
 */

import type { GateNode, RejectedEdge, SeawayGraph } from './types';

interface FeatureLike {
    type: 'Feature';
    properties: Record<string, unknown>;
    geometry:
        | { type: 'Point'; coordinates: [number, number] }
        | { type: 'LineString'; coordinates: [number, number][] };
}

export interface SeawayOverlayGeoJSON {
    /** Gate midpoints + their marks. Style: kind=mid|port|stbd. */
    gates: { type: 'FeatureCollection'; features: FeatureLike[] };
    /** Accepted channel edges. */
    edges: { type: 'FeatureCollection'; features: FeatureLike[] };
    /** Rejected edges with `reason` — render dashed/red. */
    rejected: { type: 'FeatureCollection'; features: FeatureLike[] };
}

const gateFeatures = (g: GateNode): FeatureLike[] => {
    const out: FeatureLike[] = [
        {
            type: 'Feature',
            properties: {
                kind: 'mid',
                gateId: g.id,
                channelKey: g.channelKey,
                station: g.station,
                halfGate: !g.portMark || !g.stbdMark,
                gateWidthM: g.gateWidthM ?? null,
                buoyageBearingDeg: Math.round(g.buoyageBearingDeg),
                confidence: g.confidence,
            },
            geometry: { type: 'Point', coordinates: [g.mid.lon, g.mid.lat] },
        },
    ];
    for (const [kind, m] of [
        ['port', g.portMark],
        ['stbd', g.stbdMark],
    ] as const) {
        if (!m) continue;
        out.push({
            type: 'Feature',
            properties: { kind, gateId: g.id, source: m.source, name: m.name ?? null },
            geometry: { type: 'Point', coordinates: [m.lon, m.lat] },
        });
    }
    return out;
};

export function seawayOverlayGeoJSON(graph: SeawayGraph, rejected: RejectedEdge[] = []): SeawayOverlayGeoJSON {
    return {
        gates: {
            type: 'FeatureCollection',
            features: graph.gates.flatMap(gateFeatures),
        },
        edges: {
            type: 'FeatureCollection',
            features: graph.edges.map((e) => ({
                type: 'Feature',
                properties: {
                    edgeId: e.id,
                    kind: e.kind,
                    lengthM: Math.round(e.lengthM),
                    depthSource: e.depthSource,
                    controllingDepthM: e.controllingDepthM ?? null,
                },
                geometry: { type: 'LineString', coordinates: e.polyline.map((p) => [p.lon, p.lat]) },
            })),
        },
        rejected: {
            type: 'FeatureCollection',
            features: rejected.map((r) => ({
                type: 'Feature',
                properties: { edgeId: r.edge.id, reason: r.reason },
                geometry: { type: 'LineString', coordinates: r.edge.polyline.map((p) => [p.lon, p.lat]) },
            })),
        },
    };
}
