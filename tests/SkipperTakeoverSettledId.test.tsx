/**
 * A deliberate claim is built under the device id the Keychain settles on
 * (build 125, 125-12).
 *
 * On a reinstall the first launch mints a fresh id before the iOS Keychain has
 * answered with the real one. A takeover confirmed in those first seconds used
 * to write a claim under the minted id; the Keychain id was then adopted, and
 * the device no longer held the claim it had just made — the trickle vetoed it
 * and the ghost claim's fresh claimedAt blocked any handover for 6 h. The
 * trickle already awaited deviceIdReady(); the two manual paths (the takeover
 * confirm, shared by the Log notice and the Vessel card, and the Vessel card's
 * first claim of an unclaimed boat) now do too.
 */
import React from 'react';
import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const keychain = vi.hoisted(() => {
    const state = {
        answer: null as null | ((value: string | null) => void),
        pending: null as Promise<string | null> | null,
    };
    return state;
});

vi.mock('@capacitor/core', async () => {
    const actual = await vi.importActual<typeof import('@capacitor/core')>('@capacitor/core');
    return { ...actual, Capacitor: { ...actual.Capacitor, getPlatform: () => 'ios', isNativePlatform: () => true } };
});

vi.mock('../services/anchorWatchRecoveryStorage', () => ({
    // The Keychain answers when the test says so (a slow bridge at boot).
    readNativeDeviceIdentity: vi.fn(() => keychain.pending),
    writeNativeDeviceIdentity: vi.fn(async () => undefined),
}));

const store = vi.hoisted(() => {
    const state = {
        settings: { liveTrackShare: true } as Record<string, unknown>,
        updateSettings: (patch: Record<string, unknown>) => {
            state.settings = { ...state.settings, ...patch };
        },
    };
    return { state };
});

vi.mock('../stores/settingsStore', () => {
    const useSettingsStore = (selector: (state: typeof store.state) => unknown) => selector(store.state);
    useSettingsStore.getState = () => store.state;
    return { useSettingsStore };
});
vi.mock('../stores/authStore', () => ({
    useAuthStore: (selector: (state: { user: { id: string } }) => unknown) => selector({ user: { id: 'user-1' } }),
}));

// Fictional devices (the repo is public).
const KEPT_ID = 'dev-fictional-kept-in-keychain-5c2d';
const LIVE_ELSEWHERE = {
    deviceId: 'dev-fictional-tablet',
    deviceName: 'iPad · 77c1',
    claimedAt: new Date(Date.now() - 3 * 24 * 3_600_000).toISOString(),
    lastSeenAt: new Date(Date.now() - 10 * 60_000).toISOString(),
};

type Modules = {
    notice: typeof import('../pages/log/SkipperClaimNotice');
    takeover: typeof import('../components/vessel/SkipperTakeover');
    skipper: typeof import('../services/skipperDevice');
    identity: typeof import('../services/authIdentityScope');
};

/** A cold launch after a reinstall: localStorage gone, the Keychain slow. */
async function launch(): Promise<Modules> {
    vi.resetModules();
    localStorage.clear();
    keychain.pending = new Promise((resolve) => {
        keychain.answer = resolve;
    });
    const identity = await import('../services/authIdentityScope');
    identity.setAuthIdentityScope('user-1');
    return {
        notice: await import('../pages/log/SkipperClaimNotice'),
        takeover: await import('../components/vessel/SkipperTakeover'),
        skipper: await import('../services/skipperDevice'),
        identity,
    };
}

const claimNow = () => store.state.settings.skipperDevice as { deviceId: string } | null | undefined;

beforeEach(() => {
    store.state.settings = { liveTrackShare: true, skipperDevice: LIVE_ELSEWHERE };
});

describe('the takeover confirm waits for the settled device id', () => {
    it('a takeover confirmed before the Keychain answers is written under the Keychain’s id', async () => {
        const { notice, skipper } = await launch();
        const minted = skipper.getDeviceId();
        expect(skipper.deviceIdSettled()).toBe(false);

        render(<notice.SkipperClaimNotice isTracking />);
        fireEvent.click(screen.getByRole('button', { name: 'Publish from this device' }));
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
        });
        // Nothing written under the id minted a moment ago.
        expect(claimNow()).toEqual(LIVE_ELSEWHERE);

        await act(async () => {
            keychain.answer?.(KEPT_ID);
            await skipper.deviceIdReady();
        });
        expect(claimNow()?.deviceId).toBe(KEPT_ID);
        expect(claimNow()?.deviceId).not.toBe(minted);
        expect(skipper.holdsClaim(claimNow() as never)).toBe(true);
    });

    it('writes nothing when the settled id turns out to hold the claim already (a reinstall of the holder)', async () => {
        const { notice, skipper } = await launch();
        const held = { ...LIVE_ELSEWHERE, deviceId: KEPT_ID, deviceName: 'iPhone · 5c2d' };
        store.state.settings = { liveTrackShare: true, skipperDevice: held };

        render(<notice.SkipperClaimNotice isTracking />);
        // Before the Keychain answers, the minted id does not hold it.
        fireEvent.click(screen.getByRole('button', { name: 'Publish from this device' }));
        act(() => {
            fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
        });

        await act(async () => {
            keychain.answer?.(KEPT_ID);
            await skipper.deviceIdReady();
        });
        // Same claim, untouched: this device was the holder all along.
        expect(claimNow()).toBe(held);
    });
});

describe('the Vessel card’s first claim of an unclaimed boat', () => {
    it('waits for the Keychain, then claims under its id', async () => {
        const { takeover, skipper } = await launch();
        store.state.settings = { liveTrackShare: true };
        const apply = vi.fn((claim: { deviceId: string }) => store.state.updateSettings({ skipperDevice: claim }));

        const { result } = renderHook(() =>
            takeover.useSkipperTakeover({ claim: null, authenticatedUserId: 'user-1', apply }),
        );
        act(() => result.current.claimUnclaimed());
        expect(apply).not.toHaveBeenCalled();

        await act(async () => {
            keychain.answer?.(KEPT_ID);
            await skipper.deviceIdReady();
        });
        expect(apply).toHaveBeenCalledTimes(1);
        expect(apply.mock.calls[0][0].deviceId).toBe(KEPT_ID);
    });

    it('claims at once once the id has settled', async () => {
        const { takeover, skipper } = await launch();
        keychain.answer?.(KEPT_ID);
        await skipper.deviceIdReady();
        const apply = vi.fn();

        const { result } = renderHook(() =>
            takeover.useSkipperTakeover({ claim: null, authenticatedUserId: 'user-1', apply }),
        );
        act(() => result.current.claimUnclaimed());
        expect(apply).toHaveBeenCalledTimes(1);
        expect(apply.mock.calls[0][0].deviceId).toBe(KEPT_ID);
    });
});
