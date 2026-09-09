import { describe, expect, it } from 'vitest';
import {
    freshWindHistorySummary,
    parseWindHistorySummary,
    WindHistoryBuffer,
    WIND_GUST_WINDOW_MS,
    WIND_HISTORY_WINDOW_MS,
} from '../utils/windHistory';

const now = 1_800_000_000_000;
const wire = (over: Record<string, unknown> = {}) => ({
    wind_history_v: 1,
    wind_history_at_ms: now,
    wind_history_since_ms: now - 3_000_000,
    wind_history_latest_ms: now - 5_000,
    wind_history_samples_1h: 600,
    wind_history_source: 'n2k.42.environment.wind.speedTrue',
    wind_max_1h_kts: 22,
    wind_max_1h_at_ms: now - 1_000_000,
    wind_gust_10m_kts: 18,
    wind_gust_10m_at_ms: now - 10_000,
    ...over,
});

describe('source-time rolling wind history', () => {
    it('keeps the next known peak when the previous peak ages out without new samples', () => {
        const history = new WindHistoryBuffer();
        history.add(25, now - WIND_HISTORY_WINDOW_MS + 1, now);
        history.add(20, now - WIND_GUST_WINDOW_MS + 1, now);
        history.add(10, now, now);
        expect(history.summary('gateway', now)?.max1h?.kts).toBe(25);
        expect(history.summary('gateway', now)?.gust10m?.kts).toBe(20);
        const aged = history.summary('gateway', now + 1);
        expect(aged?.max1h?.kts).toBe(20);
        expect(aged?.gust10m?.kts).toBe(10);
        expect(history.summary('gateway', now + WIND_HISTORY_WINDOW_MS)).toBeNull();
    });

    it('keeps real calm readings, accepts constant wind at new source times and rejects duplicates', () => {
        const history = new WindHistoryBuffer();
        expect(history.add(0, now - 5_000, now)).toBe(true);
        expect(history.add(0, now, now)).toBe(true);
        expect(history.add(80, now, now + 5_000)).toBe(false);
        expect(history.add(80, now - 1, now + 5_000)).toBe(false);
        expect(history.summary('gateway', now)).toMatchObject({ sampleCount: 2, max1h: { kts: 0, at: now } });
    });

    it('rejects invalid, future and expired samples without losing valid samples', () => {
        const history = new WindHistoryBuffer();
        for (const value of [null, undefined, NaN, Infinity, -1, 151, '20'])
            expect(history.add(value, now, now)).toBe(false);
        for (const at of [0, -1, NaN, Infinity, now + 1_001, now - WIND_HISTORY_WINDOW_MS])
            expect(history.add(10, at, now)).toBe(false);
        expect(history.add(10, now, now)).toBe(true);
        expect(history.summary('gateway', now)?.sampleCount).toBe(1);
    });

    it('caps unusual sample floods and reports only the retained observed interval', () => {
        const history = new WindHistoryBuffer();
        for (let i = 0; i < 7_300; i++) history.add(10, now - 8_000 + i, now);
        expect(history.summary('gateway', now)).toMatchObject({ sampleCount: 7_200, since: now - 7_900 });
    });
});

describe('Pi wind history wire validation', () => {
    it('accepts a truthful partial hour and real zero peaks', () => {
        expect(parseWindHistorySummary(wire(), now)).toMatchObject({
            sampleCount: 600,
            max1h: { kts: 22 },
            gust10m: { kts: 18 },
        });
        expect(parseWindHistorySummary(wire({ wind_max_1h_kts: 0, wind_gust_10m_kts: 0 }), now)?.max1h?.kts).toBe(0);
    });

    it.each([
        { wind_history_v: 2 },
        { wind_history_at_ms: now + 1_001 },
        { wind_history_at_ms: now - 60_001 },
        { wind_history_samples_1h: 0 },
        { wind_history_samples_1h: 1.5 },
        { wind_history_samples_1h: 7_201 },
        { wind_history_source: '' },
        { wind_history_source: 'x'.repeat(121) },
        { wind_history_source: 'n2k\u0000.42' },
        { wind_history_since_ms: now - WIND_HISTORY_WINDOW_MS - 1 },
        { wind_history_latest_ms: now + 1_001 },
        { wind_max_1h_kts: -1 },
        { wind_max_1h_kts: NaN },
        { wind_max_1h_kts: 151 },
        { wind_max_1h_at_ms: null },
        { wind_max_1h_at_ms: now - WIND_HISTORY_WINDOW_MS },
        { wind_gust_10m_at_ms: now - WIND_GUST_WINDOW_MS },
        { wind_gust_10m_kts: 23 },
    ])('rejects malformed or untrustworthy summary %j', (over) => {
        expect(parseWindHistorySummary(wire(over), now)).toBeNull();
    });

    it('allows absent 10-minute gust only if both fields are absent', () => {
        expect(
            parseWindHistorySummary(
                wire({
                    wind_history_latest_ms: now - WIND_GUST_WINDOW_MS,
                    wind_gust_10m_kts: null,
                    wind_gust_10m_at_ms: null,
                }),
                now,
            )?.gust10m,
        ).toBeNull();
        expect(parseWindHistorySummary(wire({ wind_gust_10m_kts: null }), now)).toBeNull();
        expect(parseWindHistorySummary(wire({ wind_gust_10m_kts: null, wind_gust_10m_at_ms: null }), now)).toBeNull();
    });

    it('expires original peak timestamps even if the summary itself is still fresh', () => {
        const summary = parseWindHistorySummary(wire({ wind_gust_10m_at_ms: now - WIND_GUST_WINDOW_MS + 1 }), now);
        expect(freshWindHistorySummary(summary, now)).not.toBeNull();
        expect(freshWindHistorySummary(summary, now + 1)).toBeNull();
        expect(freshWindHistorySummary(parseWindHistorySummary(wire(), now), now + 60_001)).toBeNull();
    });
});
