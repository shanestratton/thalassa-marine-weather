import { beforeEach, describe, expect, it } from 'vitest';

import {
    cellsForBBox,
    clearAllCellMetadata,
    getCell,
    getDisplayCell,
    listCells,
    listDisplayCells,
    listPendingCells,
    listRegisteredCells,
    putCell,
    removeCell,
} from '../services/enc/EncCellMetadata';
import type { EncCell } from '../services/enc/types';

const referenceCell: EncCell = {
    id: 'VU5REF01',
    sourceHO: 'VU',
    edition: 1,
    issued: '2026-07-01',
    importedAt: '2026-08-05T00:00:00.000Z',
    bbox: [167, -17, 169, -15],
    geojsonPath: 'enc-cells/VU5REF01.geojson',
    hazardCount: 25,
    usage: 'reference',
};

beforeEach(() => {
    localStorage.clear();
    clearAllCellMetadata();
});

describe('unsigned ENC reference-pack trust boundary', () => {
    it('can be inventoried/painted but is excluded from navigation coverage', () => {
        putCell(referenceCell);

        expect(listDisplayCells()).toEqual([expect.objectContaining({ id: 'VU5REF01', usage: 'reference' })]);
        expect(getDisplayCell('VU5REF01')).toEqual(expect.objectContaining({ usage: 'reference' }));
        expect(listCells()).toEqual([]);
        expect(getCell('VU5REF01')).toBeNull();
        expect(cellsForBBox([167.5, -16.5, 168.5, -15.5])).toEqual([]);
    });

    it('keeps authoritative navigation cells in both lists', () => {
        putCell({ ...referenceCell, id: 'VU5NAV01', usage: 'navigation' });

        expect(listCells().map((cell) => cell.id)).toEqual(['VU5NAV01']);
        expect(listDisplayCells().map((cell) => cell.id)).toEqual(['VU5NAV01']);
    });

    it('does not promote an existing reference when a metadata patch omits usage', () => {
        putCell(referenceCell);
        putCell({ ...referenceCell, usage: undefined, cloudManifestVersion: 9 });

        expect(getDisplayCell(referenceCell.id)).toMatchObject({ usage: 'reference', cloudManifestVersion: 9 });
        expect(listCells()).toEqual([]);
        expect(cellsForBBox(referenceCell.bbox)).toEqual([]);
    });

    it('does not promote a case-variant reference through an explicit metadata-only navigation patch', () => {
        putCell({ ...referenceCell, id: 'vu5ref01' });
        putCell({ ...referenceCell, id: 'VU5REF01', usage: 'navigation', cloudManifestVersion: 9 });

        expect(getDisplayCell('vu5ref01')).toMatchObject({
            id: 'VU5REF01',
            usage: 'reference',
            cloudManifestVersion: 9,
        });
        expect(listDisplayCells()).toHaveLength(1);
        expect(listCells()).toEqual([]);
    });

    it('permits authority upgrade only when the verified byte-import transaction opts in', () => {
        putCell(referenceCell);
        putCell({ ...referenceCell, usage: 'navigation', edition: 2 }, { allowAuthorityUpgrade: true });

        expect(getCell(referenceCell.id)).toMatchObject({ usage: 'navigation', edition: 2 });
        expect(listCells()).toHaveLength(1);
    });

    it('keeps manifest-only and legacy zero-feature cloud records pending, never installed coverage', () => {
        putCell({
            ...referenceCell,
            id: 'VU5PEND1',
            sourceHO: 'cloud',
            edition: 0,
            issued: '',
            hazardCount: 0,
            usage: 'pending',
            cloudManifestVersion: 12,
        });
        putCell({
            ...referenceCell,
            id: 'VU5OLD01',
            sourceHO: 'cloud',
            edition: 0,
            issued: '',
            hazardCount: 0,
            usage: 'navigation',
            cloudManifestVersion: 11,
        });

        expect(listCells()).toEqual([]);
        expect(listDisplayCells()).toEqual([]);
        expect(
            listPendingCells()
                .map((cell) => cell.id)
                .sort(),
        ).toEqual(['VU5OLD01', 'VU5PEND1']);
        expect(listRegisteredCells()).toHaveLength(2);
    });

    it('does not let an invalid ID alias address or remove a valid underscore cell', () => {
        putCell({ ...referenceCell, id: 'VU5_PORT', usage: 'navigation' });

        expect(getCell('VU5/PORT')).toBeNull();
        expect(() => removeCell('VU5/PORT')).toThrow(/invalid ENC cell ID/i);
        expect(getCell('VU5_PORT')).toMatchObject({ id: 'VU5_PORT', usage: 'navigation' });
    });

    it('fails closed when a legacy registry contains navigation/reference aliases for one native file', () => {
        const navigationAlias = { ...referenceCell, usage: 'navigation' as const };
        const referenceAlias = { ...referenceCell, id: 'vu5ref01' };
        localStorage.setItem('thalassa.enc.cell.index', JSON.stringify([navigationAlias.id, referenceAlias.id]));
        localStorage.setItem(`thalassa.enc.cell:${navigationAlias.id}`, JSON.stringify(navigationAlias));
        localStorage.setItem(`thalassa.enc.cell:${referenceAlias.id}`, JSON.stringify(referenceAlias));

        expect(listCells()).toEqual([]);
        expect(getCell('VU5REF01')).toBeNull();
        expect(listDisplayCells()).toEqual([expect.objectContaining({ id: 'vu5ref01', usage: 'reference' })]);
    });
});
