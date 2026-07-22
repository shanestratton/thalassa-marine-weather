/**
 * Cycle-aligned cache expiry — the StormGlass quota fix.
 *
 * StormGlass is metered and costs real money. Its underlying wave models
 * publish on the 6-hourly synoptic cycle (00/06/12/18Z), but the cache used a
 * 3 h wall-clock TTL — so a boat sitting in one spot pulled up to 8 fetches a
 * day for data that only changes 4 times. Roughly half of every bill bought
 * byte-identical numbers.
 *
 * Expiring on the CYCLE is strictly better on both axes: one fetch per model
 * run (half the calls), AND a new run is picked up as soon as it publishes
 * rather than up to 3 h later.
 *
 * These pin the boundary maths, because the failure modes are opposite and
 * both bad: too eager burns quota, too lazy serves yesterday's forecast.
 */
import { describe, expect, it } from 'vitest';

import { currentCycleStart, isCycleEntryFresh } from '../services/weather/apiCache';

const H = 60 * 60 * 1000;
/** 2026-07-22T00:00:00Z — a cycle boundary. */
const T00 = Date.UTC(2026, 6, 22, 0, 0, 0);

describe('currentCycleStart', () => {
    it('lands on a 6-hourly boundary', () => {
        const c = currentCycleStart(T00 + 10 * H);
        expect((c / H) % 6).toBe(0);
    });

    it('does not advance to a run that has not published yet', () => {
        // 06Z + 30 min: the 06Z run is not out (90 min lag), so 00Z is current.
        expect(currentCycleStart(T00 + 6 * H + 0.5 * H)).toBe(T00);
        // 06Z + 2 h: the 06Z run has published.
        expect(currentCycleStart(T00 + 6 * H + 2 * H)).toBe(T00 + 6 * H);
    });
});

describe('isCycleEntryFresh', () => {
    it('keeps an entry for the WHOLE run — this is the saving', () => {
        // Stored just after 00Z published. Under the old 3 h TTL this refetched
        // at +3 h for identical data; now it survives until 06Z publishes.
        const storedAt = T00 + 1.6 * H;
        expect(isCycleEntryFresh(storedAt, storedAt + 3.5 * H)).toBe(true);
        expect(isCycleEntryFresh(storedAt, storedAt + 5 * H)).toBe(true);
    });

    it('expires as soon as a NEWER run publishes — fresher than the old TTL', () => {
        const storedAt = T00 + 1.6 * H;
        // 06Z + 90 min lag = the 06Z run is available.
        expect(isCycleEntryFresh(storedAt, T00 + 7.6 * H)).toBe(false);
    });

    it('an entry written moments before a new run is immediately superseded', () => {
        // Deliberate: the point is the freshest available run, not entry age.
        const justBefore = T00 + 7.4 * H;
        expect(isCycleEntryFresh(justBefore, T00 + 7.6 * H)).toBe(false);
    });

    it('a fresh write is always considered current', () => {
        for (const offset of [0, 2.5 * H, 5.9 * H]) {
            const now = T00 + offset;
            expect(isCycleEntryFresh(now, now)).toBe(true);
        }
    });

    it('roughly halves the fetches across a day — the actual quota saving', () => {
        // Walk a day hourly and count how often a 1-per-cycle cache refetches.
        let stored = T00 - 24 * H; // start cold
        let fetches = 0;
        for (let h = 0; h < 24; h++) {
            const now = T00 + h * H;
            if (!isCycleEntryFresh(stored, now)) {
                fetches++;
                stored = now;
            }
        }
        // One cold load plus one per model run that publishes during the day.
        expect(fetches).toBe(5);
        // The old 3 h wall-clock TTL over the same walk: 24/3 = 8.
        expect(fetches).toBeLessThan(8);
    });

    it('an idle boat costs ONE fetch per run no matter how often it is polled', () => {
        // The real quota shape: the app refreshes far more often than the
        // model publishes. Polling every 15 min for 6 h must cost one fetch.
        let stored = T00 + 1.6 * H; // holds the 00Z run
        let fetches = 0;
        // 8 h of polling — long enough to cross the 06Z publish at +7.5 h.
        for (let m = 0; m < 8 * 4; m++) {
            const now = T00 + 1.6 * H + m * 15 * 60 * 1000;
            if (!isCycleEntryFresh(stored, now)) {
                fetches++;
                stored = now;
            }
        }
        // 32 polls, ONE fetch — and it lands when 06Z publishes, not on a timer.
        expect(fetches).toBe(1);
    });
});
