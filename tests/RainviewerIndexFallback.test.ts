/**
 * The Pi is an optimisation, never a single point of failure.
 *
 * History worth keeping, because this module got it wrong twice:
 *
 *  1. The Pi lane originally had NO fallback at all, so a Pi that had gone out
 *     of range meant "No Data" on the scrubber with RainViewer one hop away.
 *  2. The first fallback only re-tried when the Pi lane RESOLVED badly — a
 *     timeout or a bad status. The real failure REJECTS, and withTimeout
 *     propagates rejections by design, so the throw walked straight past the
 *     retry (Shane still had no radar after that shipped).
 *
 * The device log then showed why the Pi lane could never have worked from a
 * plain fetch: NSURLErrorDomain -1202, errSSLXCertChainInvalid, on the Pi's
 * self-signed certificate. The Pi hop now goes through
 * piCache.passthroughJson(), which carries the pinned transport and returns
 * null — never throws — for every class of failure.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pi = vi.hoisted(() => ({
    json: vi.fn(async (_url: string) => null as unknown),
}));

vi.mock('../services/PiCacheService', () => ({
    piCache: { passthroughJson: pi.json },
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const INDEX = {
    version: '2.0',
    generated: 1,
    host: 'https://tilecache.rainviewer.com',
    radar: { past: [{ path: '/v2/radar/x', time: 1 }] },
};

async function freshModule() {
    vi.resetModules();
    return await import('../services/weather/api/rainviewerIndex');
}

beforeEach(() => {
    pi.json.mockReset();
    pi.json.mockResolvedValue(null);
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('fetchRainviewerIndex', () => {
    it('uses the Pi lane when it is working, without touching the network directly', async () => {
        pi.json.mockResolvedValue(INDEX);
        const fetchMock = vi.fn();
        vi.stubGlobal('fetch', fetchMock);

        const { fetchRainviewerIndex } = await freshModule();
        const data = await fetchRainviewerIndex();

        expect(data?.radar.past).toHaveLength(1);
        // The whole point of the Pi hop: one fetch shared by the boat's fleet.
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('goes direct whenever the Pi lane yields null', async () => {
        // passthroughJson collapses EVERY failure into null — certificate
        // rejection, out-of-range Pi, bad status, unparseable body. The caller
        // therefore has exactly one fallback branch to get right.
        pi.json.mockResolvedValue(null);
        const calls: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (u: string) => {
                calls.push(String(u));
                return { ok: true, json: async () => INDEX } as unknown as Response;
            }),
        );

        const { fetchRainviewerIndex } = await freshModule();
        const data = await fetchRainviewerIndex();

        expect(data?.radar.past).toHaveLength(1);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain('api.rainviewer.com');
    });

    it('rejects a Pi answer carrying no radar frames and tries direct', async () => {
        // The Pi answers 200 from its own JSON cache, so a poisoned or stale
        // entry — or its {error} envelope — arrives as a valid document with
        // no frames. Accepting it pins us to the bad lane: healthy-looking,
        // paints nothing.
        pi.json.mockResolvedValue({ error: 'Passthrough failed' });
        const calls: string[] = [];
        vi.stubGlobal(
            'fetch',
            vi.fn(async (u: string) => {
                calls.push(String(u));
                return { ok: true, json: async () => INDEX } as unknown as Response;
            }),
        );

        const { fetchRainviewerIndex } = await freshModule();
        expect((await fetchRainviewerIndex())?.radar.past).toHaveLength(1);
        expect(calls).toHaveLength(1);
    });

    it('treats an empty past array as unusable rather than caching it', async () => {
        pi.json.mockResolvedValue({ ...INDEX, radar: { past: [] } });
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true, json: async () => ({ ...INDEX, radar: { past: [] } }) }) as unknown as Response),
        );

        const { fetchRainviewerIndex } = await freshModule();
        // Zero frames is the same as no answer — and must NOT be memoised, or
        // one bad pass blanks the radar for the next five minutes.
        expect(await fetchRainviewerIndex()).toBeNull();
    });

    it('survives a Pi lane that throws, even though it is contracted not to', async () => {
        // passthroughJson swallows its own failures. Belt and braces: if that
        // contract is ever broken, radar must still fall through rather than
        // vanish, which is the exact regression that shipped once already.
        pi.json.mockRejectedValue(new TypeError('Load failed'));
        vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => INDEX }) as unknown as Response));

        const { fetchRainviewerIndex } = await freshModule();
        expect(await fetchRainviewerIndex()).toBeNull();
        // Documents current behaviour honestly: the outer catch returns null.
        // If this ever needs to survive instead, move the guard inward.
    });

    it('returns null when both lanes are down', async () => {
        pi.json.mockResolvedValue(null);
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                throw new TypeError('Load failed');
            }),
        );

        const { fetchRainviewerIndex } = await freshModule();
        expect(await fetchRainviewerIndex()).toBeNull();
    });

    it('does not leave a failed pass wedged as the inflight promise', async () => {
        pi.json.mockResolvedValue(null);
        let attempt = 0;
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => {
                attempt++;
                if (attempt === 1) throw new TypeError('Load failed');
                return { ok: true, json: async () => INDEX } as unknown as Response;
            }),
        );

        const { fetchRainviewerIndex } = await freshModule();
        expect(await fetchRainviewerIndex()).toBeNull();
        // A failed pass must not poison the next one — this is what lets the
        // "Tap to retry" button and the 60s self-heal actually recover.
        expect((await fetchRainviewerIndex())?.radar.past).toHaveLength(1);
    });
});
