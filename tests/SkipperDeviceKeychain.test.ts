/**
 * The device id survives a reinstall on iOS (build 125, 125-12).
 *
 * It lived only in localStorage ("dies with the app's storage"), so a
 * reinstall or a cleared webview minted a new id and the OLD install's claim
 * went on naming a device that no longer existed — the dead "iPhone/iPad ·
 * 7e1a" Shane met at the marina. On iOS the id now lives in the Keychain
 * (this device only, never synchronised); localStorage stays the web and
 * fallback copy, and an existing id migrates in on first run so today's
 * holder keeps its claim.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const keychain = vi.hoisted(() => ({
    value: null as string | null,
    failRead: false,
    failWrite: false,
    reads: 0,
    writes: [] as string[],
}));

vi.mock('@capacitor/core', async () => {
    const actual = await vi.importActual<typeof import('@capacitor/core')>('@capacitor/core');
    return { ...actual, Capacitor: { ...actual.Capacitor, getPlatform: () => 'ios', isNativePlatform: () => true } };
});

vi.mock('../services/anchorWatchRecoveryStorage', () => ({
    readNativeDeviceIdentity: vi.fn(async () => {
        keychain.reads += 1;
        if (keychain.failRead) throw new Error('Keychain locked');
        return keychain.value;
    }),
    writeNativeDeviceIdentity: vi.fn(async (value: string) => {
        if (keychain.failWrite) throw new Error('Keychain write refused');
        keychain.writes.push(value);
        keychain.value = value;
    }),
}));

type SkipperModule = typeof import('../services/skipperDevice');

/** A cold launch: module state gone, localStorage whatever the install kept. */
async function launch(): Promise<SkipperModule> {
    vi.resetModules();
    return import('../services/skipperDevice');
}

const realUserAgent = navigator.userAgent;
function setUserAgent(userAgent: string, maxTouchPoints = 0) {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: userAgent });
    Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: maxTouchPoints });
}

beforeEach(() => {
    localStorage.clear();
    keychain.value = null;
    keychain.failRead = false;
    keychain.failWrite = false;
    keychain.reads = 0;
    keychain.writes.length = 0;
});

afterEach(() => {
    setUserAgent(realUserAgent, 0);
});

describe('device id in the Keychain', () => {
    it('migrates an existing localStorage id into the Keychain on first run, unchanged', async () => {
        localStorage.setItem('thalassa_device_id', 'dev-fictional-holder-7e1a');
        const skipper = await launch();

        await expect(skipper.deviceIdReady()).resolves.toBe('dev-fictional-holder-7e1a');
        expect(keychain.writes).toEqual(['dev-fictional-holder-7e1a']);
        expect(skipper.getDeviceId()).toBe('dev-fictional-holder-7e1a');
    });

    it('a reinstall (localStorage gone, Keychain kept) is the same device and still the holder', async () => {
        const first = await launch();
        const id = await first.deviceIdReady();
        const claim = first.buildClaim();
        expect(first.holdsClaim(claim)).toBe(true);

        // Delete and reinstall: the sandbox (and its localStorage) goes, the
        // Keychain item stays.
        localStorage.clear();
        const reinstalled = await launch();
        await expect(reinstalled.deviceIdReady()).resolves.toBe(id);
        expect(reinstalled.getDeviceId()).toBe(id);
        expect(reinstalled.holdsClaim(claim)).toBe(true);
        expect(reinstalled.mayPublish(claim)).toBe(true);
        expect(localStorage.getItem('thalassa_device_id')).toBe(id);
    });

    it('replaces an id minted before the Keychain answered', async () => {
        keychain.value = 'dev-fictional-kept-in-keychain';
        const skipper = await launch();
        // Something asked for the id before the restore finished.
        const early = skipper.getDeviceId();
        expect(early).not.toBe('dev-fictional-kept-in-keychain');

        await expect(skipper.deviceIdReady()).resolves.toBe('dev-fictional-kept-in-keychain');
        expect(skipper.getDeviceId()).toBe('dev-fictional-kept-in-keychain');
        // The Keychain's copy is never overwritten by the early guess.
        expect(keychain.writes).toEqual([]);
    });

    it('keeps the localStorage id and writes nothing when the Keychain cannot be read', async () => {
        localStorage.setItem('thalassa_device_id', 'dev-fictional-local-only');
        keychain.failRead = true;
        const skipper = await launch();

        await expect(skipper.deviceIdReady()).resolves.toBe('dev-fictional-local-only');
        expect(keychain.writes).toEqual([]);
        expect(skipper.getDeviceId()).toBe('dev-fictional-local-only');
    });

    it('app data restored onto ANOTHER phone gets its own id, never the old phone’s', async () => {
        // The old phone: its id migrates into ITS Keychain on the first run.
        localStorage.setItem('thalassa_device_id', 'dev-fictional-old-phone-7e1a');
        const oldPhone = await launch();
        await oldPhone.deviceIdReady();
        const oldClaim = oldPhone.buildClaim();
        oldPhone.rememberHeld(true);
        expect(localStorage.getItem('thalassa_device_id_keychain')).toBe('dev-fictional-old-phone-7e1a');

        // A backup or Quick Start onto a new phone carries the app's data
        // (localStorage) but never a ThisDeviceOnly Keychain item.
        keychain.value = null;
        keychain.writes.length = 0;
        const newPhone = await launch();
        const id = await newPhone.deviceIdReady();

        expect(id).not.toBe('dev-fictional-old-phone-7e1a');
        expect(id).toMatch(/^dev-/);
        expect(newPhone.getDeviceId()).toBe(id);
        expect(keychain.writes).toEqual([id]);
        expect(localStorage.getItem('thalassa_device_id_keychain')).toBe(id);
        // Two phones are two devices: the old phone's claim is not this one's.
        expect(newPhone.holdsClaim(oldClaim)).toBe(false);
        expect(newPhone.mayPublish(oldClaim)).toBe(false);
        // And it was never the skipper here, so it is not told it was displaced.
        expect(newPhone.readRememberedHeld()).toBe(false);

        // Its own id from now on, through any reinstall.
        localStorage.clear();
        const reinstalled = await launch();
        await expect(reinstalled.deviceIdReady()).resolves.toBe(id);
    });

    it('a first-run migration the Keychain refused is retried, not mistaken for a restore', async () => {
        localStorage.setItem('thalassa_device_id', 'dev-fictional-holder-7e1a');
        keychain.failWrite = true;
        const first = await launch();
        await expect(first.deviceIdReady()).resolves.toBe('dev-fictional-holder-7e1a');
        expect(localStorage.getItem('thalassa_device_id_keychain')).toBeNull();

        keychain.failWrite = false;
        const next = await launch();
        await expect(next.deviceIdReady()).resolves.toBe('dev-fictional-holder-7e1a');
        expect(keychain.writes).toEqual(['dev-fictional-holder-7e1a']);
    });

    it('asks the Keychain once per launch', async () => {
        const skipper = await launch();
        await skipper.deviceIdReady();
        await skipper.deviceIdReady();
        skipper.getDeviceId();
        expect(keychain.reads).toBe(1);
    });
});

describe('the default device name says what the device is', () => {
    it('names an iPhone an iPhone, with a short stable suffix', async () => {
        setUserAgent('Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko)');
        localStorage.setItem('thalassa_device_id', 'dev-fictional-phone-9f3a');
        const skipper = await launch();
        expect(skipper.getDeviceName()).toBe('iPhone · 9f3a');
    });

    it('names an iPad an iPad, even behind the desktop-class user agent', async () => {
        setUserAgent('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko)', 5);
        localStorage.setItem('thalassa_device_id', 'dev-fictional-tablet-77c1');
        const skipper = await launch();
        expect(skipper.getDeviceName()).toBe('iPad · 77c1');
    });
});
