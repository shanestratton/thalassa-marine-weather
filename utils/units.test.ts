/**
 * Unit tests for utils/units.ts — Unit conversion functions
 * Tests cover null handling, conversion accuracy, and edge cases
 */
import { describe, it, expect } from 'vitest';
import {
    ktsToMph, ktsToKmh, ktsToMps,
    ftToM, mToFt,
    kgToLbs, lbsToKg,
    celsiusToFahrenheit, fahrenheitToCelsius,
    convertSpeed, convertLength, convertWeight,
    convertTemp, convertDistance, convertMetersTo, convertPrecip
} from './units';

// ── Primitive Converters ─────────────────────────────────────────

describe('ktsToMph', () => {
    it('converts 0 knots to 0 mph', () => expect(ktsToMph(0)).toBe(0));
    it('converts 10 knots to ~11.5 mph', () => expect(ktsToMph(10)).toBeCloseTo(11.5078, 1));
    it('converts 100 knots to ~115 mph', () => expect(ktsToMph(100)).toBeCloseTo(115.078, 0));
});

describe('ktsToKmh', () => {
    it('converts 10 knots to 18.52 km/h', () => expect(ktsToKmh(10)).toBeCloseTo(18.52, 1));
});

describe('ktsToMps', () => {
    it('converts 10 knots to ~5.14 m/s', () => expect(ktsToMps(10)).toBeCloseTo(5.14444, 1));
});

describe('ftToM / mToFt', () => {
    it('converts 1 foot to ~0.3048 meters', () => expect(ftToM(1)).toBeCloseTo(0.3048, 4));
    it('converts 1 meter to ~3.281 feet', () => expect(mToFt(1)).toBeCloseTo(3.28084, 2));
    it('round-trips: ft → m → ft', () => expect(mToFt(ftToM(42))).toBeCloseTo(42, 3));
});

describe('kgToLbs / lbsToKg', () => {
    it('converts 1 kg to ~2.205 lbs', () => expect(kgToLbs(1)).toBeCloseTo(2.20462, 2));
    it('converts 1 lbs to ~0.454 kg', () => expect(lbsToKg(1)).toBeCloseTo(0.453592, 2));
    it('round-trips: kg → lbs → kg', () => expect(lbsToKg(kgToLbs(75))).toBeCloseTo(75, 2));
});

describe('celsiusToFahrenheit / fahrenheitToCelsius', () => {
    it('freezing point: 0°C = 32°F', () => expect(celsiusToFahrenheit(0)).toBe(32));
    it('boiling point: 100°C = 212°F', () => expect(celsiusToFahrenheit(100)).toBe(212));
    it('body temp: 37°C = 98.6°F', () => expect(celsiusToFahrenheit(37)).toBeCloseTo(98.6, 1));
    it('round-trips: C → F → C', () => expect(fahrenheitToCelsius(celsiusToFahrenheit(25))).toBeCloseTo(25, 5));
    it('negative: -40° is same in both', () => expect(celsiusToFahrenheit(-40)).toBeCloseTo(-40, 0));
});

// ── Generic "Model to View" Converters ─────────────────────────

describe('convertSpeed', () => {
    it('returns null for null input', () => expect(convertSpeed(null, 'kts')).toBeNull());
    it('returns null for undefined input', () => expect(convertSpeed(undefined, 'mph')).toBeNull());
    it('knots passes through', () => expect(convertSpeed(10, 'kts')).toBe(10));
    it('converts to mph', () => expect(convertSpeed(10, 'mph')).toBeCloseTo(11.5, 0));
    it('converts to kmh', () => expect(convertSpeed(10, 'kmh')).toBeCloseTo(18.5, 0));
    it('converts to mps', () => expect(convertSpeed(10, 'mps')).toBeCloseTo(5.1, 0));
});

describe('convertLength', () => {
    it('returns null for null', () => expect(convertLength(null, 'ft')).toBeNull());
    it('feet passes through', () => expect(convertLength(30, 'ft')).toBe(30));
    it('converts to meters', () => expect(convertLength(30, 'm')).toBeCloseTo(9.1, 0));
});

describe('convertWeight', () => {
    it('returns null for null', () => expect(convertWeight(null, 'lbs')).toBeNull());
    it('lbs passes through', () => expect(convertWeight(1000, 'lbs')).toBe(1000));
    it('converts to kg', () => expect(convertWeight(1000, 'kg')).toBeCloseTo(454, 0));
    it('converts to tonnes', () => expect(convertWeight(2204.62, 'tonnes')).toBeCloseTo(1.0, 0));
});

describe('convertTemp', () => {
    it('returns "--" for null', () => expect(convertTemp(null, 'C')).toBe('--'));
    it('returns "--" for undefined', () => expect(convertTemp(undefined, 'F')).toBe('--'));
    it('Celsius passes through (rounded)', () => expect(convertTemp(25.7, 'C')).toBe('26'));
    it('converts to Fahrenheit', () => expect(convertTemp(0, 'F')).toBe('32'));
    it('negative Celsius converts correctly', () => expect(convertTemp(-10, 'F')).toBe('14'));
});

describe('convertDistance', () => {
    it('returns "--" for null', () => expect(convertDistance(null, 'nm')).toBe('--'));
    it('nm passes through', () => expect(convertDistance(10, 'nm')).toBe('10.0'));
    it('converts to km', () => expect(convertDistance(10, 'km')).toBe('18.5'));
    it('converts to mi', () => expect(convertDistance(10, 'mi')).toBe('11.5'));
});

describe('convertMetersTo', () => {
    it('returns null for null', () => expect(convertMetersTo(null, 'ft')).toBeNull());
    it('meters passes through', () => expect(convertMetersTo(10, 'm')).toBe(10));
    it('converts to feet', () => expect(convertMetersTo(10, 'ft')).toBeCloseTo(32.8, 0));
});

describe('convertPrecip', () => {
    it('returns null for null', () => expect(convertPrecip(null, 'C')).toBeNull());
    it('returns null for 0mm', () => expect(convertPrecip(0, 'C')).toBeNull());
    it('returns TRACE for sub-0.25mm', () => expect(convertPrecip(0.1, 'C')).toBe('TRACE'));
    it('returns mm string for metric', () => expect(convertPrecip(5.3, 'C')).toBe('5.3'));
    it('converts to inches for F units', () => {
        const result = convertPrecip(25.4, 'F'); // 25.4mm = 1 inch
        expect(result).toBe('1.00"');
    });
    it('shows <0.01" for tiny amounts in F', () => expect(convertPrecip(0.25, 'F')).toBe('<0.01"'));
});
