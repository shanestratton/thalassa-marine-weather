// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createForecastAssetsHandler, FORECAST_PUBLIC_QUOTA } from '../supabase/functions/forecast-assets/handler';
import { FORECAST_ASSETS_URL } from '../services/weather/api/forecastAssetsEndpoint';

const FILE = 'g-20261017T000000Z-123456abcdef-h000.bin';
const request = (path: string, init?: RequestInit) => new Request(`${FORECAST_ASSETS_URL}/${path}`, init);
afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});
describe('credential-free fixed public release Edge admission', () => {
    it.each(['gfs-atmos', 'ifs-pressure', 'ssh'] as const)(
        'delivers %s only after public quota and keeps digest headers',
        async (dataset) => {
            const events: string[] = [];
            const quota = vi.fn(async () => {
                events.push('quota');
                return null;
            });
            const upstream = vi.fn(async (input: string, init?: RequestInit) => {
                events.push('upstream');
                expect(input).toMatch(
                    /^https:\/\/github\.com\/shanestratton\/thalassa-ocean-data\/releases\/download\//,
                );
                expect(JSON.stringify(init)).not.toMatch(/private-user|private-cookie|private-api/);
                return new Response(new Uint8Array([1, 2, 3]), {
                    headers: { 'content-type': 'application/octet-stream' },
                });
            });
            vi.stubGlobal('fetch', upstream);
            const response = await createForecastAssetsHandler(quota)(
                request(`${dataset}/${FILE}`, {
                    headers: { Authorization: 'Bearer private-user', Cookie: 'private-cookie', apikey: 'private-api' },
                }),
            );
            expect(response.status).toBe(200);
            expect(events).toEqual(['quota', 'upstream']);
            expect(await response.arrayBuffer()).toEqual(new Uint8Array([1, 2, 3]).buffer);
            expect(response.headers.get('x-content-sha256')).toMatch(/^[a-f0-9]{64}$/);
            expect(response.headers.get('x-thalassa-generation')).toBe('g-20261017T000000Z-123456abcdef');
            expect(response.headers.get('access-control-allow-origin')).toBe('*');
            expect(FORECAST_PUBLIC_QUOTA).toEqual({
                bucket: 'forecast_assets_public',
                limit: 120,
                windowSeconds: 3600,
            });
        },
    );
    it.each([
        'sst/manifest-v2.json',
        'mpa/manifest-v2.json',
        'ssh/manifest.json',
        'ssh/h00.bin',
        'ssh/manifest-v2-a.json',
        'ssh/manifest-v2.json?lat=-27',
        'ssh/manifest-v2.json?url=https://bad.test',
        'ssh/manifest-v2.json?model=gfs',
        'ssh/%6danifest-v2.json',
        'ssh/nested/manifest-v2.json',
        `ssh/${FILE}%2felse`,
        'gfs-atmos/manifest-v2.json#redirect',
    ])('refuses unsupported path %s before quota or public fetch', async (path) => {
        const quota = vi.fn(async () => null),
            upstream = vi.fn();
        vi.stubGlobal('fetch', upstream);
        expect((await createForecastAssetsHandler(quota)(request(path))).status).toBe(400);
        expect(quota).not.toHaveBeenCalled();
        expect(upstream).not.toHaveBeenCalled();
    });
    it('keeps preflight credential-free and rejects mutation and partial requests before quota', async () => {
        const quota = vi.fn(async () => null),
            upstream = vi.fn();
        vi.stubGlobal('fetch', upstream);
        const handle = createForecastAssetsHandler(quota);
        const response = await handle(request('ssh/manifest-v2.json', { method: 'OPTIONS' }));
        expect(response.status).toBe(204);
        expect(response.headers.get('access-control-allow-headers')).toBe('If-None-Match');
        expect((await handle(request('ssh/manifest-v2.json', { method: 'POST', body: '{}' }))).status).toBe(405);
        expect((await handle(request(`ssh/${FILE}`, { headers: { Range: 'bytes=0-2' } }))).status).toBe(400);
        expect(quota).not.toHaveBeenCalled();
        expect(upstream).not.toHaveBeenCalled();
    });
    it.each([429, 503])('holds public upstream when quota returns %s, retaining retry and CORS', async (status) => {
        const upstream = vi.fn();
        vi.stubGlobal('fetch', upstream);
        const handle = createForecastAssetsHandler(
            async () => new Response('held', { status, headers: { 'Retry-After': '60' } }),
        );
        const response = await handle(request(`ssh/${FILE}`));
        expect(response.status).toBe(status);
        expect(response.headers.get('retry-after')).toBe('60');
        expect(response.headers.get('access-control-allow-origin')).toBe('*');
        expect(upstream).not.toHaveBeenCalled();
    });
    it('refuses thrown, stalled or retired quota before publishing, including a late successful RPC', async () => {
        const upstream = vi.fn();
        vi.stubGlobal('fetch', upstream);
        expect(
            (
                await createForecastAssetsHandler(async () => {
                    throw Error('quota unavailable');
                })(request(`ssh/${FILE}`))
            ).status,
        ).toBe(503);
        vi.useFakeTimers();
        let finish!: (value: null) => void;
        let quotaSignal: AbortSignal | undefined;
        const pending = createForecastAssetsHandler(async (_, signal) => {
            quotaSignal = signal;
            return new Promise<null>((resolve) => {
                finish = resolve;
            });
        })(request(`ssh/${FILE}`));
        await vi.advanceTimersByTimeAsync(8000);
        expect((await pending).status).toBe(503);
        expect(quotaSignal?.aborted).toBe(true);
        finish(null);
        await Promise.resolve();
        const controller = new AbortController();
        controller.abort();
        const quota = vi.fn(async () => null);
        expect(
            (await createForecastAssetsHandler(quota)(request(`ssh/${FILE}`, { signal: controller.signal }))).status,
        ).toBe(503);
        expect(quota).not.toHaveBeenCalled();
        expect(upstream).not.toHaveBeenCalled();
    });
    it('preserves complete-object conditional GET after quota', async () => {
        vi.stubGlobal(
            'fetch',
            async () => new Response(new Uint8Array([1]), { headers: { 'content-type': 'application/octet-stream' } }),
        );
        const quota = vi.fn(async () => null),
            handle = createForecastAssetsHandler(quota);
        const first = await handle(request(`ssh/${FILE}`));
        const response = await handle(
            request(`ssh/${FILE}`, { headers: { 'If-None-Match': first.headers.get('etag')! } }),
        );
        expect(response.status).toBe(304);
        expect(await response.text()).toBe('');
        expect(quota).toHaveBeenCalledTimes(2);
    });
    it('holds a quota that succeeds while its caller retires in the same microtask', async () => {
        const upstream = vi.fn();
        vi.stubGlobal('fetch', upstream);
        const controller = new AbortController();
        const handle = createForecastAssetsHandler(async () => {
            queueMicrotask(() => controller.abort());
            return null;
        });
        expect((await handle(request(`ssh/${FILE}`, { signal: controller.signal }))).status).toBe(503);
        expect(upstream).not.toHaveBeenCalled();
    });
});
