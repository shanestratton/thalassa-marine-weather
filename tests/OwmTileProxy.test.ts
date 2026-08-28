import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import handler, { OWM_TILE_MAX_BYTES, OWM_TILE_TIMEOUT_MS } from '../api/owm-tile';

const SERVER_SECRET = 'server-only-owm-test-secret';
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);

function request(query: string, method = 'GET'): Request {
    return new Request(`https://www.thalassawx.app/api/owm-tile?${query}`, { method });
}

function pngResponse(bytes = PNG, headers: Record<string, string> = {}): Response {
    return new Response(bytes.slice(), {
        status: 200,
        headers: {
            'content-type': 'image/png',
            'content-length': String(bytes.byteLength),
            ...headers,
        },
    });
}

describe('server-only OWM tile proxy', () => {
    const originalKey = process.env.OWM_API_KEY;

    beforeEach(() => {
        process.env.OWM_API_KEY = SERVER_SECRET;
    });

    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
        if (originalKey === undefined) delete process.env.OWM_API_KEY;
        else process.env.OWM_API_KEY = originalKey;
    });

    it.each([
        ['clouds', 'clouds_new'],
        ['temperature', 'temp_new'],
    ])('pins %s to its allowlisted upstream and never reflects the key', async (layer, upstreamLayer) => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(pngResponse());

        const response = await handler(request(`layer=${layer}&z=3&x=6&y=4`));
        const upstream = new URL(String(fetchSpy.mock.calls[0]?.[0]));

        expect(response.status).toBe(200);
        expect(upstream.origin).toBe('https://tile.openweathermap.org');
        expect(upstream.pathname).toBe(`/map/${upstreamLayer}/3/6/4.png`);
        expect(upstream.searchParams.get('appid')).toBe(SERVER_SECRET);
        expect(fetchSpy.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'manual' });
        expect(response.headers.get('content-type')).toBe('image/png');
        expect(response.headers.get('cache-control')).toBe(
            'public, max-age=300, s-maxage=1800, stale-while-revalidate=3600',
        );
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(response.headers.get('cross-origin-resource-policy')).toBe('cross-origin');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
        expect(`${response.status}\n${[...response.headers].join('\n')}`).not.toContain(SERVER_SECRET);
    });

    it('supports native CORS preflight and bounded HEAD without exposing another method', async () => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(pngResponse());
        const preflight = await handler(request('', 'OPTIONS'));
        const head = await handler(request('layer=clouds&z=0&x=0&y=0', 'HEAD'));

        expect(preflight.status).toBe(204);
        expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
        expect(preflight.headers.get('access-control-allow-methods')).toBe('GET, HEAD, OPTIONS');
        expect(head.status).toBe(200);
        expect(await head.text()).toBe('');
        expect(fetchSpy).toHaveBeenCalledTimes(1);

        const rejected = await handler(request('layer=clouds&z=0&x=0&y=0', 'POST'));
        expect(rejected.status).toBe(405);
        expect(rejected.headers.get('allow')).toBe('GET, HEAD, OPTIONS');
        expect(rejected.headers.get('cache-control')).toBe('no-store');
    });

    it.each([
        'layer=rain&z=3&x=1&y=1',
        'layer=clouds&z=10&x=1&y=1',
        'layer=clouds&z=3&x=8&y=1',
        'layer=clouds&z=3&x=1&y=8',
        'layer=clouds&z=3&x=-1&y=1',
        'layer=clouds&z=03&x=1&y=1',
        'layer=clouds&layer=temperature&z=3&x=1&y=1',
        'layer=clouds&z=3&x=1&y=1&appid=attacker-value',
    ])('rejects malformed or expanded authority without fetching: %s', async (query) => {
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected fetch'));
        const response = await handler(request(query));

        expect(response.status).toBe(400);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fails closed when the Vercel runtime secret is absent', async () => {
        delete process.env.OWM_API_KEY;
        const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('unexpected fetch'));

        const response = await handler(request('layer=clouds&z=0&x=0&y=0'));

        expect(response.status).toBe(503);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(await response.text()).toBe('Weather tile unavailable');
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it.each([
        ['wrong MIME', () => pngResponse(PNG, { 'content-type': 'text/html' })],
        ['wrong signature', () => pngResponse(new Uint8Array(12))],
        ['oversized declaration', () => pngResponse(PNG, { 'content-length': String(OWM_TILE_MAX_BYTES + 1) })],
    ])('rejects %s with one generic non-cacheable response', async (_label, responseFactory) => {
        vi.spyOn(globalThis, 'fetch').mockResolvedValue(responseFactory());

        const response = await handler(request('layer=temperature&z=0&x=0&y=0'));

        expect(response.status).toBe(502);
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(response.headers.get('content-type')).toBe('text/plain; charset=utf-8');
        expect(await response.text()).toBe('Weather tile unavailable');
    });

    it('keeps the upstream timeout active until the tile response exists', async () => {
        vi.useFakeTimers();
        vi.spyOn(globalThis, 'fetch').mockImplementation(
            (_input, init) =>
                new Promise((_resolve, reject) => {
                    init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
                }),
        );

        const pending = handler(request('layer=clouds&z=0&x=0&y=0'));
        await vi.advanceTimersByTimeAsync(OWM_TILE_TIMEOUT_MS);
        const response = await pending;

        expect(response.status).toBe(502);
        expect(response.headers.get('cache-control')).toBe('no-store');
    });
});
