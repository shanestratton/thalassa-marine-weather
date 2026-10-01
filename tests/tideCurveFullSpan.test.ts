/**
 * The route colour's "highest tide" is read over the 14 days the rest of the
 * app loads (round-4 review, 2026-09-30).
 *
 * fetchTideCurve asks WorldTides for days from NOW to the end of the range
 * (+2 for the proxy's yesterday anchor): a departure today with a 24 h window
 * got 3 days, so owner decision 10's "highest tide" was this week's top — at
 * neaps, "never clears" of water next week's springs clear. The chips now ask
 * for the full span through `opts.days`, on the same cache path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const wt = vi.hoisted(() => ({ days: [] as number[], at: [] as [number, number][] }));
vi.mock('../services/weather/api/worldtides', () => ({
    fetchWorldTides: vi.fn(async (lat: number, lon: number, days: number) => {
        wt.days.push(days);
        wt.at.push([lat, lon]);
        const t0 = Math.floor(Date.now() / 1000) - 24 * 3600;
        return {
            status: 200,
            responseDatum: 'LAT',
            extremes: Array.from({ length: 8 }, (_, k) => ({
                dt: t0 + k * 22_320,
                date: '',
                height: k % 2 === 0 ? 0.2 : 2.1,
                type: k % 2 === 0 ? 'Low' : 'High',
            })),
        };
    }),
}));

import { clearTideCache, fetchTideCurve, TIDE_CURVE_MAX_DAYS } from '../services/TideHeightService';

describe('fetchTideCurve opts.days', () => {
    beforeEach(() => {
        wt.days.length = 0;
        wt.at.length = 0;
        clearTideCache();
    });

    it('a whole-span curve is fetched at its bucket’s centre and shared across windows (decision 11 fix-up)', async () => {
        // 2026-10-01: keyed by the 6 h window as well, and fetched wherever the
        // route passed, every new route missed the app's cache and the Pi's
        // (which keys on the exact spot) and spent the public tide proxy's
        // 12 an hour. A 14-day curve is the same data whatever the window.
        const now = Date.now();
        await fetchTideCurve(-27.31, 153.11, now, now + 24 * 3600_000, { days: TIDE_CURVE_MAX_DAYS });
        await fetchTideCurve(-27.21, 153.02, now + 9 * 3600_000, now + 33 * 3600_000, { days: TIDE_CURVE_MAX_DAYS });
        await fetchTideCurve(-27.3, 153.1, now + 3 * 24 * 3600_000, now + 4 * 24 * 3600_000, {
            days: TIDE_CURVE_MAX_DAYS,
        });
        expect(wt.at).toEqual([[-27.25, 153]]);
        expect(wt.days).toEqual([14]);
    });

    it('a departure today with a 24 h window asks for 3 days on its own…', async () => {
        const now = Date.now();
        await fetchTideCurve(-27.3, 153.1, now, now + 24 * 3600_000);
        expect(wt.days).toEqual([3]);
    });

    it('…and for the full 14 days when asked, cached apart from the short span', async () => {
        const now = Date.now();
        await fetchTideCurve(-27.3, 153.1, now, now + 24 * 3600_000, { days: TIDE_CURVE_MAX_DAYS });
        expect(wt.days).toEqual([14]);
        // A second ask in the same bucket rides the cache.
        await fetchTideCurve(-27.31, 153.11, now, now + 24 * 3600_000, { days: TIDE_CURVE_MAX_DAYS });
        expect(wt.days).toEqual([14]);
        // The short span is its own fetch, never answered by the other.
        await fetchTideCurve(-27.3, 153.1, now, now + 24 * 3600_000);
        expect(wt.days).toEqual([14, 3]);
    });

    it('never more than the app’s 14', async () => {
        const now = Date.now();
        await fetchTideCurve(-27.3, 153.1, now, now + 24 * 3600_000, { days: 40 });
        expect(wt.days).toEqual([14]);
    });
});
