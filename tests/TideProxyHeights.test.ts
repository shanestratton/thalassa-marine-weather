import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const quota = vi.hoisted(() => vi.fn(async () => ({ userId: 'test' })));
vi.mock('../supabase/functions/_shared/auth-rate-limit.ts', () => ({
    requireAuthenticatedOrPublicQuota: quota,
    withCors: (response: Response) => response,
}));
let handler: (request: Request) => Promise<Response>;
const upstream = vi.fn();
const dt = Date.parse('2026-09-20T02:00:00Z') / 1000;
const height = { dt, date: new Date(dt * 1000).toISOString(), height: 1.2 };
const data = () => ({
    status: 200,
    extremes: [{ ...height, type: 'High' }],
    heights: [height],
    requestDatum: 'LAT',
    responseDatum: 'LAT',
    copyright: 'WorldTides',
});
beforeAll(async () => {
    vi.stubGlobal('Deno', {
        serve: (fn: typeof handler) => {
            handler = fn;
        },
        env: { get: () => 'test-server-only-key' },
    });
    // Runtime import keeps Deno's URL-import graph outside the app's tsc
    // program; Vitest supplies its auth boundary mock above.
    const edgeModule = '../supabase/functions/proxy-tides/index';
    await import(edgeModule);
});
beforeEach(() => {
    upstream.mockReset();
    quota.mockClear();
    vi.stubGlobal('fetch', upstream);
    upstream.mockResolvedValue(
        new Response(JSON.stringify(data()), { headers: { 'Content-Type': 'application/json' } }),
    );
});
afterAll(() => {
    vi.unstubAllGlobals();
});
const request = (body: Record<string, unknown>) =>
    handler(
        new Request('https://example.com/proxy-tides', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ lat: -21.1, lon: 149.2, ...body }),
        }),
    );

describe('bounded additive tide heights proxy mode', () => {
    it('retains existing extremes-only defaults, server-only credentials and unchanged quota', async () => {
        expect((await request({})).status).toBe(200);
        const url = new URL(upstream.mock.calls[0][0]);
        expect(url.origin).toBe('https://www.worldtides.info');
        expect(url.searchParams.get('days')).toBe('14');
        expect(url.searchParams.has('heights')).toBe(false);
        expect(url.searchParams.get('datum')).toBe('LAT');
        expect(quota).toHaveBeenCalledWith(expect.any(Request), 'tides', 60, 12, 3600);
    });
    it('adds bounded half-hourly heights, actual datum and timezone to an on-demand station request', async () => {
        const response = await request({
            heights: true,
            days: 3,
            stationDistance: 1,
            host: 'https://evil.test',
            step: 1,
        });
        expect(response.status).toBe(200);
        const url = new URL(upstream.mock.calls[0][0]);
        expect(url.origin).toBe('https://www.worldtides.info');
        expect(url.searchParams.has('heights')).toBe(true);
        expect(url.searchParams.has('extremes')).toBe(true);
        expect(url.searchParams.get('step')).toBe('1800');
        expect(url.searchParams.has('timezone')).toBe(true);
        expect(url.searchParams.has('localtime')).toBe(true);
        expect((await response.json()).heights).toEqual([height]);
    });
    it.each([
        { heights: true, days: 4 },
        { heights: true, stations: true, days: 2 },
        { heights: '1', days: 2 },
        { heights: {}, days: 2 },
    ])('refuses invalid or costly dense request %j before upstream', async (body) => {
        expect((await request(body)).status).toBe(400);
        expect(upstream).not.toHaveBeenCalled();
    });
    it.each([
        [{ ...height, date: 'not a date' }],
        [{ ...height, height: null }],
        [{ ...height, height: 999 }],
        Array.from({ length: 147 }, () => height),
    ])('rejects invalid or excessive upstream heights', async (...args) => {
        const heights = args.length === 1 && Array.isArray(args[0]) ? args[0] : args;
        upstream.mockResolvedValueOnce(
            new Response(JSON.stringify({ ...data(), heights }), { headers: { 'Content-Type': 'application/json' } }),
        );
        expect((await request({ heights: true, days: 3 })).status).toBe(502);
    });
});
