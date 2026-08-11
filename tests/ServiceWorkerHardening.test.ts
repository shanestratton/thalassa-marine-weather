import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type ServiceWorkerHandler = (event: {
    request?: Request;
    respondWith?: (response: Promise<Response>) => void;
    waitUntil: (work: Promise<unknown>) => void;
}) => void;

function loadServiceWorker() {
    const listeners = new Map<string, ServiceWorkerHandler>();
    const makeCache = () => ({
        addAll: vi.fn().mockResolvedValue(undefined),
        match: vi.fn().mockResolvedValue(undefined),
        put: vi.fn().mockResolvedValue(undefined),
        keys: vi.fn().mockResolvedValue([]),
        delete: vi.fn().mockResolvedValue(true),
    });
    const namedCaches = new Map<string, ReturnType<typeof makeCache>>();
    const getCache = (name: string) => {
        const existing = namedCaches.get(name);
        if (existing) return existing;
        const created = makeCache();
        namedCaches.set(name, created);
        return created;
    };
    const caches = {
        open: vi.fn((name: string) => Promise.resolve(getCache(name))),
        keys: vi.fn().mockResolvedValue([]),
        delete: vi.fn().mockResolvedValue(true),
        match: vi.fn().mockResolvedValue(undefined),
    };
    // An image content-type, because v199's tile branch only caches real
    // images (a 200-status error body used to replay into the decoder
    // forever). A bare text Response now correctly never reaches the tile
    // cache — which is the guard, not a failure.
    const fetchMock = vi
        .fn()
        .mockResolvedValue(new Response('network', { status: 200, headers: { 'content-type': 'image/png' } }));
    const workerMath = Object.create(Math) as Math;
    workerMath.random = () => 1;
    const source = readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf8');
    // Cache names come FROM the source, not from literals here — the v198
    // hardcodes silently turned every assertion into "called 0 times" the day
    // a release bumped the worker to v199 (2026-08-11). A missing constant
    // still fails loudly below via the fallback name never being opened.
    const readName = (constant: string): string =>
        new RegExp(`const ${constant} = '([^']+)'`).exec(source)?.[1] ?? `missing-${constant}`;
    const names = {
        core: readName('CACHE_NAME'),
        runtimeTiles: readName('RUNTIME_TILE_CACHE'),
        offlineTiles: readName('OFFLINE_TILE_CACHE'),
    };

    runInNewContext(source, {
        URL,
        Response,
        fetch: fetchMock,
        caches,
        console,
        Math: workerMath,
        self: {
            location: { origin: 'https://thalassa.example' },
            clients: { claim: vi.fn() },
            skipWaiting: vi.fn(),
            addEventListener: (type: string, handler: ServiceWorkerHandler) => listeners.set(type, handler),
        },
    });

    return {
        listeners,
        cache: getCache(names.core),
        names,
        getCache,
        caches,
        fetchMock,
    };
}

describe('production service worker', () => {
    it('installs only stable URLs that survive Vite fingerprinting', async () => {
        const { listeners, cache } = loadServiceWorker();
        const pending: Promise<unknown>[] = [];

        listeners.get('install')?.({ waitUntil: (work) => pending.push(work) });
        await Promise.all(pending);

        expect(cache.addAll).toHaveBeenCalledWith(['/', '/index.html']);
        expect(cache.addAll).not.toHaveBeenCalledWith(expect.arrayContaining(['/index.css', '/manifest.json']));
    });

    it('never intercepts an authenticated request', () => {
        const { listeners, fetchMock } = loadServiceWorker();
        const respondWith = vi.fn();

        listeners.get('fetch')?.({
            request: new Request('https://api.mapbox.com/tiles/1/2/3.png', {
                headers: { authorization: 'Bearer private-token' },
            }),
            respondWith,
            waitUntil: vi.fn(),
        });

        expect(respondWith).not.toHaveBeenCalled();
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('matches trusted cache hosts by DNS boundary, not substring', async () => {
        const { listeners, getCache, fetchMock, names } = loadServiceWorker();
        const deceptiveRespondWith = vi.fn();

        listeners.get('fetch')?.({
            request: new Request('https://evilmapbox.com/tiles/1/2/3.png'),
            respondWith: deceptiveRespondWith,
            waitUntil: vi.fn(),
        });
        expect(deceptiveRespondWith).not.toHaveBeenCalled();

        let responsePromise: Promise<Response> | undefined;
        const pending: Promise<unknown>[] = [];
        listeners.get('fetch')?.({
            request: new Request('https://api.mapbox.com/tiles/1/2/3.png'),
            respondWith: (response) => {
                responsePromise = response;
            },
            waitUntil: (work) => pending.push(work),
        });

        expect(responsePromise).toBeDefined();
        expect(await responsePromise).toMatchObject({ status: 200 });
        await Promise.all(pending);
        expect(fetchMock).toHaveBeenCalledOnce();
        expect(getCache(names.runtimeTiles).put).toHaveBeenCalledOnce();
        expect(getCache(names.offlineTiles).put).not.toHaveBeenCalled();
    });

    it('serves explicit offline-area tiles without evicting or rewriting them', async () => {
        const { listeners, getCache, fetchMock, names } = loadServiceWorker();
        const runtimeCache = getCache(names.runtimeTiles);
        const offlineCache = getCache(names.offlineTiles);
        offlineCache.match.mockResolvedValue(new Response('offline-area'));

        let responsePromise: Promise<Response> | undefined;
        listeners.get('fetch')?.({
            request: new Request('https://tile.openstreetmap.org/8/234/155.png'),
            respondWith: (response) => {
                responsePromise = response;
            },
            waitUntil: vi.fn(),
        });

        expect(responsePromise).toBeDefined();
        expect(await responsePromise?.then((response) => response.text())).toBe('offline-area');
        expect(fetchMock).not.toHaveBeenCalled();
        expect(runtimeCache.put).not.toHaveBeenCalled();
        expect(offlineCache.put).not.toHaveBeenCalled();
        expect(offlineCache.delete).not.toHaveBeenCalled();
    });

    it('prunes only the ordinary browsing tile cache to its fixed limit', async () => {
        const { listeners, getCache, names } = loadServiceWorker();
        const runtimeCache = getCache(names.runtimeTiles);
        const offlineCache = getCache(names.offlineTiles);
        runtimeCache.keys.mockResolvedValue(
            Array.from(
                { length: 2002 },
                (_, index) => new Request(`https://tile.openstreetmap.org/8/${index}/155.png`),
            ),
        );

        let responsePromise: Promise<Response> | undefined;
        const pending: Promise<unknown>[] = [];
        listeners.get('fetch')?.({
            request: new Request('https://tile.openstreetmap.org/8/234/155.png'),
            respondWith: (response) => {
                responsePromise = response;
            },
            waitUntil: (work) => pending.push(work),
        });

        expect(await responsePromise).toMatchObject({ status: 200 });
        await Promise.all(pending);
        expect(runtimeCache.delete).toHaveBeenCalledTimes(2);
        expect(offlineCache.keys).not.toHaveBeenCalled();
        expect(offlineCache.delete).not.toHaveBeenCalled();
    });
});
