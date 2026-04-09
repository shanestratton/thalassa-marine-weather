import { describe, it, expect } from 'vitest';
import {
    calculateHeatIndex,
    calculateWindChill,
    calculateApparentTemp,
    calculateFeelsLike,
    calculateDistance,
    getSunTimes,
} from '../utils/math';

describe('Math Utils', () => {
    describe('calculateHeatIndex', () => {
        it('should return null for temps below 80F', () => {
            expect(calculateHeatIndex(26, 50)).toBeNull();
        });

        it('should calculate correctly for 90F/50%', () => {
            const hi = calculateHeatIndex(90, 50);
            expect(hi).toBeGreaterThan(90);
        });
    });

    describe('calculateWindChill', () => {
        it('should return null for temps above 50F', () => {
            expect(calculateWindChill(51, 10, 'F')).toBeNull();
        });

        it('should return null for wind below 3mph', () => {
            expect(calculateWindChill(30, 2, 'F')).toBeNull();
        });

        it('should calculate correctly for 30F/20mph', () => {
            const wc = calculateWindChill(30, 20, 'F');
            expect(wc).toBeLessThan(30);
        });
    });

    describe('calculateDistance', () => {
        it('should calculate distance between two points', () => {
            // New York to London approx 3461 miles / 5570 km / 3007 nm
            // 40.7128° N, 74.0060° W -> 51.5074° N, 0.1278° W
            const dist = calculateDistance(40.7128, -74.006, 51.5074, -0.1278);
            expect(dist).toBeGreaterThan(5500); // KM (approx 5570km)
            expect(dist).toBeLessThan(5600);
        });

        it('should return 0 for same location', () => {
            expect(calculateDistance(10, 10, 10, 10)).toBe(0);
        });

        it('1 degree lat ≈ 111 km', () => {
            const dist = calculateDistance(0, 0, 1, 0);
            expect(dist).toBeGreaterThan(110);
            expect(dist).toBeLessThan(112);
        });

        it('is symmetric', () => {
            const ab = calculateDistance(-33, 151, -27, 153);
            const ba = calculateDistance(-27, 153, -33, 151);
            expect(ab).toBeCloseTo(ba, 5);
        });
    });

    describe('calculateApparentTemp', () => {
        it('returns apparent temperature (BOM formula)', () => {
            const at = calculateApparentTemp(30, 80, 5);
            expect(at).not.toBeNull();
            expect(typeof at).toBe('number');
        });

        it('wind cooling reduces apparent temp', () => {
            const calm = calculateApparentTemp(25, 50, 0)!;
            const windy = calculateApparentTemp(25, 50, 25)!;
            expect(windy).toBeLessThan(calm);
        });

        it('humidity increases apparent temp', () => {
            const dry = calculateApparentTemp(30, 20, 10)!;
            const humid = calculateApparentTemp(30, 90, 10)!;
            expect(humid).toBeGreaterThan(dry);
        });

        it('returns null for undefined temp', () => {
            expect(calculateApparentTemp(undefined as any, 50, 10)).toBeNull();
        });
    });

    describe('calculateFeelsLike', () => {
        it('returns a number', () => {
            expect(typeof calculateFeelsLike(25, 70, 10)).toBe('number');
        });

        it('rounds to 1 decimal place', () => {
            const fl = calculateFeelsLike(25, 70, 10);
            const parts = fl.toString().split('.');
            expect(parts.length <= 2).toBe(true);
            if (parts[1]) expect(parts[1].length).toBeLessThanOrEqual(1);
        });
    });

    describe('getSunTimes', () => {
        it('calculates sunrise and sunset for Brisbane', () => {
            const result = getSunTimes(new Date('2024-06-21'), -27.47, 153.02);
            expect(result).not.toBeNull();
            expect(result!.sunrise).toBeInstanceOf(Date);
            expect(result!.sunset).toBeInstanceOf(Date);
            // Brisbane sunrise ~20:30 UTC (6:30 AEST), sunset ~7:30 UTC (17:30 AEST)
            // In UTC, sunrise hour > sunset hour due to timezone offset
            expect(result!.sunrise.getUTCHours()).toBeGreaterThanOrEqual(19);
            expect(result!.sunset.getUTCHours()).toBeLessThanOrEqual(8);
        });

        it('sunrise is before sunset at equator', () => {
            const result = getSunTimes(new Date('2024-03-20'), 0, 0);
            expect(result).not.toBeNull();
            expect(result!.sunrise.getTime()).toBeLessThan(result!.sunset.getTime());
        });

        it('returns null for extreme polar latitude in winter', () => {
            const result = getSunTimes(new Date('2024-12-21'), 89, 0);
            expect(result).toBeNull();
        });
    });
});
