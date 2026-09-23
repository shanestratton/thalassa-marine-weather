import { describe, expect, it } from 'vitest';
import {
    stationWindDirection,
    tideGaugePresentation,
    tideHeightLabel,
} from '../components/map/tideStationPresentation';

const NOW = Date.parse('2026-09-20T00:30:00Z');
const HOUR = 3_600_000;
const sample = (hour: number, heightM: number) => ({ timeMs: NOW + hour * HOUR, heightM });
const fullDay = () => Array.from({ length: 27 }, (_, i) => sample(i - 1, 1 + Math.cos(((i - 1) / 12) * Math.PI * 2)));

describe('tide station display-only gauge', () => {
    it('interpolates only within nearby provider samples and gives a direction', () => {
        expect(tideGaugePresentation([sample(-0.5, 0.4), sample(0.5, 1.2)], NOW)).toMatchObject({
            heightM: 0.8,
            trend: 'rising',
            curve: null,
            fraction: null,
        });
        expect(tideGaugePresentation([sample(-1, 2), sample(1, 0)], NOW)).toMatchObject({
            heightM: 1,
            trend: 'falling',
        });
    });

    it('will not extrapolate a tide or interpolate over a large missing interval', () => {
        for (const heights of [
            [],
            [sample(1, 1), sample(2, 2)],
            [sample(-2, 1), sample(-1, 2)],
            [sample(-2, 1), sample(2, 2)],
        ]) {
            expect(tideGaugePresentation(heights, NOW)).toEqual({
                heightM: null,
                trend: 'unknown',
                fraction: null,
                curve: null,
            });
        }
    });

    it('uses the forward trend at an exact sample, and never calls a level steady current or slack', () => {
        expect(tideGaugePresentation([sample(-1, 1), sample(0, 2), sample(1, 1)], NOW).trend).toBe('falling');
        expect(tideGaugePresentation([sample(-1, -0.2), sample(1, -0.2)], NOW)).toMatchObject({
            heightM: -0.2,
            trend: 'steady',
        });
        expect(tideGaugePresentation([sample(0, 1)], NOW)).toMatchObject({ heightM: 1, trend: 'unknown' });
    });

    it('requires complete 24-hour samples before showing a curve or a relative-range fill', () => {
        const result = tideGaugePresentation(fullDay(), NOW);
        expect(result.fraction).toBe(1);
        expect(result.curve).toMatchObject({ startMs: NOW, endMs: NOW + 24 * HOUR, minM: 0, maxM: 2 });
        expect(result.curve?.points[0]).toMatchObject({ x: 8, y: 14, timeMs: NOW, heightM: 2 });
        expect(result.curve?.linePath).not.toMatch(/NaN|Infinity/);
        expect(result.curve?.areaPath).toMatch(/Z$/);
        expect(
            tideGaugePresentation(
                fullDay().filter((p) => p.timeMs < NOW + 22 * HOUR),
                NOW,
            ).curve,
        ).toBeNull();
        expect(
            tideGaugePresentation(
                fullDay().filter((p) => p.timeMs <= NOW + 8 * HOUR || p.timeMs >= NOW + 12 * HOUR),
                NOW,
            ).curve,
        ).toBeNull();
    });

    it('shows a genuinely flat range at mid-gauge without dividing by zero', () => {
        const result = tideGaugePresentation(
            fullDay().map((p) => ({ ...p, heightM: -0.4 })),
            NOW,
        );
        expect(result.fraction).toBe(0.5);
        expect(result.curve?.points.every((p) => Math.abs(p.y - 58) < 1e-9)).toBe(true);
    });

    it('sorts without mutating, ignores invalid samples, and refuses conflicting duplicate times', () => {
        const data = [sample(1, 2), sample(-1, 0), sample(0, 1), sample(0, 1), sample(2, NaN)];
        const before = data.map((p) => ({ ...p }));
        expect(tideGaugePresentation(data, NOW).heightM).toBe(1);
        expect(data).toEqual(before);
        expect(tideGaugePresentation([...data, sample(0, 2)], NOW).heightM).toBeNull();
        expect(tideGaugePresentation(data, NaN).heightM).toBeNull();
    });

    it('keeps signed heights and meteorological FROM bearings honest', () => {
        expect(tideHeightLabel(-0.03)).toBe('0.0');
        expect(tideHeightLabel(-0.7)).toBe('-0.7');
        expect(tideHeightLabel(NaN)).toBe('—');
        expect(stationWindDirection(45)).toBe('NE · 45°');
        expect(stationWindDirection(360)).toBe('N · 0°');
        expect(stationWindDirection(-1)).toBeNull();
        expect(stationWindDirection(Infinity)).toBeNull();
    });
});
