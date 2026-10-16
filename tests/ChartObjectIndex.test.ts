import { describe, expect, it } from 'vitest';
import type { Geometry } from 'geojson';
import type { EncConversionResult } from '../services/enc/types';
import { buildChartObjectIndex, chartObjectPoint, normaliseChartQuery } from '../services/enc/chartObjectIndex';

const point = (properties = {}, coordinates = [151, -27]) => ({
    type: 'Feature' as const,
    properties,
    geometry: { type: 'Point' as const, coordinates },
});
const cell = (layers: EncConversionResult['layers']): EncConversionResult => ({
    cellId: 'US5TEST1',
    sourceHO: 'US',
    edition: 1,
    issued: '2026-10-16',
    bbox: [-180, -90, 180, 90],
    layers,
});
describe('bounded chart object index', () => {
    it('finds punctuation-equivalent light characters, marks, and accented named places from real S-57 attributes', () => {
        const index = buildChartObjectIndex(
            cell({
                LIGHTS: {
                    type: 'FeatureCollection',
                    features: [point({ OBJNAM: 'North light', LITCHR: 2, COLOUR: '4', SIGPER: 3 })],
                },
                BOYLAT: { type: 'FeatureCollection', features: [point()] },
                SEAARE: { type: 'FeatureCollection', features: [point({ objnam: 'Baie de l’Été' }), point()] },
            }),
        );
        expect(index.objects).toHaveLength(3);
        expect(index.objects[0]).toMatchObject({ name: 'North light', kind: 'light', character: 'FlG 3s' });
        expect(index.objects[0].search).toContain(normaliseChartQuery('Fl.G 3.0s'));
        expect(index.objects[1]).toMatchObject({ name: 'Lateral buoy', kind: 'mark' });
        expect(index.objects[2].search).toContain(normaliseChartQuery('baie de l ete'));
        expect(index.limited).toBe(false);
    });
    it('takes a short dateline anchor rather than moving a named area to Greenwich', () => {
        expect(
            chartObjectPoint({
                type: 'Polygon',
                coordinates: [
                    [
                        [179, 1],
                        [-179, 1],
                        [-179, 3],
                        [179, 3],
                        [179, 1],
                    ],
                ],
            }),
        ).toEqual([-180, 2]);
        expect(
            chartObjectPoint({
                type: 'LineString',
                coordinates: [
                    [179, 4],
                    [-179, 6],
                ],
            }),
        ).toEqual([-180, 5]);
    });
    it('rejects malformed/nonfinite and oversized geometry without copying it', () => {
        for (const geometry of [
            null,
            {},
            { type: 'Point', coordinates: [181, 1] },
            { type: 'Point', coordinates: [1, NaN] },
            { type: 'Polygon', coordinates: [null] },
            { type: 'MultiPolygon', coordinates: [null] },
            { type: 'LineString', coordinates: Array.from({ length: 2049 }, () => [1, 1]) },
        ]) {
            expect(chartObjectPoint(geometry as Geometry | null)).toBeNull();
        }
        const feature = point({ OBJNAM: 'A\u0000B' });
        const index = buildChartObjectIndex(cell({ SEAARE: { type: 'FeatureCollection', features: [feature] } }));
        feature.properties = { OBJNAM: 'changed' } as typeof feature.properties;
        feature.geometry.coordinates[0] = 0;
        expect(index.objects[0]).toMatchObject({ name: 'AB', lon: 151 });
        expect(Object.isFrozen(index.objects[0])).toBe(true);
        expect(index.objects[0]).not.toHaveProperty('geometry');
    });
    it('bounds dense cells, name/byte size, and the scan of unnamed geometry, with explicit partial coverage', () => {
        const dense = buildChartObjectIndex(
            cell({ BOYLAT: { type: 'FeatureCollection', features: Array.from({ length: 900 }, () => point()) } }),
        );
        expect(dense.objects.length).toBeLessThanOrEqual(512);
        expect(dense.bytes).toBeLessThanOrEqual(128 * 1024);
        expect(dense.limited).toBe(true);
        const scan = buildChartObjectIndex(
            cell({ SEAARE: { type: 'FeatureCollection', features: Array.from({ length: 50001 }, () => point()) } }),
        );
        expect(scan.objects).toHaveLength(0);
        expect(scan.limited).toBe(true);
        expect(normaliseChartQuery('x'.repeat(1000))).toHaveLength(256);
    });
});
