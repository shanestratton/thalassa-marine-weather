// @vitest-environment node
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    buildSevenCsRequest,
    createAutoroutingTrialHandler,
    parseSevenCsResult,
    SEVENCS_ROUTE_URL,
    SEVENCS_TOKEN_URL,
    TRIAL_MAX_RESPONSE_BYTES,
    TRIAL_PROVIDER_TIMEOUT_MS,
    validateTrialInput,
} from '../supabase/functions/_shared/autorouting-trial';

const USER = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-09-12T00:00:00Z');
const input = {
    departure: { lat: -26.65, lon: 153.3 },
    destination: { lat: -26.4, lon: 153.3 },
    draftM: 2.4,
    speedKts: 6.5,
};
const points = [
    [153.3, -26.65],
    [153.3, -26.5],
    [153.3, -26.4],
];
const feature = (coordinates: unknown = [points], properties = { type: 'track', safe: true }) => ({
    type: 'Feature',
    properties,
    geometry: { type: 'MultiLineString', coordinates },
});
const result = (features: unknown[] = [feature()], overrides: Record<string, unknown> = {}) => ({
    id: 42,
    success: true,
    rtz: '<route>synthetic test only</route>',
    geoJson: JSON.stringify({ type: 'FeatureCollection', features }),
    ...overrides,
});
const request = (body: unknown = { action: 'calculate', ...input }) =>
    new Request('https://edge.invalid/autorouting-trial', {
        method: 'POST',
        headers: { Authorization: 'Bearer fake-user-session', 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function harness(overrides: Record<string, string | undefined> = {}) {
    const env: Record<string, string | undefined> = {
        SEVENCS_TRIAL_ENABLED: 'true',
        SEVENCS_TRIAL_USER_IDS: USER,
        SEVENCS_TRIAL_EXPIRES_AT: '2026-09-13T00:00:00Z',
        SEVENCS_CLIENT_ID: 'fake-client',
        SEVENCS_CLIENT_SECRET: 'fake-secret',
        ...overrides,
    };
    const authorize = vi.fn().mockResolvedValue({ userId: USER });
    const fetcher = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json({ access_token: 'fake-provider-bearer', token_type: 'Bearer', expires_in: 300 }))
        .mockResolvedValueOnce(json(result()));
    const clock = { now: NOW };
    const handler = createAutoroutingTrialHandler({
        env: (key) => env[key],
        authorize,
        fetch: fetcher,
        now: () => clock.now,
    });
    return { handler, env, authorize, fetcher, clock };
}

afterEach(() => vi.useRealTimers());

describe('autorouting trial access and provider boundary', () => {
    it('authenticates status using a separate cheap quota and never calls the provider', async () => {
        const h = harness();
        const req = request({ action: 'status' });
        const response = await h.handler(req);
        expect(await response.json()).toMatchObject({ enabled: true, ready: true });
        expect(response.headers.get('cache-control')).toBe('no-store');
        expect(h.authorize).toHaveBeenCalledExactlyOnceWith(req, 'autorouting_trial_status', 120, 3600);
        expect(h.fetcher).not.toHaveBeenCalled();
    });

    it('requires authentication even for status and preserves quota rejection headers', async () => {
        const h = harness();
        h.authorize.mockResolvedValueOnce(json({ error: 'Authentication required' }, 401));
        expect((await h.handler(request({ action: 'status' }))).status).toBe(401);
        h.authorize.mockResolvedValueOnce(new Response(null, { status: 429, headers: { 'Retry-After': '3600' } }));
        const denied = await h.handler(request());
        expect(denied.status).toBe(429);
        expect(denied.headers.get('Retry-After')).toBe('3600');
        expect(h.fetcher).not.toHaveBeenCalled();
    });

    it.each([
        ['kill switch', { SEVENCS_TRIAL_ENABLED: 'false' }],
        ['non-explicit switch', { SEVENCS_TRIAL_ENABLED: '1' }],
        ['missing expiry', { SEVENCS_TRIAL_EXPIRES_AT: undefined }],
        ['invalid expiry', { SEVENCS_TRIAL_EXPIRES_AT: 'tomorrow' }],
        ['expiry boundary', { SEVENCS_TRIAL_EXPIRES_AT: '2026-09-12T00:00:00Z' }],
        ['wrong UUID', { SEVENCS_TRIAL_USER_IDS: OTHER }],
        ['substring is not a grant', { SEVENCS_TRIAL_USER_IDS: `x${USER}` }],
        ['malformed allowlist', { SEVENCS_TRIAL_USER_IDS: `${USER},*` }],
    ])('fails closed on %s', async (_name, overrides) => {
        const h = harness(overrides);
        expect(await (await h.handler(request({ action: 'status' }))).json()).toMatchObject({
            enabled: false,
            ready: false,
        });
        expect((await h.handler(request())).status).toBe(403);
        expect(h.fetcher).not.toHaveBeenCalled();
    });

    it('does not report readiness without both provider secrets', async () => {
        const h = harness({ SEVENCS_CLIENT_SECRET: '' });
        expect(await (await h.handler(request({ action: 'status' }))).json()).toMatchObject({
            enabled: true,
            ready: false,
        });
        expect((await h.handler(request())).status).toBe(503);
        expect(h.fetcher).not.toHaveBeenCalled();
    });

    it('makes one fixed-host token exchange and one synchronous route POST with the exact schema', async () => {
        const h = harness();
        const req = request();
        const response = await h.handler(req);
        expect(response.status).toBe(200);
        const route = await response.json();
        expect(route).toMatchObject({
            provider: 'SevenCs',
            id: '42',
            coordinates: points,
            source: { rtz: result().rtz, geoJson: result().geoJson },
        });
        expect(h.authorize).toHaveBeenCalledExactlyOnceWith(req, 'autorouting_trial_calculate', 12, 3600);
        expect(h.fetcher).toHaveBeenCalledTimes(2);
        const [tokenUrl, tokenOptions] = h.fetcher.mock.calls[0];
        expect(tokenUrl).toBe(SEVENCS_TOKEN_URL);
        expect(tokenOptions).toMatchObject({ method: 'POST', redirect: 'error' });
        expect(new URLSearchParams(String(tokenOptions?.body)).get('client_secret')).toBe('fake-secret');
        const [routeUrl, routeOptions] = h.fetcher.mock.calls[1];
        expect(routeUrl).toBe(SEVENCS_ROUTE_URL);
        expect(routeOptions).toMatchObject({
            method: 'POST',
            redirect: 'error',
            headers: { Authorization: 'Bearer fake-provider-bearer' },
        });
        expect(JSON.parse(String(routeOptions?.body))).toEqual(buildSevenCsRequest(input, NOW));
        expect(JSON.stringify(route)).not.toMatch(/fake-secret|fake-client|fake-provider-bearer|fake-user-session/);
        expect(route.warnings.join(' ')).toMatch(/0.5 m.*no tide credit/i);
        expect(route.warnings.join(' ')).toMatch(/Air draft, beam/);
        expect(route).not.toHaveProperty('verified');
    });

    it('uses the request draft unchanged and preserves checker dependencies without paid weather tools', () => {
        const wire = buildSevenCsRequest(input, NOW);
        expect(wire.departure.position).toBe('-26.65 153.3');
        expect(wire.arrival.position).toBe('-26.4 153.3');
        expect(wire.vessel).toEqual({ type: 'Yacht' });
        expect(wire.safety).toEqual({
            draft: 2.4,
            clearance: { berthing: 0.5, confined: 0.5, coastal: 0.5, openSea: 0.5 },
        });
        expect(wire.schedule).toEqual({
            etd: '2026-09-12T00:00:00.000Z',
            speed: { sea: 6.5, river: 6.5, berthing: 3 },
        });
        expect(wire.finalizing).toMatchObject({
            routeChecker: true,
            routeExpander: true,
            confinedWaterFinder: true,
            openSeaFinder: true,
            weatherOptimization: false,
            calculateVoyage: false,
        });
        expect(wire).not.toHaveProperty('weatherOptimization');
        expect(wire).not.toHaveProperty('calculateVoyage');
        expect(buildSevenCsRequest({ ...input, speedKts: 2 }, NOW).schedule.speed.berthing).toBe(2);
    });

    it.each([
        { url: 'http://169.254.169.254/latest/meta-data' },
        { id: 1 },
        { action: 'retrieve' },
        { draftM: 0 },
        { speedKts: 101 },
        { departure: { lat: -91, lon: 0 } },
    ])('rejects arbitrary provider fields or invalid input: %j', async (change) => {
        const h = harness();
        expect((await h.handler(request({ action: 'calculate', ...input, ...change }))).status).toBe(400);
        expect(h.fetcher).not.toHaveBeenCalled();
    });

    it('checks access again before sending coordinates and after the response', async () => {
        const h = harness();
        h.fetcher.mockReset().mockImplementationOnce(async () => {
            h.env.SEVENCS_TRIAL_ENABLED = 'false';
            return json({ access_token: 'fake-token', token_type: 'Bearer', expires_in: 300 });
        });
        expect((await h.handler(request())).status).toBe(403);
        expect(h.fetcher).toHaveBeenCalledTimes(1);
        const second = harness();
        second.fetcher
            .mockReset()
            .mockResolvedValueOnce(json({ access_token: 'fake-token', token_type: 'Bearer', expires_in: 300 }))
            .mockImplementationOnce(async () => {
                second.clock.now = Date.parse('2026-09-14T00:00:00Z');
                return json(result());
            });
        expect((await second.handler(request())).status).toBe(403);
    });

    it('reuses only the short-lived server token, never a cached route', async () => {
        const h = harness();
        expect((await h.handler(request())).status).toBe(200);
        h.fetcher.mockResolvedValueOnce(json(result()));
        expect((await h.handler(request())).status).toBe(200);
        expect(h.fetcher.mock.calls.map(([url]) => url)).toEqual([
            SEVENCS_TOKEN_URL,
            SEVENCS_ROUTE_URL,
            SEVENCS_ROUTE_URL,
        ]);
    });

    it.each([202, 302, 401, 500])('does not poll or retry provider HTTP %s or disclose raw errors', async (status) => {
        const h = harness();
        h.fetcher
            .mockReset()
            .mockResolvedValueOnce(json({ access_token: 'fake-token', token_type: 'Bearer', expires_in: 300 }))
            .mockResolvedValueOnce(new Response('private provider details fake-secret', { status }));
        const response = await h.handler(request());
        expect(response.status).toBe(502);
        expect(await response.text()).not.toMatch(/private provider|fake-secret/);
        expect(h.fetcher).toHaveBeenCalledTimes(2);
    });

    it('caps declared and streamed provider payloads without parsing partial data', async () => {
        for (const declared of [true, false]) {
            const h = harness();
            const cancel = vi.fn();
            const stream = new ReadableStream<Uint8Array>({
                start(controller) {
                    controller.enqueue(new Uint8Array(TRIAL_MAX_RESPONSE_BYTES + 1));
                },
                cancel,
            });
            h.fetcher
                .mockReset()
                .mockResolvedValueOnce(json({ access_token: 'fake-token', token_type: 'Bearer', expires_in: 300 }))
                .mockResolvedValueOnce(
                    new Response(stream, {
                        headers: declared ? { 'Content-Length': String(TRIAL_MAX_RESPONSE_BYTES + 1) } : {},
                    }),
                );
            expect((await h.handler(request())).status).toBe(502);
            expect(cancel).toHaveBeenCalled();
        }
    });

    it('bounds a provider that ignores AbortSignal and never retries', async () => {
        vi.useFakeTimers();
        const h = harness();
        h.fetcher.mockReset().mockImplementation(() => new Promise(() => undefined));
        const pending = h.handler(request());
        await vi.advanceTimersByTimeAsync(0);
        expect(h.fetcher).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(TRIAL_PROVIDER_TIMEOUT_MS);
        expect((await pending).status).toBe(504);
        expect(h.fetcher).toHaveBeenCalledTimes(1);
        expect((h.fetcher.mock.calls[0][1]?.signal as AbortSignal).aborted).toBe(true);
    });

    it('wires the deployed entry to real-user authentication and no storage or logger', () => {
        const source = readFileSync('supabase/functions/autorouting-trial/index.ts', 'utf8');
        const helper = readFileSync('supabase/functions/_shared/autorouting-trial.ts', 'utf8');
        expect(source).toContain('authorize: requireAuthenticatedQuota');
        expect(source).not.toContain('requireAuthenticatedOrPublicQuota');
        expect(helper).not.toMatch(/console\.|\.from\(|localStorage|Deno\.write/);
    });

    it('cancels a stalled provider body inside the same total provider deadline', async () => {
        vi.useFakeTimers();
        const h = harness();
        const cancel = vi.fn();
        h.fetcher
            .mockReset()
            .mockResolvedValueOnce(json({ access_token: 'fake-token', token_type: 'Bearer', expires_in: 300 }))
            .mockResolvedValueOnce(new Response(new ReadableStream({ cancel })));
        const pending = h.handler(request());
        await vi.advanceTimersByTimeAsync(0);
        expect(h.fetcher).toHaveBeenCalledTimes(2);
        await vi.advanceTimersByTimeAsync(TRIAL_PROVIDER_TIMEOUT_MS);
        expect((await pending).status).toBe(504);
        expect(cancel).toHaveBeenCalledExactlyOnceWith(undefined);
    });

    it('bounds an oversized request before authentication or provider work', async () => {
        const h = harness();
        expect((await h.handler(request({ action: 'calculate', ...input, junk: 'x'.repeat(4096) }))).status).toBe(400);
        expect(h.authorize).not.toHaveBeenCalled();
        expect(h.fetcher).not.toHaveBeenCalled();
    });

    it.each([
        { access_token: '', token_type: 'Bearer', expires_in: 300 },
        { access_token: 'token\nheader', token_type: 'Bearer', expires_in: 300 },
        { access_token: 'fake-token', token_type: 'Basic', expires_in: 300 },
        { access_token: 'fake-token', token_type: 'Bearer', expires_in: 0 },
    ])('rejects malformed provider tokens without submitting coordinates', async (token) => {
        const h = harness();
        h.fetcher.mockReset().mockResolvedValueOnce(json(token));
        expect((await h.handler(request())).status).toBe(502);
        expect(h.fetcher).toHaveBeenCalledTimes(1);
    });
});

describe('complete provider geometry and warnings', () => {
    it('warns about small provider endpoint movements without changing or joining the track', () => {
        const shifted = [[153.3, -26.6499], points[1], [153.3, -26.4001]];
        const parsed = parseSevenCsResult(result([feature([shifted])]), input, NOW);
        expect(parsed.coordinates).toEqual(shifted);
        expect(parsed.warnings).toContain(
            'Provider route starts 11 m from the requested departure. No connecting leg has been added.',
        );
        expect(parsed.warnings).toContain(
            'Provider route ends 11 m from the requested destination. No connecting leg has been added.',
        );
        const exact = parseSevenCsResult(result(), input, NOW);
        expect(exact.warnings.join(' ')).not.toMatch(/Provider route starts|Provider route ends/);
    });

    it('rejects geographically identical endpoints even with different longitude notation', () => {
        expect(() =>
            validateTrialInput({ ...input, departure: { lat: 0, lon: -180 }, destination: { lat: 0, lon: 180 } }),
        ).toThrow();
        expect(() =>
            validateTrialInput({ ...input, departure: { lat: 90, lon: 0 }, destination: { lat: 90, lon: 120 } }),
        ).toThrow();
    });

    it('enforces the combined source UTF-8 budget even when parsed outside the HTTP boundary', () => {
        expect(() =>
            parseSevenCsResult(result(undefined, { rtz: '🌊'.repeat(TRIAL_MAX_RESPONSE_BYTES / 4) }), input, NOW),
        ).toThrow();
    });
    it('accepts the observed MultiLineString shape with absent userWarnings and preserves source byte-for-byte', () => {
        const raw = result();
        const parsed = parseSevenCsResult(raw, input, NOW);
        expect(parsed.coordinates).toEqual(points);
        expect(parsed.source).toEqual({ rtz: raw.rtz, geoJson: raw.geoJson });
    });

    it('joins only already-identical endpoints and never reorders or decimates vertices', () => {
        const parsed = parseSevenCsResult(
            result([
                feature([
                    [points[0], points[1]],
                    [points[1], points[2]],
                ]),
            ]),
            input,
            NOW,
        );
        expect(parsed.coordinates).toEqual(points);
        expect(() =>
            parseSevenCsResult(
                result([
                    feature([
                        [points[0], points[1]],
                        [[153.31, -26.5], points[2]],
                    ]),
                ]),
                input,
                NOW,
            ),
        ).toThrow();
    });

    it.each([
        [feature([[[181, -26.65], points[2]]])],
        [feature([[[153.3, null], points[2]]])],
        [feature([[[153.3, -26.65, 0], points[2]]])],
        [feature([[points[2], points[0]]])],
        [feature([[[153.3, -25], points[2]]])],
        [feature([[points[0], points[0]]])],
        [feature([[points[0]]])],
        [feature([], { type: 'track', safe: true })],
    ])('rejects the whole malformed/displaced track: %j', (...features) => {
        expect(() => parseSevenCsResult(result(features), input, NOW)).toThrow();
    });

    it('rejects invalid hidden danger geometry rather than silently ignoring it', () => {
        const hidden = {
            type: 'Feature',
            properties: { type: 'danger' },
            geometry: { type: 'Point', coordinates: [999, 0] },
        };
        expect(() => parseSevenCsResult(result([feature(), hidden]), input, NOW)).toThrow();
        const invalidLine = { ...hidden, geometry: { type: 'LineString', coordinates: [points[0]] } };
        expect(() => parseSevenCsResult(result([feature(), invalidLine]), input, NOW)).toThrow();
    });

    it('includes provider user warnings and every danger/unsafe feature without claiming app verification', () => {
        const danger = {
            type: 'Feature',
            properties: { type: 'danger', name: 'Synthetic hazard', class: 'OBSTRN' },
            geometry: { type: 'Point', coordinates: points[1] },
        };
        const parsed = parseSevenCsResult(
            result([feature([points], { type: 'track', safe: false }), danger], {
                userWarnings: ['Check local conditions'],
            }),
            input,
            NOW,
        );
        expect(parsed.warnings).toContain('Check local conditions');
        expect(parsed.warnings.filter((warning) => warning.startsWith('Provider check feature'))).toHaveLength(2);
        expect(parsed.warnings.join(' ')).toContain('Synthetic hazard');
        expect(parsed).not.toHaveProperty('verified');
    });

    it('rejects provider failure, oversized warnings, missing RTZ and excess track points', () => {
        for (const change of [
            { success: false },
            { rtz: null },
            { id: Number.MAX_SAFE_INTEGER + 1 },
            { userWarnings: ['x'.repeat(2001)] },
            { userWarnings: Array(99).fill('warning') },
        ]) {
            expect(() => parseSevenCsResult(result(undefined, change), input, NOW)).toThrow();
        }
        expect(() => parseSevenCsResult(result([feature([Array(10_001).fill(points[0])])]), input, NOW)).toThrow();
        expect(() => validateTrialInput({ ...input, departure: input.destination })).toThrow();
    });
});
