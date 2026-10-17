import { beforeEach, afterEach, it, expect, vi } from 'vitest';
const f = vi.hoisted(() => ({
    owner: '10000000-0000-4000-8000-000000000001',
    boat: '20000000-0000-4000-8000-000000000001',
    pi: '30000000-0000-4000-8000-000000000001',
    device: '40000000-0000-4000-8000-000000000001',
    epoch: 0,
    pairEpoch: 0,
    authListeners: new Set<() => void>(),
    fleetListeners: new Set<(n: { activeVesselId: string }, p: { activeVesselId: string }) => void>(),
    statusOwner: null as string | null,
    getDevice: vi.fn(),
    request: vi.fn(),
    appState: vi.fn(),
    appListen: vi.fn(),
    fetch: vi.fn(),
    native: false,
    nativePost: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => f.native },
    CapacitorHttp: { post: (...args: unknown[]) => f.nativePost(...args) },
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => ({ userId: f.owner, generation: f.epoch, key: 'fixture-owner' }),
    isAuthIdentityScopeCurrent: (s: { generation: number }) => s.generation === f.epoch,
    subscribeAuthIdentityScope: (fn: () => void) => {
        f.authListeners.add(fn);
        return () => f.authListeners.delete(fn);
    },
}));
vi.mock('../stores/settingsStore', () => ({
    useSettingsStore: {
        getState: () => ({
            activeVesselId: f.boat,
            vesselFleet: [
                {
                    id: f.boat,
                    owner_id: f.owner,
                    profile: { name: 'Fixture yacht' },
                    archived_at: null,
                    releasedAt: null,
                },
            ],
        }),
        subscribe: (fn: (n: { activeVesselId: string }, p: { activeVesselId: string }) => void) => {
            f.fleetListeners.add(fn);
            return () => f.fleetListeners.delete(fn);
        },
    },
}));
vi.mock('../services/PiPairingService', () => ({
    getPairing: () => ({ deviceId: f.pi, publicKeySpki: 'A'.repeat(120), pairedAt: 'fixture-pair' }),
    getPiEquipmentReadRevision: () => f.pairEpoch,
    getChartDevice: (...args: unknown[]) => f.getDevice(...args),
    pinnedPiRequest: (...args: unknown[]) => f.request(...args),
    verifySignedResponse: async () => ({ ok: true }),
}));
vi.mock('../services/PiCacheService', () => ({ piCache: { lanBaseUrlNow: () => 'https://boat.local:3001' } }));
vi.mock('../services/piTls', () => ({ isPinnedTransportAvailable: () => true }));
vi.mock('../services/supabaseAuth', () => ({
    getAuthenticatedFunctionHeaders: async () => ({
        Authorization: 'Bearer fixture-owner-token',
        apikey: 'public-not-needed',
    }),
}));
vi.mock('@capacitor/app', () => ({
    App: { getState: () => f.appState(), addListener: (...args: unknown[]) => f.appListen(...args) },
}));
import { reviewPiFleetSharing, piFleetWorkerOrigin, stopPairedPiFleetSharing } from '../services/ais/piFleetClient';
beforeEach(() => {
    vi.stubEnv('VITE_FLEET_FEED_URL', 'https://fleet.invalid/fleet-feed');
    vi.stubGlobal('fetch', f.fetch);
    f.epoch = 0;
    f.pairEpoch = 0;
    f.statusOwner = null;
    f.native = false;
    f.nativePost.mockReset();
    f.authListeners.clear();
    f.fleetListeners.clear();
    f.getDevice.mockReset().mockResolvedValue({ chartDeviceId: f.device });
    f.appState.mockReset().mockResolvedValue({ isActive: true });
    f.appListen.mockReset().mockResolvedValue({ remove: async () => {} });
    f.fetch.mockReset();
    f.request.mockReset().mockImplementation(async () => ({
        status: 200,
        data: JSON.stringify({
            schema: 1,
            operatorConfigured: true,
            state: 'off',
            consent: null,
            lastLocalRevision: null,
            lastAcknowledgedAt: null,
        }),
    }));
});
afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});
it('captures actual owner/fleet/pair/enrollment before any Pi review; release retires both subscriptions', async () => {
    const session = await reviewPiFleetSharing();
    expect(session.current()).toBe(true);
    expect(f.request).toHaveBeenCalledTimes(1);
    const call = f.request.mock.calls[0][0];
    expect(call.url).toBe('https://boat.local:3001/api/fleet-sharing/status');
    expect(call.isCurrent()).toBe(true);
    session.release();
    expect(session.current()).toBe(false);
    expect(f.authListeners.size).toBe(0);
    expect(f.fleetListeners.size).toBe(0);
    expect(f.fetch).not.toHaveBeenCalled();
});
for (const retirement of ['vessel-A-B-A', 'pair-A-B-A', 'auth-A-B-A', 'background'] as const)
    it(retirement + ' during secure enrollment read cannot issue a Pi request', async () => {
        let finish!: (v: { chartDeviceId: string }) => void;
        f.getDevice.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const pending = reviewPiFleetSharing(),
            rejected = expect(pending).rejects.toThrow();
        await vi.waitFor(() => expect(f.getDevice).toHaveBeenCalled());
        if (retirement === 'vessel-A-B-A')
            for (const listener of [...f.fleetListeners]) {
                listener({ activeVesselId: f.pi }, { activeVesselId: f.boat });
                listener({ activeVesselId: f.boat }, { activeVesselId: f.pi });
            }
        if (retirement === 'pair-A-B-A') f.pairEpoch += 2;
        if (retirement === 'auth-A-B-A') {
            f.epoch += 2;
            for (const listener of [...f.authListeners]) listener();
        }
        if (retirement === 'background') f.appListen.mock.calls[0][1]({ isActive: false });
        finish({ chartDeviceId: f.device });
        await rejected;
        expect(f.request).not.toHaveBeenCalled();
        expect(f.fetch).not.toHaveBeenCalled();
        expect(f.authListeners.size).toBe(0);
    });
it('operator endpoint is fixed public HTTPS with no credential, query, fragment or alternate path', () => {
    expect(piFleetWorkerOrigin('https://fleet.invalid/fleet-feed')).toBe('https://fleet.invalid');
    for (const v of [
        'http://fleet.invalid/fleet-feed',
        'https://u:p@fleet.invalid/fleet-feed',
        'https://fleet.invalid/fleet-feed?target=other',
        'https://fleet.invalid/wrong',
    ])
        expect(piFleetWorkerOrigin(v)).toBeNull();
});
it('local privacy stop needs no WAN endpoint, status receipt or selected-vessel consent', async () => {
    vi.stubEnv('VITE_FLEET_FEED_URL', '');
    await stopPairedPiFleetSharing();
    expect(f.request).toHaveBeenCalledTimes(1);
    expect(f.request.mock.calls[0][0]).toMatchObject({
        url: 'https://boat.local:3001/api/fleet-sharing/off',
        method: 'POST',
        data: { schema: 1 },
    });
    expect(f.fetch).not.toHaveBeenCalled();
});
it('local stop rejects a pair retirement during enrollment and makes no request', async () => {
    let resolve!: (v: { chartDeviceId: string }) => void;
    f.getDevice.mockImplementation(
        () =>
            new Promise((r) => {
                resolve = r;
            }),
    );
    const pending = stopPairedPiFleetSharing(),
        rejected = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(f.getDevice).toHaveBeenCalled());
    f.pairEpoch += 2;
    resolve({ chartDeviceId: f.device });
    await rejected;
    expect(f.request).not.toHaveBeenCalled();
});
it('local stop only accepts an actual current off acknowledgement', async () => {
    f.request.mockResolvedValue({
        status: 200,
        data: JSON.stringify({
            schema: 1,
            operatorConfigured: true,
            state: 'unavailable',
            consent: null,
            lastLocalRevision: null,
            lastAcknowledgedAt: null,
        }),
    });
    await expect(stopPairedPiFleetSharing()).rejects.toThrow('could not be confirmed');
});
for (const native of [false, true])
    it(`a stalled ${native ? 'native' : 'browser'} consent read has a JS deadline and cannot reach Pi confirmation`, async () => {
        const session = await reviewPiFleetSharing();
        vi.useFakeTimers();
        f.native = native;
        f.request.mockImplementation(
            async (request: { url: string; data: { nonce: string; expectedRevision: null; expiresAt: number } }) => ({
                status: 200,
                data: JSON.stringify({
                    proposal: {
                        schema: 1,
                        binding: {
                            ownerId: f.owner,
                            boatId: f.boat,
                            piDeviceId: f.pi,
                            relayId: 'fictional-relay-14005',
                            pairingId: 'a'.repeat(64),
                            controllerId: f.device,
                            enrollmentRevision: 'b'.repeat(64),
                            sourceKey: 'c'.repeat(64),
                        },
                        enabled: true,
                        consentVersion: '2026-10-17-pi-v1',
                        at: Date.now(),
                        expiresAt: request.data.expiresAt,
                        expectedRevision: request.data.expectedRevision,
                        nonce: request.data.nonce,
                        publicKeySpki: 'A'.repeat(120),
                    },
                    signature: 'synthetic-pinned-signature',
                }),
            }),
        );
        const send = native ? f.nativePost : f.fetch;
        send.mockImplementation(() => new Promise(() => {}));
        const pending = session.enable(),
            rejected = expect(pending).rejects.toThrow('deadline');
        await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
        if (native)
            expect(send.mock.calls[0][0]).toMatchObject({
                disableRedirects: true,
                readTimeout: 6000,
                connectTimeout: 2500,
                responseType: 'text',
            });
        await vi.advanceTimersByTimeAsync(7000);
        await rejected;
        expect(f.request.mock.calls.some(([request]) => request.url.endsWith('/confirm'))).toBe(false);
        session.release();
    });
