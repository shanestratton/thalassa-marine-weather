/**
 * goldenHour — Unit Tests
 *
 * Tests getGoldenHourWindows, isGoldenHour, and getGoldenHourLabel
 * pure functions for sunrise/sunset → golden hour window calculations.
 */
import { describe, it, expect } from 'vitest';
import { getGoldenHourWindows, isGoldenHour, getGoldenHourLabel } from '../utils/goldenHour';

describe('getGoldenHourWindows', () => {
    it('returns correct morning and evening windows', () => {
        const result = getGoldenHourWindows('06:00', '18:00');
        expect(result).not.toBeNull();
        expect(result!.morning.start).toBe('06:00');
        expect(result!.morning.end).toBe('06:30');
        expect(result!.evening.start).toBe('17:30');
        expect(result!.evening.end).toBe('18:00');
    });

    it('calculates correct windows for early sunrise', () => {
        const result = getGoldenHourWindows('05:15', '19:45');
        expect(result!.morning.start).toBe('05:15');
        expect(result!.morning.end).toBe('05:45');
        expect(result!.evening.start).toBe('19:15');
        expect(result!.evening.end).toBe('19:45');
    });

    it('returns null for invalid sunrise', () => {
        expect(getGoldenHourWindows('--:--', '18:00')).toBeNull();
    });

    it('returns null for invalid sunset', () => {
        expect(getGoldenHourWindows('06:00', '')).toBeNull();
    });

    it('returns null for both invalid', () => {
        expect(getGoldenHourWindows('', '')).toBeNull();
    });

    it('handles sunrise near midnight (polar regions)', () => {
        const result = getGoldenHourWindows('00:10', '23:50');
        expect(result!.morning.start).toBe('00:10');
        expect(result!.morning.end).toBe('00:40');
        expect(result!.evening.start).toBe('23:20');
        expect(result!.evening.end).toBe('23:50');
    });

    it('handles non-standard input characters', () => {
        // parseHHMM strips non-numeric/colon characters
        const result = getGoldenHourWindows('06:00AM', '06:00PM');
        expect(result).not.toBeNull();
        expect(result!.morning.start).toBe('06:00');
    });
});

describe('isGoldenHour', () => {
    it('returns true during morning golden hour', () => {
        const now = new Date();
        now.setHours(6, 15, 0, 0);
        expect(isGoldenHour('06:00', '18:00', now)).toBe(true);
    });

    it('returns true during evening golden hour', () => {
        const now = new Date();
        now.setHours(17, 45, 0, 0);
        expect(isGoldenHour('06:00', '18:00', now)).toBe(true);
    });

    it('returns false outside golden hour', () => {
        const now = new Date();
        now.setHours(12, 0, 0, 0);
        expect(isGoldenHour('06:00', '18:00', now)).toBe(false);
    });

    it('returns false before sunrise', () => {
        const now = new Date();
        now.setHours(5, 0, 0, 0);
        expect(isGoldenHour('06:00', '18:00', now)).toBe(false);
    });

    it('returns false after sunset', () => {
        const now = new Date();
        now.setHours(20, 0, 0, 0);
        expect(isGoldenHour('06:00', '18:00', now)).toBe(false);
    });

    it('returns false at exactly the end of morning window', () => {
        const now = new Date();
        now.setHours(6, 30, 0, 0);
        // End is exclusive
        expect(isGoldenHour('06:00', '18:00', now)).toBe(false);
    });

    it('returns true at exactly the start of morning window', () => {
        const now = new Date();
        now.setHours(6, 0, 0, 0);
        expect(isGoldenHour('06:00', '18:00', now)).toBe(true);
    });

    it('returns false for invalid inputs', () => {
        expect(isGoldenHour('', '18:00')).toBe(false);
    });
});

describe('getGoldenHourLabel', () => {
    it('returns "morning" during morning golden hour', () => {
        const now = new Date();
        now.setHours(6, 10, 0, 0);
        expect(getGoldenHourLabel('06:00', '18:00', now)).toBe('morning');
    });

    it('returns "evening" during evening golden hour', () => {
        const now = new Date();
        now.setHours(17, 40, 0, 0);
        expect(getGoldenHourLabel('06:00', '18:00', now)).toBe('evening');
    });

    it('returns null outside golden hours', () => {
        const now = new Date();
        now.setHours(12, 0, 0, 0);
        expect(getGoldenHourLabel('06:00', '18:00', now)).toBeNull();
    });

    it('returns null for invalid inputs', () => {
        expect(getGoldenHourLabel('--:--', '18:00')).toBeNull();
    });
});
