import { describe, expect, it } from 'vitest';
import { passageRainTimeSelection, passageWindTimeSelection } from '../components/map/passageWeatherTime';

const HOUR = 3_600_000;
const MINUTE = 60_000;
const NOW = Date.UTC(2026, 8, 21, 2, 15);
const windHours = Array.from({ length: 169 }, (_, i) => i);
const refTime = new Date(NOW - 15 * MINUTE).toISOString();
const rainFrames = [-20, -10, 10, 30, 60, 120, 240].map((minutes) => ({ timeMs: NOW + minutes * MINUTE }));

describe('the passage departure drives the chart weather clock', () => {
    it('wind at departure + elapsed uses the exact grid clock, not its nearest Now index', () => {
        const look = { departureMs: NOW + 2 * 24 * HOUR, aheadMs: 4 * HOUR };
        expect(passageWindTimeSelection(windHours, refTime, look, NOW)).toEqual({
            target: { frame: 52.25, beyond: false },
            coverageHours: 119.75,
            unsynced: false,
        });
        expect(passageWindTimeSelection(windHours, refTime, look, NOW + HOUR)).toEqual(
            passageWindTimeSelection(windHours, refTime, look, NOW),
        );
    });

    it('rolling Now still follows the clock while fixed departures remain fixed after they pass', () => {
        const rolling = { departureMs: null, aheadMs: HOUR };
        expect(passageWindTimeSelection(windHours, refTime, rolling, NOW).target?.frame).toBe(1.25);
        expect(passageWindTimeSelection(windHours, refTime, rolling, NOW + HOUR).target?.frame).toBe(2.25);
        const fixed = { departureMs: NOW, aheadMs: 0 };
        expect(passageWindTimeSelection(windHours, refTime, fixed, NOW + HOUR).target?.frame).toBe(0.25);
    });

    it('a departure outside the field has zero future coverage and is explicitly unsynced', () => {
        const look = { departureMs: NOW + 5 * 24 * HOUR, aheadMs: 0 };
        expect(passageWindTimeSelection(windHours.slice(0, 48), refTime, look, NOW)).toEqual({
            target: { frame: 47, beyond: true },
            coverageHours: 0,
            unsynced: true,
        });
        expect(passageWindTimeSelection(windHours, null, look, NOW)).toEqual({
            target: null,
            coverageHours: null,
            unsynced: true,
        });
        expect(passageWindTimeSelection([], refTime, look, NOW).coverageHours).toBeNull();
    });

    it('distinguishes an exact last wind frame from elapsed time beyond it', () => {
        const look = { departureMs: NOW - 15 * MINUTE + 47 * HOUR, aheadMs: 0 };
        expect(passageWindTimeSelection(windHours.slice(0, 48), refTime, look, NOW)).toEqual({
            target: { frame: 47, beyond: false },
            coverageHours: 0,
            unsynced: false,
        });
        expect(
            passageWindTimeSelection(windHours.slice(0, 48), refTime, { ...look, aheadMs: HOUR }, NOW).unsynced,
        ).toBe(true);
    });

    it('rain chooses departure + elapsed by valid time and reports reach from departure', () => {
        const look = { departureMs: NOW + HOUR, aheadMs: HOUR };
        expect(passageRainTimeSelection(rainFrames, 1, look, NOW)).toEqual({
            target: 5,
            coverageHours: 3,
            unsynced: false,
        });
        expect(passageRainTimeSelection(rainFrames, 1, look, NOW + 30 * MINUTE)).toEqual(
            passageRainTimeSelection(rainFrames, 1, look, NOW),
        );
    });

    it('keeps observed radar for rolling Now, but does not replace a fixed date with Now', () => {
        expect(passageRainTimeSelection(rainFrames, 1, { departureMs: null, aheadMs: 0 }, NOW).target).toBe(1);
        expect(passageRainTimeSelection(rainFrames, 1, { departureMs: NOW + 5 * MINUTE, aheadMs: 0 }, NOW).target).toBe(
            2,
        );
        const fixed = { departureMs: NOW - 20 * MINUTE, aheadMs: 0 };
        expect(passageRainTimeSelection(rainFrames, 1, fixed, NOW + 5 * HOUR)).toEqual({
            target: 0,
            coverageHours: 4 + 1 / 3,
            unsynced: false,
        });
    });

    it('returns observed rain with an explicit unsynced warning beyond either available boundary', () => {
        expect(passageRainTimeSelection(rainFrames, 1, { departureMs: NOW + 5 * 24 * HOUR, aheadMs: 0 }, NOW)).toEqual({
            target: 1,
            coverageHours: 0,
            unsynced: true,
        });
        expect(passageRainTimeSelection(rainFrames, 1, { departureMs: NOW - HOUR, aheadMs: 0 }, NOW).unsynced).toBe(
            true,
        );
        expect(passageRainTimeSelection([{}, {}], 1, { departureMs: NOW + HOUR, aheadMs: 0 }, NOW)).toEqual({
            target: 1,
            coverageHours: null,
            unsynced: true,
        });
    });
});
