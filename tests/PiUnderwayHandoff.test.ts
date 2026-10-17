import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UnderwayInputs } from '../services/underway/UnderwayAlarmWatch';
const state = vi.hoisted(() => ({
    pair: { deviceId: 'boat-a', publicKeySpki: 'key-a' } as { deviceId: string; publicKeySpki: string } | null,
    base: 'https://boat-a' as string | null,
    request: vi.fn(),
    action: null as null | ((action: { kind: string }) => void),
}));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => state.pair, pinnedPiRequest: state.request }));
vi.mock('../services/PiCacheService', () => ({ piCache: { lanBaseUrlNow: () => state.base } }));
vi.mock('../services/underway/underwayAlarmStore', () => ({
    UnderwayAlarmStore: {
        subscribeActions: (listener: typeof state.action) => {
            state.action = listener;
            return () => undefined;
        },
    },
}));
const at = 1792100000000;
const input = (key: string | null = 'route-a'): UnderwayInputs => ({
    nowMs: Date.now(),
    prefs: {
        offRoute: { enabled: true, inshoreNm: 0.25, offshoreNm: 1 },
        shoal: { enabled: true },
        watchCheck: { enabled: false, intervalMin: 15 },
    },
    following: key
        ? {
              key,
              route: [
                  { lat: 30, lon: -150 },
                  { lat: 31, lon: -150 },
              ],
          }
        : null,
    fix: { lat: 30.2, lon: -150, at: Date.now() },
    sogKn: 6,
    cogDeg: 0,
    atAnchor: false,
    zone: null,
    depth: { boatFeed: false, depthM: null, reference: null, freshness: 'dead', readingAt: 0 },
    draftM: 2,
    draftAssumed: false,
    marginM: 0.5,
});
const response = (routeKey: string | null = 'route-a', alarms: unknown[] = []): { status: number; data: string } => ({
    status: 200,
    data: JSON.stringify({ v: 1, armed: routeKey !== null, routeKey, alarms }),
});
const alarm = { kind: 'off-route', key: `off-route::${at}`, ackedAt: null };
const drain = async () => {
    for (let i = 0; i < 25; i++) await Promise.resolve();
};
beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(at);
    state.pair = { deviceId: 'boat-a', publicKeySpki: 'key-a' };
    state.base = 'https://boat-a';
    state.request.mockReset();
    state.action = null;
});
afterEach(() => vi.useRealTimers());

describe('Pi followed-route handoff ownership', () => {
    it('a cold-started phone without a route never stands down somebody else’s Pi watch', async () => {
        const { syncPiUnderway } = await import('../services/underway/piUnderwayWatch');
        syncPiUnderway(input(null));
        await drain();
        expect(state.request).not.toHaveBeenCalled();
    });
    it('sends the exact route/draft/clearance over the pinned lane and binds acknowledgements to its confirmed route', async () => {
        state.request.mockResolvedValue(response('route-a', [alarm]));
        const { syncPiUnderway } = await import('../services/underway/piUnderwayWatch');
        const current = input();
        syncPiUnderway(current);
        await drain();
        expect(state.request).toHaveBeenCalledWith(
            expect.objectContaining({
                url: 'https://boat-a/api/underway-watch',
                method: 'POST',
                data: {
                    armed: true,
                    configuration: {
                        key: 'route-a',
                        route: current.following!.route,
                        draftM: 2,
                        ukcM: 0.5,
                        prefs: current.prefs,
                    },
                },
            }),
        );
        state.action?.({ kind: 'off-route' });
        expect(state.request.mock.calls.at(-1)![0]).toMatchObject({
            url: 'https://boat-a/api/underway-watch/ack',
            data: { key: alarm.key },
        });
    });
    it('never transports a cached acknowledgement to a different pairing or LAN endpoint', async () => {
        state.request.mockResolvedValue(response('route-a', [alarm]));
        const { syncPiUnderway } = await import('../services/underway/piUnderwayWatch');
        syncPiUnderway(input());
        await drain();
        state.request.mockClear();
        state.base = 'https://boat-b';
        state.action?.({ kind: 'off-route' });
        expect(state.request).not.toHaveBeenCalled();
        state.base = 'https://boat-a';
        state.pair = { deviceId: 'boat-b', publicKeySpki: 'key-b' };
        state.action?.({ kind: 'off-route' });
        expect(state.request).not.toHaveBeenCalled();
    });
    it('route intent changes immediately retire old alarm keys even while a new handoff is pending', async () => {
        state.request.mockResolvedValueOnce(response('route-a', [alarm])).mockReturnValue(new Promise(() => undefined));
        const { syncPiUnderway } = await import('../services/underway/piUnderwayWatch');
        syncPiUnderway(input());
        await drain();
        syncPiUnderway(input('route-b'));
        state.request.mockClear();
        state.action?.({ kind: 'off-route' });
        expect(state.request).not.toHaveBeenCalled();
    });
    it('a response for another route gives no alarm keys and does not automatically rearm the old route', async () => {
        state.request
            .mockResolvedValueOnce(response('route-a', [alarm]))
            .mockResolvedValue(response('route-b', [alarm]));
        const { syncPiUnderway } = await import('../services/underway/piUnderwayWatch');
        syncPiUnderway(input());
        await drain();
        vi.setSystemTime(at + 16000);
        syncPiUnderway(input());
        await drain();
        expect(state.request.mock.calls.at(-1)![0].method).toBe('GET');
        state.request.mockClear();
        state.action?.({ kind: 'off-route' });
        vi.setSystemTime(at + 40000);
        syncPiUnderway(input());
        await drain();
        expect(state.request).not.toHaveBeenCalled();
        syncPiUnderway(input('route-c'));
        await drain();
        expect(state.request.mock.calls[0][0]).toMatchObject({
            method: 'POST',
            data: { configuration: { key: 'route-c' } },
        });
    });
    it('a late own arm response after Stop is cleaned up with a route-conditional stand-down', async () => {
        let done!: (value: unknown) => void;
        state.request
            .mockReturnValueOnce(
                new Promise((resolve) => {
                    done = resolve;
                }),
            )
            .mockResolvedValue(response(null));
        const { syncPiUnderway } = await import('../services/underway/piUnderwayWatch');
        syncPiUnderway(input());
        syncPiUnderway(input(null));
        done(response('route-a', [alarm]));
        await drain();
        expect(state.request).toHaveBeenCalledTimes(2);
        expect(state.request.mock.calls[1][0]).toMatchObject({
            method: 'POST',
            data: { armed: false, routeKey: 'route-a' },
        });
        state.request.mockClear();
        state.action?.({ kind: 'off-route' });
        expect(state.request).not.toHaveBeenCalled();
    });
    it('an old in-flight response cannot claim ownership of a newly paired boat', async () => {
        let done!: (value: unknown) => void;
        state.request.mockReturnValue(
            new Promise((resolve) => {
                done = resolve;
            }),
        );
        const { syncPiUnderway } = await import('../services/underway/piUnderwayWatch');
        syncPiUnderway(input());
        state.pair = { deviceId: 'boat-b', publicKeySpki: 'key-b' };
        state.base = 'https://boat-b';
        syncPiUnderway(input(null));
        done(response('route-a', [alarm]));
        await drain();
        state.request.mockClear();
        state.action?.({ kind: 'off-route' });
        syncPiUnderway(input(null));
        await drain();
        expect(state.request).not.toHaveBeenCalled();
    });
    it('a transient LAN loss does not forget this session’s ownership when Stop needs a later cleanup', async () => {
        state.request.mockResolvedValueOnce(response('route-a')).mockResolvedValue(response(null));
        const { syncPiUnderway } = await import('../services/underway/piUnderwayWatch');
        syncPiUnderway(input());
        await drain();
        state.base = null;
        syncPiUnderway(input(null));
        state.base = 'https://boat-a';
        syncPiUnderway(input(null));
        await drain();
        expect(state.request.mock.calls.at(-1)![0]).toMatchObject({ data: { armed: false, routeKey: 'route-a' } });
    });
    it('does not simplify an oversized new route and cleans up only its previously confirmed route', async () => {
        state.request.mockResolvedValueOnce(response('route-a')).mockResolvedValue(response(null));
        const { syncPiUnderway } = await import('../services/underway/piUnderwayWatch');
        syncPiUnderway(input());
        await drain();
        const invalid = input('route-b');
        invalid.following!.route = Array.from({ length: 1001 }, (_, i) => ({ lat: 30 + i * 0.0001, lon: -150 }));
        syncPiUnderway(invalid);
        await drain();
        expect(state.request).toHaveBeenCalledTimes(2);
        expect(state.request.mock.calls[1][0]).toMatchObject({ data: { armed: false, routeKey: 'route-a' } });
    });
    it('a Pi400 for a new route triggers old-route cleanup rather than indefinitely retrying the rejected route', async () => {
        state.request
            .mockResolvedValueOnce(response('route-a'))
            .mockResolvedValueOnce({ status: 400, data: 'invalid route' })
            .mockResolvedValue(response(null));
        const { syncPiUnderway } = await import('../services/underway/piUnderwayWatch');
        syncPiUnderway(input());
        await drain();
        syncPiUnderway(input('route-b'));
        await drain();
        expect(state.request.mock.calls[2][0]).toMatchObject({ data: { armed: false, routeKey: 'route-a' } });
        state.request.mockClear();
        vi.setSystemTime(at + 60000);
        syncPiUnderway(input('route-b'));
        await drain();
        expect(state.request).not.toHaveBeenCalled();
    });
    it('a409 during stand-down stands aside for the other device instead of repeating destructive cleanup', async () => {
        state.request
            .mockResolvedValueOnce(response('route-a'))
            .mockResolvedValue({ status: 409, data: 'route changed' });
        const { syncPiUnderway } = await import('../services/underway/piUnderwayWatch');
        syncPiUnderway(input());
        await drain();
        syncPiUnderway(input(null));
        await drain();
        state.request.mockClear();
        vi.setSystemTime(at + 60000);
        syncPiUnderway(input(null));
        await drain();
        expect(state.request).not.toHaveBeenCalled();
    });
    it('does not acknowledge mismatched kind/key, already-acked or stale Pi snapshots', async () => {
        state.request.mockResolvedValue(
            response('route-a', [
                { kind: 'off-route', key: `chart-ahead::${at}` },
                { ...alarm, ackedAt: at },
            ]),
        );
        const { syncPiUnderway } = await import('../services/underway/piUnderwayWatch');
        syncPiUnderway(input());
        await drain();
        state.request.mockClear();
        state.action?.({ kind: 'off-route' });
        expect(state.request).not.toHaveBeenCalled();
        state.request.mockResolvedValue(response('route-a', [alarm]));
        vi.setSystemTime(at + 16000);
        syncPiUnderway(input());
        await drain();
        state.request.mockClear();
        vi.setSystemTime(at + 62000);
        state.action?.({ kind: 'off-route' });
        expect(state.request).not.toHaveBeenCalled();
    });
});
