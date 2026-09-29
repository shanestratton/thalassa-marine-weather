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

    it.each(['CANAL', 'NTMBAR'] as const)('honours %s navigation-line evidence through conflicting land', (layer) => {
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
    });

    // Phase 1 (inshore router): a lead is evidence of water only where it IS
    // on water. A lead line drawn across charted land (a leading line running
    // on to its marks ashore, or any lead over LNDARE with no chart water under
    // it) used to vouch everything within 125 m of it as water, so a route
    // could ride a lead's land extension straight over the land and pass this
    // audit. Before Phase 1 each of these read 0 m.
    it.each(['NAVLINE', 'RECTRC'] as const)('a %s lead drawn over hard land vouches nothing', (layer) => {
        const layers: InshoreLayers = {
            LNDARE: collection(polygon(0, 0, 0.02, 0.01)),
            [layer]: collection(
                line([
                    [0, 0.005],
                    [0.02, 0.005],
                ]),
            ),
        };

        expect(auditUnvouchedHardLand(layers, crossing).maxRunM).toBeGreaterThan(MAX_UNVOUCHED_HARD_LAND_RUN_M);
    });

    it.each([
        ['clearing line', 1],
        ['transit', 2],
        ['uncategorised chart line', undefined],
    ])('never takes a chart NAVLNE %s as water evidence', (_name, CATNAV) => {
        const layers: InshoreLayers = {
            LNDARE: collection(polygon(0, 0, 0.02, 0.01)),
            NAVLINE: collection({
                ...line([
                    [0, 0.005],
                    [0.02, 0.005],
                ]),
                properties: { acronym: 'NAVLNE', CATNAV },
            }),
        };

        expect(auditUnvouchedHardLand(layers, crossing).maxRunM).toBeGreaterThan(MAX_UNVOUCHED_HARD_LAND_RUN_M);
    });

    it('a charted leading line (NAVLNE CATNAV 3) wholly over land vouches nothing', () => {
        const layers: InshoreLayers = {
            LNDARE: collection(polygon(0, 0, 0.02, 0.01)),
            NAVLINE: collection({
                ...line([
                    [0, 0.005],
                    [0.02, 0.005],
                ]),
                properties: { acronym: 'NAVLNE', CATNAV: 3 },
            }),
        };

        expect(auditUnvouchedHardLand(layers, crossing).maxRunM).toBeGreaterThan(MAX_UNVOUCHED_HARD_LAND_RUN_M);
    });

    describe('a leading line that runs from charted water on to land (Phase 1)', () => {
        // The west half of the lead lies over a charted 3 m band inside the
        // land paint (the chart's own water: the lead's on-water span); the
        // east half runs on over bare LNDARE towards its marks ashore.
        const water = { ...polygon(0, 0.0049, 0.01, 0.0051), properties: { acronym: 'DEPARE', DRVAL1: 3 } };
        const layers = (): InshoreLayers => ({
            LNDARE: collection(polygon(0, 0, 0.02, 0.01)),
            DEPARE: collection(water),
            NAVLINE: collection({
                ...line([
                    [0, 0.005],
                    [0.02, 0.005],
                ]),
                properties: { acronym: 'NAVLNE', CATNAV: 3 },
            }),
        });
        // ~55 m north of the lead, over the land the whole way.
        const beside = (toLon: number): [number, number][] => [
            [-0.005, 0.0055],
            [toLon, 0.0055],
        ];

        it('its on-water span still vouches the 125 m beside it (unchanged)', () => {
            expect(auditUnvouchedHardLand(layers(), beside(0.0095)).maxRunM).toBe(0);
        });

        it('its land extension no longer vouches anything', () => {
            // Before Phase 1: 0 m. Now the run from ~125 m past the end of the
            // water span to the east edge of the land (~990 m) is hard land.
            const result = auditUnvouchedHardLand(layers(), beside(0.025), 20);
            expect(result.maxRunM).toBeGreaterThan(MAX_UNVOUCHED_HARD_LAND_RUN_M);
            expect(result.maxRunM).toBeGreaterThan(900);
            expect(result.maxRunM).toBeLessThan(1_100);
            expect(result.maxRunStart?.[0]).toBeGreaterThan(0.01);
        });
    });

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
