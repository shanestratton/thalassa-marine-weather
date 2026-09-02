/** "1d 24h" must be impossible (audit 2026-09-02): round once, then split. */
import { describe, expect, it } from 'vitest';
import { splitDaysHours } from '../utils/splitDaysHours';

describe('splitDaysHours', () => {
    it('never yields 24 hours', () => {
        expect(splitDaysHours(47.7)).toEqual({ days: 2, hours: 0 });
        expect(splitDaysHours(23.6)).toEqual({ days: 1, hours: 0 });
        expect(splitDaysHours(30.4)).toEqual({ days: 1, hours: 6 });
        expect(splitDaysHours(23.4)).toEqual({ days: 0, hours: 23 });
        for (let h = 0; h < 200; h += 0.1) expect(splitDaysHours(h).hours).toBeLessThan(24);
    });
    it('clamps negatives to zero rather than printing -0', () => {
        expect(splitDaysHours(-3)).toEqual({ days: 0, hours: 0 });
    });
});
