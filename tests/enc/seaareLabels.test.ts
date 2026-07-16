/**
 * seaareLabels — the named-area → label-point reduction lifted out of the
 * buildMergedVectorData fold. Locks in the label-anchor geometry and the
 * SCAMIN-relaxing name ladder.
 */
import { describe, it, expect } from 'vitest';
import type { Feature, FeatureCollection } from 'geojson';

import { labelAnchorFor, reduceNamedAreas } from '../../services/enc/seaareLabels';

const fc = (features: Feature[]): FeatureCollection => ({ type: 'FeatureCollection', features });
const namedPoly = (name: string, ring: number[][], props: Record<string, unknown> = {}): Feature => ({
    type: 'Feature',
    geometry: { type: 'Polygon', coordinates: [ring] },
    properties: { OBJNAM: name, ...props },
});

describe('labelAnchorFor', () => {
    it('returns a Point coordinate verbatim', () => {
        expect(labelAnchorFor({ type: 'Point', coordinates: [153.1, -27.4] })).toEqual([153.1, -27.4]);
    });
    it('returns the outer-ring vertex average of a polygon', () => {
        // unit square [0,0]..[2,2] closed → mean of the 4 distinct corners = (1,1)
        const sq = [
            [0, 0],
            [2, 0],
            [2, 2],
            [0, 2],
            [0, 0],
        ];
        expect(labelAnchorFor({ type: 'Polygon', coordinates: [sq] })).toEqual([1, 1]);
    });
    it('picks the LARGEST polygon of a MultiPolygon', () => {
        const small = [
            [0, 0],
            [1, 0],
            [0, 1],
            [0, 0],
        ];
        const big = [
            [10, 10],
            [12, 10],
            [12, 12],
            [10, 12],
            [10, 10],
        ];
        const a = labelAnchorFor({ type: 'MultiPolygon', coordinates: [[small], [big]] });
        expect(a![0]).toBeGreaterThan(9); // anchored on the big one
    });
    it('null for line/empty geometry', () => {
        expect(labelAnchorFor({ type: 'LineString', coordinates: [[0, 0]] } as Feature['geometry'])).toBeNull();
        expect(labelAnchorFor(null as unknown as Feature['geometry'])).toBeNull();
    });
});

describe('reduceNamedAreas', () => {
    const sq = (o: number): number[][] => [
        [o, o],
        [o + 2, o],
        [o + 2, o + 2],
        [o, o + 2],
        [o, o],
    ];

    it('reduces named polygons to one label point per name, keyed kind:name', () => {
        const into = new Map<string, Feature>();
        reduceNamedAreas(fc([namedPoly('Mooloolah River', sq(0))]), 'water', into);
        const label = into.get('water:Mooloolah River')!;
        expect(label.geometry).toEqual({ type: 'Point', coordinates: [1, 1] });
        expect(label.properties).toMatchObject({ _name: 'Mooloolah River', _kind: 'water' });
    });

    it('skips unnamed areas', () => {
        const into = new Map<string, Feature>();
        reduceNamedAreas(fc([namedPoly('', sq(0))]), 'water', into);
        expect(into.size).toBe(0);
    });

    it('finest-cell-wins: a later same-name area overwrites', () => {
        const into = new Map<string, Feature>();
        reduceNamedAreas(fc([namedPoly('Bay', sq(0))]), 'water', into);
        reduceNamedAreas(fc([namedPoly('Bay', sq(10))]), 'water', into);
        expect(into.size).toBe(1);
        expect(into.get('water:Bay')!.geometry).toEqual({ type: 'Point', coordinates: [11, 11] });
    });

    it('relaxes SCAMIN _minZoom by 2.5 (floor 7)', () => {
        const into = new Map<string, Feature>();
        reduceNamedAreas(fc([namedPoly('Ch', sq(0), { _minZoom: 12.6 })]), 'water', into);
        expect(into.get('water:Ch')!.properties!._minZoom).toBeCloseTo(10.1);
        into.clear();
        reduceNamedAreas(fc([namedPoly('Bay', sq(0), { _minZoom: 8 })]), 'water', into);
        expect(into.get('water:Bay')!.properties!._minZoom).toBe(7); // floored
    });
});
