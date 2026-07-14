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
import { shadowingCells, featureIsShadowed, GLAZE_SHADOW_RATIO, type CellExtent } from '../../services/enc/scaleShadow';
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

/**
 * GLAZE_SHADOW_RATIO — the safety-optics gap (adversarial review
 * 2026-07-14): an approach cell only 4x the harbour cell's bbox area is
 * invisible to the 16x base ratio, so its glaze shipped UNCLIPPED and
 * its SAFE-white painted over water the harbour survey charts as
 * under-keel. The glaze clip runs at its own, much lower ratio; the
 * destructive base-feature drop stays at 16x.
 */
describe('GLAZE_SHADOW_RATIO — adjacent-band pairs clip the glaze, siblings never', () => {
    // Approach cell 1°×1° (area 1); harbour cell 0.5°×0.5° (area 0.25)
    // overlapping its SW quarter — a typical adjacent-usage-band pair.
    const APPROACH: CellExtent = { id: 'approach', bbox: [153, -28, 154, -27] };
    const HARBOUR: CellExtent = { id: 'harbour', bbox: [153.1, -27.9, 153.6, -27.4] };

    it('a 4x-finer overlapping cell shadows the GLAZE but not the base drop', () => {
        expect(shadowingCells(APPROACH, [APPROACH, HARBOUR]).map((c) => c.id)).toEqual([]);
        expect(shadowingCells(APPROACH, [APPROACH, HARBOUR], GLAZE_SHADOW_RATIO).map((c) => c.id)).toEqual(['harbour']);
    });

    it('same-band grid siblings (equal bbox area) never shadow each other, so no mutual clip', () => {
        expect(shadowingCells(DETAIL, ALL, GLAZE_SHADOW_RATIO)).toEqual([]);
        expect(shadowingCells(SIBLING, ALL, GLAZE_SHADOW_RATIO)).toEqual([]);
    });

    it('shadowing is one-directional for ANY pair at the glaze ratio (needs ratio² ≤ 1 to invert)', () => {
        const aShadowedByB = shadowingCells(APPROACH, [APPROACH, HARBOUR], GLAZE_SHADOW_RATIO).length > 0;
        const bShadowedByA = shadowingCells(HARBOUR, [APPROACH, HARBOUR], GLAZE_SHADOW_RATIO).length > 0;
        expect(aShadowedByB && bShadowedByA).toBe(false);
    });

    it('a 1.5x pair stays inside the sibling guard — near-equal extents do not nibble each other', () => {
        const big: CellExtent = { id: 'big', bbox: [0, 0, 1.5, 1] }; // area 1.5
        const small: CellExtent = { id: 'small', bbox: [0.2, 0, 1.2, 1] }; // area 1
        expect(shadowingCells(big, [big, small], GLAZE_SHADOW_RATIO)).toEqual([]);
        expect(shadowingCells(small, [big, small], GLAZE_SHADOW_RATIO)).toEqual([]);
    });
});
