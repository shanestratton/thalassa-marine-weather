import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
    pairing: { deviceId: 'fictional-pi', publicKeySpki: 'synthetic-pin', pairedAt: '2026-10-16T00:00:00Z' },
    paired: true,
    native: true,
    base: 'https://pi.local:8080' as string | null,
    foreground: true,
    chart: vi.fn(),
    request: vi.fn(),
    app: null as null | ((state: { isActive: boolean }) => void),
    audio: { enabled: vi.fn(), stop: vi.fn(), update: vi.fn() },
}));
vi.mock('../services/PiPairingService', () => ({
    getPairing: () => (f.paired ? f.pairing : null),
    getChartDevice: f.chart,
    pinnedPiRequest: f.request,
}));
vi.mock('../services/piTls', () => ({ isPinnedTransportAvailable: () => f.native }));
vi.mock('../services/PiCacheService', () => ({ piCache: { lanBaseUrlNow: () => f.base } }));
vi.mock('../services/signalk/notificationAudio', () => ({
    SignalKNotificationAudio: class {
        setEnabled = f.audio.enabled;
        stop = f.audio.stop;
        update = f.audio.update;
    },
}));
vi.mock('@capacitor/app', () => ({
    App: {
        getState: async () => ({ isActive: f.foreground }),
        addListener: async (_event: string, callback: (state: { isActive: boolean }) => void) => {
            f.app = callback;
            return {
                remove: async () => {
                    if (f.app === callback) f.app = null;
                },
            };
        },
    },
}));
import { PairedPiNotifications as service } from '../services/signalk/PairedPiNotifications';
import { parsePiSignalKNotifications } from '../services/signalk/piNotifications';
import { setAuthIdentityScope } from '../services/authIdentityScope';
const NOW = Date.parse('2026-10-16T00:00:00Z');
const session = '12345678-1234-4321-8765-123456789012';
const notice = (at = NOW - 5000) => ({
    path: 'notifications.depth',
    source: 'sensor.1',
    at,
    receivedAt: at + 100,
    message: 'Depth alarm',
    state: 'alarm',
    soundRequested: true,
});
const body = (notices: unknown[] = [notice()], overrides: Record<string, unknown> = {}) => ({
    schema: 1,
    session,
    startedAt: NOW - 10000,
    state: 'reading',
    servedAt: Date.now(),
    notices,
    truncated: false,
    ...overrides,
});
const response = (data: unknown, status = 200) => ({
    status,
    data: JSON.stringify(data),
    headers: {},
    peerSpki: 'synthetic-pin',
});
beforeEach(() => {
    service.stop();
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    setAuthIdentityScope('fictional-skipper');
    f.paired = true;
    f.native = true;
    f.base = 'https://pi.local:8080';
    f.foreground = true;
    f.pairing = { deviceId: 'fictional-pi', publicKeySpki: 'synthetic-pin', pairedAt: '2026-10-16T00:00:00Z' };
    f.chart.mockResolvedValue({ chartDeviceId: 'fictional-enrolled' });
    f.request.mockImplementation(async () => response(body()));
    vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
});
afterEach(() => {
    service.stop();
    setAuthIdentityScope(null);
    vi.useRealTimers();
    vi.restoreAllMocks();
});
describe('bounded paired Pi notification wire contract', () => {
    it('keeps original notification identity/source clocks and validates explicit response session', () => {
        expect(parsePiSignalKNotifications(JSON.stringify(body()), NOW)).toMatchObject({
            session,
            notices: [notice()],
        });
    });
    it.each([
        { schema: 0 },
        { session: 'not-a-session' },
        { servedAt: NOW + 5001 },
        { servedAt: NOW - 15001 },
        { truncated: 'yes' },
        { state: 'unavailable' },
        { origin: 'https://unexpected.example' },
    ])('refuses unknown/legacy/stale session shape %j', (override) => {
        expect(() => parsePiSignalKNotifications(JSON.stringify(body([notice()], override)), NOW)).toThrow();
    });
    it.each([
        { at: 0 },
        { at: NOW + 10000 },
        { receivedAt: 0 },
        { message: 'bad\u0000text' },
        { path: 'notifications.__proto__' },
        { source: 'https://untrusted?token=private' },
        { state: 'made-up' },
        { soundRequested: 1 },
        { extra: 0 },
    ])('refuses invalid notification data %j', (override) => {
        expect(() => parsePiSignalKNotifications(JSON.stringify(body([{ ...notice(), ...override }])), NOW)).toThrow();
    });
    it('bounds UTF8 bytes/count and refuses duplicate IDs instead of inventing rows or clocks', () => {
        expect(() => parsePiSignalKNotifications(' '.repeat(16384) + '{}', NOW)).toThrow();
        expect(() =>
            parsePiSignalKNotifications(JSON.stringify(body(Array.from({ length: 65 }, () => notice()))), NOW),
        ).toThrow();
        expect(() => parsePiSignalKNotifications(JSON.stringify(body([notice(), notice()])), NOW)).toThrow();
        expect(
            parsePiSignalKNotifications(
                JSON.stringify(body([], { state: 'unavailable', session: null, startedAt: null })),
                NOW,
            ).notices,
        ).toEqual([]);
    });
});
describe('foreground paired Pi consumer', () => {
    it('reads only the fixed pinned/enrolled boat-LAN endpoint, preserving dated rows and a silent initial baseline', async () => {
        await service.start();
        expect(f.chart).toHaveBeenCalledTimes(1);
        expect(f.request).toHaveBeenCalledWith({
            url: 'https://pi.local:8080/api/signalk/notifications',
            method: 'GET',
            responseType: 'text',
            connectTimeout: 2500,
            readTimeout: 4000,
        });
        expect(service.getSnapshot()).toMatchObject({
            status: 'reading',
            source: 'pairedPi',
            notices: [notice()],
            soundEnabled: false,
        });
        expect(f.audio.update.mock.calls.at(-1)?.[1]).toEqual([]);
    });
    it.each(['pair', 'native', 'lan'] as const)(
        'refuses without %s and never tries an internet/browser fallback',
        async (key) => {
            if (key === 'pair') f.paired = false;
            if (key === 'native') f.native = false;
            if (key === 'lan') f.base = null;
            await service.start();
            expect(service.getSnapshot().status).toBe('unavailable');
            expect(f.chart).not.toHaveBeenCalled();
            expect(f.request).not.toHaveBeenCalled();
        },
    );
    it('requires enrollment before transport and reports old Pi without another endpoint/provider attempt', async () => {
        f.chart.mockResolvedValue(null);
        await service.start();
        expect(service.getSnapshot().status).toBe('enrollment');
        expect(f.request).not.toHaveBeenCalled();
        f.chart.mockResolvedValue({ chartDeviceId: 'fictional-enrolled' });
        f.request.mockResolvedValue(response(null, 404));
        await service.start();
        expect(service.getSnapshot().status).toBe('update');
        expect(f.request).toHaveBeenCalledTimes(1);
    });
    it.each([401, 403])('revocation %s clears source and opt-in immediately', async (status) => {
        await service.start();
        service.setNotificationSound(true);
        f.request.mockResolvedValue(response(null, status));
        await vi.advanceTimersByTimeAsync(3000);
        expect(service.getSnapshot()).toMatchObject({ status: 'enrollment', notices: [], soundEnabled: false });
    });
    it('deduplicates source timestamps across absent/replayed rows; only later fresh events can cue after opt-in', async () => {
        await service.start();
        service.setNotificationSound(true);
        f.request.mockImplementation(async () => response(body([])));
        await vi.advanceTimersByTimeAsync(3000);
        f.request.mockImplementation(async () => response(body([notice()])));
        await vi.advanceTimersByTimeAsync(3000);
        expect(f.audio.update.mock.calls.at(-1)?.[1]).toEqual([]);
        f.request.mockImplementation(async () => response(body([notice(NOW + 8000)])));
        await vi.advanceTimersByTimeAsync(3000);
        expect(f.audio.update.mock.calls.at(-1)?.[1]).toEqual([{ notice: notice(NOW + 8000), fresh: true }]);
    });
    it('new Pi stream sessions and truncated lists reset sound and do not replay their initial alarms', async () => {
        await service.start();
        service.setNotificationSound(true);
        f.request.mockImplementation(async () =>
            response(body([notice(NOW + 2000)], { session: '22345678-1234-4321-8765-123456789012' })),
        );
        await vi.advanceTimersByTimeAsync(3000);
        expect(service.getSnapshot().soundEnabled).toBe(false);
        expect(f.audio.update.mock.calls.at(-1)?.[1]).toEqual([]);
        f.request.mockImplementation(async () => response(body([notice(NOW + 5000)], { truncated: true })));
        await vi.advanceTimersByTimeAsync(3000);
        service.setNotificationSound(true);
        expect(service.getSnapshot()).toMatchObject({ soundEnabled: false, truncated: true });
    });
    it.each(['key', 'device', 'pairedAt', 'base'] as const)(
        'a changed %s fences displayed data before another poll',
        async (key) => {
            await service.start();
            if (key === 'key') f.pairing = { ...f.pairing, publicKeySpki: 'other-pin' };
            if (key === 'device') f.pairing = { ...f.pairing, deviceId: 'other-pi' };
            if (key === 'pairedAt') f.pairing = { ...f.pairing, pairedAt: '2026-10-16T00:01:00Z' };
            if (key === 'base') f.base = 'https://other.local:8080';
            await vi.advanceTimersByTimeAsync(1000);
            expect(service.getSnapshot()).toMatchObject({ status: 'paused', notices: [], soundEnabled: false });
            expect(f.request).toHaveBeenCalledTimes(1);
        },
    );
    it('account change clears synchronously and discards an earlier pending native reply', async () => {
        let resolve!: (value: ReturnType<typeof response>) => void;
        f.request.mockImplementation(
            () =>
                new Promise((r) => {
                    resolve = r;
                }),
        );
        const reading = service.start();
        await vi.advanceTimersByTimeAsync(0);
        setAuthIdentityScope('other-fictional-skipper');
        expect(service.getSnapshot().notices).toEqual([]);
        resolve(response(body()));
        await reading;
        expect(service.getSnapshot()).toMatchObject({ status: 'paused', notices: [] });
    });
    it('background retires without automatic resume or later sound; no foreground request opens while already inactive', async () => {
        await service.start();
        service.setNotificationSound(true);
        f.app?.({ isActive: false });
        expect(service.getSnapshot()).toMatchObject({ status: 'paused', notices: [], soundEnabled: false });
        await vi.advanceTimersByTimeAsync(10000);
        expect(f.request).toHaveBeenCalledTimes(1);
        f.foreground = false;
        await service.start();
        expect(f.request).toHaveBeenCalledTimes(1);
    });
    it('a native request that never settles is bounded; malformed responses clear data without another request', async () => {
        f.request.mockImplementation(() => new Promise(() => undefined));
        const reading = service.start();
        await vi.advanceTimersByTimeAsync(7001);
        await reading;
        expect(service.getSnapshot().status).toBe('error');
        expect(f.request).toHaveBeenCalledTimes(1);
        f.request.mockResolvedValue(response({ schema: 0 }));
        await service.start();
        expect(service.getSnapshot()).toMatchObject({ status: 'error', notices: [] });
        await vi.advanceTimersByTimeAsync(10000);
        expect(f.request).toHaveBeenCalledTimes(2);
    });
});
