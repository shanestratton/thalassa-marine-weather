import { webcrypto } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const io = vi.hoisted(() => ({ copy: vi.fn(), stat: vi.fn(), read: vi.fn(), remove: vi.fn() }));
vi.mock('@capacitor/core', () => ({ registerPlugin: () => ({ copyGpx: io.copy }) }));
vi.mock('@capacitor/filesystem', () => ({
    Directory: { Data: 'DATA' },
    Encoding: { UTF8: 'utf8' },
    Filesystem: { stat: io.stat, readFile: io.read, deleteFile: io.remove },
}));
const XML = '<gpx version="1.1"><rte><rtept lat="30" lon="-60"/><rtept lat="31" lon="-60"/></rte></gpx>';
const URL = 'file:///private/Inbox/example.gpx';
const ID = '11111111-1111-4111-8111-111111111111';
async function setup() {
    const scope = await import('../services/authIdentityScope');
    scope.setAuthIdentityScope('fictional-a');
    return {
        scope,
        native: await import('../services/nativeOpenedGpx'),
        queue: await import('../services/openedGpxQueue'),
    };
}
beforeEach(() => {
    vi.resetModules();
    vi.stubGlobal('crypto', webcrypto);
    vi.stubGlobal(
        'fetch',
        vi.fn(() => {
            throw Error('No network permitted');
        }),
    );
    for (const fn of Object.values(io)) fn.mockReset();
    io.copy.mockImplementation(async ({ ownerNamespace }) => ({
        path: `gpx-import/${ownerNamespace}/${ID}.gpx`,
        size: new TextEncoder().encode(XML).byteLength,
    }));
    io.stat.mockResolvedValue({ type: 'file', size: new TextEncoder().encode(XML).byteLength });
    io.read.mockResolvedValue({ data: XML });
    io.remove.mockResolvedValue(undefined);
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
});
it('copies only into the current owner namespace, stages a preview and deletes the temporary source without WAN', async () => {
    const { native, queue } = await setup();
    await native.openNativeGpx(URL);
    const file = queue.peekOpenedGpx()!;
    expect(file.name).toBe('Opened route.gpx');
    expect(file.size).toBe(new TextEncoder().encode(XML).byteLength);
    expect(io.remove).toHaveBeenCalledTimes(1);
    expect(io.remove.mock.calls[0][0].path).toMatch(/^gpx-import\/[a-f0-9]{32}\//);
    expect(queue.peekOpenedGpx()).toBe(file); // a transient preview remount must not lose the handoff
    queue.finishOpenedGpx(new File(['x'], 'other.gpx'));
    expect(queue.peekOpenedGpx()).toBe(file);
    queue.finishOpenedGpx(file);
    expect(queue.peekOpenedGpx()).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
});
it.each([
    'https://example.test/route.gpx',
    'file://server/route.gpx',
    'file:///route.gpx?x=1',
    'file:///route.gpx#x',
    'file:///route.xml',
    'file:///route.gpx/',
])('refuses non-local or ambiguous attachment %s', async (url) => {
    const { native } = await setup();
    expect(native.isLocalGpxUrl(url)).toBe(false);
    await expect(native.openNativeGpx(url)).rejects.toThrow();
    expect(io.copy).not.toHaveBeenCalled();
});
it('removes a late native copy after an account change without exposing or opening its content', async () => {
    const { native, scope, queue } = await setup();
    let resolve!: (value: { path: string; size: number }) => void;
    io.copy.mockImplementation(
        ({ ownerNamespace }) =>
            new Promise((done) => {
                resolve = () => done({ path: `gpx-import/${ownerNamespace}/${ID}.gpx`, size: XML.length });
            }),
    );
    const result = native.openNativeGpx(URL).catch((error) => error);
    await vi.waitFor(() => expect(io.copy).toHaveBeenCalled());
    scope.setAuthIdentityScope('fictional-b');
    resolve({ path: '', size: 0 });
    expect(await result).toBeInstanceOf(Error);
    expect(queue.peekOpenedGpx()).toBeNull();
    expect(io.read).not.toHaveBeenCalled();
    expect(io.remove).toHaveBeenCalledTimes(1);
});
it('rejects changed sizes and XML entity declarations before the GPX preview', async () => {
    const { native, queue } = await setup();
    io.stat.mockResolvedValueOnce({ type: 'file', size: 1 });
    await expect(native.openNativeGpx(URL)).rejects.toThrow('changed');
    expect(queue.peekOpenedGpx()).toBeNull();
    const unsafe = '<!DOCTYPE gpx [<!ENTITY x "expanded">]><gpx>&x;</gpx>';
    io.copy.mockImplementation(async ({ ownerNamespace }) => ({
        path: `gpx-import/${ownerNamespace}/${ID}.gpx`,
        size: unsafe.length,
    }));
    io.stat.mockResolvedValue({ type: 'file', size: unsafe.length });
    io.read.mockResolvedValue({ data: unsafe });
    await expect(native.openNativeGpx(URL)).rejects.toThrow('XML');
    expect(queue.peekOpenedGpx()).toBeNull();
    expect(io.remove).toHaveBeenCalledTimes(2);
});
it('does not read or delete a native response naming another owner namespace', async () => {
    const { native } = await setup();
    io.copy.mockResolvedValue({ path: `gpx-import/${'f'.repeat(32)}/${ID}.gpx`, size: XML.length });
    await expect(native.openNativeGpx(URL)).rejects.toThrow('Invalid GPX copy');
    expect(io.read).not.toHaveBeenCalled();
    expect(io.remove).not.toHaveBeenCalled();
});
it('bounds a stalled native copy and removes its late owned result without publishing a preview', async () => {
    const { native, queue } = await setup();
    let finish!: () => void;
    io.copy.mockImplementation(
        ({ ownerNamespace }) =>
            new Promise((done) => {
                finish = () => done({ path: `gpx-import/${ownerNamespace}/${ID}.gpx`, size: XML.length });
            }),
    );
    vi.useFakeTimers();
    const result = native.openNativeGpx(URL).catch((error) => error);
    await vi.waitFor(() => expect(io.copy).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(15_000);
    expect((await result).message).toContain('timed out');
    finish();
    await vi.waitFor(() => expect(io.remove).toHaveBeenCalledTimes(1));
    expect(queue.peekOpenedGpx()).toBeNull();
    expect(io.read).not.toHaveBeenCalled();
});
