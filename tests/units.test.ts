
import { describe, it, expect } from 'vitest';
import { ktsToMph, ktsToKmh, celsiusToFahrenheit, fahrenheitToCelsius, ftToM, mToFt } from '../utils/units';

describe('Unit Conversions', () => {
    describe('Speed', () => {
        it('should convert knots to mph', () => {
            expect(ktsToMph(1)).toBeCloseTo(1.15, 1);
            expect(ktsToMph(10)).toBeCloseTo(11.5, 1);
        });

        it('should convert knots to kmh', () => {
            expect(ktsToKmh(1)).toBeCloseTo(1.852, 2);
        });
    });

    describe('Temperature', () => {
        it('should convert C to F', () => {
            expect(celsiusToFahrenheit(0)).toBe(32);
            expect(celsiusToFahrenheit(100)).toBe(212);
        });

        it('should convert F to C', () => {
            expect(fahrenheitToCelsius(32)).toBe(0);
            expect(fahrenheitToCelsius(212)).toBe(100);
        });
    });

    describe('Distance/Length', () => {
        it('should convert ft to m', () => {
            expect(ftToM(3.28084)).toBeCloseTo(1, 2);
        });

        it('should convert m to ft', () => {
            expect(mToFt(1)).toBeCloseTo(3.28084, 2);
        });
    });
});
