/**
 * The phone keeps each chart's licence class (127-C-b, C7) and can only make a
 * cell stricter than the Pi said: a Pi row marked 'open' for a licensed id is
 * stored protected, a NOAA cell from the shelf is open, and a record written
 * before the field existed is classified on read. The field never enters a
 * chart's identity: a saved route check's fingerprint is byte-identical with or
 * without it (a new field there would expire every saved check at once, the
 * "Charts changed. Recheck" loop of 2026-08-26). Fictional cells only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncCell, EncConversionResult } from '../services/enc/types';

const mocks = vi.hoisted(() => ({ saveCellGeoJSON: vi.fn() }));
vi.mock('../services/enc/EncCellStore', () => ({
    saveCellGeoJSON: mocks.saveCellGeoJSON,
    loadCellGeoJSON: vi.fn(),
    deleteCellGeoJSON: vi.fn(),
}));

import { importCell } from '../services/enc/EncHazardService';
import {
    clearAllCellMetadata,
    getRegisteredCell,
    getRegistryFingerprint,
    putCell,
} from '../services/enc/EncCellMetadata';
import { isProtectedChart } from '../services/enc/chartLicence';

function conversion(cellId: string, sourceHO: string): EncConversionResult {
    return {
        cellId,
        sourceHO,
        edition: 4,
        updateNumber: 1,
        issued: '2026-09-01',
        bbox: sourceHO === 'US' ? [-76.5, 38.9, -76.3, 39.1] : [166.3, -22.4, 166.5, -22.2],
        layers: { DEPARE: { type: 'FeatureCollection', features: [] } },
    };
}

beforeEach(() => {
    localStorage.clear();
    clearAllCellMetadata();
    mocks.saveCellGeoJSON
        .mockReset()
        .mockImplementation(async (id: string) => ({ path: `enc/${id}.json`, sizeBytes: 2048 }));
});

describe('a chart keeps its licence class on the phone', () => {
    it("stores a Pi row marked 'open' for an o-charts id as protected", async () => {
        await importCell(conversion('OC-99-ZZTEST', 'FR'), { licence: 'open' });
        expect(getRegisteredCell('OC-99-ZZTEST')?.licence).toBe('protected');
    });

    it('stores a NOAA cell from the shelf as open, and as protected when its source said so', async () => {
        await importCell(conversion('US5XX01M', 'US'), { usage: 'navigation', cloudManifestVersion: 3 });
        expect(getRegisteredCell('US5XX01M')?.licence).toBe('open');
        await importCell(conversion('US5XX02M', 'US'), { licence: 'protected' });
        expect(getRegisteredCell('US5XX02M')?.licence).toBe('protected');
    });

    it('classifies a legacy record without the field on read', () => {
        const legacy = (id: string, sourceHO: string): EncCell => ({
            id,
            sourceHO,
            edition: 1,
            issued: '2026-01-01',
            importedAt: '2026-01-02T00:00:00.000Z',
            bbox: [10, 10, 11, 11],
            geojsonPath: `enc/${id}.json`,
            hazardCount: 0,
        });
        putCell(legacy('ZZ5TEST1', 'ZZ'));
        putCell(legacy('US5XX03M', 'US'));
        expect(isProtectedChart(getRegisteredCell('ZZ5TEST1')!)).toBe(true);
        expect(isProtectedChart(getRegisteredCell('US5XX03M')!)).toBe(false);
    });

    it('leaves the registry fingerprint byte-identical with and without the field', async () => {
        await importCell(conversion('OC-99-ZZTEST', 'FR'));
        await importCell(conversion('US5XX01M', 'US'));
        const withField = getRegistryFingerprint();
        const stamped = getRegisteredCell('OC-99-ZZTEST')!;
        expect(stamped.licence).toBe('protected');
        const { licence: _licence, ...withoutField } = stamped;
        putCell(withoutField as EncCell);
        expect(getRegisteredCell('OC-99-ZZTEST')?.licence).toBeUndefined();
        expect(getRegistryFingerprint()).toBe(withField);
        expect(withField).toBe('OC-99-ZZTEST@4@2026-09-01@2048@update-1|US5XX01M@4@2026-09-01@2048@update-1');
    });
});
