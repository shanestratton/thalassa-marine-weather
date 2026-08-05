import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncCell, EncConversionResult } from '../services/enc/types';

const state = vi.hoisted(() => ({
    configured: false,
    manifestVersion: 12,
    manifestBBox: [167, -17, 169, -15] as [number, number, number, number],
    payloadCellId: 'VU5PORT1',
    records: [] as EncCell[],
    download: vi.fn(),
    putCell: vi.fn(),
    importCell: vi.fn(),
    saveCellGeoJSON: vi.fn(),
    invalidateCloudCellBlob: vi.fn(),
    retireCloudCell: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    isSupabaseConfigured: () => state.configured,
    supabase: {
        storage: {
            from: () => ({ download: state.download }),
        },
    },
}));

vi.mock('../services/enc/EncCellMetadata', () => ({
    listDisplayCells: () => state.records,
    listRegisteredCells: () => state.records,
    getRegisteredCell: (id: string) =>
        state.records.find((cell) => cell.id.trim().toUpperCase() === id.trim().toUpperCase()) ?? null,
    listCells: () =>
        state.records.filter((cell) => cell.usage !== 'reference' && cell.usage !== 'pending' && cell.usage !== 'demo'),
    putCell: state.putCell,
    suspendNotifications: vi.fn(),
    resumeNotifications: vi.fn(),
    cellsForBBox: () => state.records.filter((cell) => cell.usage === 'navigation'),
}));

vi.mock('../services/enc/EncCellStore', () => ({
    parseJsonOffThread: async (text: string) => JSON.parse(text) as unknown,
    saveCellGeoJSON: state.saveCellGeoJSON,
}));

vi.mock('../services/enc/EncHazardService', () => ({
    getDisplayCoverage: () => state.records,
    importCell: state.importCell,
    invalidateCloudCellBlob: state.invalidateCloudCellBlob,
    retireCloudCell: state.retireCloudCell,
}));

function referenceCell(id = 'VU5PORT1'): EncCell {
    return {
        id,
        sourceHO: 'VU',
        edition: 9999,
        issued: '2026-08-01',
        importedAt: '2026-08-05T00:00:00.000Z',
        bbox: [167, -17, 169, -15],
        geojsonPath: `enc-cells/${id}.geojson`,
        hazardCount: 1,
        usage: 'reference',
    };
}

function cloudNavigationCell(id = 'VU5PORT1', manifestVersion = 11): EncCell {
    return {
        ...referenceCell(id),
        edition: 5,
        usage: 'navigation',
        cloudManifestVersion: manifestVersion,
    };
}

function conversion(id: string): EncConversionResult {
    return {
        cellId: id,
        sourceHO: 'VU',
        edition: 5,
        issued: '2026-08-02',
        bbox: [167, -17, 169, -15],
        layers: {
            DEPARE: {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        properties: { DRVAL1: 4, DRVAL2: 8 },
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
    };
}

describe('cloud ENC registration cannot promote unsigned reference bytes', () => {
    beforeEach(() => {
        vi.resetModules();
        localStorage.clear();
        state.configured = false;
        state.manifestVersion = 12;
        state.manifestBBox = [167, -17, 169, -15];
        state.payloadCellId = 'VU5PORT1';
        state.records = [referenceCell()];
        state.download.mockReset();
        state.putCell.mockReset();
        state.importCell.mockReset();
        state.saveCellGeoJSON.mockReset();
        state.invalidateCloudCellBlob.mockReset().mockImplementation(async (id: string, version: number) => {
            const index = state.records.findIndex((cell) => cell.id.trim().toUpperCase() === id.trim().toUpperCase());
            if (index < 0) return false;
            state.records[index] = {
                ...state.records[index],
                usage: 'pending',
                cloudManifestVersion: version,
            };
            return true;
        });
        state.retireCloudCell.mockReset().mockImplementation(async (id: string) => {
            const before = state.records.length;
            state.records = state.records.filter((cell) => cell.id.trim().toUpperCase() !== id.trim().toUpperCase());
            return state.records.length !== before;
        });
        state.putCell.mockImplementation((cell: EncCell) => {
            const index = state.records.findIndex(
                (stored) => stored.id.trim().toUpperCase() === cell.id.trim().toUpperCase(),
            );
            const prior = index >= 0 ? state.records[index] : undefined;
            const next = {
                ...cell,
                usage:
                    cell.usage ??
                    (prior?.usage === 'reference' || prior?.usage === 'demo' ? prior.usage : 'navigation'),
            } as EncCell;
            if (index >= 0) state.records[index] = next;
            else state.records.push(next);
        });
        state.importCell.mockImplementation(
            async (blob: EncConversionResult, options: { cloudManifestVersion?: number } = {}) => {
                const id = blob.cellId.trim().toUpperCase();
                const imported: EncCell = {
                    id,
                    sourceHO: blob.sourceHO,
                    edition: blob.edition,
                    issued: blob.issued,
                    importedAt: '2026-08-05T01:00:00.000Z',
                    bbox: blob.bbox,
                    geojsonPath: `enc-cells/${id}.geojson`,
                    hazardCount: 1,
                    usage: 'navigation',
                    cloudManifestVersion: options.cloudManifestVersion,
                };
                state.records = state.records.filter((cell) => cell.id.trim().toUpperCase() !== id);
                state.records.push(imported);
                return imported;
            },
        );
        state.download.mockImplementation(async (path: string) => {
            if (path === 'manifest.json') {
                const text = JSON.stringify({
                    version: state.manifestVersion,
                    cells: [{ cellId: 'VU5PORT1', bbox: state.manifestBBox }],
                });
                return {
                    data: { size: new TextEncoder().encode(text).byteLength, text: async () => text },
                    error: null,
                };
            }
            const text = JSON.stringify(conversion(state.payloadCellId));
            return {
                data: { size: new TextEncoder().encode(text).byteLength, text: async () => text },
                error: null,
            };
        });
    });

    it('keeps a signed-out reference quarantined, then replaces it only through verified cloud import after sign-in', async () => {
        const { registerCloudCells } = await import('../services/enc/cloudCellSync');

        await expect(registerCloudCells()).resolves.toBe(0);
        expect(state.records[0]).toMatchObject({ id: 'VU5PORT1', usage: 'reference', edition: 9999 });
        expect(state.download).not.toHaveBeenCalled();

        state.configured = true;
        await expect(registerCloudCells()).resolves.toBe(1);

        expect(state.putCell).not.toHaveBeenCalled();
        expect(state.saveCellGeoJSON).not.toHaveBeenCalled();
        expect(state.importCell).toHaveBeenCalledWith(expect.objectContaining({ cellId: 'VU5PORT1', edition: 5 }), {
            usage: 'navigation',
            cloudManifestVersion: 12,
        });
        expect(state.records).toEqual([
            expect.objectContaining({ id: 'VU5PORT1', usage: 'navigation', edition: 5, cloudManifestVersion: 12 }),
        ]);
    });

    it('registers a fresh manifest entry as pending rather than installed navigation coverage', async () => {
        state.configured = true;
        state.records = [];
        const { registerCloudCells } = await import('../services/enc/cloudCellSync');

        await expect(registerCloudCells()).resolves.toBe(1);

        expect(state.records).toEqual([
            expect.objectContaining({ id: 'VU5PORT1', usage: 'pending', hazardCount: 0, cloudManifestVersion: 12 }),
        ]);
        expect(state.importCell).not.toHaveBeenCalled();
    });

    it('keeps the reference quarantined when the bucket payload does not match the manifest cell ID', async () => {
        state.configured = true;
        state.payloadCellId = 'VU5OTHER';
        const { registerCloudCells } = await import('../services/enc/cloudCellSync');

        await expect(registerCloudCells()).resolves.toBe(0);

        expect(state.importCell).not.toHaveBeenCalled();
        expect(state.saveCellGeoJSON).not.toHaveBeenCalled();
        expect(state.records).toEqual([expect.objectContaining({ id: 'VU5PORT1', usage: 'reference', edition: 9999 })]);
    });

    it('rejects a matching cell whose payload bbox differs from the active manifest', async () => {
        state.configured = true;
        state.manifestBBox = [166, -18, 170, -14];
        const { registerCloudCells } = await import('../services/enc/cloudCellSync');

        await expect(registerCloudCells()).resolves.toBe(0);

        expect(state.importCell).not.toHaveBeenCalled();
        expect(state.records).toEqual([expect.objectContaining({ usage: 'reference', edition: 9999 })]);
    });

    it('rejects a wrapper containing extra cells even when one matches the requested path', async () => {
        state.configured = true;
        state.download.mockImplementation(async (path: string) => {
            if (path === 'manifest.json') {
                const text = JSON.stringify({
                    version: 12,
                    cells: [{ cellId: 'VU5PORT1', bbox: [167, -17, 169, -15] }],
                });
                return { data: { size: text.length, text: async () => text }, error: null };
            }
            const text = JSON.stringify({ cells: [conversion('VU5PORT1'), conversion('VU5OTHER')] });
            return { data: { size: text.length, text: async () => text }, error: null };
        });
        const { registerCloudCells } = await import('../services/enc/cloudCellSync');

        await expect(registerCloudCells()).resolves.toBe(0);
        expect(state.importCell).not.toHaveBeenCalled();
    });

    it('rejects a same-version manifest rewrite and a version rollback', async () => {
        state.configured = true;
        state.records = [];
        const { registerCloudCells } = await import('../services/enc/cloudCellSync');

        await expect(registerCloudCells()).resolves.toBe(1);
        state.manifestBBox = [166, -18, 170, -14];
        await expect(registerCloudCells()).resolves.toBe(0);
        expect(state.records[0]).toMatchObject({ bbox: [167, -17, 169, -15], cloudManifestVersion: 12 });

        state.manifestVersion = 11;
        state.manifestBBox = [167, -17, 169, -15];
        await expect(registerCloudCells()).resolves.toBe(0);
        expect(state.records[0]).toMatchObject({ cloudManifestVersion: 12 });
    });

    it('retires cloud-managed cells removed by a newer manifest', async () => {
        state.configured = true;
        state.records = [cloudNavigationCell('VU5PORT1', 12)];
        const { registerCloudCells } = await import('../services/enc/cloudCellSync');
        await expect(registerCloudCells()).resolves.toBe(0);

        state.manifestVersion = 13;
        state.download.mockImplementation(async (path: string) => {
            if (path !== 'manifest.json') throw new Error(`unexpected ${path}`);
            const text = JSON.stringify({ version: 13, cells: [] });
            return { data: { size: text.length, text: async () => text }, error: null };
        });
        await expect(registerCloudCells()).resolves.toBe(0);

        expect(state.retireCloudCell).toHaveBeenCalledWith('VU5PORT1');
        expect(state.records).toEqual([]);
    });

    it('discards a blob begun under stored manifest v11 after registration advances to v12', async () => {
        state.configured = true;
        state.manifestVersion = 11;
        state.records = [cloudNavigationCell()];
        type DownloadData = { size: number; text: () => Promise<string> };
        let releaseBlob!: (value: { data: DownloadData; error: null }) => void;
        const blobResponse = new Promise<{ data: DownloadData; error: null }>((resolve) => {
            releaseBlob = resolve;
        });
        state.download.mockImplementation(async (path: string) => {
            if (path === 'manifest.json') {
                const text = JSON.stringify({
                    version: state.manifestVersion,
                    cells: [{ cellId: 'VU5PORT1', bbox: [167, -17, 169, -15] }],
                });
                return {
                    data: { size: new TextEncoder().encode(text).byteLength, text: async () => text },
                    error: null,
                };
            }
            return blobResponse;
        });
        const { downloadCloudCell, registerCloudCells } = await import('../services/enc/cloudCellSync');

        await expect(registerCloudCells()).resolves.toBe(0);
        const staleDownload = downloadCloudCell('VU5PORT1');
        await vi.waitFor(() => expect(state.download).toHaveBeenCalledWith('VU5PORT1.json'));
        state.manifestVersion = 12;
        await expect(registerCloudCells()).resolves.toBe(0);

        const staleText = JSON.stringify(conversion('VU5PORT1'));
        releaseBlob({
            data: { size: new TextEncoder().encode(staleText).byteLength, text: async () => staleText },
            error: null,
        });
        await expect(staleDownload).resolves.toBe(false);
        expect(state.importCell).not.toHaveBeenCalled();
        expect(state.records[0]).toMatchObject({ usage: 'pending', cloudManifestVersion: 12 });
    });
});
