import { describe, expect, it } from 'vitest';
import { spliceCanalEgressChannel, type NavGrid } from '../services/inshoreRouterEngine';

const M_PER_LAT = 110_540;
const mPerLon = (lat: number): number => 111_320 * Math.cos((lat * Math.PI) / 180);

function gridFor(points: Array<{ lat: number; lon: number }>): NavGrid {
    const minLat = Math.min(...points.map((p) => p.lat)) - 0.01;
    const maxLat = Math.max(...points.map((p) => p.lat)) + 0.01;
    const minLon = Math.min(...points.map((p) => p.lon)) - 0.01;
    const maxLon = Math.max(...points.map((p) => p.lon)) + 0.01;
    const midLat = (minLat + maxLat) / 2;
    const dLat = 50 / M_PER_LAT;
    const dLon = 50 / mPerLon(midLat);
    const width = Math.ceil((maxLon - minLon) / dLon);
    const height = Math.ceil((maxLat - minLat) / dLat);
    return {
        width,
        height,
        minLat,
        minLon,
        dLat,
        dLon,
        cells: new Float32Array(width * height).fill(10),
        preferred: new Uint8Array(width * height),
    };
}

describe('canal egress splice', () => {
    it('still splices the tier contract when the existing route already passes near the gate centres', () => {
        const origin = { lat: -27.214, lon: 153.0852 }; // marina tap, about 250 m off the canal line
        const canalStart = { lat: -27.214, lon: 153.0877 };
        const innerGate = { lat: -27.2032, lon: 153.093 };
        const outerGate = { lat: -27.1967, lon: 153.0934 };
        const dest = { lat: -27.185, lon: 153.096 };
        const canalLines = [
            [[canalStart.lon, canalStart.lat] as [number, number], [innerGate.lon, innerGate.lat] as [number, number]],
        ];
        const egressTracks = [{ pts: [innerGate, outerGate], tier2FromIndex: 1 }];
        const polyline: [number, number][] = [
            [origin.lon, origin.lat],
            [innerGate.lon, innerGate.lat],
            [outerGate.lon, outerGate.lat],
            [dest.lon, dest.lat],
        ];

        const result = spliceCanalEgressChannel(
            polyline,
            egressTracks,
            canalLines,
            gridFor([origin, innerGate, outerGate, dest]),
        );

        expect(result.spliced).toBe(true);
        expect(result.gates).toBe(2);
        expect(
            result.polyline.some(
                ([lon, lat]) => Math.abs(lon - innerGate.lon) < 1e-8 && Math.abs(lat - innerGate.lat) < 1e-8,
            ),
        ).toBe(true);
        expect(result.forceTier2?.some(Boolean)).toBe(true);
    });
});
