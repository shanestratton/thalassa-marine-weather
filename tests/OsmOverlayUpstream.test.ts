// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    fetchOverpassDocument,
    isOverlayPayload,
    overlayCacheKey,
    overlayUnavailableResponse,
    OVERLAY_FIELDS,
    OVERPASS_ATTEMPT_MS,
    OVERPASS_ENDPOINTS,
    OVERPASS_MAX_BYTES,
    OVERPASS_MAX_ELEMENTS,
    parseOverpassDocument,
} from '../supabase/functions/_shared/overpass-fetch';

const query = '[out:json][timeout:30];way[man_made=pier](0,0,0.001,0.001);out geom;';
const result = {
    elements: [
        {
            type: 'way',
            id: 1,
            geometry: [
                { lat: 0, lon: 0 },
                { lat: 0.001, lon: 0 },
            ],
        },
    ],
};
const json = (value: unknown = result) => new Response(JSON.stringify(value));
beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined));
afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('OSM obstacle upstream recovery', () => {
    it('makes one identified, bounded request when the primary works', async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json());
        await expect(fetchOverpassDocument(query, undefined, fetcher)).resolves.toEqual(result);
        expect(fetcher).toHaveBeenCalledTimes(1);
        const [url, init] = fetcher.mock.calls[0];
        expect(url).toBe(OVERPASS_ENDPOINTS[0]);
        expect(init).toMatchObject({ method: 'POST', redirect: 'error', body: 'data=' + encodeURIComponent(query) });
        expect(init?.headers).toEqual({
            'Content-Type': 'application/x-www-form-urlencoded',
            Accept: 'application/json',
            'User-Agent': 'thalassa-osm-overlay/1.0 (https://thalassawx.app)',
        });
        expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it.each([406, 429, 500, 502, 503, 504])(
        'recovers from HTTP %i using the same query on one independent instance',
        async (status) => {
            const fetcher = vi
                .fn<typeof fetch>()
                .mockResolvedValueOnce(new Response('rejected', { status }))
                .mockResolvedValueOnce(json());
            await expect(fetchOverpassDocument(query, undefined, fetcher)).resolves.toEqual(result);
            expect(fetcher.mock.calls.map(([url]) => url)).toEqual([...OVERPASS_ENDPOINTS]);
            expect(fetcher.mock.calls[1][1]?.body).toBe(fetcher.mock.calls[0][1]?.body);
        },
    );

    it('recovers from a transport failure without exposing its raw URL/message', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockRejectedValueOnce(new Error('private position / bearer'))
            .mockResolvedValueOnce(json());
        await expect(fetchOverpassDocument(query, undefined, fetcher)).resolves.toEqual(result);
        expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private position');
    });

    it.each([
        ['partial runtime error', { ...result, remark: 'runtime error: Query timed out' }],
        ['HTML as success', '<html>busy</html>'],
        ['invalid schema', { elements: null }],
        ['null element', { elements: [null] }],
        ['unexpected class', { elements: [{ type: 'node', id: 2 }] }],
        ['oversized element list', { elements: Array(OVERPASS_MAX_ELEMENTS + 1).fill({ type: 'way' }) }],
    ])('does not accept %s as a complete obstacle inventory', async (_name, bad) => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(typeof bad === 'string' ? new Response(bad) : json(bad))
            .mockResolvedValueOnce(json());
        await expect(fetchOverpassDocument(query, undefined, fetcher)).resolves.toEqual(result);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('bounds upstream bytes before parsing and falls back', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(
                new Response('{}', {
                    headers: { 'Content-Length': String(OVERPASS_MAX_BYTES + 1) },
                }),
            )
            .mockResolvedValueOnce(json());
        await expect(fetchOverpassDocument(query, undefined, fetcher)).resolves.toEqual(result);
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('returns no fabricated empty data when both endpoints fail', async () => {
        const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('no', { status: 406 }));
        await expect(fetchOverpassDocument(query, undefined, fetcher)).rejects.toThrow(
            'Overpass unavailable (HTTP 406; HTTP 406)',
        );
        expect(fetcher).toHaveBeenCalledTimes(2);
    });

    it('does not retry a malformed query on another host', async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('invalid query', { status: 400 }));
        await expect(fetchOverpassDocument(query, undefined, fetcher)).rejects.toThrow('rejected the query');
        expect(fetcher).toHaveBeenCalledTimes(1);
    });

    it('bounds even a fetch implementation that ignores abort', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
        const promise = fetchOverpassDocument(query, undefined, fetcher);
        const assertion = expect(promise).rejects.toThrow('Overpass unavailable (timeout; timeout)');
        await vi.advanceTimersByTimeAsync(OVERPASS_ATTEMPT_MS * 2);
        await assertion;
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(fetcher.mock.calls.every(([, init]) => init?.signal?.aborted)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('deadline includes a stalled body, not only the arrival of headers', async () => {
        vi.useFakeTimers();
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValueOnce(new Response(new ReadableStream()))
            .mockResolvedValueOnce(json());
        const promise = fetchOverpassDocument(query, undefined, fetcher);
        await vi.advanceTimersByTimeAsync(OVERPASS_ATTEMPT_MS);
        await expect(promise).resolves.toEqual(result);
        expect(fetcher).toHaveBeenCalledTimes(2);
        expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });

    it('never sends a cancelled request or starts a fallback after cancellation', async () => {
        const controller = new AbortController();
        const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
        const promise = fetchOverpassDocument(query, controller.signal, fetcher);
        controller.abort();
        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        expect(fetcher).toHaveBeenCalledTimes(1);
        await expect(fetchOverpassDocument(query, controller.signal, fetcher)).rejects.toMatchObject({
            name: 'AbortError',
        });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
});

describe('OSM cache and error contract', () => {
    it('keeps genuinely empty successful responses distinct from errors', () => {
        expect(parseOverpassDocument('{"elements":[]}')).toEqual({ elements: [] });
        expect(() => parseOverpassDocument('{"elements":[],"remark":"timeout"}')).toThrow();
    });
    it('does not reuse an old schema or a nearby bbox missing an obstacle', () => {
        expect(overlayCacheKey([153.08, -27.22, 153.09, -27.17])).toMatch(/^v6_/);
        expect(overlayCacheKey([153.08, -27.22, 153.09, -27.17])).not.toBe(
            overlayCacheKey([153.08, -27.22, 153.0901, -27.17]),
        );
    });
    it('requires every obstacle collection in cached payloads', () => {
        const full = Object.fromEntries(
            OVERLAY_FIELDS.map((key) => [key, { type: 'FeatureCollection', features: [] }]),
        );
        expect(isOverlayPayload(full)).toBe(true);
        expect(isOverlayPayload({ ...full, berths: undefined })).toBe(false);
        expect(isOverlayPayload({ ...full, breakwater: { type: 'FeatureCollection', features: null } })).toBe(false);
        expect(isOverlayPayload(null)).toBe(false);
    });
    it('serves explicit non-cacheable failure, not an HTTP-200 empty overlay', async () => {
        const response = overlayUnavailableResponse({ 'Access-Control-Allow-Origin': '*' });
        expect(response.status).toBe(503);
        expect(response.headers.get('Cache-Control')).toBe('no-store');
        expect(response.headers.get('Retry-After')).toBe('30');
        expect(response.headers.get('X-Overlay-Cache')).toBe('error');
        expect(await response.json()).toMatchObject({ code: 'OVERLAY_UPSTREAM_UNAVAILABLE' });
    });
    it('wires recovery behind unchanged authorization and exposes the error marker to browsers', () => {
        const source = readFileSync('supabase/functions/osm-overlay/index.ts', 'utf8');
        expect(source).toContain("requireAuthenticatedOrPublicQuota(req, 'osm_overlay', 120, 20, 3600)");
        expect(source.indexOf('requireAuthenticatedOrPublicQuota(req')).toBeLessThan(
            source.indexOf('const fresh = await fetchFromOverpass('),
        );
        expect(source).toMatch(/'Access-Control-Expose-Headers': '[^']*X-Overlay-Cache[^']*Retry-After'/);
        expect(source).toContain('fetchOverpassDocument(buildQuery(bbox), signal)');
        expect(source).toContain('return overlayUnavailableResponse(CORS)');
        expect(source).toContain('isOverlayPayload(hit.payload) && age >= 0 && age < CACHE_TTL_MS');
    });
});
