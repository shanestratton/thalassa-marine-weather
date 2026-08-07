import { describe, expect, it } from 'vitest';
import {
    bandTendency,
    hpaToInHg,
    observedTendency,
    reduceToSeaLevel,
    timeUntilTendency,
    TENDENCY_WINDOW_MS,
    type PressureSample,
} from '../utils/barometerTendency';

const NOW = 1_754_600_000_000; // fixed epoch — nothing here may depend on the wall clock
const H = 3_600_000;

/** A record with `spanH` hours of samples every 5 minutes, ending at `now`. */
function series(spanH: number, at: (tMinusMs: number) => number, now = NOW, stepMs = 5 * 60_000): PressureSample[] {
    const out: PressureSample[] = [];
    for (let back = spanH * H; back >= 0; back -= stepMs) {
        out.push({ t: now - back, hpa: at(back) });
    }
    return out;
}

describe('bandTendency', () => {
    it('bands the WMO characteristics on both sides of zero', () => {
        expect(bandTendency(0.05)).toEqual({ direction: 'steady', rate: 'steady' });
        expect(bandTendency(-0.05)).toEqual({ direction: 'steady', rate: 'steady' });
        expect(bandTendency(1.0)).toEqual({ direction: 'rising', rate: 'slowly' });
        expect(bandTendency(-1.0)).toEqual({ direction: 'falling', rate: 'slowly' });
        expect(bandTendency(2.5)).toEqual({ direction: 'rising', rate: 'moderate' });
        expect(bandTendency(-4.0)).toEqual({ direction: 'falling', rate: 'quickly' });
        expect(bandTendency(-9.0)).toEqual({ direction: 'falling', rate: 'very-rapidly' });
    });

    it('puts the band edges on the documented side', () => {
        expect(bandTendency(1.5).rate).toBe('slowly');
        expect(bandTendency(1.51).rate).toBe('moderate');
        expect(bandTendency(3.5).rate).toBe('moderate');
        expect(bandTendency(3.51).rate).toBe('quickly');
        expect(bandTendency(6.0).rate).toBe('quickly');
        expect(bandTendency(6.01).rate).toBe('very-rapidly');
    });
});

describe('observedTendency', () => {
    it('reads a steady barometer as steady', () => {
        const t = observedTendency(
            series(4, () => 1015),
            NOW,
        );
        expect(t).not.toBeNull();
        expect(t!.direction).toBe('steady');
        expect(t!.rate).toBe('steady');
        expect(t!.severity).toBe('calm');
        expect(Math.abs(t!.delta3h)).toBeLessThan(0.1);
    });

    it('measures a 6 hPa fall over three hours as a gale signature', () => {
        // 1018 three hours ago → 1012 now, linear.
        const t = observedTendency(
            series(4, (back) => 1012 + (Math.min(back, 3 * H) / (3 * H)) * 6),
            NOW,
        );
        expect(t).not.toBeNull();
        expect(t!.direction).toBe('falling');
        expect(t!.delta3h).toBeCloseTo(-6, 1);
        expect(t!.rate).toBe('quickly');
        expect(t!.severity).toBe('warn');
        expect(t!.read).toContain('Gale');
    });

    it('treats a fast rise as less serious than the same fast fall', () => {
        const fall = observedTendency(
            series(4, (back) => 1010 + (Math.min(back, 3 * H) / (3 * H)) * 5),
            NOW,
        );
        const rise = observedTendency(
            series(4, (back) => 1010 - (Math.min(back, 3 * H) / (3 * H)) * 5),
            NOW,
        );
        expect(fall!.delta3h).toBeCloseTo(-5, 1);
        expect(rise!.delta3h).toBeCloseTo(5, 1);
        expect(fall!.severity).toBe('warn');
        expect(rise!.severity).toBe('watch');
    });

    it('refuses to invent a trend from a short record', () => {
        // 40 minutes of samples — nowhere near a three-hour tendency.
        expect(
            observedTendency(
                series(0.66, () => 1013),
                NOW,
            ),
        ).toBeNull();
        expect(observedTendency([{ t: NOW, hpa: 1013 }], NOW)).toBeNull();
        expect(observedTendency([], NOW)).toBeNull();
    });

    it('rescales a short-but-usable record to a three-hour figure', () => {
        // Two hours of record, falling 2 hPa across it → −3 hPa/3 h.
        const t = observedTendency(
            series(2, (back) => 1010 + (back / (2 * H)) * 2),
            NOW,
        );
        expect(t).not.toBeNull();
        expect(t!.spanMs).toBeLessThan(TENDENCY_WINDOW_MS);
        // The endpoints are the medians of a ±10 min pool, so the measured
        // span is ~110 min, not the full 120 — hence −1.83 hPa, which
        // rescales to the −3 hPa/3 h the record actually implies.
        expect(t!.deltaHpa).toBeCloseTo(-1.83, 1);
        expect(t!.delta3h).toBeCloseTo(-3, 1);
    });

    it('rides out a single spike at an endpoint', () => {
        // Flat 1015, with one 1040 outlier landing right on "now".
        const s = series(4, () => 1015);
        s[s.length - 1] = { t: NOW, hpa: 1040 };
        const t = observedTendency(s, NOW);
        expect(t).not.toBeNull();
        // The endpoint median throws the spike away; a mean would have shown
        // a ~+1 hPa/3h rise out of nothing.
        expect(Math.abs(t!.delta3h)).toBeLessThan(0.5);
        expect(t!.direction).toBe('steady');
    });

    it('ignores non-finite samples instead of poisoning the delta', () => {
        const s = series(4, () => 1015);
        s.splice(3, 0, { t: NOW - 3.5 * H, hpa: Number.NaN });
        const t = observedTendency(s, NOW);
        expect(t).not.toBeNull();
        expect(Number.isFinite(t!.delta3h)).toBe(true);
    });

    it('reports how long is left before a trend is possible', () => {
        expect(timeUntilTendency([], NOW)).toBeGreaterThan(0);
        // One hour of record: 90 min is the floor, so ~30 min to go.
        const left = timeUntilTendency(
            series(1, () => 1013),
            NOW,
        );
        expect(left).not.toBeNull();
        expect(left! / 60_000).toBeCloseTo(30, 0);
        expect(
            timeUntilTendency(
                series(4, () => 1013),
                NOW,
            ),
        ).toBeNull();
    });
});

describe('conversions', () => {
    it('reduces to sea level upward, and leaves a boat alone', () => {
        // At sea level the correction is a no-op — the common case on a boat.
        expect(reduceToSeaLevel(1013.25, 0)).toBe(1013.25);
        // ~100 m up reads about 12 hPa low at the station.
        const reduced = reduceToSeaLevel(1001, 100, 15);
        expect(reduced).toBeGreaterThan(1012);
        expect(reduced).toBeLessThan(1014);
    });

    it('converts hPa to inHg at the standard atmosphere', () => {
        expect(hpaToInHg(1013.25)).toBeCloseTo(29.92, 2);
    });
});
