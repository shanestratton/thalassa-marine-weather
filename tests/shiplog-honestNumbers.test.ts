/**
 * The Ship's Log tells one story about a track.
 *
 * Shane, 2026-09-06, boat on the hard at Scarborough: the card said 0.1 nm,
 * the day rows under it said 1.6 + 1.0 = 2.6 NM, "Day 1" was dated the day
 * before the track began, the row said LIVE under a "Slide to start tracking"
 * slider, the max speed was 7.4 kts, and the track that went nowhere never
 * deleted itself. Each of those is pinned here.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
    DAY_RUNS_MIN_DURATION_MS,
    dayRunLabel,
    groupEntriesByDate,
    groupEntriesByNoonWindow,
    shouldShowDayRuns,
} from '../utils/voyageData';
import {
    EMPTY_TRACK_NM,
    EMPTY_TRACK_SPAN_M,
    isEmptyTrack,
    selectEmptyVoyagesToPrune,
    summarizeEntries,
    trackSpanM,
    type VoyageSummary,
} from '../services/shiplog/VoyageSummary';
import type { ShipLogEntry } from '../types';

const read = (p: string) => readFileSync(resolve(process.cwd(), p), 'utf8');

// Local wall-clock entries so noon windows and dates are deterministic.
function at(y: number, mo: number, d: number, h: number, min: number, over: Partial<ShipLogEntry> = {}): ShipLogEntry {
    const ts = new Date(y, mo - 1, d, h, min, 0, 0).toISOString();
    return {
        id: ts,
        voyageId: 'v1',
        timestamp: ts,
        latitude: -27.2,
        longitude: 153.11,
        entryType: 'auto',
        ...over,
    } as ShipLogEntry;
}

describe('distance made good comes from the gated total, not the raw hops', () => {
    // Two days. Raw legs sum to 1.2 and 2.0 NM; the gated total moved 0.5 then 0.2.
    const entries = [
        at(2026, 9, 5, 10, 0, { distanceNM: 0.6, cumulativeDistanceNM: 0 }),
        at(2026, 9, 5, 11, 0, { distanceNM: 0.6, cumulativeDistanceNM: 0.5 }),
        at(2026, 9, 6, 10, 0, { distanceNM: 1.0, cumulativeDistanceNM: 0.5 }),
        at(2026, 9, 6, 11, 0, { distanceNM: 1.0, cumulativeDistanceNM: 0.7 }),
    ];

    it('the date groups read the card’s numbers', () => {
        const groups = groupEntriesByDate(entries); // newest first
        expect(groups.map((g) => g.stats.totalDistance)).toHaveLength(2);
        expect(groups[0].stats.totalDistance).toBeCloseTo(0.2, 9);
        expect(groups[1].stats.totalDistance).toBeCloseTo(0.5, 9);
    });

    it('so do the noon-to-noon runs', () => {
        const runs = groupEntriesByNoonWindow(entries);
        // 05 Sep 10:00 and 11:00 fall in the 04 Sep-noon window; 06 Sep 10:00/11:00 in 05 Sep-noon.
        expect(runs).toHaveLength(2);
        expect(runs[0].distanceNM).toBeCloseTo(0.5, 9);
        expect(runs[1].distanceNM).toBeCloseTo(0.2, 9);
    });

    it('a jitter cloud with a growing hop sum but a flat total made good nothing', () => {
        // Yesterday she made 0.1 NM; today every hop is jitter and the total never moves.
        const still = [
            at(2026, 9, 5, 16, 0, { distanceNM: 0.1, cumulativeDistanceNM: 0.1 }),
            at(2026, 9, 6, 10, 0, { distanceNM: 0.01, cumulativeDistanceNM: 0.1 }),
            at(2026, 9, 6, 10, 1, { distanceNM: 0.01, cumulativeDistanceNM: 0.1 }),
            at(2026, 9, 6, 10, 2, { distanceNM: 0.01, cumulativeDistanceNM: 0.1 }),
        ];
        const today = groupEntriesByDate(still)[0]; // newest first
        expect(today.stats.entryCount).toBe(3);
        expect(today.stats.totalDistance).toBe(0);
    });

    it('entries without a running total fall back to the raw sum (imported, older builds)', () => {
        const legacy = [at(2026, 9, 6, 10, 0, { distanceNM: 3 }), at(2026, 9, 6, 11, 0, { distanceNM: 4 })];
        expect(groupEntriesByDate(legacy)[0].stats.totalDistance).toBe(7);
    });
});

describe('day’s runs are for passages', () => {
    it('a four-hour track that crosses noon is not a two-day passage', () => {
        const track = [at(2026, 9, 6, 10, 32), at(2026, 9, 6, 12, 30), at(2026, 9, 6, 14, 23)];
        const runs = groupEntriesByNoonWindow(track);
        expect(runs).toHaveLength(2); // two windows …
        expect(shouldShowDayRuns(runs, track)).toBe(false); // … but no panel
    });

    it('a thirty-hour passage gets the panel', () => {
        const passage = [at(2026, 9, 5, 8, 0), at(2026, 9, 5, 20, 0), at(2026, 9, 6, 14, 0)];
        expect(shouldShowDayRuns(groupEntriesByNoonWindow(passage), passage)).toBe(true);
        expect(DAY_RUNS_MIN_DURATION_MS).toBe(24 * 60 * 60 * 1000);
    });

    it('rows are labelled by the dates sailed, not by the noon the window opened', () => {
        const sameDay = groupEntriesByNoonWindow([at(2026, 9, 6, 10, 32), at(2026, 9, 6, 11, 50)])[0];
        expect(dayRunLabel(sameDay)).toBe('06 Sep');
        const overnight = groupEntriesByNoonWindow([at(2026, 9, 5, 13, 0), at(2026, 9, 6, 9, 0)])[0];
        expect(dayRunLabel(overnight)).toBe('05–06 Sep');
        expect(
            dayRunLabel({ firstTs: at(2026, 9, 30, 13, 0).timestamp, lastTs: at(2026, 10, 1, 9, 0).timestamp }),
        ).toBe('30 Sep–01 Oct');
    });
});

describe('a track that went nowhere deletes itself', () => {
    const m = (metres: number) => metres / 111_320; // degrees of latitude
    const cloud = [0, 12, -8, 20, -15, 5].map((dm, i) =>
        at(2026, 9, 6, 10, i, {
            latitude: -27.2 + m(dm),
            longitude: 153.11 + m(dm) / Math.cos((27.2 * Math.PI) / 180),
        }),
    );

    it('measures the footprint as the bounding-box diagonal, ignoring 0,0 placeholders', () => {
        const span = trackSpanM(cloud)!;
        expect(span).toBeGreaterThan(40);
        expect(span).toBeLessThan(EMPTY_TRACK_SPAN_M);
        expect(trackSpanM([...cloud, at(2026, 9, 6, 10, 9, { latitude: 0, longitude: 0 })])).toBeCloseTo(span, 6);
        expect(trackSpanM([cloud[0]])).toBe(0);
        expect(trackSpanM([])).toBeNull();
    });

    it('0.1 NM of jitter inside a 60 m box is empty; a real 300 m berth move is not', () => {
        expect(isEmptyTrack({ totalDistanceNM: 0.1, spanM: 60 })).toBe(true);
        expect(isEmptyTrack({ totalDistanceNM: 0.1, spanM: 300 })).toBe(false);
        expect(isEmptyTrack({ totalDistanceNM: 0.02, spanM: null })).toBe(true); // the old rule still holds
        expect(isEmptyTrack({ totalDistanceNM: 0.1, spanM: null })).toBe(false); // no box → distance decides
        expect(EMPTY_TRACK_NM).toBe(0.05);
        expect(EMPTY_TRACK_SPAN_M).toBe(150);
    });

    it('the sweep prunes it once this device has stopped it', () => {
        const s: VoyageSummary = {
            voyageId: 'hard',
            entryCount: 3398,
            startedAt: '2026-09-06T00:32:00Z',
            endedAt: '2026-09-06T04:23:00Z',
            totalDistanceNM: 0.1,
            avgSpeedKts: 1.1,
            hasManual: false,
            isPlannedRoute: false,
            isImported: false,
            firstLat: -27.2,
            firstLon: 153.11,
            lastLat: -27.2,
            lastLon: 153.11,
            firstIsOnWater: false,
            landFraction: 1,
            spanM: 60,
        };
        const nowMs = Date.parse('2026-09-06T04:24:00Z');
        expect(selectEmptyVoyagesToPrune([s], { nowMs, deviceStoppedIds: new Set(['hard']) })).toEqual(['hard']);
        expect(
            selectEmptyVoyagesToPrune([{ ...s, spanM: 400 }], { nowMs, deviceStoppedIds: new Set(['hard']) }),
        ).toEqual([]);
    });

    it('client summaries carry the footprint', () => {
        expect(summarizeEntries(cloud)[0].spanM).toBeCloseTo(trackSpanM(cloud)!, 6);
    });
});

describe('what the screens say', () => {
    it('LIVE means recording now, not dated today', () => {
        const timeline = read('components/DateGroupedTimeline.tsx');
        expect(timeline).toContain('{isToday && isTracking && (');
        expect(timeline).toContain('const todayStr = getTodayDateString();');
        expect(read('pages/log/LogSubComponents.tsx')).toContain('isTracking={isLiveVoyage}');
        expect(read('pages/LogPage.tsx')).toMatch(
            /isLiveVoyage=\{\s*state\.isTracking && state\.currentVoyageId === summary\.voyageId\s*\}/,
        );
    });

    it('the recorded speed is the receiver’s, or a confirmed move’s; hops are kept to four places', () => {
        const pipeline = read('services/shiplog/CapturePipeline.ts');
        expect(pipeline).toContain('speedKts = recordedSpeedKts(bestPos?.speed, speedKts, accrual.moving);');
        expect(pipeline).toContain('distanceNM: Math.round(distanceNM * 10_000) / 10_000,');
    });

    it('the stop-time prune and the server summary share the footprint rule', () => {
        expect(read('hooks/useLogPageState.ts')).toContain(
            'isEmptyTrack({ totalDistanceNM: dist, spanM: trackSpanM(ve) })',
        );
        const migration = read('supabase/migrations/20260906150000_voyage_summary_track_span.sql');
        for (const col of ['min_lat', 'max_lat', 'min_lon', 'max_lon']) expect(migration).toContain(`AS ${col}`);
        expect(migration).toContain('FROM PUBLIC, anon;');
        expect(read('services/shiplog/VoyageSummary.ts')).toContain('row.min_lat == null');
    });
});
