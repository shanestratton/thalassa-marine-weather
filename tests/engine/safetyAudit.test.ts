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

    // Phase 2a review (2026-09-30): the audit's water test is the grid's
    // (services/engine/chartWaterEvidence.ts). It used to vouch ANY DEPARE,
    // DRGARE or FAIRWY overlap — drying, coarser, unranked, a bare
    // bathymetry-derived band, a route area — so it could never catch the
    // land the grid's old Pass 4 rescue reopened under a chart fairway or
    // dredged area.
    describe('water evidence under land paint follows the grid (owner decision 1)', () => {
        const land = (props: Record<string, unknown> = {}) => ({ ...polygon(0, 0, 0.02, 0.01), properties: props });
        const band = (props: Record<string, unknown>) => ({ ...polygon(0, 0, 0.02, 0.01), properties: props });
        const COARSE = 100;
        const FINE = 200;

        it.each([
            [
                'OSM-vouched water (natural=water)',
                { LNDARE: collection(land()), DEPARE: collection(band({ natural: 'water', DRVAL1: 10 })) },
            ],
            [
                'an OSM marina basin',
                { LNDARE: collection(land()), DEPARE: collection(band({ leisure: 'marina', DRVAL1: 5 })) },
            ],
            [
                'a finer never-drying S-57 DEPARE',
                {
                    LNDARE: collection(land({ _scaleRank: COARSE })),
                    DEPARE: collection(band({ acronym: 'DEPARE', DRVAL1: 1, _scaleRank: FINE })),
                },
            ],
            [
                'a finer never-drying S-57 DRGARE',
                {
                    LNDARE: collection(land({ _scaleRank: COARSE })),
                    DRGARE: collection(band({ acronym: 'DRGARE', DRVAL1: 3, _scaleRank: FINE })),
                },
            ],
        ] as [string, InshoreLayers][])('%s vouches the land it overlaps', (_name, layers) => {
            const result = auditUnvouchedHardLand(layers, crossing);
            expect(result.maxRunM).toBe(0);
            expect(result.totalM).toBe(0);
            expect(result.sampledIntervals).toBeGreaterThan(0);
        });

        it.each([
            [
                'an equal-rank DRGARE',
                {
                    LNDARE: collection(land({ _scaleRank: FINE })),
                    DRGARE: collection(band({ acronym: 'DRGARE', DRVAL1: 3, _scaleRank: FINE })),
                },
            ],
            [
                'a coarser DEPARE',
                {
                    LNDARE: collection(land({ _scaleRank: FINE })),
                    DEPARE: collection(band({ acronym: 'DEPARE', DRVAL1: 5, _scaleRank: COARSE })),
                },
            ],
            [
                'a finer DRYING band',
                {
                    LNDARE: collection(land({ _scaleRank: COARSE })),
                    DEPARE: collection(band({ acronym: 'DEPARE', DRVAL1: -1, _scaleRank: FINE })),
                },
            ],
            [
                'an unranked S-57 band',
                {
                    LNDARE: collection(land({ _scaleRank: COARSE })),
                    DEPARE: collection(band({ acronym: 'DEPARE', DRVAL1: 5 })),
                },
            ],
            [
                'unranked land paint',
                {
                    LNDARE: collection(land()),
                    DEPARE: collection(band({ acronym: 'DEPARE', DRVAL1: 5, _scaleRank: FINE })),
                },
            ],
            [
                'a bare (bathymetry-derived, untagged) DEPARE',
                { LNDARE: collection(land()), DEPARE: collection(band({ DRVAL1: 10 })) },
            ],
            [
                'a chart FAIRWY (a route area, not a depth)',
                { LNDARE: collection(land()), FAIRWY: collection(band({ acronym: 'FAIRWY' })) },
            ],
            [
                'a synthetic mark ribbon',
                { LNDARE: collection(land()), FAIRWY: collection(band({ _class: 'synthetic-channel-segment' })) },
            ],
        ] as [string, InshoreLayers][])('%s does not vouch the land it overlaps', (_name, layers) => {
            expect(auditUnvouchedHardLand(layers, crossing).maxRunM).toBeGreaterThan(MAX_UNVOUCHED_HARD_LAND_RUN_M);
        });

        it('the FINEST land paint is the one a band must beat', () => {
            const layers: InshoreLayers = {
                LNDARE: collection(land({ _scaleRank: COARSE }), land({ _scaleRank: 250 })),
                DEPARE: collection(band({ acronym: 'DEPARE', DRVAL1: 5, _scaleRank: FINE })),
            };
            expect(auditUnvouchedHardLand(layers, crossing).maxRunM).toBeGreaterThan(MAX_UNVOUCHED_HARD_LAND_RUN_M);
        });
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
        // Owner decision 1 (2026-09-30): the band beats the land paint only
        // when charted at a FINER scale, so the fixture carries the ranks the
        // router's merge stamps (land: a coarse cell's; band: a finer one's).
        const water = {
            ...polygon(0, 0.0049, 0.01, 0.0051),
            properties: { acronym: 'DEPARE', DRVAL1: 3, _scaleRank: 200 },
        };
        const layers = (): InshoreLayers => ({
            LNDARE: collection({ ...polygon(0, 0, 0.02, 0.01), properties: { _scaleRank: 100 } }),
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

        it('with no ranks the band cannot beat the land paint (decision 1 fails safe): nothing is vouched', () => {
            const bare = layers();
            const unranked: InshoreLayers = {
                ...bare,
                LNDARE: collection(polygon(0, 0, 0.02, 0.01)),
                DEPARE: collection({ ...water, properties: { acronym: 'DEPARE', DRVAL1: 3 } }),
            };
            // Neither the band nor the lead over it vouches anything: the
            // band cannot beat unranked land paint, so the lead is on land
            // and the 55 m strip beside it is not vouched.
            expect(auditUnvouchedHardLand(unranked, beside(0.0095)).maxRunM).toBeGreaterThan(
                MAX_UNVOUCHED_HARD_LAND_RUN_M,
            );
        });
    });

    it('resets the continuous run when a wet corridor separates two land sections', () => {
        const result = auditUnvouchedHardLand(
            {
                LNDARE: collection(polygon(0, 0, 0.02, 0.01)),
                DEPARE: collection({ ...polygon(0.009, 0, 0.011, 0.01), properties: { waterway: 'canal' } }),
            },
            crossing,
            20,
        );

        expect(result.totalM).toBeGreaterThan(result.maxRunM * 1.8);
        expect(result.maxRunM).toBeLessThan(1_100);
    });
});
