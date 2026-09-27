import { describe, expect, it } from 'vitest';
import { formatDisplayDate } from '../utils/displayDate';

describe('formatDisplayDate', () => {
    it("gives the app's one day form, with fixed English names", () => {
        // Not '28/9/2026' (bare toLocaleDateString), and never 'Sept'.
        expect(formatDisplayDate('2026-09-28')).toBe('Mon 28 Sep 2026');
        expect(formatDisplayDate('2026-09-28', { weekday: false })).toBe('28 Sep 2026');
    });

    it('reads a bare date as that local day, not UTC midnight', () => {
        expect(formatDisplayDate('2026-01-01')).toBe('Thu 1 Jan 2026');
    });

    it('shows -- for a missing or unreadable date', () => {
        expect(formatDisplayDate(null)).toBe('--');
        expect(formatDisplayDate(undefined)).toBe('--');
        expect(formatDisplayDate('')).toBe('--');
        expect(formatDisplayDate('not a date')).toBe('--');
    });
});
