/**
 * Voyage logging asks iOS only for what its track source needs (build 123,
 * package VL). Anchor Watch keeps its Always gate — see
 * NativeAnchorSafetyNotificationContract.test.ts, which still pins it.
 *
 * Why While Using is enough for a boat-fed log: with
 * allowsBackgroundLocationUpdates and updates started in the foreground, Core
 * Location keeps the app running under When In Use, blue indicator showing
 * (Apple, "Handling location updates in the background"); Transistorsoft says
 * the same for its SDK. What Always adds is a restart from the background and
 * a relaunch after iOS ends the app — which a phone-only log is told about
 * honestly instead of being refused. (A Pi recording her track will cover it
 * once its track can backfill a voyage — phase 2; until then a boat-fed log
 * aboard takes While Using like any other.)
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => {
    let enabled = false;
    return {
        get enabled() {
            return enabled;
        },
        setEnabled(value: boolean) {
            enabled = value;
        },
        ready: vi.fn(async () => undefined),
        start: vi.fn(async () => {
            enabled = true;
        }),
        stop: vi.fn(async () => {
            enabled = false;
        }),
        destroyLocations: vi.fn(async () => undefined),
        changePace: vi.fn(async () => undefined),
        getState: vi.fn(async () => ({ enabled })),
        getProviderState: vi.fn(async () => ({ enabled: true, status: 4, gps: true })),
        requestPermission: vi.fn(async () => 4),
        setConfig: vi.fn(async (_config: unknown) => undefined),
    };
});

vi.mock('@capacitor/core', () => ({
    Capacitor: {
        getPlatform: () => 'ios',
    },
}));

vi.mock('@transistorsoft/capacitor-background-geolocation', () => ({
    default: {
        ready: native.ready,
        start: native.start,
        stop: native.stop,
        changePace: native.changePace,
        getState: native.getState,
        getProviderState: native.getProviderState,
        requestPermission: native.requestPermission,
        setConfig: native.setConfig,
        destroyLocations: native.destroyLocations,
        onLocation: vi.fn(() => ({ remove: vi.fn() })),
        onGeofence: vi.fn(() => ({ remove: vi.fn() })),
        onHeartbeat: vi.fn(() => ({ remove: vi.fn() })),
        onActivityChange: vi.fn(() => ({ remove: vi.fn() })),
        onProviderChange: vi.fn(() => ({ remove: vi.fn() })),
    },
}));

vi.mock('../utils/createLogger', () => ({
    createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
    BgGeoManager,
    LEASELESS_VOYAGE_ADVISORY,
    VoyageLocationError,
    isVoyageLocationError,
} from '../services/BgGeoManager';

// CLLocationManager's authorization enum, as Transistorsoft reports it.
const NOT_DETERMINED = 0;
const DENIED = 2;
const ALWAYS = 3;
const WHEN_IN_USE = 4;

const provider = (status: number, enabled = true) => ({ enabled, status, gps: true });
const alwaysRequested = () =>
    native.setConfig.mock.calls.some(
        ([config]) =>
            (config as { geolocation?: { locationAuthorizationRequest?: string } } | undefined)?.geolocation
                ?.locationAuthorizationRequest === 'Always',
    );

describe('BgGeoManager.requireVoyageBackgroundLocation', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        native.setEnabled(false);
        native.getProviderState.mockResolvedValue(provider(WHEN_IN_USE));
        native.requestPermission.mockResolvedValue(WHEN_IN_USE);
    });

    it('a boat-fed log (While Using) starts the keep-alive lease and never asks for Always', async () => {
        await expect(BgGeoManager.requireVoyageBackgroundLocation('when-in-use')).resolves.toEqual({
            lease: true,
            advisory: null,
        });
        expect(native.requestPermission).not.toHaveBeenCalled();
        expect(alwaysRequested()).toBe(false);
    });

    it('a boat-fed log with location never asked prompts for While Using only', async () => {
        native.getProviderState
            .mockResolvedValueOnce(provider(NOT_DETERMINED))
            .mockResolvedValueOnce(provider(WHEN_IN_USE));
        await expect(BgGeoManager.requireVoyageBackgroundLocation('when-in-use')).resolves.toMatchObject({
            lease: true,
        });
        expect(native.requestPermission).toHaveBeenCalledTimes(1);
        expect(alwaysRequested()).toBe(false);
    });

    it('a gateway-only log with location denied says honestly that While Using is enough', async () => {
        native.getProviderState.mockResolvedValue(provider(DENIED));
        const error = await BgGeoManager.requireVoyageBackgroundLocation('when-in-use').then(
            () => null,
            (cause: unknown) => cause as Error,
        );
        expect(error?.message).toMatch(/While Using is enough/);
        expect(error?.message).not.toMatch(/Always/);
        expect(native.requestPermission).not.toHaveBeenCalled();
        // Typed, so the Log page puts it in its start card, never a toast.
        expect(isVoyageLocationError(error)).toBe(true);
        expect((error as VoyageLocationError).kind).toBe('permission');
    });

    it('Location Services off is its own kind of refusal', async () => {
        native.getProviderState.mockResolvedValue(provider(WHEN_IN_USE, false));
        const error = await BgGeoManager.requireVoyageBackgroundLocation('when-in-use').then(
            () => null,
            (cause: unknown) => cause as Error,
        );
        expect(isVoyageLocationError(error) && error.kind).toBe('services-off');
    });

    it('a Start from ashore asks for nothing: no grant means no lease and an honest "only while open", never a prompt or an error', async () => {
        native.getProviderState.mockResolvedValue(provider(DENIED));
        await expect(BgGeoManager.requireVoyageBackgroundLocation('none-needed')).resolves.toEqual({
            lease: false,
            advisory: LEASELESS_VOYAGE_ADVISORY,
        });
        native.getProviderState.mockResolvedValue(provider(NOT_DETERMINED));
        await expect(BgGeoManager.requireVoyageBackgroundLocation('none-needed')).resolves.toEqual({
            lease: false,
            advisory: LEASELESS_VOYAGE_ADVISORY,
        });
        expect(LEASELESS_VOYAGE_ADVISORY).toMatch(/only while Thalassa is open/);
        expect(native.requestPermission).not.toHaveBeenCalled();
        expect(alwaysRequested()).toBe(false);
    });

    it('a Start from ashore in the background with While Using waits for the foreground instead of running leaseless', async () => {
        // Build 123 review: returning "no lease" here started a voyage iOS
        // suspends at the first screen lock, with nothing to take the lease
        // later. Like every other mode, it waits for Thalassa to be in front.
        native.getProviderState.mockResolvedValue(provider(WHEN_IN_USE));
        const error = await BgGeoManager.requireVoyageBackgroundLocation('none-needed', { background: true }).then(
            () => null,
            (cause: unknown) => cause as Error,
        );
        expect(error?.message).toMatch(/when Thalassa is open/);
        expect(isVoyageLocationError(error) && error.kind).toBe('deferred');
        // A voyage that was already running leaseless carries on as it was.
        await expect(
            BgGeoManager.requireVoyageBackgroundLocation('none-needed', { background: true, resumeLeaseless: true }),
        ).resolves.toEqual({ lease: false, advisory: LEASELESS_VOYAGE_ADVISORY });
        // Always can start from the background: no deferral.
        native.getProviderState.mockResolvedValue(provider(ALWAYS));
        await expect(
            BgGeoManager.requireVoyageBackgroundLocation('none-needed', { background: true }),
        ).resolves.toEqual({ lease: true, advisory: null });
    });

    it('a Start from ashore with any grant keeps the phone awake with the lease, silently', async () => {
        native.getProviderState.mockResolvedValue(provider(WHEN_IN_USE));
        await expect(BgGeoManager.requireVoyageBackgroundLocation('none-needed')).resolves.toEqual({
            lease: true,
            advisory: null,
        });
        expect(native.requestPermission).not.toHaveBeenCalled();
    });

    it('a phone-only log at While Using starts, with an honest Always advisory instead of a refusal', async () => {
        native.getProviderState.mockResolvedValue(provider(WHEN_IN_USE));
        native.requestPermission.mockResolvedValue(WHEN_IN_USE);
        const result = await BgGeoManager.requireVoyageBackgroundLocation('always-advised');
        expect(result.lease).toBe(true);
        expect(result.advisory).toMatch(/Logging from this phone/);
        expect(result.advisory).toMatch(/Settings › Privacy & Security › Location Services › Thalassa › Always/);
        // It may ask iOS once (the system shows its own upgrade sheet at most once) …
        expect(alwaysRequested()).toBe(true);
        // … and always puts the shared prompt policy back.
        expect(native.setConfig).toHaveBeenLastCalledWith({
            geolocation: { locationAuthorizationRequest: 'WhenInUse' },
        });
    });

    it('a phone-only log with Always needs no advisory', async () => {
        native.getProviderState.mockResolvedValue(provider(ALWAYS));
        await expect(BgGeoManager.requireVoyageBackgroundLocation('always-advised')).resolves.toEqual({
            lease: true,
            advisory: null,
        });
    });

    it('a start from the background without Always defers to the foreground (iOS cannot start While Using there)', async () => {
        native.getProviderState.mockResolvedValue(provider(WHEN_IN_USE));
        await expect(BgGeoManager.requireVoyageBackgroundLocation('when-in-use', { background: true })).rejects.toThrow(
            /when Thalassa is open/,
        );
        await expect(
            BgGeoManager.requireVoyageBackgroundLocation('always-advised', { background: true }),
        ).rejects.toThrow(/when Thalassa is open/);
        // …unless the engine is already running (a WebView reload re-arming its own lease).
        native.setEnabled(true);
        await expect(
            BgGeoManager.requireVoyageBackgroundLocation('when-in-use', { background: true }),
        ).resolves.toMatchObject({ lease: true });
    });

    it('hasAlwaysLocation reads the grant without prompting', async () => {
        native.getProviderState.mockResolvedValue(provider(ALWAYS));
        await expect(BgGeoManager.hasAlwaysLocation()).resolves.toBe(true);
        native.getProviderState.mockResolvedValue(provider(WHEN_IN_USE));
        await expect(BgGeoManager.hasAlwaysLocation()).resolves.toBe(false);
        expect(native.requestPermission).not.toHaveBeenCalled();
    });

    it('Anchor Watch is untouched: it still demands Always', async () => {
        native.getProviderState.mockResolvedValue(provider(WHEN_IN_USE));
        native.requestPermission.mockResolvedValue(WHEN_IN_USE);
        await expect(BgGeoManager.requireAlwaysLocationAuthorization('anchor-watch')).rejects.toThrow(
            'Anchor Watch needs Always Location access',
        );
    });
});
