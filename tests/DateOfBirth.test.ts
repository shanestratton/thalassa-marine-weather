/**
 * Date of birth, not age (129-14, Shane 2026-10-14: "in the vessel profile,
 * can we change punters age for date of birth. Otherwise we will have to
 * change the age every year. This only shows up in the float plan").
 *
 * A date of birth is a calendar date, yyyy-mm-dd, with no time and no time
 * zone: the day someone was born does not move when the phone crosses the
 * date line. An age is worked out from it on a given calendar day. Fictional
 * people and dates only: the repository is public.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { ageOn, dayIn, isBirthDate, localDay } from '../services/crew/dateOfBirth';

describe('isBirthDate', () => {
    it('takes a real calendar date as yyyy-mm-dd and nothing else', () => {
        expect(isBirthDate('1979-03-04')).toBe(true);
        expect(isBirthDate('2000-02-29')).toBe(true);
        // Not a date in that year, not the stored form, not a string.
        for (const value of ['1979-02-29', '1979-02-30', '1979-13-01', '79-03-04', '1979-3-4', '04/03/1979', '']) {
            expect(isBirthDate(value), value).toBe(false);
        }
        expect(isBirthDate(null)).toBe(false);
        expect(isBirthDate(47)).toBe(false);
        // Before 1900 is a typing slip, not a crew member.
        expect(isBirthDate('1899-12-31')).toBe(false);
    });
});

describe('ageOn', () => {
    it('counts whole years on the day given: the day before a birthday, the day itself, the day after', () => {
        expect(ageOn('1979-03-04', '2026-03-03')).toBe(46);
        expect(ageOn('1979-03-04', '2026-03-04')).toBe(47);
        expect(ageOn('1979-03-04', '2026-03-05')).toBe(47);
        expect(ageOn('1979-03-04', '2026-12-31')).toBe(47);
    });

    it('a 29 February birthday is reached on 1 March in a common year, and on 29 February in a leap year', () => {
        // The rule: an age goes up on the first day whose month and day are
        // the birth month and day or later. In a year with no 29 February
        // that day is 1 March, so on 28 February a leapling is still a year
        // younger.
        expect(ageOn('2000-02-29', '2027-02-28')).toBe(26);
        expect(ageOn('2000-02-29', '2027-03-01')).toBe(27);
        expect(ageOn('2000-02-29', '2028-02-28')).toBe(27);
        expect(ageOn('2000-02-29', '2028-02-29')).toBe(28);
    });

    it('a baby is 0, and a date after the day given, or not a date, has no age', () => {
        expect(ageOn('2026-06-01', '2026-10-14')).toBe(0);
        expect(ageOn('2026-10-15', '2026-10-14')).toBeNull();
        expect(ageOn('1979-02-30', '2026-10-14')).toBeNull();
        expect(ageOn('1979-03-04', 'not a day')).toBeNull();
        expect(ageOn(undefined, '2026-10-14')).toBeNull();
    });
});

describe('the calendar day, wherever the phone is', () => {
    const zone = process.env.TZ;
    afterEach(() => {
        if (zone === undefined) delete process.env.TZ;
        else process.env.TZ = zone;
    });

    it("a phone's own day is its local calendar day, not UTC's: UTC+13 and UTC-10", () => {
        // 10:30 UTC on 14 October 2026 is 23:30 on the 14th in Tonga (UTC+13)
        // and 00:30 on the 14th in Honolulu (UTC-10).
        const instant = new Date(Date.UTC(2026, 9, 14, 10, 30));
        process.env.TZ = 'Pacific/Tongatapu';
        expect(instant.getTimezoneOffset(), 'the zone took').toBe(-13 * 60);
        expect(localDay(instant)).toBe('2026-10-14');
        // 11:30 UTC: already the 15th in Tonga, still the 14th in Honolulu.
        const later = new Date(Date.UTC(2026, 9, 14, 11, 30));
        expect(localDay(later)).toBe('2026-10-15');
        process.env.TZ = 'Pacific/Honolulu';
        expect(later.getTimezoneOffset(), 'the zone took').toBe(10 * 60);
        expect(localDay(later)).toBe('2026-10-14');
        expect(localDay(new Date(Date.UTC(2026, 9, 14, 9, 59)))).toBe('2026-10-13');
    });

    it("a departure's day is its day in the plan's zone, east and west of the date line", () => {
        // 22:00 UTC on 13 October 2026: 08:00 on the 14th in Brisbane, 11:00
        // on the 14th in Tonga, 12:00 on the 13th in Honolulu.
        const departs = Date.UTC(2026, 9, 13, 22, 0);
        expect(dayIn(departs, 'Australia/Brisbane')).toBe('2026-10-14');
        expect(dayIn(departs, 'Pacific/Tongatapu')).toBe('2026-10-14');
        expect(dayIn(departs, 'Pacific/Honolulu')).toBe('2026-10-13');
        expect(dayIn(departs, 'Europe/Lisbon')).toBe('2026-10-13');
        // An unknown zone falls back to the device's own day, never throws.
        process.env.TZ = 'Pacific/Honolulu';
        expect(dayIn(departs, 'Not/AZone')).toBe('2026-10-13');
    });

    it('a birthday on the departure day counts at UTC+13 and at UTC-10 alike', () => {
        // Born 14 October 1979; the boat leaves at 22:00 UTC on 13 October.
        const departs = Date.UTC(2026, 9, 13, 22, 0);
        expect(ageOn('1979-10-14', dayIn(departs, 'Pacific/Tongatapu'))).toBe(47);
        expect(ageOn('1979-10-14', dayIn(departs, 'Pacific/Honolulu'))).toBe(46);
    });
});
