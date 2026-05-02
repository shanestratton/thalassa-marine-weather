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
            store.set('ship_log_tracking_state', 'not json{{{');
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
            store.set('ship_log_last_position', 'garbage');
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
            store.set('ship_log_voyage_start', '2026-05-02T06:00:00Z');
            await clearVoyageState();
            expect(store.has('ship_log_last_position')).toBe(false);
            expect(store.has('ship_log_voyage_start')).toBe(false);
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
});
