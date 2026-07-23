import { describe, expect, it } from 'vitest';
import {
    hasPngSignature,
    hasWebpSignature,
    isJsonContentType,
    jsonResponse,
    parseBoundedInteger,
    parseBoundedNumber,
    parseCoordinate,
    parseForecastHours,
    parseGeoBounds,
    readJsonObject,
    readResponseArrayBufferLimited,
    readResponseJsonObjectLimited,
    readResponseTextLimited,
    requireServiceRolePost,
} from '../supabase/functions/_shared/http-security';

function streamedRequest(chunks: string[]): Request {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
            controller.close();
        },
    });
    return new Request('https://thalassa.example/functions/v1/test', {
        method: 'POST',
        body,
        duplex: 'half',
    } as RequestInit & { duplex: 'half' });
}

describe('Edge HTTP trust-boundary helpers', () => {
    it('accepts only finite, bounded numeric input', () => {
        expect(parseCoordinate('-27.47', 'lat')).toBe(-27.47);
        expect(parseCoordinate(180, 'lon')).toBe(180);
        expect(parseCoordinate(' ', 'lat')).toBeNull();
        expect(parseCoordinate('Infinity', 'lon')).toBeNull();
        expect(parseCoordinate(90.0001, 'lat')).toBeNull();

        expect(parseBoundedNumber('0.5', 0.5, 100)).toBe(0.5);
        expect(parseBoundedNumber('1e309', 0, 100)).toBeNull();
        expect(parseBoundedInteger('250', 1, 250)).toBe(250);
        expect(parseBoundedInteger('2.5', 1, 250)).toBeNull();
    });

    it('validates normal and antimeridian-crossing geographic bounds', () => {
        expect(parseGeoBounds({ north: 10, south: -10, east: 20, west: -20 })).toMatchObject({
            latSpan: 20,
            lonSpan: 40,
        });
        expect(parseGeoBounds({ north: 10, south: -10, east: -170, west: 170 })).toMatchObject({
            lonSpan: 20,
        });
        expect(parseGeoBounds({ north: -10, south: 10, east: 20, west: -20 })).toBeNull();
        expect(parseGeoBounds({ north: 10, south: -10, east: 10, west: 10 })).toBeNull();
    });

    it('deduplicates forecast hours but rejects oversized or invalid arrays', () => {
        expect(parseForecastHours([6, 0, 3, 3], [0], 4, 12)).toEqual([0, 3, 6]);
        expect(parseForecastHours(undefined, [0, 3], 4, 12)).toEqual([0, 3]);
        expect(parseForecastHours([], [0], 4, 12)).toBeNull();
        expect(parseForecastHours([0, 3, 6, 9, 12], [0], 4, 12)).toBeNull();
        expect(parseForecastHours([0, 12.5], [0], 4, 12)).toBeNull();
    });

    it('requires an exact POST and exact service-role bearer credential', () => {
        const key = 'service-role-secret';
        expect(requireServiceRolePost(new Request('https://thalassa.example', { method: 'GET' }), key)?.status).toBe(
            405,
        );
        expect(
            requireServiceRolePost(
                new Request('https://thalassa.example', {
                    method: 'POST',
                    headers: { authorization: `bearer ${key}` },
                }),
                key,
            )?.status,
        ).toBe(401);
        expect(
            requireServiceRolePost(
                new Request('https://thalassa.example', {
                    method: 'POST',
                    headers: { authorization: `Bearer ${key}` },
                }),
                key,
            ),
        ).toBeNull();
    });

    it('bounds chunked request bodies without trusting Content-Length', async () => {
        await expect(readJsonObject(streamedRequest(['{"safe":', 'true}']), 32)).resolves.toEqual({ safe: true });
        await expect(readJsonObject(streamedRequest(['{"payload":"', 'x'.repeat(64), '"}']), 32)).resolves.toBeNull();
        await expect(readJsonObject(streamedRequest(['["not","an","object"]']), 64)).resolves.toBeNull();
    });

    it('bounds streaming upstream responses and verifies binary signatures', async () => {
        await expect(readResponseTextLimited(new Response('123456'), 5)).resolves.toBeNull();
        await expect(readResponseTextLimited(new Response('123456'), 6)).resolves.toBe('123456');
        await expect(
            readResponseArrayBufferLimited(
                new Response(new Uint8Array([1, 2, 3]), { headers: { 'Content-Length': '100' } }),
                10,
            ),
        ).resolves.toBeNull();

        const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
        expect(hasPngSignature(png.buffer)).toBe(true);
        expect(hasPngSignature(new TextEncoder().encode('<html>error</html>').buffer)).toBe(false);

        const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
        expect(hasWebpSignature(webp.buffer)).toBe(true);
        expect(hasWebpSignature(new TextEncoder().encode('RIFFfakeJPEG').buffer)).toBe(false);
    });

    it('requires an advertised JSON media type, a byte-bounded body, and an object root', async () => {
        expect(isJsonContentType('application/json; charset=utf-8')).toBe(true);
        expect(isJsonContentType('application/problem+json')).toBe(true);
        expect(isJsonContentType('text/html')).toBe(false);

        await expect(
            readResponseJsonObjectLimited(
                new Response('{"safe":true}', { headers: { 'Content-Type': 'application/json' } }),
                64,
            ),
        ).resolves.toEqual({ safe: true });
        await expect(
            readResponseJsonObjectLimited(
                new Response('["not-an-object"]', { headers: { 'Content-Type': 'application/json' } }),
                64,
            ),
        ).resolves.toBeNull();
        await expect(
            readResponseJsonObjectLimited(
                new Response('{"safe":true}', { headers: { 'Content-Type': 'text/html' } }),
                64,
            ),
        ).resolves.toBeNull();
        await expect(
            readResponseJsonObjectLimited(
                new Response(`{"payload":"${'x'.repeat(80)}"}`, {
                    headers: { 'Content-Type': 'application/json' },
                }),
                32,
            ),
        ).resolves.toBeNull();
    });

    it('sets defensive JSON defaults while permitting an intentional cache override', () => {
        const response = jsonResponse({ ok: true }, 200, { 'Cache-Control': 'private, max-age=5' });
        expect(response.headers.get('content-type')).toBe('application/json');
        expect(response.headers.get('cache-control')).toBe('private, max-age=5');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    });
});
