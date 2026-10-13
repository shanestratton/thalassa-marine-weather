import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Calypso's thalassa_weather tool on the device (services/voice/cloudTools.ts).
 *
 * 127-H: the place-name lookup goes through the same commercial Open-Meteo
 * boundary as the forecast (proxy-openmeteo's fixed `geocode` operation), so
 * no phone or browser ever calls a free Open-Meteo host, and the key stays on
 * the server. Coordinates below are fictional.
 */

vi.mock('../services/supabase', () => ({
    supabaseUrl: 'https://example.supabase.co',
    supabaseAnonKey: 'public-anon-key',
    supabase: { auth: { getSession: vi.fn().mockResolvedValue({ data: { session: null }, error: null }) } },
}));

import { runThalassaWeather } from '../services/voice/cloudTools';

const PROXY = 'https://example.supabase.co/functions/v1/proxy-openmeteo';

type ProxyBody = { operation: string; params: Record<string, unknown> };

function json(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

/** A fetch that answers proxy-openmeteo by operation and records every call. */
function stubProxy(answers: Partial<Record<string, () => Response>>) {
    const calls: Array<{ url: string; body: ProxyBody | null }> = [];
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as ProxyBody) : null;
        calls.push({ url, body });
        if (url !== PROXY || !body) return new Response('not here', { status: 404 });
        const answer = answers[body.operation];
        return answer ? answer() : json({ error: 'Invalid request' }, 400);
    });
    vi.stubGlobal('fetch', fetchMock);
    return { calls, fetchMock };
}

const FORECAST = { current: { wind_speed_10m: 14, wind_direction_10m: 120 } };
const MARINE = { current: { wave_height: 1.1 } };

describe('Calypso thalassa_weather on the device', () => {
    beforeEach(() => {
        vi.unstubAllGlobals();
    });

    it('geocodes a place name through proxy-openmeteo, then asks for the forecast and the sea there', async () => {
        const { calls } = stubProxy({
            geocode: () =>
                json({
                    results: [
                        {
                            name: 'Whitehaven Beach',
                            latitude: -20.2832,
                            longitude: 149.0391,
                            country: 'Exampleland',
                            admin1: 'North Province',
                        },
                    ],
                }),
            forecast: () => json(FORECAST),
            marine: () => json(MARINE),
        });

        const result = await runThalassaWeather({ location: 'Whitehaven Beach' });

        expect(result.isError).toBe(false);
        expect(calls[0]).toEqual({
            url: PROXY,
            body: {
                operation: 'geocode',
                params: { name: 'Whitehaven Beach', count: 1, language: 'en', format: 'json' },
            },
        });
        const later = calls.slice(1).map((call) => call.body);
        expect(later.map((body) => body?.operation).sort()).toEqual(['forecast', 'marine']);
        for (const body of later) {
            expect(body?.params).toMatchObject({ latitude: '-20.2832', longitude: '149.0391' });
        }
        const content = JSON.parse(result.content) as { location: { name: string; lat: number; lng: number } };
        expect(content.location).toEqual({
            name: 'Whitehaven Beach, North Province, Exampleland',
            lat: -20.2832,
            lng: 149.0391,
        });
        // Never a provider host from the phone or the browser.
        for (const call of calls) expect(call.url).not.toContain('open-meteo.com');
        expect(JSON.stringify(calls)).not.toContain('apikey');
    });

    it('works the same anywhere in the world (a North Atlantic harbour, no admin area)', async () => {
        const { calls } = stubProxy({
            geocode: () =>
                json({
                    results: [
                        { name: 'Porto Ficticio', latitude: 38.5312, longitude: -28.6271, country: 'Exampleland' },
                    ],
                }),
            forecast: () => json(FORECAST),
            marine: () => json(MARINE),
        });

        const result = await runThalassaWeather({ location: '  Porto Ficticio  ' });

        expect(result.isError).toBe(false);
        expect(calls[0].body?.params).toEqual({ name: 'Porto Ficticio', count: 1, language: 'en', format: 'json' });
        expect(JSON.parse(result.content).location).toEqual({
            name: 'Porto Ficticio, Exampleland',
            lat: 38.5312,
            lng: -28.6271,
        });
    });

    it.each([
        ['no match', () => json({ generationtime_ms: 0.4 })],
        ['a malformed hit', () => json({ results: [{ name: 'Nowhere', latitude: 'north', longitude: null }] })],
    ])('returns "could not geocode" on %s, and asks for no forecast', async (_label, geocode) => {
        const { calls } = stubProxy({ geocode, forecast: () => json(FORECAST), marine: () => json(MARINE) });

        const result = await runThalassaWeather({ location: 'Whitehaven Beach' });

        expect(result).toEqual({ content: 'ERROR: could not geocode "Whitehaven Beach"', isError: true });
        expect(calls.map((call) => call.body?.operation)).toEqual(['geocode']);
        for (const call of calls) expect(call.url).not.toContain('open-meteo.com');
    });

    it.each([
        // 400 is exactly what today's proxy-openmeteo answers an operation it
        // does not know yet: the app shipping before the edge deploy must not
        // tell the skipper a real place does not exist, and never falls back
        // to a free host.
        ['the edge not deployed yet (400)', () => json({ error: 'Invalid request' }, 400)],
        ['no key on the server (503)', () => json({ error: 'Weather service unavailable' }, 503)],
        ['quota (429)', () => json({ error: 'Too many requests' }, 429)],
        [
            'a dead network',
            () => {
                throw new TypeError('Failed to fetch');
            },
        ],
    ])('says the lookup is unavailable (not that the place is unknown) on %s', async (_label, geocode) => {
        const { calls } = stubProxy({ geocode, forecast: () => json(FORECAST), marine: () => json(MARINE) });

        const result = await runThalassaWeather({ location: 'Porto Ficticio' });

        expect(result).toEqual({
            content:
                'ERROR: place-name lookup unavailable right now, so "Porto Ficticio" was not looked up; retry with lat/lng',
            isError: true,
        });
        expect(result.content).not.toContain('could not geocode');
        expect(calls.map((call) => call.body?.operation)).toEqual(['geocode']);
        for (const call of calls) expect(call.url).not.toContain('open-meteo.com');
    });

    it('never sends a place name the proxy would refuse (over 100 characters, or control characters)', async () => {
        const { calls } = stubProxy({});

        const long = await runThalassaWeather({ location: 'x'.repeat(101) });
        const control = await runThalassaWeather({ location: 'Bay\u0000of Examples' });

        expect(long.isError).toBe(true);
        expect(long.content).toMatch(/^ERROR: could not geocode/);
        expect(control.isError).toBe(true);
        expect(calls).toHaveLength(0);
    });

    it('makes no geocode call when given coordinates', async () => {
        const { calls } = stubProxy({ forecast: () => json(FORECAST), marine: () => json(MARINE) });

        const result = await runThalassaWeather({ lat: 51.9012, lng: -8.4011, location: 'Example Harbour' });

        expect(result.isError).toBe(false);
        expect(calls.map((call) => call.body?.operation).sort()).toEqual(['forecast', 'marine']);
        expect(JSON.parse(result.content).location).toEqual({ name: 'Example Harbour', lat: 51.9012, lng: -8.4011 });
    });
});
