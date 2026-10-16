import { describe, expect, it } from 'vitest';
import type { Feature, FeatureCollection, Polygon } from 'geojson';
import {
    applyExclusionField,
    buildExclusionField,
    rasterExclusionField,
    routeExclusionConflict,
} from '../services/engine/exclusionField';
import { aStar, cellCostAt, lineOfSightClear } from '../services/engine/aStar';
import { isNavigable } from '../services/engine/geometry';
import type { NavGrid } from '../services/engine/types';

const rect = (w: number, s: number, e: number, n: number, properties = {}): Feature<Polygon> => ({
    type: 'Feature',
    properties,
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [w, s],
                [e, s],
                [e, n],
                [w, n],
                [w, s],
            ],
        ],
    },
});
const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const grid = (): NavGrid =>
    ({
        width: 10,
        height: 10,
        minLon: 0,
        minLat: 0,
        dLon: 0.001,
        dLat: 0.001,
        cells: new Float32Array(100).fill(10),
        preferred: new Uint8Array(100),
    }) as NavGrid;

describe('139 composite exclusion field', () => {
    it('keeps the cached grid untouched and cannot reopen a masked cell by a later depth carve', () => {
        const base = grid();
        const field = buildExclusionField({ manual: fc(rect(0.004, 0.003, 0.006, 0.007)) });
        const privateGrid = applyExclusionField(base, field);
        expect(base.cells.every((depth) => depth === 10)).toBe(true);
        expect(base.exclusionBlocked).toBeUndefined();
        expect(privateGrid.cells).not.toBe(base.cells);
        expect(privateGrid.preferred).not.toBe(base.preferred);
        privateGrid.cells[55] = 50;
        privateGrid.preferred[55] = 1;
        expect(isNavigable(privateGrid, 5, 5)).toBe(false);
        expect(cellCostAt(privateGrid, 5, 5)).toBe(Infinity);
        expect(aStar(privateGrid, { x: 5, y: 5 }, { x: 9, y: 5 })).toBeNull();
        expect(lineOfSightClear(privateGrid, { x: 0, y: 5 }, { x: 9, y: 5 })).toBe(false);
    });
    it('rerasterizes changed equal-count geometry and does not inherit another request’s masks', () => {
        const base = grid();
        const first = applyExclusionField(base, buildExclusionField({ manual: fc(rect(0.002, 0.002, 0.003, 0.003)) }));
        const second = applyExclusionField(base, buildExclusionField({ manual: fc(rect(0.007, 0.007, 0.008, 0.008)) }));
        expect(first.exclusionBlocked?.[22]).toBe(1);
        expect(second.exclusionBlocked?.[22]).toBe(0);
        expect(second.exclusionBlocked?.[77]).toBe(1);
        expect(applyExclusionField(base, buildExclusionField({})).cells).toEqual(base.cells);
    });
    it('uses the same park cost for search and smoothing while preserving navigability', () => {
        const base = grid();
        const parks = applyExclusionField(
            base,
            buildExclusionField({ marineParks: fc(rect(0.004, 0.003, 0.006, 0.007)) }),
        );
        expect(isNavigable(parks, 5, 5)).toBe(true);
        expect(cellCostAt(parks, 5, 5)).toBeCloseTo(cellCostAt(base, 5, 5) * 1.25);
        expect(lineOfSightClear(parks, { x: 0, y: 5 }, { x: 9, y: 5 })).toBe(false);
        expect(aStar(parks, { x: 0, y: 5 }, { x: 9, y: 5 })).not.toBeNull();
    });
    it.each([7, '07', [3, 7]])('uses original entry-prohibited code %s', (RESTRN) => {
        const f = buildExclusionField({ RESARE: fc(rect(0.004, 0.003, 0.006, 0.007, { RESTRN })) });
        expect(
            routeExclusionConflict(
                [
                    [0, 0.005],
                    [0.01, 0.005],
                ],
                f,
            ),
        ).toBe('entry-prohibited');
    });
    it('does not turn no-anchoring or unrelated restrictions into prohibited transit', () => {
        const f = buildExclusionField({ RESARE: fc(rect(0.004, 0.003, 0.006, 0.007, { RESTRN: '1,3,13,14' })) });
        expect(f.areas).toEqual([]);
    });
    it('keeps entry-restricted and separation zones hard, but park transit advisory', () => {
        const route = [
            [0, 0.005],
            [0.01, 0.005],
        ] as const;
        expect(
            routeExclusionConflict(
                route,
                buildExclusionField({ RESARE: fc(rect(0.004, 0.003, 0.006, 0.007, { RESTRN: 8 })) }),
            ),
        ).toBe('entry-restricted');
        expect(
            routeExclusionConflict(route, buildExclusionField({ TSEZNE: fc(rect(0.004, 0.003, 0.006, 0.007)) })),
        ).toBe('traffic-separation');
        const parks = buildExclusionField({ marineParks: fc(rect(0.004, 0.003, 0.006, 0.007)) });
        expect(routeExclusionConflict(route, parks)).toBeNull();
        const masks = rasterExclusionField(grid(), parks)!;
        expect(masks.blocked.some(Boolean)).toBe(false);
        expect(masks.caution.some(Boolean)).toBe(true);
    });
    it('finds a thin no-go polygon crossed between widely separated route vertices', () => {
        const f = buildExclusionField({ manual: fc(rect(0.00499, 0.001, 0.00501, 0.009)) });
        expect(
            routeExclusionConflict(
                [
                    [0.001, 0.005],
                    [0.009, 0.005],
                ],
                f,
            ),
        ).toBe('manual-no-go');
    });
    it('retains holes and exact edge touches in the final whole-line audit', () => {
        const area = rect(0.001, 0.001, 0.009, 0.009);
        area.geometry.coordinates.push(rect(0.003, 0.003, 0.007, 0.007).geometry.coordinates[0]);
        const f = buildExclusionField({ manual: fc(area) });
        expect(
            routeExclusionConflict(
                [
                    [0.004, 0.005],
                    [0.006, 0.005],
                ],
                f,
            ),
        ).toBeNull();
        expect(
            routeExclusionConflict(
                [
                    [0.003, 0.004],
                    [0.003, 0.006],
                ],
                f,
            ),
        ).toBe('manual-no-go');
        expect(rasterExclusionField(grid(), f)!.blocked[55]).toBe(0);
    });
    it('marks a tiny interior island even when no grid-cell centre is inside it', () => {
        const g = grid(),
            original = g.cells.slice();
        const f = buildExclusionField({ manual: fc(rect(0.0041, 0.0031, 0.0042, 0.0032)) });
        const masks = rasterExclusionField(g, f)!;
        expect(masks.blocked[34]).toBe(1);
        expect(g.cells).toEqual(original);
        expect(g.preferred.some(Boolean)).toBe(false);
    });
    it('marks both sides of grid-aligned boundaries, including the upper window edge', () => {
        const f = buildExclusionField({ manual: fc(rect(0.005, 0.003, 0.006, 0.005)) });
        const mask = rasterExclusionField(grid(), f)!.blocked;
        expect(mask[44]).toBe(1);
        expect(mask[45]).toBe(1);
        expect(mask[54]).toBe(1);
        expect(mask[55]).toBe(1);
        const edge = rasterExclusionField(
            grid(),
            buildExclusionField({ manual: fc(rect(0.002, 0.01, 0.004, 0.011)) }),
        )!.blocked;
        expect(edge[92]).toBe(1);
        expect(edge[93]).toBe(1);
    });
    it('copies source geometry independently and ignores chart mark names/identifiers', () => {
        const area = rect(0.004, 0.003, 0.006, 0.007, { RESTRN: 7, _cellId: 'PRIVATE_CELL', OBJNAM: 'PRIVATE_MARK' });
        const f = buildExclusionField({ RESARE: fc(area) });
        area.geometry.coordinates[0][0][0] = 1;
        expect(
            routeExclusionConflict(
                [
                    [0, 0.005],
                    [0.01, 0.005],
                ],
                f,
            ),
        ).toBe('entry-prohibited');
        expect(JSON.stringify(f)).not.toMatch(/PRIVATE_CELL|PRIVATE_MARK/);
    });
    it.each(['unclosed', 'crossed', 'point', 'dateline'] as const)(
        'refuses %s known hard geometry instead of dropping it',
        (mode) => {
            const area = rect(0.004, 0.003, 0.006, 0.007);
            if (mode === 'unclosed') area.geometry.coordinates[0].pop();
            if (mode === 'crossed')
                area.geometry.coordinates[0] = [
                    [0, 0],
                    [1, 1],
                    [1, 0],
                    [0, 1],
                    [0, 0],
                ];
            if (mode === 'dateline')
                area.geometry.coordinates[0] = [
                    [179, 0],
                    [-179, 0],
                    [-179, 1],
                    [179, 1],
                    [179, 0],
                ];
            const source =
                mode === 'point'
                    ? fc({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [0, 0] } })
                    : fc(area);
            expect(() => buildExclusionField({ manual: source })).toThrow();
        },
    );
    it('does not allocate a grid mask without active exclusions', () => {
        expect(rasterExclusionField(grid(), buildExclusionField({}))).toBeNull();
    });
    it('retires a cancelled mask before it can be adopted', () => {
        const f = buildExclusionField({ manual: fc(rect(0, 0, 0.01, 0.01)) });
        expect(() =>
            rasterExclusionField(grid(), f, () => {
                throw new DOMException('stale', 'AbortError');
            }),
        ).toThrow('stale');
    });
    it('rejects oversized grids and malformed final route geometry', () => {
        const f = buildExclusionField({ manual: fc(rect(0.004, 0.003, 0.006, 0.007)) });
        expect(() => rasterExclusionField({ ...grid(), width: 3000000 }, f)).toThrow();
        expect(() =>
            routeExclusionConflict(
                [
                    [0, NaN],
                    [1, 1],
                ],
                f,
            ),
        ).toThrow();
        expect(() =>
            routeExclusionConflict(
                [
                    [179, 0],
                    [-179, 0],
                ],
                f,
            ),
        ).toThrow();
    });
});
