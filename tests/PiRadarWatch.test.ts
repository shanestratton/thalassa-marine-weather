import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import fixture from './fixtures/radar-relay137.json';
const f = vi.hoisted(() => ({
    request: vi.fn(),
    device: vi.fn(),
    identity: 1,
    userId: '' as string | null,
    base: 'https://192.0.2.1:3443',
    pair: { deviceId: '', publicKeySpki: 'generated-pin', pairedAt: 'generated' },
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => ({ generation: f.identity, userId: f.userId }),
    isAuthIdentityScopeCurrent: (v: { generation: number }) => f.identity === v.generation,
}));
vi.mock('../services/PiPairingService', () => ({
    getPairing: () => f.pair,
    getChartDevice: f.device,
    pinnedPiRequest: f.request,
}));
vi.mock('../services/PiCacheService', () => ({ piCache: { lanBaseUrlNow: () => f.base } }));
vi.mock('../services/piTls', () => ({ isPinnedTransportAvailable: () => true }));
import { RadarWatch, radarServerOwnerRevision, type RadarServerContext } from '../pi-cache/src/radar/watch';
import { RadarFeed } from '../utils/radarFeed';
import { DEFAULT_COLLISION_PREFS } from '../utils/collisionRule';
import { decodePiRadarWatch } from '../services/radar/piRadarWatchWire';
import {
    readPiRadarWatch,
    armPiRadarWatch,
    stopPiRadarWatch,
    acknowledgePiRadarWatch,
} from '../services/radar/piRadarWatch';
const T = Date.UTC(2026, 0, 2, 12),
    b = fixture.context.binding;
const controller = { deviceId: b.deviceId, enrollmentRevision: b.enrollmentRevision };
const frame = (s: string) =>
    '$' +
    s +
    '*' +
    [...s]
        .reduce((a, c) => a ^ c.charCodeAt(0), 0)
        .toString(16)
        .padStart(2, '0');
let watch: RadarWatch, server: RadarServerContext;
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    f.identity = 1;
    f.userId = b.ownerId;
    f.base = 'https://192.0.2.1:3443';
    f.pair = { deviceId: b.piDeviceId, publicKeySpki: 'generated-pin', pairedAt: 'generated' };
    f.request.mockReset();
    f.device.mockReset().mockResolvedValue({ chartDeviceId: b.deviceId });
    const feed = new RadarFeed('pi:' + 'a'.repeat(32));
    feed.ingest(frame('GPRMC,120000,A,0000.000,N,00000.000,E,5,0,020126,,,A'), T, T);
    feed.ingest(frame('HEHDT,0,T'), T, T);
    feed.ingest(frame('RATTM,1,1,0,R,10,180,R,0,6,N,Generated,T,,120000,A'), T, T);
    server = {
        ownerId: b.ownerId,
        piDeviceId: b.piDeviceId,
        pairingId: b.pairingId,
        feedId: b.feedId,
        contextToken: 'a'.repeat(64),
    };
    watch = new RadarWatch({
        readSnapshot: () => ({
            schema: 1,
            source: 'radar',
            configured: true,
            connected: true,
            overloaded: false,
            servedAt: T,
            feedId: feed.feedId,
            lastFrameAt: T,
            lastTargetAt: T,
            ownship: feed.ownshipSnapshot(),
            observations: feed.evidence(T),
        }),
        currentContext: () => server,
        aisArmed: () => true,
        atAnchor: () => false,
        controllerCurrent: () => true,
        now: () => Date.now(),
    });
    f.request.mockImplementation(
        async (options: { url: string; method: string; data: unknown; isCurrent: () => boolean }) => {
            if (!options.isCurrent()) throw Error('cancelled');
            const view =
                options.method === 'GET'
                    ? await watch.describe()
                    : options.url.endsWith('/ack')
                      ? await watch.acknowledge(controller, options.data)
                      : await watch.command(controller, options.data);
            return { status: 200, data: JSON.stringify(view) };
        },
    );
});
afterEach(() => vi.useRealTimers());
describe('owned enrolled Pi radar watch client against the actual Pi model', () => {
    it('does not accept a ready push claim without its own fresh original check clock', async () => {
        const raw = await watch.describe();
        raw.push = { state: 'ready', checkedAt: null };
        expect(await decodePiRadarWatch(raw, T)).toBeNull();
        raw.push.checkedAt = T - 30001;
        expect(await decodePiRadarWatch(raw, T)).toBeNull();
    });
    it('keeps passive reads off; deliberate arm echoes both CAS proofs and exact ACK then stands down', async () => {
        const off = await readPiRadarWatch();
        expect(off.view.context).toBeNull();
        expect(off.view.state).toBe('off');
        const armed = await armPiRadarWatch(off, DEFAULT_COLLISION_PREFS);
        expect(armed.view.running).toBe(true);
        expect(armed.view.alarms).toHaveLength(1);
        expect(f.request.mock.calls[1][0].data).toMatchObject({
            armed: true,
            expected: null,
            expectedOwnerRevision: radarServerOwnerRevision(server),
        });
        expect(armed.view.alarms[0]).toMatchObject({ sourceAt: T, reportAt: T, unknown: false });
        const acked = await acknowledgePiRadarWatch(armed, armed.view.alarms[0].key);
        expect(acked.view.alarms).toHaveLength(0);
        const stopped = await stopPiRadarWatch(acked);
        expect(stopped.view.state).toBe('off');
        expect(stopped.view.context).toBeNull();
    });
    it('validates canonical source/episode/severity keys rather than trusting a card key', async () => {
        const raw = await watch.command(controller, {
            armed: true,
            expected: null,
            expectedOwnerRevision: radarServerOwnerRevision(server),
            prefs: DEFAULT_COLLISION_PREFS,
        });
        expect(await decodePiRadarWatch(raw, T)).not.toBeNull();
        raw.alarms[0].closeQuarters = true;
        expect(await decodePiRadarWatch(raw, T)).toBeNull();
    });
    it('ages earliest original dependencies despite a new response timestamp; cannot show an unknown card clear', async () => {
        const raw = await watch.command(controller, {
            armed: true,
            expected: null,
            expectedOwnerRevision: radarServerOwnerRevision(server),
            prefs: DEFAULT_COLLISION_PREFS,
        });
        raw.servedAt = T + 16000;
        raw.evaluatedAt = T + 16000;
        const view = await decodePiRadarWatch(raw, T + 16000);
        expect(view?.alarms[0]).toMatchObject({
            sourceAt: T,
            unknown: true,
            cpaNm: null,
            tcpaMin: null,
            cleared: null,
        });
        raw.alarms[0].cleared = 'passed';
        expect((await decodePiRadarWatch(raw, T + 16000))?.alarms[0].cleared).toBe('lost');
    });
    it.each(['account', 'pair', 'base', 'caller'] as const)('rejects a response after %s changes', async (change) => {
        let release!: (v: unknown) => void;
        const data = JSON.stringify(await watch.describe());
        f.request.mockReturnValue(
            new Promise((r) => {
                release = r;
            }),
        );
        let live = true;
        const pending = readPiRadarWatch({ isCurrent: () => live });
        await vi.waitFor(() => expect(f.request).toHaveBeenCalled());
        if (change === 'account') f.identity++;
        if (change === 'pair') f.pair = { ...f.pair, pairedAt: 'replacement' };
        if (change === 'base') f.base = 'https://192.0.2.2:3443';
        if (change === 'caller') live = false;
        release({ status: 200, data });
        await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
    });
    it('does not send an arm after intent expires during native header loading', async () => {
        const proof = await readPiRadarWatch();
        f.request.mockImplementation(async (o: { isCurrent: () => boolean }) => {
            await new Promise((r) => setTimeout(r, 7000));
            expect(o.isCurrent()).toBe(false);
            throw Error('late header');
        });
        const pending = armPiRadarWatch(proof, DEFAULT_COLLISION_PREFS).catch((e) => e);
        await vi.advanceTimersByTimeAsync(6001);
        expect(await pending).toMatchObject({ code: 'unavailable' });
        await vi.advanceTimersByTimeAsync(1000);
    });
    it('withholds another owner or selected Pi even on the pinned channel', async () => {
        const raw = await watch.describe();
        for (const owner of [
            { ...raw.owner!, ownerId: '99999999-9999-4999-8999-999999999999' },
            {
                ...raw.owner!,
                piDeviceId: '99999999-9999-4999-8999-999999999999',
                feedId: 'pi:99999999-9999-4999-8999-999999999999:' + 'a'.repeat(24),
            },
        ]) {
            f.request.mockResolvedValue({ status: 200, data: JSON.stringify({ ...raw, owner }) });
            await expect(readPiRadarWatch()).rejects.toMatchObject({ code: 'invalid' });
        }
    });
    it('treats old Pi routes, oversized status and stale owner proof as unavailable rather than success', async () => {
        f.request.mockResolvedValue({ status: 404, data: '{}' });
        await expect(readPiRadarWatch()).rejects.toMatchObject({ code: 'update' });
        f.request.mockResolvedValue({ status: 200, data: ' '.repeat(65537) });
        await expect(readPiRadarWatch()).rejects.toMatchObject({ code: 'invalid' });
        f.request.mockResolvedValue({
            status: 200,
            data: JSON.stringify({ ...(await watch.describe()), servedAt: T - 5001 }),
        });
        await expect(readPiRadarWatch()).rejects.toMatchObject({ code: 'invalid' });
    });
    it('refuses delayed writes using an old reviewed status without issuing POST', async () => {
        const proof = await readPiRadarWatch();
        vi.setSystemTime(T + 5001);
        await expect(armPiRadarWatch(proof, DEFAULT_COLLISION_PREFS)).rejects.toMatchObject({ code: 'conflict' });
        expect(f.request).toHaveBeenCalledTimes(1);
    });
});
