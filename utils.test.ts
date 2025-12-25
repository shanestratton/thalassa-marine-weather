
import { describe, it, expect } from 'vitest';
import { 
    convertSpeed, 
    convertLength, 
    convertTemp, 
    calculateWindChill, 
    expandCompassDirection, 
    getBeaufort,
    calculateApparentTemp 
} from './utils';

describe('Thalassa Marine Utilities', () => {
    
    describe('Speed Conversions', () => {
        it('converts knots to mph correctly', () => {
            // 10 kts * 1.15078 = 11.5
            expect(convertSpeed(10, 'mph')).toBe(11.5);
        });

        it('converts knots to km/h correctly', () => {
            // 10 kts * 1.852 = 18.5
            expect(convertSpeed(10, 'kmh')).toBe(18.5);
        });

        it('returns raw knots if unit is kts', () => {
            expect(convertSpeed(10, 'kts')).toBe(10);
        });

        it('handles null input', () => {
            expect(convertSpeed(null, 'kts')).toBe(null);
        });
    });

    describe('Length Conversions', () => {
        it('converts feet to meters correctly', () => {
            // 10 ft * 0.3048 = 3.0
            expect(convertLength(10, 'm')).toBe(3.0);
        });

        it('retains feet if unit is ft', () => {
            expect(convertLength(10, 'ft')).toBe(10.0);
        });
    });

    describe('Wind Chill (Marine)', () => {
        it('calculates wind chill valid range', () => {
            // 0C (32F) at 10kts (11.5mph)
            // Formula approx yields -5C
            const wc = calculateWindChill(0, 10, 'C');
            expect(wc).toBeLessThan(0);
        });

        it('returns null if temp is too high (above 10C/50F)', () => {
            expect(calculateWindChill(20, 10, 'C')).toBe(null);
        });
    });

    describe('Compass Logic', () => {
        it('expands cardinal directions', () => {
            expect(expandCompassDirection('N')).toBe('North');
            expect(expandCompassDirection('SSW')).toBe('South-Southwest');
        });

        it('handles unknown direction', () => {
            expect(expandCompassDirection('')).toBe('Unknown');
        });
    });

    describe('Beaufort Scale', () => {
        it('identifies Gale Force', () => {
            const b = getBeaufort(38);
            expect(b.force).toBe(8);
            expect(b.desc).toBe('Gale');
        });

        it('identifies Calm', () => {
            const b = getBeaufort(0);
            expect(b.force).toBe(0);
            expect(b.desc).toBe('Calm');
        });
    });

    describe('Apparent Temperature (BOM)', () => {
        it('calculates humid heat index correctly', () => {
            // 30C, 80% RH, 5kts wind
            const at = calculateApparentTemp(30, 80, 5);
            // Should feel significantly hotter (~38C)
            expect(at).toBeGreaterThan(30);
        });
    });
});
