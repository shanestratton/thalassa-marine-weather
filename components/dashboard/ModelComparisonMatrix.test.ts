import { describe, it, expect } from 'vitest';
import { sampleAt, unwrapDegrees, circularSpread } from './ModelComparisonMatrix';

const H = 3600_000;

describe('sampleAt', () => {
    const times = [0, H, 2 * H, 3 * H];
    const values = [10, 20, 30, 40];

    it('picks the nearest hourly sample', () => {
        expect(sampleAt(times, values, H + 20 * 60_000)).toBe(20); // 1h20 → 1h
        expect(sampleAt(times, values, H + 40 * 60_000)).toBe(30); // 1h40 → 2h
    });

    it('returns null beyond 90 minutes of the series edge', () => {
        expect(sampleAt(times, values, 6 * H)).toBeNull();
        expect(sampleAt([], [], 0)).toBeNull();
    });

    it('propagates null samples', () => {
        expect(sampleAt(times, [10, null, 30, 40], H)).toBeNull();
    });
});

describe('unwrapDegrees', () => {
    it('keeps a continuous series unchanged', () => {
        expect(unwrapDegrees([90, 100, 110])).toEqual([90, 100, 110]);
    });

    it('unwraps across the 0/360 boundary so lines stay continuous', () => {
        // 350 → 10 is a +20° veer, not a -340° plunge
        expect(unwrapDegrees([350, 10, 20])).toEqual([350, 370, 380]);
        // 10 → 350 is a -20° back
        expect(unwrapDegrees([10, 350, 340])).toEqual([10, -10, -20]);
    });

    it('carries continuity across null gaps', () => {
        expect(unwrapDegrees([350, null, 10])).toEqual([350, null, 370]);
    });

    it('pulls a series into the anchor window so separate models plot comparably', () => {
        // Anchored at 350°, a series starting at 10° is really +20°, not -340°
        expect(unwrapDegrees([10, 20], 350)).toEqual([370, 380]);
        // Anchored at 10°, a series starting at 350° is really -20°
        expect(unwrapDegrees([350, 340], 10)).toEqual([-10, -20]);
    });
});

describe('circularSpread', () => {
    it('measures spread the short way around', () => {
        expect(circularSpread([350, 10])).toBe(20);
        expect(circularSpread([0, 180])).toBe(180);
        expect(circularSpread([90, 100, 110])).toBe(20);
    });

    it('is zero for a single value', () => {
        expect(circularSpread([123])).toBe(0);
    });
});
