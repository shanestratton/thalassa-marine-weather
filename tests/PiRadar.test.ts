import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const f = vi.hoisted(() => ({
    request: vi.fn(),
    identity: 1,
    pair: { deviceId: 'pi-generated', publicKeySpki: 'generated-pin', pairedAt: 'generated' },
    base: 'https://192.0.2.1:3443',
    available: true,
}));
vi.mock('../services/authIdentityScope', () => ({
    getAuthIdentityScope: () => ({ generation: f.identity }),
    isAuthIdentityScopeCurrent: (s: { generation: number }) => s.generation === f.identity,
}));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => f.pair, pinnedPiRequest: f.request }));
vi.mock('../services/PiCacheService', () => ({ piCache: { lanBaseUrlNow: () => f.base } }));
vi.mock('../services/piTls', () => ({ isPinnedTransportAvailable: () => f.available }));
import { loadPiRadarPicture } from '../services/radar/piRadar';
import { decodePiRadarPicture } from '../services/radar/radarWire';
import { RadarFeed } from '../utils/radarFeed';
const T = Date.UTC(2026, 0, 2, 12),
    id = 'pi:' + 'a'.repeat(32);
const frame = (body: string) =>
    `$${body}*${[...body]
        .reduce((v, c) => v ^ c.charCodeAt(0), 0)
        .toString(16)
        .padStart(2, '0')}`;
function packet() {
    const feed = new RadarFeed(id);
    feed.ingest(frame('RATLL,1,5030.000,N,00115.000,W,Generated,120000,T,'), T, T);
    return {
        schema: 1,
        source: 'radar',
        configured: true,
        connected: true,
        overloaded: false,
        feedId: id,
        servedAt: T,
        lastFrameAt: T,
        lastTargetAt: T,
        ownship: feed.ownshipSnapshot(),
        observations: feed.evidence(T),
    };
}
beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T);
    f.identity = 1;
    f.pair = { deviceId: 'pi-generated', publicKeySpki: 'generated-pin', pairedAt: 'generated' };
    f.base = 'https://192.0.2.1:3443';
    f.available = true;
    f.request.mockReset();
});
afterEach(() => vi.useRealTimers());
describe('private bounded Pi radar reader', () => {
    it('requalifies original observations and binds the returned RAM picture to the current pair/account', async () => {
        f.request.mockResolvedValue({ status: 200, data: JSON.stringify(packet()) });
        const result = await loadPiRadarPicture();
        expect(result.contacts[0]).toMatchObject({ at: T, receivedAt: T, source: 'radar', motion: null });
        expect(f.request).toHaveBeenCalledWith(
            expect.objectContaining({ url: f.base + '/api/radar/targets', responseType: 'text' }),
        );
        expect(result.isCurrent()).toBe(true);
        f.pair = { ...f.pair, pairedAt: 'replacement' };
        expect(result.isCurrent()).toBe(false);
    });
    it.each(['account', 'pin', 'device', 'base', 'pairing', 'caller'] as const)(
        'discards a late response after %s changes',
        async (change) => {
            let resolve!: (v: unknown) => void;
            f.request.mockReturnValue(
                new Promise((r) => {
                    resolve = r;
                }),
            );
            let current = true;
            const pending = loadPiRadarPicture({ isCurrent: () => current });
            if (change === 'account') f.identity++;
            if (change === 'pin') f.pair = { ...f.pair, publicKeySpki: 'other' };
            if (change === 'device') f.pair = { ...f.pair, deviceId: 'other' };
            if (change === 'base') f.base = 'https://192.0.2.2:3443';
            if (change === 'pairing') f.pair = { ...f.pair, pairedAt: 'other' };
            if (change === 'caller') current = false;
            resolve({ status: 200, data: JSON.stringify(packet()) });
            await expect(pending).rejects.toMatchObject({ code: 'cancelled' });
        },
    );
    it('cancels immediately and imposes a five-second whole-request deadline', async () => {
        f.request.mockReturnValue(new Promise(() => {}));
        const abort = new AbortController();
        const first = loadPiRadarPicture({ signal: abort.signal });
        abort.abort();
        await expect(first).rejects.toMatchObject({ code: 'cancelled' });
        const second = loadPiRadarPicture();
        const proof = expect(second).rejects.toMatchObject({ code: 'unavailable' });
        await vi.advanceTimersByTimeAsync(5000);
        await proof;
    });
    it('never falls back to WAN or interprets missing/oversized replies as an empty clear picture', async () => {
        f.available = false;
        await expect(loadPiRadarPicture()).rejects.toMatchObject({ code: 'unavailable' });
        expect(f.request).not.toHaveBeenCalled();
        f.available = true;
        f.request.mockResolvedValueOnce({ status: 404, data: '{}' });
        await expect(loadPiRadarPicture()).rejects.toMatchObject({ code: 'update' });
        f.request.mockResolvedValueOnce({ status: 200, data: 'x'.repeat(524289) });
        await expect(loadPiRadarPicture()).rejects.toMatchObject({ code: 'invalid' });
    });
    it('rejects wrong source, duplicate observations, excess targets, spoofed qualification and stale/future envelopes', () => {
        const p = packet();
        expect(decodePiRadarPicture(p, T)?.contacts).toHaveLength(1);
        for (const patch of [
            { source: 'ais' },
            { feedId: 'radar:mmsi:123' },
            { servedAt: T + 1001 },
            { servedAt: T - 15001 },
            { observations: [...p.observations, ...p.observations] },
            { observations: Array(401).fill(p.observations[0]) },
            { observations: [{ ...p.observations[0], sentence: 'bad', qualified: true }] },
        ])
            expect(decodePiRadarPicture({ ...p, ...patch }, T)).toBeNull();
        const old = decodePiRadarPicture({ ...p, servedAt: T + 16000 }, T + 16000)!;
        expect(old.contacts[0].fresh).toBe(false);
        expect(old.contacts[0].at).toBe(T);
    });
});
