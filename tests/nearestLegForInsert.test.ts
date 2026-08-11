import { describe, expect, it } from 'vitest';

import { nearestLegForInsert, type ScreenPoint } from '../components/map/mapHubHelpers';

/**
 * The tap-on-line insert geometry, extracted from MapHub 2026-08-11 after the
 * old inline version (16 px corridor, middle 80% of the leg) proved smaller
 * than the fingertip pressing it — every miss fell through to a silent
 * append, which read as "insert doesn't exist".
 *
 * Contract: returns i meaning "insert between pins[i-1] and pins[i]",
 * -1 meaning append. Screen-space CSS pixels throughout.
 */
describe('nearestLegForInsert', () => {
    // One horizontal leg, comfortably long: pin 0 at x=0, pin 1 at x=400.
    const pins: ScreenPoint[] = [
        { x: 0, y: 100 },
        { x: 400, y: 100 },
    ];

    it('splices a press in the corridor at mid-leg', () => {
        expect(nearestLegForInsert({ x: 200, y: 110 }, pins)).toBe(1);
    });

    it('accepts a press a full fingertip off the line — 16 px was the old bug', () => {
        // 24 px perpendicular: inside the 28 px corridor, outside the old 16.
        expect(nearestLegForInsert({ x: 200, y: 124 }, pins)).toBe(1);
    });

    it('rejects a press beyond the corridor', () => {
        expect(nearestLegForInsert({ x: 200, y: 130 }, pins)).toBe(-1);
    });

    it('defers to the pin affordance near an endpoint — 40 px, in pixels not proportions', () => {
        // 30 px from pin 0: on the line, but the pin owns it.
        expect(nearestLegForInsert({ x: 30, y: 100 }, pins)).toBe(-1);
        // 41 px from pin 0: past the pin's hit-slop, the leg owns it. Under
        // the old middle-80% rule this point (t ≈ 0.10) sat exactly on the
        // dead-zone boundary of a 400 px leg — and on an 800 px leg the dead
        // zone would have been 80 px; the pixel rule stays 40 regardless.
        expect(nearestLegForInsert({ x: 41, y: 100 }, pins)).toBe(1);
    });

    it('never splices past the final pin — appending beyond the end still appends', () => {
        // In line with the leg but beyond pin 1. Clamped-t distance equals
        // distance to pin 1, and anything nearer than 40 px is the pin's;
        // anything past 40 px fails there too. Both sides append.
        expect(nearestLegForInsert({ x: 430, y: 100 }, pins)).toBe(-1);
        expect(nearestLegForInsert({ x: 460, y: 100 }, pins)).toBe(-1);
    });

    it('picks the nearest leg of a multi-leg route', () => {
        const route: ScreenPoint[] = [
            { x: 0, y: 0 },
            { x: 400, y: 0 },
            { x: 400, y: 400 },
        ];
        // Near the second (vertical) leg's midline.
        expect(nearestLegForInsert({ x: 390, y: 200 }, route)).toBe(2);
        // Near the first (horizontal) leg's midline.
        expect(nearestLegForInsert({ x: 200, y: 10 }, route)).toBe(1);
    });

    it('skips a zero-length leg (duplicated pin) instead of dividing by it', () => {
        const dup: ScreenPoint[] = [
            { x: 0, y: 100 },
            { x: 0, y: 100 },
            { x: 400, y: 100 },
        ];
        expect(nearestLegForInsert({ x: 200, y: 100 }, dup)).toBe(2);
    });

    it('returns append for empty and single-pin routes', () => {
        expect(nearestLegForInsert({ x: 10, y: 10 }, [])).toBe(-1);
        expect(nearestLegForInsert({ x: 10, y: 10 }, [{ x: 10, y: 10 }])).toBe(-1);
    });
});
