import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
    paired: false,
    satellite: false,
    native: true,
    foreground: true,
    request: vi.fn(),
    get: vi.fn(),
    set: vi.fn(),
    remove: vi.fn(),
    ingest: vi.fn(),
    clear: vi.fn(),
    stop: vi.fn(),
    streamStop: vi.fn(),
    opens: [] as { onMessage: (text: string) => void; onClosed: () => void }[],
    app: null as null | ((state: { isActive: boolean }) => void),
}));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => (f.paired ? {} : null) }));
vi.mock('../services/networkPolicy', () => ({ satelliteModeActive: () => f.satellite }));
vi.mock('../services/NmeaStore', () => ({
    NmeaStore: { start: vi.fn(), ingestRemote: f.ingest, clearRemote: f.clear },
}));
vi.mock('../services/NmeaListenerService', () => ({ NmeaListenerService: { stop: f.stop } }));
vi.mock('../services/auth/secureStorage', () => ({
    SECURE_SIGNALK_DEVICE_KEY: 'thalassa-signalk-device-v1',
    getSecureValue: f.get,
    setSecureValue: f.set,
    removeSecureValue: f.remove,
}));
vi.mock('../services/signalk/native', () => ({
    nativeSignalKAvailable: () => f.native,
    signalKNativeRequest: f.request,
    openSignalKNative: vi.fn((_config, _token, onMessage, onClosed) => {
        f.opens.push({ onMessage, onClosed });
        return { ready: Promise.resolve(), stop: f.streamStop };
    }),
}));
vi.mock('@capacitor/app', () => ({
    App: {
        getState: async () => ({ isActive: f.foreground }),
        addListener: async (_name: string, callback: (state: { isActive: boolean }) => void) => {
            f.app = callback;
            return {
                remove: async () => {
                    f.app = null;
                },
            };
        },
    },
}));
import {
    DirectSignalKService as service,
    accessRequestId,
    approvedSignalKAccess,
} from '../services/signalk/DirectSignalKService';
import { getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';
import { readSignalKDeviceConfig, saveSignalKDeviceConfig } from '../services/signalk/config';
const NOW = 1_800_000_000_000,
    self = 'urn:mrn:imo:mmsi:000000001';
const config = {
    origin: 'https://boat.example',
    clientId: '12345678-1234-4321-8765-123456789012',
    allowInsecureLan: false,
    selected: true,
};
const document = () => ({
    uuid: self,
    navigation: { speedOverGround: { value: 2, timestamp: new Date(NOW - 4000).toISOString(), $source: 'fixture' } },
});
beforeEach(() => {
    service.stop();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    localStorage.clear();
    setAuthIdentityScope('fictional-skipper');
    saveSignalKDeviceConfig(config);
    f.paired = false;
    f.satellite = false;
    f.native = true;
    f.foreground = true;
    f.opens = [];
    f.app = null;
    f.get.mockResolvedValue(
        JSON.stringify({
            owner: getAuthIdentityScope().key,
            origin: config.origin,
            clientId: config.clientId,
            token: 'synthetic-token',
            expiresAt: null,
        }),
    );
    f.request.mockImplementation(async (_config, target) =>
        target === 'self'
            ? { status: 200, body: document() }
            : { status: 202, body: { state: 'PENDING', href: '/signalk/v1/access/requests/test-id' } },
    );
});
afterEach(() => {
    service.stop();
    setAuthIdentityScope(null);
    vi.useRealTimers();
});
describe('selected direct Signal K lifecycle', () => {
    it('opens a read stream with qualified original clocks and never requests access on boot', async () => {
        await service.start();
        expect(service.getSnapshot().status).toBe('reading');
        expect(f.opens).toHaveLength(1);
        expect(f.request.mock.calls.map((c) => c[1])).toEqual(['self']);
        expect(f.ingest.mock.calls.at(-1)?.[0]).toMatchObject({
            source: 'device',
            via: 'signalk',
            gaugeTimes: { sog: NOW - 4000 },
        });
        expect(f.stop).toHaveBeenCalled();
        await vi.advanceTimersByTimeAsync(14000);
        expect(f.ingest.mock.calls.at(-1)?.[0].sogKts).toBeNull();
    });
    it.each(['paired', 'satellite', 'native'] as const)(
        'does not touch credentials/network when %s forbids the reader',
        async (key) => {
            if (key === 'native') f.native = false;
            else f[key] = true;
            await service.start();
            expect(f.get).not.toHaveBeenCalled();
            expect(f.request).not.toHaveBeenCalled();
            expect(f.opens).toHaveLength(0);
        },
    );
    it('cannot read another account/origin/device credential and does not silently enroll again', async () => {
        f.get.mockResolvedValue(
            JSON.stringify({
                owner: 'user:another',
                origin: config.origin,
                clientId: config.clientId,
                token: 'other-token',
                expiresAt: null,
            }),
        );
        await service.start();
        expect(service.getSnapshot().status).toBe('approval');
        expect(f.request).not.toHaveBeenCalled();
    });
    it('retires late HTTP bootstrap after account change before it can open or publish', async () => {
        let resolve!: (value: unknown) => void;
        f.request.mockImplementation(() => new Promise((r) => (resolve = r)));
        const opening = service.start();
        await vi.advanceTimersByTimeAsync(0);
        setAuthIdentityScope('fictional-other');
        resolve({ status: 200, body: document() });
        await opening;
        expect(f.opens).toHaveLength(0);
        expect(f.ingest).not.toHaveBeenCalled();
        expect(f.clear).toHaveBeenCalledWith('signalk');
    });
    it('stops on pairing/background/config retirement and ignores old-session callbacks', async () => {
        await service.start();
        const previous = f.opens[0];
        f.paired = true;
        await vi.advanceTimersByTimeAsync(1000);
        expect(f.streamStop).toHaveBeenCalled();
        expect(service.getSnapshot().status).toBe('paused');
        const count = f.ingest.mock.calls.length;
        previous.onMessage('{}');
        expect(f.ingest).toHaveBeenCalledTimes(count);
        f.paired = false;
        await service.start();
        f.app?.({ isActive: false });
        expect(service.getSnapshot().status).toBe('paused');
        await service.start();
        saveSignalKDeviceConfig({ ...config, selected: false });
        await vi.advanceTimersByTimeAsync(1000);
        expect(service.getSnapshot().status).toBe('paused');
    });
    it('marks revoked credentials for explicit approval without POST/reconnect loops', async () => {
        f.request.mockResolvedValue({ status: 403, body: null });
        await service.start();
        expect(service.getSnapshot().status).toBe('approval');
        await vi.advanceTimersByTimeAsync(120000);
        expect(f.request).toHaveBeenCalledTimes(1);
        expect(f.opens).toHaveLength(0);
    });
    it('handles official pending/denied approvals only after explicit user action', async () => {
        await service.requestApproval(config);
        expect(service.getSnapshot().status).toBe('pending');
        await vi.advanceTimersByTimeAsync(120000);
        expect(f.request).toHaveBeenCalledTimes(1);
        f.request.mockResolvedValueOnce({ status: 200, body: { state: 'PENDING' } });
        await service.checkApproval();
        expect(service.getSnapshot().status).toBe('pending');
        f.request.mockResolvedValueOnce({
            status: 200,
            body: { state: 'COMPLETED', statusCode: 200, accessRequest: { permission: 'DENIED' } },
        });
        await service.checkApproval();
        expect(service.getSnapshot().status).toBe('denied');
        expect(f.set).not.toHaveBeenCalled();
    });
    it('saves approved token only to secure storage and keeps preferences credential-free', async () => {
        await service.requestApproval(config);
        f.request.mockResolvedValueOnce({
            status: 200,
            body: {
                state: 'COMPLETED',
                statusCode: 200,
                accessRequest: { permission: 'APPROVED', token: 'synthetic-approved-token' },
            },
        });
        await service.checkApproval();
        expect(f.set).toHaveBeenCalledExactlyOnceWith(
            'thalassa-signalk-device-v1',
            expect.stringContaining('synthetic-approved-token'),
        );
        expect(JSON.stringify(readSignalKDeviceConfig())).not.toContain('token');
        expect(Object.values(localStorage).join('')).not.toContain('synthetic-approved-token');
    });
    it('refuses cross-origin approval hrefs and expired/invalid access documents', () => {
        expect(
            accessRequestId(
                { state: 'PENDING', href: '/signalk/v1/access/requests/opaque%3Aid%2Fwith%20spaces' },
                config.origin,
            ),
        ).toBe('opaque:id/with spaces');
        expect(
            accessRequestId(
                { state: 'PENDING', href: 'https://other.example/signalk/v1/access/requests/id' },
                config.origin,
            ),
        ).toBeNull();
        expect(
            accessRequestId({ state: 'PENDING', href: '/signalk/v1/access/requests/id?token=bad' }, config.origin),
        ).toBeNull();
        expect(
            approvedSignalKAccess(
                {
                    state: 'COMPLETED',
                    statusCode: 200,
                    accessRequest: {
                        permission: 'APPROVED',
                        token: 'x',
                        expirationTime: new Date(NOW - 1).toISOString(),
                    },
                },
                NOW,
            ),
        ).toBeNull();
    });
});
