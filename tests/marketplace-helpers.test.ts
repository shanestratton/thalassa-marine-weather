import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    haversineNm,
    timeAgo,
    formatPrice,
    getConditionColor,
    getAvatarGradient,
    AVATAR_GRADIENTS,
    MAX_PHOTOS,
} from '../components/marketplace/helpers';

describe('marketplace/helpers', () => {
    // ── haversineNm ──────────────────────────────────────────────

    describe('haversineNm', () => {
        it('returns 0 for same point', () => {
            expect(haversineNm(0, 0, 0, 0)).toBe(0);
        });

        it('calculates Sydney to Auckland (~1100nm)', () => {
            const dist = haversineNm(-33.87, 151.21, -36.85, 174.76);
            expect(dist).toBeGreaterThan(1050);
            expect(dist).toBeLessThan(1200);
        });

        it('calculates equator segment (~60nm per degree)', () => {
            const dist = haversineNm(0, 0, 0, 1);
            expect(dist).toBeGreaterThan(59);
            expect(dist).toBeLessThan(61);
        });

        it('handles negative coordinates', () => {
            const dist = haversineNm(-45, -170, -45, 170);
            expect(dist).toBeGreaterThan(0);
        });

        it('handles antipodal points (~10800nm)', () => {
            const dist = haversineNm(0, 0, 0, 180);
            expect(dist).toBeGreaterThan(10700);
            expect(dist).toBeLessThan(10900);
        });
    });

    // ── timeAgo ──────────────────────────────────────────────────

    describe('timeAgo', () => {
        beforeEach(() => {
            vi.useFakeTimers();
            vi.setSystemTime(new Date('2026-03-15T12:00:00Z'));
        });

        afterEach(() => {
            vi.useRealTimers();
        });

        it('returns "just now" for < 1 minute', () => {
            expect(timeAgo('2026-03-15T12:00:00Z')).toBe('just now');
            expect(timeAgo('2026-03-15T11:59:30Z')).toBe('just now');
        });

        it('returns minutes for < 1 hour', () => {
            expect(timeAgo('2026-03-15T11:30:00Z')).toBe('30m ago');
            expect(timeAgo('2026-03-15T11:55:00Z')).toBe('5m ago');
        });

        it('returns hours for < 24 hours', () => {
            expect(timeAgo('2026-03-15T06:00:00Z')).toBe('6h ago');
            expect(timeAgo('2026-03-14T13:00:00Z')).toBe('23h ago');
        });

        it('returns days for < 7 days', () => {
            expect(timeAgo('2026-03-13T12:00:00Z')).toBe('2d ago');
            expect(timeAgo('2026-03-09T12:00:00Z')).toBe('6d ago');
        });

        it('returns date string for >= 7 days', () => {
            const result = timeAgo('2026-03-01T12:00:00Z');
            // Should be a locale date string, not "Xd ago"
            expect(result).not.toContain('d ago');
            expect(result).toBeTruthy();
        });
    });

    // ── formatPrice ──────────────────────────────────────────────

    describe('formatPrice', () => {
        it('formats integer AUD prices', () => {
            expect(formatPrice(250, 'AUD')).toBe('A$250');
        });

        it('formats decimal USD prices', () => {
            expect(formatPrice(19.99, 'USD')).toContain('$');
            expect(formatPrice(19.99, 'USD')).toContain('19.99');
        });

        it('formats EUR with symbol', () => {
            expect(formatPrice(100, 'EUR')).toBe('€100');
        });

        it('formats GBP with symbol', () => {
            expect(formatPrice(50, 'GBP')).toBe('£50');
        });

        it('formats NZD with symbol', () => {
            expect(formatPrice(75, 'NZD')).toBe('NZ$75');
        });

        it('handles unknown currencies with code prefix', () => {
            expect(formatPrice(100, 'JPY')).toContain('JPY');
        });

        it('formats large integers with locale separators', () => {
            const result = formatPrice(1500, 'USD');
            expect(result).toContain('$');
        });
    });

    // ── getConditionColor ────────────────────────────────────────

    describe('getConditionColor', () => {
        it('returns emerald for New', () => {
            expect(getConditionColor('New')).toContain('emerald');
        });

        it('returns sky for Like New', () => {
            expect(getConditionColor('Like New')).toContain('sky');
        });

        it('returns amber for Used - Good', () => {
            expect(getConditionColor('Used - Good')).toContain('amber');
        });

        it('returns amber for Used - Fair', () => {
            expect(getConditionColor('Used - Fair')).toContain('amber');
        });

        it('returns red for Needs Repair', () => {
            expect(getConditionColor('Needs Repair')).toContain('red');
        });

        it('returns slate for unknown conditions', () => {
            expect(getConditionColor('Unknown')).toContain('slate');
            expect(getConditionColor('')).toContain('slate');
        });
    });

    // ── getAvatarGradient ────────────────────────────────────────

    describe('getAvatarGradient', () => {
        it('returns a valid gradient class', () => {
            const result = getAvatarGradient('user-123');
            expect(AVATAR_GRADIENTS).toContain(result);
        });

        it('returns consistent results for same input', () => {
            expect(getAvatarGradient('abc')).toBe(getAvatarGradient('abc'));
        });

        it('returns different results for different inputs', () => {
            // With 6 gradients, most different IDs should produce different results
            const results = new Set(['a', 'b', 'c', 'd', 'e'].map(getAvatarGradient));
            expect(results.size).toBeGreaterThan(1);
        });

        it('handles empty string', () => {
            const result = getAvatarGradient('');
            expect(AVATAR_GRADIENTS).toContain(result);
        });
    });

    // ── Constants ──────────────────────────────────────────────

    describe('constants', () => {
        it('MAX_PHOTOS is 20', () => {
            expect(MAX_PHOTOS).toBe(20);
        });

        it('AVATAR_GRADIENTS has expected length', () => {
            expect(AVATAR_GRADIENTS.length).toBe(6);
        });
    });
});
