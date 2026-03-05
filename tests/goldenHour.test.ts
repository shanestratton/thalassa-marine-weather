import { describe, it, expect } from 'vitest';
import { getGoldenHourWindows, isGoldenHour, getGoldenHourLabel } from '../utils/goldenHour';

describe('goldenHour', () => {
    const sunrise = '06:15';
    const sunset = '18:45';

    describe('getGoldenHourWindows', () => {
        it('returns correct morning and evening windows', () => {
            const w = getGoldenHourWindows(sunrise, sunset);
            expect(w).not.toBeNull();
            expect(w!.morning.start).toBe('06:15');
            expect(w!.morning.end).toBe('06:45');
            expect(w!.evening.start).toBe('18:15');
            expect(w!.evening.end).toBe('18:45');
        });

        it('returns null for invalid input', () => {
            expect(getGoldenHourWindows('invalid', sunset)).toBeNull();
            expect(getGoldenHourWindows(sunrise, '')).toBeNull();
            expect(getGoldenHourWindows('--:--', '--:--')).toBeNull();
        });
    });

    describe('isGoldenHour', () => {
        it('returns true during morning golden hour', () => {
            const during = new Date(2026, 2, 5, 6, 20); // 06:20
            expect(isGoldenHour(sunrise, sunset, during)).toBe(true);
        });

        it('returns true during evening golden hour', () => {
            const during = new Date(2026, 2, 5, 18, 30); // 18:30
            expect(isGoldenHour(sunrise, sunset, during)).toBe(true);
        });

        it('returns false at midday', () => {
            const midday = new Date(2026, 2, 5, 12, 0);
            expect(isGoldenHour(sunrise, sunset, midday)).toBe(false);
        });

        it('returns false at night', () => {
            const night = new Date(2026, 2, 5, 22, 0);
            expect(isGoldenHour(sunrise, sunset, night)).toBe(false);
        });

        it('returns false just before morning golden hour', () => {
            const before = new Date(2026, 2, 5, 6, 14);
            expect(isGoldenHour(sunrise, sunset, before)).toBe(false);
        });

        it('returns false just after evening golden hour', () => {
            const after = new Date(2026, 2, 5, 18, 45);
            expect(isGoldenHour(sunrise, sunset, after)).toBe(false);
        });
    });

    describe('getGoldenHourLabel', () => {
        it('returns "morning" during morning window', () => {
            const d = new Date(2026, 2, 5, 6, 30);
            expect(getGoldenHourLabel(sunrise, sunset, d)).toBe('morning');
        });

        it('returns "evening" during evening window', () => {
            const d = new Date(2026, 2, 5, 18, 20);
            expect(getGoldenHourLabel(sunrise, sunset, d)).toBe('evening');
        });

        it('returns null outside both windows', () => {
            const d = new Date(2026, 2, 5, 14, 0);
            expect(getGoldenHourLabel(sunrise, sunset, d)).toBeNull();
        });
    });
});
