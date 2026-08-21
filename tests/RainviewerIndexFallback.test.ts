/**
 * The Pi is an optimisation, never a single point of failure.
 *
 * fetchRainviewerIndex routes through the Pi cache when piCache.isAvailable()
 * says the boat network is up — but that reflects the LAST health probe. A Pi
 * that answered once and then went out of range, or a host left pointing at a
 * bench address, sent this fetch somewhere unreachable and the null return
 * reads downstream as "no frames": the rain scrubber shows "No Data" with a
 * perfectly healthy RainViewer API one hop away (Shane, 2026-08-21).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const pi = vi.hoisted(() => ({ url: null as string | null }));

vi.mock('../services/PiCacheService', () => ({
    piCache: { passthroughUrl: () => pi.url },
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const INDEX = { version: '2.0', generated: 1, host: 'https://tilecache.rainviewer.com', radar: { past: [{ path: '/v2/radar/x', time: 1 }] } };

async function freshModule() {
    vi.resetModules();
    return await import('../services/weather/api/rainviewerIndex');
}

beforeEach(() => {
    pi.url = null;
});

afterEach(() => {
    vi.unstubAllGlobals();
});

describe('fetchRainviewerIndex', () => {
    it('uses the Pi lane when it is working', async () => {
        pi.url = 'http://pi.local/api/passthrough?url=x';
        const calls: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (u: string) => {
            calls.push(String(u));
            return { ok: true, json: async () => INDEX } as unknown as Response;
        }));
        const { fetchRainviewerIndex } = await freshModule();
        const data = await fetchRainviewerIndex();
        expect(data?.radar.past).toHaveLength(1);
        expect(calls).toHaveLength(1);
        expect(calls[0]).toContain('pi.local');
    });

    it('falls back to RainViewer directly when the Pi lane fails', async () => {
        pi.url = 'http://pi.local/api/passthrough?url=x';
        const calls: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (u: string) => {
            calls.push(String(u));
            if (String(u).includes('pi.local')) return { ok: false, status: 502 } as unknown as Response;
            return { ok: true, json: async () => INDEX } as unknown as Response;
        }));
        const { fetchRainviewerIndex } = await freshModule();
        const data = await fetchRainviewerIndex();
        // The whole point: radar frames survive a dead Pi.
        expect(data?.radar.past).toHaveLength(1);
        expect(calls).toHaveLength(2);
        expect(calls[1]).toContain('api.rainviewer.com');
    });

    it('does not double-fetch when there is no Pi to fail', async () => {
        pi.url = null;
        const calls: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (u: string) => {
            calls.push(String(u));
            return { ok: false, status: 500 } as unknown as Response;
        }));
        const { fetchRainviewerIndex } = await freshModule();
        expect(await fetchRainviewerIndex()).toBeNull();
        expect(calls).toHaveLength(1);
    });

    // ── The failure that actually strands a boat ──────────────────────
    // An unreachable host does not answer with a status — it REJECTS. The
    // first cut of this fallback only re-tried on a resolved-but-bad
    // response, and utils/deadline.ts propagates rejections by design, so
    // the throw went straight past the retry to the outer catch and
    // returned null with RainViewer working one hop away. Shane still had
    // "No Radar" after that fix shipped, which is what sent us back here.
    it('falls through to direct when the Pi lane THROWS, not just when it answers badly', async () => {
        pi.url = 'http://pi.local/api/passthrough?url=x';
        const calls: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (u: string) => {
            calls.push(String(u));
            if (String(u).includes('pi.local')) throw new TypeError('Load failed');
            return { ok: true, json: async () => INDEX } as unknown as Response;
        }));
        const { fetchRainviewerIndex } = await freshModule();
        const data = await fetchRainviewerIndex();
        expect(data?.radar.past).toHaveLength(1);
        expect(calls).toHaveLength(2);
        expect(calls[1]).toContain('api.rainviewer.com');
    });

    // The Pi answers 200 from its own JSON cache, so a poisoned or stale
    // entry — or its {error} envelope — arrives as a valid 200 document
    // with no frames. Treating that as success pins us to the bad lane and
    // skips the direct retry: healthy-looking, paints nothing.
    it('rejects a 200 that carries no radar frames and tries direct', async () => {
        pi.url = 'http://pi.local/api/passthrough?url=x';
        const calls: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (u: string) => {
            calls.push(String(u));
            if (String(u).includes('pi.local')) {
                return { ok: true, json: async () => ({ error: 'Passthrough failed' }) } as unknown as Response;
            }
            return { ok: true, json: async () => INDEX } as unknown as Response;
        }));
        const { fetchRainviewerIndex } = await freshModule();
        const data = await fetchRainviewerIndex();
        expect(data?.radar.past).toHaveLength(1);
        expect(calls).toHaveLength(2);
    });

    it('treats an empty past array as unusable rather than caching it', async () => {
        pi.url = null;
        vi.stubGlobal('fetch', vi.fn(async () => ({
            ok: true,
            json: async () => ({ ...INDEX, radar: { past: [] } }),
        }) as unknown as Response));
        const { fetchRainviewerIndex } = await freshModule();
        // Zero frames is the same as no answer — and it must NOT be memoised,
        // or a single bad pass blanks the radar for the next five minutes.
        expect(await fetchRainviewerIndex()).toBeNull();
    });

    it('returns null when both lanes are down', async () => {
        pi.url = 'http://pi.local/api/passthrough?url=x';
        const calls: string[] = [];
        vi.stubGlobal('fetch', vi.fn(async (u: string) => {
            calls.push(String(u));
            throw new TypeError('Load failed');
        }));
        const { fetchRainviewerIndex } = await freshModule();
        expect(await fetchRainviewerIndex()).toBeNull();
        // Tried both before giving up — no lane silently skipped.
        expect(calls).toHaveLength(2);
    });

    it('does not leave a rejected fetch wedged as the inflight promise', async () => {
        pi.url = null;
        let attempt = 0;
        vi.stubGlobal('fetch', vi.fn(async () => {
            attempt++;
            if (attempt === 1) throw new TypeError('Load failed');
            return { ok: true, json: async () => INDEX } as unknown as Response;
        }));
        const { fetchRainviewerIndex } = await freshModule();
        expect(await fetchRainviewerIndex()).toBeNull();
        // A failed pass must not poison the next one — this is what makes
        // the "Tap to retry" button and the 60s self-heal able to recover.
        expect((await fetchRainviewerIndex())?.radar.past).toHaveLength(1);
    });
});
