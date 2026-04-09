import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
    navStatusColorSimple,
    getWeatherRecommendation,
    formatDistance,
    bearingToCardinal,
    formatElapsed,
} from '../components/anchor-watch/anchorUtils';

describe('navStatusColorSimple', () => {
    it('returns green for underway using engine (0)', () => {
        expect(navStatusColorSimple(0)).toBe('#22c55e');
    });

    it('returns amber for at anchor (1)', () => {
        expect(navStatusColorSimple(1)).toBe('#f59e0b');
    });

    it('returns slate for moored/aground (5, 6)', () => {
        expect(navStatusColorSimple(5)).toBe('#94a3b8');
        expect(navStatusColorSimple(6)).toBe('#94a3b8');
    });

    it('returns cyan for fishing (7)', () => {
        expect(navStatusColorSimple(7)).toBe('#06b6d4');
    });

    it('returns orange for underway sailing / restricted / constrained (2, 3, 4)', () => {
        expect(navStatusColorSimple(2)).toBe('#f97316');
        expect(navStatusColorSimple(3)).toBe('#f97316');
        expect(navStatusColorSimple(4)).toBe('#f97316');
    });

    it('returns red for AIS-SART (14)', () => {
        expect(navStatusColorSimple(14)).toBe('#ef4444');
    });

    it('returns sky-blue for unknown codes', () => {
        expect(navStatusColorSimple(99)).toBe('#38bdf8');
        expect(navStatusColorSimple(-1)).toBe('#38bdf8');
    });
});

describe('getWeatherRecommendation', () => {
    it('returns Storm Scope for wind >= 30kts', () => {
        const r = getWeatherRecommendation(30, 0, 0);
        expect(r.scope).toBe(10);
        expect(r.severity).toBe('red');
        expect(r.label).toBe('Storm Scope');
    });

    it('returns Storm Scope for waves >= 3m', () => {
        const r = getWeatherRecommendation(0, 0, 3);
        expect(r.scope).toBe(10);
        expect(r.severity).toBe('red');
    });

    it('uses gust * 0.85 as effective wind', () => {
        // gust 36 * 0.85 = 30.6 → Storm
        const r = getWeatherRecommendation(5, 36, 0);
        expect(r.severity).toBe('red');
    });

    it('returns Strong Wind for effective wind >= 20', () => {
        const r = getWeatherRecommendation(20, 0, 0);
        expect(r.scope).toBe(8);
        expect(r.severity).toBe('amber');
    });

    it('returns Strong Wind for waves >= 2m', () => {
        const r = getWeatherRecommendation(0, 0, 2);
        expect(r.severity).toBe('amber');
    });

    it('returns Moderate for effective wind >= 10', () => {
        const r = getWeatherRecommendation(10, 0, 0);
        expect(r.scope).toBe(7);
        expect(r.severity).toBe('sky');
    });

    it('returns Light Air for calm conditions', () => {
        const r = getWeatherRecommendation(5, 5, 0.5);
        expect(r.scope).toBe(5);
        expect(r.severity).toBe('emerald');
        expect(r.label).toBe('Light Air');
    });
});

describe('formatDistance', () => {
    it('formats meters under 1000m as meters', () => {
        expect(formatDistance(500)).toBe('500m');
        expect(formatDistance(0)).toBe('0m');
        expect(formatDistance(999)).toBe('999m');
    });

    it('formats >= 1000m as nautical miles', () => {
        expect(formatDistance(1852)).toBe('1.0 NM');
        expect(formatDistance(3704)).toBe('2.0 NM');
    });

    it('rounds meters to whole numbers', () => {
        expect(formatDistance(123.456)).toBe('123m');
    });
});

describe('bearingToCardinal', () => {
    it('converts cardinal directions', () => {
        expect(bearingToCardinal(0)).toBe('N');
        expect(bearingToCardinal(90)).toBe('E');
        expect(bearingToCardinal(180)).toBe('S');
        expect(bearingToCardinal(270)).toBe('W');
    });

    it('converts intercardinal directions', () => {
        expect(bearingToCardinal(45)).toBe('NE');
        expect(bearingToCardinal(135)).toBe('SE');
        expect(bearingToCardinal(225)).toBe('SW');
        expect(bearingToCardinal(315)).toBe('NW');
    });

    it('wraps at 360', () => {
        expect(bearingToCardinal(360)).toBe('N');
    });
});

describe('formatElapsed', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    it('formats minutes only when < 1 hour', () => {
        const now = Date.now();
        vi.setSystemTime(now);
        expect(formatElapsed(now - 30 * 60000)).toBe('30m');
    });

    it('formats hours and minutes', () => {
        const now = Date.now();
        vi.setSystemTime(now);
        expect(formatElapsed(now - 90 * 60000)).toBe('1h 30m');
    });

    it('formats 0m for just-started', () => {
        const now = Date.now();
        vi.setSystemTime(now);
        expect(formatElapsed(now)).toBe('0m');
    });
});
