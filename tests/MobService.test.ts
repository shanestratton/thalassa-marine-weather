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

function pushOwn(latitude: number, longitude: number) {
    const pos = { latitude, longitude, accuracy: 5, altitude: null, heading: null, speed: 0, timestamp: Date.now() };
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

    it('keeps an armed MOB physically tracking but hides its fix from another account', async () => {
        mockFix = { latitude: -27.01, longitude: 153.02, accuracy: 3 };
        const accountAScope = getAuthIdentityScope();
        await MobService.activate();
        pushOwn(-27.02, 153.02);

        expect(MobService.currentState().active?.fixLat).toBe(-27.01);
        expect(watchCallbacks).toHaveLength(1);

        setAuthIdentityScope(TEST_ACCOUNT_B);

        expect(MobService.isActive()).toBe(false);
        expect(MobService.currentState()).toMatchObject({
            active: null,
            own: null,
            distanceMeters: null,
            bearingDeg: null,
            elapsedSec: 0,
        });
        // Account B cannot clear account A's emergency.
        await MobService.clear();
        expect(prefStore[authScopedStorageKey(MOB_STORAGE_KEY, accountAScope)]).toBeDefined();
        expect(watchCallbacks).toHaveLength(1);

        setAuthIdentityScope(TEST_ACCOUNT_A);
        expect(MobService.isActive()).toBe(true);
        expect(MobService.currentState().active?.fixLon).toBe(153.02);
        expect(MobService.currentState().own?.latitude).toBe(-27.02);
    });

    it('discards a GPS activation that resolves after the account changes', async () => {
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

        await expect(pending).resolves.toBeNull();
        expect(MobService.currentState().active).toBeNull();
        expect(Object.keys(prefStore)).toHaveLength(0);
        expect(Haptics.impact).not.toHaveBeenCalled();
        expect(KeepAwake.keepAwake).not.toHaveBeenCalled();
    });

    it('drops a persisted fix whose hydration resolves under another account', async () => {
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

        expect(MobService.currentState().active).toBeNull();
        expect(watchCallbacks).toHaveLength(0);

        setAuthIdentityScope(TEST_ACCOUNT_A);
        await MobService.hydrate();
        expect(MobService.currentState().active?.fixLat).toBe(-27.7);
    });

    it('ignores the unattributed legacy global MOB fix', async () => {
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
        expect(prefStore[MOB_STORAGE_KEY]).toBeDefined();
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
