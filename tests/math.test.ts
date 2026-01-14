
import { describe, it, expect } from 'vitest';
import { calculateHeatIndex, calculateWindChill, calculateDistance, getSunTimes } from '../utils/math';

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
            const dist = calculateDistance(40.7128, -74.0060, 51.5074, -0.1278);
            expect(dist).toBeGreaterThan(5500); // KM (approx 5570km)
            expect(dist).toBeLessThan(5600);
        });

        it('should return 0 for same location', () => {
            expect(calculateDistance(10, 10, 10, 10)).toBe(0);
        });
    });
});
