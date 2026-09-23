import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FunctionsHttpError } from '@supabase/supabase-js';

const mock = vi.hoisted(() => ({
    configured: true,
    getSession: vi.fn(),
    invoke: vi.fn(),
    from: vi.fn(),
    rpc: vi.fn(),
}));

vi.mock('../services/supabase', () => ({
    get supabase() {
        return mock.configured
            ? {
                  auth: { getSession: mock.getSession },
                  functions: { invoke: mock.invoke },
                  from: mock.from,
                  rpc: mock.rpc,
              }
            : null;
    },
}));

import { setAuthIdentityScope } from '../services/authIdentityScope';
import { calculateAutoroutingTrial, getAutoroutingTrialStatus } from '../services/autoroutingTrial';
import { snapshotAutoroutingVesselProfile } from '../services/autoroutingVesselProfile';
import {
    AUTOROUTING_TRIAL_MAX_POINTS,
    AUTOROUTING_TRIAL_MAX_CHART_TRACK_CONSTRAINTS,
    AUTOROUTING_TRIAL_MAX_SOURCE_BYTES,
    type AutoroutingTrialRequest,
} from '../types/autorouting';

const request = (): AutoroutingTrialRequest => ({
    departure: { lat: -27.206, lon: 153.096 },
    destination: { lat: -23.9, lon: 152.4 },
    draftM: 2.4,
    speedKts: 6.5,
});
const route = () => ({
    id: 'trial-route-1',
    provider: 'SevenCs',
    coordinates: [
        [153.096, -27.206],
        [153.15, -27.1],
        [152.4, -23.9],
    ],
    warnings: ['Trial proposal: check the route against current charts.'],
    createdAt: '2026-09-12T03:00:00.123Z',
});
const session = (id = 'user-a') => ({
    data: { session: { user: { id }, access_token: 'test-session-token' } },
    error: null,
});
function deferred<T>() {
    let resolve!: (value: T) => void;
    let reject!: (reason: unknown) => void;
    const promise = new Promise<T>((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
}
const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
};

describe('isolated autorouting trial service', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
        vi.clearAllMocks();
        vi.spyOn(console, 'warn').mockImplementation(() => undefined);
        setAuthIdentityScope('user-a');
        mock.configured = true;
        mock.getSession.mockResolvedValue(session());
        mock.invoke.mockResolvedValue({ data: route(), error: null });
    });
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it.each([
        { enabled: false, ready: false },
        { enabled: true, ready: false, message: 'Waiting for chart coverage.' },
        { enabled: true, ready: true },
        { enabled: true, ready: true, channelGuidance: true },
        { enabled: true, ready: true, channelGuidance: false },
        { enabled: true, ready: false, channelGuidance: false },
        { enabled: true, ready: true, vesselProfile: true },
        { enabled: true, ready: false, vesselProfile: false },
    ])('reads a valid server status %j', async (data) => {
        mock.invoke.mockResolvedValue({ data, error: null });
        expect(await getAutoroutingTrialStatus()).toEqual(data);
        expect(mock.invoke).toHaveBeenCalledWith('autorouting-trial', {
            body: { action: 'status' },
            headers: { Authorization: 'Bearer test-session-token' },
            signal: expect.any(AbortSignal),
        });
    });

    it.each([
        null,
        {},
        { enabled: true },
        { enabled: 1, ready: true },
        { enabled: false, ready: true },
        { enabled: true, ready: true, message: {} },
        { enabled: true, ready: true, message: 'x'.repeat(501) },
        { enabled: true, ready: true, channelGuidance: 'true' },
        { enabled: true, ready: true, channelGuidance: null },
        { enabled: true, ready: false, channelGuidance: true },
        { enabled: false, ready: false, channelGuidance: true },
        { enabled: true, ready: true, vesselProfile: 'true' },
        { enabled: true, ready: true, vesselProfile: null },
        { enabled: true, ready: false, vesselProfile: true },
    ])('fails closed on malformed status %j', async (data) => {
        mock.invoke.mockResolvedValue({ data, error: null });
        expect(await getAutoroutingTrialStatus()).toMatchObject({ enabled: false, ready: false });
    });

    it('never calls the function anonymously or with a mismatched/unavailable session', async () => {
        setAuthIdentityScope(null);
        expect(await getAutoroutingTrialStatus()).toMatchObject({ enabled: false, ready: false });
        await expect(calculateAutoroutingTrial(request())).rejects.toThrow('Sign in');
        expect(mock.getSession).not.toHaveBeenCalled();
        setAuthIdentityScope('user-a');
        mock.configured = false;
        await expect(calculateAutoroutingTrial(request())).rejects.toThrow('Sign in');
        mock.configured = true;
        for (const response of [
            session('user-b'),
            { data: { session: null }, error: null },
            { ...session(), error: new Error('failed') },
            { data: { session: { user: { id: 'user-a' }, access_token: '' } }, error: null },
        ]) {
            mock.getSession.mockResolvedValue(response);
            await expect(calculateAutoroutingTrial(request())).rejects.toThrow('Sign in');
        }
        expect(mock.invoke).not.toHaveBeenCalled();
    });

    it('posts only an authenticated flat request and never persists or activates the proposal', async () => {
        const input = {
            ...request(),
            extra: 'not transmitted',
            departure: { ...request().departure, secret: 'not transmitted' },
        };
        const storageWrite = vi.spyOn(Storage.prototype, 'setItem');
        const output = await calculateAutoroutingTrial(input);
        expect(mock.invoke).toHaveBeenCalledExactlyOnceWith('autorouting-trial', {
            body: { action: 'calculate', ...request() },
            headers: { Authorization: 'Bearer test-session-token' },
            signal: expect.any(AbortSignal),
        });
        expect(output).toEqual(route());
        expect(mock.from).not.toHaveBeenCalled();
        expect(mock.rpc).not.toHaveBeenCalled();
        expect(storageWrite).not.toHaveBeenCalled();
    });

    it('snapshots nested vessel dimensions before authentication and requires an acknowledged profile', async () => {
        const auth = deferred<ReturnType<typeof session>>();
        mock.getSession.mockReturnValueOnce(auth.promise);
        const profile = snapshotAutoroutingVesselProfile({
            length: 40,
            beam: 12,
            airDraft: 60,
            draft: 8,
            estimatedFields: ['draft'],
        });
        const expected = structuredClone(profile);
        mock.invoke.mockResolvedValueOnce({ data: { enabled: true, ready: true, vesselProfile: true }, error: null });
        mock.invoke.mockResolvedValueOnce({ data: { ...route(), vesselProfile: expected }, error: null });
        const pending = calculateAutoroutingTrial({ ...request(), vesselProfile: profile });
        if (profile.length.status !== 'missing') profile.length.valueM = 99;
        profile.draftStatus = 'measured';
        auth.resolve(session());
        const output = await pending;
        expect(mock.invoke).toHaveBeenCalledTimes(2);
        expect(mock.invoke.mock.calls[1][1].body).toEqual({
            action: 'calculate',
            ...request(),
            vesselProfile: expected,
        });
        expect(output.vesselProfile).toEqual(expected);
        expect(output.vesselProfile).not.toBe(expected);
        expect(output.vesselProfile?.beam).not.toBe(expected.beam);
    });

    it.each([undefined, false])(
        'never sends a profile when server support is not explicit: %j',
        async (vesselProfile) => {
            mock.invoke.mockResolvedValueOnce({ data: { enabled: true, ready: true, vesselProfile }, error: null });
            await expect(
                calculateAutoroutingTrial({
                    ...request(),
                    vesselProfile: snapshotAutoroutingVesselProfile({ draft: 8 }),
                }),
            ).rejects.toThrow('cannot use the stored vessel profile');
            expect(mock.invoke).toHaveBeenCalledTimes(1);
            expect(mock.invoke.mock.calls[0][1].body).toEqual({ action: 'status' });
        },
    );

    it.each([undefined, null, { draftStatus: 'measured' }])(
        'rejects a missing/malformed profile acknowledgement: %j',
        async (vesselProfile) => {
            mock.invoke.mockResolvedValueOnce({
                data: { enabled: true, ready: true, vesselProfile: true },
                error: null,
            });
            mock.invoke.mockResolvedValueOnce({ data: { ...route(), vesselProfile }, error: null });
            await expect(
                calculateAutoroutingTrial({
                    ...request(),
                    vesselProfile: snapshotAutoroutingVesselProfile({ draft: 8 }),
                }),
            ).rejects.toThrow('unreadable route');
        },
    );

    it('rejects a changed profile acknowledgement and missing draft before a provider request', async () => {
        const profile = snapshotAutoroutingVesselProfile({ draft: 8 });
        mock.invoke.mockResolvedValueOnce({ data: { enabled: true, ready: true, vesselProfile: true }, error: null });
        mock.invoke.mockResolvedValueOnce({
            data: { ...route(), vesselProfile: { ...profile, draftStatus: 'estimated' } },
            error: null,
        });
        await expect(calculateAutoroutingTrial({ ...request(), vesselProfile: profile })).rejects.toThrow(
            'unreadable route',
        );
        mock.invoke.mockClear();
        await expect(
            calculateAutoroutingTrial({ ...request(), vesselProfile: { ...profile, draftStatus: 'missing' } }),
        ).rejects.toThrow('Vessel settings');
        expect(mock.invoke).not.toHaveBeenCalled();
    });

    it('cannot carry a profile capability result across an account switch', async () => {
        const status = deferred<{ data: { enabled: boolean; ready: boolean; vesselProfile: boolean }; error: null }>();
        mock.invoke.mockReturnValueOnce(status.promise);
        const pending = calculateAutoroutingTrial({
            ...request(),
            vesselProfile: snapshotAutoroutingVesselProfile({ draft: 8 }),
        });
        await flush();
        setAuthIdentityScope('user-b');
        status.resolve({ data: { enabled: true, ready: true, vesselProfile: true }, error: null });
        await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        expect(mock.invoke).toHaveBeenCalledTimes(1);
        expect(mock.invoke.mock.calls[0][1].body.action).toBe('status');
    });

    it('snapshots caller coordinates before waiting for authentication', async () => {
        const auth = deferred<ReturnType<typeof session>>();
        mock.getSession.mockReturnValue(auth.promise);
        const input = request();
        const pending = calculateAutoroutingTrial(input);
        input.departure.lat = 0;
        input.destination.lon = 0;
        input.draftM = 10;
        auth.resolve(session());
        await pending;
        expect(mock.invoke.mock.calls[0][1].body).toEqual({ action: 'calculate', ...request() });
    });

    it('snapshots ordered chart-track constraints before authentication without expanding caller options', async () => {
        const auth = deferred<ReturnType<typeof session>>();
        mock.getSession.mockReturnValue(auth.promise);
        const constraints = [
            { lat: -27.19, lon: 153.1 },
            { lat: -27.17, lon: 153.11 },
        ];
        const expected = constraints.map((point) => ({ ...point }));
        const input = {
            ...request(),
            chartTrackConstraints: constraints,
            mustGo: [{ position: 'arbitrary provider input' }],
            profile: 'not forwarded',
        };
        const pending = calculateAutoroutingTrial(input);
        constraints[0].lat = 0;
        constraints.reverse();
        constraints.push({ lat: 0, lon: 0 });
        auth.resolve(session());
        await pending;
        expect(mock.invoke.mock.calls[0][1].body).toEqual({
            action: 'calculate',
            ...request(),
            chartTrackConstraints: expected,
        });
        expect(mock.invoke.mock.calls[0][1].body.chartTrackConstraints).not.toBe(constraints);
    });

    it('does not infer guidance from an old server status or introduce mustGo into an ordinary request', async () => {
        mock.invoke.mockResolvedValueOnce({ data: { enabled: true, ready: true }, error: null });
        expect(await getAutoroutingTrialStatus()).not.toHaveProperty('channelGuidance');
        await calculateAutoroutingTrial({ ...request(), chartTrackConstraints: undefined });
        expect(mock.invoke.mock.calls[1][1].body).toEqual({ action: 'calculate', ...request() });
        expect(mock.invoke.mock.calls[1][1].body).not.toHaveProperty('chartTrackConstraints');
        expect(mock.invoke.mock.calls[1][1].body).not.toHaveProperty('mustGo');
    });

    it('allows exactly the maximum number of explicit constraints without reordering or truncation', async () => {
        expect(AUTOROUTING_TRIAL_MAX_CHART_TRACK_CONSTRAINTS).toBe(8);
        const chartTrackConstraints = Array.from({ length: AUTOROUTING_TRIAL_MAX_CHART_TRACK_CONSTRAINTS }, (_, i) => ({
            lat: -27.19 + i * 0.001,
            lon: 153.1,
        }));
        await calculateAutoroutingTrial({ ...request(), chartTrackConstraints });
        expect(mock.invoke.mock.calls[0][1].body.chartTrackConstraints).toEqual(chartTrackConstraints);
    });

    it.each(
        [
            null,
            'automatic',
            [],
            Array(2),
            [{ lat: NaN, lon: 153.1 }],
            [{ lat: -91, lon: 153.1 }],
            [{ lat: -27.19, lon: 181 }],
            [{ lat: '-27.19', lon: 153.1 }],
            [{ lat: -27.19, lon: 153.1, geometry: [] }],
            [{ lat: -27.19, lon: 153.1, name: 'caller override' }],
            [{ position: '-27.19 153.1', id: 0 }],
            [request().departure],
            [request().destination],
            [
                { lat: -27.19, lon: 153.1 },
                { lat: -27.19, lon: 153.1 },
            ],
            [
                { lat: 0, lon: -180 },
                { lat: 0, lon: 180 },
            ],
            [
                { lat: 90, lon: 0 },
                { lat: 90, lon: 120 },
            ],
            Array.from({ length: AUTOROUTING_TRIAL_MAX_CHART_TRACK_CONSTRAINTS + 1 }, (_, i) => ({ lat: i, lon: 1 })),
        ].map((chartTrackConstraints) => ({ chartTrackConstraints })),
    )('rejects malformed chart-track constraints before authentication: %j', async ({ chartTrackConstraints }) => {
        await expect(
            calculateAutoroutingTrial({ ...request(), chartTrackConstraints } as AutoroutingTrialRequest),
        ).rejects.toThrow('chart-track positions');
        expect(mock.getSession).not.toHaveBeenCalled();
        expect(mock.invoke).not.toHaveBeenCalled();
    });

    it.each([
        null,
        {},
        { ...request(), departure: { lat: NaN, lon: 0 } },
        { ...request(), destination: { lat: 91, lon: 0 } },
        { ...request(), departure: { lat: 0, lon: 181 } },
        { ...request(), destination: request().departure },
        { ...request(), draftM: 0 },
        { ...request(), draftM: -1 },
        { ...request(), draftM: 30.01 },
        { ...request(), draftM: Infinity },
        { ...request(), speedKts: 0 },
        { ...request(), speedKts: 100.01 },
        { ...request(), speedKts: '6.5' },
    ])('rejects invalid input before any authentication or provider request %j', async (input) => {
        await expect(calculateAutoroutingTrial(input as AutoroutingTrialRequest)).rejects.toThrow(
            'Enter two different',
        );
        expect(mock.getSession).not.toHaveBeenCalled();
        expect(mock.invoke).not.toHaveBeenCalled();
    });

    it('accepts zero-valued coordinates and explicit maximum request bounds', async () => {
        await calculateAutoroutingTrial({
            departure: { lat: 0, lon: 0 },
            destination: { lat: 90, lon: 180 },
            draftM: 30,
            speedKts: 100,
        });
        expect(mock.invoke).toHaveBeenCalledOnce();
    });

    it.each([
        null,
        [],
        [[1, 2]],
        [
            [1, 2],
            [1, 2],
        ],
        [[1, 2], null, [3, 4]],
        [
            [1, 2],
            [NaN, 3],
            [3, 4],
        ],
        [
            [1, 2],
            [3, Infinity],
        ],
        [
            [1, 2],
            [181, 3],
        ],
        [
            [1, 2],
            [3, 91],
        ],
        [
            [1, 2],
            ['3', 4],
        ],
        [
            [1, 2],
            [3, 4, 5],
        ],
        [
            [-27, 153],
            [-23, 152],
        ],
    ])('rejects the whole malformed geometry without filtering points %j', async (coordinates) => {
        mock.invoke.mockResolvedValue({ data: { ...route(), coordinates }, error: null });
        await expect(calculateAutoroutingTrial(request())).rejects.toThrow('unreadable route');
    });

    it('rejects oversized geometry rather than silently simplifying or truncating it', async () => {
        const coordinates = Array.from({ length: AUTOROUTING_TRIAL_MAX_POINTS + 1 }, (_, i) => [0, i / 1000]);
        mock.invoke.mockResolvedValue({ data: { ...route(), coordinates }, error: null });
        await expect(calculateAutoroutingTrial(request())).rejects.toThrow('unreadable route');
    });

    it('preserves order, repeated vertices, exact timestamp and independent output arrays', async () => {
        const data = {
            ...route(),
            coordinates: [
                [-180, -90],
                [0, 0],
                [0, 0],
                [180, 90],
            ],
        };
        mock.invoke.mockResolvedValue({ data, error: null });
        const output = await calculateAutoroutingTrial(request());
        expect(output).toEqual(data);
        data.coordinates[1][0] = 20;
        data.warnings.push('changed later');
        expect(output.coordinates).toEqual([
            [-180, -90],
            [0, 0],
            [0, 0],
            [180, 90],
        ]);
        expect(output.warnings).toHaveLength(1);
        expect(output.createdAt).toBe('2026-09-12T03:00:00.123Z');
    });

    it('preserves optional source bytes verbatim in a separate in-memory object without logging or storage', async () => {
        const source = {
            rtz: '\n<?xml version="1.0"?><route name="Thalassa 🌊" />\n',
            geoJson: '{ "type": "FeatureCollection", "features": [] }\n',
        };
        const exact = { ...source };
        mock.invoke.mockResolvedValue({ data: { ...route(), source }, error: null });
        const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
        const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
        const writes = vi.spyOn(Storage.prototype, 'setItem');
        const output = await calculateAutoroutingTrial(request());
        expect(output.source).toEqual(exact);
        expect(output.source).not.toBe(source);
        source.rtz = 'changed';
        expect(output.source).toEqual(exact);
        expect(log).not.toHaveBeenCalled();
        expect(error).not.toHaveBeenCalled();
        expect(writes).not.toHaveBeenCalled();
    });

    it('preserves a new server’s structured unsafe report in independently owned records', async () => {
        const providerCheck = {
            status: 'unsafe',
            findings: [
                {
                    featureIndex: 4,
                    featureType: 'danger',
                    severity: 'danger',
                    message: 'Provider detected a charted obstruction.',
                },
            ],
        };
        mock.invoke.mockResolvedValue({ data: { ...route(), providerCheck }, error: null });
        const output = await calculateAutoroutingTrial(request());
        expect(output.providerCheck).toEqual(providerCheck);
        providerCheck.findings[0].message = 'changed later';
        expect(output.providerCheck?.findings[0].message).toBe('Provider detected a charted obstruction.');
        expect(output.coordinates).toEqual(route().coordinates);
        expect(output.warnings).toEqual(route().warnings);
    });

    it('recovers an old server’s unsafe report from exact source without changing its bytes', async () => {
        const source = {
            rtz: '<route/>',
            geoJson: JSON.stringify({
                type: 'FeatureCollection',
                features: [
                    {
                        type: 'Feature',
                        properties: { type: 'track', safe: false },
                        geometry: { type: 'LineString', coordinates: route().coordinates },
                    },
                    {
                        type: 'Feature',
                        properties: { type: 'danger', name: 'Synthetic depth hazard' },
                        geometry: { type: 'Point', coordinates: route().coordinates[1] },
                    },
                ],
            }),
        };
        mock.invoke.mockResolvedValue({ data: { ...route(), source }, error: null });
        const output = await calculateAutoroutingTrial(request());
        expect(output.providerCheck).toMatchObject({
            status: 'unsafe',
            findings: [{ severity: 'danger' }, { severity: 'danger' }],
        });
        expect(output.source).toEqual(source);
        expect(output.warnings).toEqual(route().warnings);
        expect(output.providerCheck?.findings[0]).not.toHaveProperty('geometry');
        expect(output.providerCheck?.findings[1]).toMatchObject({
            geometry: { type: 'Point', coordinates: route().coordinates[1] },
            provenance: { source: 'SevenCs GeoJSON', properties: { type: 'danger', name: 'Synthetic depth hazard' } },
        });
    });

    it('deep-clones provider geometry and exact primitive provenance from normalized reports', async () => {
        const finding = {
            featureIndex: 4,
            featureType: 'danger',
            severity: 'danger',
            message: 'Synthetic obstruction',
            geometry: { type: 'Point', coordinates: [153.15, -27.1] },
            provenance: {
                source: 'SevenCs GeoJSON',
                properties: { uuid: 'synthetic-id', dataset: 'synthetic-chart', height: null },
                omittedPropertyCount: 0,
            },
        };
        const providerCheck = { status: 'unsafe', findings: [finding] };
        mock.invoke.mockResolvedValue({ data: { ...route(), providerCheck }, error: null });
        const output = await calculateAutoroutingTrial(request());
        expect(output.providerCheck).toEqual(providerCheck);
        finding.geometry.coordinates[0] = 0;
        finding.provenance.properties.uuid = 'changed';
        expect(output.providerCheck?.findings[0].geometry).toEqual({ type: 'Point', coordinates: [153.15, -27.1] });
        expect(output.providerCheck?.findings[0].provenance?.properties.uuid).toBe('synthetic-id');
    });

    it.each([
        { geometry: { type: 'Point', coordinates: [181, 0] } },
        { geometry: { type: 'Point', coordinates: [153, -27, 0] } },
        { featureType: 'track', geometry: { type: 'Point', coordinates: [153, -27] } },
        { provenance: { source: 'local ENC', properties: {}, omittedPropertyCount: 0 } },
        { provenance: { source: 'SevenCs GeoJSON', properties: { nested: { id: 1 } }, omittedPropertyCount: 0 } },
    ])('rejects invalid normalized provider locator/provenance: %j', async (details) => {
        mock.invoke.mockResolvedValue({
            data: {
                ...route(),
                providerCheck: {
                    status: 'unsafe',
                    findings: [
                        { featureIndex: 0, featureType: 'danger', severity: 'danger', message: 'Hazard', ...details },
                    ],
                },
            },
            error: null,
        });
        await expect(calculateAutoroutingTrial(request())).rejects.toThrow('unreadable route');
    });

    it('recovers the earliest server’s unsafe warning with no source and deduplicates current reports', async () => {
        const message = 'Provider check feature 2 (unsafe): track. Review the original checker output before use.';
        const data = { ...route(), warnings: [...route().warnings, message] };
        mock.invoke.mockResolvedValue({ data, error: null });
        const old = await calculateAutoroutingTrial(request());
        expect(old.providerCheck).toEqual({
            status: 'unsafe',
            findings: [{ featureIndex: 1, featureType: 'track', severity: 'danger', message }],
        });
        mock.invoke.mockResolvedValue({ data: { ...data, providerCheck: old.providerCheck }, error: null });
        expect((await calculateAutoroutingTrial(request())).providerCheck?.findings).toHaveLength(1);
    });

    it('does not let a new summary without findings suppress an unsafe original report', async () => {
        const message = 'Provider check feature 1 (unsafe): track. Review the original checker output before use.';
        mock.invoke.mockResolvedValue({
            data: { ...route(), warnings: [message], providerCheck: { status: 'not-reported', findings: [] } },
            error: null,
        });
        expect((await calculateAutoroutingTrial(request())).providerCheck?.status).toBe('unsafe');
    });

    it.each(['Info', 'Warning', 'Danger'])(
        'recovers legacy source severity %s without upgrading it from old danger-kind wording',
        async (severity) => {
            const warning =
                'Provider check feature 1: danger · Synthetic hazard. Review the original checker output before use.';
            const source = {
                rtz: '<route/>',
                geoJson: JSON.stringify({
                    type: 'FeatureCollection',
                    features: [{ type: 'Feature', properties: { type: 'danger', severity, name: 'Synthetic hazard' } }],
                }),
            };
            mock.invoke.mockResolvedValue({ data: { ...route(), source, warnings: [warning] }, error: null });
            const output = await calculateAutoroutingTrial(request());
            expect(output.providerCheck).toMatchObject({
                status: severity === 'Danger' ? 'unsafe' : 'caution',
                findings: [{ providerSeverity: severity, severity: severity === 'Danger' ? 'danger' : 'caution' }],
            });
            expect(output.providerCheck?.findings).toHaveLength(1);
            expect(output.warnings).toEqual([warning]);
        },
    );

    it.each([
        null,
        { status: 'safe', findings: [] },
        { status: 'unsafe', findings: [] },
        { status: 'not-reported', findings: [{ featureIndex: 0, severity: 'danger', message: 'Unsafe' }] },
        { status: 'caution', findings: null },
        { status: 'caution', findings: [{ featureIndex: -1, severity: 'caution', message: 'Check' }] },
        { status: 'caution', findings: [{ featureIndex: 10_000, severity: 'caution', message: 'Check' }] },
        { status: 'caution', findings: [{ featureIndex: 0, severity: 'clear', message: 'Check' }] },
        { status: 'caution', findings: [{ featureIndex: 0, severity: 'caution', message: '' }] },
        { status: 'caution', findings: [{ featureIndex: 0, severity: 'caution', message: 'x'.repeat(2001) }] },
        { status: 'caution', findings: [{ featureIndex: 0, severity: 'caution', message: 'Check', featureType: 5 }] },
    ])('rejects malformed structured provider metadata %j', async (providerCheck) => {
        mock.invoke.mockResolvedValue({ data: { ...route(), providerCheck }, error: null });
        await expect(calculateAutoroutingTrial(request())).rejects.toThrow('unreadable route');
    });

    it.each([
        null,
        'raw',
        {},
        { rtz: '<route />' },
        { rtz: '', geoJson: '{}' },
        { rtz: '<route />', geoJson: 42 },
        { rtz: '<route />', geoJson: '   ' },
    ])('rejects an invalid supplied source instead of silently stripping it %j', async (source) => {
        mock.invoke.mockResolvedValue({ data: { ...route(), source }, error: null });
        await expect(calculateAutoroutingTrial(request())).rejects.toThrow('unreadable route');
    });

    it('bounds the combined source in UTF-8 bytes, not JavaScript characters or per-file size', async () => {
        const source = { rtz: 'x'.repeat(AUTOROUTING_TRIAL_MAX_SOURCE_BYTES - 2), geoJson: '{}' };
        mock.invoke.mockResolvedValue({ data: { ...route(), source }, error: null });
        expect((await calculateAutoroutingTrial(request())).source).toEqual(source);
        mock.invoke.mockResolvedValue({
            data: { ...route(), source: { ...source, rtz: source.rtz + 'x' } },
            error: null,
        });
        await expect(calculateAutoroutingTrial(request())).rejects.toThrow('unreadable route');
        mock.invoke.mockResolvedValue({
            data: { ...route(), source: { rtz: '🌊'.repeat(AUTOROUTING_TRIAL_MAX_SOURCE_BYTES / 4), geoJson: '{}' } },
            error: null,
        });
        await expect(calculateAutoroutingTrial(request())).rejects.toThrow('unreadable route');
    });

    it.each([
        { provider: 'Unknown' },
        { id: '' },
        { id: 'x'.repeat(201) },
        { createdAt: 'yesterday' },
        { createdAt: '2026-09-12T03:00:00' },
        { createdAt: '2026-99-12T03:00:00Z' },
        { warnings: null },
        { warnings: [''] },
        { warnings: ['x'.repeat(2001)] },
        { warnings: [42] },
        { warnings: Array(101).fill('warning') },
    ])('rejects malformed metadata %j', async (replacement) => {
        mock.invoke.mockResolvedValue({ data: { ...route(), ...replacement }, error: null });
        await expect(calculateAutoroutingTrial(request())).rejects.toThrow('unreadable route');
    });

    it.each(['session', 'invoke', 'response'])('does not expose raw transport details from %s', async (phase) => {
        const secret = new Error('Provider rejected secret-token and private coordinates');
        if (phase === 'session') mock.getSession.mockRejectedValue(secret);
        else if (phase === 'invoke') mock.invoke.mockRejectedValue(secret);
        else mock.invoke.mockResolvedValue({ data: null, error: secret });
        await expect(calculateAutoroutingTrial(request())).rejects.toThrow(
            'The autorouting trial is unavailable. No route has been activated.',
        );
        expect(await getAutoroutingTrialStatus()).toEqual({
            enabled: false,
            ready: false,
            message: 'The autorouting trial is unavailable. No route has been activated.',
        });
    });

    it.each([
        [
            400,
            'The routing service rejected this request. Check the positions and vessel settings. No route has been activated.',
        ],
        [401, 'Sign in to use the autorouting trial.'],
        [403, 'This account cannot access the autorouting trial. No route has been activated.'],
        [
            429,
            'The autorouting request limit has been reached. Please wait before trying again. No route has been activated.',
        ],
        [502, 'The routing provider could not complete this request. No route has been activated.'],
        [503, 'The routing service is temporarily unavailable. Please try again later. No route has been activated.'],
        [504, 'The trial request timed out. Please try again.'],
        [404, 'The autorouting trial is unavailable. No route has been activated.'],
    ] as const)(
        'uses only fixed copy for HTTP %i and never retries or enables a failed status',
        async (status, message) => {
            const response = () => new Response('private provider message, bearer and coordinates', { status });
            const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
            const errorLog = vi.spyOn(console, 'error').mockImplementation(() => undefined);
            mock.invoke.mockImplementation(async () => ({ data: null, error: new FunctionsHttpError(response()) }));
            await expect(calculateAutoroutingTrial(request())).rejects.toThrow(message);
            expect(mock.invoke).toHaveBeenCalledTimes(1);
            expect(await getAutoroutingTrialStatus()).toEqual({ enabled: false, ready: false, message });
            expect(mock.invoke).toHaveBeenCalledTimes(2);
            expect(log).not.toHaveBeenCalled();
            expect(errorLog).not.toHaveBeenCalled();
        },
    );

    it.each([
        [502, 'AR_TOKEN_HTTP'],
        [502, 'AR_TOKEN_PAYLOAD'],
        [502, 'AR_ROUTE_HTTP'],
        [502, 'AR_ROUTE_PAYLOAD'],
        [502, 'AR_ROUTE_INVALID'],
        [502, 'AR_PROVIDER_NETWORK'],
        [504, 'AR_TIMEOUT'],
    ] as const)(
        'shows the allowlisted support reference for HTTP %i / %s without provider prose',
        async (status, code) => {
            const response = new Response(JSON.stringify({ code, error: 'private provider token and position' }), {
                status,
            });
            const json = vi.spyOn(response, 'json');
            const text = vi.spyOn(response, 'text');
            mock.invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(response) });
            const failure = await calculateAutoroutingTrial(request()).catch((error: Error) => error);
            expect(failure).toBeInstanceOf(Error);
            expect((failure as Error).message).toContain(`Reference: ${code}.`);
            expect((failure as Error).message).not.toContain('private');
            expect(json).not.toHaveBeenCalled();
            expect(text).not.toHaveBeenCalled();
            expect(mock.invoke).toHaveBeenCalledTimes(1);
        },
    );

    it.each([
        [502, JSON.stringify({ code: 'AR_TIMEOUT' })],
        [504, JSON.stringify({ code: 'AR_ROUTE_HTTP' })],
        [400, JSON.stringify({ code: 'AR_ROUTE_HTTP' })],
        [502, JSON.stringify({ code: 'AR_ROUTE_HTTP\nprivate-token' })],
        [502, JSON.stringify({ code: { secret: 'private-token' } })],
        [502, JSON.stringify({ code: '__proto__' })],
        [502, JSON.stringify({ message: 'AR_ROUTE_HTTP' })],
        [502, JSON.stringify(['AR_ROUTE_HTTP'])],
        [502, 'not JSON; private-token'],
        [502, JSON.stringify({ code: 'AR_ROUTE_HTTP', padding: 'x'.repeat(1_024) })],
    ] as const)('ignores mismatched, hostile, malformed or oversized diagnostic bodies (%i)', async (status, body) => {
        mock.invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(new Response(body, { status })) });
        const failure = await calculateAutoroutingTrial(request()).catch((error: Error) => error);
        expect((failure as Error).message).not.toMatch(/Reference:|private-token|__proto__/);
    });

    it('bounds diagnostic reads by actual bytes even with a false Content-Length and cancels an oversized stream', async () => {
        const cancel = vi.fn();
        const response = new Response(
            new ReadableStream({
                start(controller) {
                    controller.enqueue(new TextEncoder().encode('x'.repeat(1_025)));
                },
                cancel,
            }),
            { status: 502, headers: { 'Content-Length': '1' } },
        );
        mock.invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(response) });
        await expect(calculateAutoroutingTrial(request())).rejects.toThrow('routing provider could not complete');
        expect(cancel).toHaveBeenCalledTimes(1);
    });

    it.each([
        null,
        'secret-token',
        { status: 401 },
        { status: '502', json: () => ({ code: 'AR_ROUTE_HTTP' }) },
        Object.defineProperty({}, 'status', {
            get: () => {
                throw new Error('private-token');
            },
        }),
    ])('fails safely for a malformed SDK context without reflecting it: %j', async (context) => {
        mock.invoke.mockResolvedValue({ data: null, error: new FunctionsHttpError(context) });
        await expect(calculateAutoroutingTrial(request())).rejects.toThrow(
            'The autorouting trial is unavailable. No route has been activated.',
        );
    });

    it('does not trust lookalike HTTP errors, hostile getters, or malformed Response statuses', async () => {
        const contextGetter = Object.defineProperty(new FunctionsHttpError(null), 'context', {
            get: () => {
                throw new Error('private-token');
            },
        });
        const statusGetter = Object.defineProperty(new Response(null, { status: 502 }), 'status', {
            get: () => {
                throw new Error('private-token');
            },
        });
        const stringStatus = Object.defineProperty(new Response(null, { status: 502 }), 'status', { value: '401' });
        for (const error of [
            { name: 'FunctionsHttpError', context: new Response(null, { status: 401 }) },
            contextGetter,
            new FunctionsHttpError(statusGetter),
            new FunctionsHttpError(stringStatus),
        ]) {
            mock.invoke.mockResolvedValue({ data: null, error });
            await expect(calculateAutoroutingTrial(request())).rejects.toThrow(
                'The autorouting trial is unavailable. No route has been activated.',
            );
        }
    });

    it('does not wait longer than one second for an optional diagnostic reference', async () => {
        vi.useFakeTimers();
        const cancel = vi.fn();
        mock.invoke.mockResolvedValue({
            data: null,
            error: new FunctionsHttpError(new Response(new ReadableStream({ cancel }), { status: 502 })),
        });
        const pending = calculateAutoroutingTrial(request());
        const rejected = expect(pending).rejects.toThrow('routing provider could not complete');
        await vi.advanceTimersByTimeAsync(1_000);
        await rejected;
        expect(cancel).toHaveBeenCalledOnce();
        expect(vi.getTimerCount()).toBe(0);
    });

    it.each(['cancel', 'account'])(
        'fences %s during a deferred diagnostic body and cancels its stream',
        async (action) => {
            const cancel = vi.fn();
            let streamController!: ReadableStreamDefaultController<Uint8Array>;
            mock.invoke.mockResolvedValue({
                data: null,
                error: new FunctionsHttpError(
                    new Response(
                        new ReadableStream<Uint8Array>({
                            start(controller) {
                                streamController = controller;
                            },
                            cancel,
                        }),
                        { status: 502 },
                    ),
                ),
            });
            const controller = new AbortController();
            const pending = calculateAutoroutingTrial(request(), controller.signal);
            const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
            await flush();
            if (action === 'cancel') controller.abort();
            else {
                setAuthIdentityScope('user-b');
                setAuthIdentityScope('user-a');
            }
            await rejected;
            await flush();
            expect(cancel).toHaveBeenCalledOnce();
            expect(() => streamController.enqueue(new Uint8Array([1]))).toThrow();
            expect(mock.invoke).toHaveBeenCalledOnce();
        },
    );

    it('rejects a pre-aborted request without any auth/provider call', async () => {
        const controller = new AbortController();
        controller.abort();
        await expect(calculateAutoroutingTrial(request(), controller.signal)).rejects.toMatchObject({
            name: 'AbortError',
        });
        await expect(getAutoroutingTrialStatus(controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
        expect(mock.getSession).not.toHaveBeenCalled();
        expect(mock.invoke).not.toHaveBeenCalled();
    });

    it.each(['session', 'invoke'])(
        'cancels promptly during %s even if the underlying operation ignores abort',
        async (phase) => {
            const auth = deferred<ReturnType<typeof session>>();
            const result = deferred<{ data: ReturnType<typeof route>; error: null }>();
            if (phase === 'session') mock.getSession.mockReturnValue(auth.promise);
            else mock.invoke.mockReturnValue(result.promise);
            const controller = new AbortController();
            const pending = calculateAutoroutingTrial(request(), controller.signal);
            const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
            await flush();
            controller.abort();
            await rejected;
            auth.resolve(session());
            result.resolve({ data: route(), error: null });
            await flush();
            expect(mock.invoke).toHaveBeenCalledTimes(phase === 'session' ? 0 : 1);
            if (phase === 'invoke') expect(mock.invoke.mock.calls[0][1].signal.aborted).toBe(true);
        },
    );

    it.each(['session', 'invoke'])('fences account changes including A → B → A during %s', async (phase) => {
        const auth = deferred<ReturnType<typeof session>>();
        const result = deferred<{ data: ReturnType<typeof route>; error: null }>();
        if (phase === 'session') mock.getSession.mockReturnValue(auth.promise);
        else mock.invoke.mockReturnValue(result.promise);
        const pending = calculateAutoroutingTrial(request());
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await flush();
        setAuthIdentityScope('user-b');
        setAuthIdentityScope('user-a');
        await rejected;
        auth.resolve(session());
        result.resolve({ data: route(), error: null });
        await flush();
        expect(mock.invoke).toHaveBeenCalledTimes(phase === 'session' ? 0 : 1);
    });

    it('does not convert a cancelled status into a status that could repaint a new account', async () => {
        mock.invoke.mockReturnValue(new Promise(() => undefined));
        const pending = getAutoroutingTrialStatus();
        const rejected = expect(pending).rejects.toMatchObject({ name: 'AbortError' });
        await flush();
        setAuthIdentityScope('user-b');
        await rejected;
    });

    it('bounds status to 15 seconds and calculation to 45 seconds, including authentication', async () => {
        vi.useFakeTimers();
        mock.getSession.mockReturnValue(new Promise(() => undefined));
        const status = getAutoroutingTrialStatus();
        await vi.advanceTimersByTimeAsync(15_000);
        expect(await status).toMatchObject({ enabled: false, ready: false });
        const calculation = calculateAutoroutingTrial(request());
        const rejected = expect(calculation).rejects.toThrow('timed out');
        await vi.advanceTimersByTimeAsync(45_000);
        await rejected;
        expect(mock.invoke).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    });

    it('removes timeout, caller abort and identity subscriptions after completion', async () => {
        vi.useFakeTimers();
        const controller = new AbortController();
        await calculateAutoroutingTrial(request(), controller.signal);
        const invokedSignal = mock.invoke.mock.calls[0][1].signal;
        expect(vi.getTimerCount()).toBe(0);
        controller.abort();
        setAuthIdentityScope('user-b');
        expect(invokedSignal.aborted).toBe(false);
    });
});
