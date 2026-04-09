/**
 * AisGuardZone — Unit tests
 *
 * Tests the virtual radar guard zone: enable/disable, radius config,
 * feature checking, alert generation, and state management.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AisGuardZone } from '../services/AisGuardZone';

describe('AisGuardZone', () => {
    beforeEach(() => {
        localStorage.clear();
        AisGuardZone.setEnabled(false);
        AisGuardZone.setRadius(2); // Reset to default
        AisGuardZone.clearAlerts();
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
            const saved = localStorage.getItem('thalassa_guard_zone');
            expect(saved).not.toBeNull();
            const parsed = JSON.parse(saved!);
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
            const saved = JSON.parse(localStorage.getItem('thalassa_guard_zone')!);
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
});
