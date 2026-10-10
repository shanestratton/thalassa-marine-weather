/**
 * The strong shape gate every Pi and NOAA-shelf cell passes before this phone
 * holds it. The file/link import half (the ENC Library) is retired in 127
 * (127-C-c, Shane's Q1 "yes"); its tests went with it.
 */
import { describe, expect, it } from 'vitest';

import { validateLocalEncPack } from '../services/enc/localEncPackImport';
import type { EncConversionResult } from '../services/enc/types';

function validCell(overrides: Partial<EncConversionResult> = {}): EncConversionResult {
    return {
        cellId: 'VU5PORT1',
        sourceHO: 'VU',
        edition: 4,
        issued: '2026-07-01',
        bbox: [167, -17, 169, -15],
        layers: {
            DEPARE: {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        properties: { DRVAL1: 10, DRVAL2: 20 },
                        geometry: {
                            type: 'Polygon',
                            coordinates: [
                                [
                                    [167.1, -16.9],
                                    [168.9, -16.9],
                                    [168.9, -15.1],
                                    [167.1, -16.9],
                                ],
                            ],
                        },
                    },
                ],
            },
        },
        ...overrides,
    };
}

describe('ENC pack validation', () => {
    it('accepts a bare converted cell or batch and normalises the office code', () => {
        expect(validateLocalEncPack({ ...validCell(), sourceHO: 'vu' }).cells[0].sourceHO).toBe('VU');
        expect(validateLocalEncPack({ ...validCell(), cellId: 'vu5port1' }).cells[0].cellId).toBe('VU5PORT1');
        expect(validateLocalEncPack({ cells: [validCell()], skipped: [] }).cells).toHaveLength(1);
    });

    it('fails closed on unknown layers, missing depth coverage, or geometry outside the declared bbox', () => {
        const unknown = validCell({
            layers: {
                ...validCell().layers,
                DANGER_THAT_APP_WOULD_DROP: { type: 'FeatureCollection', features: [] },
            } as EncConversionResult['layers'],
        });
        expect(() => validateLocalEncPack(unknown)).toThrow(/unsupported chart layer/i);

        expect(() =>
            validateLocalEncPack({
                ...validCell(),
                layers: { LIGHTS: { type: 'FeatureCollection', features: [] } },
            }),
        ).toThrow(/no DEPARE\/DRGARE depth-area coverage/i);

        expect(() => validateLocalEncPack({ ...validCell(), bbox: [167.5, -16.5, 168.5, -15.5] })).toThrow(
            /outside its declared bbox/i,
        );

        const openRing = validCell();
        const polygon = openRing.layers.DEPARE!.features[0].geometry as GeoJSON.Polygon;
        polygon.coordinates[0][polygon.coordinates[0].length - 1] = [167.2, -16.8];
        expect(() => validateLocalEncPack(openRing)).toThrow(/closed GeoJSON ring/i);
    });

    it('bounds recursive geometry validation before a hostile pack can exhaust the call stack', () => {
        let geometry: GeoJSON.Geometry = validCell().layers.DEPARE!.features[0].geometry!;
        for (let depth = 0; depth < 34; depth += 1) {
            geometry = { type: 'GeometryCollection', geometries: [geometry] };
        }
        const nested = validCell();
        nested.layers.DEPARE!.features[0] = {
            ...nested.layers.DEPARE!.features[0],
            geometry,
        };

        expect(() => validateLocalEncPack(nested)).toThrow(/geometry nesting exceeds 32 levels/i);
    });
});
