// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { assertCompleteOfficialLayers, ENC_LAYERS } from '../pi-cache/src/s57Converter';
import { dsidCsvRows, dsidDate, dsidRevision } from '../pi-cache/src/s57Dsid';
describe('shared NOAA/boat S-57 conversion contract', () => {
    it('refuses failed, partial or unverifiable official layers while permitting genuinely absent classes', () => {
        const layer = {
            type: 'FeatureCollection' as const,
            features: [{ type: 'Feature' as const, geometry: null, properties: {} }],
        };
        expect(() => assertCompleteOfficialLayers({ SBDARE: layer, BRIDGE: 'absent' }, { SBDARE: 1 })).not.toThrow();
        expect(() =>
            assertCompleteOfficialLayers({ WRECKS: { type: 'FeatureCollection', features: [] } }, {}),
        ).not.toThrow();
        expect(() => assertCompleteOfficialLayers({ WRECKS: null }, {})).not.toThrow();
        for (const [outcomes, counts] of [
            [{ SBDARE: layer }, { SBDARE: 2 }],
            [{ SBDARE: layer }, {}],
            [{ SBDARE: null }, { SBDARE: 1 }],
            [{ SBDARE: 'absent' as const }, { SBDARE: 1 }],
        ] as const)
            expect(() => assertCompleteOfficialLayers(outcomes, counts)).toThrow(/completely verified/);
    });
    it('extracts each layer once, including seabed points and sounding datum coverage', () => {
        expect(new Set(ENC_LAYERS).size).toBe(ENC_LAYERS.length);
        expect(ENC_LAYERS.filter((name) => name === 'M_SDAT')).toHaveLength(1);
        expect(ENC_LAYERS).toContain('SBDARE');
        expect(ENC_LAYERS).toContain('WEDKLP');
        for (const name of ['BRIDGE', 'PONTON', 'CBLOHD', 'PIPOHD', 'CONVYR', 'M_SDAT'])
            expect(ENC_LAYERS).toContain(name);
    });
    it('parses actual GDAL-style DSID quoted values without shifting fields at commas/newlines', () => {
        const [headers, values] = dsidCsvRows(
            'DSID_DSNM,COMMENT,DSID_EDTN,DSID_UPDN,DSID_ISDT\r\n"US5CA16M.000","quoted, remark\nwith ""quote""",46,1,20260708\r\n',
        );
        expect(headers).toEqual(['DSID_DSNM', 'COMMENT', 'DSID_EDTN', 'DSID_UPDN', 'DSID_ISDT']);
        expect(values).toEqual(['US5CA16M.000', 'quoted, remark\nwith "quote"', '46', '1', '20260708']);
        expect(dsidRevision(values[2])).toBe(46);
        expect(dsidRevision(values[3])).toBe(1);
        expect(dsidDate(values[4])).toBe('2026-07-08');
    });
    it('rejects incomplete metadata, invalid dates and fabricated numeric revision fallbacks', () => {
        for (const csv of ['DSID_EDTN\n', 'A,B\n1\n', 'A,A\n1,2\n', 'A\n"unfinished'])
            expect(() => dsidCsvRows(csv)).toThrow();
        for (const value of ['', undefined, '-1', '1.2', '1junk', '65536']) expect(dsidRevision(value)).toBeUndefined();
        expect(dsidRevision('0')).toBe(0);
        for (const value of ['', undefined, '20260230', '20251301', '20251000'])
            expect(dsidDate(value)).toBeUndefined();
        expect(dsidDate('20240229')).toBe('2024-02-29');
    });
});
