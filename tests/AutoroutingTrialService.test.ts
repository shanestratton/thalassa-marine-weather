import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
import {
    AUTOROUTING_TRIAL_MAX_POINTS,
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
