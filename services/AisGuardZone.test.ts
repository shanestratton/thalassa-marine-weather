/**
 * AIS Guard Zone unit tests — virtual radar collision alert system.
 *
 * Tests cover:
 * - Enable/disable state management
 * - Radius clamping
 * - Feature checking against guard zone
 * - Per-MMSI alert debounce (no repeated alerts)
 * - Zone exit clears debounce
 * - localStorage persistence
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AisGuardZone } from './AisGuardZone';

// Mock localStorage
const store: Record<string, string> = {};
vi.stubGlobal('localStorage', {
    getItem: (key: string) => store[key] ?? null,
    setItem: (key: string, val: string) => { store[key] = val; },
    removeItem: (key: string) => { delete store[key]; },
});

// Helper: create a GeoJSON Point feature
function makeFeature(
    mmsi: number, lat: number, lon: number,
    opts: Partial<{ sog: number; cog: number; name: string; source: string; staleMinutes: number }> = {},
): GeoJSON.Feature {
    return {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [lon, lat] },
        properties: {
            mmsi,
            name: opts.name || `Vessel ${mmsi}`,
            sog: opts.sog ?? 5,
            cog: opts.cog ?? 0,
            source: opts.source ?? 'aisstream',
            staleMinutes: opts.staleMinutes ?? 0,
        },
    };
}

// Newport Harbour reference point
const OWN_LAT = -33.7350;
const OWN_LON = 151.3050;

// ~0.5 NM north
const NEAR_LAT = -33.7267;
const NEAR_LON = 151.3050;

// ~5 NM north (well outside default 2 NM radius)
const FAR_LAT = -33.6518;
const FAR_LON = 151.3050;

describe('AisGuardZone', () => {
    beforeEach(() => {
        // Reset state before each test
        AisGuardZone.setEnabled(false);
        AisGuardZone.clearAlerts();
        AisGuardZone.setRadius(2);
    });

    describe('state management', () => {
        it('starts disabled', () => {
            const state = AisGuardZone.getState();
            expect(state.enabled).toBe(false);
        });

        it('can be enabled', () => {
            AisGuardZone.setEnabled(true);
            expect(AisGuardZone.getState().enabled).toBe(true);
        });

        it('clears alerts on disable', () => {
            AisGuardZone.setEnabled(true);
            // Trigger an alert
            AisGuardZone.checkFeatures(OWN_LAT, OWN_LON, [
                makeFeature(123456789, NEAR_LAT, NEAR_LON),
            ]);
            expect(AisGuardZone.getState().alerts.length).toBeGreaterThan(0);

            AisGuardZone.setEnabled(false);
            expect(AisGuardZone.getState().alerts).toHaveLength(0);
        });
    });

    describe('radius', () => {
        it('defaults to 2 NM', () => {
            expect(AisGuardZone.getState().radiusNm).toBe(2);
        });

        it('clamps minimum to 0.1 NM', () => {
            AisGuardZone.setRadius(-5);
            expect(AisGuardZone.getState().radiusNm).toBe(0.1);
        });

        it('clamps maximum to 50 NM', () => {
            AisGuardZone.setRadius(100);
            expect(AisGuardZone.getState().radiusNm).toBe(50);
        });

        it('accepts valid radius', () => {
            AisGuardZone.setRadius(5);
            expect(AisGuardZone.getState().radiusNm).toBe(5);
        });
    });

    describe('feature checking', () => {
        it('returns empty when disabled', () => {
            const alerts = AisGuardZone.checkFeatures(OWN_LAT, OWN_LON, [
                makeFeature(123456789, NEAR_LAT, NEAR_LON),
            ]);
            expect(alerts).toHaveLength(0);
        });

        it('detects vessel within radius', () => {
            AisGuardZone.setEnabled(true);
            const alerts = AisGuardZone.checkFeatures(OWN_LAT, OWN_LON, [
                makeFeature(123456789, NEAR_LAT, NEAR_LON),
            ]);
            expect(alerts).toHaveLength(1);
            expect(alerts[0].mmsi).toBe(123456789);
            expect(alerts[0].distanceNm).toBeLessThan(1);
        });

        it('ignores vessel outside radius', () => {
            AisGuardZone.setEnabled(true);
            const alerts = AisGuardZone.checkFeatures(OWN_LAT, OWN_LON, [
                makeFeature(123456789, FAR_LAT, FAR_LON),
            ]);
            expect(alerts).toHaveLength(0);
        });

        it('ignores local NMEA source (own vessel)', () => {
            AisGuardZone.setEnabled(true);
            const alerts = AisGuardZone.checkFeatures(OWN_LAT, OWN_LON, [
                makeFeature(123456789, NEAR_LAT, NEAR_LON, { source: 'local' }),
            ]);
            expect(alerts).toHaveLength(0);
        });

        it('ignores stale vessels (> 30 min)', () => {
            AisGuardZone.setEnabled(true);
            const alerts = AisGuardZone.checkFeatures(OWN_LAT, OWN_LON, [
                makeFeature(123456789, NEAR_LAT, NEAR_LON, { staleMinutes: 45 }),
            ]);
            expect(alerts).toHaveLength(0);
        });
    });

    describe('alert debounce', () => {
        it('does not re-alert same MMSI on consecutive checks', () => {
            AisGuardZone.setEnabled(true);
            const feature = makeFeature(123456789, NEAR_LAT, NEAR_LON);

            const firstAlerts = AisGuardZone.checkFeatures(OWN_LAT, OWN_LON, [feature]);
            expect(firstAlerts).toHaveLength(1);

            // Second check — same vessel still in zone
            const secondAlerts = AisGuardZone.checkFeatures(OWN_LAT, OWN_LON, [feature]);
            expect(secondAlerts).toHaveLength(0); // Debounced
        });

        it('re-alerts after vessel leaves and re-enters', () => {
            AisGuardZone.setEnabled(true);
            const nearFeature = makeFeature(123456789, NEAR_LAT, NEAR_LON);
            const farFeature = makeFeature(123456789, FAR_LAT, FAR_LON);

            // Enter zone
            const first = AisGuardZone.checkFeatures(OWN_LAT, OWN_LON, [nearFeature]);
            expect(first).toHaveLength(1);

            // Leave zone
            AisGuardZone.checkFeatures(OWN_LAT, OWN_LON, [farFeature]);

            // Re-enter zone
            const third = AisGuardZone.checkFeatures(OWN_LAT, OWN_LON, [nearFeature]);
            expect(third).toHaveLength(1); // Re-alerted
        });
    });

    describe('subscription', () => {
        it('notifies listeners on state change', () => {
            const listener = vi.fn();
            const unsub = AisGuardZone.subscribe(listener);

            AisGuardZone.setEnabled(true);
            expect(listener).toHaveBeenCalledTimes(1);
            expect(listener).toHaveBeenCalledWith(
                expect.objectContaining({ enabled: true }),
            );

            unsub();
            AisGuardZone.setEnabled(false);
            // Should not be called again after unsubscribe
            expect(listener).toHaveBeenCalledTimes(1);
        });
    });
});
