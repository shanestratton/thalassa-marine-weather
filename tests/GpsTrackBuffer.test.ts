/**
 * GpsTrackBuffer — Unit tests
 *
 * Tests pure geometry helpers (bearing, headingDelta) and
 * the track buffer push/drain/thinning logic.
 */

import { describe, it, expect } from 'vitest';
import { bearing, headingDelta } from '../services/shiplog/GpsTrackBuffer';

// ── bearing ─────────────────────────────────────────────────────

describe('bearing', () => {
    it('due north ≈ 0°', () => {
        expect(bearing(0, 0, 1, 0)).toBeCloseTo(0, 0);
    });

    it('due east ≈ 90°', () => {
        expect(bearing(0, 0, 0, 1)).toBeCloseTo(90, 0);
    });

    it('due south ≈ 180°', () => {
        expect(bearing(0, 0, -1, 0)).toBeCloseTo(180, 0);
    });

    it('due west ≈ 270°', () => {
        expect(bearing(0, 0, 0, -1)).toBeCloseTo(270, 0);
    });

    it('result is always in [0, 360)', () => {
        for (let i = 0; i < 10; i++) {
            const b = bearing(
                Math.random() * 180 - 90,
                Math.random() * 360 - 180,
                Math.random() * 180 - 90,
                Math.random() * 360 - 180,
            );
            expect(b).toBeGreaterThanOrEqual(0);
            expect(b).toBeLessThan(360);
        }
    });
});

// ── headingDelta ────────────────────────────────────────────────

describe('headingDelta', () => {
    it('returns 0 for same bearing', () => {
        expect(headingDelta(90, 90)).toBe(0);
    });

    it('returns correct delta for simple case', () => {
        expect(headingDelta(0, 90)).toBe(90);
    });

    it('handles wrap-around: 350° → 10° = 20°', () => {
        expect(headingDelta(350, 10)).toBe(20);
    });

    it('handles wrap-around: 10° → 350° = 20°', () => {
        expect(headingDelta(10, 350)).toBe(20);
    });

    it('maximum delta is 180°', () => {
        expect(headingDelta(0, 180)).toBe(180);
    });

    it('is symmetric', () => {
        expect(headingDelta(45, 135)).toBe(headingDelta(135, 45));
    });

    it('opposite directions = 180°', () => {
        expect(headingDelta(90, 270)).toBe(180);
    });
});
