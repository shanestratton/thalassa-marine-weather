/**
 * TemperatureService — Australian apparent temperature tests
 */
import { describe, it, expect } from 'vitest';
import { calculateFeelsLike } from '../services/TemperatureService';

describe('TemperatureService', () => {
    describe('calculateFeelsLike', () => {
        it('returns raw temp when humidity missing', () => {
            expect(calculateFeelsLike(25, undefined as unknown as number, 10)).toBe(25);
        });

        it('calm hot humid day feels hotter', () => {
            const result = calculateFeelsLike(35, 80, 5);
            expect(result).toBeGreaterThan(35);
        });

        it('windy cold dry day feels colder', () => {
            const result = calculateFeelsLike(15, 30, 25);
            // Should be colder than actual but clamped to -5 max drop
            expect(result).toBeLessThan(15);
            expect(result).toBeGreaterThanOrEqual(10); // -5 clamp
        });

        it('clamps feels-like to no more than 5°C below actual', () => {
            // Strong wind, low humidity = big drop, but clamped
            const result = calculateFeelsLike(20, 20, 35);
            expect(result).toBeGreaterThanOrEqual(15);
        });

        it('handles zero wind', () => {
            const result = calculateFeelsLike(25, 60, 0);
            expect(typeof result).toBe('number');
            expect(Number.isFinite(result)).toBe(true);
        });

        it('handles freezing temperatures', () => {
            const result = calculateFeelsLike(0, 50, 15);
            expect(typeof result).toBe('number');
            expect(Number.isFinite(result)).toBe(true);
        });

        it('returns integer (rounded)', () => {
            const result = calculateFeelsLike(25.7, 65, 12);
            expect(result % 1).toBe(0); // Integer
        });

        it('tropical conditions: hot and humid', () => {
            const result = calculateFeelsLike(32, 90, 3);
            // Should feel significantly hotter
            expect(result).toBeGreaterThan(32);
        });

        it('standard sailing conditions', () => {
            // 22°C, moderate humidity, 15kt breeze
            const result = calculateFeelsLike(22, 65, 15);
            expect(result).toBeGreaterThanOrEqual(17); // clamped
            expect(result).toBeLessThanOrEqual(25);
        });
    });
});
