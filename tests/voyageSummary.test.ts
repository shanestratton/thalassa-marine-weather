/**
 * Tests for summarizeEntries — the pure client-side voyage roll-up that
 * backs the Log list (and is the contract the get_voyage_summaries RPC
 * mirrors). Pins down counts, distance, duration window, avg speed,
 * source-flag detection, and first/last coordinate extraction.
 */

import { describe, it, expect } from 'vitest';
import {
    summarizeEntries,
    mergeSummariesWithLive,
    careerTotalsFromSummaries,
    type VoyageSummary,
} from '../services/shiplog/VoyageSummary';
import type { ShipLogEntry } from '../types';

const mk = (o: Partial<ShipLogEntry>): ShipLogEntry =>
    ({
        id: o.id ?? `e-${Math.random()}`,
        userId: 'u1',
        voyageId: o.voyageId ?? 'v1',
        timestamp: o.timestamp ?? '2026-02-01T00:00:00.000Z',
        latitude: o.latitude ?? -27.5,
        longitude: o.longitude ?? 153.0,
        positionFormatted: '',
        cumulativeDistanceNM: o.cumulativeDistanceNM,
        speedKts: o.speedKts,
        entryType: o.entryType ?? 'auto',
        source: o.source,
        isOnWater: o.isOnWater,
        ...o,
    }) as ShipLogEntry;

describe('summarizeEntries', () => {
    it('groups by voyageId and counts entries', () => {
        const out = summarizeEntries([mk({ voyageId: 'a' }), mk({ voyageId: 'a' }), mk({ voyageId: 'b' })]);
        const a = out.find((s) => s.voyageId === 'a')!;
        const b = out.find((s) => s.voyageId === 'b')!;
        expect(a.entryCount).toBe(2);
        expect(b.entryCount).toBe(1);
    });

    it('uses MAX cumulative distance as the voyage total', () => {
        const out = summarizeEntries([
            mk({ voyageId: 'a', cumulativeDistanceNM: 3 }),
            mk({ voyageId: 'a', cumulativeDistanceNM: 17.4 }),
            mk({ voyageId: 'a', cumulativeDistanceNM: 12 }),
        ]);
        expect(out[0].totalDistanceNM).toBeCloseTo(17.4);
    });

    it('captures the start/end window from earliest + latest timestamps', () => {
        const out = summarizeEntries([
            mk({ voyageId: 'a', timestamp: '2026-02-01T08:00:00.000Z' }),
            mk({ voyageId: 'a', timestamp: '2026-02-01T06:00:00.000Z' }),
            mk({ voyageId: 'a', timestamp: '2026-02-01T10:30:00.000Z' }),
        ]);
        expect(out[0].startedAt).toBe('2026-02-01T06:00:00.000Z');
        expect(out[0].endedAt).toBe('2026-02-01T10:30:00.000Z');
    });

    it('extracts first/last coordinates by timestamp order', () => {
        const out = summarizeEntries([
            mk({ voyageId: 'a', timestamp: '2026-02-01T10:00:00.000Z', latitude: -20, longitude: 148 }),
            mk({ voyageId: 'a', timestamp: '2026-02-01T06:00:00.000Z', latitude: -27.5, longitude: 153 }),
        ]);
        expect(out[0].firstLat).toBe(-27.5);
        expect(out[0].firstLon).toBe(153);
        expect(out[0].lastLat).toBe(-20);
        expect(out[0].lastLon).toBe(148);
    });

    it('averages only moving entries (speed > 0)', () => {
        const out = summarizeEntries([
            mk({ voyageId: 'a', speedKts: 0 }),
            mk({ voyageId: 'a', speedKts: 6 }),
            mk({ voyageId: 'a', speedKts: 4 }),
            mk({ voyageId: 'a', speedKts: undefined }),
        ]);
        expect(out[0].avgSpeedKts).toBeCloseTo(5); // (6+4)/2, zeros + undefined excluded
    });

    it('reports avgSpeed 0 when nothing moved', () => {
        const out = summarizeEntries([mk({ voyageId: 'a', speedKts: 0 }), mk({ voyageId: 'a' })]);
        expect(out[0].avgSpeedKts).toBe(0);
    });

    it('detects manual entries', () => {
        const out = summarizeEntries([
            mk({ voyageId: 'a', entryType: 'auto' }),
            mk({ voyageId: 'a', entryType: 'manual' }),
        ]);
        expect(out[0].hasManual).toBe(true);
    });

    it('flags planned routes and imports distinctly', () => {
        const planned = summarizeEntries([mk({ voyageId: 'p', source: 'planned_route' })])[0];
        expect(planned.isPlannedRoute).toBe(true);
        expect(planned.isImported).toBe(false);

        const imported = summarizeEntries([mk({ voyageId: 'i', source: 'gpx_import' })])[0];
        expect(imported.isImported).toBe(true);
        expect(imported.isPlannedRoute).toBe(false);

        const device = summarizeEntries([mk({ voyageId: 'd', source: 'device' })])[0];
        expect(device.isImported).toBe(false);
        expect(device.isPlannedRoute).toBe(false);
    });

    it('carries the first entry is_on_water flag', () => {
        const out = summarizeEntries([
            mk({ voyageId: 'a', timestamp: '2026-02-01T06:00:00.000Z', isOnWater: true }),
            mk({ voyageId: 'a', timestamp: '2026-02-01T10:00:00.000Z', isOnWater: false }),
        ]);
        expect(out[0].firstIsOnWater).toBe(true);
    });

    it('computes landFraction over entries that carry water data', () => {
        const out = summarizeEntries([
            mk({ voyageId: 'a', isOnWater: false }),
            mk({ voyageId: 'a', isOnWater: false }),
            mk({ voyageId: 'a', isOnWater: true }),
            mk({ voyageId: 'a', isOnWater: undefined }), // no data — excluded from denominator
        ]);
        expect(out[0].landFraction).toBeCloseTo(2 / 3);
    });

    it('reports landFraction null when no entry has water data', () => {
        const out = summarizeEntries([mk({ voyageId: 'a', isOnWater: undefined })]);
        expect(out[0].landFraction).toBeNull();
    });

    it('returns voyages newest-first by latest entry', () => {
        const out = summarizeEntries([
            mk({ voyageId: 'old', timestamp: '2026-01-01T00:00:00.000Z' }),
            mk({ voyageId: 'new', timestamp: '2026-03-01T00:00:00.000Z' }),
            mk({ voyageId: 'mid', timestamp: '2026-02-01T00:00:00.000Z' }),
        ]);
        expect(out.map((s) => s.voyageId)).toEqual(['new', 'mid', 'old']);
    });

    it('handles an empty list', () => {
        expect(summarizeEntries([])).toEqual([]);
    });

    it('falls back to default_voyage bucket for entries with no voyageId', () => {
        const out = summarizeEntries([mk({ voyageId: undefined as unknown as string })]);
        expect(out[0].voyageId).toBe('default_voyage');
    });
});

describe('mergeSummariesWithLive', () => {
    const serverSummary = (voyageId: string, endedAt: string, dist: number): VoyageSummary => ({
        voyageId,
        entryCount: 10,
        startedAt: '2026-02-01T00:00:00.000Z',
        endedAt,
        totalDistanceNM: dist,
        avgSpeedKts: 5,
        hasManual: false,
        isPlannedRoute: false,
        isImported: false,
        firstLat: -27,
        firstLon: 153,
        lastLat: -20,
        lastLon: 148,
        firstIsOnWater: true,
        landFraction: 0,
    });

    it('passes summaries through untouched when there are no local entries', () => {
        const summaries = [serverSummary('a', '2026-02-01T10:00:00.000Z', 50)];
        expect(mergeSummariesWithLive(summaries, [])).toBe(summaries);
    });

    it('overlays a live recomputed summary for a loaded/active voyage', () => {
        const summaries = [serverSummary('a', '2026-02-01T10:00:00.000Z', 50)];
        // Active voyage 'a' has grown — local entries show more distance
        const entries = [
            mk({ voyageId: 'a', timestamp: '2026-02-01T10:00:00.000Z', cumulativeDistanceNM: 50 }),
            mk({ voyageId: 'a', timestamp: '2026-02-01T11:30:00.000Z', cumulativeDistanceNM: 63 }),
        ];
        const merged = mergeSummariesWithLive(summaries, entries);
        expect(merged).toHaveLength(1);
        expect(merged[0].totalDistanceNM).toBeCloseTo(63); // live wins over stale 50
        expect(merged[0].entryCount).toBe(2);
        expect(merged[0].endedAt).toBe('2026-02-01T11:30:00.000Z');
    });

    it('inserts a brand-new active voyage the server has not seen yet', () => {
        const summaries = [serverSummary('old', '2026-01-01T00:00:00.000Z', 20)];
        const entries = [mk({ voyageId: 'new', timestamp: '2026-03-01T00:00:00.000Z', cumulativeDistanceNM: 4 })];
        const merged = mergeSummariesWithLive(summaries, entries);
        expect(merged.map((s) => s.voyageId)).toEqual(['new', 'old']); // newest-first
        expect(merged.find((s) => s.voyageId === 'new')!.entryCount).toBe(1);
    });

    it('does not duplicate a voyage that exists both server-side and locally', () => {
        const summaries = [
            serverSummary('a', '2026-02-01T10:00:00.000Z', 50),
            serverSummary('b', '2026-01-15T10:00:00.000Z', 30),
        ];
        const entries = [mk({ voyageId: 'a', cumulativeDistanceNM: 55 })];
        const merged = mergeSummariesWithLive(summaries, entries);
        expect(merged).toHaveLength(2);
        expect(merged.filter((s) => s.voyageId === 'a')).toHaveLength(1);
    });

    it('leaves untouched voyages that have no local entries', () => {
        const summaries = [
            serverSummary('a', '2026-02-01T10:00:00.000Z', 50),
            serverSummary('b', '2026-01-15T10:00:00.000Z', 30),
        ];
        const entries = [mk({ voyageId: 'a', cumulativeDistanceNM: 55 })];
        const merged = mergeSummariesWithLive(summaries, entries);
        const b = merged.find((s) => s.voyageId === 'b')!;
        expect(b.totalDistanceNM).toBe(30); // server copy preserved
    });
});

describe('careerTotalsFromSummaries', () => {
    const summary = (over: Partial<VoyageSummary>): VoyageSummary => ({
        voyageId: 'v',
        entryCount: 10,
        startedAt: '2026-02-01T00:00:00.000Z',
        endedAt: '2026-02-01T05:00:00.000Z',
        totalDistanceNM: 20,
        avgSpeedKts: 5,
        hasManual: false,
        isPlannedRoute: false,
        isImported: false,
        firstLat: -27,
        firstLon: 153,
        lastLat: -20,
        lastLon: 148,
        firstIsOnWater: true,
        landFraction: 0,
        ...over,
    });

    it('sums distance, time and count over own maritime voyages', () => {
        const totals = careerTotalsFromSummaries([
            summary({
                voyageId: 'a',
                totalDistanceNM: 20,
                startedAt: '2026-02-01T00:00:00Z',
                endedAt: '2026-02-01T05:00:00Z',
            }),
            summary({
                voyageId: 'b',
                totalDistanceNM: 30,
                startedAt: '2026-02-02T00:00:00Z',
                endedAt: '2026-02-02T03:00:00Z',
            }),
        ]);
        expect(totals.totalDistance).toBe(50);
        expect(totals.totalTimeAtSeaHrs).toBe(8); // 5h + 3h
        expect(totals.totalVoyages).toBe(2);
    });

    it('excludes imported and planned-route voyages', () => {
        const totals = careerTotalsFromSummaries([
            summary({ voyageId: 'own', totalDistanceNM: 20 }),
            summary({ voyageId: 'imported', totalDistanceNM: 99, isImported: true }),
            summary({ voyageId: 'planned', totalDistanceNM: 99, isPlannedRoute: true }),
        ]);
        expect(totals.totalVoyages).toBe(1);
        expect(totals.totalDistance).toBe(20);
    });

    it('excludes land tracks (landFraction >= 0.6) but keeps coastal/jittery ones', () => {
        const totals = careerTotalsFromSummaries([
            summary({ voyageId: 'sea', totalDistanceNM: 20, landFraction: 0.1 }),
            summary({ voyageId: 'coastal', totalDistanceNM: 15, landFraction: 0.59 }),
            summary({ voyageId: 'cardrive', totalDistanceNM: 99, landFraction: 0.95 }),
        ]);
        expect(totals.totalVoyages).toBe(2);
        expect(totals.totalDistance).toBe(35);
    });

    it('treats null landFraction as maritime (fail-open, no water data)', () => {
        const totals = careerTotalsFromSummaries([summary({ voyageId: 'a', landFraction: null })]);
        expect(totals.totalVoyages).toBe(1);
    });

    it('returns zeros for an empty history', () => {
        expect(careerTotalsFromSummaries([])).toEqual({
            totalDistance: 0,
            totalTimeAtSeaHrs: 0,
            totalVoyages: 0,
        });
    });
});
