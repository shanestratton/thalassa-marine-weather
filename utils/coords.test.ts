/**
 * coords — Unit tests for coordinate formatting utilities.
 */
import { describe, it, expect } from 'vitest';
import { fmtLat, fmtLon, fmtCoord } from './coords';

describe('fmtLat', () => {
    it('formats positive latitudes as N', () => {
        expect(fmtLat(27.467)).toBe('27.467°N');
    });

    it('formats negative latitudes as S', () => {
        expect(fmtLat(-33.86)).toBe('33.860°S');
    });

    it('formats zero latitude', () => {
        expect(fmtLat(0)).toBe('0.000°N');
    });

    it('handles null/undefined', () => {
        expect(fmtLat(null)).toBe('--');
        expect(fmtLat(undefined)).toBe('--');
    });

    it('respects custom precision', () => {
        expect(fmtLat(27.4678, 1)).toBe('27.5°N');
    });
});

describe('fmtLon', () => {
    it('formats positive longitudes as E', () => {
        expect(fmtLon(153.028)).toBe('153.028°E');
    });

    it('formats negative longitudes as W', () => {
        expect(fmtLon(-73.935)).toBe('73.935°W');
    });

    it('handles null/undefined', () => {
        expect(fmtLon(null)).toBe('--');
    });
});

describe('fmtCoord', () => {
    it('formats a full coordinate pair', () => {
        const result = fmtCoord(-27.5, 153.0);
        expect(result).toContain('S');
        expect(result).toContain('E');
    });

    it('handles missing coordinates', () => {
        expect(fmtCoord(null, null)).toContain('--');
    });
});
