/**
 * MobService tests — Man Overboard is the single most safety-critical feature
 * in the app and had ZERO coverage (audit finding). This pins the
 * distance/bearing-back-to-fix math, the persist/restore across restart, and
 * the activate/clear lifecycle.
 *
 * Native deps are mocked so the pure logic runs under jsdom.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

function pushOwn(latitude: number, longitude: number) {
    const pos = { latitude, longitude, accuracy: 5, altitude: null, heading: null, speed: 0, timestamp: Date.now() };
    for (const cb of [...watchCallbacks]) cb(pos);
}

async function resetService() {
    await MobService.clear();
    // Singleton bleed: clear() doesn't reset the private hydrate guard.
    (MobService as unknown as { hydrated: boolean; snapshot: unknown; own: unknown }).hydrated = false;
    (MobService as unknown as { snapshot: unknown }).snapshot = null;
    (MobService as unknown as { own: unknown }).own = null;
    for (const k of Object.keys(prefStore)) delete prefStore[k];
    watchCallbacks.length = 0;
    mockFix = null;
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
        (MobService as unknown as { hydrated: boolean; snapshot: unknown }).hydrated = false;
        (MobService as unknown as { snapshot: unknown }).snapshot = null;

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
});
