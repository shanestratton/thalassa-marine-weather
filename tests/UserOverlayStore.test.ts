import { beforeEach, it, expect, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
const f = vi.hoisted(() => ({
    files: new Map<string, string>(),
    scope: { key: 'user:A', generation: 1, userId: 'A' },
    listeners: new Set<() => void>(),
    renameWait: null as Promise<void> | null,
    statError: null as Error | null,
    native: true,
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => f.scope,
    isAuthIdentityScopeCurrent: (s: unknown) => s === f.scope,
    subscribeAuthIdentityScope: (fn: () => void) => {
        f.listeners.add(fn);
        return () => f.listeners.delete(fn);
    },
}));
vi.mock('@capacitor/core', () => ({ Capacitor: { isNativePlatform: () => f.native } }));
vi.mock('@capacitor/filesystem', () => ({
    Directory: { Data: 'DATA' },
    Encoding: { UTF8: 'utf8' },
    Filesystem: {
        stat: vi.fn(async ({ path }: { path: string }) => {
            if (f.statError) throw f.statError;
            if (!f.files.has(path)) throw Object.assign(Error('missing'), { code: 'ENOENT' });
            const value = f.files.get(path)!;
            return { type: 'file', size: f.native ? new TextEncoder().encode(value).length : value.length };
        }),
        readFile: vi.fn(async ({ path }: { path: string }) => ({ data: f.files.get(path) })),
        writeFile: vi.fn(async ({ path, data }: { path: string; data: string }) => {
            f.files.set(path, data);
        }),
        rename: vi.fn(async ({ from, to }: { from: string; to: string }) => {
            if (f.renameWait) await f.renameWait;
            const text = f.files.get(from);
            if (text === undefined) throw Error('missing');
            f.files.set(to, text);
            f.files.delete(from);
        }),
        deleteFile: vi.fn(async ({ path }: { path: string }) => {
            f.files.delete(path);
        }),
        readdir: vi.fn(async ({ path }: { path: string }) => {
            const names = [
                ...new Set(
                    [...f.files.keys()]
                        .filter((k) => k.startsWith(path + '/'))
                        .map((k) => k.slice(path.length + 1).split('/')[0]),
                ),
            ];
            if (!names.length) throw Object.assign(Error('missing'), { code: 'ENOENT' });
            return { files: names.map((name) => ({ name })) };
        }),
    },
}));
import { Filesystem } from '@capacitor/filesystem';
import { normalizeOverlay } from '../services/userOverlays/model';
import {
    saveUserOverlay,
    loadUserOverlays,
    readUserOverlay,
    updateUserOverlay,
    removeUserOverlay,
} from '../services/userOverlays/store';
const preview = (x = 0) => ({
    ...normalizeOverlay({ type: 'Point', coordinates: [x, 1] }),
    format: 'GeoJSON' as const,
});
beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    f.files.clear();
    f.scope = { key: 'user:A', generation: 1, userId: 'A' };
    f.renameWait = null;
    f.statError = null;
    f.native = true;
    vi.clearAllMocks();
});
it('writes only normalized content under a hashed Directory.Data account namespace, alerts off', async () => {
    const row = await saveUserOverlay(preview(), 'Private');
    expect(row).toMatchObject({ visible: true, alerts: false, features: 1, polygons: 0 });
    expect(
        [...f.files.keys()].every((k) => /^user-overlays\/v1\/[a-f0-9]{32}\/(index\.json|[a-f0-9]{64}\.json)$/.test(k)),
    ).toBe(true);
    expect(Filesystem.writeFile).toHaveBeenCalledWith(expect.objectContaining({ directory: 'DATA' }));
    expect(await readUserOverlay(row)).toEqual(preview().data);
    expect((await loadUserOverlays()).position).toBe('boat');
});
it('exact duplicate and eleven-file capacity refuse, removal reclaims only owned file', async () => {
    const first = await saveUserOverlay(preview(), 'First');
    await expect(saveUserOverlay(preview(), 'duplicate')).rejects.toThrow('already');
    for (let i = 1; i < 10; i++) await saveUserOverlay(preview(i), 'Other');
    await expect(saveUserOverlay(preview(11), 'Eleventh')).rejects.toThrow('limit');
    await removeUserOverlay(first.id);
    expect((await loadUserOverlays()).overlays).toHaveLength(9);
    expect([...f.files.keys()].some((k) => k.endsWith(first.id + '.json'))).toBe(false);
});
it('account namespaces isolate reads and a late old-account rename never deletes a committed file', async () => {
    const scope = f.scope;
    const a = await saveUserOverlay(preview(), 'A');
    let release!: () => void;
    f.renameWait = new Promise<void>((r) => (release = r));
    const pending = updateUserOverlay(a.id, { alerts: true }, scope);
    await vi.waitFor(() => expect(Filesystem.rename).toHaveBeenCalledTimes(2));
    f.scope = { key: 'user:B', generation: 2, userId: 'B' };
    release();
    await expect(pending).rejects.toThrow('Sign in');
    f.renameWait = null;
    expect((await loadUserOverlays()).overlays).toEqual([]);
    f.scope = scope;
    expect((await loadUserOverlays()).overlays[0].alerts).toBe(true);
    expect(await readUserOverlay(a, scope)).toEqual(preview().data);
});
it('hash, byte count, malformed index and unavailable storage fail closed', async () => {
    const row = await saveUserOverlay(preview(), 'A');
    const dataPath = [...f.files.keys()].find((k) => k.endsWith(row.id + '.json'))!;
    f.files.set(dataPath, f.files.get(dataPath)!.replace('[0,1]', '[1,1]'));
    await expect(readUserOverlay(row)).rejects.toThrow('integrity');
    f.files.set([...f.files.keys()].find((k) => k.endsWith('index.json'))!, '{"schema":1}');
    await expect(loadUserOverlays()).rejects.toThrow('damaged');
    f.statError = Error('permission denied');
    await expect(loadUserOverlays()).rejects.toThrow('unavailable');
    expect(Filesystem.writeFile).toHaveBeenCalledTimes(2);
});
it('reconciles only this account’s immutable orphan before next save', async () => {
    await saveUserOverlay(preview(), 'A');
    const root = [...f.files.keys()][0].split('/').slice(0, 3).join('/'),
        orphan = root + '/' + 'a'.repeat(64) + '.json',
        foreign = 'user-overlays/v1/' + 'b'.repeat(32) + '/' + 'c'.repeat(64) + '.json';
    f.files.set(orphan, 'orphan');
    f.files.set(foreign, 'foreign');
    await saveUserOverlay(preview(2), 'B');
    expect(f.files.has(orphan)).toBe(false);
    expect(f.files.get(foreign)).toBe('foreign');
});
it('refuses a fifth private library and stale caller operations before writes', async () => {
    for (let i = 0; i < 4; i++) f.files.set('user-overlays/v1/' + String(i).repeat(32) + '/index.json', '{}');
    await expect(saveUserOverlay(preview(), 'A')).rejects.toThrow('four private');
    expect(Filesystem.writeFile).not.toHaveBeenCalled();
    await expect(saveUserOverlay(preview(), 'stale', { ...f.scope, generation: 0 })).rejects.toThrow('Sign in');
});

it('aggregate feature budget cannot be multiplied across individually valid files', async () => {
    const collection = (x: number) => ({
        ...normalizeOverlay({
            type: 'FeatureCollection',
            features: Array.from({ length: 1001 }, () => ({
                type: 'Feature',
                geometry: { type: 'Point', coordinates: [x, 1] },
                properties: { name: 'point' },
            })),
        }),
        format: 'GeoJSON' as const,
    });
    await saveUserOverlay(collection(1), 'First');
    await expect(saveUserOverlay(collection(2), 'Second')).rejects.toThrow('feature');
    expect((await loadUserOverlays()).overlays).toHaveLength(1);
});

it.each([true, false])('reads Unicode labels with native=%s stat units and exact UTF-8 hash proof', async (native) => {
    f.native = native;
    const value = {
        ...normalizeOverlay({
            type: 'Feature',
            properties: { name: 'Café 船' },
            geometry: { type: 'Point', coordinates: [1, 1] },
        }),
        format: 'GeoJSON' as const,
    };
    const row = await saveUserOverlay(value, 'Private');
    expect(await readUserOverlay(row)).toEqual(value.data);
    const path = [...f.files.keys()].find((k) => k.endsWith(row.id + '.json'))!;
    f.files.set(path, f.files.get(path)!.replace('Café', 'Cafe'));
    await expect(readUserOverlay(row)).rejects.toThrow();
});

it('verified data cannot bypass aggregate caps through corrupted index counts', async () => {
    const row = await saveUserOverlay(preview(), 'Private');
    await expect(readUserOverlay({ ...row, features: 2 })).rejects.toThrow('metadata');
    await expect(readUserOverlay({ ...row, vertices: 2 })).rejects.toThrow('metadata');
    await expect(readUserOverlay({ ...row, polygons: 1 })).rejects.toThrow('metadata');
});
