import { describe, expect, it } from 'vitest';
import type { EncConversionResult } from '../../services/enc/types';
import {
    cellSoundingDatum,
    matchingSoundingDatum,
    normalizeSoundingDatum,
    chartAndCurveDatumsMatch,
    VERIFIED_PRODUCER_DATUMS,
} from '../../services/enc/chartDatum';

const cell = (extra: Partial<EncConversionResult> = {}): EncConversionResult => ({
    cellId: 'US5TEST1',
    sourceHO: 'US',
    edition: 1,
    issued: '2026-10-14',
    bbox: [-77, 38, -76, 39],
    extractorSchema: 3,
    soundingDatum: 23,
    layers: { M_SDAT: { type: 'FeatureCollection', features: [] } },
    ...extra,
});
const zone = (datum: unknown): GeoJSON.Feature => ({
    type: 'Feature',
    properties: { VERDAT: datum },
    geometry: {
        type: 'Polygon',
        coordinates: [
            [
                [-77, 38],
                [-76, 38],
                [-76, 39],
                [-77, 38],
            ],
        ],
    },
});

describe('cell sounding datum proof', () => {
    it('decodes exact IHO codes without treating approximations or epochs as equivalents', () => {
        expect([3, 12, 23, 27].map(normalizeSoundingDatum)).toEqual(['MSL', 'MLLW', 'LAT', 'LLWLT']);
        for (const value of [10, 15, 19, 0, 'LAT (1992)', 'approximate LAT', 'unknown', '', null])
            expect(normalizeSoundingDatum(value)).toBeNull();
        expect(normalizeSoundingDatum('Lowest Astronomical Tide')).toBe('LAT');
    });
    it('requires schema3 and a complete extracted M_SDAT layer, including an explicit empty collection', () => {
        expect(cellSoundingDatum(cell())).toBe('LAT');
        expect(cellSoundingDatum(cell({ extractorSchema: 2 }))).toBeNull();
        expect(cellSoundingDatum(cell({ layers: {} }))).toBeNull();
    });
    it('uses SDAT and never the heights/clearances VDAT', () => {
        expect(cellSoundingDatum(cell({ soundingDatum: 12, verticalDatum: 23 }))).toBe('MLLW');
        expect(cellSoundingDatum(cell({ soundingDatum: undefined, verticalDatum: 23 }))).toBeNull();
        expect(cellSoundingDatum(cell({ soundingDatum: 0, verticalDatum: 23 }))).toBeNull();
    });
    it('refuses a mixed, unknown or malformed local sounding-datum override', () => {
        const withZones = (features: GeoJSON.Feature[]) =>
            cell({ layers: { M_SDAT: { type: 'FeatureCollection', features } } });
        expect(cellSoundingDatum(withZones([zone(23)]))).toBe('LAT');
        for (const datum of [12, 27, 3, 0, undefined]) expect(cellSoundingDatum(withZones([zone(datum)]))).toBeNull();
        const invalidZone = zone(23);
        Reflect.set(invalidZone, 'geometry', null);
        expect(cellSoundingDatum(withZones([invalidZone]))).toBeNull();
        expect(
            cellSoundingDatum(withZones([{ ...zone(23), geometry: { type: 'Polygon', coordinates: [] } }])),
        ).toBeNull();
    });
    it('requires all cells to agree and exactly match the tide source', () => {
        expect(matchingSoundingDatum([])).toBeNull();
        expect(matchingSoundingDatum([cell(), cell({ soundingDatum: 12 })])).toBeNull();
        expect(matchingSoundingDatum([cell(), cell()])).toBe('LAT');
        expect(chartAndCurveDatumsMatch(23, 'LAT')).toBe(true);
        for (const datum of ['MLLW', 'LLWLT', 'MSL', null]) expect(chartAndCurveDatumsMatch(datum, 'LAT')).toBe(false);
    });
    it('has no fabricated producer-wide fallback from roadmap candidates', () => {
        expect(VERIFIED_PRODUCER_DATUMS.size).toBe(0);
        for (const sourceHO of ['AU', 'NZ', 'US', 'CA'])
            expect(cellSoundingDatum(cell({ sourceHO, soundingDatum: undefined }))).toBeNull();
    });
});
