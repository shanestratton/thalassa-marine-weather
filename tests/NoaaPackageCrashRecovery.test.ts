import { createHash, webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { partitionNoaaRecords } from '../scripts/noaa-enc/partition-records';
import type { EncCell, EncConversionResult } from '../services/enc/types';
const disk = vi.hoisted(() => ({
    files: new Map<string, string>(),
    prefs: new Map<string, string>(),
    deleted: vi.fn(),
    readHook: vi.fn(),
}));
vi.mock('@capacitor/core', async (original) => {
    const actual = await original<typeof import('@capacitor/core')>();
    return { ...actual, Capacitor: { ...actual.Capacitor, isNativePlatform: () => false } };
});
vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: async ({ key }: { key: string }) => ({ value: disk.prefs.get(key) ?? null }),
        set: async ({ key, value }: { key: string; value: string }) => {
            disk.prefs.set(key, value);
        },
    },
}));
vi.mock('@capacitor/filesystem', () => ({
    Directory: { Data: 'DATA', Library: 'LIBRARY' },
    Encoding: { UTF8: 'utf8' },
    Filesystem: {
        readFile: async ({ path }: { path: string }) => {
            if (!disk.files.has(path)) throw Error('ENOENT');
            if (path.endsWith('/manifest.json')) disk.readHook();
            return { data: disk.files.get(path) };
        },
        stat: async ({ path }: { path: string }) => {
            if (disk.files.has(path)) return { size: new TextEncoder().encode(disk.files.get(path)).length };
            if ([...disk.files.keys()].some((p) => p.startsWith(path + '/'))) return { size: 0 };
            throw Error('ENOENT');
        },
        deleteFile: async ({ path }: { path: string }) => {
            disk.files.delete(path);
        },
        rmdir: async ({ path }: { path: string }) => {
            for (const p of disk.files.keys()) if (p.startsWith(path + '/')) disk.files.delete(p);
        },
    },
}));
vi.mock('../services/enc/EncCellStore', () => ({ deleteCellGeoJSON: disk.deleted }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeBlocks: () => false }));
vi.mock('../services/enc/noaaAgreement', async (original) => ({
    ...(await original<typeof import('../services/enc/noaaAgreement')>()),
    noaaAgreementAccepted: async () => true,
}));
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { putCell, getRegisteredCell, removeCell } from '../services/enc/EncCellMetadata';
import { noaaPackagePath } from '../services/enc/noaaPackageStore';
import { loadNoaaArea, removeNoaaDownload, savedNoaaDownloads, type NoaaDownload } from '../services/enc/noaaCatalogue';
import { NOAA_AGREEMENT_SHA256, NOAA_AGREEMENT_URL } from '../services/enc/noaaAgreement';
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const source: EncConversionResult = {
    cellId: 'US3AK1EX',
    sourceHO: 'US',
    edition: 1,
    updateNumber: 0,
    issued: '2026-03-16',
    bbox: [-134, 55, -132, 56],
    layers: {
        SOUNDG: {
            type: 'FeatureCollection',
            features: [
                {
                    type: 'Feature',
                    properties: { depth: 2 },
                    geometry: { type: 'Point', coordinates: [-133.75, 55.5] },
                },
            ],
        },
    },
};
async function crashState(installed = true) {
    const scope = getAuthIdentityScope(),
        zipSha256 = 'b'.repeat(64),
        packaged = partitionNoaaRecords(source, zipSha256),
        text = JSON.stringify(packaged.manifest),
        manifestSha256 = hash(text),
        path = await noaaPackagePath(manifestSha256),
        account = hash(scope.key).slice(0, 32);
    disk.files.set(path + '/manifest.json', text);
    for (const part of packaged.manifest.parts)
        disk.files.set(path + '/' + part.sha256 + '.json', packaged.parts[part.sequence]);
    const record: NoaaDownload = {
        id: source.cellId,
        edition: 1,
        update: 0,
        chartSha256: 'a'.repeat(64),
        zipSha256,
        zipBytes: 8,
        packages: [{ sha256: manifestSha256, bytes: text.length + packaged.manifest.bytes }],
        bytes: 8 + text.length + packaged.manifest.bytes,
        path: `noaa-originals/${account}/${zipSha256}.zip`,
        savedAt: Date.now(),
        installed,
        withdrawn: false,
    };
    disk.files.set(record.path, 'UEsDBAECAwQ=');
    disk.prefs.set(authScopedStorageKey('thalassa_noaa_originals_v1', scope), JSON.stringify([record]));
    // This is the real kill window: durable reservation still names old current
    // hash, while atomic registry activation already names the complete new one.
    const active: EncCell = {
        id: source.cellId,
        sourceHO: 'US',
        edition: 1,
        updateNumber: 0,
        issued: source.issued,
        bbox: source.bbox,
        importedAt: new Date().toISOString(),
        geojsonPath: path + '/manifest.json',
        licence: 'open',
        usage: 'navigation',
        contentSha256: manifestSha256,
        noaaPackage: { owner: scope.key, manifestSha256, path },
        hazardCount: 1,
    };
    putCell(active, { allowAuthorityUpgrade: true });
    const now = new Date().toISOString();
    vi.stubGlobal(
        'fetch',
        vi.fn(
            async () =>
                new Response(
                    JSON.stringify({
                        schema: 1,
                        generation: 'c'.repeat(24),
                        checkedAt: now,
                        sourceAt: now,
                        sourceSha256: 'd'.repeat(64),
                        sourceUrl: 'https://charts.noaa.gov/ENCs/ENCProdCat_19115.xml',
                        agreementUrl: NOAA_AGREEMENT_URL,
                        agreementSha256: NOAA_AGREEMENT_SHA256,
                        activeCells: 1,
                        withdrawn: [source.cellId],
                        attribution: 'NOAA public synthetic recovery fixture.',
                        shards: [],
                    }),
                ),
        ),
    );
    return { record, active, path };
}
beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    disk.files.clear();
    disk.prefs.clear();
    disk.deleted.mockReset();
    disk.readHook.mockReset();
    localStorage.clear();
    removeCell(source.cellId);
    setAuthIdentityScope('noaa-crash-owner');
});
describe('durable NOAA reservation recovery after metadata commits before ZIP identity', () => {
    it.each([true, false])(
        'withdraws the exact reserved active package even with old identity/installed:%s',
        async (installed) => {
            const f = await crashState(installed);
            await loadNoaaArea(source.bbox, { refresh: true });
            expect(getRegisteredCell(source.cellId)).toBeNull();
            expect((await savedNoaaDownloads())[0]).toMatchObject({ withdrawn: true, installed: false });
            expect(disk.files.has(f.record.path)).toBe(true);
            expect(disk.files.has(f.path + '/manifest.json')).toBe(true);
            await removeNoaaDownload(f.record);
            expect(await savedNoaaDownloads()).toEqual([]);
            expect(disk.files.size).toBe(0);
        },
    );
    it('Remove directly reconciles the active reserved package before deleting its bytes', async () => {
        const f = await crashState();
        await removeNoaaDownload(f.record);
        expect(getRegisteredCell(source.cellId)).toBeNull();
        expect(await savedNoaaDownloads()).toEqual([]);
        expect(disk.files.size).toBe(0);
    });
    it('withdrawal and Remove preserve a later manual/Pi replacement', async () => {
        const f = await crashState();
        const replacement = {
            ...f.active,
            edition: 2,
            contentSha256: 'e'.repeat(64),
            noaaPackage: undefined,
            geojsonPath: 'manual',
        };
        putCell(replacement, { allowAuthorityUpgrade: true });
        await loadNoaaArea(source.bbox, { refresh: true });
        await removeNoaaDownload(f.record);
        expect(getRegisteredCell(source.cellId)).toEqual(replacement);
        expect(disk.deleted).not.toHaveBeenCalled();
    });
    it('uncertain manifest ownership retains activation, all bytes and quota instead of deleting a live package', async () => {
        const f = await crashState();
        disk.files.set(f.path + '/manifest.json', '{}');
        await expect(removeNoaaDownload(f.record)).rejects.toThrow(/manifest/);
        expect(getRegisteredCell(source.cellId)?.noaaPackage).toEqual(f.active.noaaPackage);
        expect(await savedNoaaDownloads()).toEqual([f.record]);
        expect(disk.files.has(f.record.path)).toBe(true);
    });
    it('a reserved manifest for a different original source cannot authorize deletion', async () => {
        const f = await crashState(),
            scope = getAuthIdentityScope();
        const wrong = {
            ...f.record,
            zipSha256: 'f'.repeat(64),
            path: f.record.path.replace('b'.repeat(64), 'f'.repeat(64)),
        };
        disk.files.set(wrong.path, disk.files.get(f.record.path)!);
        disk.prefs.set(authScopedStorageKey('thalassa_noaa_originals_v1', scope), JSON.stringify([wrong]));
        await expect(removeNoaaDownload(wrong)).rejects.toThrow(/source changed/);
        expect(getRegisteredCell(source.cellId)?.noaaPackage).toEqual(f.active.noaaPackage);
        expect(await savedNoaaDownloads()).toEqual([wrong]);
        expect(disk.files.has(f.path + '/manifest.json')).toBe(true);
    });
    it('a different account package is not detached even when the public manifest hash is identical', async () => {
        const f = await crashState();
        const other = {
            ...f.active,
            noaaPackage: { ...f.active.noaaPackage!, owner: 'different-owner', path: 'different-account-path' },
        };
        putCell(other, { allowAuthorityUpgrade: true });
        await removeNoaaDownload(f.record);
        expect(getRegisteredCell(source.cellId)).toEqual(other);
        expect(disk.deleted).not.toHaveBeenCalled();
        expect(await savedNoaaDownloads()).toEqual([]);
    });
    it('a direct metadata replacement during manifest proof cannot be removed or have its source bytes deleted', async () => {
        const f = await crashState(),
            replacement = {
                ...f.active,
                edition: 2,
                contentSha256: 'e'.repeat(64),
                noaaPackage: undefined,
                geojsonPath: 'manual',
            };
        disk.readHook.mockImplementationOnce(() => putCell(replacement, { allowAuthorityUpgrade: true }));
        await expect(removeNoaaDownload(f.record)).rejects.toThrow(/authority changed/);
        expect(getRegisteredCell(source.cellId)).toEqual(replacement);
        expect(await savedNoaaDownloads()).toEqual([f.record]);
        expect(disk.files.has(f.path + '/manifest.json')).toBe(true);
        expect(disk.deleted).not.toHaveBeenCalled();
    });
});
