import { Blob as NodeBlob, File as NodeFile } from 'node:buffer';
import { webcrypto } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
    native: false,
    copy: vi.fn(),
    picker: vi.fn(),
    fs: {
        stat: vi.fn(),
        readFile: vi.fn(),
        writeFile: vi.fn(),
        mkdir: vi.fn(),
        readdir: vi.fn(),
        rename: vi.fn(),
        deleteFile: vi.fn(),
        getUri: vi.fn(),
    },
}));
vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => mock.native, convertFileSrc: (value: string) => value },
    registerPlugin: () => ({ copyChart: mock.copy, pickChart: mock.picker }),
}));
vi.mock('@capacitor/filesystem', () => ({
    Filesystem: mock.fs,
    Directory: { Data: 'DATA' },
    Encoding: { UTF8: 'utf8' },
}));
const files = new Map<string, string | Blob>(),
    directories = new Set<string>();
function page(): Uint8Array<ArrayBuffer> {
    const bytes = new Uint8Array(512);
    bytes.set(new TextEncoder().encode('SQLite format 3\0'));
    new DataView(bytes.buffer).setUint16(16, 512, false);
    return bytes;
}
const pickedFile = (name = 'Personal anchorage.mbtiles', bytes = page()) => new File([bytes], name);
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((next) => {
        resolve = next;
    });
    return { promise, resolve };
};
const size = (value: string | Blob) =>
    typeof value === 'string' ? new TextEncoder().encode(value).length : value.size;
function move({ from, to }: { from: string; to: string }) {
    const value = files.get(from);
    if (value === undefined) throw new Error('File not found.');
    files.set(to, value);
    files.delete(from);
}
async function setup() {
    const identity = await import('../services/authIdentityScope');
    identity.setAuthIdentityScope('account-a');
    return { identity, service: await import('../services/charts/localChartLibrary') };
}
beforeEach(() => {
    vi.resetModules();
    vi.resetAllMocks();
    vi.useRealTimers();
    localStorage.clear();
    files.clear();
    directories.clear();
    mock.native = false;
    vi.stubGlobal('Blob', NodeBlob);
    vi.stubGlobal('File', NodeFile);
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal('fetch', vi.fn());
    mock.fs.stat.mockImplementation(async ({ path }: { path: string }) => {
        if (directories.has(path)) return { type: 'directory', size: 0 };
        const value = files.get(path);
        if (value === undefined) throw new Error('File not found.');
        return { type: 'file', size: size(value) };
    });
    mock.fs.readFile.mockImplementation(async ({ path }: { path: string }) => {
        if (!files.has(path)) throw new Error('File not found.');
        return { data: files.get(path) };
    });
    mock.fs.writeFile.mockImplementation(async ({ path, data }: { path: string; data: string | Blob }) => {
        files.set(path, data);
        return { uri: path };
    });
    mock.fs.mkdir.mockImplementation(async ({ path }: { path: string }) => {
        if (directories.has(path)) throw new Error('Directory exists.');
        directories.add('chart-library');
        directories.add(path);
    });
    mock.fs.readdir.mockImplementation(async ({ path }: { path: string }) => {
        if (!directories.has(path)) throw new Error('Directory not found.');
        const prefix = path + '/';
        return {
            files: [
                ...[...directories]
                    .filter((name) => name.startsWith(prefix) && !name.slice(prefix.length).includes('/'))
                    .map((name) => ({ name: name.slice(prefix.length), type: 'directory', size: 0 })),
                ...[...files]
                    .filter(([name]) => name.startsWith(prefix) && !name.slice(prefix.length).includes('/'))
                    .map(([name, value]) => ({ name: name.slice(prefix.length), type: 'file', size: size(value) })),
            ],
        };
    });
    mock.fs.rename.mockImplementation(async (request: { from: string; to: string }) => {
        move(request);
    });
    mock.fs.deleteFile.mockImplementation(async ({ path }: { path: string }) => {
        files.delete(path);
    });
});
describe('retained private chart storage', () => {
    it('releases a cancelled picker wait before native completion and cleans the exact late private copy', async () => {
        const { service } = await setup();
        mock.native = true;
        const picker = deferred<{ path: string; size: number; name: string }>();
        mock.picker.mockReturnValue(picker.promise);
        const controller = new AbortController();
        const pending = service
            .importLocalChart('native-picker', 'own', { signal: controller.signal })
            .catch((error: unknown) => error);
        await vi.waitFor(() => expect(mock.picker).toHaveBeenCalledOnce());
        const namespace = mock.picker.mock.calls[0][0].ownerNamespace;
        controller.abort();
        expect(await pending).toBeInstanceOf(Error);
        expect(await service.listLocalCharts()).toEqual([]);
        const path = `chart-library/${namespace}/00000000-0000-4000-8000-000000000001.kap`;
        files.set(path, new Blob(['BSB/own fixture']));
        picker.resolve({ path, size: 15, name: 'own.kap' });
        await vi.waitFor(() => expect(files.has(path)).toBe(false));
    });
    it('uses a charged base64 fallback only for real Blob preparation refusal and verifies original bytes', async () => {
        const { service } = await setup();
        const write = mock.fs.writeFile.getMockImplementation()!;
        mock.fs.writeFile.mockImplementation(async (request: { path: string; data: string | Blob }) => {
            if (request.data instanceof Blob)
                throw new Error('Error preparing Blob/File data to be stored in object store');
            return write(request);
        });
        const chart = await service.importLocalChart(pickedFile(), 'own');
        expect(chart.webEncoding).toBe('base64');
        expect([...files.keys()].some((path) => path.endsWith('.mbtiles.base64'))).toBe(true);
        expect((await service.readLocalChart(chart.id)).bytes).toEqual(page());
        expect(await service.listLocalCharts()).toEqual([chart]);
        await service.removeLocalChart(chart.id);
        expect([...files.keys()].some((path) => path.endsWith('.base64'))).toBe(false);
    });
    it('does not retry quota or arbitrary disk failures as a different storage format', async () => {
        const { service } = await setup();
        mock.fs.writeFile.mockRejectedValueOnce(new Error('QuotaExceededError'));
        await expect(service.importLocalChart(pickedFile(), 'own')).rejects.toThrow('Quota');
        expect(mock.fs.writeFile).toHaveBeenCalledTimes(1);
        expect([...files.keys()].some((path) => path.endsWith('.base64'))).toBe(false);
    });
    it('charges existing base64 characters conservatively without reading another owner', async () => {
        const { service } = await setup(),
            other = 'c'.repeat(32);
        directories.add('chart-library');
        directories.add(`chart-library/${other}`);
        const stat = mock.fs.readdir.getMockImplementation()!;
        mock.fs.readdir.mockImplementation(async (request: { path: string }) =>
            request.path === `chart-library/${other}`
                ? { files: [{ name: 'old.kap.base64', type: 'file', size: 32 * 1024 * 1024 }] }
                : stat(request),
        );
        await expect(service.importLocalChart(pickedFile(), 'own')).rejects.toThrow('full');
        expect(mock.fs.readFile).not.toHaveBeenCalled();
    });
    it('aborts an unresolved native stream on A/B/A and releases the queued storage operation', async () => {
        const { service, identity } = await setup();
        const chart = await service.importLocalChart(pickedFile(), 'own');
        mock.native = true;
        mock.fs.getUri.mockResolvedValue({ uri: 'capacitor://localhost/chart' });
        const cancel = vi.fn();
        const body = new ReadableStream<Uint8Array>({ pull: () => new Promise<void>(() => {}), cancel });
        const fetchMock = vi.mocked(fetch);
        fetchMock.mockResolvedValue(new Response(body, { status: 200, headers: { 'content-length': '512' } }));
        const pending = service.readLocalChart(chart.id).catch((error: unknown) => error);
        await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
        identity.setAuthIdentityScope('account-b');
        identity.setAuthIdentityScope('account-a');
        expect(await pending).toBeInstanceOf(Error);
        expect(cancel).toHaveBeenCalledTimes(1);
        expect((fetchMock.mock.calls[0][1] as RequestInit).signal?.aborted).toBe(true);
        expect(await service.listLocalCharts()).toEqual([chart]);
    });
    it('rolls back an index accepted just before a queued final-cleanup account transition', async () => {
        const { service, identity } = await setup();
        const remove = mock.fs.deleteFile.getMockImplementation()!;
        let changed = false;
        mock.fs.deleteFile.mockImplementation(async (request: { path: string }) => {
            await remove(request);
            if (!changed && request.path.endsWith('/index.pending')) {
                changed = true;
                queueMicrotask(() => {
                    identity.setAuthIdentityScope('account-b');
                    identity.setAuthIdentityScope('account-a');
                });
            }
        });
        await expect(service.importLocalChart(pickedFile(), 'own')).rejects.toThrow('stopped');
        expect(await service.listLocalCharts()).toEqual([]);
        expect([...files.keys()].some((path) => path.endsWith('.mbtiles'))).toBe(false);
    });
    it('keeps a failed unlink listed so the owner can retry removal', async () => {
        const { service } = await setup();
        const chart = await service.importLocalChart(pickedFile(), 'own');
        const remove = mock.fs.deleteFile.getMockImplementation()!;
        mock.fs.deleteFile.mockImplementation(async (request: { path: string }) => {
            if (request.path.endsWith('.mbtiles')) throw new Error('Disk temporarily busy');
            await remove(request);
        });
        await expect(service.removeLocalChart(chart.id)).rejects.toThrow('temporarily busy');
        expect(await service.listLocalCharts()).toEqual([chart]);
    });
    it('cleans a native copy arriving after its real 15-second timeout without publishing it', async () => {
        const { service } = await setup();
        mock.native = true;
        const copy = deferred<{ path: string; size: number }>();
        mock.copy.mockReturnValue(copy.promise);
        const pending = service
            .importLocalChart({ url: 'file:///Inbox/chart.mbtiles', name: 'chart.mbtiles' }, 'own')
            .catch((error: unknown) => error);
        await vi.waitFor(() => expect(mock.copy).toHaveBeenCalledOnce());
        const owner = mock.copy.mock.calls[0][0].ownerNamespace;
        const path = `chart-library/${owner}/00000000-0000-4000-8000-000000000001.mbtiles`;
        // A real-clock timeout, bounded below the suite's existing ceiling.
        const result = await pending;
        expect((result as Error).message).toContain('timed out');
        files.set(path, new Blob([page()]));
        copy.resolve({ path, size: 512 });
        await vi.waitFor(() => expect(files.has(path)).toBe(false));
        expect(mock.fs.writeFile).not.toHaveBeenCalled();
    }, 18_000);
    it('lists a closed retained chart without fetch, SQLite or a Cache file and preserves Unicode names', async () => {
        const { service } = await setup();
        const chart = await service.importLocalChart(pickedFile('Île personnelle.mbtiles'), 'own');
        expect(await service.listLocalCharts()).toEqual([chart]);
        expect(chart.sha256).toMatch(/^[a-f0-9]{64}$/);
        expect(mock.fs.getUri).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
        expect(mock.fs.stat.mock.calls.every(([call]) => call.directory === 'DATA')).toBe(true);
        expect([...files.keys()].every((path) => path.startsWith('chart-library/'))).toBe(true);
        const stored = [...files.values()].find((value) => value instanceof Blob);
        expect(stored).toBeInstanceOf(Blob);
        expect(stored).not.toBeInstanceOf(File);
    });
    it('isolates A/B/A indexes and retires an earlier A byte proof', async () => {
        const { service, identity } = await setup();
        const chart = await service.importLocalChart(pickedFile(), 'open');
        const proof = await service.readLocalChart(chart.id);
        expect(proof.isCurrent()).toBe(true);
        identity.setAuthIdentityScope('account-b');
        expect(await service.listLocalCharts()).toEqual([]);
        identity.setAuthIdentityScope('account-a');
        expect(await service.listLocalCharts()).toEqual([chart]);
        expect(proof.isCurrent()).toBe(false);
    });
    it('refuses false rights and oversized files before any write', async () => {
        const { service } = await setup();
        expect(() => service.importLocalChart(pickedFile(), 'licensed' as 'own')).toThrow('own');
        const file = pickedFile();
        Object.defineProperty(file, 'size', { value: 32 * 1024 * 1024 + 1 });
        await expect(service.importLocalChart(file, 'own')).rejects.toThrow('32 MiB');
        expect(mock.fs.writeFile).not.toHaveBeenCalled();
    });
    it('refuses a renamed non-chart and removes its uncommitted private copy', async () => {
        const { service } = await setup();
        await expect(
            service.importLocalChart(pickedFile('not-real.mbtiles', new Uint8Array(512)), 'own'),
        ).rejects.toThrow('SQLite');
        expect(files.size).toBe(0);
    });
    it('holds a corrupt owner index instead of replacing it with an empty library', async () => {
        const { service } = await setup();
        await service.importLocalChart(pickedFile(), 'own');
        const index = [...files.keys()].find((path) => path.endsWith('/index.json'))!;
        files.set(index, '{bad');
        const writes = mock.fs.writeFile.mock.calls.length;
        await expect(service.listLocalCharts()).rejects.toThrow();
        await expect(service.importLocalChart(pickedFile(), 'own')).rejects.toThrow();
        expect(mock.fs.writeFile).toHaveBeenCalledTimes(writes);
    });
    it('checks actual saved bytes against the retained checksum before returning a reader', async () => {
        const { service } = await setup();
        const chart = await service.importLocalChart(pickedFile(), 'own');
        const path = [...files.keys()].find((path) => path.endsWith('.mbtiles'))!;
        const changed = page();
        changed[511] = 2;
        files.set(path, new Blob([changed]));
        await expect(service.readLocalChart(chart.id)).rejects.toThrow('checksum');
    });
    it('counts another account’s retained files toward the physical global quota without reading their contents', async () => {
        const { service } = await setup();
        const other = 'b'.repeat(32);
        directories.add('chart-library');
        directories.add(`chart-library/${other}`);
        for (let i = 0; i < 8; i++) files.set(`chart-library/${other}/${i}.mbtiles`, new Blob([page()]));
        await expect(service.importLocalChart(pickedFile(), 'own')).rejects.toThrow('8 files');
        expect(mock.fs.readFile).not.toHaveBeenCalled();
        expect(mock.fs.writeFile).not.toHaveBeenCalled();
    });
    it('cleans a late native copy after account A/B/A and never commits its index', async () => {
        const { service, identity } = await setup();
        mock.native = true;
        const copy = deferred<{ path: string; size: number }>();
        mock.copy.mockReturnValue(copy.promise);
        const pending = service
            .importLocalChart({ url: 'file:///Inbox/chart.mbtiles', name: 'chart.mbtiles' }, 'own')
            .catch((error: unknown) => error);
        await vi.waitFor(() => expect(mock.copy).toHaveBeenCalledTimes(1));
        const owner = mock.copy.mock.calls[0][0].ownerNamespace;
        identity.setAuthIdentityScope('account-b');
        identity.setAuthIdentityScope('account-a');
        const path = `chart-library/${owner}/00000000-0000-4000-8000-000000000001.mbtiles`;
        files.set(path, new Blob([page()]));
        copy.resolve({ path, size: 512 });
        expect(await pending).toBeInstanceOf(Error);
        expect(files.has(path)).toBe(false);
        expect(mock.fs.writeFile).not.toHaveBeenCalled();
    });
    it('does not delete a forged native path belonging to another owner', async () => {
        const { service } = await setup();
        mock.native = true;
        const path = `chart-library/${'b'.repeat(32)}/00000000-0000-4000-8000-000000000001.mbtiles`;
        files.set(path, new Blob([page()]));
        mock.copy.mockResolvedValue({ path, size: 512 });
        await expect(
            service.importLocalChart({ url: 'file:///Inbox/chart.mbtiles', name: 'chart.mbtiles' }, 'own'),
        ).rejects.toThrow('Invalid');
        expect(files.has(path)).toBe(true);
        expect(mock.fs.deleteFile).not.toHaveBeenCalled();
    });
    it('rolls back a rename that completes after retirement before a queued A read can observe it', async () => {
        const { service, identity } = await setup();
        const gate = deferred<void>();
        mock.fs.rename.mockImplementationOnce(async (request: { from: string; to: string }) => {
            await gate.promise;
            move(request);
        });
        const pending = service.importLocalChart(pickedFile(), 'own').catch((error: unknown) => error);
        await vi.waitFor(() => expect(mock.fs.rename).toHaveBeenCalledTimes(1));
        identity.setAuthIdentityScope('account-b');
        identity.setAuthIdentityScope('account-a');
        const freshList = service.listLocalCharts();
        gate.resolve();
        expect(await pending).toBeInstanceOf(Error);
        expect(await freshList).toEqual([]);
        expect([...files.keys()].filter((path) => path.endsWith('.mbtiles'))).toEqual([]);
    });
    it('retirement while a closed sheet’s byte read is pending removes the uncommitted copy', async () => {
        const { service } = await setup();
        let live = true;
        const gate = deferred<void>();
        const read = mock.fs.readFile.getMockImplementation()!;
        mock.fs.readFile.mockImplementation(async (request: { path: string }) => {
            if (request.path.endsWith('.mbtiles')) await gate.promise;
            return read(request);
        });
        const pending = service
            .importLocalChart(pickedFile(), 'own', { isCurrent: () => live })
            .catch((error: unknown) => error);
        await vi.waitFor(() => expect(mock.fs.readFile).toHaveBeenCalled());
        live = false;
        gate.resolve();
        expect(await pending).toBeInstanceOf(Error);
        expect([...files.keys()].some((path) => path.endsWith('.mbtiles'))).toBe(false);
    });
    it('retires an acquired byte reader immediately when removal is requested', async () => {
        const { service } = await setup();
        const chart = await service.importLocalChart(pickedFile(), 'own'),
            proof = await service.readLocalChart(chart.id);
        const pending = service.removeLocalChart(chart.id);
        expect(proof.isCurrent()).toBe(false);
        await pending;
        expect(await service.listLocalCharts()).toEqual([]);
    });
    it('refuses a stale queued removal before unlinking an immutable saved chart', async () => {
        const { service, identity } = await setup();
        const chart = await service.importLocalChart(pickedFile(), 'own');
        const pending = service.removeLocalChart(chart.id).catch((error: unknown) => error);
        identity.setAuthIdentityScope('account-b');
        identity.setAuthIdentityScope('account-a');
        expect(await pending).toBeInstanceOf(Error);
        expect(await service.listLocalCharts()).toEqual([chart]);
    });
});
