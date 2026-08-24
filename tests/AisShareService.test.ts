/**
 * The crowd-feed's app half: consent, hot-path cost, batching, and the
 * deliberate lossiness. The one behaviour that must never regress: with the
 * toggle off (the default), offer() does nothing observable.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
    headers: vi.fn(async () => ({ Authorization: 'Bearer tok', apikey: 'anon', 'Content-Type': 'application/json' })),
}));

vi.mock('../services/supabaseAuth', () => ({
    getAuthenticatedFunctionHeaders: auth.headers,
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => false },
    CapacitorHttp: { post: vi.fn() },
}));

import {
    __bankConnectedForTest,
    __flushForTest,
    __markCheckedInForTest,
    __resetAisShareForTest,
    __resetWatchClockForTest,
    getShareStats,
    isShareEnabled,
    offer,
    reportLink,
    setLowDataLink,
    setShareEnabled,
} from '../services/AisShareService';

const SENTENCE = '!AIVDM,1,1,,B,17Ojo>0011btinahKV54lSqp0000,0*6D';

beforeEach(() => {
    __resetAisShareForTest();
    localStorage.clear();
    vi.stubEnv('VITE_FLEET_FEED_URL', 'https://relay.example/fleet-feed');
    vi.stubGlobal(
        'fetch',
        vi.fn(async () => ({ ok: true })),
    );
});

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
});

describe('consent', () => {
    it('is off by default — sharing is an explicit choice', () => {
        expect(isShareEnabled()).toBe(false);
        for (let i = 0; i < 10; i++) offer(SENTENCE);
        expect(getShareStats().buffered).toBe(0);
    });

    it('never inherits the retired AisHubService opt-in', () => {
        localStorage.setItem('aishub_enabled', 'true'); // the OLD feature's key
        expect(isShareEnabled()).toBe(false);
    });

    it('turning it off clears the buffer immediately', () => {
        setShareEnabled(true);
        for (let i = 0; i < 10; i++) offer(SENTENCE);
        expect(getShareStats().buffered).toBe(10);
        setShareEnabled(false);
        expect(getShareStats().buffered).toBe(0);
    });
});

describe('buffering and flushing', () => {
    it('flushes a batch with the user token and counts what shipped', async () => {
        setShareEnabled(true);
        for (let i = 0; i < 8; i++) offer(SENTENCE);
        await __flushForTest();
        expect(auth.headers).toHaveBeenCalled();
        const stats = getShareStats();
        expect(stats.sharedTotal).toBe(8);
        expect(stats.buffered).toBe(0);
        expect(stats.lastFlushOk).toBe(true);
    });

    it('does not bother the network for a trickle BETWEEN check-ins', async () => {
        // The old contract was "a trickle never goes out". That is no longer
        // quite true, and the difference is the whole point of the redesign:
        // a trickle waits for the watch tick, then rides along with it. What
        // survives is the cost control — a handful of sentences does not buy
        // its own request.
        setShareEnabled(true);
        __markCheckedInForTest();
        offer(SENTENCE); // below MIN_FLUSH_SENTENCES
        await __flushForTest();
        expect(getShareStats().sharedTotal).toBe(0);
        expect(getShareStats().buffered).toBe(1);
    });

    it('ships the trickle when the watch comes due', async () => {
        setShareEnabled(true);
        __markCheckedInForTest();
        offer(SENTENCE);
        await __flushForTest();
        expect(getShareStats().buffered).toBe(1); // held
        __resetWatchClockForTest(); // 5 minutes later
        await __flushForTest();
        expect(getShareStats().sharedTotal).toBe(1);
        expect(getShareStats().buffered).toBe(0);
    });

    it('is LOSSY on failure — drops the batch, keeps fresh data flowing', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: false })),
        );
        setShareEnabled(true);
        for (let i = 0; i < 8; i++) offer(SENTENCE);
        await __flushForTest();
        const stats = getShareStats();
        expect(stats.sharedTotal).toBe(0);
        expect(stats.droppedTotal).toBe(8);
        expect(stats.buffered).toBe(0); // gone, not queued
        expect(stats.lastFlushOk).toBe(false);
    });

    it('drops from the FRONT when the ring fills — newest sentences win', () => {
        setShareEnabled(true);
        for (let i = 0; i < 2100; i++) offer(`${SENTENCE}#${i}` as string);
        const stats = getShareStats();
        expect(stats.buffered).toBe(2000);
        expect(stats.droppedTotal).toBe(100);
    });

    it('a signed-out flush drops quietly — telemetry never demands sign-in', async () => {
        auth.headers.mockRejectedValueOnce(new Error('Sign in to use this online service'));
        setShareEnabled(true);
        for (let i = 0; i < 8; i++) offer(SENTENCE);
        await __flushForTest();
        expect(getShareStats().droppedTotal).toBe(8);
        expect(getShareStats().lastFlushOk).toBe(false);
    });
});

describe('unconfigured build', () => {
    it('is fully inert without VITE_FLEET_FEED_URL', () => {
        vi.stubEnv('VITE_FLEET_FEED_URL', '');
        setShareEnabled(true);
        offer(SENTENCE);
        expect(getShareStats().buffered).toBe(0);
    });
});

/**
 * THE EMPTY BAY — the reason this service was rebuilt.
 *
 * Until 2026-08-23 the only path to the network was a buffer holding five or
 * more sentences, checked before the URL, before auth, before anything. A boat
 * anchored off Osprey Reef with a working receiver and no ships within 200
 * miles never crossed that floor, so it made ZERO requests, forever — and on
 * the wire it was indistinguishable from someone who turned sharing on and
 * unplugged the aerial. The most valuable contributor in the fleet looked
 * exactly like the worst freeloader.
 */
describe('the watch check-in', () => {
    const headersOf = (call: unknown): Record<string, string> =>
        (call as [string, { headers: Record<string, string> }])[1].headers ?? {};

    it('checks in with an EMPTY buffer and nothing heard', async () => {
        setShareEnabled(true);
        reportLink('connected');
        __bankConnectedForTest(300_000);
        await __flushForTest();

        const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[] } };
        expect(fetchMock.mock.calls).toHaveLength(1);
        const h = headersOf(fetchMock.mock.calls[0]);
        expect(h['X-Thalassa-Watch']).toBe('1');
        expect(h['X-Thalassa-Connected']).toBe('300');
        expect(h['X-Thalassa-Link']).toBe('connected');
        expect(h['X-Thalassa-Heard']).toBe('0');
    });

    it('checks in even when the gateway is DOWN', async () => {
        // The fault the ledger most needs to hear about must not be the fault
        // that silences the report. Gating the check-in on a live connection
        // was the obvious design and it is exactly wrong.
        setShareEnabled(true);
        reportLink('down', 'ECONNREFUSED 192.168.1.50:2000');
        await __flushForTest();

        const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[] } };
        expect(fetchMock.mock.calls).toHaveLength(1);
        const h = headersOf(fetchMock.mock.calls[0]);
        expect(h['X-Thalassa-Link']).toBe('down');
        expect(h['X-Thalassa-Connected']).toBe('0');
        expect(h['X-Thalassa-Link-Err']).toBe('ECONNREFUSED 192.168.1.50:2000');
    });

    it('banks connected time across a link that flaps', async () => {
        // Credit follows time the link was actually up, not whatever state the
        // timer happened to catch.
        setShareEnabled(true);
        reportLink('connected');
        __bankConnectedForTest(120_000);
        reportLink('down', 'socket closed');
        __bankConnectedForTest(60_000);
        await __flushForTest();
        const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[] } };
        expect(headersOf(fetchMock.mock.calls[0])['X-Thalassa-Connected']).toBe('180');
    });

    it('does not rebase the credit clock on a FAILED check-in', async () => {
        // Sentences are lossy by design; the watch is not. A failed post must
        // not quietly consume connected time the ledger never heard about.
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: false })),
        );
        setShareEnabled(true);
        reportLink('connected');
        __bankConnectedForTest(300_000);
        await __flushForTest();
        expect(getShareStats().lastFlushOk).toBe(false);

        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({ ok: true })),
        );
        __resetWatchClockForTest();
        await __flushForTest();
        const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[] } };
        // Still claiming the full 300 s — nothing was lost to the failure.
        expect(headersOf(fetchMock.mock.calls[0])['X-Thalassa-Connected']).toBe('300');
    });

    it('records the standing the server sends back so the card survives a relaunch', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => ({
                ok: true,
                json: async () => ({
                    accepted: 0,
                    decoded: 0,
                    rejected: { tooLong: 0, notAis: 3, checksum: 1 },
                    watch: { ok: true, standing: 'on_watch', watchMinutes: 412, watchMinutes7d: 96 },
                }),
            })),
        );
        setShareEnabled(true);
        reportLink('connected');
        await __flushForTest();
        const stats = getShareStats();
        expect(stats.card?.watchMinutes).toBe(412);
        expect(stats.card?.standing).toBe('on_watch');
        // ...and the rejection reasons, so the UI can name the fault.
        expect(stats.rejected).toEqual({ tooLong: 0, notAis: 3, checksum: 1 });
    });

    it('survives a reply with no JSON body at all', async () => {
        // A proxy, an old worker, or a 204 must never cost a batch. An earlier
        // draft awaited res.json() unguarded and threw straight into the
        // failure path.
        setShareEnabled(true);
        for (let i = 0; i < 8; i++) offer(SENTENCE);
        await __flushForTest();
        expect(getShareStats().lastFlushOk).toBe(true);
        expect(getShareStats().sharedTotal).toBe(8);
    });

    it('earns the same on a low-data link, it just knocks less', async () => {
        // Credit is bounded by connected seconds and wall clock, never by
        // request count, so a satellite skipper is not penalised for thrift.
        setShareEnabled(true);
        setLowDataLink(true);
        __markCheckedInForTest();
        for (let i = 0; i < 50; i++) offer(SENTENCE);
        await __flushForTest();
        // A loud bay does NOT buy its own request on low-data.
        expect(getShareStats().sharedTotal).toBe(0);

        __resetWatchClockForTest();
        reportLink('connected');
        __bankConnectedForTest(1_800_000);
        await __flushForTest();
        const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[] } };
        expect(headersOf(fetchMock.mock.calls[0])['X-Thalassa-Connected']).toBe('1800');
        expect(getShareStats().sharedTotal).toBe(50);
    });

    it('posts a revoke event when consent is withdrawn', async () => {
        setShareEnabled(true);
        reportLink('connected');
        await __flushForTest();
        const before = (globalThis.fetch as unknown as { mock: { calls: unknown[] } }).mock.calls.length;

        setShareEnabled(false);
        await Promise.resolve();
        await new Promise((r) => setTimeout(r, 0));

        const fetchMock = globalThis.fetch as unknown as { mock: { calls: unknown[] } };
        expect(fetchMock.mock.calls.length).toBeGreaterThan(before);
        const h = headersOf(fetchMock.mock.calls[fetchMock.mock.calls.length - 1]);
        expect(h['X-Thalassa-Revoke']).toBe('1');
    });
});
