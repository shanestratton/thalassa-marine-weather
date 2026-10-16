import { beforeEach, it, expect, vi } from 'vitest';
import { webcrypto } from 'node:crypto';
const f = vi.hoisted(() => ({
    files: new Map<string, string>(),
    scope: { key: 'user:A', userId: 'A', generation: 1 },
    writeWait: null as Promise<void> | null,
    permission: false,
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => f.scope,
    isAuthIdentityScopeCurrent: (s: unknown) => s === f.scope,
}));
vi.mock('@capacitor/filesystem', () => ({
    Directory: { Data: 'DATA' },
    Encoding: { UTF8: 'utf8' },
    Filesystem: {
        stat: vi.fn(async ({ path }: { path: string }) => {
            if (f.permission) throw Error('permission denied');
            const value = f.files.get(path);
            if (value === undefined) throw Object.assign(Error('missing'), { code: 'ENOENT' });
            return { type: 'file', size: value.length };
        }),
        readFile: vi.fn(async ({ path }: { path: string }) => ({ data: f.files.get(path) })),
        writeFile: vi.fn(async ({ path, data }: { path: string; data: string }) => {
            if (f.writeWait) await f.writeWait;
            f.files.set(path, data);
            return { uri: 'private' };
        }),
        rename: vi.fn(async ({ from, to }: { from: string; to: string }) => {
            const value = f.files.get(from);
            if (value === undefined) throw Error('missing');
            f.files.set(to, value);
            f.files.delete(from);
        }),
        readdir: vi.fn(async ({ path }: { path: string }) => ({
            files: [
                ...new Set(
                    [...f.files.keys()]
                        .filter((k) => k.startsWith(path + '/'))
                        .map((k) => k.slice(path.length + 1).split('/')[0]),
                ),
            ].map((name) => ({ name })),
        })),
    },
}));
import { Filesystem } from '@capacitor/filesystem';
import {
    saveAnnotation,
    loadAnnotations,
    changeAnnotation,
    removeAnnotation,
} from '../services/chartAnnotations/store';
const geometry = { type: 'Point' as const, coordinates: [1, 1] };
beforeEach(() => {
    vi.stubGlobal('crypto', webcrypto);
    f.files.clear();
    f.scope = { key: 'user:A', userId: 'A', generation: 1 };
    f.writeWait = null;
    f.permission = false;
    vi.clearAllMocks();
});
it('private Unicode drawings are account-hashed, integrity checked and preserve geometry', async () => {
    const saved = await saveAnnotation(geometry, 'Café 船', 0),
        row = saved.annotations[0];
    expect(row.geometry).toEqual(geometry);
    expect(row.label).toBe('Café 船');
    expect([...f.files.keys()]).toHaveLength(1);
    expect([...f.files.keys()][0]).toMatch(/^chart-annotations\/v1\/[a-f0-9]{32}\/library.json$/);
    expect(Filesystem.writeFile).toHaveBeenCalledWith(expect.objectContaining({ directory: 'DATA', encoding: 'utf8' }));
    expect(await loadAnnotations()).toEqual(saved);
    const path = [...f.files.keys()][0];
    f.files.set(path, f.files.get(path)!.replace('Café', 'Cafe'));
    await expect(loadAnnotations()).rejects.toThrow('integrity');
});
it('two stale library writers have one CAS winner and item revision is independently checked', async () => {
    const results = await Promise.allSettled([
        saveAnnotation(geometry, 'First', 0),
        saveAnnotation(geometry, 'Second', 0),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const current = await loadAnnotations(),
        row = current.annotations[0];
    await expect(changeAnnotation(row.id, 2, current.revision, { visible: false })).rejects.toThrow('changed');
    const changed = await changeAnnotation(row.id, row.revision, current.revision, { visible: false });
    expect(changed.annotations[0]).toMatchObject({ visible: false, revision: 2 });
    await expect(removeAnnotation(row.id, row.revision, changed.revision)).rejects.toThrow('changed');
    expect((await removeAnnotation(row.id, 2, changed.revision)).annotations).toHaveLength(0);
});
it('late old-account writes cannot publish or rename into a new account', async () => {
    const scope = f.scope;
    let release!: () => void;
    f.writeWait = new Promise((r) => (release = r));
    const pending = saveAnnotation(geometry, 'Private A', 0, scope);
    await vi.waitFor(() => expect(Filesystem.writeFile).toHaveBeenCalled());
    f.scope = { key: 'user:B', userId: 'B', generation: 2 };
    release();
    await expect(pending).rejects.toThrow('Sign in');
    f.writeWait = null;
    expect(Filesystem.rename).not.toHaveBeenCalled();
    expect((await loadAnnotations()).annotations).toEqual([]);
    f.scope = scope;
    expect((await loadAnnotations()).annotations).toEqual([]);
});
it('permission failure is not empty storage and a fifth library cannot grow the device bound', async () => {
    f.permission = true;
    await expect(loadAnnotations()).rejects.toThrow('unavailable');
    f.permission = false;
    for (let i = 0; i < 4; i++)
        f.files.set(`chart-annotations/v1/${String(i).repeat(32)}/library.json`, 'private other account');
    await expect(saveAnnotation(geometry, 'Fifth', 0)).rejects.toThrow('four');
    expect(Filesystem.writeFile).not.toHaveBeenCalled();
});
it('129th drawing refuses before filesystem commit', async () => {
    let current = await saveAnnotation(geometry, 'First', 0);
    for (let i = 1; i < 128; i++) current = await saveAnnotation(geometry, 'Other', current.revision);
    const writes = vi.mocked(Filesystem.writeFile).mock.calls.length;
    await expect(saveAnnotation(geometry, '129', current.revision)).rejects.toThrow('damaged');
    expect(Filesystem.writeFile).toHaveBeenCalledTimes(writes);
});

it('aggregate vertex budget cannot be multiplied across valid drawings', async () => {
    const line = { type: 'LineString' as const, coordinates: Array.from({ length: 256 }, (_, i) => [i / 1000, 1]) };
    let current = await saveAnnotation(line, 'Line', 0);
    for (let i = 1; i < 16; i++) current = await saveAnnotation(line, 'Line', current.revision);
    const writes = vi.mocked(Filesystem.writeFile).mock.calls.length;
    await expect(saveAnnotation(geometry, 'Extra', current.revision)).rejects.toThrow('vertex');
    expect(Filesystem.writeFile).toHaveBeenCalledTimes(writes);
});
