import { describe, expect, it } from 'vitest';
import type { ShipLogEntry } from '../types';
import {
    formatVoyageDuration,
    mergeVoyageDepartureTime,
    voyageDepartureTime,
    voyageElapsedMs,
} from '../utils/voyageTiming';
import { calculateVoyageStats } from '../utils/voyageData';
import { deriveLiveStats } from '../pages/log/logPageDerive';
import { summarizeEntries, mergeSummariesWithLive, careerTotalsFromSummaries } from '../services/shiplog/VoyageSummary';

const epoch = Date.parse('2026-09-23T00:00:00Z');
const iso = (seconds: number) => new Date(epoch + seconds * 1000).toISOString();
const fix = (seconds: number, metres = 0, speed = 0, overrides: Partial<ShipLogEntry> = {}): ShipLogEntry => ({
    id: String(seconds),
    userId: 'test',
    voyageId: 'sailing',
    timestamp: iso(seconds),
    latitude: -27 + metres / 111195,
    longitude: 153,
    positionFormatted: '',
    speedKts: speed,
    cumulativeDistanceNM: metres / 1852,
    entryType: 'auto',
    source: 'device',
    ...overrides,
});
const sailing = [fix(0), fix(3600), fix(7200, 0, 2), fix(7220, 20, 2), fix(7240, 40, 2), fix(10800, 1000, 0)];

describe('GPS departure timing', () => {
    it('formats partial days consistently without rounding up or losing hours', () => {
        expect(formatVoyageDuration(46.27 * 3600000)).toBe('1d 22h');
        expect(formatVoyageDuration(25 * 3600000)).toBe('1d 1h');
        expect(formatVoyageDuration(8.15 * 3600000)).toBe('8h 9m');
        expect(formatVoyageDuration(24 * 3600000)).toBe('1d 0h');
        expect(formatVoyageDuration(0)).toBe('0h 0m');
        expect(formatVoyageDuration(NaN)).toBe('—');
    });
    it('also removes confirmed predeparture dock time from dense historical GPS tracks', () => {
        const historical = sailing.map((e) => ({
            ...e,
            timestamp: new Date(Date.parse(e.timestamp) - 86400000).toISOString(),
        }));
        expect(voyageDepartureTime(historical)).toBe(iso(7200 - 86400));
        expect(voyageElapsedMs(summarizeEntries(historical)[0])).toBe(3600_000);
    });
    it('leaves the clock at zero while recording at the berth', () => {
        const docked = [fix(0), fix(3600, 4, 0.1), fix(7200, -4, 0.2)];
        expect(voyageDepartureTime(docked)).toBeNull();
        expect(deriveLiveStats(docked, 'sailing')).toMatchObject({ durationHrs: 0, durationMins: 0, departedAt: null });
        expect(calculateVoyageStats(docked)?.durationMinutes).toBe(0);
    });

    it('backdates to the start of sustained movement, excludes two hours at dock and keeps later stops', () => {
        expect(voyageDepartureTime([...sailing].reverse())).toBe(iso(7200));
        const live = deriveLiveStats(sailing, 'sailing');
        expect(live).toMatchObject({ durationHrs: 1, durationMins: 0, departedAt: iso(7200) });
        expect(live.activeEntries).toHaveLength(sailing.length); // no points removed
        expect(calculateVoyageStats(sailing)?.durationMinutes).toBe(60);
        const summary = summarizeEntries(sailing)[0];
        expect(summary.startedAt).toBe(iso(0)); // raw recording bounds untouched
        expect(summary.departedAt).toBe(iso(7200));
        expect(voyageElapsedMs(summary)).toBe(3600_000);
        expect(careerTotalsFromSummaries([summary]).totalTimeAtSeaHrs).toBe(1);
    });

    it('rejects one fast GPS jump, repeated timestamps, stationary position with fast speed and zero accrued distance', () => {
        expect(voyageDepartureTime([fix(0), fix(10, 100, 8), fix(20), fix(40)])).toBeNull();
        expect(voyageDepartureTime([fix(0, 0, 2), fix(0, 20, 2), fix(40, 50, 2)])).toBeNull();
        expect(voyageDepartureTime([fix(0, 0, 6), fix(20, 0, 6), fix(40, 0, 6)])).toBeNull();
        expect(voyageDepartureTime([0, 20, 40].map((t) => fix(t, t, 2, { cumulativeDistanceNM: 0 })))).toBeNull();
    });

    it('requires enough elapsed time and breaks confirmation on GPS gaps, stops or invalid positions', () => {
        expect(voyageDepartureTime([fix(0, 0, 8), fix(2, 20, 8), fix(4, 40, 8)])).toBeNull();
        expect(voyageDepartureTime([fix(0, 0, 2), fix(1400, 20, 2), fix(1440, 40, 2)])).toBeNull();
        expect(voyageDepartureTime([fix(0, 0, 2), fix(20), fix(40, 40, 2)])).toBeNull();
        expect(voyageDepartureTime([fix(0, 0, 2), fix(20, 20, 2, { latitude: 91 }), fix(40, 40, 2)])).toBeNull();
    });

    it('preserves imported/planned timestamps and older summary compatibility', () => {
        const historical = [fix(-86400), fix(-80000)];
        expect(voyageDepartureTime(historical)).toBe(iso(-86400));
        expect(voyageDepartureTime([fix(0, 0, 0, { source: 'gpx_import' }), fix(3600)])).toBe(iso(0));
        expect(voyageElapsedMs({ startedAt: iso(0), endedAt: iso(3600) })).toBe(3600_000);
        expect(voyageElapsedMs({ startedAt: iso(0), endedAt: iso(3600), departedAt: null })).toBe(0);
    });

    it('keeps cloud departure when reopening with only the final stationary track points', () => {
        const server = summarizeEntries(sailing)[0];
        const tail = [fix(10800, 1000)];
        expect(deriveLiveStats(tail, 'sailing', server)).toMatchObject({ durationHrs: 1, departedAt: iso(7200) });
        expect(mergeSummariesWithLive([server], tail)[0].departedAt).toBe(iso(7200));
        expect(
            mergeVoyageDepartureTime({ ...server, departedAt: undefined }, summarizeEntries(tail)[0]),
        ).toBeUndefined();
    });

    it('a full local series can establish awaiting departure even against an old server', () => {
        const entries = [fix(0), fix(3600)];
        const server = { ...summarizeEntries(entries)[0], departedAt: undefined };
        expect(deriveLiveStats(entries, 'sailing', server)).toMatchObject({ durationHrs: 0, departedAt: null });
    });
});
