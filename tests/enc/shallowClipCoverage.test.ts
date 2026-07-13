/**
 * Shallow-band-only glaze clip coverage (2026-07-14, "large steps
 * through the shipping channel"): a corridor-only channel cell whose
 * DEPARE bands are ALL deep (>= 10 m) must clip NOTHING — the first
 * cut of the shallow-band filter returned null for that case, which
 * fell through to the whole-data-extent rectangle fallback and blacked
 * out entire cell extents along the NE Channel.
 */
import { describe, expect, it } from 'vitest';
import type { Feature, FeatureCollection, Position } from 'geojson';
import { shallowClipCoverage } from '../../services/enc/EncHazardService';

const square = (x0: number, y0: number, x1: number, y1: number): Position[] => [
    [x0, y0],
    [x1, y0],
    [x1, y1],
    [x0, y1],
    [x0, y0],
];

const band = (drval1: number | undefined, ring: Position[]): Feature => ({
    type: 'Feature',
    properties: drval1 === undefined ? {} : { DRVAL1: drval1 },
    geometry: { type: 'Polygon', coordinates: [ring] },
});

const fc = (...features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });

describe('shallowClipCoverage — deep corridor cells clip nothing', () => {
    it('all-deep cell → EMPTY coverage (NOT null / NOT the extent): the shipping-channel regression', () => {
        const corridorOnly = fc(band(10, square(0, 0, 1, 4)), band(15, square(1, 0, 2, 4)));
        expect(shallowClipCoverage([corridorOnly, undefined])).toEqual([]);
    });

    it('mixed cell → only the shallow bands survive', () => {
        const mixed = fc(band(12, square(0, 0, 2, 2)), band(3, square(2, 0, 4, 2)));
        const cov = shallowClipCoverage([mixed]);
        expect(cov).toHaveLength(1);
        expect(cov[0][0][0]).toEqual([2, 0]); // the 3 m band's ring
    });

    it('missing DRVAL1 → treated shallow (conservative)', () => {
        const unknownDepth = fc(band(undefined, square(0, 0, 1, 1)));
        expect(shallowClipCoverage([unknownDepth])).toHaveLength(1);
    });

    it('exactly at the 10 m threshold → deep (excluded)', () => {
        expect(shallowClipCoverage([fc(band(10, square(0, 0, 1, 1)))])).toEqual([]);
    });

    it('MultiPolygon shallow bands explode into individual polys', () => {
        const multi: Feature = {
            type: 'Feature',
            properties: { DRVAL1: 2 },
            geometry: {
                type: 'MultiPolygon',
                coordinates: [[square(0, 0, 1, 1)], [square(2, 2, 3, 3)]],
            },
        };
        expect(shallowClipCoverage([fc(multi)])).toHaveLength(2);
    });

    it('no collections at all → empty', () => {
        expect(shallowClipCoverage([undefined, undefined])).toEqual([]);
    });

    it('lowercase / string-quoted DRVAL1 (ogr2ogr cells) still classifies correctly', () => {
        // Hard rule 2: converted cells carry lowercase attribute names
        // and may quote numerics. A missed deep-band exclusion re-marks
        // whole corridors shallow and the staircase returns.
        const lowerDeep: Feature = {
            type: 'Feature',
            properties: { drval1: '12' },
            geometry: { type: 'Polygon', coordinates: [square(0, 0, 1, 1)] },
        };
        const stringShallow: Feature = {
            type: 'Feature',
            properties: { DRVAL1: '3' },
            geometry: { type: 'Polygon', coordinates: [square(2, 2, 3, 3)] },
        };
        const cov = shallowClipCoverage([fc(lowerDeep, stringShallow)]);
        expect(cov).toHaveLength(1);
        expect(cov[0][0][0]).toEqual([2, 2]); // only the shallow band survives
    });
});
