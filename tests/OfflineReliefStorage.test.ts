import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    RELIEF_OFFLINE_DIRECTORY,
    RELIEF_OFFLINE_LIMIT_BYTES,
    RELIEF_TILE_MAX_BYTES,
    RELIEF_WEB_CACHE,
    planReliefArea,
    reliefTile,
} from '../services/offlineReliefPlan';

const state = vi.hoisted(() => ({
    native: true,
    satellite: false,
    files: new Map<string, { data: string; size: number }>(),
    http: vi.fn(),
    writes: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => state.native,
        convertFileSrc: (s: string) => s.replace('file:///', 'capacitor://localhost/_capacitor_file_/'),
    },
    CapacitorHttp: { get: state.http },
}));
vi.mock('@capacitor/filesystem', () => ({
    Directory: { Data: 'DATA' },
    Encoding: { UTF8: 'utf8' },
    Filesystem: {
        mkdir: vi.fn(async () => undefined),
        getUri: vi.fn(async ({ path }: { path: string }) => ({ uri: `file:///data/${path}` })),
        readdir: vi.fn(async () => ({
            files: [...state.files].map(([path, file]) => ({
                name: path.split('/').at(-1),
                type: 'file',
                size: file.size,
            })),
        })),
        readFile: vi.fn(async ({ path }: { path: string }) => ({ data: state.files.get(path)?.data })),
        writeFile: vi.fn(async (o: { path: string; data: string; encoding?: string; directory: string }) => {
            state.writes(o);
            state.files.set(o.path, {
                data: o.data,
                size: o.encoding === 'utf8' ? o.data.length : atob(o.data).length,
            });
        }),
        deleteFile: vi.fn(async ({ path }: { path: string }) => {
            state.files.delete(path);
        }),
    },
}));
vi.mock('../services/networkPolicy', () => ({ satelliteModeBlocks: () => state.satellite }));
const area = { north: 1, south: 0.9, west: 1, east: 1.1 },
    base = 'https://tiles.thalassatiles.com/v1';
const manifest = `${RELIEF_OFFLINE_DIRECTORY}/index.json`,
    webManifest = new URL('/__thalassa-offline-relief-manifest-v1', globalThis.location.href).href;
function image(mime: string): Uint8Array<ArrayBuffer> {
    const b = new Uint8Array(44),
        d = new DataView(b.buffer);
    if (mime === 'image/png') {
        b.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
        d.setUint32(16, 256);
        d.setUint32(20, 256);
    } else {
        b.set([82, 73, 70, 70]);
        d.setUint32(4, 36, true);
        b.set([87, 69, 66, 80, 86, 80, 56, 76], 8);
        d.setUint32(16, 24, true);
        b.set([47, 255, 192, 63, 0], 20);
    }
    return b;
}
const encoded = (b: Uint8Array) => btoa(String.fromCharCode(...b));
function response(url: string) {
    const t = reliefTile(url)!;
    return { url, status: 200, headers: { 'content-type': t.mime }, data: encoded(image(t.mime)) };
}
function saveIndex(tiles: unknown[]) {
    const data = JSON.stringify({ schema: 1, tiles });
    state.files.set(manifest, { data, size: data.length });
}
function memoryCache() {
    const entries = new Map<string, Response>();
    return {
        entries,
        match: vi.fn(async (r: string | Request) => entries.get(typeof r === 'string' ? r : r.url)?.clone()),
        put: vi.fn(async (r: string | Request, s: Response) => {
            entries.set(typeof r === 'string' ? r : r.url, s.clone());
        }),
        delete: vi.fn(async (r: string | Request) => entries.delete(typeof r === 'string' ? r : r.url)),
        keys: vi.fn(async () => [...entries.keys()].map((url) => new Request(url))),
    };
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.resetModules();
    vi.clearAllMocks();
    state.native = true;
    state.satellite = false;
    state.files.clear();
    state.http.mockImplementation(async ({ url }: { url: string }) => response(url));
    vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => {
            const t = reliefTile(url)!;
            return new Response(image(t.mime), { headers: { 'content-type': t.mime } });
        }),
    );
});
afterEach(() => {
    vi.clearAllTimers();
    vi.unstubAllGlobals();
    vi.useRealTimers();
});

describe('native public relief persistence', () => {
    it('can restore and delete saved terrain when a full disk prevents rewriting its nonempty index', async () => {
        const first = await import('../services/OfflineReliefService');
        await first.downloadReliefArea(area, 4, base, new AbortController().signal, vi.fn());
        const count = first.reliefStorage().tiles;
        expect(count).toBeGreaterThan(0);
        state.writes.mockImplementation((o: { path: string }) => {
            if (o.path === manifest && [...state.files.keys()].some((path) => path !== manifest))
                throw new Error('No room for index replacement');
        });
        vi.resetModules();
        const fresh = await import('../services/OfflineReliefService');
        await fresh.hydrateRelief();
        expect(fresh.reliefStorage().tiles).toBe(count);
        await fresh.deleteSavedRelief();
        expect(fresh.reliefStorage().tiles).toBe(0);
        expect([...state.files.keys()]).toEqual([manifest]);
        expect(JSON.parse(state.files.get(manifest)!.data).tiles).toEqual([]);
        state.writes.mockReset();
    });
    it('reserves deletion before awaiting hydration so a download cannot refill it concurrently', async () => {
        const { Filesystem } = await import('@capacitor/filesystem');
        let finish!: (value: { uri: string }) => void;
        vi.mocked(Filesystem.getUri).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const service = await import('../services/OfflineReliefService');
        const deleting = service.deleteSavedRelief();
        await vi.waitFor(() => expect(Filesystem.getUri).toHaveBeenCalledOnce());
        await expect(service.downloadReliefArea(area, 4, base, new AbortController().signal, vi.fn())).rejects.toThrow(
            'deletion',
        );
        finish({ uri: `file:///data/${RELIEF_OFFLINE_DIRECTORY}` });
        await deleting;
        expect(service.reliefStorage().tiles).toBe(0);
        expect(state.http).not.toHaveBeenCalled();
    });
    it('refuses new writes when a crash-orphaned terrain file cannot be reclaimed', async () => {
        const { Filesystem } = await import('@capacitor/filesystem');
        const orphan = `${RELIEF_OFFLINE_DIRECTORY}/v1_global_idx_9_10_10.png`;
        state.files.set(orphan, { data: 'partial', size: RELIEF_TILE_MAX_BYTES });
        vi.mocked(Filesystem.deleteFile).mockRejectedValueOnce(new Error('Filesystem busy'));
        const service = await import('../services/OfflineReliefService'),
            p = vi.fn();
        await service.downloadReliefArea(area, 4, base, new AbortController().signal, p);
        expect(p.mock.lastCall?.[0].phase).toBe('error');
        expect(state.http).not.toHaveBeenCalled();
        expect(state.writes).not.toHaveBeenCalled();
        await service.downloadReliefArea(area, 4, base, new AbortController().signal, p);
        expect(p.mock.lastCall?.[0]).toMatchObject({ phase: 'done', failed: 0 });
        expect(state.files.has(orphan)).toBe(false);
    });
    it('stops after a partial native write and requires orphan cleanup before another operation', async () => {
        const { Filesystem } = await import('@capacitor/filesystem');
        const service = await import('../services/OfflineReliefService'),
            p = vi.fn();
        state.writes.mockImplementation((o: { path: string; encoding?: string }) => {
            if (o.encoding !== 'utf8') {
                state.files.set(o.path, { data: 'partial', size: 44 });
                throw new Error('Disk full during write');
            }
        });
        vi.mocked(Filesystem.deleteFile).mockRejectedValueOnce(new Error('Cleanup unavailable'));
        await service.downloadReliefArea(area, 4, base, new AbortController().signal, p);
        expect(p.mock.lastCall?.[0]).toMatchObject({ phase: 'error', saved: 0 });
        expect(state.writes.mock.calls.filter(([o]) => o.encoding !== 'utf8')).toHaveLength(1);
        expect(service.reliefStorage().tiles).toBe(0);
        state.writes.mockReset();
        await service.downloadReliefArea(area, 4, base, new AbortController().signal, p);
        expect(p.mock.lastCall?.[0]).toMatchObject({
            phase: 'done',
            saved: planReliefArea(area, 4).tileCount,
            failed: 0,
        });
        expect([...state.files.values()].some((f) => f.data === 'partial')).toBe(false);
    });
    it('hydrates a fresh process into synchronous local file URLs without a network request', async () => {
        const first = await import('../services/OfflineReliefService');
        const progress = vi.fn();
        await first.downloadReliefArea(area, 4, base, new AbortController().signal, progress);
        expect(progress.mock.lastCall?.[0]).toMatchObject({
            phase: 'done',
            failed: 0,
            saved: planReliefArea(area, 4).tileCount,
        });
        expect(
            state.writes.mock.calls.every(
                ([o]) => o.directory === 'DATA' && o.path.startsWith(RELIEF_OFFLINE_DIRECTORY + '/'),
            ),
        ).toBe(true);
        expect(
            state.http.mock.calls.every(
                ([o]) => o.disableRedirects === true && o.responseType === 'arraybuffer' && reliefTile(o.url),
            ),
        ).toBe(true);
        const count = first.reliefStorage().tiles;
        expect(count).toBeGreaterThan(0);
        vi.resetModules();
        state.http.mockClear();
        const fresh = await import('../services/OfflineReliefService');
        const bridge = await import('../services/offlineReliefRuntime');
        expect(bridge.offlineReliefUrl(planReliefArea(area, 4).tiles[0].url)).toBeNull();
        await fresh.hydrateRelief();
        expect(fresh.reliefStorage().tiles).toBe(count);
        const tile = planReliefArea(area, 4).tiles[0];
        expect(bridge.offlineReliefUrl(tile.url)).toBe(
            `capacitor://localhost/_capacitor_file_/data/${RELIEF_OFFLINE_DIRECTORY}/${tile.key}`,
        );
        expect(state.http).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
    it('discards missing files, foreign paths, oversized rows and crash orphans', async () => {
        const good = planReliefArea(area, 4).tiles[0],
            missing = planReliefArea(area, 4).tiles[1];
        saveIndex([
            { url: good.url, bytes: 44, usedAt: 1 },
            { url: missing.url, bytes: 44, usedAt: 1 },
            { url: 'https://api.mapbox.com/private.png', bytes: 44, usedAt: 1 },
            { url: good.url + '?x=1', bytes: 44, usedAt: 1 },
        ]);
        state.files.set(`${RELIEF_OFFLINE_DIRECTORY}/${good.key}`, { data: '', size: 44 });
        state.files.set(`${RELIEF_OFFLINE_DIRECTORY}/v1_global_idx_9_10_10.png`, {
            data: '',
            size: RELIEF_TILE_MAX_BYTES + 1,
        });
        state.files.set(`${RELIEF_OFFLINE_DIRECTORY}/unrelated-user-chart.mbtiles`, { data: '', size: 100 });
        const service = await import('../services/OfflineReliefService');
        await service.hydrateRelief();
        expect(service.reliefStorage()).toEqual({ tiles: 1, bytes: 44 });
        expect(state.files.has(`${RELIEF_OFFLINE_DIRECTORY}/v1_global_idx_9_10_10.png`)).toBe(false);
        expect(state.files.has(`${RELIEF_OFFLINE_DIRECTORY}/unrelated-user-chart.mbtiles`)).toBe(true);
        await service.deleteSavedRelief();
        expect(service.reliefStorage().tiles).toBe(0);
        expect(state.files.has(`${RELIEF_OFFLINE_DIRECTORY}/unrelated-user-chart.mbtiles`)).toBe(true);
    });
    it('evicts least-used public terrain at 128 MiB while keeping tiles requested by the current area', async () => {
        const old = Array.from({ length: 512 }, (_, x) => ({
            url: `${base}/relief-global/idx/9/${x}/100.png`,
            bytes: RELIEF_TILE_MAX_BYTES,
            usedAt: x + 1,
        }));
        saveIndex(old);
        for (const row of old)
            state.files.set(`${RELIEF_OFFLINE_DIRECTORY}/${reliefTile(row.url)!.key}`, { data: '', size: row.bytes });
        const service = await import('../services/OfflineReliefService');
        await service.hydrateRelief();
        expect(service.reliefStorage().bytes).toBe(RELIEF_OFFLINE_LIMIT_BYTES);
        const bridge = await import('../services/offlineReliefRuntime');
        bridge.offlineReliefUrl(old[0].url);
        await service.downloadReliefArea(area, 4, base, new AbortController().signal, vi.fn());
        expect(service.reliefStorage().bytes).toBeLessThanOrEqual(RELIEF_OFFLINE_LIMIT_BYTES);
        expect(state.files.has(`${RELIEF_OFFLINE_DIRECTORY}/${reliefTile(old[0].url)!.key}`)).toBe(true);
        expect(state.files.has(`${RELIEF_OFFLINE_DIRECTORY}/${reliefTile(old[1].url)!.key}`)).toBe(false);
        for (const tile of planReliefArea(area, 4).tiles)
            expect(state.files.has(`${RELIEF_OFFLINE_DIRECTORY}/${tile.key}`)).toBe(true);
    });
    it('does not save late native replies after cancellation or allow deletion during a running download', async () => {
        const pending: { url: string; resolve: (r: ReturnType<typeof response>) => void }[] = [];
        state.http.mockImplementation(
            ({ url }: { url: string }) => new Promise((resolve) => pending.push({ url, resolve })),
        );
        const service = await import('../services/OfflineReliefService'),
            abort = new AbortController(),
            progress = vi.fn();
        const run = service.downloadReliefArea(area, 4, base, abort.signal, progress);
        await vi.waitFor(() => expect(pending).toHaveLength(2));
        await expect(service.deleteSavedRelief()).rejects.toThrow('Cancel');
        abort.abort();
        await run;
        for (const p of pending) p.resolve(response(p.url));
        await Promise.resolve();
        expect(service.reliefStorage().tiles).toBe(0);
        expect(progress.mock.lastCall?.[0].phase).toBe('cancelled');
        expect([...state.files.keys()]).toEqual([manifest]);
    });
    it('rejects redirected, HTML, oversized and missing tile responses without an offline success claim', async () => {
        const service = await import('../services/OfflineReliefService');
        state.http.mockImplementation(async ({ url }: { url: string }) => ({
            ...response(url),
            url: 'https://evil.example/tile.png',
        }));
        const p = vi.fn();
        await service.downloadReliefArea(area, 4, base, new AbortController().signal, p);
        expect(p.mock.lastCall?.[0]).toMatchObject({ phase: 'error', saved: 0 });
        expect(service.reliefStorage().tiles).toBe(0);
        state.http.mockImplementation(async ({ url }: { url: string }) => ({
            ...response(url),
            headers: { 'content-type': 'text/html' },
        }));
        await service.downloadReliefArea(area, 4, base, new AbortController().signal, p);
        expect(service.reliefStorage().tiles).toBe(0);
        state.http.mockImplementation(async ({ url }: { url: string }) => ({
            ...response(url),
            headers: { 'content-type': reliefTile(url)!.mime, 'content-length': String(RELIEF_TILE_MAX_BYTES + 1) },
        }));
        await service.downloadReliefArea(area, 4, base, new AbortController().signal, p);
        expect(service.reliefStorage().tiles).toBe(0);
        state.http.mockImplementation(async ({ url }: { url: string }) => ({ ...response(url), status: 404 }));
        await service.downloadReliefArea(area, 4, base, new AbortController().signal, p);
        expect(p.mock.lastCall?.[0]).toMatchObject({ saved: 0, failed: 0, missing: planReliefArea(area, 4).tileCount });
        expect(p.mock.lastCall?.[0].message).toContain('No relief was saved');
    });
    it('never sends WAN requests when Satellite Mode blocks bulk download', async () => {
        state.satellite = true;
        const service = await import('../services/OfflineReliefService');
        await expect(service.downloadReliefArea(area, 4, base, new AbortController().signal, vi.fn())).rejects.toThrow(
            'Satellite Mode',
        );
        expect(state.http).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
    it('does not publish a tile whose persistent index write failed', async () => {
        const service = await import('../services/OfflineReliefService');
        await service.hydrateRelief();
        state.writes.mockImplementation((o: { path: string }) => {
            if (o.path === manifest && [...state.files.keys()].some((path) => path !== manifest))
                throw new Error('Storage full');
        });
        const p = vi.fn();
        await service.downloadReliefArea(area, 4, base, new AbortController().signal, p);
        expect(service.reliefStorage().tiles).toBe(0);
        expect(p.mock.lastCall?.[0]).toMatchObject({ phase: 'error', saved: 0 });
        expect([...state.files.keys()]).toEqual([manifest]);
        state.writes.mockReset();
    });
});

describe('browser terrain cache matching the service worker', () => {
    it('moves a validated legacy manifest onto the app origin without fetching terrain again', async () => {
        state.native = false;
        const cache = memoryCache();
        vi.stubGlobal('caches', { open: vi.fn(async () => cache) });
        const service = await import('../services/OfflineReliefService');
        await service.downloadReliefArea(area, 4, base, new AbortController().signal, vi.fn());
        const count = service.reliefStorage().tiles;
        const legacy = 'https://tiles.thalassatiles.com/__offline-relief-manifest-v1';
        cache.entries.set(legacy, cache.entries.get(webManifest)!.clone());
        cache.entries.delete(webManifest);
        vi.mocked(fetch).mockClear();
        vi.resetModules();
        const fresh = await import('../services/OfflineReliefService');
        await fresh.hydrateRelief();
        expect(fresh.reliefStorage().tiles).toBe(count);
        expect(count).toBeGreaterThan(0);
        expect(cache.entries.has(webManifest)).toBe(true);
        expect(new URL(webManifest).origin).toBe(location.origin);
        expect(cache.entries.has(legacy)).toBe(false);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('refetches a browser-evicted saved file instead of trusting an old in-memory index', async () => {
        state.native = false;
        const cache = memoryCache();
        vi.stubGlobal('caches', { open: vi.fn(async () => cache) });
        const service = await import('../services/OfflineReliefService'),
            p = vi.fn();
        await service.downloadReliefArea(area, 4, base, new AbortController().signal, p);
        const missing = planReliefArea(area, 4).tiles[0].url;
        cache.entries.delete(missing);
        expect(service.reliefStorage().tiles).toBe(planReliefArea(area, 4).tileCount);
        vi.mocked(fetch).mockClear();
        await service.downloadReliefArea(area, 4, base, new AbortController().signal, p);
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(vi.mocked(fetch).mock.calls[0][0]).toBe(missing);
        expect(cache.entries.has(missing)).toBe(true);
        expect(p.mock.lastCall?.[0]).toMatchObject({
            phase: 'done',
            failed: 0,
            saved: planReliefArea(area, 4).tileCount,
        });
    });
    it('persists across fresh modules, uses credential-free no-redirect downloads and deletes only owned terrain', async () => {
        state.native = false;
        const cache = memoryCache(),
            open = vi.fn(async (_name: string) => cache);
        vi.stubGlobal('caches', { open });
        const service = await import('../services/OfflineReliefService');
        await service.downloadReliefArea(area, 4, base, new AbortController().signal, vi.fn());
        expect(open.mock.calls.every(([name]) => name === RELIEF_WEB_CACHE)).toBe(true);
        expect(fetch).toHaveBeenCalledWith(
            expect.stringContaining(base),
            expect.objectContaining({ redirect: 'error', credentials: 'omit', cache: 'reload' }),
        );
        const count = service.reliefStorage().tiles;
        cache.entries.set('https://tile.openstreetmap.org/0/0/0.png', new Response('viewed tile'));
        vi.resetModules();
        const fresh = await import('../services/OfflineReliefService');
        await fresh.hydrateRelief();
        expect(fresh.reliefStorage().tiles).toBe(count);
        expect(count).toBeGreaterThan(0);
        const manifest = await cache.match(webManifest);
        expect((await manifest!.json()).schema).toBe(1);
        await fresh.deleteSavedRelief();
        expect(fresh.reliefStorage().tiles).toBe(0);
        expect(cache.entries.has('https://tile.openstreetmap.org/0/0/0.png')).toBe(true);
        expect([...cache.entries.keys()].filter((url) => reliefTile(url))).toEqual([]);
    });
});
