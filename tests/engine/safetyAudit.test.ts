import type { Feature, FeatureCollection, LineString, Polygon } from 'geojson';
import { describe, expect, it } from 'vitest';
import { auditUnvouchedHardLand, MAX_UNVOUCHED_HARD_LAND_RUN_M } from '../../services/engine/safetyAudit';
import type { InshoreLayers } from '../../services/engine/types';

function polygon(minLon: number, minLat: number, maxLon: number, maxLat: number): Feature<Polygon> {
    return {
        type: 'Feature',
        properties: {},
        geometry: {
            type: 'Polygon',
            coordinates: [
                [
                    [minLon, minLat],
                    [maxLon, minLat],
                    [maxLon, maxLat],
                    [minLon, maxLat],
                    [minLon, minLat],
                ],
            ],
        },
    };
}

function line(coordinates: [number, number][]): Feature<LineString> {
    return {
        type: 'Feature',
        properties: {},
        geometry: { type: 'LineString', coordinates },
    };
}

function collection(...features: Feature[]): FeatureCollection {
    return { type: 'FeatureCollection', features };
}

const crossing: [number, number][] = [
    [-0.005, 0.005],
    [0.025, 0.005],
];

describe('auditUnvouchedHardLand', () => {
    it('short-circuits without land or a usable polyline', () => {
        expect(auditUnvouchedHardLand({}, crossing)).toEqual({
            maxRunM: 0,
            totalM: 0,
            sampledIntervals: 0,
        });
        expect(auditUnvouchedHardLand({ LNDARE: collection(polygon(0, 0, 1, 1)) }, [[0, 0]])).toEqual({
            maxRunM: 0,
            totalM: 0,
            sampledIntervals: 0,
        });
    });

    it('measures a sustained exact-land crossing and records its endpoints', () => {
        const result = auditUnvouchedHardLand({ LNDARE: collection(polygon(0, 0, 0.02, 0.01)) }, crossing, 20);

        expect(result.maxRunM).toBeGreaterThan(2_100);
        expect(result.maxRunM).toBeGreaterThan(MAX_UNVOUCHED_HARD_LAND_RUN_M);
        expect(result.totalM).toBeCloseTo(result.maxRunM, 6);
        expect(result.sampledIntervals).toBeGreaterThan(100);
        expect(result.maxRunStart?.[0]).toBeGreaterThanOrEqual(0);
        expect(result.maxRunEnd?.[0]).toBeLessThanOrEqual(0.02);
    });

    it('does not call overlapping charted water hard land', () => {
        const land = collection(polygon(0, 0, 0.02, 0.01));
        const result = auditUnvouchedHardLand(
            { LNDARE: land, DEPARE: collection(polygon(0, 0, 0.02, 0.01)) },
            crossing,
        );

        expect(result.maxRunM).toBe(0);
        expect(result.totalM).toBe(0);
        expect(result.sampledIntervals).toBeGreaterThan(0);
    });

    it.each(['CANAL', 'NAVLINE', 'RECTRC', 'NTMBAR'] as const)(
        'honours %s navigation-line evidence through conflicting land',
        (layer) => {
            const layers: InshoreLayers = {
                LNDARE: collection(polygon(0, 0, 0.02, 0.01)),
                [layer]: collection(
                    line([
                        [0, 0.005],
                        [0.02, 0.005],
                    ]),
                ),
            };

            expect(auditUnvouchedHardLand(layers, crossing).maxRunM).toBe(0);
        },
    );

    it('resets the continuous run when a wet corridor separates two land sections', () => {
        const result = auditUnvouchedHardLand(
            {
                LNDARE: collection(polygon(0, 0, 0.02, 0.01)),
                FAIRWY: collection(polygon(0.009, 0, 0.011, 0.01)),
            },
            crossing,
            20,
        );

        expect(result.totalM).toBeGreaterThan(result.maxRunM * 1.8);
        expect(result.maxRunM).toBeLessThan(1_100);
    });
});
