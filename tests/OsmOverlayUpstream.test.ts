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

import { queryForOwnedOsm } from '../services/osm/ownedOverpassContract';
const operation = {
    schema: 1 as const,
    kind: 'overlay' as const,
    bbox: [0, 0, 0.001, 0.001] as [number, number, number, number],
};
const query = queryForOwnedOsm(operation);
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
const sourceAt = new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
const document = (value: unknown = result) => ({
    ...(value as object),
    osm3s: { timestamp_osm_base: sourceAt },
    thalassaSource: { schema: 1, complete: true, licence: 'ODbL-1.0', sourceAt, cohortSha256: 'a'.repeat(64) },
});
const json = (value: unknown = result) => new Response(JSON.stringify(document(value)));
const settings: Record<string, string> = {
    THALASSA_WX_OSM_ORIGIN: 'https://wx-data.thalassawx.app',
    THALASSA_WX_OSM_TOKEN: 'server_fixture_'.repeat(3),
};
const env = (name: string) => settings[name];
const ask = (fetcher: typeof fetch, signal?: AbortSignal) => fetchOverpassDocument(query, signal, fetcher, env);
beforeEach(() => vi.spyOn(console, 'warn').mockImplementation(() => undefined));
afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
});

describe('Owned OSM obstacle upstream', () => {
    it('makes one fixed authenticated bounded operation without forwarding a user bearer or QL', async () => {
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(json());
        await expect(ask(fetcher)).resolves.toEqual({ ...result, sourceAt });
        expect(fetcher).toHaveBeenCalledTimes(1);
        const [url, init] = fetcher.mock.calls[0];
        expect(url).toBe(OVERPASS_ENDPOINTS[0]);
        expect(init).toMatchObject({ method: 'POST', redirect: 'error', body: JSON.stringify(operation) });
        expect(init?.headers).toEqual({
            'Content-Type': 'application/json',
            Accept: 'application/json',
            Authorization: `Bearer ${settings.THALASSA_WX_OSM_TOKEN}`,
        });
        expect(init?.signal).toBeInstanceOf(AbortSignal);
    });
    it.each([406, 429, 500, 502, 503, 504])(
        'HTTP%i refuses once without a public mirror or fake empty success',
        async (status) => {
            const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('rejected', { status }));
            await expect(ask(fetcher)).rejects.toThrow();
            expect(fetcher).toHaveBeenCalledTimes(1);
            expect(fetcher.mock.calls.map(([url]) => url)).toEqual([...OVERPASS_ENDPOINTS]);
        },
    );
    it('transport failure does not retry or expose the raw private error', async () => {
        const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('private position / bearer'));
        await expect(ask(fetcher)).rejects.toThrow();
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(JSON.stringify(vi.mocked(console.warn).mock.calls)).not.toContain('private position');
    });
    it.each([
        ['partial runtime error', { ...result, remark: 'runtime error: Query timed out' }],
        ['HTML as success', '<html>busy</html>'],
        ['invalid schema', { elements: null }],
        ['null element', { elements: [null] }],
        ['unexpected class', { elements: [{ type: 'node', id: 2 }] }],
        ['oversized element list', { elements: Array(OVERPASS_MAX_ELEMENTS + 1).fill({ type: 'way', id: 1 }) }],
    ])('does not accept %s as a complete obstacle inventory', async (_name, bad) => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValue(typeof bad === 'string' ? new Response(bad) : json(bad));
        await expect(ask(fetcher)).rejects.toThrow();
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('bounds upstream bytes before parsing without trying another host', async () => {
        const fetcher = vi
            .fn<typeof fetch>()
            .mockResolvedValue(new Response('{}', { headers: { 'Content-Length': String(OVERPASS_MAX_BYTES + 1) } }));
        await expect(ask(fetcher)).rejects.toThrow();
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
    it('unconfigured or foreign own origin refuses before network', async () => {
        const fetcher = vi.fn<typeof fetch>();
        for (const origin of [
            undefined,
            'https://overpass-api.de',
            'http://wx',
            'https://wx-data.thalassawx.app/other',
        ])
            await expect(
                fetchOverpassDocument(query, undefined, fetcher, (name) =>
                    name === 'THALASSA_WX_OSM_ORIGIN' ? origin : settings[name],
                ),
            ).rejects.toThrow();
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('unknown or malicious recipe refuses before network', async () => {
        const fetcher = vi.fn<typeof fetch>();
        await expect(fetchOverpassDocument('[out:json];nwr;out;', undefined, fetcher, env)).rejects.toThrow();
        expect(fetcher).not.toHaveBeenCalled();
    });
    it('bounds even a fetch implementation that ignores abort', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
        const promise = ask(fetcher);
        const assertion = expect(promise).rejects.toThrow('deadline');
        await vi.advanceTimersByTimeAsync(OVERPASS_ATTEMPT_MS);
        await assertion;
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('deadline includes a stalled body, not only the arrival of headers', async () => {
        vi.useFakeTimers();
        const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(new ReadableStream()));
        const promise = ask(fetcher);
        const assertion = expect(promise).rejects.toThrow('deadline');
        await vi.advanceTimersByTimeAsync(OVERPASS_ATTEMPT_MS);
        await assertion;
        expect(fetcher).toHaveBeenCalledTimes(1);
        expect(fetcher.mock.calls[0][1]?.signal?.aborted).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
    it('cancelled intent never starts a fallback or another request', async () => {
        const controller = new AbortController();
        const fetcher = vi.fn<typeof fetch>().mockImplementation(() => new Promise(() => undefined));
        const promise = ask(fetcher, controller.signal);
        controller.abort();
        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        expect(fetcher).toHaveBeenCalledTimes(1);
        await expect(ask(fetcher, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(fetcher).toHaveBeenCalledTimes(1);
    });
});

describe('OSM cache and error contract', () => {
    it('keeps genuinely empty successful responses distinct from errors', () => {
        expect(parseOverpassDocument('{"elements":[]}')).toEqual({ elements: [] });
        expect(() => parseOverpassDocument('{"elements":[],"remark":"timeout"}')).toThrow();
    });
    it('does not reuse an old schema or a nearby bbox missing an obstacle', () => {
        expect(overlayCacheKey([153.08, -27.22, 153.09, -27.17])).toMatch(/^v7_owned_/);
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
