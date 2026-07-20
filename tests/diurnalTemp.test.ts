/**
 * Parton & Logan curve, checked against the physical behaviour it claims to
 * model rather than against itself: the peak must lag solar noon, the halves
 * must join at sunset, and the whole point — it must NOT clip the extremes the
 * way linear interpolation does.
 *
 * Sun times are Newport, Moreton Bay (-27.20, 153.10) on 2026-07-20, taken
 * from suncalc: sunrise 06:35 local, sunset 17:14 local.
 */
import { describe, it, expect } from 'vitest';
import {
    diurnalTemperature,
    diurnalSeries,
    diurnalTemperatureAt,
    timeOfMaximum,
    PARTON_LOGAN_DEFAULTS,
} from '../services/weather/diurnalTemp';

const SUNRISE = new Date('2026-07-19T20:35:53Z'); // 06:35 AEST
const SUNSET = new Date('2026-07-20T07:14:08Z'); // 17:14 AEST
const SUNRISE_NEXT = new Date('2026-07-20T20:35:40Z');

const DAY = { tMax: 22, tMin: 9, sunrise: SUNRISE, sunset: SUNSET, sunriseNext: SUNRISE_NEXT };

describe('daytime sine', () => {
    it('starts at the minimum at sunrise', () => {
        expect(diurnalTemperature(SUNRISE, DAY)).toBeCloseTo(9, 5);
    });

    it('peaks AFTER solar noon, not at it', () => {
        const peak = timeOfMaximum(DAY);
        const solarNoon = new Date((SUNRISE.getTime() + SUNSET.getTime()) / 2);
        const lagHours = (peak.getTime() - solarNoon.getTime()) / 3_600_000;
        // The whole reason a exists: ground keeps warming after peak radiation.
        expect(lagHours).toBeCloseTo(PARTON_LOGAN_DEFAULTS.a, 2);
        expect(lagHours).toBeGreaterThan(1.5);
    });

    it('actually reaches the stated maximum', () => {
        expect(diurnalTemperature(timeOfMaximum(DAY), DAY)).toBeCloseTo(22, 5);
    });

    it('never exceeds the max or drops below the min during daylight', () => {
        for (let h = 0; h <= 10.6; h += 0.25) {
            const t = diurnalTemperature(new Date(SUNRISE.getTime() + h * 3_600_000), DAY);
            expect(t).toBeGreaterThanOrEqual(9 - 1e-9);
            expect(t).toBeLessThanOrEqual(22 + 1e-9);
        }
    });
});

describe('night decay', () => {
    it('joins the daytime curve at sunset with no step', () => {
        const before = diurnalTemperature(new Date(SUNSET.getTime() - 1000), DAY);
        const after = diurnalTemperature(new Date(SUNSET.getTime() + 1000), DAY);
        expect(Math.abs(before - after)).toBeLessThan(0.01);
    });

    it('falls monotonically through the night', () => {
        let prev = Infinity;
        for (let h = 0; h < 13; h += 0.5) {
            const t = diurnalTemperature(new Date(SUNSET.getTime() + h * 3_600_000), DAY);
            expect(t).toBeLessThan(prev);
            prev = t;
        }
    });

    it('decays toward TOMORROW’s minimum when given one', () => {
        const cold = { ...DAY, tMinNext: 4 };
        const preDawn = new Date(SUNRISE_NEXT.getTime() - 1_800_000);
        expect(diurnalTemperature(preDawn, cold)).toBeLessThan(diurnalTemperature(preDawn, DAY));
        expect(diurnalTemperature(preDawn, cold)).toBeGreaterThan(4);
    });
});

describe('the reason this exists — linear interpolation clips the extremes', () => {
    it('reads warmer than a 6-hourly straight line through the afternoon peak', () => {
        // Model steps at 12:00 and 18:00 local; the real peak is ~13:45.
        const noon = new Date('2026-07-20T02:00:00Z');
        const six = new Date('2026-07-20T08:00:00Z');
        const tNoon = diurnalTemperature(noon, DAY);
        const tSix = diurnalTemperature(six, DAY);

        const peak = timeOfMaximum(DAY);
        const frac = (peak.getTime() - noon.getTime()) / (six.getTime() - noon.getTime());
        const linearAtPeak = tNoon + frac * (tSix - tNoon);

        const curveAtPeak = diurnalTemperature(peak, DAY);
        expect(curveAtPeak).toBeGreaterThan(linearAtPeak);
        // Not a rounding difference — this is the error being corrected.
        expect(curveAtPeak - linearAtPeak).toBeGreaterThan(1.0);
    });
});

describe('series and location wrapper', () => {
    it('emits one value per hour', () => {
        const s = diurnalSeries(SUNRISE, 24, DAY);
        expect(s).toHaveLength(24);
        expect(s.every(Number.isFinite)).toBe(true);
    });

    it('derives sun times from a real location', () => {
        const t = diurnalTemperatureAt(new Date('2026-07-20T03:00:00Z'), -27.2, 153.1, {
            tMax: 22,
            tMin: 9,
        });
        expect(t).toBeGreaterThan(9);
        expect(t).toBeLessThanOrEqual(22);
    });
});

describe('degenerate cases', () => {
    it('returns the midpoint rather than NaN inside a polar day', () => {
        const polar = { tMax: 5, tMin: -5, sunrise: SUNRISE, sunset: SUNRISE };
        expect(diurnalTemperature(SUNRISE, polar)).toBe(0);
    });
});
