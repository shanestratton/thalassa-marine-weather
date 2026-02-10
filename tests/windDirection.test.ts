/**
 * Tests for degreesToCardinal and other utility functions
 * Tests pure conversion logic
 */

import { describe, it, expect } from 'vitest';
import { degreesToCardinal } from '../utils';

describe('degreesToCardinal', () => {
    it('converts 0° to N', () => {
        expect(degreesToCardinal(0)).toBe('N');
    });

    it('converts 360° to N', () => {
        expect(degreesToCardinal(360)).toBe('N');
    });

    it('converts 90° to E', () => {
        expect(degreesToCardinal(90)).toBe('E');
    });

    it('converts 180° to S', () => {
        expect(degreesToCardinal(180)).toBe('S');
    });

    it('converts 270° to W', () => {
        expect(degreesToCardinal(270)).toBe('W');
    });

    it('converts 45° to NE', () => {
        expect(degreesToCardinal(45)).toBe('NE');
    });

    it('converts 135° to SE', () => {
        expect(degreesToCardinal(135)).toBe('SE');
    });

    it('converts 225° to SW', () => {
        expect(degreesToCardinal(225)).toBe('SW');
    });

    it('converts 315° to NW', () => {
        expect(degreesToCardinal(315)).toBe('NW');
    });

    it('handles decimal degrees (22.5° → NNE)', () => {
        expect(degreesToCardinal(22.5)).toBe('NNE');
    });

    it('returns undefined for negative degrees (no wrapping)', () => {
        // degreesToCardinal expects 0-360 range; negative inputs are out of range
        const result = degreesToCardinal(-90);
        expect(result).toBeUndefined();
    });
});
