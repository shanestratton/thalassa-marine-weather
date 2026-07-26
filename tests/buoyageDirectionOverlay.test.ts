import { describe, expect, it } from 'vitest';

import { buoyageDirectionGeoJSON } from '../services/seaway/buoyageDirectionOverlay';
import { CHART_CONFIDENCE, REGIONAL_CONFIDENCE } from '../services/seaway/gateExtractor';
import type { GateNode, SeawayGraph } from '../services/seaway/types';

const chartGate = (id: string, station: number, lon: number, bearingDeg = 180): GateNode => ({
    id,
    channelKey: 'main#0',
    station,
    mid: { lat: -27 - station / 1000, lon },
    buoyageBearingDeg: bearingDeg,
    confidence: CHART_CONFIDENCE,
    portMark: { lat: -27, lon: lon - 0.0002, side: 'port', source: 'chart' },
    stbdMark: { lat: -27, lon: lon + 0.0002, side: 'stbd', source: 'chart' },
});

describe('buoyageDirectionOverlay', () => {
    it('renders a small, evenly spaced set of trusted chart-direction arrows at gate midpoints', () => {
        const gates = Array.from({ length: 10 }, (_, index) =>
            chartGate(`g${index + 1}`, index + 1, 153 + index / 100),
        );
        const graph: SeawayGraph = {
            gates,
            edges: [],
            channels: [{ key: 'main#0', gateIds: gates.map((gate) => gate.id) }],
        };

        const data = buoyageDirectionGeoJSON(graph);

        expect(data.features).toHaveLength(3); // never a picket fence through a harbour
        expect(data.features.map((feature) => feature.properties.bearingDeg)).toEqual([180, 180, 180]);
        expect(data.features.every((feature) => feature.properties.channelKey === 'main#0')).toBe(true);
        expect(data.features.map((feature) => feature.geometry.coordinates[1])).toEqual([-27.002, -27.006, -27.009]);
    });

    it('never invents a direction from one gate, a regional pair, or an invalid bearing', () => {
        const regional = {
            ...chartGate('regional', 1, 153.1),
            channelKey: 'regional#0',
            confidence: REGIONAL_CONFIDENCE,
            portMark: { lat: -27, lon: 153.0998, side: 'port' as const, source: 'regional' as const },
            stbdMark: { lat: -27, lon: 153.1002, side: 'stbd' as const, source: 'regional' as const },
        };
        const invalidBearing = chartGate('bad-bearing', 2, 153.2, Number.NaN);
        const graph: SeawayGraph = {
            gates: [chartGate('solo', 1, 153), regional, invalidBearing],
            edges: [],
            channels: [
                { key: 'main#0', gateIds: ['solo'] },
                { key: 'regional#0', gateIds: ['regional'] },
                { key: 'main#0', gateIds: ['solo', 'bad-bearing'] },
            ],
        };

        expect(buoyageDirectionGeoJSON(graph).features).toEqual([]);
    });

    it('normalises a valid negative bearing to the map rotation range', () => {
        const a = chartGate('a', 1, 153, -45);
        const b = chartGate('b', 2, 153.01, -45);
        const graph: SeawayGraph = {
            gates: [a, b],
            edges: [],
            channels: [{ key: 'main#0', gateIds: ['a', 'b'] }],
        };

        expect(buoyageDirectionGeoJSON(graph).features[0]?.properties.bearingDeg).toBe(315);
    });
});
