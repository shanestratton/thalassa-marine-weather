import { describe, expect, it } from 'vitest';
import type { VoyageSummary } from '../services/shiplog/VoyageSummary';
import type { ShipLogEntry } from '../types';
import { lifetimeVoyageStats } from '../utils/lifetimeVoyageStats';

const voyage = (voyageId: string, overrides: Partial<VoyageSummary> = {}): VoyageSummary => ({
    voyageId,
    entryCount: 100,
    startedAt: '2026-09-23T00:00:00Z',
    departedAt: '2026-09-23T01:00:00Z',
    endedAt: '2026-09-23T03:00:00Z',
    totalDistanceNM: 12,
    avgSpeedKts: 6,
    hasManual: false,
    isPlannedRoute: false,
    isImported: false,
    landFraction: 0,
    firstIsOnWater: true,
    firstLat: -20,
    firstLon: 148,
    lastLat: -20.1,
    lastLon: 148.1,
    ...overrides,
});

describe('lifetime voyage statistics', () => {
    it('keeps all totals and records unchanged by archive or restore, including overlapping snapshots', () => {
        const a = voyage('a');
        const b = voyage('b', { totalDistanceNM: 20, avgSpeedKts: 7 });
        const baseline = lifetimeVoyageStats([a, b], []);
        expect(lifetimeVoyageStats([a], [b])).toEqual(baseline);
        expect(lifetimeVoyageStats([a, b], [b])).toEqual(baseline);
        expect(lifetimeVoyageStats([a, b], [])).toEqual(baseline);
        expect(baseline.totals).toEqual({ totalNm: 32, totalMs: 4 * 3600_000, voyageCount: 2 });
        expect(baseline.records).toMatchObject({ longestPassageNM: 20, fastestAvgKts: 7, voyageCount: 2 });
        expect(baseline.careerTotals).toEqual({ totalDistance: 32, totalTimeAtSeaHrs: 4, totalVoyages: 2 });
        expect(baseline.entryCount).toBe(200);
    });

    it('sums separate passage legs without counting stopover days or adding a group as an extra voyage', () => {
        const a = voyage('a', { passageGroupId: 'north' });
        const b = voyage('b', {
            passageGroupId: 'north',
            startedAt: '2026-09-25T00:00:00Z',
            departedAt: '2026-09-25T01:00:00Z',
            endedAt: '2026-09-25T04:00:00Z',
        });
        const c = voyage('c', { passageGroupId: 'north' });
        const stats = lifetimeVoyageStats([c], [a, b]);
        expect(stats.totals).toEqual({ totalNm: 36, totalMs: 7 * 3600_000, voyageCount: 3 });
        expect(stats.records.longestDurationMs).toBe(3 * 3600_000);
    });

    it('excludes plans, imports, land and explicit never-departed records from every metric', () => {
        const excluded = [
            voyage('plan', { isPlannedRoute: true }),
            voyage('import', { isImported: true }),
            voyage('land', { landFraction: 0.6 }),
            voyage('waiting', { departedAt: null }),
        ].map((summary) => ({ ...summary, totalDistanceNM: 10000, avgSpeedKts: 100 }));
        const good = voyage('good');
        expect(lifetimeVoyageStats([good, ...excluded], excluded)).toEqual(lifetimeVoyageStats([good], []));
    });

    it('retains legacy timing and unknown-water voyages without fabricating departure evidence', () => {
        const legacy = voyage('legacy', { departedAt: undefined, landFraction: null });
        expect(lifetimeVoyageStats([], [legacy]).totals).toEqual({
            totalNm: 12,
            totalMs: 3 * 3600_000,
            voyageCount: 1,
        });
    });

    it('prefers a complete archived summary over a shorter duplicate, and does not add their distance', () => {
        const whole = voyage('a');
        const tail = voyage('a', { entryCount: 1, totalDistanceNM: 0.1, departedAt: null });
        expect(lifetimeVoyageStats([tail], [whole])).toEqual(lifetimeVoyageStats([whole], []));
    });

    it('never lets a duplicate strip plan/import classification', () => {
        expect(lifetimeVoyageStats([voyage('a')], [voyage('a', { isPlannedRoute: true })]).totals.voyageCount).toBe(0);
        expect(lifetimeVoyageStats([voyage('a')], [voyage('a', { isImported: true })]).totals.voyageCount).toBe(0);
    });

    it('extends a live trip without losing established departure, cloud speed or the original distance', () => {
        const tail = {
            id: 'tail',
            userId: 'owner',
            voyageId: 'a',
            timestamp: '2026-09-23T04:00:00Z',
            latitude: -20.2,
            longitude: 148.2,
            entryType: 'auto',
            source: 'device',
            positionFormatted: '',
            cumulativeDistanceNM: 15,
            speedKts: 0,
        } as ShipLogEntry;
        const stats = lifetimeVoyageStats([voyage('a')], [voyage('a')], [tail]);
        expect(stats.totals).toEqual({ totalNm: 15, totalMs: 3 * 3600_000, voyageCount: 1 });
        expect(stats.records.fastestAvgKts).toBe(6);
        expect(stats.summaries[0].departedAt).toBe('2026-09-23T01:00:00Z');
        expect(stats.entryCount).toBe(100);
    });

    it('returns consistent zeros with no sailed history', () => {
        const stats = lifetimeVoyageStats([], []);
        expect(stats.totals).toEqual({ totalNm: 0, totalMs: 0, voyageCount: 0 });
        expect(stats.records.voyageCount).toBe(0);
        expect(stats.careerTotals.totalVoyages).toBe(0);
    });
});
