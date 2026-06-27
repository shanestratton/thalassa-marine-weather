/**
 * Tests for circular (bearing) statistics. Wind direction is angular — a wrong
 * mean or sign here mislabels which way the wind is shifting, so pin the wrap
 * cases explicitly.
 */
import { describe, it, expect } from 'vitest';
import { circularMean, circularDelta, directionShift } from '../utils/circularStats';

describe('circularMean', () => {
    it('averages a simple cluster', () => {
        expect(circularMean([90, 100, 110])).toBeCloseTo(100, 5);
    });
    it('averages ACROSS the 360/0 wrap (the trap)', () => {
        // 350 and 10 → 0, NOT 180.
        expect(circularMean([350, 10])).toBeCloseTo(0, 5);
        expect(circularMean([10, 350])).toBeCloseTo(0, 5);
        expect(circularMean([355, 5, 15])).toBeCloseTo(5, 5);
    });
    it('ignores null / undefined / non-finite samples', () => {
        expect(circularMean([90, null, undefined, NaN, 90])).toBeCloseTo(90, 5);
    });
    it('returns null for an empty (or all-empty) set', () => {
        expect(circularMean([])).toBeNull();
        expect(circularMean([null, undefined])).toBeNull();
    });
    it('returns null when vectors cancel exactly (opposed pair)', () => {
        expect(circularMean([0, 180])).toBeNull();
        expect(circularMean([90, 270])).toBeNull();
    });
});

describe('circularDelta', () => {
    it('is 0 for identical bearings', () => {
        expect(circularDelta(120, 120)).toBe(0);
    });
    it('is positive (clockwise) for a veer', () => {
        expect(circularDelta(180, 200)).toBe(20); // S → SSW: clockwise
        expect(circularDelta(350, 10)).toBe(20); // across the wrap, still clockwise
    });
    it('is negative (anticlockwise) for a back', () => {
        expect(circularDelta(200, 180)).toBe(-20);
        expect(circularDelta(10, 350)).toBe(-20);
    });
    it('takes the SHORT way round, not the long one', () => {
        expect(circularDelta(0, 170)).toBe(170);
        expect(circularDelta(0, 190)).toBe(-170); // shorter to go anticlockwise
    });
});

describe('directionShift', () => {
    it('calls a clockwise turn veering', () => {
        expect(directionShift(180, 240)).toBe('veering'); // SW → W
        expect(directionShift(350, 30)).toBe('veering'); // across the wrap
    });
    it('calls an anticlockwise turn backing', () => {
        expect(directionShift(240, 180)).toBe('backing');
    });
    it('calls a small change steady (default 15° threshold)', () => {
        expect(directionShift(180, 190)).toBe('steady');
        expect(directionShift(180, 170)).toBe('steady');
    });
    it('honours a custom threshold', () => {
        expect(directionShift(180, 200, 25)).toBe('steady');
        expect(directionShift(180, 200, 10)).toBe('veering');
    });
    it('is null when either bearing is missing', () => {
        expect(directionShift(null, 180)).toBeNull();
        expect(directionShift(180, undefined)).toBeNull();
        expect(directionShift(NaN, 180)).toBeNull();
    });
});
