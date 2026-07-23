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
    const cache = {
        addAll: vi.fn().mockResolvedValue(undefined),
        match: vi.fn().mockResolvedValue(undefined),
        put: vi.fn().mockResolvedValue(undefined),
        keys: vi.fn().mockResolvedValue([]),
        delete: vi.fn().mockResolvedValue(true),
    };
    const caches = {
        open: vi.fn().mockResolvedValue(cache),
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

    return { listeners, cache, caches, fetchMock };
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
        const { listeners, cache, fetchMock } = loadServiceWorker();
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
        expect(cache.put).toHaveBeenCalledOnce();
    });
});
