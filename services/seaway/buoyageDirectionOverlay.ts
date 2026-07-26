/**
 * buoyageDirectionOverlay — restrained, chart-backed direction-of-buoyage
 * cues for the planning chart.
 *
 * A direction arrow is only useful when it is trustworthy. These features
 * therefore come exclusively from numbered chart laterals that the Seaway
 * compiler paired by sequence adjacency (0.95 confidence). Regional and
 * geometric pairs deliberately stay out: an attractive arrow pointing the
 * wrong way is worse than no arrow at all.
 */

import { CHART_CONFIDENCE } from './gateExtractor';
import type { GateNode, SeawayGraph } from './types';

export interface BuoyageDirectionFeature {
    type: 'Feature';
    properties: {
        channelKey: string;
        bearingDeg: number;
    };
    geometry: {
        type: 'Point';
        coordinates: [number, number];
    };
}

export interface BuoyageDirectionGeoJSON {
    type: 'FeatureCollection';
    features: BuoyageDirectionFeature[];
}

const EMPTY: BuoyageDirectionGeoJSON = { type: 'FeatureCollection', features: [] };

/** Keep the planning chart readable in a dense harbour. */
const MAX_ARROWS_PER_CHANNEL = 3;

function isChartDirectionGate(gate: GateNode): boolean {
    // `CHART_CONFIDENCE` is a literal today, but retain a tiny tolerance in
    // case a persisted graph crosses a JSON round-trip before this overlay
    // sees it.
    if (gate.confidence < CHART_CONFIDENCE - 1e-6 || !Number.isFinite(gate.buoyageBearingDeg)) return false;
    if (!Number.isFinite(gate.mid.lat) || !Number.isFinite(gate.mid.lon)) return false;
    return gate.portMark?.source === 'chart' || gate.stbdMark?.source === 'chart';
}

/**
 * Pick a small, evenly spaced subset of a channel's gates. The arrow lands
 * at a charted gate midpoint — near its physical marks rather than floating
 * in arbitrary open water — and points in the compiled seaward→landward
 * direction of buoyage.
 */
function sampledGateIndexes(length: number): number[] {
    if (length < 2) return [];

    const count = Math.min(MAX_ARROWS_PER_CHANNEL, Math.max(1, Math.ceil(length / 4)));
    const indexes = new Set<number>();
    for (let i = 0; i < count; i++) {
        indexes.add(Math.min(length - 1, Math.max(0, Math.floor(((i + 0.5) * length) / count))));
    }
    return [...indexes].sort((a, b) => a - b);
}

export function buoyageDirectionGeoJSON(graph: SeawayGraph | null | undefined): BuoyageDirectionGeoJSON {
    if (!graph) return EMPTY;

    const gatesById = new Map(graph.gates.map((gate) => [gate.id, gate]));
    const features: BuoyageDirectionFeature[] = [];

    for (const channel of graph.channels) {
        const gates = channel.gateIds
            .map((id) => gatesById.get(id))
            .filter((gate): gate is GateNode => !!gate && isChartDirectionGate(gate))
            .sort((a, b) => a.station - b.station);

        // One mark cannot establish a direction, even when the mark itself
        // is charted. Require a sequence of at least two trusted gates.
        if (gates.length < 2) continue;

        for (const index of sampledGateIndexes(gates.length)) {
            const gate = gates[index];
            const bearingDeg = ((gate.buoyageBearingDeg % 360) + 360) % 360;
            features.push({
                type: 'Feature',
                properties: { channelKey: channel.key, bearingDeg },
                geometry: { type: 'Point', coordinates: [gate.mid.lon, gate.mid.lat] },
            });
        }
    }

    return { type: 'FeatureCollection', features };
}
