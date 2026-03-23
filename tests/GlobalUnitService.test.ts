/**
 * GlobalUnitService — unit conversion tests
 */
import { describe, it, expect, beforeEach } from 'vitest';
import {
    convertCurrency,
    formatCurrency,
    getCurrencySymbol,
    getAvailableCurrencies,
    kgToLb,
    lbToKg,
    kgToOz,
    convertWeight,
    convertVolume,
    convertLength,
    celsiusToFahrenheit,
    fahrenheitToCelsius,
    getUnitPreferences,
    setUnitPreferences,
    formatStoresQuantity,
    updateRates,
    getRatesAge,
} from '../services/GlobalUnitService';

describe('GlobalUnitService', () => {
    beforeEach(() => {
        localStorage.clear();
    });

    // ── Currency ─────────────────────────
    describe('convertCurrency', () => {
        it('same currency returns same amount', () => {
            expect(convertCurrency(100, 'AUD', 'AUD')).toBe(100);
        });

        it('converts AUD to USD using default rates', () => {
            const result = convertCurrency(100, 'AUD', 'USD');
            expect(result).toBe(65); // 100 * 0.65
        });

        it('converts USD to AUD', () => {
            const result = convertCurrency(65, 'USD', 'AUD');
            expect(result).toBe(100);
        });

        it('converts between non-AUD currencies', () => {
            const result = convertCurrency(100, 'USD', 'EUR');
            // 100 USD → AUD → EUR: (100/0.65) * 0.6 ≈ 92.31
            expect(result).toBeCloseTo(92.31, 1);
        });

        it('handles zero amount', () => {
            expect(convertCurrency(0, 'AUD', 'USD')).toBe(0);
        });
    });

    describe('formatCurrency', () => {
        it('formats AUD with symbol', () => {
            expect(formatCurrency(42.5, 'AUD')).toBe('A$42.50');
        });

        it('formats EUR', () => {
            expect(formatCurrency(100, 'EUR')).toBe('€100.00');
        });

        it('formats GBP', () => {
            expect(formatCurrency(25.99, 'GBP')).toBe('£25.99');
        });
    });

    describe('getCurrencySymbol', () => {
        it('returns correct symbols', () => {
            expect(getCurrencySymbol('AUD')).toBe('A$');
            expect(getCurrencySymbol('USD')).toBe('US$');
            expect(getCurrencySymbol('EUR')).toBe('€');
            expect(getCurrencySymbol('GBP')).toBe('£');
            expect(getCurrencySymbol('XPF')).toBe('₣');
        });
    });

    describe('getAvailableCurrencies', () => {
        it('returns all 7 currencies', () => {
            const currencies = getAvailableCurrencies();
            expect(currencies).toHaveLength(7);
            expect(currencies.map((c) => c.code)).toContain('AUD');
            expect(currencies.map((c) => c.code)).toContain('XPF');
        });
    });

    describe('updateRates / getRatesAge', () => {
        it('tracks when rates were last updated', () => {
            expect(getRatesAge()).toBeNull();
            updateRates({ USD: 0.66 });
            expect(getRatesAge()).not.toBeNull();
        });

        it('uses updated rates for conversion', () => {
            updateRates({ USD: 0.7 });
            expect(convertCurrency(100, 'AUD', 'USD')).toBe(70);
        });
    });

    // ── Weight ─────────────────────────
    describe('weight conversions', () => {
        it('kgToLb converts correctly', () => {
            expect(kgToLb(1)).toBeCloseTo(2.2, 1);
            expect(kgToLb(10)).toBeCloseTo(22.05, 1);
        });

        it('lbToKg converts correctly', () => {
            expect(lbToKg(2.2)).toBeCloseTo(1, 0);
        });

        it('kgToOz converts correctly', () => {
            expect(kgToOz(1)).toBeCloseTo(35.3, 0);
        });

        it('convertWeight handles same unit', () => {
            expect(convertWeight(5, 'kg', 'kg')).toBe(5);
        });

        it('convertWeight kg ↔ lb roundtrip', () => {
            const lb = convertWeight(10, 'kg', 'lb');
            const kg = convertWeight(lb, 'lb', 'kg');
            expect(kg).toBeCloseTo(10, 0);
        });

        it('convertWeight g ↔ oz', () => {
            const oz = convertWeight(1000, 'g', 'oz');
            expect(oz).toBeCloseTo(35.3, 0);
        });

        it('convertWeight g ↔ kg', () => {
            expect(convertWeight(1000, 'g', 'kg')).toBe(1);
            expect(convertWeight(1, 'kg', 'g')).toBe(1000);
        });
    });

    // ── Volume ─────────────────────────
    describe('volume conversions', () => {
        it('same unit returns same value', () => {
            expect(convertVolume(5, 'L', 'L')).toBe(5);
        });

        it('L to gal and back', () => {
            const gal = convertVolume(3.78541, 'L', 'gal');
            expect(gal).toBeCloseTo(1, 0);
        });

        it('ml to L', () => {
            expect(convertVolume(1000, 'ml', 'L')).toBe(1);
        });

        it('L to floz', () => {
            const floz = convertVolume(1, 'L', 'floz');
            expect(floz).toBeCloseTo(33.8, 0);
        });

        it('L to qt', () => {
            const qt = convertVolume(1, 'L', 'qt');
            expect(qt).toBeCloseTo(1.06, 1);
        });
    });

    // ── Length ─────────────────────────
    describe('length conversions', () => {
        it('same unit returns same value', () => {
            expect(convertLength(100, 'm', 'm')).toBe(100);
        });

        it('m to ft', () => {
            expect(convertLength(1, 'm', 'ft')).toBeCloseTo(3.28, 1);
        });

        it('nm to m', () => {
            expect(convertLength(1, 'nm', 'm')).toBe(1852);
        });

        it('km to nm', () => {
            expect(convertLength(1.852, 'km', 'nm')).toBeCloseTo(1, 1);
        });

        it('mi to km', () => {
            expect(convertLength(1, 'mi', 'km')).toBeCloseTo(1.61, 1);
        });

        it('ft to m', () => {
            expect(convertLength(3.28, 'ft', 'm')).toBeCloseTo(1, 0);
        });
    });

    // ── Temperature ─────────────────────────
    describe('temperature conversions', () => {
        it('0°C = 32°F', () => {
            expect(celsiusToFahrenheit(0)).toBe(32);
        });

        it('100°C = 212°F', () => {
            expect(celsiusToFahrenheit(100)).toBe(212);
        });

        it('32°F = 0°C', () => {
            expect(fahrenheitToCelsius(32)).toBe(0);
        });

        it('212°F = 100°C', () => {
            expect(fahrenheitToCelsius(212)).toBe(100);
        });

        it('negative temps work', () => {
            expect(celsiusToFahrenheit(-40)).toBe(-40); // -40 is the same in both
        });
    });

    // ── Preferences ─────────────────────────
    describe('unit preferences', () => {
        it('defaults to AUD metric', () => {
            const prefs = getUnitPreferences();
            expect(prefs.currency).toBe('AUD');
            expect(prefs.unitSystem).toBe('metric');
        });

        it('persists preferences', () => {
            setUnitPreferences({ currency: 'USD', unitSystem: 'imperial' });
            const prefs = getUnitPreferences();
            expect(prefs.currency).toBe('USD');
            expect(prefs.unitSystem).toBe('imperial');
        });

        it('partial update preserves other fields', () => {
            setUnitPreferences({ currency: 'EUR' });
            const prefs = getUnitPreferences();
            expect(prefs.currency).toBe('EUR');
            expect(prefs.unitSystem).toBe('metric'); // unchanged
        });
    });

    // ── formatStoresQuantity ─────────────────────────
    describe('formatStoresQuantity', () => {
        it('metric returns raw value with unit', () => {
            expect(formatStoresQuantity(5, 'kg', 'metric')).toBe('5 kg');
        });

        it('imperial converts kg to lb', () => {
            const result = formatStoresQuantity(1, 'kg', 'imperial');
            expect(result).toContain('lb');
        });

        it('imperial converts L to gal', () => {
            const result = formatStoresQuantity(3.785, 'L', 'imperial');
            expect(result).toContain('gal');
        });

        it('imperial converts ml to fl oz', () => {
            const result = formatStoresQuantity(500, 'ml', 'imperial');
            expect(result).toContain('fl oz');
        });

        it('imperial converts m to ft', () => {
            const result = formatStoresQuantity(10, 'm', 'imperial');
            expect(result).toContain('ft');
        });

        it('imperial passes through unknown units', () => {
            expect(formatStoresQuantity(5, 'boxes', 'imperial')).toBe('5 boxes');
        });
    });
});
