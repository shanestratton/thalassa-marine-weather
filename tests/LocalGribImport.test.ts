import { webcrypto, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { concatenate, message } from './fixtures/grib1Fixtures';
const io = vi.hoisted(() => ({
    copy: vi.fn(),
    read: vi.fn(),
    stat: vi.fn(),
    remove: vi.fn(),
    list: vi.fn(),
    decode: vi.fn(),
    files: new Map<string, Uint8Array>(),
    bytes: new Uint8Array(),
}));
vi.mock('@capacitor/core', () => ({ registerPlugin: () => ({ copy: io.copy }) }));
vi.mock('@capacitor/filesystem', () => ({
    Directory: { Data: 'DATA' },
    Filesystem: { readFile: io.read, stat: io.stat, deleteFile: io.remove, readdir: io.list },
}));
vi.mock('../services/weather/gribImportWorkerHost', () => ({ decodeGribInWorker: io.decode }));
const URL = 'file:///private/Inbox/fictional.grb';
const PREFIX = 'thalassa.grib.import.v1.';
const data = (lead = 6) =>
    new Uint8Array(
        concatenate(message(), message({ parameter: 34 }), message({ p1: lead }), message({ parameter: 34, p1: lead })),
    );
async function setup() {
    const scope = await import('../services/authIdentityScope');
    scope.setAuthIdentityScope('fictional-account-A');
    const wind = (await import('../stores/WindStore')).WindStore;
    const store = await import('../services/weather/localGribImport');
    return { scope, wind, store };
}
beforeEach(async () => {
    vi.resetModules();
    localStorage.clear();
    vi.stubGlobal('crypto', webcrypto);
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime('2026-01-01T03:00:00Z');
    io.files.clear();
    io.bytes = data();
    for (const fn of [io.copy, io.read, io.stat, io.remove, io.list, io.decode]) fn.mockReset();
    io.copy.mockImplementation(async ({ ownerNamespace }: { ownerNamespace: string }) => {
        const path = `grib-import/${ownerNamespace}/${randomUUID()}.grb`;
        io.files.set(path, io.bytes.slice());
        return { path, size: io.bytes.length };
    });
    io.stat.mockImplementation(async ({ path }: { path: string }) => {
        const value = io.files.get(path);
        if (!value) throw Error('not found');
        return { type: 'file', size: value.length };
    });
    io.read.mockImplementation(async ({ path }: { path: string }) => ({
        data: Buffer.from(io.files.get(path)!).toString('base64'),
    }));
    io.remove.mockImplementation(async ({ path }: { path: string }) => {
        io.files.delete(path);
    });
    io.list.mockImplementation(async ({ path }: { path: string }) => ({
        files: [...io.files.keys()]
            .filter((key) => key.startsWith(path + '/'))
            .map((key) => ({ name: key.slice(path.length + 1), type: 'file' })),
    }));
    const { decodeGrib1File } = await import('../services/weather/decodeGrib1Wind');
    io.decode.mockImplementation(async (buffer: ArrayBuffer, options: { isCurrent: () => boolean }) =>
        decodeGrib1File(buffer, options.isCurrent),
    );
});
afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});
describe('private attachment selection', () => {
    it('frames a new import once, never a restored selection, and removes only its owned raw file without enabling WAN', async () => {
        const { store, wind } = await setup();
        await store.importLocalGribUrl(URL);
        const path = wind.getState().localGribPath!,
            namespace = await store.gribOwnerNamespace();
        expect(store.consumeImportedGribView(path)).not.toBeNull();
        expect(store.consumeImportedGribView(path)).toBeNull();
        await store.restoreLocalGribSelection();
        expect(store.consumeImportedGribView(path)).toBeNull();
        const other = `grib-import/${'f'.repeat(32)}/${randomUUID()}.grb`;
        io.files.set(other, data());
        await store.removeSelectedImportedGrib();
        expect(localStorage.getItem(PREFIX + namespace)).toBeNull();
        expect(io.files.has(path)).toBe(false);
        expect(io.files.has(other)).toBe(true);
        expect(wind.getState()).toMatchObject({ isGlobalMode: false, localGribPath: null, grid: null });
    });
    it('copies to account-scoped Data, validates bytes, and persists only a hashed file identity', async () => {
        const { store, wind } = await setup(),
            file = await store.importLocalGribUrl(URL);
        const path = wind.getState().localGribPath!;
        expect(path).toMatch(/^grib-import\/[a-f0-9]{32}\/[a-f0-9-]{36}\.grb$/);
        expect(io.read).toHaveBeenCalledWith({ path, directory: 'DATA' });
        expect(wind.getState()).toMatchObject({ isGlobalMode: false, field: 'wind', loading: false, error: null });
        expect(file.wind!.stepHours).toEqual([0, 6]);
        const namespace = await store.gribOwnerNamespace(),
            raw = localStorage.getItem(PREFIX + namespace)!;
        expect(raw).not.toContain('Inbox');
        expect(JSON.parse(raw)).toMatchObject({
            owner: 'user:fictional-account-A',
            size: io.bytes.length,
            active: true,
        });
        expect(JSON.parse(raw).sha256).toMatch(/^[a-f0-9]{64}$/);
        expect((await store.loadSelectedImportedGrib())!.fingerprint).toBe(JSON.parse(raw).sha256);
    });
    it('a rejected attachment leaves the selected good file and metadata intact', async () => {
        const { store, wind } = await setup();
        await store.importLocalGribUrl(URL);
        const original = wind.getState().localGribPath!;
        io.bytes = new Uint8Array([80, 75, 3, 4, 5, 6, 7, 8]);
        await expect(store.importLocalGribUrl(URL)).rejects.toThrow();
        expect(wind.getState().localGribPath).toBe(original);
        expect([...io.files.keys()]).toEqual([original]);
    });
    it('replaces corrupt saved metadata with a new valid attachment', async () => {
        const { store } = await setup(),
            namespace = await store.gribOwnerNamespace();
        localStorage.setItem(PREFIX + namespace, 'invalid');
        await expect(store.importLocalGribUrl(URL)).resolves.toHaveProperty('wind');
    });
    it('rejects expired/future-only data and removes failed candidates', async () => {
        const { store } = await setup();
        io.bytes = new Uint8Array(concatenate(message(), message({ parameter: 34 })));
        await expect(store.importLocalGribUrl(URL)).rejects.toThrow(/expired|current time/);
        expect(io.files.size).toBe(0);
    });
    it('account switches cannot expose a selected raw file to another owner', async () => {
        const { store, wind, scope } = await setup();
        await store.importLocalGribUrl(URL);
        const path = wind.getState().localGribPath!;
        scope.setAuthIdentityScope('fictional-account-B');
        expect(store.currentImportedGrib()).toBeNull();
        await expect(store.loadImportedGrib(path)).rejects.toThrow(/current account/);
    });
    it('the installed native lifecycle synchronously hides the previous account grid', async () => {
        const { store, wind, scope } = await setup();
        store.installLocalGribImports();
        await store.importLocalGribUrl(URL);
        expect(wind.getState().grid).not.toBeNull();
        scope.setAuthIdentityScope('fictional-account-B');
        expect(wind.getState().grid).toBeNull();
        expect(wind.getState().localGribPath).toBeNull();
        expect(store.currentImportedGrib()).toBeNull();
    });
    it('rejects late native copies after an account switch and cleans only the owned candidate', async () => {
        const { store, scope, wind } = await setup();
        let finish!: (value: { path: string; size: number }) => void;
        io.copy.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = store.importLocalGribUrl(URL);
        await vi.waitFor(() => expect(io.copy).toHaveBeenCalled());
        const namespace = io.copy.mock.calls[0][0].ownerNamespace,
            path = `grib-import/${namespace}/${randomUUID()}.grb`;
        io.files.set(path, io.bytes.slice());
        scope.setAuthIdentityScope('fictional-account-B');
        finish({ path, size: io.bytes.length });
        await expect(pending).rejects.toThrow(/stopped/);
        expect(io.files.has(path)).toBe(false);
        expect(wind.getState().localGribPath).toBeNull();
    });
    it('bounds a stalled native copy and cleans its late owned result without publishing it', async () => {
        const { store, wind } = await setup();
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'setInterval', 'clearInterval'] });
        vi.setSystemTime('2026-01-01T03:00:00Z');
        let finish!: (value: { path: string; size: number }) => void;
        io.copy.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = store.importLocalGribUrl(URL);
        const rejected = expect(pending).rejects.toThrow(/timed out/);
        await vi.waitFor(() => expect(io.copy).toHaveBeenCalled());
        await vi.advanceTimersByTimeAsync(15000);
        await rejected;
        const namespace = io.copy.mock.calls[0][0].ownerNamespace,
            path = `grib-import/${namespace}/${randomUUID()}.grb`;
        io.files.set(path, io.bytes.slice());
        finish({ path, size: io.bytes.length });
        await vi.waitFor(() => expect(io.files.has(path)).toBe(false));
        expect(wind.getState().grid).toBeNull();
    });
    it('a changed saved file fails SHA256 restore without replacing it with another provider', async () => {
        const { store, wind } = await setup();
        await store.importLocalGribUrl(URL);
        const path = wind.getState().localGribPath!;
        io.files.get(path)![40] ^= 1;
        vi.resetModules();
        const again = await setup();
        await again.store.restoreLocalGribSelection();
        expect(again.wind.getState()).toMatchObject({ isGlobalMode: false, grid: null });
        expect(again.wind.getState().error).toMatch(/checksum/);
    });
    it('restore reports invalid metadata explicitly rather than swallowing the error', async () => {
        const { store, wind } = await setup(),
            namespace = await store.gribOwnerNamespace();
        localStorage.setItem(PREFIX + namespace, 'invalid');
        await store.restoreLocalGribSelection();
        expect(wind.getState().error).toMatch(/metadata is invalid/);
    });
    it('does not restore a file deselected in favor of provider mode', async () => {
        const { store, wind } = await setup();
        store.installLocalGribImports();
        await store.importLocalGribUrl(URL);
        wind.toggleMode();
        await new Promise((resolve) => setTimeout(resolve, 20));
        vi.resetModules();
        const again = await setup();
        await again.store.restoreLocalGribSelection();
        expect(again.wind.getState().isGlobalMode).toBe(true);
        expect(again.wind.getState().localGribPath).toBeNull();
    });
    it('cleans orphan files only inside the current owner namespace', async () => {
        const { store } = await setup(),
            namespace = await store.gribOwnerNamespace();
        const orphan = `grib-import/${namespace}/${randomUUID()}.grb`,
            other = `grib-import/${'f'.repeat(32)}/${randomUUID()}.grb`;
        io.files.set(orphan, data());
        io.files.set(other, data());
        await store.importLocalGribUrl(URL);
        expect(io.files.has(orphan)).toBe(false);
        expect(io.files.has(other)).toBe(true);
    });
    it('an explicit online choice cancels an in-flight replacement and prevents its late publish', async () => {
        const { store, wind } = await setup();
        store.installLocalGribImports();
        await store.importLocalGribUrl(URL);
        let finish!: (value: { path: string; size: number }) => void;
        io.copy.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = store.importLocalGribUrl(URL),
            rejected = expect(pending).rejects.toThrow(/stopped/);
        await vi.waitFor(() => expect(io.copy).toHaveBeenCalledTimes(2));
        wind.toggleMode();
        await rejected;
        const path = `grib-import/${io.copy.mock.calls[1][0].ownerNamespace}/${randomUUID()}.grb`;
        io.files.set(path, io.bytes.slice());
        finish({ path, size: io.bytes.length });
        await vi.waitFor(() => expect(io.files.has(path)).toBe(false));
        expect(wind.getState()).toMatchObject({ isGlobalMode: true, grid: null });
    });
    it.each([
        'https://example.org/file.grb',
        'file://evil.example/file.grb',
        'file:///tmp/x.grb?secret=1',
        'file:///tmp/x.zip',
        'file:///tmp/x.grb#fragment',
    ])('refuses nonlocal or non-GRIB URLs: %s', async (url) => {
        const { store } = await setup();
        await expect(store.importLocalGribUrl(url)).rejects.toThrow(/local GRIB/);
        expect(io.copy).not.toHaveBeenCalled();
    });
});
