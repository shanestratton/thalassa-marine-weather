import { describe, expect, it } from 'vitest';
import SunCalc from 'suncalc';
import { getMoonTimes, getMoonTransits, localNoon, startOfLocalDay, wallClock } from '../utils/celestial';
import { solunarPeriods } from '../utils/solunar';

describe('bounded local-day lunar transits', () => {
    for (const [date, lat, lon, zone] of [
        ['2026-10-17', -27.2, 153.1, 'Australia/Brisbane'],
        ['2026-03-08', 40.7, -74, 'America/New_York'],
        ['2026-11-01', 40.7, -74, 'America/New_York'],
        ['2026-10-17', 1.9, -157.4, 'Pacific/Kiritimati'],
        ['2026-06-21', 78.2, 15.6, 'Arctic/Longyearbyen'],
    ] as const) {
        it(`${date} ${zone}: actual day and independently calculated meridian`, () => {
            const noon = localNoon(date, zone),
                result = getMoonTransits(noon, lat, lon, zone);
            expect(result.state).toBe('normal');
            expect(result.upper.length + result.lower.length).toBeGreaterThanOrEqual(1);
            for (const event of [...result.upper, ...result.lower]) {
                expect(wallClock(event.getTime(), zone).slice(0, 3)).toEqual(date.split('-').map(Number));
                // Independent installed SunCalc 1.9 low-precision coordinates.
                // This is a meridian geometry check, not a claimed USNO transit fixture.
                // Azimuth alone is ill-conditioned near the zenith. Compare
                // east/west components on either side, allowing the older
                // low-precision model its documented rise/set discrepancy.
                const eastWest = (offset: number) => {
                    const position = SunCalc.getMoonPosition(new Date(event.getTime() + offset), lat, lon);
                    return Math.sin(position.azimuth) * Math.cos(position.altitude);
                };
                expect(eastWest(-15 * 60000) * eastWest(15 * 60000)).toBeLessThan(0);
            }
            if (result.upper[0] && result.lower[0]) {
                const spacing = Math.abs(result.upper[0].getTime() - result.lower[0].getTime());
                expect(spacing).toBeGreaterThan(12 * 3600000);
                expect(spacing).toBeLessThan(13 * 3600000);
            }
        });
    }
    it('uses 23 and 25 hour civil days, with independently searched crossings', () => {
        for (const [date, hours] of [
            ['2026-03-08', 23],
            ['2026-11-01', 25],
        ] as const) {
            const start = startOfLocalDay(localNoon(date, 'America/New_York'), 'America/New_York').getTime();
            expect(startOfLocalDay(new Date(start + 26 * 3600000), 'America/New_York').getTime() - start).toBe(
                hours * 3600000,
            );
        }
    });
    it('does not invent a transit missing from the local calendar day', () => {
        const days = Array.from({ length: 30 }, (_, i) =>
            getMoonTransits(localNoon(`2026-10-${String(i + 1).padStart(2, '0')}`, 'UTC'), 51.5, 0, 'UTC'),
        );
        expect(days.some((day) => day.upper.length === 0 || day.lower.length === 0)).toBe(true);
        for (const day of days) expect(day.upper.length + day.lower.length).toBeLessThanOrEqual(2);
    });
    it.each([
        [90, 0],
        [-90, 0],
        [NaN, 0],
        [0, 181],
        [0, Infinity],
    ])('unavailable coordinates %s %s', (lat, lon) => {
        expect(getMoonTransits(new Date('2026-10-17'), lat, lon, 'UTC')).toEqual({
            state: 'unavailable',
            upper: [],
            lower: [],
        });
    });
    it('invalid dates and zones are unavailable', () => {
        expect(getMoonTransits(new Date(NaN), 0, 0, 'UTC').state).toBe('unavailable');
        expect(getMoonTransits(new Date(), 0, 0, 'Not/AZone').state).toBe('unavailable');
        for (const date of ['2026-02-30', '2026-13-01', 'bad', '2011-12-30']) {
            expect(solunarPeriods(date, 0, -171.8, 'Pacific/Apia')).toBeNull();
        }
    });
    it('traditional windows have truthful cross-midnight labels and no fabricated polar rise', () => {
        const rows = Array.from({ length: 30 }, (_, i) =>
            solunarPeriods(`2026-10-${String(i + 1).padStart(2, '0')}`, -27.2, 153.1, 'Australia/Brisbane'),
        );
        expect(JSON.stringify(rows)).toMatch(/previous day|next day/);
        const noon = localNoon('2026-06-21', 'Arctic/Longyearbyen');
        const moon = getMoonTimes(noon, 78.2, 15.6, 'Arctic/Longyearbyen');
        const polar = solunarPeriods('2026-06-21', 78.2, 15.6, 'Arctic/Longyearbyen')!;
        expect(polar[2].times).toHaveLength(moon.rise ? 1 : 0);
        expect(polar[3].times).toHaveLength(moon.set ? 1 : 0);
        expect(polar.slice(0, 2).flatMap((row) => row.times).length).toBeGreaterThan(0);
    });
});
