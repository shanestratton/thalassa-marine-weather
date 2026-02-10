/**
 * Unit tests for utils/format.ts — String formatting utilities
 * Tests cover compass directions, location formatting, coordinates, and TTS expansion
 */
import { describe, it, expect } from 'vitest';
import {
    formatLocationInput,
    degreesToCardinal,
    cardinalToDegrees,
    expandCompassDirection,
    expandForSpeech,
    formatCoordinate,
} from './format';

describe('degreesToCardinal', () => {
    it('0° = N', () => expect(degreesToCardinal(0)).toBe('N'));
    it('90° = E', () => expect(degreesToCardinal(90)).toBe('E'));
    it('180° = S', () => expect(degreesToCardinal(180)).toBe('S'));
    it('270° = W', () => expect(degreesToCardinal(270)).toBe('W'));
    it('45° = NE', () => expect(degreesToCardinal(45)).toBe('NE'));
    it('135° = SE', () => expect(degreesToCardinal(135)).toBe('SE'));
    it('225° = SW', () => expect(degreesToCardinal(225)).toBe('SW'));
    it('315° = NW', () => expect(degreesToCardinal(315)).toBe('NW'));
    it('360° wraps to N', () => expect(degreesToCardinal(360)).toBe('N'));
    it('null returns "--"', () => expect(degreesToCardinal(null)).toBe('--'));
    it('undefined returns "--"', () => expect(degreesToCardinal(undefined)).toBe('--'));
});

describe('cardinalToDegrees', () => {
    it('N = 0', () => expect(cardinalToDegrees('N')).toBe(0));
    it('E = 90', () => expect(cardinalToDegrees('E')).toBe(90));
    it('S = 180', () => expect(cardinalToDegrees('S')).toBe(180));
    it('W = 270', () => expect(cardinalToDegrees('W')).toBe(270));
    it('SE = 135', () => expect(cardinalToDegrees('SE')).toBe(135));
    it('is case-insensitive', () => expect(cardinalToDegrees('ne')).toBe(45));
    it('null returns undefined', () => expect(cardinalToDegrees(null)).toBeUndefined());
    it('empty string returns undefined', () => expect(cardinalToDegrees('')).toBeUndefined());
});

describe('formatLocationInput', () => {
    it('capitalizes first letter of each word', () => {
        expect(formatLocationInput('new york')).toBe('New York');
    });

    it('keeps US state abbreviations uppercase', () => {
        expect(formatLocationInput('miami, fl')).toBe('Miami, FL');
    });

    it('keeps Australian state abbreviations uppercase', () => {
        expect(formatLocationInput('sydney, nsw')).toBe('Sydney, NSW');
    });

    it('handles already-formatted input', () => {
        expect(formatLocationInput('Brisbane')).toBe('Brisbane');
    });
});

describe('expandCompassDirection', () => {
    it('N → North', () => expect(expandCompassDirection('N')).toBe('North'));
    it('NNE → North-Northeast', () => expect(expandCompassDirection('NNE')).toBe('North-Northeast'));
    it('SW → Southwest', () => expect(expandCompassDirection('SW')).toBe('Southwest'));
    it('empty → Unknown', () => expect(expandCompassDirection('')).toBe('Unknown'));
    it('invalid returns itself', () => expect(expandCompassDirection('X')).toBe('X'));
});

describe('expandForSpeech', () => {
    it('expands kts to knots', () => {
        expect(expandForSpeech('Wind 15 kts from N')).toContain('knots');
    });

    it('expands nm to nautical miles', () => {
        expect(expandForSpeech('visibility 10 nm')).toContain('nautical miles');
    });

    it('expands °C to degrees Celsius', () => {
        expect(expandForSpeech('Temp 25°C')).toContain('degrees Celsius');
    });

    it('expands ft to feet', () => {
        expect(expandForSpeech('Waves 6 ft high')).toContain('feet');
    });

    it('returns empty for empty input', () => {
        expect(expandForSpeech('')).toBe('');
    });
});

describe('formatCoordinate', () => {
    it('formats positive latitude as N', () => {
        expect(formatCoordinate(27.45, 'lat')).toBe('27.4500°N');
    });

    it('formats negative latitude as S', () => {
        expect(formatCoordinate(-27.45, 'lat')).toBe('27.4500°S');
    });

    it('formats positive longitude as E', () => {
        expect(formatCoordinate(153.02, 'lon')).toBe('153.0200°E');
    });

    it('formats negative longitude as W', () => {
        expect(formatCoordinate(-74.006, 'lon')).toBe('74.0060°W');
    });

    it('formats zero latitude as N', () => {
        expect(formatCoordinate(0, 'lat')).toBe('0.0000°N');
    });
});
