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
});
