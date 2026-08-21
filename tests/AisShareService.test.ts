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
    __flushForTest,
    __resetAisShareForTest,
    getShareStats,
    isShareEnabled,
    offer,
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

    it('does not bother the network for a trickle', async () => {
        setShareEnabled(true);
        offer(SENTENCE); // below MIN_FLUSH_SENTENCES
        await __flushForTest();
        expect(getShareStats().sharedTotal).toBe(0);
        expect(getShareStats().buffered).toBe(1);
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
