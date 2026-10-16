import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
    request: vi.fn(),
    base: 'https://boat.local:8443',
    native: true,
    pairing: { publicKeySpki: 'synthetic-pin', deviceId: 'synthetic-boat', pairedAt: '2026-01-01' },
}));
vi.mock('../services/PiPairingService', () => ({ getPairing: () => mocks.pairing, pinnedPiRequest: mocks.request }));
vi.mock('../services/PiCacheService', () => ({ piCache: { lanBaseUrlNow: () => mocks.base } }));
vi.mock('../services/piTls', () => ({ isPinnedTransportAvailable: () => mocks.native }));
import { loadPiTrackHistory } from '../services/piTrackHistory';
import { setAuthIdentityScope } from '../services/authIdentityScope';

const from = Date.parse('2026-01-01T00:00:00Z'),
    to = from + 86_400_000;
const point = (sample_id: number, at_ms = from, over = {}) => ({
    sample_id,
    at_ms,
    lat: 0,
    lon: 179.9,
    reason: 'first',
    sog_kts: 0,
    tws_kts: null,
    pressure_hpa: null,
    ...over,
});
function page(points: unknown[], truncated = false, snapshot = 5, nextCursor: string | null = null, over = {}) {
    return {
        status: 200,
        data: JSON.stringify({ page: 1, from, to, snapshot, points, truncated, nextCursor, ...over }),
    };
}
beforeEach(() => {
    mocks.request.mockReset();
    mocks.base = 'https://boat.local:8443';
    mocks.native = true;
    mocks.pairing = { publicKeySpki: 'synthetic-pin', deviceId: 'synthetic-boat', pairedAt: '2026-01-01' };
    setAuthIdentityScope('synthetic-track-owner');
});

describe('bounded private Pi track history', () => {
    it('retains duplicate timestamps across composite pages and missing sensors without forecast fill', async () => {
        mocks.request
            .mockResolvedValueOnce(page([point(1), point(2)], true, 5, `${from}:2:5`))
            .mockResolvedValueOnce(page([point(3), point(4, from + 1000)]));
        const result = await loadPiTrackHistory({ from, to });
        expect(result.points.map((row) => row.sample_id)).toEqual([1, 2, 3, 4]);
        expect(result.truncated).toBe(false);
        expect(result.points[0]).toMatchObject({
            lat: 0,
            sog_kts: 0,
            tws_kts: null,
            pressure_hpa: null,
            heading_true_deg: null,
        });
        const second = new URL(mocks.request.mock.calls[1][0].url);
        expect(second.searchParams.get('cursor')).toBe(`${from}:2:5`);
        expect(second.origin).toBe('https://boat.local:8443');
        expect(mocks.request.mock.calls.every(([request]) => request.responseType === 'text')).toBe(true);
    });
    it('bounds a caller at 500 rows and resumes without losing the remaining same-time fix', async () => {
        const rows = Array.from({ length: 500 }, (_, index) => point(index + 1));
        mocks.request.mockResolvedValueOnce(page(rows, true, 501, `${from}:500:501`));
        const first = await loadPiTrackHistory({ from, to, maxPoints: 500, maxPages: 1 });
        expect(first.points).toHaveLength(500);
        expect(first.truncated).toBe(true);
        mocks.request.mockResolvedValueOnce(page([point(501)], false, 501));
        const second = await loadPiTrackHistory({ from, to, cursor: first.nextCursor! });
        expect(second.points.map((row) => row.sample_id)).toEqual([501]);
        expect(second.truncated).toBe(false);
    });
    it.each([true, false])('requires Pi update for a legacy response, truncated=%s', async (truncated) => {
        mocks.request.mockResolvedValue({
            status: 200,
            data: JSON.stringify({ from, to, points: [point(1)], truncated }),
        });
        await expect(loadPiTrackHistory({ from, to })).rejects.toMatchObject({ code: 'update' });
    });
    it('keeps optional source clocks distinct from logging time and legacy heading', async () => {
        mocks.request.mockResolvedValue(
            page([
                point(1, from, {
                    hdg_deg: 42,
                    sog_at_ms: from - 3000,
                    heading_true_deg: null,
                    engine_rpm_at_ms: from - 5000,
                    leeway_source: 'sensor',
                }),
            ]),
        );
        const result = await loadPiTrackHistory({ from, to });
        expect(result.points[0]).toMatchObject({
            sog_at_ms: from - 3000,
            hdg_deg: 42,
            heading_true_deg: null,
            engine_rpm_at_ms: from - 5000,
            stw_at_ms: null,
        });
    });
    it.each([
        page([point(1)], true, 5, `${from}:0:5`),
        page([point(1), point(1)]),
        page([point(3), point(2)]),
        page([point(1)], false, 5, `${from}:1:5`),
        page([], true, 5, `${from}:1:5`),
        page([point(1, from - 1)]),
        page([point(6)]),
        page([point(1, from, { lat: 91 })]),
        page([point(1, from, { sog_kts: '5' })]),
        page([point(1)], false, 5, null, { to: to + 1 }),
    ])('rejects malformed page/cursor/order without silently dropping rows', async (response) => {
        mocks.request.mockResolvedValue(response);
        await expect(loadPiTrackHistory({ from, to })).rejects.toMatchObject({ code: 'invalid' });
    });
    it('rejects a changed snapshot midway', async () => {
        mocks.request
            .mockResolvedValueOnce(page([point(1)], true, 5, `${from}:1:5`))
            .mockResolvedValueOnce(page([point(2)], false, 6));
        await expect(loadPiTrackHistory({ from, to })).rejects.toMatchObject({ code: 'invalid' });
    });
    it('does not issue a request without the verified native private lane', async () => {
        mocks.native = false;
        await expect(loadPiTrackHistory({ from, to })).rejects.toMatchObject({ code: 'unavailable' });
        expect(mocks.request).not.toHaveBeenCalled();
    });
    it.each(['account', 'pin', 'device', 'base', 'generation'])('discards an in-flight %s change', async (change) => {
        mocks.request.mockImplementation(async () => {
            if (change === 'account') setAuthIdentityScope('another-synthetic-owner');
            if (change === 'pin') mocks.pairing.publicKeySpki = 'another-synthetic-pin';
            if (change === 'device') mocks.pairing.deviceId = 'another-synthetic-boat';
            if (change === 'base') mocks.base = 'https://another-boat.local:8443';
            if (change === 'generation') {
                setAuthIdentityScope('another-owner');
                setAuthIdentityScope('synthetic-track-owner');
            }
            return page([point(1)]);
        });
        await expect(loadPiTrackHistory({ from, to })).rejects.toMatchObject({ code: 'cancelled' });
        expect(mocks.request).toHaveBeenCalledTimes(1);
    });
    it('aborts immediately while the bridge is pending and never starts another page', async () => {
        const controller = new AbortController();
        let finish!: (value: ReturnType<typeof page>) => void;
        mocks.request.mockImplementation(
            () =>
                new Promise((resolve) => {
                    finish = resolve;
                }),
        );
        const result = loadPiTrackHistory({ from, to, signal: controller.signal });
        controller.abort();
        await expect(result).rejects.toMatchObject({ code: 'cancelled' });
        finish(page([point(1)], true, 5, `${from}:1:5`));
        await Promise.resolve();
        expect(mocks.request).toHaveBeenCalledTimes(1);
    });
    it('rejects oversized UTF-8 pages before JSON parsing', async () => {
        mocks.request.mockResolvedValue({ status: 200, data: '\u6d77'.repeat(400_000) });
        await expect(loadPiTrackHistory({ from, to })).rejects.toMatchObject({ code: 'invalid' });
    });
    it('returns an explicit resumable partial when the byte budget is reached', async () => {
        let id = 0;
        mocks.request.mockImplementation(async () => {
            id++;
            return page([point(id)], true, 100, `${from}:${id}:100`, { padding: 'x'.repeat(950_000) });
        });
        const result = await loadPiTrackHistory({ from, to });
        expect(result.truncated).toBe(true);
        expect(result.points.map((row) => row.sample_id)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
        expect(result.nextCursor).toBe(`${from}:8:100`);
        expect(mocks.request).toHaveBeenCalledTimes(9);
    });
    it('returns an explicit partial on the whole deadline without consuming unreturned rows', async () => {
        const time = vi.spyOn(performance, 'now');
        let now = 0;
        time.mockImplementation(() => now);
        mocks.request
            .mockResolvedValueOnce(page([point(1)], true, 5, `${from}:1:5`))
            .mockImplementationOnce(async () => {
                now += 20_001;
                return page([point(2)]);
            });
        try {
            const result = await loadPiTrackHistory({ from, to });
            expect(result.truncated).toBe(true);
            expect(result.points).toHaveLength(1);
            expect(result.nextCursor).toBe(`${from}:1:5`);
        } finally {
            time.mockRestore();
        }
    });
});
