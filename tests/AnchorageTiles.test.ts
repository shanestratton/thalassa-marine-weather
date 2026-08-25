/**
 * Anchorages v1 — tile selection and the stay window.
 *
 * The tile radius test matters doubly: load too few tiles and a boat near a
 * tile edge misses the bay 5 NM away across the boundary; load too many and
 * a Gulf crossing pulls the whole coast. The stay window is the verdict's
 * definition of "tonight" — its edge cases (3 am re-rank, 7 am planning)
 * were argued in the code comment and are pinned here.
 */
import { describe, expect, it } from 'vitest';
import { tileWithinRadius } from '../services/anchorages/AnchorageService';
import { stayWindowMs } from '../services/anchorages/anchorageForecast';

describe('tileWithinRadius', () => {
    // t-22e148: the Whitsundays tile — lat −22..−20, lon 148..150.
    const WHITSUNDAYS: [number, number, number, number] = [148, -22, 150, -20];

    it('a centre inside the tile always loads it', () => {
        expect(tileWithinRadius(WHITSUNDAYS, -20.27, 148.72, 50)).toBe(true);
    });

    it('a centre across the tile edge still loads it — the 50 NM promise', () => {
        // Bowen is at ~−20.01, 148.24: 20-odd NM north of the tile boundary
        // would be ~−19.7 — take a point clearly outside but within 50 NM.
        expect(tileWithinRadius(WHITSUNDAYS, -19.5, 148.7, 50)).toBe(true);
    });

    it('a centre far away does not load it', () => {
        // Brisbane: ~430 NM south of the Whitsundays.
        expect(tileWithinRadius(WHITSUNDAYS, -27.4, 153.1, 50)).toBe(false);
    });

    it('longitude tolerance widens with latitude, honestly', () => {
        // 50 NM of longitude at −20° is ~0.89°; a centre 0.85° east of the
        // tile edge is in, 1.5° east is out.
        expect(tileWithinRadius(WHITSUNDAYS, -21, 150.85, 50)).toBe(true);
        expect(tileWithinRadius(WHITSUNDAYS, -21, 151.5, 50)).toBe(false);
    });
});

describe('stayWindowMs — what "tonight" means', () => {
    const at = (h: number, m = 0) => new Date(2026, 7, 25, h, m).getTime();

    it('mid-afternoon plans the full night to tomorrow 09:00', () => {
        const w = stayWindowMs(at(15));
        expect(new Date(w.toMs).getDate()).toBe(26);
        expect(new Date(w.toMs).getHours()).toBe(9);
        expect((w.toMs - w.fromMs) / 3_600_000).toBeCloseTo(18, 5);
    });

    it('a 03:00 re-rank covers the REST of this night, not the next one', () => {
        const w = stayWindowMs(at(3));
        expect(new Date(w.toMs).getDate()).toBe(25);
        expect(new Date(w.toMs).getHours()).toBe(9);
    });

    it('07:00 rolls to tomorrow — you are planning tonight, not the next two hours', () => {
        const w = stayWindowMs(at(7));
        expect(new Date(w.toMs).getDate()).toBe(26);
    });

    it('the window is never shorter than 4 hours', () => {
        for (const h of [0, 3, 5, 6, 8, 9, 12, 18, 23]) {
            const w = stayWindowMs(at(h));
            expect(w.toMs - w.fromMs).toBeGreaterThanOrEqual(4 * 3_600_000);
        }
    });
});
