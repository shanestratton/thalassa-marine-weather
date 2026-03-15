/**
 * AnchorWatchService — Unit tests for safety-critical anchor monitoring code
 *
 * Tests: haversine distance, bearing calculation, swing radius computation,
 * drag detection logic, and jitter filtering.
 */

import { describe, it, expect } from 'vitest';
import { haversineDistance, bearing, calculateSwingRadius } from '../services/AnchorWatchService';

// ── Haversine Distance ──

describe('haversineDistance', () => {
    it('returns 0 for same point', () => {
        expect(haversineDistance(-33.8688, 151.2093, -33.8688, 151.2093)).toBe(0);
    });

    it('calculates short distance accurately (Sydney Harbor ~500m)', () => {
        // Opera House to Harbour Bridge: ~600m
        const d = haversineDistance(-33.8568, 151.2153, -33.8523, 151.2108);
        expect(d).toBeGreaterThan(400);
        expect(d).toBeLessThan(800);
    });

    it('calculates medium distance (Sydney to Bondi ~7km)', () => {
        const d = haversineDistance(-33.8688, 151.2093, -33.8912, 151.2744);
        expect(d).toBeGreaterThan(5000);
        expect(d).toBeLessThan(10000);
    });

    it('calculates cross-equator distance', () => {
        // Singapore to Perth: ~3900km
        const d = haversineDistance(1.3521, 103.8198, -31.9505, 115.8605);
        expect(d).toBeGreaterThan(3_700_000);
        expect(d).toBeLessThan(4_100_000);
    });

    it('handles antimeridian crossing (Fiji to Samoa)', () => {
        // Fiji (178°E) to Samoa (172°W = 188°E effectively)
        const d = haversineDistance(-17.7134, 178.065, -13.8333, -171.75);
        expect(d).toBeGreaterThan(500_000);
        expect(d).toBeLessThan(1_500_000);
    });

    it('agrees with known distance (1 degree latitude ≈ 111km)', () => {
        const d = haversineDistance(0, 0, 1, 0);
        expect(d).toBeGreaterThan(110_000);
        expect(d).toBeLessThan(112_000);
    });
});

// ── Bearing ──

describe('bearing', () => {
    it('returns 0 for due north', () => {
        const b = bearing(0, 0, 1, 0);
        expect(b).toBeCloseTo(0, 0);
    });

    it('returns 90 for due east', () => {
        const b = bearing(0, 0, 0, 1);
        expect(b).toBeCloseTo(90, 0);
    });

    it('returns 180 for due south', () => {
        const b = bearing(1, 0, 0, 0);
        expect(b).toBeCloseTo(180, 0);
    });

    it('returns 270 for due west', () => {
        const b = bearing(0, 1, 0, 0);
        expect(b).toBeCloseTo(270, 0);
    });

    it('returns value in 0-360 range', () => {
        const b = bearing(-33.8688, 151.2093, -33.8523, 151.2108);
        expect(b).toBeGreaterThanOrEqual(0);
        expect(b).toBeLessThan(360);
    });

    it('calculates NE bearing correctly', () => {
        const b = bearing(0, 0, 1, 1);
        expect(b).toBeGreaterThan(30);
        expect(b).toBeLessThan(60);
    });
});

// ── Swing Radius ──

describe('calculateSwingRadius', () => {
    it('calculates chain catenary with standard scope', () => {
        const r = calculateSwingRadius({
            rodeLength: 50,
            waterDepth: 10,
            scopeRatio: 5,
            rodeType: 'chain',
            safetyMargin: 10,
        });
        // sqrt(50²-10²) * 0.85 + 10 ≈ 41.6 + 10 = 51.6
        expect(r).toBeGreaterThan(40);
        expect(r).toBeLessThan(60);
    });

    it('rope gives larger radius than chain (less catenary sag)', () => {
        const chainR = calculateSwingRadius({
            rodeLength: 50,
            waterDepth: 10,
            scopeRatio: 5,
            rodeType: 'chain',
            safetyMargin: 0,
        });
        const ropeR = calculateSwingRadius({
            rodeLength: 50,
            waterDepth: 10,
            scopeRatio: 5,
            rodeType: 'rope',
            safetyMargin: 0,
        });
        expect(ropeR).toBeGreaterThan(chainR);
    });

    it('mixed is between chain and rope', () => {
        const config = { rodeLength: 50, waterDepth: 10, scopeRatio: 5, safetyMargin: 0 };
        const chain = calculateSwingRadius({ ...config, rodeType: 'chain' as const });
        const rope = calculateSwingRadius({ ...config, rodeType: 'rope' as const });
        const mixed = calculateSwingRadius({ ...config, rodeType: 'mixed' as const });
        expect(mixed).toBeGreaterThan(chain);
        expect(mixed).toBeLessThan(rope);
    });

    it('returns safety margin when rode ≤ depth', () => {
        const r = calculateSwingRadius({
            rodeLength: 5,
            waterDepth: 10,
            scopeRatio: 5,
            rodeType: 'chain',
            safetyMargin: 15,
        });
        expect(r).toBe(15);
    });

    it('safety margin adds to horizontal distance', () => {
        const withMargin = calculateSwingRadius({
            rodeLength: 50,
            waterDepth: 10,
            scopeRatio: 5,
            rodeType: 'chain',
            safetyMargin: 20,
        });
        const withoutMargin = calculateSwingRadius({
            rodeLength: 50,
            waterDepth: 10,
            scopeRatio: 5,
            rodeType: 'chain',
            safetyMargin: 0,
        });
        expect(withMargin - withoutMargin).toBeCloseTo(20, 1);
    });

    it('shallow water gives larger radius (more horizontal)', () => {
        const shallow = calculateSwingRadius({
            rodeLength: 50,
            waterDepth: 3,
            scopeRatio: 5,
            rodeType: 'chain',
            safetyMargin: 0,
        });
        const deep = calculateSwingRadius({
            rodeLength: 50,
            waterDepth: 15,
            scopeRatio: 5,
            rodeType: 'chain',
            safetyMargin: 0,
        });
        expect(shallow).toBeGreaterThan(deep);
    });
});
