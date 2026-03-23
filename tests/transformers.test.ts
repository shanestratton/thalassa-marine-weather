import { describe, it, expect } from 'vitest';
import { abbreviate, getCondition, generateDescription } from '../services/weather/transformers';

describe('abbreviate', () => {
    it('returns short strings unchanged', () => {
        expect(abbreviate('Hello')).toBe('Hello');
    });

    it('returns strings at exactly 12 chars unchanged', () => {
        expect(abbreviate('123456789012')).toBe('123456789012');
    });

    it('truncates strings over 12 chars', () => {
        expect(abbreviate('This is a very long string')).toBe('This is a ..');
    });

    it('returns empty string for empty input', () => {
        expect(abbreviate('')).toBe('');
    });
});

describe('getCondition', () => {
    it('returns Rain for heavy precipitation', () => {
        expect(getCondition(50, 10, true)).toBe('Rain');
    });

    it('returns Light Rain for light precipitation', () => {
        expect(getCondition(50, 1, true)).toBe('Light Rain');
    });

    it('returns Overcast for very high cloud cover', () => {
        expect(getCondition(95, 0, true)).toBe('Overcast');
    });

    it('returns Cloudy for high cloud cover', () => {
        expect(getCondition(60, 0, true)).toBe('Cloudy');
    });

    it('returns Clouds for moderate cloud', () => {
        expect(getCondition(30, 0, true)).toBe('Clouds');
    });

    it('returns Clouds at night for moderate cloud', () => {
        expect(getCondition(30, 0, false)).toBe('Clouds');
    });

    it('returns Sunny for clear day', () => {
        expect(getCondition(10, 0, true)).toBe('Sunny');
    });

    it('returns Clear for clear night', () => {
        expect(getCondition(10, 0, false)).toBe('Clear');
    });

    it('rain takes priority over cloud cover', () => {
        expect(getCondition(10, 6, true)).toBe('Rain');
    });

    it('light rain takes priority over cloud cover', () => {
        expect(getCondition(10, 0.6, true)).toBe('Light Rain');
    });

    it('no precip below threshold', () => {
        expect(getCondition(10, 0.4, true)).toBe('Sunny');
    });
});

describe('generateDescription', () => {
    it('generates basic description', () => {
        expect(generateDescription('Sunny', 10, 'NE', 1)).toBe('Sunny. Winds NE at 10kts.');
    });

    it('includes waves when > 2ft', () => {
        const desc = generateDescription('Cloudy', 15, 'SW', 4.5);
        expect(desc).toContain('Seas 4.5ft');
    });

    it('omits waves when <= 2ft', () => {
        const desc = generateDescription('Cloudy', 15, 'SW', 1.5);
        expect(desc).not.toContain('Seas');
    });

    it('handles null wind', () => {
        const desc = generateDescription('Clear', null, 'N', 0);
        expect(desc).toBe('Clear.');
    });

    it('handles null wave', () => {
        const desc = generateDescription('Overcast', 20, 'SE', null);
        expect(desc).toContain('Winds SE at 20kts');
        expect(desc).not.toContain('Seas');
    });

    it('rounds wind speed', () => {
        const desc = generateDescription('Cloudy', 15.7, 'W', 1);
        expect(desc).toContain('16kts');
    });
});
