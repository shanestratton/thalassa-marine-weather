import { describe, it, expect } from 'vitest';
import { resolveTimeZone, formatTimeInZone } from './timezone';

describe('resolveTimeZone', () => {
    it('resolves known coordinates to IANA zones', () => {
        // Sydney
        expect(resolveTimeZone(-33.87, 151.21)).toBe('Australia/Sydney');
        // Austin, TX (near Gentrys Mill)
        expect(resolveTimeZone(30.27, -97.74)).toBe('America/Chicago');
        // London
        expect(resolveTimeZone(51.51, -0.13)).toBe('Europe/London');
    });

    it('uses a valid provider hint when supplied', () => {
        // If the provider already told us the zone, keep it — lookup cost is
        // negligible but trusting the provider is semantically cleaner.
        expect(resolveTimeZone(30.27, -97.74, 'America/Chicago')).toBe('America/Chicago');
    });

    it('ignores UTC/GMT sentinel hints and falls back to geographic lookup', () => {
        // WeatherKit returns 'UTC' as a sentinel — it should NOT be trusted.
        expect(resolveTimeZone(-33.87, 151.21, 'UTC')).toBe('Australia/Sydney');
        expect(resolveTimeZone(30.27, -97.74, 'GMT')).toBe('America/Chicago');
        expect(resolveTimeZone(30.27, -97.74, '')).toBe('America/Chicago');
    });

    it('falls back to UTC when coordinates are invalid', () => {
        // tz-lookup throws on out-of-range lat; we should swallow gracefully.
        expect(resolveTimeZone(999, 999)).toBe('UTC');
    });
});

describe('formatTimeInZone', () => {
    // 2026-04-17 06:30:45 UTC (arbitrary but fixed)
    const iso = '2026-04-17T06:30:45Z';

    it('formats UTC ISO in the target zone', () => {
        // Sydney = UTC+10 (AEST, no DST in April)
        expect(formatTimeInZone(iso, 'Australia/Sydney')).toBe('16:31');
        // Chicago = UTC-5 (CDT in April)
        expect(formatTimeInZone(iso, 'America/Chicago')).toBe('01:31');
        // London = UTC+1 (BST in April)
        expect(formatTimeInZone(iso, 'Europe/London')).toBe('07:31');
    });

    it('rounds to the nearest minute', () => {
        // 06:30:45 → 06:31 (seconds ≥ 30 bumps up)
        expect(formatTimeInZone('2026-04-17T06:30:45Z', 'UTC')).toBe('06:31');
        // 06:30:29 → 06:30 (seconds < 30 stays)
        expect(formatTimeInZone('2026-04-17T06:30:29Z', 'UTC')).toBe('06:30');
    });

    it('accepts Date objects as input', () => {
        const d = new Date(iso);
        expect(formatTimeInZone(d, 'Australia/Sydney')).toBe('16:31');
    });

    it('returns --:-- for invalid input', () => {
        expect(formatTimeInZone('not-a-date', 'UTC')).toBe('--:--');
    });

    it('falls back to device time when the tz is invalid', () => {
        // Shouldn't throw — returns *some* HH:MM string (device-zone formatted).
        const result = formatTimeInZone(iso, 'Not/A_Real_Zone');
        expect(result).toMatch(/^\d{2}:\d{2}$/);
    });
});
