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
    const fetchMock = vi.fn().mockResolvedValue(new Response('network', { status: 200 }));
    const workerMath = Object.create(Math) as Math;
    workerMath.random = () => 1;
    const source = readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf8');

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
        cache: getCache('thalassa-v198-core'),
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
        const { listeners, getCache, fetchMock } = loadServiceWorker();
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
        expect(getCache('thalassa-v198-runtime-tiles').put).toHaveBeenCalledOnce();
        expect(getCache('thalassa-v195-tiles').put).not.toHaveBeenCalled();
    });

    it('serves explicit offline-area tiles without evicting or rewriting them', async () => {
        const { listeners, getCache, fetchMock } = loadServiceWorker();
        const runtimeCache = getCache('thalassa-v198-runtime-tiles');
        const offlineCache = getCache('thalassa-v195-tiles');
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
        const { listeners, getCache } = loadServiceWorker();
        const runtimeCache = getCache('thalassa-v198-runtime-tiles');
        const offlineCache = getCache('thalassa-v195-tiles');
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
