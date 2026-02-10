/**
 * Unit tests for utils/math.ts — Weather calculation functions
 * Tests cover wind chill (NWS), heat index, haversine distance, and sun times
 */
import { describe, it, expect } from 'vitest';
import {
    calculateWindChill,
    calculateHeatIndex,
    calculateApparentTemp,
    calculateFeelsLike,
    calculateDistance,
    getSunTimes,
} from './math';

describe('calculateWindChill', () => {
    it('returns null when temp > 50°F (10°C)', () => {
        expect(calculateWindChill(15, 20, 'C')).toBeNull();
    });

    it('returns null when wind < 3 mph', () => {
        expect(calculateWindChill(0, 1, 'C')).toBeNull();
    });

    it('calculates wind chill for cold + windy (Celsius)', () => {
        const wc = calculateWindChill(5, 20, 'C');
        expect(wc).not.toBeNull();
        expect(wc!).toBeLessThan(5); // Wind chill should be lower
    });

    it('calculates wind chill in Fahrenheit', () => {
        const wc = calculateWindChill(40, 20, 'F');
        expect(wc).not.toBeNull();
        expect(wc!).toBeLessThan(40);
    });

    it('stronger wind = lower wind chill', () => {
        const wc10 = calculateWindChill(0, 10, 'C')!;
        const wc30 = calculateWindChill(0, 30, 'C')!;
        expect(wc30).toBeLessThan(wc10);
    });
});

describe('calculateHeatIndex', () => {
    it('returns null when temp < 80°F (~26.7°C)', () => {
        expect(calculateHeatIndex(20, 50)).toBeNull();
    });

    it('calculates heat index for hot + humid', () => {
        const hi = calculateHeatIndex(35, 80);
        expect(hi).not.toBeNull();
        expect(hi!).toBeGreaterThan(35); // Feels hotter
    });

    it('higher humidity = higher heat index', () => {
        const hi50 = calculateHeatIndex(35, 50)!;
        const hi90 = calculateHeatIndex(35, 90)!;
        expect(hi90).toBeGreaterThan(hi50);
    });
});

describe('calculateApparentTemp', () => {
    it('returns null for null/undefined temp', () => {
        expect(calculateApparentTemp(undefined as unknown as number, 50, 10)).toBeNull();
    });

    it('returns a number for valid inputs', () => {
        const at = calculateApparentTemp(25, 60, 10);
        expect(at).not.toBeNull();
        expect(typeof at).toBe('number');
    });

    it('more wind = lower apparent temp', () => {
        const calm = calculateApparentTemp(25, 60, 0)!;
        const windy = calculateApparentTemp(25, 60, 30)!;
        expect(windy).toBeLessThan(calm);
    });
});

describe('calculateFeelsLike', () => {
    it('returns a number', () => {
        expect(typeof calculateFeelsLike(25, 70, 10)).toBe('number');
    });

    it('higher humidity raises feels-like', () => {
        const dry = calculateFeelsLike(30, 20, 5);
        const humid = calculateFeelsLike(30, 90, 5);
        expect(humid).toBeGreaterThan(dry);
    });

    it('higher wind lowers feels-like', () => {
        const calm = calculateFeelsLike(25, 60, 0);
        const gale = calculateFeelsLike(25, 60, 40);
        expect(gale).toBeLessThan(calm);
    });
});

describe('calculateDistance (Haversine)', () => {
    it('returns 0 for same point', () => {
        expect(calculateDistance(-27.47, 153.02, -27.47, 153.02)).toBe(0);
    });

    it('Brisbane to Sydney ≈ 730km', () => {
        const d = calculateDistance(-27.47, 153.02, -33.87, 151.21);
        expect(d).toBeGreaterThan(700);
        expect(d).toBeLessThan(800);
    });

    it('London to New York ≈ 5570km', () => {
        const d = calculateDistance(51.5, -0.12, 40.7, -74.0);
        expect(d).toBeGreaterThan(5500);
        expect(d).toBeLessThan(5700);
    });

    it('is symmetric: A→B = B→A', () => {
        const ab = calculateDistance(-27, 153, -33, 151);
        const ba = calculateDistance(-33, 151, -27, 153);
        expect(ab).toBeCloseTo(ba, 5);
    });
});

describe('getSunTimes', () => {
    it('returns sunrise and sunset for Brisbane', () => {
        const result = getSunTimes(new Date('2024-06-21'), -27.47, 153.02);
        expect(result).not.toBeNull();
        expect(result!.sunrise).toBeInstanceOf(Date);
        expect(result!.sunset).toBeInstanceOf(Date);
    });

    it('sunrise and sunset are distinct times', () => {
        const result = getSunTimes(new Date('2024-06-21'), -27.47, 153.02)!;
        expect(result.sunrise.getTime()).not.toBe(result.sunset.getTime());
    });

    it('returns null for polar regions during polar night/day', () => {
        // North Pole during winter solstice — no sunrise
        const result = getSunTimes(new Date('2024-12-21'), 89.0, 0);
        expect(result).toBeNull();
    });
});
