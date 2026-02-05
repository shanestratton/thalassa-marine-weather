/**
 * Unit Tests for Voyage Data Utilities
 * Tests grouping, filtering, searching, and statistics calculations
 */

import { describe, it, expect } from 'vitest';
import {
    groupEntriesByDate,
    calculateVoyageStats,
    filterEntriesByType,
    searchEntries
} from '../utils/voyageData';
import { ShipLogEntry } from '../types';

// Mock data helper
const createMockEntry = (overrides: Partial<ShipLogEntry> = {}): ShipLogEntry => ({
    id: 'test-' + Math.random(),
    userId: 'test-user',
    voyageId: 'test-voyage',
    timestamp: new Date('2026-02-01T12:00:00Z').toISOString(),
    latitude: -27.2086,
    longitude: 153.0874,
    positionFormatted: "27°12.5'S 153°5.2'E",
    distanceNM: 1.5,
    cumulativeDistanceNM: 10.0,
    speedKts: 6.0,
    courseDeg: 85,
    entryType: 'auto',
    ...overrides
});

describe('Voyage Data Utilities', () => {
    describe('groupEntriesByDate', () => {
        it('should group entries by date', () => {
            const entries: ShipLogEntry[] = [
                createMockEntry({ timestamp: '2026-02-01T10:00:00Z' }),
                createMockEntry({ timestamp: '2026-02-01T14:00:00Z' }),
                createMockEntry({ timestamp: '2026-02-02T10:00:00Z' }),
                createMockEntry({ timestamp: '2026-02-02T14:00:00Z' }),
                createMockEntry({ timestamp: '2026-02-03T10:00:00Z' })
            ];

            const grouped = groupEntriesByDate(entries);

            expect(grouped).toHaveLength(3);
            expect(grouped[0].date).toBe('2026-02-03'); // Most recent first
            expect(grouped[0].entries).toHaveLength(1);
            expect(grouped[1].date).toBe('2026-02-02');
            expect(grouped[1].entries).toHaveLength(2);
            expect(grouped[2].date).toBe('2026-02-01');
            expect(grouped[2].entries).toHaveLength(2);
        });

        it('should calculate daily statistics', () => {
            const entries: ShipLogEntry[] = [
                createMockEntry({ speedKts: 6.0, distanceNM: 1.5 }),
                createMockEntry({ speedKts: 8.0, distanceNM: 2.0 }),
                createMockEntry({ speedKts: 7.0, distanceNM: 1.75 })
            ];

            const grouped = groupEntriesByDate(entries);

            expect(grouped[0].stats.avgSpeed).toBeCloseTo(7.0, 1);
            expect(grouped[0].stats.maxSpeed).toBe(8.0);
            expect(grouped[0].stats.totalDistance).toBeCloseTo(5.25, 2);
            expect(grouped[0].stats.entryCount).toBe(3);
        });

        it('should format display date correctly', () => {
            const entries: ShipLogEntry[] = [
                createMockEntry({ timestamp: '2026-02-15T12:00:00Z' })
            ];

            const grouped = groupEntriesByDate(entries);

            expect(grouped[0].displayDate).toContain('February');
            expect(grouped[0].displayDate).toContain('15');
            expect(grouped[0].displayDate).toContain('2026');
        });

        it('should handle empty array', () => {
            const grouped = groupEntriesByDate([]);
            expect(grouped).toHaveLength(0);
        });
    });

    describe('calculateVoyageStats', () => {
        it('should return null for empty entries', () => {
            const stats = calculateVoyageStats([]);
            expect(stats).toBeNull();
        });

        it('should calculate total distance correctly', () => {
            const entries: ShipLogEntry[] = [
                createMockEntry({ cumulativeDistanceNM: 100.5 }), // Most recent (first in array)
                createMockEntry({ cumulativeDistanceNM: 50.2 })
            ];

            const stats = calculateVoyageStats(entries);

            expect(stats?.totalDistance).toBe(100.5);
        });

        it('should calculate speed statistics', () => {
            const entries: ShipLogEntry[] = [
                createMockEntry({ speedKts: 6.0 }),
                createMockEntry({ speedKts: 8.0 }),
                createMockEntry({ speedKts: 4.0 }),
                createMockEntry({ speedKts: 7.0 })
            ];

            const stats = calculateVoyageStats(entries);

            expect(stats?.avgSpeed).toBeCloseTo(6.25, 2);
            expect(stats?.maxSpeed).toBe(8.0);
            expect(stats?.minSpeed).toBe(4.0);
        });

        it('should count entry types', () => {
            const entries: ShipLogEntry[] = [
                createMockEntry({ entryType: 'auto' }),
                createMockEntry({ entryType: 'auto' }),
                createMockEntry({ entryType: 'waypoint' }),
                createMockEntry({ entryType: 'manual' })
            ];

            const stats = calculateVoyageStats(entries);

            expect(stats?.totalEntries).toBe(4);
            expect(stats?.waypointCount).toBe(1);
            expect(stats?.manualEntryCount).toBe(1);
        });

        it('should calculate weather averages', () => {
            const entries: ShipLogEntry[] = [
                createMockEntry({ windSpeed: 10, waveHeight: 1.5, airTemp: 25 }),
                createMockEntry({ windSpeed: 15, waveHeight: 2.0, airTemp: 27 }),
                createMockEntry({ windSpeed: 12, waveHeight: 1.8, airTemp: 26 })
            ];

            const stats = calculateVoyageStats(entries);

            expect(stats?.weather.avgWindSpeed).toBeCloseTo(12.33, 1);
            expect(stats?.weather.avgWaveHeight).toBeCloseTo(1.77, 1);
            expect(stats?.weather.avgAirTemp).toBeCloseTo(26, 0);
        });

        it('should calculate duration correctly', () => {
            const entries: ShipLogEntry[] = [
                createMockEntry({ timestamp: '2026-02-03T12:00:00Z' }), // End (newest)
                createMockEntry({ timestamp: '2026-02-01T06:00:00Z' })  // Start (oldest)
            ];

            const stats = calculateVoyageStats(entries);

            expect(stats?.totalTime).toContain('2d'); // ~2.25 days
        });
    });

    describe('filterEntriesByType', () => {
        const mixedEntries: ShipLogEntry[] = [
            createMockEntry({ entryType: 'auto', id: 'auto1' }),
            createMockEntry({ entryType: 'manual', id: 'manual1' }),
            createMockEntry({ entryType: 'waypoint', id: 'waypoint1' }),
            createMockEntry({ entryType: 'auto', id: 'auto2' })
        ];

        it('should filter by single type', () => {
            const filtered = filterEntriesByType(mixedEntries, ['auto']);
            expect(filtered).toHaveLength(2);
            expect(filtered.every(e => e.entryType === 'auto')).toBe(true);
        });

        it('should filter by multiple types', () => {
            const filtered = filterEntriesByType(mixedEntries, ['auto', 'waypoint']);
            expect(filtered).toHaveLength(3);
        });

        it('should return all entries for empty filter', () => {
            const filtered = filterEntriesByType(mixedEntries, []);
            expect(filtered).toHaveLength(4);
        });

        it('should return empty for no matches', () => {
            const filtered = filterEntriesByType(
                [createMockEntry({ entryType: 'auto' })],
                ['manual']
            );
            expect(filtered).toHaveLength(0);
        });
    });

    describe('searchEntries', () => {
        const entriesWithNotes: ShipLogEntry[] = [
            createMockEntry({
                notes: 'Spotted dolphins off starboard',
                id: 'dolphin'
            }),
            createMockEntry({
                waypointName: 'North Stradbroke Clear',
                id: 'stradbroke'
            }),
            createMockEntry({
                notes: 'Reduced sail due to squall',
                id: 'squall'
            }),
            createMockEntry({
                notes: 'Beautiful sunset',
                id: 'sunset'
            })
        ];

        it('should find entries by note content', () => {
            const results = searchEntries(entriesWithNotes, 'dolphins');
            expect(results).toHaveLength(1);
            expect(results[0].id).toBe('dolphin');
        });

        it('should find entries by waypoint name', () => {
            const results = searchEntries(entriesWithNotes, 'Stradbroke');
            expect(results).toHaveLength(1);
            expect(results[0].id).toBe('stradbroke');
        });

        it('should be case insensitive', () => {
            const results = searchEntries(entriesWithNotes, 'DOLPHINS');
            expect(results).toHaveLength(1);
        });

        it('should return all entries for empty query', () => {
            const results = searchEntries(entriesWithNotes, '');
            expect(results).toHaveLength(4);
        });

        it('should return all entries for whitespace query', () => {
            const results = searchEntries(entriesWithNotes, '   ');
            expect(results).toHaveLength(4);
        });

        it('should find partial matches', () => {
            const results = searchEntries(entriesWithNotes, 'sail');
            expect(results).toHaveLength(1);
            expect(results[0].id).toBe('squall');
        });
    });

    describe('Edge cases and data integrity', () => {
        it('should handle entries without optional fields', () => {
            const entries: ShipLogEntry[] = [
                createMockEntry({
                    speedKts: undefined,
                    windSpeed: undefined,
                    waveHeight: undefined
                })
            ];

            const stats = calculateVoyageStats(entries);

            expect(stats?.avgSpeed).toBe(0);
            expect(stats?.weather.avgWindSpeed).toBe(0);
            expect(stats?.weather.avgWaveHeight).toBe(0);
        });

        it('should preserve entry order in grouping', () => {
            const entries: ShipLogEntry[] = [
                createMockEntry({ timestamp: '2026-02-01T10:00:00Z', id: 'entry1' }),
                createMockEntry({ timestamp: '2026-02-01T12:00:00Z', id: 'entry2' }),
                createMockEntry({ timestamp: '2026-02-01T14:00:00Z', id: 'entry3' })
            ];

            const grouped = groupEntriesByDate(entries);

            expect(grouped[0].entries[0].id).toBe('entry1');
            expect(grouped[0].entries[1].id).toBe('entry2');
            expect(grouped[0].entries[2].id).toBe('entry3');
        });
    });
});
