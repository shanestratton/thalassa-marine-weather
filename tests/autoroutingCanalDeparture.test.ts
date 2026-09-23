import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    calculateWithCanalDeparture,
    joinCanalDeparture,
    runCanalDepartureWorker,
    canalContinuationHeadsOutward,
    type CanalChannelConstraints,
} from '../services/autoroutingCanalDeparture';
import { setAuthIdentityScope } from '../services/authIdentityScope';
import type { CanalDepartureGeometry, buildCanalDepartureGeometry } from '../services/canalDepartureGeometry';
import type { AutoroutingTrialRoute } from '../types/autorouting';

const mocks = vi.hoisted(() => ({
    session: vi.fn(),
    invoke: vi.fn(),
    water: vi.fn(),
    provider: vi.fn(),
    tiles: vi.fn(),
}));
vi.mock('../services/supabase', () => ({
    supabase: { auth: { getSession: mocks.session }, functions: { invoke: mocks.invoke } },
}));
vi.mock('../services/mapboxWater', () => ({
    fetchMapboxWater: mocks.water,
    tilesForBbox: mocks.tiles,
    MAPBOX_WATER_ZOOM: 16,
}));
vi.mock('../services/autoroutingTrial', () => ({ calculateAutoroutingTrial: mocks.provider }));
const start = { lat: 0.002, lon: 0.002 },
    exit = { lat: 0.003, lon: 0.003 },
    destination = { lat: 0.007, lon: 0.007 };
const request = () => ({ departure: { ...start }, destination: { ...destination }, draftM: 2.4, speedKts: 6.5 });
const channel = (): CanalChannelConstraints => ({
    gateCentres: [{ ...exit }],
    outboundBearingDeg: 45,
    profileId: 'synthetic-verified-channel',
    sourceRevision: 'fixture-only',
});
const local = (): CanalDepartureGeometry => ({
    coordinates: [
        [start.lon, start.lat],
        [exit.lon, exit.lat],
    ],
    grid: {
        width: 100,
        height: 100,
        minLon: 0,
        minLat: 0,
        dLon: 0.0001,
        dLat: 0.0001,
        water: new Uint8Array(10000).fill(1),
    },
});
const remote = (): AutoroutingTrialRoute => ({
    id: 'r',
    provider: 'SevenCs',
    createdAt: '2026-09-12T00:00:00Z',
    warnings: [],
    coordinates: [
        [exit.lon, exit.lat],
        [destination.lon, destination.lat],
    ],
    source: { rtz: 'original', geoJson: 'original' },
});
const fc = { type: 'FeatureCollection', features: [] };
let workers: FakeWorker[];
class FakeWorker {
    onmessage: ((event: { data: { result?: CanalDepartureGeometry; error?: string } }) => void) | null = null;
    onerror: (() => void) | null = null;
    terminate = vi.fn();
    postMessage = vi.fn((_args: Parameters<typeof buildCanalDepartureGeometry>) =>
        queueMicrotask(() => this.onmessage?.({ data: { result: local() } })),
    );
    constructor() {
        workers.push(this);
    }
}
beforeEach(() => {
    vi.resetAllMocks();
    workers = [];
    mocks.tiles.mockReturnValue([1]);
    setAuthIdentityScope('canal-owner');
    vi.stubGlobal('Worker', FakeWorker);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ bridges: [] }) }));
    mocks.session.mockResolvedValue({
        data: { session: { user: { id: 'canal-owner' }, access_token: 'fixture-bearer' } },
        error: null,
    });
    mocks.invoke.mockResolvedValue({
        data: {
            berths: fc,
            breakwater: fc,
            aeroway: fc,
            reef: fc,
            canalLines: {
                ...fc,
                features: [
                    {
                        type: 'Feature',
                        geometry: {
                            type: 'LineString',
                            coordinates: [
                                [0, 0],
                                [0.001, 0.001],
                            ],
                        },
                    },
                ],
            },
        },
        error: null,
    });
    mocks.water.mockResolvedValue({
        ...fc,
        features: [
            {
                type: 'Feature',
                properties: {},
                geometry: {
                    type: 'Polygon',
                    coordinates: [
                        [
                            [0, 0],
                            [0.01, 0],
                            [0.01, 0.01],
                            [0, 0.01],
                            [0, 0],
                        ],
                    ],
                },
            },
        ],
    });
    mocks.provider.mockResolvedValue(remote());
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
});
const calc = (signal = new AbortController().signal) =>
    calculateWithCanalDeparture(request(), exit, 'fixture-token', signal, vi.fn());

describe('canal departure orchestration', () => {
    it('still rejects over 48 map tiles before any account, map or provider request', async () => {
        mocks.tiles.mockReturnValue(Array.from({ length: 49 }, (_, i) => i));
        await expect(calc()).rejects.toThrow(/map area is too large/);
        expect(mocks.session).not.toHaveBeenCalled();
        expect(mocks.water).not.toHaveBeenCalled();
        expect(mocks.invoke).not.toHaveBeenCalled();
        expect(mocks.provider).not.toHaveBeenCalled();
        expect(workers).toHaveLength(0);
    });
    it('rejects the legacy edge HTTP-200 empty-on-error response', async () => {
        mocks.invoke.mockResolvedValue({
            data: { water: fc, canalLines: fc, berths: fc, breakwater: fc, aeroway: fc, reef: fc },
            error: null,
        });
        await expect(calc()).rejects.toThrow(/unavailable/);
        expect(mocks.provider).not.toHaveBeenCalled();
    });
    it('stops before the worker or SevenCs on the explicit obstacle-service 503', async () => {
        mocks.invoke.mockResolvedValue({
            data: null,
            error: new Error('Edge Function returned a non-2xx status code'),
            response: new Response(JSON.stringify({ code: 'OVERLAY_UPSTREAM_UNAVAILABLE' }), { status: 503 }),
        });
        await expect(calc()).rejects.toThrow(/unavailable/);
        expect(workers).toHaveLength(0);
        expect(mocks.provider).not.toHaveBeenCalled();
    });
    it('routes locally first, then sends the exact exit and unchanged vessel prefs to SevenCs', async () => {
        const result = await calc();
        expect(mocks.provider).toHaveBeenCalledWith({ ...request(), departure: exit }, expect.any(AbortSignal));
        expect(workers).toHaveLength(1);
        expect(workers[0].terminate).toHaveBeenCalled();
        expect(mocks.invoke.mock.calls[0][1].headers).toEqual({ Authorization: 'Bearer fixture-bearer' });
        expect(mocks.water.mock.calls[0][2]).toEqual({ requireComplete: true });
        expect(result.coordinates).toEqual([
            [start.lon, start.lat],
            [exit.lon, exit.lat],
            [destination.lon, destination.lat],
        ]);
        expect(result.canalDeparture).toEqual({ handoverIndex: 1 });
        expect(result.source).toEqual(remote().source);
        expect(result.warnings.join(' ')).toMatch(/not surveyed depth/);
    });
    it('injects guidance only after the local calculation and keeps the exact prefix and source', async () => {
        const guided = remote();
        guided.coordinates.splice(1, 0, [0.005, 0.005]);
        guided.id = 'guided';
        const calculateProvider = vi.fn().mockResolvedValue(guided);
        const result = await calculateWithCanalDeparture(
            request(),
            exit,
            'fixture-token',
            new AbortController().signal,
            vi.fn(),
            channel(),
            calculateProvider,
        );
        expect(workers).toHaveLength(1);
        expect(calculateProvider).toHaveBeenCalledWith({ ...request(), departure: exit }, expect.any(AbortSignal));
        expect(mocks.provider).not.toHaveBeenCalled();
        expect(result.coordinates).toEqual([[start.lon, start.lat], ...guided.coordinates]);
        expect(result.source).toEqual(guided.source);
        expect(result.canalDeparture?.handoverIndex).toBe(1);
    });
    it('does not let an injected guided result bypass the outward gate check', async () => {
        const inward = remote();
        inward.coordinates.splice(1, 0, [0.0029, 0.0029]);
        const calculateProvider = vi.fn().mockResolvedValue(inward);
        await expect(
            calculateWithCanalDeparture(
                request(),
                exit,
                'fixture-token',
                new AbortController().signal,
                vi.fn(),
                channel(),
                calculateProvider,
            ),
        ).rejects.toThrow(/turns back/);
        expect(mocks.provider).not.toHaveBeenCalled();
    });
    it('does not let an injected guided result move the canal handover', async () => {
        const moved = remote();
        moved.coordinates[0] = [0.0031, 0.0031];
        const calculateProvider = vi.fn().mockResolvedValue(moved);
        await expect(
            calculateWithCanalDeparture(
                request(),
                exit,
                'fixture-token',
                new AbortController().signal,
                vi.fn(),
                channel(),
                calculateProvider,
            ),
        ).rejects.toThrow(/did not start/);
    });
    it('sends the verified gate constraints to the disposable worker and keeps the exact final gate as handover', async () => {
        const gates = channel();
        const result = await calculateWithCanalDeparture(
            request(),
            exit,
            'fixture-token',
            new AbortController().signal,
            vi.fn(),
            gates,
        );
        expect(workers[0].postMessage.mock.calls[0][0][5]).toEqual(gates.gateCentres);
        expect(mocks.provider).toHaveBeenCalledWith({ ...request(), departure: exit }, expect.any(AbortSignal));
        expect(result.coordinates[1]).toEqual([exit.lon, exit.lat]);
    });
    it.each([
        { gateCentres: [] },
        { gateCentres: [start] },
        { gateCentres: [{ lat: 0.02, lon: 0.02 }, exit] },
        { gateCentres: [exit, exit] },
        { outboundBearingDeg: NaN },
        { outboundBearingDeg: 360 },
        { profileId: '' },
        { sourceRevision: '' },
    ])('rejects invalid channel constraints before network requests and worker creation: %j', async (change) => {
        await expect(
            calculateWithCanalDeparture(request(), exit, 'fixture-token', new AbortController().signal, vi.fn(), {
                ...channel(),
                ...change,
            }),
        ).rejects.toThrow(/profile|marker gate|map area/);
        expect(mocks.session).not.toHaveBeenCalled();
        expect(mocks.water).not.toHaveBeenCalled();
        expect(mocks.provider).not.toHaveBeenCalled();
        expect(workers).toHaveLength(0);
    });
    it('stops before the provider if the worker result skipped a mandatory midpoint', async () => {
        const gates = channel();
        gates.gateCentres.unshift({ lat: 0.0025, lon: 0.0025 });
        await expect(
            calculateWithCanalDeparture(request(), exit, 'fixture-token', new AbortController().signal, vi.fn(), gates),
        ).rejects.toThrow(/did not preserve every verified marker gate/);
        expect(mocks.provider).not.toHaveBeenCalled();
    });
    it('snapshots gate coordinates and outbound bearing before asynchronous requests', async () => {
        const gates = channel();
        const promise = calculateWithCanalDeparture(
            request(),
            exit,
            'fixture-token',
            new AbortController().signal,
            vi.fn(),
            gates,
        );
        gates.gateCentres[0].lon = 40;
        gates.outboundBearingDeg = 225;
        await promise;
        expect(workers[0].postMessage.mock.calls[0][0][5]).toEqual([exit]);
    });
    it.each(['water', 'obstacles', 'bridge', 'worker'])(
        'never falls back to SevenCs from the berth when %s fails',
        async (failure) => {
            if (failure === 'water') mocks.water.mockRejectedValue(new Error('Missing tile'));
            if (failure === 'obstacles') mocks.invoke.mockResolvedValue({ data: {}, error: null });
            if (failure === 'bridge') vi.mocked(fetch).mockResolvedValue({ ok: false } as Response);
            if (failure === 'worker')
                vi.stubGlobal(
                    'Worker',
                    class {
                        constructor() {
                            throw new Error('not available');
                        }
                    },
                );
            await expect(calc()).rejects.toThrow();
            expect(mocks.provider).not.toHaveBeenCalled();
        },
    );
    it('rejects a changed session before coordinates are sent under the wrong identity', async () => {
        mocks.session.mockResolvedValue({
            data: { session: { user: { id: 'other' }, access_token: 'other-token' } },
            error: null,
        });
        await expect(calc()).rejects.toThrow(/Sign in/);
        expect(mocks.invoke).not.toHaveBeenCalled();
    });
    it('aborts promptly on Clear/Close even while auth is stalled', async () => {
        mocks.session.mockImplementation(() => new Promise(() => {}));
        const controller = new AbortController();
        const promise = calc(controller.signal);
        controller.abort();
        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        expect(mocks.provider).not.toHaveBeenCalled();
    });
    it('discards a delayed provider response after account change', async () => {
        let finish!: (r: AutoroutingTrialRoute) => void;
        mocks.provider.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const promise = calc();
        const check = expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        await vi.waitFor(() => expect(mocks.provider).toHaveBeenCalled());
        setAuthIdentityScope('other');
        await check;
        finish(remote());
    });
    it('snapshots caller positions before asynchronous work', async () => {
        const input = request(),
            gate = { ...exit };
        const promise = calculateWithCanalDeparture(
            input,
            gate,
            'fixture-token',
            new AbortController().signal,
            vi.fn(),
        );
        input.departure.lon = 50;
        input.destination.lon = 50;
        gate.lon = 50;
        await promise;
        expect(mocks.provider.mock.calls[0][0]).toEqual({ ...request(), departure: exit });
    });
    it('bounds a stalled calculation and does not start the provider afterwards', async () => {
        vi.useFakeTimers();
        mocks.session.mockImplementation(() => new Promise(() => {}));
        const promise = calc();
        const check = expect(promise).rejects.toThrow(/timed out/);
        await vi.advanceTimersByTimeAsync(85_001);
        await check;
        expect(mocks.provider).not.toHaveBeenCalled();
    });
    it('terminates a worker on abort rather than returning a late route', async () => {
        vi.stubGlobal(
            'Worker',
            class extends FakeWorker {
                postMessage = vi.fn();
            },
        );
        const controller = new AbortController();
        const promise = runCanalDepartureWorker(
            [start, exit, [0, 0, 0.01, 0.01], fc as never, fc as never],
            controller.signal,
        );
        controller.abort();
        await expect(promise).rejects.toMatchObject({ name: 'AbortError' });
        expect(workers[0].terminate).toHaveBeenCalled();
    });
});

describe('canal/provider seam', () => {
    it('rejects an inward provider departure even when all the water-mask cells are clear', () => {
        const route = remote();
        route.coordinates.splice(1, 0, [0.0029, 0.0029]);
        expect(() => joinCanalDeparture(local(), route, channel())).toThrow(/turns back into the marked exit channel/);
    });
    it('rejects backtracking within the first 30 m after initially moving outward', () => {
        const route = remote();
        route.coordinates.splice(1, 0, [0.00305, 0.00305], [0.00304, 0.00304]);
        expect(() => joinCanalDeparture(local(), route, channel())).toThrow(/turns back/);
    });
    it('checks the interpolated first 30 m of a long first provider leg without altering the provider payload', () => {
        const route = remote();
        const snapshot = structuredClone(route);
        const result = joinCanalDeparture(local(), route, channel());
        expect(route).toEqual(snapshot);
        expect(result.coordinates).toContainEqual(route.coordinates[1]);
    });
    it('does not accept invalid, zero-length or purely sideways continuations as outbound', () => {
        const origin: [number, number] = [exit.lon, exit.lat];
        expect(canalContinuationHeadsOutward([origin, origin], exit, 0)).toBe(false);
        expect(canalContinuationHeadsOutward([origin, [exit.lon + 0.001, exit.lat]], exit, 0)).toBe(false);
        expect(canalContinuationHeadsOutward([origin, [NaN, exit.lat]], exit, 0)).toBe(false);
        expect(canalContinuationHeadsOutward(remote().coordinates, exit, NaN)).toBe(false);
    });
    it('rejects a displaced handover instead of drawing an unvalidated connector', () => {
        const route = remote();
        route.coordinates[0] = [0.0031, 0.003];
        expect(() => joinCanalDeparture(local(), route)).toThrow(/did not start/);
    });
    it('rejects a provider line that doubles back over a wall within the canal crop', () => {
        const path = local();
        path.grid.water[40 * 100 + 40] = 0;
        expect(() => joinCanalDeparture(path, remote())).toThrow(/could not be confirmed/);
    });
    it('retains a tiny endpoint mismatch as a separately checked segment, never alters provider vertices', () => {
        const route = remote();
        route.coordinates[0] = [exit.lon + 0.000001, exit.lat];
        const snapshot = structuredClone(route);
        const result = joinCanalDeparture(local(), route);
        expect(result.coordinates).toEqual([...local().coordinates, ...route.coordinates]);
        expect(route).toEqual(snapshot);
    });
});
