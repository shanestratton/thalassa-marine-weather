/**
 * MobService tests — Man Overboard is the single most safety-critical feature
 * in the app and had ZERO coverage (audit finding). This pins the
 * distance/bearing-back-to-fix math, the persist/restore across restart, and
 * the activate/clear lifecycle.
 *
 * Native deps are mocked so the pure logic runs under jsdom.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

// ── Mocks (hoisted before MobService import) ─────────────────────────────────
let mockFix: { latitude: number; longitude: number; accuracy: number } | null = null;
const watchCallbacks: ((pos: unknown) => void)[] = [];

vi.mock('../services/GpsService', () => ({
    GpsService: {
        // Live-fix cache MOB reads before any blocking acquisition.
        getLastKnownPosition: () => null,
        getCurrentPosition: vi.fn(async () => mockFix),
        watchPosition: vi.fn((cb: (pos: unknown) => void) => {
            watchCallbacks.push(cb);
            return () => {
                const i = watchCallbacks.indexOf(cb);
                if (i >= 0) watchCallbacks.splice(i, 1);
            };
        }),
    },
}));

const prefStore: Record<string, string> = {};
vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: vi.fn(async ({ key }: { key: string }) => ({ value: prefStore[key] ?? null })),
        set: vi.fn(async ({ key, value }: { key: string; value: string }) => {
            prefStore[key] = value;
        }),
        remove: vi.fn(async ({ key }: { key: string }) => {
            delete prefStore[key];
        }),
    },
}));
vi.mock('@capacitor/haptics', () => ({ Haptics: { impact: vi.fn(async () => {}) }, ImpactStyle: { Heavy: 'HEAVY' } }));
vi.mock('@capacitor-community/keep-awake', () => ({
    KeepAwake: { keepAwake: vi.fn(async () => {}), allowSleep: vi.fn(async () => {}) },
}));

import { MobService } from '../services/MobService';
import { GpsService, type GpsPosition } from '../services/GpsService';
import { Haptics } from '@capacitor/haptics';
import { KeepAwake } from '@capacitor-community/keep-awake';
import { Preferences } from '@capacitor/preferences';

const TEST_ACCOUNT_A = 'mob-account-a';
const TEST_ACCOUNT_B = 'mob-account-b';
const MOB_STORAGE_KEY = 'thalassa_mob_active_v1';

interface MobServiceInternals {
    snapshot: unknown;
    snapshotOwnerKey: string | null;
    snapshotOwnerUserId: string | null;
    own: unknown;
    persistenceStatus: 'idle' | 'pending' | 'confirmed' | 'failed';
    hydratedScopeKeys: Set<string>;
    hydrationPromises: Map<number, Promise<void>>;
    storageChains: Map<string, Promise<void>>;
    stopLiveTracking(): void;
    clearScheduledHaptics(): void;
}

function internals(): MobServiceInternals {
    return MobService as unknown as MobServiceInternals;
}

function fullGpsFix(fix: { latitude: number; longitude: number; accuracy: number }): GpsPosition {
    return {
        ...fix,
        altitude: null,
        heading: null,
        speed: 0,
        timestamp: Date.now(),
    };
}

function pushOwn(latitude: number, longitude: number, timestamp: number = Date.now(), accuracy = 5, speed = 0) {
    const pos = { latitude, longitude, accuracy, altitude: null, heading: null, speed, timestamp };
    for (const cb of [...watchCallbacks]) cb(pos);
}

async function resetService() {
    const service = internals();
    service.stopLiveTracking();
    service.clearScheduledHaptics();
    service.snapshot = null;
    service.snapshotOwnerKey = null;
    service.snapshotOwnerUserId = null;
    service.own = null;
    service.persistenceStatus = 'idle';
    service.hydratedScopeKeys.clear();
    service.hydrationPromises.clear();
    service.storageChains.clear();
    for (const k of Object.keys(prefStore)) delete prefStore[k];
    watchCallbacks.length = 0;
    mockFix = null;

    setAuthIdentityScope(null);
    setAuthIdentityScope(TEST_ACCOUNT_A);
    // Let the identity listener's empty hydration settle, then make each test
    // explicitly control whether its scope has been hydrated.
    await Promise.resolve();
    await Promise.resolve();
    service.hydratedScopeKeys.clear();

    vi.mocked(GpsService.getCurrentPosition).mockReset();
    vi.mocked(GpsService.getCurrentPosition).mockImplementation(async () => (mockFix ? fullGpsFix(mockFix) : null));
    vi.mocked(Preferences.get).mockClear();
    vi.mocked(Preferences.set).mockClear();
    vi.mocked(Preferences.remove).mockClear();
    vi.mocked(Haptics.impact).mockClear();
    vi.mocked(KeepAwake.keepAwake).mockClear();
    vi.mocked(KeepAwake.allowSleep).mockClear();
}

describe('MobService', () => {
    beforeEach(async () => {
        await resetService();
    });

    it('STARTS the GPS engine, not just a passive listener', async () => {
        // GpsService.watchPosition defaults ensureRunning to false: a bare
        // subscribe receives fixes only if something else already started the
        // engine. App renders MapHub and the Dashboard — the only hooks that
        // do — mutually exclusively with the MOB screen, so without
        // ensureRunning the live bearing and distance to the person in the
        // water never populate, under a pulsing "Live" badge.
        mockFix = { latitude: -27.4, longitude: 153.1, accuracy: 5 };
        await MobService.activate();
        const call = vi.mocked(GpsService.watchPosition).mock.calls.at(-1);
        expect(call?.[1]).toEqual({ ensureRunning: true });
    });

    it('activates at the current GPS fix and is active', async () => {
        mockFix = { latitude: -27.0, longitude: 153.0, accuracy: 4 };
        const snap = await MobService.activate();
        expect(snap).not.toBeNull();
        expect(snap?.fixLat).toBe(-27.0);
        expect(snap?.fixLon).toBe(153.0);
        expect(MobService.isActive()).toBe(true);
    });

    it('returns null and stays inactive when no GPS fix is available', async () => {
        mockFix = null;
        const snap = await MobService.activate();
        expect(snap).toBeNull();
        expect(MobService.isActive()).toBe(false);
    });

    it('immediately retains a poor GPS fix as an approximate MOB search datum', async () => {
        mockFix = { latitude: -27, longitude: 153, accuracy: 250 };

        await expect(MobService.activate()).resolves.toMatchObject({
            fixLat: -27,
            fixLon: 153,
            fixAccuracy: 250,
        });

        expect(MobService.isActive()).toBe(true);
        expect(MobService.currentState().fixQuality).toBe('approximate');
        expect(Preferences.set).toHaveBeenCalled();
    });

    it('refines an approximate datum with a better early fix without moving the activation time', async () => {
        mockFix = { latitude: -27, longitude: 153, accuracy: 250 };
        const initial = await MobService.activate();
        expect(initial).not.toBeNull();

        pushOwn(-27.00005, 153.00005, initial!.activatedAt + 5_000, 20);
        await vi.waitFor(() => expect(MobService.currentState().persistenceStatus).toBe('confirmed'));

        expect(MobService.currentState().active).toMatchObject({
            fixLat: -27.00005,
            fixLon: 153.00005,
            fixAccuracy: 20,
            activatedAt: initial!.activatedAt,
        });
        expect(MobService.currentState().fixQuality).toBe('precise');
    });

    it('freezes the MOB datum after the refinement window so own-ship motion cannot drag it', async () => {
        mockFix = { latitude: -27, longitude: 153, accuracy: 250 };
        const initial = await MobService.activate();

        pushOwn(-27.01, 153.01, initial!.activatedAt + 31_000, 5);

        expect(MobService.currentState().active).toMatchObject({
            fixLat: -27,
            fixLon: 153,
            fixAccuracy: 250,
            activatedAt: initial!.activatedAt,
        });
    });

    it('retains the original search circle when own ship moves materially inside the refinement window', async () => {
        mockFix = { latitude: -27, longitude: 153, accuracy: 250 };
        const initial = await MobService.activate();

        // About 130 m after 25 seconds at ten knots: accepting this as the
        // casualty datum would move the search target down-track.
        pushOwn(-27.00117, 153, initial!.activatedAt + 25_000, 5, 5.14);

        expect(MobService.currentState().active).toMatchObject({
            fixLat: -27,
            fixLon: 153,
            fixAccuracy: 250,
            activatedAt: initial!.activatedAt,
        });
        expect(MobService.currentState().fixQuality).toBe('approximate');
    });

    it('requires negligible reported speed even when displacement still looks small', async () => {
        mockFix = { latitude: -27, longitude: 153, accuracy: 250 };
        const initial = await MobService.activate();

        pushOwn(-27.00003, 153, initial!.activatedAt + 2_000, 5, 4);

        expect(MobService.currentState().active).toMatchObject({
            fixLat: -27,
            fixLon: 153,
            fixAccuracy: 250,
        });
    });

    it('computes distance + TRUE bearing from own position back to the fix', async () => {
        // Person went over at the fix; vessel has moved ~111 m SOUTH of it.
        mockFix = { latitude: -27.0, longitude: 153.0, accuracy: 4 };
        await MobService.activate();
        pushOwn(-27.001, 153.0); // own is south → fix bears due NORTH

        const s = MobService.currentState();
        expect(s.distanceMeters).toBeGreaterThan(100);
        expect(s.distanceMeters).toBeLessThan(125); // ~111 m
        // Bearing own→fix is essentially due north (0°/360°)
        expect(Math.min(s.bearingDeg ?? 999, 360 - (s.bearingDeg ?? 999))).toBeLessThan(2);
    });

    it('bears due EAST when the fix is east of own', async () => {
        mockFix = { latitude: -27.0, longitude: 153.001, accuracy: 4 }; // fix east
        await MobService.activate();
        pushOwn(-27.0, 153.0); // own west of fix → fix bears ~090°
        const s = MobService.currentState();
        expect(s.bearingDeg).toBeGreaterThan(88);
        expect(s.bearingDeg).toBeLessThan(92);
        expect(s.distanceMeters).toBeGreaterThan(90); // ~99 m at this latitude
        expect(s.distanceMeters).toBeLessThan(110);
    });

    it('ages its own-ship fix and hides stale distance and bearing', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-06-21T00:00:00Z'));
            mockFix = { latitude: -27.0, longitude: 153.001, accuracy: 4 };
            await MobService.activate();
            pushOwn(-27.0, 153.0);

            expect(MobService.currentState()).toMatchObject({
                ownPositionAgeMs: 0,
                ownPositionFresh: true,
            });
            expect(MobService.currentState().distanceMeters).not.toBeNull();
            expect(MobService.currentState().bearingDeg).not.toBeNull();

            vi.setSystemTime(new Date('2026-06-21T00:00:16Z'));
            const stale = MobService.currentState();
            expect(stale.own?.longitude).toBe(153.0);
            expect(stale.ownPositionAgeMs).toBe(16_000);
            expect(stale.ownPositionFresh).toBe(false);
            expect(stale.distanceMeters).toBeNull();
            expect(stale.bearingDeg).toBeNull();
        } finally {
            await MobService.clear();
            vi.useRealTimers();
        }
    });

    it('persists the fix and restores it on a fresh hydrate (app restart)', async () => {
        mockFix = { latitude: 12.34, longitude: -56.78, accuracy: 9 };
        await MobService.activate();
        expect(Object.keys(prefStore).length).toBe(1); // persisted

        // Simulate a restart: wipe in-memory singleton state but keep storage
        const service = internals();
        service.stopLiveTracking();
        service.clearScheduledHaptics();
        service.hydratedScopeKeys.delete(getAuthIdentityScope().key);
        service.snapshot = null;
        service.snapshotOwnerKey = null;
        service.snapshotOwnerUserId = null;
        service.own = null;

        await MobService.hydrate();
        expect(MobService.isActive()).toBe(true);
        expect(MobService.currentState().active?.fixLat).toBe(12.34);
        expect(MobService.currentState().active?.fixLon).toBe(-56.78);
        expect(MobService.currentState().persistenceStatus).toBe('confirmed');
    });

    it('keeps MOB active but exposes a failed restart-recovery write', async () => {
        vi.mocked(Preferences.set).mockRejectedValueOnce(new Error('native storage unavailable'));
        mockFix = { latitude: -27, longitude: 153, accuracy: 4 };

        await expect(MobService.activate()).resolves.not.toBeNull();

        expect(MobService.isActive()).toBe(true);
        expect(MobService.currentState().persistenceStatus).toBe('failed');
    });

    it('clear() deactivates and wipes persisted state', async () => {
        mockFix = { latitude: -27, longitude: 153, accuracy: 4 };
        await MobService.activate();
        expect(MobService.isActive()).toBe(true);

        await MobService.clear();
        expect(MobService.isActive()).toBe(false);
        expect(MobService.currentState().active).toBeNull();
        expect(MobService.currentState().distanceMeters).toBeNull();
        expect(Object.keys(prefStore).length).toBe(0);
    });

    it('keeps the emergency armed when persisted recovery cannot be cleared', async () => {
        mockFix = { latitude: -27, longitude: 153, accuracy: 4 };
        await MobService.activate();
        vi.mocked(Preferences.remove).mockRejectedValueOnce(new Error('native storage unavailable'));

        await expect(MobService.clear()).rejects.toThrow('MOB remains active');

        expect(MobService.isActive()).toBe(true);
        expect(MobService.currentState().persistenceStatus).toBe('failed');
        expect(Object.keys(prefStore)).toHaveLength(1);
    });

    it('retains device recovery when legacy cleanup succeeds but authoritative removal fails', async () => {
        mockFix = { latitude: -27, longitude: 153, accuracy: 4 };
        await MobService.activate();
        vi.mocked(Preferences.remove)
            .mockImplementationOnce(async ({ key }) => {
                delete prefStore[key];
            })
            .mockRejectedValueOnce(new Error('device recovery removal failed'));

        await expect(MobService.clear()).rejects.toThrow('MOB remains active');

        expect(MobService.isActive()).toBe(true);
        expect(prefStore[MOB_STORAGE_KEY]).toBeDefined();
        expect(MobService.currentState().persistenceStatus).toBe('failed');
    });

    it('elapsedSec counts up from activation', async () => {
        vi.useFakeTimers();
        try {
            vi.setSystemTime(new Date('2026-06-21T00:00:00Z'));
            mockFix = { latitude: -27, longitude: 153, accuracy: 4 };
            await MobService.activate();
            expect(MobService.currentState().elapsedSec).toBe(0);
            vi.setSystemTime(new Date('2026-06-21T00:01:05Z')); // +65 s
            expect(MobService.currentState().elapsedSec).toBe(65);
        } finally {
            vi.useRealTimers();
        }
    });

    it('keeps an armed MOB visible and clearable across logout/account transitions', async () => {
        mockFix = { latitude: -27.01, longitude: 153.02, accuracy: 3 };
        await MobService.activate();
        pushOwn(-27.02, 153.02);

        expect(MobService.currentState().active?.fixLat).toBe(-27.01);
        expect(watchCallbacks).toHaveLength(1);

        setAuthIdentityScope(TEST_ACCOUNT_B);

        expect(MobService.isActive()).toBe(true);
        expect(MobService.currentState()).toMatchObject({
            active: { fixLat: -27.01, fixLon: 153.02 },
            own: { latitude: -27.02 },
        });
        // The emergency belongs to the physical device, not the auth session.
        await MobService.clear();
        expect(prefStore[MOB_STORAGE_KEY]).toBeUndefined();
        expect(watchCallbacks).toHaveLength(0);

        setAuthIdentityScope(TEST_ACCOUNT_A);
        expect(MobService.isActive()).toBe(false);
        expect(MobService.currentState().active).toBeNull();
    });

    it('finishes a physical MOB activation even if auth changes while GPS resolves', async () => {
        let resolveFix!: (fix: GpsPosition) => void;
        vi.mocked(GpsService.getCurrentPosition).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveFix = resolve;
                }),
        );

        const pending = MobService.activate();
        await vi.waitFor(() => expect(GpsService.getCurrentPosition).toHaveBeenCalledTimes(1));

        setAuthIdentityScope(TEST_ACCOUNT_B);
        resolveFix(fullGpsFix({ latitude: -27.5, longitude: 153.5, accuracy: 5 }));

        await expect(pending).resolves.toMatchObject({ fixLat: -27.5, fixLon: 153.5 });
        expect(MobService.currentState().active).toMatchObject({ fixLat: -27.5, fixLon: 153.5 });
        expect(prefStore[MOB_STORAGE_KEY]).toBeDefined();
        expect(Haptics.impact).toHaveBeenCalled();
        expect(KeepAwake.keepAwake).toHaveBeenCalled();
    });

    it('restores a device emergency even when auth changes during hydration', async () => {
        const accountAScope = getAuthIdentityScope();
        const persisted = JSON.stringify({
            version: 2,
            ownerKey: accountAScope.key,
            ownerUserId: accountAScope.userId,
            snapshot: {
                fixLat: -27.7,
                fixLon: 153.7,
                fixAccuracy: 4,
                activatedAt: Date.now(),
            },
        });
        prefStore[authScopedStorageKey(MOB_STORAGE_KEY, accountAScope)] = persisted;
        internals().hydratedScopeKeys.delete(accountAScope.key);

        let resolveRead!: (result: { value: string }) => void;
        vi.mocked(Preferences.get).mockImplementationOnce(
            () =>
                new Promise((resolve) => {
                    resolveRead = resolve;
                }),
        );
        const pending = MobService.hydrate();
        await vi.waitFor(() => expect(Preferences.get).toHaveBeenCalled());

        setAuthIdentityScope(TEST_ACCOUNT_B);
        resolveRead({ value: persisted });
        await pending;

        expect(MobService.currentState().active?.fixLat).toBe(-27.7);
        expect(MobService.isActive()).toBe(true);
        expect(watchCallbacks).toHaveLength(1);
    });

    it('rejects and removes an unattributed legacy global MOB fix', async () => {
        prefStore[MOB_STORAGE_KEY] = JSON.stringify({
            fixLat: -27.9,
            fixLon: 153.9,
            fixAccuracy: 5,
            activatedAt: Date.now(),
        });
        internals().hydratedScopeKeys.delete(getAuthIdentityScope().key);

        await MobService.hydrate();

        expect(MobService.isActive()).toBe(false);
        expect(MobService.currentState().active).toBeNull();
        expect(prefStore[MOB_STORAGE_KEY]).toBeUndefined();
    });

    it('serializes a slow persist before clear so the fix cannot resurrect', async () => {
        let resolveWrite!: () => void;
        vi.mocked(Preferences.set).mockImplementationOnce(
            ({ key, value }) =>
                new Promise<void>((resolve) => {
                    resolveWrite = () => {
                        prefStore[key] = value;
                        resolve();
                    };
                }),
        );
        mockFix = { latitude: -27.8, longitude: 153.8, accuracy: 4 };

        const activation = MobService.activate();
        await vi.waitFor(() => expect(Preferences.set).toHaveBeenCalledTimes(1));
        const clear = MobService.clear();

        resolveWrite();
        await Promise.all([activation, clear]);

        expect(MobService.isActive()).toBe(false);
        expect(Object.keys(prefStore)).toHaveLength(0);
    });

    it('cancels delayed haptic pulses when the owning account clears the emergency', async () => {
        vi.useFakeTimers();
        try {
            mockFix = { latitude: -27, longitude: 153, accuracy: 4 };
            await MobService.activate();
            expect(Haptics.impact).toHaveBeenCalledTimes(1);

            await MobService.clear();
            await vi.advanceTimersByTimeAsync(500);

            expect(Haptics.impact).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });
});
