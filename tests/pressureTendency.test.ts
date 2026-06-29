/**
 * Tests for the barometric-tendency verdict (pressure hPa). Judged on the slope
 * over the next ~12 h, not the absolute value — a wrong sign would call a
 * deepening low "settled".
 */
import { describe, it, expect } from 'vitest';
import { pressureTendency } from '../components/dashboard/hero/MetricDeepDiveModal';

const H = 3_600_000;
// Build an hourly pressure series from now-1h..now+12h at a constant slope (hPa/h).
function series(now: number, p0: number, slopePerHour: number) {
    const pts = [];
    for (let h = -1; h <= 13; h++) pts.push({ t: now + h * H, v: p0 + slopePerHour * h });
    return pts;
}

describe('pressureTendency', () => {
    const now = 1_700_000_000_000;

    it('steady glass ⇒ good / Settled', () => {
        const r = pressureTendency(series(now, 1015, 0), now);
        expect(r?.verdict).toBe('good');
        expect(r?.word).toBe('Settled');
    });

    it('a gentle rise still reads settled', () => {
        // +0.5 hPa/h → ~1.5/3h, under the 3/3h "rising fast" bar
        const r = pressureTendency(series(now, 1010, 0.5), now);
        expect(r?.verdict).toBe('good');
    });

    it('a fast sustained fall ⇒ poor / Dropping fast', () => {
        // -1.5 hPa/h ≈ -4.5/3h
        const r = pressureTendency(series(now, 1015, -1.5), now);
        expect(r?.verdict).toBe('poor');
        expect(r?.word).toMatch(/dropping/i);
    });

    it('a moderate fall ⇒ marginal / Falling', () => {
        // -0.5 hPa/h ≈ -1.5/3h
        const r = pressureTendency(series(now, 1015, -0.5), now);
        expect(r?.verdict).toBe('marginal');
        expect(r?.word).toBe('Falling');
    });

    it('a fast rise ⇒ marginal / Rising fast (windy clearing)', () => {
        // +1.5 hPa/h ≈ +4.5/3h
        const r = pressureTendency(series(now, 1005, 1.5), now);
        expect(r?.verdict).toBe('marginal');
        expect(r?.word).toMatch(/rising/i);
    });

    it('null when the forward window has no data', () => {
        expect(pressureTendency([{ t: now - 5 * H, v: 1015 }], now)).toBeNull();
        expect(pressureTendency([], now)).toBeNull();
    });
});
