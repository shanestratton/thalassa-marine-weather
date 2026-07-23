/**
 * AisGuardZone — Unit tests
 *
 * Tests the virtual radar guard zone: enable/disable, radius config,
 * feature checking, alert generation, and state management.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AisGuardZone } from '../services/AisGuardZone';
import { authScopedStorageKey, getAuthIdentityScope, setAuthIdentityScope } from '../services/authIdentityScope';

const TEST_ACCOUNT_A = 'guard-account-a';
const TEST_ACCOUNT_B = 'guard-account-b';
const GUARD_STORAGE_KEY = 'thalassa_guard_zone';

describe('AisGuardZone', () => {
    beforeEach(() => {
        localStorage.clear();
        for (const identity of [null, TEST_ACCOUNT_A, TEST_ACCOUNT_B]) {
            setAuthIdentityScope(identity);
            AisGuardZone.setEnabled(false);
            AisGuardZone.setRadius(2);
            AisGuardZone.clearAlerts();
        }
        localStorage.clear();
        setAuthIdentityScope(TEST_ACCOUNT_A);
    });

    // ── Initial state ──

    describe('getState', () => {
        it('defaults to disabled with 2 NM radius', () => {
            const state = AisGuardZone.getState();
            expect(state.enabled).toBe(false);
            expect(state.radiusNm).toBe(2);
            expect(state.alerts).toEqual([]);
        });
    });

    // ── Enable/disable ──

    describe('setEnabled', () => {
        it('enables the guard zone', () => {
            AisGuardZone.setEnabled(true);
            expect(AisGuardZone.getState().enabled).toBe(true);
        });

        it('disabling clears alerts', () => {
            AisGuardZone.setEnabled(true);
            AisGuardZone.setEnabled(false);
            expect(AisGuardZone.getState().enabled).toBe(false);
            expect(AisGuardZone.getState().alerts).toEqual([]);
        });

        it('persists to localStorage', () => {
            AisGuardZone.setEnabled(true);
            const saved = localStorage.getItem(authScopedStorageKey(GUARD_STORAGE_KEY));
            expect(saved).not.toBeNull();
            const parsed = JSON.parse(saved!);
            expect(parsed.ownerKey).toBe(getAuthIdentityScope().key);
            expect(parsed.enabled).toBe(true);
        });
    });

    // ── Radius ──

    describe('setRadius', () => {
        it('updates the guard zone radius', () => {
            AisGuardZone.setRadius(5);
            expect(AisGuardZone.getState().radiusNm).toBe(5);
        });

        it('persists radius to localStorage', () => {
            AisGuardZone.setRadius(3);
            const saved = JSON.parse(localStorage.getItem(authScopedStorageKey(GUARD_STORAGE_KEY))!);
            expect(saved.radiusNm).toBe(3);
        });
    });

    // ── Feature checking ──

    function makeGeoFeature(mmsi: number, lat: number, lon: number, name: string, sog = 5, cog = 0): GeoJSON.Feature {
        return {
            type: 'Feature',
            geometry: { type: 'Point', coordinates: [lon, lat] },
            properties: { mmsi, name, sog, cog, shipType: 'Cargo' },
        };
    }

    describe('checkFeatures', () => {
        it('does nothing when disabled', () => {
            AisGuardZone.setEnabled(false);
            AisGuardZone.checkFeatures(-33.868, 151.209, [makeGeoFeature(123456789, -33.868, 151.21, 'Test')]);
            expect(AisGuardZone.getState().alerts).toEqual([]);
        });

        it('generates alert for target inside radius', () => {
            AisGuardZone.setEnabled(true);
            AisGuardZone.setRadius(5); // 5 NM

            // Target at roughly 0.002° away ≈ ~0.1 NM → inside 5 NM zone
            const newAlerts = AisGuardZone.checkFeatures(-33.868, 151.209, [
                makeGeoFeature(123456789, -33.87, 151.21, 'Nearby Vessel', 8, 270),
            ]);

            expect(newAlerts.length).toBeGreaterThan(0);
            expect(newAlerts[0].mmsi).toBe(123456789);
            expect(newAlerts[0].name).toBe('Nearby Vessel');
        });

        it('does not alert for target outside radius', () => {
            AisGuardZone.setEnabled(true);
            AisGuardZone.setRadius(0.5); // 0.5 NM — very tight

            // Target at ~60 NM away
            AisGuardZone.checkFeatures(-33.868, 151.209, [
                makeGeoFeature(987654321, -34.868, 152.209, 'Far Vessel', 12, 90),
            ]);

            expect(AisGuardZone.getState().alerts).toEqual([]);
        });
    });

    // ── Clear alerts ──

    describe('clearAlerts', () => {
        it('removes all alerts', () => {
            AisGuardZone.setEnabled(true);
            AisGuardZone.setRadius(10);
            AisGuardZone.checkFeatures(0, 0, [makeGeoFeature(111, 0.001, 0.001, 'A')]);

            AisGuardZone.clearAlerts();
            expect(AisGuardZone.getState().alerts).toEqual([]);
        });
    });

    // ── Subscription ──

    describe('subscribe', () => {
        it('notifies on state change', () => {
            const listener = vi.fn();
            const unsub = AisGuardZone.subscribe(listener);

            AisGuardZone.setEnabled(true);
            expect(listener).toHaveBeenCalled();
            expect(listener.mock.calls[0][0].enabled).toBe(true);

            unsub();
        });

        it('unsubscribe stops notifications', () => {
            const listener = vi.fn();
            const unsub = AisGuardZone.subscribe(listener);
            unsub();

            AisGuardZone.setEnabled(true);
            expect(listener).not.toHaveBeenCalled();
        });
    });

    // ── State snapshots ──

    describe('state snapshots', () => {
        it('getState returns object with enabled, radiusNm, and alerts', () => {
            const state = AisGuardZone.getState();
            expect(state).toHaveProperty('enabled');
            expect(state).toHaveProperty('radiusNm');
            expect(state).toHaveProperty('alerts');
        });

        it('mutating returned enabled does not affect internal state', () => {
            const state1 = AisGuardZone.getState();
            state1.enabled = true;

            const state2 = AisGuardZone.getState();
            expect(state2.enabled).toBe(false);
        });
    });

    describe('identity isolation and physical safety', () => {
        it('hides account A config from B while A physical watch keeps detecting targets', () => {
            const accountAScope = getAuthIdentityScope();
            AisGuardZone.setRadius(5);
            AisGuardZone.setEnabled(true);

            setAuthIdentityScope(TEST_ACCOUNT_B);
            expect(AisGuardZone.getState()).toEqual({
                enabled: false,
                radiusNm: 2,
                alerts: [],
            });

            const alerts = AisGuardZone.checkFeatures(-33.868, 151.209, [
                makeGeoFeature(123456789, -33.87, 151.21, 'Account A physical watch'),
            ]);
            expect(alerts).toHaveLength(1);
            expect(AisGuardZone.getState().alerts).toEqual([]);

            setAuthIdentityScope(TEST_ACCOUNT_A);
            expect(AisGuardZone.getState().enabled).toBe(true);
            expect(AisGuardZone.getState().radiusNm).toBe(5);
            expect(AisGuardZone.getState().alerts[0]?.mmsi).toBe(123456789);
            expect(localStorage.getItem(authScopedStorageKey(GUARD_STORAGE_KEY, accountAScope))).toContain(
                '"radiusNm":5',
            );
        });

        it('does not let a delayed account A setter overwrite account B', () => {
            const accountAScope = getAuthIdentityScope();
            AisGuardZone.setRadius(4);

            setAuthIdentityScope(TEST_ACCOUNT_B);
            AisGuardZone.setRadius(40, accountAScope);
            AisGuardZone.setEnabled(true, accountAScope);

            expect(AisGuardZone.getState()).toEqual({
                enabled: false,
                radiusNm: 2,
                alerts: [],
            });
            setAuthIdentityScope(TEST_ACCOUNT_A);
            expect(AisGuardZone.getState().radiusNm).toBe(4);
            expect(AisGuardZone.getState().enabled).toBe(false);
        });

        it('ignores unattributed legacy persisted config', () => {
            localStorage.setItem(GUARD_STORAGE_KEY, JSON.stringify({ enabled: true, radiusNm: 40 }));

            setAuthIdentityScope('guard-new-account');

            expect(AisGuardZone.getState()).toEqual({
                enabled: false,
                radiusNm: 2,
                alerts: [],
            });
        });

        it('restores only a correctly attributed scoped configuration', () => {
            const userId = 'guard-restored-account';
            const ownerKey = `user:${userId}`;
            const scope = { key: ownerKey, userId, generation: getAuthIdentityScope().generation };
            localStorage.setItem(
                authScopedStorageKey(GUARD_STORAGE_KEY, scope),
                JSON.stringify({
                    version: 2,
                    ownerKey,
                    ownerUserId: userId,
                    enabled: true,
                    radiusNm: 7,
                }),
            );

            setAuthIdentityScope(userId);

            expect(AisGuardZone.getState()).toEqual({
                enabled: true,
                radiusNm: 7,
                alerts: [],
            });
        });

        it('rejects an owner-mismatched scoped configuration', () => {
            const userId = 'guard-mismatched-account';
            const ownerKey = `user:${userId}`;
            const scope = { key: ownerKey, userId, generation: getAuthIdentityScope().generation };
            const key = authScopedStorageKey(GUARD_STORAGE_KEY, scope);
            localStorage.setItem(
                key,
                JSON.stringify({
                    version: 2,
                    ownerKey: 'user:someone-else',
                    ownerUserId: 'someone-else',
                    enabled: true,
                    radiusNm: 25,
                }),
            );

            setAuthIdentityScope(userId);

            expect(AisGuardZone.getState()).toEqual({
                enabled: false,
                radiusNm: 2,
                alerts: [],
            });
            expect(localStorage.getItem(key)).toBeNull();
        });
    });
});
