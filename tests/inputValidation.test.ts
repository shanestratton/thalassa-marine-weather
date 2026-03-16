/**
 * Input Validation Tests
 *
 * Tests all validation functions from utils/inputValidation.ts
 * covering XSS prevention, field length limits, coordinate validation, and edge cases.
 */

import { describe, it, expect } from 'vitest';
import {
    sanitizeText,
    validateDisplayName,
    validateVesselName,
    validateListingTitle,
    validatePrice,
    validateDescription,
    validateLatitude,
    validateLongitude,
    validateEmail,
    validateSearchQuery,
} from '../utils/inputValidation';

// ═══════════════════════════════════════

describe('sanitizeText', () => {
    it('strips HTML tags', () => {
        expect(sanitizeText('<b>bold</b>')).toBe('bold');
        expect(sanitizeText('<div class="x">text</div>')).toBe('text');
    });

    it('strips script tags', () => {
        expect(sanitizeText('<script>alert("xss")</script>Hello')).toBe('Hello');
    });

    it('strips event handlers', () => {
        expect(sanitizeText('text onload=alert(1) more')).toBe('text alert(1) more');
        expect(sanitizeText('text onclick=bad() more')).toBe('text bad() more');
    });

    it('strips javascript: URIs', () => {
        expect(sanitizeText('javascript:alert(1)')).toBe('alert(1)');
    });

    it('returns empty for null/undefined', () => {
        expect(sanitizeText(null as unknown as string)).toBe('');
        expect(sanitizeText(undefined as unknown as string)).toBe('');
        expect(sanitizeText('')).toBe('');
    });

    it('preserves normal text', () => {
        expect(sanitizeText('Hello World')).toBe('Hello World');
        expect(sanitizeText("Captain's Log - Day 5")).toBe("Captain's Log - Day 5");
    });

    it('trims whitespace', () => {
        expect(sanitizeText('  hello  ')).toBe('hello');
    });
});

// ═══════════════════════════════════════

describe('validateDisplayName', () => {
    it('accepts valid names', () => {
        expect(validateDisplayName('Captain Shane')).toEqual({ valid: true });
        expect(validateDisplayName('AB')).toEqual({ valid: true });
    });

    it('rejects too short', () => {
        expect(validateDisplayName('A').valid).toBe(false);
        expect(validateDisplayName('').valid).toBe(false);
    });

    it('rejects too long', () => {
        expect(validateDisplayName('A'.repeat(41)).valid).toBe(false);
    });

    it('rejects HTML in name', () => {
        expect(validateDisplayName('<script>alert(1)</script>Captain').valid).toBe(false);
    });
});

// ═══════════════════════════════════════

describe('validateVesselName', () => {
    it('accepts valid vessel name', () => {
        expect(validateVesselName('Thalassa').valid).toBe(true);
    });

    it('rejects empty', () => {
        expect(validateVesselName('').valid).toBe(false);
    });

    it('rejects too long', () => {
        expect(validateVesselName('A'.repeat(61)).valid).toBe(false);
    });
});

// ═══════════════════════════════════════

describe('validateListingTitle', () => {
    it('accepts valid title', () => {
        expect(validateListingTitle('Used Beneteau Oceanis 40.1').valid).toBe(true);
    });

    it('rejects too short', () => {
        expect(validateListingTitle('AB').valid).toBe(false);
    });

    it('rejects too long', () => {
        expect(validateListingTitle('A'.repeat(121)).valid).toBe(false);
    });
});

// ═══════════════════════════════════════

describe('validatePrice', () => {
    it('accepts valid prices', () => {
        expect(validatePrice(99.99).valid).toBe(true);
        expect(validatePrice('250').valid).toBe(true);
        expect(validatePrice(0).valid).toBe(true);
    });

    it('rejects negative', () => {
        expect(validatePrice(-1).valid).toBe(false);
    });

    it('rejects NaN', () => {
        expect(validatePrice('abc').valid).toBe(false);
        expect(validatePrice(NaN).valid).toBe(false);
    });

    it('rejects over 10M', () => {
        expect(validatePrice(10_000_001).valid).toBe(false);
    });
});

// ═══════════════════════════════════════

describe('validateDescription', () => {
    it('accepts valid description', () => {
        expect(validateDescription('A lovely boat in great condition.').valid).toBe(true);
    });

    it('accepts empty description', () => {
        expect(validateDescription('').valid).toBe(true);
    });

    it('rejects overly long', () => {
        expect(validateDescription('x'.repeat(2001)).valid).toBe(false);
    });
});

// ═══════════════════════════════════════

describe('validateLatitude', () => {
    it('accepts valid latitudes', () => {
        expect(validateLatitude(0).valid).toBe(true);
        expect(validateLatitude(-33.8688).valid).toBe(true);
        expect(validateLatitude(90).valid).toBe(true);
        expect(validateLatitude(-90).valid).toBe(true);
    });

    it('rejects out of range', () => {
        expect(validateLatitude(91).valid).toBe(false);
        expect(validateLatitude(-91).valid).toBe(false);
    });

    it('rejects NaN', () => {
        expect(validateLatitude(NaN).valid).toBe(false);
    });
});

// ═══════════════════════════════════════

describe('validateLongitude', () => {
    it('accepts valid longitudes', () => {
        expect(validateLongitude(0).valid).toBe(true);
        expect(validateLongitude(151.2093).valid).toBe(true);
        expect(validateLongitude(-180).valid).toBe(true);
        expect(validateLongitude(180).valid).toBe(true);
    });

    it('rejects out of range', () => {
        expect(validateLongitude(181).valid).toBe(false);
        expect(validateLongitude(-181).valid).toBe(false);
    });
});

// ═══════════════════════════════════════

describe('validateEmail', () => {
    it('accepts valid emails', () => {
        expect(validateEmail('user@example.com').valid).toBe(true);
        expect(validateEmail('captain.shane@thalassa.app').valid).toBe(true);
    });

    it('rejects invalid', () => {
        expect(validateEmail('notanemail').valid).toBe(false);
        expect(validateEmail('missing@domain').valid).toBe(false);
        expect(validateEmail('@no-local.com').valid).toBe(false);
    });

    it('rejects empty', () => {
        expect(validateEmail('').valid).toBe(false);
    });

    it('rejects too long', () => {
        expect(validateEmail('a'.repeat(250) + '@x.com').valid).toBe(false);
    });
});

// ═══════════════════════════════════════

describe('validateSearchQuery', () => {
    it('accepts valid queries', () => {
        expect(validateSearchQuery('Sydney, NSW').valid).toBe(true);
        expect(validateSearchQuery('-33.8688, 151.2093').valid).toBe(true);
    });

    it('rejects empty', () => {
        expect(validateSearchQuery('').valid).toBe(false);
    });

    it('rejects too long', () => {
        expect(validateSearchQuery('A'.repeat(201)).valid).toBe(false);
    });
});
