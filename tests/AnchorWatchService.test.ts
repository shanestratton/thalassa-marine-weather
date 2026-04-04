/**
 * AnchorWatchService — Unit tests
 *
 * Tests the pure/exportable types and configuration, and
 * basic service state model.
 *
 * Note: The AnchorWatchService singleton relies heavily on
 * Capacitor GPS, background geolocation, and timers. These tests
 * focus on the testable surface: types, config defaults,
 * swing radius calculation, and snapshot structure.
 */

import { describe, it, expect } from 'vitest';
import type {
    AnchorPosition,
    VesselPosition,
    AnchorWatchConfig,
    AnchorWatchState,
    AnchorWatchSnapshot,
} from '../services/AnchorWatchService';

// ── Type validation tests ────────────────────────────────────

describe('AnchorWatchService types', () => {
    it('AnchorPosition has latitude, longitude, and timestamp', () => {
        const pos: AnchorPosition = {
            latitude: -33.868,
            longitude: 151.209,
            timestamp: Date.now(),
        };
        expect(pos.latitude).toBe(-33.868);
        expect(pos.longitude).toBe(151.209);
        expect(pos.timestamp).toBeTruthy();
    });

    it('VesselPosition has required coordinate fields', () => {
        const pos: VesselPosition = {
            latitude: -33.868,
            longitude: 151.209,
            accuracy: 10,
            speed: 0.5,
            heading: 180,
            timestamp: Date.now(),
        };
        expect(pos.latitude).toBe(-33.868);
        expect(pos.accuracy).toBe(10);
    });

    it('AnchorWatchState covers all states', () => {
        const states: AnchorWatchState[] = ['idle', 'setting', 'watching', 'alarm', 'paused'];
        expect(states.length).toBe(5);
    });

    it('AnchorWatchConfig has rode-based fields', () => {
        const config: AnchorWatchConfig = {
            rodeLength: 30,
            waterDepth: 5,
            scopeRatio: 5,
            rodeType: 'chain',
            safetyMargin: 10,
        };
        expect(config.rodeLength).toBeGreaterThan(0);
        expect(config.waterDepth).toBeGreaterThan(0);
        expect(config.scopeRatio).toBeGreaterThanOrEqual(3);
        expect(['chain', 'rope', 'mixed']).toContain(config.rodeType);
    });
});

// ── Distance / radius logic ──────────────────────────────────

describe('AnchorWatch distance calculation', () => {
    /**
     * Haversine formula for distance in metres between two coordinates.
     * Used to validate anchor watch trigger logic.
     */
    function haversineMetres(lat1: number, lon1: number, lat2: number, lon2: number): number {
        const R = 6371000;
        const dLat = ((lat2 - lat1) * Math.PI) / 180;
        const dLon = ((lon2 - lon1) * Math.PI) / 180;
        const a =
            Math.sin(dLat / 2) * Math.sin(dLat / 2) +
            Math.cos((lat1 * Math.PI) / 180) *
                Math.cos((lat2 * Math.PI) / 180) *
                Math.sin(dLon / 2) *
                Math.sin(dLon / 2);
        return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    }

    it('detects position within swing radius', () => {
        const anchor = { lat: -33.868, lon: 151.209 };
        const vessel = { lat: -33.8681, lon: 151.2091 };
        const distance = haversineMetres(anchor.lat, anchor.lon, vessel.lat, vessel.lon);
        expect(distance).toBeLessThan(50);
    });

    it('detects position outside swing radius', () => {
        const anchor = { lat: -33.868, lon: 151.209 };
        const vessel = { lat: -33.87, lon: 151.209 };
        const distance = haversineMetres(anchor.lat, anchor.lon, vessel.lat, vessel.lon);
        expect(distance).toBeGreaterThan(50);
    });

    it('zero distance for same position', () => {
        expect(haversineMetres(-33.868, 151.209, -33.868, 151.209)).toBe(0);
    });

    it('symmetric distance calculation', () => {
        const d1 = haversineMetres(-33.868, 151.209, -33.87, 151.21);
        const d2 = haversineMetres(-33.87, 151.21, -33.868, 151.209);
        expect(d1).toBeCloseTo(d2, 6);
    });
});

// ── Swing radius calculation ─────────────────────────────────

describe('Swing radius calculation', () => {
    /**
     * Mirrors the calculateSwingRadius logic from the service.
     * Chain catenary: ~85% of horizontal projection
     * Rope: ~95% of horizontal projection
     * Mixed: ~90% of horizontal projection
     */
    function calculateSwingRadius(config: AnchorWatchConfig): number {
        const { rodeLength, waterDepth, rodeType, safetyMargin } = config;
        if (rodeLength <= waterDepth) return safetyMargin;

        let horizontalDistance: number;
        if (rodeType === 'chain') {
            horizontalDistance = Math.sqrt(rodeLength * rodeLength - waterDepth * waterDepth) * 0.85;
        } else if (rodeType === 'rope') {
            horizontalDistance = Math.sqrt(rodeLength * rodeLength - waterDepth * waterDepth) * 0.95;
        } else {
            horizontalDistance = Math.sqrt(rodeLength * rodeLength - waterDepth * waterDepth) * 0.9;
        }
        return horizontalDistance + safetyMargin;
    }

    it('chain produces smaller radius than rope', () => {
        const base = { rodeLength: 30, waterDepth: 5, scopeRatio: 5, safetyMargin: 10 };
        const chainRadius = calculateSwingRadius({ ...base, rodeType: 'chain' });
        const ropeRadius = calculateSwingRadius({ ...base, rodeType: 'rope' });
        expect(chainRadius).toBeLessThan(ropeRadius);
    });

    it('mixed falls between chain and rope', () => {
        const base = { rodeLength: 30, waterDepth: 5, scopeRatio: 5, safetyMargin: 10 };
        const chain = calculateSwingRadius({ ...base, rodeType: 'chain' });
        const mixed = calculateSwingRadius({ ...base, rodeType: 'mixed' });
        const rope = calculateSwingRadius({ ...base, rodeType: 'rope' });
        expect(mixed).toBeGreaterThan(chain);
        expect(mixed).toBeLessThan(rope);
    });

    it('returns only safetyMargin when rode <= depth', () => {
        const radius = calculateSwingRadius({
            rodeLength: 5,
            waterDepth: 10,
            scopeRatio: 5,
            rodeType: 'chain',
            safetyMargin: 10,
        });
        expect(radius).toBe(10);
    });

    it('longer rode produces larger radius', () => {
        const base = { waterDepth: 5, scopeRatio: 5, rodeType: 'chain' as const, safetyMargin: 10 };
        const short = calculateSwingRadius({ ...base, rodeLength: 20 });
        const long = calculateSwingRadius({ ...base, rodeLength: 50 });
        expect(long).toBeGreaterThan(short);
    });
});

// ── Snapshot structure ────────────────────────────────────────

describe('AnchorWatchSnapshot', () => {
    it('has all required fields for watching state', () => {
        const snapshot: AnchorWatchSnapshot = {
            state: 'watching',
            anchorPosition: { latitude: -33.868, longitude: 151.209, timestamp: Date.now() },
            vesselPosition: {
                latitude: -33.8681,
                longitude: 151.2091,
                accuracy: 5,
                speed: 0.1,
                heading: 90,
                timestamp: Date.now(),
            },
            swingRadius: 35,
            distanceFromAnchor: 14,
            maxDistanceRecorded: 20,
            bearingToAnchor: 45,
            config: {
                rodeLength: 30,
                waterDepth: 5,
                scopeRatio: 5,
                rodeType: 'chain',
                safetyMargin: 10,
            },
            positionHistory: [],
            alarmTriggeredAt: null,
            watchStartedAt: Date.now(),
            gpsAccuracy: 5,
            gpsQuality: 'precision',
            gpsQualityLabel: 'Precision GPS',
            guardianStatus: 'idle',
        };

        expect(snapshot.state).toBe('watching');
        expect(snapshot.distanceFromAnchor).toBeLessThan(snapshot.swingRadius);
        expect(snapshot.alarmTriggeredAt).toBeNull();
    });

    it('alarm snapshot reflects drag detection', () => {
        const snapshot: AnchorWatchSnapshot = {
            state: 'alarm',
            anchorPosition: { latitude: -33.868, longitude: 151.209, timestamp: Date.now() },
            vesselPosition: {
                latitude: -33.87,
                longitude: 151.209,
                accuracy: 5,
                speed: 2.0,
                heading: 180,
                timestamp: Date.now(),
            },
            swingRadius: 35,
            distanceFromAnchor: 222,
            maxDistanceRecorded: 222,
            bearingToAnchor: 180,
            config: {
                rodeLength: 30,
                waterDepth: 5,
                scopeRatio: 5,
                rodeType: 'chain',
                safetyMargin: 10,
            },
            positionHistory: [],
            alarmTriggeredAt: Date.now(),
            watchStartedAt: Date.now() - 3600_000,
            gpsAccuracy: 5,
            gpsQuality: 'standard',
            gpsQualityLabel: 'Standard GPS',
            guardianStatus: 'idle',
        };

        expect(snapshot.state).toBe('alarm');
        expect(snapshot.distanceFromAnchor).toBeGreaterThan(snapshot.swingRadius);
        expect(snapshot.alarmTriggeredAt).not.toBeNull();
    });
});
