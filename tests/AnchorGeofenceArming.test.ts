/**
 * Arming must not be defeated by the fence it is about to replace.
 *
 * Shane 2026-08-08: Anchor Watch refused to arm and the entire failure UI was
 * the Transistorsoft plugin's own string, "deleted 0 of 1 geofences". The
 * removal that runs BEFORE the add was strict, so a stale fence the SDK
 * declined to delete aborted the arm — over a fence the next call supersedes
 * anyway. He read it as the GPS being broken; his GPS was feeding a valid fix
 * with 15 satellites in view at the time.
 *
 * The property that must survive the relaxation: a watch may only claim to be
 * fenced when a fence is actually registered.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';

const geo = vi.hoisted(() => ({
    removeGeofence: vi.fn(),
    addGeofence: vi.fn(),
    geofenceExists: vi.fn(),
    ensureReady: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
    Capacitor: { isNativePlatform: () => true, getPlatform: () => 'ios' },
    registerPlugin: () => ({}),
}));

vi.mock('@transistorsoft/capacitor-background-geolocation', () => ({
    default: {
        removeGeofence: geo.removeGeofence,
        addGeofence: geo.addGeofence,
        geofenceExists: geo.geofenceExists,
    },
    AuthorizationStatus: { Always: 3, WhenInUse: 2, Denied: 1, Restricted: 0 },
}));

import { BgGeoManager } from '../services/BgGeoManager';

beforeEach(() => {
    geo.removeGeofence.mockReset();
    geo.addGeofence.mockReset();
    geo.geofenceExists.mockReset();
    // ensureReady() is private plumbing; short-circuit it so these tests are
    // about geofence policy, not plugin boot.
    vi.spyOn(BgGeoManager, 'ensureReady').mockResolvedValue(undefined);
    vi.spyOn(BgGeoManager as unknown as { isNativeSupported: () => boolean }, 'isNativeSupported').mockReturnValue(
        true,
    );
});

describe('geofence removal policy', () => {
    it('reports failure rather than throwing, on the arm path', async () => {
        geo.removeGeofence.mockRejectedValue(new Error('deleted 0 of 1 geofences'));
        await expect(BgGeoManager.tryRemoveGeofence('anchor')).resolves.toBe(false);
    });

    it('reports success when the fence really goes', async () => {
        geo.removeGeofence.mockResolvedValue(undefined);
        geo.geofenceExists.mockResolvedValue(false);
        await expect(BgGeoManager.tryRemoveGeofence('anchor')).resolves.toBe(true);
    });

    it('still THROWS on the strict teardown path — a surviving fence is unsafe', async () => {
        geo.removeGeofence.mockResolvedValue(undefined);
        geo.geofenceExists.mockResolvedValue(true); // SDK lied: it is still there
        await expect(BgGeoManager.removeGeofence('anchor')).rejects.toThrow(/remained registered/);
    });

    it('treats a resolved-but-ineffective removal as a failure, not a success', async () => {
        // The nastiest shape: the bridge call resolves and the fence survives.
        geo.removeGeofence.mockResolvedValue(undefined);
        geo.geofenceExists.mockResolvedValue(true);
        await expect(BgGeoManager.tryRemoveGeofence('anchor')).resolves.toBe(false);
    });

    it('can read an identifier back, which is what lets arming verify itself', async () => {
        geo.geofenceExists.mockResolvedValue(true);
        await expect(BgGeoManager.geofenceExists('anchor')).resolves.toBe(true);
    });
});
