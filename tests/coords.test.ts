import { describe, it, expect } from 'vitest';
import { fmtLat, fmtLon, fmtCoord } from '../utils/coords';

describe('fmtLat', () => {
    it('formats southern latitude', () => {
        expect(fmtLat(-33.867)).toBe('33.867°S');
    });

    it('formats northern latitude', () => {
        expect(fmtLat(51.507)).toBe('51.507°N');
    });

    it('formats equator as N', () => {
        expect(fmtLat(0)).toBe('0.000°N');
    });

    it('returns -- for null', () => {
        expect(fmtLat(null)).toBe('--');
    });

    it('returns -- for undefined', () => {
        expect(fmtLat(undefined)).toBe('--');
    });

    it('respects custom precision', () => {
        expect(fmtLat(-27.4698, 1)).toBe('27.5°S');
    });
});

describe('fmtLon', () => {
    it('formats eastern longitude', () => {
        expect(fmtLon(153.028)).toBe('153.028°E');
    });

    it('formats western longitude', () => {
        expect(fmtLon(-0.128)).toBe('0.128°W');
    });

    it('formats prime meridian as E', () => {
        expect(fmtLon(0)).toBe('0.000°E');
    });

    it('returns -- for null', () => {
        expect(fmtLon(null)).toBe('--');
    });
});

describe('fmtCoord', () => {
    it('formats a lat/lon pair', () => {
        expect(fmtCoord(-27.217, 153.1)).toBe('27.217°S, 153.100°E');
    });

    it('handles null values', () => {
        expect(fmtCoord(null, null)).toBe('--, --');
    });
});
