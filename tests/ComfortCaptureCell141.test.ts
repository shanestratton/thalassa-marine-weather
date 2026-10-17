import { describe, expect, it } from 'vitest';
import { comfortCaptureCellFits } from '../services/comfort/captureCell';
const capture = { latitude: -27, longitude: 153 };
const shore = { ...capture, coastDistanceNm: 1 };
describe('actual comfort capture coast clearance', () => {
    it('keeps the local cell plus100m entirely inside confirmed coast clearance', () => {
        expect(comfortCaptureCellFits(shore, capture, 1.751)).toBe(true);
        expect(comfortCaptureCellFits(shore, capture, 1.752)).toBe(false);
    });
    it('subtracts moved-capture offset in kilometres rather than nautical miles', () => {
        // About667m from the original evidence;1.1km+667m+100m exceeds1NM.
        expect(comfortCaptureCellFits(shore, { ...capture, latitude: -27.006 }, 1.1)).toBe(false);
        expect(comfortCaptureCellFits(shore, { ...capture, latitude: -27.006 }, 1)).toBe(true);
    });
    it('refuses absent, invalid and out-of-envelope evidence', () => {
        expect(comfortCaptureCellFits(null, capture, 0)).toBe(false);
        for (const value of [undefined, null, NaN, Infinity, -1])
            expect(comfortCaptureCellFits(shore, capture, value)).toBe(false);
        for (const value of [0, -1, Infinity, 101])
            expect(comfortCaptureCellFits({ ...shore, coastDistanceNm: value }, capture, 0)).toBe(false);
    });
});
