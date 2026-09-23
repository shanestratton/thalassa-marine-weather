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
    TRIAL_MAX_CHART_TRACK_CONSTRAINTS,
    TRIAL_PROVIDER_TIMEOUT_MS,
    validateTrialInput,
} from '../supabase/functions/_shared/autorouting-trial';
import { snapshotAutoroutingVesselProfile } from '../services/autoroutingVesselProfile';
import type { AutoroutingVesselProfile } from '../supabase/functions/_shared/autorouting-vessel';

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
        expect(await response.json()).toMatchObject({
            enabled: true,
            ready: true,
            channelGuidance: true,
            vesselProfile: true,
        });
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
        const status = await (await h.handler(request({ action: 'status' }))).json();
        expect(status).toMatchObject({
            enabled: false,
            ready: false,
        });
        expect(status).not.toHaveProperty('channelGuidance');
        expect(status).not.toHaveProperty('vesselProfile');
        expect((await h.handler(request())).status).toBe(403);
        expect(h.fetcher).not.toHaveBeenCalled();
    });

    it('does not report readiness without both provider secrets', async () => {
        const h = harness({ SEVENCS_CLIENT_SECRET: '' });
        const status = await (await h.handler(request({ action: 'status' }))).json();
        expect(status).toMatchObject({
            enabled: true,
            ready: false,
        });
        expect(status).not.toHaveProperty('channelGuidance');
        expect(status).not.toHaveProperty('vesselProfile');
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
        expect(wire).not.toHaveProperty('mustGo');
        expect(wire).not.toHaveProperty('chartTrackConstraints');
        expect(buildSevenCsRequest({ ...input, speedKts: 2 }, NOW).schedule.speed.berthing).toBe(2);
    });

    it('validates and detaches known dimensions and estimated-draft status before provider work', () => {
        const vesselProfile = snapshotAutoroutingVesselProfile({
            length: 40,
            beam: 12,
            airDraft: 60,
            draft: 8,
            estimatedFields: ['draft', 'airDraft'],
        });
        const expected = structuredClone(vesselProfile);
        const parsed = validateTrialInput({ ...input, vesselProfile });
        if (vesselProfile.length.status !== 'missing') vesselProfile.length.valueM = 99;
        vesselProfile.draftStatus = 'measured';
        expect(parsed.vesselProfile).toEqual(expected);
        expect(parsed.vesselProfile).not.toBe(vesselProfile);
        const output = parseSevenCsResult(result(), parsed, NOW);
        expect(output.vesselProfile).toEqual(expected);
        expect(output.vesselProfile).not.toBe(parsed.vesselProfile);
        expect(output.warnings.join(' ')).toMatch(/draft is estimated/);
        expect(output.warnings.join(' ')).toMatch(/Air draft is estimated/);
        expect(output.warnings.join(' ')).not.toMatch(/dimensions are unknown/);
    });

    it.each(['measured', 'estimated'] as const)(
        'maps %s dimensions to the exact documented SevenCs fields while keeping provenance in Thalassa',
        async (status) => {
            const vesselProfile: AutoroutingVesselProfile = {
                length: { status, valueM: 12.4 },
                beam: { status, valueM: 4.3 },
                airDraft: { status, valueM: 18.2 },
                draftStatus: status,
            };
            const h = harness();
            const response = await h.handler(request({ action: 'calculate', ...input, vesselProfile }));
            expect(response.status).toBe(200);
            const wire = JSON.parse(String(h.fetcher.mock.calls[1][1]?.body));
            expect(wire.vessel).toEqual({ type: 'Yacht', length: 12.4, beam: 4.3 });
            expect(wire.safety).toEqual({
                draft: 2.4,
                airDraft: 18.2,
                clearance: { berthing: 0.5, confined: 0.5, coastal: 0.5, openSea: 0.5 },
            });
            expect(wire.vessel).not.toHaveProperty('airDraft');
            expect(wire.safety.clearance).not.toHaveProperty('vertical');
            expect(JSON.stringify(wire)).not.toMatch(/vesselProfile|draftStatus|estimated|measured|turningRadius/);
            const output = await response.json();
            expect(output.vesselProfile).toEqual(vesselProfile);
            expect(output.warnings.join(' ')).toMatch(/does not establish bridge or overhead clearance/);
            if (status === 'estimated') {
                expect(output.warnings.join(' ')).toMatch(/draft is estimated/);
                expect(output.warnings.join(' ')).toMatch(/Length is estimated/);
                expect(output.warnings.join(' ')).toMatch(/Beam is estimated/);
                expect(output.warnings.join(' ')).toMatch(/Air draft is estimated/);
            } else expect(output.warnings.join(' ')).not.toMatch(/is estimated/);
        },
    );

    it('omits every missing dimension instead of sending zeros or null provider defaults', () => {
        const vesselProfile = snapshotAutoroutingVesselProfile({ draft: 8 });
        const wire = buildSevenCsRequest({ ...input, vesselProfile }, NOW);
        expect(wire).toEqual(buildSevenCsRequest(input, NOW));
        expect(wire.vessel).toEqual({ type: 'Yacht' });
        expect(wire.safety).not.toHaveProperty('airDraft');
        vesselProfile.beam = { status: 'estimated', valueM: 4.2 };
        const partial = buildSevenCsRequest({ ...input, vesselProfile }, NOW);
        expect(partial.vessel).toEqual({ type: 'Yacht', beam: 4.2 });
        expect(partial.safety).not.toHaveProperty('airDraft');
    });

    it('preserves accepted trial dimension bounds and guidance without adding a vertical margin or turn radius', () => {
        const vesselProfile: AutoroutingVesselProfile = {
            length: { status: 'measured', valueM: 300 },
            beam: { status: 'measured', valueM: 100 },
            airDraft: { status: 'measured', valueM: 150 },
            draftStatus: 'measured',
        };
        const parsed = validateTrialInput({
            ...input,
            vesselProfile,
            chartTrackConstraints: [{ lat: -26.5, lon: 153.31 }],
        });
        const wire = buildSevenCsRequest(parsed, NOW);
        expect(wire.vessel).toEqual({ type: 'Yacht', length: 300, beam: 100 });
        expect(wire.safety.airDraft).toBe(150);
        expect(wire.mustGo).toEqual([{ position: '-26.5 153.31', id: 0, name: 'Chart track 1' }]);
        expect(wire.safety.clearance).not.toHaveProperty('vertical');
        expect(wire.vessel).not.toHaveProperty('minTurningRadius');
    });

    it.each([
        null,
        {},
        { ...snapshotAutoroutingVesselProfile({ draft: 8 }), draftStatus: 'missing' },
        { ...snapshotAutoroutingVesselProfile({ draft: 8 }), draftStatus: 'confirmed' },
        { ...snapshotAutoroutingVesselProfile({ draft: 8 }), turningRadius: 10 },
        { ...snapshotAutoroutingVesselProfile({ draft: 8 }), length: { status: 'missing', valueM: 0 } },
        { ...snapshotAutoroutingVesselProfile({ draft: 8 }), length: { status: 'measured', valueM: 301 } },
        { ...snapshotAutoroutingVesselProfile({ draft: 8 }), beam: { status: 'measured', valueM: 101 } },
        { ...snapshotAutoroutingVesselProfile({ draft: 8 }), airDraft: { status: 'measured', valueM: 151 } },
    ])('rejects malformed/unsupported vessel profile before token exchange: %j', async (vesselProfile) => {
        const h = harness();
        const response = await h.handler(request({ action: 'calculate', ...input, vesselProfile }));
        expect(response.status).toBe(400);
        expect(h.fetcher).not.toHaveBeenCalled();
    });

    it('keeps legacy draft provenance unknown and does not fabricate missing dimensions', () => {
        const output = parseSevenCsResult(result(), input, NOW);
        expect(output).not.toHaveProperty('vesselProfile');
        expect(output.warnings.join(' ')).toMatch(/Draft measurement status is unknown/);
        const partial = { ...input, vesselProfile: snapshotAutoroutingVesselProfile({ draft: 8, length: 40 }) };
        const warnings = parseSevenCsResult(result(), partial, NOW).warnings.join(' ');
        expect(warnings).toMatch(/Beam is missing and was not supplied/);
        expect(warnings).toMatch(/Air draft is missing and was not supplied/);
        expect(warnings).toMatch(/does not establish bridge or overhead clearance/);
    });

    it('maps only bounded ordered chart positions into documented mustGo fields', async () => {
        const chartTrackConstraints = [
            { lat: -26.61, lon: 153.301 },
            { lat: -26.57, lon: 153.302 },
        ];
        const h = harness();
        const response = await h.handler(request({ action: 'calculate', ...input, chartTrackConstraints }));
        expect(response.status).toBe(200);
        const wire = JSON.parse(String(h.fetcher.mock.calls[1][1]?.body));
        expect(wire.mustGo).toEqual([
            { position: '-26.61 153.301', id: 0, name: 'Chart track 1' },
            { position: '-26.57 153.302', id: 1, name: 'Chart track 2' },
        ]);
        const { mustGo, ...base } = wire;
        expect(mustGo).toHaveLength(2);
        expect(JSON.stringify(base)).toBe(JSON.stringify(buildSevenCsRequest(input, NOW)));
        expect(h.authorize).toHaveBeenCalledWith(expect.any(Request), 'autorouting_trial_calculate', 12, 3600);
        expect(h.fetcher).toHaveBeenCalledTimes(2);
    });

    it('clones all explicit constraints without reordering or silently truncating the maximum', () => {
        expect(TRIAL_MAX_CHART_TRACK_CONSTRAINTS).toBe(8);
        const chartTrackConstraints = Array.from({ length: TRIAL_MAX_CHART_TRACK_CONSTRAINTS }, (_, i) => ({
            lat: -26.61 + i * 0.001,
            lon: 153.301,
        }));
        const exact = chartTrackConstraints.map((point) => ({ ...point }));
        const parsed = validateTrialInput({ ...input, chartTrackConstraints });
        chartTrackConstraints[0].lat = 0;
        chartTrackConstraints.reverse();
        expect(parsed.chartTrackConstraints).toEqual(exact);
        expect(buildSevenCsRequest(parsed, NOW).mustGo).toEqual(
            exact.map((point, index) => ({
                position: `${point.lat} ${point.lon}`,
                id: index,
                name: `Chart track ${index + 1}`,
            })),
        );
    });

    it.each(
        [
            null,
            'automatic',
            [],
            [{ lat: -91, lon: 153.1 }],
            [{ lat: -26.61, lon: 181 }],
            [{ lat: '-26.61', lon: 153.301 }],
            [{ lat: -26.61, lon: 153.301, geometry: [] }],
            [{ lat: -26.61, lon: 153.301, id: 99 }],
            [{ position: '-26.61 153.301' }],
            [input.departure],
            [input.destination],
            [
                { lat: -26.61, lon: 153.301 },
                { lat: -26.61, lon: 153.301 },
            ],
            [
                { lat: 0, lon: -180 },
                { lat: 0, lon: 180 },
            ],
            [
                { lat: 90, lon: 0 },
                { lat: 90, lon: 120 },
            ],
            Array.from({ length: TRIAL_MAX_CHART_TRACK_CONSTRAINTS + 1 }, (_, i) => ({ lat: i, lon: 1 })),
        ].map((chartTrackConstraints) => ({ chartTrackConstraints })),
    )('rejects malformed guided input without token or route requests: %j', async ({ chartTrackConstraints }) => {
        const h = harness();
        expect((await h.handler(request({ action: 'calculate', ...input, chartTrackConstraints }))).status).toBe(400);
        expect(h.fetcher).not.toHaveBeenCalled();
    });

    it.each([
        { url: 'http://169.254.169.254/latest/meta-data' },
        { id: 1 },
        { mustGo: [{ position: '-26.61 153.301', id: 0 }] },
        { rtz: '<route />' },
        { cost: { shallow: 0 } },
        { profile: 'unchecked' },
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
        expect(await response.json()).toEqual({
            error: 'The provider could not return a complete trial route. No route has been activated.',
            code: 'AR_ROUTE_HTTP',
        });
        expect(h.fetcher).toHaveBeenCalledTimes(2);
    });

    it.each([400, 401, 429, 500])('distinguishes token HTTP %s without exposing its response', async (status) => {
        const h = harness();
        h.fetcher.mockReset().mockResolvedValueOnce(new Response('fake-secret private token endpoint', { status }));
        const response = await h.handler(request());
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({
            error: 'The provider could not return a complete trial route. No route has been activated.',
            code: 'AR_TOKEN_HTTP',
        });
        expect(h.fetcher).toHaveBeenCalledTimes(1);
    });

    it.each(['token', 'route'] as const)(
        'classifies %s transport failure without echoing arbitrary fields',
        async (phase) => {
            const h = harness();
            h.fetcher.mockReset();
            if (phase === 'route')
                h.fetcher.mockResolvedValueOnce(
                    json({ access_token: 'fake-token', token_type: 'Bearer', expires_in: 300 }),
                );
            h.fetcher.mockRejectedValueOnce(
                Object.assign(new Error('fake-secret private URL and positions'), {
                    code: 'private-provider-code',
                    status: 401,
                    coordinates: input.departure,
                }),
            );
            const response = await h.handler(request());
            expect(response.status).toBe(502);
            expect(await response.json()).toEqual({
                error: 'The provider could not return a complete trial route. No route has been activated.',
                code: 'AR_PROVIDER_NETWORK',
            });
            expect(h.fetcher).toHaveBeenCalledTimes(phase === 'route' ? 2 : 1);
        },
    );

    it.each(['token', 'route'] as const)(
        'classifies malformed, oversized and failed-stream %s payloads without partial data',
        async (phase) => {
            for (const kind of ['json', 'oversized', 'stream'] as const) {
                const h = harness();
                h.fetcher.mockReset();
                if (phase === 'route')
                    h.fetcher.mockResolvedValueOnce(
                        json({ access_token: 'fake-token', token_type: 'Bearer', expires_in: 300 }),
                    );
                const payload =
                    kind === 'stream'
                        ? new Response(
                              new ReadableStream({
                                  start(controller) {
                                      controller.error(new Error('fake-secret private stream error'));
                                  },
                              }),
                          )
                        : new Response('fake-secret not JSON', {
                              headers:
                                  kind === 'oversized'
                                      ? { 'Content-Length': String(TRIAL_MAX_RESPONSE_BYTES + 1) }
                                      : {},
                          });
                h.fetcher.mockResolvedValueOnce(payload);
                const response = await h.handler(request());
                expect(response.status).toBe(502);
                expect(await response.json()).toEqual({
                    error: 'The provider could not return a complete trial route. No route has been activated.',
                    code: phase === 'token' ? 'AR_TOKEN_PAYLOAD' : 'AR_ROUTE_PAYLOAD',
                });
                expect(h.fetcher).toHaveBeenCalledTimes(phase === 'route' ? 2 : 1);
            }
        },
    );

    it.each([
        result(undefined, { success: false, message: 'fake-secret raw failure' }),
        result(undefined, { rtz: '' }),
        result([
            feature([
                [
                    [153.3, -26.65],
                    [153.3, -26.5],
                ],
                [
                    [153.31, -26.5],
                    [153.3, -26.4],
                ],
            ]),
        ]),
        result([
            feature([
                [
                    [153.3, -25],
                    [153.3, -26.4],
                ],
            ]),
        ]),
        result([
            feature(),
            { type: 'Feature', properties: { type: 'danger' }, geometry: { type: 'Point', coordinates: [999, 0] } },
        ]),
    ])(
        'keeps incomplete or invalid route responses rejected with only a fixed validation code',
        async (providerReply) => {
            const h = harness();
            h.fetcher
                .mockReset()
                .mockResolvedValueOnce(json({ access_token: 'fake-token', token_type: 'Bearer', expires_in: 300 }))
                .mockResolvedValueOnce(json(providerReply));
            const response = await h.handler(request());
            expect(response.status).toBe(502);
            expect(await response.json()).toEqual({
                error: 'The provider could not return a complete trial route. No route has been activated.',
                code: 'AR_ROUTE_INVALID',
            });
            expect(h.fetcher).toHaveBeenCalledTimes(2);
        },
    );

    it('does not add provider support codes to access, quota, input or successful responses', async () => {
        const h = harness();
        h.authorize.mockResolvedValueOnce(json({ error: 'Request quota exceeded' }, 429));
        expect(await (await h.handler(request())).json()).toEqual({ error: 'Request quota exceeded' });
        expect(
            await (await h.handler(request({ action: 'calculate', ...input, draftM: -1 }))).json(),
        ).not.toHaveProperty('code');
        expect(await (await h.handler(request({ action: 'status' }))).json()).not.toHaveProperty('code');
        expect(await (await h.handler(request())).json()).not.toHaveProperty('code');
        const disabled = harness({ SEVENCS_TRIAL_ENABLED: 'false' });
        expect(await (await disabled.handler(request())).json()).not.toHaveProperty('code');
        expect(disabled.fetcher).not.toHaveBeenCalled();
    });

    it('reports a subsequent provider failure even when the cheap readiness check succeeded', async () => {
        const h = harness();
        expect(await (await h.handler(request({ action: 'status' }))).json()).toMatchObject({ ready: true });
        expect(h.fetcher).not.toHaveBeenCalled();
        h.fetcher.mockReset().mockResolvedValueOnce(new Response('fake-secret', { status: 401 }));
        expect(await (await h.handler(request())).json()).toMatchObject({ code: 'AR_TOKEN_HTTP' });
        expect(h.fetcher).toHaveBeenCalledTimes(1);
    });

    it('does not retain failure diagnostics or retry when a later explicit request succeeds with the cached token', async () => {
        const h = harness();
        h.fetcher
            .mockReset()
            .mockResolvedValueOnce(json({ access_token: 'fake-token', token_type: 'Bearer', expires_in: 300 }))
            .mockResolvedValueOnce(new Response('fake-secret transient response', { status: 503 }))
            .mockResolvedValueOnce(json(result()));
        expect(await (await h.handler(request())).json()).toMatchObject({ code: 'AR_ROUTE_HTTP' });
        expect(h.fetcher).toHaveBeenCalledTimes(2);
        const retry = await h.handler(request());
        expect(retry.status).toBe(200);
        expect(await retry.json()).not.toHaveProperty('code');
        expect(h.fetcher.mock.calls.map(([url]) => url)).toEqual([
            SEVENCS_TOKEN_URL,
            SEVENCS_ROUTE_URL,
            SEVENCS_ROUTE_URL,
        ]);
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
        const response = await pending;
        expect(response.status).toBe(504);
        expect(await response.json()).toEqual({
            error: 'The trial request timed out or was cancelled. No route has been activated.',
            code: 'AR_TIMEOUT',
        });
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
        const response = await h.handler(request());
        expect(response.status).toBe(502);
        expect(await response.json()).toEqual({
            error: 'The provider could not return a complete trial route. No route has been activated.',
            code: 'AR_TOKEN_PAYLOAD',
        });
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
        expect(parsed.providerCheck).toMatchObject({
            status: 'unsafe',
            findings: [
                { featureIndex: 0, featureType: 'track', severity: 'danger' },
                { featureIndex: 1, featureType: 'danger', severity: 'danger' },
            ],
        });
        expect(parsed.providerCheck.findings.map((finding) => finding.message)).toEqual(
            parsed.warnings.filter((warning) => warning.startsWith('Provider check feature')),
        );
        expect(parsed.providerCheck.findings[0]).not.toHaveProperty('geometry');
        expect(parsed.providerCheck.findings[1]).toMatchObject({
            geometry: danger.geometry,
            provenance: { source: 'SevenCs GeoJSON', properties: danger.properties, omittedPropertyCount: 0 },
        });
        expect(parsed).not.toHaveProperty('verified');
    });

    it('separates caution from unsafe and never calls an unflagged response cleared', () => {
        expect(parseSevenCsResult(result(), input, NOW).providerCheck).toEqual({
            status: 'not-reported',
            findings: [],
        });
        const restriction = {
            type: 'Feature',
            properties: { type: 'restriction', description: 'Synthetic restriction' },
            geometry: { type: 'Point', coordinates: points[1] },
        };
        expect(parseSevenCsResult(result([feature(), restriction]), input, NOW).providerCheck).toMatchObject({
            status: 'caution',
            findings: [{ featureIndex: 1, severity: 'caution' }],
        });
        expect(
            parseSevenCsResult(
                result([feature(), { ...restriction, properties: { ...restriction.properties, safe: false } }]),
                input,
                NOW,
            ).providerCheck.status,
        ).toBe('unsafe');
    });

    it.each(['false', 0, null])('rejects malformed provider safe flag %j instead of hiding it', (safe) => {
        expect(() =>
            parseSevenCsResult(result([feature([points], { type: 'track', safe } as never)]), input, NOW),
        ).toThrow();
    });

    it.each([
        ['Info', 'caution'],
        ['Warning', 'caution'],
        ['Danger', 'unsafe'],
    ])('honours severity %s rather than mistaking the danger feature kind for its level', (severity, status) => {
        const hazard = {
            type: 'Feature',
            properties: { type: 'danger', severity, description: 'Provider fixture finding' },
            geometry: { type: 'Point', coordinates: points[1] },
        };
        const parsed = parseSevenCsResult(result([feature(), hazard]), input, NOW);
        expect(parsed.providerCheck).toMatchObject({
            status,
            findings: [
                {
                    featureType: 'danger',
                    providerSeverity: severity,
                    severity: status === 'unsafe' ? 'danger' : 'caution',
                },
            ],
        });
        expect(parsed.providerCheck.findings[0].message).toContain(`severity ${severity}`);
        expect(
            parseSevenCsResult(
                result([feature(), { ...hazard, properties: { ...hazard.properties, safe: false } }]),
                input,
                NOW,
            ).providerCheck.status,
        ).toBe('unsafe');
    });

    it('marks absent or unknown hazard severity as unresolved and preserves unknown severity text', () => {
        for (const severity of [undefined, 'Unexpected']) {
            const hazard = {
                type: 'Feature',
                properties: { type: 'danger', severity },
                geometry: { type: 'Point', coordinates: points[1] },
            };
            const parsed = parseSevenCsResult(result([feature(), hazard]), input, NOW);
            expect(parsed.providerCheck.status).toBe('unsafe');
            expect(parsed.providerCheck.findings[0].message).toContain('unresolved hazard');
            if (severity) expect(parsed.providerCheck.findings[0].providerSeverity).toBe(severity);
        }
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
