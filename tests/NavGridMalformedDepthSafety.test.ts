import type { FeatureCollection } from 'geojson';
import { describe, expect, it } from 'vitest';

import { CAUTION } from '../services/engine/constants';
import { latLonToGrid } from '../services/engine/geometry';
import { buildNavGrid } from '../services/engine/navGrid';
import type { InshoreLayers } from '../services/engine/types';

const BBOX: [number, number, number, number] = [153, -27.002, 153.002, -27];

function depthArea(drval1: unknown): FeatureCollection {
    return {
        type: 'FeatureCollection',
        features: [
            {
                type: 'Feature',
                properties: { acronym: 'DEPARE', DRVAL1: drval1 },
                geometry: {
                    type: 'Polygon',
                    coordinates: [
                        [
                            [BBOX[0], BBOX[1]],
                            [BBOX[2], BBOX[1]],
                            [BBOX[2], BBOX[3]],
                            [BBOX[0], BBOX[3]],
                            [BBOX[0], BBOX[1]],
                        ],
                    ],
                },
            },
        ],
    };
}

function centreValue(drval1: unknown): number {
    const layers: InshoreLayers = { DEPARE: depthArea(drval1) };
    const grid = buildNavGrid(layers, BBOX, 25, 2.4, 0.5, 60);
    const { x, y } = latLonToGrid(grid, -27.001, 153.001);
    return grid.cells[y * grid.width + x];
}

describe('navigation grid malformed depth safety', () => {
    it.each([undefined, '8', Number.NaN, Number.POSITIVE_INFINITY])(
        'downgrades a DEPARE with invalid DRVAL1=%s to caution',
        (drval1) => {
            expect(centreValue(drval1)).toBe(CAUTION);
        },
    );

    it('still accepts a finite charted depth', () => {
        expect(centreValue(8)).toBe(8);
    });
});
