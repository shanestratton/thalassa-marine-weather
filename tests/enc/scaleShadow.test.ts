/**
 * scaleShadow — the Tangalooma tan wall lock.
 *
 * The 30°×30° Coral Sea overview cell (OC-61-051031) charts Moreton Island as
 * a blob bulging ~500 m over the anchorage the 1°×1° detail cell
 * (OC-61-351824) charts correctly. Overview features fully inside the detail
 * bbox must drop; partial features (the mainland) and sibling same-scale
 * cells must be untouched.
 */
import { describe, expect, it } from 'vitest';
import { shadowingCells, featureIsShadowed, type CellExtent } from '../../services/enc/scaleShadow';
import type { Feature } from 'geojson';

const OVERVIEW: CellExtent = { id: 'OC-61-051031', bbox: [150, -30, 180, 0] };
const DETAIL: CellExtent = { id: 'OC-61-351824', bbox: [153, -28, 154, -27] };
const SIBLING: CellExtent = { id: 'OC-61-351825', bbox: [154, -28, 155, -27] };
const ALL = [OVERVIEW, DETAIL, SIBLING];

const poly = (minLon: number, minLat: number, maxLon: number, maxLat: number): Feature => ({
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
});

describe('scaleShadow', () => {
    it('the overview cell is shadowed by detail cells; siblings and detail cells are not', () => {
        expect(
            shadowingCells(OVERVIEW, ALL)
                .map((c) => c.id)
                .sort(),
        ).toEqual(['OC-61-351824', 'OC-61-351825']);
        expect(shadowingCells(DETAIL, ALL)).toEqual([]);
        expect(shadowingCells(SIBLING, ALL)).toEqual([]);
    });

    it('a Moreton-Island-class blob fully inside the detail bbox drops; the mainland (partial) survives', () => {
        const shadows = shadowingCells(OVERVIEW, ALL);
        const moretonBlob = poly(153.35, -27.45, 153.56, -27.02); // fully inside DETAIL
        const mainland = poly(150.5, -29.5, 153.5, -26.5); // spills far outside DETAIL
        expect(featureIsShadowed(moretonBlob, shadows)).toBe(true);
        expect(featureIsShadowed(mainland, shadows)).toBe(false);
    });

    it('no shadows ⇒ nothing drops (fast path)', () => {
        expect(featureIsShadowed(poly(153.4, -27.4, 153.5, -27.1), [])).toBe(false);
    });
});
