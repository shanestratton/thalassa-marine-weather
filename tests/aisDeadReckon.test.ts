import { describe, expect, it } from 'vitest';
import { aisVectorMinutes, buildAisDrFeatures, deadReckonAis, uncertaintyRing } from '../services/ais/aisDeadReckon';

const now = 1_800_000_000_000;
const distanceNm = (a: number[], b: number[]) => {
    const rad = Math.PI / 180;
    const phi = (b[1] - a[1]) * rad;
    const lambda = (b[0] - a[0]) * rad;
    const h = Math.sin(phi / 2) ** 2 + Math.cos(a[1] * rad) * Math.cos(b[1] * rad) * Math.sin(lambda / 2) ** 2;
    return 3440.065 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(Math.max(0, 1 - h)));
};
const feature = (lon: number, cog: number, ageSec = 300): GeoJSON.Feature<GeoJSON.Point> => ({
    type: 'Feature',
    geometry: { type: 'Point', coordinates: [lon, 12] },
    properties: { mmsi: 234567890, sog: 12, cog, updatedAt: now - ageSec * 1000 },
});

describe('AIS display dead reckoning', () => {
    it('uses only the chosen vector lengths and defaults to twelve minutes', () => {
        expect([6, 12, 30, undefined, 5, '30'].map(aisVectorMinutes)).toEqual([6, 12, 30, 12, 12, 12]);
    });
    it('projects at SOG and bounds the uncertainty ring', () => {
        const projected = deadReckonAis(12, 150, 12, 90, 300)!;
        expect(distanceNm([150, 12], [projected.lon, projected.lat])).toBeCloseTo(1, 6);
        expect(projected.uncertaintyNm).toBe(1);
        expect(deadReckonAis(12, 150, 30, 90, 3600)!.uncertaintyNm).toBe(5);
        expect(deadReckonAis(12, 150, 30, 90, 3601)).toBeNull();
    });
    it.each([
        [179.99, 90],
        [-179.99, 270],
    ])('keeps a nondegenerate ring when a ghost crosses longitude %s', (lon, cog) => {
        const report = feature(lon, cog);
        const original = JSON.stringify(report);
        const result = buildAisDrFeatures([report], now);
        expect(JSON.stringify(report)).toBe(original);
        expect(result.features.map((f) => f.properties?.kind)).toEqual(['ghost', 'link', 'ring']);
        const centre = (result.features[0].geometry as GeoJSON.Point).coordinates;
        const link = (result.features[1].geometry as GeoJSON.LineString).coordinates;
        const ring = (result.features[2].geometry as GeoJSON.Polygon).coordinates[0];
        expect(new Set(ring.map((point) => point.join(','))).size).toBeGreaterThan(40);
        expect(ring).toHaveLength(49);
        expect(ring[0]).toEqual(ring[48]);
        for (const point of ring) expect(distanceNm(centre, point)).toBeCloseTo(1, 6);
        for (const line of [link, ring])
            for (let i = 1; i < line.length; i++)
                expect(Math.abs(line[i][0] - line[i - 1][0])).toBeLessThanOrEqual(180);
    });
    it.each([90, -90, 89.9999, -89.9999])('keeps polar ring vertices finite at %s degrees', (lat) => {
        const ring = uncertaintyRing(lat, 180.25, 5);
        expect(ring).toHaveLength(49);
        for (const point of ring) {
            expect(point.every(Number.isFinite)).toBe(true);
            expect(Math.abs(point[1])).toBeLessThanOrEqual(90);
        }
    });
    it('does not invent ghosts for fresh, unknown-motion or stopped targets', () => {
        const fresh = feature(150, 90, 60);
        const stopped = feature(150, 90);
        stopped.properties!.sog = 0;
        const unknown = feature(150, 360);
        expect(buildAisDrFeatures([fresh, stopped, unknown], now).features).toHaveLength(0);
    });
});
