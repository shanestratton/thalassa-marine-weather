import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { marineEnvelopeV2 } from '../supabase/functions/_shared/marine-v2';
import { marineFixtureSource, MARINE_FIXTURE_AT as at, MARINE_FIXTURE_POINT as point } from './fixtures/marineV2141';

const f = vi.hoisted(() => ({
    owner: { key: 'owner-A', userId: 'owner-A', generation: 1 },
    boat: 'boat-A',
    pairRevision: 1,
    reach: true,
    baseUrl: 'https://fictional-pi.local',
    pair: { deviceId: 'pi-A', publicKeySpki: 'fictional-pin-A', pairedAt: '2026-10-16' },
    pi: vi.fn(),
    headers: vi.fn(),
    authListeners: [] as (() => void)[],
    boatListeners: [] as ((next: { activeVesselId: string }, previous: { activeVesselId: string }) => void)[],
}));
vi.mock('../services/PiCacheService', () => ({
    piCache: {
        get baseUrl() {
            return f.baseUrl;
        },
        canReachPinned: () => f.reach,
    },
}));
vi.mock('../services/PiPairingService', () => ({
    getPairing: () => f.pair,
    getPiEquipmentReadRevision: () => f.pairRevision,
    pinnedPiRequest: f.pi,
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => f.owner,
    subscribeAuthIdentityScope: (callback: () => void) => {
        f.authListeners.push(callback);
        return () => {};
    },
}));
vi.mock('../services/supabaseAuth', () => ({ getAuthenticatedFunctionHeaders: f.headers }));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => ({ activeVesselId: f.boat }),
        subscribe: (callback: (next: { activeVesselId: string }, previous: { activeVesselId: string }) => void) => {
            f.boatListeners.push(callback);
            return () => {};
        },
    },
}));

const envelope = () => marineEnvelopeV2(point, at, marineFixtureSource('waves'), marineFixtureSource('motion'));
const json = (value: unknown) =>
    new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const wire = () => ({ status: 200, data: JSON.stringify(envelope()) });
const deferred = <T>() => {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
        resolve = done;
    });
    return { promise, resolve };
};
const load = () => import('../services/weather/api/marineModel');
beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(at);
    vi.stubEnv('VITE_SUPABASE_URL', 'https://fictional-project.supabase.co');
    vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'fictional-public-anon');
    f.owner = { key: 'owner-A', userId: 'owner-A', generation: 1 };
    f.boat = 'boat-A';
    f.pairRevision = 1;
    f.reach = true;
    f.baseUrl = 'https://fictional-pi.local';
    f.pair = { deviceId: 'pi-A', publicKeySpki: 'fictional-pin-A', pairedAt: '2026-10-16' };
    f.authListeners = [];
    f.boatListeners = [];
    f.pi.mockReset().mockResolvedValue(wire());
    f.headers
        .mockReset()
        .mockResolvedValue({ Authorization: 'Bearer fictional-user-token', apikey: 'fictional-public-anon' });
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => json(envelope())),
    );
});
afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.useRealTimers();
});
describe('actual Pi-first versioned model client', () => {
    it('uses the pinned schema2 path, immutable original clocks and independent returned copies', async () => {
        const api = await load(),
            first = await api.fetchMarineModelV2(point.latitude, point.longitude);
        expect(first?.via).toBe('pi');
        expect(first?.current).toMatchObject({ waveHeight: 4.92, waterTemperature: 21, currentSpeed: 1 });
        expect(first?.fetchedAtMs).toBe(at);
        expect(f.pi.mock.calls[0][0]).toMatchObject({
            url: 'https://fictional-pi.local/api/weather/marine?lat=-27.1234&lon=153.4567&schema=2',
            connectTimeout: 4000,
            readTimeout: 4000,
        });
        first!.current.waveHeight = 99;
        const cached = await api.fetchMarineModelV2(point.latitude, point.longitude);
        expect(cached?.current.waveHeight).toBe(4.92);
        expect(f.pi).toHaveBeenCalledTimes(1);
        expect(fetch).not.toHaveBeenCalled();
    });
    it.each(['legacy', 'wrong-point', 'old-receipt'] as const)(
        'falls through an old Pi %s response to the fixed Edge schema',
        async (mode) => {
            const raw = envelope() as unknown as Record<string, unknown>;
            if (mode === 'legacy') delete raw.marine_schema;
            if (mode === 'wrong-point') raw.requested = { latitude: 1, longitude: 2 };
            if (mode === 'old-receipt') raw.fetched_at_ms = at - 3600001;
            f.pi.mockResolvedValue({ status: 200, data: JSON.stringify(raw) });
            const result = await (await load()).fetchMarineModelV2(point.latitude, point.longitude);
            expect(result?.via).toBe('supabase');
            expect(vi.mocked(fetch).mock.calls[0][0]).toBe(
                'https://fictional-project.supabase.co/functions/v1/get-marine?lat=-27.1234&lon=153.4567&schema=2',
            );
            expect(vi.mocked(fetch).mock.calls[0][1]).toMatchObject({
                redirect: 'error',
                headers: { Authorization: 'Bearer fictional-user-token', apikey: 'fictional-public-anon' },
            });
        },
    );
    it('bounds a stalled Pi hop and prevents a late native header continuation', async () => {
        const old = deferred<ReturnType<typeof wire>>();
        f.pi.mockReturnValue(old.promise);
        const api = await load(),
            pending = api.fetchMarineModelV2(point.latitude, point.longitude);
        await vi.advanceTimersByTimeAsync(4000);
        expect((await pending)?.via).toBe('supabase');
        expect(f.pi.mock.calls[0][0].isCurrent()).toBe(false);
        old.resolve(wire());
        await vi.advanceTimersByTimeAsync(1);
        expect((await api.fetchMarineModelV2(point.latitude, point.longitude))?.via).toBe('supabase');
        expect(f.pi).toHaveBeenCalledTimes(1);
    });
    it('bounds auth-header loading inside the Edge hop and never sends after that deadline', async () => {
        f.reach = false;
        const headers = deferred<Record<string, string>>();
        f.headers.mockReturnValue(headers.promise);
        const pending = (await load()).fetchMarineModelV2(point.latitude, point.longitude);
        await vi.advanceTimersByTimeAsync(4000);
        expect(await pending).toBeNull();
        headers.resolve({ Authorization: 'Bearer fictional-old-token' });
        await vi.advanceTimersByTimeAsync(1);
        expect(fetch).not.toHaveBeenCalled();
    });
    it('bounds response-body wait and aborts without caching a late body', async () => {
        f.reach = false;
        let signal!: AbortSignal;
        vi.mocked(fetch).mockImplementation(async (_url, init) => {
            signal = init!.signal!;
            return new Response(
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
            );
        });
        const pending = (await load()).fetchMarineModelV2(point.latitude, point.longitude);
        await vi.advanceTimersByTimeAsync(4000);
        expect(await pending).toBeNull();
        expect(signal.aborted).toBe(true);
    });
    it.each(['owner', 'vessel', 'pair'] as const)(
        'retires a delayed %s A-B-A result and its cache write',
        async (kind) => {
            const old = deferred<ReturnType<typeof wire>>();
            f.pi.mockReturnValueOnce(old.promise);
            const api = await load(),
                pending = api.fetchMarineModelV2(point.latitude, point.longitude);
            if (kind === 'owner') {
                f.owner = { key: 'owner-B', userId: 'owner-B', generation: 2 };
                f.authListeners.forEach((fn) => fn());
                f.owner = { key: 'owner-A', userId: 'owner-A', generation: 3 };
                f.authListeners.forEach((fn) => fn());
            }
            if (kind === 'vessel') {
                f.boat = 'boat-B';
                f.boatListeners.forEach((fn) => fn({ activeVesselId: 'boat-B' }, { activeVesselId: 'boat-A' }));
                f.boat = 'boat-A';
                f.boatListeners.forEach((fn) => fn({ activeVesselId: 'boat-A' }, { activeVesselId: 'boat-B' }));
            }
            if (kind === 'pair') f.pairRevision += 2;
            old.resolve(wire());
            expect(await pending).toBeNull();
            expect(fetch).not.toHaveBeenCalled();
            expect((await api.fetchMarineModelV2(point.latitude, point.longitude))?.via).toBe('pi');
            expect(f.pi).toHaveBeenCalledTimes(2);
        },
    );
    it('joins equal in-flight coordinates instead of issuing another hop', async () => {
        const old = deferred<ReturnType<typeof wire>>();
        f.pi.mockReturnValueOnce(old.promise);
        const api = await load();
        const first = api.fetchMarineModelV2(point.latitude, point.longitude),
            second = api.fetchMarineModelV2(point.latitude, point.longitude);
        expect(f.pi).toHaveBeenCalledTimes(1);
        old.resolve(wire());
        expect(await first).toEqual(await second);
    });
    it('bounds total active reads even while old identity leases are retired', async () => {
        const waits = Array.from({ length: 8 }, () => deferred<ReturnType<typeof wire>>());
        waits.forEach((wait) => f.pi.mockReturnValueOnce(wait.promise));
        const api = await load(),
            pending = waits.map((_wait, index) =>
                api.fetchMarineModelV2(point.latitude + index / 10000, point.longitude),
            );
        expect(await api.fetchMarineModelV2(point.latitude + 0.01, point.longitude)).toBeNull();
        expect(f.pi).toHaveBeenCalledTimes(8);
        api.retireMarineModelV2();
        expect(await api.fetchMarineModelV2(point.latitude + 0.02, point.longitude)).toBeNull();
        waits.forEach((wait) => wait.resolve(wire()));
        expect((await Promise.all(pending)).every((value) => value === null)).toBe(true);
        expect((await api.fetchMarineModelV2(point.latitude, point.longitude))?.via).toBe('pi');
        expect(f.pi).toHaveBeenCalledTimes(9);
    });
    it('keeps at most32 point records in RAM and reloads the oldest', async () => {
        f.pi.mockImplementation(async ({ url }: { url: string }) => {
            const requested = new URL(url).searchParams;
            const raw = envelope();
            raw.requested = { latitude: Number(requested.get('lat')), longitude: Number(requested.get('lon')) };
            return { status: 200, data: JSON.stringify(raw) };
        });
        const api = await load();
        for (let i = 0; i < 33; i++)
            expect(await api.fetchMarineModelV2(point.latitude + i / 10000, point.longitude)).not.toBeNull();
        expect(f.pi).toHaveBeenCalledTimes(33);
        await api.fetchMarineModelV2(point.latitude + 32 / 10000, point.longitude);
        expect(f.pi).toHaveBeenCalledTimes(33);
        await api.fetchMarineModelV2(point.latitude, point.longitude);
        expect(f.pi).toHaveBeenCalledTimes(34);
    });
    it.each([
        [NaN, 0],
        [Infinity, 0],
        [91, 0],
        [0, 181],
    ])('refuses invalid point %s,%s before network', async (lat, lon) => {
        expect(await (await load()).fetchMarineModelV2(lat, lon)).toBeNull();
        expect(f.pi).not.toHaveBeenCalled();
        expect(fetch).not.toHaveBeenCalled();
    });
});
