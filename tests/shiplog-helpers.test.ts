/**
 * Unit Tests for Ship Log Helper Functions
 * Tests pure utility functions: distance, bearing, DMS, quarter-hour, DB mapping
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
    calculateDistanceNM,
    calculateBearing,
    formatPositionDMS,
    getNextQuarterHour,
    toDbFormat,
    fromDbFormat,
    getIntervalForZone,
    getZoneLabel,
    NEARSHORE_INTERVAL_MS,
    COASTAL_INTERVAL_MS,
    OFFSHORE_INTERVAL_MS,
} from '../services/shiplog/helpers';

// ---- Distance (Haversine) ----

describe('calculateDistanceNM', () => {
    it('returns 0 for same position', () => {
        expect(calculateDistanceNM(0, 0, 0, 0)).toBe(0);
    });

    it('calculates Brisbane to Sydney (~395 nm)', () => {
        const d = calculateDistanceNM(-27.47, 153.02, -33.87, 151.21);
        expect(d).toBeGreaterThan(390);
        expect(d).toBeLessThan(400);
    });

    it('calculates short harbour distance (~0.5 nm)', () => {
        // ~1km apart in Moreton Bay
        const d = calculateDistanceNM(-27.4500, 153.1000, -27.4590, 153.1000);
        expect(d).toBeGreaterThan(0.4);
        expect(d).toBeLessThan(0.7);
    });

    it('handles cross-hemisphere', () => {
        // Singapore to Sydney
        const d = calculateDistanceNM(1.35, 103.82, -33.87, 151.21);
        expect(d).toBeGreaterThan(3300);
        expect(d).toBeLessThan(3500);
    });
});

// ---- Bearing ----

describe('calculateBearing', () => {
    it('returns ~0° for due north', () => {
        const b = calculateBearing(0, 0, 10, 0);
        expect(b).toBeCloseTo(0, 0);
    });

    it('returns ~90° for due east', () => {
        const b = calculateBearing(0, 0, 0, 10);
        expect(b).toBeCloseTo(90, 0);
    });

    it('returns ~180° for due south', () => {
        const b = calculateBearing(10, 0, 0, 0);
        expect(b).toBeCloseTo(180, 0);
    });

    it('returns ~270° for due west', () => {
        const b = calculateBearing(0, 10, 0, 0);
        expect(b).toBeCloseTo(270, 0);
    });
});

// ---- DMS Formatting ----

describe('formatPositionDMS', () => {
    it('formats southern hemisphere correctly', () => {
        const result = formatPositionDMS(-27.475, 153.0167);
        expect(result).toContain('S');
        expect(result).toContain('E');
        expect(result).toContain('27°');
        expect(result).toContain('153°');
    });

    it('formats northern/western hemisphere', () => {
        const result = formatPositionDMS(40.7128, -74.006);
        expect(result).toContain('N');
        expect(result).toContain('W');
    });

    it('handles equator/prime meridian', () => {
        const result = formatPositionDMS(0, 0);
        expect(result).toContain('N'); // 0 is positive
        expect(result).toContain('E');
    });
});

// ---- Quarter-Hour Snapping ----

describe('getNextQuarterHour', () => {
    beforeEach(() => {
        vi.useFakeTimers();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    it('snaps 07:14 to 07:15:30', () => {
        vi.setSystemTime(new Date(2025, 0, 1, 7, 14, 0, 0));
        const { nextTime } = getNextQuarterHour();
        expect(nextTime.getHours()).toBe(7);
        expect(nextTime.getMinutes()).toBe(15);
        expect(nextTime.getSeconds()).toBe(30);
    });

    it('snaps 07:15 to 07:30:30', () => {
        vi.setSystemTime(new Date(2025, 0, 1, 7, 15, 0, 0));
        const { nextTime } = getNextQuarterHour();
        expect(nextTime.getHours()).toBe(7);
        expect(nextTime.getMinutes()).toBe(30);
    });

    it('wraps hour at 07:45 → 08:00:30', () => {
        vi.setSystemTime(new Date(2025, 0, 1, 7, 45, 0, 0));
        const { nextTime } = getNextQuarterHour();
        expect(nextTime.getHours()).toBe(8);
        expect(nextTime.getMinutes()).toBe(0);
        expect(nextTime.getSeconds()).toBe(30);
    });

    it('returns positive msUntil', () => {
        vi.setSystemTime(new Date(2025, 0, 1, 7, 14, 0, 0));
        const { msUntil } = getNextQuarterHour();
        expect(msUntil).toBeGreaterThan(0);
    });
});

// ---- DB Format Round-Trip ----

describe('toDbFormat / fromDbFormat', () => {
    it('round-trips core fields correctly', () => {
        const entry = {
            id: 'test-123',
            userId: 'user-456',
            voyageId: 'voyage-789',
            timestamp: '2025-01-01T00:00:00Z',
            latitude: -27.47,
            longitude: 153.02,
            speedKts: 6.5,
            distanceNM: 1.2,
            cumulativeDistanceNM: 10.5,
            courseDeg: 180,
            entryType: 'auto' as const,
            source: 'device' as const,
        };

        const dbRow = toDbFormat(entry);
        expect(dbRow.user_id).toBe('user-456');
        expect(dbRow.voyage_id).toBe('voyage-789');
        expect(dbRow.speed_kts).toBe(6.5);
        expect(dbRow.distance_nm).toBe(1.2);
        expect(dbRow.entry_type).toBe('auto');

        const restored = fromDbFormat(dbRow);
        expect(restored.userId).toBe('user-456');
        expect(restored.voyageId).toBe('voyage-789');
        expect(restored.speedKts).toBe(6.5);
        expect(restored.entryType).toBe('auto');
    });

    it('excludes unmapped fields in toDbFormat', () => {
        const entry = { id: 'test', unknownField: 'should-be-dropped' } as any;
        const dbRow = toDbFormat(entry);
        expect(dbRow.id).toBe('test');
        expect(dbRow.unknownField).toBeUndefined();
        expect(dbRow.unknown_field).toBeUndefined();
    });

    it('handles undefined values by excluding them', () => {
        const entry = { id: 'test', windSpeed: undefined };
        const dbRow = toDbFormat(entry);
        expect(dbRow.id).toBe('test');
        expect('wind_speed' in dbRow).toBe(false);
    });
});

// ---- Zone Helpers ----

describe('getIntervalForZone', () => {
    it('returns 30s for nearshore', () => {
        expect(getIntervalForZone('nearshore')).toBe(NEARSHORE_INTERVAL_MS);
        expect(getIntervalForZone('nearshore')).toBe(30_000);
    });

    it('returns 2min for coastal', () => {
        expect(getIntervalForZone('coastal')).toBe(COASTAL_INTERVAL_MS);
    });

    it('returns 15min for offshore', () => {
        expect(getIntervalForZone('offshore')).toBe(OFFSHORE_INTERVAL_MS);
    });
});

describe('getZoneLabel', () => {
    it('returns label with interval for each zone', () => {
        expect(getZoneLabel('nearshore')).toContain('30s');
        expect(getZoneLabel('coastal')).toContain('2min');
        expect(getZoneLabel('offshore')).toContain('15min');
    });
});
