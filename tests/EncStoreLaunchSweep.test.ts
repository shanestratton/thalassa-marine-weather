/**
 * One sweep per launch (127-C-c decision 5), replacing both the 127 upgrade
 * purge and the deferred 126-20 launch purge. o-charts (Roberto, 2026-10-10):
 * "Storing unencrypted data on any medium, and especially in the cloud, is
 * strictly prohibited by the terms of the licenses signed with the chart
 * providers."
 *
 *  (a) the registry: every localStorage record that is not an open chart goes;
 *  (b) the files: open cells move out of Documents into Library/Application
 *      Support/enc-open (native), every other file goes in one recursive rmdir;
 *      the web deletes its non-open files one by one;
 *  (c) chart pictures in WebKit's HTTP cache, purged once (native only).
 *
 * No "done" flag for (a) and (b): a run cut short finishes on the next launch.
 * Fictional ids only.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
    native: true,
    files: new Set<string>(),
    calls: [] as Array<Record<string, string>>,
    sameUri: false,
    renameFails: new Set<string>(),
    prepareChartStore: vi.fn(async () => ({ path: 'Application Support/enc-open' })),
    purgeWebDiskCache: vi.fn(async () => undefined),
}));

const OLD = 'DATA:enc-cells';
const notFound = () => Promise.reject(new Error('File does not exist'));

vi.mock('@capacitor/filesystem', () => ({
    Directory: { Data: 'DATA', Library: 'LIBRARY', Documents: 'DOCUMENTS', Cache: 'CACHE' },
    Encoding: { UTF8: 'utf8' },
    Filesystem: {
        stat: vi.fn(async (o: { path: string; directory: string }) => {
            const k = `${o.directory}:${o.path}`;
            h.calls.push({ op: 'stat', k });
            return [...h.files].some((f) => f === k || f.startsWith(`${k}/`)) ? { type: 'directory' } : notFound();
        }),
        readdir: vi.fn(async (o: { path: string; directory: string }) => {
            const k = `${o.directory}:${o.path}/`;
            return {
                files: [...h.files].filter((f) => f.startsWith(k)).map((f) => ({ name: f.slice(k.length) })),
            };
        }),
        getUri: vi.fn(async (o: { path: string; directory: string }) => ({
            uri: h.sameUri ? 'file:///same' : `file:///${o.directory}/${o.path}`,
        })),
        rename: vi.fn(async (o: { from: string; directory: string; to: string; toDirectory: string }) => {
            h.calls.push({ op: 'rename', from: `${o.directory}:${o.from}`, to: `${o.toDirectory}:${o.to}` });
            if (h.renameFails.has(o.from)) throw new Error('rename failed');
            h.files.delete(`${o.directory}:${o.from}`);
            h.files.add(`${o.toDirectory}:${o.to}`);
        }),
        rmdir: vi.fn(async (o: { path: string; directory: string; recursive?: boolean }) => {
            const k = `${o.directory}:${o.path}`;
            h.calls.push({ op: 'rmdir', k, recursive: String(o.recursive) });
            for (const f of [...h.files]) if (f.startsWith(`${k}/`)) h.files.delete(f);
        }),
        deleteFile: vi.fn(async (o: { path: string; directory: string }) => {
            const k = `${o.directory}:${o.path}`;
            h.calls.push({ op: 'deleteFile', k });
            h.files.delete(k);
        }),
        mkdir: vi.fn(async () => undefined),
        writeFile: vi.fn(async () => ({ uri: '' })),
        readFile: vi.fn(async () => notFound()),
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

const rec = (id: string, sourceHO: string, extra: Record<string, unknown> = {}) => ({
    id,
    sourceHO,
    edition: 1,
    issued: '2026-08-01',
    importedAt: '2026-08-02T00:00:00.000Z',
    bbox: [-80.2, 25.6, -80.0, 25.8],
    geojsonPath: `enc-cells/${id}.geojson`,
    hazardCount: 3,
    usage: 'navigation',
    ...extra,
});

const PROTECTED = [
    rec('OC-99-ZZ0201', 'ZZ'),
    rec('FR4ZZ001', 'FR'),
    rec('XYZTEST1', 'ZZ'),
    rec('OC-99-ZZ0202', 'ZZ', { usage: 'pending', cloudManifestVersion: 4, hazardCount: 0 }),
    rec('GB4ZZ001', 'GB', { personalManifestVersion: 2 }),
    // An unsigned ENC Library pack: no provable provenance (decision 12).
    rec('US5ZZ09M', 'US', { usage: 'reference' }),
];
const OPEN = rec('US5ZZ01M', 'US');

function seed(): void {
    const all = [...PROTECTED, OPEN];
    localStorage.setItem('thalassa.enc.cell.index', JSON.stringify(all.map((c) => c.id)));
    for (const c of all) localStorage.setItem(`thalassa.enc.cell:${c.id}`, JSON.stringify(c));
    localStorage.setItem('thalassa_enc_auto_publish', '1');
    for (const c of all) h.files.add(`${OLD}/${c.id}.geojson`);
    h.files.add(`${OLD}/OC-99-ZZ0299.geojson`); // an orphan with no record
}

async function launch(native: boolean) {
    h.native = native;
    vi.resetModules();
    const store = await import('../services/enc/EncCellStore');
    await store.storeReady();
    return store;
}

const ops = (op: string) => h.calls.filter((c) => c.op === op);

describe('the launch sweep', () => {
    beforeEach(() => {
        localStorage.clear();
        h.files.clear();
        h.calls.length = 0;
        h.sameUri = false;
        h.renameFails.clear();
        h.prepareChartStore.mockClear();
        h.purgeWebDiskCache.mockReset().mockResolvedValue(undefined);
        seed();
    });

    it('(a) the registry keeps only open charts and drops the auto-publish flag', async () => {
        await launch(true);
        for (const c of PROTECTED) expect(localStorage.getItem(`thalassa.enc.cell:${c.id}`)).toBeNull();
        expect(localStorage.getItem('thalassa.enc.cell:US5ZZ01M')).not.toBeNull();
        expect(JSON.parse(localStorage.getItem('thalassa.enc.cell.index')!)).toEqual(['US5ZZ01M']);
        expect(localStorage.getItem('thalassa_enc_auto_publish')).toBeNull();
    });

    it('(b) native: the open file moves after the getUri check, then ONE recursive rmdir removes the rest', async () => {
        await launch(true);
        expect(h.prepareChartStore).toHaveBeenCalledTimes(1);
        expect(ops('rename')).toEqual([
            {
                op: 'rename',
                from: 'DATA:enc-cells/US5ZZ01M.geojson',
                to: 'LIBRARY:Application Support/enc-open/US5ZZ01M.geojson',
            },
        ]);
        expect(ops('rmdir')).toEqual([{ op: 'rmdir', k: OLD, recursive: 'true' }]);
        expect(ops('deleteFile')).toEqual([]);
        expect([...h.files]).toEqual(['LIBRARY:Application Support/enc-open/US5ZZ01M.geojson']);
    });

    it('(b) native: deletes nothing when the platform says both folders are the same place', async () => {
        h.sameUri = true;
        await launch(true);
        expect(ops('rmdir')).toEqual([]);
        expect(ops('deleteFile')).toEqual([]);
        expect(ops('rename')).toEqual([]);
    });

    it('(b) native: a failed rename marks that record pending and its file is deleted only by the one rmdir', async () => {
        h.renameFails.add('enc-cells/US5ZZ01M.geojson');
        await launch(true);
        const kept = JSON.parse(localStorage.getItem('thalassa.enc.cell:US5ZZ01M')!);
        expect(kept.usage).toBe('pending');
        expect(ops('deleteFile')).toEqual([]);
        expect(ops('rmdir')).toHaveLength(1);
    });

    it('(b) web: per-file deletes of every file without an open record, the open one kept', async () => {
        await launch(false);
        expect(ops('rmdir')).toEqual([]);
        expect(ops('rename')).toEqual([]);
        expect(
            ops('deleteFile')
                .map((c) => c.k.split('/').pop())
                .sort(),
        ).toEqual([...PROTECTED.map((c) => `${c.id}.geojson`), 'OC-99-ZZ0299.geojson'].sort());
        expect([...h.files]).toEqual([`${OLD}/US5ZZ01M.geojson`]);
    });

    it('a second launch is a no-op', async () => {
        await launch(true);
        h.calls.length = 0;
        await launch(true);
        expect(ops('rename')).toEqual([]);
        expect(ops('rmdir')).toEqual([]);
        expect(ops('deleteFile')).toEqual([]);
    });

    it('a kill between the registry step and the file step finishes on the next launch', async () => {
        h.native = true;
        vi.resetModules();
        const meta = await import('../services/enc/EncCellMetadata');
        expect(meta.listCells().map((c) => c.id)).toEqual(['US5ZZ01M']);
        // Killed here: the files are still in Documents.
        expect(h.files.size).toBe(PROTECTED.length + 2);
        await launch(true);
        expect([...h.files]).toEqual(['LIBRARY:Application Support/enc-open/US5ZZ01M.geojson']);
    });

    it('(c) purges WebKit’s HTTP cache once on native, retries after a throw, never on the web', async () => {
        await launch(false);
        expect(h.purgeWebDiskCache).not.toHaveBeenCalled();

        h.purgeWebDiskCache.mockRejectedValueOnce(new Error('not implemented'));
        await launch(true);
        expect(h.purgeWebDiskCache).toHaveBeenCalledTimes(1);
        expect(localStorage.getItem('thalassa_webkit_cache_purged_v1')).toBeNull();

        await launch(true);
        expect(h.purgeWebDiskCache).toHaveBeenCalledTimes(2);
        expect(localStorage.getItem('thalassa_webkit_cache_purged_v1')).toBe('1');

        await launch(true);
        expect(h.purgeWebDiskCache).toHaveBeenCalledTimes(2);
    });
});
