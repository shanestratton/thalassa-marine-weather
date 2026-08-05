import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncCell, EncConversionResult } from '../services/enc/types';

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
}

const mocks = vi.hoisted(() => ({
    storedCell: null as EncCell | null,
    saveCellGeoJSON: vi.fn(),
    loadCellGeoJSON: vi.fn(),
    deleteCellGeoJSON: vi.fn(),
}));

vi.mock('../services/enc/EncCellStore', () => ({
    saveCellGeoJSON: mocks.saveCellGeoJSON,
    loadCellGeoJSON: mocks.loadCellGeoJSON,
    deleteCellGeoJSON: mocks.deleteCellGeoJSON,
}));

vi.mock('../services/enc/EncCellMetadata', () => ({
    getCell: (id: string) =>
        mocks.storedCell?.id === id &&
        mocks.storedCell.usage !== 'reference' &&
        mocks.storedCell.usage !== 'pending' &&
        mocks.storedCell.usage !== 'demo'
            ? mocks.storedCell
            : null,
    getDisplayCell: (id: string) => (mocks.storedCell?.id === id ? mocks.storedCell : null),
    getRegisteredCell: (id: string) =>
        mocks.storedCell?.id.trim().toUpperCase() === id.trim().toUpperCase() ? mocks.storedCell : null,
    listDisplayCells: () => (mocks.storedCell ? [mocks.storedCell] : []),
    listRegisteredCells: () => (mocks.storedCell ? [mocks.storedCell] : []),
    listPendingCells: () => (mocks.storedCell?.usage === 'pending' ? [mocks.storedCell] : []),
    putCell: (cell: EncCell) => {
        mocks.storedCell = { ...cell };
    },
    subscribe: () => () => undefined,
    getVersion: () => 0,
}));

import { getIndexForCell, importCell, invalidateCloudCellBlob } from '../services/enc/EncHazardService';

function conversion(edition: number, cellId = 'VU5PORT1'): EncConversionResult {
    return {
        cellId,
        sourceHO: 'VU',
        edition,
        issued: '2026-08-01',
        bbox: [167, -17, 169, -15],
        layers: {
            DEPARE: { type: 'FeatureCollection', features: [] },
        },
    };
}

describe('ENC cell import authority serialization', () => {
    beforeEach(() => {
        mocks.storedCell = null;
        mocks.saveCellGeoJSON.mockReset();
        mocks.loadCellGeoJSON.mockReset();
        mocks.deleteCellGeoJSON.mockReset();
    });

    it('never lets a concurrent unsigned import replace trusted bytes or metadata', async () => {
        const trustedSave = deferred<{ path: string; sizeBytes: number }>();
        mocks.saveCellGeoJSON
            .mockReturnValueOnce(trustedSave.promise)
            .mockResolvedValue({ path: 'enc-cells/VU5PORT1.geojson', sizeBytes: 200 });

        const trusted = importCell(conversion(4), { usage: 'navigation' });
        await vi.waitFor(() => expect(mocks.saveCellGeoJSON).toHaveBeenCalledTimes(1));

        const unsigned = importCell(conversion(5), { usage: 'reference' });
        await Promise.resolve();
        expect(mocks.saveCellGeoJSON).toHaveBeenCalledTimes(1);

        trustedSave.resolve({ path: 'enc-cells/VU5PORT1.geojson', sizeBytes: 100 });
        await expect(trusted).resolves.toMatchObject({ id: 'VU5PORT1', edition: 4, usage: 'navigation' });
        await expect(unsigned).rejects.toThrow(/trusted navigation coverage.*bytes were not written/i);

        expect(mocks.saveCellGeoJSON).toHaveBeenCalledTimes(1);
        expect(mocks.storedCell).toMatchObject({ id: 'VU5PORT1', edition: 4, usage: 'navigation' });
    });

    it('rejects an edition downgrade before touching the shared cell blob', async () => {
        mocks.storedCell = {
            id: 'VU5PORT1',
            sourceHO: 'VU',
            edition: 6,
            issued: '2026-08-02',
            importedAt: '2026-08-05T00:00:00.000Z',
            bbox: [167, -17, 169, -15],
            geojsonPath: 'enc-cells/VU5PORT1.geojson',
            hazardCount: 1,
            usage: 'navigation',
        };

        await expect(importCell(conversion(5), { usage: 'navigation' })).rejects.toThrow(
            /older than installed edition 6.*bytes were not written/i,
        );
        expect(mocks.saveCellGeoJSON).not.toHaveBeenCalled();
        expect(mocks.storedCell).toMatchObject({ edition: 6, usage: 'navigation' });
    });

    it('allows trusted bytes to replace a self-asserted numerically newer reference', async () => {
        mocks.storedCell = {
            id: 'VU5PORT1',
            sourceHO: 'VU',
            edition: 9999,
            issued: '2026-08-02',
            importedAt: '2026-08-05T00:00:00.000Z',
            bbox: [167, -17, 169, -15],
            geojsonPath: 'enc-cells/VU5PORT1.geojson',
            hazardCount: 1,
            usage: 'reference',
        };
        mocks.saveCellGeoJSON.mockResolvedValue({ path: 'enc-cells/VU5PORT1.geojson', sizeBytes: 200 });

        await expect(importCell(conversion(5), { usage: 'navigation' })).resolves.toMatchObject({
            id: 'VU5PORT1',
            edition: 5,
            usage: 'navigation',
        });
        expect(mocks.saveCellGeoJSON).toHaveBeenCalledTimes(1);
    });

    it('does not let a manifest refresh roll back the last trusted edition or issue date', async () => {
        mocks.storedCell = {
            id: 'VU5PORT1',
            sourceHO: 'VU',
            edition: 6,
            issued: '2026-08-02',
            importedAt: '2026-08-05T00:00:00.000Z',
            bbox: [167, -17, 169, -15],
            geojsonPath: 'enc-cells/VU5PORT1.geojson',
            hazardCount: 1,
            usage: 'pending',
            cloudManifestVersion: 12,
        };

        await expect(
            importCell({ ...conversion(5), issued: '2026-08-03' }, { usage: 'navigation', cloudManifestVersion: 12 }),
        ).rejects.toThrow(/older than installed edition 6/i);
        await expect(
            importCell({ ...conversion(6), issued: '2026-08-01' }, { usage: 'navigation', cloudManifestVersion: 12 }),
        ).rejects.toThrow(/issue date.*older than installed/i);
        expect(mocks.saveCellGeoJSON).not.toHaveBeenCalled();
    });

    it('serializes case variants as one native-file identity', async () => {
        const trustedSave = deferred<{ path: string; sizeBytes: number }>();
        mocks.saveCellGeoJSON.mockReturnValueOnce(trustedSave.promise);

        const trusted = importCell(conversion(4, 'VU5PORT1'), { usage: 'navigation' });
        await vi.waitFor(() => expect(mocks.saveCellGeoJSON).toHaveBeenCalledTimes(1));
        const unsignedCaseVariant = importCell(conversion(5, 'vu5port1'), { usage: 'reference' });
        await Promise.resolve();
        expect(mocks.saveCellGeoJSON).toHaveBeenCalledTimes(1);

        trustedSave.resolve({ path: 'enc-cells/VU5PORT1.geojson', sizeBytes: 100 });
        await expect(trusted).resolves.toMatchObject({ id: 'VU5PORT1', usage: 'navigation' });
        await expect(unsignedCaseVariant).rejects.toThrow(/trusted navigation coverage/i);
        expect(mocks.saveCellGeoJSON).toHaveBeenCalledTimes(1);
    });

    it('never re-caches an old spatial index after a replacement import dropped it', async () => {
        mocks.storedCell = {
            id: 'VU5PORT1',
            sourceHO: 'VU',
            edition: 1,
            issued: '2026-07-01',
            importedAt: '2026-08-05T00:00:00.000Z',
            bbox: [167, -17, 169, -15],
            geojsonPath: 'enc-cells/VU5PORT1.geojson',
            hazardCount: 0,
            usage: 'navigation',
        };
        const oldBlob = deferred<EncConversionResult | null>();
        mocks.loadCellGeoJSON.mockReturnValueOnce(oldBlob.promise).mockResolvedValue(conversion(2));
        mocks.saveCellGeoJSON.mockResolvedValue({ path: 'enc-cells/VU5PORT1.geojson', sizeBytes: 200 });

        const buildingOldIndex = getIndexForCell('VU5PORT1');
        await vi.waitFor(() => expect(mocks.loadCellGeoJSON).toHaveBeenCalledTimes(1));
        oldBlob.resolve(conversion(1));
        await expect(importCell(conversion(2), { usage: 'navigation' })).resolves.toMatchObject({ edition: 2 });

        await expect(buildingOldIndex).resolves.not.toBeNull();
        expect(mocks.loadCellGeoJSON).toHaveBeenCalledTimes(2);
        expect(mocks.storedCell).toMatchObject({ edition: 2, usage: 'navigation' });
    });

    it('does not let a stale manifest invalidation delete a newer import that won the same-cell lock', async () => {
        const oldImportedAt = '2026-08-05T00:00:00.000Z';
        mocks.storedCell = {
            id: 'VU5PORT1',
            sourceHO: 'VU',
            edition: 1,
            issued: '2026-07-01',
            importedAt: oldImportedAt,
            bbox: [167, -17, 169, -15],
            geojsonPath: 'enc-cells/VU5PORT1.geojson',
            hazardCount: 1,
            usage: 'navigation',
            cloudManifestVersion: 11,
        };
        const newSave = deferred<{ path: string; sizeBytes: number }>();
        mocks.saveCellGeoJSON.mockReturnValueOnce(newSave.promise);

        const replacement = importCell(conversion(2), { usage: 'navigation', cloudManifestVersion: 12 });
        await vi.waitFor(() => expect(mocks.saveCellGeoJSON).toHaveBeenCalledOnce());
        const staleInvalidation = invalidateCloudCellBlob('VU5PORT1', 12, true, 11, oldImportedAt);
        newSave.resolve({ path: 'enc-cells/VU5PORT1.geojson', sizeBytes: 200 });

        await expect(replacement).resolves.toMatchObject({ edition: 2, cloudManifestVersion: 12 });
        await expect(staleInvalidation).resolves.toBe(false);
        expect(mocks.deleteCellGeoJSON).not.toHaveBeenCalled();
        expect(mocks.storedCell).toMatchObject({ edition: 2, usage: 'navigation', cloudManifestVersion: 12 });
    });
});
