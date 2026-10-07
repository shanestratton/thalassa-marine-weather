/**
 * The Blitzortung socket opens only behind the licence flag.
 *
 * Blitzortung.org's terms (checked 2026-10-07): applications must be freely
 * accessible, must not be used for storm warning, and "have to retrieve their
 * data from a separate server and not from the servers of Blitzortung.org".
 * Thalassa is a subscription app that opened wss://ws*.blitzortung.org
 * straight from the phone and counted strikes into a threat banner — so the
 * feed is OFF by default (Shane's call, build 123) behind ONE build flag,
 * VITE_BLITZORTUNG_ENABLED, which can be flipped back if permission arrives.
 *
 * This is the choke point: with the flag off no code path can open the
 * socket, whoever subscribes.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({
    start: vi.fn(async (_options: { url: string; subscribeMessage: string }) => undefined),
    stop: vi.fn(async () => undefined),
    addListener: vi.fn(async () => ({ remove: vi.fn(async () => undefined) })),
    removeAllListeners: vi.fn(async () => undefined),
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        isNativePlatform: () => true,
        getPlatform: () => 'ios',
        isPluginAvailable: () => true,
    },
    registerPlugin: () => native,
}));

async function freshService() {
    vi.resetModules();
    return import('../services/weather/api/blitzortungLightning');
}

beforeEach(() => {
    vi.unstubAllEnvs();
    native.start.mockClear();
    native.addListener.mockClear();
});

afterEach(() => {
    vi.unstubAllEnvs();
});

describe('Blitzortung licence flag', () => {
    it('is OFF when nothing sets it', async () => {
        const { isBlitzortungEnabled } = await import('../services/weather/api/lightningLicence');
        expect(isBlitzortungEnabled()).toBe(false);
    });

    it.each(['false', '0', '', 'yes'])('stays OFF for %j — only the word true turns it on', async (value) => {
        vi.stubEnv('VITE_BLITZORTUNG_ENABLED', value);
        const { isBlitzortungEnabled } = await import('../services/weather/api/lightningLicence');
        expect(isBlitzortungEnabled()).toBe(false);
    });

    it('turns ON only when the build sets VITE_BLITZORTUNG_ENABLED=true', async () => {
        vi.stubEnv('VITE_BLITZORTUNG_ENABLED', 'true');
        const { isBlitzortungEnabled } = await import('../services/weather/api/lightningLicence');
        expect(isBlitzortungEnabled()).toBe(true);
    });
});

describe('the strike feed', () => {
    it('never opens a socket to Blitzortung while the flag is off, even on a phone with a subscriber', async () => {
        const service = await freshService();
        const unsubscribe = service.subscribeLightningStrikes(() => {});
        await Promise.resolve();
        await Promise.resolve();
        expect(native.addListener).not.toHaveBeenCalled();
        expect(native.start).not.toHaveBeenCalled();
        expect(service.getLightningConnectionStatus()).not.toBe('connecting');
        expect(service.getLightningConnectionStatus()).not.toBe('open');
        unsubscribe();
    });

    it('opens it as before when the flag is flipped back on', async () => {
        vi.stubEnv('VITE_BLITZORTUNG_ENABLED', 'true');
        const service = await freshService();
        const unsubscribe = service.subscribeLightningStrikes(() => {});
        await vi.waitFor(() => expect(native.start).toHaveBeenCalledTimes(1));
        expect(native.start.mock.calls[0][0]).toMatchObject({
            url: expect.stringMatching(/^wss:\/\/ws\d\.blitzortung\.org\/$/),
        });
        unsubscribe();
    });
});
