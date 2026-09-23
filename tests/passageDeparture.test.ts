import { describe, expect, it } from 'vitest';
import { passageDepartureTime, passageForecastOffsetMs, passageForecastTime } from '../services/passageDeparture';

const HOUR = 3_600_000;
const NOW = Date.parse('2026-09-21T02:00:00Z');

describe('passage forecast clock', () => {
    it('keeps legacy elapsed time relative to the current clock', () => {
        const look = { departureMs: null, aheadMs: 6 * HOUR };
        for (const now of [NOW, NOW + HOUR]) {
            expect(passageDepartureTime(look, now)).toBe(now);
            expect(passageForecastTime(look, now)).toBe(now + 6 * HOUR);
            expect(passageForecastOffsetMs(look, now)).toBe(6 * HOUR);
        }
    });

    it('uses a future departure even at zero elapsed passage time', () => {
        const look = { departureMs: NOW + 2 * 24 * HOUR, aheadMs: 0 };
        expect(passageDepartureTime(look, NOW)).toBe(NOW + 48 * HOUR);
        expect(passageForecastTime(look, NOW)).toBe(NOW + 48 * HOUR);
        expect(passageForecastOffsetMs(look, NOW)).toBe(48 * HOUR);
    });

    it('holds forecast time fixed while its offset from the current clock shrinks', () => {
        const look = { departureMs: NOW + 24 * HOUR, aheadMs: 6 * HOUR };
        expect(passageForecastTime(look, NOW)).toBe(NOW + 30 * HOUR);
        expect(passageForecastTime(look, NOW + HOUR)).toBe(NOW + 30 * HOUR);
        expect(passageForecastOffsetMs(look, NOW + HOUR)).toBe(29 * HOUR);
    });

    it('preserves an accepted departure after the current clock passes its forecast time', () => {
        const look = { departureMs: NOW, aheadMs: HOUR };
        expect(passageDepartureTime(look, NOW + 2 * HOUR)).toBe(NOW);
        expect(passageForecastTime(look, NOW + 2 * HOUR)).toBe(NOW + HOUR);
        expect(passageForecastOffsetMs(look, NOW + 2 * HOUR)).toBe(-HOUR);
    });
});
