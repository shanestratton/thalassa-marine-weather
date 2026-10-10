/**
 * Licensed (protected) chart cells never touch a Filesystem call
 * (127-C-c decisions 3 and 4). o-charts (Roberto, 2026-10-10): "Storing
 * unencrypted data on any medium, and especially in the cloud, is strictly
 * prohibited by the terms of the licenses signed with the chart providers."
 *
 * The real store, registry and import run here; only @capacitor/filesystem,
 * the platform and the remote rungs are stubbed. Fictional cells only:
 * protected OC-99-ZZ…, open (NOAA-shaped) US5ZZ01M, a synthetic box in the
 * North Sea.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EncConversionResult } from '../services/enc/types';

const h = vi.hoisted(() => ({
    native: false,
    files: new Map<string, string>(),
    calls: [] as Array<{ op: string; path?: string; directory?: string; to?: string; toDirectory?: string }>,
    downloadPiCell: vi.fn(async (_id: string) => false),
    downloadCloudCell: vi.fn(async (_id: string) => false),
    prepareChartStore: vi.fn(async () => ({ path: 'Application Support/enc-open' })),
    purgeWebDiskCache: vi.fn(async () => undefined),
}));

const notFound = () => Promise.reject(new Error('File does not exist'));
const key = (o: { path?: string; directory?: string }) => `${o.directory}:${o.path}`;

vi.mock('@capacitor/filesystem', () => ({
    Directory: { Data: 'DATA', Library: 'LIBRARY', Documents: 'DOCUMENTS', Cache: 'CACHE' },
    Encoding: { UTF8: 'utf8' },
    Filesystem: {
        writeFile: vi.fn(async (o: { path: string; directory: string; data: string }) => {
            h.calls.push({ op: 'writeFile', path: o.path, directory: o.directory });
            h.files.set(key(o), o.data);
            return { uri: key(o) };
        }),
        readFile: vi.fn(async (o: { path: string; directory: string }) => {
            h.calls.push({ op: 'readFile', path: o.path, directory: o.directory });
            const data = h.files.get(key(o));
            return data === undefined ? notFound() : { data };
        }),
        stat: vi.fn(async (o: { path: string; directory: string }) => {
            h.calls.push({ op: 'stat', path: o.path, directory: o.directory });
            const hit = [...h.files.keys()].some((k) => k === key(o) || k.startsWith(`${key(o)}/`));
            return hit ? { type: 'file', size: 1, uri: key(o) } : notFound();
        }),
        mkdir: vi.fn(async (o: { path: string; directory: string }) => {
            h.calls.push({ op: 'mkdir', path: o.path, directory: o.directory });
        }),
        rename: vi.fn(async (o: { from: string; directory: string; to: string; toDirectory: string }) => {
            h.calls.push({ op: 'rename', path: o.from, directory: o.directory, to: o.to, toDirectory: o.toDirectory });
        }),
        deleteFile: vi.fn(async (o: { path: string; directory: string }) => {
            h.calls.push({ op: 'deleteFile', path: o.path, directory: o.directory });
            h.files.delete(key(o));
        }),
        rmdir: vi.fn(async (o: { path: string; directory: string }) => {
            h.calls.push({ op: 'rmdir', path: o.path, directory: o.directory });
        }),
        readdir: vi.fn(async () => ({ files: [] })),
        getUri: vi.fn(async (o: { path: string; directory: string }) => ({ uri: `file:///${key(o)}` })),
    },
}));
vi.mock('@capacitor/core', async (original) => {
    const real = await original<typeof import('@capacitor/core')>();
    return {
        ...real,
        Capacitor: {
            ...real.Capacitor,
            isNativePlatform: () => h.native,
            getPlatform: () => (h.native ? 'ios' : 'web'),
        },
        registerPlugin: () => ({
            prepareChartStore: h.prepareChartStore,
            purgeWebDiskCache: h.purgeWebDiskCache,
        }),
    };
});
vi.mock('../services/enc/piCellSync', () => ({ downloadPiCell: h.downloadPiCell }));
vi.mock('../services/enc/cloudCellSync', () => ({ downloadCloudCell: h.downloadCloudCell }));

function cell(cellId: string, sourceHO: string, pad = 0): EncConversionResult {
    return {
        cellId,
        sourceHO,
        edition: 2,
        issued: '2026-09-01',
        bbox: [3.0, 54.0, 3.2, 54.2],
        layers: {
            DEPARE: {
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        properties: { DRVAL1: 8, DRVAL2: 15, NOTE: 'x'.repeat(pad) },
                        geometry: {
                            type: 'Polygon',
                            coordinates: [
                                [
                                    [3.0, 54.0],
                                    [3.2, 54.0],
                                    [3.2, 54.2],
                                    [3.0, 54.0],
                                ],
                            ],
                        },
                    },
                ],
            },
        },
    } as unknown as EncConversionResult;
}

async function load(native: boolean) {
    h.native = native;
    vi.resetModules();
    const store = await import('../services/enc/EncCellStore');
    const hazards = await import('../services/enc/EncHazardService');
    const vault = await import('../services/enc/boatCellVault');
    return { store, hazards, vault };
}

const writes = () => h.calls.filter((c) => ['writeFile', 'mkdir', 'rename'].includes(c.op));

describe('protected chart cells are held in memory only', () => {
    beforeEach(() => {
        localStorage.clear();
        h.files.clear();
        h.calls.length = 0;
        h.downloadPiCell.mockClear();
        h.downloadCloudCell.mockClear();
    });

    it('importCell of a protected cell makes zero writeFile/mkdir/rename calls', async () => {
        const { hazards } = await load(true);
        await hazards.importCell(cell('OC-99-ZZ0001', 'ZZ'));
        expect(writes()).toEqual([]);
        expect(h.calls.filter((c) => c.path?.includes('OC-99-ZZ0001'))).toEqual([]);
    });

    it('reads it back from the parse cache, then from the vault, then climbs to the Pi', async () => {
        const { store, hazards, vault } = await load(false);
        for (let i = 1; i <= 5; i++) await hazards.importCell(cell(`OC-99-ZZ000${i}`, 'ZZ'));
        expect((await store.loadCellGeoJSON('OC-99-ZZ0005'))?.cellId).toBe('OC-99-ZZ0005');

        // The parse cache gives back its oldest cell; the vault still holds it.
        expect(store.releaseBlobCache()).toBeGreaterThan(0);
        const raw = await store.readCellRaw('OC-99-ZZ0001');
        expect(raw.kind).toBe('text');
        expect((await store.loadCellGeoJSON('OC-99-ZZ0001'))?.cellId).toBe('OC-99-ZZ0001');
        expect(h.calls.filter((c) => c.op === 'readFile')).toEqual([]);

        // Memory gone (unpair, jetsam): the ladder climbs to the boat's Pi.
        vault.clear();
        store.clearProtectedBlobs();
        expect(store.blobCacheStats().entries).toBe(0);
        await store.loadCellGeoJSON('OC-99-ZZ0001');
        expect(h.downloadPiCell).toHaveBeenCalledWith('OC-99-ZZ0001');
        expect(h.calls.filter((c) => c.path?.includes('OC-99-ZZ0001'))).toEqual([]);
    });

    it('a forced disk write of a protected cell throws', async () => {
        const { store } = await load(true);
        await expect(store.writeOpenCellText('OC-99-ZZ0009', '{}')).rejects.toThrow(/licensed/i);
        await expect(store.writeOpenCellText('FR4ZZ001', '{}')).rejects.toThrow(/licensed/i);
        expect(writes()).toEqual([]);
    });

    it('a cell the Pi stamps protected stays in memory even with an open-looking id', async () => {
        const { hazards } = await load(true);
        await hazards.importCell(cell('US5ZZ03M', 'US'), { licence: 'protected' });
        expect(writes()).toEqual([]);
    });

    it('an open cell writes to Library/Application Support/enc-open on native', async () => {
        const { hazards } = await load(true);
        await hazards.importCell(cell('US5ZZ01M', 'US'));
        const write = h.calls.find((c) => c.op === 'writeFile');
        expect(write).toEqual({
            op: 'writeFile',
            path: 'Application Support/enc-open/US5ZZ01M.geojson',
            directory: 'LIBRARY',
        });
        expect(h.prepareChartStore).toHaveBeenCalled();
    });

    it('an open cell writes to Data/enc-cells on the web (IndexedDB)', async () => {
        const { hazards } = await load(false);
        await hazards.importCell(cell('US4ZZ02M', 'US'));
        const write = h.calls.find((c) => c.op === 'writeFile');
        expect(write).toEqual({ op: 'writeFile', path: 'enc-cells/US4ZZ02M.geojson', directory: 'DATA' });
    });

    it('a 14-cell merge window fits the vault, so the plotting budget never leaves a cell unreadable', async () => {
        const { store, hazards } = await load(false);
        store.setBlobCachePlottingMode(true);
        // ~1.5 MB of text each: 21 MB, past the 16 MB plotting parse cache.
        const ids = Array.from({ length: 14 }, (_, i) => `OC-99-ZZ01${String(i).padStart(2, '0')}`);
        for (const id of ids) await hazards.importCell(cell(id, 'ZZ', 1_500_000));
        expect(store.blobCacheStats().entries).toBeLessThan(14);
        for (const id of ids) expect((await store.readCellRaw(id)).kind).not.toBe('missing');
        store.setBlobCachePlottingMode(false);
    });
});
