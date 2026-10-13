import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { runInContext, runInNewContext } from 'node:vm';
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
        mapboxTiles: readName('MAPBOX_TILE_CACHE'),
    };

    runInNewContext(source, {
        URL,
        Response,
        Headers,
        Blob,
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
        // 127-H: Mapbox tiles live in their own dated cache, never the shared one.
        expect(getCache(names.mapboxTiles).put).toHaveBeenCalledOnce();
        expect(getCache(names.runtimeTiles).put).not.toHaveBeenCalled();
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

// ── 127-H: Mapbox raster tiles under the Product Terms' 30-day cache limit ──
//
// Mapbox Product Terms §2.8.1: "caching is limited to thirty (30) days on the
// same device making the Mapping API request". The worker keeps Mapbox tiles
// in their own cache with its own stamp and never serves one 29 days old or
// older, online or off. These tests run the real worker against an in-memory
// CacheStorage and a clock the test owns.

const DAY = 86_400_000;
const T0 = Date.UTC(2026, 9, 11, 2, 0, 0);
const STAMP = 'x-thalassa-cached-at';
const SATELLITE = 'https://api.mapbox.com/v4/mapbox.satellite/8/234/155@2x.jpg90?access_token=pk.fictional';
const HYBRID = 'https://api.mapbox.com/styles/v1/example/hybrid/tiles/512/8/234/155@2x?access_token=pk.fictional';

class MemoryCache {
    readonly entries = new Map<string, Response>();
    readonly deleted: string[] = [];
    async match(request: Request | string) {
        const hit = this.entries.get(typeof request === 'string' ? request : request.url);
        return hit ? hit.clone() : undefined;
    }
    async put(request: Request | string, response: Response) {
        const key = typeof request === 'string' ? request : request.url;
        this.entries.delete(key);
        this.entries.set(key, response);
    }
    async keys() {
        return [...this.entries.keys()].map((url) => new Request(url));
    }
    async delete(request: Request | string) {
        const key = typeof request === 'string' ? request : request.url;
        this.deleted.push(key);
        return this.entries.delete(key);
    }
    async addAll() {}
    urls() {
        return [...this.entries.keys()];
    }
}

type Network = (request: Request) => Promise<Response>;

function image(body: string, type = 'image/jpeg'): Response {
    return new Response(body, { status: 200, headers: { 'content-type': type } });
}

function loadWorkerWithStore(options: { network?: Network } = {}) {
    const listeners = new Map<string, ServiceWorkerHandler>();
    const store = new Map<string, MemoryCache>();
    const open = (name: string) => {
        const existing = store.get(name);
        if (existing) return existing;
        const created = new MemoryCache();
        store.set(name, created);
        return created;
    };
    const caches = {
        open: async (name: string) => open(name),
        keys: async () => [...store.keys()],
        delete: async (name: string) => store.delete(name),
        match: async (request: Request) => {
            for (const cache of store.values()) {
                const hit = await cache.match(request);
                if (hit) return hit;
            }
            return undefined;
        },
    };
    const clock = { now: T0 };
    class WorkerDate extends Date {
        static now() {
            return clock.now;
        }
    }
    let network: Network = options.network ?? (async () => image('network'));
    const fetchMock = vi.fn((request: Request) => network(request));
    const source = readFileSync(resolve(process.cwd(), 'public/sw.js'), 'utf8');
    const readName = (constant: string): string =>
        new RegExp(`const ${constant} = '([^']+)'`).exec(source)?.[1] ?? `missing-${constant}`;
    const names = {
        core: readName('CACHE_NAME'),
        runtime: readName('RUNTIME_TILE_CACHE'),
        offline: readName('OFFLINE_TILE_CACHE'),
        data: readName('DATA_CACHE'),
        mapbox: readName('MAPBOX_TILE_CACHE'),
    };
    const workerMath = Object.create(Math) as Math;
    workerMath.random = () => 1;

    const context = {
        URL,
        Request,
        Response,
        Headers,
        Blob,
        Date: WorkerDate,
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
    };
    runInNewContext(source, context);
    /** Reads one of the worker's own top-level bindings. */
    const peek = (expression: string): unknown => runInContext(expression, context);

    const settle = async (pending: Promise<unknown>[]) => {
        let seen = -1;
        while (seen !== pending.length) {
            seen = pending.length;
            await Promise.all(pending);
        }
    };

    const dispatch = async (request: Request | string) => {
        let responsePromise: Promise<Response> | undefined;
        const pending: Promise<unknown>[] = [];
        listeners.get('fetch')?.({
            request: typeof request === 'string' ? new Request(request) : request,
            respondWith: (response) => {
                responsePromise = response;
            },
            waitUntil: (work) => pending.push(work),
        });
        const response = responsePromise ? await responsePromise : undefined;
        await settle(pending);
        return response;
    };

    const activate = async () => {
        const pending: Promise<unknown>[] = [];
        listeners.get('activate')?.({ waitUntil: (work) => pending.push(work) });
        await settle(pending);
    };

    const seedMapbox = (url: string, stamp: string | number | null, body = 'old-tile') => {
        const headers: Record<string, string> = { 'content-type': 'image/jpeg' };
        if (stamp !== null) headers[STAMP] = String(stamp);
        open(names.mapbox).entries.set(url, new Response(body, { status: 200, headers }));
    };

    return {
        names,
        clock,
        fetchMock,
        cache: open,
        store,
        dispatch,
        activate,
        peek,
        seedMapbox,
        setNetwork: (next: Network) => {
            network = next;
        },
    };
}

const offline: Network = async () => {
    throw new TypeError('Failed to fetch');
};

describe('Mapbox tiles stay under the 30-day cache limit (127-H)', () => {
    it('stores a satellite tile in its own cache with a stamp, never in the shared tile cache', async () => {
        const sw = loadWorkerWithStore({ network: async () => image('satellite-bytes') });
        expect(sw.names.mapbox).toBe('thalassa-v200-mapbox-tiles');

        const response = await sw.dispatch(SATELLITE);

        expect(response?.status).toBe(200);
        expect(await response?.text()).toBe('satellite-bytes');
        const stored = await sw.cache(sw.names.mapbox).match(SATELLITE);
        expect(stored?.headers.get(STAMP)).toBe(String(T0));
        expect(stored?.headers.get('content-type')).toBe('image/jpeg');
        expect(await stored?.text()).toBe('satellite-bytes');
        expect(sw.cache(sw.names.runtime).urls()).toEqual([]);
        expect(sw.cache(sw.names.offline).urls()).toEqual([]);
    });

    it.each([
        ['28 days', 28 * DAY],
        ['29 days less 1 ms', 29 * DAY - 1],
    ])('serves a tile stamped %s ago from the cache, even offline, without the network', async (_label, age) => {
        const sw = loadWorkerWithStore({ network: offline });
        // The Hybrid Static Tiles go the same way as the satellite raster.
        sw.seedMapbox(HYBRID, T0 - age, 'cached-hybrid');

        const response = await sw.dispatch(HYBRID);

        expect(await response?.text()).toBe('cached-hybrid');
        expect(sw.fetchMock).not.toHaveBeenCalled();
        expect(sw.cache(sw.names.mapbox).urls()).toEqual([HYBRID]);
    });

    it.each([
        ['29 days and 1 ms ago', T0 - 29 * DAY - 1],
        ['exactly 29 days ago', T0 - 29 * DAY],
        ['six weeks ago', T0 - 42 * DAY],
    ])('deletes a tile stamped %s, fetches it again and re-stores it with a new stamp', async (_label, stamp) => {
        const sw = loadWorkerWithStore({ network: async () => image('fresh-tile') });
        sw.seedMapbox(SATELLITE, stamp);

        const response = await sw.dispatch(SATELLITE);

        expect(await response?.text()).toBe('fresh-tile');
        expect(sw.fetchMock).toHaveBeenCalledOnce();
        const stored = await sw.cache(sw.names.mapbox).match(SATELLITE);
        expect(stored?.headers.get(STAMP)).toBe(String(T0));
        expect(await stored?.text()).toBe('fresh-tile');
    });

    it.each([
        ['no stamp', null],
        ['a stamp that is not a time', 'yesterday'],
        ['a stamp in the future (the clock went back)', T0 + 2 * DAY],
    ])('never serves a tile with %s', async (_label, stamp) => {
        const sw = loadWorkerWithStore({ network: async () => image('fresh-tile') });
        sw.seedMapbox(SATELLITE, stamp);

        const response = await sw.dispatch(SATELLITE);

        expect(await response?.text()).toBe('fresh-tile');
        expect(sw.fetchMock).toHaveBeenCalledOnce();
    });

    it('answers an expired tile offline with an empty 404, never the old tile, and drops the old bytes', async () => {
        const sw = loadWorkerWithStore({ network: offline });
        sw.seedMapbox(SATELLITE, T0 - 30 * DAY, 'old-tile');

        const response = await sw.dispatch(SATELLITE);

        expect(response?.status).toBe(404);
        expect(await response?.text()).toBe('');
        expect(sw.cache(sw.names.mapbox).urls()).toEqual([]);
    });

    it('stores nothing that is not a good image: vector tiles, styles and errors pass straight through', async () => {
        const sw = loadWorkerWithStore();
        const answers: Record<string, Response> = {
            'https://api.mapbox.com/v4/mapbox.mapbox-streets-v8/8/234/155.vector.pbf?access_token=pk.fictional':
                new Response('pbf', { status: 200, headers: { 'content-type': 'application/x-protobuf' } }),
            'https://api.mapbox.com/styles/v1/example/hybrid?access_token=pk.fictional': new Response('{}', {
                status: 200,
                headers: { 'content-type': 'application/json' },
            }),
            [SATELLITE]: new Response('nope', { status: 403, headers: { 'content-type': 'image/png' } }),
        };
        sw.setNetwork(async (request) => answers[request.url]);

        for (const url of Object.keys(answers)) await sw.dispatch(url);

        expect(sw.fetchMock).toHaveBeenCalledTimes(3);
        expect(sw.cache(sw.names.mapbox).urls()).toEqual([]);
        expect(sw.cache(sw.names.runtime).urls()).toEqual([]);
    });

    it('never answers a Mapbox request from the shared or offline-area tile caches (old, unstamped copies)', async () => {
        const sw = loadWorkerWithStore({ network: async () => image('from-mapbox') });
        sw.cache(sw.names.runtime).entries.set(SATELLITE, image('legacy-runtime-copy'));
        sw.cache(sw.names.offline).entries.set(HYBRID, image('legacy-offline-copy'));

        expect(await (await sw.dispatch(SATELLITE))?.text()).toBe('from-mapbox');
        expect(await (await sw.dispatch(HYBRID))?.text()).toBe('from-mapbox');
        expect(sw.fetchMock).toHaveBeenCalledTimes(2);
    });

    it('caps its own cache at 800 tiles: the 801st write drops the oldest', async () => {
        const sw = loadWorkerWithStore({ network: async () => image('tile-801') });
        const urls = Array.from(
            { length: 800 },
            (_, index) =>
                `https://api.mapbox.com/v4/mapbox.satellite/12/${index}/2000@2x.jpg90?access_token=pk.fictional`,
        );
        for (const url of urls) sw.seedMapbox(url, T0 - DAY);

        await sw.dispatch(SATELLITE);

        const kept = sw.cache(sw.names.mapbox).urls();
        expect(kept).toHaveLength(800);
        expect(kept).not.toContain(urls[0]);
        expect(kept).toContain(urls[1]);
        expect(kept).toContain(SATELLITE);
    });

    it('activate keeps the Mapbox cache, sweeps its expired tiles, and purges unstamped Mapbox copies from both shared caches', async () => {
        const sw = loadWorkerWithStore();
        const runtime = sw.cache(sw.names.runtime);
        const keepers = [
            'https://tile.openstreetmap.org/8/234/155.png',
            'https://tiles.openseamap.org/seamark/8/234/155.png',
            'https://tiles.thalassatiles.com/relief/v1/8/234/155.webp',
            'https://a.basemaps.cartocdn.com/light_all/8/234/155@2x.png',
        ];
        for (const url of keepers) runtime.entries.set(url, image('keep', 'image/png'));
        runtime.entries.set(SATELLITE, image('legacy'));
        runtime.entries.set('https://a.tiles.mapbox.com/v4/mapbox.satellite/3/4/5.jpg', image('legacy'));
        const offlineArea = sw.cache(sw.names.offline);
        offlineArea.entries.set('https://tile.openstreetmap.org/9/1/2.png', image('download', 'image/png'));
        // The offline-area cache's name was the v195-v197 workers' browsing
        // cache (2026-07-19 to 2026-08-06), and they kept every Mapbox answer
        // there: imagery and place-name lookups, all of unknown age by now.
        // MapOfflineService has only ever downloaded OSM and OpenSeaMap.
        const legacyOffline = [
            'https://api.mapbox.com/v4/mapbox.satellite/7/117/77@2x.jpg90?access_token=pk.fictional',
            'https://api.mapbox.com/geocoding/v5/mapbox.places/Porto%20Ficticio.json?access_token=pk.fictional',
        ];
        offlineArea.entries.set(legacyOffline[0], image('legacy-satellite'));
        offlineArea.entries.set(
            legacyOffline[1],
            new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }),
        );
        sw.seedMapbox(HYBRID, T0 - 30 * DAY);
        sw.seedMapbox(SATELLITE, T0 - DAY, 'recent');
        sw.cache('thalassa-v198-runtime-tiles').entries.set(SATELLITE, image('ancient'));

        await sw.activate();

        expect([...sw.store.keys()].sort()).toEqual([sw.names.runtime, sw.names.offline, sw.names.mapbox].sort());
        expect(runtime.urls()).toEqual(keepers);
        expect(sw.cache(sw.names.mapbox).urls()).toEqual([SATELLITE]);
        expect(offlineArea.urls()).toEqual(['https://tile.openstreetmap.org/9/1/2.png']);
        expect(offlineArea.deleted.sort()).toEqual([...legacyOffline].sort());
    });

    it('does not sweep again on the first request after activate has just swept', async () => {
        const sw = loadWorkerWithStore();
        sw.seedMapbox(SATELLITE, T0 - DAY, 'recent');
        await sw.activate();
        const mapbox = sw.cache(sw.names.mapbox);
        const keys = vi.spyOn(mapbox, 'keys');

        await sw.dispatch('https://tile.openstreetmap.org/8/234/155.png');
        await sw.dispatch(SATELLITE);

        expect(keys).not.toHaveBeenCalled();
        expect(mapbox.urls()).toEqual([SATELLITE]);
    });

    it('tries the sweep again on the next request when one fails', async () => {
        const sw = loadWorkerWithStore();
        const stale = 'https://api.mapbox.com/v4/mapbox.satellite/5/1/1@2x.jpg90?access_token=pk.fictional';
        sw.seedMapbox(stale, T0 - 42 * DAY);
        const mapbox = sw.cache(sw.names.mapbox);
        vi.spyOn(mapbox, 'keys').mockRejectedValueOnce(new Error('storage busy'));
        const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

        await sw.dispatch('https://tile.openstreetmap.org/8/234/155.png');
        expect(mapbox.urls()).toEqual([stale]);
        await sw.dispatch('https://tile.openstreetmap.org/8/235/155.png');

        expect(mapbox.urls()).toEqual([]);
        expect(warn).toHaveBeenCalledOnce();
        warn.mockRestore();
    });

    it('remembers which tiles the page asked for only while a sweep runs, then forgets them', async () => {
        const sw = loadWorkerWithStore();
        sw.seedMapbox(SATELLITE, T0 - 42 * DAY);

        // The first request starts the sweep; the tile it asks for is the
        // fetch branch's to judge, so the sweep leaves the fresh copy alone.
        expect(await (await sw.dispatch(SATELLITE))?.text()).toBe('network');
        expect(sw.cache(sw.names.mapbox).urls()).toEqual([SATELLITE]);
        expect(sw.peek('mapboxRequested')).toBeNull();

        // No sweep running: nothing is remembered, however long the worker lives.
        await sw.dispatch(HYBRID);
        expect(sw.peek('mapboxRequested')).toBeNull();
    });

    it('sweeps expired Mapbox tiles on the first request after the worker starts, and only the first', async () => {
        const sw = loadWorkerWithStore();
        const stale = 'https://api.mapbox.com/v4/mapbox.satellite/5/1/1@2x.jpg90?access_token=pk.fictional';
        const later = 'https://api.mapbox.com/v4/mapbox.satellite/5/2/2@2x.jpg90?access_token=pk.fictional';
        sw.seedMapbox(stale, T0 - 42 * DAY);
        sw.seedMapbox(SATELLITE, T0 - DAY, 'recent');

        // A skipper back after six weeks: the first request is the chart page,
        // not a Mapbox tile, and it still cleans the old imagery off the disk.
        await sw.dispatch('https://tile.openstreetmap.org/8/234/155.png');
        expect(sw.cache(sw.names.mapbox).urls()).toEqual([SATELLITE]);

        sw.seedMapbox(later, T0 - 42 * DAY);
        await sw.dispatch('https://tile.openstreetmap.org/8/235/155.png');
        expect(sw.cache(sw.names.mapbox).urls()).toEqual([SATELLITE, later]);
    });
});

describe('the other chart tiles and the bypasses are unchanged (127-H)', () => {
    it.each([
        'https://tile.openstreetmap.org/8/234/155.png',
        'https://tiles.openseamap.org/seamark/8/234/155.png',
        'https://tiles.thalassatiles.com/relief/v1/8/234/155.webp',
        'https://a.basemaps.cartocdn.com/light_all/8/234/155@2x.png',
    ])('%s stays cache-first in the shared tile cache', async (url) => {
        const sw = loadWorkerWithStore({ network: async () => image('tile', 'image/png') });

        expect(await (await sw.dispatch(url))?.text()).toBe('tile');
        sw.setNetwork(offline);
        expect(await (await sw.dispatch(url))?.text()).toBe('tile');

        expect(sw.fetchMock).toHaveBeenCalledOnce();
        expect(sw.cache(sw.names.runtime).urls()).toEqual([url]);
        expect(sw.cache(sw.names.mapbox).urls()).toEqual([]);
    });

    it('never caches a non-image answer for a shared-cache host', async () => {
        const sw = loadWorkerWithStore({
            network: async () => new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }),
        });

        await sw.dispatch('https://tile.openstreetmap.org/8/234/155.png');

        expect(sw.cache(sw.names.runtime).urls()).toEqual([]);
    });

    it('leaves POSTs, authorised requests and localhost alone', async () => {
        const sw = loadWorkerWithStore();

        expect(await sw.dispatch(new Request(SATELLITE, { method: 'POST', body: 'x' }))).toBeUndefined();
        expect(
            await sw.dispatch(new Request(SATELLITE, { headers: { authorization: 'Bearer fictional' } })),
        ).toBeUndefined();
        expect(await sw.dispatch('http://localhost:5173/v4/mapbox.satellite/1/1/1.jpg')).toBeUndefined();
        expect(sw.fetchMock).not.toHaveBeenCalled();
    });

    it('no longer holds Open-Meteo answers: the app reaches Open-Meteo only through its proxy', async () => {
        const sw = loadWorkerWithStore();

        const answer = await sw.dispatch(
            'https://api.open-meteo.com/v1/forecast?latitude=38.5&longitude=-28.6&current=wind_speed_10m',
        );

        expect(answer).toBeUndefined();
        expect(sw.cache(sw.names.data).urls()).toEqual([]);
    });
});
