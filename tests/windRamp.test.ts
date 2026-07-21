/**
 * windRamp — the wind particle colour bands.
 *
 * These pin the arithmetic, not the aesthetics. The renderer picks a colour
 * with leaflet-velocity's `floor(len * v / max)` over RAW m/s, so a band edge
 * is an emergent property of (stop count × maxVelocity), not something stated
 * anywhere. The old ramp is the cautionary tale: its comments claimed
 * "0-10 kts / 35+ kts" while the maths actually produced 13-knot bands running
 * to 78 kt, so ordinary sailing wind drew in one flat colour and nobody
 * noticed for months.
 */
import { describe, expect, it } from 'vitest';

import {
    WIND_BANDS,
    WIND_COLORS,
    WIND_GRADIENT,
    WIND_MAX_MS,
    WIND_TOP_KT,
    windColorForKt,
} from '../components/map/windRamp';

/** The band a knot value should land in, straight off the table. */
function expectedHex(kt: number): string {
    return (WIND_BANDS.find((b) => kt < b.toKt) ?? WIND_BANDS[WIND_BANDS.length - 1]).hex;
}

describe('windRamp bucket construction', () => {
    it('emits one bucket per knot up to the ceiling', () => {
        expect(WIND_COLORS).toHaveLength(WIND_TOP_KT);
        expect(WIND_TOP_KT).toBe(60);
    });

    it('draws exactly the 10 declared band colours, no more', () => {
        expect(new Set(WIND_COLORS).size).toBe(WIND_BANDS.length);
        expect(WIND_BANDS).toHaveLength(10);
    });

    it('keys maxVelocity to the ceiling in m/s, not knots', () => {
        // The grid is m/s; passing a knot value here is what made the old ramp
        // span 78 kt.
        expect(WIND_MAX_MS).toBeCloseTo(30.8003, 3);
        expect(WIND_MAX_MS / (1852 / 3600)).toBeCloseTo(59.87, 1);
    });

    it('band table is strictly ascending', () => {
        const tops = WIND_BANDS.map((b) => b.toKt);
        expect([...tops].sort((a, b) => a - b)).toEqual(tops);
    });
});

describe('band edges land on the thresholds a skipper steers by', () => {
    it.each([
        [0, 'Drifter'],
        [4.8, 'Drifter'],
        [5, 'Light air'],
        [12, 'Pleasant'],
        [19.8, 'Working breeze'],
        [20, 'Reef'],
        [24.8, 'Reef'],
        [25, 'Heavy reef'],
        [29.8, 'Heavy reef'],
        [30, 'Near gale'],
        [33.8, 'Near gale'],
        [34, 'Gale (F8)'],
        [39.8, 'Gale (F8)'],
        [40, 'Strong gale'],
        [50, 'Storm force'],
    ])('%f kt reads as %s', (kt, label) => {
        const band = WIND_BANDS.find((b) => b.label === label)!;
        expect(windColorForKt(kt as number)).toBe(band.hex);
    });

    it('the REEF flip at 20 kt is a cool→warm hue change, not a shade', () => {
        expect(windColorForKt(19.8)).toBe('#10a06b'); // green
        expect(windColorForKt(20)).toBe('#ee7a0b'); // orange
    });

    it('the GALE flip lands on the true Beaufort F8 line of 34 kt', () => {
        expect(windColorForKt(33.8)).not.toBe(windColorForKt(34));
        expect(windColorForKt(34)).toBe('#cf35bd');
    });
});

describe('borderline speeds err HOT, never cool', () => {
    // A go/no-go field must never under-report. The sub-unity bias makes each
    // edge fall just below its round knot, so a particle sitting exactly on a
    // threshold takes the more alarming colour.
    it.each(WIND_BANDS.slice(0, -1).map((b) => b.toKt))('the %d kt edge flips at or below the round number', (top) => {
        let flip = top - 0.5;
        const below = expectedHex(top - 0.5);
        while (windColorForKt(flip) === below && flip < top + 0.5) flip += 0.001;
        expect(flip).toBeLessThanOrEqual(top);
        expect(top - flip).toBeLessThan(0.25); // and not so early it misleads
    });
});

describe('out-of-range input cannot crash or wrap', () => {
    it('clamps everything above the ceiling to the top band', () => {
        const top = WIND_BANDS[WIND_BANDS.length - 1].hex;
        for (const kt of [60, 75, 120, 500]) expect(windColorForKt(kt)).toBe(top);
    });

    it('clamps zero, negative and non-finite to the calm band', () => {
        const calm = WIND_BANDS[0].hex;
        for (const kt of [0, -5, NaN, -Infinity]) expect(windColorForKt(kt)).toBe(calm);
    });
});

describe('legend gradient is derived, so it cannot drift from the renderer', () => {
    it('names every band colour, in low→high order', () => {
        for (const b of WIND_BANDS) expect(WIND_GRADIENT).toContain(b.hex);
        const positions = WIND_BANDS.map((b) => WIND_GRADIENT.indexOf(b.hex));
        expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    });

    it('uses hard stops — the renderer buckets, it does not interpolate', () => {
        // Each band appears twice: once opening its span, once closing it.
        for (const b of WIND_BANDS) {
            expect(WIND_GRADIENT.split(b.hex).length - 1).toBe(2);
        }
    });

    it('runs bottom-up so calm sits at the foot of the bar', () => {
        expect(WIND_GRADIENT.startsWith('linear-gradient(to top,')).toBe(true);
        expect(WIND_GRADIENT).toContain(`${WIND_BANDS[0].hex} 0.00%`);
    });
});
