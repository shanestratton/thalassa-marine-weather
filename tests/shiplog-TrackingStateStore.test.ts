/**
 * Tests for TrackingStateStore — verifies Capacitor Preferences round-trips
 * and that parse failures degrade gracefully.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    loadTrackingState,
    saveTrackingState,
    getLastPosition,
    saveLastPosition,
    clearVoyageState,
    type TrackingState,
    type StoredPosition,
} from '../services/shiplog/TrackingStateStore';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const store = new Map<string, string>();

vi.mock('@capacitor/preferences', () => ({
    Preferences: {
        get: async ({ key }: { key: string }) => ({ value: store.get(key) ?? null }),
        set: async ({ key, value }: { key: string; value: string }) => {
            store.set(key, value);
        },
        remove: async ({ key }: { key: string }) => {
            store.delete(key);
        },
    },
}));

describe('TrackingStateStore', () => {
    beforeEach(() => {
        setAuthIdentityScope('tracking-owner');
        store.clear();
    });

    afterEach(() => {
        store.clear();
    });

    describe('TrackingState round-trip', () => {
        it('returns null when no state is persisted', async () => {
            await expect(loadTrackingState()).resolves.toBeNull();
        });

        it('persists and reads back a TrackingState', async () => {
            const state: TrackingState = {
                isTracking: true,
                isPaused: false,
                isRapidMode: false,
                currentVoyageId: 'voyage_123',
                voyageStartTime: '2026-05-02T06:00:00Z',
                loggingZone: 'offshore',
                currentIntervalMs: 900_000,
            };
            await saveTrackingState(state);
            await expect(loadTrackingState()).resolves.toEqual(state);
        });

        it('returns null and does not throw on corrupt JSON', async () => {
            store.set(authScopedStorageKey('ship_log_tracking_state'), 'not json{{{');
            await expect(loadTrackingState()).resolves.toBeNull();
        });
    });

    describe('StoredPosition round-trip', () => {
        it('returns null when no position is persisted', async () => {
            await expect(getLastPosition()).resolves.toBeNull();
        });

        it('persists and reads back a StoredPosition', async () => {
            const pos: StoredPosition = {
                latitude: -27.5,
                longitude: 153.0,
                timestamp: '2026-05-02T06:00:00Z',
                cumulativeDistanceNM: 12.34,
                speedKts: 5.5,
            };
            await saveLastPosition(pos);
            await expect(getLastPosition()).resolves.toEqual(pos);
        });

        it('returns null and does not throw on corrupt JSON', async () => {
            store.set(authScopedStorageKey('ship_log_last_position'), 'garbage');
            await expect(getLastPosition()).resolves.toBeNull();
        });
    });

    describe('clearVoyageState', () => {
        it('removes both the last-position and legacy voyage-start keys', async () => {
            await saveLastPosition({
                latitude: 0,
                longitude: 0,
                timestamp: 't',
                cumulativeDistanceNM: 0,
            });
            store.set(authScopedStorageKey('ship_log_voyage_start'), '2026-05-02T06:00:00Z');
            await clearVoyageState();
            expect(store.has(authScopedStorageKey('ship_log_last_position'))).toBe(false);
            expect(store.has(authScopedStorageKey('ship_log_voyage_start'))).toBe(false);
        });

        it('leaves the live tracking-state key intact', async () => {
            const state: TrackingState = {
                isTracking: true,
                isPaused: false,
                isRapidMode: false,
            };
            await saveTrackingState(state);
            await saveLastPosition({
                latitude: 0,
                longitude: 0,
                timestamp: 't',
                cumulativeDistanceNM: 0,
            });
            await clearVoyageState();
            await expect(loadTrackingState()).resolves.toEqual(state);
            await expect(getLastPosition()).resolves.toBeNull();
        });
    });

    describe('account and generation fences', () => {
        it('keeps tracking state and last position isolated across A→B→A', async () => {
            const scopeA = getAuthIdentityScope();
            await saveTrackingState({
                isTracking: true,
                isPaused: false,
                isRapidMode: false,
                currentVoyageId: 'voyage-a',
            });
            await saveLastPosition({
                latitude: 1,
                longitude: 2,
                timestamp: 'a',
                cumulativeDistanceNM: 3,
            });

            setAuthIdentityScope('tracking-owner-b');
            await expect(loadTrackingState()).resolves.toBeNull();
            await expect(getLastPosition()).resolves.toBeNull();
            await saveTrackingState({
                isTracking: false,
                isPaused: false,
                isRapidMode: false,
                currentVoyageId: 'voyage-b',
            });

            setAuthIdentityScope('tracking-owner');
            await expect(loadTrackingState()).resolves.toMatchObject({ currentVoyageId: 'voyage-a' });
            await expect(getLastPosition()).resolves.toMatchObject({ timestamp: 'a' });

            // A callback captured before the switch cannot overwrite the
            // newer A generation after the account returns.
            await saveTrackingState(
                {
                    isTracking: false,
                    isPaused: false,
                    isRapidMode: false,
                    currentVoyageId: 'stale-a',
                },
                scopeA,
            );
            await expect(loadTrackingState()).resolves.toMatchObject({ currentVoyageId: 'voyage-a' });
        });

        it('ignores unattributed global legacy values (fail closed)', async () => {
            store.set(
                'ship_log_tracking_state',
                JSON.stringify({
                    isTracking: true,
                    isPaused: false,
                    isRapidMode: false,
                    currentVoyageId: 'global-legacy',
                }),
            );
            await expect(loadTrackingState()).resolves.toBeNull();
        });
    });
});
