/**
 * Tests for day's-runs (noon-to-noon) windowing and personal-records
 * rollup — the two wave-2 logbook helpers.
 */
import { describe, it, expect } from 'vitest';
import { groupEntriesByNoonWindow } from '../utils/voyageData';
import { computePersonalRecords, type VoyageSummary } from '../services/shiplog/VoyageSummary';
import type { ShipLogEntry } from '../types';

// Build an entry at a LOCAL date/time so noon windows are deterministic
// regardless of the test machine's timezone.
function at(y: number, mo: number, d: number, h: number, min: number, distanceNM = 0): ShipLogEntry {
    const ts = new Date(y, mo - 1, d, h, min, 0, 0).toISOString();
    return {
        id: ts,
        voyageId: 'v1',
        timestamp: ts,
        latitude: -27,
        longitude: 153,
        entryType: 'auto',
        distanceNM,
    } as ShipLogEntry;
}

describe('groupEntriesByNoonWindow', () => {
    it('splits a voyage across a noon boundary into two numbered runs', () => {
        const es = [
            at(2026, 6, 1, 13, 0, 2), // after noon Jun 1 → window A
            at(2026, 6, 1, 23, 0, 3), // window A
            at(2026, 6, 2, 6, 0, 4), // before noon Jun 2 → still window A
            at(2026, 6, 2, 13, 0, 5), // after noon Jun 2 → window B
        ];
        const runs = groupEntriesByNoonWindow(es);
        expect(runs).toHaveLength(2);
        expect(runs[0].dayNumber).toBe(1);
        expect(runs[1].dayNumber).toBe(2);
        // Window A summed per-leg distance = 2+3+4 = 9; B = 5.
        expect(runs[0].distanceNM).toBeCloseTo(9);
        expect(runs[1].distanceNM).toBeCloseTo(5);
        expect(runs[0].entryCount).toBe(3);
    });

    it('an entry exactly at noon opens the new window', () => {
        const es = [at(2026, 6, 1, 11, 59, 1), at(2026, 6, 1, 12, 0, 2)];
        const runs = groupEntriesByNoonWindow(es);
        expect(runs).toHaveLength(2);
    });

    it('sums per-leg distanceNM, never diffs cumulative (turn pins are 0)', () => {
        // A turn pin contributes distanceNM 0; must not inflate the run.
        const es = [at(2026, 6, 1, 13, 0, 4), at(2026, 6, 1, 14, 0, 0), at(2026, 6, 1, 15, 0, 6)];
        expect(groupEntriesByNoonWindow(es)[0].distanceNM).toBeCloseTo(10);
    });

    it('single-day voyage → one run', () => {
        const es = [at(2026, 6, 1, 13, 0, 3), at(2026, 6, 1, 18, 0, 4)];
        expect(groupEntriesByNoonWindow(es)).toHaveLength(1);
    });

    it('empty input → no runs', () => {
        expect(groupEntriesByNoonWindow([])).toEqual([]);
    });
});

function sv(over: Partial<VoyageSummary>): VoyageSummary {
    return {
        voyageId: 'v',
        entryCount: 10,
        startedAt: '2026-06-01T00:00:00Z',
        endedAt: '2026-06-01T02:00:00Z',
        totalDistanceNM: 10,
        avgSpeedKts: 5,
        hasManual: false,
        isPlannedRoute: false,
        isImported: false,
        firstLat: -27,
        firstLon: 153,
        lastLat: -27,
        lastLon: 153,
        firstIsOnWater: true,
        landFraction: 0,
        ...over,
    };
}

describe('computePersonalRecords', () => {
    it('picks the longest passage, fastest average and longest duration', () => {
        const r = computePersonalRecords([
            sv({
                voyageId: 'a',
                totalDistanceNM: 12,
                avgSpeedKts: 4,
                startedAt: '2026-06-01T00:00:00Z',
                endedAt: '2026-06-01T03:00:00Z',
            }),
            sv({
                voyageId: 'b',
                totalDistanceNM: 80,
                avgSpeedKts: 6,
                startedAt: '2026-06-02T00:00:00Z',
                endedAt: '2026-06-02T20:00:00Z',
            }),
            sv({
                voyageId: 'c',
                totalDistanceNM: 30,
                avgSpeedKts: 9,
                startedAt: '2026-06-03T00:00:00Z',
                endedAt: '2026-06-03T05:00:00Z',
            }),
        ]);
        expect(r.voyageCount).toBe(3);
        expect(r.longestPassageVoyageId).toBe('b');
        expect(r.longestPassageNM).toBe(80);
        expect(r.fastestVoyageId).toBe('c');
        expect(r.fastestAvgKts).toBe(9);
        expect(r.longestDurationVoyageId).toBe('b');
        expect(r.longestDurationMs).toBe(20 * 3600 * 1000);
    });

    it('excludes planned, imported and land-majority voyages from records', () => {
        const r = computePersonalRecords([
            sv({ voyageId: 'planned', totalDistanceNM: 500, isPlannedRoute: true }),
            sv({ voyageId: 'gpx', totalDistanceNM: 500, isImported: true }),
            sv({ voyageId: 'drive', totalDistanceNM: 500, landFraction: 0.9 }),
            sv({ voyageId: 'sailed', totalDistanceNM: 15 }),
        ]);
        expect(r.voyageCount).toBe(1);
        expect(r.longestPassageVoyageId).toBe('sailed');
        expect(r.longestPassageNM).toBe(15);
    });

    it('empty / no-qualifying history → zeroed records, voyageCount 0', () => {
        expect(computePersonalRecords([]).voyageCount).toBe(0);
        expect(computePersonalRecords([sv({ isImported: true })]).longestPassageVoyageId).toBeNull();
    });
});
