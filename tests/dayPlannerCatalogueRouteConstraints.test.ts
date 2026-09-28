import { describe, expect, it } from 'vitest';
import {
    assertCatalogueRouteCheckpoints,
    catalogueRouteMustGo,
} from '../services/dayPlanner/catalogueRouteConstraints';
import type { CatalogueRouteConstraint } from '../services/dayPlanner/cataloguePlanningTypes';

const constraint = (points: [number, number][]): CatalogueRouteConstraint => ({
    variant: { id: '00000000-0000-4000-8000-000000000001', version: 1 },
    direction: 'outbound',
    checkpoints: points.map(([lon, lat], index) => ({
        lon,
        lat,
        sequence: index + 1,
        required: true,
        name: `Point ${index}`,
        evidenceNote: 'Synthetic fixture',
    })),
});

describe('mandatory catalogue route checkpoints', () => {
    it('preserves an origin connector and every interior checkpoint, without changing input', () => {
        const source = constraint([
            [0, 0],
            [0.01, 0.01],
            [0.02, 0],
        ]);
        const original = structuredClone(source);
        expect(catalogueRouteMustGo({ lon: -0.01, lat: 0 }, { lon: 0.02, lat: 0 }, source)).toEqual([
            { lon: 0, lat: 0 },
            { lon: 0.01, lat: 0.01 },
        ]);
        expect(source).toEqual(original);
    });

    it('rejects excess required points without thinning and rejects unrepresentable duplicates', () => {
        const source = constraint(Array.from({ length: 11 }, (_, i) => [i * 0.01, 0]));
        expect(() => catalogueRouteMustGo({ lon: 0, lat: 0 }, { lon: 0.1, lat: 0 }, source)).toThrow(/budget/);
        expect(() =>
            catalogueRouteMustGo(
                { lon: 0, lat: 0 },
                { lon: 0.02, lat: 0 },
                constraint([
                    [0, 0],
                    [0.01, 0],
                    [0.01, 0],
                    [0.02, 0],
                ]),
            ),
        ).toThrow(/distinct/);
    });

    it('accepts required collinear points between provider vertices', () => {
        expect(() =>
            assertCatalogueRouteCheckpoints(
                [
                    [0, 0],
                    [0.02, 0],
                ],
                constraint([
                    [0, 0],
                    [0.01, 0],
                    [0.02, 0],
                ]),
            ),
        ).not.toThrow();
    });

    it('rejects shortcut, reversed order and antimeridian geometry', () => {
        const source = constraint([
            [0, 0],
            [0.01, 0.01],
            [0.02, 0],
        ]);
        expect(() =>
            assertCatalogueRouteCheckpoints(
                [
                    [0, 0],
                    [0.02, 0],
                ],
                source,
            ),
        ).toThrow(/every required/);
        expect(() =>
            assertCatalogueRouteCheckpoints(
                [
                    [0.02, 0],
                    [0.01, 0.01],
                    [0, 0],
                ],
                source,
            ),
        ).toThrow(/every required/);
        expect(() =>
            assertCatalogueRouteCheckpoints(
                [
                    [179.9, 0],
                    [-179.9, 0],
                ],
                source,
            ),
        ).toThrow(/unsupported/);
    });

    it('requires every checkpoint to remain mandatory, ordered and within supported latitude', () => {
        for (const change of [{ required: false }, { sequence: 3 }, { lat: 81 }]) {
            const source = constraint([
                [0, 0],
                [0.01, 0],
                [0.02, 0],
            ]);
            Object.assign(source.checkpoints[1], change);
            expect(() =>
                assertCatalogueRouteCheckpoints(
                    [
                        [0, 0],
                        [0.02, 0],
                    ],
                    source,
                ),
            ).toThrow(/invalid/);
        }
    });
});
