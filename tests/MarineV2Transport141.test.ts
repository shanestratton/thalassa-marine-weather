import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    fetchMarineEnvelopeV2,
    MARINE_V2_SOURCE_BYTES,
    MARINE_V2_SOURCE_DEADLINE_MS,
} from '../supabase/functions/get-marine/marine-v2';
import { marineFixtureSource, MARINE_FIXTURE_AT as at, MARINE_FIXTURE_POINT as point } from './fixtures/marineV2141';

const json = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(at);
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});
describe('actual schema-2 upstream transport', () => {
    it('makes two parallel bounded model-specific reads and never returns the provider key', async () => {
        const calls: URL[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string, init: RequestInit) => {
                calls.push(new URL(url));
                expect(init.redirect).toBe('error');
                expect(init.signal).toBeInstanceOf(AbortSignal);
                return json(
                    marineFixtureSource(
                        new URL(url).searchParams.get('models') === 'meteofrance_wave' ? 'waves' : 'motion',
                    ),
                );
            }),
        );
        const result = await fetchMarineEnvelopeV2(point, 'fictional-provider-key');
        expect(calls).toHaveLength(2);
        expect(calls.map((url) => url.searchParams.get('models'))).toEqual(['meteofrance_wave', 'best_match']);
        for (const url of calls) {
            expect(url.origin).toBe('https://customer-marine-api.open-meteo.com');
            expect(url.searchParams.get('apikey')).toBe('fictional-provider-key');
        }
        expect(result?.fetched_at_ms).toBe(at);
        expect(result?.waves?.current.wave_height).toBe(1.5);
        expect(result?.motion?.current.ocean_current_velocity).toBe(3.6);
        expect(JSON.stringify(result)).not.toContain('fictional-provider-key');
        expect(vi.getTimerCount()).toBe(0);
    });
    it('retains motion/SST when the independent wave provider fails', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async (url: string) =>
                new URL(url).searchParams.get('models') === 'meteofrance_wave'
                    ? new Response('', { status: 503 })
                    : json(marineFixtureSource('motion')),
            ),
        );
        const result = await fetchMarineEnvelopeV2(point, 'fictional');
        expect(result?.waves).toBeNull();
        expect(result?.motion?.current.sea_surface_temperature).toBe(21);
    });
    it.each(['not-json', 'array', 'malformed', 'declared-oversize', 'streamed-oversize'])(
        'refuses bounded invalid upstream bodies: %s',
        async (mode) => {
            vi.stubGlobal(
                'fetch',
                vi.fn(async () => {
                    if (mode === 'not-json') return new Response('{}', { headers: { 'Content-Type': 'text/html' } });
                    if (mode === 'array') return json([]);
                    if (mode === 'malformed')
                        return new Response('{', { headers: { 'Content-Type': 'application/json' } });
                    if (mode === 'declared-oversize')
                        return new Response('{}', {
                            headers: {
                                'Content-Type': 'application/json',
                                'Content-Length': String(MARINE_V2_SOURCE_BYTES + 1),
                            },
                        });
                    return json({ pad: 'x'.repeat(MARINE_V2_SOURCE_BYTES) });
                }),
            );
            expect(await fetchMarineEnvelopeV2(point, 'fictional')).toBeNull();
            expect(vi.getTimerCount()).toBe(0);
        },
    );
    it.each(['headers', 'body'])('aborts the actual %s wait at the source deadline', async (stage) => {
        const signals: AbortSignal[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn((_url: string, init: RequestInit) => {
                const signal = init.signal!;
                signals.push(signal);
                if (stage === 'headers')
                    return new Promise((_resolve, reject) =>
                        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), {
                            once: true,
                        }),
                    );
                return Promise.resolve(
                    new Response(
                        new ReadableStream({
                            start(controller) {
                                signal.addEventListener(
                                    'abort',
                                    () => controller.error(new DOMException('aborted', 'AbortError')),
                                    { once: true },
                                );
                            },
                        }),
                        { headers: { 'Content-Type': 'application/json' } },
                    ),
                );
            }),
        );
        const pending = fetchMarineEnvelopeV2(point, 'fictional');
        await vi.advanceTimersByTimeAsync(MARINE_V2_SOURCE_DEADLINE_MS - 1);
        expect(signals).toHaveLength(2);
        expect(signals.some((signal) => signal.aborted)).toBe(false);
        await vi.advanceTimersByTimeAsync(1);
        expect(await pending).toBeNull();
        expect(signals.every((signal) => signal.aborted)).toBe(true);
        expect(vi.getTimerCount()).toBe(0);
    });
});
